'use strict';

/**
 * Lernen und Pflichtschulungen: Kurskatalog, Zuweisungen mit Fristen, Selbstanmeldung,
 * Abschlussnachweise mit optionaler Bestätigung, automatischer Erneuerung und Erfüllungsquoten.
 *
 * Lerninhalte werden nicht gehostet, ein Kurs verweist höchstens per Link darauf.
 * Erinnerungen laufen über Aufgaben auf der Übersicht; Daybreak versendet keine E-Mails.
 *
 * Die HR-Sachbearbeitung gehört hier nicht zu HR (isHr), sie nutzt das Modul wie alle Mitarbeitenden.
 * HR Business Partner sehen und ändern nichts an den Kursen der HR-Leitung (hrCanAccess).
 */

const express = require('express');

const COURSE_TYPES = Object.freeze({ online: 'Online', classroom: 'Präsenz', document: 'Dokument', external: 'Extern' });
const STATUS_LABELS = Object.freeze({ assigned: 'Zugewiesen', started: 'Begonnen', completed: 'Abgeschlossen', expired: 'Abgelaufen' });
const OPEN_STATUSES = Object.freeze(['assigned', 'started']);
const ASSIGNABLE_ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp']);
const LEADERSHIP_ROLES = Object.freeze(['manager', 'director']);
const HR_ROLES = Object.freeze(['hr_admin', 'hrbp']);
const RECERTIFICATION_LEAD_DAYS = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_PROOF_LENGTH = 2000;
const MAX_URL_LENGTH = 2000;
const INVALID = Symbol('invalid');

const DEMO_COURSES = Object.freeze([
  {
    title: 'Sicher arbeiten im Büro',
    description: 'Grundregeln für einen sicheren Arbeitsplatz.',
    courseType: 'online',
    provider: 'Demo-Akademie',
    durationMinutes: 30,
    mandatory: 1,
    validityMonths: 12
  },
  {
    title: 'Sorgsamer Umgang mit Daten',
    description: 'Wie du im Alltag sorgsam mit Daten umgehst.',
    courseType: 'document',
    provider: 'Demo-Akademie',
    durationMinutes: 20,
    mandatory: 1,
    requiresConfirmation: 1,
    validityMonths: 24
  },
  {
    title: 'Gespräche gut moderieren',
    description: 'Besprechungen klar führen und alle einbeziehen.',
    courseType: 'classroom',
    provider: 'Demo-Akademie',
    durationMinutes: 180
  },
  {
    title: 'Einstieg in Datenanalyse',
    description: 'Zahlen lesen und einfache Auswertungen erstellen.',
    courseType: 'external',
    provider: 'Demo-Lernplattform',
    linkUrl: 'https://example.org/datenanalyse',
    durationMinutes: 240
  }
]);

const nowIso = () => new Date().toISOString();
const todayIso = () => nowIso().slice(0, 10);
const flag = value => value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Monatsrechnung ohne Überlauf: Der 31.01. plus ein Monat ergibt den 28.02., nicht den 03.03. */
function addMonths(isoDate, months) {
  const start = new Date(`${isoDate}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDayOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDayOfMonth));
  return target.toISOString().slice(0, 10);
}

function germanDate(isoDate) {
  const [year, month, day] = String(isoDate).split('-');
  return `${day}.${month}.${year}`;
}

/** Nur http und https: So kann ein Kurslink keinen Code im Browser anderer Personen ausführen. */
function parseLink(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return INVALID;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return INVALID;
  }
  const isWebLink = url.protocol === 'http:' || url.protocol === 'https:';
  // Eingebettete Zugangsdaten taugen vor allem zur Täuschung: https://bank.de@boese.example/
  if (!isWebLink || url.username || url.password) return INVALID;
  return url.href;
}

/** Tabellenprogramme führen Felder aus, die mit = + - @ beginnen. Das Apostroph macht sie zu Text. */
function csvField(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  if (/[;"\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Das Einzige in diesem Modul, was nur SQLite versteht. */
function sqliteTableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
}

function createLearningModule(deps) {
  const { db, auth, current, isHr, hrCanAccess, subordinateIds, cleanText, boundedInt, validDate, log, createTask, isModuleEnabled } = deps;
  const router = express.Router();

  const talentAvailable = () => isModuleEnabled('talent') && sqliteTableExists(db, 'qualification_records');
  const isLeader = actor => LEADERSHIP_ROLES.includes(actor.role);

  function routeId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  /** Liefert null für "nichts angegeben", das Datum oder INVALID. validDate allein prüft nur das Muster. */
  function readDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !validDate(value)) return INVALID;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : INVALID;
  }

  function readOptionalInt(value, min, max) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return INVALID;
    return boundedInt(value, min, max, INVALID);
  }

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_courses (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        course_type TEXT NOT NULL CHECK(course_type IN ('online','classroom','document','external')),
        provider TEXT,
        link_url TEXT,
        duration_minutes INTEGER,
        mandatory INTEGER NOT NULL DEFAULT 0,
        requires_confirmation INTEGER NOT NULL DEFAULT 0,
        validity_months INTEGER,
        competency_id INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        updated_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_assignments (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        course_id INTEGER NOT NULL REFERENCES learning_courses(id),
        assigned_by INTEGER REFERENCES users(id),
        source TEXT NOT NULL CHECK(source IN ('hr','manager','self','recertification')),
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','started','completed','expired')),
        started_at TEXT,
        completed_at TEXT,
        proof_text TEXT,
        expires_at TEXT,
        confirmation_pending INTEGER NOT NULL DEFAULT 0,
        reported_completion_date TEXT,
        confirmed_by INTEGER REFERENCES users(id),
        confirmation_note TEXT,
        overdue_reminded INTEGER NOT NULL DEFAULT 0,
        recertification_id INTEGER REFERENCES learning_assignments(id),
        qualification_record_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_one_open_assignment
        ON learning_assignments(user_id, course_id) WHERE status IN ('assigned','started');
      CREATE INDEX IF NOT EXISTS idx_learning_assignments_user ON learning_assignments(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_learning_assignments_course ON learning_assignments(course_id, status);
    `);
  }

  // --- Lesen und Aufbereiten -------------------------------------------------------------

  function competencyOf(course) {
    if (!course.competency_id || !talentAvailable()) return null;
    const competency = db.prepare('SELECT id, name FROM competencies WHERE id=?').get(course.competency_id);
    return competency ? { id: competency.id, name: competency.name } : null;
  }

  function publicCourse(course) {
    return {
      id: course.id,
      title: course.title,
      description: course.description || '',
      courseType: course.course_type,
      courseTypeLabel: COURSE_TYPES[course.course_type],
      provider: course.provider || '',
      linkUrl: course.link_url || null,
      durationMinutes: course.duration_minutes,
      mandatory: Boolean(course.mandatory),
      requiresConfirmation: Boolean(course.requires_confirmation),
      validityMonths: course.validity_months,
      competency: competencyOf(course),
      active: Boolean(course.active)
    };
  }

  const ASSIGNMENT_SELECT = `
    SELECT a.*, c.title AS course_title, c.course_type, c.mandatory, c.link_url, c.duration_minutes, c.provider,
           u.name AS user_name, u.title AS user_title, u.manager_id AS user_manager_id
    FROM learning_assignments a
    JOIN learning_courses c ON c.id = a.course_id
    JOIN users u ON u.id = a.user_id`;

  const assignmentById = id => db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id=?`).get(id);
  const courseById = id => db.prepare('SELECT * FROM learning_courses WHERE id=?').get(id);

  function isOverdue(row, today = todayIso()) {
    return OPEN_STATUSES.includes(row.status) && !row.confirmation_pending && Boolean(row.due_date) && row.due_date < today;
  }

  function publicAssignment(row, { includeProof = true } = {}) {
    return {
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      courseId: row.course_id,
      courseTitle: row.course_title,
      courseType: row.course_type,
      courseTypeLabel: COURSE_TYPES[row.course_type],
      provider: row.provider || '',
      linkUrl: row.link_url || null,
      durationMinutes: row.duration_minutes,
      mandatory: Boolean(row.mandatory),
      source: row.source,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status],
      dueDate: row.due_date,
      overdue: isOverdue(row),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
      confirmationPending: Boolean(row.confirmation_pending),
      confirmationNote: row.confirmation_note || '',
      proofText: includeProof ? row.proof_text || '' : ''
    };
  }

  const byDueDateThenTitle = (first, second) => {
    const firstDue = first.dueDate || '9999-12-31';
    const secondDue = second.dueDate || '9999-12-31';
    return firstDue.localeCompare(secondDue) || first.courseTitle.localeCompare(second.courseTitle, 'de');
  };

  const activePersons = () => db.prepare('SELECT id, name, title, role, manager_id FROM users WHERE is_system_account=0 AND active=1').all();

  // Wer im Modul eine Teamansicht hat. Nur diese Rollen können einer Aufgabe zum Team auch nachgehen.
  const followsUpOnTeam = person => [...LEADERSHIP_ROLES, ...HR_ROLES].includes(person?.role);

  /** Die direkte Führungskraft bestätigt immer, HR nur bei Personen, auf die es zugreifen darf. Nie die Person selbst. */
  function canConfirm(actor, assignment) {
    if (actor.id === assignment.user_id) return false;
    if (assignment.user_manager_id === actor.id && followsUpOnTeam(actor)) return true;
    return isHr(actor) && hrCanAccess(actor, assignment.user_id);
  }

  /** Wen HR im Lernstand sieht. Direkt unterstellte Personen gehören immer dazu, sonst bliebe ihre Bestätigung liegen. */
  const peopleVisibleToHr = actor => activePersons().filter(person => hrCanAccess(actor, person) || person.manager_id === actor.id);

  // --- Schreiben ------------------------------------------------------------------------

  function parseCourse(body, previous = null) {
    const field = (name, fallback) => (body[name] === undefined ? fallback : body[name]);
    const title = cleanText(field('title', previous?.title), MAX_TITLE_LENGTH);
    if (!title) return { error: 'Bitte gib einen Kurstitel an.' };
    const courseType = field('courseType', previous?.course_type);
    if (typeof courseType !== 'string' || !Object.hasOwn(COURSE_TYPES, courseType)) {
      return { error: 'Bitte wähle eine gültige Kursart: Online, Präsenz, Dokument oder Extern.' };
    }
    const linkUrl = parseLink(field('linkUrl', previous?.link_url));
    if (linkUrl === INVALID) return { error: 'Der Link muss eine vollständige Adresse sein, die mit http:// oder https:// beginnt.' };
    const durationMinutes = readOptionalInt(field('durationMinutes', previous?.duration_minutes), 1, 100000);
    if (durationMinutes === INVALID) return { error: 'Die Dauer muss eine ganze Zahl in Minuten sein.' };
    const validityMonths = readOptionalInt(field('validityMonths', previous?.validity_months), 1, 600);
    if (validityMonths === INVALID) return { error: 'Die Gültigkeit muss eine ganze Zahl in Monaten sein.' };

    let competencyId = previous?.competency_id ?? null;
    if (body.competencyId !== undefined && talentAvailable()) {
      const requested = readOptionalInt(body.competencyId, 1, Number.MAX_SAFE_INTEGER);
      const known = requested && requested !== INVALID && db.prepare('SELECT id FROM competencies WHERE id=? AND active=1').get(requested);
      if (requested === INVALID || (requested && !known)) return { error: 'Die gewählte Kompetenz gibt es nicht.' };
      competencyId = requested;
    }

    const mandatory = flag(field('mandatory', previous?.mandatory));
    return {
      value: {
        title,
        description: cleanText(field('description', previous?.description)) || null,
        courseType,
        provider: cleanText(field('provider', previous?.provider), MAX_TITLE_LENGTH) || null,
        linkUrl,
        durationMinutes,
        mandatory: mandatory ? 1 : 0,
        // Eine Bestätigung ist nur bei Pflichtkursen vorgesehen.
        requiresConfirmation: mandatory && flag(field('requiresConfirmation', previous?.requires_confirmation)) ? 1 : 0,
        validityMonths,
        competencyId,
        active: flag(field('active', previous ? previous.active : 1)) ? 1 : 0
      }
    };
  }

  const courseValues = course => [
    course.title,
    course.description,
    course.courseType,
    course.provider,
    course.linkUrl,
    course.durationMinutes,
    course.mandatory,
    course.requiresConfirmation,
    course.validityMonths,
    course.competencyId,
    course.active
  ];

  function insertCourse(course, actorId) {
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO learning_courses(
        title, description, course_type, provider, link_url, duration_minutes, mandatory,
        requires_confirmation, validity_months, competency_id, active,
        created_by, updated_by, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...courseValues(course), actorId, actorId, now, now);
    return Number(result.lastInsertRowid);
  }

  function assignmentTaskTitle(courseTitle, dueDate) {
    return `Schulung „${courseTitle}“ abschließen${dueDate ? ` (bis ${germanDate(dueDate)})` : ''}`;
  }

  /** Legt eine Zuweisung an. Gibt es schon eine offene, passiert nichts und das Ergebnis ist null. */
  function createAssignment({ userId, course, assignedBy, source, dueDate, withTask = true }) {
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO learning_assignments(user_id, course_id, assigned_by, source, due_date, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'assigned', ?, ?)
      ON CONFLICT (user_id, course_id) WHERE status IN ('assigned','started') DO NOTHING
    `).run(userId, course.id, assignedBy, source, dueDate, now, now);
    if (!result.changes) return null;
    const id = Number(result.lastInsertRowid);
    if (withTask) createTask(userId, assignmentTaskTitle(course.title, dueDate), 'learning_assignment', id, dueDate);
    log(assignedBy, 'learning_assignment_created', 'learning_assignments', id, null, { userId, courseId: course.id, dueDate, source });
    return id;
  }

  /**
   * Bestimmt, wem zugewiesen werden soll, und prüft das Recht dazu.
   * HR darf Einzelne, Rollen oder alle; Führungskräfte nur direkt unterstellte Personen.
   */
  function resolveAssignees(actor, body) {
    const hr = isHr(actor);
    if (!hr && !isLeader(actor)) return { status: 403, error: 'Nur HR und Führungskräfte dürfen Kurse zuweisen.' };
    const requestedIds = Array.isArray(body.userIds) ? body.userIds : [];
    const requestedRoles = Array.isArray(body.roles) ? body.roles : [];
    const everyone = body.all === true;
    if (!hr && (requestedRoles.length || everyone)) {
      return { status: 403, error: 'Führungskräfte können nur einzelnen direkt unterstellten Personen Kurse zuweisen.' };
    }
    if ([requestedIds.length > 0, requestedRoles.length > 0, everyone].filter(Boolean).length !== 1) {
      return { status: 400, error: 'Bitte wähle genau eine Zielgruppe: einzelne Personen, Rollen oder alle.' };
    }
    const persons = activePersons();
    if (everyone) return { userIds: persons.map(person => person.id) };
    if (requestedRoles.length) {
      if (requestedRoles.some(role => !ASSIGNABLE_ROLES.includes(role))) return { status: 400, error: 'Mindestens eine Rolle ist ungültig.' };
      // Die Rückmeldung „hat den Kurs schon offen“ wäre sonst eine Auskunft über die HR-Leitung.
      if (requestedRoles.includes('hr_admin') && actor.role === 'hrbp') return { status: 403, error: 'Der HR-Leitung weist nur die HR-Administration gezielt Kurse zu.' };
      return { userIds: persons.filter(person => requestedRoles.includes(person.role)).map(person => person.id) };
    }
    const personById = new Map(persons.map(person => [person.id, person]));
    const userIds = [...new Set(requestedIds.map(Number))];
    if (userIds.some(id => !personById.has(id))) return { status: 400, error: 'Mindestens eine Person wurde nicht gefunden.' };
    if (hr && userIds.some(id => !hrCanAccess(actor, personById.get(id)))) {
      return { status: 403, error: 'Der HR-Leitung weist nur die HR-Administration gezielt Kurse zu.' };
    }
    if (!hr && userIds.some(id => personById.get(id).manager_id !== actor.id)) {
      return { status: 403, error: 'Du kannst nur Personen Kurse zuweisen, die dir direkt unterstellt sind.' };
    }
    return { userIds };
  }

  function closeAssignmentTasks(assignmentId) {
    db.prepare("UPDATE tasks SET done=1 WHERE type IN ('learning_assignment','learning_overdue','learning_confirmation') AND entity_id=? AND done=0").run(assignmentId);
  }

  /** Ein abgeschalteter Kurs lässt sich nicht mehr verlangen. Wird er wieder aktiv, gilt die Aufgabe wieder. */
  function syncTasksWithCourse(courseId, active) {
    const assignments = db.prepare("SELECT id, confirmation_pending, overdue_reminded FROM learning_assignments WHERE course_id=? AND status IN ('assigned','started')").all(courseId);
    for (const assignment of assignments) {
      if (!active) {
        closeAssignmentTasks(assignment.id);
        continue;
      }
      let type = 'learning_assignment';
      if (assignment.confirmation_pending) type = 'learning_confirmation';
      else if (assignment.overdue_reminded) type = 'learning_overdue';
      db.prepare('UPDATE tasks SET done=0 WHERE type=? AND entity_id=?').run(type, assignment.id);
    }
  }

  /** Trägt den Abschluss ins Talentprofil ein. Nur bei eingeschaltetem Talentmodul und je Abschluss einmal. */
  function addQualificationRecord(assignment, course, { actorId, completedAt, expiresAt, proof, confirmed }) {
    if (!talentAvailable() || assignment.qualification_record_id) return null;
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO qualification_records(
        user_id, record_type, title, issuer, issued_at, expires_at, evidence_text, status, source,
        created_by, updated_by, created_at, updated_at
      )
      VALUES(?, 'training', ?, ?, ?, ?, ?, ?, 'learning', ?, ?, ?, ?)
    `).run(
      assignment.user_id,
      course.title,
      course.provider,
      completedAt,
      expiresAt,
      proof || null,
      confirmed ? 'verified' : 'valid',
      actorId,
      actorId,
      now,
      now
    );
    return Number(result.lastInsertRowid);
  }

  const finishAssignment = db.transaction(({ assignment, course, actorId, completedAt, proof, confirmedBy }) => {
    const expiresAt = course.validity_months ? addMonths(completedAt, course.validity_months) : null;
    const recordId = addQualificationRecord(assignment, course, { actorId, completedAt, expiresAt, proof, confirmed: Boolean(confirmedBy) });
    db.prepare(`
      UPDATE learning_assignments
      SET status='completed', completed_at=?, proof_text=?, expires_at=?, confirmation_pending=0, reported_completion_date=NULL,
          confirmed_by=?, confirmation_note=NULL, qualification_record_id=COALESCE(?, qualification_record_id), updated_at=?
      WHERE id=?
    `).run(completedAt, proof || null, expiresAt, confirmedBy || null, recordId, nowIso(), assignment.id);
    closeAssignmentTasks(assignment.id);
    log(
      actorId,
      'learning_assignment_completed',
      'learning_assignments',
      assignment.id,
      { status: assignment.status },
      { status: 'completed', completedAt, expiresAt, confirmedBy: confirmedBy || null }
    );
  });

  /** Wer einen Abschluss bestätigen soll: die direkte Führungskraft, sonst HR. Nie die Person selbst. */
  function confirmationRecipients(assignment) {
    const persons = activePersons();
    const manager = persons.find(person => person.id === assignment.user_manager_id);
    if (followsUpOnTeam(manager)) return [manager.id];
    return persons
      .filter(person => HR_ROLES.includes(person.role) && person.id !== assignment.user_id && hrCanAccess(person, assignment.user_id))
      .map(person => person.id);
  }

  /**
   * Bestätigungen und Hinweise auf überfällige Kurse gehören zur aktuellen Führungskraft.
   * Ohne neue Führungskraft bestätigt HR, ein reiner Hinweis ist dann hinfällig.
   */
  function moveTasksToNewManager({ userId, previousManagerId, managerId }) {
    if (!previousManagerId) return;
    const open = db.prepare("SELECT id FROM learning_assignments WHERE user_id=? AND status IN ('assigned','started')").all(userId);
    const newManager = activePersons().find(person => person.id === managerId);
    const managerFollowsUp = followsUpOnTeam(newManager);
    for (const assignment of open) {
      const tasksOfPrevious = type => db.prepare('SELECT id, title FROM tasks WHERE type=? AND entity_id=? AND user_id=? AND done=0').all(type, assignment.id, previousManagerId);
      for (const task of tasksOfPrevious('learning_overdue')) {
        if (managerFollowsUp) db.prepare('UPDATE tasks SET user_id=? WHERE id=?').run(newManager.id, task.id);
        else db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(task.id);
      }
      for (const task of tasksOfPrevious('learning_confirmation')) {
        if (managerFollowsUp) {
          db.prepare('UPDATE tasks SET user_id=? WHERE id=?').run(newManager.id, task.id);
          continue;
        }
        db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(task.id);
        const row = assignmentById(assignment.id);
        for (const recipient of confirmationRecipients({ ...row, user_manager_id: managerId })) {
          createTask(recipient, task.title, 'learning_confirmation', assignment.id, row.due_date);
        }
      }
    }
  }
  deps.onManagerChanged?.(moveTasksToNewManager);

  const requestConfirmation = db.transaction(({ assignment, course, actor, completedAt, proof, recipients }) => {
    db.prepare(`
      UPDATE learning_assignments
      SET status='started', started_at=COALESCE(started_at, ?), confirmation_pending=1, reported_completion_date=?, proof_text=?, confirmation_note=NULL, updated_at=?
      WHERE id=?
    `).run(nowIso(), completedAt, proof || null, nowIso(), assignment.id);
    // Die Person hat ihren Teil getan. Lehnt die Führungskraft ab, kommt die Aufgabe zurück.
    db.prepare("UPDATE tasks SET done=1 WHERE type IN ('learning_assignment','learning_overdue') AND entity_id=? AND done=0").run(assignment.id);
    for (const userId of recipients) {
      createTask(userId, `${cleanText(assignment.user_name, 120)}: Abschluss von „${course.title}“ bestätigen`, 'learning_confirmation', assignment.id, assignment.due_date);
    }
    log(
      actor.id,
      'learning_completion_reported',
      'learning_assignments',
      assignment.id,
      { status: assignment.status },
      { status: 'started', confirmationPending: true, completedAt }
    );
  });

  router.use('/learning', auth);

  // --- Kurskatalog ----------------------------------------------------------------------

  router.get('/learning/courses', (req, res) => {
    const actor = current(req);
    const includeInactive = isHr(actor) && req.query.includeInactive === 'true';
    const courses = db.prepare(`SELECT * FROM learning_courses ${includeInactive ? '' : 'WHERE active=1'} ORDER BY title`).all();
    res.json({ courses: courses.map(publicCourse) });
  });

  router.post('/learning/courses', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf den Kurskatalog pflegen.' });
    const parsed = parseCourse(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const course = parsed.value;
    const id = insertCourse(course, actor.id);
    log(actor.id, 'learning_course_created', 'learning_courses', id, null, course);
    res.json({ id, course: publicCourse(courseById(id)) });
  });

  router.patch('/learning/courses/:id', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf den Kurskatalog pflegen.' });
    const before = courseById(routeId(req.params.id));
    if (!before) return res.status(404).json({ error: 'Kurs nicht gefunden.' });
    const parsed = parseCourse(req.body || {}, before);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const course = parsed.value;
    db.prepare(`
      UPDATE learning_courses
      SET title=?, description=?, course_type=?, provider=?, link_url=?, duration_minutes=?, mandatory=?,
          requires_confirmation=?, validity_months=?, competency_id=?, active=?, updated_by=?, updated_at=?
      WHERE id=?
    `).run(...courseValues(course), actor.id, nowIso(), before.id);
    if (Boolean(before.active) !== Boolean(course.active)) syncTasksWithCourse(before.id, Boolean(course.active));
    log(actor.id, 'learning_course_updated', 'learning_courses', before.id, before, course);
    res.json({ course: publicCourse(courseById(before.id)) });
  });

  // --- Selbst anmelden ------------------------------------------------------------------

  router.post('/learning/courses/:id/enroll', (req, res) => {
    const actor = current(req);
    const course = courseById(routeId(req.params.id));
    if (!course || !course.active) return res.status(404).json({ error: 'Kurs nicht gefunden.' });
    if (course.mandatory) return res.status(400).json({ error: 'Pflichtkurse werden zugewiesen. Du kannst dich dafür nicht selbst eintragen.' });
    if (actor.role === 'super_admin') return res.status(400).json({ error: 'Die Systemadministration nimmt nicht an Kursen teil.' });
    const id = db.transaction(() => createAssignment({ userId: actor.id, course, assignedBy: actor.id, source: 'self', dueDate: null, withTask: false }))();
    if (!id) return res.status(409).json({ error: 'Du bist für diesen Kurs bereits eingetragen.' });
    res.json({ id });
  });

  // --- Zuweisen -------------------------------------------------------------------------

  router.post('/learning/assignments', (req, res) => {
    const actor = current(req);
    const body = req.body || {};
    const assignees = resolveAssignees(actor, body);
    if (assignees.error) return res.status(assignees.status).json({ error: assignees.error });
    const course = courseById(routeId(body.courseId));
    if (!course || !course.active) return res.status(400).json({ error: 'Bitte wähle einen aktiven Kurs.' });
    const dueDate = readDate(body.dueDate);
    if (dueDate === INVALID) return res.status(400).json({ error: 'Die Frist ist kein gültiges Datum.' });
    if (dueDate && dueDate < todayIso()) return res.status(400).json({ error: 'Die Frist darf nicht in der Vergangenheit liegen.' });
    const source = isHr(actor) ? 'hr' : 'manager';
    const createdIds = db.transaction(() => assignees.userIds
      .map(userId => createAssignment({ userId, course, assignedBy: actor.id, source, dueDate }))
      .filter(Boolean))();
    res.json({ created: createdIds.length, alreadyOpen: assignees.userIds.length - createdIds.length, ids: createdIds });
  });

  router.post('/learning/assignments/:id/start', (req, res) => {
    const actor = current(req);
    const assignment = assignmentById(routeId(req.params.id));
    if (!assignment) return res.status(404).json({ error: 'Zuweisung nicht gefunden.' });
    if (assignment.user_id !== actor.id) return res.status(403).json({ error: 'Nur die zugewiesene Person kann den Kurs beginnen.' });
    if (assignment.status !== 'assigned') return res.status(409).json({ error: 'Dieser Kurs wurde bereits begonnen.' });
    const now = nowIso();
    db.prepare("UPDATE learning_assignments SET status='started', started_at=?, updated_at=? WHERE id=?").run(now, now, assignment.id);
    log(actor.id, 'learning_assignment_started', 'learning_assignments', assignment.id, { status: 'assigned' }, { status: 'started' });
    res.json({ ok: true });
  });

  router.post('/learning/assignments/:id/complete', (req, res) => {
    const actor = current(req);
    const body = req.body || {};
    const assignment = assignmentById(routeId(req.params.id));
    if (!assignment) return res.status(404).json({ error: 'Zuweisung nicht gefunden.' });
    const isOwner = assignment.user_id === actor.id;
    if (!isOwner && !(isHr(actor) && hrCanAccess(actor, assignment.user_id))) return res.status(403).json({ error: 'Nur die zugewiesene Person oder HR kann den Abschluss melden.' });
    if (!OPEN_STATUSES.includes(assignment.status)) return res.status(409).json({ error: 'Dieser Kurs ist bereits abgeschlossen.' });
    if (assignment.confirmation_pending) return res.status(409).json({ error: 'Dieser Abschluss wartet bereits auf die Bestätigung.' });
    const completedAt = readDate(body.completedAt) ?? todayIso();
    if (completedAt === INVALID) return res.status(400).json({ error: 'Das Abschlussdatum ist kein gültiges Datum.' });
    if (completedAt > todayIso()) return res.status(400).json({ error: 'Das Abschlussdatum darf nicht in der Zukunft liegen.' });
    const proof = cleanText(body.proof, MAX_PROOF_LENGTH);
    const course = courseById(assignment.course_id);

    // HR erfasst für andere (etwa nach einer Präsenzschulung); das gilt zugleich als Bestätigung.
    if (!isOwner) {
      finishAssignment({ assignment, course, actorId: actor.id, completedAt, proof, confirmedBy: actor.id });
      return res.json({ status: 'completed', confirmationPending: false });
    }
    const needsConfirmation = course.mandatory && course.requires_confirmation;
    const recipients = needsConfirmation ? confirmationRecipients(assignment) : [];
    if (needsConfirmation && recipients.length) {
      requestConfirmation({ assignment, course, actor, completedAt, proof, recipients });
      return res.json({ status: 'started', confirmationPending: true });
    }
    finishAssignment({ assignment, course, actorId: actor.id, completedAt, proof, confirmedBy: null });
    res.json({ status: 'completed', confirmationPending: false });
  });

  router.post('/learning/assignments/:id/confirm', (req, res) => {
    const actor = current(req);
    const body = req.body || {};
    const assignment = assignmentById(routeId(req.params.id));
    if (!assignment) return res.status(404).json({ error: 'Zuweisung nicht gefunden.' });
    if (!canConfirm(actor, assignment)) return res.status(403).json({ error: 'Nur die direkte Führungskraft oder HR darf diesen Abschluss bestätigen.' });
    if (!assignment.confirmation_pending) return res.status(409).json({ error: 'Dieser Abschluss wartet nicht auf eine Bestätigung.' });
    if (typeof body.approved !== 'boolean') return res.status(400).json({ error: 'Bitte gib an, ob du den Abschluss bestätigst.' });
    if (body.approved) {
      finishAssignment({
        assignment,
        course: courseById(assignment.course_id),
        actorId: actor.id,
        completedAt: assignment.reported_completion_date,
        proof: assignment.proof_text,
        confirmedBy: actor.id
      });
      return res.json({ status: 'completed' });
    }
    const note = cleanText(body.comment, MAX_PROOF_LENGTH);
    if (!note) return res.status(400).json({ error: 'Bitte schreibe kurz, warum du den Abschluss nicht bestätigst.' });
    db.transaction(() => {
      db.prepare(`
        UPDATE learning_assignments
        SET confirmation_pending=0, reported_completion_date=NULL, confirmation_note=?, updated_at=?
        WHERE id=?
      `).run(note, nowIso(), assignment.id);
      db.prepare("UPDATE tasks SET done=1 WHERE type='learning_confirmation' AND entity_id=? AND done=0").run(assignment.id);
      db.prepare('UPDATE tasks SET done=0 WHERE type=? AND entity_id=?').run(assignment.overdue_reminded ? 'learning_overdue' : 'learning_assignment', assignment.id);
      log(actor.id, 'learning_completion_rejected', 'learning_assignments', assignment.id, { confirmationPending: true }, { confirmationPending: false });
    })();
    res.json({ status: 'started' });
  });

  // --- Sichten --------------------------------------------------------------------------

  router.get('/learning/my', (req, res) => {
    const actor = current(req);
    const assignments = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.user_id=?`).all(actor.id).map(row => publicAssignment(row));
    const openCourseIds = new Set(assignments.filter(item => OPEN_STATUSES.includes(item.status)).map(item => item.courseId));
    const catalog = db.prepare('SELECT * FROM learning_courses WHERE active=1 ORDER BY title').all().map(course => ({
      ...publicCourse(course),
      alreadyOpen: openCourseIds.has(course.id),
      canEnroll: !course.mandatory && !openCourseIds.has(course.id)
    }));
    const isOpen = item => OPEN_STATUSES.includes(item.status);
    const latestFirst = (first, second) => String(second.completedAt).localeCompare(String(first.completedAt));
    res.json({
      open: assignments.filter(item => isOpen(item) && !item.overdue).sort(byDueDateThenTitle),
      overdue: assignments.filter(item => item.overdue).sort(byDueDateThenTitle),
      completed: assignments.filter(item => !isOpen(item)).sort(latestFirst),
      catalog
    });
  });

  router.get('/learning/team', (req, res) => {
    const actor = current(req);
    if (!isHr(actor) && !isLeader(actor)) return res.status(403).json({ error: 'Diese Sicht ist HR und Führungskräften vorbehalten.' });
    const visibleIds = new Set(isHr(actor) ? peopleVisibleToHr(actor).map(person => person.id) : subordinateIds(actor));
    const rows = db.prepare(ASSIGNMENT_SELECT).all().filter(row => visibleIds.has(row.user_id));
    const people = activePersons()
      .filter(person => visibleIds.has(person.id))
      .map(person => {
        const own = rows.filter(row => row.user_id === person.id);
        const assignments = own
          .map(row => ({ ...publicAssignment(row, { includeProof: canConfirm(actor, row) }), canConfirm: canConfirm(actor, row) && Boolean(row.confirmation_pending) }))
          .sort(byDueDateThenTitle);
        return {
          id: person.id,
          name: person.name,
          title: person.title || '',
          open: assignments.filter(item => OPEN_STATUSES.includes(item.status) && !item.overdue).length,
          overdue: assignments.filter(item => item.overdue).length,
          completed: assignments.filter(item => item.status === 'completed').length,
          expired: assignments.filter(item => item.status === 'expired').length,
          assignments
        };
      })
      .sort((first, second) => first.name.localeCompare(second.name, 'de'));
    res.json({ people, pendingConfirmations: people.flatMap(person => person.assignments.filter(item => item.canConfirm)) });
  });

  /**
   * Stand je Person und Pflichtkurs. Eine Person erfüllt den Kurs, solange ein Abschluss gilt,
   * auch wenn die Rezertifizierung schon offen ist.
   */
  function complianceEntries(actor) {
    const today = todayIso();
    // Auch Quoten zählen nur, wen die Person sehen darf. Sonst ließe sich aus ihnen auf andere schließen.
    const visibleIds = new Set(peopleVisibleToHr(actor).map(person => person.id));
    const rows = db.prepare(`${ASSIGNMENT_SELECT}
      WHERE c.mandatory=1 AND c.active=1 AND u.is_system_account=0 AND u.active=1`).all().filter(row => visibleIds.has(row.user_id));
    const emails = new Map(db.prepare('SELECT id, email FROM users').all().map(user => [user.id, user.email]));
    const byPersonAndCourse = new Map();
    for (const row of rows) {
      const key = `${row.user_id}:${row.course_id}`;
      if (!byPersonAndCourse.has(key)) byPersonAndCourse.set(key, []);
      byPersonAndCourse.get(key).push(row);
    }
    return [...byPersonAndCourse.values()].map(history => {
      const latest = history.reduce((newest, row) => (row.id > newest.id ? row : newest));
      const validCompletions = history
        .filter(row => row.status === 'completed' && (!row.expires_at || row.expires_at >= today))
        .sort((first, second) => second.completed_at.localeCompare(first.completed_at));
      const completion = validCompletions[0] || null;
      const shown = completion || latest;
      return {
        userId: latest.user_id,
        userName: latest.user_name,
        email: emails.get(latest.user_id) || '',
        courseId: latest.course_id,
        courseTitle: latest.course_title,
        fulfilled: Boolean(completion),
        overdue: !completion && isOverdue(latest, today),
        confirmationPending: !completion && Boolean(latest.confirmation_pending),
        statusLabel: STATUS_LABELS[shown.status],
        dueDate: latest.due_date,
        completedAt: completion?.completed_at || null,
        expiresAt: completion?.expires_at || null,
        proofText: completion?.proof_text || ''
      };
    });
  }

  function complianceSummary(entries) {
    const required = entries.length;
    const fulfilled = entries.filter(entry => entry.fulfilled).length;
    return { required, fulfilled, overdue: entries.filter(entry => entry.overdue).length, ratePercent: percentOf(fulfilled, required) };
  }

  router.get('/learning/report', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Die Erfüllungsquoten sind HR vorbehalten.' });
    const entries = complianceEntries(actor);
    const courses = db.prepare('SELECT id, title FROM learning_courses WHERE mandatory=1 AND active=1 ORDER BY title').all()
      .map(course => ({ courseId: course.id, title: course.title, ...complianceSummary(entries.filter(entry => entry.courseId === course.id)) }));
    const peopleById = new Map(entries.map(entry => [entry.userId, entry.userName]));
    const people = [...peopleById.entries()]
      .map(([userId, name]) => ({ userId, name, ...complianceSummary(entries.filter(entry => entry.userId === userId)) }))
      .sort((first, second) => first.name.localeCompare(second.name, 'de'));
    res.json({ overall: complianceSummary(entries), courses, people });
  });

  router.get('/learning/report/export.csv', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Der Export ist HR vorbehalten.' });
    const entries = complianceEntries(actor).sort((first, second) => (
      first.userName.localeCompare(second.userName, 'de') || first.courseTitle.localeCompare(second.courseTitle, 'de')
    ));
    const header = ['Person', 'E-Mail', 'Pflichtkurs', 'Status', 'Erfüllt', 'Frist', 'Abschluss', 'Gültig bis', 'Nachweis'];
    const lines = entries.map(entry => [
      entry.userName,
      entry.email,
      entry.courseTitle,
      entry.confirmationPending ? 'Wartet auf Bestätigung' : entry.overdue ? 'Überfällig' : entry.statusLabel,
      entry.fulfilled ? 'Ja' : 'Nein',
      entry.dueDate,
      entry.completedAt,
      entry.expiresAt,
      entry.proofText
    ]);
    const csv = [header, ...lines].map(fields => fields.map(csvField).join(';')).join('\r\n');
    log(actor.id, 'learning_report_exported', 'learning_assignments', null, null, { rows: lines.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pflichtschulungen.csv"');
    res.send(Buffer.from(`﻿${csv}\r\n`, 'utf8'));
  });

  // --- Wartung --------------------------------------------------------------------------

  function remindOverdue(today) {
    const overdue = db.prepare(`
      SELECT a.id, a.user_id, a.due_date, c.title AS course_title, u.name AS user_name, u.manager_id
      FROM learning_assignments a
      JOIN learning_courses c ON c.id = a.course_id
      JOIN users u ON u.id = a.user_id
      WHERE a.status IN ('assigned','started') AND a.confirmation_pending=0 AND a.overdue_reminded=0
        AND a.due_date IS NOT NULL AND a.due_date < ? AND c.active=1 AND u.is_system_account=0 AND u.active=1
    `).all(today);
    for (const item of overdue) {
      db.prepare('UPDATE learning_assignments SET overdue_reminded=1, updated_at=? WHERE id=?').run(nowIso(), item.id);
      // Die Aufgabe „abschließen“ steht schon offen. Der Hinweis „überfällig“ ersetzt sie, zwei für denselben Kurs wären doppelt.
      db.prepare("UPDATE tasks SET done=1 WHERE type='learning_assignment' AND entity_id=? AND done=0").run(item.id);
      createTask(item.user_id, `Überfällig: Schulung „${item.course_title}“ abschließen`, 'learning_overdue', item.id, item.due_date);
      const manager = item.manager_id
        ? db.prepare('SELECT id, role FROM users WHERE id=? AND is_system_account=0 AND active=1').get(item.manager_id)
        : null;
      if (followsUpOnTeam(manager)) createTask(manager.id, `Überfällige Schulung: ${cleanText(item.user_name, 120)} – „${item.course_title}“`, 'learning_overdue', item.id, item.due_date);
    }
    return overdue.length;
  }

  /** Wer nicht mehr da ist, schließt keinen Kurs mehr ab. Hinweise und Bestätigungen an andere sind dann hinfällig. */
  function closeTasksOfInactivePeople() {
    const obsolete = db.prepare(`
      SELECT t.id
      FROM tasks t
      JOIN learning_assignments a ON a.id = t.entity_id
      JOIN users u ON u.id = a.user_id
      WHERE t.type IN ('learning_overdue','learning_confirmation') AND t.done = 0 AND u.active = 0 AND t.user_id <> a.user_id
    `).all();
    for (const { id } of obsolete) db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(id);
  }

  /** 30 Tage vor Ablauf einer Pflichtschulung entsteht genau eine neue Zuweisung. */
  function createRecertifications(today) {
    const expiring = db.prepare(`
      SELECT a.id, a.user_id, a.course_id, a.expires_at
      FROM learning_assignments a
      JOIN learning_courses c ON c.id = a.course_id
      JOIN users u ON u.id = a.user_id
      WHERE a.status='completed' AND a.recertification_id IS NULL AND a.expires_at IS NOT NULL AND a.expires_at <= ?
        AND c.mandatory=1 AND c.active=1 AND u.is_system_account=0 AND u.active=1
    `).all(addDays(today, RECERTIFICATION_LEAD_DAYS));
    let created = 0;
    for (const item of expiring) {
      const successor = db.prepare(`
        SELECT id FROM learning_assignments
        WHERE user_id=? AND course_id=? AND id<>? AND (status IN ('assigned','started') OR (status='completed' AND (expires_at IS NULL OR expires_at > ?)))
        ORDER BY id DESC LIMIT 1
      `).get(item.user_id, item.course_id, item.id, item.expires_at);
      let recertificationId = successor?.id;
      if (!recertificationId) {
        const dueDate = item.expires_at >= today ? item.expires_at : addDays(today, RECERTIFICATION_LEAD_DAYS);
        recertificationId = createAssignment({ userId: item.user_id, course: courseById(item.course_id), assignedBy: null, source: 'recertification', dueDate });
        created += 1;
      }
      db.prepare('UPDATE learning_assignments SET recertification_id=?, updated_at=? WHERE id=?').run(recertificationId, nowIso(), item.id);
    }
    return created;
  }

  function markExpired(today) {
    const expired = db.prepare("SELECT id FROM learning_assignments WHERE status='completed' AND expires_at IS NOT NULL AND expires_at < ?").all(today);
    for (const item of expired) {
      db.prepare("UPDATE learning_assignments SET status='expired', updated_at=? WHERE id=?").run(nowIso(), item.id);
      log(null, 'learning_assignment_expired', 'learning_assignments', item.id, { status: 'completed' }, { status: 'expired' });
    }
    return expired.length;
  }

  const maintenance = db.transaction(() => {
    const today = todayIso();
    closeTasksOfInactivePeople();
    const overdueReminded = remindOverdue(today);
    const recertifications = createRecertifications(today);
    const expired = markExpired(today);
    return { overdueReminded, recertifications, expired };
  });

  // --- Beispieldaten --------------------------------------------------------------------

  function seedDemo() {
    const persons = activePersons();
    if (!persons.length) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM learning_courses').get().count) return;
    const admin = persons.find(person => person.role === 'hr_admin') || persons[0];
    const [safety, dataHandling] = DEMO_COURSES.map(course => courseById(insertCourse({
      linkUrl: null,
      mandatory: 0,
      requiresConfirmation: 0,
      validityMonths: null,
      competencyId: null,
      active: 1,
      ...course
    }, admin.id)));

    const today = todayIso();
    const seedAssignments = db.transaction(() => {
      for (const person of persons) createAssignment({ userId: person.id, course: safety, assignedBy: admin.id, source: 'hr', dueDate: addDays(today, 30) });
      const employees = persons.filter(person => person.role === 'employee');
      const [finished, overdue] = employees;
      if (finished) {
        const id = createAssignment({ userId: finished.id, course: dataHandling, assignedBy: admin.id, source: 'hr', dueDate: addDays(today, 14) });
        const completedAt = addDays(today, -20);
        db.prepare("UPDATE learning_assignments SET status='completed', completed_at=?, proof_text=?, expires_at=?, confirmed_by=? WHERE id=?")
          .run(completedAt, 'Teilnahmebescheinigung liegt vor.', addMonths(completedAt, 24), admin.id, id);
        closeAssignmentTasks(id);
      }
      if (overdue) {
        const id = createAssignment({ userId: overdue.id, course: dataHandling, assignedBy: admin.id, source: 'hr', dueDate: today });
        db.prepare('UPDATE learning_assignments SET due_date=? WHERE id=?').run(addDays(today, -7), id);
      }
    });
    seedAssignments();
    maintenance();
  }

  const helpArticles = [
    {
      id: 'learning-my-courses',
      title: 'Meine Kurse und Pflichtschulungen',
      roles: ['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin'],
      views: ['learningHome'],
      keywords: ['kurs', 'schulung', 'pflichtschulung', 'lernen', 'weiterbildung', 'abschluss melden', 'nachweis', 'überfällig'],
      answer: 'Unter „Lernen“ siehst du offene und überfällige Kurse, deine Abschlüsse und den Katalog. Für freiwillige Kurse trägst du dich selbst ein. Den Abschluss meldest du selbst, optional mit einem Nachweis als Text. Bei manchen Pflichtkursen muss deine Führungskraft oder HR ihn bestätigen. Dateien lädst du hier nicht hoch.',
      steps: ['Öffne „Lernen“.', 'Wähle bei einem Kurs „Beginnen“ oder trage dich im Katalog ein.', 'Melde danach den Abschluss. Die Aufgabe auf der Übersicht verschwindet, sobald der Kurs abgeschlossen ist.'],
      actions: [{ label: 'Meine Kurse öffnen', view: 'learningHome' }]
    },
    {
      id: 'learning-team',
      title: 'Schulungen im Team zuweisen und prüfen',
      roles: ['manager', 'director', 'hr_admin', 'hrbp', 'super_admin'],
      views: ['learningTeam'],
      keywords: ['schulung zuweisen', 'kurs zuweisen', 'team schulung', 'abschluss bestätigen', 'führungslinie lernen', 'mein team lernen'],
      answer: 'Führungskräfte sehen den Lernstand aller, die sie direkt oder indirekt führen, und können direkt unterstellten Personen Kurse zuweisen. HR kann einzelnen Personen, ganzen Rollen oder allen zuweisen. Wer schon eine offene Zuweisung für den Kurs hat, bekommt keine zweite. Abschlüsse, die bestätigt werden müssen, erscheinen als Aufgabe bei der direkten Führungskraft.',
      steps: ['Öffne „Lernen“ und den Reiter „Mein Team“.', 'Wähle „+ Kurs zuweisen“.', 'Bestätige wartende Abschlüsse oben auf derselben Seite.'],
      actions: [{ label: 'Mein Team öffnen', view: 'learningTeam' }]
    },
    {
      id: 'learning-compliance',
      title: 'Kurskatalog und Erfüllungsquoten',
      roles: ['hr_admin', 'hrbp', 'super_admin'],
      views: ['learningCourses', 'learningReport'],
      keywords: ['kurskatalog', 'erfüllungsquote', 'pflichtkurs', 'rezertifizierung', 'erneuerung', 'gültigkeit', 'export', 'csv'],
      answer: 'HR pflegt den Kurskatalog und legt bei Pflichtkursen fest, wie lange ein Abschluss gilt und ob er bestätigt werden muss. 30 Tage vor Ablauf einer Pflichtschulung weist Daybreak sie automatisch neu zu. Die Erfüllungsquote zeigt je Pflichtkurs und je Person, wie viele Zuweisungen mit einem gültigen Abschluss erfüllt sind. Der Export ist eine CSV-Datei für Tabellenprogramme.',
      steps: ['Lege Kurse unter „Kurse“ an.', 'Weise sie über „+ Kurs zuweisen“ zu.', 'Prüfe den Stand unter „Erfüllung“ und lade bei Bedarf die CSV-Datei herunter.'],
      actions: [{ label: 'Erfüllung öffnen', view: 'learningReport' }]
    }
  ];

  return { router, initialize, seedDemo, maintenance, helpArticles };
}

module.exports = { createLearningModule };
