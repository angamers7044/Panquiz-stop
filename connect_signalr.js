import WebSocket from 'ws';

export function establishWebSocketConnection(websocketUrl, playId, playerName) {
    const ws = new WebSocket(websocketUrl);

    ws.on('open', () => {
        console.log('🔗 WebSocket connection opened');
        const handshake = { protocol: "json", version: 1 };
        ws.send(JSON.stringify(handshake) + '\u001e');
    });

    ws.on('message', (message) => {
        // Log ALL messages to catch medal/results events
        console.log(`📨 RAW MESSAGE: ${message.toString()}`);
        
        const parsedMessage = JSON.parse(message.toString().replace('\u001e', ''));
        
        // Log parsed message structure
        console.log(`📋 PARSED MESSAGE:`, JSON.stringify(parsedMessage, null, 2));

        if (message.toString() === "{}\u001e") {
            console.log('🤝 Sending PlayerJoined message');
            const playerJoined = {
                type: 1,
                target: "PlayerJoined",
                arguments: [playId, playerName]
            };
            ws.send(JSON.stringify(playerJoined) + '\u001e');
        }

        if (parsedMessage.type === 1 && parsedMessage.target === "ShowQuestion") {
            console.log('❓ Question received, processing...');
            const questionData = parsedMessage.arguments[0];
            const rightAnswer = questionData.rightAnswer;
            const maxAnswers = questionData.maxAnswers;

            const answerMapping = {};
            for (let i = 0; i < maxAnswers; i++) {
                const binaryRepresentation = Array(maxAnswers).fill("0");
                binaryRepresentation[i] = "1";
                const binaryString = binaryRepresentation.join("");
                answerMapping[binaryString] = i.toString();
            }

            const mappedAnswer = answerMapping[rightAnswer];

            if (mappedAnswer !== undefined) {
                console.log(`✅ Sending answer: ${mappedAnswer}`);
                const answerMessage = {
                    type: 1,
                    target: "AnswerGivenFromPlayer",
                    arguments: [playId, mappedAnswer, 500]
                };
                ws.send(JSON.stringify(answerMessage) + '\u001e');
            }
        }

        // Handle ShowMedal event specifically
        if (parsedMessage.type === 1 && parsedMessage.target === "ShowMedal") {
            const rankingCode = parsedMessage.arguments[0];
            
            // Decode medal ranking: 0=3rd place, 1=2nd place, 2=1st place
            const medalMapping = {
                0: { place: "3rd", emoji: "🥉", name: "Bronze Medal" },
                1: { place: "2nd", emoji: "🥈", name: "Silver Medal" },
                2: { place: "1st", emoji: "🥇", name: "Gold Medal" }
            };
            
            const medal = medalMapping[rankingCode];
            if (medal) {
                console.log(`🏅 MEDAL AWARDED! ${medal.emoji} ${medal.name} (${medal.place} place)`);
                console.log(`🎉 Player: ${playerName} earned ${medal.place} place!`);
            } else {
                console.log(`🏅 UNKNOWN MEDAL RANKING: ${rankingCode}`);
            }
        }

        // Check for other potential medal/results events
        if (parsedMessage.type === 1) {
            const target = parsedMessage.target;
            
            // Look for other potential medal/results related events
            if (target && target !== "ShowMedal" && (
                target.includes('Result') || 
                target.includes('Medal') || 
                target.includes('Achievement') || 
                target.includes('Award') || 
                target.includes('Score') || 
                target.includes('End') || 
                target.includes('Finish') || 
                target.includes('Complete') ||
                target.includes('Summary') ||
                target.includes('Stats')
            )) {
                console.log(`🏅 OTHER MEDAL EVENT: ${target}`);
                console.log(`🏅 ARGUMENTS:`, JSON.stringify(parsedMessage.arguments, null, 2));
            }
        }

        if (parsedMessage.type === 1 && parsedMessage.target === "PlayerDisconnected" && parsedMessage.arguments[0] === true) {
            console.log('👋 Player disconnected - keeping connection open for medals');
            
            // Don't close immediately - medals might still come through WebSocket
            setTimeout(() => {
                console.log('🔌 Closing WebSocket after medal capture delay');
                if (ws.readyState === ws.OPEN) {
                    ws.close();
                }
            }, 10000); // Wait 10 seconds for medals
        }
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
    });
}