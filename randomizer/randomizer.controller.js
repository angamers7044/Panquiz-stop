import fetch from 'node-fetch';
import { URLSearchParams } from 'url';
import WebSocket from 'ws';

export let bruteForceState = {
    running: false,
    currentPin: null,
    startPin: null,
    found: null,
    log: [],
    stopRequested: false,
    authenticator: null,
    tempConnections: new Map() // Track temp connections for QuizAlreadyStarted check
};

function getRandomizerStatus(req, res) {
    res.json({
        running: bruteForceState.running,
        currentPin: bruteForceState.currentPin,
        startPin: bruteForceState.startPin,
        found: bruteForceState.found,
        log: bruteForceState.log.slice(-100)
    });
}

// Test a PIN by trying to connect and waiting for QuizAlreadyStarted message
async function testPinForAvailability(pinCode, playData) {
    return new Promise(async (resolve) => {
        try {
            // Negotiate SignalR connection
            const firstNegotiateUrl = "https://play.panquiz.com/api/v1/playHub/negotiate?negotiateVersion=1";
            const headers = {
                "Content-Type": "text/plain;charset=UTF-8",
                "Accept": "*/*",
                "Origin": "https://play.panquiz.com",
                "Referer": "https://play.panquiz.com/",
                "User-Agent": "Mozilla/5.0",
                "X-Requested-With": "XMLHttpRequest",
                "x-signalr-user-agent": "Microsoft SignalR/6.0 (6.0.7; Unknown OS; Browser; Unknown Runtime Version)"
            };

            const firstResponse = await fetch(firstNegotiateUrl, { method: 'POST', headers });
            const firstData = await firstResponse.json();
            const accessToken = firstData.accessToken;
            const websocketUrl = firstData.url;

            if (!accessToken || !websocketUrl) {
                resolve({ available: false, reason: 'negotiation_failed' });
                return;
            }

            const urlObj = new URL(websocketUrl);
            const asrsRequestId = urlObj.searchParams.get("asrs_request_id");
            const secondNegotiateUrl = `${urlObj.origin}/client/negotiate?hub=playhub&asrs.op=%2Fv1%2FplayHub&negotiateVersion=1&asrs_request_id=${asrsRequestId}`;
            headers.Authorization = `Bearer ${accessToken}`;

            const secondResponse = await fetch(secondNegotiateUrl, { method: 'POST', headers });
            const secondData = await secondResponse.json();
            const connectionToken = secondData.connectionToken;

            if (!connectionToken) {
                resolve({ available: false, reason: 'no_token' });
                return;
            }

            const finalWebSocketUrl = `${websocketUrl}&id=${connectionToken}&access_token=${encodeURIComponent(accessToken)}`;
            const ws = new WebSocket(finalWebSocketUrl);

            // Set a 1-second timeout
            let quizAlreadyStartedReceived = false;
            const timeoutId = setTimeout(() => {
                ws.close();
                // If no QuizAlreadyStarted received, the quiz is available
                resolve({ available: !quizAlreadyStartedReceived, reason: 'timeout' });
            }, 1000);

            ws.on('open', () => {
                const handshake = { protocol: "json", version: 1 };
                ws.send(JSON.stringify(handshake) + '\u001e');
                
                // Send PlayerJoined
                const playerJoined = {
                    type: 1,
                    target: "PlayerJoined",
                    arguments: [playData.playId, "QuizRandomizer"]
                };
                ws.send(JSON.stringify(playerJoined) + '\u001e');
            });

            ws.on('message', (message) => {
                try {
                    const parsedMessage = JSON.parse(message.toString().replace('\u001e', ''));
                    
                    // Check for QuizAlreadyStarted message
                    if (parsedMessage.type === 1 && parsedMessage.target === "QuizAlreadyStarted") {
                        quizAlreadyStartedReceived = true;
                        clearTimeout(timeoutId);
                        ws.close();
                        resolve({ available: false, reason: 'quiz_already_started' });
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            });

            ws.on('error', () => {
                clearTimeout(timeoutId);
                ws.close();
                resolve({ available: false, reason: 'ws_error' });
            });

            ws.on('close', () => {
                clearTimeout(timeoutId);
            });
        } catch (error) {
            resolve({ available: false, reason: 'exception' });
        }
    });
}

async function startRandomizer(req, res) {
    if (bruteForceState.running) {
        return res.status(400).json({ error: 'Brute force already running' });
    }
    const { startPin, authenticator } = req.body;
    if (typeof startPin !== 'number' || startPin < 0 || startPin > 999999) {
        return res.status(400).json({ error: 'Invalid startPin' });
    }
    bruteForceState.running = true;
    bruteForceState.stopRequested = false;
    bruteForceState.startPin = startPin;
    bruteForceState.currentPin = startPin;
    bruteForceState.found = null;
    bruteForceState.authenticator = authenticator || null;
    bruteForceState.log = [`🚀 Controllo PIN in corso partendo da: ${startPin.toString().padStart(6, '0')}...`];

    // Parallel batch optimization
    (async () => {
        const BATCH_SIZE = 50;
        for (let i = startPin; i <= 999999; i += BATCH_SIZE) {
            if (!bruteForceState.running || bruteForceState.stopRequested) {
                bruteForceState.log.push('⏹️ Brute force fermato manualmente.');
                bruteForceState.running = false;
                break;
            }
            const batch = [];
            for (let j = 0; j < BATCH_SIZE && (i + j) <= 999999; j++) {
                const pinNum = i + j;
                const pinCode = pinNum.toString().padStart(6, '0');
                const params = new URLSearchParams();
                params.append('pincode', pinCode);
                batch.push(
                    fetch('https://play.panquiz.com/api/v1/player/pin', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: params
                    })
                    .then(async response => {
                        let data;
                        try { data = await response.json(); } catch { data = null; }
                        return { pinCode, data };
                    })
                    .catch(error => ({ pinCode, error }))
                );
            }
            const results = await Promise.all(batch);
            for (const result of results) {
                bruteForceState.currentPin = parseInt(result.pinCode, 10);
                if (result.error) {
                    bruteForceState.log.push(`⚠️ Errore di connessione con PIN ${result.pinCode}: ${result.error.message || result.error}`);
                } else if (result.data && result.data.errorCode === 0) {
                    // PIN is valid - now check if quiz is already started
                    bruteForceState.log.push(`🎯 PIN VALIDO trovato: ${result.pinCode} - Verifico disponibilità quiz...`);
                    
                    // Test the PIN for availability (wait 1 second for QuizAlreadyStarted)
                    const testResult = await testPinForAvailability(result.pinCode, result.data);
                    
                    if (testResult.available) {
                        // Quiz is available!
                        bruteForceState.log.push(`✅ PIN DISPONIBILE: ${result.pinCode} - QUIZ TROVATO!`);
                        bruteForceState.found = { pin: result.pinCode, data: result.data };
                        bruteForceState.running = false;
                        return;
                    } else {
                        // Quiz already started, continue searching
                        bruteForceState.log.push(`⏳ PIN ${result.pinCode} - Quiz già avviato, continuo ricerca...`);
                    }
                } else if (result.data && result.data.errorCode === 1) {
                    bruteForceState.log.push(`❌ PIN ${result.pinCode} errato (errorCode: 1)`);
                } else {
                    bruteForceState.log.push(`❓ Risposta insolita per ${result.pinCode}: ${JSON.stringify(result.data)}`);
                }
            }
        }
        bruteForceState.running = false;
    })();
    res.json({ started: true });
}

function stopRandomizer(req, res) {
    bruteForceState.stopRequested = true;
    bruteForceState.running = false;
    bruteForceState.authenticator = null;
    res.json({ stopped: true });
}

function getCorrectAnswer(q) {
    if (typeof q.correct === 'string' && q.correct.match(/^[01]+$/)) {
        const answers = [q.answer1, q.answer2, q.answer3, q.answer4, q.answer5, q.answer6];
        return answers.filter((a, i) => q.correct[i] === '1' && a).join(', ');
    }
    if (typeof q.correct === 'string' && q.correct.match(/^\d+$/)) {
        const idx = parseInt(q.correct, 10) - 1;
        const answers = [q.answer1, q.answer2, q.answer3, q.answer4, q.answer5, q.answer6];
        return answers[idx] || '';
    }
    return '';
}

function checkRandomizerAuthenticator(auth) {
    return auth && bruteForceState.authenticator && auth === bruteForceState.authenticator;
}

export { getRandomizerStatus, startRandomizer, stopRandomizer, getCorrectAnswer, checkRandomizerAuthenticator };
