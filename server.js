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

// Store active connections
const activeConnections = new Map();

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
            const parsedMessage = JSON.parse(message.toString().replace('\u001e', ''));

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

                console.log(`Question received for ${playerName}, answering...`);

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
                    console.log(`Answer sent for ${playerName}: ${mappedAnswer} (Total: ${connectionData.questionsAnswered})`);
                }
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
            message: 'PIN è valido'
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
            return res.status(400).json({ error: 'Codice PIN e nome giocatore sono richiesti' });
        }

        console.log(`Join request: PIN=${pinCode}, Player=${playerName}`);

        // First validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Codice PIN non valido' });
        }

        console.log(`PIN validated: PlayID=${playId}`);

        // Negotiate SignalR connection
        const negotiation = await negotiateSignalRConnection();
        if (!negotiation) {
            return res.status(500).json({ error: 'Impossibile negoziare la connessione' });
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
            message: 'Ti sei unito con successo alla partita'
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

// Start server only in development
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Panquiz Proxy Server running on http://localhost:${PORT}`);
        console.log(`📂 Serving web interface from /public`);
        console.log(`🔗 API endpoints available at /api/*`);
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
}