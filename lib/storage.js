'use strict';

/**
 * Wo die Daten liegen. Standard ist SQLite: je Mandant eine Datei, nichts weiter zu installieren.
 * Mit DAYBREAK_DATABASE_URL wird PostgreSQL verwendet: je Mandant ein eigenes Schema.
 * Der übrige Code kennt nur diese Schnittstelle und "Orte" als Text.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PostgresDatabase } = require('./postgres/database');
const { bridgeFor } = require('./postgres/bridge');

const POSTGRES_PREFIX = 'postgres:';

function resolveDataDir(env, primaryDbPath) {
  return path.resolve(env.DAYBREAK_DATA_DIR || path.join(path.dirname(primaryDbPath), 'data'));
}

function createSqliteStorage({ primaryDbPath, dataDir }) {
  const tenantsDir = path.join(dataDir, 'tenants');
  return {
    kind: 'sqlite',
    primaryLocation: primaryDbPath,
    prepare() {
      fs.mkdirSync(tenantsDir, { recursive: true, mode: 0o700 });
    },
    controlLocation: () => path.join(dataDir, 'control.db'),
    tenantLocation: slug => path.join(tenantsDir, `${slug}.db`),
    exists: location => fs.existsSync(location),
    open(location) {
      const db = new Database(location);
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      // Personaldaten: nur für den Eigentümer lesbar.
      fs.chmodSync(location, 0o600);
      return db;
    },
    remove(location) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${location}${suffix}`, { force: true });
    }
  };
}

function createPostgresStorage({ connectionString, schemaPrefix }) {
  const schemaOf = location => location.slice(POSTGRES_PREFIX.length);
  const locationFor = name => `${POSTGRES_PREFIX}${schemaPrefix}${name.replace(/-/g, '_')}`;
  const open = location => new PostgresDatabase({ connectionString, schema: schemaOf(location) });
  return {
    kind: 'postgres',
    connectionString,
    primaryLocation: locationFor('t_default'),
    prepare() {},
    controlLocation: () => locationFor('control'),
    tenantLocation: slug => locationFor(`t_${slug}`),
    schemaOf,
    exists(location) {
      const { rows } = bridgeFor(connectionString).call({ text: 'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', params: [schemaOf(location)] });
      return rows.length > 0;
    },
    open,
    retryNow: () => bridgeFor(connectionString).retryNow(),
    remove(location) {
      open(location).dropSchema();
    }
  };
}

function createStorage({ env = process.env, primaryDbPath, dataDir = resolveDataDir(env, primaryDbPath) }) {
  // DAYBREAK_TEST_DATABASE_URL gilt nur für Testläufe. Sie bringen eine eigene Umgebung mit und
  // bekommen je Datenordner eigene Schemas; ein Neustart im selben Test findet seine Daten wieder.
  const connectionString = env.DAYBREAK_DATABASE_URL || process.env.DAYBREAK_TEST_DATABASE_URL;
  if (!connectionString) return createSqliteStorage({ primaryDbPath, dataDir });
  const schemaPrefix = env.DAYBREAK_DATABASE_URL
    ? 'daybreak_'
    : `t${crypto.createHash('sha1').update(dataDir).digest('hex').slice(0, 10)}_`;
  return createPostgresStorage({ connectionString, schemaPrefix });
}

module.exports = { POSTGRES_PREFIX, createPostgresStorage, createSqliteStorage, createStorage, resolveDataDir };
