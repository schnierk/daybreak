const crypto = require('crypto');
const express = require('express');
const { createCoreHelpers } = require('../lib/core-helpers');

const CYCLE_STATUSES = new Set(['draft', 'nomination', 'open', 'evaluation', 'completed', 'archived']);
const PARTICIPANT_STATUSES = new Set(['planned', 'nominating', 'feedback_open', 'in_evaluation', 'completed', 'cancelled']);
const NOMINATION_STATUSES = new Set(['proposed', 'approved', 'rejected', 'invited', 'started', 'submitted', 'declined']);
const FEEDBACK_GROUPS = new Set(['self', 'manager', 'peer', 'direct_report', 'stakeholder']);
const QUESTION_TYPES = new Set(['rating', 'text']);
const RESULT_STATUSES = new Set(['pending', 'calculated', 'reviewed', 'released_for_manager', 'released_for_employee', 'closed']);
const DEVELOPMENT_ACTIONS = new Set(['development_goal', 'coaching', 'mentoring', 'training', 'job_shadowing', 'project_assignment', 'job_rotation', 'follow_up_feedback']);

const NAMED_GROUPS = ['self', 'manager'];
const ANONYMOUS_GROUPS = ['peer', 'direct_report', 'stakeholder'];
const RELEASED_FOR_MANAGER = ['released_for_manager', 'released_for_employee', 'closed'];
const RELEASED_FOR_EMPLOYEE = ['released_for_employee', 'closed'];
const NEXT_RESULT_STATUS = { calculated: 'reviewed', reviewed: 'released_for_manager', released_for_manager: 'released_for_employee', released_for_employee: 'closed' };
const CYCLE_TRANSITIONS = { draft: ['nomination', 'archived'], nomination: ['open', 'archived'], open: ['nomination', 'evaluation', 'archived'], evaluation: ['completed', 'archived'], completed: ['archived'] };
const RUNNING_CYCLE_STATUSES = ['nomination', 'open'];
const RESULT_PHASES = ['evaluation', 'completed'];
const CONTACTED_NOMINATIONS = ['invited', 'started', 'submitted', 'declined'];
// Solange niemand eine Antwort begonnen hat, gibt es nichts, was einer bestimmten Person gehört.
const UNTOUCHED_NOMINATIONS = ['proposed', 'approved', 'invited'];

const DEMO_RUNNING_DESCRIPTIONS = ['Laufende Beispielrunde zum Ausprobieren.', 'Aktiver, entwicklungsorientierter Feedbackzyklus der Demo.'];
const DEMO_FINISHED_DESCRIPTIONS = ['Abgeschlossene Beispielrunde mit freigegebenem Bericht.', 'Abgeschlossener Demo-Zyklus mit freigegebenem Ergebnisbericht.'];
const DEMO_COMMENTS = {
  self: 'Ich möchte früher um Rückmeldung bitten und das auch im Alltag beibehalten.',
  manager: 'Behalte bei, wie klar du Entscheidungen erklärst und andere früh einbindest.',
  peer: [
    'Du hörst gut zu und fragst nach, wenn etwas unklar ist. Das hilft uns allen.',
    'Deine Übergaben sind gut vorbereitet, darauf kann ich mich verlassen.',
    'Du teilst dein Wissen gern und ohne Umwege. Bitte unbedingt beibehalten.'
  ]
};

// Je Frage die Noten von Selbsteinschätzung, Führungskraft und drei Kolleg:innen.
const DEMO_RATINGS = [[4, 4, 5, 4, 5], [4, 3, 4, 4, 3], [3, 3, 3, 4, 3], [5, 5, 5, 5, 4], [4, 4, 3, 3, 4], [3, 4, 4, 5, 4], [5, 4, 4, 4, 5]];

const SECOND_PERSON_EXCEPTIONS = new Map([['ist', 'bist'], ['wird', 'wirst'], ['muss', 'musst'], ['weiß', 'weißt']]);
const VERBS_WITHOUT_T = new Set(['kann', 'soll', 'will', 'darf', 'mag', 'sollte', 'könnte', 'würde', 'möchte', 'müsste', 'dürfte', 'wollte', 'konnte', 'musste', 'durfte']);
const WORDS_ENDING_IN_T = new Set(['nicht', 'selbst', 'jetzt', 'oft', 'gut', 'stets', 'erst', 'zuletzt', 'bereit', 'weit', 'damit', 'meist']);
// Wen „sie“, „ihre“ oder „sich“ meint und welcher Fall gilt, lässt sich nicht sicher erkennen. Lieber bleibt die Frage, wie sie ist.
const AMBIGUOUS_REFERENCE = /(?:^|[\s(])(?:sich|sie|er|ihn|ihm|ihr\p{L}*|sein\p{L}*)(?=[\s.,;:!?)]|$)/iu;
const OWN_PHRASES = [
  [/\bdie eigene\b/g, 'deine eigene'],
  [/\bdie eigenen\b/g, 'deine eigenen'],
  [/\bden eigenen\b/g, 'deinen eigenen'],
  [/\bdem eigenen\b/g, 'deinem eigenen'],
  [/\bder eigenen\b/g, 'deiner eigenen'],
  [/\bdes eigenen\b/g, 'deines eigenen'],
  [/\bdas eigene\b/g, 'dein eigenes']
];

const INTERNAL_ERROR = 'Das hat gerade nicht geklappt. Bitte versuche es gleich noch einmal.';
const DAY_IN_MS = 86400000;

/** Ein Problem, dessen Text für die Person bestimmt ist. Alles andere bleibt im Serverprotokoll. */
class FeedbackProblem extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const looksLikeVerb = word => SECOND_PERSON_EXCEPTIONS.has(word) || VERBS_WITHOUT_T.has(word) || (word.endsWith('t') && !WORDS_ENDING_IN_T.has(word));

/** hört wird zu hörst, arbeitet zu arbeitest, kann zu kannst. Bei setzt oder heißt ändert sich nichts. */
function secondPersonVerb(verb) {
  if (SECOND_PERSON_EXCEPTIONS.has(verb)) return SECOND_PERSON_EXCEPTIONS.get(verb);
  if (/[sßxz]t$/.test(verb)) return verb;
  return verb.endsWith('t') ? `${verb.slice(0, -1)}st` : `${verb}st`;
}

/**
 * Die Du-Form einer Frage für die Selbsteinschätzung. Gespeichert bleibt die Frage für alle anderen.
 * Passt sie in kein sicheres Muster, kommt null zurück: besser die dritte Person als falsches Deutsch.
 */
function selfWording(questionText) {
  const statement = questionText.match(/^Die Person (\p{Ll}+)(?=[\s.,;:!?]|$)(.*)$/su);
  const question = questionText.match(/^(W\p{Ll}+|Inwie\p{Ll}+)((?: \p{Lu}\p{L}*)?) (\p{Ll}+) die Person(?=[\s.,;:!?]|$)(.*)$/su);
  let wording = null;
  if (statement && looksLikeVerb(statement[1])) wording = `Du ${secondPersonVerb(statement[1])}${statement[2]}`;
  else if (question && looksLikeVerb(question[3])) wording = `${question[1]}${question[2]} ${secondPersonVerb(question[3])} du${question[4]}`;
  if (!wording || /\bPerson\b/.test(wording) || AMBIGUOUS_REFERENCE.test(wording)) return null;
  return OWN_PHRASES.reduce((text, [phrase, replacement]) => text.replace(phrase, replacement), wording);
}

function respondToFailure(res, error) {
  if (error instanceof FeedbackProblem) return res.status(error.status).json({ error: error.message });
  console.error('360° Feedback: interner Fehler', error);
  return res.status(500).json({ error: INTERNAL_ERROR });
}

function createFeedbackModule(deps) {
  const { db, auth, current, isHr, canViewEmployee, cleanText, validDate, log, createTask } = deps;
  // Nicht jeder Aufrufer gibt diese Bausteine mit. Die Regeln selbst gelten trotzdem immer.
  const { hrCanAccess, blocksSelfEdit } = deps.hrCanAccess && deps.blocksSelfEdit ? deps : createCoreHelpers(db);

  const router = express.Router();
  const now = () => new Date().toISOString();
  const today = () => now().slice(0, 10);
  const daysFromToday = days => new Date(Date.now() + days * DAY_IN_MS).toISOString().slice(0, 10);
  const germanDate = value => String(value).slice(0, 10).split('-').reverse().join('.');
  const text = (value, max = 4000) => cleanText(value, max);
  const bool = value => value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
  const bodyOf = req => req.body || {};
  const asId = value => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const rating = value => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : null;
  };
  const byGermanName = (a, b) => String(a.name).localeCompare(String(b.name), 'de');
  const sum = values => values.reduce((total, value) => total + value, 0);
  const rounded = value => Number(value.toFixed(2));
  const userById = id => db.prepare('SELECT id,name,email,role,title,manager_id,active,is_system_account FROM users WHERE id=?').get(id);
  const cycleById = id => db.prepare('SELECT * FROM feedback_cycles WHERE id=?').get(id);
  const questionnaireById = id => db.prepare('SELECT * FROM feedback_questionnaires WHERE id=?').get(id);
  const dueState = dueDate => {
    if (!dueDate) return 'open';
    if (dueDate < today()) return 'overdue';
    return dueDate <= daysFromToday(7) ? 'due_soon' : 'open';
  };

  function ensureColumn(table, column, definition) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_questionnaires (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        parent_questionnaire_id INTEGER REFERENCES feedback_questionnaires(id), active INTEGER NOT NULL DEFAULT 1, frozen INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS feedback_questionnaire_sections (
        id INTEGER PRIMARY KEY, questionnaire_id INTEGER NOT NULL REFERENCES feedback_questionnaires(id), title TEXT NOT NULL, description TEXT,
        display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(questionnaire_id, display_order)
      );
      CREATE TABLE IF NOT EXISTS feedback_questions (
        id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL REFERENCES feedback_questionnaire_sections(id), question_text TEXT NOT NULL,
        question_type TEXT NOT NULL CHECK(question_type IN ('rating','text','yes_no','multiple_choice')), required INTEGER NOT NULL DEFAULT 1,
        display_order INTEGER NOT NULL DEFAULT 0, competency_id INTEGER REFERENCES competencies(id), help_text TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(section_id, display_order)
      );
      CREATE TABLE IF NOT EXISTS feedback_cycles (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        nomination_deadline TEXT NOT NULL, feedback_deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft','nomination','open','evaluation','completed','archived')),
        questionnaire_id INTEGER NOT NULL REFERENCES feedback_questionnaires(id), anonymous_minimum INTEGER NOT NULL DEFAULT 3 CHECK(anonymous_minimum >= 3),
        created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(end_date >= start_date), CHECK(nomination_deadline >= start_date), CHECK(feedback_deadline >= nomination_deadline), CHECK(feedback_deadline <= end_date)
      );
      CREATE TABLE IF NOT EXISTS feedback_cycle_participants (
        id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES feedback_cycles(id), employee_id INTEGER NOT NULL REFERENCES users(id),
        manager_id INTEGER REFERENCES users(id), status TEXT NOT NULL DEFAULT 'planned'
          CHECK(status IN ('planned','nominating','feedback_open','in_evaluation','completed','cancelled')),
        nomination_completed INTEGER NOT NULL DEFAULT 0, feedback_completed INTEGER NOT NULL DEFAULT 0, result_released INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(cycle_id, employee_id)
      );
      CREATE TABLE IF NOT EXISTS feedback_nominations (
        id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL REFERENCES feedback_cycle_participants(id), giver_id INTEGER NOT NULL REFERENCES users(id),
        feedback_group TEXT NOT NULL CHECK(feedback_group IN ('self','manager','peer','direct_report','stakeholder')),
        proposed_by INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'proposed'
          CHECK(status IN ('proposed','approved','rejected','invited','started','submitted','declined')),
        rejection_reason TEXT, confirmed_by INTEGER REFERENCES users(id), confirmed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(participant_id, giver_id, feedback_group)
      );
      CREATE TABLE IF NOT EXISTS feedback_invitations (
        id INTEGER PRIMARY KEY, nomination_id INTEGER NOT NULL UNIQUE REFERENCES feedback_nominations(id), participant_id INTEGER NOT NULL REFERENCES feedback_cycle_participants(id),
        giver_id INTEGER NOT NULL REFERENCES users(id), feedback_group TEXT NOT NULL CHECK(feedback_group IN ('self','manager','peer','direct_report','stakeholder')),
        status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','started','submitted','declined')),
        invited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TEXT, submitted_at TEXT, declined_at TEXT, reopened_at TEXT, reopened_by INTEGER REFERENCES users(id),
        UNIQUE(participant_id, giver_id, feedback_group)
      );
      CREATE TABLE IF NOT EXISTS feedback_responses (
        id INTEGER PRIMARY KEY, invitation_id INTEGER NOT NULL REFERENCES feedback_invitations(id), question_id INTEGER NOT NULL REFERENCES feedback_questions(id),
        numeric_value INTEGER CHECK(numeric_value BETWEEN 1 AND 5), text_value TEXT, not_applicable INTEGER NOT NULL DEFAULT 0, draft INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, submitted_at TEXT,
        UNIQUE(invitation_id, question_id),
        CHECK((numeric_value IS NULL OR text_value IS NULL) OR numeric_value IS NULL)
      );
      CREATE TABLE IF NOT EXISTS feedback_result_statuses (
        id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL UNIQUE REFERENCES feedback_cycle_participants(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','calculated','reviewed','released_for_manager','released_for_employee','closed')),
        calculated_at TEXT, reviewed_at TEXT, released_for_manager_at TEXT, released_for_employee_at TEXT, closed_at TEXT,
        updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS feedback_development_actions (
        id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL REFERENCES feedback_cycle_participants(id), action_type TEXT NOT NULL
          CHECK(action_type IN ('development_goal','coaching','mentoring','training','job_shadowing','project_assignment','job_rotation','follow_up_feedback')),
        description TEXT NOT NULL, competency_id INTEGER REFERENCES competencies(id), responsible_id INTEGER REFERENCES users(id), target_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')), linked_goal_id INTEGER REFERENCES goals(id),
        created_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS feedback_history (
        id INTEGER PRIMARY KEY, participant_id INTEGER REFERENCES feedback_cycle_participants(id), cycle_id INTEGER REFERENCES feedback_cycles(id),
        actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_cycles_status ON feedback_cycles(status, feedback_deadline);
      CREATE INDEX IF NOT EXISTS idx_feedback_participants_cycle ON feedback_cycle_participants(cycle_id, status);
      CREATE INDEX IF NOT EXISTS idx_feedback_nominations_participant ON feedback_nominations(participant_id, status);
      CREATE INDEX IF NOT EXISTS idx_feedback_invitations_giver ON feedback_invitations(giver_id, status);
      CREATE INDEX IF NOT EXISTS idx_feedback_responses_invitation ON feedback_responses(invitation_id, question_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_results_participant ON feedback_result_statuses(participant_id, status);
    `);
    ensureColumn('tasks', 'entity_id', 'INTEGER');
    ensureColumn('users', 'is_system_account', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('feedback_result_statuses', 'meeting_completed_at', 'TEXT');
    ensureColumn('feedback_result_statuses', 'meeting_completed_by', 'INTEGER REFERENCES users(id)');
    catchUpManagerChanges();
  }

  function history(actor, action, { participantId = null, cycleId = null, metadata = null } = {}) {
    const safeMetadata = metadata ? JSON.stringify(metadata) : null;
    db.prepare('INSERT INTO feedback_history(participant_id,cycle_id,actor_id,action,metadata) VALUES(?,?,?,?,?)').run(participantId, cycleId, actor?.id || null, action, safeMetadata);
    log(actor?.id || null, action, participantId ? 'feedback_cycle_participants' : 'feedback_cycles', participantId || cycleId || null, null, metadata || null);
  }

  // ------------------------------------------------------------------ Aufgaben

  function task(userId, title, type, entityId, dueDate = null) {
    if (!userId) return;
    const exists = db.prepare('SELECT id FROM tasks WHERE user_id=? AND type=? AND entity_id=? AND done=0').get(userId, type, entityId);
    if (!exists) createTask(userId, title, type, entityId, dueDate);
  }

  function closeTasks(type, entityId, userId = null) {
    if (userId) db.prepare('UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND user_id=? AND done=0').run(type, entityId, userId);
    else db.prepare('UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND done=0').run(type, entityId);
  }

  const PARTICIPANTS_OF_CYCLE = 'SELECT id FROM feedback_cycle_participants WHERE cycle_id=?';
  const CYCLE_TASK_TARGETS = {
    feedback_submit: 'SELECT i.id FROM feedback_invitations i JOIN feedback_cycle_participants p ON p.id=i.participant_id WHERE p.cycle_id=?',
    feedback_nomination_review: 'SELECT n.id FROM feedback_nominations n JOIN feedback_cycle_participants p ON p.id=n.participant_id WHERE p.cycle_id=?',
    feedback_nominate: PARTICIPANTS_OF_CYCLE,
    feedback_result_review: PARTICIPANTS_OF_CYCLE,
    feedback_result_meeting: PARTICIPANTS_OF_CYCLE,
    feedback_result: PARTICIPANTS_OF_CYCLE
  };

  function closeCycleTasks(cycleId, types) {
    let closed = 0;
    for (const type of types) {
      closed += db.prepare(`UPDATE tasks SET done=1 WHERE type=? AND done=0 AND entity_id IN (${CYCLE_TASK_TARGETS[type]})`).run(type, cycleId).changes;
    }
    return closed;
  }

  function refreshTaskDeadlines(cycle) {
    const setDue = (type, dueDate) => db.prepare(`UPDATE tasks SET due_date=? WHERE type=? AND done=0 AND entity_id IN (${CYCLE_TASK_TARGETS[type]})`).run(dueDate, type, cycle.id);
    setDue('feedback_submit', cycle.feedback_deadline);
    setDue('feedback_nominate', cycle.nomination_deadline);
    setDue('feedback_nomination_review', cycle.nomination_deadline);
  }

  const nominateTaskTitle = cycleName => `Personen für dein 360° Feedback „${cycleName}“ vorschlagen`;
  const meetingTaskTitle = employeeName => `Ergebnisgespräch mit ${employeeName} vorbereiten (360° Feedback)`;
  const submitTaskTitle = (giverId, employeeId, employeeName) => (giverId === employeeId
    ? 'Deine Selbsteinschätzung im 360° Feedback abgeben'
    : `360° Feedback für ${employeeName} abgeben`);

  // ------------------------------------------------------------------ Fragebögen

  function questionnaireUsed(questionnaireId) {
    return !!db.prepare('SELECT id FROM feedback_cycles WHERE questionnaire_id=? LIMIT 1').get(questionnaireId);
  }

  function questionnaireLocked(questionnaire) {
    return !questionnaire || !!questionnaire.frozen || questionnaireUsed(questionnaire.id);
  }

  function questionnaireDetails(questionnaireId, includeInactive = false) {
    const questionnaire = questionnaireById(questionnaireId);
    if (!questionnaire) return null;
    const sections = db.prepare('SELECT * FROM feedback_questionnaire_sections WHERE questionnaire_id=? ORDER BY display_order,id').all(questionnaireId);
    const questions = db.prepare(`SELECT q.*,c.name competency_name FROM feedback_questions q LEFT JOIN competencies c ON c.id=q.competency_id
      WHERE q.section_id IN (SELECT id FROM feedback_questionnaire_sections WHERE questionnaire_id=?) ${includeInactive ? '' : 'AND q.active=1'}
      ORDER BY q.display_order,q.id`).all(questionnaireId);
    return {
      ...questionnaire,
      used: questionnaireUsed(questionnaireId),
      sections: sections.map(section => ({
        ...section,
        questions: questions
          .filter(question => question.section_id === section.id)
          .map(question => ({ ...question, self_question_text: selfWording(question.question_text) }))
      }))
    };
  }

  function nextDisplayOrder(table, scopeColumn, scopeId) {
    return db.prepare(`SELECT COALESCE(MAX(display_order),0)+1 next_order FROM ${table} WHERE ${scopeColumn}=?`).get(scopeId).next_order;
  }

  /** Tauscht den Platz mit dem Nachbarn. Der Zwischenwert ist nötig, weil jeder Platz nur einmal vergeben sein darf. */
  function moveInOrder(table, scopeColumn, row, direction) {
    const neighbour = db.prepare(`SELECT id,display_order FROM ${table} WHERE ${scopeColumn}=? AND display_order ${direction === 'up' ? '<' : '>'} ? ORDER BY display_order ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1`).get(row[scopeColumn], row.display_order);
    if (!neighbour) return false;
    db.transaction(() => {
      const setOrder = db.prepare(`UPDATE ${table} SET display_order=?,updated_at=? WHERE id=?`);
      setOrder.run(-row.id, now(), row.id);
      setOrder.run(row.display_order, now(), neighbour.id);
      setOrder.run(neighbour.display_order, now(), row.id);
    })();
    return true;
  }

  function questionWithQuestionnaire(questionId) {
    return db.prepare('SELECT q.*,s.questionnaire_id FROM feedback_questions q JOIN feedback_questionnaire_sections s ON s.id=q.section_id WHERE q.id=?').get(questionId);
  }

  function validCompetency(competencyId) {
    return !competencyId || !!db.prepare('SELECT id FROM competencies WHERE id=? AND active=1').get(competencyId);
  }

  // ------------------------------------------------------------------ Teilnahmen und Rechte

  // Die Führungskraft kommt immer aus der Personenakte, damit Rechte nach einem Wechsel sofort stimmen.
  const PARTICIPANT_QUERY = `SELECT p.id,p.cycle_id,p.employee_id,e.manager_id,p.status,p.nomination_completed,p.feedback_completed,p.result_released,p.created_at,p.updated_at,
    c.name cycle_name,c.status cycle_status,c.questionnaire_id,c.feedback_deadline,c.nomination_deadline,c.anonymous_minimum,
    e.name employee_name,e.title employee_title,m.name manager_name,
    r.status result_status,r.calculated_at,r.reviewed_at,r.released_for_manager_at,r.released_for_employee_at,r.closed_at,r.meeting_completed_at
    FROM feedback_cycle_participants p
    JOIN feedback_cycles c ON c.id=p.cycle_id
    JOIN users e ON e.id=p.employee_id
    LEFT JOIN users m ON m.id=e.manager_id
    LEFT JOIN feedback_result_statuses r ON r.participant_id=p.id`;

  const participantDetails = participantId => db.prepare(`${PARTICIPANT_QUERY} WHERE p.id=?`).get(participantId);
  const isEmployee = (actor, participant) => actor.id === participant.employee_id;
  const isCurrentManager = (actor, participant) => !!participant.manager_id && actor.id === participant.manager_id;

  /** Namen und Zeitpunkte sieht nur HR. Wer selbst Feedback bekommt, sieht sie nie, auch als HR nicht. */
  function hrSeesDetails(actor, participant) {
    return isHr(actor) && !isEmployee(actor, participant) && hrCanAccess(actor, participant.employee_id);
  }

  function hrManages(actor, participant) {
    return isHr(actor) && hrCanAccess(actor, participant.employee_id) && !blocksSelfEdit(actor, participant.employee_id);
  }

  function canManageParticipant(actor, participant) {
    return hrManages(actor, participant) || isCurrentManager(actor, participant);
  }

  function canSeeParticipant(actor, participant) {
    return isEmployee(actor, participant) || isCurrentManager(actor, participant) || hrSeesDetails(actor, participant) || canViewEmployee(actor, participant.employee_id);
  }

  function canEditNominations(actor, participant) {
    return isEmployee(actor, participant) || canManageParticipant(actor, participant);
  }

  function canReadResult(actor, participant, resultState) {
    const calculated = !!resultState && resultState !== 'pending';
    // Erlaubt die Organisation HR die eigenen Vorgänge, muss sie den eigenen Bericht zum Freigeben lesen können. Namen sieht sie trotzdem nicht.
    if (isEmployee(actor, participant)) return RELEASED_FOR_EMPLOYEE.includes(resultState) || (hrManages(actor, participant) && calculated);
    if (hrSeesDetails(actor, participant)) return calculated;
    return isCurrentManager(actor, participant) && RELEASED_FOR_MANAGER.includes(resultState);
  }

  function participantPermissions(actor, participant) {
    const canPropose = cycleCanNominate(participant) && canEditNominations(actor, participant);
    return {
      proposeNominations: canPropose,
      finishNominating: canPropose && isEmployee(actor, participant) && !participant.nomination_completed,
      decideNominations: canManageParticipant(actor, participant) && RUNNING_CYCLE_STATUSES.includes(participant.cycle_status),
      proposeStakeholder: hrManages(actor, participant),
      readResult: canReadResult(actor, participant, participant.result_status),
      calculateResult: hrManages(actor, participant) && RESULT_PHASES.includes(participant.cycle_status) && participant.result_status === 'pending',
      viewHistory: hrSeesDetails(actor, participant)
    };
  }

  /** Alles außerhalb dieser Liste würde verraten, wann jemand abgegeben hat: Jede Abgabe ändert updated_at. */
  function participantForReader(participant, actor) {
    if (hrSeesDetails(actor, participant)) return participant;
    const {
      id, cycle_id, employee_id, manager_id, status, nomination_completed, result_released, cycle_name, cycle_status, questionnaire_id,
      feedback_deadline, nomination_deadline, anonymous_minimum, employee_name, employee_title, manager_name, result_status, meeting_completed_at
    } = participant;
    return {
      id, cycle_id, employee_id, manager_id, status, nomination_completed, result_released, cycle_name, cycle_status, questionnaire_id,
      feedback_deadline, nomination_deadline, anonymous_minimum, employee_name, employee_title, manager_name, result_status, meeting_completed_at
    };
  }

  function nominationForReader(nomination, actor, participant) {
    if (hrSeesDetails(actor, participant)) return nomination;
    return {
      id: nomination.id,
      participant_id: nomination.participant_id,
      feedback_group: nomination.feedback_group,
      giver_name: nomination.giver_name,
      giver_title: nomination.giver_title,
      proposer_name: nomination.proposer_name,
      // Für Empfänger:in und Führungskraft ist die Person bestätigt. Ob sie schon antwortete, bleibt offen.
      status: CONTACTED_NOMINATIONS.includes(nomination.status) ? 'approved' : nomination.status,
      rejection_reason: nomination.rejection_reason
    };
  }

  /**
   * Zahlen je Gruppe. Für HR vollständig. Für alle anderen nur, was keine einzelne Person verrät:
   * Eine kleine Gruppe erscheint höchstens zusammengefasst, und die Summe zählt nur, was auch einzeln
   * zu sehen ist. Sonst ließe sich die verborgene Gruppe aus der Differenz ausrechnen.
   */
  function progressFor(participant, actor) {
    const invitations = db.prepare('SELECT feedback_group,status FROM feedback_invitations WHERE participant_id=?').all(participant.id);
    const inGroup = group => invitations.filter(item => item.feedback_group === group);
    const submittedCount = rows => rows.filter(item => item.status === 'submitted').length;
    if (hrSeesDetails(actor, participant)) {
      const countsOf = rows => ({ invited: rows.length, submitted: submittedCount(rows), declined: rows.filter(item => item.status === 'declined').length });
      return { groups: [...FEEDBACK_GROUPS].map(group => ({ group, ...countsOf(inGroup(group)) })).filter(item => item.invited), ...countsOf(invitations) };
    }
    const groups = NAMED_GROUPS.map(group => ({ group, invited: inGroup(group).length, submitted: submittedCount(inGroup(group)) })).filter(item => item.invited);
    const small = [];
    for (const group of ANONYMOUS_GROUPS) {
      const rows = inGroup(group);
      if (rows.length >= participant.anonymous_minimum) groups.push({ group, invited: rows.length, submitted: submittedCount(rows) });
      else small.push(...rows);
    }
    if (small.length) groups.push({ group: 'anonymous_combined', invited: small.length, submitted: small.length >= participant.anonymous_minimum ? submittedCount(small) : null });
    const countable = groups.filter(item => item.submitted !== null);
    return { groups, invited: sum(countable.map(item => item.invited)), submitted: sum(countable.map(item => item.submitted)) };
  }

  function participantsOfCycle(cycleId, actor) {
    return db.prepare(`${PARTICIPANT_QUERY} WHERE p.cycle_id=?`).all(cycleId)
      .filter(participant => canSeeParticipant(actor, participant))
      .sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name), 'de'));
  }

  // ------------------------------------------------------------------ Fristen und Phasen

  function cycleCanNominate(cycle) {
    return !!cycle && (cycle.cycle_status || cycle.status) === 'nomination' && cycle.nomination_deadline >= today();
  }

  function cycleCanAnswer(cycle) {
    return !!cycle && (cycle.cycle_status || cycle.status) === 'open' && cycle.feedback_deadline >= today();
  }

  function nominationBlockedReason(cycle) {
    if ((cycle.cycle_status || cycle.status) !== 'nomination') return 'Personen lassen sich nur vorschlagen, solange die Runde Vorschläge sammelt.';
    return `Die Frist für Vorschläge ist am ${germanDate(cycle.nomination_deadline)} abgelaufen. HR kann sie verlängern.`;
  }

  function answerBlockedReason(cycle) {
    const status = cycle.cycle_status || cycle.status;
    if (status === 'open') return `Die Frist ist am ${germanDate(cycle.feedback_deadline)} abgelaufen. HR kann sie verlängern.`;
    if (status === 'nomination') return 'Diese Feedbackanfrage ruht, solange die Runde noch Vorschläge sammelt.';
    if (status === 'draft') return 'Diese Feedbackrunde hat noch nicht begonnen.';
    return 'Diese Feedbackrunde ist beendet. Antworten sind nicht mehr möglich.';
  }

  // ------------------------------------------------------------------ Anfragen und Antworten

  function deriveGroup(participant, giverId, preferredGroup, actor) {
    if (giverId === participant.employee_id) return 'self';
    if (participant.manager_id && giverId === participant.manager_id) return 'manager';
    const giver = userById(giverId);
    if (!giver) return null;
    if (giver.manager_id === participant.employee_id) return 'direct_report';
    if (hrManages(actor, participant) && preferredGroup === 'stakeholder') return 'stakeholder';
    return 'peer';
  }

  function addInvitation(nomination, actor) {
    const participant = participantDetails(nomination.participant_id);
    if (!participant || participant.cycle_status !== 'open') return null;
    const existing = db.prepare('SELECT id FROM feedback_invitations WHERE nomination_id=?').get(nomination.id);
    if (existing) return existing.id;
    const id = db.prepare('INSERT INTO feedback_invitations(nomination_id,participant_id,giver_id,feedback_group,status) VALUES(?,?,?,?,?)').run(nomination.id, nomination.participant_id, nomination.giver_id, nomination.feedback_group, 'invited').lastInsertRowid;
    db.prepare("UPDATE feedback_nominations SET status='invited',updated_at=? WHERE id=?").run(now(), nomination.id);
    task(nomination.giver_id, submitTaskTitle(nomination.giver_id, participant.employee_id, participant.employee_name), 'feedback_submit', id, participant.feedback_deadline);
    updateParticipantCompletion(participant.id);
    history(actor, 'feedback_invitation_created', { participantId: participant.id, cycleId: participant.cycle_id, metadata: { invitationId: id, group: nomination.feedback_group } });
    return id;
  }

  function inviteApprovedNominations(cycleId, actor) {
    const nominations = db.prepare(`SELECT n.* FROM feedback_nominations n JOIN feedback_cycle_participants p ON p.id=n.participant_id
      WHERE p.cycle_id=? AND n.status='approved'`).all(cycleId);
    for (const nomination of nominations) addInvitation(nomination, actor);
  }

  function pausePendingInvitationTasks(cycleId) {
    return db.prepare(`UPDATE tasks SET done=1 WHERE type='feedback_submit' AND done=0 AND entity_id IN (
      SELECT i.id FROM feedback_invitations i JOIN feedback_cycle_participants p ON p.id=i.participant_id
      WHERE p.cycle_id=? AND i.status IN ('invited','started')
    )`).run(cycleId).changes;
  }

  function resumePendingInvitationTasks(cycle) {
    const invitations = db.prepare(`SELECT i.id,i.giver_id,p.employee_id,e.name employee_name FROM feedback_invitations i
      JOIN feedback_cycle_participants p ON p.id=i.participant_id
      JOIN users e ON e.id=p.employee_id
      WHERE p.cycle_id=? AND i.status IN ('invited','started')
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.type='feedback_submit' AND t.entity_id=i.id AND t.done=0)`).all(cycle.id);
    for (const invitation of invitations) {
      task(invitation.giver_id, submitTaskTitle(invitation.giver_id, invitation.employee_id, invitation.employee_name), 'feedback_submit', invitation.id, cycle.feedback_deadline);
    }
    return invitations.length;
  }

  function updateParticipantCompletion(participantId) {
    const invitations = db.prepare('SELECT status FROM feedback_invitations WHERE participant_id=?').all(participantId);
    const completed = invitations.length > 0 && invitations.every(item => ['submitted', 'declined'].includes(item.status));
    db.prepare('UPDATE feedback_cycle_participants SET feedback_completed=?,updated_at=? WHERE id=?').run(completed ? 1 : 0, now(), participantId);
    return completed;
  }

  function invitationForActor(invitationId, actor) {
    return db.prepare(`SELECT i.*,p.cycle_id,p.employee_id,c.status cycle_status,c.feedback_deadline,c.questionnaire_id,c.anonymous_minimum,e.name employee_name
      FROM feedback_invitations i JOIN feedback_cycle_participants p ON p.id=i.participant_id JOIN feedback_cycles c ON c.id=p.cycle_id JOIN users e ON e.id=p.employee_id
      WHERE i.id=? AND i.giver_id=?`).get(invitationId, actor.id);
  }

  function questionsForCycle(cycleId) {
    return db.prepare(`SELECT q.*,s.title section_title,s.description section_description,s.display_order section_order,co.name competency_name
      FROM feedback_questions q JOIN feedback_questionnaire_sections s ON s.id=q.section_id JOIN feedback_cycles c ON c.questionnaire_id=s.questionnaire_id LEFT JOIN competencies co ON co.id=q.competency_id
      WHERE c.id=? AND q.active=1 ORDER BY s.display_order,q.display_order,q.id`).all(cycleId);
  }

  function invitationForm(invitation) {
    const questions = questionsForCycle(invitation.cycle_id);
    const responses = db.prepare('SELECT * FROM feedback_responses WHERE invitation_id=?').all(invitation.id);
    const isSelf = invitation.feedback_group === 'self';
    const sections = new Map();
    for (const question of questions) {
      if (!sections.has(question.section_id)) {
        sections.set(question.section_id, { id: question.section_id, title: question.section_title, description: question.section_description, displayOrder: question.section_order, questions: [] });
      }
      const existing = responses.find(response => response.question_id === question.id);
      sections.get(question.section_id).questions.push({
        ...question,
        question_text: isSelf ? selfWording(question.question_text) ?? question.question_text : question.question_text,
        response: existing ? { numericValue: existing.numeric_value, textValue: existing.text_value, notApplicable: !!existing.not_applicable, draft: !!existing.draft } : null
      });
    }
    return {
      invitation: {
        id: invitation.id,
        status: invitation.status,
        feedbackGroup: invitation.feedback_group,
        employeeName: invitation.employee_name,
        deadline: invitation.feedback_deadline,
        deadlineState: dueState(invitation.feedback_deadline),
        anonymousMinimum: invitation.anonymous_minimum,
        selfWordingIncomplete: isSelf && questions.some(question => /\bPerson\b/.test(question.question_text) && !selfWording(question.question_text))
      },
      sections: [...sections.values()]
    };
  }

  function parseAnswer(question, entry) {
    const notApplicable = bool(entry.notApplicable);
    const hasNumber = ![undefined, null, ''].includes(entry.numericValue);
    const numericValue = hasNumber ? rating(entry.numericValue) : null;
    const textValue = text(entry.textValue, 4000);
    if (question.question_type === 'rating') {
      if (hasNumber && !numericValue) throw new FeedbackProblem('Bewertungen müssen zwischen 1 und 5 liegen.');
      if (notApplicable && numericValue) throw new FeedbackProblem('Eine Note und „nicht beurteilbar“ schließen sich aus.');
      return { numericValue, textValue: null, notApplicable: notApplicable ? 1 : 0, isEmpty: !notApplicable && !numericValue };
    }
    if (question.question_type === 'text') {
      if (notApplicable || (textValue && textValue.length < 2)) throw new FeedbackProblem('Textantworten müssen mindestens zwei Zeichen enthalten.');
      return { numericValue: null, textValue: textValue || null, notApplicable: 0, isEmpty: !textValue };
    }
    throw new FeedbackProblem('Dieser Fragetyp ist in dieser Version nicht verfügbar.');
  }

  function parseAnswers(entries, questions) {
    if (!Array.isArray(entries) || !entries.length) throw new FeedbackProblem('Bitte beantworte mindestens eine Frage.');
    const questionsById = new Map(questions.map(question => [question.id, question]));
    const answers = new Map();
    for (const entry of entries) {
      const questionId = asId(entry?.questionId);
      const question = questionsById.get(questionId);
      if (!question || answers.has(questionId)) throw new FeedbackProblem('Eine Antwort verweist auf eine ungültige oder doppelte Frage.');
      answers.set(questionId, parseAnswer(question, entry));
    }
    return answers;
  }

  function requireAllRequiredAnswers(invitation, questions, answers) {
    const saved = new Set(db.prepare("SELECT question_id FROM feedback_responses WHERE invitation_id=? AND (numeric_value IS NOT NULL OR not_applicable=1 OR (text_value IS NOT NULL AND text_value<>''))").all(invitation.id).map(row => row.question_id));
    for (const question of questions.filter(item => item.required)) {
      const answer = answers.get(question.id);
      const complete = answer ? !answer.isEmpty : saved.has(question.id);
      if (!complete) throw new FeedbackProblem('Bitte beantworte alle Pflichtfragen, bevor du das Feedback absendest.');
    }
  }

  function saveResponses(invitation, actor, entries, finalSubmit) {
    const questions = questionsForCycle(invitation.cycle_id);
    const answers = parseAnswers(entries, questions);
    if (finalSubmit) requireAllRequiredAnswers(invitation, questions, answers);
    db.transaction(() => {
      const upsert = db.prepare(`INSERT INTO feedback_responses(invitation_id,question_id,numeric_value,text_value,not_applicable,draft,updated_at,submitted_at)
        VALUES(?,?,?,?,?,1,?,NULL) ON CONFLICT(invitation_id,question_id) DO UPDATE SET numeric_value=excluded.numeric_value,text_value=excluded.text_value,
        not_applicable=excluded.not_applicable,draft=excluded.draft,updated_at=excluded.updated_at,submitted_at=excluded.submitted_at`);
      for (const [questionId, answer] of answers) {
        // Eine aufgehobene Note darf nicht als alter Entwurf weiterleben.
        if (answer.isEmpty) db.prepare('DELETE FROM feedback_responses WHERE invitation_id=? AND question_id=?').run(invitation.id, questionId);
        else upsert.run(invitation.id, questionId, answer.numericValue, answer.textValue, answer.notApplicable, now());
      }
      if (finalSubmit) {
        db.prepare('UPDATE feedback_responses SET draft=0,submitted_at=?,updated_at=? WHERE invitation_id=?').run(now(), now(), invitation.id);
        db.prepare("UPDATE feedback_invitations SET status='submitted',submitted_at=? WHERE id=?").run(now(), invitation.id);
        db.prepare("UPDATE feedback_nominations SET status='submitted',updated_at=? WHERE id=?").run(now(), invitation.nomination_id);
        closeTasks('feedback_submit', invitation.id, actor.id);
        updateParticipantCompletion(invitation.participant_id);
        history(actor, 'feedback_submitted', { participantId: invitation.participant_id, cycleId: invitation.cycle_id, metadata: { invitationId: invitation.id, group: invitation.feedback_group } });
      } else {
        db.prepare("UPDATE feedback_invitations SET status=CASE WHEN status='invited' THEN 'started' ELSE status END,started_at=COALESCE(started_at,?) WHERE id=?").run(now(), invitation.id);
        db.prepare("UPDATE feedback_nominations SET status=CASE WHEN status='invited' THEN 'started' ELSE status END,updated_at=? WHERE id=?").run(now(), invitation.nomination_id);
      }
    })();
  }

  // ------------------------------------------------------------------ Auswertung

  const hasAnswer = row => Number.isInteger(row.numeric_value) || !!row.text_value;

  function aggregate(rows) {
    const numbers = rows.map(row => row.numeric_value).filter(value => Number.isInteger(value));
    return {
      responseCount: rows.filter(hasAnswer).length,
      notApplicableCount: rows.filter(row => row.not_applicable).length,
      average: numbers.length ? rounded(sum(numbers) / numbers.length) : null
    };
  }

  /**
   * Welche Gruppen darf diese Person sehen? Wer selbst in einer anonymen Gruppe geantwortet hat, könnte die
   * eigene Antwort herausrechnen. Für ihn oder sie zählen deshalb nur die Antworten der anderen.
   */
  function visibleGroupsForQuestion(rows, minimum, reader) {
    const answered = rows.filter(row => hasAnswer(row) || row.not_applicable);
    const othersAnswered = entries => entries.filter(row => hasAnswer(row) && row.giver_id !== reader.id).length;
    const visible = [];
    for (const group of NAMED_GROUPS) {
      const entries = answered.filter(row => row.feedback_group === group);
      if (entries.length) visible.push({ group, ...aggregate(entries), anonymous: false, rows: entries });
    }
    const smallGroups = [];
    for (const group of ANONYMOUS_GROUPS) {
      const entries = answered.filter(row => row.feedback_group === group);
      if (othersAnswered(entries) >= minimum) visible.push({ group, ...aggregate(entries), anonymous: true, rows: entries });
      else smallGroups.push(...entries);
    }
    if (othersAnswered(smallGroups) >= minimum) {
      visible.push({ group: 'anonymous_combined', ...aggregate(smallGroups), anonymous: true, combinedGroups: ANONYMOUS_GROUPS, rows: smallGroups });
    }
    return visible;
  }

  /** Die Reihenfolge folgt dem Inhalt, nicht der Abgabe. So verrät sie nicht, wer früh oder spät geschrieben hat. */
  function mixedOrder(rows, salt) {
    const sortKey = row => crypto.createHash('sha256').update(`${salt}:${row.text_value}`).digest('hex');
    return rows.map(row => [sortKey(row), row]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  }

  function calculateResult(participantId, reader) {
    const participant = participantDetails(participantId);
    if (!participant) return null;
    const minimum = participant.anonymous_minimum;
    const wordingForReader = text => (isEmployee(reader, participant) ? selfWording(text) ?? text : text);
    const questions = questionsForCycle(participant.cycle_id);
    const answerRows = db.prepare(`SELECT r.question_id,r.numeric_value,r.text_value,r.not_applicable,i.feedback_group,i.giver_id
      FROM feedback_responses r JOIN feedback_invitations i ON i.id=r.invitation_id
      WHERE i.participant_id=? AND i.status='submitted' AND r.draft=0`).all(participantId);
    const visibleByQuestion = new Map(questions.map(question => [question.id, visibleGroupsForQuestion(answerRows.filter(row => row.question_id === question.id), minimum, reader)]));
    const resultQuestions = questions.map(question => ({
      id: question.id,
      sectionId: question.section_id,
      sectionTitle: question.section_title,
      question: wordingForReader(question.question_text),
      type: question.question_type,
      competencyId: question.competency_id,
      competencyName: question.competency_name,
      groups: visibleByQuestion.get(question.id).map(({ rows, ...group }) => group)
    }));
    const sectionMap = new Map();
    const competencyMap = new Map();
    const addAverage = (item, group) => {
      if (!item.groups.has(group.group)) item.groups.set(group.group, []);
      item.groups.get(group.group).push(group.average);
    };
    for (const question of resultQuestions.filter(item => item.type === 'rating')) {
      if (!sectionMap.has(question.sectionId)) sectionMap.set(question.sectionId, { id: question.sectionId, title: question.sectionTitle, groups: new Map() });
      if (question.competencyId && !competencyMap.has(question.competencyId)) {
        competencyMap.set(question.competencyId, { id: question.competencyId, title: question.competencyName || 'Kompetenz', groups: new Map() });
      }
      for (const group of question.groups.filter(item => item.average !== null)) {
        addAverage(sectionMap.get(question.sectionId), group);
        if (question.competencyId) addAverage(competencyMap.get(question.competencyId), group);
      }
    }
    const summarize = item => ({
      id: item.id,
      title: item.title,
      groups: [...item.groups.entries()].map(([group, values]) => ({ group, average: rounded(sum(values) / values.length), questionCount: values.length }))
    });
    const comments = questions.filter(question => question.question_type === 'text').flatMap(question => visibleByQuestion.get(question.id).flatMap(group => {
      const written = group.rows.filter(row => row.text_value);
      const ordered = group.anonymous ? mixedOrder(written, `${participant.id}:${question.id}`) : written;
      return ordered.map(row => ({ questionId: question.id, question: wordingForReader(question.question_text), group: group.group, text: row.text_value, anonymous: group.anonymous }));
    }));
    const comparisons = resultQuestions.filter(item => item.type === 'rating').map(item => {
      const self = item.groups.find(group => group.group === 'self')?.average ?? null;
      const others = item.groups.filter(group => group.group !== 'self' && group.average !== null).map(group => group.average);
      const external = others.length ? rounded(sum(others) / others.length) : null;
      return { questionId: item.id, question: item.question, self, external, difference: self !== null && external !== null ? rounded(external - self) : null };
    });
    const progress = progressFor(participant, reader);
    return {
      participant: { id: participant.id, employeeId: participant.employee_id, employeeName: participant.employee_name, managerId: participant.manager_id, managerName: participant.manager_name },
      cycle: { id: participant.cycle_id, name: participant.cycle_name, minimumAnonymousGroupSize: minimum },
      responseRate: { ...progress, percentage: progress.invited ? Math.round((progress.submitted / progress.invited) * 100) : 0 },
      questions: resultQuestions,
      sections: [...sectionMap.values()].map(summarize),
      competencies: [...competencyMap.values()].map(summarize),
      comparisons,
      comments,
      calculation: {
        calculatedAt: participant.calculated_at,
        rule: `Antworten von Kolleg:innen, direkt unterstellten und weiteren Personen erscheinen erst ab ${minimum} Antworten und ohne Namen. Kleinere Gruppen werden nur zusammengefasst gezeigt, wenn sie gemeinsam mindestens ${minimum} Antworten haben. Sonst bleiben sie verborgen.`
      }
    };
  }

  function resultStatus(participantId) {
    return db.prepare('SELECT * FROM feedback_result_statuses WHERE participant_id=?').get(participantId);
  }

  function resultStatusForReader(status) {
    const { status: state, calculated_at, released_for_manager_at, released_for_employee_at, closed_at, meeting_completed_at } = status;
    return { status: state, calculated_at, released_for_manager_at, released_for_employee_at, closed_at, meeting_completed_at };
  }

  function resultPermissions(actor, participant, status) {
    const released = RELEASED_FOR_MANAGER.includes(status.status);
    return {
      nextStatus: hrManages(actor, participant) ? NEXT_RESULT_STATUS[status.status] || null : null,
      develop: released && canManageParticipant(actor, participant),
      completeMeeting: released && status.status !== 'closed' && !status.meeting_completed_at && isCurrentManager(actor, participant)
    };
  }

  function setResultStatus(participant, actor, nextStatus) {
    const before = resultStatus(participant.id);
    if (!before || NEXT_RESULT_STATUS[before.status] !== nextStatus) throw new FeedbackProblem('Dieser Schritt ist gerade nicht möglich.', 409);
    const fields = { reviewed: 'reviewed_at', released_for_manager: 'released_for_manager_at', released_for_employee: 'released_for_employee_at', closed: 'closed_at' };
    db.transaction(() => {
      db.prepare(`UPDATE feedback_result_statuses SET status=?,${fields[nextStatus]}=?,updated_by=?,updated_at=? WHERE participant_id=?`).run(nextStatus, now(), actor.id, now(), participant.id);
      if (nextStatus === 'reviewed') closeTasks('feedback_result_review', participant.id);
      if (nextStatus === 'released_for_manager') task(participant.manager_id, meetingTaskTitle(participant.employee_name), 'feedback_result_meeting', participant.id);
      if (nextStatus === 'released_for_employee') {
        db.prepare('UPDATE feedback_cycle_participants SET result_released=1,updated_at=? WHERE id=?').run(now(), participant.id);
        task(participant.employee_id, `Dein 360°-Bericht aus „${participant.cycle_name}“ ist freigegeben: jetzt ansehen`, 'feedback_result', participant.id);
      }
      if (nextStatus === 'closed') {
        for (const type of ['feedback_result_review', 'feedback_result_meeting', 'feedback_result']) closeTasks(type, participant.id);
      }
      history(actor, `feedback_result_${nextStatus}`, { participantId: participant.id, cycleId: participant.cycle_id, metadata: { previousStatus: before.status, nextStatus } });
    })();
  }

  // ------------------------------------------------------------------ Wechsel der Führungskraft

  /**
   * Die Anfrage an die Führungskraft zieht mit um, solange niemand mit dem Antworten begonnen hat. Begonnene
   * Entwürfe und abgegebene Antworten gehören der bisherigen Führungskraft und bleiben bei ihr.
   */
  function handOverManagerRequest(participant, previousManagerId, managerId) {
    const cycle = cycleById(participant.cycle_id);
    if (!['draft', 'nomination', 'open'].includes(cycle.status)) return;
    const allRequests = db.prepare('SELECT * FROM feedback_nominations WHERE participant_id=?').all(participant.id);
    const managerRequests = allRequests.filter(item => item.feedback_group === 'manager');
    const previousRequest = managerRequests.find(item => item.giver_id === previousManagerId && UNTOUCHED_NOMINATIONS.includes(item.status));
    let newManagerHasRequest = managerRequests.some(item => item.giver_id === managerId);
    const withdraw = nomination => {
      db.prepare("UPDATE feedback_nominations SET status='rejected',rejection_reason=?,updated_at=? WHERE id=?").run('Die Führungskraft hat gewechselt.', now(), nomination.id);
      const invitation = db.prepare('SELECT id FROM feedback_invitations WHERE nomination_id=?').get(nomination.id);
      if (invitation) {
        db.prepare("UPDATE feedback_invitations SET status='declined',declined_at=? WHERE id=?").run(now(), invitation.id);
        closeTasks('feedback_submit', invitation.id);
      }
      closeTasks('feedback_nomination_review', nomination.id);
    };
    if (previousRequest && managerId && !newManagerHasRequest) {
      db.prepare('UPDATE feedback_nominations SET giver_id=?,updated_at=? WHERE id=?').run(managerId, now(), previousRequest.id);
      const invitation = db.prepare('SELECT id FROM feedback_invitations WHERE nomination_id=?').get(previousRequest.id);
      if (invitation) {
        db.prepare('UPDATE feedback_invitations SET giver_id=? WHERE id=?').run(managerId, invitation.id);
        db.prepare("UPDATE tasks SET user_id=? WHERE type='feedback_submit' AND entity_id=? AND done=0").run(managerId, invitation.id);
      }
      newManagerHasRequest = true;
    } else if (previousRequest) {
      withdraw(previousRequest);
    }
    const stillInUse = item => item.id !== previousRequest?.id && !['rejected', 'declined'].includes(item.status);
    if (managerId && !newManagerHasRequest && !managerRequests.some(stillInUse)) {
      const id = db.prepare('INSERT INTO feedback_nominations(participant_id,giver_id,feedback_group,proposed_by,status,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?)')
        .run(participant.id, managerId, 'manager', managerId, 'approved', managerId, now()).lastInsertRowid;
      if (cycle.status === 'open') addInvitation({ id, participant_id: participant.id, giver_id: managerId, feedback_group: 'manager' }, null);
    }
    // Sonst läge dieselbe Person doppelt in der Runde und könnte die Antworten ihrer früheren Gruppe herausrechnen.
    const earlierRequest = allRequests.find(item => item.giver_id === managerId && item.feedback_group !== 'manager' && UNTOUCHED_NOMINATIONS.includes(item.status));
    if (earlierRequest) withdraw(earlierRequest);
    updateParticipantCompletion(participant.id);
  }

  function moveCasesToManager(employeeId, managerId, actorId = null) {
    const participants = db.prepare('SELECT id,cycle_id,employee_id,manager_id FROM feedback_cycle_participants WHERE employee_id=?').all(employeeId);
    for (const participant of participants) {
      const previousManagerId = participant.manager_id ?? null;
      if (previousManagerId === managerId) continue;
      db.prepare('UPDATE feedback_cycle_participants SET manager_id=?,updated_at=? WHERE id=?').run(managerId, now(), participant.id);
      const nominationsOfParticipant = 'SELECT id FROM feedback_nominations WHERE participant_id=?';
      if (managerId) {
        db.prepare("UPDATE tasks SET user_id=? WHERE type='feedback_result_meeting' AND entity_id=? AND done=0").run(managerId, participant.id);
        db.prepare(`UPDATE tasks SET user_id=? WHERE type='feedback_nomination_review' AND done=0 AND entity_id IN (${nominationsOfParticipant})`).run(managerId, participant.id);
        // Hatte die Person bei der Freigabe keine Führungskraft, gab es noch niemanden, der die Aufgabe bekommen konnte.
        const details = participantDetails(participant.id);
        const meetingNeverAssigned = previousManagerId === null && RELEASED_FOR_MANAGER.includes(details.result_status) && details.result_status !== 'closed' && !details.meeting_completed_at;
        if (meetingNeverAssigned) task(managerId, meetingTaskTitle(details.employee_name), 'feedback_result_meeting', participant.id);
      } else {
        // Ohne Führungskraft gibt es kein Gespräch vorzubereiten. Über Vorschläge entscheidet dann HR.
        closeTasks('feedback_result_meeting', participant.id);
        const hrId = firstHrId();
        if (hrId) db.prepare(`UPDATE tasks SET user_id=? WHERE type='feedback_nomination_review' AND done=0 AND entity_id IN (${nominationsOfParticipant})`).run(hrId, participant.id);
      }
      handOverManagerRequest(participant, previousManagerId, managerId);
      history(actorId ? { id: actorId } : null, 'feedback_manager_changed', { participantId: participant.id, cycleId: participant.cycle_id, metadata: { previousManagerId, managerId } });
    }
  }

  /** Wechsel, die vor dieser Anmeldung passiert sind, sollen keine verwaisten Aufgaben hinterlassen. */
  function catchUpManagerChanges() {
    const outdated = db.prepare(`SELECT DISTINCT p.employee_id,e.manager_id FROM feedback_cycle_participants p JOIN users e ON e.id=p.employee_id
      WHERE COALESCE(p.manager_id,0)<>COALESCE(e.manager_id,0)`).all();
    for (const { employee_id: employeeId, manager_id: managerId } of outdated) {
      db.transaction(() => moveCasesToManager(employeeId, managerId ?? null))();
    }
  }

  deps.onManagerChanged?.(({ userId, managerId, actorId }) => moveCasesToManager(userId, managerId ?? null, actorId ?? null));

  function firstHrId() {
    return db.prepare("SELECT id FROM users WHERE role IN ('hr_admin','hrbp') AND is_system_account=0 AND active=1 ORDER BY CASE WHEN role='hr_admin' THEN 0 ELSE 1 END,id LIMIT 1").get()?.id || null;
  }

  // ------------------------------------------------------------------ Beispieldaten

  function seedQuestionnaire(actor) {
    const questionnaire = db.prepare('SELECT * FROM feedback_questionnaires WHERE name=? AND version=1').get('360° Entwicklungsfeedback');
    if (questionnaire) return questionnaire;
    const id = db.prepare('INSERT INTO feedback_questionnaires(name,description,version,created_by,updated_by) VALUES(?,?,?,?,?)').run('360° Entwicklungsfeedback', 'Fragebogen mit Bewertungen und offenen Fragen, der bei der Entwicklung hilft.', 1, actor.id, actor.id).lastInsertRowid;
    const sections = ['Zusammenarbeit', 'Kommunikation', 'Wirkung', 'Lernen und Entwicklung', 'Verantwortung'];
    const ratings = [
      'arbeitet konstruktiv und zuverlässig mit anderen zusammen', 'holt unterschiedliche Sichtweisen ein', 'teilt Wissen aktiv', 'geht respektvoll mit Feedback um',
      'kommuniziert klar und verständlich', 'macht Entscheidungen nachvollziehbar', 'spricht schwierige Themen konstruktiv an', 'hört aktiv zu',
      'setzt Prioritäten wirksam um', 'liefert verlässliche Ergebnisse', 'übernimmt Verantwortung für die eigene Wirkung', 'verbessert Abläufe kontinuierlich',
      'lernt aus Erfahrungen', 'entwickelt neue Fähigkeiten gezielt weiter', 'fragt aktiv nach Feedback', 'überträgt Erkenntnisse in die Praxis',
      'übernimmt Verantwortung', 'geht umsichtig mit Mitteln um', 'handelt kundenorientiert', 'fördert eine vertrauensvolle Zusammenarbeit'
    ];
    const addSection = db.prepare('INSERT INTO feedback_questionnaire_sections(questionnaire_id,title,description,display_order) VALUES(?,?,?,?)');
    const addQuestion = db.prepare('INSERT INTO feedback_questions(section_id,question_text,question_type,required,display_order,help_text) VALUES(?,?,?,?,?,?)');
    sections.forEach((section, sectionIndex) => {
      const sectionId = addSection.run(id, section, `Fragen zum Thema ${section}.`, sectionIndex + 1).lastInsertRowid;
      for (let offset = 0; offset < 4; offset += 1) {
        addQuestion.run(sectionId, `Die Person ${ratings[sectionIndex * 4 + offset]}.`, 'rating', 1, offset + 1, '1 = trifft nicht zu · 5 = trifft vollständig zu');
      }
      addQuestion.run(sectionId, `Was sollte die Person beim Thema „${section}“ unbedingt beibehalten?`, 'text', 0, 10, 'Bitte konkret und hilfreich formulieren.');
    });
    return questionnaireById(id);
  }

  function demoTarget(candidates) {
    return candidates.find(user => user.manager_id && candidates.filter(peer => peer.manager_id === user.manager_id && peer.id !== user.id).length >= 3) || candidates.find(user => user.manager_id);
  }

  /** Eine Beispielrunde soll auch Monate nach dem ersten Start noch benutzbar sein. */
  function reviveDemoCycle(cycle) {
    if (cycle.status !== 'open' || cycle.feedback_deadline >= today()) return;
    const feedbackDeadline = daysFromToday(60);
    const endDate = daysFromToday(90) > cycle.end_date ? daysFromToday(90) : cycle.end_date;
    db.prepare('UPDATE feedback_cycles SET feedback_deadline=?,end_date=?,updated_at=? WHERE id=?').run(feedbackDeadline, endDate, now(), cycle.id);
    refreshTaskDeadlines(cycleById(cycle.id));
  }

  function seedRunningCycle(hr, questionnaire) {
    const existing = db.prepare('SELECT * FROM feedback_cycles WHERE description IN (?,?)').get(...DEMO_RUNNING_DESCRIPTIONS);
    if (existing) {
      reviveDemoCycle(existing);
      return;
    }
    const cycleId = db.prepare(`INSERT INTO feedback_cycles(name,description,start_date,end_date,nomination_deadline,feedback_deadline,status,questionnaire_id,anonymous_minimum,created_by,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`360° Feedback ${today().slice(0, 4)}`, DEMO_RUNNING_DESCRIPTIONS[0], daysFromToday(-30), daysFromToday(90), daysFromToday(-7), daysFromToday(60), 'open', questionnaire.id, 3, hr.id, hr.id).lastInsertRowid;
    const candidates = db.prepare("SELECT * FROM users WHERE role IN ('employee','manager','director') ORDER BY id").all();
    const target = demoTarget(candidates);
    if (!target) return;
    const participantId = db.prepare("INSERT INTO feedback_cycle_participants(cycle_id,employee_id,manager_id,status) VALUES(?,?,?,'feedback_open')").run(cycleId, target.id, target.manager_id).lastInsertRowid;
    db.prepare('INSERT INTO feedback_result_statuses(participant_id,status,updated_by) VALUES(?,?,?)').run(participantId, 'pending', hr.id);
    const peers = candidates.filter(peer => peer.manager_id === target.manager_id && peer.id !== target.id).slice(0, 3).map(peer => peer.id);
    for (const giverId of [target.id, target.manager_id, ...peers]) {
      const group = giverId === target.id ? 'self' : giverId === target.manager_id ? 'manager' : 'peer';
      const nominationId = db.prepare('INSERT INTO feedback_nominations(participant_id,giver_id,feedback_group,proposed_by,status,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?)').run(participantId, giverId, group, hr.id, 'approved', hr.id, now()).lastInsertRowid;
      addInvitation({ id: nominationId, participant_id: participantId, giver_id: giverId, feedback_group: group }, hr);
    }
  }

  function seedFinishedCycle(hr, questionnaire) {
    if (db.prepare('SELECT id FROM feedback_cycles WHERE description IN (?,?)').get(...DEMO_FINISHED_DESCRIPTIONS)) return;
    const candidates = db.prepare("SELECT * FROM users WHERE role IN ('employee','manager','director') AND manager_id IS NOT NULL ORDER BY id").all();
    const target = demoTarget(candidates);
    if (!target) return;
    const lastYear = Number(today().slice(0, 4)) - 1;
    db.transaction(() => {
      const cycleId = db.prepare(`INSERT INTO feedback_cycles(name,description,start_date,end_date,nomination_deadline,feedback_deadline,status,questionnaire_id,anonymous_minimum,created_by,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`360° Feedback ${lastYear}`, DEMO_FINISHED_DESCRIPTIONS[0], `${lastYear}-01-01`, `${lastYear}-12-31`, `${lastYear}-04-30`, `${lastYear}-06-30`, 'completed', questionnaire.id, 3, hr.id, hr.id).lastInsertRowid;
      const participantId = db.prepare("INSERT INTO feedback_cycle_participants(cycle_id,employee_id,manager_id,status,nomination_completed,feedback_completed,result_released) VALUES(?,?,?,'completed',1,1,1)").run(cycleId, target.id, target.manager_id).lastInsertRowid;
      db.prepare('INSERT INTO feedback_result_statuses(participant_id,status,calculated_at,reviewed_at,released_for_manager_at,released_for_employee_at,updated_by) VALUES(?,?,?,?,?,?,?)').run(participantId, 'released_for_employee', now(), now(), now(), now(), hr.id);
      const questions = questionsForCycle(cycleId);
      const ratingQuestions = questions.filter(question => question.question_type === 'rating');
      const firstSections = new Set([...new Set(questions.map(question => question.section_id))].slice(0, 2));
      const peers = candidates.filter(peer => peer.manager_id === target.manager_id && peer.id !== target.id).slice(0, 3).map(peer => peer.id);
      const givers = [target.id, target.manager_id, ...peers];
      givers.forEach((giverId, giverIndex) => {
        const group = giverId === target.id ? 'self' : giverId === target.manager_id ? 'manager' : 'peer';
        const nominationId = db.prepare('INSERT INTO feedback_nominations(participant_id,giver_id,feedback_group,proposed_by,status,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?)').run(participantId, giverId, group, hr.id, 'submitted', hr.id, now()).lastInsertRowid;
        const invitationId = db.prepare('INSERT INTO feedback_invitations(nomination_id,participant_id,giver_id,feedback_group,status,invited_at,submitted_at) VALUES(?,?,?,?,?,?,?)').run(nominationId, participantId, giverId, group, 'submitted', now(), now()).lastInsertRowid;
        const answer = db.prepare('INSERT INTO feedback_responses(invitation_id,question_id,numeric_value,text_value,not_applicable,draft,submitted_at) VALUES(?,?,?,?,0,0,?)');
        ratingQuestions.forEach((question, questionIndex) => {
          answer.run(invitationId, question.id, DEMO_RATINGS[questionIndex % DEMO_RATINGS.length][giverIndex], null, now());
        });
        for (const question of questions.filter(item => item.question_type === 'text' && firstSections.has(item.section_id))) {
          const comment = group === 'peer' ? DEMO_COMMENTS.peer[(giverIndex - 2) % DEMO_COMMENTS.peer.length] : DEMO_COMMENTS[group];
          answer.run(invitationId, question.id, null, comment, now());
        }
      });
    })();
  }

  function seed() {
    const hr = db.prepare("SELECT * FROM users WHERE role IN ('hr_admin','hrbp') AND is_system_account=0 ORDER BY id LIMIT 1").get();
    if (!hr) return;
    const questionnaire = seedQuestionnaire(hr);
    seedRunningCycle(hr, questionnaire);
    seedFinishedCycle(hr, questionnaire);
  }

  // ------------------------------------------------------------------ Schnittstelle

  router.use(auth);

  router.get('/feedback/meta', (req, res) => {
    const actor = current(req);
    const questionnaires = isHr(actor) ? db.prepare('SELECT id,name,version,active,frozen FROM feedback_questionnaires ORDER BY name,version DESC').all() : [];
    res.json({
      roles: actor.role,
      cycleStatuses: [...CYCLE_STATUSES],
      participantStatuses: [...PARTICIPANT_STATUSES],
      nominationStatuses: [...NOMINATION_STATUSES],
      feedbackGroups: [...FEEDBACK_GROUPS],
      resultStatuses: [...RESULT_STATUSES],
      developmentActions: [...DEVELOPMENT_ACTIONS],
      questionnaires
    });
  });

  // --- Fragebögen

  router.get('/feedback/questionnaires', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragebögen verwalten.' });
    res.json({ items: db.prepare('SELECT q.*,EXISTS(SELECT 1 FROM feedback_cycles c WHERE c.questionnaire_id=q.id) used FROM feedback_questionnaires q ORDER BY q.active DESC,q.name,q.version DESC').all() });
  });

  router.get('/feedback/questionnaires/:id', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragebögen verwalten.' });
    const item = questionnaireDetails(asId(req.params.id), true);
    if (!item) return res.status(404).json({ error: 'Fragebogen nicht gefunden.' });
    res.json({ questionnaire: item });
  });

  router.post('/feedback/questionnaires', (req, res) => {
    const actor = current(req);
    const body = bodyOf(req);
    const name = text(body.name, 180);
    const description = text(body.description, 2000);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragebögen anlegen.' });
    if (!name) return res.status(400).json({ error: 'Bitte gib dem Fragebogen einen Namen.' });
    if (db.prepare('SELECT id FROM feedback_questionnaires WHERE name=? AND version=1').get(name)) return res.status(409).json({ error: 'Einen Fragebogen mit diesem Namen gibt es schon.' });
    const id = db.prepare('INSERT INTO feedback_questionnaires(name,description,version,created_by,updated_by) VALUES(?,?,?,?,?)').run(name, description, 1, actor.id, actor.id).lastInsertRowid;
    history(actor, 'feedback_questionnaire_created', { metadata: { questionnaireId: id, name } });
    res.status(201).json({ id });
  });

  router.patch('/feedback/questionnaires/:id', (req, res) => {
    const actor = current(req);
    const id = asId(req.params.id);
    const questionnaire = questionnaireById(id);
    const body = bodyOf(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragebögen bearbeiten.' });
    if (!questionnaire) return res.status(404).json({ error: 'Fragebogen nicht gefunden.' });
    if (questionnaireLocked(questionnaire)) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    const name = body.name === undefined ? questionnaire.name : text(body.name, 180);
    const description = body.description === undefined ? questionnaire.description : text(body.description, 2000);
    const active = body.active === undefined ? questionnaire.active : bool(body.active) ? 1 : 0;
    if (!name) return res.status(400).json({ error: 'Bitte gib dem Fragebogen einen Namen.' });
    if (db.prepare('SELECT id FROM feedback_questionnaires WHERE name=? AND version=? AND id<>?').get(name, questionnaire.version, id)) return res.status(409).json({ error: 'Einen Fragebogen mit diesem Namen gibt es schon.' });
    db.prepare('UPDATE feedback_questionnaires SET name=?,description=?,active=?,updated_by=?,updated_at=? WHERE id=?').run(name, description, active, actor.id, now(), id);
    history(actor, 'feedback_questionnaire_updated', { metadata: { questionnaireId: id } });
    res.json({ ok: true });
  });

  router.post('/feedback/questionnaires/:id/version', (req, res) => {
    const actor = current(req);
    const sourceId = asId(req.params.id);
    const source = questionnaireDetails(sourceId, true);
    const name = text(bodyOf(req).name, 180);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf neue Versionen anlegen.' });
    if (!source) return res.status(404).json({ error: 'Fragebogen nicht gefunden.' });
    const nextVersion = db.prepare('SELECT COALESCE(MAX(version),0)+1 version FROM feedback_questionnaires WHERE name=?').get(name || source.name).version;
    const id = db.transaction(() => {
      const questionnaireId = db.prepare('INSERT INTO feedback_questionnaires(name,description,version,parent_questionnaire_id,created_by,updated_by) VALUES(?,?,?,?,?,?)').run(name || source.name, source.description, nextVersion, source.id, actor.id, actor.id).lastInsertRowid;
      const addSection = db.prepare('INSERT INTO feedback_questionnaire_sections(questionnaire_id,title,description,display_order) VALUES(?,?,?,?)');
      const addQuestion = db.prepare('INSERT INTO feedback_questions(section_id,question_text,question_type,required,display_order,competency_id,help_text,active) VALUES(?,?,?,?,?,?,?,?)');
      for (const section of source.sections) {
        const sectionId = addSection.run(questionnaireId, section.title, section.description, section.display_order).lastInsertRowid;
        for (const question of section.questions) addQuestion.run(sectionId, question.question_text, question.question_type, question.required, question.display_order, question.competency_id, question.help_text, question.active);
      }
      return questionnaireId;
    })();
    history(actor, 'feedback_questionnaire_versioned', { metadata: { sourceId, questionnaireId: id, version: nextVersion } });
    res.status(201).json({ id, version: nextVersion });
  });

  router.post('/feedback/questionnaires/:id/sections', (req, res) => {
    const actor = current(req);
    const questionnaireId = asId(req.params.id);
    const body = bodyOf(req);
    const title = text(body.title, 180);
    const description = text(body.description, 1000);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Abschnitte anlegen.' });
    if (questionnaireLocked(questionnaireById(questionnaireId))) return res.status(409).json({ error: 'Abschnitte lassen sich nur in Fragebögen ändern, die noch nicht verwendet werden.' });
    if (!title) return res.status(400).json({ error: 'Bitte gib dem Abschnitt einen Titel.' });
    const order = asId(body.displayOrder) || nextDisplayOrder('feedback_questionnaire_sections', 'questionnaire_id', questionnaireId);
    if (db.prepare('SELECT id FROM feedback_questionnaire_sections WHERE questionnaire_id=? AND display_order=?').get(questionnaireId, order)) {
      return res.status(409).json({ error: `Platz ${order} ist schon vergeben. Der nächste freie Platz ist ${nextDisplayOrder('feedback_questionnaire_sections', 'questionnaire_id', questionnaireId)}.` });
    }
    res.status(201).json({ id: db.prepare('INSERT INTO feedback_questionnaire_sections(questionnaire_id,title,description,display_order) VALUES(?,?,?,?)').run(questionnaireId, title, description, order).lastInsertRowid });
  });

  const sectionById = id => db.prepare('SELECT * FROM feedback_questionnaire_sections WHERE id=?').get(id);

  router.patch('/feedback/questionnaires/sections/:id', (req, res) => {
    const actor = current(req);
    const section = sectionById(asId(req.params.id));
    const body = bodyOf(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Abschnitte bearbeiten.' });
    if (!section) return res.status(404).json({ error: 'Abschnitt nicht gefunden.' });
    if (questionnaireLocked(questionnaireById(section.questionnaire_id))) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    const title = body.title === undefined ? section.title : text(body.title, 180);
    const description = body.description === undefined ? section.description : text(body.description, 1000);
    if (!title) return res.status(400).json({ error: 'Bitte gib dem Abschnitt einen Titel.' });
    db.prepare('UPDATE feedback_questionnaire_sections SET title=?,description=?,updated_at=? WHERE id=?').run(title, description, now(), section.id);
    res.json({ ok: true });
  });

  router.post('/feedback/questionnaires/sections/:id/move', (req, res) => {
    const actor = current(req);
    const section = sectionById(asId(req.params.id));
    const direction = bodyOf(req).direction;
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Abschnitte verschieben.' });
    if (!section) return res.status(404).json({ error: 'Abschnitt nicht gefunden.' });
    if (questionnaireLocked(questionnaireById(section.questionnaire_id))) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Die Richtung ist ungültig.' });
    res.json({ moved: moveInOrder('feedback_questionnaire_sections', 'questionnaire_id', section, direction) });
  });

  router.delete('/feedback/questionnaires/sections/:id', (req, res) => {
    const actor = current(req);
    const section = sectionById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Abschnitte löschen.' });
    if (!section) return res.status(404).json({ error: 'Abschnitt nicht gefunden.' });
    if (questionnaireLocked(questionnaireById(section.questionnaire_id))) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    db.transaction(() => {
      db.prepare('DELETE FROM feedback_questions WHERE section_id=?').run(section.id);
      db.prepare('DELETE FROM feedback_questionnaire_sections WHERE id=?').run(section.id);
      history(actor, 'feedback_section_deleted', { metadata: { questionnaireId: section.questionnaire_id, sectionId: section.id } });
    })();
    res.json({ ok: true });
  });

  router.post('/feedback/questionnaires/sections/:id/questions', (req, res) => {
    const actor = current(req);
    const sectionId = asId(req.params.id);
    const section = sectionById(sectionId);
    const body = bodyOf(req);
    const questionText = text(body.questionText);
    const competencyId = asId(body.competencyId);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragen anlegen.' });
    if (!section || questionnaireLocked(questionnaireById(section.questionnaire_id))) return res.status(409).json({ error: 'Fragen lassen sich nur in Fragebögen ändern, die noch nicht verwendet werden.' });
    if (!questionText || !QUESTION_TYPES.has(body.questionType) || !validCompetency(competencyId)) return res.status(400).json({ error: 'Bitte prüfe Fragetext, Art der Frage und Kompetenz.' });
    const order = asId(body.displayOrder) || nextDisplayOrder('feedback_questions', 'section_id', sectionId);
    if (db.prepare('SELECT id FROM feedback_questions WHERE section_id=? AND display_order=?').get(sectionId, order)) {
      return res.status(409).json({ error: `Platz ${order} ist schon vergeben. Der nächste freie Platz ist ${nextDisplayOrder('feedback_questions', 'section_id', sectionId)}.` });
    }
    const id = db.prepare('INSERT INTO feedback_questions(section_id,question_text,question_type,required,display_order,competency_id,help_text) VALUES(?,?,?,?,?,?,?)')
      .run(sectionId, questionText, body.questionType, bool(body.required) ? 1 : 0, order, competencyId, text(body.helpText, 1000)).lastInsertRowid;
    res.status(201).json({ id, displayOrder: order });
  });

  router.patch('/feedback/questions/:id', (req, res) => {
    const actor = current(req);
    const questionId = asId(req.params.id);
    const question = questionWithQuestionnaire(questionId);
    const body = bodyOf(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragen bearbeiten.' });
    if (!question) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    if (questionnaireLocked(questionnaireById(question.questionnaire_id))) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    const questionText = body.questionText === undefined ? question.question_text : text(body.questionText);
    const questionType = body.questionType === undefined ? question.question_type : body.questionType;
    const competencyId = body.competencyId === undefined ? question.competency_id : asId(body.competencyId);
    if (!questionText) return res.status(400).json({ error: 'Bitte gib einen Fragetext ein.' });
    if (!QUESTION_TYPES.has(questionType) || !validCompetency(competencyId)) return res.status(400).json({ error: 'Bitte prüfe die Art der Frage und die Kompetenz.' });
    db.prepare('UPDATE feedback_questions SET question_text=?,question_type=?,required=?,help_text=?,competency_id=?,active=?,updated_at=? WHERE id=?').run(
      questionText,
      questionType,
      body.required === undefined ? question.required : bool(body.required) ? 1 : 0,
      body.helpText === undefined ? question.help_text : text(body.helpText, 1000),
      competencyId,
      body.active === undefined ? question.active : bool(body.active) ? 1 : 0,
      now(),
      questionId
    );
    history(actor, 'feedback_question_updated', { metadata: { questionId } });
    res.json({ ok: true });
  });

  router.post('/feedback/questions/:id/move', (req, res) => {
    const actor = current(req);
    const question = questionWithQuestionnaire(asId(req.params.id));
    const direction = bodyOf(req).direction;
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragen verschieben.' });
    if (!question) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    if (questionnaireLocked(questionnaireById(question.questionnaire_id))) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Die Richtung ist ungültig.' });
    res.json({ moved: moveInOrder('feedback_questions', 'section_id', question, direction) });
  });

  router.delete('/feedback/questions/:id', (req, res) => {
    const actor = current(req);
    const question = questionWithQuestionnaire(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fragen löschen.' });
    if (!question) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    if (questionnaireLocked(questionnaireById(question.questionnaire_id))) return res.status(409).json({ error: 'Dieser Fragebogen wird schon verwendet und bleibt unverändert. Erstelle bitte eine neue Version.' });
    db.prepare('DELETE FROM feedback_questions WHERE id=?').run(question.id);
    history(actor, 'feedback_question_deleted', { metadata: { questionId: question.id, questionnaireId: question.questionnaire_id } });
    res.json({ ok: true });
  });

  // --- Feedbackrunden

  router.get('/feedback/cycles', (req, res) => {
    const actor = current(req);
    let items = db.prepare(`SELECT c.*,q.name questionnaire_name,q.version questionnaire_version,
      (SELECT COUNT(*) FROM feedback_cycle_participants p WHERE p.cycle_id=c.id) participant_count
      FROM feedback_cycles c JOIN feedback_questionnaires q ON q.id=c.questionnaire_id ORDER BY c.start_date DESC,c.id DESC`).all();
    if (!isHr(actor)) {
      const allowed = new Set(db.prepare(`SELECT p.cycle_id FROM feedback_cycle_participants p JOIN users e ON e.id=p.employee_id WHERE p.employee_id=? OR e.manager_id=?`).all(actor.id, actor.id).map(item => item.cycle_id));
      items = items.filter(item => allowed.has(item.id));
    }
    res.json({ items });
  });

  function validCycleDates({ startDate, endDate, nominationDeadline, feedbackDeadline }) {
    return [startDate, endDate, nominationDeadline, feedbackDeadline].every(value => value && validDate(value))
      && endDate >= startDate && nominationDeadline >= startDate && feedbackDeadline >= nominationDeadline && feedbackDeadline <= endDate;
  }

  router.post('/feedback/cycles', (req, res) => {
    const actor = current(req);
    const body = bodyOf(req);
    const name = text(body.name, 180);
    const description = text(body.description, 2000);
    const questionnaireId = asId(body.questionnaireId);
    const dates = {
      startDate: text(body.startDate, 10),
      endDate: text(body.endDate, 10),
      nominationDeadline: text(body.nominationDeadline, 10),
      feedbackDeadline: text(body.feedbackDeadline, 10)
    };
    const minimum = Math.max(3, Number.isInteger(Number(body.anonymousMinimum)) ? Number(body.anonymousMinimum) : 3);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Feedbackrunden anlegen.' });
    if (!name || !questionnaireById(questionnaireId) || !validCycleDates(dates)) return res.status(400).json({ error: 'Bitte gib einen Namen, einen Fragebogen und Daten in passender Reihenfolge an: Start, Vorschläge, Feedback, Ende.' });
    if (!questionnaireDetails(questionnaireId).sections.some(section => section.questions.length)) return res.status(400).json({ error: 'Der Fragebogen braucht mindestens eine Frage.' });
    const id = db.prepare(`INSERT INTO feedback_cycles(name,description,start_date,end_date,nomination_deadline,feedback_deadline,status,questionnaire_id,anonymous_minimum,created_by,updated_by)
      VALUES(?,?,?,?,?,?,'draft',?,?,?,?)`).run(name, description, dates.startDate, dates.endDate, dates.nominationDeadline, dates.feedbackDeadline, questionnaireId, minimum, actor.id, actor.id).lastInsertRowid;
    db.prepare('UPDATE feedback_questionnaires SET frozen=1,updated_at=? WHERE id=?').run(now(), questionnaireId);
    history(actor, 'feedback_cycle_created', { cycleId: id, metadata: { name, questionnaireId, minimum } });
    res.status(201).json({ id });
  });

  router.patch('/feedback/cycles/:id', (req, res) => {
    const actor = current(req);
    const cycleId = asId(req.params.id);
    const cycle = cycleById(cycleId);
    const body = bodyOf(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Feedbackrunden bearbeiten.' });
    if (!cycle) return res.status(404).json({ error: 'Feedbackrunde nicht gefunden.' });
    if (cycle.status !== 'draft') return res.status(409).json({ error: 'Nur Entwürfe lassen sich bearbeiten. Bei einer laufenden Runde kannst du die Fristen verlängern.' });
    const name = body.name === undefined ? cycle.name : text(body.name, 180);
    const description = body.description === undefined ? cycle.description : text(body.description, 2000);
    const dates = {
      startDate: body.startDate === undefined ? cycle.start_date : text(body.startDate, 10),
      endDate: body.endDate === undefined ? cycle.end_date : text(body.endDate, 10),
      nominationDeadline: body.nominationDeadline === undefined ? cycle.nomination_deadline : text(body.nominationDeadline, 10),
      feedbackDeadline: body.feedbackDeadline === undefined ? cycle.feedback_deadline : text(body.feedbackDeadline, 10)
    };
    if (!name || !validCycleDates(dates)) return res.status(400).json({ error: 'Bitte gib einen Namen und Daten in passender Reihenfolge an: Start, Vorschläge, Feedback, Ende.' });
    db.prepare('UPDATE feedback_cycles SET name=?,description=?,start_date=?,end_date=?,nomination_deadline=?,feedback_deadline=?,updated_by=?,updated_at=? WHERE id=?').run(name, description, dates.startDate, dates.endDate, dates.nominationDeadline, dates.feedbackDeadline, actor.id, now(), cycleId);
    history(actor, 'feedback_cycle_updated', { cycleId, metadata: { name } });
    res.json({ ok: true });
  });

  router.patch('/feedback/cycles/:id/deadlines', (req, res) => {
    const actor = current(req);
    const cycleId = asId(req.params.id);
    const cycle = cycleById(cycleId);
    const body = bodyOf(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Fristen verlängern.' });
    if (!cycle) return res.status(404).json({ error: 'Feedbackrunde nicht gefunden.' });
    if (!RUNNING_CYCLE_STATUSES.includes(cycle.status)) return res.status(409).json({ error: 'Fristen lassen sich nur in einer laufenden Feedbackrunde verlängern.' });
    const nominationDeadline = body.nominationDeadline === undefined ? cycle.nomination_deadline : text(body.nominationDeadline, 10);
    const feedbackDeadline = body.feedbackDeadline === undefined ? cycle.feedback_deadline : text(body.feedbackDeadline, 10);
    if (!nominationDeadline || !feedbackDeadline || !validDate(nominationDeadline) || !validDate(feedbackDeadline)) return res.status(400).json({ error: 'Bitte gib gültige Daten an.' });
    if (nominationDeadline < cycle.nomination_deadline || feedbackDeadline < cycle.feedback_deadline) return res.status(400).json({ error: 'Eine Frist lässt sich hier nur nach hinten verschieben.' });
    const nominationChanged = nominationDeadline !== cycle.nomination_deadline;
    const feedbackChanged = feedbackDeadline !== cycle.feedback_deadline;
    if (!nominationChanged && !feedbackChanged) return res.status(400).json({ error: 'Bitte wähle ein späteres Datum.' });
    if ((nominationChanged && nominationDeadline < today()) || (feedbackChanged && feedbackDeadline < today())) return res.status(400).json({ error: 'Die neue Frist darf nicht in der Vergangenheit liegen.' });
    if (feedbackDeadline < nominationDeadline) return res.status(400).json({ error: 'Die Frist für das Feedback darf nicht vor der Frist für Vorschläge liegen.' });
    const endDate = feedbackDeadline > cycle.end_date ? feedbackDeadline : cycle.end_date;
    db.transaction(() => {
      db.prepare('UPDATE feedback_cycles SET nomination_deadline=?,feedback_deadline=?,end_date=?,updated_by=?,updated_at=? WHERE id=?').run(nominationDeadline, feedbackDeadline, endDate, actor.id, now(), cycleId);
      refreshTaskDeadlines({ id: cycleId, nomination_deadline: nominationDeadline, feedback_deadline: feedbackDeadline });
      history(actor, 'feedback_cycle_deadline_extended', {
        cycleId,
        metadata: { previous: { nominationDeadline: cycle.nomination_deadline, feedbackDeadline: cycle.feedback_deadline }, next: { nominationDeadline, feedbackDeadline } }
      });
    })();
    res.json({ ok: true, nominationDeadline, feedbackDeadline, endDate });
  });

  router.patch('/feedback/cycles/:id/status', (req, res) => {
    const actor = current(req);
    const cycleId = asId(req.params.id);
    const cycle = cycleById(cycleId);
    const next = bodyOf(req).status;
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf die Phase einer Feedbackrunde ändern.' });
    if (!cycle) return res.status(404).json({ error: 'Feedbackrunde nicht gefunden.' });
    if (!CYCLE_STATUSES.has(next) || !(CYCLE_TRANSITIONS[cycle.status] || []).includes(next)) return res.status(409).json({ error: 'Dieser Phasenwechsel ist nicht möglich.' });
    // Sonst stünde die Runde in einer Phase, in der wegen der Frist niemand mehr etwas tun kann.
    if (next === 'nomination' && cycle.nomination_deadline < today()) return res.status(409).json({ error: `Die Frist für Vorschläge ist am ${germanDate(cycle.nomination_deadline)} abgelaufen. Verschiebe sie zuerst.` });
    if (next === 'open' && cycle.feedback_deadline < today()) return res.status(409).json({ error: `Die Frist für das Feedback ist am ${germanDate(cycle.feedback_deadline)} abgelaufen. Verschiebe sie zuerst.` });
    const resetForNominations = cycle.status === 'open' && next === 'nomination';
    db.transaction(() => {
      db.prepare('UPDATE feedback_cycles SET status=?,updated_by=?,updated_at=? WHERE id=?').run(next, actor.id, now(), cycleId);
      const pausedTasks = resetForNominations ? pausePendingInvitationTasks(cycleId) : 0;
      if (next === 'nomination') {
        db.prepare("UPDATE feedback_cycle_participants SET status='nominating',updated_at=? WHERE cycle_id=? AND status IN ('planned','feedback_open')").run(now(), cycleId);
        for (const participant of db.prepare('SELECT id,employee_id FROM feedback_cycle_participants WHERE cycle_id=? AND nomination_completed=0').all(cycleId)) {
          task(participant.employee_id, nominateTaskTitle(cycle.name), 'feedback_nominate', participant.id, cycle.nomination_deadline);
        }
      }
      if (next === 'open') {
        closeCycleTasks(cycleId, ['feedback_nominate']);
        inviteApprovedNominations(cycleId, actor);
        resumePendingInvitationTasks(cycle);
        db.prepare("UPDATE feedback_cycle_participants SET status='feedback_open',updated_at=? WHERE cycle_id=? AND status IN ('planned','nominating')").run(now(), cycleId);
      }
      if (next === 'evaluation') {
        closeCycleTasks(cycleId, ['feedback_submit', 'feedback_nominate', 'feedback_nomination_review']);
        db.prepare("UPDATE feedback_cycle_participants SET status='in_evaluation',updated_at=? WHERE cycle_id=? AND status!='cancelled'").run(now(), cycleId);
      }
      if (next === 'completed') db.prepare("UPDATE feedback_cycle_participants SET status='completed',updated_at=? WHERE cycle_id=? AND status!='cancelled'").run(now(), cycleId);
      if (next === 'archived') closeCycleTasks(cycleId, Object.keys(CYCLE_TASK_TARGETS));
      history(actor, resetForNominations ? 'feedback_cycle_reset_to_nomination' : 'feedback_cycle_status_changed', {
        cycleId,
        metadata: { previousStatus: cycle.status, nextStatus: next, pausedInvitationTasks: pausedTasks, responsesPreserved: resetForNominations }
      });
    })();
    res.json({ ok: true, status: next });
  });

  router.get('/feedback/cycles/:id', (req, res) => {
    const actor = current(req);
    const cycleId = asId(req.params.id);
    const cycle = cycleById(cycleId);
    if (!cycle) return res.status(404).json({ error: 'Feedbackrunde nicht gefunden.' });
    const participants = participantsOfCycle(cycleId, actor);
    if (!isHr(actor) && !participants.length) return res.status(403).json({ error: 'Du hast keinen Zugriff auf diese Feedbackrunde.' });
    res.json({
      cycle: {
        ...cycle,
        questionnaire: questionnaireDetails(cycle.questionnaire_id),
        participants: participants.map(participant => {
          const progress = progressFor(participant, actor);
          return { ...participantForReader(participant, actor), invitations: progress.invited, submitted: progress.submitted, permissions: participantPermissions(actor, participant) };
        })
      }
    });
  });

  router.post('/feedback/cycles/:id/participants', (req, res) => {
    const actor = current(req);
    const cycleId = asId(req.params.id);
    const cycle = cycleById(cycleId);
    const employeeId = asId(bodyOf(req).employeeId);
    const employee = userById(employeeId);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Personen in eine Feedbackrunde aufnehmen.' });
    if (!cycle || !['draft', 'nomination'].includes(cycle.status)) return res.status(409).json({ error: 'Personen lassen sich nur im Entwurf oder während der Vorschläge aufnehmen.' });
    if (!employee || !employee.active || employee.is_system_account) return res.status(400).json({ error: 'Diese Person gibt es nicht.' });
    if (!hrCanAccess(actor, employee) || blocksSelfEdit(actor, employee.id)) return res.status(403).json({ error: 'Du darfst diese Person nicht in eine Feedbackrunde aufnehmen.' });
    if (db.prepare('SELECT id FROM feedback_cycle_participants WHERE cycle_id=? AND employee_id=?').get(cycleId, employeeId)) return res.status(409).json({ error: 'Diese Person ist schon in der Feedbackrunde.' });
    const id = db.transaction(() => {
      const participantId = db.prepare('INSERT INTO feedback_cycle_participants(cycle_id,employee_id,manager_id,status) VALUES(?,?,?,?)').run(cycleId, employeeId, employee.manager_id || null, cycle.status === 'nomination' ? 'nominating' : 'planned').lastInsertRowid;
      db.prepare('INSERT INTO feedback_result_statuses(participant_id,status,updated_by) VALUES(?,?,?)').run(participantId, 'pending', actor.id);
      const nomination = db.prepare('INSERT INTO feedback_nominations(participant_id,giver_id,feedback_group,proposed_by,status,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?)');
      nomination.run(participantId, employeeId, 'self', actor.id, 'approved', actor.id, now());
      if (employee.manager_id) nomination.run(participantId, employee.manager_id, 'manager', actor.id, 'approved', actor.id, now());
      // Im Entwurf kann die Person noch nichts tun. Die Aufgabe entsteht, wenn die Vorschläge beginnen.
      if (cycle.status === 'nomination') task(employeeId, nominateTaskTitle(cycle.name), 'feedback_nominate', participantId, cycle.nomination_deadline);
      history(actor, 'feedback_participant_added', { participantId, cycleId, metadata: { employeeId } });
      return participantId;
    })();
    res.status(201).json({ id });
  });

  // --- Vorschläge

  router.get('/feedback/participants/:id/nominations', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.id));
    if (!participant) return res.status(404).json({ error: 'Teilnahme nicht gefunden.' });
    if (!hrSeesDetails(actor, participant) && !isEmployee(actor, participant) && !isCurrentManager(actor, participant)) return res.status(403).json({ error: 'Du hast keinen Zugriff auf diese Vorschläge.' });
    const nominations = db.prepare(`SELECT n.*,u.name giver_name,u.title giver_title,p.name proposer_name,c.name confirmer_name FROM feedback_nominations n
      JOIN users u ON u.id=n.giver_id JOIN users p ON p.id=n.proposed_by LEFT JOIN users c ON c.id=n.confirmed_by
      WHERE n.participant_id=? ORDER BY n.created_at,n.id`).all(participant.id);
    res.json({
      participant: participantForReader(participant, actor),
      nominations: nominations.map(nomination => nominationForReader(nomination, actor, participant)),
      progress: progressFor(participant, actor),
      permissions: participantPermissions(actor, participant)
    });
  });

  router.get('/feedback/nominations/candidates', (req, res) => {
    const actor = current(req);
    const involved = db.prepare('SELECT 1 FROM feedback_cycle_participants p JOIN users e ON e.id=p.employee_id WHERE p.employee_id=? OR e.manager_id=? LIMIT 1').get(actor.id, actor.id);
    // Das Personenverzeichnis braucht nur, wer auch jemanden vorschlagen kann.
    if (!isHr(actor) && !involved) return res.status(403).json({ error: 'Du bist in keiner Feedbackrunde und kannst niemanden vorschlagen.' });
    const participant = req.query.participantId ? participantDetails(asId(req.query.participantId)) : null;
    const taken = new Set(participant && canEditNominations(actor, participant)
      ? [participant.employee_id, ...db.prepare('SELECT giver_id FROM feedback_nominations WHERE participant_id=?').all(participant.id).map(row => row.giver_id)]
      : []);
    const users = db.prepare('SELECT id,name,title,role FROM users WHERE id!=? AND is_system_account=0 AND active=1').all(actor.id)
      .filter(user => !taken.has(user.id))
      .sort(byGermanName)
      .map(({ role, ...user }) => (isHr(actor) ? { ...user, role } : user));
    res.json({ users });
  });

  router.post('/feedback/participants/:id/nominations', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.id));
    const body = bodyOf(req);
    const giverId = asId(body.giverId);
    const giver = giverId ? userById(giverId) : null;
    if (!participant || !giver || !giver.active || giver.is_system_account) return res.status(400).json({ error: 'Bitte wähle eine Person aus.' });
    if (!canEditNominations(actor, participant)) return res.status(403).json({ error: 'Du darfst für diese Person niemanden vorschlagen.' });
    if (!cycleCanNominate(participant)) return res.status(403).json({ error: nominationBlockedReason(participant) });
    const group = deriveGroup(participant, giverId, body.feedbackGroup, actor);
    if (!group) return res.status(400).json({ error: 'Die Gruppe dieser Person ließ sich nicht bestimmen.' });
    if (db.prepare('SELECT id FROM feedback_nominations WHERE participant_id=? AND giver_id=?').get(participant.id, giverId)) return res.status(409).json({ error: 'Diese Person wurde schon vorgeschlagen.' });
    const id = db.transaction(() => {
      const nominationId = db.prepare('INSERT INTO feedback_nominations(participant_id,giver_id,feedback_group,proposed_by,status) VALUES(?,?,?,?,?)').run(participant.id, giverId, group, actor.id, 'proposed').lastInsertRowid;
      const reviewer = participant.manager_id || firstHrId();
      if (reviewer && reviewer !== actor.id) {
        task(reviewer, `Vorschlag prüfen: ${giver.name} soll ${participant.employee_name} Feedback geben`, 'feedback_nomination_review', nominationId, participant.nomination_deadline);
      }
      history(actor, 'feedback_nomination_proposed', { participantId: participant.id, cycleId: participant.cycle_id, metadata: { nominationId, giverId, group } });
      return nominationId;
    })();
    res.status(201).json({ id, feedbackGroup: group });
  });

  router.post('/feedback/participants/:id/nominations/complete', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.id));
    if (!participant) return res.status(404).json({ error: 'Teilnahme nicht gefunden.' });
    if (!isEmployee(actor, participant) && !hrManages(actor, participant)) return res.status(403).json({ error: 'Nur die Person selbst oder HR kann die Vorschläge abschließen.' });
    if (participant.cycle_status !== 'nomination') return res.status(409).json({ error: 'Die Runde sammelt gerade keine Vorschläge.' });
    db.transaction(() => {
      db.prepare('UPDATE feedback_cycle_participants SET nomination_completed=1,updated_at=? WHERE id=?').run(now(), participant.id);
      closeTasks('feedback_nominate', participant.id);
      history(actor, 'feedback_nominations_completed', { participantId: participant.id, cycleId: participant.cycle_id });
    })();
    res.json({ ok: true });
  });

  router.patch('/feedback/nominations/:id', (req, res) => {
    const actor = current(req);
    const nominationId = asId(req.params.id);
    const nomination = db.prepare('SELECT * FROM feedback_nominations WHERE id=?').get(nominationId);
    const body = bodyOf(req);
    const decision = body.status;
    const reason = text(body.rejectionReason, 1000);
    if (!nomination) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    const participant = participantDetails(nomination.participant_id);
    if (!canManageParticipant(actor, participant)) return res.status(403).json({ error: 'Nur die zuständige Führungskraft oder HR darf Vorschläge prüfen.' });
    if (nomination.status !== 'proposed' || !['approved', 'rejected'].includes(decision) || !RUNNING_CYCLE_STATUSES.includes(participant.cycle_status)) return res.status(409).json({ error: 'Dieser Vorschlag lässt sich nicht mehr ändern.' });
    if (decision === 'rejected' && reason.length < 3) return res.status(400).json({ error: 'Bitte begründe die Ablehnung kurz.' });
    db.transaction(() => {
      db.prepare('UPDATE feedback_nominations SET status=?,rejection_reason=?,confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=?').run(decision, decision === 'rejected' ? reason : null, actor.id, now(), now(), nominationId);
      closeTasks('feedback_nomination_review', nominationId);
      if (decision === 'approved' && participant.cycle_status === 'open') addInvitation({ ...nomination, status: 'approved' }, actor);
      if (decision === 'rejected' && nomination.proposed_by !== actor.id) {
        const giverName = userById(nomination.giver_id)?.name || 'Eine Person';
        task(nomination.proposed_by, `Vorschlag abgelehnt: ${giverName} gibt ${participant.employee_name} kein 360° Feedback`, 'feedback_nomination_rejected_notice', nominationId);
      }
      history(actor, decision === 'approved' ? 'feedback_nomination_approved' : 'feedback_nomination_rejected', {
        participantId: participant.id,
        cycleId: participant.cycle_id,
        metadata: { nominationId, reason: decision === 'rejected' ? reason : undefined }
      });
    })();
    res.json({ ok: true });
  });

  const TASK_TARGET_LOOKUPS = new Map([
    ['feedback_nomination_review', 'SELECT participant_id FROM feedback_nominations WHERE id=?'],
    ['feedback_nomination_rejected_notice', 'SELECT participant_id FROM feedback_nominations WHERE id=?'],
    ['feedback_development_action', 'SELECT participant_id FROM feedback_development_actions WHERE id=?']
  ]);

  /** Manche Aufgaben hängen an einem Vorschlag oder einer Maßnahme, der Knopf führt aber zur Teilnahme. */
  router.get('/feedback/task-target', (req, res) => {
    const actor = current(req);
    const lookup = TASK_TARGET_LOOKUPS.get(req.query.type);
    const row = lookup ? db.prepare(lookup).get(asId(req.query.id)) : null;
    const participant = row ? participantDetails(row.participant_id) : null;
    if (!participant || !canSeeParticipant(actor, participant)) return res.status(404).json({ error: 'Dieser Vorgang ist nicht mehr verfügbar.' });
    res.json({ participantId: participant.id });
  });

  // --- Feedback abgeben

  router.get('/feedback/invitations', (req, res) => {
    const actor = current(req);
    const items = db.prepare(`SELECT i.id,i.status,i.feedback_group,i.invited_at,i.submitted_at,c.name cycle_name,c.feedback_deadline,p.id participant_id,e.name employee_name
      FROM feedback_invitations i JOIN feedback_cycle_participants p ON p.id=i.participant_id JOIN feedback_cycles c ON c.id=p.cycle_id JOIN users e ON e.id=p.employee_id
      WHERE i.giver_id=? ORDER BY c.feedback_deadline,i.invited_at`).all(actor.id)
      .map(item => ({ ...item, deadlineState: item.status === 'submitted' ? 'completed' : dueState(item.feedback_deadline) }));
    res.json({ items });
  });

  router.get('/feedback/invitations/:id', (req, res) => {
    const actor = current(req);
    const invitation = invitationForActor(asId(req.params.id), actor);
    if (!invitation) return res.status(403).json({ error: 'Du kannst nur deine eigenen Feedbackanfragen öffnen.' });
    if (['submitted', 'declined'].includes(invitation.status)) return res.status(409).json({ error: 'Diese Feedbackanfrage ist bereits abgeschlossen.' });
    if (!cycleCanAnswer(invitation)) return res.status(409).json({ error: answerBlockedReason(invitation), code: 'feedback_not_open' });
    res.json(invitationForm(invitation));
  });

  function answerProblem(invitation) {
    if (!['invited', 'started'].includes(invitation.status)) return 'Diese Feedbackanfrage ist bereits abgeschlossen.';
    return cycleCanAnswer(invitation) ? null : answerBlockedReason(invitation);
  }

  router.put('/feedback/invitations/:id/responses', (req, res) => {
    const actor = current(req);
    const invitation = invitationForActor(asId(req.params.id), actor);
    if (!invitation) return res.status(403).json({ error: 'Du kannst nur deine eigenen Antworten bearbeiten.' });
    const problem = answerProblem(invitation);
    if (problem) return res.status(409).json({ error: problem, code: 'feedback_not_open' });
    try {
      saveResponses(invitation, actor, bodyOf(req).answers, false);
      res.json({ ok: true });
    } catch (error) {
      respondToFailure(res, error);
    }
  });

  router.post('/feedback/invitations/:id/submit', (req, res) => {
    const actor = current(req);
    const invitation = invitationForActor(asId(req.params.id), actor);
    if (!invitation) return res.status(403).json({ error: 'Du kannst nur deine eigene Feedbackanfrage absenden.' });
    const problem = answerProblem(invitation);
    if (problem) return res.status(409).json({ error: problem, code: 'feedback_not_open' });
    try {
      saveResponses(invitation, actor, bodyOf(req).answers, true);
      res.json({ ok: true });
    } catch (error) {
      respondToFailure(res, error);
    }
  });

  router.post('/feedback/invitations/:id/decline', (req, res) => {
    const actor = current(req);
    const invitation = invitationForActor(asId(req.params.id), actor);
    if (!invitation) return res.status(403).json({ error: 'Du kannst nur deine eigene Feedbackanfrage ablehnen.' });
    const problem = answerProblem(invitation);
    if (problem) return res.status(409).json({ error: problem, code: 'feedback_not_open' });
    db.transaction(() => {
      db.prepare("UPDATE feedback_invitations SET status='declined',declined_at=? WHERE id=?").run(now(), invitation.id);
      db.prepare("UPDATE feedback_nominations SET status='declined',updated_at=? WHERE id=?").run(now(), invitation.nomination_id);
      closeTasks('feedback_submit', invitation.id, actor.id);
      updateParticipantCompletion(invitation.participant_id);
      history(actor, 'feedback_invitation_declined', { participantId: invitation.participant_id, cycleId: invitation.cycle_id, metadata: { invitationId: invitation.id } });
    })();
    res.json({ ok: true });
  });

  router.post('/feedback/invitations/:id/reopen', (req, res) => {
    const actor = current(req);
    const invitationId = asId(req.params.id);
    const invitation = db.prepare(`SELECT i.*,p.cycle_id,p.employee_id,c.status cycle_status,c.feedback_deadline
      FROM feedback_invitations i JOIN feedback_cycle_participants p ON p.id=i.participant_id JOIN feedback_cycles c ON c.id=p.cycle_id WHERE i.id=?`).get(invitationId);
    if (!isHr(actor) || (invitation && !hrManages(actor, invitation))) return res.status(403).json({ error: 'Nur HR darf abgegebenes Feedback wieder öffnen.' });
    if (!invitation || invitation.status !== 'submitted' || !cycleCanAnswer(invitation)) return res.status(409).json({ error: 'Diese Antwort lässt sich gerade nicht wieder öffnen.' });
    const employeeName = userById(invitation.employee_id)?.name || 'die Person';
    db.transaction(() => {
      db.prepare("UPDATE feedback_invitations SET status='started',submitted_at=NULL,reopened_at=?,reopened_by=? WHERE id=?").run(now(), actor.id, invitationId);
      db.prepare("UPDATE feedback_nominations SET status='started',updated_at=? WHERE id=?").run(now(), invitation.nomination_id);
      db.prepare('UPDATE feedback_responses SET draft=1,submitted_at=NULL,updated_at=? WHERE invitation_id=?').run(now(), invitationId);
      updateParticipantCompletion(invitation.participant_id);
      task(invitation.giver_id, `360° Feedback für ${employeeName} erneut abschließen`, 'feedback_submit', invitationId, invitation.feedback_deadline);
      history(actor, 'feedback_reopened', { participantId: invitation.participant_id, cycleId: invitation.cycle_id, metadata: { invitationId } });
    })();
    res.json({ ok: true });
  });

  router.get('/feedback/cycles/:id/progress', (req, res) => {
    const actor = current(req);
    const cycleId = asId(req.params.id);
    const cycle = cycleById(cycleId);
    if (!cycle) return res.status(404).json({ error: 'Feedbackrunde nicht gefunden.' });
    const participants = participantsOfCycle(cycleId, actor);
    if (!isHr(actor) && !participants.length) return res.status(403).json({ error: 'Du hast keinen Zugriff auf diesen Fortschritt.' });
    const progress = participants.map(participant => progressFor(participant, actor));
    const invited = sum(progress.map(item => item.invited));
    const submitted = sum(progress.map(item => item.submitted));
    const deadlinePassed = cycle.status === 'open' && cycle.feedback_deadline < today();
    res.json({
      cycle: { id: cycle.id, name: cycle.name, status: cycle.status },
      metrics: {
        participants: participants.length,
        nominationsComplete: participants.filter(item => item.nomination_completed).length,
        invitations: invited,
        submitted,
        // Offen ist nur für HR eine Zahl. Andere könnten sonst abgelehnte Anfragen ausrechnen.
        overdue: deadlinePassed && isHr(actor) ? sum(progress.map(item => item.invited - item.submitted - (item.declined || 0))) : 0,
        responseRate: invited ? Math.round((submitted / invited) * 100) : 0
      },
      participants: participants.map(participant => ({
        id: participant.id,
        employeeId: participant.employee_id,
        status: participant.status,
        ...(hrSeesDetails(actor, participant) ? { feedbackCompleted: !!participant.feedback_completed } : {})
      }))
    });
  });

  // --- Berichte

  router.post('/feedback/results/:participantId/calculate', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.participantId));
    if (!isHr(actor) || (participant && !hrManages(actor, participant))) return res.status(403).json({ error: 'Nur HR darf Berichte berechnen.' });
    if (!participant || !RESULT_PHASES.includes(participant.cycle_status)) return res.status(409).json({ error: 'Berichte lassen sich erst berechnen, wenn die Auswertung begonnen hat.' });
    const status = resultStatus(participant.id);
    if (!status || status.status !== 'pending') return res.status(409).json({ error: 'Dieser Bericht wurde schon berechnet.' });
    db.transaction(() => {
      db.prepare("UPDATE feedback_result_statuses SET status='calculated',calculated_at=?,updated_by=?,updated_at=? WHERE participant_id=?").run(now(), actor.id, now(), participant.id);
      task(actor.id, `360°-Bericht von ${participant.employee_name} prüfen und freigeben`, 'feedback_result_review', participant.id);
      history(actor, 'feedback_result_calculated', {
        participantId: participant.id,
        cycleId: participant.cycle_id,
        metadata: { submittedInvitations: db.prepare("SELECT COUNT(*) count FROM feedback_invitations WHERE participant_id=? AND status='submitted'").get(participant.id).count }
      });
    })();
    res.json({ result: canReadResult(actor, participant, 'calculated') ? calculateResult(participant.id, actor) : null });
  });

  router.get('/feedback/results/:participantId', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.participantId));
    if (!participant) return res.status(404).json({ error: 'Teilnahme nicht gefunden.' });
    const status = resultStatus(participant.id);
    if (hrSeesDetails(actor, participant) && (!status || status.status === 'pending')) {
      // Berichte aus einer laufenden Runde ließen sich vergleichen und verrieten dann einzelne Antworten.
      return res.status(409).json({ error: 'Dieser Bericht wurde noch nicht berechnet. Das geht erst, wenn die Auswertung begonnen hat.' });
    }
    if (!canReadResult(actor, participant, status?.status)) return res.status(403).json({ error: 'Dieser Bericht ist noch nicht für dich freigegeben.' });
    if (isEmployee(actor, participant)) {
      closeTasks('feedback_result', participant.id, actor.id);
      closeTasks('feedback_development_action_notice', participant.id, actor.id);
      db.prepare(`UPDATE tasks SET done=1 WHERE type='feedback_development_action' AND done=0 AND user_id=?
        AND entity_id IN (SELECT id FROM feedback_development_actions WHERE participant_id=?)`).run(actor.id, participant.id);
    }
    const actions = db.prepare(`SELECT a.id,a.action_type,a.description,a.target_date,a.status,a.linked_goal_id,c.name competency_name,u.name responsible_name
      FROM feedback_development_actions a LEFT JOIN competencies c ON c.id=a.competency_id LEFT JOIN users u ON u.id=a.responsible_id
      WHERE a.participant_id=? ORDER BY a.updated_at DESC,a.id DESC`).all(participant.id);
    res.json({ status: resultStatusForReader(status), result: calculateResult(participant.id, actor), actions, permissions: resultPermissions(actor, participant, status) });
  });

  router.patch('/feedback/results/:participantId/status', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.participantId));
    const nextStatus = bodyOf(req).status;
    if (!isHr(actor) || (participant && !hrManages(actor, participant))) return res.status(403).json({ error: 'Nur HR darf Berichte freigeben.' });
    if (!participant || !RESULT_STATUSES.has(nextStatus)) return res.status(400).json({ error: 'Teilnahme oder Schritt ist ungültig.' });
    if (!RESULT_PHASES.includes(participant.cycle_status)) return res.status(409).json({ error: 'Berichte lassen sich erst freigeben, wenn die Auswertung begonnen hat.' });
    try {
      setResultStatus(participant, actor, nextStatus);
      res.json({ ok: true, status: nextStatus });
    } catch (error) {
      respondToFailure(res, error);
    }
  });

  router.post('/feedback/results/:participantId/meeting', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.participantId));
    if (!participant) return res.status(404).json({ error: 'Teilnahme nicht gefunden.' });
    if (!isCurrentManager(actor, participant)) return res.status(403).json({ error: 'Nur die aktuelle Führungskraft schließt das Ergebnisgespräch ab.' });
    if (!RELEASED_FOR_MANAGER.includes(participant.result_status)) return res.status(409).json({ error: 'Der Bericht ist noch nicht für dich freigegeben.' });
    if (participant.meeting_completed_at) return res.status(409).json({ error: 'Das Ergebnisgespräch ist schon abgeschlossen.' });
    db.transaction(() => {
      db.prepare('UPDATE feedback_result_statuses SET meeting_completed_at=?,meeting_completed_by=?,updated_at=? WHERE participant_id=?').run(now(), actor.id, now(), participant.id);
      closeTasks('feedback_result_meeting', participant.id);
      history(actor, 'feedback_result_meeting_completed', { participantId: participant.id, cycleId: participant.cycle_id });
    })();
    res.json({ ok: true });
  });

  router.post('/feedback/participants/:id/development-actions', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.id));
    const body = bodyOf(req);
    const actionType = body.actionType;
    const description = text(body.description, 3000);
    const competencyId = asId(body.competencyId);
    const responsibleId = asId(body.responsibleId);
    const targetDate = text(body.targetDate, 10) || null;
    const createGoal = bool(body.createGoal);
    const goalTitle = text(body.goalTitle, 240);
    if (!participant || !canManageParticipant(actor, participant)) return res.status(403).json({ error: 'Nur HR oder die Führungskraft darf Maßnahmen festhalten.' });
    const status = resultStatus(participant.id);
    if (!RELEASED_FOR_MANAGER.includes(status?.status)) return res.status(409).json({ error: 'Maßnahmen lassen sich erst nach der Freigabe des Berichts festhalten.' });
    if (!DEVELOPMENT_ACTIONS.has(actionType) || description.length < 10 || !validDate(targetDate) || !validCompetency(competencyId) || (responsibleId && !userById(responsibleId))) return res.status(400).json({ error: 'Bitte prüfe die Maßnahme. Die Beschreibung braucht mindestens 10 Zeichen.' });
    if (createGoal && (!goalTitle || !targetDate)) return res.status(400).json({ error: 'Für ein Entwicklungsziel brauchst du einen Titel und einen Termin.' });
    try {
      const created = db.transaction(() => {
        let goalId = null;
        if (createGoal) {
          const approval = participant.manager_id ? 'pending_employee_acceptance' : 'approved';
          goalId = db.prepare('INSERT INTO goals(user_id,title,description,weight,progress,status,due_date,created_by,approval_status,goal_type) VALUES(?,?,?,?,?,?,?,?,?,?)').run(participant.employee_id, goalTitle, description, 100, 0, 'on_track', targetDate, actor.id, approval, 'development').lastInsertRowid;
          if (competencyId) db.prepare('INSERT OR IGNORE INTO goal_competencies(goal_id,competency_id,created_by) VALUES(?,?,?)').run(goalId, competencyId, actor.id);
          if (approval === 'pending_employee_acceptance') task(participant.employee_id, `${actor.name} hat dir ein Entwicklungsziel aus dem 360° Feedback vorgeschlagen`, 'goal_acceptance', goalId);
        }
        const id = db.prepare('INSERT INTO feedback_development_actions(participant_id,action_type,description,competency_id,responsible_id,target_date,linked_goal_id,created_by) VALUES(?,?,?,?,?,?,?,?)').run(participant.id, actionType, description, competencyId, responsibleId, targetDate, goalId, actor.id).lastInsertRowid;
        // Sieht die Person den Bericht noch nicht, würde der Hinweis ins Leere führen.
        if (RELEASED_FOR_EMPLOYEE.includes(status.status)) {
          task(participant.employee_id, `${actor.name} hat eine Entwicklungsmaßnahme aus deinem 360° Feedback festgehalten`, 'feedback_development_action_notice', participant.id);
        }
        history(actor, 'feedback_development_action_created', { participantId: participant.id, cycleId: participant.cycle_id, metadata: { actionId: id, actionType, goalId, competencyId } });
        return { id, goalId };
      })();
      res.status(201).json(created);
    } catch (error) {
      respondToFailure(res, error);
    }
  });

  // --- Übersicht und Verlauf

  router.get('/feedback/dashboard', (req, res) => {
    const actor = current(req);
    const invitations = db.prepare(`SELECT i.id,i.status,i.feedback_group,c.name cycle_name,c.feedback_deadline,p.id participant_id,e.name employee_name FROM feedback_invitations i
      JOIN feedback_cycle_participants p ON p.id=i.participant_id JOIN feedback_cycles c ON c.id=p.cycle_id JOIN users e ON e.id=p.employee_id
      WHERE i.giver_id=? AND c.status='open' ORDER BY c.feedback_deadline,i.id`).all(actor.id);
    const casesQuery = `SELECT p.id,p.cycle_id,p.employee_id,p.status,p.nomination_completed,c.name cycle_name,c.status cycle_status,c.nomination_deadline,c.feedback_deadline,r.status result_status,e.name employee_name
      FROM feedback_cycle_participants p
      JOIN feedback_cycles c ON c.id=p.cycle_id
      JOIN users e ON e.id=p.employee_id
      LEFT JOIN feedback_result_statuses r ON r.participant_id=p.id`;
    const own = db.prepare(`${casesQuery} WHERE p.employee_id=? ORDER BY c.start_date DESC,p.id DESC`).all(actor.id);
    const team = db.prepare(`${casesQuery} WHERE e.manager_id=? ORDER BY c.start_date DESC,p.id DESC`).all(actor.id);
    const cycles = isHr(actor) ? db.prepare("SELECT id,name,status,nomination_deadline,feedback_deadline FROM feedback_cycles WHERE status!='archived' ORDER BY start_date DESC,id DESC").all() : [];
    res.json({
      invitations: invitations.map(item => ({
        id: item.id,
        participantId: item.participant_id,
        employeeName: item.employee_name,
        cycleName: item.cycle_name,
        feedbackGroup: item.feedback_group,
        status: item.status,
        deadline: item.feedback_deadline,
        reminder: item.status === 'submitted' ? 'completed' : dueState(item.feedback_deadline)
      })),
      ownCycles: own,
      teamCycles: team,
      hrCycles: cycles.map(cycle => ({ ...cycle, deadlineState: dueState(cycle.status === 'nomination' ? cycle.nomination_deadline : cycle.feedback_deadline) })),
      metrics: {
        openInvitations: invitations.filter(item => ['invited', 'started'].includes(item.status)).length,
        releasedReports: own.filter(item => RELEASED_FOR_EMPLOYEE.includes(item.result_status)).length,
        teamOpen: team.filter(item => ['nominating', 'feedback_open', 'in_evaluation'].includes(item.status)).length
      }
    });
  });

  router.get('/feedback/history/:participantId', (req, res) => {
    const actor = current(req);
    const participant = participantDetails(asId(req.params.participantId));
    const allowed = participant && (hrSeesDetails(actor, participant) || isCurrentManager(actor, participant) || isEmployee(actor, participant));
    if (!allowed) return res.status(403).json({ error: 'Du hast keinen Zugriff auf diesen Verlauf.' });
    const progress = progressFor(participant, actor);
    if (!hrSeesDetails(actor, participant)) return res.json({ items: [], progress });
    const items = db.prepare('SELECT h.*,u.name actor_name FROM feedback_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.participant_id=? ORDER BY h.created_at DESC,h.id DESC').all(participant.id)
      .map(item => ({ ...item, metadata: item.metadata ? JSON.parse(item.metadata) : null }));
    res.json({ items, progress });
  });

  return { router, initialize, seed };
}

module.exports = { createFeedbackModule, selfWording };
