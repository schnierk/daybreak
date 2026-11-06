'use strict';

/**
 * Gemeinsame Bausteine eines Mandanten: Grundschema und Hilfsfunktionen, die alle
 * Fachmodule als Abhängigkeit erhalten. Alles arbeitet ausschließlich auf der
 * übergebenen Datenbank; dadurch bleibt jeder Mandant für sich.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { APPROVAL_RULES, getApprovalRule } = require('./approval-rules');

const TEMP_PASSWORD_COST = 12;
// Erzeugte temporäre Passwörter sind lange Zufallswerte und werden bei der ersten Anmeldung ersetzt.
// Sie sind auch mit niedrigerer Kostenstufe nicht zu erraten, und der Server bleibt reaktionsfähig.
const GENERATED_PASSWORD_COST = 8;
const MIN_PASSWORD_LENGTH = 12;

const ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp']);
// hr_staff ist die Sachbearbeitung. Sie gehört bewusst nicht zu isHr: Was sie darf, wird ausdrücklich freigegeben.
const HR_ROLES = Object.freeze(['hr_staff', 'hrbp', 'hr_admin']);

// NUL-Zeichen kann PostgreSQL nicht speichern, und sinnvoll sind sie in keinem Text.
// eslint-disable-next-line no-control-regex
const cleanText = (value, max = 4000) => typeof value === 'string' ? value.replace(/[<>\u0000]/g, '').trim().slice(0, max) : '';

const boundedInt = (value, min, max, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

/** Leere Werte gelten als "kein Datum". Sonst muss es ein echter Kalendertag im Format JJJJ-MM-TT sein. */
const validDate = value => {
  if (!value) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

function ensureColumn(db, table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Ältere Datenbanken kennen die Rolle hr_staff noch nicht. SQLite kann CHECK-Regeln nicht ändern,
 * deshalb wird die Tabelle nach dem dort beschriebenen Weg neu aufgebaut: neue Tabelle anlegen,
 * Daten kopieren, alte ersetzen. Fremdschlüssel anderer Tabellen bleiben dabei gültig.
 */
function ensureRolesAllowed(db) {
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
  if (definition.includes('hr_staff') || !/role/i.test(definition)) return;
  const allowed = ROLES.map(role => `'${role}'`).join(',');
  if (db.dialect === 'postgres') {
    const constraint = db.prepare("SELECT conname::text AS name FROM pg_constraint WHERE conrelid=to_regclass('users') AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%hr_admin%'").get();
    if (!constraint) return;
    db.execRaw(`ALTER TABLE users DROP CONSTRAINT "${constraint.name}"; ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (${allowed}))`);
    return;
  }
  const rebuilt = definition
    .replace(/CREATE\s+TABLE\s+"?users"?/i, 'CREATE TABLE users_rebuild')
    .replace(/CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/i, `CHECK(role IN (${allowed}))`);
  if (!rebuilt.includes('hr_staff')) return;
  const dependents = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  const columns = db.prepare('PRAGMA table_info(users)').all().map(column => `"${column.name}"`).join(',');
  const foreignKeysOn = db.pragma('foreign_keys', { simple: true });
  const violation = row => `${row.table}|${row.rowid}|${row.parent}|${row.fkid}`;
  // Ein alter Verweis ins Leere hat mit dem Umbau nichts zu tun und darf den Start nicht verhindern.
  const violationsBefore = new Set(db.pragma('foreign_key_check').map(violation));
  db.pragma('foreign_keys = OFF');
  // Eigene Trigger oder Sichten, die users nennen, würden das Umbenennen sonst scheitern lassen.
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec(rebuilt);
      db.exec(`INSERT INTO users_rebuild(${columns}) SELECT ${columns} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_rebuild RENAME TO users');
      for (const { sql } of dependents) db.exec(sql);
      const broken = db.pragma('foreign_key_check').filter(row => !violationsBefore.has(violation(row)));
      if (broken.length) throw new Error(`Nach dem Umbau der Tabelle users passen Verweise nicht mehr (zum Beispiel in ${broken[0].table}).`);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma(`foreign_keys = ${foreignKeysOn ? 'ON' : 'OFF'}`);
  }
}

function initializeCoreSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('employee','manager','director','hr_staff','hr_admin','hrbp')), title TEXT, manager_id INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT, weight INTEGER DEFAULT 100, progress INTEGER DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), status TEXT DEFAULT 'on_track', due_date TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS checkins (id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES users(id), manager_id INTEGER NOT NULL REFERENCES users(id), period TEXT NOT NULL, summary TEXT NOT NULL, achievements TEXT, obstacles TEXT, next_steps TEXT, performance INTEGER CHECK(performance BETWEEN 1 AND 5), on_track TEXT CHECK(on_track IN ('on_track','needs_focus','off_track')), employee_comment TEXT, satisfaction INTEGER CHECK(satisfaction BETWEEN 1 AND 5), acknowledged_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, type TEXT, due_date TEXT, done INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity TEXT, entity_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS organization_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  ensureColumn(db, 'goals', 'approval_status', "TEXT DEFAULT 'approved'");
  ensureColumn(db, 'goals', 'manager_comment', 'TEXT');
  ensureColumn(db, 'goals', 'reviewed_at', 'TEXT');
  ensureColumn(db, 'tasks', 'entity_id', 'INTEGER');
  ensureColumn(db, 'audit_log', 'old_values', 'TEXT');
  ensureColumn(db, 'audit_log', 'new_values', 'TEXT');
  ensureColumn(db, 'users', 'is_system_account', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE goals SET approval_status='approved' WHERE approval_status IS NULL").run();
  ensureRolesAllowed(db);
}

/** Nur Buchstaben und Ziffern: Beginnt ein Passwort mit einem Minus, verfälscht der Formelschutz in CSV-Listen es. */
function generateTemporaryPassword() {
  return crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
}

/** Diese Anmeldenamen gehören dem System und sind für Personen tabu. */
const RESERVED_EMAILS = new Set(['root@root.de', 'system-root@daybreak.internal']);

// Lang genug, aber das Erste, was jemand ausprobiert.
const GUESSABLE_PASSWORD = /^(?:pass(?:wort|word)|kennwort|daybreak|demo|admin|qwertz|qwerty|willkommen|welcome|sommer|winter|hallo|geheim|changeme|letmein)[\d\s!?.,_-]*$/i;

/** Liefert den Grund, warum ein Passwort nicht taugt, sonst null. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`;
  if (new Set(password).size < 5) return 'Dieses Passwort ist zu einfach. Nimm mehr verschiedene Zeichen.';
  if (/^\d+$/.test(password) || GUESSABLE_PASSWORD.test(password)) return 'Dieses Passwort ist zu leicht zu erraten. Nimm zum Beispiel mehrere zufällige Wörter.';
  return null;
}

/**
 * Zielerreichung einer Person: Nur freigegebene Ziele zählen, gewichtet nach ihrer Bedeutung.
 * Ohne solche Ziele gibt es keinen Wert (null), nicht 0 Prozent.
 */
function goalProgress(goals) {
  const counted = goals.filter(goal => (goal.approval_status ?? 'approved') === 'approved');
  const totalWeight = counted.reduce((sum, goal) => sum + (Number(goal.weight) || 0), 0);
  if (!totalWeight) return null;
  return Math.round(counted.reduce((sum, goal) => sum + goal.progress * (Number(goal.weight) || 0), 0) / totalWeight);
}

function createCoreHelpers(db, { revokeUserSessions = () => 0 } = {}) {
  function log(actor, action, entity, entityId, oldValues = null, newValues = null) {
    db.prepare('INSERT INTO audit_log(actor_id,action,entity,entity_id,old_values,new_values) VALUES(?,?,?,?,?,?)')
      .run(actor || null, action, entity, entityId || null, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null);
  }

  function isHr(actor) {
    return ['hr_admin', 'hrbp', 'super_admin'].includes(actor.role);
  }

  /** Wer zum Tagesgeschäft von HR gehört. Die Sachbearbeitung ist hier dabei, anders als bei isHr. */
  function isHrOperator(actor) {
    return ['hr_admin', 'hrbp', 'hr_staff', 'super_admin'].includes(actor?.role);
  }

  const roleOf = person => (typeof person === 'object' ? person?.role : db.prepare('SELECT role FROM users WHERE id=?').get(person)?.role);

  /**
   * Darf diese HR-Person die Daten der anderen Person sehen und bearbeiten? Die HR-Leitung bleibt
   * für andere HR-Rollen tabu, die Sachbearbeitung auch gegenüber HR-Kolleg:innen.
   */
  function hrCanAccess(actor, person) {
    if (!isHrOperator(actor)) return false;
    const role = roleOf(person);
    // Gibt es die Person nicht, antwortet der Aufrufer mit „nicht gefunden“.
    if (!role || ['hr_admin', 'super_admin'].includes(actor.role)) return true;
    return actor.role === 'hrbp' ? role !== 'hr_admin' : !HR_ROLES.includes(role);
  }

  /** Niemand verwaltet das eigene Konto. Die Sachbearbeitung betreut nur Konten ohne Führungs- oder HR-Aufgabe. */
  function canManageAccount(actor, person) {
    if (!person || person.id === actor?.id) return false;
    if (['hr_admin', 'super_admin'].includes(actor?.role)) return true;
    if (actor?.role === 'hrbp') return !HR_ROLES.includes(person.role);
    if (actor?.role === 'hr_staff') return person.role === 'employee';
    return false;
  }

  /**
   * HR-Rollen vergibt nur die HR-Administration. Führungsrollen vergibt auch der HR Business Partner.
   * Die Sachbearbeitung legt nur Mitarbeitende an: Sonst könnte sie sich über ein selbst angelegtes
   * Führungskonto Einblick in Bewertungen verschaffen, die ihr sonst verschlossen bleiben.
   */
  function canAssignRole(actor, role) {
    if (!ROLES.includes(role)) return false;
    if (['hr_admin', 'super_admin'].includes(actor?.role)) return true;
    if (actor?.role === 'hrbp') return !HR_ROLES.includes(role);
    return actor?.role === 'hr_staff' && role === 'employee';
  }

  /**
   * Wer führt, liest die Bewertungen seiner Leute. Die Sachbearbeitung kann deshalb weder sich
   * selbst noch Kolleg:innen derselben Rolle als Führungskraft eintragen. Das tun HR Business
   * Partner oder HR-Administration.
   */
  function canAssignManager(actor, manager) {
    return actor?.role !== 'hr_staff' || manager?.role !== 'hr_staff';
  }

  /** Wem darf diese HR-Person eine andere Führungskraft geben? HR-Konten ordnet nur die HR-Administration neu zu. */
  function canReassignPerson(actor, person) {
    if (!hrCanAccess(actor, person)) return false;
    return actor.role !== 'hrbp' || !HR_ROLES.includes(roleOf(person));
  }

  /** HR ändert die eigenen Daten nicht, außer die Organisation erlaubt es in den Genehmigungsregeln. */
  function blocksSelfEdit(actor, personId) {
    if (actor?.id !== personId || actor?.role === 'super_admin') return false;
    return approvalRule('personnel.hr_self_edit') !== 'allowed';
  }

  const managerListeners = [];
  /** Module melden sich hier an, wenn offene Vorgänge beim Wechsel der Führungskraft mitziehen sollen. */
  function onManagerChanged(listener) {
    managerListeners.push(listener);
  }

  function changeManager(userId, managerId, actorId = null) {
    const before = db.prepare('SELECT manager_id FROM users WHERE id=?').get(userId);
    if (!before || (before.manager_id ?? null) === (managerId ?? null)) return false;
    db.transaction(() => {
      db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(managerId ?? null, userId);
      for (const listener of managerListeners) listener({ userId, previousManagerId: before.manager_id ?? null, managerId: managerId ?? null, actorId });
    })();
    return true;
  }

  function canViewEmployee(actor, employeeId) {
    if (actor.id === employeeId) return true;
    if (isHr(actor)) return hrCanAccess(actor, employeeId);
    let person = db.prepare('SELECT manager_id FROM users WHERE id=?').get(employeeId);
    const seen = new Set();
    while (person?.manager_id && !seen.has(person.manager_id)) {
      if (person.manager_id === actor.id) return true;
      seen.add(person.manager_id);
      person = db.prepare('SELECT manager_id FROM users WHERE id=?').get(person.manager_id);
    }
    return false;
  }

  function canEditEmployee(actor, employeeId) {
    if (actor.id === employeeId) return true;
    if (isHr(actor)) return hrCanAccess(actor, employeeId);
    return db.prepare('SELECT manager_id FROM users WHERE id=?').get(employeeId)?.manager_id === actor.id;
  }

  function subordinateIds(actor) {
    const all = db.prepare('SELECT id,manager_id FROM users WHERE is_system_account=0 AND active=1').all();
    const walk = (id, seen = new Set()) => all
      .filter(user => user.manager_id === id && !seen.has(user.id))
      .flatMap(user => { seen.add(user.id); return [user.id, ...walk(user.id, seen)]; });
    return walk(actor.id);
  }

  /** Eine Frist gibt es nur, wenn der Vorgang eine hat. Der Tag des Anlegens ist keine. */
  function createTask(userId, title, type, entityId, dueDate = null) {
    const due = dueDate && validDate(dueDate) ? dueDate : null;
    db.prepare('INSERT INTO tasks(user_id,title,type,entity_id,due_date) VALUES(?,?,?,?,?)').run(userId, title, type, entityId, due);
  }

  /** Liefert die gültige Einstellung einer Genehmigungsregel, ohne Entscheidung die Voreinstellung. */
  function approvalRule(key) {
    const rule = getApprovalRule(key);
    if (!rule) throw new Error(`Unbekannte Genehmigungsregel: ${key}`);
    const stored = db.prepare('SELECT setting_value FROM organization_settings WHERE setting_key=?').get(key)?.setting_value;
    return rule.options.some(option => option.value === stored) ? stored : rule.defaultValue;
  }

  function listApprovalRules() {
    return APPROVAL_RULES.map(rule => ({ ...rule, value: approvalRule(rule.key) }));
  }

  /** Speichert eine Regel. Gibt false zurück, wenn es Regel oder Wert nicht gibt. */
  function setApprovalRule(key, value, actor = null) {
    const rule = getApprovalRule(key);
    if (!rule || !rule.options.some(option => option.value === value)) return false;
    const before = approvalRule(key);
    db.prepare(`INSERT INTO organization_settings(setting_key,setting_value,updated_by,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(key, value, actor?.id || null, new Date().toISOString());
    log(actor?.id || null, 'approval_rule_changed', 'organization_settings', null, { key, value: before }, { key, value });
    return true;
  }

  /** Alle Regeln gelten wieder mit ihrer Voreinstellung. */
  function resetApprovalRules() {
    db.prepare('DELETE FROM organization_settings').run();
  }

  /** Hält die erste Position einer neuen Person in der Positionshistorie fest. */
  function recordInitialPosition(userId, positionId, effectiveDate, actor, source = 'user_creation') {
    const position = db.prepare('SELECT id,title FROM position_profiles WHERE id=?').get(positionId);
    if (!position) return;
    const effective = effectiveDate && validDate(effectiveDate) ? effectiveDate : new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO position_assignment_history(user_id,position_profile_id,position_title,effective_date,changed_by,source) VALUES(?,?,?,?,?,?)')
      .run(userId, position.id, position.title, effective, actor?.id || null, source);
  }

  /**
   * Legt ein Konto an, zum Beispiel bei der Einstellung aus dem Recruiting.
   * Ohne Passwort wird ein zufälliges temporäres erzeugt und einmalig zurückgegeben.
   * Die Person muss es bei der ersten Anmeldung ändern.
   */
  function createUserAccount({ name, email, role = 'employee', title = null, managerId = null, positionProfileId = null, positionEffectiveDate = null, password = null, actor = null }) {
    const cleanName = cleanText(name, 120);
    const cleanEmail = cleanText(email, 254).toLowerCase();
    if (!cleanName || !/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      const error = new Error('Name und gültige E-Mail sind erforderlich.');
      error.status = 400;
      throw error;
    }
    if (!ROLES.includes(role)) {
      const error = new Error('Ungültige Rolle.');
      error.status = 400;
      throw error;
    }
    if (db.prepare('SELECT id FROM users WHERE email=?').get(cleanEmail)) {
      const error = new Error('Diese E-Mail ist bereits vergeben.');
      error.status = 409;
      throw error;
    }
    if (managerId && !db.prepare('SELECT id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(managerId)) {
      const error = new Error('Führungskraft nicht gefunden.');
      error.status = 400;
      throw error;
    }
    if (password !== null && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
      const error = new Error(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`);
      error.status = 400;
      throw error;
    }
    const temporaryPassword = password || generateTemporaryPassword();
    const id = db.prepare('INSERT INTO users(name,email,password_hash,role,title,manager_id,position_profile_id,must_change_password) VALUES(?,?,?,?,?,?,?,1)')
      .run(cleanName, cleanEmail, bcrypt.hashSync(temporaryPassword, password ? TEMP_PASSWORD_COST : GENERATED_PASSWORD_COST), role, cleanText(title, 160) || null, managerId || null, positionProfileId || null).lastInsertRowid;
    if (positionProfileId) recordInitialPosition(id, positionProfileId, positionEffectiveDate, actor);
    log(actor?.id || null, 'user_created', 'users', id, null, { name: cleanName, email: cleanEmail, role, managerId: managerId || null, positionProfileId: positionProfileId || null });
    return { id, temporaryPassword: password ? null : temporaryPassword };
  }

  /** Sperrt oder reaktiviert ein Konto. Gesperrte Personen verlieren sofort den Zugang. */
  function setUserActive(userId, active, actor = null) {
    const before = db.prepare('SELECT id,active FROM users WHERE id=? AND is_system_account=0').get(userId);
    if (!before) return false;
    db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, userId);
    if (!active) revokeUserSessions(userId);
    log(actor?.id || null, active ? 'user_reactivated' : 'user_deactivated', 'users', userId, { active: before.active }, { active: active ? 1 : 0 });
    return true;
  }

  return {
    approvalRule,
    blocksSelfEdit,
    boundedInt,
    canAssignManager,
    canReassignPerson,
    canAssignRole,
    canEditEmployee,
    canManageAccount,
    canViewEmployee,
    changeManager,
    cleanText,
    createTask,
    createUserAccount,
    goalProgress,
    hrCanAccess,
    isHr,
    isHrOperator,
    listApprovalRules,
    log,
    onManagerChanged,
    resetApprovalRules,
    recordInitialPosition,
    setApprovalRule,
    setUserActive,
    subordinateIds,
    validDate
  };
}

module.exports = {
  HR_ROLES,
  ROLES,
  goalProgress,
  passwordProblem,
  RESERVED_EMAILS,
  GENERATED_PASSWORD_COST,
  MIN_PASSWORD_LENGTH,
  TEMP_PASSWORD_COST,
  boundedInt,
  cleanText,
  createCoreHelpers,
  ensureColumn,
  generateTemporaryPassword,
  initializeCoreSchema,
  validDate
};
