'use strict';

/**
 * Öffentliche Demo einmal am Tag auf Anfang stellen. Besucher dürfen dort fast alles ausprobieren,
 * auch andere Beispielpersonen umbenennen oder sperren. Ohne Reset sähen das alle Nächsten.
 *
 * Gelöscht wird nur die Datenbank der ersten Organisation und nur, wenn sie im Demo-Modus läuft. Andere
 * Organisationen bleiben unberührt. Die Aufträge der automatischen Programmierung bleiben ebenfalls erhalten.
 */

const fs = require('fs');

const AUTOMATION_TABLES = ['automation_jobs', 'automation_audit'];
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Liest die Stunde aus der Einstellung. Ohne gültige Angabe gibt es keinen Reset. */
function demoResetHour(env = process.env) {
  const text = String(env.DAYBREAK_DEMO_RESET_HOUR ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const hour = Number(text);
  return hour <= 23 ? hour : null;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/** Ein Worker schreibt aus einem eigenen Prozess in dieselbe Datei. Dann darf sie nicht verschwinden. */
function automationBusy(db) {
  if (!tableExists(db, 'automation_jobs')) return false;
  return Boolean(db.prepare("SELECT 1 FROM automation_jobs WHERE status IN ('queued','running') OR deployment_status IN ('publishing','restart_pending') LIMIT 1").get());
}

function readAutomationRows(db) {
  return AUTOMATION_TABLES
    .filter(table => tableExists(db, table))
    .map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }));
}

function restoreAutomationRows(db, saved) {
  db.transaction(() => {
    for (const { table, rows } of saved) {
      for (const original of rows) {
        // Die Rückmeldung an Dayo, aus der ein Auftrag entstand, gehört zu den Beispieldaten und ist jetzt weg.
        const row = table === 'automation_jobs' ? { ...original, feedback_id: null } : original;
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
      }
    }
  })();
}

function createDemoReset({ env, platform, sessionStore, runtimeFor, closeRuntime, now = () => new Date() }) {
  /** Antwortet, ob zurückgesetzt wurde, und wenn nicht, warum. */
  function resetDemo() {
    const tenant = platform.primaryTenant();
    if (!tenant.demo_mode) return { reset: false, reason: 'no_demo' };
    const isSqlite = platform.storage.kind === 'sqlite';
    const current = runtimeFor(tenant);
    // Automatische Programmierung gibt es nur mit SQLite.
    if (isSqlite && automationBusy(current.db)) return { reset: false, reason: 'automation_running' };
    const saved = isSqlite ? readAutomationRows(current.db) : [];

    sessionStore.revokeForTenant(tenant.slug);
    closeRuntime(tenant.slug);
    // Der letzte Stand bleibt bis zum nächsten Reset liegen, falls doch etwas fehlt.
    if (isSqlite) fs.copyFileSync(tenant.db_path, `${tenant.db_path}-vor-reset`);
    platform.storage.remove(tenant.db_path);
    platform.resetModuleSwitches(tenant.id);

    restoreAutomationRows(runtimeFor(tenant).db, saved);
    platform.audit('system', 'demo_reset', tenant.id, { automationRows: saved.reduce((sum, { rows }) => sum + rows.length, 0) });
    return { reset: true };
  }

  const hour = demoResetHour(env);
  let lastDay = null;
  function resetIfDue() {
    const time = now();
    const day = time.toDateString();
    if (hour === null || time.getHours() !== hour || lastDay === day) return null;
    lastDay = day;
    try {
      return resetDemo();
    } catch (error) {
      console.error('Die Demo ließ sich nicht zurücksetzen', error);
      return { reset: false, reason: 'failed' };
    }
  }

  let timer = null;
  function start() {
    if (hour === null || timer) return;
    timer = setInterval(resetIfDue, CHECK_EVERY_MS);
    timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { resetDemo, resetIfDue, start, stop };
}

module.exports = { createDemoReset, demoResetHour };
