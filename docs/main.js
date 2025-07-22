const terminal = document.getElementById('terminal');
const input = document.getElementById('input');

function print(text) {
  terminal.innerHTML += text + '<br>';
  terminal.scrollTop = terminal.scrollHeight;
}

function prompt(question) {
  return new Promise(resolve => {
    print(question);
    input.value = '';
    input.focus();
    input.onkeydown = e => {
      if (e.key === 'Enter') {
        print('> ' + input.value);
        resolve(input.value);
      }
    };
  });
}

// Example flow (replace with your logic)
(async function() {
  print('Welcome to Panquiz Terminal!');
  const pin = await prompt('Inserisci il PIN della partita:');
  const name = await prompt('Inserisci il tuo nome giocatore:');
  print(`Hai inserito PIN: ${pin}, Nome: ${name}`);
  // Here you would use fetch/WebSocket for browser, not Node.js modules
})();