import React, { useState, useRef } from 'react';
import './RandomizerPopup.css';

export default function RandomizerPopup({ onClose }) {
  const [startPin, setStartPin] = useState('');
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef(null);

  const pollStatus = async () => {
    const res = await fetch('/api/randomizer/status');
    const data = await res.json();
    setLog(data.log || []);
    setRunning(data.running);
    if (!data.running && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handleStart = async (e) => {
    e.preventDefault();
    if (!/^\d{1,6}$/.test(startPin)) {
      setLog(["Valore non valido. Inserisci un numero tra 000000 e 999999."]);
      return;
    }
    await fetch('/api/randomizer/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startPin: parseInt(startPin, 10) })
    });
    pollStatus();
    if (!intervalRef.current) {
      intervalRef.current = setInterval(pollStatus, 1000);
    }
  };

  const handleStop = async () => {
    await fetch('/api/randomizer/stop', { method: 'POST' });
    pollStatus();
  };

  return (
    <div className="randomizer-popup-overlay">
      <div className="randomizer-popup">
        <button className="randomizer-close" onClick={onClose}>&times;</button>
        <h2>Panquiz PIN Randomizer</h2>
        <form onSubmit={handleStart} className="randomizer-form">
          <label htmlFor="startPin">PIN minimo (000000):</label>
          <input
            type="number"
            id="startPin"
            min="0"
            max="999999"
            value={startPin}
            onChange={e => setStartPin(e.target.value)}
            disabled={running}
            required
          />
          <div className="randomizer-controls">
            <button type="submit" className="start-btn" disabled={running}>Avvia</button>
            <button type="button" className="stop-btn" onClick={handleStop} disabled={!running}>Ferma</button>
          </div>
        </form>
        <div className="randomizer-log">
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </div>
    </div>
  );
}
