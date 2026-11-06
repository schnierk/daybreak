'use strict';

/**
 * Nachfolgeplanung: Schlüsselpositionen, Kandidaten mit Bereitschaft und Risikoeinschätzung.
 *
 * Grundsätze dieses Moduls:
 * - Das System zeigt an und zählt, es entscheidet nichts: keine Rangfolge, keine Punktzahl,
 *   keine automatische Empfehlung. Kandidaten stehen deshalb immer alphabetisch.
 * - Betroffene erfahren nichts: Es gibt keine Mitteilung an Kandidaten, und Protokoll und
 *   Aufgaben enthalten weder Namen von Kandidaten noch Einstufungen.
 * - Wer selbst Stelleninhaber oder Kandidat ist, sieht den Plan nicht und kann ihn nicht ändern.
 *   Das gilt auch für HR-Rollen, und ein gesperrter Plan verrät nicht einmal, dass es ihn gibt.
 * - Zu Personen, die jemand sonst nicht sehen darf, gibt es nur Name und Bereitschaft.
 */

const express = require('express');
const { BOXES } = require('./talentReview');

const LEVEL_LABELS = Object.freeze({ high: 'Hoch', medium: 'Mittel', low: 'Niedrig' });
const LEVELS = Object.freeze(Object.keys(LEVEL_LABELS));

const READINESS_LABELS = Object.freeze({
  ready_now: 'Sofort bereit',
  ready_1_2_years: 'In 1 bis 2 Jahren bereit',
  ready_3_plus_years: 'In 3 oder mehr Jahren bereit'
});

const CANDIDATE_STATUS_LABELS = Object.freeze({ proposed: 'Vorgeschlagen', confirmed: 'Bestätigt', removed: 'Entfernt' });
const PLAN_NOT_FOUND = 'Diesen Plan gibt es nicht.';
const PLAN_STATUS_LABELS = Object.freeze({ active: 'Aktiv', archived: 'Archiviert' });

const REQUIREMENT_STATUS_LABELS = Object.freeze({
  fulfilled: 'Erfüllt',
  partial: 'Eine Stufe fehlt',
  development_needed: 'Zwei Stufen fehlen',
  high_development_needed: 'Drei oder mehr Stufen fehlen',
  not_rated: 'Nicht bewertet'
});

/** Diese Spalten müssen vorhanden sein, damit die 9-Box lesend angezeigt werden kann. */
const NINE_BOX_COLUMNS = Object.freeze({
  talent_reviews: ['id', 'period_id', 'employee_id', 'status', 'calibrated_performance', 'calibrated_potential', 'finalized_at'],
  talent_review_periods: ['id', 'name', 'assessment_date']
});

const ALLOWED_ROLES = Object.freeze(['hr_admin', 'hrbp', 'director', 'super_admin']);

const HELP_ARTICLES = Object.freeze([
  {
    id: 'succession-plans',
    title: 'Nachfolgepläne pflegen',
    roles: ['hr_admin', 'hrbp', 'super_admin'],
    views: ['successionHome', 'successionPlan'],
    keywords: ['nachfolge', 'nachfolgeplan', 'schlüsselposition', 'kandidat', 'bereitschaft', 'bankstärke', 'mögliche nachfolger'],
    answer: 'Ein Nachfolgeplan gehört zu einer wichtigen Stelle. Du hältst fest, wie wichtig die Stelle ist und wie groß das Risiko eines Ausfalls ist, und nimmst mögliche Nachfolger:innen mit ihrer Bereitschaft auf. Das System zählt und zeigt an, eine Rangfolge oder Empfehlung gibt es nicht. Wer im Plan steht, wird nicht benachrichtigt. Einen Plan, in dem du selbst stehst, siehst du nicht. Den pflegt eine andere HR-Person.',
    steps: [
      'Lege unter „Nachfolgeplanung“ einen Plan für die Stelle an.',
      'Nimm mögliche Nachfolger:innen auf und halte Stärken, Lücken und Maßnahmen fest.',
      'Bestätige einmal im Jahr, dass du den Plan überprüft hast.'
    ],
    actions: [{ label: 'Nachfolgeplanung öffnen', view: 'successionHome' }]
  },
  {
    id: 'succession-director',
    title: 'Nachfolge in meiner Führungslinie',
    roles: ['director'],
    views: ['successionHome', 'successionPlan'],
    keywords: ['nachfolge', 'nachfolgeplan', 'kandidat vorschlagen', 'schlüsselposition', 'mögliche nachfolger'],
    answer: 'Du siehst die Nachfolgepläne für Stellen in deiner Führungslinie und kannst mögliche Nachfolger:innen vorschlagen. HR prüft den Vorschlag. Zu Personen außerhalb deiner Linie siehst du nur Name und Bereitschaft. Das Thema ist vertraulich, wer im Plan steht, wird nicht benachrichtigt.',
    steps: [
      'Öffne „Nachfolgeplanung“ und wähle einen Plan.',
      'Schlage eine Person aus deiner Führungslinie vor und gib ihre Bereitschaft an.'
    ],
    actions: [{ label: 'Nachfolgeplanung öffnen', view: 'successionHome' }]
  },
  {
    id: 'succession-metrics',
    title: 'Kennzahlen der Nachfolgeplanung lesen',
    roles: ['hr_admin', 'hrbp', 'director', 'super_admin'],
    views: ['successionMetrics'],
    keywords: ['bankstärke', 'risiko-matrix', 'risikomatrix', 'kennzahl nachfolge', 'bereiter kandidat', 'mögliche nachfolger'],
    answer: 'Die Kennzahlen zählen je Plan die bestätigten möglichen Nachfolger:innen je Bereitschaft. Eine Liste zeigt Pläne, für die gerade niemand sofort bereit ist. Eine Übersicht ordnet die Pläne danach, wie wichtig die Stelle und wie groß das Risiko eines Ausfalls ist. Die Zahlen helfen beim Gespräch, die Entscheidung treffen Menschen.',
    steps: [
      'Öffne in der Nachfolgeplanung den Reiter „Kennzahlen“.',
      'Sprich zuerst über Pläne, für die niemand sofort bereit ist.'
    ],
    actions: [{ label: 'Kennzahlen öffnen', view: 'successionMetrics' }]
  }
]);

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function httpProblem(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

function sendProblem(res, error) {
  if (!error.httpStatus) throw error;
  return res.status(error.httpStatus).json({ error: error.message });
}

const isKeyOf = (labels, value) => typeof value === 'string' && Object.hasOwn(labels, value);

function createSuccessionModule(deps) {
  const { db, auth, current, isHr, hrCanAccess, canViewEmployee, subordinateIds, cleanText, validDate, log, createTask, isModuleEnabled, skillGap } = deps;
  const clock = deps.clock || (() => new Date());
  const router = express.Router();

  const nowIso = () => clock().toISOString();
  const asId = value => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  };
  const optionalDate = value => (value === undefined || value === null || value === '' ? null : value);
  const talentAvailable = () => isModuleEnabled('talent') && typeof skillGap === 'function';

  /** SQLite-spezifisch: Spaltennamen einer Tabelle. Der Name kommt nur aus Konstanten dieser Datei. */
  function sqliteColumnsOf(tableName) {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name);
  }

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS succession_plans (
        id INTEGER PRIMARY KEY,
        position_profile_id INTEGER REFERENCES position_profiles(id),
        role_name TEXT,
        holder_id INTEGER REFERENCES users(id),
        criticality TEXT NOT NULL CHECK(criticality IN ('high','medium','low')),
        risk TEXT NOT NULL CHECK(risk IN ('high','medium','low')),
        risk_reason TEXT NOT NULL,
        planned_departure TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
        last_reviewed_at TEXT,
        last_reviewed_by INTEGER REFERENCES users(id),
        created_by INTEGER REFERENCES users(id),
        updated_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(position_profile_id IS NOT NULL OR role_name IS NOT NULL)
      );
      CREATE TABLE IF NOT EXISTS succession_candidates (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL REFERENCES succession_plans(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        readiness TEXT NOT NULL CHECK(readiness IN ('ready_now','ready_1_2_years','ready_3_plus_years')),
        strengths TEXT,
        gaps TEXT,
        development_actions TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('proposed','confirmed','removed')),
        proposed_by INTEGER REFERENCES users(id),
        updated_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(plan_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS succession_history (
        id INTEGER PRIMARY KEY,
        candidate_id INTEGER NOT NULL REFERENCES succession_candidates(id),
        plan_id INTEGER NOT NULL REFERENCES succession_plans(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        old_readiness TEXT,
        new_readiness TEXT NOT NULL,
        changed_by INTEGER REFERENCES users(id),
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS succession_review_tasks (
        plan_id INTEGER NOT NULL REFERENCES succession_plans(id),
        review_year INTEGER NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY(plan_id, review_year)
      );
      CREATE INDEX IF NOT EXISTS idx_succession_candidates_user ON succession_candidates(user_id);
      CREATE INDEX IF NOT EXISTS idx_succession_plans_holder ON succession_plans(holder_id);
      CREATE INDEX IF NOT EXISTS idx_succession_history_candidate ON succession_history(candidate_id);
    `);
  }

  // ---------------------------------------------------------------------------------------
  // Rechte
  // ---------------------------------------------------------------------------------------

  const PLAN_SELECT = `
    SELECT p.*, pos.title position_title, holder.name holder_name, holder.active holder_active,
           COALESCE(holder_position.title, holder.title) holder_title
    FROM succession_plans p
    LEFT JOIN position_profiles pos ON pos.id = p.position_profile_id
    LEFT JOIN users holder ON holder.id = p.holder_id
    LEFT JOIN position_profiles holder_position ON holder_position.id = holder.position_profile_id`;

  const CANDIDATE_SELECT = `
    SELECT c.*, u.name, u.active user_active, COALESCE(pos.title, u.title) title, proposer.name proposed_by_name
    FROM succession_candidates c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN position_profiles pos ON pos.id = u.position_profile_id
    LEFT JOIN users proposer ON proposer.id = c.proposed_by`;

  const planById = id => db.prepare(`${PLAN_SELECT} WHERE p.id=?`).get(id);
  const candidateById = id => db.prepare(`${CANDIDATE_SELECT} WHERE c.id=?`).get(id);
  const candidateRow = (planId, userId) => db.prepare('SELECT id, status FROM succession_candidates WHERE plan_id=? AND user_id=?').get(planId, userId);
  const activePerson = id => db.prepare('SELECT id, name FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id);

  /** Betroffen ist, wer Stelleninhaber ist oder je als Kandidat im Plan stand, auch wenn wieder entfernt. */
  function isAffected(personId, plan) {
    return plan.holder_id === personId || Boolean(candidateRow(plan.id, personId));
  }

  /** Niemand liest die eigene Einstufung, auch HR nicht. Deshalb steht die Betroffenheit vor der Rolle. */
  function canSeePlan(actor, plan) {
    if (isAffected(actor.id, plan)) return false;
    if (isHr(actor)) return true;
    if (actor.role !== 'director' || plan.status !== 'active' || !plan.holder_id) return false;
    return canViewEmployee(actor, plan.holder_id);
  }

  const canEditPlan = (actor, plan) => isHr(actor) && !isAffected(actor.id, plan);

  /**
   * Der Plan, wenn diese HR-Person ihn sehen darf. Sonst antwortet sie dasselbe wie bei einem unbekannten
   * Plan: Eine andere Antwort würde verraten, dass jemand für die eigene Stelle plant oder dass man Kandidat ist.
   */
  function planForHr(actor, id) {
    const plan = planById(id);
    if (!plan || !canSeePlan(actor, plan)) throw httpProblem(404, PLAN_NOT_FOUND);
    return plan;
  }

  /** Stärken, Lücken und Notizen gibt es nur zu Personen, die jemand auch sonst sehen darf. */
  const seesCandidateDetails = (actor, userId) => canViewEmployee(actor, userId);

  function assertPlanActive(plan) {
    if (plan.status !== 'active') throw httpProblem(409, 'Dieser Plan ist archiviert. Hole ihn zuerst zurück.');
  }

  function visiblePlans(actor) {
    const rows = db.prepare(PLAN_SELECT).all().filter(plan => canSeePlan(actor, plan));
    return rows.sort((left, right) => planTitle(left).localeCompare(planTitle(right), 'de'));
  }

  // ---------------------------------------------------------------------------------------
  // Unterstützung: nur anzeigen, nichts empfehlen
  // ---------------------------------------------------------------------------------------

  const planTitle = plan => plan.position_title || plan.role_name || '';

  /** Abdeckung der aktuellen Position als einfache Zählung, bewusst ohne Prozentwert und ohne Empfehlungstext. */
  function currentPositionCoverage(userId) {
    const empty = { rated: false, positionTitle: null, total: 0, fulfilled: 0, notRated: 0, items: [] };
    if (!talentAvailable()) return empty;
    const gap = skillGap(userId);
    const items = gap.requirements.map(requirement => ({
      competency: requirement.competency,
      requiredLevel: requirement.requiredLevel,
      availableLevel: requirement.availableLevel,
      status: requirement.status,
      statusLabel: REQUIREMENT_STATUS_LABELS[requirement.status]
    }));
    const notRated = items.filter(item => item.status === 'not_rated').length;
    return {
      rated: items.length > notRated,
      positionTitle: gap.position?.title || null,
      total: items.length,
      fulfilled: items.filter(item => item.status === 'fulfilled').length,
      notRated,
      items
    };
  }

  function requirementStatus(requiredLevel, availableLevel) {
    if (availableLevel === null) return 'not_rated';
    const missing = requiredLevel - availableLevel;
    if (missing <= 0) return 'fulfilled';
    if (missing === 1) return 'partial';
    return missing === 2 ? 'development_needed' : 'high_development_needed';
  }

  /** Vergleich mit dem Zielprofil des Plans. Die Einschätzung der Führungskraft geht vor der eigenen. */
  function targetProfileComparison(plan, userId) {
    const empty = { rated: false, total: 0, fulfilled: 0, notRated: 0, items: [] };
    if (!plan.position_profile_id || !talentAvailable()) return empty;

    const requirements = db.prepare(`
      SELECT r.competency_id, r.required_level, c.name competency
      FROM position_requirements r
      JOIN competencies c ON c.id = r.competency_id
      WHERE r.position_profile_id = ? AND r.active = 1
      ORDER BY c.name
    `).all(plan.position_profile_id);
    if (!requirements.length) return empty;

    const assessments = db.prepare(`
      SELECT competency_id, assessment_type, rating
      FROM competency_assessments
      WHERE user_id = ? AND active = 1
      ORDER BY updated_at DESC, id DESC
    `).all(userId);
    const availableLevel = competencyId => {
      const forCompetency = assessments.filter(item => item.competency_id === competencyId);
      const chosen = forCompetency.find(item => item.assessment_type === 'manager') || forCompetency.find(item => item.assessment_type === 'self');
      return chosen ? chosen.rating : null;
    };

    const items = requirements.map(requirement => {
      const level = availableLevel(requirement.competency_id);
      const status = requirementStatus(requirement.required_level, level);
      return {
        competency: requirement.competency,
        requiredLevel: requirement.required_level,
        availableLevel: level,
        status,
        statusLabel: REQUIREMENT_STATUS_LABELS[status]
      };
    });
    const notRated = items.filter(item => item.status === 'not_rated').length;
    return {
      rated: items.length > notRated,
      total: items.length,
      fulfilled: items.filter(item => item.status === 'fulfilled').length,
      notRated,
      items
    };
  }

  function nineBoxReadable() {
    if (!isModuleEnabled('talent_review')) return false;
    return Object.entries(NINE_BOX_COLUMNS).every(([tableName, columns]) => {
      const existing = sqliteColumnsOf(tableName);
      return columns.every(column => existing.includes(column));
    });
  }

  /** Letzte freigegebene Einordnung, nur lesend aus dem Talent Review. */
  function latestNineBox(userId) {
    const row = db.prepare(`
      SELECT r.calibrated_performance performance, r.calibrated_potential potential, r.finalized_at,
             p.name period_name, p.assessment_date
      FROM talent_reviews r
      JOIN talent_review_periods p ON p.id = r.period_id
      WHERE r.employee_id = ? AND r.status = 'finalized'
        AND r.calibrated_performance IS NOT NULL AND r.calibrated_potential IS NOT NULL
      ORDER BY p.assessment_date DESC, r.finalized_at DESC, r.id DESC
      LIMIT 1
    `).get(userId);
    if (!row) return null;
    return {
      period: row.period_name,
      assessmentDate: row.assessment_date,
      performance: row.performance,
      potential: row.potential,
      label: BOXES[`${row.potential}-${row.performance}`] || null
    };
  }

  // ---------------------------------------------------------------------------------------
  // Darstellen
  // ---------------------------------------------------------------------------------------

  function benchOf(planId) {
    const bench = { ready_now: 0, ready_1_2_years: 0, ready_3_plus_years: 0, proposed: 0 };
    const rows = db.prepare(`
      SELECT c.readiness, c.status
      FROM succession_candidates c
      JOIN users u ON u.id = c.user_id
      WHERE c.plan_id = ? AND c.status <> 'removed' AND u.active = 1 AND u.is_system_account = 0
    `).all(planId);
    for (const row of rows) {
      if (row.status === 'confirmed') bench[row.readiness] += 1;
      else bench.proposed += 1;
    }
    return bench;
  }

  function planView(plan, actor) {
    return {
      id: plan.id,
      title: planTitle(plan),
      positionProfileId: plan.position_profile_id,
      roleName: plan.role_name,
      holder: plan.holder_id
        ? { id: plan.holder_id, name: plan.holder_name, title: plan.holder_title, active: Boolean(plan.holder_active) }
        : null,
      criticality: plan.criticality,
      criticalityLabel: LEVEL_LABELS[plan.criticality],
      risk: plan.risk,
      riskLabel: LEVEL_LABELS[plan.risk],
      riskReason: plan.risk_reason,
      plannedDeparture: plan.planned_departure,
      status: plan.status,
      statusLabel: PLAN_STATUS_LABELS[plan.status],
      lastReviewedAt: plan.last_reviewed_at,
      bench: benchOf(plan.id),
      canEdit: canEditPlan(actor, plan),
      canPropose: actor.role === 'director' && plan.status === 'active'
    };
  }

  /** Zählt nur Pläne, die die anfragende Person ohnehin sehen darf, damit die Zahl nichts verrät. */
  function nominationCount(actor, userId) {
    const plans = db.prepare(`
      SELECT p.*
      FROM succession_candidates c
      JOIN succession_plans p ON p.id = c.plan_id
      WHERE c.user_id = ? AND c.status <> 'removed' AND p.status = 'active'
    `).all(userId);
    return plans.filter(plan => canSeePlan(actor, plan)).length;
  }

  function historyOf(candidateId) {
    const rows = db.prepare(`
      SELECT h.*, u.name changed_by_name
      FROM succession_history h
      LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.candidate_id = ?
      ORDER BY h.changed_at DESC, h.id DESC
    `).all(candidateId);
    return rows.map(row => ({
      oldReadiness: row.old_readiness,
      oldReadinessLabel: row.old_readiness ? READINESS_LABELS[row.old_readiness] : null,
      newReadiness: row.new_readiness,
      newReadinessLabel: READINESS_LABELS[row.new_readiness],
      changedBy: row.changed_by_name || 'System',
      changedAt: row.changed_at
    }));
  }

  function candidateView(candidate, plan, actor, showNineBox) {
    if (!seesCandidateDetails(actor, candidate.user_id)) {
      return {
        name: candidate.name,
        readiness: candidate.readiness,
        readinessLabel: READINESS_LABELS[candidate.readiness],
        status: candidate.status,
        statusLabel: CANDIDATE_STATUS_LABELS[candidate.status],
        limited: true,
        currentPosition: null,
        targetProfile: null
      };
    }
    const count = nominationCount(actor, candidate.user_id);
    const view = {
      id: candidate.id,
      userId: candidate.user_id,
      name: candidate.name,
      title: candidate.title,
      active: Boolean(candidate.user_active),
      readiness: candidate.readiness,
      readinessLabel: READINESS_LABELS[candidate.readiness],
      strengths: candidate.strengths,
      gaps: candidate.gaps,
      developmentActions: candidate.development_actions,
      note: candidate.note,
      status: candidate.status,
      statusLabel: CANDIDATE_STATUS_LABELS[candidate.status],
      proposedBy: candidate.proposed_by_name,
      nominationCount: count,
      nominationText: count > 1 ? `für ${count} Pläne vorgesehen` : null,
      history: historyOf(candidate.id),
      limited: false,
      currentPosition: currentPositionCoverage(candidate.user_id),
      targetProfile: targetProfileComparison(plan, candidate.user_id)
    };
    if (showNineBox) view.nineBox = latestNineBox(candidate.user_id);
    return view;
  }

  function planDetail(plan, actor) {
    const showNineBox = isHr(actor) && nineBoxReadable();
    // Dass jemand von der Liste genommen wurde, geht niemanden außerhalb der Führungslinie etwas an.
    const candidates = db.prepare(`${CANDIDATE_SELECT} WHERE c.plan_id=? ORDER BY u.name, c.id`).all(plan.id)
      .filter(candidate => candidate.status !== 'removed' || seesCandidateDetails(actor, candidate.user_id));
    return {
      plan: planView(plan, actor),
      nineBoxAvailable: showNineBox,
      candidates: candidates.map(candidate => candidateView(candidate, plan, actor, showNineBox))
    };
  }

  // ---------------------------------------------------------------------------------------
  // Eingaben
  // ---------------------------------------------------------------------------------------

  function assertHolderAllowed(holderId, actor, plan = null) {
    if (holderId === null) return;
    if (!activePerson(holderId)) throw httpProblem(400, 'Diese Person gibt es nicht oder ihr Konto ist gesperrt.');
    if (holderId === actor.id) throw httpProblem(403, 'Einen Plan für deine eigene Stelle muss jemand anderes pflegen.');
    if (plan) {
      const candidate = candidateRow(plan.id, holderId);
      if (candidate && candidate.status !== 'removed') {
        throw httpProblem(400, 'Diese Person steht in diesem Plan als mögliche Nachfolge. Entferne sie dort zuerst.');
      }
    }
  }

  function planFromBody(body, actor, base = null) {
    const readHolder = () => {
      if (body.holderId === undefined) return base?.holder_id ?? null;
      if (body.holderId === null || body.holderId === '') return null;
      const id = asId(body.holderId);
      if (!id) throw httpProblem(400, 'Diese Person gibt es nicht oder ihr Konto ist gesperrt.');
      return id;
    };
    const holderId = readHolder();
    if (!base || holderId !== base.holder_id) assertHolderAllowed(holderId, actor, base);

    let positionProfileId = base?.position_profile_id ?? null;
    let roleName = base?.role_name ?? null;
    if (body.positionProfileId !== undefined || body.roleName !== undefined) {
      const hasProfile = body.positionProfileId !== undefined && body.positionProfileId !== null && body.positionProfileId !== '';
      positionProfileId = null;
      roleName = null;
      if (hasProfile) {
        positionProfileId = asId(body.positionProfileId);
        // Ein bereits zugeordnetes Profil bleibt gültig, auch wenn es inzwischen nicht mehr aktiv ist.
        const unchanged = base && positionProfileId === base.position_profile_id;
        const profile = positionProfileId && db.prepare('SELECT id FROM position_profiles WHERE id=? AND active=1').get(positionProfileId);
        if (!unchanged && !profile) throw httpProblem(400, 'Diese Position gibt es nicht oder sie ist nicht aktiv.');
      } else {
        roleName = cleanText(body.roleName, 160) || null;
      }
    }
    if (!positionProfileId && !roleName) throw httpProblem(400, 'Bitte wähle eine Position oder benenne die Stelle.');

    const criticality = body.criticality !== undefined ? body.criticality : base?.criticality;
    if (!LEVELS.includes(criticality)) throw httpProblem(400, 'Bitte gib an, wie wichtig die Stelle ist: hoch, mittel oder niedrig.');
    const risk = body.risk !== undefined ? body.risk : base?.risk;
    if (!LEVELS.includes(risk)) throw httpProblem(400, 'Bitte gib das Risiko des Ausfalls an: hoch, mittel oder niedrig.');

    const riskReason = body.riskReason !== undefined ? cleanText(body.riskReason, 2000) : base?.risk_reason;
    if (!riskReason) throw httpProblem(400, 'Bitte begründe das Risiko des Ausfalls.');

    const plannedDeparture = body.plannedDeparture !== undefined ? optionalDate(body.plannedDeparture) : (base?.planned_departure ?? null);
    if (plannedDeparture !== null && !(validDate(plannedDeparture) && isCalendarDate(plannedDeparture))) {
      throw httpProblem(400, 'Der geplante Abgang muss ein gültiges Datum sein.');
    }
    // Ein vorhandener Plan darf sein altes Datum behalten, neu eintragen lässt sich nur Künftiges.
    if (plannedDeparture !== null && plannedDeparture !== (base?.planned_departure ?? null) && plannedDeparture < new Date().toISOString().slice(0, 10)) {
      throw httpProblem(400, 'Der geplante Abgang liegt in der Vergangenheit. Trage ein Datum ab heute ein.');
    }

    const status = body.status !== undefined ? body.status : (base?.status ?? 'active');
    if (!isKeyOf(PLAN_STATUS_LABELS, status)) throw httpProblem(400, 'Der Status muss aktiv oder archiviert sein.');

    return { positionProfileId, roleName, holderId, criticality, risk, riskReason, plannedDeparture, status };
  }

  function candidateTextFields(body, base = null) {
    const field = (key, column) => (body[key] !== undefined ? cleanText(body[key], 2000) || null : (base?.[column] ?? null));
    return {
      strengths: field('strengths', 'strengths'),
      gaps: field('gaps', 'gaps'),
      developmentActions: field('developmentActions', 'development_actions'),
      note: field('note', 'note')
    };
  }

  function recordReadiness(candidateId, plan, userId, oldReadiness, newReadiness, actorId) {
    db.prepare(`
      INSERT INTO succession_history(candidate_id, plan_id, user_id, old_readiness, new_readiness, changed_by, changed_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(candidateId, plan.id, userId, oldReadiness, newReadiness, actorId, nowIso());
  }

  // ---------------------------------------------------------------------------------------
  // Aufgaben
  // ---------------------------------------------------------------------------------------

  const reviewTaskTitle = plan => `Nachfolgeplan „${planTitle(plan)}“: jährliche Überprüfung`;
  const proposalTaskTitle = plan => `Nachfolgeplan „${planTitle(plan)}“: neuen Vorschlag prüfen`;

  /** Eine HR-Person, die den Plan bearbeiten darf: bevorzugt, wer ihn angelegt hat. */
  function responsibleHrPerson(plan) {
    const people = db.prepare(`
      SELECT id, role FROM users
      WHERE is_system_account = 0 AND active = 1 AND role IN ('hr_admin','hrbp')
      ORDER BY id
    `).all().filter(person => !isAffected(person.id, plan));
    return people.find(person => person.id === plan.created_by)
      || people.find(person => person.role === 'hr_admin')
      || people[0]
      || null;
  }

  function closeTasks(type, entityId) {
    db.prepare('UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND done=0').run(type, entityId);
  }

  /**
   * Wer betroffen ist oder gesperrt wurde, kann den Plan nicht mehr öffnen. Offene Aufgaben wandern deshalb
   * weiter. Findet sich niemand, sind sie hinfällig, sonst bliebe ein Knopf ohne Wirkung stehen.
   * Der Titel folgt dabei dem aktuellen Namen des Plans.
   */
  function refreshPlanTasks(plan) {
    const open = db.prepare("SELECT id, user_id, type, due_date FROM tasks WHERE type IN ('succession_review','succession_candidate_proposal') AND entity_id=? AND done=0").all(plan.id);
    if (!open.length) return;
    const stillResponsible = db.prepare("SELECT id FROM users WHERE id=? AND is_system_account=0 AND active=1 AND role IN ('hr_admin','hrbp')");
    for (const task of open) {
      const review = task.type === 'succession_review';
      const title = review ? reviewTaskTitle(plan) : proposalTaskTitle(plan);
      // Ältere Aufgaben tragen den Tag ihres Anlegens als Frist. Das ist keine Frist.
      const dueDate = review ? `${String(task.due_date || clock().toISOString()).slice(0, 4)}-12-31` : null;
      const next = stillResponsible.get(task.user_id) && !isAffected(task.user_id, plan) ? { id: task.user_id } : responsibleHrPerson(plan);
      if (next) db.prepare('UPDATE tasks SET user_id=?, title=?, due_date=? WHERE id=?').run(next.id, title, dueDate, task.id);
      else db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(task.id);
    }
  }

  /** Wird ein archivierter Plan zurückgeholt, fehlt die Überprüfung des laufenden Jahres sonst bis zum nächsten. */
  function restoreReviewTask(plan) {
    const reviewYear = clock().getUTCFullYear();
    if (String(plan.last_reviewed_at || '').startsWith(String(reviewYear))) return;
    const claimed = db.prepare('SELECT plan_id FROM succession_review_tasks WHERE plan_id=? AND review_year=?').get(plan.id, reviewYear);
    if (!claimed) return;
    const person = responsibleHrPerson(plan);
    if (person) createTask(person.id, reviewTaskTitle(plan), 'succession_review', plan.id, `${reviewYear}-12-31`);
  }

  /** Legt je aktivem Plan und Kalenderjahr genau eine Überprüfungsaufgabe an. */
  function maintenance() {
    const reviewYear = clock().getUTCFullYear();
    const plans = db.prepare(`
      SELECT p.*, pos.title position_title FROM succession_plans p
      LEFT JOIN position_profiles pos ON pos.id = p.position_profile_id
      LEFT JOIN succession_review_tasks t ON t.plan_id = p.id AND t.review_year = ?
      WHERE p.status = 'active' AND t.plan_id IS NULL
    `).all(reviewYear);
    for (const plan of plans) {
      // Ohne geeignete Person bleibt der Plan offen und wird beim nächsten Lauf erneut versucht.
      const person = responsibleHrPerson(plan);
      if (!person) continue;
      db.transaction(() => {
        const claimed = db.prepare(`
          INSERT INTO succession_review_tasks(plan_id, review_year, user_id, created_at) VALUES(?,?,?,?)
          ON CONFLICT(plan_id, review_year) DO NOTHING
        `).run(plan.id, reviewYear, person.id, nowIso());
        if (claimed.changes) createTask(person.id, reviewTaskTitle(plan), 'succession_review', plan.id, `${reviewYear}-12-31`);
      })();
    }
    const withOpenTasks = db.prepare("SELECT DISTINCT entity_id FROM tasks WHERE type IN ('succession_review','succession_candidate_proposal') AND done=0").all();
    for (const { entity_id: planId } of withOpenTasks) {
      const plan = planById(planId);
      if (plan) db.transaction(() => refreshPlanTasks(plan))();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Demo-Daten
  // ---------------------------------------------------------------------------------------

  function seedDemo() {
    const people = db.prepare('SELECT id, role, manager_id, position_profile_id FROM users WHERE is_system_account=0 AND active=1 ORDER BY id').all();
    if (people.length < 3) return;
    if (db.prepare('SELECT id FROM succession_plans LIMIT 1').get()) return;

    const leader = people.find(person => person.role === 'director') || people.find(person => person.role === 'manager');
    if (!leader) return;
    const reports = people.filter(person => person.manager_id === leader.id);
    const hrPartner = people.find(person => person.role === 'hrbp');
    const timestamp = nowIso();

    const addPlan = plan => db.prepare(`
      INSERT INTO succession_plans(position_profile_id, role_name, holder_id, criticality, risk, risk_reason, planned_departure, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(plan.position, plan.role, plan.holder.id, plan.criticality, plan.risk, plan.reason, plan.departure ?? null, timestamp, timestamp).lastInsertRowid;
    const addCandidate = (planId, person, readiness, strengths, gaps, actions) => {
      const id = db.prepare(`
        INSERT INTO succession_candidates(plan_id, user_id, readiness, strengths, gaps, development_actions, status, created_at, updated_at)
        VALUES(?,?,?,?,?,?,'confirmed',?,?)
      `).run(planId, person.id, readiness, strengths, gaps, actions, timestamp, timestamp).lastInsertRowid;
      recordReadiness(id, { id: planId }, person.id, null, readiness, null);
    };
    const nextYear = `${clock().getUTCFullYear() + 1}-06-30`;

    db.transaction(() => {
      const leaderPlan = addPlan({
        position: leader.position_profile_id,
        role: leader.position_profile_id ? null : 'Bereichsleitung (Beispiel)',
        holder: leader,
        criticality: 'high',
        risk: 'medium',
        reason: 'Beispiel: Viel Wissen liegt bei einer Person, ein Wechsel ist denkbar.',
        departure: nextYear
      });
      reports.slice(0, 2).forEach((person, index) => addCandidate(
        leaderPlan,
        person,
        index === 0 ? 'ready_1_2_years' : 'ready_3_plus_years',
        'Beispiel: arbeitet gut über Teamgrenzen hinweg.',
        'Beispiel: wenig Erfahrung mit Budgetverantwortung.',
        'Beispiel: Vertretung in einem Bereichstermin übernehmen.'
      ));

      if (reports.length >= 2) {
        const teamPlan = addPlan({
          position: reports[0].position_profile_id,
          role: reports[0].position_profile_id ? null : 'Teamleitung (Beispiel)',
          holder: reports[0],
          criticality: 'medium',
          risk: 'low',
          reason: 'Beispiel: Die Aufgabe ist gut dokumentiert.'
        });
        reports.slice(1, 3).forEach((person, index) => addCandidate(
          teamPlan,
          person,
          index === 0 ? 'ready_now' : 'ready_1_2_years',
          'Beispiel: kennt die Abläufe im Team sehr gut.',
          'Beispiel: noch keine Führungserfahrung.',
          'Beispiel: ein kleines Projekt eigenständig leiten.'
        ));
      }

      if (hrPartner && reports.length >= 2) {
        const hrPlan = addPlan({
          position: hrPartner.position_profile_id,
          role: hrPartner.position_profile_id ? null : 'Personalbetreuung (Beispiel)',
          holder: hrPartner,
          criticality: 'low',
          risk: 'high',
          reason: 'Beispiel: Die Stelle ist nur einfach besetzt.'
        });
        addCandidate(hrPlan, reports[1], 'ready_3_plus_years', 'Beispiel: gute Gesprächsführung.', 'Beispiel: fehlendes Fachwissen im Arbeitsrecht.', 'Beispiel: Schulung und Begleitung im Tagesgeschäft.');
      }
    })();
  }

  // ---------------------------------------------------------------------------------------
  // Schnittstellen
  // ---------------------------------------------------------------------------------------

  // Führungskräfte und Beschäftigte kommen hier gar nicht weiter, auch nicht mit fremden IDs.
  router.use('/succession', auth, (req, res, next) => {
    if (!ALLOWED_ROLES.includes(current(req).role)) return res.status(403).json({ error: 'Die Nachfolgeplanung ist für dich nicht freigegeben.' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const requireHr = (req, res, next) => {
    if (!isHr(current(req))) return res.status(403).json({ error: 'Das darf nur HR ändern.' });
    next();
  };

  router.get('/succession/options', (req, res) => {
    const actor = current(req);
    const everyone = db.prepare(`
      SELECT u.id, u.name, u.role, COALESCE(pos.title, u.title) title
      FROM users u
      LEFT JOIN position_profiles pos ON pos.id = u.position_profile_id
      WHERE u.is_system_account = 0 AND u.active = 1
      ORDER BY u.name
    `).all();
    const allowed = isHr(actor) ? null : new Set(subordinateIds(actor));
    const selectable = everyone.filter(person => person.id !== actor.id && (!allowed || allowed.has(person.id)));
    const summary = ({ id, name, title }) => ({ id, name, title });
    res.json({
      people: selectable.map(summary),
      // Stelle der HR-Leitung planen darf auch der HR Business Partner, ihre Stärken und Lücken beurteilt er nicht.
      candidates: selectable.filter(person => !isHr(actor) || hrCanAccess(actor, person)).map(summary),
      profiles: isHr(actor) ? db.prepare('SELECT id, title FROM position_profiles WHERE active=1 ORDER BY title').all() : [],
      readiness: READINESS_LABELS,
      levels: LEVEL_LABELS
    });
  });

  router.get('/succession/plans', (req, res) => {
    const actor = current(req);
    const wanted = ['active', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'active';
    const plans = visiblePlans(actor).filter(plan => wanted === 'all' || plan.status === wanted);
    res.json({ plans: plans.map(plan => planView(plan, actor)) });
  });

  router.post('/succession/plans', requireHr, (req, res) => {
    const actor = current(req);
    try {
      const plan = planFromBody(req.body || {}, actor);
      const timestamp = nowIso();
      const id = db.prepare(`
        INSERT INTO succession_plans(position_profile_id, role_name, holder_id, criticality, risk, risk_reason, planned_departure, status, created_by, updated_by, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(plan.positionProfileId, plan.roleName, plan.holderId, plan.criticality, plan.risk, plan.riskReason, plan.plannedDeparture, plan.status, actor.id, actor.id, timestamp, timestamp).lastInsertRowid;
      log(actor.id, 'succession_plan_created', 'succession_plans', id, null, { holderId: plan.holderId });
      res.status(201).json({ plan: planView(planById(id), actor) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.get('/succession/plans/:id', (req, res) => {
    const actor = current(req);
    const plan = planById(asId(req.params.id));
    // Für HR ist "gibt es nicht" hilfreich. Allen anderen verraten wir nicht, ob es den Plan gibt.
    if (isHr(actor) && (!plan || !canSeePlan(actor, plan))) return res.status(404).json({ error: PLAN_NOT_FOUND });
    if (!plan || !canSeePlan(actor, plan)) return res.status(403).json({ error: 'Diesen Plan darfst du nicht sehen.' });
    res.json(planDetail(plan, actor));
  });

  router.patch('/succession/plans/:id', requireHr, (req, res) => {
    const actor = current(req);
    try {
      const before = planForHr(actor, asId(req.params.id));
      const plan = planFromBody(req.body || {}, actor, before);
      db.transaction(() => {
        db.prepare(`
          UPDATE succession_plans
          SET position_profile_id=?, role_name=?, holder_id=?, criticality=?, risk=?, risk_reason=?, planned_departure=?, status=?, updated_by=?, updated_at=?
          WHERE id=?
        `).run(plan.positionProfileId, plan.roleName, plan.holderId, plan.criticality, plan.risk, plan.riskReason, plan.plannedDeparture, plan.status, actor.id, nowIso(), before.id);
        const updated = planById(before.id);
        if (plan.status === 'archived') {
          closeTasks('succession_review', before.id);
          closeTasks('succession_candidate_proposal', before.id);
        } else {
          if (before.status === 'archived') restoreReviewTask(updated);
          refreshPlanTasks(updated);
        }
        log(actor.id, 'succession_plan_updated', 'succession_plans', before.id, null, { holderId: plan.holderId, status: plan.status });
      })();
      res.json({ plan: planView(planById(before.id), actor) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.post('/succession/plans/:id/reviewed', requireHr, (req, res) => {
    const actor = current(req);
    try {
      const plan = planForHr(actor, asId(req.params.id));
      assertPlanActive(plan);
      const timestamp = nowIso();
      db.transaction(() => {
        db.prepare('UPDATE succession_plans SET last_reviewed_at=?, last_reviewed_by=?, updated_by=?, updated_at=? WHERE id=?').run(timestamp, actor.id, actor.id, timestamp, plan.id);
        closeTasks('succession_review', plan.id);
        log(actor.id, 'succession_plan_reviewed', 'succession_plans', plan.id);
      })();
      res.json({ plan: planView(planById(plan.id), actor) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.post('/succession/plans/:id/candidates', (req, res) => {
    const actor = current(req);
    const plan = planById(asId(req.params.id));
    if (isHr(actor) && (!plan || !canSeePlan(actor, plan))) return res.status(404).json({ error: PLAN_NOT_FOUND });
    if (!plan || !canSeePlan(actor, plan)) return res.status(403).json({ error: 'Diesen Plan darfst du nicht sehen.' });

    const body = req.body || {};
    const userId = asId(body.userId);
    try {
      assertPlanActive(plan);
      if (userId === actor.id) throw httpProblem(403, 'Dich selbst kannst du nicht vorschlagen.');
      if (!userId || !activePerson(userId)) throw httpProblem(400, 'Bitte wähle eine aktive Person aus.');
      if (!canViewEmployee(actor, userId)) {
        throw httpProblem(403, isHr(actor) ? 'Die HR-Leitung nimmt nur die HR-Administration auf.' : 'Du kannst nur Personen aus deiner Führungslinie vorschlagen.');
      }
      if (userId === plan.holder_id) throw httpProblem(400, 'Wer die Stelle gerade besetzt, kann nicht die eigene Nachfolge sein.');
      if (!isKeyOf(READINESS_LABELS, body.readiness)) throw httpProblem(400, 'Bitte gib die Bereitschaft an. Ohne sie geht es nicht.');
      if (candidateRow(plan.id, userId)) throw httpProblem(409, 'Diese Person steht schon in diesem Plan.');

      const text = candidateTextFields(body);
      const status = isHr(actor) ? 'confirmed' : 'proposed';
      const timestamp = nowIso();
      const id = db.transaction(() => {
        const candidateId = db.prepare(`
          INSERT INTO succession_candidates(plan_id, user_id, readiness, strengths, gaps, development_actions, note, status, proposed_by, updated_by, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(plan.id, userId, body.readiness, text.strengths, text.gaps, text.developmentActions, text.note, status, actor.id, actor.id, timestamp, timestamp).lastInsertRowid;
        recordReadiness(candidateId, plan, userId, null, body.readiness, actor.id);
        log(actor.id, 'succession_candidate_created', 'succession_candidates', candidateId, null, { planId: plan.id, userId });
        if (status === 'proposed') {
          const updated = planById(plan.id);
          const person = responsibleHrPerson(updated);
          const alreadyWaiting = db.prepare("SELECT id FROM tasks WHERE type='succession_candidate_proposal' AND entity_id=? AND done=0 LIMIT 1").get(plan.id);
          if (person && !alreadyWaiting) createTask(person.id, proposalTaskTitle(updated), 'succession_candidate_proposal', plan.id);
        }
        // Eine HR-Person, die jetzt selbst im Plan steht, kann ihre Aufgabe dazu nicht mehr erledigen.
        refreshPlanTasks(planById(plan.id));
        return candidateId;
      })();
      res.status(201).json({ candidate: candidateView(candidateById(id), plan, actor, isHr(actor) && nineBoxReadable()) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.patch('/succession/candidates/:id', requireHr, (req, res) => {
    const actor = current(req);
    const body = req.body || {};
    try {
      const before = candidateById(asId(req.params.id));
      if (!before) throw httpProblem(404, 'Diesen Eintrag gibt es nicht.');
      const plan = planForHr(actor, before.plan_id);
      if (!seesCandidateDetails(actor, before.user_id)) throw httpProblem(403, 'Die Angaben zur HR-Leitung ändert nur die HR-Administration.');
      assertPlanActive(plan);

      const readiness = body.readiness !== undefined ? body.readiness : before.readiness;
      if (!isKeyOf(READINESS_LABELS, readiness)) throw httpProblem(400, 'Diese Bereitschaft gibt es nicht.');
      const status = body.status !== undefined ? body.status : before.status;
      if (!isKeyOf(CANDIDATE_STATUS_LABELS, status)) throw httpProblem(400, 'Diesen Status gibt es nicht.');
      if (status !== 'removed' && before.user_id === plan.holder_id) {
        throw httpProblem(400, 'Wer die Stelle gerade besetzt, kann nicht die eigene Nachfolge sein.');
      }

      const text = candidateTextFields(body, before);
      db.transaction(() => {
        db.prepare(`
          UPDATE succession_candidates
          SET readiness=?, strengths=?, gaps=?, development_actions=?, note=?, status=?, updated_by=?, updated_at=?
          WHERE id=?
        `).run(readiness, text.strengths, text.gaps, text.developmentActions, text.note, status, actor.id, nowIso(), before.id);
        if (readiness !== before.readiness) recordReadiness(before.id, plan, before.user_id, before.readiness, readiness, actor.id);
        log(actor.id, 'succession_candidate_updated', 'succession_candidates', before.id, null, { planId: plan.id, userId: before.user_id });
        const openProposals = db.prepare("SELECT id FROM succession_candidates WHERE plan_id=? AND status='proposed' LIMIT 1").get(plan.id);
        if (!openProposals) closeTasks('succession_candidate_proposal', plan.id);
      })();
      res.json({ candidate: candidateView(candidateById(before.id), plan, actor, nineBoxReadable()) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.get('/succession/metrics', (req, res) => {
    const actor = current(req);
    const plans = visiblePlans(actor).filter(plan => plan.status === 'active');
    const matrix = Object.fromEntries(LEVELS.map(criticality => [criticality, Object.fromEntries(LEVELS.map(risk => [risk, 0]))]));
    const benchRows = plans.map(plan => {
      matrix[plan.criticality][plan.risk] += 1;
      return {
        planId: plan.id,
        title: planTitle(plan),
        criticalityLabel: LEVEL_LABELS[plan.criticality],
        riskLabel: LEVEL_LABELS[plan.risk],
        bench: benchOf(plan.id)
      };
    });

    // Brutto zählt jede Nominierung, netto jede Person nur einmal.
    const planIds = new Set(plans.map(plan => plan.id));
    const confirmed = db.prepare(`
      SELECT c.plan_id, c.user_id
      FROM succession_candidates c
      JOIN users u ON u.id = c.user_id
      WHERE c.status = 'confirmed' AND u.active = 1 AND u.is_system_account = 0
    `).all().filter(row => planIds.has(row.plan_id));

    res.json({
      plans: benchRows,
      plansWithoutReadyCandidate: benchRows.filter(row => row.bench.ready_now === 0).map(row => ({ planId: row.planId, title: row.title })),
      riskMatrix: matrix,
      levels: LEVEL_LABELS,
      nominations: { gross: confirmed.length, net: new Set(confirmed.map(row => row.user_id)).size }
    });
  });

  return { router, initialize, seedDemo, maintenance, helpArticles: HELP_ARTICLES };
}

module.exports = { createSuccessionModule };
