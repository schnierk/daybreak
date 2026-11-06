'use strict';

/**
 * Konten durch HR: anlegen, ändern, zuordnen, Passwort zurücksetzen, sperren.
 *
 * Wer was darf, steht in lib/core-helpers.js (canManageAccount, canAssignRole). Kurz gesagt:
 * HR-Rollen vergibt nur die HR-Administration, niemand verwaltet sein eigenes Konto, und die
 * Sachbearbeitung betreut nur Konten ohne Führungs- oder HR-Aufgabe.
 */

const express = require('express');
const { RESERVED_EMAILS } = require('../lib/core-helpers');

const DEMO_LIMIT_MESSAGE = { error: 'In der öffentlichen Demo ist die Höchstzahl an Konten erreicht. Bitte nutze die vorhandenen Konten.', code: 'demo_protected' };

/** Zahl aus einer Anfrage. Ungültiges wird nicht still zu "keine Angabe". */
function readId(value) {
  if (value === null || value === undefined || value === '') return { id: null, valid: true };
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? { id, valid: true } : { id: null, valid: false };
}

function createAccountsRouter({
  db, auth, current, isHr, isHrOperator, canManageAccount, canAssignManager, canAssignRole, canReassignPerson, canViewEmployee, hrCanAccess, blocksSelfEdit,
  changeManager, cleanText, validDate, log, createTask, setUserActive, passwordProblem, generateTemporaryPassword,
  passwordChecks, passwordCosts, busyMessage, revokeSessions, recordPositionHistory, isProtectedAccount,
  protectedMessage, demoAccountsFull
}) {
  const router = express.Router();

  const findPerson = id => db.prepare('SELECT id,name,email,role,title,manager_id,active FROM users WHERE id=? AND is_system_account=0').get(id);
  const activePerson = id => db.prepare('SELECT id,name,role FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id);
  const emailTaken = (email, exceptId = 0) => Boolean(db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, exceptId));
  const validEmail = email => /^\S+@\S+\.\S+$/.test(email);

  const activeReports = personId => db.prepare('SELECT COUNT(*) count FROM users WHERE manager_id=? AND active=1 AND is_system_account=0').get(personId).count;

  /**
   * Passt diese Person als Führungskraft? Wer Leute führt, braucht die passende Rolle, sonst fehlt
   * zum Beispiel „Mein Team“. Antwortet mit dem Fehler oder null.
   */
  function managerProblem(actor, manager, promoteManager) {
    if (!canAssignManager(actor, manager)) return { status: 403, body: { error: 'Personen aus der HR-Sachbearbeitung tragen HR Business Partner oder HR-Administration als Führungskraft ein.' } };
    if (manager.role !== 'employee') return null;
    if (!canAssignRole(actor, 'manager')) return { status: 403, body: { error: `${manager.name} ist noch nicht als Führungskraft eingetragen. Die Rolle vergeben HR Business Partner oder HR-Administration.` } };
    if (promoteManager !== true) return { status: 409, body: { error: `${manager.name} ist noch nicht als Führungskraft eingetragen.`, code: 'manager_role_required', managerName: manager.name } };
    return null;
  }

  function promoteToManager(actor, manager) {
    if (manager?.role !== 'employee') return;
    db.prepare("UPDATE users SET role='manager' WHERE id=?").run(manager.id);
    log(actor.id, 'user_updated', 'users', manager.id, { role: 'employee' }, { role: 'manager' });
  }

  function isLastActiveAdmin(person) {
    if (person.role !== 'hr_admin') return false;
    return !db.prepare("SELECT 1 FROM users WHERE role='hr_admin' AND is_system_account=0 AND active=1 AND id<>? LIMIT 1").get(person.id);
  }

  router.get('/users', auth, (req, res) => {
    const actor = current(req);
    const seesAll = isHrOperator(actor);
    const includeInactive = seesAll && req.query.includeInactive === 'true';
    const all = db.prepare(`SELECT u.id,u.name,u.email,u.role,COALESCE(p.title,u.title) title,u.manager_id,u.active,u.position_profile_id
      FROM users u LEFT JOIN position_profiles p ON p.id=u.position_profile_id
      WHERE u.is_system_account=0${includeInactive ? '' : ' AND u.active=1'} ORDER BY u.name`).all();
    const visible = seesAll ? all : all.filter(user => canViewEmployee(actor, user.id));
    res.json({
      users: visible.map(user => (seesAll ? {
        ...user,
        canManage: canManageAccount(actor, user),
        canAssign: canReassignPerson(actor, user) && !blocksSelfEdit(actor, user.id),
        protected: isProtectedAccount(user.email)
      } : user))
    });
  });

  router.post('/users', auth, async (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return res.status(403).json({ error: 'Nur HR darf Mitarbeitende anlegen.' });
    const body = req.body || {};
    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 254).toLowerCase();
    const title = cleanText(body.title, 160);
    const role = typeof body.role === 'string' && body.role ? body.role : 'employee';
    const effectiveDate = cleanText(body.positionEffectiveDate, 10);
    const manager = readId(body.managerId);
    const positionId = readId(body.positionProfileId);
    const chosenPassword = body.password === undefined || body.password === null || body.password === '' ? null : body.password;

    if (!name || !validEmail(email)) return res.status(400).json({ error: 'Bitte gib Name und eine gültige E-Mail an.' });
    if (RESERVED_EMAILS.has(email)) return res.status(400).json({ error: 'Diese E-Mail ist reserviert.' });
    if (chosenPassword !== null) {
      const problem = passwordProblem(chosenPassword);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (!canAssignRole(actor, role)) {
      const known = ['employee', 'manager', 'director', 'hr_staff', 'hrbp', 'hr_admin'].includes(role);
      if (!known) return res.status(400).json({ error: 'Ungültige Rolle.' });
      return res.status(403).json({ error: actor.role === 'hr_staff' ? 'Du legst nur Mitarbeitende an. Führungs- und HR-Rollen vergeben HR Business Partner oder HR-Administration.' : 'HR-Konten legt nur die HR-Administration an.' });
    }
    const managerPerson = manager.id ? activePerson(manager.id) : null;
    if (!manager.valid || (manager.id && !managerPerson)) return res.status(400).json({ error: 'Führungskraft nicht gefunden.' });
    if (managerPerson) {
      const problem = managerProblem(actor, managerPerson, body.promoteManager);
      if (problem) return res.status(problem.status).json(problem.body);
    }
    if (!positionId.valid) return res.status(400).json({ error: 'Das gewählte Positionsprofil ist nicht verfügbar.' });
    const position = positionId.id ? db.prepare('SELECT id,title FROM position_profiles WHERE id=? AND active=1').get(positionId.id) : null;
    if (positionId.id && !position) return res.status(400).json({ error: 'Das gewählte Positionsprofil ist nicht verfügbar.' });
    if (position && (!effectiveDate || !validDate(effectiveDate))) return res.status(400).json({ error: 'Bitte gib an, ab wann die Position offiziell wirksam ist.' });
    // Die Zuordnung wirkt sofort. Ein Datum in der Zukunft würde etwas anderes versprechen.
    if (position && effectiveDate > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Die Position wirkt sofort. Trage als Datum spätestens heute ein.' });
    if (emailTaken(email)) return res.status(409).json({ error: 'Diese E-Mail ist bereits vergeben.' });
    if (demoAccountsFull()) return res.status(403).json(DEMO_LIMIT_MESSAGE);
    if (passwordChecks.busy()) return res.status(429).json(busyMessage);

    const temporaryPassword = chosenPassword === null ? generateTemporaryPassword() : null;
    const passwordHash = await passwordChecks.hash(chosenPassword ?? temporaryPassword, chosenPassword === null ? passwordCosts.generated : passwordCosts.chosen);
    const effectiveTitle = position?.title || title;
    try {
      const created = db.transaction(() => {
        promoteToManager(actor, managerPerson);
        const id = db.prepare('INSERT INTO users(name,email,password_hash,role,title,manager_id,position_profile_id,must_change_password) VALUES(?,?,?,?,?,?,?,1)')
          .run(name, email, passwordHash, role, effectiveTitle, manager.id, position?.id || null).lastInsertRowid;
        const historyId = position ? recordPositionHistory({ userId: id, positionId: position.id, effectiveDate, actor, source: 'user_creation' }) : null;
        return { id, historyId };
      })();
      log(actor.id, 'user_created', 'users', created.id, null, { name, email, role, title: effectiveTitle, managerId: manager.id, positionProfileId: position?.id || null, effectiveDate: position ? effectiveDate : null, historyId: created.historyId });
      res.status(200).json({ id: created.id, ...(temporaryPassword ? { temporaryPassword } : {}) });
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Diese E-Mail ist bereits vergeben.' });
      throw error;
    }
  });

  // Name, E-Mail, Bezeichnung und Rolle. Rollen ändert nie jemand an sich selbst.
  router.patch('/users/:id', auth, (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return res.status(403).json({ error: 'Nur HR darf Konten ändern.' });
    const person = findPerson(Number(req.params.id));
    if (!person) return res.status(404).json({ error: 'Person nicht gefunden.' });
    const isSelf = person.id === actor.id;
    if (blocksSelfEdit(actor, person.id)) return res.status(403).json({ error: 'Deine eigenen Kontodaten ändert eine andere HR-Person.' });
    if (!isSelf && !canManageAccount(actor, person)) return res.status(403).json({ error: 'Dieses Konto darf nur die HR-Administration ändern.' });
    if (isProtectedAccount(person.email)) return res.status(403).json(protectedMessage);

    const body = req.body || {};
    const next = {
      name: body.name === undefined ? person.name : cleanText(body.name, 120),
      email: body.email === undefined ? person.email : cleanText(body.email, 254).toLowerCase(),
      title: body.title === undefined ? person.title : cleanText(body.title, 160) || null,
      role: body.role === undefined ? person.role : body.role
    };
    if (!next.name || !validEmail(next.email)) return res.status(400).json({ error: 'Bitte gib Name und eine gültige E-Mail an.' });
    if (next.email !== person.email && RESERVED_EMAILS.has(next.email)) return res.status(400).json({ error: 'Diese E-Mail ist reserviert.' });
    if (next.email !== person.email && emailTaken(next.email, person.id)) return res.status(409).json({ error: 'Diese E-Mail ist bereits vergeben.' });
    if (next.role !== person.role) {
      if (isSelf) return res.status(403).json({ error: 'Deine eigene Rolle ändert eine andere HR-Administration.' });
      if (!canAssignRole(actor, next.role)) {
        const known = ['employee', 'manager', 'director', 'hr_staff', 'hrbp', 'hr_admin'].includes(next.role);
        if (!known) return res.status(400).json({ error: 'Ungültige Rolle.' });
        return res.status(403).json({ error: actor.role === 'hr_staff' ? 'Rollen vergeben HR Business Partner oder HR-Administration.' : 'HR-Rollen vergibt nur die HR-Administration.' });
      }
      if (isLastActiveAdmin(person)) return res.status(409).json({ error: 'Das ist die letzte aktive HR-Administration. Lege zuerst eine weitere an.' });
      // Sonst bliebe das Team an einer Person hängen, die zwar alles liest, aber keine Vorschläge mehr abgeben kann.
      const led = next.role === 'employee' ? activeReports(person.id) : 0;
      if (led) return res.status(409).json({ error: `${person.name} führt noch ${led === 1 ? 'eine Person' : `${led} Personen`}. Ordne sie zuerst einer anderen Führungskraft zu.`, code: 'still_leading' });
    }
    db.transaction(() => {
      db.prepare('UPDATE users SET name=?,email=?,title=?,role=? WHERE id=?').run(next.name, next.email, next.title, next.role, person.id);
      log(actor.id, 'user_updated', 'users', person.id, { name: person.name, email: person.email, title: person.title, role: person.role }, next);
      // Die Person soll merken, wenn sich ihre Anmeldung oder ihr Name ändert.
      if (!isSelf && next.email !== person.email) createTask(person.id, `${actor.name} hat deine Anmelde-E-Mail geändert. Sie lautet jetzt ${next.email}. Wende dich an HR, falls du das nicht erwartet hast.`, 'account_notice', person.id);
      else if (!isSelf && next.name !== person.name) createTask(person.id, `${actor.name} hat deinen Namen geändert. Er lautet jetzt ${next.name}. Wende dich an HR, falls du das nicht erwartet hast.`, 'account_notice', person.id);
    })();
    res.json({ ok: true, emailChanged: next.email !== person.email });
  });

  router.patch('/users/:id/manager', auth, (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return res.status(403).json({ error: 'Nur HR darf Zuordnungen ändern.' });
    const userId = Number(req.params.id);
    const body = req.body || {};
    const manager = readId(body.managerId);
    if (!manager.valid) return res.status(400).json({ error: 'Führungskraft nicht gefunden.' });
    if (userId === manager.id) return res.status(400).json({ error: 'Eine Person kann nicht ihre eigene Führungskraft sein.' });
    const employee = findPerson(userId);
    if (!employee) return res.status(404).json({ error: 'Person nicht gefunden.' });
    if (blocksSelfEdit(actor, userId)) return res.status(403).json({ error: 'Deine eigene Zuordnung ändert eine andere HR-Person.' });
    if (!canReassignPerson(actor, employee)) return res.status(403).json({ error: 'Diese Zuordnung darf nur die HR-Administration ändern.' });
    const newManager = manager.id ? activePerson(manager.id) : null;
    if (manager.id && !newManager) return res.status(404).json({ error: 'Führungskraft nicht gefunden.' });
    let cursor = manager.id;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (cursor === userId) return res.status(400).json({ error: 'Diese Zuordnung geht nicht: Die Führungslinie würde im Kreis laufen.' });
      seen.add(cursor);
      cursor = db.prepare('SELECT manager_id FROM users WHERE id=? AND is_system_account=0').get(cursor)?.manager_id;
    }
    if (newManager) {
      const problem = managerProblem(actor, newManager, body.promoteManager);
      if (problem) return res.status(problem.status).json(problem.body);
    }
    db.transaction(() => {
      promoteToManager(actor, newManager);
      changeManager(userId, manager.id, actor.id);
      log(actor.id, 'manager_assigned', 'users', userId, { managerId: employee.manager_id }, { managerId: manager.id });
    })();
    res.json({ ok: true });
  });

  router.get('/hierarchy', auth, (req, res) => {
    const actor = current(req);
    const all = db.prepare(`SELECT u.id,u.name,u.role,COALESCE(p.title,u.title) title,u.manager_id
      FROM users u LEFT JOIN position_profiles p ON p.id=u.position_profile_id
      WHERE u.is_system_account=0 AND u.active=1 ORDER BY u.name`).all();
    if (isHrOperator(actor)) return res.json({ users: all, rootId: null });
    if (actor.role === 'employee') {
      const manager = actor.manager_id ? all.find(user => user.id === actor.manager_id) : null;
      const users = manager ? [manager, ...all.filter(user => user.manager_id === manager.id)] : [actor];
      return res.json({ users, rootId: manager?.id || actor.id, context: 'team' });
    }
    // Die eigene Führungskraft gehört dazu, damit klar ist, an wen man selbst berichtet.
    const users = all.filter(user => canViewEmployee(actor, user.id));
    const boss = actor.manager_id ? all.find(user => user.id === actor.manager_id) : null;
    res.json({ users: boss ? [boss, ...users] : users, rootId: boss?.id || actor.id, context: 'subtree' });
  });

  router.post('/users/:id/password', auth, async (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return res.status(403).json({ error: 'Nur HR darf Passwörter zurücksetzen.' });
    const person = findPerson(Number(req.params.id));
    if (!person) return res.status(404).json({ error: 'Person nicht gefunden.' });
    if (person.id === actor.id) return res.status(400).json({ error: 'Dein eigenes Passwort änderst du unten links über „Passwort ändern“.' });
    if (!canManageAccount(actor, person)) return res.status(403).json({ error: 'Das Passwort dieses Kontos darf nur die HR-Administration zurücksetzen.' });
    if (isProtectedAccount(person.email)) return res.status(403).json(protectedMessage);
    if (passwordChecks.busy()) return res.status(429).json(busyMessage);
    const temporaryPassword = generateTemporaryPassword();
    const temporaryHash = await passwordChecks.hash(temporaryPassword, passwordCosts.generated);
    db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(temporaryHash, person.id);
    revokeSessions(person.id);
    log(actor.id, 'password_reset_by_hr', 'users', person.id);
    // Die Person soll merken, wenn jemand ihr Konto übernommen hat.
    createTask(person.id, `${actor.name} hat dein Passwort zurückgesetzt. Wende dich an HR, falls du das nicht erwartet hast.`, 'account_notice', person.id);
    res.json({ temporaryPassword });
  });

  router.patch('/users/:id/active', auth, (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return res.status(403).json({ error: 'Nur HR darf Konten sperren.' });
    const person = findPerson(Number(req.params.id));
    if (!person) return res.status(404).json({ error: 'Person nicht gefunden.' });
    if (person.id === actor.id) return res.status(400).json({ error: 'Du kannst dein eigenes Konto nicht sperren.' });
    if (!canManageAccount(actor, person)) return res.status(403).json({ error: 'Dieses Konto darf nur die HR-Administration sperren.' });
    const active = req.body?.active === true;
    if (!active && isProtectedAccount(person.email)) return res.status(403).json(protectedMessage);
    if (!active && isLastActiveAdmin(person)) return res.status(409).json({ error: 'Die letzte aktive HR-Administration kann nicht gesperrt werden.' });
    setUserActive(person.id, active, actor);
    res.json({ ok: true, active, directReports: active ? 0 : activeReports(person.id) });
  });

  return { router };
}

module.exports = { createAccountsRouter };
