#!/usr/bin/env node
/**
 * Zieht eine bestehende SQLite-Installation nach PostgreSQL um.
 *
 * Aufruf (Daybreak dabei beenden):
 *   DAYBREAK_DATABASE_URL=postgres://benutzer:passwort@rechner:5432/datenbank npm run migrate:postgres
 *
 * Die SQLite-Dateien werden nur gelesen und bleiben unverändert. Gibt es am Ziel schon Daten,
 * bricht das Werkzeug ab. Geht beim Umzug etwas schief, wird alles Neue wieder entfernt.
 * Sitzungen werden nicht übernommen; alle melden sich danach neu an. Mehr in docs/POSTGRESQL.md.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { loadEnvironment } = require('../config/load-env');
const { createStorage, createSqliteStorage, resolveDataDir } = require('../lib/storage');
const { translateScript, withoutForeignKeys } = require('../lib/postgres/translate');

const SKIPPED_TABLES = new Set(['app_sessions']);

const quote = name => `"${String(name).replace(/"/g, '""')}"`;

/** Verweise zwischen Tabellen kommen zuletzt, denn Tabellen dürfen gegenseitig aufeinander zeigen. */
function foreignKeysOf(source, tableName) {
  const groups = new Map();
  for (const key of source.prepare(`PRAGMA foreign_key_list(${quote(tableName)})`).all()) {
    if (!groups.has(key.id)) groups.set(key.id, []);
    groups.get(key.id).push(key);
  }
  return [...groups.values()].map(parts => {
    parts.sort((a, b) => a.seq - b.seq);
    const [{ table: target, on_update: onUpdate, on_delete: onDelete }] = parts;
    const targetColumns = parts.every(part => part.to) ? ` (${parts.map(part => quote(part.to)).join(',')})` : '';
    return `ALTER TABLE ${quote(tableName)} ADD FOREIGN KEY (${parts.map(part => quote(part.from)).join(',')}) REFERENCES ${quote(target)}${targetColumns} ON UPDATE ${onUpdate} ON DELETE ${onDelete} DEFERRABLE INITIALLY IMMEDIATE`;
  });
}

/** Kopiert alle Tabellen. "adjustRow" darf einzelne Werte ändern, zum Beispiel den Ablageort. */
function copyDatabase(sourcePath, target, { adjustRow = (table, row) => row } = {}) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // Der Umzug großer Tabellen darf länger dauern als eine normale Anfrage.
    target.execRaw('SET statement_timeout = 0');
    const objects = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
    const tables = objects.filter(object => object.type === 'table' && !SKIPPED_TABLES.has(object.name));
    const copied = new Set(tables.map(table => table.name));
    for (const table of tables) target.execRaw(translateScript(withoutForeignKeys(table.sql)));

    const { bridge, schema } = target;
    const counts = {};
    target.transaction(() => {
      for (const table of tables) {
        // Große Zahlen bleiben exakt: JavaScript rundet sie sonst unbemerkt.
        const rows = source.prepare(`SELECT * FROM ${quote(table.name)}`).safeIntegers().all();
        counts[table.name] = rows.length;
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const text = `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map((column, index) => `$${index + 1}`).join(',')})`;
        for (const [index, row] of rows.entries()) {
          const adjusted = adjustRow(table.name, row);
          try {
            bridge.call({ schema, text, params: columns.map(column => adjusted[column]) });
          } catch (error) {
            throw new Error(`Tabelle ${table.name}, Zeile ${index + 1}: ${error.message}`);
          }
        }
      }
    })();

    for (const table of tables) target.syncIdentity(table.name);
    for (const table of tables) {
      for (const statement of foreignKeysOf(source, table.name)) {
        try {
          target.execRaw(statement);
        } catch (error) {
          throw new Error(`Tabelle ${table.name}: Ein Verweis zeigt ins Leere. ${error.message}`);
        }
      }
    }
    // Trigger entstehen beim nächsten Start aus dem Modulcode.
    for (const index of objects.filter(object => object.type === 'index' && copied.has(object.tbl_name))) {
      target.execRaw(translateScript(index.sql));
    }

    for (const table of tables) {
      const { count } = target.prepare(`SELECT COUNT(*) AS count FROM ${quote(table.name)}`).get();
      if (count !== counts[table.name]) throw new Error(`Tabelle ${table.name}: ${counts[table.name]} Zeilen gelesen, aber ${count} angekommen.`);
    }
    return { tables: tables.length, rows: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  } finally {
    source.close();
  }
}

function migrate({ env, projectRoot, report = console.log }) {
  if (!env.DAYBREAK_DATABASE_URL) throw new Error('Bitte gib mit DAYBREAK_DATABASE_URL an, wohin die Daten umziehen sollen.');
  const primaryDbPath = path.resolve(env.DAYBREAK_DB_PATH || path.join(projectRoot, 'loop.db'));
  const dataDir = resolveDataDir(env, primaryDbPath);
  const sqlite = createSqliteStorage({ primaryDbPath, dataDir });
  const postgres = createStorage({ env, primaryDbPath, dataDir });

  const controlPath = sqlite.controlLocation();
  if (!sqlite.exists(controlPath)) throw new Error(`Unter ${controlPath} liegt keine Steuerungsdatenbank. Starte Daybreak zuerst einmal mit SQLite.`);
  const control = new Database(controlPath, { readonly: true, fileMustExist: true });
  const tenants = control.prepare('SELECT slug,db_path,is_primary FROM tenants ORDER BY id').all();
  control.close();

  const moves = tenants.map(tenant => {
    // Wurde der Datenordner verschoben, stimmt der gespeicherte Pfad nicht mehr.
    const stored = tenant.is_primary ? primaryDbPath : tenant.db_path;
    const from = sqlite.exists(stored) || tenant.is_primary ? stored : sqlite.tenantLocation(tenant.slug);
    if (!sqlite.exists(from)) throw new Error(`Für die Organisation ${tenant.slug} fehlt die Datenbank (${from}). Es wurde nichts verändert.`);
    return { slug: tenant.slug, from, to: tenant.is_primary ? postgres.primaryLocation : postgres.tenantLocation(tenant.slug) };
  });
  const controlTarget = postgres.controlLocation();
  for (const location of [controlTarget, ...moves.map(move => move.to)]) {
    if (postgres.exists(location)) throw new Error(`Am Ziel gibt es schon Daten (${postgres.schemaOf(location)}). Es wurde nichts verändert.`);
  }

  const created = [];
  const openTarget = location => {
    created.push(location);
    return postgres.open(location);
  };
  try {
    for (const move of moves) {
      const result = copyDatabase(move.from, openTarget(move.to));
      report(`${move.slug}: ${result.rows} Zeilen in ${result.tables} Tabellen übernommen.`);
    }
    const locationOf = new Map(moves.map(move => [move.slug, move.to]));
    const result = copyDatabase(controlPath, openTarget(controlTarget), {
      adjustRow: (table, row) => (table === 'tenants' ? { ...row, db_path: locationOf.get(row.slug) } : row)
    });
    report(`Steuerung: ${result.rows} Zeilen in ${result.tables} Tabellen übernommen.`);
  } catch (error) {
    const leftovers = created.filter(location => !removeAfterFailure(postgres, location));
    if (leftovers.length) error.message = `${error.message} Diese Reste ließen sich nicht entfernen: ${leftovers.map(postgres.schemaOf).join(', ')}. Lösche sie mit DROP SCHEMA ... CASCADE, bevor du es noch einmal versuchst.`;
    throw error;
  }
  return { moved: moves.length };
}

/**
 * Nach einer Zeitüberschreitung läuft die abgebrochene Anweisung auf dem Server noch kurz weiter und
 * hält ihre Sperren. Deshalb mehrmals versuchen. Der ursprüngliche Fehler soll dabei erhalten bleiben.
 */
function removeAfterFailure(postgres, location) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      postgres.retryNow?.();
      postgres.remove(location);
      return true;
    } catch {
      Atomics.wait(pause, 0, 0, 3000);
    }
  }
  return false;
}

if (require.main === module) {
  loadEnvironment();
  try {
    const { moved } = migrate({ env: process.env, projectRoot: path.resolve(__dirname, '..') });
    console.log(`Umzug abgeschlossen: ${moved} Organisation(en). Die SQLite-Dateien sind unverändert.`);
    console.log('Starte Daybreak jetzt mit derselben DAYBREAK_DATABASE_URL.');
    process.exit(0);
  } catch (error) {
    console.error(`Umzug abgebrochen: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { migrate };
