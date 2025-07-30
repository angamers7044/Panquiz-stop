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
// Force port detection for different hosting services
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

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
        ws: ws,
        isMainPlayer: true, // This is the main player, not a bot
        autoAnswer: true    // Default to auto answer, can be changed via API
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

                console.log(`Question received for ${playerName}:`, {
                    question: questionData.question,
                    answers: questionData.answers,
                    rightAnswer: rightAnswer,
                    maxAnswers: maxAnswers
                });

                // Store question for manual answer mode
                connectionData.currentQuestion = {
                    question: questionData.question || 'Domanda non disponibile',
                    answers: questionData.answers || [],
                    rightAnswer: rightAnswer,
                    maxAnswers: maxAnswers,
                    questionNumber: connectionData.questionsAnswered + 1,
                    timestamp: Date.now()
                };

                const answerMapping = {};
                for (let i = 0; i < maxAnswers; i++) {
                    const binaryRepresentation = Array(maxAnswers).fill("0");
                    binaryRepresentation[i] = "1";
                    const binaryString = binaryRepresentation.join("");
                    answerMapping[binaryString] = i.toString();
                }

                const mappedAnswer = answerMapping[rightAnswer];
                connectionData.correctAnswerIndex = parseInt(mappedAnswer);

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
                console.log(`🔄 PlayAgain detected for ${playerName}!`);
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
                
                // Update connection data with new game info but mark for reconnection
                connectionData.playId = newPlayId;
                connectionData.questionsAnswered = 0;
                connectionData.lastActivity = Date.now();
                connectionData.needsReconnection = true;
                connectionData.newPin = newPin;
                
                console.log(`🔄 Marking ${playerName} for reconnection to new game ${newPlayId}...`);
                
                // Close current connection - reconnection will be handled externally
                ws.close();
            }

            if (parsedMessage.type === 1 && parsedMessage.target === "ShowMedal") {
                const medalPosition = parsedMessage.arguments[0];
                console.log(`🏆 Medal received for ${playerName}: position ${medalPosition}`);
                
                // Store medal result
                connectionData.medalPosition = medalPosition;
                connectionData.medalTimestamp = Date.now();
                
                // Medal position mapping: 1=second, 2=first, 3=third
                const positionNames = { 1: 'secondo', 2: 'primo', 3: 'terzo' };
                const positionName = positionNames[medalPosition] || `posizione ${medalPosition}`;
                
                console.log(`🎖️ ${playerName} ha ottenuto il ${positionName} posto!`);
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

// Bulk join endpoint - Add multiple bots at once
app.post('/api/bulk-join', async (req, res) => {
    try {
        const { pinCode, botNames } = req.body;

        if (!pinCode || !Array.isArray(botNames) || botNames.length === 0) {
            return res.status(400).json({ error: 'Codice PIN e lista nomi bot sono richiesti' });
        }

        console.log(`🤖 Bulk bot join request: PIN=${pinCode}, Bots=${botNames.length}`);

        // First validate PIN
        const playId = await validateMatchPin(pinCode);
        if (!playId) {
            return res.status(400).json({ error: 'Codice PIN non valido' });
        }

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
                    connectionId
                );

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

        res.json({
            success: true,
            totalBots: botNames.length,
            successfulJoins: results.length,
            failedJoins: errors.length,
            bots: results,
            errors: errors,
            message: `🤖 ${results.length}/${botNames.length} bot avviati con successo!`
        });

    } catch (error) {
        console.error('Bulk bot join error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get connection status
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

        if (connection.medalPosition) {
            // Medal position mapping: 1=second, 2=first, 3=third
            const positionNames = { 1: 'secondo', 2: 'primo', 3: 'terzo' };
            const medals = { 1: '🥈', 2: '🥇', 3: '🥉' };
            
            res.json({
                success: true,
                medal: {
                    position: connection.medalPosition,
                    positionName: positionNames[connection.medalPosition] || `posizione ${connection.medalPosition}`,
                    emoji: medals[connection.medalPosition] || '🏆',
                    timestamp: connection.medalTimestamp
                }
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

// Function to reconnect a bot after PlayAgain
async function reconnectBot(connectionId, newPlayId, playerName, newPin) {
    try {
        console.log(`🔄 Starting reconnection for ${playerName} to game ${newPlayId}...`);
        
        // Negotiate new SignalR connection
        const negotiation = await negotiateSignalRConnection();
        if (!negotiation) {
            console.error(`❌ Failed to negotiate new connection for ${playerName}`);
            return false;
        }
        
        // Remove old connection data
        activeConnections.delete(connectionId);
        
        // Create new WebSocket connection with same connectionId
        await createEnhancedWebSocketConnection(negotiation.websocketUrl, newPlayId, playerName, connectionId);
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
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Panquiz Proxy Server running on http://0.0.0.0:${PORT}`);
        console.log(`📂 Serving web interface from /public`);
        console.log(`🔗 API endpoints available at /api/*`);
        console.log(`🌐 External URL will be provided by hosting service`);
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