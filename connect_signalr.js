import WebSocket from 'ws';

export function establishWebSocketConnection(websocketUrl, playId, playerName) {
    const ws = new WebSocket(websocketUrl);

    ws.on('open', () => {
        const handshake = { protocol: "json", version: 1 };
        ws.send(JSON.stringify(handshake) + '\u001e');
    });

    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message.toString().replace('\u001e', ''));

        if (message.toString() === "{}\u001e") {
            const playerJoined = {
                type: 1,
                target: "PlayerJoined",
                arguments: [playId, playerName]
            };
            ws.send(JSON.stringify(playerJoined) + '\u001e');
        }

        if (parsedMessage.type === 1 && parsedMessage.target === "ShowQuestion") {
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
                const answerMessage = {
                    type: 1,
                    target: "AnswerGivenFromPlayer",
                    arguments: [playId, mappedAnswer, 500]
                };
                ws.send(JSON.stringify(answerMessage) + '\u001e');
            }
        }

        if (parsedMessage.type === 1 && parsedMessage.target === "PlayAgain") {
            console.log('🔄 PlayAgain detected! Game restarting...');
            const [oldPlayId, newPlayId, gameNumber, newPin] = parsedMessage.arguments;
            
            console.log(`🎮 Game restarted - Old PlayID: ${oldPlayId}, New PlayID: ${newPlayId}, Game: ${gameNumber}, PIN: ${newPin}`);
            
            // Send PlayerJoined message for the new game session
            const playerJoinedAgain = {
                type: 1,
                target: "PlayerJoined",
                arguments: [newPlayId, playerName]
            };
            ws.send(JSON.stringify(playerJoinedAgain) + '\u001e');
            console.log(`✅ Player automatically rejoined new game ${newPlayId}`);
            
            // Update the playId for future messages in this session
            playId = newPlayId;
        }

        if (parsedMessage.type === 1 && parsedMessage.target === "PlayerDisconnected" && parsedMessage.arguments[0] === true) {
            ws.close();
        }
    });

    ws.on('error', () => {});
    ws.on('close', () => {});
}