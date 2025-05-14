import fetch from 'node-fetch';
import readline from 'readline-sync';
import { URLSearchParams } from 'url';

async function validateMatchPin(pin) {
    const url = "https://play.panquiz.com/api/v1/player/pin";
    const headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "*/*",
        "Origin": "https://play.panquiz.com",
        "Referer": "https://play.panquiz.com/",
        "User-Agent": "Mozilla/5.0"
    };
    const body = new URLSearchParams({ pinCode: pin });

    try {
        const response = await fetch(url, { method: 'POST', headers, body });
        const data = await response.json();

        if (data.playId) {
            return data.playId;
        } else {
            return null;
        }
    } catch (error) {
        return null;
    }
}

export async function promptForMatchPin() {
    while (true) {
        const pin = readline.question("Inserisci il PIN della partita: ");
        const playId = await validateMatchPin(pin);
        if (playId) return playId;
    }
}