'use strict';

/**
 * Bietet dieselbe Schnittstelle wie better-sqlite3, arbeitet aber auf PostgreSQL.
 * Jeder Mandant bekommt ein eigenes Schema; alle Anfragen nennen ihr Schema ausdrücklich,
 * damit keine Anweisung versehentlich bei einem anderen Mandanten landet.
 */

const { bridgeFor } = require('./bridge');
const { cachedStatement, translateScript } = require('./translate');

const SCHEMA_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

// Fehler, die bei SQLite gar nicht entstehen, weil dort Spalten jeden Wert annehmen.
// Für Lesen, Ändern und Löschen heißt das schlicht: Es gibt keinen passenden Datensatz.
const NOT_MATCHING_VALUE = new Set(['22P02', '22003', '22007', '22008']);

const SQLITE_ERROR_CODES = {
  23505: { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed' },
  23503: { code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: 'FOREIGN KEY constraint failed' },
  23514: { code: 'SQLITE_CONSTRAINT_CHECK', message: 'CHECK constraint failed' },
  23502: { code: 'SQLITE_CONSTRAINT_NOTNULL', message: 'NOT NULL constraint failed' }
};

function mapError(error, sqlText) {
  const known = SQLITE_ERROR_CODES[error.postgresCode];
  if (known) {
    error.code = known.code;
    error.message = `${known.message}: ${error.constraint || error.message}`;
  } else if (error.postgresCode) {
    error.message = `${error.message} [${error.postgresCode}] bei: ${String(sqlText).replace(/\s+/g, ' ').slice(0, 300)}`;
  }
  return error;
}

/** Zwischen Threads werden Binärwerte zu Uint8Array. Der Fachcode erwartet Buffer, wie bei SQLite. */
function withBuffers(result) {
  for (const row of result.rows) {
    for (const [column, value] of Object.entries(row)) {
      if (value instanceof Uint8Array) row[column] = Buffer.from(value);
    }
  }
  return result;
}

function flattenParameters(parameters) {
  const values = parameters.length === 1 && Array.isArray(parameters[0]) ? parameters[0] : parameters;
  return values.map(value => {
    if (value === undefined) throw new TypeError('Für eine Abfrage fehlt ein Wert.');
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  });
}

/** Stelle des WHERE der Anweisung selbst. Ein WHERE in einer Teilabfrage im SET-Teil zählt nicht. */
function outermostWhere(text) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (depth === 0 && /^WHERE\b/i.test(text.slice(index, index + 6)) && !/\w/.test(text[index - 1] || ' ')) {
      return index;
    }
  }
  return -1;
}

/**
 * Ein unpassender Wert in der Bedingung findet einfach nichts, wie bei SQLite. Ein unpassender
 * Wert, der gespeichert werden soll, ist dagegen ein Fehler und darf nicht verschwinden.
 */
function failedOnlyInCondition(text, values, error) {
  const offending = String(error.message).match(/"((?:[^"\\]|\\.)*)"/)?.[1];
  const where = outermostWhere(text);
  if (where < 0) return false;
  const numbersIn = part => [...part.matchAll(/\$(\d+)/g)].map(match => Number(match[1]) - 1);
  const matches = index => String(values[index]) === offending;
  const inSet = numbersIn(text.slice(0, where)).some(matches);
  const inWhere = numbersIn(text.slice(where)).some(matches);
  return offending !== undefined ? inWhere && !inSet : numbersIn(text.slice(0, where)).length === 0;
}

class PostgresStatement {
  constructor(database, sql) {
    this.database = database;
    this.source = sql;
    this.translated = cachedStatement(sql);
  }

  execute(parameters, { returning = false } = {}) {
    const { translated, database } = this;
    if (translated.kind === 'noop') return { rows: [], rowCount: 0 };
    const params = translated.params || flattenParameters(parameters);
    let text = translated.text;
    if (returning && translated.kind === 'insert' && !translated.hasReturning) {
      const key = database.integerPrimaryKey(translated.table);
      if (key) text = `${text} RETURNING "${key}"`;
    }
    return database.query(text, params);
  }

  /** Falscher Datentyp beim Suchen: Wie bei SQLite gibt es dann einfach keinen Treffer. */
  executeRead(parameters) {
    try {
      return this.execute(parameters);
    } catch (error) {
      if (NOT_MATCHING_VALUE.has(error.postgresCode)) return { rows: [], rowCount: 0 };
      throw error;
    }
  }

  get(...parameters) {
    return this.executeRead(parameters).rows[0];
  }

  all(...parameters) {
    return this.executeRead(parameters).rows;
  }

  /**
   * Wurden Datensätze mit fester Nummer eingefügt, kennt der Zähler von PostgreSQL diese Nummer
   * nicht und vergibt sie später noch einmal. SQLite hat dieses Problem nicht. Deshalb wird der
   * Zähler nach festen Nummern nachgezogen und bei einem Zusammenstoß einmal neu versucht.
   */
  run(...parameters) {
    const { translated, database } = this;
    const key = translated.kind === 'insert' ? database.integerPrimaryKey(translated.table) : null;
    const hasFixedNumber = Boolean(key && translated.columns?.includes(key.toLowerCase()));
    const attempt = () => this.execute(parameters, { returning: true });
    let result;
    try {
      result = attempt();
      // INSERT OR IGNORE würde auch den Zusammenstoß mit einem veralteten Zähler verschlucken.
      if (key && !hasFixedNumber && translated.ignoresConflicts && result.rowCount === 0) {
        database.syncIdentity(translated.table, key);
        result = attempt();
      }
    } catch (error) {
      if (key && !hasFixedNumber && error.postgresCode === '23505' && String(error.constraint || '').endsWith('_pkey')) {
        database.syncIdentity(translated.table, key);
        result = attempt();
      } else if (translated.kind !== 'insert' && NOT_MATCHING_VALUE.has(error.postgresCode) && failedOnlyInCondition(translated.text, flattenParameters(parameters), error)) {
        return { changes: 0, lastInsertRowid: 0 };
      } else {
        throw error;
      }
    }
    if (hasFixedNumber && result.rowCount > 0) database.syncIdentity(translated.table, key);
    const inserted = key && result.rows[0] ? result.rows[0][key] : undefined;
    return { changes: result.rowCount, lastInsertRowid: inserted ?? 0 };
  }
}

class PostgresDatabase {
  constructor({ connectionString, schema }) {
    if (!SCHEMA_PATTERN.test(schema)) throw new Error(`Ungültiger Schemaname: ${schema}`);
    this.dialect = 'postgres';
    this.schema = schema;
    this.bridge = bridgeFor(connectionString);
    this.primaryKeys = new Map();
    this.open = true;
    this.bridge.call({ schema, createSchema: true, simple: true, text: 'SELECT 1' });
  }

  get inTransaction() {
    return this.bridge.transactionDepth > 0;
  }

  query(text, params) {
    if (!this.open) throw new TypeError('Die Datenbankverbindung ist geschlossen.');
    try {
      return withBuffers(this.bridge.call({ schema: this.schema, text, params, savepoint: this.inTransaction }));
    } catch (error) {
      throw mapError(error, text);
    }
  }

  prepare(sql) {
    return new PostgresStatement(this, sql);
  }

  /** Mehrere Anweisungen ohne Parameter, meist das Anlegen von Tabellen. */
  exec(sql) {
    return this.execRaw(translateScript(sql));
  }

  /** Bereits fertiges PostgreSQL, zum Beispiel Trigger. */
  execRaw(text) {
    if (!this.open) throw new TypeError('Die Datenbankverbindung ist geschlossen.');
    if (!text.trim()) return this;
    try {
      this.bridge.call({ schema: this.schema, simple: true, text, savepoint: this.inTransaction });
    } catch (error) {
      throw mapError(error, text);
    }
    return this;
  }

  /** Nur Tabellenauskünfte haben hier eine Bedeutung; Einstellungen wie foreign_keys nicht. */
  pragma(source) {
    return this.prepare(`PRAGMA ${source}`).all();
  }

  integerPrimaryKey(table) {
    if (this.primaryKeys.has(table)) return this.primaryKeys.get(table);
    const rows = this.bridge.call({
      schema: this.schema,
      text: `SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
      params: [table],
      savepoint: this.inTransaction
    }).rows;
    const key = rows.length === 1 && rows[0].type === 'bigint' ? rows[0].name : null;
    if (rows.length) this.primaryKeys.set(table, key);
    return key;
  }

  syncIdentity(table, key = this.integerPrimaryKey(table)) {
    if (!key) return;
    // Spalten ohne eigenen Zähler (BIGINT PRIMARY KEY, von außen vergeben) haben nichts nachzuziehen.
    this.query(`SELECT setval(sequence, GREATEST(COALESCE((SELECT MAX("${key}") FROM "${table}"), 0), 1))
      FROM pg_get_serial_sequence($1, $2) AS sequence WHERE sequence IS NOT NULL`, [table, key]);
  }

  transaction(work) {
    const run = (...args) => {
      const { bridge, schema } = this;
      const nested = bridge.transactionDepth > 0;
      const savepoint = `daybreak_nested_${bridge.transactionDepth}`;
      bridge.call({ schema, simple: true, text: nested ? `SAVEPOINT ${savepoint}` : 'BEGIN' });
      bridge.transactionDepth += 1;
      try {
        const result = work(...args);
        bridge.transactionDepth -= 1;
        bridge.call({ schema, simple: true, text: nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT' });
        return result;
      } catch (error) {
        bridge.transactionDepth = Math.max(0, bridge.transactionDepth - 1);
        bridge.call({ schema, simple: true, text: nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK' });
        throw error;
      }
    };
    return Object.assign(run, { deferred: run, immediate: run, exclusive: run });
  }

  /** Beendet nur diese Sicht. Die gemeinsame Verbindung bleibt für andere Mandanten offen. */
  close() {
    this.open = false;
  }

  dropSchema() {
    this.bridge.call({ simple: true, text: `DROP SCHEMA IF EXISTS "${this.schema}" CASCADE` });
    this.open = false;
  }
}

module.exports = { PostgresDatabase, SCHEMA_PATTERN };
