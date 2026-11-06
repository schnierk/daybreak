'use strict';

/**
 * Vergütung: Gehaltsbänder, Vergütungshistorie und Gehaltsrunden.
 *
 * Grundsätze dieses Moduls:
 * - Geld sind immer ganze Cent. Gerechnet wird nur mit Ganzzahlen, nie mit Fließkomma.
 * - Protokoll und Aufgabentitel enthalten nie Beträge oder Einstufungen.
 * - Das System rechnet und warnt. Entscheidungen treffen Menschen.
 * - Eine Gehaltsrunde rechnet immer vom Stand zum eigenen Gültig-ab-Datum aus, nicht vom heutigen.
 * - Niemand entscheidet über das eigene Gehalt. Und was Knöpfe zeigen, entscheidet dieselbe
 *   Prüfung, die auch die Schnittstelle nutzt (decisionOptions).
 *
 * Nicht Teil des Moduls: Lohnabrechnung, Steuern, Auszahlung von Boni und Auswertungen nach
 * Geschlecht (Entgelttransparenz braucht ein eigenes, abgestimmtes Konzept).
 */

const express = require('express');
const { ensureColumn } = require('../lib/core-helpers');

/** Unterhalb dieser Gruppengröße zeigen Summen und Durchschnitte nichts an. */
const MIN_GROUP_SIZE = 5;
/** Obergrenze für Beträge (100 Mio.). Hält alle Summen sicher im Ganzzahlbereich. */
const MAX_CENTS = 10_000_000_000;
/** 100 % und Stellenumfang 1,0 entsprechen jeweils 10.000 Basispunkten. */
const BASIS_POINTS = 10_000;

const PROPOSER_ROLES = Object.freeze(['manager', 'director', 'hr_admin']);
const LEADER_ROLES = Object.freeze(['manager', 'director']);

const RECORD_REASONS = Object.freeze({
  hire: 'Eintritt',
  cycle: 'Gehaltsrunde',
  promotion: 'Beförderung',
  correction: 'Korrektur',
  other: 'Sonstiges'
});

const CYCLE_STATUS_LABELS = Object.freeze({
  draft: 'Entwurf',
  open: 'Offen',
  review: 'In Prüfung',
  closed: 'Abgeschlossen'
});

const PROPOSAL_STATUS_LABELS = Object.freeze({
  submitted: 'Vorgeschlagen',
  approved: 'Genehmigt',
  rejected: 'Abgelehnt'
});

const RESULT_LABELS = Object.freeze({
  none: 'Kein Vorschlag',
  pending: 'HR prüft',
  approved: 'Genehmigt',
  changed: 'Von HR geändert',
  rejected: 'Abgelehnt'
});

const HR_ADMIN_DECIDES = 'Entscheiden und Abschließen darf die HR-Administration.';
const OWN_PROPOSAL_BLOCKED = 'Das ist dein eigener Vorschlag. Laut euren Genehmigungsregeln entscheidet darüber eine andere HR-Administration.';
const OWN_SALARY_BLOCKED = 'Über deine eigene Vergütung muss jemand anderes entscheiden (Vier-Augen-Prinzip).';

const HELP_ARTICLES = Object.freeze([
  {
    id: 'compensation-own',
    title: 'Meine Vergütung ansehen',
    roles: ['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp'],
    views: ['compensationMine'],
    keywords: ['gehalt', 'mein gehalt', 'vergütung', 'gehaltsband', 'lohn', 'stellenumfang'],
    answer: 'Unter „Meine Arbeit“ findest du „Meine Vergütung“. Dort siehst du deine eigene Vergütung, sobald sie gilt, und die Spanne deines Gehaltsbandes. Konkrete Beträge nennt Dayo nicht.',
    steps: [
      'Öffne im Menü „Meine Arbeit“.',
      'Wähle „Meine Vergütung“.',
      'Bei Fragen zu deinem Gehalt wende dich an HR oder deine Führungskraft.'
    ],
    actions: [{ label: 'Meine Vergütung öffnen', view: 'compensationMine' }]
  },
  {
    id: 'compensation-round-leader',
    title: 'Vorschläge in der Gehaltsrunde abgeben',
    roles: ['manager', 'director'],
    views: ['compensationTeam'],
    keywords: ['gehaltsrunde', 'vorschlag', 'gehaltserhöhung', 'budget', 'erhöhung', 'ergebnis', 'abgelehnt'],
    answer: 'Solange eine Gehaltsrunde offen ist, schlägst du für deine direkten Mitarbeitenden eine Erhöhung vor, als Betrag oder in Prozent. Überschreitest du das Budget oder das Band, musst du das begründen. Gesperrt wird nichts, die Entscheidung trifft HR. Jeder Vorschlag gilt ab dem Speichern, abgeben musst du nichts mehr. Nach dem Abschluss siehst du das Ergebnis für dein Team und bekommst einen Hinweis. Andere Einzelwerte siehst du nicht.',
    steps: [
      'Öffne die Aufgabe auf deiner Übersicht oder „Personal“ und dann „Vergütung“.',
      'Trage je Person einen Vorschlag ein.',
      'Behalte die Budgetanzeige für deinen Bereich im Blick.',
      'Das Ergebnis findest du später an derselben Stelle.'
    ],
    actions: [{ label: 'Vorschläge öffnen', view: 'compensationTeam' }]
  },
  {
    id: 'compensation-round-hr',
    title: 'Eine Gehaltsrunde durchführen',
    roles: ['hr_admin', 'hrbp', 'super_admin'],
    views: ['compensationCycles', 'compensationCycle', 'compensationHome'],
    keywords: ['gehaltsrunde', 'runde öffnen', 'runde abschließen', 'budget', 'vorschläge prüfen', 'genehmigen'],
    answer: 'Eine Runde läuft in vier Schritten: Entwurf, offen, in Prüfung, abgeschlossen. Beim Öffnen werden Teilnehmende und Ausgangsgehälter festgeschrieben, und zwar der Stand zum Gültig-ab-Datum. Die Führungskräfte bekommen eine Aufgabe. Wer später dazukommt, nimmst du in der offenen Runde auf. In der Prüfung genehmigt, ändert oder lehnt die HR-Administration die Vorschläge ab. Erst der Abschluss legt die neuen Vergütungseinträge an, und zwar genau einmal, und sagt den Führungskräften Bescheid.',
    steps: [
      'Lege unter „Gehaltsrunden“ eine Runde mit Budget, Gültig-ab-Datum und Frist an.',
      'Öffne die Runde und gib sie nach der Vorschlagsphase in die Prüfung.',
      'Entscheide jeden Vorschlag und schließe die Runde ab.'
    ],
    actions: [{ label: 'Gehaltsrunden öffnen', view: 'compensationCycles' }]
  },
  {
    id: 'compensation-bands',
    title: 'Gehaltsbänder und die Lage im Gehaltsband verstehen',
    roles: ['hr_admin', 'hrbp', 'super_admin'],
    views: ['compensationGrades', 'compensationPeople', 'compensationHome'],
    keywords: ['gehaltsband', 'band', 'lage im gehaltsband', 'compa-ratio', 'compa ratio', 'bandposition', 'außerhalb des bandes', 'teilzeit'],
    answer: 'Ein Band beschreibt Minimum, Mitte und Maximum für eine Vollzeitstelle im Jahr. Die Lage im Gehaltsband vergleicht das auf Vollzeit hochgerechnete Gehalt mit der Mitte des Bandes: Hundert Prozent heißt genau in der Mitte. Der Stand zwischen Minimum und Maximum zeigt, wie weit das Gehalt im Band nach oben reicht. Außerhalb des Bandes erscheint eine Warnung, gesperrt wird nichts.',
    steps: [
      'Pflege die Bänder unter „Gehaltsbänder“.',
      'Ordne das Band beim Vergütungseintrag einer Person zu.',
      'Prüfe unter „Übersicht“, wer außerhalb des Bandes liegt.'
    ],
    actions: [{ label: 'Gehaltsbänder öffnen', view: 'compensationGrades' }]
  }
]);

/** Rechnet a * b / c exakt und rundet kaufmännisch. BigInt, damit nichts ungenau wird. */
function mulDivRound(a, b, c) {
  const numerator = BigInt(a) * BigInt(b);
  const divisor = BigInt(c);
  const negative = (numerator < 0n) !== (divisor < 0n);
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDivisor = divisor < 0n ? -divisor : divisor;
  const rounded = (absoluteNumerator * 2n + absoluteDivisor) / (absoluteDivisor * 2n);
  return Number(negative ? -rounded : rounded);
}

/**
 * Wandelt eine Eingabe in ganze Cent um, ohne Fließkomma-Rechnung.
 * Texte dürfen deutsch geschrieben sein ("52.345,67"). Mehr als zwei Nachkommastellen sind
 * ungültig. Bei Zahlen gilt der Punkt immer als Komma; 1.234 ist also ungültig und nicht 1234.
 */
function parseMoneyToCents(value) {
  let text;
  if (typeof value === 'number') text = String(value);
  else if (typeof value === 'string') text = value.replace(/[\s €]/g, '');
  else return null;

  const germanGroups = typeof value === 'string' ? text.match(/^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/) : null;
  const plain = text.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  const match = germanGroups || plain;
  if (!match) return null;

  const whole = match[1].replace(/\./g, '');
  if (whole.length > 12) return null;
  const cents = Number(whole) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return cents <= MAX_CENTS ? cents : null;
}

/** Wandelt eine Prozentangabe (0 bis 100, höchstens zwei Nachkommastellen) in Basispunkte um. */
function parsePercentToBasisPoints(value) {
  let text;
  if (typeof value === 'number') text = String(value);
  else if (typeof value === 'string') text = value.replace(/[\s %]/g, '');
  else return null;

  const match = text.match(/^(\d{1,3})(?:[.,](\d{1,2}))?$/);
  if (!match) return null;
  const points = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return points <= BASIS_POINTS ? points : null;
}

/** Stellenumfang größer 0 bis 1, höchstens vier Nachkommastellen. Ergebnis in Basispunkten. */
function parseFteToBasisPoints(value) {
  let text;
  if (typeof value === 'number') text = String(value);
  else if (typeof value === 'string') text = value.trim();
  else return null;

  const match = text.match(/^([01])(?:[.,](\d{1,4}))?$/);
  if (!match) return null;
  const points = Number(match[1]) * BASIS_POINTS + Number((match[2] || '').padEnd(4, '0'));
  return points >= 1 && points <= BASIS_POINTS ? points : null;
}

function parseCurrency(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Kennzahlen immer bezogen auf Vollzeit, weil Bänder Vollzeit-Jahresbeträge sind. */
function salaryMetrics(annualSalaryCents, fteBasisPoints, grade) {
  const fullTimeCents = mulDivRound(annualSalaryCents, BASIS_POINTS, fteBasisPoints);
  if (!grade) return { fullTimeCents, compaRatio: null, rangePositionPercent: null, bandStatus: 'no_band' };

  const span = grade.maxCents - grade.minCents;
  let bandStatus = 'inside';
  if (fullTimeCents < grade.minCents) bandStatus = 'below';
  if (fullTimeCents > grade.maxCents) bandStatus = 'above';
  return {
    fullTimeCents,
    compaRatio: mulDivRound(fullTimeCents, 1000, grade.midCents) / 1000,
    rangePositionPercent: span > 0 ? mulDivRound(fullTimeCents - grade.minCents, 1000, span) / 10 : null,
    bandStatus
  };
}

function bandWarnings(metrics) {
  if (metrics.bandStatus === 'above') {
    return [{ code: 'above_band', message: 'Liegt über dem Maximum des Bandes (bezogen auf Vollzeit). Das ist nur ein Hinweis.' }];
  }
  if (metrics.bandStatus === 'below') {
    return [{ code: 'below_band', message: 'Liegt unter dem Minimum des Bandes (bezogen auf Vollzeit). Das ist nur ein Hinweis.' }];
  }
  return [];
}

/** Schützt vor Formeln in Tabellenprogrammen und maskiert Trennzeichen. */
function csvField(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  if (/[;"\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function centsToCsv(cents) {
  if (cents === null || cents === undefined) return '';
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

function httpProblem(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

function sendProblem(res, error) {
  if (!error.httpStatus) throw error;
  return res.status(error.httpStatus).json({ error: error.message });
}

const sumOf = (items, valueOf) => items.reduce((total, item) => total + valueOf(item), 0);
const isKeyOf = (labels, value) => typeof value === 'string' && Object.hasOwn(labels, value);
const germanDate = iso => String(iso).slice(0, 10).split('-').reverse().join('.');

/** „Anna“, „Anna und Ben“, „Anna, Ben und Clara“, „Anna, Ben und 3 weitere“. */
function peopleText(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} und ${names.length - 2} weitere`;
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

function createCompensationModule(deps) {
  const { db, auth, current, isHr, hrCanAccess, subordinateIds, cleanText, validDate, log, createTask, approvalRule } = deps;
  const router = express.Router();

  const nowIso = () => new Date().toISOString();
  const todayIso = () => nowIso().slice(0, 10);
  const realDate = value => Boolean(value) && validDate(value) && isCalendarDate(value);
  const asId = value => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  };

  const canWrite = actor => actor.role === 'hr_admin' || actor.role === 'super_admin';
  const canExport = actor => actor.role === 'hr_admin';
  const canPropose = actor => PROPOSER_ROLES.includes(actor.role);

  const requireHrRead = (req, res, next) => {
    if (!isHr(current(req))) return res.status(403).json({ error: 'Diese Vergütungsdaten sind nur für HR sichtbar.' });
    next();
  };
  const requireHrWrite = (req, res, next) => {
    if (!canWrite(current(req))) return res.status(403).json({ error: 'Das darf nur die HR-Administration ändern.' });
    next();
  };

  /** Datensätze dürfen nie überschrieben werden. Der Auslöser ist SQLite-Syntax, deshalb hier gekapselt. */
  function protectRecordsFromOverwrite() {
    if (db.dialect === 'postgres') {
      // DROP TRIGGER bräuchte eine Sperre und ließe einen Neustart warten, solange eine Sicherung läuft.
      const exists = db.prepare("SELECT 1 FROM pg_trigger WHERE tgname='compensation_records_never_overwrite' AND tgrelid=to_regclass('compensation_records')").get();
      if (exists) return;
      db.execRaw(`
        CREATE OR REPLACE FUNCTION compensation_records_never_overwrite() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'Vergütungseinträge werden nie überschrieben.';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER compensation_records_never_overwrite BEFORE UPDATE ON compensation_records
          FOR EACH ROW EXECUTE FUNCTION compensation_records_never_overwrite();
      `);
      return;
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS compensation_records_never_overwrite
      BEFORE UPDATE ON compensation_records
      BEGIN
        SELECT RAISE(ABORT, 'Vergütungseinträge werden nie überschrieben.');
      END;
    `);
  }

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compensation_grades (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        min_cents BIGINT NOT NULL CHECK(min_cents > 0),
        mid_cents BIGINT NOT NULL CHECK(mid_cents > 0),
        max_cents BIGINT NOT NULL CHECK(max_cents > 0),
        valid_from TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        updated_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(min_cents <= mid_cents AND mid_cents <= max_cents),
        UNIQUE(name, valid_from)
      );
      CREATE TABLE IF NOT EXISTS compensation_cycles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        budget_mode TEXT NOT NULL CHECK(budget_mode IN ('percent','amount')),
        budget_percent_points INTEGER,
        budget_amount_cents BIGINT,
        effective_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','review','closed')),
        base_total_cents BIGINT,
        opened_at TEXT,
        opened_by INTEGER REFERENCES users(id),
        review_at TEXT,
        review_by INTEGER REFERENCES users(id),
        closed_at TEXT,
        closed_by INTEGER REFERENCES users(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compensation_records (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        effective_date TEXT NOT NULL,
        annual_salary_cents BIGINT NOT NULL CHECK(annual_salary_cents > 0),
        currency TEXT NOT NULL DEFAULT 'EUR',
        grade_id INTEGER REFERENCES compensation_grades(id),
        fte_basis_points INTEGER NOT NULL CHECK(fte_basis_points > 0 AND fte_basis_points <= 10000),
        variable_target_cents BIGINT NOT NULL DEFAULT 0 CHECK(variable_target_cents >= 0),
        reason TEXT NOT NULL CHECK(reason IN ('hire','cycle','promotion','correction','other')),
        source_cycle_id INTEGER REFERENCES compensation_cycles(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        UNIQUE(source_cycle_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS compensation_cycle_participants (
        cycle_id INTEGER NOT NULL REFERENCES compensation_cycles(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        baseline_record_id INTEGER NOT NULL REFERENCES compensation_records(id),
        base_salary_cents BIGINT NOT NULL,
        currency TEXT NOT NULL,
        grade_id INTEGER REFERENCES compensation_grades(id),
        fte_basis_points INTEGER NOT NULL,
        variable_target_cents BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(cycle_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS compensation_proposals (
        id INTEGER PRIMARY KEY,
        cycle_id INTEGER NOT NULL REFERENCES compensation_cycles(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        proposed_by INTEGER REFERENCES users(id),
        input_mode TEXT NOT NULL CHECK(input_mode IN ('amount','percent')),
        input_percent_points INTEGER,
        increase_cents BIGINT NOT NULL CHECK(increase_cents >= 0),
        proposed_salary_cents BIGINT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected')),
        final_salary_cents BIGINT,
        changed_by_hr INTEGER NOT NULL DEFAULT 0,
        decision_reason TEXT,
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(cycle_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_compensation_records_user_date ON compensation_records(user_id, effective_date);
      CREATE INDEX IF NOT EXISTS idx_compensation_cycles_status ON compensation_cycles(status);
    `);
    ensureColumn(db, 'compensation_cycles', 'proposal_deadline', 'TEXT');
    ensureColumn(db, 'compensation_cycle_participants', 'result_manager_id', 'INTEGER REFERENCES users(id)');
    protectRecordsFromOverwrite();
  }

  // ---------------------------------------------------------------------------------------
  // Lesen und Darstellen
  // ---------------------------------------------------------------------------------------

  const RECORD_SELECT = `
    SELECT r.*, g.name grade_name, g.currency grade_currency, g.min_cents grade_min_cents,
           g.mid_cents grade_mid_cents, g.max_cents grade_max_cents, g.active grade_active, creator.name created_by_name,
           round_proposer.name round_proposed_by_name, round_decider.name round_decided_by_name
    FROM compensation_records r
    LEFT JOIN compensation_grades g ON g.id = r.grade_id
    LEFT JOIN users creator ON creator.id = r.created_by
    LEFT JOIN compensation_proposals round_proposal ON round_proposal.cycle_id = r.source_cycle_id AND round_proposal.user_id = r.user_id
    LEFT JOIN users round_proposer ON round_proposer.id = round_proposal.proposed_by
    LEFT JOIN users round_decider ON round_decider.id = round_proposal.decided_by`;

  const PERSON_SELECT = `
    SELECT u.id, u.name, u.email, u.role, u.manager_id, u.active, COALESCE(pos.title, u.title) title
    FROM users u
    LEFT JOIN position_profiles pos ON pos.id = u.position_profile_id`;

  const gradeById = id => db.prepare('SELECT * FROM compensation_grades WHERE id=?').get(id);
  const cycleById = id => db.prepare('SELECT * FROM compensation_cycles WHERE id=?').get(id);
  const personById = id => db.prepare(`${PERSON_SELECT} WHERE u.id=? AND u.is_system_account=0`).get(id);
  const activePeople = () => db.prepare(`${PERSON_SELECT} WHERE u.is_system_account=0 AND u.active=1 ORDER BY u.name`).all();

  const recordsOf = userId => db.prepare(`${RECORD_SELECT} WHERE r.user_id=? ORDER BY r.effective_date DESC, r.id DESC`).all(userId);

  /** Stand je Person zu einem Datum: jüngster Eintrag mit Gültig-ab bis zu diesem Tag. */
  function recordsAsOf(date) {
    const rows = db.prepare(`${RECORD_SELECT} WHERE r.effective_date <= ? ORDER BY r.user_id, r.effective_date DESC, r.id DESC`).all(date);
    const result = new Map();
    for (const row of rows) {
      if (!result.has(row.user_id)) result.set(row.user_id, row);
    }
    return result;
  }

  const currentRecordsByUser = () => recordsAsOf(todayIso());

  /** Einträge, die erst noch gelten, je Person der Reihe nach. Bei gleichem Datum gilt der später erfasste. */
  function futureRecordsByUser() {
    const rows = db.prepare(`${RECORD_SELECT} WHERE r.effective_date > ? ORDER BY r.user_id, r.effective_date, r.id`).all(todayIso());
    const result = new Map();
    for (const row of rows) {
      if (!result.has(row.user_id)) result.set(row.user_id, new Map());
      result.get(row.user_id).set(row.effective_date, row);
    }
    return new Map([...result].map(([userId, byDate]) => [userId, [...byDate.values()]]));
  }

  const upcomingView = row => (row
    ? { effectiveDate: row.effective_date, annualSalaryCents: row.annual_salary_cents, currency: row.currency, reasonLabel: RECORD_REASONS[row.reason] }
    : null);

  function gradeView(row) {
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      minCents: row.min_cents,
      midCents: row.mid_cents,
      maxCents: row.max_cents,
      validFrom: row.valid_from,
      active: Boolean(row.active)
    };
  }

  /** Das Band zu einer Zeile, die die Felder aus RECORD_SELECT oder participantRows enthält. */
  function gradeOfRow(row) {
    if (!row.grade_id) return null;
    return {
      id: row.grade_id,
      name: row.grade_name,
      currency: row.grade_currency,
      minCents: row.grade_min_cents,
      midCents: row.grade_mid_cents,
      maxCents: row.grade_max_cents
    };
  }

  function hrRecordView(row) {
    const grade = gradeOfRow(row);
    const metrics = salaryMetrics(row.annual_salary_cents, row.fte_basis_points, grade);
    return {
      id: row.id,
      effectiveDate: row.effective_date,
      future: row.effective_date > todayIso(),
      annualSalaryCents: row.annual_salary_cents,
      currency: row.currency,
      fte: row.fte_basis_points / BASIS_POINTS,
      fteBasisPoints: row.fte_basis_points,
      variableTargetCents: row.variable_target_cents,
      reason: row.reason,
      reasonLabel: RECORD_REASONS[row.reason],
      grade,
      gradeActive: row.grade_id ? Boolean(row.grade_active) : null,
      metrics,
      warnings: bandWarnings(metrics),
      sourceCycleId: row.source_cycle_id,
      proposedBy: row.round_proposed_by_name || null,
      decidedBy: row.round_decided_by_name || null,
      createdBy: row.created_by_name || 'System',
      createdAt: row.created_at
    };
  }

  /** Damit ein neuer Eintrag nicht still Umfang, Band oder Zielvergütung ändert: Das Formular startet mit dem bisherigen Stand. */
  function entryDefaults(history) {
    const base = history.find(record => !record.future) || history[history.length - 1];
    if (!base) return null;
    return {
      annualSalaryCents: base.annualSalaryCents,
      fteBasisPoints: base.fteBasisPoints,
      gradeId: base.grade?.id ?? null,
      gradeName: base.grade?.name ?? null,
      gradeActive: base.gradeActive,
      variableTargetCents: base.variableTargetCents,
      currency: base.currency
    };
  }

  /** Beschäftigte sehen ihr Gehalt und die Spanne ihres Bandes, keine Bandmitte und keine Kennzahlen. */
  function ownRecordView(row) {
    return {
      effectiveDate: row.effective_date,
      annualSalaryCents: row.annual_salary_cents,
      currency: row.currency,
      fte: row.fte_basis_points / BASIS_POINTS,
      fteBasisPoints: row.fte_basis_points,
      variableTargetCents: row.variable_target_cents,
      reasonLabel: RECORD_REASONS[row.reason],
      band: row.grade_id
        ? { name: row.grade_name, currency: row.grade_currency, minCents: row.grade_min_cents, maxCents: row.grade_max_cents }
        : null
    };
  }

  function ownCompensation(userId) {
    const today = todayIso();
    const history = recordsOf(userId).filter(row => row.effective_date <= today).map(ownRecordView);
    return { current: history[0] || null, history };
  }

  function indirectReportIds(actor) {
    const direct = new Set(db.prepare('SELECT id FROM users WHERE manager_id=?').all(actor.id).map(row => row.id));
    return subordinateIds(actor).filter(id => !direct.has(id) && id !== actor.id);
  }

  // ---------------------------------------------------------------------------------------
  // Gehaltsbänder
  // ---------------------------------------------------------------------------------------

  function gradeFromBody(body, base = null) {
    const name = body.name !== undefined ? cleanText(body.name, 80) : base?.name;
    if (!name) throw httpProblem(400, 'Bitte gib dem Band eine Bezeichnung.');

    const currency = body.currency !== undefined ? parseCurrency(body.currency) : (base?.currency ?? 'EUR');
    if (!currency) throw httpProblem(400, 'Die Währung muss ein dreistelliger Code sein, zum Beispiel EUR.');

    const minCents = body.min !== undefined ? parseMoneyToCents(body.min) : base?.min_cents;
    const midCents = body.mid !== undefined ? parseMoneyToCents(body.mid) : base?.mid_cents;
    const maxCents = body.max !== undefined ? parseMoneyToCents(body.max) : base?.max_cents;
    if (![minCents, midCents, maxCents].every(cents => Number.isInteger(cents) && cents > 0)) {
      throw httpProblem(400, 'Minimum, Mitte und Maximum müssen positive Beträge mit höchstens zwei Nachkommastellen sein.');
    }
    if (minCents > midCents || midCents > maxCents) {
      throw httpProblem(400, 'Es muss gelten: Minimum ≤ Mitte ≤ Maximum.');
    }

    const validFrom = body.validFrom !== undefined ? body.validFrom : base?.valid_from;
    if (!realDate(validFrom)) throw httpProblem(400, 'Bitte gib für „Gültig ab“ ein gültiges Datum an.');

    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw httpProblem(400, 'Bitte gib an, ob das Band aktiv ist.');
    }
    const active = body.active !== undefined ? Number(body.active) : (base?.active ?? 1);

    return { name, currency, minCents, midCents, maxCents, validFrom, active };
  }

  function assertGradeNameFree(name, validFrom, ownId = null) {
    const clash = db.prepare('SELECT id FROM compensation_grades WHERE name=? AND valid_from=?').get(name, validFrom);
    if (clash && clash.id !== ownId) throw httpProblem(409, 'Ein Band mit dieser Bezeichnung und diesem Datum gibt es schon.');
  }

  // ---------------------------------------------------------------------------------------
  // Vergütungshistorie
  // ---------------------------------------------------------------------------------------

  function recordFromBody(body) {
    if (!realDate(body.effectiveDate)) throw httpProblem(400, 'Bitte gib für „Gültig ab“ ein gültiges Datum an.');

    const annualSalaryCents = parseMoneyToCents(body.annualSalary);
    if (!annualSalaryCents) throw httpProblem(400, 'Das Jahresgehalt muss ein positiver Betrag mit höchstens zwei Nachkommastellen sein.');

    const fteBasisPoints = parseFteToBasisPoints(body.fte === undefined || body.fte === '' ? 1 : body.fte);
    if (!fteBasisPoints) throw httpProblem(400, 'Der Stellenumfang muss größer als 0 und höchstens 1 sein, zum Beispiel 0,8.');

    const variableInput = body.variableTarget;
    const variableTargetCents = variableInput === undefined || variableInput === '' || variableInput === null ? 0 : parseMoneyToCents(variableInput);
    if (variableTargetCents === null) throw httpProblem(400, 'Die variable Zielvergütung muss ein Betrag ab 0 sein.');

    if (!isKeyOf(RECORD_REASONS, body.reason)) throw httpProblem(400, 'Bitte wähle einen gültigen Grund.');

    let grade = null;
    if (body.gradeId !== undefined && body.gradeId !== null && body.gradeId !== '') {
      grade = gradeById(asId(body.gradeId));
      if (!grade) throw httpProblem(400, 'Dieses Gehaltsband gibt es nicht.');
      if (!grade.active) throw httpProblem(400, 'Dieses Gehaltsband ist nicht mehr aktiv.');
      if (body.effectiveDate < grade.valid_from) throw httpProblem(400, 'Dieses Gehaltsband gilt erst ab einem späteren Datum.');
    }

    const currencyInput = body.currency === undefined || body.currency === '' ? (grade?.currency ?? 'EUR') : body.currency;
    const currency = parseCurrency(currencyInput);
    if (!currency) throw httpProblem(400, 'Die Währung muss ein dreistelliger Code sein, zum Beispiel EUR.');
    if (grade && grade.currency !== currency) throw httpProblem(400, 'Die Währung passt nicht zum gewählten Gehaltsband.');

    return {
      effectiveDate: body.effectiveDate,
      annualSalaryCents,
      fteBasisPoints,
      variableTargetCents,
      reason: body.reason,
      gradeId: grade?.id ?? null,
      currency
    };
  }

  const insertRecord = (record, userId, actorId, sourceCycleId = null) => db.prepare(`
    INSERT INTO compensation_records(user_id, effective_date, annual_salary_cents, currency, grade_id,
      fte_basis_points, variable_target_cents, reason, source_cycle_id, created_by, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    userId, record.effectiveDate, record.annualSalaryCents, record.currency, record.gradeId,
    record.fteBasisPoints, record.variableTargetCents, record.reason, sourceCycleId, actorId, nowIso()
  ).lastInsertRowid;

  // ---------------------------------------------------------------------------------------
  // Gehaltsrunden: Rechnen
  // ---------------------------------------------------------------------------------------

  /** Budget für eine Gruppe. Bei einem festen Betrag bekommt jede Gruppe ihren Anteil an der Basis. */
  function budgetForBase(cycle, baseCents) {
    if (cycle.budget_mode === 'percent') return mulDivRound(baseCents, cycle.budget_percent_points, BASIS_POINTS);
    if (!cycle.base_total_cents) return 0;
    return mulDivRound(cycle.budget_amount_cents, baseCents, cycle.base_total_cents);
  }

  function budgetView(cycle, baseCents, plannedCents) {
    const budgetCents = budgetForBase(cycle, baseCents);
    return {
      baseCents,
      budgetCents,
      plannedCents,
      remainingCents: budgetCents - plannedCents,
      overBudget: plannedCents > budgetCents,
      overByCents: Math.max(0, plannedCents - budgetCents),
      usedPercent: budgetCents > 0 ? mulDivRound(plannedCents, 1000, budgetCents) / 10 : null
    };
  }

  /** Zeilen der Runde mit Person, Band und Vorschlag. Die Führungskraft ist immer die aktuelle. */
  function participantRows(cycleId) {
    return db.prepare(`
      SELECT p.*, u.name, u.role, u.manager_id, u.active user_active, COALESCE(pos.title, u.title) title,
             manager.name manager_name,
             g.name grade_name, g.currency grade_currency, g.min_cents grade_min_cents,
             g.mid_cents grade_mid_cents, g.max_cents grade_max_cents,
             pr.id proposal_id, pr.input_mode, pr.input_percent_points, pr.increase_cents,
             pr.proposed_salary_cents, pr.reason proposal_reason, pr.status proposal_status,
             pr.final_salary_cents, pr.changed_by_hr, pr.decision_reason, pr.updated_at proposal_updated_at,
             pr.decided_at, pr.proposed_by proposed_by_id, proposer.name proposed_by_name, decider.name decided_by_name
      FROM compensation_cycle_participants p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN position_profiles pos ON pos.id = u.position_profile_id
      LEFT JOIN users manager ON manager.id = u.manager_id
      LEFT JOIN compensation_grades g ON g.id = p.grade_id
      LEFT JOIN compensation_proposals pr ON pr.cycle_id = p.cycle_id AND pr.user_id = p.user_id
      LEFT JOIN users proposer ON proposer.id = pr.proposed_by
      LEFT JOIN users decider ON decider.id = pr.decided_by
      WHERE p.cycle_id = ?
      ORDER BY u.name
    `).all(cycleId);
  }

  /** Gehalt nach dem Vorschlag. Eine Entscheidung von HR hat Vorrang, abgelehnt bleibt es beim Ausgangsgehalt. */
  function plannedSalary(row) {
    if (!row.proposal_id || row.proposal_status === 'rejected') return row.base_salary_cents;
    return row.final_salary_cents ?? row.proposed_salary_cents;
  }

  const plannedIncrease = row => plannedSalary(row) - row.base_salary_cents;

  function proposalWarnings(row) {
    if (!row.proposal_id || row.proposal_status === 'rejected') return [];
    return bandWarnings(salaryMetrics(plannedSalary(row), row.fte_basis_points, gradeOfRow(row)));
  }

  function worksheetRow(row) {
    const grade = gradeOfRow(row);
    return {
      userId: row.user_id,
      name: row.name,
      title: row.title,
      baseSalaryCents: row.base_salary_cents,
      currency: row.currency,
      fte: row.fte_basis_points / BASIS_POINTS,
      fteBasisPoints: row.fte_basis_points,
      grade,
      metrics: salaryMetrics(row.base_salary_cents, row.fte_basis_points, grade),
      proposal: row.proposal_id ? {
        mode: row.input_mode,
        percent: row.input_percent_points === null ? null : row.input_percent_points / 100,
        increaseCents: row.increase_cents,
        proposedSalaryCents: row.proposed_salary_cents,
        reason: row.proposal_reason,
        updatedAt: row.proposal_updated_at
      } : null,
      plannedMetrics: row.proposal_id ? salaryMetrics(plannedSalary(row), row.fte_basis_points, grade) : null,
      warnings: proposalWarnings(row)
    };
  }

  function hrParticipantView(row, actor, latestRecordIds, cycle) {
    const worksheet = worksheetRow(row);
    return {
      ...worksheet,
      proposal: row.proposal_id ? {
        ...worksheet.proposal,
        status: row.proposal_status,
        statusLabel: PROPOSAL_STATUS_LABELS[row.proposal_status],
        proposedBy: row.proposed_by_name,
        finalSalaryCents: row.final_salary_cents,
        changedByHr: Boolean(row.changed_by_hr),
        decisionReason: row.decision_reason,
        decidedBy: row.decided_by_name,
        decidedAt: row.decided_at
      } : null,
      plannedSalaryCents: plannedSalary(row),
      plannedIncreaseCents: plannedIncrease(row),
      variableTargetCents: row.variable_target_cents,
      managerId: row.manager_id,
      managerName: row.manager_name,
      active: Boolean(row.user_active),
      isSelf: row.user_id === actor.id,
      decision: decisionOptions(row, actor),
      // Während der Runde kann ein neuerer Eintrag dazukommen; dann ist das Ausgangsgehalt zu prüfen.
      newerRecordExists: cycle.status !== 'closed' && latestRecordIds.get(row.user_id) !== row.baseline_record_id
    };
  }

  function latestRecordIdsByUser() {
    const rows = db.prepare('SELECT user_id, id FROM compensation_records ORDER BY user_id, effective_date DESC, id DESC').all();
    const result = new Map();
    for (const row of rows) {
      if (!result.has(row.user_id)) result.set(row.user_id, row.id);
    }
    return result;
  }

  function cycleView(row) {
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      budgetMode: row.budget_mode,
      budgetPercent: row.budget_percent_points === null ? null : row.budget_percent_points / 100,
      budgetAmountCents: row.budget_amount_cents,
      effectiveDate: row.effective_date,
      proposalDeadline: row.proposal_deadline,
      status: row.status,
      statusLabel: CYCLE_STATUS_LABELS[row.status],
      baseTotalCents: row.base_total_cents,
      openedAt: row.opened_at,
      reviewAt: row.review_at,
      closedAt: row.closed_at,
      createdAt: row.created_at
    };
  }

  /**
   * Was eine HR-Person von einer Runde sieht. Die HR-Leitung bleibt für den HR Business Partner tabu.
   * Fehlen deshalb Zeilen, dürfen auch die Summen sie nicht verraten: Sie gelten dann ohne diese Personen.
   */
  function cycleRowsFor(actor, cycle) {
    const all = participantRows(cycle.id);
    const rows = all.filter(row => hrCanAccess(actor, row));
    return { rows, partial: rows.length < all.length };
  }

  /** Bei einem festen Betrag ließe sich aus dem Anteil am Budget die ausgeblendete Gehaltssumme zurückrechnen. */
  function maskPartialBudget(cycle, view) {
    if (cycle.budget_mode === 'percent') return view;
    return { ...view, budgetCents: null, remainingCents: null, overByCents: null, usedPercent: null };
  }

  function cycleViewFor(cycle, rows, partial) {
    const view = cycleView(cycle);
    if (!partial) return view;
    return { ...view, baseTotalCents: cycle.base_total_cents === null ? null : sumOf(rows, row => row.base_salary_cents), budgetAmountCents: null };
  }

  function overallBudget(cycle, rows, partial = false) {
    const planned = sumOf(rows, plannedIncrease);
    if (!partial) return budgetView(cycle, cycle.base_total_cents || 0, planned);
    return maskPartialBudget(cycle, budgetView(cycle, sumOf(rows, row => row.base_salary_cents), planned));
  }

  /** Bereiche je direkter Führungskraft, damit HR Überschreitungen und fehlende Vorschläge sofort sieht. */
  function budgetAreas(cycle, rows, partial = false) {
    const areas = new Map();
    for (const row of rows) {
      const key = row.manager_id ?? 0;
      if (!areas.has(key)) areas.set(key, { managerId: row.manager_id, managerName: row.manager_name, rows: [] });
      areas.get(key).rows.push(row);
    }
    return [...areas.values()]
      .map(area => {
        const budget = budgetView(cycle, sumOf(area.rows, row => row.base_salary_cents), sumOf(area.rows, plannedIncrease));
        return {
          managerId: area.managerId,
          managerName: area.managerName || 'Ohne Führungskraft',
          participants: area.rows.length,
          missing: area.rows.filter(row => row.user_active === 1 && !row.proposal_id).length,
          ...(partial ? maskPartialBudget(cycle, budget) : budget)
        };
      })
      .sort((left, right) => left.managerName.localeCompare(right.managerName, 'de'));
  }

  function proposalCounts(rows) {
    return {
      participants: rows.length,
      missing: rows.filter(row => !row.proposal_id).length,
      submitted: rows.filter(row => row.proposal_status === 'submitted').length,
      approved: rows.filter(row => row.proposal_status === 'approved').length,
      rejected: rows.filter(row => row.proposal_status === 'rejected').length
    };
  }

  // ---------------------------------------------------------------------------------------
  // Gehaltsrunden: Ablauf
  // ---------------------------------------------------------------------------------------

  function cycleFromBody(body, base = null) {
    const name = body.name !== undefined ? cleanText(body.name, 120) : base?.name;
    if (!name) throw httpProblem(400, 'Bitte gib der Gehaltsrunde einen Namen.');

    const currency = body.currency !== undefined && body.currency !== '' ? parseCurrency(body.currency) : (base?.currency ?? 'EUR');
    if (!currency) throw httpProblem(400, 'Die Währung muss ein dreistelliger Code sein, zum Beispiel EUR.');

    const effectiveDate = body.effectiveDate !== undefined ? body.effectiveDate : base?.effective_date;
    if (!realDate(effectiveDate)) throw httpProblem(400, 'Bitte gib für „Gültig ab“ ein gültiges Datum an.');

    const proposalDeadline = checkedDeadline(body.proposalDeadline !== undefined ? body.proposalDeadline : base?.proposal_deadline, effectiveDate);

    const budgetMode = body.budgetMode !== undefined ? body.budgetMode : base?.budget_mode;
    if (budgetMode !== 'percent' && budgetMode !== 'amount') {
      throw httpProblem(400, 'Das Budget muss in Prozent oder als Betrag angegeben werden.');
    }

    let budgetPercentPoints = null;
    let budgetAmountCents = null;
    if (budgetMode === 'percent') {
      budgetPercentPoints = body.budgetPercent !== undefined ? parsePercentToBasisPoints(body.budgetPercent) : base?.budget_percent_points;
      if (!budgetPercentPoints) throw httpProblem(400, 'Das Budget in Prozent muss größer als 0 und höchstens 100 sein.');
    } else {
      budgetAmountCents = body.budgetAmount !== undefined ? parseMoneyToCents(body.budgetAmount) : base?.budget_amount_cents;
      if (!budgetAmountCents) throw httpProblem(400, 'Das Budget als Betrag muss größer als 0 sein.');
    }

    return { name, currency, effectiveDate, proposalDeadline, budgetMode, budgetPercentPoints, budgetAmountCents };
  }

  function checkedDeadline(value, effectiveDate) {
    if (value === undefined || value === null || value === '') return null;
    if (!realDate(value)) throw httpProblem(400, 'Bitte gib für die Frist ein gültiges Datum an.');
    if (value > effectiveDate) throw httpProblem(400, 'Die Frist für Vorschläge muss spätestens am Gültig-ab-Datum enden.');
    return value;
  }

  /** Personen, die zu einer Runde gehören können: aktiv und mit einem Eintrag in dieser Währung zum Gültig-ab-Datum der Runde. */
  function eligiblePeople(currency, effectiveDate) {
    const records = recordsAsOf(effectiveDate);
    return activePeople().flatMap(person => {
      const record = records.get(person.id);
      return record && record.currency === currency ? [{ person, record }] : [];
    });
  }

  /** Warum sich diese Runde gerade nicht öffnen lässt, oder null. */
  function openBlockedReason(cycle) {
    const running = db.prepare("SELECT id FROM compensation_cycles WHERE currency=? AND status IN ('open','review') AND id<>?").get(cycle.currency, cycle.id);
    if (running) return 'In dieser Währung läuft schon eine Gehaltsrunde. Schließe sie zuerst ab.';
    // Eine Runde vor einer schon beschlossenen würde deren Beträge nicht kennen und Gehälter später wieder senken.
    const later = db.prepare("SELECT name, effective_date FROM compensation_cycles WHERE currency=? AND status='closed' AND effective_date>? AND id<>? ORDER BY effective_date DESC, id DESC LIMIT 1")
      .get(cycle.currency, cycle.effective_date, cycle.id);
    if (later) {
      return `Die Runde „${later.name}“ gilt schon ab ${germanDate(later.effective_date)}. Wähle für diese Runde ein Gültig-ab-Datum ab diesem Tag, sonst gingen ihre Erhöhungen später wieder verloren.`;
    }
    return null;
  }

  const addParticipant = (cycleId, personId, record) => db.prepare(`
    INSERT INTO compensation_cycle_participants(cycle_id, user_id, baseline_record_id, base_salary_cents, currency, grade_id, fte_basis_points, variable_target_cents)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(cycleId, personId, record.id, record.annual_salary_cents, record.currency, record.grade_id, record.fte_basis_points, record.variable_target_cents);

  const isActiveProposer = userId => Boolean(db.prepare(`SELECT id FROM users WHERE id=? AND is_system_account=0 AND active=1 AND role IN ('manager','director','hr_admin')`).get(userId));

  /** Heißt die Runde schon „Gehaltsrunde …“, steht das Wort sonst doppelt im Aufgabentitel. */
  const roundLabel = cycle => (/gehaltsrunde/i.test(cycle.name) ? `„${cycle.name}“` : `Gehaltsrunde „${cycle.name}“`);

  function proposalTaskTitle(cycle, names) {
    return `${roundLabel(cycle)}: ${names.length === 1 ? 'Vorschlag' : 'Vorschläge'} für ${peopleText(names)} abgeben`;
  }

  /**
   * Hält die Aufgaben einer offenen Runde passend: Wer noch Vorschläge abgeben muss, hat genau eine
   * offene Aufgabe, die alle noch fehlenden Personen nennt. Jede andere Aufgabe dieser Runde schließt sich.
   * Gibt zurück, wie viele Aufgaben neu entstanden sind.
   */
  function syncProposalTasks(cycle) {
    const missing = new Map();
    for (const row of participantRows(cycle.id)) {
      if (row.user_active !== 1 || row.proposal_id || !row.manager_id) continue;
      if (!missing.has(row.manager_id)) missing.set(row.manager_id, []);
      missing.get(row.manager_id).push(row.name);
    }
    const openTasks = db.prepare("SELECT id, user_id FROM tasks WHERE type='compensation_proposal' AND entity_id=? AND done=0").all(cycle.id);
    for (const task of openTasks) {
      const names = missing.get(task.user_id);
      if (names && isActiveProposer(task.user_id)) {
        db.prepare('UPDATE tasks SET title=?, due_date=? WHERE id=?').run(proposalTaskTitle(cycle, names), cycle.proposal_deadline ?? null, task.id);
      } else {
        db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(task.id);
      }
    }
    const withTask = new Set(openTasks.map(task => task.user_id));
    let created = 0;
    for (const [leaderId, names] of missing) {
      if (withTask.has(leaderId) || !isActiveProposer(leaderId)) continue;
      createTask(leaderId, proposalTaskTitle(cycle, names), 'compensation_proposal', cycle.id, cycle.proposal_deadline);
      created += 1;
    }
    return created;
  }

  /** Öffnet eine Runde: Teilnehmende und Ausgangsgehälter werden festgeschrieben, Führungskräfte bekommen eine Aufgabe. */
  function openCycle(cycle, actorId, excludedIds = []) {
    const excluded = new Set(excludedIds);
    const entries = eligiblePeople(cycle.currency, cycle.effective_date).filter(entry => !excluded.has(entry.person.id));
    if (!entries.length) throw httpProblem(409, `Es gibt keine Teilnehmenden: Niemand hat zum ${germanDate(cycle.effective_date)} eine Vergütung in dieser Währung.`);

    const blocked = openBlockedReason(cycle);
    if (blocked) throw httpProblem(409, blocked);

    const baseTotalCents = sumOf(entries, entry => entry.record.annual_salary_cents);

    return db.transaction(() => {
      const timestamp = nowIso();
      const claimed = db.prepare("UPDATE compensation_cycles SET status='open', base_total_cents=?, opened_at=?, opened_by=?, updated_at=? WHERE id=? AND status='draft'")
        .run(baseTotalCents, timestamp, actorId, timestamp, cycle.id);
      if (claimed.changes !== 1) throw httpProblem(409, 'Diese Gehaltsrunde wurde schon geöffnet.');

      for (const { person, record } of entries) addParticipant(cycle.id, person.id, record);
      return { participants: entries.length, tasks: syncProposalTasks(cycle) };
    })();
  }

  /** Nimmt jemanden nachträglich in eine offene Runde auf, zum Beispiel wer erst nach dem Öffnen eingestellt wurde. */
  function addToOpenCycle(cycle, person, actor) {
    const record = recordsAsOf(cycle.effective_date).get(person.id);
    if (!record) throw httpProblem(409, `Für diese Person gibt es zum ${germanDate(cycle.effective_date)} keinen Vergütungseintrag. Lege zuerst einen an.`);
    if (record.currency !== cycle.currency) throw httpProblem(409, 'Der Vergütungseintrag dieser Person hat eine andere Währung als die Runde.');

    return db.transaction(() => {
      const known = db.prepare('SELECT user_id FROM compensation_cycle_participants WHERE cycle_id=? AND user_id=?').get(cycle.id, person.id);
      if (known) throw httpProblem(409, 'Diese Person nimmt schon an der Runde teil.');
      const claimed = db.prepare("UPDATE compensation_cycles SET base_total_cents=COALESCE(base_total_cents,0)+?, updated_at=? WHERE id=? AND status='open'")
        .run(record.annual_salary_cents, nowIso(), cycle.id);
      if (claimed.changes !== 1) throw httpProblem(409, 'Personen lassen sich nur in eine offene Runde aufnehmen.');
      addParticipant(cycle.id, person.id, record);
      syncProposalTasks(cycle);
      log(actor.id, 'compensation_cycle_participant_added', 'compensation_cycles', cycle.id, null, { userId: person.id });
    })();
  }

  /** Wer nicht in der Runde ist: Aufnehmen geht nur mit einem passenden Vergütungseintrag zum Gültig-ab-Datum. */
  function peopleOutsideCycle(cycle, rows, actor) {
    const inRound = new Set(rows.map(row => row.user_id));
    const records = recordsAsOf(cycle.effective_date);
    const addable = [];
    const withoutEntry = [];
    for (const person of activePeople().filter(item => hrCanAccess(actor, item) && !inRound.has(item.id))) {
      const summary = { userId: person.id, name: person.name, title: person.title };
      if (records.get(person.id)?.currency === cycle.currency) addable.push(summary);
      else withoutEntry.push(summary);
    }
    return { addable, withoutEntry };
  }

  function closeProposalTasks(cycleId) {
    db.prepare("UPDATE tasks SET done=1 WHERE type='compensation_proposal' AND entity_id=? AND done=0").run(cycleId);
  }

  function resultNoticeTitle(cycle, team) {
    const rejected = team.filter(row => row.proposal_status === 'rejected').map(row => row.name);
    if (rejected.length) {
      return `${roundLabel(cycle)} ist entschieden: ${rejected.length === 1 ? 'Vorschlag' : 'Vorschläge'} für ${peopleText(rejected)} abgelehnt`;
    }
    return `${roundLabel(cycle)} ist entschieden: Ergebnis für ${peopleText(team.map(row => row.name))}`;
  }

  /** Beim Abschluss erfährt jede Führungskraft, wie die Runde für ihr Team ausgegangen ist. Beträge stehen nur in der Ansicht. */
  function notifyLeadersOfResult(cycle, rows, actor) {
    const teams = new Map();
    for (const row of rows) {
      if (row.user_active !== 1 || !row.manager_id) continue;
      if (!teams.has(row.manager_id)) teams.set(row.manager_id, []);
      teams.get(row.manager_id).push(row);
    }
    for (const [leaderId, team] of teams) {
      if (leaderId === actor.id || !isActiveProposer(leaderId)) continue;
      createTask(leaderId, resultNoticeTitle(cycle, team), 'compensation_result_notice', cycle.id);
    }
  }

  /** Der Stand zum Gültig-ab-Datum kann sich seit dem Öffnen geändert haben. Die Runde darf ihn dann nicht unterschreiten. */
  function loweredSalaries(cycle, rows) {
    const records = recordsAsOf(cycle.effective_date);
    return rows.filter(row => {
      const record = records.get(row.user_id);
      return record && record.id !== row.baseline_record_id && record.currency === row.currency && plannedSalary(row) < record.annual_salary_cents;
    });
  }

  /** Betrag oder Prozent, immer auf das tatsächliche Jahresgehalt bezogen. */
  function increaseFromBody(body, baseSalaryCents) {
    if (body.mode === 'amount') {
      const increaseCents = parseMoneyToCents(body.value);
      if (increaseCents === null) throw httpProblem(400, 'Die Erhöhung muss ein Betrag ab 0 mit höchstens zwei Nachkommastellen sein.');
      return checkedIncrease({ mode: 'amount', percentPoints: null, increaseCents }, baseSalaryCents);
    }
    if (body.mode === 'percent') {
      const percentPoints = parsePercentToBasisPoints(body.value);
      if (percentPoints === null) throw httpProblem(400, 'Die Erhöhung muss zwischen 0 und 100 Prozent liegen, mit höchstens zwei Nachkommastellen.');
      return checkedIncrease({ mode: 'percent', percentPoints, increaseCents: mulDivRound(baseSalaryCents, percentPoints, BASIS_POINTS) }, baseSalaryCents);
    }
    throw httpProblem(400, 'Bitte gib die Erhöhung als Betrag oder in Prozent an.');
  }

  function checkedIncrease(increase, baseSalaryCents) {
    if (baseSalaryCents + increase.increaseCents > MAX_CENTS) throw httpProblem(400, 'Das neue Gehalt wäre zu hoch.');
    return increase;
  }

  function closeCycle(cycle, actor) {
    return db.transaction(() => {
      const timestamp = nowIso();
      // Dieser Schritt macht den Abschluss einmalig: Nur eine Anfrage kann "in Prüfung" nach "abgeschlossen" setzen.
      const claimed = db.prepare("UPDATE compensation_cycles SET status='closed', closed_at=?, closed_by=?, updated_at=? WHERE id=? AND status='review'")
        .run(timestamp, actor.id, timestamp, cycle.id);
      if (claimed.changes !== 1) throw httpProblem(409, 'Nur eine Runde in Prüfung kann abgeschlossen werden. Sie wird nie zweimal abgeschlossen.');
      db.prepare("UPDATE tasks SET done=1 WHERE type='compensation_decision' AND entity_id=? AND done=0").run(cycle.id);

      const rows = participantRows(cycle.id);
      const undecided = rows.filter(row => row.proposal_status === 'submitted').length;
      if (undecided) throw httpProblem(409, undecided === 1 ? 'Es ist noch 1 Vorschlag ohne Entscheidung.' : `Es sind noch ${undecided} Vorschläge ohne Entscheidung.`);

      const approved = rows.filter(item => item.proposal_status === 'approved');
      const lowered = loweredSalaries(cycle, approved.filter(row => row.user_active === 1));
      if (lowered.length) {
        const who = peopleText(lowered.map(row => row.name));
        throw httpProblem(409, `Bei ${who} läge das neue Gehalt unter dem Stand zum ${germanDate(cycle.effective_date)}, weil seit dem Öffnen ein neuer Eintrag dazugekommen ist. Entscheide neu: ändern oder ablehnen.`);
      }

      let created = 0;
      let skippedInactive = 0;
      for (const row of approved) {
        if (row.user_active !== 1) {
          skippedInactive += 1;
          continue;
        }
        const recordId = insertRecord({
          effectiveDate: cycle.effective_date,
          annualSalaryCents: plannedSalary(row),
          currency: row.currency,
          gradeId: row.grade_id,
          fteBasisPoints: row.fte_basis_points,
          variableTargetCents: row.variable_target_cents,
          reason: 'cycle'
        }, row.user_id, actor.id, cycle.id);
        log(actor.id, 'compensation_record_created', 'compensation_records', recordId, null, { userId: row.user_id, source: 'cycle' });
        created += 1;
      }
      // Ab jetzt zählt, wer beim Abschluss zuständig war: Eine spätere Führungskraft liest keine alten Runden.
      db.prepare('UPDATE compensation_cycle_participants SET result_manager_id=(SELECT manager_id FROM users WHERE users.id=compensation_cycle_participants.user_id) WHERE cycle_id=?').run(cycle.id);
      closeProposalTasks(cycle.id);
      notifyLeadersOfResult(cycle, rows, actor);
      log(actor.id, 'compensation_cycle_closed', 'compensation_cycles', cycle.id, null, { recordsCreated: created });
      return { created, skippedInactive };
    })();
  }

  // Wechselt die Führungskraft, wandert die offene Aufgabe zur Runde mit.
  deps.onManagerChanged?.(({ userId }) => {
    const rounds = db.prepare(`
      SELECT c.* FROM compensation_cycles c
      JOIN compensation_cycle_participants p ON p.cycle_id = c.id
      WHERE c.status = 'open' AND p.user_id = ?
    `).all(userId);
    for (const cycle of rounds) syncProposalTasks(cycle);
  });

  /** Fängt auf, was am Modul vorbeiläuft, etwa gesperrte Konten oder ältere Daten ohne passende Aufgabe. */
  function maintenance() {
    for (const cycle of db.prepare("SELECT * FROM compensation_cycles WHERE status='open'").all()) {
      db.transaction(() => syncProposalTasks(cycle))();
    }
  }

  function directParticipants(cycleId, leaderId) {
    return participantRows(cycleId).filter(row => row.manager_id === leaderId && row.user_active === 1 && row.user_id !== leaderId);
  }

  function openRoundsForLeader(actor) {
    if (!canPropose(actor)) return [];
    return db.prepare(`
      SELECT DISTINCT c.*
      FROM compensation_cycles c
      JOIN compensation_cycle_participants p ON p.cycle_id = c.id
      JOIN users u ON u.id = p.user_id
      WHERE c.status = 'open' AND u.manager_id = ? AND u.active = 1 AND u.id <> ?
      ORDER BY c.effective_date, c.id
    `).all(actor.id, actor.id);
  }

  /**
   * Sicht einer direkten Führungskraft auf eine offene Runde. Für die gesamte Runde gibt es
   * nur den Anteil des verplanten Budgets und auch das nur, wenn außerhalb des eigenen Teams
   * genug Personen sind, damit sich daraus keine Einzelwerte ableiten lassen.
   */
  function leaderRoundView(cycle, actor) {
    const allRows = participantRows(cycle.id);
    const rows = allRows.filter(row => row.manager_id === actor.id && row.user_active === 1 && row.user_id !== actor.id);
    // Liegen außerhalb des eigenen Teams nur wenige Vorschläge vor, verrät jede Änderung des Anteils einen Einzelwert.
    const foreignProposals = allRows.filter(row => row.proposal_id && row.manager_id !== actor.id && row.user_id !== actor.id).length;
    const overall = overallBudget(cycle, allRows);
    const roughShare = share => (share === null ? null : Math.round(share / 5) * 5);
    return {
      cycle: leaderCycleView(cycle),
      budget: {
        area: budgetView(cycle, sumOf(rows, row => row.base_salary_cents), sumOf(rows, plannedIncrease)),
        overall: foreignProposals >= MIN_GROUP_SIZE ? { usedPercent: roughShare(overall.usedPercent), overBudget: overall.overBudget } : null
      },
      missingProposals: rows.filter(row => !row.proposal_id).length,
      rows: rows.map(worksheetRow)
    };
  }

  function leaderCycleView(cycle) {
    return {
      id: cycle.id,
      name: cycle.name,
      currency: cycle.currency,
      effectiveDate: cycle.effective_date,
      proposalDeadline: cycle.proposal_deadline,
      status: cycle.status,
      statusLabel: CYCLE_STATUS_LABELS[cycle.status]
    };
  }

  /** Wen eine Führungskraft im Ergebnis einer Runde sieht: nur die eigenen direkten Leute. */
  function resultRowsFor(cycle, actor) {
    return participantRows(cycle.id).filter(row => {
      if (row.manager_id !== actor.id || row.user_active !== 1 || row.user_id === actor.id) return false;
      if (cycle.status !== 'closed') return true;
      // Ältere Runden kennen die Zuständigkeit beim Abschluss noch nicht. Dort zählt, wer vorgeschlagen hat.
      return (row.result_manager_id ?? row.proposed_by_id) === actor.id;
    });
  }

  function resultKey(row, cycle) {
    if (!row.proposal_id) return 'none';
    if (cycle.status !== 'closed') return 'pending';
    if (row.proposal_status === 'rejected') return 'rejected';
    return row.changed_by_hr ? 'changed' : 'approved';
  }

  /** In der Prüfung kann HR noch umentscheiden. Deshalb gibt es Ergebnis und Begründung erst nach dem Abschluss. */
  function resultRowView(row, cycle) {
    const closed = cycle.status === 'closed';
    const result = resultKey(row, cycle);
    return {
      userId: row.user_id,
      name: row.name,
      title: row.title,
      currency: row.currency,
      baseSalaryCents: row.base_salary_cents,
      proposal: row.proposal_id ? {
        percent: row.input_percent_points === null ? null : row.input_percent_points / 100,
        increaseCents: row.increase_cents,
        proposedSalaryCents: row.proposed_salary_cents,
        reason: row.proposal_reason
      } : null,
      result,
      resultLabel: RESULT_LABELS[result],
      finalSalaryCents: closed ? plannedSalary(row) : null,
      decisionReason: closed ? row.decision_reason : null,
      decidedBy: closed ? row.decided_by_name : null
    };
  }

  /** Entschiedene oder gerade geprüfte Runden, an denen Leute dieser Führungskraft teilgenommen haben. Neueste zuerst. */
  function resultRoundsForLeader(actor) {
    if (!canPropose(actor)) return [];
    const cycles = db.prepare("SELECT * FROM compensation_cycles WHERE status IN ('review','closed') ORDER BY effective_date DESC, id DESC").all();
    return cycles.flatMap(cycle => {
      const rows = resultRowsFor(cycle, actor);
      return rows.length ? [{ cycle: leaderCycleView(cycle), rows: rows.map(row => resultRowView(row, cycle)) }] : [];
    });
  }

  /**
   * Summen für Vorgesetzte weiter oben. Direkte Mitarbeitende zählen bewusst nicht mit: Ihre
   * Werte sind in einer offenen Runde sichtbar, die Differenz würde sonst Einzelwerte verraten.
   */
  function areaSummary(actor) {
    const group = new Set(indirectReportIds(actor));
    const currentRecords = currentRecordsByUser();
    const byCurrency = new Map();
    for (const userId of group) {
      const record = currentRecords.get(userId);
      if (!record) continue;
      if (!byCurrency.has(record.currency)) byCurrency.set(record.currency, []);
      byCurrency.get(record.currency).push(record);
    }
    const totals = [...byCurrency.entries()]
      .filter(([, records]) => records.length >= MIN_GROUP_SIZE)
      .map(([currency, records]) => ({
        currency,
        people: records.length,
        annualSalaryCents: sumOf(records, record => record.annual_salary_cents),
        variableTargetCents: sumOf(records, record => record.variable_target_cents)
      }));

    const openCycles = db.prepare("SELECT * FROM compensation_cycles WHERE status='open' ORDER BY effective_date, id").all();
    const rounds = openCycles.flatMap(cycle => {
      const rows = participantRows(cycle.id).filter(row => group.has(row.user_id) && row.user_active === 1);
      if (rows.length < MIN_GROUP_SIZE) return [];
      // Weicht die Runde nur um wenige Personen von der Gesamtsumme ab, würde die Differenz Einzelwerte verraten.
      const notInRound = (byCurrency.get(cycle.currency)?.length ?? 0) - rows.length;
      if (notInRound > 0 && notInRound < MIN_GROUP_SIZE) return [];

      const proposals = rows.filter(row => row.proposal_id).length;
      const budget = budgetView(cycle, sumOf(rows, row => row.base_salary_cents), sumOf(rows, plannedIncrease));
      return [{
        cycleId: cycle.id,
        name: cycle.name,
        currency: cycle.currency,
        people: rows.length,
        proposals,
        baseCents: budget.baseCents,
        budgetCents: budget.budgetCents,
        // Bei wenigen Vorschlägen wäre die Summe praktisch ein Einzelwert.
        planned: proposals >= MIN_GROUP_SIZE ? {
          plannedCents: budget.plannedCents,
          remainingCents: budget.remainingCents,
          overBudget: budget.overBudget,
          overByCents: budget.overByCents,
          usedPercent: budget.usedPercent
        } : null
      }];
    });

    return { minGroupSize: MIN_GROUP_SIZE, suppressed: totals.length === 0 && rounds.length === 0, totals, rounds };
  }

  // ---------------------------------------------------------------------------------------
  // Demo-Daten
  // ---------------------------------------------------------------------------------------

  function seedDemo() {
    const people = db.prepare('SELECT id, role, manager_id FROM users WHERE is_system_account=0 AND active=1 ORDER BY id').all();
    if (!people.length) return;
    if (db.prepare('SELECT id FROM compensation_grades LIMIT 1').get()) return;

    const today = todayIso();
    const thisYear = Number(today.slice(0, 4));
    const addGrade = db.prepare('INSERT INTO compensation_grades(name, currency, min_cents, mid_cents, max_cents, valid_from, active, created_at, updated_at) VALUES(?,?,?,?,?,?,1,?,?)');
    const gradeIds = {};
    const timestamp = nowIso();
    for (const [key, name, min, mid, max] of [
      ['A', 'Stufe A', 3_600_000, 4_400_000, 5_200_000],
      ['B', 'Stufe B', 4_800_000, 5_800_000, 6_800_000],
      ['C', 'Stufe C', 6_200_000, 7_500_000, 8_800_000],
      ['D', 'Stufe D', 8_500_000, 10_500_000, 12_500_000]
    ]) {
      gradeIds[key] = addGrade.run(name, 'EUR', min, mid, max, `${thisYear - 3}-01-01`, timestamp, timestamp).lastInsertRowid;
    }
    const midpoints = { A: 4_400_000, B: 5_800_000, C: 7_500_000, D: 10_500_000 };
    const gradeKeyFor = (person, index) => {
      if (person.role === 'director' || person.role === 'hr_admin') return 'D';
      if (person.role === 'manager' || person.role === 'hrbp') return 'C';
      return index % 2 ? 'B' : 'A';
    };
    // Der Stellenanteil folgt der Akte, wenn es sie gibt. Sonst widersprechen sich Vergütung und Personalakte.
    const demoWorkingShare = personId => {
      try {
        const hours = db.prepare('SELECT weekly_hours FROM personnel_records WHERE user_id=?').get(personId)?.weekly_hours;
        return hours ? Math.round((Number(hours) / 40) * BASIS_POINTS) : null;
      } catch {
        return null;
      }
    };
    // Erfundene Werte rund um die Bandmitte. Jede Person liegt etwas anders, eine bewusst über dem Band.
    const shares = [92, 104, 98, 110, 95, 101, 107, 97];

    db.transaction(() => {
      people.forEach((person, index) => {
        const gradeKey = gradeKeyFor(person, index);
        const fteBasisPoints = demoWorkingShare(person.id) ?? (index % 7 === 3 ? 8000 : BASIS_POINTS);
        const share = index === 4 ? 125 : shares[index % shares.length];
        const fullTimeCents = mulDivRound(midpoints[gradeKey], share, 100);
        const annualSalaryCents = mulDivRound(fullTimeCents, fteBasisPoints, BASIS_POINTS);
        const base = {
          currency: 'EUR',
          gradeId: gradeIds[gradeKey],
          fteBasisPoints,
          variableTargetCents: person.role === 'employee' ? 0 : 500_000
        };
        insertRecord({ ...base, effectiveDate: `${thisYear - 2}-01-01`, annualSalaryCents: mulDivRound(annualSalaryCents, 96, 100), reason: 'other' }, person.id, null);
        insertRecord({ ...base, effectiveDate: `${thisYear}-01-01`, annualSalaryCents, reason: 'cycle' }, person.id, null);
      });
      const effectiveDate = `${thisYear + 1}-01-01`;
      const inTwoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const cycleId = db.prepare(`
        INSERT INTO compensation_cycles(name, currency, budget_mode, budget_percent_points, effective_date, proposal_deadline, created_at, updated_at)
        VALUES(?, 'EUR', 'percent', 300, ?, ?, ?, ?)
      `).run(`Gehaltsrunde ${thisYear + 1} (Beispiel)`, effectiveDate, inTwoWeeks <= effectiveDate ? inTwoWeeks : null, timestamp, timestamp).lastInsertRowid;
      openCycle(cycleById(cycleId), null);
    })();
  }

  // ---------------------------------------------------------------------------------------
  // Schnittstellen
  // ---------------------------------------------------------------------------------------

  // Gehaltsdaten sollen nicht im Zwischenspeicher des Browsers oder eines Proxys liegen bleiben.
  const noStore = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  router.use('/compensation', auth, noStore);

  // Was die Oberfläche anzeigen darf. Enthält selbst keine Vergütungsdaten.
  router.get('/compensation/access', (req, res) => {
    const actor = current(req);
    const leader = LEADER_ROLES.includes(actor.role);
    res.json({
      readAll: isHr(actor),
      canWrite: canWrite(actor),
      canExport: canExport(actor),
      openRounds: openRoundsForLeader(actor).map(cycle => ({ id: cycle.id, name: cycle.name })),
      resultRounds: resultRoundsForLeader(actor).map(round => ({ id: round.cycle.id, name: round.cycle.name })),
      areaSummary: leader && !areaSummary(actor).suppressed
    });
  });

  router.get('/compensation/me', (req, res) => {
    res.json(ownCompensation(current(req).id));
  });

  // --- Bänder ------------------------------------------------------------------------------

  router.get('/compensation/grades', requireHrRead, (req, res) => {
    const rows = db.prepare('SELECT * FROM compensation_grades ORDER BY active DESC, name, valid_from DESC').all();
    res.json({ grades: rows.map(gradeView) });
  });

  router.post('/compensation/grades', requireHrWrite, (req, res) => {
    const actor = current(req);
    try {
      const grade = gradeFromBody(req.body || {});
      assertGradeNameFree(grade.name, grade.validFrom);
      const timestamp = nowIso();
      const id = db.prepare(`
        INSERT INTO compensation_grades(name, currency, min_cents, mid_cents, max_cents, valid_from, active, created_by, updated_by, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(grade.name, grade.currency, grade.minCents, grade.midCents, grade.maxCents, grade.validFrom, grade.active, actor.id, actor.id, timestamp, timestamp).lastInsertRowid;
      log(actor.id, 'compensation_grade_created', 'compensation_grades', id);
      res.status(201).json({ grade: gradeView(gradeById(id)) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.patch('/compensation/grades/:id', requireHrWrite, (req, res) => {
    const actor = current(req);
    const before = gradeById(asId(req.params.id));
    if (!before) return res.status(404).json({ error: 'Dieses Gehaltsband gibt es nicht.' });
    try {
      const grade = gradeFromBody(req.body || {}, before);
      assertGradeNameFree(grade.name, grade.validFrom, before.id);
      if (grade.currency !== before.currency) {
        const inUse = db.prepare('SELECT id FROM compensation_records WHERE grade_id=? LIMIT 1').get(before.id);
        if (inUse) throw httpProblem(409, 'Die Währung lässt sich nicht ändern, weil das Band schon verwendet wird.');
      }
      db.prepare(`
        UPDATE compensation_grades SET name=?, currency=?, min_cents=?, mid_cents=?, max_cents=?, valid_from=?, active=?, updated_by=?, updated_at=? WHERE id=?
      `).run(grade.name, grade.currency, grade.minCents, grade.midCents, grade.maxCents, grade.validFrom, grade.active, actor.id, nowIso(), before.id);
      log(actor.id, 'compensation_grade_updated', 'compensation_grades', before.id);
      res.json({ grade: gradeView(gradeById(before.id)) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  // --- Personen und Historie ---------------------------------------------------------------

  router.get('/compensation/people', requireHrRead, (req, res) => {
    const actor = current(req);
    const currentRecords = currentRecordsByUser();
    const futureRecords = futureRecordsByUser();
    res.json({
      people: activePeople().filter(person => hrCanAccess(actor, person)).map(person => {
        const record = currentRecords.get(person.id);
        return {
          id: person.id,
          name: person.name,
          title: person.title,
          isSelf: person.id === actor.id,
          current: record ? hrRecordView(record) : null,
          next: upcomingView(futureRecords.get(person.id)?.[0])
        };
      })
    });
  });

  router.get('/compensation/people/:userId', (req, res) => {
    const actor = current(req);
    const userId = asId(req.params.userId);
    if (!isHr(actor)) {
      if (userId !== actor.id) return res.status(403).json({ error: 'Du kannst nur deine eigene Vergütung sehen.' });
      return res.json(ownCompensation(actor.id));
    }
    const person = personById(userId);
    if (!person) return res.status(404).json({ error: 'Person nicht gefunden.' });
    if (!hrCanAccess(actor, person)) return res.status(403).json({ error: 'Diese Vergütung sieht nur die HR-Administration.' });
    const history = recordsOf(person.id).map(hrRecordView);
    const later = history.filter(record => record.future).at(-1);
    res.json({
      person: { id: person.id, name: person.name, title: person.title, active: Boolean(person.active), isSelf: person.id === actor.id },
      current: history.find(record => !record.future) || null,
      next: later ? { effectiveDate: later.effectiveDate, annualSalaryCents: later.annualSalaryCents, currency: later.currency, reasonLabel: later.reasonLabel } : null,
      entryDefaults: entryDefaults(history),
      history
    });
  });

  router.post('/compensation/people/:userId/records', requireHrWrite, (req, res) => {
    const actor = current(req);
    const person = personById(asId(req.params.userId));
    if (!person || !person.active) return res.status(404).json({ error: 'Person nicht gefunden.' });
    if (person.id === actor.id) {
      return res.status(403).json({ error: 'Deine eigene Vergütung muss jemand anderes eintragen (Vier-Augen-Prinzip).' });
    }
    try {
      const record = recordFromBody(req.body || {});
      const id = insertRecord(record, person.id, actor.id);
      log(actor.id, 'compensation_record_created', 'compensation_records', id, null, { userId: person.id });
      const view = hrRecordView(db.prepare(`${RECORD_SELECT} WHERE r.id=?`).get(id));
      res.status(201).json({ record: view, warnings: view.warnings });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  // --- Gehaltsrunden: HR -------------------------------------------------------------------

  router.get('/compensation/cycles', requireHrRead, (req, res) => {
    const actor = current(req);
    const cycles = db.prepare('SELECT * FROM compensation_cycles ORDER BY effective_date DESC, id DESC').all();
    res.json({
      cycles: cycles.map(cycle => {
        const { rows, partial } = cycleRowsFor(actor, cycle);
        return {
          ...cycleViewFor(cycle, rows, partial),
          counts: proposalCounts(rows),
          budget: cycle.status === 'draft' ? null : overallBudget(cycle, rows, partial)
        };
      })
    });
  });

  router.post('/compensation/cycles', requireHrWrite, (req, res) => {
    const actor = current(req);
    try {
      const cycle = cycleFromBody(req.body || {});
      const timestamp = nowIso();
      const id = db.prepare(`
        INSERT INTO compensation_cycles(name, currency, budget_mode, budget_percent_points, budget_amount_cents, effective_date, proposal_deadline, created_by, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(cycle.name, cycle.currency, cycle.budgetMode, cycle.budgetPercentPoints, cycle.budgetAmountCents, cycle.effectiveDate, cycle.proposalDeadline, actor.id, timestamp, timestamp).lastInsertRowid;
      log(actor.id, 'compensation_cycle_created', 'compensation_cycles', id);
      res.status(201).json({ cycle: cycleView(cycleById(id)) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.get('/compensation/cycles/:id', requireHrRead, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    const { rows, partial } = cycleRowsFor(actor, cycle);
    const latestRecordIds = latestRecordIdsByUser();
    const draft = cycle.status === 'draft';
    const eligible = draft
      ? eligiblePeople(cycle.currency, cycle.effective_date)
        .filter(({ person }) => hrCanAccess(actor, person))
        .map(({ person }) => ({ userId: person.id, name: person.name, title: person.title, isSelf: person.id === actor.id }))
      : [];
    res.json({
      cycle: cycleViewFor(cycle, rows, partial),
      counts: proposalCounts(rows),
      eligible,
      openBlockedReason: draft ? openBlockedReason(cycle) : null,
      outside: cycle.status === 'open' && canWrite(actor) ? peopleOutsideCycle(cycle, rows, actor) : { addable: [], withoutEntry: [] },
      decisionRule: {
        ownProposalsDenied: ownProposalsDenied(),
        otherHrAdministrators: otherHrAdministrators(actor)
      },
      partial,
      budget: draft ? null : { overall: overallBudget(cycle, rows, partial), areas: budgetAreas(cycle, rows, partial) },
      participants: rows.map(row => hrParticipantView(row, actor, latestRecordIds, cycle))
    });
  });

  router.patch('/compensation/cycles/:id', requireHrWrite, (req, res) => {
    const actor = current(req);
    const before = cycleById(asId(req.params.id));
    if (!before) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    const body = req.body || {};
    const onlyDeadline = before.status === 'open' && Object.keys(body).length === 1 && 'proposalDeadline' in body;
    if (before.status !== 'draft' && !onlyDeadline) return res.status(409).json({ error: 'Nur ein Entwurf lässt sich noch ändern. In einer offenen Runde geht nur noch die Frist.' });
    try {
      if (onlyDeadline) {
        const deadline = checkedDeadline(body.proposalDeadline, before.effective_date);
        db.transaction(() => {
          db.prepare("UPDATE compensation_cycles SET proposal_deadline=?, updated_at=? WHERE id=? AND status='open'").run(deadline, nowIso(), before.id);
          syncProposalTasks(cycleById(before.id));
          log(actor.id, 'compensation_cycle_updated', 'compensation_cycles', before.id);
        })();
        return res.json({ cycle: cycleView(cycleById(before.id)) });
      }
      const cycle = cycleFromBody(body, before);
      db.prepare(`
        UPDATE compensation_cycles SET name=?, currency=?, budget_mode=?, budget_percent_points=?, budget_amount_cents=?, effective_date=?, proposal_deadline=?, updated_at=? WHERE id=? AND status='draft'
      `).run(cycle.name, cycle.currency, cycle.budgetMode, cycle.budgetPercentPoints, cycle.budgetAmountCents, cycle.effectiveDate, cycle.proposalDeadline, nowIso(), before.id);
      log(actor.id, 'compensation_cycle_updated', 'compensation_cycles', before.id);
      res.json({ cycle: cycleView(cycleById(before.id)) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.post('/compensation/cycles/:id/participants', requireHrWrite, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    if (cycle.status !== 'open') return res.status(409).json({ error: 'Personen lassen sich nur in eine offene Runde aufnehmen.' });
    const person = personById(asId(req.body?.userId));
    if (!person || !person.active) return res.status(404).json({ error: 'Person nicht gefunden.' });
    try {
      addToOpenCycle(cycle, person, actor);
      const row = participantRows(cycle.id).find(item => item.user_id === person.id);
      res.status(201).json({ participant: hrParticipantView(row, actor, latestRecordIdsByUser(), cycleById(cycle.id)) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.post('/compensation/cycles/:id/open', requireHrWrite, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    if (cycle.status !== 'draft') return res.status(409).json({ error: 'Nur ein Entwurf lässt sich öffnen.' });

    const requested = req.body?.excludeUserIds;
    if (requested !== undefined && !Array.isArray(requested)) return res.status(400).json({ error: 'Die Ausnahmen müssen eine Liste sein.' });
    const excludedIds = (requested || []).map(asId);
    if (excludedIds.includes(null)) return res.status(400).json({ error: 'Die Liste der Ausnahmen enthält ungültige Einträge.' });

    try {
      const result = openCycle(cycle, actor.id, excludedIds);
      log(actor.id, 'compensation_cycle_opened', 'compensation_cycles', cycle.id, null, { participants: result.participants });
      res.json({ cycle: cycleView(cycleById(cycle.id)), ...result });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.post('/compensation/cycles/:id/review', requireHrWrite, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    const timestamp = nowIso();
    const moved = db.transaction(() => {
      const claimed = db.prepare("UPDATE compensation_cycles SET status='review', review_at=?, review_by=?, updated_at=? WHERE id=? AND status='open'")
        .run(timestamp, actor.id, timestamp, cycle.id);
      if (claimed.changes !== 1) return false;
      closeProposalTasks(cycle.id);
      log(actor.id, 'compensation_cycle_review_started', 'compensation_cycles', cycle.id);
      return true;
    })();
    if (!moved) return res.status(409).json({ error: 'Nur eine offene Runde kann in die Prüfung gehen.' });
    res.json({ cycle: cycleView(cycleById(cycle.id)) });
  });

  router.post('/compensation/cycles/:id/close', requireHrWrite, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    try {
      const result = closeCycle(cycle, actor);
      res.json({ cycle: cycleView(cycleById(cycle.id)), ...result });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  function saveDecision({ cycle, row, actor, status, finalSalaryCents, changedByHr, decisionReason }) {
    db.prepare(`
      UPDATE compensation_proposals SET status=?, final_salary_cents=?, changed_by_hr=?, decision_reason=?, decided_by=?, decided_at=?, updated_at=?
      WHERE cycle_id=? AND user_id=?
    `).run(status, finalSalaryCents, changedByHr ? 1 : 0, decisionReason, actor.id, nowIso(), nowIso(), cycle.id, row.user_id);
    log(actor.id, `compensation_proposal_${status}`, 'compensation_proposals', row.proposal_id, null, { userId: row.user_id, changedByHr: Boolean(changedByHr) });
  }

  const ownProposalsDenied = () => approvalRule('compensation.self_approval') === 'denied';

  const otherHrAdministrators = actor => db.prepare("SELECT COUNT(*) count FROM users WHERE role='hr_admin' AND active=1 AND is_system_account=0 AND id<>?").get(actor.id).count;

  /**
   * Was diese Person mit einer Zeile in der Prüfung tun darf. Schnittstelle und Knöpfe nutzen dieselbe
   * Antwort. Niemand entscheidet über das eigene Gehalt. Verbietet die Organisation eigene Vorschläge,
   * darf auch niemand allein einen Wert festsetzen: Eine Änderung ist dann selbst nur ein neuer
   * Vorschlag, über den eine andere HR-Administration entscheidet. Sonst ließe sich die zweite
   * Person mit einem Klick auf „Ändern“ umgehen.
   */
  function decisionOptions(row, actor) {
    const blocked = blockedReason => ({ approve: false, reject: false, change: false, savesProposal: false, blockedReason });
    if (!canWrite(actor)) return blocked(HR_ADMIN_DECIDES);
    if (row.user_id === actor.id) return blocked(OWN_SALARY_BLOCKED);
    if (row.proposed_by_id === actor.id && ownProposalsDenied()) return blocked(OWN_PROPOSAL_BLOCKED);
    const hasProposal = Boolean(row.proposal_id);
    return { approve: hasProposal, reject: hasProposal, change: true, savesProposal: ownProposalsDenied(), blockedReason: null };
  }

  /**
   * Verbietet die Regel eigene Vorschläge, wartet ein Wert von HR auf eine andere HR-Administration.
   * Die soll das auf ihrer Übersicht sehen, sonst bleibt die Runde hängen.
   */
  function syncSecondPersonTasks(cycle) {
    const admins = db.prepare("SELECT id FROM users WHERE role='hr_admin' AND active=1 AND is_system_account=0").all();
    const adminIds = new Set(admins.map(admin => admin.id));
    const waiting = cycle.status === 'review' && ownProposalsDenied()
      ? participantRows(cycle.id).filter(row => row.proposal_status === 'submitted' && adminIds.has(row.proposed_by_id))
      : [];
    for (const admin of admins) {
      const hasWork = waiting.some(row => row.proposed_by_id !== admin.id && row.user_id !== admin.id);
      const open = db.prepare("SELECT id FROM tasks WHERE user_id=? AND type='compensation_decision' AND entity_id=? AND done=0").get(admin.id, cycle.id);
      if (hasWork && !open) createTask(admin.id, `Gehaltsrunde „${cycle.name}“: Werte von HR warten auf deine Entscheidung`, 'compensation_decision', cycle.id);
      if (!hasWork && open) db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(open.id);
    }
  }

  router.post('/compensation/cycles/:id/approve-open', requireHrWrite, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    if (cycle.status !== 'review') return res.status(409).json({ error: 'Vorschläge werden erst in der Prüfung entschieden.' });

    const open = participantRows(cycle.id).filter(row => row.proposal_status === 'submitted');
    const own = open.filter(row => !decisionOptions(row, actor).approve);
    const approvable = open.filter(row => decisionOptions(row, actor).approve);
    db.transaction(() => {
      for (const row of approvable) {
        saveDecision({ cycle, row, actor, status: 'approved', finalSalaryCents: row.proposed_salary_cents, changedByHr: Boolean(row.changed_by_hr), decisionReason: row.changed_by_hr ? row.proposal_reason : null });
      }
      syncSecondPersonTasks(cycle);
    })();
    res.json({ approved: approvable.length, skippedOwn: own.length });
  });

  router.post('/compensation/cycles/:id/decisions/:userId', requireHrWrite, (req, res) => {
    const actor = current(req);
    const cycle = cycleById(asId(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'Diese Gehaltsrunde gibt es nicht.' });
    const userId = asId(req.params.userId);
    if (userId === actor.id) return res.status(403).json({ error: OWN_SALARY_BLOCKED });
    if (cycle.status !== 'review') return res.status(409).json({ error: 'Vorschläge werden erst in der Prüfung entschieden.' });
    const row = participantRows(cycle.id).find(item => item.user_id === userId);
    if (!row) return res.status(404).json({ error: 'Diese Person nimmt nicht an der Runde teil.' });

    const body = req.body || {};
    const reason = cleanText(body.reason, 2000) || null;
    try {
      const options = decisionOptions(row, actor);
      if (options.blockedReason) throw httpProblem(403, options.blockedReason);
      if (body.action === 'approve') {
        if (!row.proposal_id) throw httpProblem(409, 'Für diese Person liegt kein Vorschlag vor.');
        // Stammt der offene Vorschlag selbst von HR, bleibt das für die Führungskraft sichtbar. War der
        // Vorschlag schon genehmigt und geändert, gilt mit dieser Aktion wieder der Vorschlag selbst.
        const proposedByHr = row.proposal_status === 'submitted' && Boolean(row.changed_by_hr);
        saveDecision({ cycle, row, actor, status: 'approved', finalSalaryCents: row.proposed_salary_cents, changedByHr: proposedByHr, decisionReason: reason || (proposedByHr ? row.proposal_reason : null) });
      } else if (body.action === 'reject') {
        if (!row.proposal_id) throw httpProblem(409, 'Für diese Person liegt kein Vorschlag vor.');
        saveDecision({ cycle, row, actor, status: 'rejected', finalSalaryCents: null, changedByHr: false, decisionReason: reason });
      } else if (body.action === 'change') {
        if (!reason) throw httpProblem(400, 'Bitte begründe die Änderung.');
        const increase = increaseFromBody(body, row.base_salary_cents);
        const finalSalaryCents = row.base_salary_cents + increase.increaseCents;
        db.transaction(() => {
          // Ohne Vorschlag (zum Beispiel ohne Führungskraft) legt HR den Wert selbst vor.
          if (!row.proposal_id) {
            const timestamp = nowIso();
            row.proposal_id = db.prepare(`
              INSERT INTO compensation_proposals(cycle_id, user_id, proposed_by, input_mode, input_percent_points, increase_cents, proposed_salary_cents, reason, created_at, updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)
            `).run(cycle.id, row.user_id, actor.id, increase.mode, increase.percentPoints, increase.increaseCents, finalSalaryCents, options.savesProposal ? reason : null, timestamp, timestamp).lastInsertRowid;
            log(actor.id, 'compensation_proposal_saved', 'compensation_proposals', row.proposal_id, null, { userId: row.user_id });
          } else if (options.savesProposal) {
            db.prepare(`
              UPDATE compensation_proposals SET proposed_by=?, input_mode=?, input_percent_points=?, increase_cents=?, proposed_salary_cents=?, reason=?,
                status='submitted', final_salary_cents=NULL, changed_by_hr=1, decision_reason=NULL, decided_by=NULL, decided_at=NULL, updated_at=?
              WHERE cycle_id=? AND user_id=?
            `).run(actor.id, increase.mode, increase.percentPoints, increase.increaseCents, finalSalaryCents, reason, nowIso(), cycle.id, row.user_id);
            log(actor.id, 'compensation_proposal_saved', 'compensation_proposals', row.proposal_id, { proposedBy: row.proposed_by_id, proposedSalaryCents: row.proposed_salary_cents }, { userId: row.user_id, proposedSalaryCents: finalSalaryCents });
          }
          if (!options.savesProposal) saveDecision({ cycle, row, actor, status: 'approved', finalSalaryCents, changedByHr: true, decisionReason: reason });
        })();
      } else {
        throw httpProblem(400, 'Bitte wähle genehmigen, ändern oder ablehnen.');
      }
      syncSecondPersonTasks(cycle);
      const updated = participantRows(cycle.id).find(item => item.user_id === userId);
      res.json({ participant: hrParticipantView(updated, actor, latestRecordIdsByUser(), cycle) });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  // --- Gehaltsrunden: direkte Führungskraft ------------------------------------------------

  router.get('/compensation/team', (req, res) => {
    const actor = current(req);
    if (actor.role === 'employee') return res.status(403).json({ error: 'Diese Ansicht gibt es nur für Führungskräfte.' });
    res.json({ rounds: openRoundsForLeader(actor).map(cycle => leaderRoundView(cycle, actor)) });
  });

  router.get('/compensation/team/results', (req, res) => {
    const actor = current(req);
    if (actor.role === 'employee') return res.status(403).json({ error: 'Diese Ansicht gibt es nur für Führungskräfte.' });
    res.json({ results: resultRoundsForLeader(actor) });
  });

  router.put('/compensation/team/:cycleId/proposals/:userId', (req, res) => {
    const actor = current(req);
    const userId = asId(req.params.userId);
    if (userId === actor.id) return res.status(403).json({ error: 'Für dich selbst kannst du keinen Vorschlag abgeben.' });
    if (!canPropose(actor)) return res.status(403).json({ error: 'Vorschläge gibt die direkte Führungskraft ab.' });

    const cycle = cycleById(asId(req.params.cycleId));
    if (!cycle || cycle.status !== 'open') return res.status(403).json({ error: 'Für diese Runde kannst du gerade keine Vorschläge abgeben.' });

    const rows = directParticipants(cycle.id, actor.id);
    const row = rows.find(item => item.user_id === userId);
    if (!row) return res.status(403).json({ error: 'Du kannst nur für direkte Mitarbeitende vorschlagen, die an dieser Runde teilnehmen.' });

    const body = req.body || {};
    try {
      const increase = increaseFromBody(body, row.base_salary_cents);
      const proposedSalaryCents = row.base_salary_cents + increase.increaseCents;
      const reason = cleanText(body.reason, 2000) || null;

      const othersPlanned = sumOf(rows.filter(item => item.user_id !== userId), plannedIncrease);
      const areaBudget = budgetForBase(cycle, sumOf(rows, item => item.base_salary_cents));
      const makesBudgetWorse = increase.increaseCents > plannedIncrease(row);
      const overBudget = othersPlanned + increase.increaseCents > areaBudget;
      const newMetrics = salaryMetrics(proposedSalaryCents, row.fte_basis_points, gradeOfRow(row));
      const aboveBand = newMetrics.bandStatus === 'above';
      if (((overBudget && makesBudgetWorse) || aboveBand) && !reason) {
        throw httpProblem(400, 'Dein Vorschlag überschreitet das Budget oder das Gehaltsband. Bitte begründe ihn. Gesperrt wird er dadurch nicht.');
      }

      const timestamp = nowIso();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO compensation_proposals(cycle_id, user_id, proposed_by, input_mode, input_percent_points, increase_cents, proposed_salary_cents, reason, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(cycle_id, user_id) DO UPDATE SET
            proposed_by=excluded.proposed_by, input_mode=excluded.input_mode, input_percent_points=excluded.input_percent_points,
            increase_cents=excluded.increase_cents, proposed_salary_cents=excluded.proposed_salary_cents,
            reason=excluded.reason, updated_at=excluded.updated_at
        `).run(cycle.id, userId, actor.id, increase.mode, increase.percentPoints, increase.increaseCents, proposedSalaryCents, reason, timestamp, timestamp);
        const proposalId = db.prepare('SELECT id FROM compensation_proposals WHERE cycle_id=? AND user_id=?').get(cycle.id, userId).id;
        log(actor.id, 'compensation_proposal_saved', 'compensation_proposals', proposalId, null, { userId });
        syncProposalTasks(cycle);
      })();

      const warnings = bandWarnings(newMetrics);
      if (overBudget) warnings.push({ code: 'over_budget', message: 'Dein Bereich liegt damit über dem Budget. HR sieht das in der Prüfung.' });
      const view = leaderRoundView(cycle, actor);
      res.json({ row: view.rows.find(item => item.userId === userId), budget: view.budget, warnings });
    } catch (error) {
      sendProblem(res, error);
    }
  });

  router.get('/compensation/area-summary', (req, res) => {
    const actor = current(req);
    if (!LEADER_ROLES.includes(actor.role) && !isHr(actor)) return res.status(403).json({ error: 'Diese Ansicht gibt es nur für Führungskräfte.' });
    res.json(areaSummary(actor));
  });

  // --- Auswertung für HR -------------------------------------------------------------------

  router.get('/compensation/analytics', requireHrRead, (req, res) => {
    const actor = current(req);
    const currentRecords = currentRecordsByUser();
    const people = activePeople().filter(person => hrCanAccess(actor, person));
    const bands = new Map(db.prepare('SELECT * FROM compensation_grades ORDER BY name, valid_from DESC').all().map(grade => [grade.id, {
      gradeId: grade.id,
      name: grade.name,
      currency: grade.currency,
      minCents: grade.min_cents,
      midCents: grade.mid_cents,
      maxCents: grade.max_cents,
      active: Boolean(grade.active),
      people: 0,
      belowBand: 0,
      aboveBand: 0,
      compaPermilleSum: 0
    }]));
    const outside = [];
    let withoutBand = 0;
    let withoutRecord = 0;

    for (const person of people) {
      const record = currentRecords.get(person.id);
      if (!record) {
        withoutRecord += 1;
        continue;
      }
      const grade = gradeOfRow(record);
      if (!grade) {
        withoutBand += 1;
        continue;
      }
      const metrics = salaryMetrics(record.annual_salary_cents, record.fte_basis_points, grade);
      const band = bands.get(grade.id);
      band.people += 1;
      band.compaPermilleSum += mulDivRound(metrics.fullTimeCents, 1000, grade.midCents);
      if (metrics.bandStatus === 'above') band.aboveBand += 1;
      if (metrics.bandStatus === 'below') band.belowBand += 1;
      if (metrics.bandStatus === 'above' || metrics.bandStatus === 'below') {
        outside.push({
          userId: person.id,
          name: person.name,
          title: person.title,
          grade: { name: grade.name, currency: grade.currency, minCents: grade.minCents, maxCents: grade.maxCents },
          fullTimeCents: metrics.fullTimeCents,
          currency: record.currency,
          direction: metrics.bandStatus,
          compaRatio: metrics.compaRatio
        });
      }
    }

    res.json({
      minGroupSize: MIN_GROUP_SIZE,
      bands: [...bands.values()]
        .filter(band => band.active || band.people > 0)
        .map(({ compaPermilleSum, ...band }) => ({
          ...band,
          averageCompaRatio: band.people >= MIN_GROUP_SIZE ? mulDivRound(compaPermilleSum, 1, band.people) / 1000 : null
        })),
      outside,
      withoutBand,
      withoutRecord
    });
  });

  router.get('/compensation/export.csv', (req, res) => {
    const actor = current(req);
    if (!canExport(actor)) return res.status(403).json({ error: 'Den Export darf nur die HR-Administration herunterladen.' });

    const currentRecords = currentRecordsByUser();
    const futureRecords = futureRecordsByUser();
    // Eine Zeile je Stand: der heutige und jeder beschlossene künftige. „Stand“ trennt beide, damit Summen stimmen.
    const header = ['Name', 'E-Mail', 'Stand', 'Gültig ab', 'Jahresgehalt', 'Währung', 'Stellenumfang', 'Vollzeit-Entsprechung', 'Variable Zielvergütung', 'Band', 'Bandminimum', 'Bandmitte', 'Bandmaximum', 'Lage im Gehaltsband in Prozent der Mitte', 'Stand zwischen Minimum und Maximum in Prozent', 'Grund', 'Hinweis', 'Vorgeschlagen von', 'Entschieden von'];
    const lines = [header.map(csvField).join(';')];
    let rows = 0;
    const addLine = (person, state, record) => {
      const grade = gradeOfRow(record);
      const metrics = salaryMetrics(record.annual_salary_cents, record.fte_basis_points, grade);
      lines.push([
        person.name,
        person.email,
        state,
        germanDate(record.effective_date),
        centsToCsv(record.annual_salary_cents),
        record.currency,
        String(record.fte_basis_points / BASIS_POINTS).replace('.', ','),
        centsToCsv(metrics.fullTimeCents),
        centsToCsv(record.variable_target_cents),
        grade?.name ?? '',
        centsToCsv(grade?.minCents),
        centsToCsv(grade?.midCents),
        centsToCsv(grade?.maxCents),
        metrics.compaRatio === null ? '' : (metrics.compaRatio * 100).toFixed(1).replace('.', ','),
        metrics.rangePositionPercent === null ? '' : metrics.rangePositionPercent.toFixed(1).replace('.', ','),
        RECORD_REASONS[record.reason],
        bandWarnings(metrics).map(warning => warning.code === 'above_band' ? 'Über dem Band' : 'Unter dem Band').join(''),
        record.round_proposed_by_name ?? '',
        record.round_decided_by_name ?? ''
      ].map(csvField).join(';'));
      rows += 1;
    };
    for (const person of activePeople()) {
      const record = currentRecords.get(person.id);
      if (record) addLine(person, 'Aktuell', record);
      for (const future of futureRecords.get(person.id) || []) addLine(person, 'Künftig', future);
    }
    log(actor.id, 'compensation_exported', 'compensation_records', null, null, { rows });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="verguetung.csv"');
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  return { router, initialize, seedDemo, maintenance, helpArticles: HELP_ARTICLES };
}

module.exports = {
  MIN_GROUP_SIZE,
  createCompensationModule,
  csvField,
  mulDivRound,
  parseFteToBasisPoints,
  parseMoneyToCents,
  parsePercentToBasisPoints,
  salaryMetrics
};
