'use strict';

/**
 * Leere Datenbank für einen Test. Standard ist SQLite im Arbeitsspeicher. Ist
 * DAYBREAK_TEST_DATABASE_URL gesetzt, laufen dieselben Tests auf PostgreSQL, jeder in einem
 * eigenen Schema, das am Ende wieder gelöscht wird.
 */

const Database = require('better-sqlite3');
const { PostgresDatabase } = require('../postgres/database');

let counter = 0;

function openTestDatabase() {
  const connectionString = process.env.DAYBREAK_TEST_DATABASE_URL;
  if (!connectionString) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
  }
  counter += 1;
  const db = new PostgresDatabase({ connectionString, schema: `h${process.pid}_${counter}_${Math.random().toString(36).slice(2, 8)}` });
  db.close = () => {
    if (db.open) db.dropSchema();
  };
  return db;
}

module.exports = { openTestDatabase };
