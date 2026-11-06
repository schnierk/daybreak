'use strict';

// Rechnet Passwort-Prüfungen in einem eigenen Thread, damit der Hauptprozess frei bleibt.
const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, operation, password, hash, cost }) => {
  try {
    const result = operation === 'compare' ? bcrypt.compareSync(password, hash) : bcrypt.hashSync(password, cost);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
