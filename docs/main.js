const terminal = document.getElementById('terminal');
const input = document.getElementById('input');

let history = [];
let historyIndex = -1;
let promptResolve = null;

function print(text) {
  terminal.innerHTML += text + '<br>';
  terminal.scrollTop = terminal.scrollHeight;
}

function prompt(question) {
  print(question);
  input.value = '';
  input.focus();
  return new Promise(resolve => {
    promptResolve = resolve;
  });
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && promptResolve) {
    const value = input.value;
    print('> ' + value);
    history.push(value);
    historyIndex = history.length;
    input.value = '';
    const resolve = promptResolve;
    promptResolve = null;
    resolve(value);
  } else if (e.key === 'ArrowUp') {
    if (history.length && historyIndex > 0) {
      historyIndex--;
      input.value = history[historyIndex];
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
    }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (history.length && historyIndex < history.length - 1) {
      historyIndex++;
      input.value = history[historyIndex];
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
    } else if (historyIndex === history.length - 1) {
      historyIndex++;
      input.value = '';
    }
    e.preventDefault();
  }
});

// Example flow (replace with your logic)
(async function() {
  print('Welcome to Panquiz Terminal!');
  const pin = await prompt('Inserisci il PIN della partita:');
  const name = await prompt('Inserisci il tuo nome giocatore:');
  print(`Hai inserito PIN: ${pin}, Nome: ${name}`);
  // Add more prompts or logic here
})();