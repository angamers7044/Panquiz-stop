import fetch from 'node-fetch';
import { URLSearchParams } from 'url';

export let bruteForceState = {
    running: false,
    currentPin: null,
    startPin: null,
    found: null,
    log: [],
    stopRequested: false,
    authenticator: null
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

    // Aggressive parallel batch optimization (may hit rate limits!)
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
                    bruteForceState.log.push(`🎯 PIN VALIDO TROVATO: ${result.pinCode}`);
                    bruteForceState.log.push(`Dati ricevuti: ${JSON.stringify(result.data)}`);
                    bruteForceState.found = { pin: result.pinCode, data: result.data };
                    bruteForceState.running = false;
                    return;
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
