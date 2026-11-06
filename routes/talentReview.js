const express = require('express');
const { goalProgress: sharedGoalProgress } = require('../lib/core-helpers');

const PERIOD_STATUSES = new Set(['draft', 'open', 'calibration', 'completed', 'archived']);
// Aus der Kalibrierung führt ein Weg zurück nach „Offen“, damit Nachzügler keine Sackgasse sind. Archiviert ist endgültig.
const PERIOD_TRANSITIONS = Object.freeze({
  draft: ['open', 'archived'],
  open: ['calibration', 'archived'],
  calibration: ['open', 'completed', 'archived'],
  completed: ['archived'],
  archived: []
});
const PERIOD_LABELS = { draft: 'Entwurf', open: 'Offen', calibration: 'In Kalibrierung', completed: 'Abgeschlossen', archived: 'Archiviert' };
const REVIEW_STATUSES = new Set(['not_started', 'manager_draft', 'manager_submitted', 'in_calibration', 'calibrated', 'finalized']);
const MANAGER_WRITES = ['not_started', 'manager_draft'];
const SELF_ASSESSMENT_STATUSES = new Set(['not_started', 'employee_draft', 'employee_submitted']);
const SESSION_STATUSES = new Set(['planned', 'active', 'completed', 'cancelled']);
const SESSION_TRANSITIONS = Object.freeze({ planned: ['active', 'cancelled'], active: ['completed', 'cancelled'], completed: [], cancelled: [] });
const MEMBERSHIP_STATUSES = new Set(['proposed', 'active', 'paused', 'completed', 'removed']);
const DECISION_STATUSES = new Set(['planned', 'in_progress', 'completed', 'cancelled']);
const DECISION_LABELS = Object.freeze({
  development_goal: 'Neues Entwicklungsziel',
  mentoring: 'Mentoring',
  coaching: 'Coaching',
  training: 'Weiterbildung',
  project_responsibility: 'Projektverantwortung',
  job_shadowing: 'Hospitation',
  job_rotation: 'Arbeitsplatzwechsel auf Zeit',
  stretch_assignment: 'Herausfordernde Zusatzaufgabe',
  expert_track_preparation: 'Vorbereitung Fachlaufbahn',
  leadership_track_preparation: 'Vorbereitung Führungslaufbahn',
  next_review: 'Erneute Einschätzung in der nächsten Periode'
});
const DECISION_TYPES = new Set(Object.keys(DECISION_LABELS));
const MANAGER_ROLES = new Set(['manager', 'director']);
const PARTICIPANT_ROLES = new Set(['hr_admin', 'hrbp', 'director', 'manager', 'super_admin']);
const MIN_LENGTHS = Object.freeze({ reason: 20, observations: 10 });
const HISTORY_LABELS = Object.freeze({
  created: 'In die Periode aufgenommen',
  manager_draft_saved: 'Entwurf gespeichert',
  submitted: 'Eingereicht',
  returned: 'Zur Überarbeitung zurückgegeben',
  self_submitted: 'Selbsteinschätzung abgegeben',
  case_added: 'Einer Kalibrierungssitzung zugeordnet',
  calibration_reopened: 'Erneut in die Kalibrierung genommen',
  calibrated: 'Kalibriert',
  finalized: 'Final abgeschlossen',
  manager_changed: 'Führungskraft gewechselt'
});
// Beim Speichern eines Entwurfs entsteht Verlauf, der niemanden etwas angeht: wann jemand an einem privaten Text saß.
const HISTORY_NEVER_SHOWN = ['self_draft_saved'];
const HISTORY_HIDDEN_BEFORE_SUBMIT = ['manager_draft_saved', 'returned'];
const REVIEW_TASK_TYPES = ['talent_review_start', 'talent_review_returned', 'talent_review_self_assessment', 'talent_review_submitted', 'talent_review_finalized'];
const ALL_TASK_TYPES = [...REVIEW_TASK_TYPES, 'talent_review_calibration', 'talent_pool_proposal', 'development_decision'];
const CRITERIA = [
  ['learning_agility', 'Lernbereitschaft'],
  ['complexity', 'Umgang mit Komplexität'],
  ['change_readiness', 'Veränderungsbereitschaft'],
  ['greater_responsibility', 'Übernahme größerer Verantwortung'],
  ['problem_solving', 'Problemlösung'],
  ['collaboration_influence', 'Zusammenarbeit und Einfluss'],
  ['mobility_readiness', 'Mobilitäts- und Einsatzbereitschaft'],
  ['career_interest', 'Karriereinteresse und Kompetenzentwicklung']
];
const BOXES = {
  '3-1': 'Potenzial gezielt entwickeln',
  '3-2': 'Wachstumskandidat',
  '3-3': 'Bereit für nächste Herausforderung',
  '2-1': 'Leistung stabilisieren',
  '2-2': 'Solide Entwicklung',
  '2-3': 'Starke Leistung mit Entwicklungsperspektive',
  '1-1': 'Leistungsunterstützung',
  '1-2': 'Verlässliche Fachkraft',
  '1-3': 'Leistungsträger in aktueller Rolle'
};

// Was an einer Einschätzung nach außen geht, steht hier ausdrücklich. So kann eine neue Spalte nicht versehentlich mitlaufen.
const REVIEW_STATUS_FIELDS = ['id', 'period_id', 'employee_id', 'manager_id', 'status', 'self_status', 'submitted_at', 'finalized_at'];
const REVIEW_LIST_FIELDS = [...REVIEW_STATUS_FIELDS, 'period_name', 'period_status', 'employee_name', 'employee_title', 'manager_name', 'employee_manager_id'];
const REVIEW_CONTENT_FIELDS = ['version', 'original_performance', 'original_potential', 'performance_reason', 'potential_reason', 'observations', 'development_fields', 'next_steps', 'calibrated_performance', 'calibrated_potential', 'calibration_reason', 'calibrated_at', 'employee_visible'];
const REVIEW_RETURN_FIELDS = ['returned_at', 'return_reason'];
const REVIEW_EMPLOYEE_FIELDS = ['id', 'period_id', 'employee_id', 'manager_id', 'status', 'finalized_at', 'performance_reason', 'potential_reason', 'observations', 'development_fields', 'next_steps'];

const pick = (source, fields) => Object.fromEntries(fields.filter(field => field in source).map(field => [field, source[field]]));

function createTalentReviewModule(deps) {
  const { db, auth, current, isHr, canViewEmployee, cleanText, boundedInt, validDate, log, createTask, skillGap, demoPasswordHash, isModuleEnabled = () => true, goalProgress = sharedGoalProgress } = deps;
  const router = express.Router();
  const now = () => new Date().toISOString();
  const asId = value => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  };
  const text = (value, max = 4000) => cleanText(value, max);
  const reason = value => text(value, 3000);
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const userById = id => db.prepare('SELECT id,name,email,role,title,manager_id,position_profile_id,active,is_system_account FROM users WHERE id=?').get(id);
  const personSummary = id => {
    const person = userById(id);
    return person ? { id: person.id, name: person.name, title: person.title } : null;
  };
  const periodById = id => db.prepare('SELECT * FROM talent_review_periods WHERE id=?').get(id);
  const sessionById = id => db.prepare('SELECT * FROM talent_review_sessions WHERE id=?').get(id);
  const reviewById = id => db.prepare('SELECT * FROM talent_reviews WHERE id=?').get(id);
  const currentCriteria = () => db.prepare('SELECT * FROM talent_review_potential_criteria WHERE active=1 ORDER BY display_order').all();
  const boxFor = (performance, potential) => performance && potential ? String(potential) + '-' + String(performance) : null;
  const boxLabel = (performance, potential) => BOXES[boxFor(performance, potential)] || null;
  const effectiveResult = review => {
    const performance = review.calibrated_performance || review.original_performance || null;
    const potential = review.calibrated_potential || review.original_potential || null;
    return { performance, potential, boxKey: boxFor(performance, potential), boxLabel: boxLabel(performance, potential) };
  };
  const managerStillWrites = review => MANAGER_WRITES.includes(review.status);
  const withDecisionLabel = decision => ({ ...decision, decision_label: DECISION_LABELS[decision.decision_type] || 'Entwicklungsmaßnahme' });

  // --- Wer ist wofür zuständig? Es zählt die heutige Führungslinie, nicht die Rolle. ---

  const directManagerId = employeeId => userById(employeeId)?.manager_id ?? null;
  const isDirectManager = (actor, employeeId) => actor.id !== employeeId && directManagerId(employeeId) === actor.id;
  const leadsPeople = actorId => !!db.prepare('SELECT 1 FROM users WHERE manager_id=? AND active=1 AND is_system_account=0 LIMIT 1').get(actorId);
  const isLeader = actor => MANAGER_ROLES.has(actor.role) || leadsPeople(actor.id);

  /** HR-Aufgaben an einem Fall: nie in eigener Sache, und ein HRBP nicht bei der HR-Leitung. */
  function hrReaches(actor, person) {
    const personId = typeof person === 'object' ? person?.id : person;
    if (!isHr(actor) || !personId || actor.id === personId) return false;
    return deps.hrCanAccess ? deps.hrCanAccess(actor, person) : canViewEmployee(actor, personId);
  }

  function isAboveInLine(people, leaderId, employeeId) {
    const seen = new Set();
    let managerId = people.get(employeeId)?.manager_id;
    while (managerId && !seen.has(managerId)) {
      if (managerId === leaderId) return true;
      seen.add(managerId);
      managerId = people.get(managerId)?.manager_id;
    }
    return false;
  }

  /** Alles, was eine Anfrage für die Rechteprüfung braucht, einmal geladen statt je Datensatz neu. */
  function accessContext(actor) {
    const people = new Map(db.prepare('SELECT id,manager_id,role FROM users').all().map(person => [person.id, person]));
    const sessionReviewIds = new Set(db.prepare(`SELECT c.review_id
      FROM talent_review_session_participants sp
      JOIN talent_review_sessions s ON s.id=sp.session_id
      JOIN talent_review_periods p ON p.id=s.period_id
      JOIN talent_review_session_cases c ON c.session_id=s.id
      WHERE sp.user_id=? AND s.status='active' AND p.status='calibration'`).all(actor.id).map(row => row.review_id));
    return { actor, people, sessionReviewIds };
  }

  /**
   * Was darf diese Person an dieser Einschätzung sehen? Alle Ausgaben richten sich danach:
   * - employee: die Person selbst, erst nach Abschluss und Freigabe
   * - full: direkte Führungskraft, HR und die Ebenen darüber, Letztere erst ab dem Einreichen
   * - status: die Ebenen darüber, solange die Führungskraft noch schreibt: nur der Stand
   * - session: Teilnehmende einer laufenden Sitzung außerhalb der Führungslinie: der Fall, nicht mehr
   * - null: nichts
   */
  function reviewScope(context, review) {
    const { actor, people } = context;
    if (actor.id === review.employee_id) return review.status === 'finalized' && review.employee_visible === 1 ? 'employee' : null;
    const person = people.get(review.employee_id);
    if (person?.manager_id === actor.id) return 'full';
    if (hrReaches(actor, person)) return 'full';
    if (isAboveInLine(people, actor.id, review.employee_id)) return managerStillWrites(review) ? 'status' : 'full';
    return context.sessionReviewIds.has(review.id) ? 'session' : null;
  }

  const selfReviewEditAccess = (actor, review, period) => actor.id === review.employee_id && period?.status === 'open';
  const sessionParticipant = (actor, sessionId) => !!db.prepare('SELECT 1 FROM talent_review_session_participants WHERE session_id=? AND user_id=?').get(sessionId, actor.id);
  const sessionAccess = (actor, sessionId) => isHr(actor) || sessionParticipant(actor, sessionId);
  const mayJoinSession = user => !!user && PARTICIPANT_ROLES.has(user.role) && user.active === 1 && !user.is_system_account;

  function ensureColumn(table, column, definition) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  function history(actor, entityType, entityId, field, oldValue, newValue, changeReason = null) {
    db.prepare('INSERT INTO talent_review_history(entity_type,entity_id,field_name,old_value,new_value,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(entityType, entityId, field, oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue), changeReason || null, actor.id, now());
    log(actor.id, 'talent_review_' + field, entityType, entityId, oldValue, newValue);
  }

  function initialize() {
    db.exec([
      'CREATE TABLE IF NOT EXISTS talent_review_periods (',
      ' id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL, assessment_date TEXT NOT NULL,',
      " status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','calibration','completed','archived')), employee_results_visible INTEGER NOT NULL DEFAULT 0,",
      ' created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,',
      ' CHECK(end_date >= start_date), CHECK(assessment_date >= start_date AND assessment_date <= end_date)',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_review_potential_criteria (',
      ' id INTEGER PRIMARY KEY, criterion_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, display_order INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_reviews (',
      ' id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES talent_review_periods(id), employee_id INTEGER NOT NULL REFERENCES users(id), manager_id INTEGER NOT NULL REFERENCES users(id),',
      ' original_performance INTEGER CHECK(original_performance BETWEEN 1 AND 3), original_potential INTEGER CHECK(original_potential BETWEEN 1 AND 3),',
      ' performance_reason TEXT, potential_reason TEXT, observations TEXT, development_fields TEXT, next_steps TEXT,',
      " self_performance INTEGER CHECK(self_performance BETWEEN 1 AND 3), self_potential INTEGER CHECK(self_potential BETWEEN 1 AND 3), self_performance_reason TEXT, self_potential_reason TEXT, self_observations TEXT, self_development_fields TEXT, self_next_steps TEXT, self_status TEXT NOT NULL DEFAULT 'not_started' CHECK(self_status IN ('not_started','employee_draft','employee_submitted')), self_submitted_at TEXT,",
      ' calibrated_performance INTEGER CHECK(calibrated_performance BETWEEN 1 AND 3), calibrated_potential INTEGER CHECK(calibrated_potential BETWEEN 1 AND 3), calibration_reason TEXT,',
      " status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','manager_draft','manager_submitted','in_calibration','calibrated','finalized')),",
      ' version INTEGER NOT NULL DEFAULT 1, submitted_at TEXT, returned_at TEXT, returned_by INTEGER REFERENCES users(id), return_reason TEXT, calibrated_at TEXT, calibrated_by INTEGER REFERENCES users(id), finalized_at TEXT, finalized_by INTEGER REFERENCES users(id),',
      ' employee_visible INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,',
      ' UNIQUE(period_id, employee_id)',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_review_potential_ratings (',
      ' id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES talent_reviews(id), criterion_id INTEGER NOT NULL REFERENCES talent_review_potential_criteria(id),',
      ' rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT, created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,',
      ' UNIQUE(review_id, criterion_id)',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_review_sessions (',
      ' id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES talent_review_periods(id), title TEXT NOT NULL, description TEXT, session_date TEXT NOT NULL,',
      " status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','completed','cancelled')), moderator_id INTEGER NOT NULL REFERENCES users(id), organization_manager_id INTEGER REFERENCES users(id),",
      ' created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,',
      ' UNIQUE(period_id, title)',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_review_session_participants (',
      ' session_id INTEGER NOT NULL REFERENCES talent_review_sessions(id), user_id INTEGER NOT NULL REFERENCES users(id), added_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,',
      ' PRIMARY KEY(session_id, user_id)',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_review_session_cases (',
      ' id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES talent_review_sessions(id), review_id INTEGER NOT NULL REFERENCES talent_reviews(id), display_order INTEGER NOT NULL DEFAULT 0,',
      " case_status TEXT NOT NULL DEFAULT 'pending' CHECK(case_status IN ('pending','discussed','completed')), moderator_note TEXT, outcome_status TEXT, created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,",
      ' UNIQUE(session_id, review_id)',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_review_history (',
      ' id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, field_name TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_pools (',
      ' id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, purpose TEXT, active INTEGER NOT NULL DEFAULT 1, responsible_id INTEGER REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP',
      ');',
      'CREATE TABLE IF NOT EXISTS talent_pool_memberships (',
      ' id INTEGER PRIMARY KEY, pool_id INTEGER NOT NULL REFERENCES talent_pools(id), employee_id INTEGER NOT NULL REFERENCES users(id), period_id INTEGER REFERENCES talent_review_periods(id), proposed_by INTEGER REFERENCES users(id), admitted_by INTEGER REFERENCES users(id), admitted_at TEXT,',
      " status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','paused','completed','removed')), reason TEXT NOT NULL, development_plan TEXT, removed_at TEXT, removed_reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP",
      ');',
      'CREATE TABLE IF NOT EXISTS development_decisions (',
      ' id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES talent_reviews(id), period_id INTEGER NOT NULL REFERENCES talent_review_periods(id), employee_id INTEGER NOT NULL REFERENCES users(id),',
      " decision_type TEXT NOT NULL CHECK(decision_type IN ('development_goal','mentoring','coaching','training','project_responsibility','job_shadowing','job_rotation','stretch_assignment','expert_track_preparation','leadership_track_preparation','next_review')),",
      ' description TEXT NOT NULL, responsible_id INTEGER REFERENCES users(id), start_date TEXT, target_date TEXT,',
      " status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')), linked_goal_id INTEGER REFERENCES goals(id), competency_id INTEGER REFERENCES competencies(id),",
      ' created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,',
      ' CHECK(target_date IS NULL OR start_date IS NULL OR target_date >= start_date)',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_review_period_status ON talent_reviews(period_id, status);',
      'CREATE INDEX IF NOT EXISTS idx_review_employee_period ON talent_reviews(employee_id, period_id);',
      'CREATE INDEX IF NOT EXISTS idx_review_manager_status ON talent_reviews(manager_id, status);',
      'CREATE INDEX IF NOT EXISTS idx_review_rating_review ON talent_review_potential_ratings(review_id);',
      'CREATE INDEX IF NOT EXISTS idx_session_period_status ON talent_review_sessions(period_id, status);',
      'CREATE INDEX IF NOT EXISTS idx_session_case_review ON talent_review_session_cases(review_id);',
      'CREATE INDEX IF NOT EXISTS idx_history_entity ON talent_review_history(entity_type, entity_id, created_at);',
      'CREATE INDEX IF NOT EXISTS idx_pool_members_employee ON talent_pool_memberships(employee_id, status);',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_members_active_unique ON talent_pool_memberships(pool_id, employee_id) WHERE status IN ('proposed','active','paused');",
      'CREATE INDEX IF NOT EXISTS idx_decisions_employee_status ON development_decisions(employee_id, status);'
    ].join('\n'));
    ensureColumn('talent_reviews', 'self_performance', 'INTEGER');
    ensureColumn('talent_reviews', 'self_potential', 'INTEGER');
    ensureColumn('talent_reviews', 'self_performance_reason', 'TEXT');
    ensureColumn('talent_reviews', 'self_potential_reason', 'TEXT');
    ensureColumn('talent_reviews', 'self_observations', 'TEXT');
    ensureColumn('talent_reviews', 'self_development_fields', 'TEXT');
    ensureColumn('talent_reviews', 'self_next_steps', 'TEXT');
    ensureColumn('talent_reviews', 'self_status', "TEXT NOT NULL DEFAULT 'not_started'");
    ensureColumn('talent_reviews', 'self_submitted_at', 'TEXT');
    // Notizen zu Kriterien, die noch keine Note haben. In der Tabelle der Noten ist die Note Pflicht.
    ensureColumn('talent_reviews', 'criteria_draft', 'TEXT');
    // actor_id ist eine Pflichtspalte. Hat niemand gehandelt, sagt diese Spalte, dass die dort genannte Person es nicht war.
    ensureColumn('talent_review_history', 'by_system', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'is_system_account', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
    db.exec('CREATE INDEX IF NOT EXISTS idx_review_employee_self_status ON talent_reviews(employee_id, self_status);');
    const insert = db.prepare('INSERT OR IGNORE INTO talent_review_potential_criteria(criterion_key,label,display_order) VALUES(?,?,?)');
    CRITERIA.forEach((criterion, index) => insert.run(criterion[0], criterion[1], index + 1));
    db.prepare("UPDATE talent_review_potential_criteria SET label=? WHERE criterion_key='learning_agility' AND label='Lernagilität'").run(CRITERIA[0][1]);
    // Eine ältere Datenbank kann Einschätzungen bei der früheren Führungskraft und Aufgaben ohne Namen oder längst Erledigtes enthalten.
    alignOpenReviews();
    refreshOpenTasks();
  }

  function eligibleEmployees() {
    return db.prepare("SELECT id,manager_id FROM users WHERE is_system_account=0 AND active=1 AND manager_id IS NOT NULL AND role NOT IN ('hr_admin','hrbp') ORDER BY id").all();
  }

  /** Wer in dieser Periode noch fehlt: nachträglich aufnehmbar, oder erst mit einer Führungskraft. */
  function missingPeople(periodId) {
    const missing = db.prepare(`SELECT u.id,u.name,u.title,m.name manager_name FROM users u JOIN users m ON m.id=u.manager_id
      WHERE u.is_system_account=0 AND u.active=1 AND u.role NOT IN ('hr_admin','hrbp')
        AND NOT EXISTS (SELECT 1 FROM talent_reviews r WHERE r.period_id=? AND r.employee_id=u.id) ORDER BY u.name`).all(periodId);
    const withoutManager = db.prepare(`SELECT u.id,u.name,u.title FROM users u
      WHERE u.is_system_account=0 AND u.active=1 AND u.manager_id IS NULL AND u.role NOT IN ('hr_admin','hrbp')
        AND NOT EXISTS (SELECT 1 FROM talent_reviews r WHERE r.period_id=? AND r.employee_id=u.id) ORDER BY u.name`).all(periodId);
    return { missing, withoutManager };
  }

  function ensureReviewRecords(period, actor, onlyEmployeeIds = null) {
    const insert = db.prepare('INSERT OR IGNORE INTO talent_reviews(period_id,employee_id,manager_id,status,created_by,updated_by) VALUES(?,?,?,?,?,?)');
    const find = db.prepare('SELECT id FROM talent_reviews WHERE period_id=? AND employee_id=?');
    let added = 0;
    for (const employee of eligibleEmployees()) {
      if (onlyEmployeeIds && !onlyEmployeeIds.has(employee.id)) continue;
      const result = insert.run(period.id, employee.id, employee.manager_id, 'not_started', actor.id, actor.id);
      const review = find.get(period.id, employee.id);
      if (result.changes) {
        added += 1;
        history(actor, 'talent_review', review.id, 'created', null, { periodId: period.id, employeeId: employee.id });
      }
      ensureOpenReviewTasks(review.id);
    }
    return added;
  }

  // --- Aufgaben. Für jede Aufgabe steht an einer Stelle: offen oder nicht, bei wem, mit welchem Titel und welcher Frist. ---

  const REVIEW_TASK_SQL = `SELECT r.id,r.status,r.self_status,r.employee_id,r.employee_visible,u.name employee_name,u.manager_id employee_manager_id,u.active employee_active,p.name period_name,p.status period_status,p.assessment_date,p.end_date
    FROM talent_reviews r JOIN users u ON u.id=r.employee_id JOIN talent_review_periods p ON p.id=r.period_id`;
  const SESSION_TASK_SQL = `SELECT s.id,s.title,s.status,s.session_date,s.moderator_id,p.name period_name,p.status period_status
    FROM talent_review_sessions s JOIN talent_review_periods p ON p.id=s.period_id`;
  const MEMBERSHIP_TASK_SQL = `SELECT m.id,m.status,u.name employee_name,t.name pool_name,p.name period_name
    FROM talent_pool_memberships m JOIN users u ON u.id=m.employee_id JOIN talent_pools t ON t.id=m.pool_id LEFT JOIN talent_review_periods p ON p.id=m.period_id`;
  const DECISION_TASK_SQL = `SELECT d.id,d.status,d.decision_type,d.target_date,u.name employee_name,p.name period_name,p.status period_status
    FROM development_decisions d JOIN users u ON u.id=d.employee_id JOIN talent_review_periods p ON p.id=d.period_id`;

  function reviewTaskPlan(type, review) {
    const person = review.employee_name;
    const period = review.period_name;
    const inOpenPeriod = review.period_status === 'open' && review.employee_active === 1;
    const managerCanWrite = inOpenPeriod && managerStillWrites(review) && review.employee_manager_id !== null;
    const plans = {
      talent_review_start: { open: managerCanWrite, assignee: review.employee_manager_id, title: `Einschätzung für ${person} schreiben · ${period}`, dueDate: review.assessment_date },
      talent_review_returned: { open: managerCanWrite, assignee: review.employee_manager_id, title: `Einschätzung für ${person} überarbeiten · ${period}`, dueDate: review.assessment_date },
      talent_review_self_assessment: { open: inOpenPeriod && review.self_status !== 'employee_submitted', assignee: review.employee_id, title: `Deine Selbsteinschätzung schreiben · ${period}`, dueDate: review.assessment_date },
      talent_review_submitted: { open: ['open', 'calibration'].includes(review.period_status) && ['manager_submitted', 'in_calibration', 'calibrated'].includes(review.status), title: `Einschätzung für ${person} kalibrieren und abschließen · ${period}`, dueDate: review.end_date },
      talent_review_finalized: { open: review.period_status !== 'archived' && review.status === 'finalized' && review.employee_visible === 1, assignee: review.employee_id, title: `Dein Ergebnis ansehen · ${period}`, dueDate: null }
    };
    return plans[type];
  }

  function sessionTaskPlan(session, userId) {
    const stillAhead = ['planned', 'active'].includes(session.status) && ['draft', 'open', 'calibration'].includes(session.period_status);
    const action = session.moderator_id === userId ? 'vorbereiten' : 'steht an';
    return { open: stillAhead, title: `Kalibrierungssitzung „${session.title}“ ${action} · ${session.period_name}`, dueDate: session.session_date };
  }

  function membershipTaskPlan(membership) {
    const period = membership.period_name ? ` · ${membership.period_name}` : '';
    return { open: membership.status === 'proposed', title: `${membership.employee_name} für den Talentpool „${membership.pool_name}“ vorgeschlagen: bitte entscheiden${period}`, dueDate: null };
  }

  function decisionTaskPlan(decision) {
    const open = ['planned', 'in_progress'].includes(decision.status) && decision.period_status !== 'archived';
    return { open, title: `${DECISION_LABELS[decision.decision_type] || 'Entwicklungsmaßnahme'} für ${decision.employee_name} umsetzen · ${decision.period_name}`, dueDate: decision.target_date };
  }

  const hasOpenTask = (types, entityId) => !!db.prepare(`SELECT 1 FROM tasks WHERE done=0 AND entity_id=? AND type IN (${types.map(() => '?').join(',')}) LIMIT 1`).get(entityId, ...types);
  const closeTasks = (types, entityId) => db.prepare(`UPDATE tasks SET done=1 WHERE done=0 AND entity_id=? AND type IN (${types.map(() => '?').join(',')})`).run(entityId, ...types);

  function addReviewTask(type, reviewId, assignee = null) {
    const review = db.prepare(`${REVIEW_TASK_SQL} WHERE r.id=?`).get(reviewId);
    const plan = review && reviewTaskPlan(type, review);
    const userId = assignee ?? plan?.assignee;
    if (plan?.open && userId) createTask(userId, plan.title, type, reviewId, plan.dueDate);
  }

  /** Legt die Schreibaufgaben einer Einschätzung an, falls sie gerade anstehen und noch fehlen. */
  function ensureOpenReviewTasks(reviewId) {
    if (!hasOpenTask(['talent_review_start', 'talent_review_returned'], reviewId)) addReviewTask('talent_review_start', reviewId);
    if (!hasOpenTask(['talent_review_self_assessment'], reviewId)) addReviewTask('talent_review_self_assessment', reviewId);
  }

  /** Das Ergebnis wird erst zur Aufgabe, wenn die Person es auch öffnen kann. */
  function ensureResultTask(reviewId) {
    if (!hasOpenTask(['talent_review_finalized'], reviewId)) addReviewTask('talent_review_finalized', reviewId);
  }

  function createSessionTask(session, userId) {
    const row = db.prepare(`${SESSION_TASK_SQL} WHERE s.id=?`).get(session.id);
    const plan = sessionTaskPlan(row, userId);
    if (plan.open) createTask(userId, plan.title, 'talent_review_calibration', session.id, plan.dueDate);
  }

  function createDecisionTask(decisionId, responsibleId) {
    const row = db.prepare(`${DECISION_TASK_SQL} WHERE d.id=?`).get(decisionId);
    const plan = decisionTaskPlan(row);
    if (plan.open) createTask(responsibleId, plan.title, 'development_decision', decisionId, plan.dueDate);
  }

  /**
   * Gleicht alle offenen Aufgaben des Moduls mit ihrem Vorgang ab: Hinfälliges schließt sich,
   * Titel und Fristen stimmen, und die Aufgabe liegt bei der heute zuständigen Person.
   */
  function refreshOpenTasks() {
    const tasks = db.prepare(`SELECT id,user_id,type,entity_id,title,due_date FROM tasks WHERE done=0 AND type IN (${ALL_TASK_TYPES.map(() => '?').join(',')}) ORDER BY id`).all(...ALL_TASK_TYPES);
    if (!tasks.length) return;
    const rowsById = sql => new Map(db.prepare(sql).all().map(row => [row.id, row]));
    const reviews = rowsById(REVIEW_TASK_SQL);
    const sessions = rowsById(SESSION_TASK_SQL);
    const memberships = rowsById(MEMBERSHIP_TASK_SQL);
    const decisions = rowsById(DECISION_TASK_SQL);
    const planFor = task => {
      if (REVIEW_TASK_TYPES.includes(task.type)) return reviews.has(task.entity_id) ? reviewTaskPlan(task.type, reviews.get(task.entity_id)) : null;
      if (task.type === 'talent_review_calibration') return sessions.has(task.entity_id) ? sessionTaskPlan(sessions.get(task.entity_id), task.user_id) : null;
      if (task.type === 'talent_pool_proposal') return memberships.has(task.entity_id) ? membershipTaskPlan(memberships.get(task.entity_id)) : null;
      return decisions.has(task.entity_id) ? decisionTaskPlan(decisions.get(task.entity_id)) : null;
    };
    const close = db.prepare('UPDATE tasks SET done=1 WHERE id=?');
    const update = db.prepare('UPDATE tasks SET user_id=?,title=?,due_date=? WHERE id=?');
    const seen = new Set();
    for (const task of tasks) {
      const plan = planFor(task);
      const userId = plan?.assignee ?? task.user_id;
      const key = `${task.type}:${task.entity_id}:${userId}`;
      if (!plan?.open || seen.has(key)) {
        close.run(task.id);
        continue;
      }
      seen.add(key);
      const dueDate = plan.dueDate ?? null;
      if (userId !== task.user_id || plan.title !== task.title || dueDate !== (task.due_date ?? null)) update.run(userId, plan.title, dueDate, task.id);
    }
  }

  // --- Wechsel der Führungskraft ---

  function recordManagerChange(review, actorId) {
    const before = { managerId: review.previous_manager_id };
    const after = { managerId: review.current_manager_id };
    if (actorId) {
      history({ id: actorId }, 'talent_review', review.id, 'manager_changed', before, after);
      return;
    }
    db.prepare("INSERT INTO talent_review_history(entity_type,entity_id,field_name,old_value,new_value,actor_id,by_system,created_at) VALUES('talent_review',?,'manager_changed',?,?,?,1,?)")
      .run(review.id, JSON.stringify(before), JSON.stringify(after), review.employee_id, now());
    log(null, 'talent_review_manager_changed', 'talent_review', review.id, before, after);
  }

  /** Offene Einschätzungen gehören zur heutigen Führungskraft. Abgeschlossenes behält die damalige. */
  function alignOpenReviews(changedEmployeeId = null, actorId = null) {
    const stale = db.prepare(`SELECT r.id,r.employee_id,r.manager_id previous_manager_id,u.manager_id current_manager_id
      FROM talent_reviews r JOIN users u ON u.id=r.employee_id JOIN talent_review_periods p ON p.id=r.period_id
      WHERE r.status!='finalized' AND p.status NOT IN ('completed','archived') AND u.manager_id IS NOT NULL AND r.manager_id!=u.manager_id`).all();
    for (const review of stale) {
      db.prepare('UPDATE talent_reviews SET manager_id=?,updated_at=? WHERE id=?').run(review.current_manager_id, now(), review.id);
      recordManagerChange(review, review.employee_id === changedEmployeeId ? actorId : null);
    }
    return stale;
  }

  function followManagerChange(employeeId = null, actorId = null) {
    const moved = alignOpenReviews(employeeId, actorId);
    const reopened = employeeId === null ? [] : db.prepare("SELECT r.id FROM talent_reviews r JOIN talent_review_periods p ON p.id=r.period_id WHERE r.employee_id=? AND p.status='open'").all(employeeId);
    [...moved, ...reopened].forEach(review => ensureOpenReviewTasks(review.id));
    if (employeeId !== null || moved.length) refreshOpenTasks();
  }

  deps.onManagerChanged?.(({ userId, actorId }) => followManagerChange(userId, actorId ?? null));

  const transitionPeriod = (period, next) => (PERIOD_TRANSITIONS[period.status] || []).includes(next);
  const transitionSession = (session, next) => (SESSION_TRANSITIONS[session.status] || []).includes(next);

  /**
   * In einer laufenden Periode zählt der Stand von heute, damit überall dieselbe Zahl steht. Eine beendete Periode
   * zeigt nur, was zu ihr gehört: Ziele mit Zieltermin und Check-ins aus ihrem Zeitraum.
   */
  function reviewSupport(employeeId, period) {
    const periodFinished = ['completed', 'archived'].includes(period.status);
    const inPeriod = date => !!date && date >= period.start_date && date <= period.end_date;
    const inPeriodMonths = month => month >= period.start_date.slice(0, 7) && month <= period.end_date.slice(0, 7);
    const allGoals = db.prepare('SELECT progress,weight,status,goal_type,due_date,approval_status FROM goals WHERE user_id=?').all(employeeId);
    const goals = periodFinished ? allGoals.filter(goal => inPeriod(goal.due_date)) : allGoals;
    const approvedGoals = goals.filter(goal => (goal.approval_status ?? 'approved') === 'approved');
    const allCheckins = isModuleEnabled('checkins') ? db.prepare('SELECT performance,on_track,period FROM checkins WHERE employee_id=? ORDER BY period DESC, id DESC').all(employeeId) : [];
    const checkins = periodFinished ? allCheckins.filter(item => inPeriodMonths(item.period)) : allCheckins;
    const career = db.prepare('SELECT career_path,target_position,leadership_interest,expert_interest,project_interest,mentoring_interest,internal_projects_interest,mobility,relocation,development_timeframe,career_goals FROM career_interests WHERE user_id=?').get(employeeId) || null;
    const competencies = db.prepare("SELECT c.name,a.rating,a.comment,a.updated_at FROM competency_assessments a JOIN competencies c ON c.id=a.competency_id WHERE a.user_id=? AND a.assessment_type='manager' AND a.active=1 ORDER BY a.updated_at DESC LIMIT 8").all(employeeId);
    const developmentGoals = approvedGoals.filter(goal => goal.goal_type === 'development');
    const gap = typeof skillGap === 'function' ? skillGap(employeeId) : { requirements: [], fit: null };
    return {
      periodFinished,
      period: { startDate: period.start_date, endDate: period.end_date, assessmentDate: period.assessment_date },
      goals: { count: approvedGoals.length, weightedProgress: goalProgress(goals), completed: approvedGoals.filter(goal => Number(goal.progress) >= 100).length, onTrack: approvedGoals.filter(goal => goal.status === 'on_track').length },
      checkins: { latestPerformance: checkins[0] ? checkins[0].performance : null, averagePerformance: checkins.length ? Math.round(checkins.reduce((sum, item) => sum + Number(item.performance || 0), 0) / checkins.length * 10) / 10 : null, latestOnTrack: checkins[0] ? checkins[0].on_track : null },
      developmentGoals: { count: developmentGoals.length, completed: developmentGoals.filter(goal => Number(goal.progress) >= 100).length },
      career,
      competencies,
      skillGap: gap
    };
  }

  /** Die Kompetenzbewertung der direkten Führungskraft sehen die Person, sie selbst und HR, nicht die Ebenen darüber. */
  function supportFor(actor, review, period) {
    const support = reviewSupport(review.employee_id, period);
    const manager = db.prepare('SELECT manager_id FROM users WHERE id=?').get(review.employee_id)?.manager_id;
    if (isHr(actor) || actor.id === review.employee_id || actor.id === manager) return support;
    const gap = typeof skillGap === 'function' ? skillGap(review.employee_id, { withManagerRatings: false }) : { requirements: [], fit: null };
    return { ...support, competencies: [], skillGap: gap };
  }

  /** Für die Runde reichen die Zahlen. Karrierewünsche und Kompetenzkommentare bleiben in der Führungslinie. */
  function supportNumbers(employeeId, period) {
    const support = reviewSupport(employeeId, period);
    return {
      periodFinished: support.periodFinished,
      goals: { weightedProgress: support.goals.weightedProgress },
      checkins: { latestPerformance: support.checkins.latestPerformance, averagePerformance: support.checkins.averagePerformance },
      skillGap: { fit: support.skillGap?.fit ?? null }
    };
  }

  // --- Ausgaben einer Einschätzung ---

  function reviewListItem(actor, review, scope) {
    const item = pick(review, REVIEW_LIST_FIELDS);
    item.canEdit = isEditableBy(actor, review);
    if (scope === 'status') return item;
    Object.assign(item, effectiveResult(review));
    if (scope === 'full' && review.status === 'manager_draft') item.return_reason = review.return_reason || null;
    return item;
  }

  const isEditableBy = (actor, review) => review.period_status === 'open' && managerStillWrites(review) && actor.id !== review.employee_id && review.employee_manager_id === actor.id;

  function reviewForScope(review, scope) {
    if (scope === 'employee') return { ...pick(review, REVIEW_EMPLOYEE_FIELDS), ...effectiveResult(review) };
    if (scope === 'status') return pick(review, REVIEW_STATUS_FIELDS);
    const fields = scope === 'full' ? [...REVIEW_STATUS_FIELDS, ...REVIEW_CONTENT_FIELDS, ...REVIEW_RETURN_FIELDS] : [...REVIEW_STATUS_FIELDS, ...REVIEW_CONTENT_FIELDS];
    return { ...pick(review, fields), ...effectiveResult(review) };
  }

  function selfAssessmentForScope(review, scope) {
    const status = SELF_ASSESSMENT_STATUSES.has(review.self_status) ? review.self_status : 'not_started';
    const summary = { status, submittedAt: review.self_submitted_at || null };
    if (status !== 'employee_submitted' || !['full', 'employee'].includes(scope)) return summary;
    return {
      ...summary,
      performance: review.self_performance,
      potential: review.self_potential,
      performanceReason: review.self_performance_reason,
      potentialReason: review.self_potential_reason,
      observations: review.self_observations,
      developmentFields: review.self_development_fields,
      nextSteps: review.self_next_steps
    };
  }

  function unratedComments(review) {
    try {
      return JSON.parse(review.criteria_draft || '{}');
    } catch {
      return {};
    }
  }

  function previousResults(review, scope) {
    const onlyReleased = scope === 'employee' ? ' AND r.employee_visible=1' : '';
    const rows = db.prepare(`SELECT r.id,p.name period_name,r.original_performance,r.original_potential,r.calibrated_performance,r.calibrated_potential,r.finalized_at
      FROM talent_reviews r JOIN talent_review_periods p ON p.id=r.period_id
      WHERE r.employee_id=? AND r.period_id!=? AND r.status='finalized'${onlyReleased} ORDER BY p.assessment_date DESC`).all(review.employee_id, review.period_id);
    return rows.map(row => ({ id: row.id, period_name: row.period_name, finalized_at: row.finalized_at, ...effectiveResult(row) }));
  }

  /** Rohe Werte bleiben im Haus: Dort stehen auch ältere Entwurfstexte. Hinaus gehen Bezeichnung, Person, Zeit und Grund. */
  function historyFor(reviewId, scope) {
    const hidden = scope === 'status' ? [...HISTORY_NEVER_SHOWN, ...HISTORY_HIDDEN_BEFORE_SUBMIT] : HISTORY_NEVER_SHOWN;
    const rows = db.prepare(`SELECT h.id,h.field_name,h.new_value,h.by_system,h.reason,h.created_at,u.name actor_name FROM talent_review_history h LEFT JOIN users u ON u.id=h.actor_id
      WHERE h.entity_type='talent_review' AND h.entity_id=? AND h.field_name NOT IN (${hidden.map(() => '?').join(',')}) ORDER BY h.created_at DESC,h.id DESC`).all(reviewId, ...hidden);
    return rows.map(row => ({ id: row.id, field_name: row.field_name, label: historyLabel(row), actor_name: row.by_system || !row.actor_name ? 'System' : row.actor_name, created_at: row.created_at, reason: row.reason }));
  }

  /** Beim Führungswechsel steht als Handelnde da, wer gewechselt hat. Zu wem es ging, sagt deshalb die Bezeichnung. */
  function historyLabel(row) {
    const label = HISTORY_LABELS[row.field_name] || 'Änderung';
    if (row.field_name !== 'manager_changed') return label;
    let managerId = null;
    try {
      managerId = JSON.parse(row.new_value)?.managerId;
    } catch {
      return label;
    }
    const manager = managerId ? userById(managerId) : null;
    return manager ? `${label}: jetzt ${manager.name}` : label;
  }

  const calibrationOptions = (actor, review) => db.prepare(`SELECT s.id,s.title,s.session_date FROM talent_review_sessions s
    JOIN talent_review_session_cases c ON c.session_id=s.id
    JOIN talent_review_session_participants sp ON sp.session_id=s.id
    WHERE c.review_id=? AND sp.user_id=? AND s.status='active' ORDER BY s.session_date`).all(review.id, actor.id);

  function calibrationHint(review, period, sessions) {
    if (period.status !== 'calibration') return null;
    if (review.status === 'manager_submitted') return 'Diese Einschätzung ist noch keiner Sitzung zugeordnet. HR ordnet sie unter „Kalibrierung“ zu.';
    if (review.status !== 'in_calibration' || sessions.length) return null;
    const running = db.prepare("SELECT 1 FROM talent_review_session_cases c JOIN talent_review_sessions s ON s.id=c.session_id WHERE c.review_id=? AND s.status='active' LIMIT 1").get(review.id);
    return running
      ? 'Kalibrieren können nur die Teilnehmenden der laufenden Sitzung.'
      : 'Gerade läuft keine Sitzung mit diesem Fall. HR startet sie unter „Kalibrierung“.';
  }

  function reviewPermissions(actor, review, period, sessions) {
    const direct = isDirectManager(actor, review.employee_id);
    const hr = hrReaches(actor, review.employee_id);
    return {
      canEdit: direct && period.status === 'open' && managerStillWrites(review),
      canReturn: hr && period.status === 'open' && review.status === 'manager_submitted',
      canFinalize: hr && ['calibration', 'completed'].includes(period.status) && review.status === 'calibrated',
      canCalibrate: actor.id !== review.employee_id && period.status === 'calibration' && review.status === 'in_calibration' && sessions.length > 0,
      canCreateDecision: hr || direct
    };
  }

  function detail(review, actor, scope) {
    const period = periodById(review.period_id);
    const sessions = scope === 'employee' ? [] : calibrationOptions(actor, review);
    const permissions = reviewPermissions(actor, review, period, sessions);
    const ratings = scope === 'status' ? [] : db.prepare('SELECT r.criterion_id,r.rating,r.comment,c.criterion_key,c.label FROM talent_review_potential_ratings r JOIN talent_review_potential_criteria c ON c.id=r.criterion_id WHERE r.review_id=? ORDER BY c.display_order').all(review.id);
    const decisions = scope === 'session' ? [] : db.prepare('SELECT d.*,u.name responsible_name,c.name competency_name,g.title goal_title FROM development_decisions d LEFT JOIN users u ON u.id=d.responsible_id LEFT JOIN competencies c ON c.id=d.competency_id LEFT JOIN goals g ON g.id=d.linked_goal_id WHERE d.review_id=? ORDER BY d.created_at DESC').all(review.id).map(withDecisionLabel);
    return {
      scope,
      review: reviewForScope(review, scope),
      period,
      employee: personSummary(review.employee_id),
      manager: personSummary(review.manager_id),
      selfAssessment: selfAssessmentForScope(review, scope),
      criteria: currentCriteria(),
      ratings,
      unratedComments: permissions.canEdit ? unratedComments(review) : {},
      support: ['full', 'employee'].includes(scope) ? supportFor(actor, review, period) : supportNumbers(review.employee_id, period),
      decisions,
      previous: scope === 'session' ? [] : previousResults(review, scope),
      history: ['full', 'status'].includes(scope) ? historyFor(review.id, scope) : [],
      permissions,
      calibrationSessions: sessions,
      calibrationHint: scope === 'employee' ? null : calibrationHint(review, period, sessions),
      limits: MIN_LENGTHS
    };
  }

  // --- Entwürfe dürfen Lücken haben. Vollständig muss erst sein, was eingereicht wird. ---

  /** Fehlt der Wert in der Anfrage, bleibt er. Leer heißt: zurücknehmen. Ungültig ist nur, was außerhalb der Skala liegt. */
  function draftScore(value, currentValue, max = 3) {
    if (value === undefined) return currentValue ?? null;
    if (value === null || value === '') return null;
    return boundedInt(value, 1, max, undefined);
  }

  const draftText = (value, currentValue, clean) => (value === undefined ? currentValue ?? null : clean(value) || null);

  function parseSelfDraft(body, review) {
    const performance = draftScore(body.performance, review.self_performance);
    const potential = draftScore(body.potential, review.self_potential);
    if (performance === undefined || potential === undefined) return null;
    return {
      performance,
      potential,
      performanceReason: draftText(body.performanceReason, review.self_performance_reason, reason),
      potentialReason: draftText(body.potentialReason, review.self_potential_reason, reason),
      observations: draftText(body.observations, review.self_observations, text),
      developmentFields: draftText(body.developmentFields, review.self_development_fields, text),
      nextSteps: draftText(body.nextSteps, review.self_next_steps, text)
    };
  }

  function parseManagerDraft(body, review) {
    const performance = draftScore(body.performance, review.original_performance);
    const potential = draftScore(body.potential, review.original_potential);
    if (performance === undefined || potential === undefined) return null;
    const incoming = Array.isArray(body.criteria) ? body.criteria : [];
    const criteria = [];
    for (const criterion of currentCriteria()) {
      const item = incoming.find(entry => Number(entry?.criterionId) === criterion.id);
      if (!item) continue;
      const rating = draftScore(item.rating ?? null, null, 5);
      if (rating === undefined) return null;
      criteria.push({ criterionId: criterion.id, rating, comment: text(item.comment, 1000) });
    }
    return {
      performance,
      potential,
      performanceReason: draftText(body.performanceReason, review.performance_reason, reason),
      potentialReason: draftText(body.potentialReason, review.potential_reason, reason),
      observations: draftText(body.observations, review.observations, text),
      developmentFields: draftText(body.developmentFields, review.development_fields, text),
      nextSteps: draftText(body.nextSteps, review.next_steps, text),
      criteria
    };
  }

  function lengthProblem(label, value, minimum) {
    const missing = minimum - text(value).length;
    return missing > 0 ? `${label}: noch ${plural(missing, 'Zeichen', 'Zeichen')}` : null;
  }

  function managerProblems(review) {
    const total = currentCriteria().length;
    const rated = db.prepare('SELECT COUNT(*) count FROM talent_review_potential_ratings WHERE review_id=?').get(review.id).count;
    return [
      review.original_performance ? null : 'Leistung auswählen',
      review.original_potential ? null : 'Potenzial auswählen',
      lengthProblem('Begründung zur Leistung', review.performance_reason, MIN_LENGTHS.reason),
      lengthProblem('Begründung zum Potenzial', review.potential_reason, MIN_LENGTHS.reason),
      lengthProblem('Beobachtungen', review.observations, MIN_LENGTHS.observations),
      rated < total ? `Potenzialkriterien bewerten: ${total - rated} von ${total} fehlen` : null
    ].filter(Boolean);
  }

  function selfProblems(review) {
    return [
      review.self_performance ? null : 'Leistung auswählen',
      review.self_potential ? null : 'Entwicklungsperspektive auswählen',
      lengthProblem('Begründung zur Leistung', review.self_performance_reason, MIN_LENGTHS.reason),
      lengthProblem('Begründung zur Entwicklungsperspektive', review.self_potential_reason, MIN_LENGTHS.reason),
      lengthProblem('Erfolge und Wirkung', review.self_observations, MIN_LENGTHS.observations)
    ].filter(Boolean);
  }

  const incompleteResponse = (res, problems) => res.status(409).json({ error: `Zum Einreichen fehlt noch: ${problems.join(', ')}.`, missing: problems });

  // --- Listen ---

  const REVIEW_LIST_SQL = `SELECT r.*,u.name employee_name,u.title employee_title,u.manager_id employee_manager_id,u.position_profile_id employee_position_id,m.name manager_name,p.name period_name,p.status period_status
    FROM talent_reviews r
    JOIN users u ON u.id=r.employee_id
    JOIN users m ON m.id=r.manager_id
    JOIN talent_review_periods p ON p.id=r.period_id
    ORDER BY u.name`;

  /** Die Einschätzungen, die diese Person sehen darf, jeweils mit dem, was sie davon sehen darf. */
  function visibleReviews(actor, query) {
    const context = accessContext(actor);
    const periodId = asId(query.periodId);
    const managerId = asId(query.managerId);
    const employeeId = asId(query.employeeId);
    const positionId = asId(query.positionId);
    const organizationManagerId = asId(query.organizationManagerId);
    if (organizationManagerId && !isHr(actor) && !canViewEmployee(actor, organizationManagerId)) return [];
    let reviews = db.prepare(REVIEW_LIST_SQL).all();
    if (periodId) reviews = reviews.filter(item => item.period_id === periodId);
    if (query.status && REVIEW_STATUSES.has(query.status)) reviews = reviews.filter(item => item.status === query.status);
    if (managerId) reviews = reviews.filter(item => item.employee_manager_id === managerId);
    if (employeeId) reviews = reviews.filter(item => item.employee_id === employeeId);
    if (positionId) reviews = reviews.filter(item => item.employee_position_id === positionId);
    if (organizationManagerId) reviews = reviews.filter(item => isAboveInLine(context.people, organizationManagerId, item.employee_id));
    return reviews
      .map(review => ({ review, scope: reviewScope(context, review) }))
      .filter(entry => entry.scope);
  }

  function reviewsBlockingCompletion(periodId) {
    return db.prepare(`SELECT r.id,r.employee_id,r.status,u.name employee_name,m.name manager_name
      FROM talent_reviews r JOIN users u ON u.id=r.employee_id JOIN users m ON m.id=r.manager_id
      WHERE r.period_id=? AND r.status!='finalized' AND u.active=1 AND u.manager_id IS NOT NULL ORDER BY u.name`).all(periodId);
  }

  /** Warum diese Einschätzung nicht in die Sitzung kann, oder null. */
  function caseProblem(actor, session, review) {
    if (!review || review.period_id !== session.period_id || !['manager_submitted', 'in_calibration', 'calibrated'].includes(review.status)) return { status: 400, error: 'Zuordnen lassen sich nur eingereichte Einschätzungen aus derselben Periode.' };
    if (!hrReaches(actor, review.employee_id)) return { status: 403, error: 'Diese Einschätzung darfst du nicht zuordnen.' };
    if (!['planned', 'active'].includes(session.status)) return { status: 409, error: 'Diese Sitzung ist beendet. Lege für den Fall eine neue an.' };
    if (session.organization_manager_id && !isAboveInLine(accessContext(actor).people, session.organization_manager_id, review.employee_id)) return { status: 400, error: 'Diese Person gehört nicht zum Bereich der Sitzung.' };
    if (db.prepare('SELECT 1 FROM talent_review_session_cases WHERE session_id=? AND review_id=?').get(session.id, review.id)) return { status: 409, error: 'Dieser Fall ist der Sitzung schon zugeordnet.' };
    return null;
  }

  function addCase(actor, session, review, displayOrder, moderatorNote) {
    return db.transaction(() => {
      const caseId = db.prepare('INSERT INTO talent_review_session_cases(session_id,review_id,display_order,moderator_note,created_by,updated_by) VALUES(?,?,?,?,?,?)').run(session.id, review.id, displayOrder, moderatorNote, actor.id, actor.id).lastInsertRowid;
      // Kalibriert wird nur, was in Kalibrierung steht. Eine weitere Sitzung ist der Weg, ein Ergebnis noch einmal zu besprechen.
      if (review.status !== 'in_calibration') db.prepare("UPDATE talent_reviews SET status='in_calibration',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(actor.id, now(), review.id);
      history(actor, 'talent_review_session_case', caseId, 'created', null, { sessionId: session.id, reviewId: review.id });
      history(actor, 'talent_review', review.id, review.status === 'calibrated' ? 'calibration_reopened' : 'case_added', { status: review.status }, { status: 'in_calibration', sessionId: session.id });
      return caseId;
    })();
  }

  /** Warum diese Einschätzung nicht final abgeschlossen werden kann, oder null. */
  function finalizeProblem(actor, review, period) {
    if (!hrReaches(actor, review.employee_id)) return { status: 403, error: 'Diese Einschätzung schließt eine andere HR-Person ab.' };
    if (!['calibration', 'completed'].includes(period.status) || review.status !== 'calibrated' || !review.calibrated_performance || !review.calibrated_potential) return { status: 409, error: 'Final abschließen lassen sich nur kalibrierte Einschätzungen.' };
    return null;
  }

  function finalizeReview(actor, review, period) {
    db.transaction(() => {
      db.prepare("UPDATE talent_reviews SET status='finalized',finalized_at=?,finalized_by=?,employee_visible=?,version=version+1,updated_by=?,updated_at=? WHERE id=?").run(now(), actor.id, period.employee_results_visible ? 1 : 0, actor.id, now(), review.id);
      closeTasks(['talent_review_submitted'], review.id);
      ensureResultTask(review.id);
      history(actor, 'talent_review', review.id, 'finalized', { status: review.status }, { status: 'finalized', employeeVisible: !!period.employee_results_visible });
    })();
  }

  /** Geht jede Nummer einzeln durch: Scheitert eine, bleiben die anderen, und die Antwort sagt, welche und warum. */
  function forEachRequested(reviewIds, work) {
    const done = [];
    const failed = [];
    for (const reviewId of new Set(reviewIds)) {
      const review = asId(reviewId) ? reviewById(asId(reviewId)) : null;
      const entry = { reviewId, employee_name: review ? userById(review.employee_id)?.name ?? null : null };
      if (!review) {
        failed.push({ ...entry, reason: 'Diese Einschätzung gibt es nicht.' });
        continue;
      }
      try {
        const problem = work(review);
        if (problem) failed.push({ ...entry, reason: problem.error });
        else done.push(entry);
      } catch {
        failed.push({ ...entry, reason: 'Das hat nicht geklappt. Bitte versuche es einzeln.' });
      }
    }
    return { done, failed };
  }

  const reviewsReadyToFinalize = (actor, periodId) => db.prepare("SELECT r.*,u.name employee_name FROM talent_reviews r JOIN users u ON u.id=r.employee_id WHERE r.period_id=? AND r.status='calibrated' ORDER BY u.name").all(periodId)
    .filter(review => hrReaches(actor, review.employee_id));

  function createDevelopmentGoal(actor, review, decision) {
    if (!decision.createGoal) return null;
    const employee = userById(review.employee_id);
    const title = text(decision.goalTitle, 240) || 'Entwicklungsmaßnahme aus Talent Review';
    const dueDate = decision.targetDate || null;
    if (!validDate(dueDate)) return null;
    const approvalStatus = employee.manager_id ? 'pending_employee_acceptance' : 'approved';
    const goalId = db.prepare("INSERT INTO goals(user_id,title,description,weight,progress,status,due_date,created_by,approval_status,goal_type) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(employee.id, title, decision.description, 100, 0, 'on_track', dueDate, actor.id, approvalStatus, 'development').lastInsertRowid;
    if (decision.competencyId) db.prepare('INSERT OR IGNORE INTO goal_competencies(goal_id,competency_id,created_by) VALUES(?,?,?)').run(goalId, decision.competencyId, actor.id);
    if (approvalStatus === 'pending_employee_acceptance') createTask(employee.id, `${actor.name} schlägt dir das Entwicklungsziel „${title}“ vor`, 'goal_acceptance', goalId, dueDate);
    history(actor, 'development_decision', review.id, 'goal_linked', null, { goalId, reviewId: review.id });
    return goalId;
  }

  const hrPeople = () => db.prepare("SELECT id FROM users WHERE role IN ('hr_admin','hrbp') AND active=1 AND is_system_account=0 ORDER BY id").all();

  /** Über einen Poolvorschlag entscheidet nur HR. Ist die verantwortliche Person nicht aus HR, geht die Aufgabe an die HR-Leitung. */
  function poolDeciders(pool) {
    const responsible = pool.responsible_id ? userById(pool.responsible_id) : null;
    if (responsible && responsible.active === 1 && isHr(responsible)) return [responsible.id];
    return db.prepare("SELECT id FROM users WHERE role='hr_admin' AND active=1 AND is_system_account=0 ORDER BY id").all().map(person => person.id);
  }

  function createProposalTasks(pool, membershipId) {
    const plan = membershipTaskPlan(db.prepare(`${MEMBERSHIP_TASK_SQL} WHERE m.id=?`).get(membershipId));
    poolDeciders(pool).forEach(userId => createTask(userId, plan.title, 'talent_pool_proposal', membershipId, plan.dueDate));
  }

  function seed() {
    const hr = db.prepare("SELECT id,name FROM users WHERE role='hr_admin' AND is_system_account=0 ORDER BY id LIMIT 1").get();
    if (!hr) return;
    const manager = db.prepare("SELECT id,name,role FROM users WHERE role IN ('manager','director') ORDER BY id LIMIT 1").get() || hr;
    const demoUsers = [
      ['Ayşe Demir', 'ayse.demir@loop.local', 'Product Analyst'],
      ['Jonas Richter', 'jonas.richter@loop.local', 'Product Manager'],
      ['Mina Wagner', 'mina.wagner@loop.local', 'UX Writer'],
      ['Sofia Hartmann', 'sofia.hartmann@loop.local', 'Product Operations'],
      ['Leon Fischer', 'leon.fischer@loop.local', 'Service Designer'],
      ['Nora Berger', 'nora.berger@loop.local', 'Data Analyst']
    ];
    if (demoPasswordHash && manager.role !== 'hr_admin' && eligibleEmployees().length < 9) {
      const addUser = db.prepare('INSERT OR IGNORE INTO users(name,email,password_hash,role,title,manager_id) VALUES(?,?,?,?,?,?)');
      demoUsers.forEach(user => {
        if (eligibleEmployees().length < 9) addUser.run(user[0], user[1], demoPasswordHash, 'employee', user[2], manager.id);
      });
    }
    const addPeriod = db.prepare('INSERT OR IGNORE INTO talent_review_periods(name,description,start_date,end_date,assessment_date,status,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)');
    addPeriod.run('Talent Review 2026', 'Die laufende Periode: Führungskräfte schätzen Leistung und Potenzial ihres Teams ein.', '2026-01-01', '2026-12-31', '2026-11-30', 'open', hr.id, hr.id);
    addPeriod.run('Talent Review 2025', 'Die abgeschlossene Periode aus dem Vorjahr.', '2025-01-01', '2025-12-31', '2025-11-30', 'completed', hr.id, hr.id);
    const active = db.prepare("SELECT * FROM talent_review_periods WHERE name='Talent Review 2026'").get();
    const historical = db.prepare("SELECT * FROM talent_review_periods WHERE name='Talent Review 2025'").get();
    if (active.status === 'open') ensureReviewRecords(active, hr);
    const criteria = currentCriteria();
    const addRating = db.prepare('INSERT OR IGNORE INTO talent_review_potential_ratings(review_id,criterion_id,rating,comment,created_by,updated_by) VALUES(?,?,?,?,?,?)');
    // Erfundene Vorjahreswerte gibt es nur beim ersten Befüllen, nicht für später dazugekommene Personen.
    if (!db.prepare('SELECT 1 FROM talent_reviews WHERE period_id=? LIMIT 1').get(historical.id)) {
      const reviewInsert = db.prepare("INSERT OR IGNORE INTO talent_reviews(period_id,employee_id,manager_id,original_performance,original_potential,performance_reason,potential_reason,observations,development_fields,next_steps,calibrated_performance,calibrated_potential,calibration_reason,status,submitted_at,calibrated_at,calibrated_by,finalized_at,finalized_by,employee_visible,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      eligibleEmployees().forEach((employee, index) => {
        const performance = index % 3 + 1;
        const potential = Math.floor(index / 3) % 3 + 1;
        reviewInsert.run(historical.id, employee.id, employee.manager_id, performance, potential, 'Hat die vereinbarten Ergebnisse im Jahresverlauf zuverlässig erreicht und Absprachen eingehalten.', 'Übernimmt neue Aufgaben bereitwillig, lernt schnell dazu und fragt nach, wenn etwas unklar ist.', 'Hat im Herbst die Übergabe eines größeren Vorhabens ruhig und gut organisiert begleitet.', 'Schwierige Themen früher ansprechen und Ergebnisse kürzer vorstellen.', 'Im kommenden Jahr ein kleines Vorhaben eigenständig verantworten.', performance, potential, 'Die Runde hat die Einschätzung mit vergleichbaren Aufgaben abgeglichen und bestätigt.', 'finalized', now(), now(), hr.id, now(), hr.id, 1, employee.manager_id, employee.manager_id);
        const review = db.prepare('SELECT id FROM talent_reviews WHERE period_id=? AND employee_id=?').get(historical.id, employee.id);
        if (review) criteria.forEach((criterion, ratingIndex) => addRating.run(review.id, criterion.id, (ratingIndex + index) % 5 + 1, 'Zeigt sich im Alltag an mehreren konkreten Beispielen.', employee.manager_id, employee.manager_id));
      });
    }
    // Die Periode 2025 gilt als freigegeben, solange alle ihre Ergebnisse sichtbar sind. Hat HR die Freigabe zurückgenommen, bleibt es dabei.
    db.prepare("UPDATE talent_review_periods SET employee_results_visible=1 WHERE id=? AND employee_results_visible=0 AND NOT EXISTS (SELECT 1 FROM talent_reviews r WHERE r.period_id=? AND r.status='finalized' AND r.employee_visible=0)").run(historical.id, historical.id);
    const demoReviewStates = [
      ['ayse.demir@loop.local', 'manager_draft', 2, 3],
      ['jonas.richter@loop.local', 'manager_submitted', 3, 2],
      ['mina.wagner@loop.local', 'manager_draft', 2, 2]
    ];
    const seedActiveReview = db.prepare("UPDATE talent_reviews SET original_performance=?,original_potential=?,performance_reason=?,potential_reason=?,observations=?,development_fields=?,next_steps=?,status=?,submitted_at=?,updated_by=?,updated_at=? WHERE id=? AND status='not_started' AND created_by=?");
    demoReviewStates.forEach(([email, status, performance, potential], index) => {
      const employee = db.prepare('SELECT id,manager_id FROM users WHERE email=?').get(email);
      const review = employee && db.prepare('SELECT * FROM talent_reviews WHERE period_id=? AND employee_id=?').get(active.id, employee.id);
      if (!review) return;
      const submittedAt = status === 'manager_submitted' ? now() : null;
      const result = seedActiveReview.run(performance, potential, 'Liefert verlässlich, auch wenn es im Team eng wird, und hält Kolleginnen und Kollegen auf dem Laufenden.', 'Denkt über die eigene Aufgabe hinaus und hat zuletzt mehrfach Abstimmungen im Team übernommen.', 'Hat im Frühjahr einen Engpass früh erkannt und gemeinsam mit dem Team eine Lösung gefunden.', 'Prioritäten klarer setzen und öfter Aufgaben abgeben.', 'Bis zum Sommer ein teamübergreifendes Thema begleiten.', status, submittedAt, employee.manager_id, now(), review.id, hr.id);
      if (!result.changes) return;
      criteria.forEach((criterion, ratingIndex) => addRating.run(review.id, criterion.id, (ratingIndex + index) % 5 + 1, 'Zeigt sich im Alltag an mehreren konkreten Beispielen.', employee.manager_id, employee.manager_id));
      if (status === 'manager_submitted') hrPeople().forEach(person => addReviewTask('talent_review_submitted', review.id, person.id));
    });
    const session = db.prepare("INSERT OR IGNORE INTO talent_review_sessions(period_id,title,description,session_date,status,moderator_id,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)");
    [
      ['Produkt & People Kalibrierung', 'Vergleich der Einschätzungen aus Produkt und Personal.', '2026-10-15'],
      ['Fachliche Entwicklung & Expertenlaufbahn', 'Schwerpunkt auf Entwicklungsschritten und Fachlaufbahnen.', '2026-10-22'],
      ['Abschlusskalibrierung', 'Letzte Runde vor dem Abschluss der Periode.', '2026-11-05']
    ].forEach(([title, description, sessionDate]) => session.run(active.id, title, description, sessionDate, 'planned', hr.id, hr.id, hr.id));
    const sessionRow = db.prepare("SELECT * FROM talent_review_sessions WHERE period_id=? AND title='Produkt & People Kalibrierung'").get(active.id);
    [hr.id, manager.id].forEach(userId => db.prepare('INSERT OR IGNORE INTO talent_review_session_participants(session_id,user_id,added_by) VALUES(?,?,?)').run(sessionRow.id, userId, hr.id));
    const pool = db.prepare('INSERT OR IGNORE INTO talent_pools(name,description,purpose,responsible_id,created_by,updated_by) VALUES(?,?,?,?,?,?)');
    pool.run('Führungskräftenachwuchs', 'Für Beschäftigte, die mehr Führungsverantwortung übernehmen möchten.', 'Entwicklungsangebote bündeln', hr.id, hr.id, hr.id);
    pool.run('Expertenlaufbahn', 'Für Beschäftigte, die fachlich tiefer einsteigen und andere anleiten möchten.', 'Fachliche Entwicklung sichtbar machen', hr.id, hr.id, hr.id);
    const leadershipPool = db.prepare("SELECT * FROM talent_pools WHERE name='Führungskräftenachwuchs'").get();
    const expertPool = db.prepare("SELECT id FROM talent_pools WHERE name='Expertenlaufbahn'").get();
    const ayse = db.prepare("SELECT id FROM users WHERE email='ayse.demir@loop.local'").get();
    const jonas = db.prepare("SELECT id FROM users WHERE email='jonas.richter@loop.local'").get();
    const mina = db.prepare("SELECT id FROM users WHERE email='mina.wagner@loop.local'").get();
    const membership = db.prepare('INSERT OR IGNORE INTO talent_pool_memberships(pool_id,employee_id,period_id,proposed_by,admitted_by,admitted_at,status,reason,development_plan) VALUES(?,?,?,?,?,?,?,?,?)');
    if (leadershipPool && ayse) membership.run(leadershipPool.id, ayse.id, historical.id, manager.id, hr.id, now(), 'active', 'Hat im letzten Jahr mehrfach Verantwortung für das Team übernommen.', 'Mentoring und Projektverantwortung in der nächsten Periode.');
    if (leadershipPool && jonas) {
      const proposal = membership.run(leadershipPool.id, jonas.id, active.id, manager.id, null, null, 'proposed', 'Übernimmt oft die Abstimmung zwischen den Teams und möchte mehr führen.', 'Entwicklungsgespräch und herausfordernde Zusatzaufgabe vorbereiten.');
      if (proposal.changes) createProposalTasks(leadershipPool, proposal.lastInsertRowid);
    }
    if (expertPool && mina) membership.run(expertPool.id, mina.id, historical.id, manager.id, hr.id, now(), 'active', 'Ist im Team die erste Ansprechperson für fachliche Fragen.', 'Fachliches Mentoring und sichtbare Projektwirkung.');
    const ayseReview = ayse && db.prepare('SELECT * FROM talent_reviews WHERE period_id=? AND employee_id=?').get(active.id, ayse.id);
    if (ayseReview) {
      const existingDecision = db.prepare("SELECT id FROM development_decisions WHERE review_id=? AND decision_type='mentoring'").get(ayseReview.id);
      if (!existingDecision) {
        const decisionId = db.prepare("INSERT INTO development_decisions(review_id,period_id,employee_id,decision_type,description,responsible_id,start_date,target_date,status,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(ayseReview.id, active.id, ayse.id, 'mentoring', 'Mentoring zur Vorbereitung auf mehr Verantwortung, einmal im Monat ein Gespräch.', manager.id, '2026-07-01', '2026-12-15', 'planned', hr.id, hr.id).lastInsertRowid;
        history(hr, 'development_decision', decisionId, 'created', null, { reviewId: ayseReview.id, decisionType: 'mentoring', seeded: true });
      }
    }
    // Die Beispielstände entstehen nach den Aufgaben. Hier fällt weg, was sich dadurch erledigt hat.
    refreshOpenTasks();
  }

  router.use(auth);

  // Ältere Aufrufer melden sich nicht am Wechsel der Führungskraft an. Dann holt das Modul ihn beim nächsten Aufruf nach.
  if (!deps.onManagerChanged) router.use(['/talent-review', '/talent-pools', '/development-decisions'], (req, res, next) => {
    followManagerChange();
    next();
  });

  router.get('/talent-review/meta', (req, res) => {
    const actor = current(req);
    res.json({
      periodStatuses: PERIOD_LABELS,
      reviewStatuses: { not_started: 'Nicht begonnen', manager_draft: 'Entwurf der Führungskraft', manager_submitted: 'Eingereicht', in_calibration: 'In Kalibrierung', calibrated: 'Kalibriert', finalized: 'Final abgeschlossen' },
      sessionStatuses: { planned: 'Geplant', active: 'Läuft', completed: 'Abgeschlossen', cancelled: 'Abgesagt' },
      membershipStatuses: { proposed: 'Vorgeschlagen', active: 'Aufgenommen', paused: 'Pausiert', completed: 'Beendet', removed: 'Entfernt' },
      decisionTypes: DECISION_LABELS,
      boxes: BOXES,
      criteria: currentCriteria(),
      canManagePeriods: isHr(actor),
      canReview: isLeader(actor)
    });
  });

  router.get('/talent-review/periods', (req, res) => {
    const actor = current(req);
    const rows = db.prepare('SELECT p.*,u.name created_by_name FROM talent_review_periods p JOIN users u ON u.id=p.created_by ORDER BY p.assessment_date DESC').all();
    if (!isHr(actor)) return res.json({ items: rows.filter(item => item.status !== 'draft' && item.status !== 'archived') });
    res.json({
      items: rows.map(row => ({
        ...row,
        nextStatuses: PERIOD_TRANSITIONS[row.status] || [],
        missingPeopleCount: row.status === 'open' ? missingPeople(row.id).missing.length : 0,
        readyToFinalizeCount: ['calibration', 'completed'].includes(row.status) ? reviewsReadyToFinalize(actor, row.id).length : 0
      }))
    });
  });

  router.post('/talent-review/periods', (req, res) => {
    const actor = current(req);
    const name = text(req.body.name, 180), description = text(req.body.description), startDate = text(req.body.startDate, 10), endDate = text(req.body.endDate, 10), assessmentDate = text(req.body.assessmentDate, 10);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Perioden anlegen.' });
    if (!name || !validDate(startDate) || !validDate(endDate) || !validDate(assessmentDate) || startDate > endDate || assessmentDate < startDate || assessmentDate > endDate) return res.status(400).json({ error: 'Nötig sind ein Name und ein Zeitraum. Der Stichtag muss im Zeitraum liegen.' });
    try {
      const id = db.prepare("INSERT INTO talent_review_periods(name,description,start_date,end_date,assessment_date,status,created_by,updated_by) VALUES(?,?,?,?,?,'draft',?,?)").run(name, description, startDate, endDate, assessmentDate, actor.id, actor.id).lastInsertRowid;
      history(actor, 'talent_review_period', id, 'created', null, { name, startDate, endDate, assessmentDate });
      res.status(201).json({ id });
    } catch {
      res.status(409).json({ error: 'Eine Periode mit diesem Namen gibt es schon.' });
    }
  });

  router.patch('/talent-review/periods/:id', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Perioden bearbeiten.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    if (period.status !== 'draft') return res.status(409).json({ error: 'Bearbeiten geht nur im Entwurf.' });
    const name = req.body.name === undefined ? period.name : text(req.body.name, 180);
    const description = req.body.description === undefined ? period.description : text(req.body.description);
    const startDate = req.body.startDate === undefined ? period.start_date : text(req.body.startDate, 10);
    const endDate = req.body.endDate === undefined ? period.end_date : text(req.body.endDate, 10);
    const assessmentDate = req.body.assessmentDate === undefined ? period.assessment_date : text(req.body.assessmentDate, 10);
    if (!name || !validDate(startDate) || !validDate(endDate) || !validDate(assessmentDate) || startDate > endDate || assessmentDate < startDate || assessmentDate > endDate) return res.status(400).json({ error: 'Nötig sind ein Name und ein Zeitraum. Der Stichtag muss im Zeitraum liegen.' });
    try {
      db.prepare('UPDATE talent_review_periods SET name=?,description=?,start_date=?,end_date=?,assessment_date=?,updated_by=?,updated_at=? WHERE id=?').run(name, description, startDate, endDate, assessmentDate, actor.id, now(), period.id);
      history(actor, 'talent_review_period', period.id, 'updated', period, { name, description, startDate, endDate, assessmentDate });
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Eine Periode mit diesem Namen gibt es schon.' });
    }
  });

  /** Was vor einem Wechsel des Stands noch offen ist. Die Oberfläche nennt es, bevor HR entscheidet. */
  router.get('/talent-review/periods/:id/open-items', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR sieht diese Übersicht.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    const summarize = rows => rows.map(row => pick(row, ['id', 'employee_id', 'employee_name', 'manager_name', 'status']));
    const notFinalized = reviewsBlockingCompletion(period.id);
    const inSession = new Set(db.prepare("SELECT c.review_id FROM talent_review_session_cases c JOIN talent_review_sessions s ON s.id=c.session_id WHERE s.period_id=? AND s.status IN ('planned','active')").all(period.id).map(row => row.review_id));
    const selfNotSubmitted = db.prepare("SELECT COUNT(*) count FROM talent_reviews r JOIN users u ON u.id=r.employee_id WHERE r.period_id=? AND r.self_status!='employee_submitted' AND u.active=1").get(period.id).count;
    res.json({
      notSubmitted: summarize(notFinalized.filter(managerStillWrites)),
      notInSession: summarize(notFinalized.filter(row => row.status === 'manager_submitted' && !inSession.has(row.id))),
      notFinalized: summarize(notFinalized),
      readyToFinalize: reviewsReadyToFinalize(actor, period.id).map(review => ({ id: review.id, employee_id: review.employee_id, employee_name: review.employee_name, ...effectiveResult(review) })),
      selfNotSubmitted,
      missingPeople: missingPeople(period.id).missing.length,
      resultsVisibleTo: db.prepare("SELECT COUNT(*) count FROM talent_reviews WHERE period_id=? AND status='finalized'").get(period.id).count
    });
  });

  router.get('/talent-review/periods/:id/people', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR nimmt Personen in eine Periode auf.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    res.json(missingPeople(period.id));
  });

  router.post('/talent-review/periods/:id/people', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR nimmt Personen in eine Periode auf.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    if (period.status !== 'open') return res.status(409).json({ error: 'Personen lassen sich nur aufnehmen, solange die Periode offen ist. Sonst könnte niemand mehr für sie schreiben.' });
    const wanted = new Set((Array.isArray(req.body.employeeIds) ? req.body.employeeIds : []).map(asId));
    const available = new Set(missingPeople(period.id).missing.map(person => person.id));
    if (!wanted.size || [...wanted].some(id => !available.has(id))) return res.status(400).json({ error: 'Aufnehmen lassen sich nur aktive Personen mit Führungskraft, die in dieser Periode noch fehlen.' });
    const added = db.transaction(() => ensureReviewRecords(period, actor, wanted))();
    res.json({ ok: true, added });
  });

  router.patch('/talent-review/periods/:id/status', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id)), next = req.body.status;
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf den Stand einer Periode ändern.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    if (!PERIOD_STATUSES.has(next) || !transitionPeriod(period, next)) return res.status(409).json({ error: `Von „${PERIOD_LABELS[period.status]}“ geht es nicht zu „${PERIOD_LABELS[next] || next}“.` });
    if (next === 'completed') {
      const open = reviewsBlockingCompletion(period.id);
      if (open.length) {
        const names = open.slice(0, 8).map(item => item.employee_name).join(', ');
        const more = open.length > 8 ? ` und ${open.length - 8} weitere` : '';
        return res.status(409).json({ error: `Noch nicht final abgeschlossen: ${names}${more}.`, open: open.map(item => pick(item, ['id', 'employee_id', 'employee_name', 'status'])) });
      }
    }
    db.transaction(() => {
      db.prepare('UPDATE talent_review_periods SET status=?,updated_by=?,updated_at=? WHERE id=?').run(next, actor.id, now(), period.id);
      if (next === 'open') ensureReviewRecords(period, actor);
      if (['completed', 'archived'].includes(next)) {
        // Mit der Periode endet auch jede Sitzung. Sonst blieben die Fälle für die Teilnehmenden lesbar.
        db.prepare("UPDATE talent_review_sessions SET status='completed',updated_by=?,updated_at=? WHERE period_id=? AND status='active'").run(actor.id, now(), period.id);
        db.prepare("UPDATE talent_review_sessions SET status='cancelled',updated_by=?,updated_at=? WHERE period_id=? AND status='planned'").run(actor.id, now(), period.id);
      }
      history(actor, 'talent_review_period', period.id, 'status_changed', { status: period.status }, { status: next }, text(req.body.reason, 1000) || null);
      refreshOpenTasks();
    })();
    res.json({ ok: true, status: next });
  });

  router.patch('/talent-review/periods/:id/release', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id)), visible = req.body.employeeVisible === true || req.body.employeeVisible === 'true' || req.body.employeeVisible === 'on';
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR darf Ergebnisse freigeben.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    if (period.status !== 'completed') return res.status(409).json({ error: 'Ergebnisse lassen sich erst freigeben, wenn die Periode abgeschlossen ist.' });
    db.transaction(() => {
      db.prepare('UPDATE talent_review_periods SET employee_results_visible=?,updated_by=?,updated_at=? WHERE id=?').run(visible ? 1 : 0, actor.id, now(), period.id);
      db.prepare("UPDATE talent_reviews SET employee_visible=?,updated_by=?,updated_at=? WHERE period_id=? AND status='finalized'").run(visible ? 1 : 0, actor.id, now(), period.id);
      history(actor, 'talent_review_period', period.id, 'employee_release_changed', { employeeVisible: !!period.employee_results_visible }, { employeeVisible: visible });
      if (visible) db.prepare("SELECT id FROM talent_reviews WHERE period_id=? AND status='finalized'").all(period.id).forEach(review => ensureResultTask(review.id));
      refreshOpenTasks();
    })();
    res.json({ ok: true, employeeVisible: visible });
  });

  router.get('/talent-review/reviews', (req, res) => {
    const actor = current(req);
    res.json({ items: visibleReviews(actor, req.query).map(({ review, scope }) => reviewListItem(actor, review, scope)) });
  });

  router.get('/talent-review/self-reviews', (req, res) => {
    const actor = current(req);
    const reviews = db.prepare(`SELECT r.*,p.name period_name,p.status period_status,p.start_date,p.end_date,p.assessment_date
      FROM talent_reviews r JOIN talent_review_periods p ON p.id=r.period_id
      WHERE r.employee_id=? ORDER BY p.assessment_date DESC`).all(actor.id);
    res.json({
      limits: MIN_LENGTHS,
      items: reviews.map(review => ({
        id: review.id,
        period: { id: review.period_id, name: review.period_name, status: review.period_status, startDate: review.start_date, endDate: review.end_date, assessmentDate: review.assessment_date },
        self: {
          status: SELF_ASSESSMENT_STATUSES.has(review.self_status) ? review.self_status : 'not_started',
          performance: review.self_performance,
          potential: review.self_potential,
          performanceReason: review.self_performance_reason,
          potentialReason: review.self_potential_reason,
          observations: review.self_observations,
          developmentFields: review.self_development_fields,
          nextSteps: review.self_next_steps,
          submittedAt: review.self_submitted_at || null
        },
        canEdit: review.period_status === 'open' && ['not_started', 'employee_draft'].includes(review.self_status || 'not_started'),
        support: reviewSupport(review.employee_id, { status: review.period_status, start_date: review.start_date, end_date: review.end_date, assessment_date: review.assessment_date })
      }))
    });
  });

  router.patch('/talent-review/reviews/:id/self', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id);
    if (!review || !period) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    if (!selfReviewEditAccess(actor, review, period)) return res.status(403).json({ error: 'Deine Selbsteinschätzung bearbeitest nur du, und nur solange die Periode offen ist.' });
    if (!['not_started', 'employee_draft'].includes(review.self_status || 'not_started')) return res.status(409).json({ error: 'Eine abgegebene Selbsteinschätzung lässt sich nicht mehr ändern.' });
    const draft = parseSelfDraft(req.body, review);
    if (!draft) return res.status(400).json({ error: 'Leistung und Entwicklungsperspektive gehen von 1 bis 3.' });
    db.transaction(() => {
      db.prepare("UPDATE talent_reviews SET self_performance=?,self_potential=?,self_performance_reason=?,self_potential_reason=?,self_observations=?,self_development_fields=?,self_next_steps=?,self_status='employee_draft',version=version+1,updated_by=?,updated_at=? WHERE id=?")
        .run(draft.performance, draft.potential, draft.performanceReason, draft.potentialReason, draft.observations, draft.developmentFields, draft.nextSteps, actor.id, now(), review.id);
      // Nur der Stand: Der Text eines Entwurfs ist privat und gehört weder in den Verlauf noch ins Protokoll.
      history(actor, 'talent_review', review.id, 'self_draft_saved', { status: review.self_status || 'not_started' }, { status: 'employee_draft' });
    })();
    res.json({ ok: true, status: 'employee_draft', missing: selfProblems(reviewById(review.id)) });
  });

  router.post('/talent-review/reviews/:id/self/submit', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id);
    if (!review || !period) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    if (!selfReviewEditAccess(actor, review, period)) return res.status(403).json({ error: 'Deine Selbsteinschätzung gibst nur du ab, und nur solange die Periode offen ist.' });
    if (review.self_status === 'employee_submitted') return res.status(409).json({ error: 'Du hast diese Selbsteinschätzung schon abgegeben.' });
    const problems = selfProblems(review);
    if (problems.length) return incompleteResponse(res, problems);
    db.transaction(() => {
      db.prepare("UPDATE talent_reviews SET self_status='employee_submitted',self_submitted_at=?,version=version+1,updated_by=?,updated_at=? WHERE id=?").run(now(), actor.id, now(), review.id);
      closeTasks(['talent_review_self_assessment'], review.id);
      history(actor, 'talent_review', review.id, 'self_submitted', { status: review.self_status }, { status: 'employee_submitted' });
    })();
    res.json({ ok: true, status: 'employee_submitted' });
  });

  router.get('/talent-review/reviews/:id', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id));
    if (!review) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    const scope = reviewScope(accessContext(actor), review);
    if (!scope) return res.status(403).json({ error: 'Diese Einschätzung darfst du nicht lesen.' });
    // Wer das eigene Ergebnis öffnet, hat die Aufgabe „Ergebnis ansehen“ erledigt.
    if (scope === 'employee') closeTasks(['talent_review_finalized'], review.id);
    res.json(detail(review, actor, scope));
  });

  router.patch('/talent-review/reviews/:id/manager', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id);
    if (!review || !period) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    if (!isDirectManager(actor, review.employee_id)) return res.status(403).json({ error: 'Diesen Entwurf bearbeitet nur die direkte Führungskraft.' });
    if (period.status !== 'open' || !managerStillWrites(review)) return res.status(409).json({ error: 'Diese Einschätzung lässt sich gerade nicht bearbeiten: Sie ist eingereicht oder die Periode ist nicht mehr offen.' });
    const draft = parseManagerDraft(req.body, review);
    if (!draft) return res.status(400).json({ error: 'Leistung und Potenzial gehen von 1 bis 3, die Kriterien von 1 bis 5.' });
    const unrated = unratedComments(review);
    db.transaction(() => {
      const upsert = db.prepare('INSERT INTO talent_review_potential_ratings(review_id,criterion_id,rating,comment,created_by,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(review_id,criterion_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,updated_by=excluded.updated_by,updated_at=excluded.updated_at');
      const clearRating = db.prepare('DELETE FROM talent_review_potential_ratings WHERE review_id=? AND criterion_id=?');
      for (const item of draft.criteria) {
        delete unrated[item.criterionId];
        if (item.rating) {
          upsert.run(review.id, item.criterionId, item.rating, item.comment, actor.id, actor.id, now());
        } else {
          clearRating.run(review.id, item.criterionId);
          if (item.comment) unrated[item.criterionId] = item.comment;
        }
      }
      db.prepare("UPDATE talent_reviews SET original_performance=?,original_potential=?,performance_reason=?,potential_reason=?,observations=?,development_fields=?,next_steps=?,criteria_draft=?,status='manager_draft',version=version+1,updated_by=?,updated_at=? WHERE id=?")
        .run(draft.performance, draft.potential, draft.performanceReason, draft.potentialReason, draft.observations, draft.developmentFields, draft.nextSteps, Object.keys(unrated).length ? JSON.stringify(unrated) : null, actor.id, now(), review.id);
      // Solange die Führungskraft schreibt, gehört der Text ihr. Festgehalten wird er erst, wenn HR ihn zurückgibt.
      history(actor, 'talent_review', review.id, 'manager_draft_saved', { status: review.status }, { status: 'manager_draft' });
    })();
    res.json({ ok: true, status: 'manager_draft', missing: managerProblems(reviewById(review.id)) });
  });

  router.post('/talent-review/reviews/:id/submit', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id);
    if (!review || !period) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    if (!isDirectManager(actor, review.employee_id)) return res.status(403).json({ error: 'Einreichen kann nur die direkte Führungskraft.' });
    if (period.status !== 'open') return res.status(409).json({ error: 'Einreichen geht nur, solange die Periode offen ist.' });
    if (review.status !== 'manager_draft' && review.status !== 'not_started') return res.status(409).json({ error: 'Diese Einschätzung ist schon eingereicht.' });
    const problems = managerProblems(review);
    if (problems.length) return incompleteResponse(res, problems);
    db.transaction(() => {
      db.prepare("UPDATE talent_reviews SET status='manager_submitted',submitted_at=?,criteria_draft=NULL,version=version+1,updated_by=?,updated_at=? WHERE id=?").run(now(), actor.id, now(), review.id);
      closeTasks(['talent_review_start', 'talent_review_returned'], review.id);
      hrPeople().filter(person => person.id !== review.employee_id).forEach(person => {
        if (!db.prepare("SELECT 1 FROM tasks WHERE user_id=? AND type='talent_review_submitted' AND entity_id=? AND done=0").get(person.id, review.id)) addReviewTask('talent_review_submitted', review.id, person.id);
      });
      history(actor, 'talent_review', review.id, 'submitted', { status: review.status }, { status: 'manager_submitted' });
    })();
    res.json({ ok: true });
  });

  router.post('/talent-review/reviews/:id/return', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id), returnReason = reason(req.body.reason);
    if (!isHr(actor)) return res.status(403).json({ error: 'Zurückgeben kann nur HR.' });
    if (!review || !period) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    if (!hrReaches(actor, review.employee_id)) return res.status(403).json({ error: 'Diese Einschätzung darfst du nicht zurückgeben.' });
    if (period.status !== 'open' || review.status !== 'manager_submitted') return res.status(409).json({ error: 'Zurückgeben geht nur bei eingereichten Einschätzungen in einer offenen Periode.' });
    if (returnReason.length < 10) return res.status(409).json({ error: 'Bitte begründe die Rückgabe mit mindestens 10 Zeichen.' });
    db.transaction(() => {
      db.prepare("UPDATE talent_reviews SET status='manager_draft',returned_at=?,returned_by=?,return_reason=?,version=version+1,updated_by=?,updated_at=? WHERE id=?").run(now(), actor.id, returnReason, actor.id, now(), review.id);
      closeTasks(['talent_review_submitted'], review.id);
      addReviewTask('talent_review_returned', review.id);
      // Der eingereichte Stand war offiziell. Er bleibt nachvollziehbar, auch wenn die Führungskraft ihn jetzt überarbeitet.
      const submittedVersion = { status: review.status, performance: review.original_performance, potential: review.original_potential, performanceReason: review.performance_reason, potentialReason: review.potential_reason, observations: review.observations, developmentFields: review.development_fields, nextSteps: review.next_steps };
      history(actor, 'talent_review', review.id, 'returned', submittedVersion, { status: 'manager_draft' }, returnReason);
    })();
    res.json({ ok: true });
  });

  router.get('/talent-review/sessions', (req, res) => {
    const actor = current(req), periodId = asId(req.query.periodId);
    let sessions = db.prepare('SELECT s.*,p.name period_name,p.status period_status,u.name moderator_name FROM talent_review_sessions s JOIN talent_review_periods p ON p.id=s.period_id JOIN users u ON u.id=s.moderator_id ORDER BY s.session_date DESC').all();
    if (periodId) sessions = sessions.filter(session => session.period_id === periodId);
    if (!isHr(actor)) sessions = sessions.filter(session => sessionParticipant(actor, session.id));
    res.json({ items: sessions });
  });

  router.post('/talent-review/sessions', (req, res) => {
    const actor = current(req), periodId = asId(req.body.periodId), period = periodById(periodId), title = text(req.body.title, 180), description = text(req.body.description), sessionDate = text(req.body.sessionDate, 10), moderatorId = asId(req.body.moderatorId) || actor.id, organizationManagerId = asId(req.body.organizationManagerId);
    if (!isHr(actor)) return res.status(403).json({ error: 'Kalibrierungssitzungen legt nur HR an.' });
    const organizationManager = organizationManagerId ? userById(organizationManagerId) : null;
    if (!period || !title || !sessionDate || !validDate(sessionDate) || (organizationManagerId && !organizationManager)) return res.status(400).json({ error: 'Nötig sind Periode, Titel und Datum.' });
    if (moderatorId !== actor.id && !mayJoinSession(userById(moderatorId))) return res.status(400).json({ error: 'Moderieren können nur aktive Führungskräfte und HR.' });
    if (['completed', 'archived'].includes(period.status)) return res.status(409).json({ error: 'Diese Periode ist beendet. Dafür lässt sich keine Sitzung mehr anlegen.' });
    try {
      const id = db.transaction(() => {
        const sessionId = db.prepare("INSERT INTO talent_review_sessions(period_id,title,description,session_date,status,moderator_id,organization_manager_id,created_by,updated_by) VALUES(?,?,?,?, 'planned',?,?,?,?)").run(periodId, title, description, sessionDate, moderatorId, organizationManagerId, actor.id, actor.id).lastInsertRowid;
        db.prepare('INSERT OR IGNORE INTO talent_review_session_participants(session_id,user_id,added_by) VALUES(?,?,?)').run(sessionId, moderatorId, actor.id);
        createSessionTask({ id: sessionId }, moderatorId);
        history(actor, 'talent_review_session', sessionId, 'created', null, { periodId, title, sessionDate, moderatorId });
        return sessionId;
      })();
      res.status(201).json({ id });
    } catch {
      res.status(409).json({ error: 'Eine Sitzung mit diesem Titel gibt es in der Periode schon.' });
    }
  });

  router.patch('/talent-review/sessions/:id', (req, res) => {
    const actor = current(req), session = sessionById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Sitzungen bearbeitet nur HR.' });
    if (!session) return res.status(404).json({ error: 'Sitzung nicht gefunden.' });
    const nextStatus = req.body.status;
    if (nextStatus && (!SESSION_STATUSES.has(nextStatus) || !transitionSession(session, nextStatus))) return res.status(409).json({ error: 'Dieser Wechsel des Sitzungsstands ist nicht möglich.' });
    if (nextStatus === 'active' && periodById(session.period_id).status !== 'calibration') return res.status(409).json({ error: 'Eine Sitzung kann erst starten, wenn die Periode in der Kalibrierung ist. Das stellst du unter „Perioden“ um.' });
    const title = req.body.title === undefined ? session.title : text(req.body.title, 180);
    const description = req.body.description === undefined ? session.description : text(req.body.description);
    const sessionDate = req.body.sessionDate === undefined ? session.session_date : text(req.body.sessionDate, 10);
    if (!title || !sessionDate || !validDate(sessionDate)) return res.status(400).json({ error: 'Nötig sind Titel und Datum.' });
    const taken = db.prepare('SELECT id FROM talent_review_sessions WHERE period_id=? AND title=? AND id<>?').get(session.period_id, title, session.id);
    if (taken) return res.status(409).json({ error: 'Eine Sitzung mit diesem Titel gibt es in der Periode schon.' });
    db.transaction(() => {
      db.prepare('UPDATE talent_review_sessions SET title=?,description=?,session_date=?,status=?,updated_by=?,updated_at=? WHERE id=?').run(title, description, sessionDate, nextStatus || session.status, actor.id, now(), session.id);
      history(actor, 'talent_review_session', session.id, nextStatus ? 'status_changed' : 'updated', session, { title, description, sessionDate, status: nextStatus || session.status });
      refreshOpenTasks();
    })();
    res.json({ ok: true });
  });

  router.post('/talent-review/sessions/:id/participants', (req, res) => {
    const actor = current(req), sessionId = asId(req.params.id), session = sessionById(sessionId), userId = asId(req.body.userId), participant = userById(userId);
    if (!isHr(actor)) return res.status(403).json({ error: 'Teilnehmende ordnet nur HR zu.' });
    if (!session) return res.status(404).json({ error: 'Sitzung nicht gefunden.' });
    if (!mayJoinSession(participant)) return res.status(400).json({ error: 'Teilnehmen können nur aktive Führungskräfte und HR.' });
    db.transaction(() => {
      const joined = db.prepare('INSERT OR IGNORE INTO talent_review_session_participants(session_id,user_id,added_by) VALUES(?,?,?)').run(sessionId, userId, actor.id);
      if (joined.changes) createSessionTask(session, userId);
      history(actor, 'talent_review_session', sessionId, 'participant_added', null, { userId });
    })();
    res.json({ ok: true });
  });

  router.get('/talent-review/sessions/:id', (req, res) => {
    const actor = current(req), sessionId = asId(req.params.id), session = sessionById(sessionId);
    if (!session) return res.status(404).json({ error: 'Sitzung nicht gefunden.' });
    if (!sessionAccess(actor, sessionId)) return res.status(403).json({ error: 'Diese Sitzung darfst du nicht öffnen.' });
    const context = accessContext(actor);
    const hr = isHr(actor);
    const stillAhead = ['planned', 'active'].includes(session.status);
    const participants = db.prepare('SELECT u.id,u.name,u.role,u.title FROM talent_review_session_participants p JOIN users u ON u.id=p.user_id WHERE p.session_id=? ORDER BY u.name').all(sessionId);
    const rows = db.prepare(`SELECT c.id,c.session_id,c.review_id,c.display_order,c.case_status,c.moderator_note,c.outcome_status,r.employee_id,r.status review_status,r.employee_visible,u.name employee_name,u.title employee_title,m.name manager_name
      FROM talent_review_session_cases c
      JOIN talent_reviews r ON r.id=c.review_id
      JOIN users u ON u.id=r.employee_id
      JOIN users m ON m.id=r.manager_id
      WHERE c.session_id=? ORDER BY c.display_order,c.id`).all(sessionId);
    const cases = [];
    for (const row of rows) {
      // Der eigene Fall bleibt verborgen. Nach der Sitzung bleibt nur, was man auch sonst sehen darf.
      if (row.employee_id === actor.id) continue;
      const scope = reviewScope(context, { id: row.review_id, employee_id: row.employee_id, status: row.review_status, employee_visible: row.employee_visible });
      if (hr && !scope) continue;
      if (!hr && !stillAhead && !scope) continue;
      const mayReadOutcome = !!scope && scope !== 'status';
      cases.push({
        id: row.id,
        review_id: row.review_id,
        display_order: row.display_order,
        case_status: row.case_status,
        moderator_note: row.moderator_note,
        outcome_status: mayReadOutcome ? row.outcome_status : null,
        outcome_label: mayReadOutcome ? BOXES[row.outcome_status] || null : null,
        review_status: row.review_status,
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        employee_title: row.employee_title,
        manager_name: row.manager_name,
        canOpen: !!scope
      });
    }
    const period = periodById(session.period_id);
    res.json({ session, period: pick(period, ['id', 'name', 'status']), participants, cases, canManage: hr });
  });

  router.post('/talent-review/sessions/:id/cases', (req, res) => {
    const actor = current(req), session = sessionById(asId(req.params.id)), review = reviewById(asId(req.body.reviewId));
    if (!isHr(actor)) return res.status(403).json({ error: 'Fälle ordnet nur HR den Sitzungen zu.' });
    if (!session) return res.status(400).json({ error: 'Zuordnen lassen sich nur eingereichte Einschätzungen aus derselben Periode.' });
    const problem = caseProblem(actor, session, review);
    if (problem) return res.status(problem.status).json({ error: problem.error });
    const id = addCase(actor, session, review, boundedInt(req.body.displayOrder, 0, 100000, 0), text(req.body.moderatorNote, 2000));
    res.status(201).json({ id });
  });

  /** Wer in dieser Sitzung noch fehlt. Bereits Kalibriertes zählt nicht dazu: Das würde ein Ergebnis wieder öffnen. */
  router.get('/talent-review/sessions/:id/case-candidates', (req, res) => {
    const actor = current(req), session = sessionById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Fälle ordnet nur HR den Sitzungen zu.' });
    if (!session) return res.status(404).json({ error: 'Sitzung nicht gefunden.' });
    const reviews = db.prepare(REVIEW_LIST_SQL).all().filter(review => review.period_id === session.period_id);
    const inOpenSession = new Set(db.prepare("SELECT c.review_id FROM talent_review_session_cases c JOIN talent_review_sessions s ON s.id=c.session_id WHERE s.period_id=? AND s.status IN ('planned','active')").all(session.period_id).map(row => row.review_id));
    const summary = review => ({ id: review.id, employee_name: review.employee_name, status: review.status });
    const waiting = reviews
      .filter(review => review.status === 'manager_submitted' || (review.status === 'in_calibration' && !inOpenSession.has(review.id)))
      .map(review => ({ review, problem: caseProblem(actor, session, review) }));
    res.json({
      candidates: waiting.filter(entry => !entry.problem).map(entry => summary(entry.review)),
      outside: waiting.filter(entry => entry.problem).map(entry => summary(entry.review)),
      notSubmitted: reviews.filter(managerStillWrites).map(summary)
    });
  });

  router.post('/talent-review/sessions/:id/cases/bulk', (req, res) => {
    const actor = current(req), session = sessionById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Fälle ordnet nur HR den Sitzungen zu.' });
    if (!session) return res.status(404).json({ error: 'Sitzung nicht gefunden.' });
    if (!['planned', 'active'].includes(session.status)) return res.status(409).json({ error: 'Diese Sitzung ist beendet. Lege für die Fälle eine neue an.' });
    if (!Array.isArray(req.body.reviewIds) || !req.body.reviewIds.length) return res.status(400).json({ error: 'Wähle mindestens eine Einschätzung aus.' });
    let displayOrder = db.prepare('SELECT MAX(display_order) highest FROM talent_review_session_cases WHERE session_id=?').get(session.id).highest ?? 0;
    const { done, failed } = forEachRequested(req.body.reviewIds, review => {
      const problem = caseProblem(actor, session, review);
      if (problem) return problem;
      displayOrder += 1;
      addCase(actor, session, review, displayOrder, '');
      return null;
    });
    res.json({ added: done, failed });
  });

  router.post('/talent-review/reviews/:id/calibrate', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id), sessionId = asId(req.body.sessionId), session = sessionId && sessionById(sessionId);
    const performance = boundedInt(req.body.performance, 1, 3, null), potential = boundedInt(req.body.potential, 1, 3, null), calibrationReason = reason(req.body.reason), expectedVersion = boundedInt(req.body.version, 1, 100000000, null);
    if (!review || !period || !session) return res.status(404).json({ error: 'Einschätzung oder Sitzung nicht gefunden.' });
    if (actor.id === review.employee_id) return res.status(403).json({ error: 'Den eigenen Fall kalibriert immer jemand anderes.' });
    if (period.status !== 'calibration' || session.status !== 'active' || !sessionParticipant(actor, session.id)) return res.status(403).json({ error: 'Kalibrieren können nur die Teilnehmenden einer laufenden Sitzung, solange die Periode in der Kalibrierung ist.' });
    if (!db.prepare('SELECT 1 FROM talent_review_session_cases WHERE session_id=? AND review_id=?').get(session.id, review.id)) return res.status(403).json({ error: 'Dieser Fall gehört nicht zu dieser Sitzung.' });
    if (review.status !== 'in_calibration') return res.status(409).json({ error: 'Dieser Fall steht nicht mehr in Kalibrierung. Soll er noch einmal besprochen werden, ordnet HR ihn einer weiteren Sitzung zu.' });
    if (!performance || !potential || !expectedVersion) return res.status(400).json({ error: 'Wähle Leistung und Potenzial aus.' });
    if (expectedVersion !== review.version) return res.status(409).json({ error: 'Diese Einschätzung wurde inzwischen geändert. Bitte lade die Seite neu.' });
    const changed = performance !== review.original_performance || potential !== review.original_potential;
    if (changed && calibrationReason.length < MIN_LENGTHS.reason) return res.status(400).json({ error: `Weichst du vom Vorschlag der Führungskraft ab, begründe das mit mindestens ${MIN_LENGTHS.reason} Zeichen.` });
    db.transaction(() => {
      db.prepare("UPDATE talent_reviews SET calibrated_performance=?,calibrated_potential=?,calibration_reason=?,status='calibrated',calibrated_at=?,calibrated_by=?,version=version+1,updated_by=?,updated_at=? WHERE id=?").run(performance, potential, calibrationReason || null, now(), actor.id, actor.id, now(), review.id);
      db.prepare("UPDATE talent_review_session_cases SET case_status='discussed',outcome_status=?,updated_by=?,updated_at=? WHERE session_id=? AND review_id=?").run(boxFor(performance, potential), actor.id, now(), session.id, review.id);
      history(actor, 'talent_review', review.id, 'calibrated', { performance: review.calibrated_performance, potential: review.calibrated_potential, status: review.status, version: review.version }, { performance, potential, boxKey: boxFor(performance, potential), status: 'calibrated' }, calibrationReason || null);
    })();
    res.json({ ok: true, boxKey: boxFor(performance, potential), boxLabel: boxLabel(performance, potential), version: review.version + 1 });
  });

  router.post('/talent-review/reviews/:id/finalize', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.params.id)), period = review && periodById(review.period_id);
    if (!isHr(actor)) return res.status(403).json({ error: 'Final abschließen kann nur HR.' });
    if (!review || !period) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    const problem = finalizeProblem(actor, review, period);
    if (problem) return res.status(problem.status).json({ error: problem.error });
    finalizeReview(actor, review, period);
    res.json({ ok: true });
  });

  router.post('/talent-review/periods/:id/finalize-all', (req, res) => {
    const actor = current(req), period = periodById(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Final abschließen kann nur HR.' });
    if (!period) return res.status(404).json({ error: 'Periode nicht gefunden.' });
    if (!Array.isArray(req.body.reviewIds) || !req.body.reviewIds.length) return res.status(400).json({ error: 'Wähle mindestens eine Einschätzung aus.' });
    const { done, failed } = forEachRequested(req.body.reviewIds, review => {
      if (review.period_id !== period.id) return { error: 'Diese Einschätzung gehört zu einer anderen Periode.' };
      const problem = finalizeProblem(actor, review, period);
      if (problem) return problem;
      finalizeReview(actor, review, period);
      return null;
    });
    res.json({ finalized: done, failed });
  });

  router.get('/talent-review/matrix', (req, res) => {
    const actor = current(req), periodId = asId(req.query.periodId), sessionId = asId(req.query.sessionId), poolId = asId(req.query.poolId);
    if (!isLeader(actor) && !isHr(actor)) return res.status(403).json({ error: 'Die 9-Box sehen nur Führungskräfte und HR.' });
    if (sessionId && !sessionAccess(actor, sessionId)) return res.status(403).json({ error: 'Diese Kalibrierungssitzung darfst du nicht öffnen.' });
    let reviews = visibleReviews(actor, { periodId, status: req.query.status, managerId: req.query.managerId, employeeId: req.query.employeeId, positionId: req.query.positionId, organizationManagerId: req.query.organizationManagerId })
      .filter(({ review }) => review.employee_id !== actor.id);
    if (sessionId) {
      const allowed = new Set(db.prepare('SELECT review_id FROM talent_review_session_cases WHERE session_id=?').all(sessionId).map(item => item.review_id));
      reviews = reviews.filter(({ review }) => allowed.has(review.id));
    }
    if (poolId) {
      const allowed = new Set(db.prepare("SELECT employee_id FROM talent_pool_memberships WHERE pool_id=? AND status IN ('proposed','active','paused')").all(poolId).map(item => item.employee_id));
      reviews = reviews.filter(({ review }) => allowed.has(review.employee_id));
    }
    const boxFilter = req.query.box;
    const mapped = reviews
      .map(({ review, scope }) => reviewListItem(actor, review, scope))
      .filter(item => item.boxKey && (!boxFilter || item.boxKey === boxFilter));
    const boxes = Object.keys(BOXES).reduce((result, key) => {
      result[key] = { key, label: BOXES[key], potential: Number(key[0]), performance: Number(key[2]), reviews: mapped.filter(item => item.boxKey === key) };
      return result;
    }, {});
    res.json({ boxes, total: mapped.length });
  });

  router.get('/talent-pools', (req, res) => {
    const actor = current(req);
    const pools = db.prepare("SELECT p.*,u.name responsible_name,(SELECT COUNT(*) FROM talent_pool_memberships m WHERE m.pool_id=p.id AND m.status IN ('proposed','active','paused')) member_count FROM talent_pools p LEFT JOIN users u ON u.id=p.responsible_id ORDER BY p.active DESC,p.name").all();
    if (isHr(actor)) return res.json({ items: pools, canManage: true, canPropose: true });
    if (!isLeader(actor)) return res.json({ items: [], canManage: false, canPropose: false });
    // Führungskräfte sehen aktive Pools, auch ohne Mitglied aus ihrem Team, sonst könnten sie niemanden vorschlagen.
    const context = accessContext(actor);
    const memberships = db.prepare("SELECT pool_id,employee_id FROM talent_pool_memberships WHERE status IN ('proposed','active','paused')").all();
    const items = pools
      .map(pool => ({ ...pool, member_count: memberships.filter(item => item.pool_id === pool.id && isAboveInLine(context.people, actor.id, item.employee_id)).length }))
      .filter(pool => pool.active === 1 || pool.member_count > 0);
    res.json({ items, canManage: false, canPropose: true });
  });

  router.post('/talent-pools', (req, res) => {
    const actor = current(req), name = text(req.body.name, 180), description = text(req.body.description), purpose = text(req.body.purpose), responsibleId = asId(req.body.responsibleId) || actor.id;
    if (!isHr(actor)) return res.status(403).json({ error: 'Talentpools verwaltet nur HR.' });
    if (!name || !userById(responsibleId)) return res.status(400).json({ error: 'Nötig sind ein Name und eine verantwortliche Person.' });
    try {
      const id = db.prepare('INSERT INTO talent_pools(name,description,purpose,responsible_id,created_by,updated_by) VALUES(?,?,?,?,?,?)').run(name, description, purpose, responsibleId, actor.id, actor.id).lastInsertRowid;
      history(actor, 'talent_pool', id, 'created', null, { name, description, purpose, responsibleId });
      res.status(201).json({ id });
    } catch {
      res.status(409).json({ error: 'Einen Talentpool mit diesem Namen gibt es schon.' });
    }
  });

  router.patch('/talent-pools/:id', (req, res) => {
    const actor = current(req), poolId = asId(req.params.id), pool = db.prepare('SELECT * FROM talent_pools WHERE id=?').get(poolId);
    if (!isHr(actor)) return res.status(403).json({ error: 'Talentpools verwaltet nur HR.' });
    if (!pool) return res.status(404).json({ error: 'Talentpool nicht gefunden.' });
    const name = req.body.name === undefined ? pool.name : text(req.body.name, 180);
    const description = req.body.description === undefined ? pool.description : text(req.body.description);
    const purpose = req.body.purpose === undefined ? pool.purpose : text(req.body.purpose);
    const active = req.body.active === undefined ? pool.active : (req.body.active === true || req.body.active === 'true' || req.body.active === 'on' ? 1 : 0);
    const responsibleId = asId(req.body.responsibleId) || pool.responsible_id;
    if (!name || !userById(responsibleId)) return res.status(400).json({ error: 'Nötig sind ein Name und eine verantwortliche Person.' });
    try {
      db.prepare('UPDATE talent_pools SET name=?,description=?,purpose=?,active=?,responsible_id=?,updated_by=?,updated_at=? WHERE id=?').run(name, description, purpose, active, responsibleId, actor.id, now(), pool.id);
      history(actor, 'talent_pool', pool.id, 'updated', pool, { name, description, purpose, active, responsibleId });
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Einen Talentpool mit diesem Namen gibt es schon.' });
    }
  });

  router.get('/talent-pools/memberships/:id', (req, res) => {
    const actor = current(req), membership = db.prepare('SELECT id,pool_id,status FROM talent_pool_memberships WHERE id=?').get(asId(req.params.id));
    if (!isHr(actor)) return res.status(403).json({ error: 'Über Mitgliedschaften entscheidet nur HR.' });
    if (!membership) return res.status(404).json({ error: 'Mitgliedschaft nicht gefunden.' });
    res.json({ id: membership.id, poolId: membership.pool_id, status: membership.status });
  });

  router.get('/talent-pools/:id/members', (req, res) => {
    const actor = current(req), poolId = asId(req.params.id), pool = db.prepare('SELECT * FROM talent_pools WHERE id=?').get(poolId);
    if (!pool) return res.status(404).json({ error: 'Talentpool nicht gefunden.' });
    const hr = isHr(actor);
    if (!hr && !isLeader(actor)) return res.status(403).json({ error: 'Diesen Talentpool darfst du nicht öffnen.' });
    const context = accessContext(actor);
    const members = db.prepare('SELECT m.*,u.name employee_name,u.title employee_title,p.name period_name,proposer.name proposed_by_name,admitter.name admitted_by_name FROM talent_pool_memberships m JOIN users u ON u.id=m.employee_id LEFT JOIN talent_review_periods p ON p.id=m.period_id LEFT JOIN users proposer ON proposer.id=m.proposed_by LEFT JOIN users admitter ON admitter.id=m.admitted_by WHERE m.pool_id=? ORDER BY m.updated_at DESC').all(poolId)
      .filter(member => (hr ? hrReaches(actor, context.people.get(member.employee_id)) : isAboveInLine(context.people, actor.id, member.employee_id)));
    if (!hr && pool.active !== 1 && !members.length) return res.status(403).json({ error: 'Dieser Talentpool ist nicht mehr aktiv.' });
    res.json({ pool, items: members, canPropose: pool.active === 1, canDecide: hr });
  });

  router.post('/talent-pools/:id/members', (req, res) => {
    const actor = current(req), poolId = asId(req.params.id), pool = db.prepare('SELECT * FROM talent_pools WHERE id=? AND active=1').get(poolId), employeeId = asId(req.body.employeeId), periodId = asId(req.body.periodId), employee = userById(employeeId), membershipReason = reason(req.body.reason);
    if (employeeId === actor.id) return res.status(403).json({ error: 'Dich selbst kannst du nicht vorschlagen. Das macht deine Führungskraft.' });
    if (!pool || !employee || employee.active !== 1 || employee.is_system_account) return res.status(400).json({ error: 'Nötig sind ein aktiver Talentpool und eine aktive Person.' });
    if (!hrReaches(actor, employee) && !isDirectManager(actor, employeeId)) return res.status(403).json({ error: 'Führungskräfte schlagen nur Personen aus dem direkten Team vor.' });
    if (membershipReason.length < 10) return res.status(400).json({ error: 'Bitte begründe den Vorschlag mit mindestens 10 Zeichen.' });
    if (periodId && !periodById(periodId)) return res.status(400).json({ error: 'Diese Periode gibt es nicht.' });
    if (db.prepare("SELECT 1 FROM talent_pool_memberships WHERE pool_id=? AND employee_id=? AND status IN ('proposed','active','paused')").get(poolId, employeeId)) return res.status(409).json({ error: 'Diese Person ist in diesem Talentpool schon vorgeschlagen oder aufgenommen.' });
    const status = isHr(actor) && req.body.status === 'active' ? 'active' : 'proposed';
    try {
      const id = db.transaction(() => {
        const membershipId = db.prepare('INSERT INTO talent_pool_memberships(pool_id,employee_id,period_id,proposed_by,admitted_by,admitted_at,status,reason,development_plan) VALUES(?,?,?,?,?,?,?,?,?)').run(poolId, employeeId, periodId, actor.id, status === 'active' ? actor.id : null, status === 'active' ? now() : null, status, membershipReason, text(req.body.developmentPlan)).lastInsertRowid;
        history(actor, 'talent_pool_membership', membershipId, 'created', null, { poolId, employeeId, periodId, status }, membershipReason);
        if (status === 'proposed') createProposalTasks(pool, membershipId);
        return membershipId;
      })();
      res.status(201).json({ id, status });
    } catch {
      res.status(409).json({ error: 'Diese Person ist in diesem Talentpool schon vorgeschlagen oder aufgenommen.' });
    }
  });

  router.patch('/talent-pools/memberships/:id', (req, res) => {
    const actor = current(req), membershipId = asId(req.params.id), membership = db.prepare('SELECT * FROM talent_pool_memberships WHERE id=?').get(membershipId), next = req.body.status, changeReason = reason(req.body.reason);
    if (!isHr(actor)) return res.status(403).json({ error: 'Über Mitgliedschaften entscheidet nur HR.' });
    if (!membership) return res.status(404).json({ error: 'Mitgliedschaft nicht gefunden.' });
    if (!hrReaches(actor, membership.employee_id)) return res.status(403).json({ error: 'Über diese Mitgliedschaft entscheidet eine andere HR-Person.' });
    if (!MEMBERSHIP_STATUSES.has(next)) return res.status(400).json({ error: 'Diesen Stand gibt es nicht.' });
    if (next === 'removed' && changeReason.length < 10) return res.status(400).json({ error: 'Bitte begründe das Entfernen mit mindestens 10 Zeichen.' });
    try {
      db.transaction(() => {
        db.prepare('UPDATE talent_pool_memberships SET status=?,admitted_by=?,admitted_at=?,removed_at=?,removed_reason=?,development_plan=?,updated_at=? WHERE id=?').run(next, next === 'active' ? actor.id : membership.admitted_by, next === 'active' ? now() : membership.admitted_at, next === 'removed' ? now() : membership.removed_at, next === 'removed' ? changeReason : membership.removed_reason, req.body.developmentPlan === undefined ? membership.development_plan : text(req.body.developmentPlan), now(), membership.id);
        if (next !== 'proposed') closeTasks(['talent_pool_proposal'], membership.id);
        history(actor, 'talent_pool_membership', membership.id, 'status_changed', { status: membership.status }, { status: next }, changeReason || null);
      })();
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Diese Person ist in diesem Talentpool schon aufgenommen.' });
    }
  });

  router.get('/development-decisions', (req, res) => {
    const actor = current(req), periodId = asId(req.query.periodId), employeeId = asId(req.query.employeeId);
    const context = accessContext(actor);
    let items = db.prepare('SELECT d.*,u.name employee_name,u.title employee_title,r.status review_status,u.manager_id employee_manager_id,responsible.name responsible_name,c.name competency_name,g.title goal_title FROM development_decisions d JOIN users u ON u.id=d.employee_id JOIN talent_reviews r ON r.id=d.review_id LEFT JOIN users responsible ON responsible.id=d.responsible_id LEFT JOIN competencies c ON c.id=d.competency_id LEFT JOIN goals g ON g.id=d.linked_goal_id ORDER BY d.updated_at DESC').all();
    if (periodId) items = items.filter(item => item.period_id === periodId);
    if (employeeId) items = items.filter(item => item.employee_id === employeeId);
    const handles = item => hrReaches(actor, context.people.get(item.employee_id)) || item.employee_manager_id === actor.id;
    items = items.filter(item => handles(item) || actor.id === item.employee_id || actor.id === item.responsible_id || isAboveInLine(context.people, actor.id, item.employee_id));
    res.json({
      items: items.map(item => ({ ...withDecisionLabel(item), canEdit: handles(item) || actor.id === item.responsible_id })),
      canCreate: isHr(actor) || leadsPeople(actor.id)
    });
  });

  router.post('/development-decisions', (req, res) => {
    const actor = current(req), review = reviewById(asId(req.body.reviewId)), decisionType = req.body.decisionType, description = text(req.body.description), responsibleId = asId(req.body.responsibleId), startDate = text(req.body.startDate, 10) || null, targetDate = text(req.body.targetDate, 10) || null, competencyId = asId(req.body.competencyId), createGoal = req.body.createGoal === true || req.body.createGoal === 'true' || req.body.createGoal === 'on';
    if (!review) return res.status(404).json({ error: 'Einschätzung nicht gefunden.' });
    if (!hrReaches(actor, review.employee_id) && !isDirectManager(actor, review.employee_id)) return res.status(403).json({ error: 'Für diese Einschätzung darfst du keine Maßnahme anlegen.' });
    const responsible = responsibleId ? userById(responsibleId) : null;
    if (!DECISION_TYPES.has(decisionType) || description.length < 10 || !validDate(startDate) || !validDate(targetDate) || (startDate && targetDate && targetDate < startDate) || (responsibleId && (!responsible || responsible.active !== 1)) || (competencyId && !db.prepare('SELECT id FROM competencies WHERE id=? AND active=1').get(competencyId))) return res.status(400).json({ error: 'Bitte prüfe Maßnahme, Beschreibung (mindestens 10 Zeichen) und Termine.' });
    const result = db.transaction(() => {
      const linkedGoalId = createGoal ? createDevelopmentGoal(actor, review, { createGoal, goalTitle: req.body.goalTitle, targetDate, description, competencyId }) : null;
      const decisionId = db.prepare('INSERT INTO development_decisions(review_id,period_id,employee_id,decision_type,description,responsible_id,start_date,target_date,status,linked_goal_id,competency_id,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(review.id, review.period_id, review.employee_id, decisionType, description, responsibleId, startDate, targetDate, 'planned', linkedGoalId, competencyId, actor.id, actor.id).lastInsertRowid;
      history(actor, 'development_decision', decisionId, 'created', null, { reviewId: review.id, decisionType, linkedGoalId, competencyId });
      if (responsibleId) createDecisionTask(decisionId, responsibleId);
      return { id: decisionId, linkedGoalId };
    })();
    res.status(201).json(result);
  });

  router.patch('/development-decisions/:id', (req, res) => {
    const actor = current(req), decisionId = asId(req.params.id), decision = db.prepare('SELECT * FROM development_decisions WHERE id=?').get(decisionId), next = req.body.status;
    if (!decision) return res.status(404).json({ error: 'Maßnahme nicht gefunden.' });
    if (!hrReaches(actor, decision.employee_id) && !isDirectManager(actor, decision.employee_id) && actor.id !== decision.responsible_id) return res.status(403).json({ error: 'Diese Maßnahme darfst du nicht ändern.' });
    if (next && !DECISION_STATUSES.has(next)) return res.status(400).json({ error: 'Diesen Stand gibt es nicht.' });
    const description = req.body.description === undefined ? decision.description : text(req.body.description);
    if (description.length < 10) return res.status(400).json({ error: 'Bitte beschreibe die Maßnahme mit mindestens 10 Zeichen.' });
    db.transaction(() => {
      db.prepare('UPDATE development_decisions SET description=?,status=?,updated_by=?,updated_at=? WHERE id=?').run(description, next || decision.status, actor.id, now(), decision.id);
      history(actor, 'development_decision', decision.id, 'updated', { description: decision.description, status: decision.status }, { description, status: next || decision.status }, text(req.body.reason, 1000) || null);
      if (decision.responsible_id && !hasOpenTask(['development_decision'], decision.id)) createDecisionTask(decision.id, decision.responsible_id);
      refreshOpenTasks();
    })();
    res.json({ ok: true });
  });

  router.get('/talent-review/dashboard/hr', (req, res) => {
    const actor = current(req), periodId = asId(req.query.periodId);
    if (!isHr(actor)) return res.status(403).json({ error: 'Diese Übersicht ist für HR.' });
    const period = periodId ? periodById(periodId) : db.prepare("SELECT * FROM talent_review_periods WHERE status IN ('open','calibration') ORDER BY assessment_date DESC LIMIT 1").get();
    if (!period) return res.json({ period: null, metrics: {}, boxes: {}, sessions: 0, pools: 0, decisions: 0, missingPeople: 0 });
    const reviews = db.prepare('SELECT * FROM talent_reviews WHERE period_id=?').all(period.id);
    const results = reviews.map(effectiveResult);
    const boxes = Object.keys(BOXES).reduce((result, key) => {
      result[key] = results.filter(item => item.boxKey === key).length;
      return result;
    }, {});
    const countStatus = status => reviews.filter(item => item.status === status).length;
    res.json({
      period,
      metrics: {
        included: reviews.length,
        notStarted: countStatus('not_started'),
        drafts: countStatus('manager_draft'),
        submitted: countStatus('manager_submitted'),
        inCalibration: countStatus('in_calibration'),
        calibrated: countStatus('calibrated'),
        finalized: countStatus('finalized'),
        selfSubmitted: reviews.filter(item => item.self_status === 'employee_submitted').length
      },
      boxes,
      sessions: db.prepare("SELECT COUNT(*) count FROM talent_review_sessions WHERE period_id=? AND status IN ('planned','active')").get(period.id).count,
      pools: db.prepare('SELECT COUNT(*) count FROM talent_pools WHERE active=1').get().count,
      decisions: db.prepare("SELECT COUNT(*) count FROM development_decisions WHERE period_id=? AND status IN ('planned','in_progress')").get(period.id).count,
      missingPeople: period.status === 'open' ? missingPeople(period.id).missing.length : 0
    });
  });

  router.get('/talent-review/dashboard/manager', (req, res) => {
    const actor = current(req), periodId = asId(req.query.periodId);
    if (!isLeader(actor) && !isHr(actor)) return res.status(403).json({ error: 'Diese Übersicht ist für Führungskräfte.' });
    const reviews = db.prepare(REVIEW_LIST_SQL).all().filter(review => review.employee_manager_id === actor.id && review.employee_id !== actor.id && (!periodId || review.period_id === periodId));
    const decisions = db.prepare("SELECT COUNT(*) count FROM development_decisions d JOIN users u ON u.id=d.employee_id WHERE u.manager_id=? AND d.status IN ('planned','in_progress')").get(actor.id).count;
    const proposals = db.prepare("SELECT COUNT(*) count FROM talent_pool_memberships m JOIN users u ON u.id=m.employee_id WHERE u.manager_id=? AND m.status='proposed'").get(actor.id).count;
    const countStatus = status => reviews.filter(item => item.status === status).length;
    res.json({
      items: reviews.map(review => reviewListItem(actor, review, 'full')),
      metrics: {
        notStarted: countStatus('not_started'),
        drafts: countStatus('manager_draft'),
        returned: reviews.filter(item => item.returned_at && item.status === 'manager_draft').length,
        submitted: countStatus('manager_submitted'),
        decisions,
        poolProposals: proposals
      }
    });
  });

  router.get('/talent-review/me', (req, res) => {
    const actor = current(req);
    const reviews = db.prepare("SELECT r.*,p.name period_name FROM talent_reviews r JOIN talent_review_periods p ON p.id=r.period_id WHERE r.employee_id=? AND r.status='finalized' AND r.employee_visible=1 ORDER BY p.assessment_date DESC").all(actor.id);
    const decisions = db.prepare('SELECT * FROM development_decisions WHERE employee_id=? ORDER BY updated_at DESC').all(actor.id);
    res.json({ reviews: reviews.map(review => ({ id: review.id, periodName: review.period_name, ...effectiveResult(review) })), decisions: decisions.map(withDecisionLabel) });
  });

  return { initialize, seed, router, boxFor, boxLabel, reviewSupport };
}

module.exports = { createTalentReviewModule, BOXES };
