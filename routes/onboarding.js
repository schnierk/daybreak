'use strict';

/**
 * Onboarding & Offboarding: Vorlagen mit Aufgaben und begleitete Abläufe für Ein- und Austritte.
 *
 * Beim Start wird die Vorlage kopiert. Spätere Änderungen an der Vorlage wirken deshalb nie auf
 * laufende Abläufe zurück. `startJourney` ist zustandslos und wird auch vom Recruiting aufgerufen.
 *
 * Rechte: Abläufe verwaltet HR einschließlich der Sachbearbeitung, soweit `hrCanAccess` die Person
 * freigibt, und nie den eigenen. Führungskräfte starten nur den Einstieg ihres direkten Teams.
 * Einen Austritt startet nur HR: Die Person sieht ihre Aufgaben sofort. Vorlagen pflegt die Sachbearbeitung nicht.
 *
 * Ein Austrittsablauf verteilt nur Aufgaben. Das Austrittsdatum und die Sperre des Kontos
 * entstehen allein in der Personalakte.
 */

const express = require('express');

const JOURNEY_KINDS = Object.freeze(['onboarding', 'offboarding']);
const JOURNEY_STATUSES = Object.freeze(['active', 'completed', 'cancelled']);
const ASSIGNEE_TYPES = Object.freeze(['person', 'manager', 'hr']);
const LEADERSHIP_ROLES = Object.freeze(['manager', 'director']);
const KIND_LABELS = Object.freeze({ onboarding: 'Einstieg', offboarding: 'Austritt' });
const TASK_TYPE = 'onboarding_task';
const MAX_ID = Number.MAX_SAFE_INTEGER;
const MAX_OFFSET_DAYS = 730;
const MAX_TEMPLATE_TASKS = 100;
const BUSINESS_TIME_ZONE = 'Europe/Berlin';

const ALL_ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
const LEAD_AND_HR_ROLES = Object.freeze(['manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
const HR_ROLES = Object.freeze(['hr_admin', 'hrbp', 'super_admin']);

const DEFAULT_TEMPLATES = Object.freeze([
  {
    name: 'Einstieg',
    kind: 'onboarding',
    description: 'Neutrale Vorlage für neue Mitarbeitende. Passe sie an eure Abläufe an.',
    tasks: [
      { title: 'Vertragsunterlagen vollständig ablegen', description: 'Prüfen, ob alle Unterlagen für den Eintritt vorliegen.', assignee: 'hr', offset: -14 },
      { title: 'Arbeitsplatz und Arbeitsmittel vorbereiten', description: 'Arbeitsplatz, Geräte und Zugänge rechtzeitig organisieren.', assignee: 'manager', offset: -7 },
      { title: 'Einarbeitungsplan erstellen', description: 'Festhalten, wer in den ersten Wochen was erklärt und wer Ansprechperson ist.', assignee: 'manager', offset: -3 },
      { title: 'Willkommensgespräch führen', description: 'Team vorstellen, Erwartungen und erste Aufgaben besprechen.', assignee: 'manager', offset: 0 },
      { title: 'Persönliche Angaben prüfen', description: 'Schau nach, ob deine Angaben stimmen, und melde Änderungen an HR.', assignee: 'person', offset: 0 },
      { title: 'Wichtige Richtlinien lesen', description: 'Nimm dir Zeit für die Regeln und Richtlinien deiner Organisation.', assignee: 'person', offset: 3 },
      { title: 'Gespräch nach dem ersten Monat führen', description: 'Gemeinsam auf den ersten Monat schauen und offene Fragen klären.', assignee: 'manager', offset: 30 }
    ]
  },
  {
    name: 'Austritt',
    kind: 'offboarding',
    description: 'Neutrale Vorlage für austretende Mitarbeitende. Passe sie an eure Abläufe an.',
    tasks: [
      { title: 'Austrittsunterlagen vorbereiten', description: 'Prüfen, welche Unterlagen zum Austritt benötigt werden.', assignee: 'hr', offset: -30 },
      { title: 'Übergabe planen', description: 'Festlegen, wer welche Aufgaben übernimmt.', assignee: 'manager', offset: -14 },
      { title: 'Übergabe dokumentieren', description: 'Halte den Stand deiner Aufgaben für die Nachfolge fest.', assignee: 'person', offset: -7 },
      { title: 'Abschlussgespräch führen', description: 'Rückblick und offene Punkte besprechen.', assignee: 'manager', offset: -3 },
      { title: 'Arbeitsmittel zurückgeben', description: 'Geräte, Schlüssel und Ausweise abgeben.', assignee: 'person', offset: 0 },
      { title: 'Zugänge sperren lassen', description: 'Konten und Zugänge zum Austrittstag beenden.', assignee: 'hr', offset: 0 }
    ]
  }
]);

const nowIso = () => new Date().toISOString();
const bodyOf = req => (req.body && typeof req.body === 'object' ? req.body : {});

function requestError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  return error;
}

const businessDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Kalendertag in Deutschland. Nach UTC begänne der Tag nachts zwei Stunden zu spät. */
function businessToday() {
  const parts = Object.fromEntries(businessDateFormat.formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Prüft auf ein echtes Kalenderdatum. Das reine Format würde auch den 31. Februar durchlassen. */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function germanDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

/** Fortschritt in Prozent. 100 erscheint erst, wenn wirklich alles erledigt ist. */
function progressPercent(done, total) {
  if (!total) return 0;
  if (done >= total) return 100;
  return Math.min(99, Math.round((done / total) * 100));
}

function ensureOnboardingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_templates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('onboarding','offboarding')),
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS onboarding_template_tasks (
      id INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES onboarding_templates(id),
      title TEXT NOT NULL,
      description TEXT,
      assignee_type TEXT NOT NULL CHECK(assignee_type IN ('person','manager','hr')),
      offset_days INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS onboarding_journeys (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      template_id INTEGER REFERENCES onboarding_templates(id),
      template_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('onboarding','offboarding')),
      key_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
      started_by INTEGER REFERENCES users(id),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      cancelled_at TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancel_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS onboarding_journey_tasks (
      id INTEGER PRIMARY KEY,
      journey_id INTEGER NOT NULL REFERENCES onboarding_journeys(id),
      title TEXT NOT NULL,
      description TEXT,
      assignee_type TEXT NOT NULL CHECK(assignee_type IN ('person','manager','hr')),
      assignee_id INTEGER REFERENCES users(id),
      offset_days INTEGER NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL,
      done_at TEXT,
      done_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_template_tasks_template ON onboarding_template_tasks(template_id);
    CREATE INDEX IF NOT EXISTS idx_onboarding_journey_tasks_journey ON onboarding_journey_tasks(journey_id);
    CREATE INDEX IF NOT EXISTS idx_onboarding_journeys_user ON onboarding_journeys(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_one_active_journey ON onboarding_journeys(user_id, kind) WHERE status = 'active';
  `);
}

/** Legt die Standardvorlagen nur an, solange es noch gar keine Vorlage gibt. */
function ensureDefaultTemplates(db) {
  if (db.prepare('SELECT COUNT(*) AS count FROM onboarding_templates').get().count > 0) return;
  const insertTemplate = db.prepare('INSERT INTO onboarding_templates(name,kind,description,created_at,updated_at) VALUES(?,?,?,?,?)');
  const insertTask = db.prepare('INSERT INTO onboarding_template_tasks(template_id,title,description,assignee_type,offset_days) VALUES(?,?,?,?,?)');
  db.transaction(() => {
    const timestamp = nowIso();
    for (const template of DEFAULT_TEMPLATES) {
      const templateId = insertTemplate.run(template.name, template.kind, template.description, timestamp, timestamp).lastInsertRowid;
      for (const task of template.tasks) {
        insertTask.run(templateId, task.title, task.description, task.assignee, task.offset);
      }
    }
  })();
}

/**
 * Findet eine Vorlage, mit der ein Ablauf starten kann: aktiv und mit mindestens einer Aufgabe.
 * Ohne `templateId` wird die älteste passende Vorlage der gewünschten Art genommen.
 */
function findStartableTemplate(db, { templateId = null, kind = null } = {}) {
  ensureOnboardingSchema(db);
  ensureDefaultTemplates(db);
  const hasTasks = 'EXISTS (SELECT 1 FROM onboarding_template_tasks t WHERE t.template_id = onboarding_templates.id)';
  if (templateId) {
    const template = db.prepare(`SELECT * FROM onboarding_templates WHERE id=? AND active=1 AND ${hasTasks}`).get(templateId);
    return template && (!kind || template.kind === kind) ? template : null;
  }
  return db.prepare(`SELECT * FROM onboarding_templates WHERE kind=? AND active=1 AND ${hasTasks} ORDER BY id LIMIT 1`).get(kind) || null;
}

function hrAdminIds(db) {
  return db.prepare("SELECT id FROM users WHERE role='hr_admin' AND is_system_account=0 AND active=1 ORDER BY id").all().map(row => row.id);
}

/**
 * Wer ist zuständig und wer bekommt die Aufgabe auf die Übersicht? Ohne Führungskraft übernimmt HR.
 * Die betroffene Person bekommt HR-Aufgaben nur, wenn es sonst niemanden gibt. Hat die Sachbearbeitung
 * den Ablauf gestartet, sieht sie die HR-Aufgaben ebenfalls: Sie führt ihn ja weiter.
 */
function resolveAssignment(db, assigneeType, person, starter = null) {
  if (assigneeType === 'person') return { assigneeId: person.id, recipients: [person.id] };
  if (assigneeType === 'manager') {
    const manager = person.manager_id
      ? db.prepare('SELECT id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(person.manager_id)
      : null;
    if (manager) return { assigneeId: manager.id, recipients: [manager.id] };
  }
  const admins = hrAdminIds(db);
  const others = admins.filter(id => id !== person.id);
  const recipients = others.length ? others : admins;
  if (starter?.role === 'hr_staff' && !recipients.includes(starter.id)) recipients.push(starter.id);
  return { assigneeId: null, recipients };
}

function dashboardTitle(kind, person, recipientId, taskTitle) {
  const context = recipientId === person.id ? KIND_LABELS[kind] : `${KIND_LABELS[kind]} von ${person.name}`;
  return `${context}: ${taskTitle}`.replace(/[<>]/g, '').slice(0, 300);
}

/**
 * Startet einen Ablauf und verteilt die Aufgaben. Zustandslos: Alles Nötige kommt als Parameter.
 * Ohne `templateId` wird die Standardvorlage der Art `kind` verwendet.
 * Wirft bei ungültigen Angaben einen Fehler mit `status` und deutscher Meldung.
 */
function startJourney(db, { personId, templateId = null, kind = 'onboarding', keyDate, actor = null, createTask, log }) {
  const person = db.prepare('SELECT id,name,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(personId);
  if (!person) throw requestError(404, 'Person nicht gefunden.');
  if (!isCalendarDate(keyDate)) throw requestError(400, 'Bitte gib ein gültiges Datum an.');
  const template = findStartableTemplate(db, { templateId, kind: templateId ? null : kind });
  if (!template) throw requestError(400, 'Es gibt keine aktive Vorlage mit Aufgaben für diesen Ablauf.');
  const running = db.prepare("SELECT id FROM onboarding_journeys WHERE user_id=? AND kind=? AND status='active'").get(person.id, template.kind);
  if (running) throw requestError(409, 'Für diese Person läuft bereits ein Ablauf dieser Art.');

  const templateTasks = db.prepare('SELECT * FROM onboarding_template_tasks WHERE template_id=? ORDER BY offset_days,id').all(template.id);
  const insertTask = db.prepare(`
    INSERT INTO onboarding_journey_tasks(journey_id,title,description,assignee_type,assignee_id,offset_days,due_date)
    VALUES(?,?,?,?,?,?,?)
  `);
  const actorId = actor?.id || null;
  return db.transaction(() => {
    const journeyId = db.prepare(`
      INSERT INTO onboarding_journeys(user_id,template_id,template_name,kind,key_date,started_by,started_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(person.id, template.id, template.name, template.kind, keyDate, actorId, nowIso()).lastInsertRowid;
    for (const task of templateTasks) {
      const dueDate = addDays(keyDate, task.offset_days);
      const { assigneeId, recipients } = resolveAssignment(db, task.assignee_type, person, actor);
      const taskId = insertTask.run(journeyId, task.title, task.description, task.assignee_type, assigneeId, task.offset_days, dueDate).lastInsertRowid;
      for (const recipientId of recipients) {
        createTask(recipientId, dashboardTitle(template.kind, person, recipientId, task.title), TASK_TYPE, taskId, dueDate);
      }
    }
    log(actorId, 'onboarding_journey_started', 'onboarding_journeys', journeyId, null, {
      userId: person.id,
      templateId: template.id,
      kind: template.kind,
      keyDate,
      taskCount: templateTasks.length
    });
    return { id: journeyId, kind: template.kind, taskCount: templateTasks.length };
  })();
}

function createOnboardingModule(deps) {
  const {
    db, auth, current, isHr, isHrOperator, hrCanAccess, blocksSelfEdit, canViewEmployee, subordinateIds,
    cleanText, boundedInt, log, createTask
  } = deps;
  const router = express.Router();

  function initialize() {
    ensureOnboardingSchema(db);
    ensureDefaultTemplates(db);
  }

  const canLead = actor => isHrOperator(actor) || LEADERSHIP_ROLES.includes(actor.role) || subordinateIds(actor).length > 0;

  /** Darf diese Person die Abläufe der anderen als HR verwalten? `person` ist ein Datensatz mit `id` und `role` oder eine ID. */
  function managesJourneysOf(actor, person) {
    const personId = typeof person === 'object' ? person.id : person;
    return isHrOperator(actor) && hrCanAccess(actor, person) && !blocksSelfEdit(actor, personId);
  }

  function requireHr(actor, message = 'Nur HR darf das.') {
    if (!isHr(actor)) throw requestError(403, message);
  }

  function requireLead(actor) {
    if (!canLead(actor)) throw requestError(403, 'Nur Führungskräfte und HR dürfen das.');
  }

  function idFrom(value) {
    return boundedInt(value, 1, MAX_ID, null);
  }

  function loadJourney(value) {
    const id = idFrom(value);
    const journey = id ? db.prepare(`
      SELECT j.*, u.name AS person_name, u.manager_id AS person_manager_id
      FROM onboarding_journeys j
      JOIN users u ON u.id = j.user_id
      WHERE j.id=?
    `).get(id) : null;
    if (!journey) throw requestError(404, 'Ablauf nicht gefunden.');
    return journey;
  }

  function loadTemplate(value) {
    const id = idFrom(value);
    const template = id ? db.prepare('SELECT * FROM onboarding_templates WHERE id=?').get(id) : null;
    if (!template) throw requestError(404, 'Vorlage nicht gefunden.');
    return template;
  }

  function loadJourneyTask(value) {
    const id = idFrom(value);
    const task = id ? db.prepare('SELECT * FROM onboarding_journey_tasks WHERE id=?').get(id) : null;
    if (!task) throw requestError(404, 'Aufgabe nicht gefunden.');
    return task;
  }

  function journeyTasks(journeyId) {
    return db.prepare(`
      SELECT t.*, assignee.name AS assignee_name, doer.name AS done_by_name
      FROM onboarding_journey_tasks t
      LEFT JOIN users assignee ON assignee.id = t.assignee_id
      LEFT JOIN users doer ON doer.id = t.done_by
      WHERE t.journey_id=?
      ORDER BY t.due_date, t.id
    `).all(journeyId);
  }

  function canCompleteTask(actor, task, journey) {
    return managesJourneysOf(actor, journey.user_id) || (task.assignee_id !== null && task.assignee_id === actor.id);
  }

  /** HR bricht Abläufe ab. Wer als Führungskraft einen Einstieg gestartet hat, kann einen Fehlgriff selbst zurücknehmen. */
  function mayCancelJourney(actor, journey) {
    if (managesJourneysOf(actor, journey.user_id)) return true;
    return journey.started_by === actor.id && journey.user_id !== actor.id && canViewEmployee(actor, journey.user_id);
  }

  function progressOf(tasks) {
    const done = tasks.filter(task => task.done_at).length;
    return { done, total: tasks.length, percent: progressPercent(done, tasks.length) };
  }

  /** Vollständige Sicht für HR und die Führungslinie. */
  function fullJourneyView(journey, actor) {
    const tasks = journeyTasks(journey.id);
    return {
      id: journey.id,
      userId: journey.user_id,
      personName: journey.person_name,
      kind: journey.kind,
      templateName: journey.template_name,
      keyDate: journey.key_date,
      status: journey.status,
      startedAt: journey.started_at,
      completedAt: journey.completed_at,
      cancelledAt: journey.cancelled_at,
      cancelReason: journey.cancel_reason,
      progress: progressOf(tasks),
      viewer: 'full',
      canCancel: journey.status === 'active' && mayCancelJourney(actor, journey),
      tasks: tasks.map(task => ({
        id: task.id,
        title: task.title,
        description: task.description,
        assigneeType: task.assignee_type,
        assigneeName: task.assignee_name,
        offsetDays: task.offset_days,
        dueDate: task.due_date,
        done: Boolean(task.done_at),
        doneAt: task.done_at,
        doneByName: task.done_by_name,
        canComplete: journey.status === 'active' && !task.done_at && canCompleteTask(actor, task, journey)
      }))
    };
  }

  /**
   * Sicht der betroffenen Person: nur eigene Aufgaben, von den übrigen allein die Anzahl.
   * Aufgaben von Führungskraft und HR können vertrauliche Hinweise enthalten, gerade beim Austritt.
   */
  function personJourneyView(journey, actor) {
    const tasks = journeyTasks(journey.id);
    const ownTasks = tasks.filter(task => task.assignee_type === 'person');
    const otherTasks = tasks.filter(task => task.assignee_type !== 'person');
    return {
      id: journey.id,
      kind: journey.kind,
      templateName: journey.template_name,
      keyDate: journey.key_date,
      status: journey.status,
      progress: progressOf(tasks),
      viewer: 'person',
      canCancel: false,
      tasks: ownTasks.map(task => ({
        id: task.id,
        title: task.title,
        description: task.description,
        dueDate: task.due_date,
        done: Boolean(task.done_at),
        doneAt: task.done_at,
        canComplete: journey.status === 'active' && !task.done_at && canCompleteTask(actor, task, journey)
      })),
      otherTasks: {
        total: otherTasks.length,
        done: otherTasks.filter(task => task.done_at).length
      }
    };
  }

  /** Liefert die Sicht passend zur Rolle oder wirft 403. */
  function journeyViewFor(actor, journey) {
    if (managesJourneysOf(actor, journey.user_id)) return fullJourneyView(journey, actor);
    if (journey.user_id === actor.id) return personJourneyView(journey, actor);
    if (canViewEmployee(actor, journey.user_id)) return fullJourneyView(journey, actor);
    throw requestError(403, 'Du darfst diesen Ablauf nicht sehen.');
  }

  function closeDashboardTasks(journeyTaskId) {
    db.prepare('UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND done=0').run(TASK_TYPE, journeyTaskId);
  }

  /** Hakt eine Aufgabe ab und schließt den Ablauf, sobald alle Aufgaben erledigt sind. */
  function markTaskDone(task, actorId) {
    return db.transaction(() => {
      const timestamp = nowIso();
      db.prepare('UPDATE onboarding_journey_tasks SET done_at=?,done_by=? WHERE id=?').run(timestamp, actorId, task.id);
      closeDashboardTasks(task.id);
      log(actorId, 'onboarding_task_completed', 'onboarding_journey_tasks', task.id, null, { journeyId: task.journey_id });
      const open = db.prepare('SELECT COUNT(*) AS count FROM onboarding_journey_tasks WHERE journey_id=? AND done_at IS NULL').get(task.journey_id).count;
      if (open > 0) return 'active';
      db.prepare("UPDATE onboarding_journeys SET status='completed',completed_at=? WHERE id=? AND status='active'").run(timestamp, task.journey_id);
      log(actorId, 'onboarding_journey_completed', 'onboarding_journeys', task.journey_id, { status: 'active' }, { status: 'completed' });
      return 'completed';
    })();
  }

  /** Beim Wechsel der Führungskraft ziehen offene Aufgaben mit. Die bisherige sieht den Ablauf nicht mehr. */
  function moveManagerTasks({ userId, managerId }) {
    const openTasks = db.prepare(`
      SELECT t.id, t.title, t.due_date, j.kind
      FROM onboarding_journey_tasks t
      JOIN onboarding_journeys j ON j.id = t.journey_id
      WHERE j.user_id=? AND j.status='active' AND t.assignee_type='manager' AND t.done_at IS NULL
    `).all(userId);
    if (!openTasks.length) return;
    const person = { ...db.prepare('SELECT id,name FROM users WHERE id=?').get(userId), manager_id: managerId };
    const { assigneeId, recipients } = resolveAssignment(db, 'manager', person);
    for (const task of openTasks) {
      db.prepare('UPDATE onboarding_journey_tasks SET assignee_id=? WHERE id=?').run(assigneeId, task.id);
      closeDashboardTasks(task.id);
      for (const recipientId of recipients) {
        createTask(recipientId, dashboardTitle(task.kind, person, recipientId, task.title), TASK_TYPE, task.id, task.due_date);
      }
    }
    log(null, 'onboarding_tasks_moved', 'users', userId, null, { managerId, taskCount: openTasks.length });
  }

  deps.onManagerChanged?.(moveManagerTasks);

  function templateTaskView(task) {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      assigneeType: task.assignee_type,
      offsetDays: task.offset_days
    };
  }

  function templateView(template) {
    const tasks = db.prepare('SELECT * FROM onboarding_template_tasks WHERE template_id=? ORDER BY offset_days,id').all(template.id);
    return {
      id: template.id,
      name: template.name,
      kind: template.kind,
      description: template.description,
      active: Boolean(template.active),
      tasks: tasks.map(templateTaskView)
    };
  }

  function readTemplateTask(input, existing = null) {
    const title = input.title === undefined && existing ? existing.title : cleanText(input.title, 200);
    if (!title) throw requestError(400, 'Bitte gib einen Titel für die Aufgabe an.');
    const description = input.description === undefined && existing ? existing.description : cleanText(input.description, 2000) || null;
    const assigneeType = input.assigneeType === undefined && existing ? existing.assignee_type : input.assigneeType;
    if (!ASSIGNEE_TYPES.includes(assigneeType)) throw requestError(400, 'Zuständig kann nur die Person, die Führungskraft oder HR sein.');
    const rawOffset = input.offsetDays === undefined ? (existing ? existing.offset_days : 0) : input.offsetDays;
    const offsetDays = boundedInt(rawOffset, -MAX_OFFSET_DAYS, MAX_OFFSET_DAYS, null);
    if (offsetDays === null) throw requestError(400, `Der Abstand muss zwischen -${MAX_OFFSET_DAYS} und ${MAX_OFFSET_DAYS} Tagen liegen.`);
    return { title, description, assigneeType, offsetDays };
  }

  function touchTemplate(templateId, actorId) {
    db.prepare('UPDATE onboarding_templates SET updated_by=?,updated_at=? WHERE id=?').run(actorId, nowIso(), templateId);
  }

  /** Nur erfundene Beispielabläufe zu vorhandenen Personen, und nur beim ersten Aufruf. */
  function seedDemo() {
    if (db.prepare('SELECT COUNT(*) AS count FROM onboarding_journeys').get().count > 0) return;
    const employees = db.prepare("SELECT id FROM users WHERE is_system_account=0 AND active=1 AND role='employee' ORDER BY id").all();
    if (!employees.length) return;
    const today = nowIso().slice(0, 10);
    const newcomer = employees[3] ?? employees[0];
    const keyDate = addDays(today, -3);
    const journey = startJourney(db, { personId: newcomer.id, kind: 'onboarding', keyDate, createTask, log });
    // Die Vorbereitung ist gelaufen, die Aufgaben ab dem ersten Tag bleiben zum Ausprobieren offen.
    const preparationTasks = db.prepare('SELECT * FROM onboarding_journey_tasks WHERE journey_id=? AND due_date<? ORDER BY due_date,id').all(journey.id, keyDate);
    preparationTasks.forEach(task => markTaskDone(task, null));
    if (employees.length > 1) {
      startJourney(db, { personId: employees[employees.length - 1].id, kind: 'offboarding', keyDate: addDays(today, 30), createTask, log });
    }
  }

  /** Führungskräfte brauchen nur Einstiegsvorlagen. Austrittsvorlagen können vertrauliche Hinweise enthalten. */
  const mayStartKind = (actor, kind) => kind !== 'offboarding' || isHrOperator(actor);

  /**
   * Ein Datum in der Vergangenheit ist meist ein Tippfehler, kann aber auch ein Nachtrag sein.
   * Deshalb muss es ausdrücklich bestätigt werden.
   */
  function assertKeyDatePlausible(keyDate, pastDateConfirmed) {
    if (!isCalendarDate(keyDate)) throw requestError(400, 'Bitte gib ein gültiges Datum an.');
    const today = businessToday();
    if (keyDate > addDays(today, MAX_OFFSET_DAYS)) {
      throw requestError(400, 'Dieses Datum liegt mehr als zwei Jahre in der Zukunft. Bitte prüfe es.');
    }
    if (keyDate < today && !pastDateConfirmed) {
      throw requestError(409, `Der ${germanDate(keyDate)} liegt in der Vergangenheit. Aufgaben davor wären sofort überfällig.`, { code: 'past_key_date' });
    }
  }

  router.use('/onboarding', auth);

  router.get('/onboarding/mine', (req, res) => {
    const actor = current(req);
    const journeys = db.prepare(`
      SELECT j.*, u.name AS person_name
      FROM onboarding_journeys j
      JOIN users u ON u.id = j.user_id
      WHERE j.user_id=? AND j.status <> 'cancelled'
      ORDER BY j.key_date DESC, j.id DESC
    `).all(actor.id);
    res.json({ journeys: journeys.map(journey => personJourneyView(journey, actor)) });
  });

  router.get('/onboarding/meta', (req, res) => {
    const actor = current(req);
    requireLead(actor);
    const everyone = db.prepare('SELECT id,name,role,manager_id FROM users WHERE is_system_account=0 AND active=1 ORDER BY name').all();
    const surnameOf = person => String(person.name).trim().split(/\s+/).pop();
    const people = everyone
      .filter(person => person.manager_id === actor.id || managesJourneysOf(actor, person))
      .sort((first, second) => surnameOf(first).localeCompare(surnameOf(second), 'de'));
    const templates = db.prepare('SELECT * FROM onboarding_templates WHERE active=1 ORDER BY kind DESC,name').all();
    res.json({
      people: people.map(person => ({ id: person.id, name: person.name })),
      templates: templates
        .filter(template => mayStartKind(actor, template.kind))
        .map(templateView)
        .filter(template => template.tasks.length > 0),
      canManageTemplates: isHr(actor)
    });
  });

  router.get('/onboarding/journeys', (req, res) => {
    const actor = current(req);
    const { status, kind, userId } = req.query;
    if (status !== undefined && !JOURNEY_STATUSES.includes(status)) throw requestError(400, 'Unbekannter Status.');
    if (kind !== undefined && !JOURNEY_KINDS.includes(kind)) throw requestError(400, 'Unbekannte Art.');
    const personFilter = userId === undefined ? null : idFrom(userId);
    if (userId !== undefined && !personFilter) throw requestError(400, 'Ungültige Person.');
    if (personFilter) {
      if (!managesJourneysOf(actor, personFilter) && !canViewEmployee(actor, personFilter)) {
        throw requestError(403, 'Du darfst die Abläufe dieser Person nicht sehen.');
      }
    } else {
      requireLead(actor);
    }
    const rows = db.prepare(`
      SELECT j.*, u.name AS person_name,
             COUNT(t.id) AS task_total,
             SUM(CASE WHEN t.done_at IS NOT NULL THEN 1 ELSE 0 END) AS task_done
      FROM onboarding_journeys j
      JOIN users u ON u.id = j.user_id
      LEFT JOIN onboarding_journey_tasks t ON t.journey_id = j.id
      GROUP BY j.id, u.name
      ORDER BY j.key_date DESC, j.id DESC
    `).all();
    const visible = rows
      .filter(row => status === undefined || row.status === status)
      .filter(row => kind === undefined || row.kind === kind)
      .filter(row => !personFilter || row.user_id === personFilter)
      .filter(row => managesJourneysOf(actor, row.user_id) || (row.user_id !== actor.id && canViewEmployee(actor, row.user_id)) || row.user_id === personFilter);
    res.json({
      journeys: visible.map(row => ({
        id: row.id,
        userId: row.user_id,
        personName: row.person_name,
        kind: row.kind,
        templateName: row.template_name,
        keyDate: row.key_date,
        status: row.status,
        progress: { done: row.task_done || 0, total: row.task_total, percent: progressPercent(row.task_done || 0, row.task_total) }
      }))
    });
  });

  router.post('/onboarding/journeys', (req, res) => {
    const actor = current(req);
    const input = bodyOf(req);
    const personId = idFrom(input.userId);
    const person = personId
      ? db.prepare('SELECT id,role,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(personId)
      : null;
    if (!person && isHrOperator(actor)) throw requestError(404, 'Person nicht gefunden.');
    if (person?.id === actor.id && isHrOperator(actor) && blocksSelfEdit(actor, person.id)) {
      throw requestError(403, 'Einen Ablauf für dich selbst startet eine andere HR-Person.');
    }
    const asHr = Boolean(person) && managesJourneysOf(actor, person);
    if (!asHr && person?.manager_id !== actor.id) {
      throw requestError(403, 'Einen Ablauf starten dürfen nur HR und die direkte Führungskraft.');
    }
    const templateId = idFrom(input.templateId);
    if (!templateId) throw requestError(400, 'Bitte wähle eine Vorlage.');
    if (findStartableTemplate(db, { templateId })?.kind === 'offboarding' && !asHr) {
      throw requestError(403, 'Einen Austritt startet nur HR. Bitte sprich HR an.');
    }
    assertKeyDatePlausible(input.keyDate, input.confirmPastDate === true);
    const journey = startJourney(db, { personId: person.id, templateId, keyDate: input.keyDate, actor, createTask, log });
    res.json(journey);
  });

  router.get('/onboarding/journeys/:id', (req, res) => {
    const actor = current(req);
    res.json({ journey: journeyViewFor(actor, loadJourney(req.params.id)) });
  });

  router.post('/onboarding/journeys/:id/cancel', (req, res) => {
    const actor = current(req);
    requireLead(actor);
    const journey = loadJourney(req.params.id);
    if (!mayCancelJourney(actor, journey)) {
      throw requestError(403, 'Abbrechen dürfen HR und, beim Einstieg, die Führungskraft, die ihn gestartet hat.');
    }
    if (journey.status !== 'active') throw requestError(409, 'Nur laufende Abläufe lassen sich abbrechen.');
    const reason = cleanText(bodyOf(req).reason, 500) || null;
    db.transaction(() => {
      db.prepare("UPDATE onboarding_journeys SET status='cancelled',cancelled_at=?,cancelled_by=?,cancel_reason=? WHERE id=?")
        .run(nowIso(), actor.id, reason, journey.id);
      for (const task of db.prepare('SELECT id FROM onboarding_journey_tasks WHERE journey_id=?').all(journey.id)) {
        closeDashboardTasks(task.id);
      }
      log(actor.id, 'onboarding_journey_cancelled', 'onboarding_journeys', journey.id, { status: journey.status }, { status: 'cancelled' });
    })();
    res.json({ ok: true });
  });

  // Dient der Sprungmarke von der Übersicht: verrät nur, zu welchem Ablauf eine Aufgabe gehört.
  router.get('/onboarding/tasks/:id', (req, res) => {
    const actor = current(req);
    const task = loadJourneyTask(req.params.id);
    const journey = loadJourney(task.journey_id);
    journeyViewFor(actor, journey);
    res.json({ journeyId: journey.id, own: journey.user_id === actor.id });
  });

  router.post('/onboarding/tasks/:id/complete', (req, res) => {
    const actor = current(req);
    const task = loadJourneyTask(req.params.id);
    const journey = loadJourney(task.journey_id);
    if (!canCompleteTask(actor, task, journey)) throw requestError(403, 'Diese Aufgabe dürfen nur die zuständige Person und HR erledigen.');
    if (journey.status !== 'active') throw requestError(409, 'Dieser Ablauf läuft nicht mehr.');
    if (task.done_at) throw requestError(409, 'Diese Aufgabe ist bereits erledigt.');
    const journeyStatus = markTaskDone(task, actor.id);
    res.json({ ok: true, journeyStatus, progress: progressOf(journeyTasks(journey.id)) });
  });

  router.get('/onboarding/templates', (req, res) => {
    const actor = current(req);
    requireLead(actor);
    const { kind } = req.query;
    if (kind !== undefined && !JOURNEY_KINDS.includes(kind)) throw requestError(400, 'Unbekannte Art.');
    const includeInactive = isHr(actor) && req.query.includeInactive === 'true';
    const templates = db.prepare('SELECT * FROM onboarding_templates ORDER BY kind DESC,name').all()
      .filter(template => mayStartKind(actor, template.kind))
      .filter(template => includeInactive || template.active === 1)
      .filter(template => kind === undefined || template.kind === kind);
    res.json({ templates: templates.map(templateView) });
  });

  router.post('/onboarding/templates', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Vorlagen pflegt HR.');
    const input = bodyOf(req);
    const name = cleanText(input.name, 160);
    if (!name) throw requestError(400, 'Bitte gib der Vorlage einen Namen.');
    if (!JOURNEY_KINDS.includes(input.kind)) throw requestError(400, 'Bitte wähle Einstieg oder Austritt.');
    const description = cleanText(input.description, 2000) || null;
    const rawTasks = input.tasks === undefined ? [] : input.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length > MAX_TEMPLATE_TASKS) throw requestError(400, 'Die Aufgabenliste ist ungültig.');
    const tasks = rawTasks.map(task => readTemplateTask(task && typeof task === 'object' ? task : {}));
    const id = db.transaction(() => {
      const timestamp = nowIso();
      const templateId = db.prepare(`
        INSERT INTO onboarding_templates(name,kind,description,created_by,updated_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(name, input.kind, description, actor.id, actor.id, timestamp, timestamp).lastInsertRowid;
      const insertTask = db.prepare('INSERT INTO onboarding_template_tasks(template_id,title,description,assignee_type,offset_days) VALUES(?,?,?,?,?)');
      tasks.forEach(task => insertTask.run(templateId, task.title, task.description, task.assigneeType, task.offsetDays));
      log(actor.id, 'onboarding_template_created', 'onboarding_templates', templateId, null, { name, kind: input.kind, taskCount: tasks.length });
      return templateId;
    })();
    res.json({ id });
  });

  router.get('/onboarding/templates/:id', (req, res) => {
    const actor = current(req);
    requireLead(actor);
    const template = loadTemplate(req.params.id);
    if (!mayStartKind(actor, template.kind)) throw requestError(403, 'Austrittsvorlagen sieht nur HR.');
    if (!template.active && !isHr(actor)) throw requestError(403, 'Diese Vorlage ist nicht mehr aktiv.');
    res.json({ template: templateView(template) });
  });

  router.patch('/onboarding/templates/:id', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Vorlagen pflegt HR.');
    const template = loadTemplate(req.params.id);
    const input = bodyOf(req);
    const name = input.name === undefined ? template.name : cleanText(input.name, 160);
    if (!name) throw requestError(400, 'Bitte gib der Vorlage einen Namen.');
    const description = input.description === undefined ? template.description : cleanText(input.description, 2000) || null;
    if (input.active !== undefined && typeof input.active !== 'boolean') throw requestError(400, 'Bitte gib an, ob die Vorlage aktiv ist.');
    const active = input.active === undefined ? template.active : Number(input.active);
    db.prepare('UPDATE onboarding_templates SET name=?,description=?,active=?,updated_by=?,updated_at=? WHERE id=?')
      .run(name, description, active, actor.id, nowIso(), template.id);
    log(actor.id, 'onboarding_template_updated', 'onboarding_templates', template.id,
      { name: template.name, active: template.active }, { name, active });
    res.json({ ok: true });
  });

  router.post('/onboarding/templates/:id/tasks', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Vorlagen pflegt HR.');
    const template = loadTemplate(req.params.id);
    const count = db.prepare('SELECT COUNT(*) AS count FROM onboarding_template_tasks WHERE template_id=?').get(template.id).count;
    if (count >= MAX_TEMPLATE_TASKS) throw requestError(400, `Eine Vorlage kann höchstens ${MAX_TEMPLATE_TASKS} Aufgaben haben.`);
    const task = readTemplateTask(bodyOf(req));
    const id = db.prepare('INSERT INTO onboarding_template_tasks(template_id,title,description,assignee_type,offset_days) VALUES(?,?,?,?,?)')
      .run(template.id, task.title, task.description, task.assigneeType, task.offsetDays).lastInsertRowid;
    touchTemplate(template.id, actor.id);
    log(actor.id, 'onboarding_template_task_added', 'onboarding_template_tasks', id, null, { templateId: template.id });
    res.json({ id });
  });

  router.patch('/onboarding/template-tasks/:id', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Vorlagen pflegt HR.');
    const id = idFrom(req.params.id);
    const existing = id ? db.prepare('SELECT * FROM onboarding_template_tasks WHERE id=?').get(id) : null;
    if (!existing) throw requestError(404, 'Aufgabe nicht gefunden.');
    const task = readTemplateTask(bodyOf(req), existing);
    db.prepare('UPDATE onboarding_template_tasks SET title=?,description=?,assignee_type=?,offset_days=? WHERE id=?')
      .run(task.title, task.description, task.assigneeType, task.offsetDays, existing.id);
    touchTemplate(existing.template_id, actor.id);
    log(actor.id, 'onboarding_template_task_updated', 'onboarding_template_tasks', existing.id, null, { templateId: existing.template_id });
    res.json({ ok: true });
  });

  // Laufende Abläufe haben eigene Kopien, deshalb betrifft das Löschen nur künftige Starts.
  router.delete('/onboarding/template-tasks/:id', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Vorlagen pflegt HR.');
    const id = idFrom(req.params.id);
    const existing = id ? db.prepare('SELECT * FROM onboarding_template_tasks WHERE id=?').get(id) : null;
    if (!existing) throw requestError(404, 'Aufgabe nicht gefunden.');
    db.prepare('DELETE FROM onboarding_template_tasks WHERE id=?').run(existing.id);
    touchTemplate(existing.template_id, actor.id);
    log(actor.id, 'onboarding_template_task_deleted', 'onboarding_template_tasks', existing.id, null, { templateId: existing.template_id });
    res.json({ ok: true });
  });

  router.use('/onboarding', (error, req, res, next) => {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: error.message, ...(error.extra || {}) });
    }
    next(error);
  });

  const helpArticles = [
    {
      id: 'onboarding-mine',
      title: 'Mein Einstieg oder Austritt',
      roles: ALL_ROLES,
      views: ['onboardingMine', 'dashboard'],
      keywords: ['einstieg', 'onboarding', 'erste tage', 'neu hier', 'checkliste', 'austritt', 'offboarding'],
      answer: 'Wenn für dich ein Einstieg oder Austritt läuft, findest du unter „Meine Arbeit“ deine eigenen Aufgaben mit Fälligkeit und den Gesamtfortschritt. Die Aufgaben stehen auch in der Übersicht.',
      steps: ['Öffne „Mein Einstieg“ unter „Meine Arbeit“ oder die Aufgabe in der Übersicht.', 'Erledige die Aufgabe.', 'Klicke auf „Erledigt“. Der Fortschritt aktualisiert sich sofort.'],
      actions: [{ label: 'Meinen Ablauf öffnen', view: 'onboardingMine' }]
    },
    {
      id: 'onboarding-start',
      title: 'Einen Ein- oder Austritt starten',
      roles: LEAD_AND_HR_ROLES,
      views: ['onboardingHome', 'onboardingJourney'],
      keywords: ['ablauf starten', 'onboarding starten', 'neue person', 'eintritt', 'austritt', 'offboarding starten'],
      answer: 'Einen Einstieg starten HR und die direkte Führungskraft, einen Austritt nur HR. Du wählst Person, Vorlage und den ersten oder letzten Arbeitstag. Daybreak verteilt daraufhin die Aufgaben an die Person, die Führungskraft und HR. Ein Austrittsablauf verteilt nur Aufgaben: Das Austrittsdatum und die Sperre des Kontos entstehen erst in der Personalakte.',
      steps: ['Öffne „Ein- und Austritte“.', 'Klicke auf „Ablauf starten“.', 'Wähle Person, Vorlage und Datum.', 'Falsch gestartet? Öffne den Ablauf und klicke auf „Ablauf abbrechen“.'],
      actions: [{ label: 'Abläufe öffnen', view: 'onboardingHome' }]
    },
    {
      id: 'onboarding-templates',
      title: 'Vorlagen für Ein- und Austritte pflegen',
      roles: HR_ROLES,
      views: ['onboardingTemplates', 'onboardingTemplate'],
      keywords: ['vorlage', 'checkliste anpassen', 'aufgabe in vorlage', 'onboarding vorlage', 'abstand tage'],
      answer: 'HR pflegt die Vorlagen. Je Aufgabe legst du Titel, Zuständigkeit und den Abstand in Tagen zum ersten oder letzten Arbeitstag fest, auch negativ für Aufgaben davor. Änderungen gelten nur für neue Abläufe, laufende Abläufe bleiben unverändert.',
      steps: ['Öffne den Reiter „Vorlagen“.', 'Wähle eine Vorlage oder lege eine neue an.', 'Ergänze oder ändere die Aufgaben.'],
      actions: [{ label: 'Vorlagen öffnen', view: 'onboardingTemplates' }]
    }
  ];

  return { router, initialize, seedDemo, helpArticles };
}

module.exports = { createOnboardingModule, findStartableTemplate, startJourney };
