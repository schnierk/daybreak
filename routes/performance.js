'use strict';

/**
 * Übersicht, Ziele, Check-ins, Teamansicht und Auswertung.
 *
 * Ein Ziel durchläuft diese Stände:
 * - Die Person legt es selbst an: pending_manager_approval, die Führungskraft prüft.
 * - Die Führungskraft schlägt es vor: pending_employee_acceptance, die Person antwortet.
 * - Änderungswünsche führen zu changes_requested_by_manager oder changes_requested_by_employee.
 * - Mit approved zählt es in der Zielerreichung.
 */

const express = require('express');

const GOAL_STATUSES = new Set(['on_track', 'needs_focus', 'off_track']);
const GOAL_TASK_TYPES = "('goal_approval','goal_acceptance','goal_revision_employee','goal_revision_manager')";
// Aufgaben, die nur informieren. Sie lassen sich mit einem Klick erledigen.
const NOTICE_TASK = /(?:_notice|_info)$/;
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** 2026-05 wird zu „Mai 2026“. */
function monthLabel(period) {
  const [year, month] = String(period).split('-');
  return MONTH_NAMES[Number(month) - 1] ? `${MONTH_NAMES[Number(month) - 1]} ${year}` : String(period);
}

function createPerformanceRouter({
  db, auth, current, isHr, canEditEmployee, canViewEmployee, subordinateIds, cleanText, boundedInt, validDate,
  log, createTask, approvalRule, isModuleEnabled, goalProgress, onManagerChanged, goalTypes, taskVisible
}) {
  const router = express.Router();

  const goalById = id => db.prepare('SELECT g.*,u.name owner_name FROM goals g JOIN users u ON u.id=g.user_id WHERE g.id=?').get(id);
  const goalSnapshot = goal => ({ title: goal.title, description: goal.description, weight: goal.weight, progress: goal.progress, status: goal.status, dueDate: goal.due_date, approvalStatus: goal.approval_status });
  const closeGoalTasks = goalId => db.prepare(`UPDATE tasks SET done=1 WHERE entity_id=? AND done=0 AND type IN ${GOAL_TASK_TYPES}`).run(goalId);
  const managerOf = userId => db.prepare('SELECT manager_id FROM users WHERE id=?').get(userId)?.manager_id;
  const activePerson = id => db.prepare('SELECT id,name,role,manager_id FROM users WHERE id=? AND active=1 AND is_system_account=0').get(id);

  /** Wer einen Zielvorschlag weiterbearbeitet: wer ihn gemacht hat, solange das noch passt. Sonst die aktuelle Führungskraft. */
  function goalResponsible(goal) {
    const creator = activePerson(goal.created_by);
    if (creator && creator.id !== goal.user_id && canEditEmployee(creator, goal.user_id)) return creator.id;
    return managerOf(goal.user_id) ?? null;
  }

  /** Greift HR bei einer Person ein, soll die direkte Führungskraft davon erfahren. */
  function tellDirectManager(actor, employeeId, title, type, entityId) {
    const manager = managerOf(employeeId);
    if (manager && manager !== actor.id && manager !== employeeId) createTask(manager, title, type, entityId);
  }

  // Wechselt die Führungskraft, wechselt auch die Freigabe der noch offenen Ziele.
  onManagerChanged(({ userId, previousManagerId, managerId }) => {
    // Hinweise zu Check-ins dieser Person führen bei der bisherigen Führungskraft sonst ins Leere.
    db.prepare("UPDATE tasks SET done=1 WHERE type='checkin_feedback_notice' AND done=0 AND user_id=? AND entity_id IN (SELECT id FROM checkins WHERE employee_id=?)").run(previousManagerId ?? 0, userId);
    const pending = db.prepare("SELECT id FROM goals WHERE user_id=? AND approval_status='pending_manager_approval'").all(userId);
    for (const goal of pending) {
      if (managerId) {
        db.prepare("UPDATE tasks SET user_id=? WHERE type='goal_approval' AND entity_id=? AND done=0").run(managerId, goal.id);
      } else {
        // Ohne Führungskraft gibt es niemanden, der freigibt. So verhält sich auch ein neues Ziel.
        db.prepare("UPDATE goals SET approval_status='approved' WHERE id=?").run(goal.id);
        closeGoalTasks(goal.id);
      }
    }
    // Wünscht die Person Änderungen an einem Vorschlag, übernimmt die neue Führungskraft auch das.
    const revisions = db.prepare(`SELECT t.id task_id,g.id goal_id,g.title FROM tasks t JOIN goals g ON g.id=t.entity_id
      WHERE t.type='goal_revision_manager' AND t.done=0 AND t.user_id=? AND g.user_id=?`).all(previousManagerId ?? 0, userId);
    for (const revision of revisions) {
      if (managerId) {
        db.prepare('UPDATE tasks SET user_id=? WHERE id=?').run(managerId, revision.task_id);
      } else {
        // Ohne Führungskraft überarbeitet die Person das Ziel selbst.
        db.prepare("UPDATE goals SET approval_status='changes_requested_by_manager' WHERE id=?").run(revision.goal_id);
        closeGoalTasks(revision.goal_id);
        createTask(userId, `Überarbeite dein Ziel „${revision.title}“. Du hast gerade keine Führungskraft, es gilt danach sofort.`, 'goal_revision_employee', revision.goal_id);
      }
    }
  });

  router.get('/dashboard', auth, (req, res) => {
    const actor = current(req);
    const allGoals = isModuleEnabled('goals') ? db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY weight DESC, progress DESC').all(actor.id) : [];
    // Das wichtigste freigegebene Ziel steht vorn.
    const goals = [...allGoals.filter(goal => goal.approval_status === 'approved'), ...allGoals.filter(goal => goal.approval_status !== 'approved')];
    const checkins = isModuleEnabled('checkins') ? db.prepare('SELECT c.*,m.name manager_name FROM checkins c JOIN users m ON m.id=c.manager_id WHERE employee_id=? ORDER BY period DESC, c.id DESC').all(actor.id) : [];
    const tasks = db.prepare("SELECT * FROM tasks WHERE user_id=? AND done=0 ORDER BY COALESCE(due_date,'9999-12-31'), id").all(actor.id).filter(taskVisible);
    const approved = allGoals.filter(goal => goal.approval_status === 'approved');
    res.json({
      user: actor,
      goals,
      checkins,
      tasks,
      metrics: {
        goalProgress: goalProgress(allGoals),
        onTrack: approved.filter(goal => goal.status === 'on_track').length,
        totalGoals: approved.length,
        performance: checkins[0]?.performance || null
      }
    });
  });

  // Reine Hinweise schließt die Person selbst. Aufgaben mit einem Vorgang dahinter schließt der Vorgang.
  router.post('/tasks/:id/done', auth, (req, res) => {
    const actor = current(req);
    const task = db.prepare('SELECT id,user_id,type FROM tasks WHERE id=?').get(Number(req.params.id));
    if (!task || task.user_id !== actor.id) return res.status(404).json({ error: 'Diese Aufgabe gibt es nicht.' });
    if (!NOTICE_TASK.test(String(task.type || ''))) return res.status(409).json({ error: 'Diese Aufgabe schließt sich, sobald der Vorgang erledigt ist.' });
    db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(task.id);
    res.json({ ok: true });
  });

  router.get('/goals', auth, (req, res) => {
    const actor = current(req);
    const owner = Number(req.query.userId) || actor.id;
    if (!canViewEmployee(actor, owner)) return res.status(403).json({ error: 'Kein Leserecht für diese Ziele.' });
    res.json({ goals: db.prepare('SELECT g.*,u.name owner_name FROM goals g JOIN users u ON u.id=g.user_id WHERE user_id=? ORDER BY due_date').all(owner) });
  });

  router.get('/goals/:id', auth, (req, res) => {
    const actor = current(req);
    const goal = goalById(req.params.id);
    if (!goal || !canViewEmployee(actor, goal.user_id)) return res.status(403).json({ error: 'Kein Leserecht für dieses Ziel.' });
    res.json({ goal });
  });

  router.post('/goals', auth, (req, res) => {
    const actor = current(req);
    const body = req.body || {};
    const target = Number(body.userId) || actor.id;
    const title = cleanText(body.title, 240);
    const description = cleanText(body.description);
    const weight = boundedInt(body.weight, 1, 100, 100);
    const progress = boundedInt(body.progress, 0, 100, 0);
    const status = GOAL_STATUSES.has(body.status) ? body.status : 'on_track';
    const goalType = goalTypes.has(body.goalType) ? body.goalType : 'business';
    const dueDate = body.dueDate || null;
    if (!title || !validDate(dueDate)) return res.status(400).json({ error: 'Zieltitel und Zieltermin sind ungültig.' });
    if (actor.id !== target && (!['manager', 'director', 'hr_admin', 'hrbp', 'super_admin'].includes(actor.role) || !canEditEmployee(actor, target))) {
      return res.status(403).json({ error: 'Nur direkte Führungskräfte oder HR können Ziele für Mitarbeitende anlegen.' });
    }
    const owner = db.prepare('SELECT manager_id FROM users WHERE id=? AND is_system_account=0').get(target);
    if (!owner) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
    const createdBySelf = actor.id === target;
    const needsApproval = owner.manager_id && approvalRule('goals.approval') !== 'none';
    const approvalStatus = needsApproval ? (createdBySelf ? 'pending_manager_approval' : 'pending_employee_acceptance') : 'approved';
    const id = db.prepare('INSERT INTO goals(user_id,title,description,weight,progress,status,due_date,created_by,approval_status,goal_type) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(target, title, description, weight, progress, status, dueDate, actor.id, approvalStatus, goalType).lastInsertRowid;
    if (approvalStatus !== 'approved') {
      if (createdBySelf) createTask(owner.manager_id, `${actor.name} hat das Ziel „${title}“ zur Freigabe eingereicht`, 'goal_approval', id);
      else createTask(target, `${actor.name} schlägt dir das Ziel „${title}“ vor`, 'goal_acceptance', id);
    }
    if (!createdBySelf) tellDirectManager(actor, target, `${actor.name} hat für ${activePerson(target)?.name || 'eine Person aus deinem Team'} das Ziel „${title}“ angelegt`, 'goal_decision_notice', id);
    log(actor.id, 'goal_created', 'goals', id, null, { userId: target, title, weight, progress, status, dueDate, approvalStatus, goalType });
    res.json({ id, approvalStatus });
  });

  router.patch('/goals/:id', auth, (req, res) => {
    const actor = current(req);
    const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id);
    if (!goal || !canViewEmployee(actor, goal.user_id)) return res.status(403).json({ error: 'Kein Zugriff' });
    const body = req.body || {};
    const next = {
      title: body.title === undefined ? goal.title : cleanText(body.title, 240),
      description: body.description === undefined ? goal.description : cleanText(body.description),
      weight: body.weight === undefined ? goal.weight : boundedInt(body.weight, 1, 100, goal.weight),
      progress: body.progress === undefined ? goal.progress : boundedInt(body.progress, 0, 100, goal.progress),
      status: body.status === undefined || !GOAL_STATUSES.has(body.status) ? goal.status : body.status,
      dueDate: body.dueDate === undefined ? goal.due_date : body.dueDate
    };
    if (!next.title || !validDate(next.dueDate)) return res.status(400).json({ error: 'Zieldaten sind ungültig.' });

    const employeeResubmits = actor.id === goal.user_id && ['changes_requested', 'changes_requested_by_manager'].includes(goal.approval_status) && body.resubmit;
    const managerResubmits = actor.id !== goal.user_id && goal.approval_status === 'changes_requested_by_employee' && body.resubmit && canEditEmployee(actor, goal.user_id);
    if (employeeResubmits || managerResubmits) {
      const recipient = employeeResubmits ? managerOf(goal.user_id) : goal.user_id;
      const nextStatus = !recipient ? 'approved' : employeeResubmits ? 'pending_manager_approval' : 'pending_employee_acceptance';
      db.prepare('UPDATE goals SET title=?,description=?,weight=?,progress=?,status=?,due_date=?,approval_status=?,manager_comment=NULL WHERE id=?')
        .run(next.title, next.description, next.weight, next.progress, next.status, next.dueDate, nextStatus, goal.id);
      closeGoalTasks(goal.id);
      if (recipient) {
        createTask(
          recipient,
          employeeResubmits ? `${actor.name} hat das Ziel „${next.title}“ überarbeitet und neu eingereicht` : `${actor.name} hat dein Ziel „${next.title}“ überarbeitet`,
          employeeResubmits ? 'goal_approval' : 'goal_acceptance',
          goal.id
        );
      }
      log(actor.id, 'goal_resubmitted', 'goals', goal.id, goalSnapshot(goal), { ...next, approvalStatus: nextStatus });
      return res.json({ ok: true });
    }

    if (actor.id === goal.user_id) {
      if (goal.approval_status !== 'approved') return res.status(403).json({ error: 'Den Fortschritt kannst du eintragen, sobald das Ziel freigegeben ist.' });
      db.prepare('UPDATE goals SET progress=?,status=? WHERE id=?').run(next.progress, next.status, goal.id);
      log(actor.id, 'goal_progress_updated', 'goals', goal.id, { progress: goal.progress, status: goal.status }, { progress: next.progress, status: next.status });
      return res.json({ ok: true });
    }

    if (!canEditEmployee(actor, goal.user_id)) return res.status(403).json({ error: 'Nur die direkte Führungskraft oder HR darf dieses Ziel bearbeiten.' });
    // Inhaltliche Änderungen an einem vereinbarten Ziel muss die Person neu annehmen.
    const contentChanged = next.title !== goal.title || next.description !== goal.description || next.weight !== goal.weight || next.dueDate !== goal.due_date;
    const mustReaccept = contentChanged && goal.approval_status === 'approved' && approvalRule('goals.approval') !== 'none';
    const nextApproval = mustReaccept ? 'pending_employee_acceptance' : goal.approval_status;
    db.prepare('UPDATE goals SET progress=?,status=?,title=?,description=?,weight=?,due_date=?,approval_status=? WHERE id=?')
      .run(next.progress, next.status, next.title, next.description, next.weight, next.dueDate, nextApproval, goal.id);
    if (mustReaccept) createTask(goal.user_id, `${actor.name} hat dein Ziel „${next.title}“ geändert. Bitte prüfe es.`, 'goal_acceptance', goal.id);
    tellDirectManager(actor, goal.user_id, `${actor.name} hat das Ziel „${next.title}“ von ${activePerson(goal.user_id)?.name || 'einer Person aus deinem Team'} geändert`, 'goal_decision_notice', goal.id);
    log(actor.id, 'goal_updated', 'goals', goal.id, goalSnapshot(goal), { ...next, approvalStatus: nextApproval });
    res.json({ ok: true });
  });

  router.patch('/goals/:id/review', auth, (req, res) => {
    const actor = current(req);
    const goal = goalById(req.params.id);
    const action = req.body?.action;
    const comment = cleanText(req.body?.comment);
    if (!goal || actor.id === goal.user_id || !canEditEmployee(actor, goal.user_id)) return res.status(403).json({ error: 'Nur die direkte Führungskraft oder HR kann dieses Ziel prüfen.' });
    if (!['approved', 'changes_requested'].includes(action)) return res.status(400).json({ error: 'Ungültige Entscheidung.' });
    if (goal.approval_status !== 'pending_manager_approval') return res.status(409).json({ error: 'Dieses Ziel wartet gerade nicht auf deine Freigabe.' });
    if (action === 'changes_requested' && !comment) return res.status(400).json({ error: 'Bitte beschreibe, was sich ändern soll.' });
    const approvalStatus = action === 'approved' ? 'approved' : 'changes_requested_by_manager';
    db.prepare('UPDATE goals SET approval_status=?,manager_comment=?,reviewed_at=? WHERE id=?').run(approvalStatus, comment || null, new Date().toISOString(), goal.id);
    closeGoalTasks(goal.id);
    if (action === 'changes_requested') createTask(goal.user_id, `${actor.name} wünscht Änderungen an deinem Ziel „${goal.title}“`, 'goal_revision_employee', goal.id);
    else createTask(goal.user_id, `${actor.name} hat dein Ziel „${goal.title}“ freigegeben`, 'goal_decision_notice', goal.id);
    log(actor.id, action === 'approved' ? 'goal_approved' : 'goal_changes_requested', 'goals', goal.id, { approvalStatus: goal.approval_status, managerComment: goal.manager_comment }, { approvalStatus, managerComment: comment || null });
    res.json({ ok: true });
  });

  router.patch('/goals/:id/employee-response', auth, (req, res) => {
    const actor = current(req);
    const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id);
    const action = req.body?.action;
    const comment = cleanText(req.body?.comment);
    if (!goal || goal.user_id !== actor.id) return res.status(403).json({ error: 'Nur die zugeordnete Person kann auf diesen Zielvorschlag reagieren.' });
    if (goal.approval_status !== 'pending_employee_acceptance') return res.status(400).json({ error: 'Dieses Ziel wartet derzeit nicht auf deine Rückmeldung.' });
    if (!['accepted', 'changes_requested'].includes(action)) return res.status(400).json({ error: 'Ungültige Antwort.' });
    if (action === 'changes_requested' && !comment) return res.status(400).json({ error: 'Bitte beschreibe deinen Änderungswunsch.' });
    const responsible = goalResponsible(goal);
    // Ohne zuständige Person überarbeitet die Person ihr Ziel selbst.
    const approvalStatus = action === 'accepted' ? 'approved' : responsible ? 'changes_requested_by_employee' : 'changes_requested_by_manager';
    db.prepare('UPDATE goals SET approval_status=?,manager_comment=?,reviewed_at=? WHERE id=?').run(approvalStatus, comment || null, new Date().toISOString(), goal.id);
    closeGoalTasks(goal.id);
    if (action === 'changes_requested') {
      if (responsible) createTask(responsible, `${actor.name} wünscht Änderungen am Ziel „${goal.title}“`, 'goal_revision_manager', goal.id);
      else createTask(goal.user_id, `Überarbeite dein Ziel „${goal.title}“. Du hast gerade keine Führungskraft, es gilt danach sofort.`, 'goal_revision_employee', goal.id);
    } else if (responsible) {
      createTask(responsible, `${actor.name} hat das Ziel „${goal.title}“ angenommen`, 'goal_decision_notice', goal.id);
    }
    log(actor.id, action === 'accepted' ? 'manager_goal_accepted' : 'manager_goal_changes_requested', 'goals', goal.id, { approvalStatus: goal.approval_status, managerComment: goal.manager_comment }, { approvalStatus, managerComment: comment || null });
    res.json({ ok: true });
  });

  /**
   * Ein Ziel zurückziehen. Ihr eigenes Ziel zieht die Person vor der Freigabe selbst zurück. Einen Vorschlag
   * der Führungskraft beantwortet sie, und ein vereinbartes Ziel nehmen nur die direkte Führungskraft oder HR heraus.
   */
  router.delete('/goals/:id', auth, (req, res) => {
    const actor = current(req);
    const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id);
    if (!goal || !canViewEmployee(actor, goal.user_id)) return res.status(403).json({ error: 'Kein Zugriff' });
    const isOwner = actor.id === goal.user_id;
    const mayEdit = !isOwner && canEditEmployee(actor, goal.user_id);
    const ownDraft = isOwner && goal.created_by === goal.user_id && goal.approval_status !== 'approved';
    if (!mayEdit && !ownDraft) {
      return res.status(403).json({ error: isOwner ? 'Dieses Ziel nimmt nur deine Führungskraft oder HR heraus. Auf einen Vorschlag kannst du mit einem Änderungswunsch antworten.' : 'Nur die direkte Führungskraft oder HR darf dieses Ziel entfernen.' });
    }
    db.transaction(() => {
        closeGoalTasks(goal.id);
        db.prepare('DELETE FROM goal_competencies WHERE goal_id=?').run(goal.id);
        // Eine Entwicklungsmaßnahme bleibt bestehen, sie verweist nur nicht mehr auf das Ziel.
        db.prepare('UPDATE development_decisions SET linked_goal_id=NULL WHERE linked_goal_id=?').run(goal.id);
        db.prepare('UPDATE feedback_development_actions SET linked_goal_id=NULL WHERE linked_goal_id=?').run(goal.id);
        db.prepare('DELETE FROM goals WHERE id=?').run(goal.id);
        log(actor.id, 'goal_withdrawn', 'goals', goal.id, goalSnapshot(goal), { userId: goal.user_id });
    })();
    res.json({ ok: true });
  });

  const checkinWithManager = id => db.prepare('SELECT c.*,m.name manager_name,e.name employee_name FROM checkins c JOIN users m ON m.id=c.manager_id JOIN users e ON e.id=c.employee_id WHERE c.id=?').get(id);
  const validPeriod = period => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period);

  router.get('/checkins', auth, (req, res) => {
    const actor = current(req);
    if (req.query.author === 'me') {
      // Wer nicht mehr zuständig ist, liest auch Kommentar und Sterne nicht mehr.
      const written = db.prepare('SELECT c.*,e.name employee_name FROM checkins c JOIN users e ON e.id=c.employee_id WHERE c.manager_id=? ORDER BY c.period DESC, c.id DESC').all(actor.id);
      return res.json({ checkins: written.filter(checkin => canViewEmployee(actor, checkin.employee_id)) });
    }
    const owner = Number(req.query.userId) || actor.id;
    if (!canViewEmployee(actor, owner)) return res.status(403).json({ error: 'Kein Leserecht für diese Check-ins.' });
    res.json({ checkins: db.prepare('SELECT c.*,m.name manager_name FROM checkins c JOIN users m ON m.id=c.manager_id WHERE employee_id=? ORDER BY period DESC, c.id DESC').all(owner) });
  });

  router.get('/checkins/:id', auth, (req, res) => {
    const actor = current(req);
    const checkin = checkinWithManager(req.params.id);
    if (!checkin || !canViewEmployee(actor, checkin.employee_id)) return res.status(403).json({ error: 'Kein Leserecht für diesen Check-in.' });
    res.json({ checkin, canRespond: checkin.employee_id === actor.id && !checkin.acknowledged_at, canEdit: checkin.manager_id === actor.id && !checkin.acknowledged_at });
  });

  function readCheckin(body) {
    return {
      period: cleanText(body.period, 7),
      summary: cleanText(body.summary),
      achievements: cleanText(body.achievements),
      obstacles: cleanText(body.obstacles),
      nextSteps: cleanText(body.nextSteps),
      performance: boundedInt(body.performance, 1, 5, null),
      onTrack: GOAL_STATUSES.has(body.onTrack) ? body.onTrack : null
    };
  }

  function checkinProblem(values) {
    if (!validPeriod(values.period)) return 'Bitte gib den Monat an, zum Beispiel 2026-11.';
    // Ein Tag Spielraum: Am Monatswechsel liegen Zeitzonen auseinander.
    if (values.period > new Date(Date.now() + 86400000).toISOString().slice(0, 7)) return 'Dieser Monat liegt in der Zukunft. Ein Check-in hält ein Gespräch fest, das schon stattgefunden hat.';
    if (!values.summary || !values.performance || !values.onTrack) return 'Bitte alle Pflichtfelder des Check-ins gültig ausfüllen.';
    return null;
  }

  router.post('/checkins', auth, (req, res) => {
    const actor = current(req);
    const body = req.body || {};
    const employeeId = Number(body.employeeId);
    if (!canEditEmployee(actor, employeeId) || actor.id === employeeId) return res.status(403).json({ error: 'Nur die direkte Führungskraft oder HR kann Check-ins erstellen.' });
    const values = readCheckin(body);
    const problem = checkinProblem(values);
    if (problem) return res.status(400).json({ error: problem });
    const sameMonth = Boolean(db.prepare('SELECT id FROM checkins WHERE employee_id=? AND period=? LIMIT 1').get(employeeId, values.period));
    const id = db.prepare('INSERT INTO checkins(employee_id,manager_id,period,summary,achievements,obstacles,next_steps,performance,on_track) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(employeeId, actor.id, values.period, values.summary, values.achievements, values.obstacles, values.nextSteps, values.performance, values.onTrack).lastInsertRowid;
    createTask(employeeId, `Check-in ${monthLabel(values.period)} lesen und bestätigen`, 'checkin', id);
    tellDirectManager(actor, employeeId, `${actor.name} hat für ${activePerson(employeeId)?.name || 'eine Person aus deinem Team'} den Check-in ${monthLabel(values.period)} erfasst`, 'checkin_feedback_notice', id);
    log(actor.id, 'checkin_created', 'checkins', id, null, { employeeId, period: values.period, performance: values.performance, onTrack: values.onTrack });
    res.json({ id, sameMonth });
  });

  // Die verfassende Führungskraft darf korrigieren, solange die Person noch nicht bestätigt hat.
  router.patch('/checkins/:id', auth, (req, res) => {
    const actor = current(req);
    const checkin = db.prepare('SELECT * FROM checkins WHERE id=?').get(req.params.id);
    if (!checkin || checkin.manager_id !== actor.id || !canViewEmployee(actor, checkin.employee_id)) return res.status(403).json({ error: 'Nur wer den Check-in erfasst hat, kann ihn korrigieren.' });
    if (checkin.acknowledged_at) return res.status(409).json({ error: 'Dieser Check-in ist schon bestätigt und lässt sich nicht mehr ändern.' });
    const values = readCheckin(req.body || {});
    const problem = checkinProblem(values);
    if (problem) return res.status(400).json({ error: problem });
    db.prepare('UPDATE checkins SET period=?,summary=?,achievements=?,obstacles=?,next_steps=?,performance=?,on_track=? WHERE id=?')
      .run(values.period, values.summary, values.achievements, values.obstacles, values.nextSteps, values.performance, values.onTrack, checkin.id);
    db.prepare("UPDATE tasks SET title=? WHERE type='checkin' AND entity_id=? AND done=0").run(`Check-in ${monthLabel(values.period)} lesen und bestätigen`, checkin.id);
    log(actor.id, 'checkin_updated', 'checkins', checkin.id, { period: checkin.period, performance: checkin.performance, onTrack: checkin.on_track }, { period: values.period, performance: values.performance, onTrack: values.onTrack });
    res.json({ ok: true });
  });

  // Zum Beispiel bei der falschen Person erfasst. Bestätigte Check-ins bleiben.
  router.delete('/checkins/:id', auth, (req, res) => {
    const actor = current(req);
    const checkin = db.prepare('SELECT * FROM checkins WHERE id=?').get(req.params.id);
    if (!checkin || checkin.manager_id !== actor.id || !canViewEmployee(actor, checkin.employee_id)) return res.status(403).json({ error: 'Nur wer den Check-in erfasst hat, kann ihn löschen.' });
    if (checkin.acknowledged_at) return res.status(409).json({ error: 'Dieser Check-in ist schon bestätigt und bleibt deshalb erhalten.' });
    db.transaction(() => {
      db.prepare("UPDATE tasks SET done=1 WHERE type='checkin' AND entity_id=? AND done=0").run(checkin.id);
      db.prepare('DELETE FROM checkins WHERE id=?').run(checkin.id);
      log(actor.id, 'checkin_deleted', 'checkins', checkin.id, { employeeId: checkin.employee_id, period: checkin.period }, null);
    })();
    res.json({ ok: true });
  });

  router.patch('/checkins/:id/feedback', auth, (req, res) => {
    const actor = current(req);
    const checkin = db.prepare('SELECT * FROM checkins WHERE id=?').get(req.params.id);
    const comment = cleanText(req.body?.comment);
    const satisfaction = boundedInt(req.body?.satisfaction, 1, 5, null);
    if (!checkin || checkin.employee_id !== actor.id) return res.status(403).json({ error: 'Nur die betreffende Person kann Feedback geben.' });
    if (checkin.acknowledged_at) return res.status(409).json({ error: 'Du hast diesen Check-in schon bestätigt.' });
    if (!satisfaction) return res.status(400).json({ error: 'Bitte bewerte die Zusammenfassung mit 1 bis 5 Sternen.' });
    db.prepare('UPDATE checkins SET employee_comment=?,satisfaction=?,acknowledged_at=? WHERE id=?').run(comment, satisfaction, new Date().toISOString(), checkin.id);
    db.prepare("UPDATE tasks SET done=1 WHERE user_id=? AND type='checkin' AND entity_id=? AND done=0").run(checkin.employee_id, checkin.id);
    // Die Rückmeldung bekommt, wer jetzt für die Person zuständig ist.
    const author = activePerson(checkin.manager_id);
    const recipient = author && canViewEmployee(author, checkin.employee_id) ? author.id : managerOf(checkin.employee_id);
    if (recipient) createTask(recipient, `${actor.name} hat den Check-in ${monthLabel(checkin.period)} bestätigt`, 'checkin_feedback_notice', checkin.id);
    log(actor.id, 'checkin_acknowledged', 'checkins', checkin.id, { employeeComment: checkin.employee_comment, satisfaction: checkin.satisfaction }, { employeeComment: comment, satisfaction });
    res.json({ ok: true });
  });

  router.get('/team', auth, (req, res) => {
    const actor = current(req);
    if (!['manager', 'director', 'hr_admin', 'hrbp', 'super_admin'].includes(actor.role)) return res.status(403).json({ error: 'Keine Teamansicht verfügbar.' });
    const all = db.prepare(`SELECT u.id,u.name,u.title,u.role,u.manager_id,p.title position_profile_title
      FROM users u LEFT JOIN position_profiles p ON p.id=u.position_profile_id
      WHERE u.is_system_account=0 AND u.active=1 ORDER BY u.name`).all();
    const team = all.filter(user => user.id !== actor.id && canViewEmployee(actor, user.id));
    const result = team.map(user => {
      const goals = isModuleEnabled('goals') ? db.prepare('SELECT progress,status,weight,approval_status FROM goals WHERE user_id=?').all(user.id) : [];
      const checkin = isModuleEnabled('checkins') ? db.prepare('SELECT performance FROM checkins WHERE employee_id=? ORDER BY period DESC, id DESC LIMIT 1').get(user.id) : null;
      const approved = goals.filter(goal => goal.approval_status === 'approved');
      return {
        ...user,
        title: user.position_profile_title || user.title,
        direct: user.manager_id === actor.id,
        progress: goalProgress(goals),
        performance: checkin?.performance || null,
        onTrack: approved.filter(goal => goal.status === 'on_track').length,
        totalGoals: approved.length,
        canEdit: canEditEmployee(actor, user.id)
      };
    });
    res.json({ team: result });
  });

  router.get('/reports/overview', auth, (req, res) => {
    const actor = current(req);
    if (!['hr_admin', 'hrbp', 'director', 'super_admin'].includes(actor.role)) return res.status(403).json({ error: 'Nur HR und Bereichsleitung.' });
    const ids = isHr(actor) ? null : subordinateIds(actor);
    if (ids && ids.length === 0) return res.json({ rows: [] });
    const clause = ids ? `AND u.id IN (${ids.map(() => '?').join(',')})` : '';
    const people = db.prepare(`SELECT u.id,u.name,COALESCE(p.title,u.title) title,u.role
      FROM users u LEFT JOIN position_profiles p ON p.id=u.position_profile_id
      WHERE u.is_system_account=0 AND u.active=1 ${clause} ORDER BY u.name`).all(...(ids || []));
    const goalsOn = isModuleEnabled('goals');
    const checkinsOn = isModuleEnabled('checkins');
    const rows = people.map(person => {
      const goals = goalsOn ? db.prepare('SELECT progress,weight,approval_status FROM goals WHERE user_id=?').all(person.id) : [];
      const checkins = checkinsOn ? db.prepare('SELECT AVG(performance) performance, COUNT(*) count FROM checkins WHERE employee_id=?').get(person.id) : null;
      return {
        name: person.name,
        title: person.title,
        role: person.role,
        progress: goalsOn ? goalProgress(goals) : null,
        performance: checkinsOn ? checkins.performance : null,
        checkins: checkinsOn ? checkins.count : 0
      };
    });
    res.json({ rows });
  });

  return { router };
}

module.exports = { createPerformanceRouter };
