'use strict';

/**
 * Macht PostgreSQL synchron nutzbar. Alle Fachmodule erwarten eine Datenbank, die sofort
 * antwortet, so wie SQLite. PostgreSQL antwortet aber über das Netz. Deshalb läuft die
 * Verbindung in einem eigenen Thread, und der Hauptprozess wartet kurz auf jede Antwort.
 *
 * Dadurch bleibt der gesamte Fachcode unverändert. Der Preis: Anfragen laufen nacheinander.
 * Für kleine und mittlere Organisationen reicht das; siehe docs/POSTGRESQL.md.
 */

const path = require('path');
const { MessageChannel, Worker, receiveMessageOnPort } = require('worker_threads');

// Ist die Datenbank nicht erreichbar, würden sonst alle Anfragen nacheinander warten.
const DEFAULT_TIMEOUT_MS = 20000;
const FAIL_FAST_MS = 10000;
const bridges = new Map();

class PostgresBridge {
  constructor(connectionString, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.connectionString = connectionString;
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.port = null;
    this.signal = null;
    this.transactionDepth = 0;
    this.failFastUntil = 0;
  }

  start() {
    const { port1, port2 } = new MessageChannel();
    const signalBuffer = new SharedArrayBuffer(4);
    this.signal = new Int32Array(signalBuffer);
    this.port = port1;
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { connectionString: this.connectionString, port: port2, signal: signalBuffer },
      transferList: [port2]
    });
    this.worker = worker;
    worker.unref();
    this.port.unref();
    // Das Ende eines alten Threads darf den neuen nicht vergessen lassen.
    worker.once('exit', () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.port = null;
    });
  }

  /** Sendet eine Anfrage und wartet auf die Antwort. Wirft bei Fehlern. */
  call(request) {
    if (Date.now() < this.failFastUntil) {
      const error = new Error('PostgreSQL antwortet gerade nicht.');
      error.code = 'POSTGRES_TIMEOUT';
      throw error;
    }
    if (!this.worker) this.start();
    Atomics.store(this.signal, 0, 0);
    this.port.postMessage(request);
    const started = Date.now();
    for (;;) {
      const remaining = this.timeoutMs - (Date.now() - started);
      if (remaining <= 0 || Atomics.wait(this.signal, 0, 0, remaining) === 'timed-out') {
        this.failFastUntil = Date.now() + FAIL_FAST_MS;
        this.reset();
        const error = new Error('PostgreSQL antwortet nicht.');
        error.code = 'POSTGRES_TIMEOUT';
        throw error;
      }
      let received = receiveMessageOnPort(this.port);
      while (received && received.message.ready) received = receiveMessageOnPort(this.port);
      if (received) {
        const { message } = received;
        if (message.ok) return message;
        // Ohne Verbindung warten sonst alle Anfragen nacheinander und blockieren den ganzen Prozess.
        if (message.error.duringConnect) this.failFastUntil = Date.now() + FAIL_FAST_MS;
        const error = new Error(message.error.message);
        Object.assign(error, { postgresCode: message.error.code, detail: message.error.detail, constraint: message.error.constraint });
        throw error;
      }
      // Das Signal kam, die Nachricht ist noch unterwegs.
      Atomics.store(this.signal, 0, 0);
    }
  }

  /** Für Aufräumarbeiten: nicht auf das Ende der Sperrfrist warten. */
  retryNow() {
    this.failFastUntil = 0;
  }

  reset() {
    const worker = this.worker;
    this.worker = null;
    this.port = null;
    if (worker) worker.terminate();
  }

  close() {
    this.reset();
  }
}

/** Je Verbindungsadresse gibt es im Prozess genau eine Verbindung. */
function bridgeFor(connectionString) {
  let bridge = bridges.get(connectionString);
  if (!bridge) {
    bridge = new PostgresBridge(connectionString);
    bridges.set(connectionString, bridge);
  }
  return bridge;
}

module.exports = { PostgresBridge, bridgeFor };
