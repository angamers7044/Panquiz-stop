const promptText = document.getElementById('promptText');
const inputBox = document.getElementById('inputBox');
const submitBtn = document.getElementById('submitBtn');
const output = document.getElementById('output');

function showPrompt(text, buttonText = "Avanti") {
  promptText.textContent = text;
  submitBtn.textContent = buttonText;
  inputBox.value = '';
  inputBox.focus();
}

function showOutput(text, color = "#b2ffb2") {
  output.textContent = text;
  output.style.color = color;
}

async function validateMatchPin(pin) {
    const response = await fetch('https://panquiz-proxy.vercel.app/api/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `pin=${encodeURIComponent(pin)}`
    });
    const data = await response.json();
    if (data.playId) {
        return data.playId;
    } else {
        showOutput("PIN non valido. Riprova.", "#ffb2b2");
        return null;
    }
}
function ask(question, buttonText = "Avanti") {
  return new Promise(resolve => {
    showPrompt(question, buttonText);
    showOutput("");
    submitBtn.onclick = () => {
      resolve(inputBox.value.trim());
    };
    inputBox.onkeydown = (e) => {
      if (e.key === "Enter") {
        submitBtn.click();
      }
    };
  });
}

async function connectToPanquiz(playId, playerName) {
  showPrompt("Connessione al gioco in corso...", "Attendi");
  inputBox.style.display = "none";
  submitBtn.style.display = "none";

  const connection = new signalR.HubConnectionBuilder()
    .withUrl("https://play.panquiz.com/api/v1/playHub", {
      skipNegotiation: false,
      transport: signalR.HttpTransportType.WebSockets
    })
    .configureLogging(signalR.LogLevel.Information)
    .build();

  connection.on("ShowQuestion", (questionData) => {
    showOutput(
      `Domanda: ${questionData.question}\nRisposte: ${questionData.answers.join(', ')}\nRisposta corretta: ${questionData.rightAnswer}`
    );
    // Auto-answer for demo
    connection.invoke("AnswerQuestion", playId, questionData.rightAnswer);
  });

  connection.on("PlayerDisconnected", (disconnected) => {
    if (disconnected === true) {
      showOutput("Disconnesso dalla partita.", "#ffb2b2");
      connection.stop();
    }
  });

  connection.onclose(() => {
    showOutput("Connessione chiusa.", "#ffb2b2");
  });

  try {
    await connection.start();
    showOutput("Connesso! Invio richiesta di join...");
    await connection.invoke("PlayerJoined", playId, playerName);
    showPrompt("Hai effettuato l'accesso alla partita!", "In attesa...");
  } catch (err) {
    showOutput("Errore di connessione: " + err, "#ffb2b2");
  }
}

(async function main() {
  showPrompt("Inserisci il PIN della partita:");
  let playId = null;
  while (!playId) {
    const pin = await ask("Inserisci il PIN della partita:");
    playId = await validateMatchPin(pin);
  }
  const playerName = await ask("Inserisci il tuo nome giocatore:");
  await connectToPanquiz(playId, playerName);
})();