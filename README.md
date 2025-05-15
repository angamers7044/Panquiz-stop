# Progetto: Panquiz Stop

Questo progetto è un client per connettersi a un gioco in tempo reale utilizzando WebSocket e SignalR. Consente di partecipare a una partita con un PIN e un nome giocatore, oltre a supportare l'aggiunta di bot per simulare più giocatori.

---

## **Funzionalità**
- Connessione a una partita tramite PIN.
- Inserimento del nome giocatore.
- Supporto per l'aggiunta di bot con nomi personalizzati e numerati.
- Comunicazione in tempo reale con il server tramite WebSocket e SignalR.

---

## **Requisiti**
- **Node.js**: Assicurati di avere Node.js installato sul tuo sistema.
- **Dipendenze**:
  - `node-fetch`
  - `readline-sync`
  - `ws`

---

## **Istruzioni per l'uso**
1. Clona il repository:
   ```bash
   git clone https://github.com/angamers7044/Panquiz-stop
   cd Panquiz-stop
2. Installa le dipendenze:
   ```bash
   npm install
3. Avvia lo script:
   ```bash
   node main.js
Segui le istruzioni nel terminale:

  -Inserisci il PIN della partita.
  -Inserisci il tuo nome giocatore.

Struttura dei File
main.js: File principale che gestisce il flusso dell'applicazione.
validate_pin.js: Valida il PIN della partita e restituisce l'ID della partita.
negotiate_connection.js: Gestisce la negoziazione della connessione SignalR.
connect_signalr.js: Stabilisce la connessione WebSocket e invia/riceve messaggi.
signalr.min.js: Libreria SignalR per la gestione della comunicazione in tempo reale.
