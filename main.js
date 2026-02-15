import { promptForMatchPin } from './validate_pin.js';
import { negotiateSignalRConnection } from './negotiate_connection.js';
import { establishWebSocketConnection } from './connect_signalr.js';
import readline from 'readline-sync';

(async function main() {
    const playId = await promptForMatchPin();

    const playerName = readline.question("Inserisci il tuo nome giocatore: ").trim();
    if (!playerName) {
        return;
    }

    const negotiation = await negotiateSignalRConnection();
    if (!negotiation) {
        return;
    }

    establishWebSocketConnection(negotiation.websocketUrl, playId, playerName);
})();