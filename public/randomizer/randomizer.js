// --- Unique Authenticator Generation ---
function generateAuthenticator() {
    // 32-char random hex string
    return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
}
function setCookie(name, value, days) {
    let expires = '';
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days*24*60*60*1000));
        expires = '; expires=' + date.toUTCString();
    }
    document.cookie = name + '=' + (value || '')  + expires + '; path=/';
}
function getCookie(name) {
    const nameEQ = name + '=';
    const ca = document.cookie.split(';');
    for(let i=0;i < ca.length;i++) {
        let c = ca[i];
        while (c.charAt(0)==' ') c = c.substring(1,c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
    }
    return null;
}
let authenticator = getCookie('panquiz_auth');
if (!authenticator) {
    authenticator = generateAuthenticator();
    setCookie('panquiz_auth', authenticator, 365);
}
// For debug: show authenticator in UI
window.addEventListener('DOMContentLoaded', () => {
    let el = document.getElementById('authenticatorDisplay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'authenticatorDisplay';
        el.style = 'position:fixed;bottom:8px;left:8px;background:#eee;padding:6px 12px;border-radius:8px;font-size:0.9em;color:#333;z-index:3000;opacity:0.7;';
        el.innerText = 'Auth: ' + authenticator + ' (cookie)';
        document.body.appendChild(el);
    }
});


// Animation helper for shaking and coloring the start button
function animateStartBtnSuccess() {
    const btn = document.getElementById('startBtn');
    btn.style.background = '#28a745';
    btn.classList.add('shake');
    setTimeout(() => {
        btn.classList.remove('shake');
        btn.style.background = '';
    }, 1200);
}



let statusInterval = null;

async function pollStatus() {
    const log = document.getElementById('log');
    try {
        const res = await fetch('/api/randomizer/status');
        const data = await res.json();
        log.innerHTML = (data.log || []).map(line => line + '<br>').join('');
        // ...existing code...
        if (data.running) {
            // keep polling
        } else {
            if (statusInterval) {
                clearInterval(statusInterval);
                statusInterval = null;
            }
        }
        // If a correct pin is found, animate the start button
        if (data.log && data.log.some(line => /PIN corretto|PIN valido|PIN trovato|correct pin|valid pin|found/i.test(line))) {
            animateStartBtnSuccess();
        }
    } catch (e) {
        log.innerHTML += `<span class='error'>Errore nel polling dello stato: ${e.message}</span><br>`;
        // ...existing code...
    }
}

document.getElementById('pinForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const input = document.getElementById('startPin').value;
    const startPin = parseInt(input, 10);
    const log = document.getElementById('log');
    log.innerHTML = '';
    if (isNaN(startPin) || startPin < 0 || startPin > 999999) {
        log.innerHTML = "<span class='error'>Valore non valido. Inserisci un numero tra 0 e 999999.</span>";
        // ...existing code...
        return;
    }
    // Start brute force on server
    await fetch('/api/randomizer/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startPin, authenticator })
    });
    pollStatus();
    if (!statusInterval) {
        statusInterval = setInterval(pollStatus, 1000);
    }
    // No auto-fetch of questions/answers after join. Use Show Answers button only.
});

document.getElementById('stopBtn').addEventListener('click', async function() {
    await fetch('/api/randomizer/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authenticator })
    });
    pollStatus();
});
