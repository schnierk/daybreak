'use strict';

/**
 * Spricht in einem eigenen Thread mit PostgreSQL. Der Hauptprozess wartet synchron auf jede
 * Antwort (siehe bridge.js). Eine Verbindung reicht deshalb: Es läuft immer nur eine Anfrage.
 */

const { workerData } = require('worker_threads');
const { Client, types } = require('pg');

const { connectionString, port, signal: signalBuffer } = workerData;
const signal = new Int32Array(signalBuffer);

// Zahlen sollen als Zahlen ankommen und Wahrheitswerte als 0 und 1, wie bei SQLite.
types.setTypeParser(20, Number); // bigint
types.setTypeParser(1700, parseFloat); // numeric
types.setTypeParser(16, value => (value === 't' ? 1 : 0)); // boolean

// Deutlich unter der Wartezeit der Brücke: PostgreSQL bricht ab und meldet einen normalen Fehler.
// So bleibt keine Anweisung liegen, die später doch noch ausgeführt würde.
const SESSION_SETTINGS = "SET statement_timeout = 15000; SET lock_timeout = 2000; SET idle_in_transaction_session_timeout = 60000";
// Ab PostgreSQL 14: Anweisungen enden auch, wenn der Client weg ist.
const DISCONNECT_CHECK = 'SET client_connection_check_interval = 2000';

let client = null;
let currentSchema = null;
let transactionOpen = false;
// Die Verbindung brach mitten in einer Transaktion ab. Alles Weitere darin muss scheitern,
// sonst liefen die restlichen Anweisungen einzeln auf einer neuen Verbindung.
let transactionLost = false;

function forgetConnection(failed) {
  if (client !== failed) return;
  client = null;
  currentSchema = null;
  if (transactionOpen) transactionLost = true;
  failed.end().catch(() => {});
}

/** Fehler der Verbindung selbst, im Unterschied zu Fehlern einer einzelnen Anweisung. */
function isConnectionFailure(error) {
  const code = String(error?.code || '');
  return !code || /^E[A-Z]+$/.test(code) || code.startsWith('08') || code.startsWith('57P');
}

async function prepareConnection(schema) {
  if (!client) {
    const fresh = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    // Bricht die Verbindung ab, wird sie bei der nächsten Anfrage neu aufgebaut.
    fresh.on('error', () => forgetConnection(fresh));
    fresh.on('end', () => forgetConnection(fresh));
    try {
      await fresh.connect();
      await fresh.query(SESSION_SETTINGS);
    } catch (error) {
      error.duringConnect = true;
      fresh.end().catch(() => {});
      throw error;
    }
    await fresh.query(DISCONNECT_CHECK).catch(() => {});
    client = fresh;
  }
  if (schema && schema !== currentSchema) {
    await client.query(`SET search_path TO "${schema}"`);
    currentSchema = schema;
  }
}

async function runStatement(request) {
  await prepareConnection(request.schema);
  if (request.createSchema) await client.query(`CREATE SCHEMA IF NOT EXISTS "${request.schema}"`);
  const run = async () => {
    if (request.simple) {
      await client.query(request.text);
      return { rows: [], rowCount: 0 };
    }
    const result = await client.query(request.text, request.params || []);
    return { rows: result.rows, rowCount: result.rowCount || 0 };
  };
  if (!request.savepoint) return run();
  // Wie bei SQLite soll eine fehlgeschlagene Anweisung die laufende Transaktion nicht beenden.
  await client.query('SAVEPOINT daybreak_statement');
  try {
    const outcome = await run();
    await client.query('RELEASE SAVEPOINT daybreak_statement');
    return outcome;
  } catch (error) {
    if (!isConnectionFailure(error)) {
      await client.query('ROLLBACK TO SAVEPOINT daybreak_statement');
      await client.query('RELEASE SAVEPOINT daybreak_statement');
    }
    throw error;
  }
}

async function handle(request) {
  if (transactionLost) {
    if (request.text === 'ROLLBACK') {
      transactionLost = false;
      transactionOpen = false;
      return { rows: [], rowCount: 0 };
    }
    throw new Error('Die Verbindung zur Datenbank brach während der Transaktion ab.');
  }
  const used = client;
  try {
    const outcome = await runStatement(request);
    if (request.text === 'BEGIN') transactionOpen = true;
    else if (request.text === 'COMMIT' || request.text === 'ROLLBACK') transactionOpen = false;
    return outcome;
  } catch (error) {
    if (isConnectionFailure(error) && client && client === (used || client)) forgetConnection(client);
    if (request.text === 'COMMIT' && !isConnectionFailure(error)) transactionOpen = false;
    throw error;
  }
}

function reply(message) {
  port.postMessage(message);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

port.on('message', async request => {
  try {
    reply({ ok: true, ...(await handle(request)) });
  } catch (error) {
    reply({ ok: false, error: { code: error.code, message: String(error.message || error), detail: error.detail, constraint: error.constraint, duringConnect: Boolean(error.duringConnect) } });
  }
});

// Der Hauptprozess erfährt so früh wie möglich, dass der Thread bereit ist.
port.postMessage({ ready: true });
