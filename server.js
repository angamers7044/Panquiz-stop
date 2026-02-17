import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();

// --- Randomizer Brute Force API ---
import { getRandomizerStatus, startRandomizer, stopRandomizer, checkRandomizerAuthenticator } from './randomizer/randomizer.controller.js';
import * as randomizerController from './randomizer/randomizer.controller.js';
import { negotiateSignalRConnection } from './negotiate_connection.js';
// Register Randomizer API endpoints after app is initialized
app.get('/api/randomizer/status', getRandomizerStatus);
app.post('/api/randomizer/start', express.json(), startRandomizer);
app.post('/api/randomizer/stop', stopRandomizer);

// Return questions/answers for the current brute force session if authenticator matches
app.post('/api/randomizer/questions', express.json(), (req, res) => {
    let authenticator = req.query.authenticator || req.body?.authenticator;
    if (!authenticator && req.headers['authorization']) {
        authenticator = req.headers['authorization'].replace(/^Bearer /i, '');
    }
    // Try to get authenticator from cookies if not present
    if (!authenticator && req.headers.cookie) {
        const match = req.headers.cookie.match(/panquiz_auth=([^;]+)/);
        if (match) authenticator = match[1];
    }
    if (!randomizerController.checkRandomizerAuthenticator(authenticator)) {
        return res.status(401).json({ questions: [], error: 'Missing or invalid authenticator' });
    }
    // Use found data if available
    const bruteForceState = randomizerController.bruteForceState || {};
    if (!bruteForceState.found || !bruteForceState.found.data || !bruteForceState.found.data.quiz || !bruteForceState.found.data.quiz.questions) {
        return res.json({ questions: [] });
    }
    const getCorrectAnswer = randomizerController.getCorrectAnswer || function(q) { return ''; };
    const questions = bruteForceState.found.data.quiz.questions.map(q => ({
        question: q.text,
        answers: [q.answer1, q.answer2, q.answer3, q.answer4, q.answer5, q.answer6].filter(Boolean),
        rightAnswer: getCorrectAnswer(q)
    }));
    res.json({ questions });
});

// Allow a client to disconnect itself by connectionId and authenticator
app.post('/api/self-disconnect/:connectionId', express.json(), (req, res) => {
    const { connectionId } = req.params;
    let authenticator = req.query.authenticator || req.body?.authenticator;
    if (!authenticator && req.headers['authorization']) {
        authenticator = req.headers['authorization'].replace(/^Bearer /i, '');
    }
    if (!authenticator && req.headers.cookie) {
        const match = req.headers.cookie.match(/panquiz_auth=([^;]+)/);
        if (match) authenticator = match[1];
    }
    const connection = activeConnections.get(connectionId);
    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }
    // Only allow if authenticator matches the one stored for this connection
    if (connection.authenticator && connection.authenticator !== authenticator) {
        return res.status(403).json({ error: 'Forbidden: invalid authenticator' });
    }
    if (connection.ws && connection.connected) {
        connection.ws.close();
    }
    connection.connected = false;
    res.json({ success: true });
});

// Helper to extract correct answer(s) from question object
function getCorrectAnswer(q) {
    // If correct is a string of 0/1s, return the answer(s) marked as correct
    if (typeof q.correct === 'string' && q.correct.match(/^[01]+$/)) {
        const answers = [q.answer1, q.answer2, q.answer3, q.answer4, q.answer5, q.answer6];
        return answers.filter((a, i) => q.correct[i] === '1' && a).join(', ');
    }
    // If correct is a number or string index, return that answer
    if (typeof q.correct === 'string' && q.correct.match(/^\d+$/)) {
        const idx = parseInt(q.correct, 10) - 1;
        const answers = [q.answer1, q.answer2, q.answer3, q.answer4, q.answer5, q.answer6];
        return answers[idx] || '';
    }
    return '';
}
// Force port detection for different hosting services
const PORT = process.env.PORT || process.env.SERVER_PORT || 80;

console.log('🔧 Starting Panquiz server...');
console.log('🌍 Environment:', process.env.NODE_ENV || 'development');
console.log('🚪 Port:', PORT);
console.log('🚂 Railway Environment:', process.env.RAILWAY_ENVIRONMENT || 'not detected');
console.log('🎨 Render Environment:', process.env.RENDER || 'not detected');
console.log('📡 All PORT env vars:', {
    PORT: process.env.PORT,
    SERVER_PORT: process.env.SERVER_PORT,
    NODE_ENV: process.env.NODE_ENV
});

// Store active connections
const activeConnections = new Map();

// Store current game info (updated via PlayAgain messages)
let currentGameInfo = {
    playId: null,
    pin: null,
    gameNumber: 0,
    lastUpdated: null
};

// --- Admin auth + IP bans (server-side) ---
const ADMIN_COOKIE_NAME = 'panquiz_admin_session';
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000); // 8h default

// Store a hash (not the plaintext) so `public/admin/index.html` never contains the secret.
// Format: pbkdf2$sha256$<iterations>$<saltB64Url>$<hashB64Url>
const HARDCODED_ADMIN_PASSPHRASE_HASH = ''; // leave empty to trigger first-run setup
const ADMIN_SECRET_PATH = path.join(__dirname, 'admin.secret.json');
const ADMIN_PASSPHRASE = process.env.ADMIN_PASSPHRASE; // optional (legacy override)
let resolvedAdminPassphraseHash = process.env.ADMIN_PASSPHRASE_HASH || null;

const adminSessions = new Map(); // sessionId -> { csrfToken, expiresAt }
const bannedIps = new Map(); // ip -> { reason, addedAt, expiresAt (or null for permanent), secondsRemaining }
const banTimersFile = path.join(__dirname, 'ban_timers.json'); // Persistent ban timers storage
const siteVisitors = new Map(); // ip -> { firstVisit, lastVisit, count }
const adminLoginAttempts = new Map(); // ip -> { firstAt, failures, lockedUntil }
const adminLoginAuditLog = []; // Array to store login attempt history (success/failure with details)
const MAX_AUDIT_LOG_ENTRIES = 200; // Keep last 200 entries

const ADMIN_LOGIN_WINDOW_MS = Number(process.env.ADMIN_LOGIN_WINDOW_MS || 10 * 60 * 1000); // 10m
const ADMIN_LOGIN_MAX_FAILURES = Number(process.env.ADMIN_LOGIN_MAX_FAILURES || 8);
const ADMIN_LOGIN_LOCK_MS = Number(process.env.ADMIN_LOGIN_LOCK_MS || 15 * 60 * 1000); // 15m

function sha256Base64Url(input) {
    return crypto.createHash('sha256').update(String(input ?? ''), 'utf8').digest('base64url');
}

function secureEquals(a, b) {
    // Compare fixed-length hashes to avoid leaking length/timing details.
    const ah = sha256Base64Url(a);
    const bh = sha256Base64Url(b);
    return crypto.timingSafeEqual(Buffer.from(ah), Buffer.from(bh));
}

function b64UrlToBuffer(s) {
    if (!s) return Buffer.alloc(0);
    const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    return Buffer.from(b64 + pad, 'base64');
}

function loadAdminSecretHashFromDisk() {
    try {
        if (!fs.existsSync(ADMIN_SECRET_PATH)) return null;
        const raw = fs.readFileSync(ADMIN_SECRET_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const hash = parsed?.adminPassphraseHash;
        if (typeof hash === 'string' && hash.trim()) return hash.trim();
        return null;
    } catch {
        return null;
    }
}

function saveAdminSecretHashToDisk(hash) {
    const payload = {
        adminPassphraseHash: hash,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(ADMIN_SECRET_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function parsePbkdf2Hash(stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 5) return null;
    const [scheme, alg, iterStr, saltB64u, hashB64u] = parts;
    if (scheme !== 'pbkdf2' || alg !== 'sha256') return null;
    const iterations = Number(iterStr);
    if (!Number.isFinite(iterations) || iterations < 10000) return null;
    const salt = b64UrlToBuffer(saltB64u);
    const hash = b64UrlToBuffer(hashB64u);
    if (!salt.length || !hash.length) return null;
    return { iterations, salt, hash };
}

function createPbkdf2Hash(passphrase, iterations = 210000) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.pbkdf2Sync(String(passphrase ?? ''), salt, iterations, 32, 'sha256');
    return `pbkdf2$sha256$${iterations}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyAdminPassphrase(passphrase) {
    if (!resolvedAdminPassphraseHash) {
        resolvedAdminPassphraseHash = process.env.ADMIN_PASSPHRASE_HASH || loadAdminSecretHashFromDisk() || HARDCODED_ADMIN_PASSPHRASE_HASH || null;
    }
    if (resolvedAdminPassphraseHash) {
        const parsed = parsePbkdf2Hash(resolvedAdminPassphraseHash);
        if (parsed) {
            const derived = crypto.pbkdf2Sync(String(passphrase ?? ''), parsed.salt, parsed.iterations, parsed.hash.length, 'sha256');
            return crypto.timingSafeEqual(derived, parsed.hash);
        }
    }
    // Legacy override: plaintext in env (still compared timing-safe)
    if (ADMIN_PASSPHRASE) return secureEquals(passphrase, ADMIN_PASSPHRASE);
    return false;
}

async function promptForHiddenInput(promptText) {
    const readline = await import('node:readline');
    if (!process.stdin.isTTY) {
        throw new Error('No TTY available for hidden input');
    }

    readline.emitKeypressEvents(process.stdin);
    const previousRawMode = process.stdin.isRaw;
    process.stdin.setRawMode(true);

    return await new Promise((resolve, reject) => {
        let input = '';
        let stars = 0;

        const cleanup = () => {
            process.stdin.off('keypress', onKeypress);
            try {
                process.stdin.setRawMode(Boolean(previousRawMode));
            } catch {
                // ignore
            }
        };

        const onKeypress = (str, key) => {
            try {
                if (key && key.ctrl && key.name === 'c') {
                    cleanup();
                    reject(new Error('Cancelled'));
                    return;
                }

                if (key && (key.name === 'return' || key.name === 'enter')) {
                    cleanup();
                    process.stdout.write('\n');
                    resolve(input);
                    return;
                }

                if (key && (key.name === 'backspace' || key.sequence === '\b' || key.sequence === '\x7f')) {
                    if (input.length > 0) {
                        input = input.slice(0, -1);
                        if (stars > 0) {
                            process.stdout.write('\b \b');
                            stars -= 1;
                        }
                    }
                    return;
                }

                // Ignore arrows, function keys, etc.
                if (key && (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right' || key.name === 'tab')) {
                    return;
                }

                if (typeof str === 'string' && str.length) {
                    // Drop other control characters
                    if (str === '\r' || str === '\n') return;
                    input += str;
                    process.stdout.write('*');
                    stars += 1;
                }
            } catch (err) {
                cleanup();
                reject(err);
            }
        };

        process.stdout.write(String(promptText || ''));
        process.stdin.on('keypress', onKeypress);
    });
}

async function ensureAdminSecretReady() {
    if (resolvedAdminPassphraseHash) return;
    resolvedAdminPassphraseHash = loadAdminSecretHashFromDisk() || HARDCODED_ADMIN_PASSPHRASE_HASH || null;
    if (resolvedAdminPassphraseHash) return;

    if (!process.stdin.isTTY) {
        console.error(`❌ Admin passphrase not configured. Set ADMIN_PASSPHRASE_HASH env var or create ${ADMIN_SECRET_PATH}.`);
        process.exit(1);
    }

    console.log('🔐 First-run admin setup');
    console.log(`- This will create ${ADMIN_SECRET_PATH} (gitignored).`);
    console.log('- Input is hidden; you will see * characters.');
    while (true) {
        const pass1 = await promptForHiddenInput('Set admin passphrase: ');
        const pass2 = await promptForHiddenInput('Retype admin passphrase: ');
        if (!pass1 || pass1.length < 6) {
            console.log('⚠️  Passphrase too short (min 6). Try again.');
            continue;
        }
        if (pass1 !== pass2) {
            console.log('⚠️  Passphrases do not match. Try again.');
            continue;
        }
        const hash = createPbkdf2Hash(pass1);
        saveAdminSecretHashToDisk(hash);
        resolvedAdminPassphraseHash = hash;
        console.log(`✅ Admin passphrase configured and saved to ${ADMIN_SECRET_PATH}`);
        break;
    }
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (!key) continue;
        cookies[key] = decodeURIComponent(val);
    }
    return cookies;
}

function normalizeIp(ip) {
    if (!ip) return '';
    let s = String(ip).trim();
    // x-forwarded-for may include multiple IPs; caller should pass the chosen one.
    if (s.startsWith('::ffff:')) s = s.slice(7);
    if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
    const ipv4PortMatch = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
    if (ipv4PortMatch) s = ipv4PortMatch[1];
    return s;
}

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
        const first = xff.split(',')[0]?.trim();
        const normalized = normalizeIp(first);
        if (normalized) return normalized;
    }
    const xRealIp = req.headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.trim()) {
        const normalized = normalizeIp(xRealIp.trim());
        if (normalized) return normalized;
    }
    return normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
}

function getAdminSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[ADMIN_COOKIE_NAME];
    if (!sessionId) return null;
    const session = adminSessions.get(sessionId);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        adminSessions.delete(sessionId);
        return null;
    }
    return { sessionId, ...session };
}

function isHttpsRequest(req) {
    return Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https');
}

function requireAdmin(req, res, next) {
    const session = getAdminSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    req.adminSession = session;
    return next();
}

function requireAdminPage(req, res, next) {
    const session = getAdminSession(req);
    if (!session) return res.redirect(302, '/admin');
    req.adminSession = session;
    return next();
}

function requireCsrf(req, res, next) {
    const token = req.headers['x-csrf-token'];
    if (!token || token !== req.adminSession?.csrfToken) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    return next();
}

function isBannedIp(ip) {
    const normalized = normalizeIp(ip);
    if (!normalized) return false;
    
    const banData = bannedIps.get(normalized);
    if (!banData) return false;
    
    // Check if ban has expired (null expiresAt means permanent)
    if (banData.expiresAt && Date.now() > banData.expiresAt) {
        bannedIps.delete(normalized);
        return false;
    }
    
    return true;
}

function getBanReason(ip) {
    const normalized = normalizeIp(ip);
    if (!normalized) return null;
    const banData = bannedIps.get(normalized);
    return banData ? banData.reason : null;
}

function getBanTimeRemaining(ip) {
    const normalized = normalizeIp(ip);
    if (!normalized) return null;
    const banData = bannedIps.get(normalized);
    if (!banData) return null;
    
    if (banData.secondsRemaining === null) {
        return null; // Permanent ban
    }
    return banData.secondsRemaining || 0;
}

function checkAdminLoginAllowed(ip) {
    const key = normalizeIp(ip) || 'unknown';
    const now = Date.now();
    const record = adminLoginAttempts.get(key);
    if (!record) return { allowed: true };
    if (record.lockedUntil && now < record.lockedUntil) {
        return { allowed: false, retryAfterMs: record.lockedUntil - now };
    }
    if (record.firstAt && now - record.firstAt > ADMIN_LOGIN_WINDOW_MS) {
        adminLoginAttempts.delete(key);
        return { allowed: true };
    }
    return { allowed: true };
}

function recordAdminLoginFailure(ip) {
    const key = normalizeIp(ip) || 'unknown';
    const now = Date.now();
    const record = adminLoginAttempts.get(key) || { firstAt: now, failures: 0, lockedUntil: 0 };
    if (now - record.firstAt > ADMIN_LOGIN_WINDOW_MS) {
        record.firstAt = now;
        record.failures = 0;
        record.lockedUntil = 0;
    }
    record.failures += 1;
    if (record.failures >= ADMIN_LOGIN_MAX_FAILURES) {
        record.lockedUntil = now + ADMIN_LOGIN_LOCK_MS;
    }
    adminLoginAttempts.set(key, record);
}

function clearAdminLoginFailures(ip) {
    const key = normalizeIp(ip) || 'unknown';
    adminLoginAttempts.delete(key);
}

function logAdminLoginAttempt(ip, success, passphrase = null) {
    const entry = {
        ip: ip || 'unknown',
        timestamp: new Date().toISOString(),
        success: success,
        passphrase: success ? null : (passphrase || 'unknown') // Hide successful password attempts
    };
    
    adminLoginAuditLog.push(entry);
    
    // Keep only last MAX_AUDIT_LOG_ENTRIES entries
    if (adminLoginAuditLog.length > MAX_AUDIT_LOG_ENTRIES) {
        adminLoginAuditLog.shift();
    }
}

// Load bans from persistent storage
function loadBanTimers() {
    try {
        if (fs.existsSync(banTimersFile)) {
            const data = JSON.parse(fs.readFileSync(banTimersFile, 'utf-8'));
            if (data && typeof data === 'object') {
                for (const [ip, banData] of Object.entries(data)) {
                    bannedIps.set(ip, banData);
                }
                console.log(`✅ Loaded ${Object.keys(data).length} bans from persistent storage`);
            }
        }
    } catch (error) {
        console.error('❌ Error loading ban timers:', error.message);
    }
}

// Save bans to persistent storage
function saveBanTimers() {
    try {
        const data = {};
        for (const [ip, banData] of bannedIps.entries()) {
            data[ip] = banData;
        }
        fs.writeFileSync(banTimersFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('❌ Error saving ban timers:', error.message);
    }
}

// Countdown timer for temp bans - runs every second
function startBanCountdown() {
    setInterval(() => {
        const ipsToRemove = [];
        
        for (const [ip, banData] of bannedIps.entries()) {
            // Only countdown temporary bans (not permanent)
            if (banData.secondsRemaining !== null && typeof banData.secondsRemaining === 'number') {
                banData.secondsRemaining--;
                
                // Auto-unban when timer reaches 0
                if (banData.secondsRemaining <= 0) {
                    console.log(`✅ Ban expired for IP: ${ip}`);
                    ipsToRemove.push(ip);
                }
            }
        }
        
        // Remove expired bans
        for (const ip of ipsToRemove) {
            bannedIps.delete(ip);
        }
        
        // Save to file if any changes
        if (ipsToRemove.length > 0) {
            saveBanTimers();
        }
    }, 1000); // Run every second
}

// Format seconds to readable time
function formatBanTimeRemaining(seconds) {
    if (seconds === null) return 'Permanent';
    if (seconds <= 0) return 'Expired';
    
    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);
    const secs = seconds % 60;
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 && seconds < 60) parts.push(`${secs}s`);
    
    return parts.length > 0 ? parts.join(' ') : '0s';
}

// Middleware
app.use(cors());
app.use(express.json());

// Middleware to track site visitors
app.use((req, res, next) => {
    const ip = normalizeIp(getClientIp(req));
    if (ip && ip !== 'unknown') {
        const now = Date.now();
        if (!siteVisitors.has(ip)) {
            siteVisitors.set(ip, { firstVisit: now, lastVisit: now, count: 1 });
        } else {
            const visitor = siteVisitors.get(ip);
            visitor.lastVisit = now;
            visitor.count++;
        }
    }
    next();
});

// Block banned IPs from non-admin APIs
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/admin/')) {
        const ip = getClientIp(req);
        if (ip && isBannedIp(ip)) {
            const reason = getBanReason(ip);
            const timeRemaining = getBanTimeRemaining(ip);
            const response = { error: 'Banned', reason: reason || 'No reason provided' };
            
            if (timeRemaining !== null && timeRemaining > 0) {
                response.timeRemaining = timeRemaining;
                response.timeRemainFormatted = formatBanTimeRemaining(timeRemaining);
            } else if (timeRemaining === null) {
                response.permanent = true;
            }
            
            return res.status(403).json(response);
        }
    }
    return next();
});

// Protect everything under /admin except the login page and favicon.
app.use((req, res, next) => {
    if (!req.path.startsWith('/admin')) return next();
    if (req.path === '/admin' || req.path === '/admin/' || req.path === '/admin/index.html' || req.path === '/admin/favicon.ico') return next();
    return requireAdminPage(req, res, next);
});

// Admin auth APIs
app.post('/api/admin/login', (req, res) => {
    const { passphrase } = req.body || {};
    if (!passphrase) return res.status(400).json({ error: 'Passphrase required' });
    const ip = getClientIp(req);
    const allowed = checkAdminLoginAllowed(ip);
    if (!allowed.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((allowed.retryAfterMs || 0) / 1000)));
        return res.status(429).json({ error: 'Too many attempts' });
    }

    if (!verifyAdminPassphrase(passphrase)) {
        recordAdminLoginFailure(ip);
        logAdminLoginAttempt(ip, false, passphrase); // Log failed attempt with password
        return res.status(401).json({ error: 'Invalid passphrase' });
    }
    
    clearAdminLoginFailures(ip);
    logAdminLoginAttempt(ip, true, passphrase); // Log successful attempt (password will be hidden)

    const sessionId = crypto.randomBytes(24).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    adminSessions.set(sessionId, { csrfToken, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });

    res.cookie(ADMIN_COOKIE_NAME, sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        secure: isHttpsRequest(req),
        maxAge: ADMIN_SESSION_TTL_MS,
        path: '/'
    });

    return res.json({ success: true, csrfToken });
});

app.post('/api/admin/logout', requireAdmin, requireCsrf, (req, res) => {
    adminSessions.delete(req.adminSession.sessionId);
    res.cookie(ADMIN_COOKIE_NAME, '', { httpOnly: true, sameSite: 'strict', secure: isHttpsRequest(req), maxAge: 0, path: '/' });
    return res.json({ success: true });
});

app.get('/api/admin/csrf', requireAdmin, (req, res) => {
    return res.json({ csrfToken: req.adminSession.csrfToken });
});

app.get('/api/admin/bans', requireAdmin, (req, res) => {
    const bans = Array.from(bannedIps.entries()).map(([ip, meta]) => ({ ip, ...meta }));
    return res.json({ bans });
});

app.get('/api/admin/site-visitors', requireAdmin, (req, res) => {
    const visitors = Array.from(siteVisitors.entries()).map(([ip, data]) => ({ ip, ...data }));
    // Sort by last visit (newest first)
    visitors.sort((a, b) => b.lastVisit - a.lastVisit);
    return res.json({ visitors });
});

app.get('/api/admin/login-audit-log', requireAdmin, (req, res) => {
    // Return audit log in reverse chronological order (newest first)
    const log = adminLoginAuditLog.slice().reverse();
    return res.json({ logs: log });
});

app.post('/api/admin/ban', requireAdmin, requireCsrf, (req, res) => {
    const ip = normalizeIp(req.body?.ip);
    const reason = String(req.body?.reason || '').slice(0, 200);
    const duration = req.body?.duration; // null for permanent, or milliseconds, or "1h", "24h", "7d", "permanent"
    
    if (!ip) return res.status(400).json({ error: 'IP required' });
    
    // Calculate expiration time and seconds remaining
    let expiresAt = null;
    let secondsRemaining = null;
    
    if (duration !== null && duration !== 'permanent') {
        const now = Date.now();
        let durationMs = 0;
        
        if (typeof duration === 'number') {
            durationMs = duration;
        } else if (typeof duration === 'string') {
            const durationMap = {
                '1h': 60 * 60 * 1000,
                '24h': 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000
            };
            durationMs = durationMap[duration] || 0;
        }
        
        if (durationMs > 0) {
            expiresAt = now + durationMs;
            secondsRemaining = Math.floor(durationMs / 1000);
        }
    }
    
    bannedIps.set(ip, { reason, addedAt: Date.now(), expiresAt, secondsRemaining });
    saveBanTimers(); // Save to JSON file

    // Disconnect all connections associated with this IP
    let disconnected = 0;
    for (const conn of activeConnections.values()) {
        if (normalizeIp(conn.ownerIp) === ip) {
            if (conn.ws && conn.connected) {
                conn.ws.close();
            }
            conn.connected = false;
            disconnected++;
        }
    }

    // Stop randomizer if it's running from this IP
    let randomizerStopped = false;
    if (randomizerController?.bruteForceState?.status === 'running' && 
        normalizeIp(randomizerController.bruteForceState?.ip) === ip) {
        randomizerController.stopRandomizer();
        randomizerStopped = true;
    }

    return res.json({ success: true, ip, disconnected, randomizerStopped, expiresAt, secondsRemaining });
});

app.post('/api/admin/unban', requireAdmin, requireCsrf, (req, res) => {
    const ip = normalizeIp(req.body?.ip);
    if (!ip) return res.status(400).json({ error: 'IP required' });
    const existed = bannedIps.delete(ip);
    saveBanTimers(); // Save to JSON file
    return res.json({ success: true, ip, existed });
});

// Admin can moderate a player (disable features, set restrictions)
app.post('/api/admin/moderate/:connectionId', requireAdmin, requireCsrf, (req, res) => {
    const { connectionId } = req.params;
    const connection = activeConnections.get(connectionId);
    
    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }
    
    const botDisabled = Boolean(req.body?.botDisabled);
    const reason = String(req.body?.reason || '').slice(0, 500);
    
    // Set moderation data
    connection.moderation = {
        botDisabled: botDisabled,
        reason: reason,
        appliedAt: Date.now()
    };
    
    // If there's a reason, send it to the player via a message
    if (reason && connection.ws && connection.connected) {
        const moderationMessage = {
            type: 1,
            target: "ModerationNotice",
            arguments: [reason]
        };
        connection.ws.send(JSON.stringify(moderationMessage) + '\u001e');
    }
    
    return res.json({ success: true, connectionId, moderation: connection.moderation });
});



// Admin-only connection management APIs (replaces insecure dashboard-only logic)
app.get('/api/admin/connections', requireAdmin, (req, res) => {
    const includeAll = String(req.query?.all || '') === '1';
    const connections = Array.from(activeConnections.values())
        .filter(conn => (includeAll ? true : Boolean(conn.connected)))
        .map(conn => ({
        id: conn.id,
        playerName: conn.playerName,
        playId: conn.playId,
        connected: conn.connected,
        isBot: Boolean(conn.isBot),
        autoAnswer: Boolean(conn.autoAnswer),
        questionsAnswered: conn.questionsAnswered,
        lastActivity: conn.lastActivity,
        ip: normalizeIp(conn.ownerIp || ''),
        banned: isBannedIp(conn.ownerIp || '')
    }));
    return res.json({ connections });
});

app.post('/api/admin/set-auto-answer/:connectionId', requireAdmin, requireCsrf, (req, res) => {
    try {
        const { connectionId } = req.params;
        const { autoAnswer } = req.body;
        const connection = activeConnections.get(connectionId);

        if (!connection) {
            return res.status(404).json({ error: 'Connection not found' });
        }

        connection.autoAnswer = Boolean(autoAnswer);
        return res.json({ success: true, autoAnswer: Boolean(connection.autoAnswer) });
    } catch (error) {
        return res.status(500).json({ error: error.message || String(error) });
    }
});

app.get('/api/admin/connection/:connectionId', requireAdmin, (req, res) => {
    const { connectionId } = req.params;
    const conn = activeConnections.get(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const currentQuestion = conn.currentQuestion
        ? {
            questionNumber: conn.currentQuestion.questionNumber,
            question: conn.currentQuestion.question,
            answersCount: Array.isArray(conn.currentQuestion.answers) ? conn.currentQuestion.answers.length : 0,
            maxAnswers: conn.currentQuestion.maxAnswers,
            timestamp: conn.currentQuestion.timestamp
        }
        : null;

    return res.json({
        success: true,
        connection: {
            id: conn.id,
            playerName: conn.playerName,
            playId: conn.playId,
            connected: Boolean(conn.connected),
            isBot: Boolean(conn.isBot),
            autoAnswer: Boolean(conn.autoAnswer),
            questionsAnswered: conn.questionsAnswered,
            lastActivity: conn.lastActivity,
            ip: normalizeIp(conn.ownerIp || ''),
            needsReconnection: Boolean(conn.needsReconnection),
            reconnectedAt: conn.reconnectedAt || null,
            medalData: conn.medalData || null,
            gameCompleted: Boolean(conn.gameCompleted),
            currentQuestion
        }
    });
});

app.post('/api/admin/disconnect/:connectionId', requireAdmin, requireCsrf, (req, res) => {
    const { connectionId } = req.params;
    const connection = activeConnections.get(connectionId);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    if (connection.ws && connection.connected) {
        connection.ws.close();
    }
    connection.connected = false;
    return res.json({ success: true });
});

// Static files (after /admin protection middleware)
app.use(express.static(path.join(__dirname, 'public')));

// Custom validation function that doesn't use readline
async function validateMatchPin(pin) {
    const fetch = (await import('node-fetch')).default;
    const { URLSearchParams } = await import('url');
    
    const url = 'https://play.panquiz.com/api/v1/player/pin';
    const formData = new URLSearchParams();
    formData.append('pinCode', pin);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*',
                'Origin': 'https://play.panquiz.com',
                'Referer': 'https://play.panquiz.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            return data.playId;
        }
        return null;
    } catch (error) {
        console.error('PIN validation error:', error);
        return null;
    }
}

// Function to fetch game/quiz data after PIN validation
async function fetchGameData(playId) {
    const fetch = (await import('node-fetch')).default;
    const { URLSearchParams } = await import('url');
    
    console.log(`🔍 Fetching quiz data for playId: ${playId}`);
    
    // FOUND IT! The quiz data comes from this specific endpoint with form data
    // Based on successful testing: https://play.panquiz.com/api/v1/player/start
    // User mentioned: "allora nella richiesta start nella risposta c'è un punto di nome quiz"
    const endpoint = 'https://play.panquiz.com/api/v1/player/start';
    
    try {
        console.log(`🎯 Fetching quiz data from: ${endpoint}`);
        
        // Use form data with playId (this is the format that works!)
        const formData = new URLSearchParams();
        formData.append('playId', playId);
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'application/json, */*',
                'Origin': 'https://play.panquiz.com',
                'Referer': 'https://play.panquiz.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: formData
        });

        console.log(`📊 Quiz data request status: ${response.status}`);
        
        if (response.ok) {
            const data = await response.json();
            console.log(`✅ Quiz data retrieved successfully:`, {
                success: data.success,
                hasQuiz: !!data.quiz,
                hasQuestions: !!(data.quiz && data.quiz.questions),
                totalQuestions: data.quiz ? data.quiz.totalQuestions : 0,
                title: data.quiz ? data.quiz.title : 'N/A'
            });
            
            // Validate the response format
            if (data.success && data.quiz && data.quiz.questions) {
                console.log(`🎯 Found ${data.quiz.questions.length} questions in quiz "${data.quiz.title}"`);
                
                // Log sample question for verification
                const firstQuestion = data.quiz.questions[0];
                if (firstQuestion) {
                    console.log(`📝 Sample question:`, {
                        text: firstQuestion.text ? firstQuestion.text.substring(0, 50) + '...' : 'No text',
                        timer: firstQuestion.timer || 'No timer',
                        answers: firstQuestion.maxAnswers || 'Unknown answers'
                    });
                }
                
                return data;
            } else {
                console.log(`❌ Invalid response format:`, {
                    hasSuccess: !!data.success,
                    hasQuiz: !!data.quiz,
                    hasQuestions: !!(data.quiz && data.quiz.questions),
                    responseKeys: Object.keys(data)
                });
                return null;
            }
        } else {
            const errorText = await response.text().catch(() => 'No error text');
            console.log(`❌ Quiz data request failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 100)}`);
            return null;
        }
    } catch (error) {
        console.error(`❌ Error fetching quiz data:`, error.message);
        return null;
    }
}

// Enhanced WebSocket connection with event tracking
async function createEnhancedWebSocketConnection(websocketUrl, playId, playerName, connectionId, gameData = null, meta = {}) {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(websocketUrl);
    
    const connectionData = {
        id: connectionId,
        playId,
        playerName,
        connected: false,
        questionsAnswered: 0,
        lastActivity: Date.now(),
        ws: ws,
        ownerIp: normalizeIp(meta?.ownerIp || ''),
        isBot: Boolean(meta?.isBot),
        isMainPlayer: true, // This is the main player, not a bot
        autoAnswer: true,   // Default to auto answer, can be changed via API
        gameData: gameData,
        quizQuestions: gameData?.quiz?.questions || []
    };
    
    activeConnections.set(connectionId, connectionData);

    ws.on('open', () => {
        console.log(`WebSocket connection opened for ${playerName} (${connectionId})`);
        connectionData.connected = true;
        connectionData.lastActivity = Date.now();
        
        const handshake = { protocol: "json", version: 1 };
        ws.send(JSON.stringify(handshake) + '\u001e');
    });

    ws.on('message', (message) => {
        connectionData.lastActivity = Date.now();
        
        try {
            const parsedMessage = JSON.parse(message.toString().replace('\u001e', ''));
            
            // Process specific message types
            if (parsedMessage.type === 1) {
                // Optional: Log important messages only
                if (['ShowQuestion', 'PlayAgain', 'ShowMedal', 'PlayerDisconnected'].includes(parsedMessage.target)) {
                    console.log(`📡 ${parsedMessage.target} message for ${playerName}`);
                }
            }

            if (message.toString() === "{}\u001e") {
                const playerJoined = {
                    type: 1,
                    target: "PlayerJoined",
                    arguments: [playId, playerName]
                };
                ws.send(JSON.stringify(playerJoined) + '\u001e');
                console.log(`Player ${playerName} joined game ${playId}`);
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "ShowQuestion") {
                const questionData = parsedMessage.arguments[0];
                const rightAnswer = questionData.rightAnswer;
                const maxAnswers = questionData.maxAnswers;

                console.log(`Question received for ${playerName}:`, {
                    question: questionData.question,
                    answers: questionData.answers,
                    rightAnswer: rightAnswer,
                    maxAnswers: maxAnswers
                });

                // Get question data from saved quiz data
                const questionNumber = connectionData.questionsAnswered;
                const savedQuestion = connectionData.quizQuestions[questionNumber];
                
                // Store question for manual answer mode
                connectionData.currentQuestion = {
                    question: savedQuestion?.text || questionData.question || 'Domanda in arrivo...',
                    answers: savedQuestion?.answers || questionData.answers || [],
                    rightAnswer: rightAnswer,
                    maxAnswers: savedQuestion?.maxAnswers || maxAnswers,
                    questionNumber: questionNumber + 1,
                    timestamp: Date.now()
                };
                
                console.log(`📝 Question ${questionNumber + 1}:`, {
                    text: connectionData.currentQuestion.question?.substring(0, 50) + '...',
                    maxAnswers: connectionData.currentQuestion.maxAnswers,
                    hasAnswers: connectionData.currentQuestion.answers.length > 0
                });

                const answerMapping = {};
                for (let i = 0; i < maxAnswers; i++) {
                    const binaryRepresentation = Array(maxAnswers).fill("0");
                    binaryRepresentation[i] = "1";
                    const binaryString = binaryRepresentation.join("");
                    answerMapping[binaryString] = i.toString();
                }

                const mappedAnswer = answerMapping[rightAnswer];
                connectionData.correctAnswerIndex = parseInt(mappedAnswer);
                
                // Add correct answer to current question data
                connectionData.currentQuestion.correctAnswerIndex = parseInt(mappedAnswer);

                // Only auto-answer if auto answer mode is enabled
                if (mappedAnswer !== undefined && connectionData.autoAnswer) {
                    const answerMessage = {
                        type: 1,
                        target: "AnswerGivenFromPlayer",
                        arguments: [playId, mappedAnswer, 500]
                    };
                    ws.send(JSON.stringify(answerMessage) + '\u001e');
                    connectionData.questionsAnswered++;
                    console.log(`Auto answer sent for ${playerName}: ${mappedAnswer} (Total: ${connectionData.questionsAnswered})`);
                } else if (mappedAnswer !== undefined && !connectionData.autoAnswer) {
                    console.log(`Question stored for manual answer by ${playerName}, waiting for user selection...`);
                }
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "PlayAgain") {
                console.log(`🔄🔄🔄 PlayAgain detected for ${playerName}! 🔄🔄🔄`);
                const [oldPlayId, newPlayId, gameNumber, newPin] = parsedMessage.arguments;
                
                console.log(`🎮 Game restarted - Old PlayID: ${oldPlayId}, New PlayID: ${newPlayId}, Game: ${gameNumber}, PIN: ${newPin}`);
                
                // Update global game info with new PIN and PlayID
                currentGameInfo = {
                    playId: newPlayId,
                    pin: newPin,
                    gameNumber: parseInt(gameNumber) || 0,
                    lastUpdated: new Date().toISOString()
                };
                console.log(`📌 Updated global game info: PIN ${newPin}, PlayID ${newPlayId}`);
                
                // Mark this connection for reconnection
                connectionData.playId = newPlayId;
                connectionData.questionsAnswered = 0;
                connectionData.lastActivity = Date.now();
                connectionData.needsReconnection = true;
                connectionData.newPin = newPin;
                
                console.log(`🔄 Closing connection for ${playerName} and starting auto-reconnection...`);
                
                // Close current WebSocket
                ws.close();
                
                // Auto-reconnect user and all bots after a short delay (simple approach)
                setTimeout(async () => {
                    try {
                        console.log(`🚀 Starting simple auto-reconnection to new PIN: ${newPin}`);
                        
                        // 1. Get list of bots that were connected to the old game
                        const activeBots = Array.from(activeConnections.values())
                            .filter(conn => conn.isBot && conn.connected && conn.playId === oldPlayId);
                        
                        const botNames = activeBots.map(bot => bot.playerName);
                        console.log(`🤖 Found ${botNames.length} bots to recreate:`, botNames);
                        
                        // 2. Simple reconnection: main player joins new PIN (like manual disconnect + reconnect)
                        console.log(`🔌 Auto-reconnecting main player: ${playerName} to PIN ${newPin}`);
                        await simpleReconnectPlayer(connectionId, newPin, playerName, connectionData.autoAnswer || false);
                        
                        // 3. Add bots to new game (like manually adding them again)
                        for (const botName of botNames) {
                            try {
                                console.log(`🤖 Re-adding bot: ${botName} to new PIN ${newPin}`);
                                await simpleAddBot(newPin, botName);
                            } catch (error) {
                                console.error(`❌ Failed to re-add bot ${botName}:`, error);
                            }
                        }
                        
                        console.log(`✅ Simple auto-reconnection completed for PIN ${newPin}`);
                        
                    } catch (error) {
                        console.error(`❌ Simple auto-reconnection failed:`, error);
                    }
                }, 2000); // Wait 2 seconds before reconnecting
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "ShowMedal") {
                const rankingCode = parsedMessage.arguments[0];
                console.log(`🏆🏆🏆 MEDAL RECEIVED for ${playerName}: ranking code ${rankingCode} 🏆🏆🏆`);
                
                // Decode medal ranking: 0=3rd place, 1=2nd place, 2=1st place
                const medalMapping = {
                    0: { place: "3rd", emoji: "🥉", name: "Bronze Medal", italian: "terzo", position: 0 },
                    1: { place: "2nd", emoji: "🥈", name: "Silver Medal", italian: "secondo", position: 1 },
                    2: { place: "1st", emoji: "🥇", name: "Gold Medal", italian: "primo", position: 2 }
                };
                
                const medal = medalMapping[rankingCode];
                if (medal) {
                    // Store medal result
                    connectionData.medalPosition = rankingCode;
                    connectionData.medalData = medal;
                    connectionData.medalTimestamp = Date.now();
                    connectionData.gameCompleted = true; // Mark game as completed
                    
                    console.log(`🏅🏅🏅 ${playerName} ha ottenuto ${medal.emoji} ${medal.name} (${medal.italian} posto)! 🏅🏅🏅`);
                    console.log(`📊 Medal data stored:`, medal);
                } else {
                    console.log(`🏅 Unknown medal ranking code: ${rankingCode} for ${playerName}`);
                }
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "QuizAlreadyStarted") {
                console.log(`⚠️ Quiz already started for ${playerName} (ID: ${connectionId})`);
                connectionData.quizAlreadyStarted = true;
                connectionData.quizAlreadyStartedTime = Date.now();
                ws.close();
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "PlayerDisconnected" && parsedMessage.arguments[0] === true) {
                console.log(`Player ${playerName} disconnected from game`);
                connectionData.connected = false;
                ws.close();
            }
        } catch (error) {
            console.error('Message parsing error:', error);
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${playerName}:`, error);
        connectionData.connected = false;
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for ${playerName}`);
        connectionData.connected = false;
        // Keep the connection data for a while for status queries
        setTimeout(() => {
            activeConnections.delete(connectionId);
        }, 30000); // Clean up after 30 seconds
    });

    return connectionData;
}

// API Routes

// Validate PIN endpoint (separate from joining)
app.post('/api/validate-pin', async (req, res) => {
    try {
        const { pinCode } = req.body;

        if (!pinCode) {
            return res.status(400).json({ error: 'Il codice PIN è richiesto' });
        }

        console.log(`PIN validation request: ${pinCode}`);

        // Validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Codice PIN non valido' });
        }

        console.log(`PIN validated successfully: PlayID=${playId}`);

        res.json({
            success: true,
            playId: playId,
            pinCode: pinCode,
            message: 'PIN è valido'
        });

    } catch (error) {
        console.error('PIN validation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send manual answer endpoint
app.post('/api/answer/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const { answerIndex } = req.body; // 0=A, 1=B, 2=C, 3=D
        const connectionData = activeConnections.get(connectionId);
        
        if (!connectionData) {
            return res.status(404).json({ error: 'Connection not found' });
        }
        
        if (!connectionData.currentQuestion) {
            return res.status(400).json({ error: 'No current question available' });
        }
        
        const ws = connectionData.ws;
        const playId = connectionData.playId;
        
        if (ws && ws.readyState === ws.OPEN) {
            const answerMessage = {
                type: 1,
                target: "AnswerGivenFromPlayer",
                arguments: [playId, answerIndex.toString(), 500]
            };
            
            ws.send(JSON.stringify(answerMessage) + '\u001e');
            
            // Store the chosen answer
            connectionData.lastChosenAnswer = answerIndex;
            connectionData.questionsAnswered++;
            
            const letters = ['A','B','C','D','E','F'];
            console.log(`✅ Manual answer sent for ${connectionData.playerName}: ${answerIndex} (${letters[answerIndex]})`);
            
            res.json({
                success: true,
                answerSent: answerIndex,
                answerLetter: letters[answerIndex],
                correctAnswer: connectionData.currentQuestion.correctAnswerIndex,
                wasCorrect: answerIndex === connectionData.currentQuestion.correctAnswerIndex
            });
        } else {
            res.status(400).json({ error: 'WebSocket connection not available' });
        }
        
    } catch (error) {
        console.error(`Manual answer error: ${error.message}`);
        res.status(500).json({ error: 'Failed to send answer' });
    }
});

// Join game endpoint (requires valid PIN and player name)
app.post('/api/join', async (req, res) => {
    try {
        const { pinCode, playerName } = req.body;

        if (!pinCode || !playerName) {
            return res.status(400).json({ error: 'Codice PIN e nome giocatore sono richiesti' });
        }

        console.log(`Join request: PIN=${pinCode}, Player=${playerName}`);

        // First validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Codice PIN non valido' });
        }

        console.log(`PIN validated: PlayID=${playId}`);

        // Fetch game data to store for each connection
        const gameData = await fetchGameData(playId);
        if (!gameData) {
            console.log('⚠️ No quiz data found, but continuing with connection...');
            // Don't fail the join process, just continue without quiz data for now
            // This allows the connection to work even if quiz data retrieval fails
        }

        // Negotiate SignalR connection
        const negotiation = await negotiateSignalRConnection();
        if (!negotiation) {
            return res.status(500).json({ error: 'Impossibile negoziare la connessione' });
        }

        console.log('SignalR connection negotiated successfully');

        // Create connection ID
        const connectionId = uuidv4();

        const ownerIp = getClientIp(req);

        // Establish WebSocket connection
        const connectionData = await createEnhancedWebSocketConnection(
            negotiation.websocketUrl, 
            playId, 
            playerName, 
            connectionId,
            gameData,
            { ownerIp, isBot: false }
        );

        // Store quiz data for this connection
        if (gameData && gameData.quiz) {
            connectionData.quizData = gameData.quiz;
            console.log(`📚 Quiz data stored for ${playerName}:`, {
                questions: gameData.quiz.questions ? gameData.quiz.questions.length : 0,
                firstQuestion: gameData.quiz.questions?.[0]?.text?.substring(0, 50) + '...'
            });
        }

        res.json({
            success: true,
            connectionId: connectionId,
            playId: playId,
            playerName: playerName,
            message: 'Ti sei unito con successo alla partita'
        });

    } catch (error) {
        console.error('Join game error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Return a PlayID for a given PIN without joining any connection
app.post('/api/playid-from-pin', async (req, res) => {
    try {
        const { pinCode } = req.body || {};
        if (!pinCode) {
            return res.status(400).json({ error: 'Codice PIN richiesto' });
        }

        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Pin non valido o playId non disponibile' });
        }

        return res.json({ success: true, playId });
    } catch (error) {
        console.error('playid-from-pin error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Bulk disconnect all bots created by a specific IP
app.post('/api/admin/bulk-disconnect-bots', requireAdmin, requireCsrf, (req, res) => {
    const { ip } = req.body;
    
    if (!ip || typeof ip !== 'string') {
        return res.status(400).json({ error: 'IP non valido' });
    }
    
    const normalizedIp = normalizeIp(ip);
    let disconnected = 0;
    
    for (const [connectionId, connection] of activeConnections.entries()) {
        // Only disconnect bots created by this IP
        if (connection.isBot && normalizeIp(connection.ownerIp) === normalizedIp) {
            if (connection.ws && connection.connected) {
                connection.ws.close();
            }
            connection.connected = false;
            disconnected++;
            console.log(`🔌 Disconnected bot ${connection.playerName} from IP ${ip}`);
        }
    }
    
    return res.json({ success: true, disconnected: disconnected, ip: ip });
});
app.post('/api/bulk-join', async (req, res) => {
    try {
        const { pinCode, botNames } = req.body;

        if (!pinCode || !Array.isArray(botNames) || botNames.length === 0) {
            return res.status(400).json({ error: 'Codice PIN e lista nomi bot sono richiesti' });
        }

        console.log(`🤖 Bulk bot join request: PIN=${pinCode}, Bots=${botNames.length}`);

        // Check if the player has bot feature disabled
        const playerIp = normalizeIp(getClientIp(req));
        const playerConnections = Array.from(activeConnections.values())
            .filter(conn => normalizeIp(conn.ownerIp) === playerIp && !conn.isBot);
        
        for (const playerConn of playerConnections) {
            if (playerConn.moderation && playerConn.moderation.botDisabled) {
                console.log(`⚠️ Bot feature disabled for player ${playerConn.playerName} (moderation applied)`);
                if (playerConn.moderation.reason) {
                    return res.status(403).json({ error: 'Bot feature disabled', reason: playerConn.moderation.reason });
                }
                return res.status(403).json({ error: 'Bot feature disabled for this account' });
            }
        }

        // First validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Codice PIN non valido' });
        }

        // Fetch game data once for all bots
        const gameData = await fetchGameData(playId);
        if (!gameData) {
            console.log('⚠️ No quiz data found for bulk join, but continuing...');
            // Don't fail the bulk join process, just continue without quiz data for now
            // This allows bot connections to work even if quiz data retrieval fails
        }

        const ownerIp = getClientIp(req);

        const results = [];
        const errors = [];

        // Join each bot
        for (const botName of botNames) {
            try {
                // Negotiate SignalR connection for each bot
                const negotiation = await negotiateSignalRConnection();
                if (!negotiation) {
                    errors.push({ botName, error: 'Impossibile negoziare la connessione' });
                    continue;
                }

                // Create connection ID
                const connectionId = uuidv4();

                // Establish WebSocket connection
                const connectionData = await createEnhancedWebSocketConnection(
                    negotiation.websocketUrl, 
                    playId, 
                    botName, 
                    connectionId,
                    gameData,
                    { ownerIp, isBot: true }
                );

                // Quiz data already stored in createEnhancedWebSocketConnection
                console.log(`📚 Quiz data stored for bot ${botName}`);

                results.push({
                    success: true,
                    connectionId: connectionId,
                    playId: playId,
                    botName: botName,
                    isBot: true
                });

                console.log(`🤖 Bot ${botName} joined successfully (${connectionId})`);

            } catch (error) {
                console.error(`❌ Error joining bot ${botName}:`, error);
                errors.push({ botName, error: error.message });
            }
        }

        // Wait a moment for websockets to receive QuizAlreadyStarted messages
        await new Promise(resolve => setTimeout(resolve, 100));

        // Filter out bots that have quizAlreadyStarted flag
        const validResults = results.filter(bot => {
            const connectionData = activeConnections.get(bot.connectionId);
            if (connectionData && connectionData.quizAlreadyStarted) {
                console.log(`⚠️ Quiz already started for bot ${bot.botName}, removing from results`);
                errors.push({ botName: bot.botName, error: 'La partita è già iniziata' });
                return false;
            }
            return true;
        });

        res.json({
            success: true,
            totalBots: botNames.length,
            successfulJoins: validResults.length,
            failedJoins: errors.length,
            bots: validResults,
            errors: errors,
            message: `🤖 ${validResults.length}/${botNames.length} bot avviati con successo!`
        });

    } catch (error) {
        console.error('Bulk bot join error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get connection status
// Get quiz data for a connection (all questions with text and timer)
app.get('/api/quiz/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = activeConnections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({ error: 'Connessione non trovata' });
        }

        if (connection.quizData && connection.quizData.questions) {
            res.json({
                success: true,
                quiz: {
                    questions: connection.quizData.questions.map((q, index) => ({
                        id: index,
                        text: q.text || 'Domanda non disponibile',
                        timer: q.timer || 30,
                        originalData: q
                    }))
                }
            });
        } else {
            res.json({
                success: false,
                message: 'Dati quiz non disponibili'
            });
        }
    } catch (error) {
        console.error('Error getting quiz data:', error);
        res.status(500).json({ error: 'Errore durante il recupero del quiz' });
    }
});

// Get current question for a connection (for manual answer mode)
app.get('/api/question/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = activeConnections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({ error: 'Connessione non trovata' });
        }

        if (connection.currentQuestion) {
            res.json({
                success: true,
                question: {
                    ...connection.currentQuestion,
                    correctIndex: connection.correctAnswerIndex
                }
            });
        } else {
            res.json({
                success: false,
                message: 'Nessuna domanda disponibile'
            });
        }
    } catch (error) {
        console.error('Error getting current question:', error);
        res.status(500).json({ error: 'Errore durante il recupero della domanda' });
    }
});

// Set auto answer mode for a connection
app.post('/api/set-auto-answer/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const { autoAnswer } = req.body;
        const connection = activeConnections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({ error: 'Connessione non trovata' });
        }

        connection.autoAnswer = autoAnswer;
        console.log(`Auto answer mode for ${connection.playerName}: ${autoAnswer ? 'enabled' : 'disabled'}`);
        
        res.json({
            success: true,
            message: autoAnswer ? 'Auto answer abilitato' : 'Auto answer disabilitato'
        });
        
    } catch (error) {
        console.error('Error setting auto answer mode:', error);
        res.status(500).json({ error: 'Errore durante l\'impostazione della modalità' });
    }
});

// Send manual answer for a connection
app.post('/api/answer/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const { answerIndex } = req.body;
        const connection = activeConnections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({ error: 'Connessione non trovata' });
        }

        if (!connection.currentQuestion) {
            return res.status(400).json({ error: 'Nessuna domanda attiva' });
        }

        // Send answer via WebSocket
        const answerMessage = {
            type: 1,
            target: "AnswerGivenFromPlayer",
            arguments: [connection.playId, answerIndex.toString(), 500]
        };
        
        connection.ws.send(JSON.stringify(answerMessage) + '\u001e');
        connection.questionsAnswered++;
        
        console.log(`Manual answer sent for ${connection.playerName}: ${answerIndex} (Total: ${connection.questionsAnswered})`);
        
        res.json({
            success: true,
            message: 'Risposta inviata',
            isCorrect: answerIndex === connection.correctAnswerIndex
        });
        
        // Clear current question
        connection.currentQuestion = null;
        
    } catch (error) {
        console.error('Error sending manual answer:', error);
        res.status(500).json({ error: 'Errore durante l\'invio della risposta' });
    }
});

// Get medal result for a connection
app.get('/api/medal/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = activeConnections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({ error: 'Connessione non trovata' });
        }

        if (connection.medalPosition !== undefined || connection.medalData) {
            // Use medalData if available, otherwise create from medalPosition
            let medalInfo;
            
            if (connection.medalData) {
                // Use the detailed medal data stored from ShowMedal
                medalInfo = {
                    position: connection.medalData.position,
                    positionName: connection.medalData.italian,
                    emoji: connection.medalData.emoji,
                    name: connection.medalData.name,
                    timestamp: connection.medalTimestamp
                };
            } else {
                // Fallback: Correct mapping 0=3rd, 1=2nd, 2=1st
                const positionNames = { 0: 'terzo', 1: 'secondo', 2: 'primo' };
                const medals = { 0: '🥉', 1: '🥈', 2: '🥇' };
                
                medalInfo = {
                    position: connection.medalPosition,
                    positionName: positionNames[connection.medalPosition] || `posizione ${connection.medalPosition}`,
                    emoji: medals[connection.medalPosition] || '🏆',
                    timestamp: connection.medalTimestamp
                };
            }
            
            console.log(`🏆 Returning medal data for ${connectionId}:`, medalInfo);
            
            res.json({
                success: true,
                medal: medalInfo
            });
        } else {
            res.json({
                success: false,
                message: 'Nessuna medaglia assegnata'
            });
        }
    } catch (error) {
        console.error('Error getting medal result:', error);
        res.status(500).json({ error: 'Errore durante il recupero della medaglia' });
    }
});

app.get('/api/status/:connectionId', (req, res) => {
    const { connectionId } = req.params;
    const connection = activeConnections.get(connectionId);

    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }

    res.json({
        connected: connection.connected,
        questionsAnswered: connection.questionsAnswered,
        lastActivity: connection.lastActivity,
        playerName: connection.playerName,
        playId: connection.playId,
        quizAlreadyStarted: connection.quizAlreadyStarted || false,
        moderation: connection.moderation || {}
    });
});

  // Disconnect endpoint (admin only)
  app.post('/api/disconnect/:connectionId', requireAdmin, requireCsrf, (req, res) => {
      const { connectionId } = req.params;
      const connection = activeConnections.get(connectionId);
  
      if (!connection) {
          return res.status(404).json({ error: 'Connection not found' });
    }

    if (connection.ws && connection.connected) {
        connection.ws.close();
    }

    connection.connected = false;
    res.json({ success: true });
  });
  
  // Get all active connections (for debugging)
  app.get('/api/connections', requireAdmin, (req, res) => {
      const connections = Array.from(activeConnections.values()).map(conn => ({
          id: conn.id,
          playerName: conn.playerName,
          playId: conn.playId,
          connected: conn.connected,
          questionsAnswered: conn.questionsAnswered,
          lastActivity: conn.lastActivity,
          ip: normalizeIp(conn.ownerIp || '')
      }));
  
      res.json({ connections });
  });


// Function to reconnect a bot after PlayAgain (legacy)
async function reconnectBot(connectionId, newPlayId, playerName, newPin) {
    try {
        console.log(`🔄 Starting reconnection for ${playerName} to game ${newPlayId}...`);
        
        // Negotiate new SignalR connection
        const negotiation = await negotiateSignalRConnection();
        if (!negotiation) {
            console.error(`❌ Failed to negotiate new connection for ${playerName}`);
            return false;
        }
        
        // Fetch new game data for the new playId
        const gameData = await fetchGameData(newPlayId);
        if (!gameData) {
            console.log('⚠️ No quiz data found for reconnection, but continuing...');
        }
        
        // Preserve metadata from old connection
        const oldConnection = activeConnections.get(connectionId);
        const ownerIp = oldConnection?.ownerIp || '';

        // Remove old connection data
        activeConnections.delete(connectionId);
        
        // Create new WebSocket connection with same connectionId
        await createEnhancedWebSocketConnection(
            negotiation.websocketUrl,
            newPlayId,
            playerName,
            connectionId,
            gameData,
            { ownerIp, isBot: Boolean(oldConnection?.isBot) }
        );
        console.log(`✅ ${playerName} successfully reconnected to game ${newPlayId}`);
        return true;
        
    } catch (error) {
        console.error(`❌ Reconnection failed for ${playerName}:`, error);
        return false;
    }
}

// Endpoint to trigger bot reconnection after PlayAgain
app.post('/api/reconnect-bots', async (req, res) => {
    try {
        const reconnectionPromises = [];
        
        // Find all connections that need reconnection
        for (const [connectionId, connection] of activeConnections.entries()) {
            if (connection.needsReconnection) {
                console.log(`🔄 Reconnecting bot: ${connection.playerName}`);
                
                const promise = reconnectBot(
                    connectionId, 
                    connection.playId, 
                    connection.playerName, 
                    connection.newPin
                ).then(success => ({
                    connectionId,
                    playerName: connection.playerName,
                    success
                }));
                
                reconnectionPromises.push(promise);
            }
        }
        
        const results = await Promise.all(reconnectionPromises);
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        
        res.json({
            success: true,
            reconnected: successful.length,
            failed: failed.length,
            results: results
        });
        
    } catch (error) {
        console.error('Bot reconnection error:', error);
        res.status(500).json({ error: 'Errore durante la riconnessione dei bot' });
    }
});

// Get current game info (PIN, PlayID updated via PlayAgain)
app.get('/api/current-game', (req, res) => {
    try {
        res.json({
            success: true,
            gameInfo: currentGameInfo
        });
    } catch (error) {
        console.error('Error getting current game info:', error);
        res.status(500).json({ error: 'Errore durante il recupero delle informazioni di gioco' });
    }
});

// Get connections by PlayID (for multi-player management)
app.get('/api/connections/game/:playId', (req, res) => {
    const { playId } = req.params;
    const gameConnections = Array.from(activeConnections.values())
        .filter(conn => conn.playId === playId)
        .map(conn => ({
            id: conn.id,
            playerName: conn.playerName,
            connected: conn.connected,
            questionsAnswered: conn.questionsAnswered,
            lastActivity: conn.lastActivity
        }));

    res.json({
        playId: playId,
        totalPlayers: gameConnections.length,
        activePlayers: gameConnections.filter(p => p.connected).length,
        players: gameConnections
    });
});

// Bulk disconnect endpoint
app.post('/api/bulk-disconnect', (req, res) => {
    try {
        const { connectionIds } = req.body;

        if (!Array.isArray(connectionIds) || connectionIds.length === 0) {
            return res.status(400).json({ error: 'Lista connection IDs richiesta' });
        }

        const results = [];
        const errors = [];

        for (const connectionId of connectionIds) {
            try {
                const connection = activeConnections.get(connectionId);
                if (!connection) {
                    errors.push({ connectionId, error: 'Connessione non trovata' });
                    continue;
                }

                if (connection.ws && connection.connected) {
                    connection.ws.close();
                }
                connection.connected = false;

                results.push({
                    connectionId: connectionId,
                    playerName: connection.playerName,
                    disconnected: true
                });

            } catch (error) {
                errors.push({ connectionId, error: error.message });
            }
        }

        res.json({
            success: true,
            totalRequests: connectionIds.length,
            successfulDisconnects: results.length,
            failedDisconnects: errors.length,
            disconnected: results,
            errors: errors
        });

    } catch (error) {
        console.error('Bulk disconnect error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        activeConnections: activeConnections.size,
        uptime: process.uptime()
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean up inactive connections periodically
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    for (const [connectionId, connection] of activeConnections.entries()) {
        if (now - connection.lastActivity > timeout) {
            console.log(`Cleaning up inactive connection: ${connection.playerName} (${connectionId})`);
            if (connection.ws) {
                connection.ws.close();
            }
            activeConnections.delete(connectionId);
        }
    }
}, 60000); // Check every minute

// Export for Vercel serverless
export default app;

// Start server (always for hosting services or development)
const shouldStartServer = process.env.NODE_ENV !== 'production' || 
                         process.env.RAILWAY_ENVIRONMENT || 
                         process.env.RENDER || 
                         process.env.PORT ||
                         !process.env.VERCEL;

if (shouldStartServer) {
    (async () => {
        await ensureAdminSecretReady();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Panquiz Proxy Server running on http://0.0.0.0:${PORT}`);
            console.log(`📂 Serving web interface from /public`);
            console.log(`🔗 API endpoints available at /api/*`);
            console.log(`🌐 External URL will be provided by hosting service`);
            
            // Load persistent bans and start countdown timer
            loadBanTimers();
            startBanCountdown();
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('Received SIGTERM, shutting down gracefully...');
            
            // Close all WebSocket connections
            for (const connection of activeConnections.values()) {
                if (connection.ws) {
                    connection.ws.close();
                }
            }
            
            process.exit(0);
        });
    })().catch((err) => {
        console.error('❌ Failed to start server:', err?.message || err);
        process.exit(1);
    });
}

// Auto-reconnect player after PlayAgain
async function autoReconnectPlayer(connectionId, newPin, playerName, connectionData) {
    try {
        console.log(`🔌 Starting auto-reconnection for player ${playerName} to PIN ${newPin}`);
        
        // Join the new game
        const gameData = await startGame(newPin, playerName);
        
        // Create new WebSocket connection
        const newConnection = await createEnhancedWebSocketConnection(
            gameData.websocketUrl,
            gameData.playId,
            playerName,
            connectionId,
            gameData,
            { ownerIp: connectionData?.ownerIp || '', isBot: Boolean(connectionData?.isBot) }
        );
        
        // Update connection properties
        newConnection.autoAnswer = connectionData.autoAnswer || false;
        newConnection.isBot = false;
        newConnection.needsReconnection = false;
        newConnection.reconnectedAt = Date.now();
        
        console.log(`✅ Player ${playerName} auto-reconnected to game ${newPin}`);
        return newConnection;
        
    } catch (error) {
        console.error(`❌ Auto-reconnection failed for player ${playerName}:`, error);
        throw error;
    }
}

// Auto-reconnect bot after PlayAgain
async function autoReconnectBot(botConnectionId, newPin, botName) {
    try {
        console.log(`🤖 Starting auto-reconnection for bot ${botName} to PIN ${newPin}`);
        
        // Join the new game
        const gameData = await startGame(newPin, botName);
        
        // Create new WebSocket connection for bot
        const oldConnection = activeConnections.get(botConnectionId);
        const newConnection = await createEnhancedWebSocketConnection(
            gameData.websocketUrl,
            gameData.playId,
            botName,
            botConnectionId,
            gameData,
            { ownerIp: oldConnection?.ownerIp || '', isBot: true }
        );
        
        // Restore bot properties
        newConnection.autoAnswer = true; // Bots always auto-answer
        newConnection.isBot = true;
        newConnection.needsReconnection = false;
        newConnection.reconnectedAt = Date.now();
        
        console.log(`✅ Bot ${botName} auto-reconnected to game ${newPin}`);
        return newConnection;
        
    } catch (error) {
        console.error(`❌ Auto-reconnection failed for bot ${botName}:`, error);
        throw error;
    }
}

// Helper function to start/join a game (replicates /api/join logic)
async function startGame(pinCode, playerName) {
    try {
        // Validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            throw new Error(`Invalid PIN: ${pinCode}`);
        }

        // Fetch game data
        const gameData = await fetchGameData(playId);

        // Negotiate SignalR connection
        const negotiation = await negotiateSignalRConnection();
        if (!negotiation) {
            throw new Error('Failed to negotiate SignalR connection');
        }

        return {
            playId,
            gameData,
            websocketUrl: negotiation.websocketUrl,
            negotiation
        };
    } catch (error) {
        console.error(`❌ startGame failed for PIN ${pinCode}:`, error);
        throw error;
    }
}

// Simple reconnect player (like manual disconnect + join new PIN)
async function simpleReconnectPlayer(connectionId, newPin, playerName, autoAnswer) {
    try {
        console.log(`🔌 Simple reconnection: ${playerName} joining PIN ${newPin}`);
        
        // Just join the new PIN (like user manually entering new PIN)
        const gameInfo = await startGame(newPin, playerName);
        
        // Create fresh WebSocket connection with new connectionId
        const oldConnection = activeConnections.get(connectionId);
        const newConnection = await createEnhancedWebSocketConnection(
            gameInfo.websocketUrl,
            gameInfo.playId,
            playerName,
            connectionId, // Reuse same connectionId for continuity
            gameInfo.gameData,
            { ownerIp: oldConnection?.ownerIp || '', isBot: false }
        );
        
        // Set basic properties
        newConnection.autoAnswer = autoAnswer;
        newConnection.isBot = false;
        
        console.log(`✅ Player ${playerName} simply reconnected to PIN ${newPin}`);
        return newConnection;
        
    } catch (error) {
        console.error(`❌ Simple reconnection failed for ${playerName}:`, error);
        throw error;
    }
}

// Simple add bot (like manually adding bot to new game)
async function simpleAddBot(newPin, botName) {
    try {
        console.log(`🤖 Simply adding bot ${botName} to PIN ${newPin}`);
        
        // Generate new connectionId for bot
        const { v4: uuidv4 } = await import('uuid');
        const botConnectionId = uuidv4();
        
        // Join the new game (fresh start)
        const gameInfo = await startGame(newPin, botName);
        
        // Create fresh bot connection
        const newConnection = await createEnhancedWebSocketConnection(
            gameInfo.websocketUrl,
            gameInfo.playId,
            botName,
            botConnectionId,
            gameInfo.gameData,
            { isBot: true }
        );
        
        // Set bot properties
        newConnection.autoAnswer = true;
        newConnection.isBot = true;
        
        console.log(`✅ Bot ${botName} simply added to PIN ${newPin}`);
        return newConnection;
        
    } catch (error) {
        console.error(`❌ Simple bot add failed for ${botName}:`, error);
        throw error;
    }
}
