'use strict';

/**
 * Massenimport von Mitarbeitenden, zum Beispiel beim Start einer neuen Organisation oder beim
 * Umzug aus einem anderen System. Die Datei wird im Browser gelesen, der Server prüft jede
 * Zeile. Angelegt wird nur, wenn alle Zeilen in Ordnung sind: alles oder nichts.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { GENERATED_PASSWORD_COST, generateTemporaryPassword } = require('../lib/core-helpers');

const MAX_ROWS = 2000;
const { RESERVED_EMAILS } = require('../lib/core-helpers');
const ROLE_ALIASES = new Map(Object.entries({
  '': 'employee',
  employee: 'employee',
  mitarbeiter: 'employee',
  mitarbeiterin: 'employee',
  'mitarbeiter:in': 'employee',
  mitarbeitende: 'employee',
  manager: 'manager',
  führungskraft: 'manager',
  vorgesetzte: 'manager',
  'vorgesetzte:r': 'manager',
  director: 'director',
  bereichsleitung: 'director',
  bereichsleiter: 'director',
  bereichsleiterin: 'director',
  abteilungsleitung: 'manager',
  abteilungsleiter: 'manager',
  abteilungsleiterin: 'manager',
  hr_staff: 'hr_staff',
  sachbearbeitung: 'hr_staff',
  'hr-sachbearbeitung': 'hr_staff',
  'hr sachbearbeitung': 'hr_staff',
  'hr-administration': 'hr_admin',
  'hr administration': 'hr_admin',
  hr_admin: 'hr_admin',
  'hr admin': 'hr_admin',
  'hr-admin': 'hr_admin',
  'hr-leitung': 'hr_admin',
  'hr leitung': 'hr_admin',
  hrbp: 'hrbp',
  'hr business partner': 'hrbp',
  'hr-business-partner': 'hrbp'
}));
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createPeopleImportModule({ db, auth, current, isHrOperator, canAssignManager, canAssignRole, cleanText, log, recordInitialPosition, demoAccountsFull = () => false, demoRowLimit = () => null }) {
  const router = express.Router();

  function positionsByTitle() {
    const rows = db.prepare('SELECT id,title FROM position_profiles WHERE active=1').all();
    return new Map(rows.map(row => [row.title.trim().toLowerCase(), row]));
  }

  /** Prüft alle Zeilen, ohne etwas zu verändern. */
  function validate(rawRows, actor) {
    const positions = positionsByTitle();
    const parsed = rawRows.map((raw, index) => {
      const email = cleanText(raw?.email, 254).toLowerCase();
      const managerEmail = cleanText(raw?.managerEmail, 254).toLowerCase();
      const positionTitle = cleanText(raw?.position, 160);
      const roleInput = cleanText(raw?.role, 60).toLowerCase();
      return {
        line: Number.isInteger(raw?.line) && raw.line > 0 ? raw.line : index + 1,
        // Spitze Klammern fallen beim Speichern weg. Das soll man vorher sehen.
        sanitized: /[<>]/.test(`${raw?.name ?? ''}${raw?.position ?? ''}`),
        name: cleanText(raw?.name, 120),
        email,
        title: positionTitle,
        role: ROLE_ALIASES.get(roleInput) || null,
        roleInput,
        managerEmail,
        positionId: positions.get(positionTitle.toLowerCase())?.id || null,
        errors: []
      };
    });
    const byEmail = new Map();
    for (const row of parsed) {
      if (!row.email) continue;
      if (!byEmail.has(row.email)) byEmail.set(row.email, []);
      byEmail.get(row.email).push(row);
    }
    const existingEmail = db.prepare('SELECT id FROM users WHERE email=?');
    const existingManager = db.prepare('SELECT id,name,role FROM users WHERE email=? AND is_system_account=0 AND active=1');
    for (const row of parsed) {
      if (!row.name) row.errors.push('Name fehlt.');
      if (`${row.name}${row.title}`.includes('\ufffd')) row.errors.push('Die Datei enthält unlesbare Zeichen. Speichere sie als „CSV UTF-8“.');
      if (!EMAIL_PATTERN.test(row.email)) row.errors.push('Die E-Mail ist ungültig.');
      else if (RESERVED_EMAILS.has(row.email)) row.errors.push('Diese E-Mail ist reserviert.');
      else {
        if (byEmail.get(row.email).length > 1) row.errors.push('Diese E-Mail steht mehrfach in der Datei.');
        if (existingEmail.get(row.email)) row.errors.push('Diese E-Mail ist bereits vergeben.');
      }
      if (!row.role) row.errors.push(`Unbekannte Rolle „${row.roleInput}“.`);
      if (row.role && !canAssignRole(actor, row.role)) row.errors.push(actor.role === 'hr_staff' ? 'Du legst nur Mitarbeitende an. Führungs- und HR-Rollen vergeben HR Business Partner oder HR-Administration.' : 'HR-Konten legt nur die HR-Administration an.');
      if (row.managerEmail) {
        const inFile = byEmail.get(row.managerEmail)?.[0];
        const existing = inFile ? null : existingManager.get(row.managerEmail);
        if (row.managerEmail === row.email) row.errors.push('Eine Person kann nicht ihre eigene Führungskraft sein.');
        else if (!inFile && !existing) row.errors.push('Die Führungskraft wurde weder in der Datei noch unter den Mitarbeitenden gefunden.');
        else if (!canAssignManager(actor, { role: inFile ? inFile.role : existing.role })) row.errors.push('Personen aus der HR-Sachbearbeitung tragen HR Business Partner oder HR-Administration als Führungskraft ein.');
        // Wer Leute führt, braucht die passende Rolle. Sonst fehlt zum Beispiel „Mein Team“.
        else if (inFile?.role === 'employee') row.errors.push(`${inFile.name || row.managerEmail} führt in der Datei andere, hat aber die Rolle Mitarbeiter:in. Trage dort „Führungskraft“ ein.`);
        else if (existing?.role === 'employee') row.errors.push(`${existing.name} ist noch nicht als Führungskraft eingetragen. Ändere die Rolle zuerst unter „Konten“.`);
      }
    }
    // Ringe wie A → B → A dürfen nicht entstehen.
    for (const row of parsed) {
      const seen = new Set([row.email]);
      let next = row.managerEmail;
      while (next && byEmail.has(next)) {
        if (seen.has(next)) {
          row.errors.push('Die Führungslinie bildet einen Ring.');
          break;
        }
        seen.add(next);
        next = byEmail.get(next)[0].managerEmail;
      }
    }
    return parsed;
  }

  function publicRow(row) {
    return {
      line: row.line,
      name: row.name,
      email: row.email,
      role: row.role,
      title: row.title,
      managerEmail: row.managerEmail,
      positionMatched: Boolean(row.positionId),
      sanitized: row.sanitized,
      errors: row.errors
    };
  }

  router.post('/users/import', auth, async (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return res.status(403).json({ error: 'Nur HR darf Mitarbeitende importieren.' });
    const rawRows = req.body?.rows;
    if (!Array.isArray(rawRows) || !rawRows.length) return res.status(400).json({ error: 'Die Datei enthält keine Zeilen.' });
    if (rawRows.length > MAX_ROWS) return res.status(400).json({ error: `Bitte importiere höchstens ${MAX_ROWS} Zeilen auf einmal.` });
    const demoLimit = demoRowLimit();
    if (demoLimit && rawRows.length > demoLimit) return res.status(403).json({ error: `In der öffentlichen Demo lassen sich höchstens ${demoLimit} Personen auf einmal importieren.`, code: 'demo_protected' });
    if (req.body?.dryRun !== true && demoAccountsFull()) return res.status(403).json({ error: 'In der öffentlichen Demo ist die Höchstzahl an Konten erreicht.', code: 'demo_protected' });

    const rows = validate(rawRows, actor);
    const errorCount = rows.filter(row => row.errors.length).length;
    const summary = { total: rows.length, valid: rows.length - errorCount, invalid: errorCount };
    if (req.body?.dryRun === true) return res.json({ rows: rows.map(publicRow), summary });
    if (errorCount) return res.status(400).json({ error: 'Die Datei enthält noch Fehler. Es wurde nichts angelegt.', rows: rows.map(publicRow), summary });

    // Die Passwörter entstehen vor der Transaktion, damit der Server währenddessen erreichbar bleibt.
    const prepared = [];
    for (const row of rows) {
      const temporaryPassword = generateTemporaryPassword();
      prepared.push({ ...row, temporaryPassword, passwordHash: await bcrypt.hash(temporaryPassword, GENERATED_PASSWORD_COST) });
    }

    const insert = db.prepare('INSERT INTO users(name,email,password_hash,role,title,position_profile_id,must_change_password) VALUES(?,?,?,?,?,?,1)');
    const assignManager = db.prepare('UPDATE users SET manager_id=? WHERE id=?');
    const managerByEmail = db.prepare('SELECT id FROM users WHERE email=? AND is_system_account=0 AND active=1');
    const write = db.transaction(() => {
      const ids = new Map();
      for (const row of prepared) {
        const id = insert.run(row.name, row.email, row.passwordHash, row.role, row.title || null, row.positionId).lastInsertRowid;
        ids.set(row.email, id);
        if (row.positionId) recordInitialPosition(id, row.positionId, null, actor, 'import');
        log(actor.id, 'user_imported', 'users', id, null, { email: row.email, role: row.role });
      }
      for (const row of prepared) {
        if (row.managerEmail) assignManager.run(managerByEmail.get(row.managerEmail).id, ids.get(row.email));
      }
      log(actor.id, 'users_import_completed', 'users', null, null, { count: prepared.length });
    });
    try {
      write();
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Eine E-Mail wurde inzwischen anderweitig vergeben. Bitte prüfe die Datei erneut. Es wurde nichts angelegt.' });
      throw error;
    }
    res.status(201).json({
      created: prepared.map(row => ({ name: row.name, email: row.email, temporaryPassword: row.temporaryPassword })),
      summary
    });
  });

  return { router };
}

module.exports = { MAX_ROWS, createPeopleImportModule };
