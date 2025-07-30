import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

// Import our existing modules
import { promptForMatchPin } from './validate_pin.js';
import { negotiateSignalRConnection } from './negotiate_connection.js';
import { establishWebSocketConnection } from './connect_signalr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Store active connections
const activeConnections = new Map();

// Enhanced logging for production
const log = {
    info: (msg) => console.log(`ℹ️  ${new Date().toISOString()} - ${msg}`),
    error: (msg) => console.error(`❌ ${new Date().toISOString()} - ${msg}`),
    medal: (player, msg) => console.log(`🏅 ${new Date().toISOString()} - [${player}] ${msg}`),
    event: (player, msg) => console.log(`🔍 ${new Date().toISOString()} - [${player}] ${msg}`),
    success: (msg) => console.log(`✅ ${new Date().toISOString()} - ${msg}`)
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Custom validation function that doesn't use readline
async function validateMatchPin(pin) {
    const fetch = (await import('node-fetch')).default;
    const { URLSearchParams } = await import('url');
    
    const url = "https://play.panquiz.com/api/v1/player/pin";
    const headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "*/*",
        "Origin": "https://play.panquiz.com",
        "Referer": "https://play.panquiz.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest"
    };
    
    // Ensure proper formatting of the PIN parameter
    const body = new URLSearchParams();
    body.append('pinCode', pin.toString().trim());

    console.log(`Validating PIN: ${pin}`);
    console.log(`Request body: ${body.toString()}`);

    try {
        const response = await fetch(url, { method: 'POST', headers, body });
        
        console.log(`Response status: ${response.status}`);
        
        if (!response.ok) {
            console.error(`HTTP error: ${response.status} ${response.statusText}`);
            return null;
        }
        
        const data = await response.json();
        console.log('Response data:', data);

        if (data.playId) {
            return data.playId;
        } else if (data.errorCode && data.errorCode !== 0) {
            console.error(`Panquiz error: ${data.errorCode}`);
            return null;
        } else {
            console.error('No playId in response');
            return null;
        }
    } catch (error) {
        console.error('PIN validation error:', error);
        return null;
    }
}

// Enhanced WebSocket connection with event tracking
async function createEnhancedWebSocketConnection(websocketUrl, playId, playerName, connectionId) {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(websocketUrl);
    
    const connectionData = {
        id: connectionId,
        playId,
        playerName,
        connected: false,
        questionsAnswered: 0,
        lastActivity: Date.now(),
        ws: ws
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
            // Log ALL WebSocket messages to catch medal/results events
            const rawMsg = message.toString();
            console.log(`📨 [${playerName}] RAW WEBSOCKET: ${rawMsg}`);
            
            // Skip empty/heartbeat messages
            if (rawMsg === "{}\u001e" || rawMsg.trim() === "{}") {
                console.log(`💓 [${playerName}] Heartbeat/handshake message`);
            }
            
            const parsedMessage = JSON.parse(rawMsg.replace('\u001e', ''));
            
            // Log ALL parsed WebSocket message structures
            console.log(`📋 [${playerName}] PARSED WEBSOCKET:`, JSON.stringify(parsedMessage, null, 2));

            if (message.toString() === "{}\u001e") {
                const playerJoined = {
                    type: 1,
                    target: "PlayerJoined",
                    arguments: [playId, playerName]
                };
                ws.send(JSON.stringify(playerJoined) + '\u001e');
                console.log(`🤝 Player ${playerName} joined game ${playId}`);
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "ShowQuestion") {
                const questionData = parsedMessage.arguments[0];
                const rightAnswer = questionData.rightAnswer;
                const maxAnswers = questionData.maxAnswers;

                console.log(`❓ Question received for ${playerName}, answering...`);

                const answerMapping = {};
                for (let i = 0; i < maxAnswers; i++) {
                    const binaryRepresentation = Array(maxAnswers).fill("0");
                    binaryRepresentation[i] = "1";
                    const binaryString = binaryRepresentation.join("");
                    answerMapping[binaryString] = i.toString();
                }

                const mappedAnswer = answerMapping[rightAnswer];

                if (mappedAnswer !== undefined) {
                    const answerMessage = {
                        type: 1,
                        target: "AnswerGivenFromPlayer",
                        arguments: [playId, mappedAnswer, 500]
                    };
                    ws.send(JSON.stringify(answerMessage) + '\u001e');
                    connectionData.questionsAnswered++;
                    console.log(`✅ Answer sent for ${playerName}: ${mappedAnswer} (Total: ${connectionData.questionsAnswered})`);
                }
            }

            // Check for potential medal/results events
            if (parsedMessage.type === 1) {
                const target = parsedMessage.target;
                
                // Look for potential medal/results related events
                if (target && (
                    target.includes('Result') || 
                    target.includes('Medal') || 
                    target.includes('Achievement') || 
                    target.includes('Award') || 
                    target.includes('Score') || 
                    target.includes('End') || 
                    target.includes('Finish') || 
                    target.includes('Complete') ||
                    target.includes('Summary') ||
                    target.includes('Stats') ||
                    target.includes('Leaderboard') ||
                    target.includes('Ranking') ||
                    target.includes('GameResult') ||
                    target.includes('QuizResult') ||
                    target.includes('MatchResult') ||
                    target.includes('PlayerResult') ||
                    target.includes('FinalScore') ||
                    target.includes('GameOver') ||
                    target.includes('QuizComplete')
                )) {
                    log.medal(playerName, `MEDAL/RESULTS EVENT: ${target}`);
                    log.medal(playerName, `DATA: ${JSON.stringify(parsedMessage.arguments, null, 2)}`);
                    
                    // Store medal data for later retrieval
                    if (!connectionData.medals) connectionData.medals = [];
                    connectionData.medals.push({
                        event: target,
                        data: parsedMessage.arguments,
                        timestamp: new Date().toISOString()
                    });
                }
                
                // Log ALL events we haven't seen before
                if (target !== "ShowQuestion" && target !== "PlayerDisconnected" && target !== "PlayerJoined") {
                    log.event(playerName, `NEW EVENT: ${target}`);
                    log.event(playerName, `ARGS: ${JSON.stringify(parsedMessage.arguments, null, 2)}`);
                }
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "PlayerDisconnected" && parsedMessage.arguments[0] === true) {
                log.info(`👋 Player ${playerName} received disconnect signal - keeping connection open for medals`);
                connectionData.connected = false;
                
                // Don't close immediately - medals might still come through WebSocket
                // Close after a delay to capture any final medal events
                setTimeout(() => {
                    log.info(`🔌 [${playerName}] Closing WebSocket after medal capture delay`);
                    if (ws.readyState === ws.OPEN) {
                        ws.close();
                    }
                }, 10000); // Wait 10 seconds for medals
            }
        } catch (error) {
            console.error('❌ Message parsing error:', error);
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
            return res.status(400).json({ error: 'PIN code is required' });
        }

        console.log(`PIN validation request: ${pinCode}`);

        // Validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Invalid PIN code' });
        }

        console.log(`PIN validated successfully: PlayID=${playId}`);

        res.json({
            success: true,
            playId: playId,
            message: 'PIN is valid'
        });

    } catch (error) {
        console.error('PIN validation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Join game endpoint (requires valid PIN and player name)
app.post('/api/join', async (req, res) => {
    try {
        const { pinCode, playerName } = req.body;

        if (!pinCode || !playerName) {
            return res.status(400).json({ error: 'PIN code and player name are required' });
        }

        console.log(`Join request: PIN=${pinCode}, Player=${playerName}`);

        // First validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Invalid PIN code' });
        }

        console.log(`PIN validated: PlayID=${playId}`);

        // Negotiate SignalR connection
        const negotiation = await negotiateSignalRConnection();
        if (!negotiation) {
            return res.status(500).json({ error: 'Failed to negotiate connection' });
        }

        console.log('SignalR connection negotiated successfully');

        // Create connection ID
        const connectionId = uuidv4();

        // Establish WebSocket connection
        const connectionData = await createEnhancedWebSocketConnection(
            negotiation.websocketUrl, 
            playId, 
            playerName, 
            connectionId
        );

        res.json({
            success: true,
            connectionId: connectionId,
            playId: playId,
            playerName: playerName,
            message: 'Successfully joined the game'
        });

    } catch (error) {
        console.error('Join game error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get connection status
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
        playId: connection.playId
    });
});

// Disconnect endpoint
app.post('/api/disconnect/:connectionId', (req, res) => {
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
app.get('/api/connections', (req, res) => {
    const connections = Array.from(activeConnections.values()).map(conn => ({
        id: conn.id,
        playerName: conn.playerName,
        playId: conn.playId,
        connected: conn.connected,
        questionsAnswered: conn.questionsAnswered,
        lastActivity: conn.lastActivity
    }));

    res.json(connections);
});

// Get medals for a connection
app.get('/api/medals/:connectionId', (req, res) => {
    try {
        const { connectionId } = req.params;
        const connectionData = activeConnections.get(connectionId);
        
        if (!connectionData) {
            return res.status(404).json({ error: 'Connection not found' });
        }
        
        res.json({
            success: true,
            medals: connectionData.medals || [],
            playerName: connectionData.playerName,
            questionsAnswered: connectionData.questionsAnswered
        });
    } catch (error) {
        log.error(`Medal retrieval error: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve medals' });
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

// Start server
app.listen(PORT, () => {
    log.success(`🚀 Panquiz Proxy Server running on port ${PORT}`);
    log.info(`📂 Environment: ${NODE_ENV}`);
    if (NODE_ENV === 'development') {
        log.info(`🔗 Local access: http://localhost:${PORT}`);
    } else {
        log.info(`🌐 Production deployment active on Render`);
    }
    log.success(`🔗 API endpoints available at /api/*`);
    log.success('🎯 Ready to join Panquiz games and capture medals!');
    log.info('🏅 Enhanced medal detection system enabled');
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

export default app;