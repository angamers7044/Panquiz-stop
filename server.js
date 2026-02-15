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

// Middleware
app.use(cors());
app.use(express.json());
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
async function createEnhancedWebSocketConnection(websocketUrl, playId, playerName, connectionId, gameData = null) {
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

        // Establish WebSocket connection
        const connectionData = await createEnhancedWebSocketConnection(
            negotiation.websocketUrl, 
            playId, 
            playerName, 
            connectionId,
            gameData
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

        // Fetch game data once for all bots
        const gameData = await fetchGameData(playId);
        if (!gameData) {
            console.log('⚠️ No quiz data found for bulk join, but continuing...');
            // Don't fail the bulk join process, just continue without quiz data for now
            // This allows bot connections to work even if quiz data retrieval fails
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
                    connectionId,
                    gameData
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
        lastActivity: conn.lastActivity,
        ip: conn.ip || (conn.req && (conn.req.ip || conn.req.connection?.remoteAddress)) || ''
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
        
        // Remove old connection data
        activeConnections.delete(connectionId);
        
        // Create new WebSocket connection with same connectionId
        await createEnhancedWebSocketConnection(negotiation.websocketUrl, newPlayId, playerName, connectionId, gameData);
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

// Auto-reconnect player after PlayAgain
async function autoReconnectPlayer(connectionId, newPin, playerName, connectionData) {
    try {
        console.log(`🔌 Starting auto-reconnection for player ${playerName} to PIN ${newPin}`);
        
        // Join the new game
        const gameData = await startGame(newPin, playerName);
        
        // Create new WebSocket connection
        const newConnection = createEnhancedWebSocketConnection(
            gameData.websocketUrl,
            gameData.playId,
            playerName,
            connectionId,
            gameData
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
        const newConnection = createEnhancedWebSocketConnection(
            gameData.websocketUrl,
            gameData.playId,
            botName,
            botConnectionId,
            gameData
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
        const newConnection = createEnhancedWebSocketConnection(
            gameInfo.websocketUrl,
            gameInfo.playId,
            playerName,
            connectionId, // Reuse same connectionId for continuity
            gameInfo.gameData
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
        const newConnection = createEnhancedWebSocketConnection(
            gameInfo.websocketUrl,
            gameInfo.playId,
            botName,
            botConnectionId,
            gameInfo.gameData
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
