'use strict';

/**
 * Recruiting: Stellenanforderungen, Bewerbende, Bewerbungen mit Stufen, Gespräche mit unabhängiger
 * Bewertung, Angebote mit Vier-Augen-Freigabe, Einstellung, interne Stellenbörse, Anonymisierung.
 *
 * Rechte entscheidet ausschließlich dieser Server:
 * - HR sieht alles, die einstellende Führungskraft nur eigene Stellen und deren Bewerbungen.
 * - Interview-Beteiligte sehen nur zugewiesene Bewerbungen und davon nur das Nötigste.
 * - Wer sich selbst auf eine Stelle bewirbt, ist dort nur noch bewerbende Person, auch wenn er
 *   zu HR gehört. So sieht niemand die eigenen Bewertungen oder die seiner Mitbewerbenden.
 * - Wer selbst noch bewerten soll, sieht vorher keine fremde Bewertung zu dieser Bewerbung, auch
 *   nicht als HR oder einstellende Führungskraft.
 * - Stufen und Aufbewahrungsfrist gelten für die ganze Organisation und ändert nur die HR-Administration.
 * - Die HR-Sachbearbeitung (hr_staff) ist hier eine normale Person.
 *
 * Namen und Kontaktdaten von Bewerbenden gehören nicht ins Protokoll. Aufgabentitel nennen den Namen,
 * damit klar ist, worum es geht; die Anonymisierung überschreibt diese Titel. Daybreak versendet keine
 * E-Mails: Absagetexte werden nur zum Kopieren erzeugt.
 */

const express = require('express');
const { ensureColumn } = require('../lib/core-helpers');
const { findStartableTemplate, startJourney } = require('./onboarding');

const REQUISITION_STATUSES = Object.freeze(['draft', 'pending_approval', 'open', 'paused', 'filled', 'cancelled']);
const CLOSED_REQUISITION_STATUSES = Object.freeze(['filled', 'cancelled']);
const HIRING_ALLOWED_STATUSES = Object.freeze(['open', 'paused']);
const HIRING_MANAGER_ROLES = Object.freeze(['manager', 'director', 'hr_admin', 'hrbp']);
const LEADERSHIP_ROLES = Object.freeze(['manager', 'director']);
const INACTIVE_OFFER_STATUSES = Object.freeze(['declined', 'withdrawn']);
const OPEN_OFFER_STATUSES = Object.freeze(['draft', 'pending_approval', 'approved']);

const ALL_ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
const LEAD_AND_HR_ROLES = Object.freeze(['manager', 'director', 'hr_admin', 'hrbp', 'super_admin']);
const HR_ROLES = Object.freeze(['hr_admin', 'hrbp', 'super_admin']);
const ORGANIZATION_SETTINGS_ROLES = Object.freeze(['hr_admin', 'super_admin']);

// Mit welcher Rolle jemand eingestellt werden kann. HR-Rollen vergibt wie überall nur die HR-Administration.
const HIRE_ROLES = Object.freeze({
  employee: 'Mitarbeiter:in',
  manager: 'Führungskraft',
  director: 'Bereichsleitung'
});
const HR_HIRE_ROLES = Object.freeze({
  hr_staff: 'HR-Sachbearbeitung',
  hrbp: 'HR Business Partner',
  hr_admin: 'HR-Administration'
});
const DEFAULT_HIRE_ROLE = 'employee';

const DEFAULT_STAGES = Object.freeze([
  { name: 'Eingang', kind: 'normal' },
  { name: 'Vorauswahl', kind: 'normal' },
  { name: 'Gespräch', kind: 'normal' },
  { name: 'Angebot', kind: 'normal' },
  { name: 'Eingestellt', kind: 'hired' }
]);

// Interne Kategorien. Sie erscheinen bewusst nie im Absagetext.
const REJECTION_REASONS = Object.freeze({
  qualification: 'Qualifikation passt nicht',
  experience: 'Erfahrung passt nicht',
  better_fit: 'Andere Person passt besser',
  conditions: 'Rahmenbedingungen passen nicht',
  availability: 'Verfügbarkeit passt nicht',
  candidate_withdrew: 'Von der Person zurückgezogen',
  position_closed: 'Stelle entfällt',
  other: 'Sonstiges'
});

const CANDIDATE_SOURCES = Object.freeze(['Stellenportal', 'Eigene Website', 'Empfehlung', 'Initiativbewerbung', 'Personalvermittlung', 'Messe', 'Intern', 'Sonstiges']);

const RECOMMENDATIONS = Object.freeze({
  hire: 'Einstellen',
  continue: 'Weiter prüfen',
  reject: 'Nicht einstellen'
});

const TASK = Object.freeze({
  requisitionApproval: 'recruiting_approval',
  requisitionAssigned: 'recruiting_requisition_assigned',
  requisitionReturned: 'recruiting_requisition_returned',
  feedback: 'recruiting_feedback',
  offerApproval: 'recruiting_offer_approval',
  offerReturned: 'recruiting_offer_returned',
  offerResponse: 'recruiting_offer_response',
  hire: 'recruiting_hire_decision',
  internalApplication: 'recruiting_internal_application'
});
const APPLICATION_TASK_TYPES = Object.freeze([
  TASK.offerApproval,
  TASK.offerReturned,
  TASK.offerResponse,
  TASK.hire,
  TASK.internalApplication
]);
const ANONYMIZED_TASK_TITLE = 'Aufgabe zu einer anonymisierten Bewerbung';

const REQUISITION_TRANSITIONS = Object.freeze({
  submit: { from: ['draft'], to: 'pending_approval', hrOnly: false, action: 'recruiting_requisition_submitted' },
  approve: { from: ['pending_approval'], to: 'open', hrOnly: true, action: 'recruiting_requisition_approved' },
  return: { from: ['pending_approval'], to: 'draft', hrOnly: true, action: 'recruiting_requisition_returned' },
  pause: { from: ['open'], to: 'paused', hrOnly: false, action: 'recruiting_requisition_paused' },
  resume: { from: ['paused'], to: 'open', hrOnly: false, action: 'recruiting_requisition_resumed' },
  cancel: { from: ['draft', 'pending_approval', 'open', 'paused'], to: 'cancelled', hrOnly: false, action: 'recruiting_requisition_cancelled' },
  fill: { from: ['open', 'paused'], to: 'filled', hrOnly: true, action: 'recruiting_requisition_filled' }
});

const CONFLICT_MESSAGE = 'Du hast dich auf eine Stelle beworben, auf die sich auch diese Person beworben hat. Das muss deshalb eine andere HR-Person erledigen.';
const WITHDRAWN_REASON = 'candidate_withdrew';
const ANONYMIZED_NAME = 'Anonymisierte Person';
const DEFAULT_RETENTION_MONTHS = 6;
// Abgelehnte können sich noch Monate nach der Absage beschweren. Die Anonymisierung lässt sich nicht zurückholen.
const MIN_RETENTION_MONTHS = 3;
const MAX_RETENTION_MONTHS = 120;
const MAX_OPENINGS = 500;
const MAX_INTERVIEW_PARTICIPANTS = 20;
const MAX_ID = Number.MAX_SAFE_INTEGER;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = 'Europe/Berlin';

const localMinuteFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
});

/** Gesprächstermine sind Ortszeit als Text, deshalb wird „jetzt“ genauso geschrieben. */
function localNowMinute() {
  const parts = Object.fromEntries(localMinuteFormat.formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const nowIso = () => new Date().toISOString();
const bodyOf = req => (req.body && typeof req.body === 'object' ? req.body : {});
const placeholders = count => Array.from({ length: count }, () => '?').join(',');

function fail(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  return error;
}

/** Prüft auf ein echtes Kalenderdatum. Das reine Format würde auch den 31. Februar durchlassen. */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Gesprächstermine bleiben Ortszeit als Text („2026-11-20T10:00“) und werden nicht umgerechnet. */
function normalizeDateTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59) return null;
  return `${match[1]}T${match[2]}:${match[3]}`;
}

function germanDate(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

function germanDateTime(localDateTime) {
  return `${germanDate(localDateTime)}, ${localDateTime.slice(11, 16)} Uhr`;
}

/** Zieht Monate ab, ohne über das Monatsende hinauszulaufen (31.08. minus 6 Monate wird 28.02.). */
function monthsBefore(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function addDaysToToday(days) {
  return new Date(Date.now() + days * DAY_IN_MS).toISOString().slice(0, 10);
}

function createRecruitingModule(deps) {
  const {
    db, auth, current, isHr, subordinateIds, cleanText, boundedInt, log,
    createTask, createUserAccount, isModuleEnabled, approvalRule, tenant, recordEntryDate
  } = deps;
  const router = express.Router();

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recruiting_requisitions (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        position_profile_id INTEGER REFERENCES position_profiles(id),
        openings INTEGER NOT NULL DEFAULT 1 CHECK(openings >= 1),
        hiring_manager_id INTEGER NOT NULL REFERENCES users(id),
        description TEXT,
        target_date TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','open','paused','filled','cancelled')),
        internal_posting INTEGER NOT NULL DEFAULT 0,
        return_comment TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id),
        approved_by INTEGER REFERENCES users(id),
        opened_at TEXT,
        filled_at TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruiting_candidates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        source TEXT,
        talent_pool_consent INTEGER NOT NULL DEFAULT 0,
        talent_pool_consent_date TEXT,
        notes TEXT,
        resume_text TEXT,
        resume_url TEXT,
        user_id INTEGER REFERENCES users(id),
        anonymized_at TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruiting_stages (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'normal' CHECK(kind IN ('normal','hired')),
        sort_order INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruiting_applications (
        id INTEGER PRIMARY KEY,
        requisition_id INTEGER NOT NULL REFERENCES recruiting_requisitions(id),
        candidate_id INTEGER NOT NULL REFERENCES recruiting_candidates(id),
        stage_id INTEGER NOT NULL REFERENCES recruiting_stages(id),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rejected','hired')),
        message TEXT,
        rejection_reason TEXT,
        rejection_note TEXT,
        rejected_at TEXT,
        rejected_by INTEGER REFERENCES users(id),
        hired_at TEXT,
        hired_by INTEGER REFERENCES users(id),
        hired_user_id INTEGER REFERENCES users(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(requisition_id, candidate_id)
      );
      CREATE TABLE IF NOT EXISTS recruiting_application_history (
        id INTEGER PRIMARY KEY,
        application_id INTEGER NOT NULL REFERENCES recruiting_applications(id),
        from_stage_id INTEGER REFERENCES recruiting_stages(id),
        to_stage_id INTEGER REFERENCES recruiting_stages(id),
        from_status TEXT,
        to_status TEXT NOT NULL,
        changed_by INTEGER REFERENCES users(id),
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruiting_interviews (
        id INTEGER PRIMARY KEY,
        application_id INTEGER NOT NULL REFERENCES recruiting_applications(id),
        scheduled_at TEXT NOT NULL,
        location TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','cancelled')),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruiting_interview_participants (
        interview_id INTEGER NOT NULL REFERENCES recruiting_interviews(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY(interview_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS recruiting_feedback (
        id INTEGER PRIMARY KEY,
        interview_id INTEGER NOT NULL REFERENCES recruiting_interviews(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        strengths TEXT,
        concerns TEXT,
        recommendation TEXT NOT NULL CHECK(recommendation IN ('hire','continue','reject')),
        submitted_at TEXT NOT NULL,
        UNIQUE(interview_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS recruiting_offers (
        id INTEGER PRIMARY KEY,
        application_id INTEGER NOT NULL REFERENCES recruiting_applications(id),
        start_date TEXT NOT NULL,
        position_title TEXT NOT NULL,
        compensation TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','accepted','declined','withdrawn')),
        return_comment TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id),
        last_edited_by INTEGER NOT NULL REFERENCES users(id),
        approved_by INTEGER REFERENCES users(id),
        approved_at TEXT,
        responded_by INTEGER REFERENCES users(id),
        responded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruiting_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        retention_months INTEGER NOT NULL,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recruiting_requisitions_manager ON recruiting_requisitions(hiring_manager_id, status);
      CREATE INDEX IF NOT EXISTS idx_recruiting_candidates_email ON recruiting_candidates(email);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiting_candidates_user ON recruiting_candidates(user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_recruiting_applications_candidate ON recruiting_applications(candidate_id, status);
      CREATE INDEX IF NOT EXISTS idx_recruiting_history_application ON recruiting_application_history(application_id);
      CREATE INDEX IF NOT EXISTS idx_recruiting_interviews_application ON recruiting_interviews(application_id);
      CREATE INDEX IF NOT EXISTS idx_recruiting_participants_user ON recruiting_interview_participants(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiting_one_open_offer ON recruiting_offers(application_id) WHERE status NOT IN ('declined','withdrawn');
    `);
    ensureColumn(db, 'recruiting_offers', 'approval_skipped', 'INTEGER NOT NULL DEFAULT 0');
    const timestamp = nowIso();
    if (db.prepare('SELECT COUNT(*) AS count FROM recruiting_stages').get().count === 0) {
      const insertStage = db.prepare('INSERT INTO recruiting_stages(name,kind,sort_order,created_at) VALUES(?,?,?,?)');
      DEFAULT_STAGES.forEach((stage, index) => insertStage.run(stage.name, stage.kind, index + 1, timestamp));
    }
    db.prepare('INSERT INTO recruiting_settings(id,retention_months,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING')
      .run(DEFAULT_RETENTION_MONTHS, timestamp);
  }

  const idFrom = value => boundedInt(value, 1, MAX_ID, null);
  // Ältere Einstellungen können unter der Untergrenze liegen. Sie gelten dann mit der Untergrenze.
  const retentionMonths = () => Math.max(
    db.prepare('SELECT retention_months FROM recruiting_settings WHERE id=1').get().retention_months,
    MIN_RETENTION_MONTHS
  );

  function hrRecipientIds() {
    return db.prepare("SELECT id FROM users WHERE role IN ('hr_admin','hrbp') AND is_system_account=0 AND active=1 ORDER BY id")
      .all()
      .map(row => row.id);
  }

  function closeTasks(type, entityId, userId = null) {
    if (userId === null) {
      db.prepare('UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND done=0').run(type, entityId);
    } else {
      db.prepare('UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND user_id=? AND done=0').run(type, entityId, userId);
    }
  }

  // --- Laden und Rechte -------------------------------------------------------------------

  function loadRequisition(value) {
    const id = idFrom(value);
    const requisition = id ? db.prepare(`
      SELECT r.*, m.name AS hiring_manager_name, p.title AS position_title
      FROM recruiting_requisitions r
      JOIN users m ON m.id = r.hiring_manager_id
      LEFT JOIN position_profiles p ON p.id = r.position_profile_id
      WHERE r.id=?
    `).get(id) : null;
    if (!requisition) throw fail(404, 'Stelle nicht gefunden.');
    return requisition;
  }

  function loadApplication(value) {
    const id = idFrom(value);
    const application = id ? db.prepare(`
      SELECT a.*, r.title AS requisition_title, r.status AS requisition_status, r.hiring_manager_id,
             r.position_profile_id, r.openings, c.name AS candidate_name, c.email AS candidate_email,
             c.user_id AS candidate_user_id, c.anonymized_at AS candidate_anonymized_at, s.name AS stage_name
      FROM recruiting_applications a
      JOIN recruiting_requisitions r ON r.id = a.requisition_id
      JOIN recruiting_candidates c ON c.id = a.candidate_id
      JOIN recruiting_stages s ON s.id = a.stage_id
      WHERE a.id=?
    `).get(id) : null;
    if (!application) throw fail(404, 'Bewerbung nicht gefunden.');
    return application;
  }

  function loadCandidate(value) {
    const id = idFrom(value);
    const candidate = id ? db.prepare('SELECT * FROM recruiting_candidates WHERE id=?').get(id) : null;
    if (!candidate) throw fail(404, 'Bewerbende Person nicht gefunden.');
    return candidate;
  }

  function loadInterview(value) {
    const id = idFrom(value);
    const interview = id ? db.prepare('SELECT * FROM recruiting_interviews WHERE id=?').get(id) : null;
    if (!interview) throw fail(404, 'Gespräch nicht gefunden.');
    return interview;
  }

  function loadOffer(value) {
    const id = idFrom(value);
    const offer = id ? db.prepare('SELECT * FROM recruiting_offers WHERE id=?').get(id) : null;
    if (!offer) throw fail(404, 'Angebot nicht gefunden.');
    return offer;
  }

  function isCandidateOnRequisition(userId, requisitionId) {
    return Boolean(db.prepare(`
      SELECT a.id
      FROM recruiting_applications a
      JOIN recruiting_candidates c ON c.id = a.candidate_id
      WHERE a.requisition_id=? AND (c.user_id=? OR a.hired_user_id=?)
    `).get(requisitionId, userId, userId));
  }

  function isParticipant(interviewId, userId) {
    return Boolean(db.prepare('SELECT 1 AS found FROM recruiting_interview_participants WHERE interview_id=? AND user_id=?').get(interviewId, userId));
  }

  function isAssignedInterviewer(applicationId, userId) {
    return Boolean(db.prepare(`
      SELECT p.interview_id
      FROM recruiting_interview_participants p
      JOIN recruiting_interviews i ON i.id = p.interview_id
      WHERE i.application_id=? AND p.user_id=? AND i.status='planned'
    `).get(applicationId, userId));
  }

  /**
   * Alle, die sich auf eine noch laufende Stelle beworben haben, auf die sich auch diese Person beworben hat.
   * Ist die Stelle besetzt oder abgebrochen, ist der Wettbewerb vorbei. Sie selbst bleibt trotzdem gesperrt.
   */
  function rivalCandidateIds(userId) {
    return new Set(db.prepare(`
      SELECT DISTINCT rival.candidate_id
      FROM recruiting_applications own
      JOIN recruiting_candidates me ON me.id = own.candidate_id
      JOIN recruiting_requisitions r ON r.id = own.requisition_id
      JOIN recruiting_applications rival ON rival.requisition_id = own.requisition_id
      WHERE (me.user_id=? OR own.hired_user_id=?) AND rival.candidate_id <> own.candidate_id
        AND r.status NOT IN ('filled','cancelled')
    `).all(userId, userId).map(row => row.candidate_id));
  }

  /** Eigene Betroffenheit gilt auch dann, wenn dieselbe Person über eine andere Stelle erreichbar wäre. */
  const competesWith = (userId, candidateId) => rivalCandidateIds(userId).has(candidateId);

  /**
   * Die zentrale Rechteprüfung für alles, was an einer Bewerbung hängt:
   * 'self' (eigene Bewerbung), 'hr', 'manager', 'interviewer' oder null (kein Zugriff).
   */
  function applicationAccess(actor, application) {
    if (application.candidate_user_id === actor.id || application.hired_user_id === actor.id) return 'self';
    if (isCandidateOnRequisition(actor.id, application.requisition_id)) return null;
    if (isHr(actor) && !competesWith(actor.id, application.candidate_id)) return 'hr';
    if (application.hiring_manager_id === actor.id) return 'manager';
    if (application.status === 'active' && isAssignedInterviewer(application.id, actor.id)) return 'interviewer';
    return null;
  }

  function requireManagingAccess(actor, application) {
    const access = applicationAccess(actor, application);
    if (access !== 'hr' && access !== 'manager') throw fail(403, 'Du darfst diese Bewerbung nicht bearbeiten.');
    return access;
  }

  function requireRequisitionAccess(actor, requisition) {
    if (isCandidateOnRequisition(actor.id, requisition.id)) {
      throw fail(403, 'Du bewirbst dich selbst auf diese Stelle und kannst sie deshalb nicht bearbeiten.');
    }
    if (!isHr(actor) && requisition.hiring_manager_id !== actor.id) throw fail(403, 'Du darfst diese Stelle nicht sehen.');
  }

  function requireActiveApplication(application) {
    if (application.status !== 'active') throw fail(409, 'Diese Bewerbung ist bereits abgeschlossen.');
  }

  function canUseRecruiting(actor) {
    if (isHr(actor) || LEADERSHIP_ROLES.includes(actor.role)) return true;
    return Boolean(db.prepare('SELECT id FROM recruiting_requisitions WHERE hiring_manager_id=? LIMIT 1').get(actor.id));
  }

  function requireHr(actor, message) {
    if (!isHr(actor)) throw fail(403, message);
  }

  const managesOrganizationSettings = actor => ORGANIZATION_SETTINGS_ROLES.includes(actor.role);

  function requireOrganizationSettingsRights(actor) {
    if (!managesOrganizationSettings(actor)) {
      throw fail(403, 'Stufen und Aufbewahrungsfrist gelten für die ganze Organisation. Sie ändert nur die HR-Administration.');
    }
  }

  /** HR-Personen, die zu dieser Bewerbung Aufgaben bekommen können: nie selbst Bewerbende oder Mitbewerbende. */
  function uninvolvedHrIds(application) {
    return hrRecipientIds().filter(id => (
      !isCandidateOnRequisition(id, application.requisition_id) && !competesWith(id, application.candidate_id)
    ));
  }

  // --- Stufen -----------------------------------------------------------------------------

  const activeStages = () => db.prepare('SELECT * FROM recruiting_stages WHERE active=1 ORDER BY sort_order,id').all();
  const stageView = stage => ({ id: stage.id, name: stage.name, kind: stage.kind, sortOrder: stage.sort_order, active: Boolean(stage.active) });

  function firstStage() {
    const stage = activeStages().find(item => item.kind === 'normal');
    if (!stage) throw fail(409, 'Es ist keine Stufe aktiv. Bitte prüfe die Einstellungen.');
    return stage;
  }

  function hiredStage() {
    return db.prepare("SELECT * FROM recruiting_stages WHERE kind='hired' ORDER BY id LIMIT 1").get();
  }

  function loadStage(value) {
    const id = idFrom(value);
    const stage = id ? db.prepare('SELECT * FROM recruiting_stages WHERE id=?').get(id) : null;
    if (!stage) throw fail(404, 'Stufe nicht gefunden.');
    return stage;
  }

  function assertStageNameFree(name, ownId = 0) {
    const taken = db.prepare('SELECT id,name FROM recruiting_stages WHERE active=1 AND id<>?').all(ownId)
      .some(stage => stage.name.toLocaleLowerCase('de') === name.toLocaleLowerCase('de'));
    if (taken) throw fail(409, 'Eine aktive Stufe mit diesem Namen gibt es bereits.');
  }

  /** Nummeriert die Stufen neu. Die Stufe „Eingestellt“ bleibt immer am Ende. */
  function saveStageOrder(normalStages) {
    const update = db.prepare('UPDATE recruiting_stages SET sort_order=? WHERE id=?');
    normalStages.forEach((stage, index) => update.run(index + 1, stage.id));
    update.run(normalStages.length + 1, hiredStage().id);
  }

  // --- Verlauf und Abschlüsse -------------------------------------------------------------

  function addHistory({ applicationId, fromStageId = null, toStageId, fromStatus = null, toStatus, actorId, at = nowIso() }) {
    db.prepare(`
      INSERT INTO recruiting_application_history(application_id,from_stage_id,to_stage_id,from_status,to_status,changed_by,changed_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(applicationId, fromStageId, toStageId, fromStatus, toStatus, actorId, at);
  }

  /** Schließt alles, was an einer Bewerbung noch offen ist: Aufgaben und nicht abgeschlossene Angebote. */
  function closeOpenApplicationWork(applicationId) {
    for (const interview of db.prepare('SELECT id FROM recruiting_interviews WHERE application_id=?').all(applicationId)) {
      closeTasks(TASK.feedback, interview.id);
    }
    APPLICATION_TASK_TYPES.forEach(type => closeTasks(type, applicationId));
  }

  /** Aufgabentitel nennen die Person. Nach der Anonymisierung darf der Name dort nicht stehen bleiben. */
  function removeNameFromTasks(applicationId) {
    const rename = db.prepare('UPDATE tasks SET title=? WHERE type=? AND entity_id=?');
    for (const interview of db.prepare('SELECT id FROM recruiting_interviews WHERE application_id=?').all(applicationId)) {
      rename.run(ANONYMIZED_TASK_TITLE, TASK.feedback, interview.id);
    }
    APPLICATION_TASK_TYPES.forEach(type => rename.run(ANONYMIZED_TASK_TITLE, type, applicationId));
  }

  /** Ist die Stelle voll oder abgebrochen, lässt sich niemand mehr einstellen. Die Aufgabe dazu wäre eine Sackgasse. */
  function closeHireTasksOfRequisition(requisitionId) {
    for (const application of db.prepare('SELECT id FROM recruiting_applications WHERE requisition_id=?').all(requisitionId)) {
      closeTasks(TASK.hire, application.id);
    }
  }

  /** Wer sich bewirbt, verliert den Zugriff auf die Mitbewerbenden und damit auch die Aufgaben dazu. */
  function closeTasksOfNewApplicant(userId, requisitionId) {
    for (const application of db.prepare('SELECT id FROM recruiting_applications WHERE requisition_id=?').all(requisitionId)) {
      APPLICATION_TASK_TYPES.forEach(type => closeTasks(type, application.id, userId));
    }
  }

  function rejectApplication(application, { reason, note, actorId }) {
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(`
        UPDATE recruiting_applications
        SET status='rejected', rejection_reason=?, rejection_note=?, rejected_at=?, rejected_by=?, updated_at=?
        WHERE id=?
      `).run(reason, note, timestamp, actorId, timestamp, application.id);
      addHistory({
        applicationId: application.id,
        fromStageId: application.stage_id,
        toStageId: application.stage_id,
        fromStatus: 'active',
        toStatus: 'rejected',
        actorId,
        at: timestamp
      });
      db.prepare(`UPDATE recruiting_offers SET status='withdrawn', updated_at=? WHERE application_id=? AND status IN (${placeholders(OPEN_OFFER_STATUSES.length)})`)
        .run(timestamp, application.id, ...OPEN_OFFER_STATUSES);
      closeOpenApplicationWork(application.id);
      log(actorId, 'recruiting_application_rejected', 'recruiting_applications', application.id, { status: 'active' }, { status: 'rejected', reason });
    })();
  }

  /**
   * Entfernt alle personenbezogenen Angaben. Auch Freitexte in Bewertungen und Angeboten verschwinden,
   * weil sie Hinweise auf die Person enthalten können. Zahlen für Auswertungen bleiben erhalten.
   */
  function anonymizeCandidate(candidateId, actorId, trigger) {
    const timestamp = nowIso();
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE recruiting_candidates
        SET name=?, email=NULL, phone=NULL, notes=NULL, resume_text=NULL, resume_url=NULL, user_id=NULL,
            talent_pool_consent=0, talent_pool_consent_date=NULL, anonymized_at=?, updated_at=?
        WHERE id=? AND anonymized_at IS NULL
      `).run(ANONYMIZED_NAME, timestamp, timestamp, candidateId).changes;
      if (!changed) return;
      const applications = db.prepare('SELECT id FROM recruiting_applications WHERE candidate_id=?').all(candidateId);
      for (const application of applications) {
        db.prepare('UPDATE recruiting_applications SET message=NULL, rejection_note=NULL, hired_user_id=NULL, updated_at=? WHERE id=?').run(timestamp, application.id);
        db.prepare('UPDATE recruiting_offers SET compensation=NULL, return_comment=NULL, updated_at=? WHERE application_id=?').run(timestamp, application.id);
        db.prepare('UPDATE recruiting_interviews SET location=NULL, updated_at=? WHERE application_id=?').run(timestamp, application.id);
        db.prepare(`
          UPDATE recruiting_feedback SET strengths=NULL, concerns=NULL
          WHERE interview_id IN (SELECT id FROM recruiting_interviews WHERE application_id=?)
        `).run(application.id);
        closeOpenApplicationWork(application.id);
        removeNameFromTasks(application.id);
      }
      log(actorId, 'recruiting_candidate_anonymized', 'recruiting_candidates', candidateId, null, { trigger });
    })();
  }

  /** Wen würde die Wartung bei dieser Frist anonymisieren? */
  function candidatesDueForAnonymization(months) {
    const cutoff = monthsBefore(new Date(), months).toISOString();
    return db.prepare(`
      SELECT c.id
      FROM recruiting_candidates c
      JOIN recruiting_applications a ON a.candidate_id = c.id
      WHERE c.anonymized_at IS NULL
        AND NOT (c.talent_pool_consent = 1 AND c.talent_pool_consent_date IS NOT NULL)
      GROUP BY c.id
      HAVING SUM(CASE WHEN a.status <> 'rejected' THEN 1 ELSE 0 END) = 0
         AND MAX(a.rejected_at) <= ?
    `).all(cutoff);
  }

  /** Anonymisiert abgesagte Bewerbende nach Ablauf der Frist, außer bei gültiger Talentpool-Einwilligung. */
  function maintenance() {
    const due = candidatesDueForAnonymization(retentionMonths());
    due.forEach(candidate => anonymizeCandidate(candidate.id, null, 'retention'));
    return due.length;
  }

  // --- Ansichten --------------------------------------------------------------------------

  function requisitionPermissions(actor, requisition) {
    const hr = isHr(actor);
    const closed = CLOSED_REQUISITION_STATUSES.includes(requisition.status);
    return {
      canEdit: hr ? !closed : requisition.status === 'draft',
      canAssignManager: hr && !closed,
      canSubmit: requisition.status === 'draft',
      submitOpensDirectly: requisition.status === 'draft' && approvalRule('recruiting.requisition') === 'none',
      canApprove: hr && requisition.status === 'pending_approval',
      canReturn: hr && requisition.status === 'pending_approval',
      canPause: requisition.status === 'open',
      canResume: requisition.status === 'paused',
      canCancel: !closed,
      canFill: hr && HIRING_ALLOWED_STATUSES.includes(requisition.status),
      canAddApplication: requisition.status === 'open'
    };
  }

  function requisitionView(row) {
    return {
      id: row.id,
      title: row.title,
      positionProfileId: row.position_profile_id,
      positionTitle: row.position_title || null,
      openings: row.openings,
      hiringManagerId: row.hiring_manager_id,
      hiringManagerName: row.hiring_manager_name,
      description: row.description,
      targetDate: row.target_date,
      status: row.status,
      internalPosting: Boolean(row.internal_posting),
      returnComment: row.return_comment,
      openedAt: row.opened_at,
      filledAt: row.filled_at,
      createdAt: row.created_at
    };
  }

  function candidateView(row) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      source: row.source,
      talentPoolConsent: Boolean(row.talent_pool_consent),
      talentPoolConsentDate: row.talent_pool_consent_date,
      notes: row.notes,
      resumeText: row.resume_text,
      resumeUrl: row.resume_url,
      internal: Boolean(row.user_id),
      anonymized: Boolean(row.anonymized_at),
      createdAt: row.created_at
    };
  }

  function duplicatesOf(candidate) {
    if (!candidate.email) return { duplicates: [], matchingEmployee: null };
    const duplicates = db.prepare('SELECT id,name FROM recruiting_candidates WHERE email=? AND id<>? AND anonymized_at IS NULL ORDER BY id')
      .all(candidate.email, candidate.id);
    const matchingEmployee = candidate.user_id
      ? null
      : db.prepare('SELECT id,name FROM users WHERE email=? AND is_system_account=0').get(candidate.email) || null;
    return { duplicates, matchingEmployee };
  }

  function offerView(offer, application, access, actor) {
    const active = application.status === 'active';
    const isAuthor = approvalRule('recruiting.offer') === 'four_eyes' && (offer.created_by === actor.id || offer.last_edited_by === actor.id);
    const pending = offer.status === 'pending_approval';
    const names = db.prepare('SELECT id,name FROM users WHERE id IN (?,?)').all(offer.created_by, offer.approved_by || offer.created_by);
    const nameOf = id => names.find(person => person.id === id)?.name || null;
    return {
      id: offer.id,
      status: offer.status,
      startDate: offer.start_date,
      positionTitle: offer.position_title,
      compensation: offer.compensation,
      returnComment: offer.return_comment,
      createdByName: nameOf(offer.created_by),
      approvedByName: offer.approved_by ? nameOf(offer.approved_by) : null,
      approvalSkipped: Boolean(offer.approval_skipped),
      approvedAt: offer.approved_at,
      respondedAt: offer.responded_at,
      createdAt: offer.created_at,
      canEdit: active && offer.status === 'draft',
      canSubmit: active && offer.status === 'draft',
      canApprove: access === 'hr' && active && pending && !isAuthor,
      approvalBlockedForYou: access === 'hr' && active && pending && isAuthor,
      canReturn: access === 'hr' && active && pending,
      canRespond: active && offer.status === 'approved'
    };
  }

  function acceptedOfferOf(applicationId) {
    return db.prepare("SELECT * FROM recruiting_offers WHERE application_id=? AND status='accepted' ORDER BY id DESC LIMIT 1").get(applicationId) || null;
  }

  function hiredCountOf(requisitionId) {
    return db.prepare("SELECT COUNT(*) AS count FROM recruiting_applications WHERE requisition_id=? AND status='hired'").get(requisitionId).count;
  }

  /** Bewerbungen dieser Stelle, zu denen die Person gerade noch selbst eine Bewertung abgeben soll. */
  function applicationsWaitingForRating(userId, requisitionId) {
    return new Set(db.prepare(`
      SELECT DISTINCT i.application_id
      FROM recruiting_interview_participants p
      JOIN recruiting_interviews i ON i.id = p.interview_id
      JOIN recruiting_applications a ON a.id = i.application_id
      LEFT JOIN recruiting_feedback f ON f.interview_id = p.interview_id AND f.user_id = p.user_id
      WHERE p.user_id=? AND a.requisition_id=? AND i.status='planned' AND a.status='active' AND f.id IS NULL
    `).all(userId, requisitionId).map(row => row.application_id));
  }

  /** Bewertet wird, was im Gespräch war. Deshalb erst ab dem Termin. */
  const interviewHasStarted = interview => interview.scheduled_at <= localNowMinute();

  /**
   * Bewertungen eines Gesprächs: Fremde Bewertungen erscheinen erst nach der eigenen. Vorher fehlt auch,
   * wer schon bewertet hat, weil schon das beeinflussen kann. HR und die einstellende Führungskraft sehen
   * alles, außer sie sollen zu dieser Bewerbung selbst noch bewerten.
   */
  function interviewView(interview, application, actor, privileged) {
    const participants = db.prepare(`
      SELECT u.id, u.name
      FROM recruiting_interview_participants p
      JOIN users u ON u.id = p.user_id
      WHERE p.interview_id=?
      ORDER BY u.name
    `).all(interview.id);
    const feedbackRows = db.prepare(`
      SELECT f.*, u.name AS author_name
      FROM recruiting_feedback f
      JOIN users u ON u.id = f.user_id
      WHERE f.interview_id=?
      ORDER BY f.submitted_at, f.id
    `).all(interview.id);
    const ownFeedback = feedbackRows.find(row => row.user_id === actor.id) || null;
    const waitingForOwnRating = applicationsWaitingForRating(actor.id, application.requisition_id).has(application.id);
    const feedbackVisible = Boolean(ownFeedback) || (privileged && !waitingForOwnRating);
    const participating = participants.some(person => person.id === actor.id);
    const ratingPossible = participating && !ownFeedback && interview.status === 'planned' && application.status === 'active';
    const started = interviewHasStarted(interview);
    const toFeedbackView = row => ({
      id: row.id,
      authorName: row.author_name,
      rating: row.rating,
      strengths: row.strengths,
      concerns: row.concerns,
      recommendation: row.recommendation,
      recommendationLabel: RECOMMENDATIONS[row.recommendation],
      submittedAt: row.submitted_at
    });
    return {
      id: interview.id,
      applicationId: interview.application_id,
      scheduledAt: interview.scheduled_at,
      location: interview.location,
      status: interview.status,
      participants: participants.map(person => ({
        id: person.id,
        name: person.name,
        ...(feedbackVisible ? { submitted: feedbackRows.some(row => row.user_id === person.id) } : {})
      })),
      isParticipant: participating,
      feedbackVisible,
      ownFeedback: ownFeedback ? toFeedbackView(ownFeedback) : null,
      feedback: feedbackVisible ? feedbackRows.map(toFeedbackView) : [],
      canSubmitFeedback: ratingPossible && started,
      feedbackOpensAt: ratingPossible && !started ? interview.scheduled_at : null
    };
  }

  function selfApplicationView(application) {
    return {
      access: 'self',
      application: {
        id: application.id,
        status: application.status,
        withdrawn: application.rejection_reason === WITHDRAWN_REASON,
        stageName: application.stage_name,
        appliedAt: application.created_at
      },
      requisition: { id: application.requisition_id, title: application.requisition_title }
    };
  }

  /** Nur was zur Gesprächsvorbereitung nötig ist. Kein Angebot, kein Absagegrund, keine Kontaktdaten. */
  function interviewerApplicationView(application, actor) {
    const candidate = db.prepare('SELECT name,resume_text,resume_url FROM recruiting_candidates WHERE id=?').get(application.candidate_id);
    const requisition = loadRequisition(application.requisition_id);
    const interviews = db.prepare(`
      SELECT i.*
      FROM recruiting_interviews i
      JOIN recruiting_interview_participants p ON p.interview_id = i.id
      WHERE i.application_id=? AND p.user_id=? AND i.status='planned'
      ORDER BY i.scheduled_at
    `).all(application.id, actor.id);
    return {
      access: 'interviewer',
      application: { id: application.id, stageName: application.stage_name },
      requisition: { title: requisition.title, positionTitle: requisition.position_title || null, description: requisition.description },
      candidate: { name: candidate.name, resumeText: candidate.resume_text, resumeUrl: candidate.resume_url },
      interviews: interviews.map(interview => interviewView(interview, application, actor, false))
    };
  }

  function fullApplicationView(application, access, actor) {
    const candidate = loadCandidate(application.candidate_id);
    const interviews = db.prepare('SELECT * FROM recruiting_interviews WHERE application_id=? ORDER BY scheduled_at,id').all(application.id);
    const offers = db.prepare('SELECT * FROM recruiting_offers WHERE application_id=? ORDER BY id DESC').all(application.id);
    const history = db.prepare(`
      SELECT h.*, fromStage.name AS from_stage_name, toStage.name AS to_stage_name, u.name AS changed_by_name
      FROM recruiting_application_history h
      LEFT JOIN recruiting_stages fromStage ON fromStage.id = h.from_stage_id
      LEFT JOIN recruiting_stages toStage ON toStage.id = h.to_stage_id
      LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.application_id=?
      ORDER BY h.changed_at, h.id
    `).all(application.id);
    const active = application.status === 'active';
    const hasOpenOffer = offers.some(offer => !INACTIVE_OFFER_STATUSES.includes(offer.status));
    const hasCapacity = hiredCountOf(application.requisition_id) < application.openings;
    return {
      access,
      application: {
        id: application.id,
        status: application.status,
        stageId: application.stage_id,
        stageName: application.stage_name,
        message: application.message,
        rejectionReason: application.rejection_reason,
        rejectionReasonLabel: REJECTION_REASONS[application.rejection_reason] || null,
        rejectionNote: application.rejection_note,
        rejectedAt: application.rejected_at,
        hiredAt: application.hired_at,
        appliedAt: application.created_at
      },
      requisition: { id: application.requisition_id, title: application.requisition_title, status: application.requisition_status },
      candidate: {
        ...candidateView(candidate),
        ...(access === 'hr' ? duplicatesOf(candidate) : {})
      },
      stages: activeStages().map(stageView),
      interviews: interviews.map(interview => interviewView(interview, application, actor, true)),
      offers: offers.map(offer => offerView(offer, application, access, actor)),
      offerRule: approvalRule('recruiting.offer'),
      history: history.map(entry => ({
        id: entry.id,
        fromStageName: entry.from_stage_name,
        toStageName: entry.to_stage_name,
        fromStatus: entry.from_status,
        toStatus: entry.to_status,
        changedByName: entry.changed_by_name,
        changedAt: entry.changed_at
      })),
      permissions: {
        canMove: active && HIRING_ALLOWED_STATUSES.includes(application.requisition_status),
        canReject: active,
        canPlanInterview: active,
        canCreateOffer: active && !hasOpenOffer,
        canHire: access === 'hr' && active && Boolean(acceptedOfferOf(application.id))
          && HIRING_ALLOWED_STATUSES.includes(application.requisition_status) && hasCapacity,
        canEditCandidate: !candidate.anonymized_at && (access === 'hr' || !candidate.user_id),
        canEditCandidateFully: access === 'hr' && !candidate.anonymized_at,
        canAnonymize: access === 'hr' && !active && !candidate.anonymized_at,
        canCopyRejectionText: application.status === 'rejected' && !candidate.anonymized_at && application.rejection_reason !== WITHDRAWN_REASON
      }
    };
  }

  function rejectionText(application, actor) {
    const subject = `Ihre Bewerbung: ${application.requisition_title}`;
    const organization = tenant?.name || 'unser Unternehmen';
    const signature = actor.role === 'super_admin' ? organization : `${actor.name}\n${organization}`;
    return {
      subject,
      text: [
        `Guten Tag ${application.candidate_name},`,
        '',
        `vielen Dank für Ihre Bewerbung auf die Stelle „${application.requisition_title}“ und Ihr Interesse an ${organization}.`,
        '',
        'Nach sorgfältiger Prüfung haben wir uns entschieden, den Auswahlprozess mit anderen Bewerbungen fortzusetzen.',
        '',
        'Wir danken Ihnen für die Zeit, die Sie sich genommen haben, und wünschen Ihnen für Ihren weiteren Weg alles Gute.',
        '',
        'Freundliche Grüße',
        signature
      ].join('\n')
    };
  }

  // --- Eingaben ---------------------------------------------------------------------------

  function readPositionId(value, fallback = null) {
    if (value === undefined) return fallback;
    if (value === null || value === '') return null;
    const id = idFrom(value);
    const position = id && isModuleEnabled('talent')
      ? db.prepare('SELECT id FROM position_profiles WHERE id=? AND active=1').get(id)
      : null;
    if (!position) throw fail(400, 'Die gewählte Position ist nicht verfügbar.');
    return position.id;
  }

  function readHiringManagerId(value, actor, fallback = null) {
    const missing = value === undefined || value === null || value === '';
    if (missing && fallback) return fallback;
    const id = missing ? actor.id : idFrom(value);
    if (!isHr(actor) && id !== actor.id && !subordinateIds(actor).includes(id)) {
      throw fail(403, 'Du darfst Stellen nur für deinen eigenen Bereich anfordern.');
    }
    const person = id ? db.prepare('SELECT id,role FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) : null;
    if (!person || !HIRING_MANAGER_ROLES.includes(person.role)) {
      throw fail(400, 'Bitte wähle eine aktive Führungskraft als einstellende Person.');
    }
    return person.id;
  }

  function readRequisitionFields(input, actor, existing = null) {
    const title = input.title === undefined && existing ? existing.title : cleanText(input.title, 180);
    if (!title) throw fail(400, 'Bitte gib einen Titel für die Stelle an.');
    const rawOpenings = input.openings === undefined ? (existing ? existing.openings : 1) : input.openings;
    const openings = boundedInt(rawOpenings, 1, MAX_OPENINGS, null);
    if (!openings) throw fail(400, `Die Anzahl der Stellen muss zwischen 1 und ${MAX_OPENINGS} liegen.`);
    const description = input.description === undefined && existing ? existing.description : cleanText(input.description, 8000) || null;
    const rawTargetDate = input.targetDate === undefined ? (existing ? existing.target_date : null) : input.targetDate;
    const targetDate = rawTargetDate || null;
    if (targetDate && !isCalendarDate(targetDate)) throw fail(400, 'Der Zieltermin ist kein gültiges Datum.');
    if (input.internalPosting !== undefined && typeof input.internalPosting !== 'boolean') {
      throw fail(400, 'Bitte gib an, ob die Stelle intern ausgeschrieben ist.');
    }
    const internalPosting = input.internalPosting === undefined ? (existing ? existing.internal_posting : 0) : Number(input.internalPosting);
    return {
      title,
      openings,
      description,
      targetDate,
      internalPosting,
      positionProfileId: readPositionId(input.positionProfileId, existing ? existing.position_profile_id : null),
      hiringManagerId: readHiringManagerId(input.hiringManagerId, actor, existing ? existing.hiring_manager_id : null)
    };
  }

  function readEmail(value) {
    const email = cleanText(value, 254).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Bitte gib eine gültige E-Mail-Adresse an.');
    return email;
  }

  function readPhone(value) {
    const phone = cleanText(value, 40);
    if (phone && !/^[+\d\s()/-]+$/.test(phone)) throw fail(400, 'Die Telefonnummer enthält ungültige Zeichen.');
    return phone || null;
  }

  function readSource(value) {
    const source = cleanText(value, 40);
    if (source && !CANDIDATE_SOURCES.includes(source)) throw fail(400, 'Bitte wähle eine Quelle aus der Liste.');
    return source || null;
  }

  /** Nur http und https: Ein javascript-Link im Lebenslauf-Feld würde sonst beim Anklicken Code ausführen. */
  function readResumeUrl(value) {
    const text = cleanText(value, 1000);
    if (!text) return null;
    let url = null;
    try {
      url = new URL(text);
    } catch {
      url = null;
    }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      throw fail(400, 'Der Link zum Lebenslauf muss mit http:// oder https:// beginnen.');
    }
    return url.href;
  }

  function readConsent(input, existing = null) {
    if (input.talentPoolConsent === undefined) {
      return {
        consent: existing ? existing.talent_pool_consent : 0,
        date: existing ? existing.talent_pool_consent_date : null
      };
    }
    if (typeof input.talentPoolConsent !== 'boolean') throw fail(400, 'Bitte gib an, ob eine Einwilligung für den Talentpool vorliegt.');
    if (!input.talentPoolConsent) return { consent: 0, date: null };
    const today = nowIso().slice(0, 10);
    const date = input.talentPoolConsentDate || existing?.talent_pool_consent_date || today;
    if (!isCalendarDate(date) || date > today) throw fail(400, 'Das Datum der Einwilligung muss ein gültiges Datum und darf nicht in der Zukunft liegen.');
    return { consent: 1, date };
  }

  function insertCandidate({
    name, email, phone = null, source = null, notes = null, resumeText = null, resumeUrl = null,
    consent = 0, consentDate = null, userId = null, actorId
  }) {
    const timestamp = nowIso();
    return db.prepare(`
      INSERT INTO recruiting_candidates(
        name, email, phone, source, talent_pool_consent, talent_pool_consent_date,
        notes, resume_text, resume_url, user_id, created_by, created_at, updated_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(name, email, phone, source, consent, consentDate, notes, resumeText, resumeUrl, userId, actorId, timestamp, timestamp).lastInsertRowid;
  }

  const assignableHireRoles = actor => (
    managesOrganizationSettings(actor) ? { ...HIRE_ROLES, ...HR_HIRE_ROLES } : HIRE_ROLES
  );

  function readHireRole(value, actor) {
    if (value === undefined || value === null || value === '') return DEFAULT_HIRE_ROLE;
    if (Object.hasOwn(assignableHireRoles(actor), value)) return value;
    if (Object.hasOwn(HR_HIRE_ROLES, value)) throw fail(403, 'HR-Rollen vergibt nur die HR-Administration.');
    throw fail(400, 'Bitte wähle eine Rolle aus der Liste.');
  }

  function assertNoDuplicateEmail(email, actor, ownId = 0) {
    const duplicate = db.prepare('SELECT id,name FROM recruiting_candidates WHERE email=? AND id<>? AND anonymized_at IS NULL ORDER BY id LIMIT 1').get(email, ownId);
    if (duplicate && competesWith(actor.id, duplicate.id)) {
      throw fail(409, 'Diese E-Mail ist bereits erfasst. Bitte lass das eine andere HR-Person prüfen.', { code: 'duplicate_candidate' });
    }
    if (duplicate) {
      throw fail(409, `Diese E-Mail gehört bereits zu ${duplicate.name}. Bitte verwende die vorhandene Person.`, {
        code: 'duplicate_candidate',
        duplicate
      });
    }
  }

  /** Volle Erfassung durch HR. Eine E-Mail, die zu einem Konto gehört, macht die Person zu einer internen Bewerbung. */
  function createCandidateByHr(input, actor) {
    const name = cleanText(input.name, 160);
    if (!name) throw fail(400, 'Bitte gib den Namen der Person an.');
    const email = readEmail(input.email);
    assertNoDuplicateEmail(email, actor);
    const account = db.prepare('SELECT id FROM users WHERE email=? AND is_system_account=0 AND active=1').get(email);
    if (account && db.prepare('SELECT id FROM recruiting_candidates WHERE user_id=?').get(account.id)) {
      throw fail(409, 'Für dieses Konto gibt es bereits einen Eintrag bei den Bewerbenden.', { code: 'duplicate_candidate' });
    }
    const { consent, date } = readConsent(input);
    return insertCandidate({
      name,
      email,
      phone: readPhone(input.phone),
      source: readSource(input.source),
      notes: cleanText(input.notes, 4000) || null,
      resumeText: cleanText(input.resumeText, 20000) || null,
      resumeUrl: readResumeUrl(input.resumeUrl),
      consent,
      consentDate: date,
      userId: account?.id || null,
      actorId: actor.id
    });
  }

  /**
   * Erfassung durch die einstellende Führungskraft. Sie erfährt bewusst nichts darüber, ob die
   * E-Mail anderswo schon bekannt ist: Sonst ließe sich herausfinden, wer sich sonst noch beworben
   * hat, etwa jemand aus dem eigenen Team. HR sieht mögliche Dubletten in der Personenansicht.
   */
  function createCandidateByManager(input, requisition, actor) {
    const name = cleanText(input.name, 160);
    if (!name) throw fail(400, 'Bitte gib den Namen der Person an.');
    const email = readEmail(input.email);
    const onThisRequisition = db.prepare(`
      SELECT a.id
      FROM recruiting_applications a
      JOIN recruiting_candidates c ON c.id = a.candidate_id
      WHERE a.requisition_id=? AND c.email=?
    `).get(requisition.id, email);
    if (onThisRequisition) throw fail(409, 'Diese Person hat sich auf diese Stelle bereits beworben.');
    return insertCandidate({
      name,
      email,
      phone: readPhone(input.phone),
      source: readSource(input.source),
      notes: cleanText(input.notes, 4000) || null,
      resumeText: cleanText(input.resumeText, 20000) || null,
      resumeUrl: readResumeUrl(input.resumeUrl),
      actorId: actor.id
    });
  }

  function createApplication({ requisition, candidateId, actorId, message = null }) {
    const existing = db.prepare('SELECT id FROM recruiting_applications WHERE requisition_id=? AND candidate_id=?').get(requisition.id, candidateId);
    if (existing) throw fail(409, 'Diese Person hat sich auf diese Stelle bereits beworben.');
    const stage = firstStage();
    const timestamp = nowIso();
    const applicationId = db.prepare(`
      INSERT INTO recruiting_applications(requisition_id,candidate_id,stage_id,message,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(requisition.id, candidateId, stage.id, message, actorId, timestamp, timestamp).lastInsertRowid;
    addHistory({ applicationId, toStageId: stage.id, toStatus: 'active', actorId, at: timestamp });
    log(actorId, 'recruiting_application_created', 'recruiting_applications', applicationId, null, { requisitionId: requisition.id, candidateId });
    return applicationId;
  }

  function readParticipantIds(value, application, { required = true } = {}) {
    if (value === undefined && !required) return null;
    if (!Array.isArray(value) || value.length === 0) throw fail(400, 'Bitte weise mindestens eine Person zu.');
    if (value.length > MAX_INTERVIEW_PARTICIPANTS) throw fail(400, `Es können höchstens ${MAX_INTERVIEW_PARTICIPANTS} Personen teilnehmen.`);
    const ids = [...new Set(value.map(idFrom))];
    if (ids.some(id => id === null)) throw fail(400, 'Die Liste der Personen ist ungültig.');
    const findActive = db.prepare('SELECT id FROM users WHERE id=? AND is_system_account=0 AND active=1');
    for (const id of ids) {
      if (!findActive.get(id)) throw fail(400, 'Eine der gewählten Personen ist nicht verfügbar.');
      if (isCandidateOnRequisition(id, application.requisition_id)) {
        throw fail(400, 'Wer sich selbst auf diese Stelle bewirbt, kann nicht am Gespräch teilnehmen.');
      }
    }
    return ids;
  }

  function assignFeedbackTasks(interview, application) {
    const title = `Gespräch mit ${application.candidate_name} bewerten: „${application.requisition_title}“ am ${germanDateTime(interview.scheduled_at)}`;
    const pending = db.prepare(`
      SELECT p.user_id
      FROM recruiting_interview_participants p
      WHERE p.interview_id=? AND NOT EXISTS (
        SELECT 1 FROM recruiting_feedback f WHERE f.interview_id = p.interview_id AND f.user_id = p.user_id
      )
    `).all(interview.id);
    pending.forEach(row => createTask(row.user_id, title, TASK.feedback, interview.id, interview.scheduled_at.slice(0, 10)));
  }

  function handOverTasks(requisition, newManagerId) {
    const handOver = db.prepare('UPDATE tasks SET user_id=? WHERE type=? AND entity_id=? AND user_id=? AND done=0');
    const oldManagerId = requisition.hiring_manager_id;
    [TASK.requisitionAssigned, TASK.requisitionReturned].forEach(type => handOver.run(newManagerId, type, requisition.id, oldManagerId));
    for (const application of db.prepare('SELECT id FROM recruiting_applications WHERE requisition_id=?').all(requisition.id)) {
      [TASK.offerReturned, TASK.offerResponse].forEach(type => handOver.run(newManagerId, type, application.id, oldManagerId));
    }
  }

  /** Lädt ein Gespräch samt Bewerbung und prüft, ob die handelnde Person es verwalten darf. */
  function managedInterview(actor, interviewId) {
    const interview = loadInterview(interviewId);
    const application = loadApplication(interview.application_id);
    requireManagingAccess(actor, application);
    return { interview, application };
  }

  function managedOffer(actor, offerId) {
    const offer = loadOffer(offerId);
    const application = loadApplication(offer.application_id);
    const access = requireManagingAccess(actor, application);
    return { offer, application, access };
  }

  function readOfferFields(input, application, existing = null) {
    const startDate = input.startDate === undefined && existing ? existing.start_date : input.startDate;
    if (!isCalendarDate(startDate)) throw fail(400, 'Bitte gib ein gültiges Eintrittsdatum an.');
    if (startDate !== existing?.start_date && startDate < nowIso().slice(0, 10)) throw fail(400, 'Das Eintrittsdatum liegt in der Vergangenheit. Trage ein Datum ab heute ein.');
    const positionTitle = input.positionTitle === undefined && existing
      ? existing.position_title
      : cleanText(input.positionTitle, 180) || application.requisition_title;
    const compensation = input.compensation === undefined && existing ? existing.compensation : cleanText(input.compensation, 2000) || null;
    return { startDate, positionTitle, compensation };
  }

  // --- Beispieldaten ----------------------------------------------------------------------

  /** Nur erfundene Bewerbende. Legt nie Konten an und läuft nur, solange es keine Stelle gibt. */
  function seedDemo() {
    if (db.prepare('SELECT COUNT(*) AS count FROM recruiting_requisitions').get().count > 0) return;
    const people = db.prepare('SELECT id,name,role FROM users WHERE is_system_account=0 AND active=1 ORDER BY id').all();
    const hr = people.find(person => ['hr_admin', 'hrbp'].includes(person.role));
    const lead = people.find(person => LEADERSHIP_ROLES.includes(person.role));
    const interviewer = people.find(person => person.role === 'employee');
    if (!hr || !lead || !interviewer) return;
    const stages = activeStages().filter(stage => stage.kind === 'normal');
    const insertRequisition = db.prepare(`
      INSERT INTO recruiting_requisitions(
        title, openings, hiring_manager_id, description, target_date, status, internal_posting,
        created_by, approved_by, opened_at, created_at, updated_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    db.transaction(() => {
      const timestamp = nowIso();
      const openId = insertRequisition.run(
        'Produktdesign (m/w/d)', 1, lead.id, 'Du gestaltest Oberflächen und entwickelst unser Designsystem weiter.',
        addDaysToToday(60), 'open', 1, lead.id, hr.id, timestamp, timestamp, timestamp
      ).lastInsertRowid;
      const pendingId = insertRequisition.run(
        'Werkstudium Personal (m/w/d)', 1, lead.id, 'Unterstützung im Personalbereich mit 16 Stunden pro Woche.',
        addDaysToToday(90), 'pending_approval', 0, lead.id, null, null, timestamp, timestamp
      ).lastInsertRowid;
      hrRecipientIds().forEach(id => createTask(id, `Stellenanforderung von ${lead.name} prüfen: Werkstudium Personal (m/w/d)`, TASK.requisitionApproval, pendingId));
      // Wer am Gespräch zur ersten Stelle beteiligt ist, kann sich dort nicht bewerben. Hier geht es.
      insertRequisition.run(
        'UX Research (m/w/d)', 1, lead.id, 'Du sprichst mit Nutzerinnen und Nutzern und bringst ihre Sicht ins Team.',
        addDaysToToday(75), 'open', 1, lead.id, hr.id, timestamp, timestamp, timestamp
      );

      const openRequisition = { id: openId };
      const addCandidate = (name, email, source, resumeText, extra = {}) => insertCandidate({ name, email, source, resumeText, actorId: hr.id, ...extra });
      const inbox = addCandidate('Mara Beispiel', 'mara.beispiel@example.com', 'Stellenportal', 'Fünf Jahre Erfahrung im Produktdesign, zuletzt in einer Agentur.');
      createApplication({ requisition: openRequisition, candidateId: inbox, actorId: hr.id });

      const interviewed = addCandidate('Jonas Muster', 'jonas.muster@example.com', 'Empfehlung', 'Drei Jahre Inhouse-Design, Schwerpunkt Barrierefreiheit.');
      const interviewedApplication = createApplication({ requisition: openRequisition, candidateId: interviewed, actorId: hr.id });
      const interviewStage = stages[Math.min(2, stages.length - 1)];
      db.prepare('UPDATE recruiting_applications SET stage_id=? WHERE id=?').run(interviewStage.id, interviewedApplication);
      addHistory({
        applicationId: interviewedApplication,
        fromStageId: stages[0].id,
        toStageId: interviewStage.id,
        fromStatus: 'active',
        toStatus: 'active',
        actorId: hr.id
      });
      const interviewId = db.prepare('INSERT INTO recruiting_interviews(application_id,scheduled_at,location,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(interviewedApplication, `${addDaysToToday(-1)}T10:00`, 'Besprechungsraum 2', hr.id, timestamp, timestamp).lastInsertRowid;
      db.prepare('INSERT INTO recruiting_interview_participants(interview_id,user_id) VALUES(?,?)').run(interviewId, interviewer.id);
      assignFeedbackTasks(loadInterview(interviewId), loadApplication(interviewedApplication));

      const rejected = addCandidate('Aylin Probe', 'aylin.probe@example.com', 'Eigene Website', 'Berufseinstieg nach dem Studium.');
      const rejectedApplication = createApplication({ requisition: openRequisition, candidateId: rejected, actorId: hr.id });
      rejectApplication(loadApplication(rejectedApplication), { reason: 'experience', note: null, actorId: hr.id });

      addCandidate('Noah Vorlage', 'noah.vorlage@example.com', 'Messe', 'Interesse an künftigen Stellen im Design.', {
        consent: 1,
        consentDate: timestamp.slice(0, 10)
      });
      log(null, 'recruiting_demo_seeded', 'recruiting_requisitions', openId);
    })();
  }

  // --- Routen: Grunddaten -----------------------------------------------------------------

  router.use('/recruiting', auth);

  router.get('/recruiting/meta', (req, res) => {
    const actor = current(req);
    if (!canUseRecruiting(actor)) throw fail(403, 'Dieser Bereich ist Führungskräften und HR vorbehalten.');
    const people = db.prepare('SELECT id,name,role FROM users WHERE is_system_account=0 AND active=1 ORDER BY name').all();
    const ownArea = isHr(actor) ? null : new Set([actor.id, ...subordinateIds(actor)]);
    const talentEnabled = isModuleEnabled('talent');
    res.json({
      positions: talentEnabled ? db.prepare('SELECT id,title FROM position_profiles WHERE active=1 ORDER BY title').all() : [],
      hiringManagers: people
        .filter(person => HIRING_MANAGER_ROLES.includes(person.role))
        .filter(person => !ownArea || ownArea.has(person.id))
        .map(person => ({ id: person.id, name: person.name })),
      sources: CANDIDATE_SOURCES,
      rejectionReasons: Object.entries(REJECTION_REASONS).map(([key, label]) => ({ key, label })),
      recommendations: Object.entries(RECOMMENDATIONS).map(([key, label]) => ({ key, label })),
      onboardingEnabled: isModuleEnabled('onboarding'),
      talentEnabled,
      requisitionRule: approvalRule('recruiting.requisition'),
      hireRoles: isHr(actor) ? Object.entries(assignableHireRoles(actor)).map(([key, label]) => ({ key, label })) : []
    });
  });

  // --- Routen: Stellen --------------------------------------------------------------------

  router.get('/recruiting/requisitions', (req, res) => {
    const actor = current(req);
    if (!canUseRecruiting(actor)) throw fail(403, 'Dieser Bereich ist Führungskräften und HR vorbehalten.');
    const { status } = req.query;
    if (status !== undefined && !REQUISITION_STATUSES.includes(status)) throw fail(400, 'Unbekannter Status.');
    const rows = db.prepare(`
      SELECT r.*, m.name AS hiring_manager_name, p.title AS position_title,
             SUM(CASE WHEN a.status='active' THEN 1 ELSE 0 END) AS active_applications,
             SUM(CASE WHEN a.status='hired' THEN 1 ELSE 0 END) AS hired_count
      FROM recruiting_requisitions r
      JOIN users m ON m.id = r.hiring_manager_id
      LEFT JOIN position_profiles p ON p.id = r.position_profile_id
      LEFT JOIN recruiting_applications a ON a.requisition_id = r.id
      GROUP BY r.id, m.name, p.title
      ORDER BY r.created_at DESC, r.id DESC
    `).all();
    const visible = rows
      .filter(row => status === undefined || row.status === status)
      .filter(row => isHr(actor) || row.hiring_manager_id === actor.id);
    res.json({
      requisitions: visible.map(row => {
        const ownCandidacy = isCandidateOnRequisition(actor.id, row.id);
        return {
          ...requisitionView(row),
          activeApplications: ownCandidacy ? null : row.active_applications || 0,
          hiredCount: ownCandidacy ? null : row.hired_count || 0,
          ownCandidacy
        };
      }),
      canCreate: isHr(actor) || LEADERSHIP_ROLES.includes(actor.role)
    });
  });

  router.post('/recruiting/requisitions', (req, res) => {
    const actor = current(req);
    if (!isHr(actor) && !LEADERSHIP_ROLES.includes(actor.role)) throw fail(403, 'Nur Führungskräfte und HR dürfen Stellen anfordern.');
    const fields = readRequisitionFields(bodyOf(req), actor);
    const id = db.transaction(() => {
      const timestamp = nowIso();
      const requisitionId = db.prepare(`
        INSERT INTO recruiting_requisitions(
          title, position_profile_id, openings, hiring_manager_id, description, target_date,
          internal_posting, created_by, created_at, updated_at
        )
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        fields.title, fields.positionProfileId, fields.openings, fields.hiringManagerId, fields.description, fields.targetDate,
        fields.internalPosting, actor.id, timestamp, timestamp
      ).lastInsertRowid;
      // Wer für einen anderen Bereich anlegt, sieht die Stelle danach nicht mehr. Einreichen muss die neue Führungskraft.
      if (!isHr(actor) && fields.hiringManagerId !== actor.id) {
        const nextStep = approvalRule('recruiting.requisition') === 'none' ? 'öffnen' : 'einreichen';
        createTask(fields.hiringManagerId, `Stellenanforderung von ${actor.name} prüfen und ${nextStep}: ${fields.title}`, TASK.requisitionAssigned, requisitionId);
      }
      log(actor.id, 'recruiting_requisition_created', 'recruiting_requisitions', requisitionId, null, {
        title: fields.title,
        hiringManagerId: fields.hiringManagerId,
        status: 'draft'
      });
      return requisitionId;
    })();
    res.json({ id, handedOver: fields.hiringManagerId !== actor.id });
  });

  router.get('/recruiting/requisitions/:id', (req, res) => {
    const actor = current(req);
    const requisition = loadRequisition(req.params.id);
    requireRequisitionAccess(actor, requisition);
    res.json({
      requisition: { ...requisitionView(requisition), hiredCount: hiredCountOf(requisition.id) },
      permissions: requisitionPermissions(actor, requisition)
    });
  });

  router.patch('/recruiting/requisitions/:id', (req, res) => {
    const actor = current(req);
    const requisition = loadRequisition(req.params.id);
    requireRequisitionAccess(actor, requisition);
    const permissions = requisitionPermissions(actor, requisition);
    if (!permissions.canEdit) throw fail(isHr(actor) ? 409 : 403, 'Diese Stelle kann in ihrem jetzigen Status nicht mehr geändert werden.');
    const input = bodyOf(req);
    if (input.hiringManagerId !== undefined && !isHr(actor) && Number(input.hiringManagerId) !== requisition.hiring_manager_id) {
      throw fail(403, 'Die einstellende Führungskraft kann nur HR ändern.');
    }
    const fields = readRequisitionFields(input, actor, requisition);
    if (fields.openings < hiredCountOf(requisition.id)) throw fail(409, 'Es sind bereits mehr Plätze vergeben, als du eintragen möchtest.');
    if (fields.hiringManagerId !== requisition.hiring_manager_id && isCandidateOnRequisition(fields.hiringManagerId, requisition.id)) {
      throw fail(409, 'Diese Person bewirbt sich selbst auf die Stelle und kann sie nicht verantworten.');
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE recruiting_requisitions
        SET title=?, position_profile_id=?, openings=?, hiring_manager_id=?, description=?, target_date=?, internal_posting=?, updated_at=?
        WHERE id=?
      `).run(
        fields.title, fields.positionProfileId, fields.openings, fields.hiringManagerId, fields.description, fields.targetDate,
        fields.internalPosting, nowIso(), requisition.id
      );
      // Die bisherige Führungskraft sieht die Stelle nicht mehr. Ihre offenen Aufgaben wären Sackgassen.
      if (fields.hiringManagerId !== requisition.hiring_manager_id) {
        handOverTasks(requisition, fields.hiringManagerId);
      }
      log(actor.id, 'recruiting_requisition_updated', 'recruiting_requisitions', requisition.id,
        { title: requisition.title, openings: requisition.openings, hiringManagerId: requisition.hiring_manager_id, internalPosting: requisition.internal_posting },
        { title: fields.title, openings: fields.openings, hiringManagerId: fields.hiringManagerId, internalPosting: fields.internalPosting });
    })();
    res.json({ ok: true });
  });

  for (const [name, rule] of Object.entries(REQUISITION_TRANSITIONS)) {
    router.post(`/recruiting/requisitions/:id/${name}`, (req, res) => {
      const actor = current(req);
      const requisition = loadRequisition(req.params.id);
      requireRequisitionAccess(actor, requisition);
      if (rule.hrOnly) requireHr(actor, 'Diesen Schritt darf nur HR ausführen.');
      if (!rule.from.includes(requisition.status)) throw fail(409, 'Dieser Schritt passt nicht zum aktuellen Status der Stelle.');
      const comment = cleanText(bodyOf(req).comment, 1000);
      if (name === 'return' && !comment) throw fail(400, 'Bitte schreibe kurz, was geändert werden soll.');
      const timestamp = nowIso();
      // Ohne Freigabepflicht ist eine eingereichte Stelle sofort offen.
      const opensDirectly = name === 'submit' && approvalRule('recruiting.requisition') === 'none';
      const nextStatus = opensDirectly ? 'open' : rule.to;
      db.transaction(() => {
        db.prepare('UPDATE recruiting_requisitions SET status=?,updated_at=? WHERE id=?').run(nextStatus, timestamp, requisition.id);
        if (name === 'submit') {
          db.prepare('UPDATE recruiting_requisitions SET return_comment=NULL WHERE id=?').run(requisition.id);
          closeTasks(TASK.requisitionAssigned, requisition.id);
          closeTasks(TASK.requisitionReturned, requisition.id);
          if (opensDirectly) db.prepare('UPDATE recruiting_requisitions SET opened_at=COALESCE(opened_at,?) WHERE id=?').run(timestamp, requisition.id);
          else hrRecipientIds().forEach(id => createTask(id, `Stellenanforderung von ${requisition.hiring_manager_name} prüfen: ${requisition.title}`, TASK.requisitionApproval, requisition.id));
        }
        if (name === 'approve') {
          db.prepare('UPDATE recruiting_requisitions SET approved_by=?, opened_at=COALESCE(opened_at,?) WHERE id=?').run(actor.id, timestamp, requisition.id);
          if (requisition.hiring_manager_id && requisition.hiring_manager_id !== actor.id) {
            createTask(requisition.hiring_manager_id, `${actor.name} hat die Stelle „${requisition.title}“ freigegeben`, 'recruiting_requisition_notice', requisition.id);
          }
        }
        if (name === 'return') {
          db.prepare('UPDATE recruiting_requisitions SET return_comment=? WHERE id=?').run(comment, requisition.id);
          createTask(requisition.hiring_manager_id, `Stellenanforderung überarbeiten, Rückmeldung von ${actor.name}: ${requisition.title}`, TASK.requisitionReturned, requisition.id);
        }
        if (name === 'cancel') {
          db.prepare('UPDATE recruiting_requisitions SET cancelled_at=? WHERE id=?').run(timestamp, requisition.id);
          closeTasks(TASK.requisitionAssigned, requisition.id);
          closeTasks(TASK.requisitionReturned, requisition.id);
          closeHireTasksOfRequisition(requisition.id);
        }
        if (name === 'fill') {
          db.prepare('UPDATE recruiting_requisitions SET filled_at=? WHERE id=?').run(timestamp, requisition.id);
          closeHireTasksOfRequisition(requisition.id);
        }
        if (['approve', 'return', 'cancel'].includes(name)) closeTasks(TASK.requisitionApproval, requisition.id);
        log(actor.id, rule.action, 'recruiting_requisitions', requisition.id, { status: requisition.status }, { status: nextStatus });
      })();
      res.json({ ok: true, status: nextStatus });
    });
  }

  router.get('/recruiting/requisitions/:id/board', (req, res) => {
    const actor = current(req);
    const requisition = loadRequisition(req.params.id);
    requireRequisitionAccess(actor, requisition);
    const allRows = db.prepare(`
      SELECT a.id, a.candidate_id, a.stage_id, a.status, a.created_at, a.rejection_reason,
             c.name AS candidate_name, c.user_id AS candidate_user_id, c.anonymized_at
      FROM recruiting_applications a
      JOIN recruiting_candidates c ON c.id = a.candidate_id
      WHERE a.requisition_id=?
      ORDER BY a.created_at, a.id
    `).all(requisition.id);
    // Mitbewerbende von anderen Stellen bleiben für HR auch hier verborgen. Die eigene Stelle verantwortet man weiter.
    const rivals = isHr(actor) && requisition.hiring_manager_id !== actor.id ? rivalCandidateIds(actor.id) : new Set();
    const rows = allRows.filter(row => !rivals.has(row.candidate_id));
    const offers = db.prepare(`
      SELECT o.application_id, o.status, o.approval_skipped
      FROM recruiting_offers o
      JOIN recruiting_applications a ON a.id = o.application_id
      WHERE a.requisition_id=? AND o.status NOT IN ('declined','withdrawn')
    `).all(requisition.id);
    const ratings = db.prepare(`
      SELECT i.application_id, f.rating
      FROM recruiting_feedback f
      JOIN recruiting_interviews i ON i.id = f.interview_id
      JOIN recruiting_applications a ON a.id = i.application_id
      WHERE a.requisition_id=?
    `).all(requisition.id);
    const interviewCounts = db.prepare(`
      SELECT i.application_id, COUNT(*) AS count
      FROM recruiting_interviews i
      JOIN recruiting_applications a ON a.id = i.application_id
      WHERE a.requisition_id=? AND i.status='planned'
      GROUP BY i.application_id
    `).all(requisition.id);
    const waitingForRating = applicationsWaitingForRating(actor.id, requisition.id);
    const cards = rows.map(row => {
      const ratingsHidden = waitingForRating.has(row.id);
      const applicationRatings = ratingsHidden ? [] : ratings.filter(item => item.application_id === row.id).map(item => item.rating);
      const offer = offers.find(item => item.application_id === row.id);
      return {
        id: row.id,
        candidateId: row.candidate_id,
        candidateName: row.candidate_name,
        internal: Boolean(row.candidate_user_id),
        anonymized: Boolean(row.anonymized_at),
        stageId: row.stage_id,
        status: row.status,
        appliedAt: row.created_at,
        rejectionReasonLabel: REJECTION_REASONS[row.rejection_reason] || null,
        offerStatus: offer?.status || null,
        offerApprovalSkipped: Boolean(offer?.approval_skipped),
        interviewCount: interviewCounts.find(item => item.application_id === row.id)?.count || 0,
        ratingsHidden,
        feedbackCount: applicationRatings.length,
        averageRating: applicationRatings.length
          ? Math.round((applicationRatings.reduce((sum, rating) => sum + rating, 0) / applicationRatings.length) * 10) / 10
          : null
      };
    });
    const usedStageIds = new Set(cards.filter(card => card.status !== 'rejected').map(card => card.stageId));
    const stages = db.prepare('SELECT * FROM recruiting_stages ORDER BY sort_order,id').all()
      .filter(stage => stage.active || usedStageIds.has(stage.id));
    res.json({
      requisition: { ...requisitionView(requisition), hiredCount: hiredCountOf(requisition.id) },
      permissions: requisitionPermissions(actor, requisition),
      canMoveApplications: HIRING_ALLOWED_STATUSES.includes(requisition.status),
      stages: stages.map(stageView),
      applications: cards.filter(card => card.status !== 'rejected'),
      rejected: cards.filter(card => card.status === 'rejected'),
      hiddenApplications: allRows.length - rows.length
    });
  });

  router.post('/recruiting/requisitions/:id/applications', (req, res) => {
    const actor = current(req);
    const requisition = loadRequisition(req.params.id);
    requireRequisitionAccess(actor, requisition);
    if (requisition.status !== 'open') throw fail(409, 'Bewerbungen lassen sich nur bei offenen Stellen anlegen.');
    const input = bodyOf(req);
    const hr = isHr(actor);
    if (input.candidateId !== undefined && !hr) throw fail(403, 'Vorhandene Personen kann nur HR zuordnen.');
    const applicationId = db.transaction(() => {
      let candidate;
      if (input.candidateId !== undefined) {
        candidate = loadCandidate(input.candidateId);
        if (competesWith(actor.id, candidate.id)) throw fail(403, CONFLICT_MESSAGE);
        if (candidate.anonymized_at) throw fail(409, 'Diese Person wurde anonymisiert und kann sich nicht mehr bewerben.');
      } else {
        const candidateInput = input.candidate && typeof input.candidate === 'object' ? input.candidate : {};
        const candidateId = hr ? createCandidateByHr(candidateInput, actor) : createCandidateByManager(candidateInput, requisition, actor);
        log(actor.id, 'recruiting_candidate_created', 'recruiting_candidates', candidateId);
        candidate = loadCandidate(candidateId);
      }
      if (candidate.user_id === actor.id) throw fail(403, 'Deine eigene Bewerbung reichst du über die Stellenbörse ein.');
      if (candidate.user_id && candidate.user_id === requisition.hiring_manager_id) {
        throw fail(400, 'Die einstellende Führungskraft kann sich nicht auf die eigene Stelle bewerben.');
      }
      return createApplication({ requisition, candidateId: candidate.id, actorId: actor.id, message: cleanText(input.message, 2000) || null });
    })();
    res.json({ id: applicationId });
  });

  // --- Routen: Bewerbende -----------------------------------------------------------------

  router.get('/recruiting/candidates', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Die Liste aller Bewerbenden sieht nur HR.');
    const search = cleanText(req.query.q, 160).toLocaleLowerCase('de');
    const talentPoolOnly = req.query.talentPool === 'true';
    const includeAnonymized = req.query.includeAnonymized === 'true';
    const rows = db.prepare(`
      SELECT c.*,
             COUNT(a.id) AS application_count,
             SUM(CASE WHEN a.status='active' THEN 1 ELSE 0 END) AS active_count,
             MAX(a.rejected_at) AS last_rejected_at
      FROM recruiting_candidates c
      LEFT JOIN recruiting_applications a ON a.candidate_id = c.id
      GROUP BY c.id
      ORDER BY c.name, c.id
    `).all();
    const rivals = rivalCandidateIds(actor.id);
    const visible = rows
      .filter(row => row.user_id !== actor.id && !rivals.has(row.id))
      .filter(row => includeAnonymized || !row.anonymized_at)
      .filter(row => !talentPoolOnly || row.talent_pool_consent === 1)
      .filter(row => !search || `${row.name} ${row.email || ''}`.toLocaleLowerCase('de').includes(search));
    res.json({
      candidates: visible.slice(0, 500).map(row => ({
        ...candidateView(row),
        applicationCount: row.application_count,
        activeApplications: row.active_count || 0,
        lastRejectedAt: row.last_rejected_at
      })),
      retentionMonths: retentionMonths()
    });
  });

  router.post('/recruiting/candidates', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Bewerbende ohne Stelle kann nur HR anlegen.');
    const id = createCandidateByHr(bodyOf(req), actor);
    log(actor.id, 'recruiting_candidate_created', 'recruiting_candidates', id);
    res.json({ id });
  });

  function candidateAccess(actor, candidate) {
    if (candidate.user_id === actor.id) return null;
    if (isHr(actor) && !competesWith(actor.id, candidate.id)) return 'hr';
    const managedApplication = db.prepare(`
      SELECT a.id
      FROM recruiting_applications a
      JOIN recruiting_requisitions r ON r.id = a.requisition_id
      WHERE a.candidate_id=? AND r.hiring_manager_id=?
      LIMIT 1
    `).get(candidate.id, actor.id);
    return managedApplication ? 'manager' : null;
  }

  router.get('/recruiting/candidates/:id', (req, res) => {
    const actor = current(req);
    const candidate = loadCandidate(req.params.id);
    const access = candidateAccess(actor, candidate);
    if (!access) throw fail(403, 'Du darfst diese Person nicht sehen.');
    const applications = db.prepare(`
      SELECT a.id, a.status, a.created_at, r.id AS requisition_id, r.title AS requisition_title, r.hiring_manager_id, s.name AS stage_name
      FROM recruiting_applications a
      JOIN recruiting_requisitions r ON r.id = a.requisition_id
      JOIN recruiting_stages s ON s.id = a.stage_id
      WHERE a.candidate_id=?
      ORDER BY a.created_at DESC
    `).all(candidate.id);
    res.json({
      candidate: {
        ...candidateView(candidate),
        ...(access === 'hr' ? duplicatesOf(candidate) : {})
      },
      applications: applications
        .filter(item => access === 'hr' || item.hiring_manager_id === actor.id)
        .filter(item => !isCandidateOnRequisition(actor.id, item.requisition_id))
        .map(item => ({
          id: item.id,
          status: item.status,
          stageName: item.stage_name,
          appliedAt: item.created_at,
          requisitionId: item.requisition_id,
          requisitionTitle: item.requisition_title
        }))
    });
  });

  router.patch('/recruiting/candidates/:id', (req, res) => {
    const actor = current(req);
    const candidate = loadCandidate(req.params.id);
    const access = candidateAccess(actor, candidate);
    if (!access) throw fail(403, 'Du darfst diese Person nicht bearbeiten.');
    if (candidate.anonymized_at) throw fail(409, 'Diese Person wurde anonymisiert.');
    const input = bodyOf(req);
    const hrOnlyFields = ['name', 'email', 'source', 'talentPoolConsent', 'talentPoolConsentDate'];
    if (access !== 'hr' && hrOnlyFields.some(field => input[field] !== undefined)) {
      throw fail(403, 'Name, E-Mail, Quelle und Einwilligung ändert HR.');
    }
    if (access !== 'hr' && candidate.user_id) throw fail(403, 'Angaben interner Bewerbender ändert HR.');
    if (candidate.user_id && (input.name !== undefined || input.email !== undefined)) {
      throw fail(400, 'Name und E-Mail interner Bewerbender stammen aus dem Konto.');
    }
    const name = input.name === undefined ? candidate.name : cleanText(input.name, 160);
    if (!name) throw fail(400, 'Bitte gib den Namen der Person an.');
    const email = input.email === undefined ? candidate.email : readEmail(input.email);
    if (email !== candidate.email) assertNoDuplicateEmail(email, actor, candidate.id);
    const { consent, date } = readConsent(input, candidate);
    const phone = input.phone === undefined ? candidate.phone : readPhone(input.phone);
    const source = input.source === undefined ? candidate.source : readSource(input.source);
    const notes = input.notes === undefined ? candidate.notes : cleanText(input.notes, 4000) || null;
    const resumeText = input.resumeText === undefined ? candidate.resume_text : cleanText(input.resumeText, 20000) || null;
    const resumeUrl = input.resumeUrl === undefined ? candidate.resume_url : readResumeUrl(input.resumeUrl);
    db.prepare(`
      UPDATE recruiting_candidates
      SET name=?, email=?, phone=?, source=?, talent_pool_consent=?, talent_pool_consent_date=?, notes=?, resume_text=?, resume_url=?, updated_at=?
      WHERE id=?
    `).run(name, email, phone, source, consent, date, notes, resumeText, resumeUrl, nowIso(), candidate.id);
    log(actor.id, 'recruiting_candidate_updated', 'recruiting_candidates', candidate.id, null, { talentPoolConsent: consent });
    res.json({ ok: true });
  });

  router.post('/recruiting/candidates/:id/anonymize', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Anonymisieren darf nur HR.');
    const candidate = loadCandidate(req.params.id);
    if (candidate.user_id === actor.id) throw fail(403, 'Deinen eigenen Eintrag muss eine andere HR-Person anonymisieren.');
    if (competesWith(actor.id, candidate.id)) throw fail(403, CONFLICT_MESSAGE);
    if (candidate.anonymized_at) return res.json({ ok: true, alreadyAnonymized: true });
    const active = db.prepare("SELECT COUNT(*) AS count FROM recruiting_applications WHERE candidate_id=? AND status='active'").get(candidate.id).count;
    if (active > 0) throw fail(409, 'Bitte sage zuerst die laufenden Bewerbungen ab.');
    anonymizeCandidate(candidate.id, actor.id, 'manual');
    res.json({ ok: true, alreadyAnonymized: false });
  });

  // --- Routen: Bewerbungen ----------------------------------------------------------------

  router.get('/recruiting/applications/:id', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    const access = applicationAccess(actor, application);
    if (!access) throw fail(403, 'Du darfst diese Bewerbung nicht sehen.');
    if (access === 'self') return res.json(selfApplicationView(application));
    if (access === 'interviewer') return res.json(interviewerApplicationView(application, actor));
    res.json(fullApplicationView(application, access, actor));
  });

  router.post('/recruiting/applications/:id/move', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    requireManagingAccess(actor, application);
    requireActiveApplication(application);
    if (!HIRING_ALLOWED_STATUSES.includes(application.requisition_status)) {
      throw fail(409, 'Bei dieser Stelle lassen sich Bewerbungen nicht mehr verschieben.');
    }
    const stageId = idFrom(bodyOf(req).stageId);
    const stage = stageId ? db.prepare('SELECT * FROM recruiting_stages WHERE id=? AND active=1').get(stageId) : null;
    if (!stage) throw fail(400, 'Bitte wähle eine aktive Stufe.');
    if (stage.kind === 'hired') throw fail(400, 'In diese Stufe gelangt eine Bewerbung nur über „Einstellen“.');
    if (stage.id === application.stage_id) throw fail(400, 'Die Bewerbung ist bereits in dieser Stufe.');
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE recruiting_applications SET stage_id=?,updated_at=? WHERE id=?').run(stage.id, timestamp, application.id);
      addHistory({
        applicationId: application.id,
        fromStageId: application.stage_id,
        toStageId: stage.id,
        fromStatus: 'active',
        toStatus: 'active',
        actorId: actor.id,
        at: timestamp
      });
      closeTasks(TASK.internalApplication, application.id);
      log(actor.id, 'recruiting_application_moved', 'recruiting_applications', application.id, { stageId: application.stage_id }, { stageId: stage.id });
    })();
    res.json({ ok: true });
  });

  router.post('/recruiting/applications/:id/reject', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    requireManagingAccess(actor, application);
    requireActiveApplication(application);
    const input = bodyOf(req);
    if (!Object.hasOwn(REJECTION_REASONS, input.reason)) throw fail(400, 'Bitte wähle einen Absagegrund aus der Liste.');
    rejectApplication(application, { reason: input.reason, note: cleanText(input.note, 2000) || null, actorId: actor.id });
    res.json({ ok: true, rejectionText: input.reason === WITHDRAWN_REASON ? null : rejectionText(application, actor) });
  });

  router.get('/recruiting/applications/:id/rejection-text', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    requireManagingAccess(actor, application);
    if (application.status !== 'rejected') throw fail(409, 'Einen Absagetext gibt es erst nach der Absage.');
    if (application.candidate_anonymized_at) throw fail(409, 'Diese Person wurde anonymisiert.');
    res.json({ rejectionText: rejectionText(application, actor) });
  });

  router.post('/recruiting/applications/:id/hire', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    if (applicationAccess(actor, application) !== 'hr') throw fail(403, 'Einstellen darf nur HR.');
    if (application.status === 'hired') throw fail(409, 'Diese Bewerbung wurde bereits eingestellt.');
    if (application.status !== 'active') throw fail(409, 'Eine abgesagte Bewerbung kann nicht eingestellt werden.');
    const offer = acceptedOfferOf(application.id);
    if (!offer) throw fail(409, 'Einstellen geht erst, wenn das Angebot angenommen wurde.');
    if (!HIRING_ALLOWED_STATUSES.includes(application.requisition_status)) throw fail(409, 'Diese Stelle nimmt keine Einstellungen mehr an.');
    if (hiredCountOf(application.requisition_id) >= application.openings) throw fail(409, 'Alle Plätze dieser Stelle sind bereits vergeben.');
    const manager = db.prepare('SELECT id,name FROM users WHERE id=? AND is_system_account=0 AND active=1').get(application.hiring_manager_id);
    if (!manager) throw fail(409, 'Die einstellende Führungskraft ist nicht mehr aktiv. Bitte ordne die Stelle zuerst neu zu.');

    // Gibt es schon ein Konto mit dieser E-Mail, wird kein zweites angelegt, sondern wie intern verfahren.
    const account = application.candidate_user_id
      ? db.prepare('SELECT id,active FROM users WHERE id=?').get(application.candidate_user_id)
      : db.prepare('SELECT id,active FROM users WHERE email=? AND is_system_account=0').get(application.candidate_email);
    if (account && !account.active) {
      throw fail(409, 'Zu dieser Person gibt es ein gesperrtes Konto. Bitte entsperre es zuerst unter „Mitarbeitende“ im Reiter „Konten“ (dort „Gesperrte anzeigen“).');
    }
    const internal = Boolean(account);

    const input = bodyOf(req);
    // Ein vorhandenes Konto behält seine Rolle. Änderungen daran gehören zu den Konten, nicht zur Einstellung.
    const role = internal ? null : readHireRole(input.role, actor);
    const onboardingEnabled = isModuleEnabled('onboarding');
    const startOnboarding = onboardingEnabled && (internal ? input.startOnboarding === true : true);
    const templateId = input.templateId === undefined || input.templateId === null || input.templateId === '' ? null : idFrom(input.templateId);
    if (startOnboarding && (input.templateId || input.templateId === 0) && !(templateId && findStartableTemplate(db, { templateId, kind: 'onboarding' }))) {
      throw fail(400, 'Die gewählte Vorlage für den Einstieg ist nicht verfügbar.');
    }

    let entryDateRecorded = false;
    const hired = db.transaction(() => {
      const timestamp = nowIso();
      const created = internal ? null : createUserAccount({
        name: application.candidate_name,
        email: application.candidate_email,
        role,
        title: offer.position_title,
        managerId: manager.id,
        positionProfileId: application.position_profile_id || null,
        positionEffectiveDate: offer.start_date,
        actor
      });
      const userId = internal ? account.id : created.id;
      if (!internal && offer.start_date && recordEntryDate && isModuleEnabled('personnel')) {
        entryDateRecorded = recordEntryDate({ userId, entryDate: offer.start_date, actor });
      }
      const stage = hiredStage();
      db.prepare(`
        UPDATE recruiting_applications
        SET status='hired', stage_id=?, hired_at=?, hired_by=?, hired_user_id=?, updated_at=?
        WHERE id=?
      `).run(stage.id, timestamp, actor.id, userId, timestamp, application.id);
      if (!db.prepare('SELECT id FROM recruiting_candidates WHERE user_id=?').get(userId)) {
        db.prepare('UPDATE recruiting_candidates SET user_id=?, updated_at=? WHERE id=?').run(userId, timestamp, application.candidate_id);
      }
      addHistory({
        applicationId: application.id,
        fromStageId: application.stage_id,
        toStageId: stage.id,
        fromStatus: 'active',
        toStatus: 'hired',
        actorId: actor.id,
        at: timestamp
      });
      closeOpenApplicationWork(application.id);
      log(actor.id, 'recruiting_application_hired', 'recruiting_applications', application.id, { status: 'active' }, { status: 'hired', userId, internal });
      if (internal) {
        log(actor.id, 'recruiting_internal_move_offered', 'users', userId, null, {
          applicationId: application.id,
          positionProfileId: application.position_profile_id || null,
          managerId: manager.id,
          startDate: offer.start_date
        });
      }
      const filled = hiredCountOf(application.requisition_id) >= application.openings;
      if (filled) {
        db.prepare("UPDATE recruiting_requisitions SET status='filled', filled_at=?, updated_at=? WHERE id=?")
          .run(timestamp, timestamp, application.requisition_id);
        closeHireTasksOfRequisition(application.requisition_id);
        log(actor.id, 'recruiting_requisition_filled', 'recruiting_requisitions', application.requisition_id,
          { status: application.requisition_status }, { status: 'filled' });
      }
      return { userId, temporaryPassword: created?.temporaryPassword || null, filled };
    })();

    // Erst nach dem Speichern und mit eigenem Schutz: Scheitert der Einstieg, darf das einmalige Passwort nicht verloren gehen.
    let journeyId = null;
    let onboardingNote = null;
    if (startOnboarding) {
      try {
        journeyId = startJourney(db, {
          personId: hired.userId,
          templateId,
          kind: 'onboarding',
          keyDate: offer.start_date,
          actor,
          createTask,
          log
        }).id;
      } catch (error) {
        onboardingNote = error.status ? error.message : 'Der Einstieg konnte nicht automatisch gestartet werden. Bitte starte ihn von Hand.';
        if (!error.status) console.error('Einstieg nach Einstellung nicht gestartet', error);
      }
    }

    const positionTitle = application.position_profile_id
      ? db.prepare('SELECT title FROM position_profiles WHERE id=?').get(application.position_profile_id)?.title || offer.position_title
      : offer.position_title;
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM recruiting_applications WHERE requisition_id=? AND status='active'")
      .get(application.requisition_id).count;
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      userId: hired.userId,
      internal,
      temporaryPassword: hired.temporaryPassword,
      role,
      entryDate: offer.start_date,
      personnelEnabled: isModuleEnabled('personnel'),
      entryDateRecorded,
      requisitionFilled: hired.filled,
      remainingActiveApplications: remaining,
      journeyId,
      onboardingNote,
      positionChange: internal ? {
        positionProfileId: application.position_profile_id || null,
        positionTitle,
        managerId: manager.id,
        managerName: manager.name,
        startDate: offer.start_date
      } : null
    });
  });

  // --- Routen: Gespräche und Bewertungen --------------------------------------------------

  /** Namen und Titel aller Personen bekommt nur, wer zu genau dieser Bewerbung ein Gespräch planen darf. */
  router.get('/recruiting/applications/:id/participant-options', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    requireManagingAccess(actor, application);
    const people = db.prepare('SELECT id,name,title FROM users WHERE is_system_account=0 AND active=1 ORDER BY name').all();
    res.json({ people: people.filter(person => !isCandidateOnRequisition(person.id, application.requisition_id)) });
  });

  router.post('/recruiting/applications/:id/interviews', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    requireManagingAccess(actor, application);
    requireActiveApplication(application);
    const input = bodyOf(req);
    const scheduledAt = normalizeDateTime(input.scheduledAt);
    if (!scheduledAt) throw fail(400, 'Bitte gib einen gültigen Termin an.');
    const participantIds = readParticipantIds(input.participantIds, application);
    const location = cleanText(input.location, 200) || null;
    const interviewId = db.transaction(() => {
      const timestamp = nowIso();
      const id = db.prepare('INSERT INTO recruiting_interviews(application_id,scheduled_at,location,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(application.id, scheduledAt, location, actor.id, timestamp, timestamp).lastInsertRowid;
      const addParticipant = db.prepare('INSERT INTO recruiting_interview_participants(interview_id,user_id) VALUES(?,?)');
      participantIds.forEach(userId => addParticipant.run(id, userId));
      assignFeedbackTasks(loadInterview(id), application);
      log(actor.id, 'recruiting_interview_created', 'recruiting_interviews', id, null, { applicationId: application.id, scheduledAt, participantIds });
      return id;
    })();
    res.json({ id: interviewId });
  });

  router.get('/recruiting/interviews/mine', (req, res) => {
    const actor = current(req);
    const rows = db.prepare(`
      SELECT i.*, a.id AS application_id, a.status AS application_status, r.title AS requisition_title, c.name AS candidate_name,
             f.id AS own_feedback_id
      FROM recruiting_interview_participants p
      JOIN recruiting_interviews i ON i.id = p.interview_id
      JOIN recruiting_applications a ON a.id = i.application_id
      JOIN recruiting_requisitions r ON r.id = a.requisition_id
      JOIN recruiting_candidates c ON c.id = a.candidate_id
      LEFT JOIN recruiting_feedback f ON f.interview_id = i.id AND f.user_id = p.user_id
      WHERE p.user_id=? AND i.status='planned' AND a.status='active'
      ORDER BY i.scheduled_at, i.id
    `).all(actor.id);
    const visible = rows.filter(row => {
      const access = applicationAccess(actor, loadApplication(row.application_id));
      return access && access !== 'self';
    });
    res.json({
      interviews: visible.map(row => ({
        id: row.id,
        applicationId: row.application_id,
        scheduledAt: row.scheduled_at,
        location: row.location,
        requisitionTitle: row.requisition_title,
        candidateName: row.candidate_name,
        submitted: Boolean(row.own_feedback_id),
        canSubmitFeedback: !row.own_feedback_id && interviewHasStarted(row)
      }))
    });
  });

  router.get('/recruiting/interviews/:id', (req, res) => {
    const actor = current(req);
    const interview = loadInterview(req.params.id);
    const application = loadApplication(interview.application_id);
    const access = applicationAccess(actor, application);
    const privileged = access === 'hr' || access === 'manager';
    const participating = access === 'interviewer' && interview.status === 'planned' && isParticipant(interview.id, actor.id);
    if (!privileged && !participating) throw fail(403, 'Du darfst dieses Gespräch nicht sehen.');
    const candidate = db.prepare('SELECT name,resume_text,resume_url FROM recruiting_candidates WHERE id=?').get(application.candidate_id);
    const requisition = loadRequisition(application.requisition_id);
    res.json({
      access,
      interview: interviewView(interview, application, actor, privileged),
      requisition: { id: requisition.id, title: requisition.title, positionTitle: requisition.position_title || null, description: requisition.description },
      candidate: { name: candidate.name, resumeText: candidate.resume_text, resumeUrl: candidate.resume_url },
      recommendations: Object.entries(RECOMMENDATIONS).map(([key, label]) => ({ key, label }))
    });
  });

  router.patch('/recruiting/interviews/:id', (req, res) => {
    const actor = current(req);
    const { interview, application } = managedInterview(actor, req.params.id);
    requireActiveApplication(application);
    if (interview.status !== 'planned') throw fail(409, 'Dieses Gespräch wurde abgesagt.');
    const input = bodyOf(req);
    const scheduledAt = input.scheduledAt === undefined ? interview.scheduled_at : normalizeDateTime(input.scheduledAt);
    if (!scheduledAt) throw fail(400, 'Bitte gib einen gültigen Termin an.');
    const location = input.location === undefined ? interview.location : cleanText(input.location, 200) || null;
    const participantIds = readParticipantIds(input.participantIds, application, { required: false });
    if (participantIds) {
      const reviewed = db.prepare('SELECT user_id FROM recruiting_feedback WHERE interview_id=?').all(interview.id).map(row => row.user_id);
      if (reviewed.some(userId => !participantIds.includes(userId))) {
        throw fail(409, 'Wer schon bewertet hat, bleibt am Gespräch beteiligt.');
      }
    }
    db.transaction(() => {
      db.prepare('UPDATE recruiting_interviews SET scheduled_at=?,location=?,updated_at=? WHERE id=?').run(scheduledAt, location, nowIso(), interview.id);
      if (participantIds) {
        db.prepare('DELETE FROM recruiting_interview_participants WHERE interview_id=?').run(interview.id);
        const addParticipant = db.prepare('INSERT INTO recruiting_interview_participants(interview_id,user_id) VALUES(?,?)');
        participantIds.forEach(userId => addParticipant.run(interview.id, userId));
      }
      // Der Aufgabentitel nennt den Termin, deshalb werden offene Aufgaben neu verteilt.
      closeTasks(TASK.feedback, interview.id);
      assignFeedbackTasks({ ...interview, scheduled_at: scheduledAt }, application);
      log(actor.id, 'recruiting_interview_updated', 'recruiting_interviews', interview.id, { scheduledAt: interview.scheduled_at }, { scheduledAt, participantIds });
    })();
    res.json({ ok: true });
  });

  router.post('/recruiting/interviews/:id/cancel', (req, res) => {
    const actor = current(req);
    const { interview } = managedInterview(actor, req.params.id);
    if (interview.status !== 'planned') throw fail(409, 'Dieses Gespräch wurde bereits abgesagt.');
    db.transaction(() => {
      db.prepare("UPDATE recruiting_interviews SET status='cancelled',updated_at=? WHERE id=?").run(nowIso(), interview.id);
      closeTasks(TASK.feedback, interview.id);
      log(actor.id, 'recruiting_interview_cancelled', 'recruiting_interviews', interview.id, { status: 'planned' }, { status: 'cancelled' });
    })();
    res.json({ ok: true });
  });

  router.post('/recruiting/interviews/:id/feedback', (req, res) => {
    const actor = current(req);
    const interview = loadInterview(req.params.id);
    const application = loadApplication(interview.application_id);
    const access = applicationAccess(actor, application);
    if (!access || access === 'self' || !isParticipant(interview.id, actor.id)) {
      throw fail(403, 'Bewerten können nur die zugewiesenen Personen.');
    }
    if (interview.status !== 'planned') throw fail(409, 'Dieses Gespräch wurde abgesagt.');
    requireActiveApplication(application);
    if (!interviewHasStarted(interview)) {
      throw fail(409, `Bewerten kannst du ab dem Gesprächstermin: ${germanDateTime(interview.scheduled_at)}.`);
    }
    const input = bodyOf(req);
    const rating = boundedInt(input.rating, 1, 5, null);
    if (!rating) throw fail(400, 'Bitte vergib eine Bewertung von 1 bis 5.');
    if (!Object.hasOwn(RECOMMENDATIONS, input.recommendation)) throw fail(400, 'Bitte wähle eine Empfehlung.');
    if (db.prepare('SELECT id FROM recruiting_feedback WHERE interview_id=? AND user_id=?').get(interview.id, actor.id)) {
      throw fail(409, 'Du hast dieses Gespräch bereits bewertet. Eine Änderung ist nicht möglich, damit die Bewertung unabhängig bleibt.');
    }
    const id = db.transaction(() => {
      const feedbackId = db.prepare(`
        INSERT INTO recruiting_feedback(interview_id,user_id,rating,strengths,concerns,recommendation,submitted_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        interview.id,
        actor.id,
        rating,
        cleanText(input.strengths, 4000) || null,
        cleanText(input.concerns, 4000) || null,
        input.recommendation,
        nowIso()
      ).lastInsertRowid;
      closeTasks(TASK.feedback, interview.id, actor.id);
      log(actor.id, 'recruiting_feedback_submitted', 'recruiting_feedback', feedbackId, null, { interviewId: interview.id });
      return feedbackId;
    })();
    res.json({ id });
  });

  // --- Routen: Angebote -------------------------------------------------------------------

  router.post('/recruiting/applications/:id/offers', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    requireManagingAccess(actor, application);
    requireActiveApplication(application);
    const open = db.prepare(`SELECT id FROM recruiting_offers WHERE application_id=? AND status NOT IN (${placeholders(INACTIVE_OFFER_STATUSES.length)})`)
      .get(application.id, ...INACTIVE_OFFER_STATUSES);
    if (open) throw fail(409, 'Zu dieser Bewerbung gibt es bereits ein Angebot.');
    const fields = readOfferFields(bodyOf(req), application);
    const timestamp = nowIso();
    const id = db.prepare(`
      INSERT INTO recruiting_offers(application_id,start_date,position_title,compensation,created_by,last_edited_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(application.id, fields.startDate, fields.positionTitle, fields.compensation, actor.id, actor.id, timestamp, timestamp).lastInsertRowid;
    // Die Vergütung gehört nicht ins Protokoll.
    log(actor.id, 'recruiting_offer_created', 'recruiting_offers', id, null, { applicationId: application.id, status: 'draft' });
    res.json({ id });
  });

  router.patch('/recruiting/offers/:id', (req, res) => {
    const actor = current(req);
    const { offer, application } = managedOffer(actor, req.params.id);
    requireActiveApplication(application);
    if (offer.status !== 'draft') throw fail(409, 'Nur ein Entwurf lässt sich ändern.');
    const fields = readOfferFields(bodyOf(req), application, offer);
    db.prepare('UPDATE recruiting_offers SET start_date=?,position_title=?,compensation=?,last_edited_by=?,updated_at=? WHERE id=?')
      .run(fields.startDate, fields.positionTitle, fields.compensation, actor.id, nowIso(), offer.id);
    log(actor.id, 'recruiting_offer_updated', 'recruiting_offers', offer.id, null, { compensationChanged: fields.compensation !== offer.compensation });
    res.json({ ok: true });
  });

  /** Wer das Angebot erstellt hat, kümmert sich weiter darum, solange die Person noch für die Stelle zuständig ist. */
  function offerOwnerId(offer, application) {
    const creator = db.prepare('SELECT id,role,active FROM users WHERE id=?').get(offer.created_by);
    const stillResponsible = creator?.active && (isHr(creator) || creator.id === application.hiring_manager_id);
    return stillResponsible ? creator.id : application.hiring_manager_id;
  }

  /** Nach der Freigabe ist wieder gefragt, wer das Angebot betreut: Die Antwort der Person kommt dort an. */
  function createOfferResponseTask(offer, application) {
    createTask(offerOwnerId(offer, application), `Antwort von ${application.candidate_name} zum Angebot eintragen: „${application.requisition_title}“`, TASK.offerResponse, application.id);
  }

  router.post('/recruiting/offers/:id/submit', (req, res) => {
    const actor = current(req);
    const { offer, application } = managedOffer(actor, req.params.id);
    requireActiveApplication(application);
    if (offer.status !== 'draft') throw fail(409, 'Nur ein Entwurf lässt sich zur Freigabe geben.');
    const offerRule = approvalRule('recruiting.offer');
    if (offerRule === 'none') {
      const timestamp = nowIso();
      db.transaction(() => {
        db.prepare("UPDATE recruiting_offers SET status='approved',approved_by=?,approved_at=?,approval_skipped=1,return_comment=NULL,updated_at=? WHERE id=?").run(actor.id, timestamp, timestamp, offer.id);
        closeTasks(TASK.offerReturned, application.id);
        createOfferResponseTask(offer, application);
        log(actor.id, 'recruiting_offer_approved', 'recruiting_offers', offer.id, { status: 'draft' }, { status: 'approved', withoutApproval: true });
      })();
      return res.json({ ok: true, approverCount: 0, status: 'approved' });
    }
    const approverIds = uninvolvedHrIds(application).filter(id => (
      offerRule !== 'four_eyes' || (id !== offer.created_by && id !== offer.last_edited_by)
    ));
    // Ohne freigebende Person bliebe das Angebot für immer liegen: Später hinzukommende HR-Personen bekommen keine Aufgabe.
    if (approverIds.length === 0) {
      throw fail(409, offerRule === 'four_eyes'
        ? 'Gerade kann niemand dieses Angebot freigeben: Nötig ist eine andere HR-Person als die, die es erstellt oder zuletzt geändert hat. Das Angebot bleibt ein Entwurf.'
        : 'Gerade kann niemand dieses Angebot freigeben, weil dafür keine HR-Person frei ist. Das Angebot bleibt ein Entwurf.');
    }
    db.transaction(() => {
      db.prepare("UPDATE recruiting_offers SET status='pending_approval',return_comment=NULL,updated_at=? WHERE id=?").run(nowIso(), offer.id);
      closeTasks(TASK.offerReturned, application.id);
      approverIds.forEach(id => createTask(id, `Angebot für ${application.candidate_name} freigeben: „${application.requisition_title}“`, TASK.offerApproval, application.id));
      log(actor.id, 'recruiting_offer_submitted', 'recruiting_offers', offer.id, { status: 'draft' }, { status: 'pending_approval' });
    })();
    res.json({ ok: true, approverCount: approverIds.length, status: 'pending_approval' });
  });

  router.post('/recruiting/offers/:id/approve', (req, res) => {
    const actor = current(req);
    const { offer, application, access } = managedOffer(actor, req.params.id);
    if (access !== 'hr') throw fail(403, 'Angebote gibt HR frei.');
    if (approvalRule('recruiting.offer') === 'four_eyes' && (offer.created_by === actor.id || offer.last_edited_by === actor.id)) {
      throw fail(403, 'Ein Angebot darf nicht von der Person freigegeben werden, die es erstellt oder zuletzt geändert hat.');
    }
    requireActiveApplication(application);
    if (offer.status !== 'pending_approval') throw fail(409, 'Dieses Angebot wartet nicht auf eine Freigabe.');
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare("UPDATE recruiting_offers SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=?").run(actor.id, timestamp, timestamp, offer.id);
      closeTasks(TASK.offerApproval, application.id);
      createOfferResponseTask(offer, application);
      log(actor.id, 'recruiting_offer_approved', 'recruiting_offers', offer.id, { status: 'pending_approval' }, { status: 'approved' });
    })();
    res.json({ ok: true });
  });

  router.post('/recruiting/offers/:id/return', (req, res) => {
    const actor = current(req);
    const { offer, application, access } = managedOffer(actor, req.params.id);
    if (access !== 'hr') throw fail(403, 'Angebote prüft HR.');
    requireActiveApplication(application);
    if (offer.status !== 'pending_approval') throw fail(409, 'Dieses Angebot wartet nicht auf eine Freigabe.');
    const comment = cleanText(bodyOf(req).comment, 1000);
    if (!comment) throw fail(400, 'Bitte schreibe kurz, was geändert werden soll.');
    db.transaction(() => {
      db.prepare("UPDATE recruiting_offers SET status='draft',return_comment=?,updated_at=? WHERE id=?").run(comment, nowIso(), offer.id);
      closeTasks(TASK.offerApproval, application.id);
      createTask(offerOwnerId(offer, application), `Angebot für ${application.candidate_name} überarbeiten: „${application.requisition_title}“`, TASK.offerReturned, application.id);
      log(actor.id, 'recruiting_offer_returned', 'recruiting_offers', offer.id, { status: 'pending_approval' }, { status: 'draft' });
    })();
    res.json({ ok: true });
  });

  router.post('/recruiting/offers/:id/response', (req, res) => {
    const actor = current(req);
    const { offer, application } = managedOffer(actor, req.params.id);
    requireActiveApplication(application);
    if (offer.status !== 'approved') throw fail(409, 'Eine Antwort lässt sich erst nach der Freigabe eintragen.');
    const { accepted } = bodyOf(req);
    if (typeof accepted !== 'boolean') throw fail(400, 'Bitte gib an, ob das Angebot angenommen wurde.');
    const status = accepted ? 'accepted' : 'declined';
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE recruiting_offers SET status=?,responded_by=?,responded_at=?,updated_at=? WHERE id=?').run(status, actor.id, timestamp, timestamp, offer.id);
      closeTasks(TASK.offerResponse, application.id);
      if (accepted) {
        const title = `${application.candidate_name} einstellen: „${application.requisition_title}“`;
        uninvolvedHrIds(application).forEach(id => createTask(id, title, TASK.hire, application.id, offer.start_date));
      }
      log(actor.id, accepted ? 'recruiting_offer_accepted' : 'recruiting_offer_declined', 'recruiting_offers', offer.id, { status: 'approved' }, { status });
    })();
    res.json({ ok: true, status });
  });

  // --- Routen: Interne Stellenbörse -------------------------------------------------------

  /** Wer an Gesprächen beteiligt ist, kennt Mitbewerbende und darf sich auf diese Stelle nicht bewerben. */
  function requisitionsWithInterviewsOf(userId) {
    return db.prepare(`
      SELECT DISTINCT a.requisition_id
      FROM recruiting_interview_participants p
      JOIN recruiting_interviews i ON i.id = p.interview_id
      JOIN recruiting_applications a ON a.id = i.application_id
      WHERE p.user_id=?
    `).all(userId).map(row => row.requisition_id);
  }

  /** Warum diese Person sich hier nicht bewerben kann. Ohne Grund fehlt der Knopf sonst kommentarlos. */
  function applyBlockedReason(job, actor, involvedRequisitions) {
    if (actor.role === 'super_admin') return 'Die Systemadministration kann sich nicht bewerben.';
    if (job.hiring_manager_id === actor.id) return 'Das ist deine eigene Stelle.';
    if (involvedRequisitions.includes(job.id)) {
      return 'Du bist an Gesprächen zu dieser Stelle beteiligt und kannst dich deshalb nicht bewerben. Möchtest du dich trotzdem bewerben, sprich bitte HR an.';
    }
    return null;
  }

  router.get('/recruiting/job-board', (req, res) => {
    const actor = current(req);
    const involvedRequisitions = requisitionsWithInterviewsOf(actor.id);
    const myApplications = db.prepare(`
      SELECT a.id, a.status, a.rejection_reason, a.created_at, a.requisition_id, r.title AS requisition_title, s.name AS stage_name
      FROM recruiting_applications a
      JOIN recruiting_candidates c ON c.id = a.candidate_id
      JOIN recruiting_requisitions r ON r.id = a.requisition_id
      JOIN recruiting_stages s ON s.id = a.stage_id
      WHERE c.user_id=?
      ORDER BY a.created_at DESC, a.id DESC
    `).all(actor.id);
    const jobs = db.prepare(`
      SELECT r.id, r.title, r.description, r.target_date, r.openings, r.hiring_manager_id, m.name AS hiring_manager_name, p.title AS position_title
      FROM recruiting_requisitions r
      JOIN users m ON m.id = r.hiring_manager_id
      LEFT JOIN position_profiles p ON p.id = r.position_profile_id
      WHERE r.status='open' AND r.internal_posting=1
      ORDER BY r.opened_at DESC, r.id DESC
    `).all();
    res.json({
      jobs: jobs.map(job => {
        const ownApplication = myApplications.find(application => application.requisition_id === job.id);
        const applied = Boolean(ownApplication);
        const blockedReason = applied ? null : applyBlockedReason(job, actor, involvedRequisitions);
        return {
          id: job.id,
          title: job.title,
          positionTitle: job.position_title || null,
          description: job.description,
          targetDate: job.target_date,
          openings: job.openings,
          contactName: job.hiring_manager_name,
          alreadyApplied: applied,
          applicationWithdrawn: ownApplication?.rejection_reason === WITHDRAWN_REASON,
          canApply: !applied && !blockedReason,
          applyBlockedReason: blockedReason
        };
      }),
      myApplications: myApplications.map(application => ({
        id: application.id,
        requisitionTitle: application.requisition_title,
        status: application.status,
        withdrawn: application.rejection_reason === WITHDRAWN_REASON,
        stageName: application.stage_name,
        appliedAt: application.created_at,
        canWithdraw: application.status === 'active'
      }))
    });
  });

  /**
   * Interne Bewerbung. Die eigene Führungskraft erfährt davon nichts: Nur HR bekommt eine Aufgabe.
   * Sichtbar ist die Bewerbung nur HR und der einstellenden Führungskraft.
   */
  router.post('/recruiting/job-board/:id/apply', (req, res) => {
    const actor = current(req);
    if (actor.role === 'super_admin') throw fail(403, 'Die Systemadministration kann sich nicht bewerben.');
    const id = idFrom(req.params.id);
    const requisition = id
      ? db.prepare("SELECT * FROM recruiting_requisitions WHERE id=? AND status='open' AND internal_posting=1").get(id)
      : null;
    if (!requisition) throw fail(404, 'Diese Stelle ist nicht (mehr) intern ausgeschrieben.');
    if (requisition.hiring_manager_id === actor.id) throw fail(400, 'Du kannst dich nicht auf deine eigene Stelle bewerben.');
    if (requisitionsWithInterviewsOf(actor.id).includes(requisition.id)) {
      throw fail(409, 'Du bist an Gesprächen zu dieser Stelle beteiligt und kannst dich deshalb nicht bewerben. Bitte sprich HR an.');
    }
    const input = bodyOf(req);
    const resumeUrl = readResumeUrl(input.resumeUrl);
    const resumeText = cleanText(input.resumeText, 20000) || null;
    const message = cleanText(input.message, 2000) || null;
    const person = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(actor.id);
    const applicationId = db.transaction(() => {
      const timestamp = nowIso();
      const existing = db.prepare('SELECT * FROM recruiting_candidates WHERE user_id=?').get(actor.id);
      let candidateId = existing?.id;
      if (existing) {
        db.prepare('UPDATE recruiting_candidates SET name=?,email=?,resume_text=COALESCE(?,resume_text),resume_url=COALESCE(?,resume_url),updated_at=? WHERE id=?')
          .run(person.name, person.email, resumeText, resumeUrl, timestamp, existing.id);
      } else {
        candidateId = insertCandidate({ name: person.name, email: person.email, source: 'Intern', resumeText, resumeUrl, userId: actor.id, actorId: actor.id });
        log(actor.id, 'recruiting_candidate_created', 'recruiting_candidates', candidateId);
      }
      const newApplicationId = createApplication({ requisition, candidateId, actorId: actor.id, message });
      closeTasksOfNewApplicant(actor.id, requisition.id);
      uninvolvedHrIds(loadApplication(newApplicationId))
        .forEach(hrId => createTask(hrId, `Neue interne Bewerbung von ${person.name}: ${requisition.title}`, TASK.internalApplication, newApplicationId));
      return newApplicationId;
    })();
    res.json({ id: applicationId });
  });

  router.post('/recruiting/job-board/applications/:id/withdraw', (req, res) => {
    const actor = current(req);
    const application = loadApplication(req.params.id);
    if (application.candidate_user_id !== actor.id) throw fail(403, 'Du kannst nur deine eigene Bewerbung zurückziehen.');
    requireActiveApplication(application);
    rejectApplication(application, { reason: WITHDRAWN_REASON, note: null, actorId: actor.id });
    res.json({ ok: true });
  });

  // --- Routen: Stufen, Einstellungen, Kennzahlen ------------------------------------------

  router.get('/recruiting/stages', (req, res) => {
    const actor = current(req);
    if (!canUseRecruiting(actor)) throw fail(403, 'Dieser Bereich ist Führungskräften und HR vorbehalten.');
    const includeInactive = isHr(actor) && req.query.includeInactive === 'true';
    const stages = includeInactive
      ? db.prepare('SELECT * FROM recruiting_stages ORDER BY active DESC,sort_order,id').all()
      : activeStages();
    res.json({ stages: stages.map(stageView) });
  });

  router.post('/recruiting/stages', (req, res) => {
    const actor = current(req);
    requireOrganizationSettingsRights(actor);
    const name = cleanText(bodyOf(req).name, 80);
    if (!name) throw fail(400, 'Bitte gib der Stufe einen Namen.');
    assertStageNameFree(name);
    const id = db.transaction(() => {
      const normalStages = activeStages().filter(stage => stage.kind === 'normal');
      const stageId = db.prepare('INSERT INTO recruiting_stages(name,kind,sort_order,created_at) VALUES(?,?,?,?)')
        .run(name, 'normal', normalStages.length + 1, nowIso()).lastInsertRowid;
      saveStageOrder([...normalStages, { id: stageId }]);
      log(actor.id, 'recruiting_stage_created', 'recruiting_stages', stageId, null, { name });
      return stageId;
    })();
    res.json({ id });
  });

  router.patch('/recruiting/stages/:id', (req, res) => {
    const actor = current(req);
    requireOrganizationSettingsRights(actor);
    const stage = loadStage(req.params.id);
    const input = bodyOf(req);
    const name = input.name === undefined ? stage.name : cleanText(input.name, 80);
    if (!name) throw fail(400, 'Bitte gib der Stufe einen Namen.');
    if (input.active !== undefined && typeof input.active !== 'boolean') throw fail(400, 'Bitte gib an, ob die Stufe aktiv ist.');
    const active = input.active === undefined ? Boolean(stage.active) : input.active;
    if (active) assertStageNameFree(name, stage.id);
    if (!active && stage.active) {
      if (stage.kind === 'hired') throw fail(409, 'Die Stufe „Eingestellt“ wird für den Abschluss gebraucht.');
      const inUse = db.prepare("SELECT COUNT(*) AS count FROM recruiting_applications WHERE stage_id=? AND status='active'").get(stage.id).count;
      if (inUse > 0) throw fail(409, 'In dieser Stufe liegen noch aktive Bewerbungen. Verschiebe sie zuerst.');
      if (activeStages().filter(item => item.kind === 'normal').length <= 1) throw fail(409, 'Mindestens eine Stufe muss aktiv bleiben.');
    }
    db.transaction(() => {
      db.prepare('UPDATE recruiting_stages SET name=?,active=? WHERE id=?').run(name, Number(active), stage.id);
      if (active !== Boolean(stage.active)) saveStageOrder(activeStages().filter(item => item.kind === 'normal'));
      log(actor.id, 'recruiting_stage_updated', 'recruiting_stages', stage.id, { name: stage.name, active: stage.active }, { name, active: Number(active) });
    })();
    res.json({ ok: true });
  });

  router.post('/recruiting/stages/:id/move', (req, res) => {
    const actor = current(req);
    requireOrganizationSettingsRights(actor);
    const stage = loadStage(req.params.id);
    const { direction } = bodyOf(req);
    if (!['up', 'down'].includes(direction)) throw fail(400, 'Bitte gib eine Richtung an.');
    if (stage.kind === 'hired') throw fail(409, 'Die Stufe „Eingestellt“ bleibt immer am Ende.');
    const normalStages = activeStages().filter(item => item.kind === 'normal');
    const index = normalStages.findIndex(item => item.id === stage.id);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= normalStages.length) throw fail(409, 'Diese Stufe lässt sich nicht weiter verschieben.');
    [normalStages[index], normalStages[target]] = [normalStages[target], normalStages[index]];
    db.transaction(() => {
      saveStageOrder(normalStages);
      log(actor.id, 'recruiting_stage_moved', 'recruiting_stages', stage.id, null, { direction });
    })();
    res.json({ ok: true });
  });

  router.get('/recruiting/settings', (req, res) => {
    const actor = current(req);
    requireHr(actor, 'Die Einstellungen sieht nur HR.');
    res.json({
      settings: {
        retentionMonths: retentionMonths(),
        minRetentionMonths: MIN_RETENTION_MONTHS,
        maxRetentionMonths: MAX_RETENTION_MONTHS
      },
      canManage: managesOrganizationSettings(actor)
    });
  });

  router.patch('/recruiting/settings', (req, res) => {
    const actor = current(req);
    requireOrganizationSettingsRights(actor);
    const input = bodyOf(req);
    const months = boundedInt(input.retentionMonths, MIN_RETENTION_MONTHS, MAX_RETENTION_MONTHS, null);
    if (!months) throw fail(400, `Die Frist muss zwischen ${MIN_RETENTION_MONTHS} und ${MAX_RETENTION_MONTHS} Monaten liegen.`);
    const before = retentionMonths();
    // Eine kürzere Frist kann sofort wirken. Was danach anonymisiert ist, lässt sich nicht zurückholen.
    const affected = months < before ? candidatesDueForAnonymization(months).length : 0;
    if (affected > 0 && input.confirmAnonymization !== true) {
      const people = affected === 1 ? '1 Person wird' : `${affected} Personen werden`;
      throw fail(409, `Mit dieser Frist gilt sie für abgesagte Bewerbende schon als abgelaufen: ${people} bei der nächsten Wartung endgültig anonymisiert.`, {
        code: 'retention_confirmation_needed',
        affected
      });
    }
    db.prepare('UPDATE recruiting_settings SET retention_months=?,updated_by=?,updated_at=? WHERE id=1').run(months, actor.id, nowIso());
    log(actor.id, 'recruiting_settings_updated', 'recruiting_settings', 1, { retentionMonths: before }, { retentionMonths: months });
    res.json({ ok: true, retentionMonths: months });
  });

  router.get('/recruiting/metrics', (req, res) => {
    requireHr(current(req), 'Die Kennzahlen sieht nur HR.');
    const statusCounts = db.prepare('SELECT status, COUNT(*) AS count FROM recruiting_requisitions GROUP BY status').all();
    const countOf = status => statusCounts.find(row => row.status === status)?.count || 0;
    const stageCounts = db.prepare(`
      SELECT s.id, s.name, COUNT(a.id) AS count
      FROM recruiting_stages s
      LEFT JOIN recruiting_applications a ON a.stage_id = s.id AND a.status <> 'rejected'
      WHERE s.active = 1
      GROUP BY s.id, s.name, s.sort_order
      ORDER BY s.sort_order, s.id
    `).all();
    const filled = db.prepare("SELECT opened_at, filled_at FROM recruiting_requisitions WHERE status='filled' AND opened_at IS NOT NULL AND filled_at IS NOT NULL").all();
    const durations = filled.map(row => (Date.parse(row.filled_at) - Date.parse(row.opened_at)) / DAY_IN_MS);
    res.json({
      openRequisitions: countOf('open'),
      pendingApproval: countOf('pending_approval'),
      applicationsByStage: stageCounts.map(row => ({ stageId: row.id, name: row.name, count: row.count })),
      timeToFill: {
        filledCount: durations.length,
        averageDays: durations.length
          ? Math.round((durations.reduce((sum, days) => sum + days, 0) / durations.length) * 10) / 10
          : null
      }
    });
  });

  router.use('/recruiting', (error, req, res, next) => {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: error.message, ...(error.extra || {}) });
    }
    next(error);
  });

  const helpArticles = [
    {
      id: 'recruiting-job-board',
      title: 'Interne Stellenbörse',
      roles: ALL_ROLES,
      views: ['recruitingBoard'],
      keywords: ['stellenbörse', 'interne stelle', 'bewerben', 'interne bewerbung', 'neue stelle', 'wechsel'],
      answer: 'In der Stellenbörse siehst du offene, intern ausgeschriebene Stellen und kannst dich direkt bewerben. Deine Führungskraft erfährt das nicht automatisch: Sehen können die Bewerbung nur HR, die einstellende Führungskraft der Stelle und wer für ein Gespräch eingeteilt ist.',
      steps: ['Öffne „Stellenbörse“ unter „Meine Arbeit“.', 'Wähle eine Stelle und klicke auf „Bewerben“.', 'Den Stand deiner Bewerbung siehst du auf derselben Seite. Dort kannst du sie auch zurückziehen.'],
      actions: [{ label: 'Stellenbörse öffnen', view: 'recruitingBoard' }]
    },
    {
      id: 'recruiting-requisition',
      title: 'Eine Stelle anfordern',
      roles: LEAD_AND_HR_ROLES,
      views: ['recruitingHome', 'recruitingRequisition'],
      keywords: ['stelle anfordern', 'stellenanforderung', 'neue stelle', 'freigabe stelle', 'recruiting'],
      answer: 'Führungskräfte fordern Stellen für ihren Bereich an. Je nach Regel deiner Organisation gibt HR sie frei, oder sie ist sofort offen. Erst dann kann sie Bewerbungen aufnehmen. Mit dem Kennzeichen „intern ausschreiben“ erscheint sie auch in der Stellenbörse.',
      steps: ['Öffne „Recruiting“ und klicke auf „Stelle anfordern“.', 'Fülle Titel, Anzahl und Beschreibung aus.', 'Reiche die Stelle zur Freigabe ein oder öffne sie, wenn bei euch keine Freigabe nötig ist.'],
      actions: [{ label: 'Recruiting öffnen', view: 'recruitingHome' }]
    },
    {
      id: 'recruiting-application-flow',
      title: 'Bewerbungen durch die Stufen führen',
      roles: LEAD_AND_HR_ROLES,
      views: ['recruitingRequisition', 'recruitingApplication'],
      keywords: ['bewerbung', 'stufe', 'kanban', 'verschieben', 'absage', 'absagetext', 'gespräch planen'],
      answer: 'In der Spaltenansicht einer Stelle verschiebst du Bewerbungen mit den Pfeilen. Über „Öffnen“ planst du Gespräche, erstellst ein Angebot oder sagst ab. Daybreak versendet keine E-Mails: Den Absagetext kopierst du in dein E-Mail-Programm.',
      steps: ['Öffne die Stelle.', 'Verschiebe die Bewerbung oder öffne sie.', 'Plane ein Gespräch oder trage die Absage ein.'],
      actions: [{ label: 'Recruiting öffnen', view: 'recruitingHome' }]
    },
    {
      id: 'recruiting-feedback',
      title: 'Ein Gespräch bewerten',
      roles: ALL_ROLES,
      views: ['recruitingInterviews', 'recruitingInterview', 'dashboard'],
      keywords: ['gespräch bewerten', 'interview', 'bewertung', 'feedback bewerbung', 'unabhängig'],
      answer: 'Wenn du einem Gespräch zugewiesen bist, bekommst du eine Aufgabe und bewertest die Person ab dem Gesprächstermin von 1 bis 5. Fremde Bewertungen siehst du erst nach deiner eigenen, auch als HR oder einstellende Führungskraft. So bleibt jede Einschätzung unabhängig. Abgegebene Bewertungen lassen sich nicht mehr ändern.',
      steps: ['Öffne die Aufgabe in der Übersicht oder den Reiter „Meine Gespräche“.', 'Vergib Bewertung, Stärken, Bedenken und Empfehlung.', 'Sende die Bewertung ab.'],
      actions: [{ label: 'Meine Gespräche', view: 'recruitingInterviews' }]
    },
    {
      id: 'recruiting-offer-hire',
      title: 'Angebot und Einstellung',
      roles: LEAD_AND_HR_ROLES,
      views: ['recruitingApplication'],
      keywords: ['angebot', 'freigabe angebot', 'einstellen', 'einstellung', 'temporäres passwort', 'vier augen'],
      answer: 'Wer ein Angebot freigibt, legt deine Organisation in ihren Regeln fest: HR, nie die Person, die es erstellt hat (vier Augen), HR auch beim eigenen Angebot oder gar niemand. Nach der Annahme stellt HR die Person ein und wählt dabei die Rolle. Daybreak legt dann das Konto an, zeigt das temporäre Passwort genau einmal und übernimmt das Eintrittsdatum in die Personalakte, wenn das Modul an ist.',
      steps: ['Erstelle das Angebot in der Bewerbung und gib es zur Freigabe oder stelle es fertig.', 'Trage danach die Antwort der Person ein.', 'HR klickt nach der Annahme auf „Einstellen“ und gibt das Passwort zum Eintritt persönlich weiter.'],
      actions: [{ label: 'Recruiting öffnen', view: 'recruitingHome' }]
    },
    {
      id: 'recruiting-privacy',
      title: 'Aufbewahrung und Anonymisierung',
      roles: HR_ROLES,
      views: ['recruitingCandidates', 'recruitingSettings'],
      keywords: ['datenschutz', 'anonymisieren', 'löschen', 'aufbewahrung', 'talentpool', 'einwilligung', 'frist'],
      answer: 'Abgesagte Bewerbende werden nach der eingestellten Frist automatisch und endgültig anonymisiert, außer es liegt eine gültige Einwilligung für den Talentpool vor. HR kann auch sofort anonymisieren. Die Frist ändert nur die HR-Administration. Hinweis, bitte im Einzelfall prüfen: Welche Frist für euch passt, hängt von euren Regelungen ab.',
      steps: ['Die HR-Administration legt die Frist im Reiter „Einstellungen“ fest.', 'Pflege die Einwilligung bei der jeweiligen Person.', 'Anonymisiere bei Bedarf einzeln unter „Bewerbende“.'],
      actions: [{ label: 'Einstellungen öffnen', view: 'recruitingSettings' }]
    }
  ];

  return { router, initialize, seedDemo, maintenance, helpArticles };
}

module.exports = { createRecruitingModule };
