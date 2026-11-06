'use strict';

/**
 * Abwesenheit: Urlaubskonten, Anträge mit Genehmigung, Krankmeldungen, Feiertage,
 * Teamkalender und Export für die Lohnabrechnung.
 *
 * Kontostände werden nie gespeichert, sondern beim Lesen aus Anträgen und Feiertagen
 * berechnet. So stimmt ein Konto nach Stornierungen oder neuen Feiertagen von selbst.
 *
 * Vertrauliche Arten (Krankheit) sind Gesundheitsdaten: Art und Kommentar sehen nur die
 * Person selbst und HR. Das Protokoll nennt bei keinem Antrag die Art, damit auch das
 * Fehlen der Angabe nichts verrät. Für alle anderen heißt jede Abwesenheit gleich „abwesend“.
 * Nur wer einen Antrag entscheidet, sieht dessen Art. Ganz verbergen lässt sich Krankheit
 * trotzdem nicht: Die Führungskraft erfährt, dass die Person fehlt, und weil sonst fast alles
 * einen Antrag braucht, kann sie es sich denken. Die Oberfläche sagt das offen.
 *
 * Eine geänderte Genehmigungsregel gilt nur für neue Vorgänge: Wer eine Prüfaufgabe schon hat,
 * behält sie und kann weiter entscheiden. Beim Wechsel der Führungskraft ziehen Aufgaben dagegen um.
 */

const express = require('express');
const { ensureColumn } = require('../lib/core-helpers');

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_WINDOW = 5;
const MAX_REQUEST_CALENDAR_DAYS = 1100; // Elternzeit kann rund drei Jahre dauern.
const MAX_ACCOUNT_DAYS = 366;
const DEFAULT_ENTITLEMENT_DAYS = 30;
const DEFAULT_CARRYOVER_EXPIRY = '03-31';
const REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);
const CONFIDENTIAL_LABEL = 'abwesend';
const REQUEST_LIST_LIMIT = 1000;
// Eine geplante Operation ist bekannt, eine Krankheit in Monaten nicht. Längerfristiges erfasst HR.
const MAX_SICK_DAYS_AHEAD = 14;
const HALF_DAY_PARTS = Object.freeze(['morning', 'afternoon']);
const EXIT_NOTE = 'Durch den Austritt hinfällig.';
const EXIT_SHORTENED_NOTE = 'Durch den Austritt bis zum letzten Arbeitstag gekürzt.';
const CORRECTION_TASK = 'absence_correction_notice';

const GERMAN_STATES = Object.freeze({
  BW: 'Baden-Württemberg',
  BY: 'Bayern',
  BE: 'Berlin',
  BB: 'Brandenburg',
  HB: 'Bremen',
  HH: 'Hamburg',
  HE: 'Hessen',
  MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz',
  SL: 'Saarland',
  SN: 'Sachsen',
  ST: 'Sachsen-Anhalt',
  SH: 'Schleswig-Holstein',
  TH: 'Thüringen'
});

const DEFAULT_TYPES = Object.freeze([
  { code: 'vacation', name: 'Urlaub', counts: 1, approval: 1, confidential: 0, sort: 10 },
  { code: 'sick', name: 'Krankheit', counts: 0, approval: 0, confidential: 1, sort: 20 },
  { code: 'special', name: 'Sonderurlaub', counts: 0, approval: 1, confidential: 0, sort: 30 },
  { code: 'unpaid', name: 'Unbezahlter Urlaub', counts: 0, approval: 1, confidential: 0, sort: 40 },
  { code: 'parental', name: 'Elternzeit', counts: 0, approval: 1, confidential: 0, sort: 50 }
]);

/**
 * Landesweit geltende gesetzliche Feiertage. `regions` nennt das Bundesland und das Jahr,
 * seit dem der Tag dort gilt; ohne `regions` gilt er bundesweit. Tage, die nur in einzelnen
 * Gemeinden gelten (etwa Mariä Himmelfahrt in Teilen Bayerns), ergänzt HR als eigene Tage.
 */
const HOLIDAY_RULES = Object.freeze([
  { name: 'Neujahr', fixed: '01-01' },
  { name: 'Heilige Drei Könige', fixed: '01-06', regions: { BW: 0, BY: 0, ST: 0 } },
  { name: 'Internationaler Frauentag', fixed: '03-08', regions: { BE: 2019, MV: 2023 } },
  { name: 'Karfreitag', easterOffset: -2 },
  { name: 'Ostersonntag', easterOffset: 0, regions: { BB: 0 } },
  { name: 'Ostermontag', easterOffset: 1 },
  { name: 'Tag der Arbeit', fixed: '05-01' },
  { name: 'Tag der Befreiung', fixed: '05-08', regions: { BE: 0 }, onlyYears: [2020, 2025] },
  { name: 'Christi Himmelfahrt', easterOffset: 39 },
  { name: 'Pfingstsonntag', easterOffset: 49, regions: { BB: 0 } },
  { name: 'Pfingstmontag', easterOffset: 50 },
  { name: 'Fronleichnam', easterOffset: 60, regions: { BW: 0, BY: 0, HE: 0, NW: 0, RP: 0, SL: 0 } },
  { name: 'Mariä Himmelfahrt', fixed: '08-15', regions: { SL: 0 } },
  { name: 'Weltkindertag', fixed: '09-20', regions: { TH: 2019 } },
  { name: 'Tag der Deutschen Einheit', fixed: '10-03' },
  { name: 'Reformationstag', fixed: '10-31', regions: { BB: 0, MV: 0, SN: 0, ST: 0, TH: 0, HB: 2018, HH: 2018, NI: 2018, SH: 2018 } },
  { name: 'Allerheiligen', fixed: '11-01', regions: { BW: 0, BY: 0, NW: 0, RP: 0, SL: 0 } },
  { name: 'Buß- und Bettag', repentanceDay: true, regions: { SN: 0 } },
  { name: '1. Weihnachtstag', fixed: '12-25' },
  { name: '2. Weihnachtstag', fixed: '12-26' }
]);

const ALL_ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
const LEADERSHIP_ROLES = Object.freeze(['manager', 'director', 'hr_admin', 'hrbp', 'super_admin']);
const HR_ROLES = Object.freeze(['hr_admin', 'hrbp', 'super_admin']);
const HR_OPERATOR_ROLES = Object.freeze(['hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
// Wer Anträge als HR entscheiden kann. Die Sachbearbeitung gehört bewusst nicht dazu.
const HR_DECIDER_ROLES = Object.freeze(['hr_admin', 'hrbp']);

const HELP_ARTICLES = Object.freeze([
  {
    id: 'absence-request',
    title: 'Urlaub beantragen und Konto ansehen',
    roles: ALL_ROLES,
    views: ['absenceHome'],
    keywords: ['urlaub beantragen', 'urlaub', 'urlaubsantrag', 'resturlaub', 'urlaubstage', 'urlaubskonto', 'übertrag', 'antrag stornieren'],
    answer: 'Unter „Abwesenheit“ siehst du Anspruch, Übertrag (Resttage aus dem Vorjahr), genommene und geplante Tage und deinen Rest. Wer über einen neuen Antrag entscheidet, steht im Antragsfenster; meist ist das deine direkte Führungskraft. Einen offenen Antrag oder einen genehmigten, noch nicht begonnenen Urlaub kannst du selbst stornieren; die Tage sind dann sofort wieder auf deinem Konto.',
    steps: ['Öffne „Zeit & Abwesenheit“ und dann „Abwesenheit“.', 'Wähle „+ Antrag“ und trage den Zeitraum ein, auf Wunsch mit halbem Tag am Anfang oder Ende.', 'Du siehst die Entscheidung in deinen offenen Aufgaben.'],
    actions: [{ label: 'Abwesenheit öffnen', view: 'absenceHome' }]
  },
  {
    id: 'absence-sick',
    title: 'Krank melden',
    roles: ALL_ROLES,
    views: ['absenceHome'],
    keywords: ['krank melden', 'krankmeldung', 'krank', 'krankheit', 'wer sieht krankheit'],
    answer: 'Du trägst nur den Zeitraum ein, eine Genehmigung ist nicht nötig. Eine Diagnose wird nirgends abgefragt. Deine Führungskraft erfährt, dass du fehlst. Die Art wird ihr nicht genannt, sie kann sie sich aber denken. Dein Team sieht nur „abwesend“. Eine Krankmeldung, die heute beginnt, kannst du heute selbst stornieren. Ist sie schon älter, fragst du die Korrektur bei HR an. Im Voraus geht sie höchstens 14 Tage.',
    steps: ['Öffne „Abwesenheit“.', 'Wähle „Krank melden“ und trage den Zeitraum ein.'],
    actions: [{ label: 'Abwesenheit öffnen', view: 'absenceHome' }]
  },
  {
    id: 'absence-approval',
    title: 'Anträge entscheiden und Teamkalender',
    roles: LEADERSHIP_ROLES,
    views: ['absenceTeam'],
    keywords: ['urlaub genehmigen', 'antrag genehmigen', 'antrag ablehnen', 'teamkalender', 'wer ist abwesend'],
    answer: 'Offene Anträge, über die du entscheidest, findest du im Reiter „Team“, darunter den Monatskalender. Dort steht für andere Personen nur „abwesend“. Die Art siehst du nur bei Anträgen, über die du entscheidest oder entschieden hast. Über den eigenen Antrag kannst du nicht selbst entscheiden. Wer entscheidet, legt eure Organisation in den Genehmigungsregeln fest.',
    steps: ['Öffne „Abwesenheit“ und den Reiter „Team“.', 'Prüfe im Kalender, wer im Zeitraum sonst fehlt.', 'Genehmige den Antrag oder lehne ihn mit einer kurzen Begründung ab.'],
    actions: [{ label: 'Team öffnen', view: 'absenceTeam' }]
  },
  {
    id: 'absence-setup',
    title: 'Abwesenheit einrichten',
    roles: HR_ROLES,
    views: ['absenceHr'],
    keywords: ['feiertage einspielen', 'feiertage', 'bundesland', 'urlaubsanspruch', 'abwesenheitsarten', 'export lohnabrechnung', 'konto anpassen'],
    answer: 'Im Reiter „HR“ legst du Standardanspruch, Verfallstag und Bundesland fest, spielst die gesetzlichen Feiertage eines Jahres ein und passt Konten je Person an. Dort findest du auch den Monatsexport für die Lohnabrechnung.',
    steps: ['Wähle das Bundesland und speichere die Voreinstellungen.', 'Spiele die Feiertage für das Jahr ein und ergänze eigene Tage.', 'Prüfe die Konten und passe sie bei Bedarf an.'],
    actions: [{ label: 'HR-Bereich öffnen', view: 'absenceHr' }]
  },
  {
    id: 'absence-hr-work',
    title: 'Krankmeldung erfassen und Konto korrigieren',
    roles: HR_OPERATOR_ROLES,
    views: ['absenceHr'],
    keywords: ['krankmeldung erfassen', 'krankheit nachtragen', 'abwesenheit nachtragen', 'konto korrigieren', 'urlaubskonto korrigieren', 'resturlaub ausgetreten'],
    answer: 'Im Reiter „HR“ erfasst du Krankmeldungen und andere Abwesenheiten für andere Personen, für Ausgetretene auch rückwirkend. Ein Urlaubskonto korrigierst du immer mit einem Grund; die Person bekommt dazu einen Hinweis. Die eigenen Daten ändert eine andere HR-Person, und die HR-Sachbearbeitung genehmigt keine Anträge.',
    steps: ['Öffne „Abwesenheit“ und den Reiter „HR“.', 'Unter „Anträge“ wählst du „+ Krankmeldung“ oder „+ Abwesenheit“.', 'Unter „Konten“ wählst du „Anpassen“ und nennst den Grund.'],
    actions: [{ label: 'HR-Bereich öffnen', view: 'absenceHr' }]
  }
]);

class BalanceError extends Error {}

const germanOrder = new Intl.Collator('de');

/** „Müller, Anna“ nennt den Nachnamen selbst, sonst steht er am Ende. */
function surnameAndGiven(name) {
  const text = String(name ?? '').trim();
  const comma = text.indexOf(',');
  if (comma >= 0) return { surname: text.slice(0, comma).trim(), given: text.slice(comma + 1).trim() };
  const parts = text.split(/\s+/);
  const surname = parts.pop() || '';
  return { surname, given: parts.join(' ') };
}

/** Nach Nachname, wie HR Listen liest. Der Vergleich nach deutscher Regel stellt „Jörg“ vor „Julia“. */
function sortByName(items, nameOf = item => item.name) {
  const keyed = items.map(item => ({ item, ...surnameAndGiven(nameOf(item)) }));
  keyed.sort((left, right) => germanOrder.compare(left.surname, right.surname) || germanOrder.compare(left.given, right.given));
  return keyed.map(entry => entry.item);
}

function berlinNow() {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const [date, time] = text.split(' ');
  return { date, time };
}

function toUtcMs(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  return fromUtcMs(toUtcMs(isoDate) + days * DAY_MS);
}

/** Strenger als validDate aus den Bausteinen: Der Tag muss wirklich im Kalender stehen. */
function isRealDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromUtcMs(toUtcMs(value)) === value;
}

function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function monthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return { first: `${month}-01`, last: fromUtcMs(Date.UTC(year, monthNumber, 0)) };
}

function weekdayOf(isoDate) {
  return new Date(toUtcMs(isoDate)).getUTCDay();
}

function* datesBetween(first, last) {
  const end = toUtcMs(last);
  for (let ms = toUtcMs(first); ms <= end; ms += DAY_MS) yield fromUtcMs(ms);
}

function mondayOnOrAfter(isoDate) {
  return addDays(isoDate, (8 - weekdayOf(isoDate)) % 7);
}

function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function formatRange(first, last) {
  return first === last ? formatDate(first) : `${formatDate(first)} bis ${formatDate(last)}`;
}

function formatDays(days) {
  return String(days).replace('.', ',');
}

/** Ostersonntag nach der Gaußschen Osterformel (gregorianischer Kalender). */
function easterSunday(year) {
  const century = Math.floor(year / 100);
  const leapCorrection = Math.floor(century / 4);
  const m = (15 + century - Math.floor((13 + 8 * century) / 25) - leapCorrection) % 30;
  const n = (4 + century - leapCorrection) % 7;
  const d = (19 * (year % 19) + m) % 30;
  const e = (2 * (year % 4) + 4 * (year % 7) + 6 * d + n) % 7;
  let daysAfterMarch22 = d + e;
  // Die zwei Ausnahmen der Formel: Sonst läge Ostern auf dem 26. oder 25. April.
  if (d === 29 && e === 6) daysAfterMarch22 = 28;
  if (d === 28 && e === 6 && (11 * m + 11) % 30 < 19) daysAfterMarch22 = 27;
  return addDays(`${year}-03-22`, daysAfterMarch22);
}

/** Buß- und Bettag ist der Mittwoch vor dem 23. November. */
function repentanceDay(year) {
  const november22 = `${year}-11-22`;
  return addDays(november22, -((weekdayOf(november22) + 4) % 7));
}

function holidayApplies(rule, year, state) {
  if (rule.onlyYears && !rule.onlyYears.includes(year)) return false;
  if (!rule.regions) return true;
  const since = rule.regions[state];
  return since !== undefined && year >= since;
}

function statutoryHolidays(year, state) {
  const easter = easterSunday(year);
  const dateOf = rule => {
    if (rule.fixed) return `${year}-${rule.fixed}`;
    if (rule.repentanceDay) return repentanceDay(year);
    return addDays(easter, rule.easterOffset);
  };
  return HOLIDAY_RULES
    .filter(rule => holidayApplies(rule, year, state))
    .map(rule => ({ date: dateOf(rule), name: rule.name }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function isWorkday(date, holidays) {
  const weekday = weekdayOf(date);
  return weekday !== 0 && weekday !== 6 && !holidays.has(date);
}

/** Anteil eines Kalendertags, den ein Antrag belegt. Ein einzelner halber Tag bleibt ein halber Tag. */
function dayShare(request, date) {
  const isHalf = (date === request.start_date && request.start_half)
    || (date === request.end_date && request.end_half);
  return isHalf ? 0.5 : 1;
}

/** Welche Hälfte ein halber Tag belegt. Bei mehreren Tagen ergibt sie sich: Erst ab mittags los, am Ende nur bis mittags. */
function halfPartOn(request, date) {
  const isHalf = (date === request.start_date && request.start_half) || (date === request.end_date && request.end_half);
  if (!isHalf) return null;
  if (request.start_date === request.end_date) return request.half_day_part || null;
  return date === request.start_date ? 'afternoon' : 'morning';
}

function* workdayShares(request, holidays) {
  for (const date of datesBetween(request.start_date, request.end_date)) {
    if (isWorkday(date, holidays)) yield [date, dayShare(request, date)];
  }
}

function countWorkdays(request, holidays) {
  let days = 0;
  for (const [, share] of workdayShares(request, holidays)) days += share;
  return days;
}

/** Tabellenprogramme führen Felder mit diesen Anfangszeichen sonst als Formel aus. */
function csvField(value) {
  let text = String(value ?? '');
  if (/^(?:[\t\r]|\s*[=+\-@])/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return `﻿${rows.map(row => row.map(csvField).join(';')).join('\r\n')}\r\n`;
}

const fail = (res, status, error) => res.status(status).json({ error });

const bodyOf = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

const positiveId = value => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const flag = value => value === true || value === 1 || ['true', 'on', '1'].includes(value);

const isStateCode = value => typeof value === 'string' && Object.hasOwn(GERMAN_STATES, value);

/** Tage in halben Schritten, zum Beispiel 27,5. */
const validDayAmount = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_ACCOUNT_DAYS && Number.isInteger(parsed * 2);
};

function createAbsenceModule({
  db, auth, current, isHr, isHrOperator, hrCanAccess, blocksSelfEdit, canViewEmployee, subordinateIds, cleanText, log, createTask,
  approvalRule, onManagerChanged, isModuleEnabled = () => false, now = berlinNow
}) {
  const router = express.Router();
  const today = () => now().date;
  const currentYear = () => Number(today().slice(0, 4));
  const timestamp = () => new Date().toISOString();

  const REQUEST_SELECT = `
    SELECT r.*, t.name AS type_name, t.code AS type_code, t.confidential, t.counts_against_balance,
      t.requires_approval, u.name AS user_name, u.email AS user_email, u.manager_id AS user_manager_id,
      u.role AS user_role, u.active AS user_active, m.name AS manager_name, d.name AS decided_by_name
    FROM absence_requests r
    JOIN absence_types t ON t.id = r.type_id
    JOIN users u ON u.id = r.user_id
    LEFT JOIN users m ON m.id = u.manager_id
    LEFT JOIN users d ON d.id = r.decided_by`;

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS absence_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_entitlement_days REAL NOT NULL,
        carryover_expiry_day TEXT NOT NULL,
        state TEXT,
        auto_carryover INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS absence_types (
        id INTEGER PRIMARY KEY,
        code TEXT UNIQUE,
        name TEXT NOT NULL,
        counts_against_balance INTEGER NOT NULL DEFAULT 0,
        requires_approval INTEGER NOT NULL DEFAULT 1,
        confidential INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 100
      );
      CREATE TABLE IF NOT EXISTS absence_accounts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        year INTEGER NOT NULL,
        entitlement_days REAL NOT NULL,
        carryover_days REAL,
        carryover_expires TEXT,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT,
        UNIQUE (user_id, year)
      );
      CREATE TABLE IF NOT EXISTS absence_holidays (
        id INTEGER PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('statutory', 'custom')),
        state TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS absence_requests (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type_id INTEGER NOT NULL REFERENCES absence_types(id),
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        start_half INTEGER NOT NULL DEFAULT 0,
        end_half INTEGER NOT NULL DEFAULT 0,
        comment TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_comment TEXT,
        cancelled_by INTEGER REFERENCES users(id),
        cancelled_at TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_absence_requests_user ON absence_requests(user_id, start_date);
      CREATE INDEX IF NOT EXISTS idx_absence_requests_period ON absence_requests(start_date, end_date);
    `);
    ensureColumn(db, 'absence_requests', 'half_day_part', 'TEXT');
    ensureColumn(db, 'absence_requests', 'cancel_reason', 'TEXT');
    ensureColumn(db, 'absence_accounts', 'correction_reason', 'TEXT');
    db.prepare(`
      INSERT INTO absence_settings (id, default_entitlement_days, carryover_expiry_day, auto_carryover)
      VALUES (1, ?, ?, 1)
      ON CONFLICT (id) DO NOTHING
    `).run(DEFAULT_ENTITLEMENT_DAYS, DEFAULT_CARRYOVER_EXPIRY);
    const addType = db.prepare(`
      INSERT INTO absence_types (code, name, counts_against_balance, requires_approval, confidential, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (code) DO NOTHING
    `);
    for (const type of DEFAULT_TYPES) addType.run(type.code, type.name, type.counts, type.approval, type.confidential, type.sort);
  }

  // ---------------------------------------------------------------- Personen

  function personById(id) {
    return db.prepare('SELECT id, name, email, role, manager_id, active FROM users WHERE id = ? AND is_system_account = 0').get(id);
  }

  /** HR-Zugriff auf eine Person. Die Sachbearbeitung ist dabei, anders als bei isHr; siehe hrCanAccess. */
  const hrMaySee = (actor, person) => isHrOperator(actor) && hrCanAccess(actor, person);

  const canViewPerson = (actor, userId) => canViewEmployee(actor, userId) || hrMaySee(actor, userId);

  function activeManagerId(person) {
    if (!person.manager_id) return null;
    const manager = db.prepare('SELECT id FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(person.manager_id);
    return manager ? manager.id : null;
  }

  /** Die HR-Administration, mangels einer zweiten der HR Business Partner. Die Sachbearbeitung entscheidet nie. */
  function hrDeciderIds(person) {
    const hrWithRole = role => db.prepare('SELECT id FROM users WHERE role = ? AND is_system_account = 0 AND active = 1 AND id <> ?')
      .all(role, person.id)
      .map(row => row.id);
    const admins = hrWithRole('hr_admin');
    return admins.length ? admins : hrWithRole('hrbp');
  }

  /**
   * Wer über einen neuen Antrag entscheidet: die direkte Führungskraft, sonst die HR-Administration.
   * Eine gesperrte Führungskraft zählt nicht, sonst bliebe der Antrag liegen. Vertrauliches geht
   * nie an die Führungskraft, weil sie die Art nicht sehen darf.
   */
  function responsibleIds(person, { hrOnly = false } = {}) {
    const managerId = hrOnly || approvalRule('absence.approval') === 'hr' ? null : activeManagerId(person);
    return managerId ? [managerId] : hrDeciderIds(person);
  }

  /** Dass jemand fehlt, erfährt die Führungskraft auch dann, wenn HR entscheidet: Sie plant das Team. */
  function informedIds(person) {
    const managerId = activeManagerId(person);
    return managerId ? [managerId] : hrDeciderIds(person);
  }

  /** Regel und offene Prüfaufgaben einer Anfrage. Sonst fragten lange Listen für jede Zeile neu nach. */
  function decisionContext() {
    let holders = null;
    const holdersOf = requestId => {
      if (!holders) {
        holders = new Map();
        for (const task of db.prepare("SELECT entity_id, user_id FROM tasks WHERE type = 'absence_approval' AND done = 0").all()) {
          if (!holders.has(task.entity_id)) holders.set(task.entity_id, []);
          holders.get(task.entity_id).push(task.user_id);
        }
      }
      return holders.get(requestId) || [];
    };
    let corrections = null;
    const correctionRequested = requestId => {
      corrections ??= new Set(db.prepare('SELECT entity_id FROM tasks WHERE type = ? AND done = 0').all(CORRECTION_TASK).map(task => task.entity_id));
      return corrections.has(requestId);
    };
    return { rule: approvalRule('absence.approval'), holdersOf, correctionRequested };
  }

  /** Ein gesperrtes Konto kann nicht mehr in Urlaub gehen. Was schon begonnen hat, zählt noch für die Abrechnung. */
  const isVoidForInactive = row => !row.user_active && row.start_date > today();

  /**
   * Wer eine Prüfaufgabe aus der Zeit vor einer Regeländerung hat, kann weiter entscheiden. Dasselbe gilt
   * für den HR Business Partner, der mangels zweiter HR-Administration über die HR-Leitung entscheidet.
   */
  function canDecide(actor, row, decisions = decisionContext()) {
    if (actor.id === row.user_id || isVoidForInactive(row)) return false;
    const holdsTask = () => decisions.holdersOf(row.id).includes(actor.id);
    if (isHr(actor)) return hrCanAccess(actor, { role: row.user_role }) || holdsTask();
    if (row.confidential || row.user_manager_id !== actor.id) return false;
    return decisions.rule !== 'hr' || holdsTask();
  }

  /** Wer darf eine Prüfaufgabe weiter halten? Fällt jemand weg, muss sie neu verteilt werden. */
  function canHoldApproval(holderId, row) {
    if (holderId === row.user_id) return false;
    const holder = db.prepare('SELECT role FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(holderId);
    if (!holder) return false;
    if (HR_DECIDER_ROLES.includes(holder.role)) return true;
    return !row.confidential && holderId === row.user_manager_id;
  }

  function canCancel(actor, row) {
    if (!['pending', 'approved'].includes(row.status)) return false;
    if (actor.id !== row.user_id) return hrMaySee(actor, { role: row.user_role });
    if (row.status === 'pending' || row.start_date > today()) return true;
    // Wer sich heute krank gemeldet hat und doch arbeiten kann, nimmt das selbst zurück.
    if (row.type_code === 'sick' && row.start_date === today()) return true;
    return isHrOperator(actor) && !blocksSelfEdit(actor, row.user_id);
  }

  /**
   * Eine genehmigte Abwesenheit ist fest eingeplant. Wer sie anderen absagt, muss sagen, warum.
   * Vertrauliche Arten bleiben ohne Freitext, damit dort keine Gesundheitsangaben landen.
   */
  const needsCancelReason = (actor, row) => actor.id !== row.user_id && row.status === 'approved' && !row.confidential;

  /** Was die Person nicht mehr selbst stornieren kann, darf sie HR wenigstens melden. Geändert wird dabei nichts. */
  const canRequestCorrection = (actor, row) => actor.id === row.user_id && row.status === 'approved' && !canCancel(actor, row);

  /** Prüft Recht und Existenz einer Person aus einer Anfrage. Ohne Angabe ist die angemeldete Person gemeint. */
  function viewableTarget(actor, rawUserId) {
    const userId = rawUserId === undefined ? actor.id : positiveId(rawUserId);
    if (!userId) return { status: 400, error: 'Die angegebene Person ist ungültig.' };
    if (!canViewPerson(actor, userId)) return { status: 403, error: 'Du darfst die Abwesenheiten dieser Person nicht sehen.' };
    const person = personById(userId);
    if (!person) return { status: 404, error: 'Person nicht gefunden.' };
    return { person };
  }

  // ---------------------------------------------------------------- Angaben anderer Module

  const knownTables = new Set();

  /** Gibt es die Tabelle eines anderen Moduls schon? Einmal gefunden, bleibt sie: Das spart Abfragen je Liste. */
  function tableHasColumns(table, columns) {
    const key = `${table}:${columns.join(',')}`;
    if (knownTables.has(key)) return true;
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    if (!columns.every(column => present.has(column))) return false;
    knownTables.add(key);
    return true;
  }

  function personnelNumbers() {
    if (!isModuleEnabled('personnel') || !tableHasColumns('personnel_records', ['user_id', 'personnel_number'])) return new Map();
    const rows = db.prepare('SELECT user_id, personnel_number FROM personnel_records WHERE personnel_number IS NOT NULL').all();
    return new Map(rows.map(row => [row.user_id, row.personnel_number]));
  }

  /** Letzte Arbeitstage aktuell gesperrter Personen, so wie die Personalakte den Austritt festhält. */
  function exitDates() {
    if (!tableHasColumns('personnel_changes', ['user_id', 'kind', 'status', 'effective_date'])) return new Map();
    const rows = db.prepare(`
      SELECT c.user_id, c.kind, c.effective_date
      FROM personnel_changes c
      JOIN users u ON u.id = c.user_id
      WHERE u.active = 0 AND c.kind IN ('exit', 'rehire') AND c.status = 'applied'
      ORDER BY c.effective_date, c.id
    `).all();
    const latest = new Map(rows.map(row => [row.user_id, row]));
    // Wer wieder eingetreten und nur gesperrt ist, hat keinen Austritt mehr, auch wenn einer in der Historie steht.
    return new Map([...latest.values()].filter(row => row.kind === 'exit').map(row => [row.user_id, row.effective_date]));
  }

  // ---------------------------------------------------------------- Einstellungen und Arten

  function readSettings() {
    return db.prepare('SELECT * FROM absence_settings WHERE id = 1').get();
  }

  function settingsView(settings) {
    return {
      defaultEntitlementDays: settings.default_entitlement_days,
      carryoverExpiryDay: settings.carryover_expiry_day,
      state: settings.state,
      autoCarryover: Boolean(settings.auto_carryover),
      states: GERMAN_STATES
    };
  }

  function typeView(type) {
    return {
      id: type.id,
      code: type.code,
      name: type.name,
      countsAgainstBalance: Boolean(type.counts_against_balance),
      requiresApproval: Boolean(type.requires_approval),
      confidential: Boolean(type.confidential),
      active: Boolean(type.active),
      canDisable: type.code !== 'sick'
    };
  }

  function typeNameTaken(name, exceptId = null) {
    const wanted = name.toLocaleLowerCase('de');
    return db.prepare('SELECT id, name FROM absence_types').all()
      .some(type => type.id !== exceptId && type.name.toLocaleLowerCase('de') === wanted);
  }

  // ---------------------------------------------------------------- Feiertage

  function holidayMap(first, last) {
    const rows = db.prepare('SELECT date, name FROM absence_holidays WHERE date >= ? AND date <= ?').all(first, last);
    return new Map(rows.map(row => [row.date, row.name]));
  }

  function holidaysCovering(rows) {
    if (!rows.length) return new Map();
    const first = rows.reduce((earliest, row) => (row.start_date < earliest ? row.start_date : earliest), rows[0].start_date);
    const last = rows.reduce((latest, row) => (row.end_date > latest ? row.end_date : latest), rows[0].end_date);
    return holidayMap(first, last);
  }

  /** Ersetzt die berechneten Feiertage eines Jahres. Eigene Tage bleiben, auch auf gleichem Datum. */
  function importHolidays(year, state, actorId = null) {
    const holidays = statutoryHolidays(year, state);
    const insert = db.prepare(`
      INSERT INTO absence_holidays (date, name, source, state, created_by, created_at)
      VALUES (?, ?, 'statutory', ?, ?, ?)
      ON CONFLICT (date) DO NOTHING
    `);
    return db.transaction(() => {
      db.prepare("DELETE FROM absence_holidays WHERE source = 'statutory' AND date >= ? AND date <= ?").run(`${year}-01-01`, `${year}-12-31`);
      let imported = 0;
      for (const holiday of holidays) imported += insert.run(holiday.date, holiday.name, state, actorId, timestamp()).changes;
      return { imported, skipped: holidays.length - imported };
    })();
  }

  // ---------------------------------------------------------------- Konten

  function accountRow(userId, year) {
    return db.prepare('SELECT * FROM absence_accounts WHERE user_id = ? AND year = ?').get(userId, year);
  }

  /**
   * Legt fehlende Konten aus der Voreinstellung an, samt fehlender Jahre dazwischen, damit der Übertrag
   * durchläuft. Alles in einer Transaktion: Einzeln gespeichert würde jedes Konto auf die Platte warten.
   */
  function ensureAccounts(userIds, year) {
    if (!userIds.length) return;
    const latestRows = db.prepare('SELECT user_id, MAX(year) AS year FROM absence_accounts WHERE year <= ? GROUP BY user_id').all(year);
    const latest = new Map(latestRows.map(row => [row.user_id, row.year]));
    const missing = [];
    for (const userId of userIds) {
      const last = latest.get(userId);
      if (last === year) continue;
      const firstYear = last === undefined ? Math.min(year, currentYear()) : last + 1;
      for (let accountYear = firstYear; accountYear <= year; accountYear += 1) missing.push([userId, accountYear]);
    }
    if (!missing.length) return;
    const settings = readSettings();
    const stamp = timestamp();
    const insert = db.prepare(`
      INSERT INTO absence_accounts (user_id, year, entitlement_days, carryover_days, carryover_expires, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT (user_id, year) DO NOTHING
    `);
    db.transaction(() => {
      for (const [userId, accountYear] of missing) {
        insert.run(userId, accountYear, settings.default_entitlement_days, `${accountYear}-${settings.carryover_expiry_day}`, stamp);
      }
    })();
  }

  function ensureAccount(userId, year) {
    ensureAccounts([userId], year);
    return accountRow(userId, year);
  }

  /**
   * Lädt alles für die Kontoberechnung in wenigen Abfragen, ohne Angabe für alle Personen.
   * So braucht die Liste aller Konten nicht mehr Tausende Einzelabfragen, die den Server blockieren.
   */
  function loadBalanceBook(userId = null) {
    const params = userId === null ? [] : [userId];
    const accounts = new Map();
    for (const row of db.prepare(`SELECT * FROM absence_accounts ${userId === null ? '' : 'WHERE user_id = ?'}`).all(...params)) {
      accounts.set(`${row.user_id}:${row.year}`, row);
    }
    const requests = new Map();
    const requestRows = db.prepare(`
      SELECT r.user_id, r.start_date, r.end_date, r.start_half, r.end_half, r.status
      FROM absence_requests r
      JOIN absence_types t ON t.id = r.type_id
      WHERE t.counts_against_balance = 1 AND r.status IN ('pending', 'approved') ${userId === null ? '' : 'AND r.user_id = ?'}
    `).all(...params);
    for (const row of requestRows) {
      if (!requests.has(row.user_id)) requests.set(row.user_id, []);
      requests.get(row.user_id).push(row);
    }
    let names = null;
    const nameOf = id => {
      names ??= new Map(db.prepare('SELECT id, name FROM users').all().map(row => [row.id, row.name]));
      return names.get(id) ?? null;
    };
    return {
      settings: readSettings(),
      holidays: new Map(db.prepare('SELECT date, name FROM absence_holidays').all().map(row => [row.date, row.name])),
      accountOf: (id, year) => accounts.get(`${id}:${year}`) || null,
      requestsOf: id => requests.get(id) || [],
      nameOf,
      booked: new Map(),
      rests: new Map()
    };
  }

  /** Summiert alle Tage aus offenen und genehmigten Anträgen, die in dieses Kontojahr fallen und das Konto belasten. */
  function bookedDays(account, book) {
    const key = `${account.user_id}:${account.year}`;
    if (book.booked.has(key)) return book.booked.get(key);
    const firstDay = `${account.year}-01-01`;
    const lastDay = `${account.year}-12-31`;
    const expires = account.carryover_expires;
    const todayDate = today();
    const booked = { taken: 0, plannedApproved: 0, pending: 0, beforeExpiry: 0, total: 0 };
    for (const request of book.requestsOf(account.user_id)) {
      if (request.start_date > lastDay || request.end_date < firstDay) continue;
      for (const [date, share] of workdayShares(request, book.holidays)) {
        if (date < firstDay || date > lastDay) continue;
        booked.total += share;
        if (!expires || date <= expires) booked.beforeExpiry += share;
        if (request.status === 'pending') booked.pending += share;
        else if (date <= todayDate) booked.taken += share;
        else booked.plannedApproved += share;
      }
    }
    book.booked.set(key, booked);
    return booked;
  }

  /** HR-Wert, sonst der Rest des Vorjahres. Ein offener Rest ändert sich noch, deshalb wird er nicht gespeichert. */
  function effectiveCarryover(account, book) {
    if (account.carryover_days !== null) return account.carryover_days;
    if (!book.settings.auto_carryover) return 0;
    const previous = book.accountOf(account.user_id, account.year - 1);
    return previous ? Math.max(0, yearEndRest(previous, book)) : 0;
  }

  /**
   * Rest am Jahresende, wenn alles Gebuchte genommen wird. Verfällt der Übertrag noch im Jahr,
   * zählt er nur, soweit er vorher verbraucht wird. Sonst steht er bis zum Jahresende ganz zur Verfügung.
   */
  function yearEndRest(account, book) {
    const key = `${account.user_id}:${account.year}`;
    if (book.rests.has(key)) return book.rests.get(key);
    const booked = bookedDays(account, book);
    const carryover = effectiveCarryover(account, book);
    const expiresWithinYear = Boolean(account.carryover_expires) && account.carryover_expires <= `${account.year}-12-31`;
    const usableCarryover = expiresWithinYear ? Math.min(carryover, booked.beforeExpiry) : carryover;
    const rest = account.entitlement_days + usableCarryover - booked.total;
    book.rests.set(key, rest);
    return rest;
  }

  function accountView(account, book = loadBalanceBook(account.user_id)) {
    const booked = bookedDays(account, book);
    const carryover = effectiveCarryover(account, book);
    const usedCarryover = Math.min(carryover, booked.beforeExpiry);
    const unusedCarryover = carryover - usedCarryover;
    const hasExpired = Boolean(account.carryover_expires) && today() > account.carryover_expires;
    const expiredDays = hasExpired ? unusedCarryover : 0;
    const plannedDays = booked.plannedApproved + booked.pending;
    return {
      userId: account.user_id,
      year: account.year,
      entitlementDays: account.entitlement_days,
      carryoverDays: carryover,
      carryoverAutomatic: account.carryover_days === null,
      carryoverExpires: account.carryover_expires,
      carryoverExpiredDays: expiredDays,
      carryoverExpiringDays: hasExpired || !account.carryover_expires ? 0 : unusedCarryover,
      takenDays: booked.taken,
      plannedDays,
      pendingDays: booked.pending,
      restDays: account.entitlement_days + carryover - expiredDays - booked.taken - plannedDays,
      correction: account.correction_reason
        ? { reason: account.correction_reason, at: account.updated_at, byName: book.nameOf(account.updated_by) }
        : null
    };
  }

  function parseYear(value) {
    if (value === undefined) return currentYear();
    const year = Number(value);
    return Number.isInteger(year) && Math.abs(year - currentYear()) <= YEAR_WINDOW ? year : null;
  }

  const yearProblem = () => `Bitte gib ein Jahr zwischen ${currentYear() - YEAR_WINDOW} und ${currentYear() + YEAR_WINDOW} an.`;

  // ---------------------------------------------------------------- Anträge

  function requestById(id) {
    return db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id);
  }

  function requestDraftProblem(draft) {
    if (!isRealDate(draft.start_date) || !isRealDate(draft.end_date)) return 'Bitte gib ein gültiges Anfangs- und Enddatum an.';
    if (draft.end_date < draft.start_date) return 'Das Ende darf nicht vor dem Anfang liegen.';
    const inWindow = date => Math.abs(Number(date.slice(0, 4)) - currentYear()) <= YEAR_WINDOW;
    if (!inWindow(draft.start_date) || !inWindow(draft.end_date)) return `Der Zeitraum muss zwischen ${currentYear() - YEAR_WINDOW} und ${currentYear() + YEAR_WINDOW} liegen.`;
    if ((toUtcMs(draft.end_date) - toUtcMs(draft.start_date)) / DAY_MS > MAX_REQUEST_CALENDAR_DAYS) return 'Der Zeitraum ist zu lang. Bitte teile ihn auf.';
    return null;
  }

  /**
   * Zwei halbe Tage dürfen sich ein Datum teilen, alles andere ist eine Überschneidung.
   * So geht vormittags Urlaub und nachmittags Krankheit, aber nicht derselbe Tag doppelt.
   */
  function findConflict(userId, draft) {
    const existing = db.prepare(`
      SELECT start_date, end_date, start_half, end_half, half_day_part
      FROM absence_requests
      WHERE user_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?
    `).all(userId, draft.end_date, draft.start_date);
    if (!existing.length) return null;
    for (const date of datesBetween(draft.start_date, draft.end_date)) {
      const onThisDay = existing.filter(other => other.start_date <= date && other.end_date >= date);
      if (!onThisDay.length) continue;
      const share = onThisDay.reduce((sum, other) => sum + dayShare(other, date), dayShare(draft, date));
      if (share > 1) return onThisDay[0];
      // Zwei halbe Tage passen nur, wenn sie nicht dieselbe Hälfte belegen.
      const draftPart = halfPartOn(draft, date);
      const samePart = draftPart && onThisDay.find(other => halfPartOn(other, date) === draftPart);
      if (samePart) return samePart;
    }
    return null;
  }

  function daysPerYear(request, holidays) {
    const perYear = new Map();
    for (const [date, share] of workdayShares(request, holidays)) {
      const year = Number(date.slice(0, 4));
      perYear.set(year, (perYear.get(year) || 0) + share);
    }
    return perYear;
  }

  /** Betroffene Jahre plus spätere Konten: Sie erben den Rest über den automatischen Übertrag. */
  function restsBeforeBooking(userId, perYear) {
    const years = [...perYear.keys()];
    for (const year of years) ensureAccounts([userId], year);
    const laterYears = db.prepare('SELECT year FROM absence_accounts WHERE user_id = ? AND year > ? ORDER BY year')
      .all(userId, Math.max(...years))
      .map(row => row.year);
    const book = loadBalanceBook(userId);
    const rests = new Map();
    for (const year of [...years, ...laterYears]) rests.set(year, yearEndRest(book.accountOf(userId, year), book));
    return rests;
  }

  /** Läuft nach dem Eintragen innerhalb der Transaktion: So zählt der Fall exakt wie jede spätere Kontoberechnung. */
  function assertNotOverdrawn(userId, restsBefore, perYear) {
    const book = loadBalanceBook(userId);
    for (const [year, restBefore] of restsBefore) {
      const restAfter = yearEndRest(book.accountOf(userId, year), book);
      if (restAfter >= 0 || restAfter >= restBefore) continue;
      const requested = perYear.get(year);
      if (requested === undefined) {
        throw new BalanceError(`Das würde den Urlaub für ${year} überziehen, weil dort Resttage aus ${year - 1} eingeplant sind.`);
      }
      const free = Math.max(0, requested + restAfter);
      throw new BalanceError(`Der Resturlaub für ${year} reicht nicht aus: Beantragt sind ${formatDays(requested)} Tage, frei sind noch ${formatDays(free)}. Übertrag, der bis zum Verfallsdatum nicht genommen wird, zählt dabei nicht mit.`);
    }
  }

  /** Wer entscheidet? Die Führungskraft mit Namen, sonst schlicht HR. Die Liste der HR-Personen hilft niemandem. */
  function pendingWithName(row, decisions) {
    const holders = decisions.holdersOf(row.id);
    if (!holders.length) return null;
    return holders.length === 1 && holders[0] === row.user_manager_id ? row.manager_name : 'HR';
  }

  function presentRequest(actor, row, holidays, decisions = decisionContext()) {
    const part = row.half_day_part ? { halfDayPart: row.half_day_part } : {};
    const base = {
      userId: row.user_id,
      userName: row.user_name,
      startDate: row.start_date,
      endDate: row.end_date,
      startHalf: Boolean(row.start_half),
      endHalf: Boolean(row.end_half),
      days: countWorkdays(row, holidays),
      ...part
    };
    const asHr = hrMaySee(actor, { role: row.user_role });
    const deciding = row.status === 'pending' && canDecide(actor, row, decisions);
    const seesDetails = actor.id === row.user_id || asHr || deciding
      || (row.decided_by === actor.id && canViewPerson(actor, row.user_id));
    if (seesDetails) {
      return {
        ...base,
        id: row.id,
        typeId: row.type_id,
        typeName: row.type_name,
        confidential: Boolean(row.confidential),
        countsAgainstBalance: Boolean(row.counts_against_balance),
        requiresApproval: Boolean(row.requires_approval),
        status: row.status,
        comment: row.comment,
        decisionComment: row.decision_comment,
        decidedByName: row.decided_by_name,
        decidedAt: row.decided_at,
        cancelledAt: row.cancelled_at,
        cancelReason: row.cancel_reason,
        createdAt: row.created_at,
        pendingWith: row.status === 'pending' ? pendingWithName(row, decisions) : null,
        personInactive: !row.user_active,
        canCancel: canCancel(actor, row),
        cancelNeedsReason: needsCancelReason(actor, row),
        canRequestCorrection: canRequestCorrection(actor, row),
        correctionRequested: actor.id === row.user_id && decisions.correctionRequested(row.id),
        canDecide: deciding
      };
    }
    if (row.status !== 'approved' || !canViewPerson(actor, row.user_id)) return null;
    return { ...base, label: CONFIDENTIAL_LABEL };
  }

  function requestLabel(row) {
    return row.confidential ? 'Dein Antrag' : `Dein Antrag (${row.type_name})`;
  }

  function approvalTaskTitle(person, type, startDate, endDate) {
    const typePart = type.confidential ? '' : `, ${type.name}`;
    return `Antrag prüfen: ${person.name}${typePart}, ${formatRange(startDate, endDate)}`;
  }

  function closeTasks(requestId, types) {
    const update = db.prepare('UPDATE tasks SET done = 1 WHERE type = ? AND entity_id = ? AND done = 0');
    for (const type of types) update.run(type, requestId);
  }

  /** Die echte Frist einer Entscheidung ist der erste Tag. Bei Nachgetragenem gibt es keine. */
  const decisionDeadline = startDate => (startDate >= today() ? startDate : null);

  function createApprovalTask(userId, person, type, row) {
    createTask(userId, approvalTaskTitle(person, type, row.start_date, row.end_date), 'absence_approval', row.id, decisionDeadline(row.start_date));
  }

  /** Verteilt die Prüfaufgaben eines offenen Antrags neu, wenn sich die Zuständigkeit geändert hat. */
  function reassignApprovalTasks(row) {
    const person = personById(row.user_id);
    if (!person) return;
    const responsible = isVoidForInactive(row) ? [] : responsibleIds(person, { hrOnly: Boolean(row.confidential) });
    const openTasks = db.prepare("SELECT id, user_id FROM tasks WHERE type = 'absence_approval' AND entity_id = ? AND done = 0").all(row.id);
    for (const task of openTasks) {
      if (!responsible.includes(task.user_id)) db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
    }
    for (const userId of responsible) {
      if (!openTasks.some(task => task.user_id === userId)) {
        createApprovalTask(userId, person, { name: row.type_name, confidential: row.confidential }, row);
      }
    }
  }

  // Wechselt die Führungskraft, wechselt auch die Entscheidung über offene Anträge.
  onManagerChanged?.(({ userId }) => {
    for (const row of db.prepare(`${REQUEST_SELECT} WHERE r.user_id = ? AND r.status = 'pending'`).all(userId)) reassignApprovalTasks(row);
  });

  /**
   * Nach einem Austritt findet nichts mehr statt, was nach dem letzten Arbeitstag läge: Es würde sonst den
   * Resturlaub schmälern, im Lohnexport stehen und genehmigbar bleiben. Ein nur gesperrtes Konto behält seine
   * Anträge, denn es kann zurückkommen.
   */
  function settleDepartures() {
    const ofInactive = db.prepare(`
      SELECT r.id, r.user_id, r.start_date, r.end_date, r.status
      FROM absence_requests r
      JOIN users u ON u.id = r.user_id
      WHERE u.active = 0 AND r.status IN ('pending', 'approved')
    `).all();
    if (!ofInactive.length) return;
    const exits = exitDates();
    db.transaction(() => {
      for (const row of ofInactive) {
        const lastDay = exits.get(row.user_id);
        if (lastDay && row.start_date > lastDay) {
          db.prepare("UPDATE absence_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(timestamp(), EXIT_NOTE, row.id);
          closeTasks(row.id, ['absence_approval', 'absence_decided', 'absence_info', CORRECTION_TASK]);
          log(null, 'absence_request_cancelled', 'absence_requests', row.id, { status: row.status }, { status: 'cancelled', cause: 'exit' });
        } else if (lastDay && row.end_date > lastDay) {
          db.prepare('UPDATE absence_requests SET end_date = ?, end_half = 0, cancel_reason = ? WHERE id = ?').run(lastDay, EXIT_SHORTENED_NOTE, row.id);
          log(null, 'absence_request_shortened', 'absence_requests', row.id, { endDate: row.end_date }, { endDate: lastDay, cause: 'exit' });
        } else if (row.status === 'pending' && row.start_date > today()) {
          // Solange das Konto gesperrt ist, soll niemand auf einen ruhenden Antrag warten.
          closeTasks(row.id, ['absence_approval']);
        }
      }
    })();
  }

  // ---------------------------------------------------------------- Kalender

  function calendarAudience(actor) {
    const people = sortByName(db.prepare('SELECT id, name, email, role, manager_id FROM users WHERE is_system_account = 0 AND active = 1').all());
    const reports = new Set(subordinateIds(actor));
    const namesById = new Map(people.map(person => [person.id, person.name]));
    const relationOf = person => {
      if (person.id === actor.id) return 'self';
      if (hrMaySee(actor, person)) return 'hr';
      if (reports.has(person.id)) return 'report';
      const isOwnManager = person.id === actor.manager_id;
      const isColleague = actor.manager_id && person.manager_id === actor.manager_id;
      return isOwnManager || isColleague ? 'colleague' : null;
    };
    const audience = [];
    for (const person of people) {
      const relation = relationOf(person);
      if (!relation) continue;
      const direct = person.manager_id === actor.id;
      const indirect = !direct && reports.has(person.id);
      audience.push({ ...person, relation, direct, viaManagerName: indirect ? namesById.get(person.manager_id) ?? null : null });
    }
    return audience;
  }

  /** Für alle anderen heißt jede Abwesenheit „abwesend“, sonst verriete das Wort allein die Krankheit. */
  function calendarEntry(actor, relation, row, decisions) {
    const base = {
      userId: row.user_id,
      startDate: row.start_date,
      endDate: row.end_date,
      startHalf: Boolean(row.start_half),
      endHalf: Boolean(row.end_half),
      ...(row.half_day_part ? { halfDayPart: row.half_day_part } : {})
    };
    const isDecider = relation === 'report'
      && (row.status === 'pending' ? canDecide(actor, row, decisions) : row.decided_by === actor.id);
    if (relation === 'self' || relation === 'hr' || isDecider) return { ...base, label: row.type_name, typeName: row.type_name, status: row.status };
    if (row.status !== 'approved') return null;
    return { ...base, label: CONFIDENTIAL_LABEL };
  }

  /** Wer aus demselben Team im Zeitraum fehlt. Nur Namen und Tage, die Art geht hier niemanden etwas an. */
  function teamOverlaps(actor, row, others, decisions) {
    if (!row.user_manager_id) return [];
    return others
      .filter(other => other.user_id !== row.user_id
        && other.user_manager_id === row.user_manager_id
        && other.start_date <= row.end_date
        && other.end_date >= row.start_date
        && (!isHr(actor) || hrCanAccess(actor, { role: other.user_role }))
        && (other.status === 'approved' || canDecide(actor, other, decisions)))
      .map(other => ({ userName: other.user_name, startDate: other.start_date, endDate: other.end_date, pending: other.status === 'pending' }));
  }

  // ---------------------------------------------------------------- Wartung und Demo

  /**
   * Gesperrte Konten dürfen keinen Antrag liegen lassen. Eine geänderte Regel verschiebt nichts: Wer die
   * Aufgabe hat und weiter entscheiden darf, behält sie. So stimmt der Text bei den Genehmigungsregeln.
   */
  function syncApprovalTasks() {
    settleDepartures();
    const pending = db.prepare(`${REQUEST_SELECT} WHERE r.status = 'pending'`).all();
    db.transaction(() => {
      for (const row of pending) {
        const person = personById(row.user_id);
        if (!person) continue;
        if (isVoidForInactive(row)) continue;
        const openTasks = db.prepare("SELECT id, user_id FROM tasks WHERE type = 'absence_approval' AND entity_id = ? AND done = 0").all(row.id);
        const stillValid = openTasks.filter(task => canHoldApproval(task.user_id, row));
        for (const task of openTasks) {
          if (!stillValid.includes(task)) db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
        }
        if (stillValid.length) continue;
        for (const userId of responsibleIds(person, { hrOnly: Boolean(row.confidential) })) {
          createApprovalTask(userId, person, { name: row.type_name, confidential: row.confidential }, row);
        }
      }
    })();
  }

  function seedDemo() {
    const people = db.prepare('SELECT id, name, manager_id FROM users WHERE is_system_account = 0 AND active = 1 ORDER BY id').all();
    if (!people.length) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM absence_requests').get().count > 0) return;
    const year = currentYear();
    db.prepare("UPDATE absence_settings SET state = 'NW' WHERE id = 1 AND state IS NULL").run();
    const state = readSettings().state;
    if (!db.prepare('SELECT id FROM absence_holidays WHERE date >= ? AND date <= ?').get(`${year}-01-01`, `${year}-12-31`)) importHolidays(year, state);
    if (!db.prepare('SELECT id FROM absence_holidays WHERE date >= ? AND date <= ?').get(`${year + 1}-01-01`, `${year + 1}-12-31`)) importHolidays(year + 1, state);
    const employees = people.filter(person => person.manager_id && people.some(other => other.id === person.manager_id));
    if (!employees.length) return;
    const typeByCode = code => db.prepare('SELECT * FROM absence_types WHERE code = ?').get(code);
    const vacation = typeByCode('vacation');
    const insert = db.prepare(`
      INSERT INTO absence_requests (user_id, type_id, start_date, end_date, status, comment, decided_by, decided_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const pick = index => employees[index % employees.length];
    const approvedStart = mondayOnOrAfter(addDays(today(), 21));
    insert.run(pick(0).id, vacation.id, approvedStart, addDays(approvedStart, 4), 'approved', 'Familienurlaub', pick(0).manager_id, timestamp(), pick(0).id, timestamp());
    const pendingStart = mondayOnOrAfter(addDays(today(), 49));
    const pendingEnd = addDays(pendingStart, 2);
    const pendingId = insert.run(pick(1).id, vacation.id, pendingStart, pendingEnd, 'pending', 'Kurzurlaub', null, null, pick(1).id, timestamp()).lastInsertRowid;
    createApprovalTask(pick(1).manager_id, pick(1), vacation, { id: pendingId, start_date: pendingStart, end_date: pendingEnd });
    const sickStart = mondayOnOrAfter(addDays(today(), -7));
    insert.run(pick(2).id, typeByCode('sick').id, sickStart, addDays(sickStart, 1), 'approved', null, null, null, pick(2).id, timestamp());
  }

  // ---------------------------------------------------------------- Routen

  router.use('/absence', auth);

  router.get('/absence/types', (req, res) => {
    const actor = current(req);
    const includeInactive = isHr(actor) && req.query.all === '1';
    const where = includeInactive ? '' : 'WHERE active = 1';
    const types = db.prepare(`SELECT * FROM absence_types ${where} ORDER BY sort_order, name`).all();
    res.json({ types: types.map(typeView), approval: approvalRouteFor(actor) });
  });

  /** Sagt der Person vor dem Absenden, wohin ihr Antrag geht. Das hängt von der Regel der Organisation ab. */
  function approvalRouteFor(actor) {
    const rule = approvalRule('absence.approval');
    if (rule === 'none') return { rule, decider: 'none' };
    const person = personById(actor.id);
    if (!person) return { rule, decider: 'hr' };
    const responsible = responsibleIds(person);
    if (!responsible.length) return { rule, decider: 'nobody' };
    if (responsible[0] !== person.manager_id) return { rule, decider: 'hr' };
    return { rule, decider: 'manager', name: personById(person.manager_id)?.name ?? null };
  }

  router.post('/absence/types', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf Abwesenheitsarten anlegen.');
    const body = bodyOf(req);
    const name = cleanText(body.name, 80);
    if (!name) return fail(res, 400, 'Bitte gib einen Namen an.');
    if (typeNameTaken(name)) return fail(res, 400, 'Eine Art mit diesem Namen gibt es schon.');
    const id = db.prepare(`
      INSERT INTO absence_types (name, counts_against_balance, requires_approval, confidential)
      VALUES (?, ?, ?, ?)
    `).run(name, flag(body.countsAgainstBalance) ? 1 : 0, flag(body.requiresApproval) ? 1 : 0, flag(body.confidential) ? 1 : 0).lastInsertRowid;
    log(actor.id, 'absence_type_created', 'absence_types', id, null, { name });
    res.status(201).json({ type: typeView(db.prepare('SELECT * FROM absence_types WHERE id = ?').get(id)) });
  });

  router.patch('/absence/types/:id', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf Abwesenheitsarten ändern.');
    const type = db.prepare('SELECT * FROM absence_types WHERE id = ?').get(positiveId(req.params.id));
    if (!type) return fail(res, 404, 'Abwesenheitsart nicht gefunden.');
    const body = bodyOf(req);
    const next = {
      name: body.name === undefined ? type.name : cleanText(body.name, 80),
      counts: body.countsAgainstBalance === undefined ? type.counts_against_balance : (flag(body.countsAgainstBalance) ? 1 : 0),
      approval: body.requiresApproval === undefined ? type.requires_approval : (flag(body.requiresApproval) ? 1 : 0),
      confidential: body.confidential === undefined ? type.confidential : (flag(body.confidential) ? 1 : 0),
      active: body.active === undefined ? type.active : (flag(body.active) ? 1 : 0)
    };
    if (!next.name) return fail(res, 400, 'Bitte gib einen Namen an.');
    if (typeNameTaken(next.name, type.id)) return fail(res, 400, 'Eine Art mit diesem Namen gibt es schon.');
    // Krankheit bleibt eine vertrauliche Meldung: Wer das abschaltet, legt Gesundheitsdaten offen.
    const changesSickRules = type.code === 'sick'
      && (next.counts !== type.counts_against_balance || next.approval !== type.requires_approval || next.confidential !== type.confidential);
    if (changesSickRules) return fail(res, 400, 'Krankheit bleibt eine vertrauliche Meldung ohne Genehmigung. Nur der Name lässt sich ändern.');
    if (type.code === 'sick' && type.active && !next.active) return fail(res, 400, 'Krankheit lässt sich nicht abschalten, sonst könnte sich niemand mehr krank melden.');
    db.prepare(`
      UPDATE absence_types
      SET name = ?, counts_against_balance = ?, requires_approval = ?, confidential = ?, active = ?
      WHERE id = ?
    `).run(next.name, next.counts, next.approval, next.confidential, next.active, type.id);
    log(actor.id, 'absence_type_updated', 'absence_types', type.id, { name: type.name, active: type.active }, { name: next.name, active: next.active });
    res.json({ type: typeView(db.prepare('SELECT * FROM absence_types WHERE id = ?').get(type.id)) });
  });

  router.get('/absence/settings', (req, res) => {
    if (!isHr(current(req))) return fail(res, 403, 'Nur HR darf die Voreinstellungen sehen.');
    res.json({ settings: settingsView(readSettings()) });
  });

  router.put('/absence/settings', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf die Voreinstellungen ändern.');
    const before = readSettings();
    const body = bodyOf(req);
    const entitlement = body.defaultEntitlementDays === undefined ? before.default_entitlement_days : body.defaultEntitlementDays;
    if (!validDayAmount(entitlement)) return fail(res, 400, 'Der Standardanspruch muss zwischen 0 und 366 Tagen liegen, in halben Schritten.');
    const expiryDay = body.carryoverExpiryDay === undefined ? before.carryover_expiry_day : String(body.carryoverExpiryDay);
    // Geprüft an einem Nicht-Schaltjahr: Den 29.02. gibt es nicht in jedem Jahr.
    if (!isRealDate(`2023-${expiryDay}`)) return fail(res, 400, 'Der Verfallstag muss ein echtes Datum sein, zum Beispiel der 31.03.');
    const state = body.state === undefined ? before.state : (body.state || null);
    if (state !== null && !isStateCode(state)) return fail(res, 400, 'Bitte wähle ein gültiges Bundesland.');
    const autoCarryover = body.autoCarryover === undefined ? before.auto_carryover : (flag(body.autoCarryover) ? 1 : 0);
    db.prepare(`
      UPDATE absence_settings
      SET default_entitlement_days = ?, carryover_expiry_day = ?, state = ?, auto_carryover = ?, updated_by = ?, updated_at = ?
      WHERE id = 1
    `).run(Number(entitlement), expiryDay, state, autoCarryover, actor.id, timestamp());
    log(actor.id, 'absence_settings_updated', 'absence_settings', 1, settingsLogValues(before), settingsLogValues(readSettings()));
    res.json({ settings: settingsView(readSettings()) });
  });

  function settingsLogValues(settings) {
    return {
      defaultEntitlementDays: settings.default_entitlement_days,
      carryoverExpiryDay: settings.carryover_expiry_day,
      state: settings.state,
      autoCarryover: settings.auto_carryover
    };
  }

  router.get('/absence/account', (req, res) => {
    const actor = current(req);
    const target = viewableTarget(actor, req.query.userId);
    if (target.error) return fail(res, target.status, target.error);
    const year = parseYear(req.query.year);
    if (year === null) return fail(res, 400, yearProblem());
    res.json({ account: accountView(ensureAccount(target.person.id, year)), person: { id: target.person.id, name: target.person.name } });
  });

  router.get('/absence/accounts', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf alle Konten sehen.');
    const year = parseYear(req.query.year);
    if (year === null) return fail(res, 400, yearProblem());
    settleDepartures();
    const everyone = db.prepare('SELECT id, name, email, role, active FROM users WHERE is_system_account = 0').all()
      .filter(person => hrCanAccess(actor, person));
    const exits = exitDates();
    // Ausgetretene bleiben im Jahr ihres Austritts ablesbar. Für spätere Jahre bekommen sie kein neues Konto.
    const needsAccount = person => {
      if (person.active) return true;
      const exitYear = exits.has(person.id) ? Number(exits.get(person.id).slice(0, 4)) : currentYear();
      return year <= exitYear;
    };
    ensureAccounts(everyone.filter(needsAccount).map(person => person.id), year);
    const book = loadBalanceBook();
    const numbers = personnelNumbers();
    const accounts = [];
    for (const person of sortByName(everyone)) {
      const account = book.accountOf(person.id, year);
      if (!account) continue;
      accounts.push({
        ...accountView(account, book),
        userName: person.name,
        userEmail: person.email,
        personnelNumber: numbers.get(person.id) ?? null,
        active: Boolean(person.active),
        exitDate: exits.get(person.id) ?? null,
        canAdjust: !blocksSelfEdit(actor, person.id)
      });
    }
    res.json({ year, accounts });
  });

  router.put('/absence/accounts/:userId/:year', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf Konten anpassen.');
    const person = personById(positiveId(req.params.userId));
    if (!person) return fail(res, 404, 'Person nicht gefunden.');
    if (!hrCanAccess(actor, person)) return fail(res, 403, 'Dieses Konto darfst du nicht anpassen.');
    if (blocksSelfEdit(actor, person.id)) return fail(res, 403, 'Dein eigenes Konto passt eine andere HR-Person an.');
    const year = parseYear(req.params.year);
    if (year === null) return fail(res, 400, yearProblem());
    const body = bodyOf(req);
    const reason = cleanText(body.reason, 500);
    const account = ensureAccount(person.id, year);

    const entitlement = body.entitlementDays === undefined ? account.entitlement_days : body.entitlementDays;
    if (!validDayAmount(entitlement)) return fail(res, 400, 'Der Anspruch muss zwischen 0 und 366 Tagen liegen, in halben Schritten.');
    // null oder leer heißt: Der Übertrag wird wieder automatisch aus dem Vorjahr berechnet.
    let carryover = account.carryover_days;
    if (body.carryoverDays === null || body.carryoverDays === '') carryover = null;
    else if (body.carryoverDays !== undefined) {
      if (!validDayAmount(body.carryoverDays)) return fail(res, 400, 'Der Übertrag muss zwischen 0 und 366 Tagen liegen, in halben Schritten.');
      carryover = Number(body.carryoverDays);
    }
    let expires = account.carryover_expires;
    if (body.carryoverExpires === null || body.carryoverExpires === '') expires = null;
    else if (body.carryoverExpires !== undefined) {
      if (!isRealDate(body.carryoverExpires) || body.carryoverExpires < `${year}-01-01`) return fail(res, 400, `Das Verfallsdatum muss ein gültiges Datum ab dem 01.01.${year} sein.`);
      expires = body.carryoverExpires;
    }
    if (!reason) return fail(res, 400, 'Bitte nenne einen Grund für die Anpassung.');
    db.transaction(() => {
      db.prepare(`
        UPDATE absence_accounts
        SET entitlement_days = ?, carryover_days = ?, carryover_expires = ?, correction_reason = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(Number(entitlement), carryover, expires, reason, actor.id, timestamp(), account.id);
      log(actor.id, 'absence_account_updated', 'absence_accounts', account.id,
        { userId: person.id, year, entitlementDays: account.entitlement_days, carryoverDays: account.carryover_days, carryoverExpires: account.carryover_expires },
        { userId: person.id, year, entitlementDays: Number(entitlement), carryoverDays: carryover, carryoverExpires: expires, reason });
      if (person.active && actor.id !== person.id) {
        createTask(person.id, `HR hat dein Urlaubskonto ${year} angepasst. Grund: ${reason}`, 'absence_account_notice', account.id);
      }
    })();
    res.json({ account: accountView(accountRow(person.id, year)) });
  });

  router.get('/absence/holidays', (req, res) => {
    const year = parseYear(req.query.year);
    if (year === null) return fail(res, 400, yearProblem());
    const holidays = db.prepare('SELECT id, date, name, source FROM absence_holidays WHERE date >= ? AND date <= ? ORDER BY date')
      .all(`${year}-01-01`, `${year}-12-31`);
    const state = readSettings().state;
    res.json({
      year,
      holidays,
      statutoryImported: holidays.some(holiday => holiday.source === 'statutory'),
      state,
      stateName: state ? GERMAN_STATES[state] : null
    });
  });

  router.post('/absence/holidays/import', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf Feiertage einspielen.');
    const body = bodyOf(req);
    const year = parseYear(body.year);
    if (year === null) return fail(res, 400, yearProblem());
    const state = body.state || readSettings().state;
    if (!state) return fail(res, 400, 'Bitte wähle zuerst ein Bundesland.');
    if (!isStateCode(state)) return fail(res, 400, 'Bitte wähle ein gültiges Bundesland.');
    const result = importHolidays(year, state, actor.id);
    log(actor.id, 'absence_holidays_imported', 'absence_holidays', null, null, { year, state, imported: result.imported });
    res.json({ year, state, ...result });
  });

  router.post('/absence/holidays', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf Feiertage ergänzen.');
    const body = bodyOf(req);
    const name = cleanText(body.name, 80);
    if (!isRealDate(body.date) || parseYear(body.date.slice(0, 4)) === null) return fail(res, 400, 'Bitte gib ein gültiges Datum an.');
    if (!name) return fail(res, 400, 'Bitte gib einen Namen an.');
    const result = db.prepare(`
      INSERT INTO absence_holidays (date, name, source, created_by, created_at)
      VALUES (?, ?, 'custom', ?, ?)
      ON CONFLICT (date) DO NOTHING
    `).run(body.date, name, actor.id, timestamp());
    if (!result.changes) return fail(res, 400, 'An diesem Tag ist bereits ein Feiertag eingetragen.');
    log(actor.id, 'absence_holiday_created', 'absence_holidays', result.lastInsertRowid, null, { date: body.date, name });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.delete('/absence/holidays/:id', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf Feiertage entfernen.');
    const holiday = db.prepare('SELECT id, date, name FROM absence_holidays WHERE id = ?').get(positiveId(req.params.id));
    if (!holiday) return fail(res, 404, 'Feiertag nicht gefunden.');
    db.prepare('DELETE FROM absence_holidays WHERE id = ?').run(holiday.id);
    log(actor.id, 'absence_holiday_deleted', 'absence_holidays', holiday.id, { date: holiday.date, name: holiday.name }, null);
    res.json({ ok: true });
  });

  router.get('/absence/requests', (req, res) => {
    const actor = current(req);
    const conditions = [];
    const params = [];
    const everyone = req.query.scope === 'all';
    if (everyone) {
      if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf alle Anträge sehen.');
      settleDepartures();
    } else {
      const target = viewableTarget(actor, req.query.userId);
      if (target.error) return fail(res, target.status, target.error);
      conditions.push('r.user_id = ?');
      params.push(target.person.id);
    }
    if (req.query.status !== undefined) {
      if (!REQUEST_STATUSES.includes(req.query.status)) return fail(res, 400, 'Dieser Status ist unbekannt.');
      conditions.push('r.status = ?');
      params.push(req.query.status);
    }
    if (req.query.year !== undefined) {
      const year = parseYear(req.query.year);
      if (year === null) return fail(res, 400, yearProblem());
      conditions.push('r.start_date <= ? AND r.end_date >= ?');
      params.push(`${year}-12-31`, `${year}-01-01`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const found = db.prepare(`${REQUEST_SELECT} ${where} ORDER BY r.start_date DESC, r.id DESC LIMIT ?`).all(...params, REQUEST_LIST_LIMIT + 1);
    const truncated = found.length > REQUEST_LIST_LIMIT;
    const rows = found.slice(0, REQUEST_LIST_LIMIT);
    const holidays = holidaysCovering(rows);
    const decisions = decisionContext();
    const numbers = everyone ? personnelNumbers() : new Map();
    const visible = everyone ? rows.filter(row => hrCanAccess(actor, { role: row.user_role })) : rows;
    const requests = visible
      .map(row => {
        const request = presentRequest(actor, row, holidays, decisions);
        if (!request || !everyone) return request;
        return { ...request, userEmail: row.user_email, personnelNumber: numbers.get(row.user_id) ?? null };
      })
      .filter(Boolean);
    res.json({ requests, truncated, limit: REQUEST_LIST_LIMIT });
  });

  router.post('/absence/requests', (req, res) => {
    const actor = current(req);
    const body = bodyOf(req);
    const userId = [undefined, null, ''].includes(body.userId) ? actor.id : positiveId(body.userId);
    if (!userId) return fail(res, 400, 'Die angegebene Person ist ungültig.');
    const isOwn = userId === actor.id;
    if (!isOwn && !hrMaySee(actor, userId)) return fail(res, 403, 'Nur HR darf Abwesenheiten für andere Personen erfassen.');
    const person = personById(userId);
    if (!person) return fail(res, 404, 'Person nicht gefunden.');

    const type = db.prepare('SELECT * FROM absence_types WHERE id = ? AND active = 1').get(positiveId(body.typeId));
    if (!type) return fail(res, 400, 'Bitte wähle eine gültige Abwesenheitsart.');

    const singleDayPart = body.startDate === body.endDate && HALF_DAY_PARTS.includes(body.halfDayPart) ? body.halfDayPart : null;
    const draft = {
      start_date: body.startDate,
      end_date: body.endDate,
      start_half: flag(body.startHalf) || singleDayPart ? 1 : 0,
      end_half: flag(body.endHalf) && !singleDayPart ? 1 : 0,
      half_day_part: singleDayPart
    };
    const draftProblem = requestDraftProblem(draft);
    if (draftProblem) return fail(res, 400, draftProblem);
    if (!person.active) {
      const lastDay = exitDates().get(person.id) ?? today();
      if (draft.end_date > lastDay) return fail(res, 400, `${person.name} ist nicht mehr aktiv. Du kannst nur noch Tage bis zum ${formatDate(lastDay)} nachtragen.`);
    }
    if (isOwn && type.code === 'sick' && draft.start_date > addDays(today(), MAX_SICK_DAYS_AHEAD)) {
      return fail(res, 400, `Eine Krankmeldung geht höchstens ${MAX_SICK_DAYS_AHEAD} Tage im Voraus. Steht schon länger etwas fest, trägt HR es ein.`);
    }

    const holidays = holidayMap(draft.start_date, draft.end_date);
    const days = countWorkdays(draft, holidays);
    if (days < 0.5) return fail(res, 400, 'Dieser Zeitraum enthält keinen Arbeitstag.');

    const conflict = findConflict(person.id, draft);
    if (conflict) return fail(res, 400, `Für diesen Zeitraum gibt es schon einen offenen oder genehmigten Antrag (${formatRange(conflict.start_date, conflict.end_date)}).`);

    const perYear = daysPerYear(draft, holidays);
    const restsBefore = type.counts_against_balance ? restsBeforeBooking(person.id, perYear) : null;
    // Vertrauliche Arten haben kein Freitextfeld: So kann dort keine Diagnose landen.
    const comment = type.confidential ? null : cleanText(body.comment, 1000) || null;
    const needsApproval = Boolean(type.requires_approval) && approvalRule('absence.approval') !== 'none';
    const status = needsApproval ? 'pending' : 'approved';
    const responsible = responsibleIds(person, { hrOnly: Boolean(type.confidential) });
    const range = formatRange(draft.start_date, draft.end_date);

    const create = db.transaction(() => {
      const id = db.prepare(`
        INSERT INTO absence_requests (user_id, type_id, start_date, end_date, start_half, end_half, half_day_part, comment, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(person.id, type.id, draft.start_date, draft.end_date, draft.start_half, draft.end_half, draft.half_day_part, comment, status, actor.id, timestamp()).lastInsertRowid;
      if (restsBefore) assertNotOverdrawn(person.id, restsBefore, perYear);
      if (needsApproval) {
        for (const responsibleId of responsible) createApprovalTask(responsibleId, person, type, { id, ...draft });
      } else {
        const informed = informedIds(person).filter(responsibleId => responsibleId !== actor.id);
        for (const responsibleId of informed) createTask(responsibleId, `${person.name} ist abwesend: ${range}`, 'absence_info', id);
      }
      if (!isOwn && person.active) createTask(person.id, `Für dich wurde eine Abwesenheit eingetragen: ${range}`, 'absence_info', id);
      log(actor.id, 'absence_request_created', 'absence_requests', id, null, { userId: person.id, startDate: draft.start_date, endDate: draft.end_date });
      return id;
    });

    let id;
    try {
      id = create();
    } catch (error) {
      if (error instanceof BalanceError) return fail(res, 400, error.message);
      throw error;
    }
    const warning = needsApproval && !responsible.length
      ? 'Gerade kann niemand außer dir diesen Antrag entscheiden. Bitte lege eine weitere Person mit HR-Rechten an.'
      : undefined;
    res.status(201).json({ id, status, days, warning });
  });

  router.get('/absence/requests/:id', (req, res) => {
    const actor = current(req);
    const row = requestById(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Antrag nicht gefunden.');
    const request = presentRequest(actor, row, holidaysCovering([row]));
    if (!request) return fail(res, 403, 'Du darfst diesen Antrag nicht sehen.');
    res.json({ request });
  });

  router.post('/absence/requests/:id/decision', (req, res) => {
    const actor = current(req);
    const row = requestById(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Antrag nicht gefunden.');
    if (actor.id === row.user_id) return fail(res, 403, 'Über deinen eigenen Antrag kannst du nicht selbst entscheiden.');
    if (!canDecide(actor, { ...row, user_active: 1 })) {
      return fail(res, 403, actor.role === 'hr_staff'
        ? 'Die HR-Sachbearbeitung entscheidet keine Anträge. Das tun die Führungskraft oder die HR-Administration.'
        : 'Nur die direkte Führungskraft oder HR darf diesen Antrag entscheiden.');
    }
    if (isVoidForInactive(row)) return fail(res, 409, `${row.user_name} ist nicht mehr aktiv. Über einen künftigen Antrag lässt sich deshalb nicht mehr entscheiden.`);
    const body = bodyOf(req);
    if (!['approve', 'reject'].includes(body.decision)) return fail(res, 400, 'Bitte wähle „genehmigen“ oder „ablehnen“.');
    const comment = cleanText(body.comment, 1000) || null;
    if (body.decision === 'reject' && !comment) return fail(res, 400, 'Bitte begründe die Ablehnung kurz.');
    if (row.status !== 'pending') return fail(res, 409, 'Dieser Antrag wurde bereits entschieden oder storniert.');

    const status = body.decision === 'approve' ? 'approved' : 'rejected';
    const verb = status === 'approved' ? 'genehmigt' : 'abgelehnt';
    db.transaction(() => {
      db.prepare(`
        UPDATE absence_requests
        SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ?
        WHERE id = ?
      `).run(status, actor.id, timestamp(), comment, row.id);
      closeTasks(row.id, ['absence_approval']);
      if (row.user_active) createTask(row.user_id, `${requestLabel(row)} vom ${formatRange(row.start_date, row.end_date)} wurde ${verb}.`, 'absence_decided', row.id);
      log(actor.id, `absence_request_${status}`, 'absence_requests', row.id, { status: row.status }, { status });
    })();
    res.json({ ok: true, status });
  });

  router.post('/absence/requests/:id/cancel', (req, res) => {
    const actor = current(req);
    const row = requestById(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Antrag nicht gefunden.');
    if (actor.id !== row.user_id && !hrMaySee(actor, { role: row.user_role })) return fail(res, 403, 'Nur die Person selbst oder HR darf stornieren.');
    if (!['pending', 'approved'].includes(row.status)) return fail(res, 409, 'Dieser Antrag ist bereits abgeschlossen.');
    if (!canCancel(actor, row)) return fail(res, 403, 'Eine bereits begonnene Abwesenheit kann nur HR stornieren.');
    const reason = actor.id !== row.user_id && !row.confidential ? cleanText(bodyOf(req).reason, 500) : '';
    if (needsCancelReason(actor, row) && !reason) return fail(res, 400, 'Bitte nenne einen Grund. Die Person hat fest damit geplant und bekommt ihn als Hinweis.');

    const range = formatRange(row.start_date, row.end_date);
    db.transaction(() => {
      db.prepare(`
        UPDATE absence_requests
        SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?
        WHERE id = ?
      `).run(actor.id, timestamp(), reason || null, row.id);
      closeTasks(row.id, ['absence_approval', 'absence_decided', 'absence_info', CORRECTION_TASK]);
      if (row.status === 'approved') {
        const person = personById(row.user_id);
        const informed = informedIds(person).filter(userId => userId !== actor.id);
        for (const userId of informed) createTask(userId, `${person.name}: Abwesenheit storniert (${range})`, 'absence_info', row.id);
      }
      if (actor.id !== row.user_id && row.user_active) {
        createTask(row.user_id, `Deine Abwesenheit wurde storniert: ${range}${reason ? `. Grund: ${reason}` : ''}`, 'absence_info', row.id);
      }
      log(actor.id, 'absence_request_cancelled', 'absence_requests', row.id, { status: row.status }, { status: 'cancelled', ...(reason ? { reason } : {}) });
    })();
    res.json({ ok: true, status: 'cancelled' });
  });

  router.post('/absence/requests/:id/correction', (req, res) => {
    const actor = current(req);
    const row = requestById(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Antrag nicht gefunden.');
    if (actor.id !== row.user_id) return fail(res, 403, 'Eine Korrektur fragt nur die Person selbst an.');
    if (!canRequestCorrection(actor, row)) return fail(res, 409, 'Diese Abwesenheit kannst du selbst stornieren, oder sie ist schon abgeschlossen.');
    const responsible = hrDeciderIds(personById(row.user_id));
    if (!responsible.length) return fail(res, 409, 'Gerade ist bei HR niemand eingetragen, der das ändern kann.');
    if (decisionContext().correctionRequested(row.id)) return res.json({ ok: true, alreadyRequested: true });
    const title = `Korrektur gewünscht: ${row.user_name}, Abwesenheit ${formatRange(row.start_date, row.end_date)}`;
    db.transaction(() => {
      for (const userId of responsible) createTask(userId, title, CORRECTION_TASK, row.id);
      log(actor.id, 'absence_correction_requested', 'absence_requests', row.id);
    })();
    res.json({ ok: true });
  });

  router.get('/absence/approvals', (req, res) => {
    const actor = current(req);
    settleDepartures();
    const decisions = decisionContext();
    const rows = db.prepare(`${REQUEST_SELECT} WHERE r.status = 'pending' ORDER BY r.start_date, r.id`).all()
      .filter(row => canDecide(actor, row, decisions));
    const holidays = holidaysCovering(rows);
    const sorted = sortByName(rows, row => row.user_name).sort((left, right) => left.start_date.localeCompare(right.start_date));
    const countsOnAccount = sorted.filter(row => row.counts_against_balance);
    for (const year of new Set(countsOnAccount.map(row => Number(row.start_date.slice(0, 4))))) {
      const people = countsOnAccount.filter(row => Number(row.start_date.slice(0, 4)) === year).map(row => row.user_id);
      ensureAccounts([...new Set(people)], year);
    }
    const book = countsOnAccount.length ? loadBalanceBook() : null;
    const others = sorted.length
      ? db.prepare(`${REQUEST_SELECT} WHERE r.status IN ('pending', 'approved') AND u.active = 1 AND r.start_date <= ? AND r.end_date >= ?`)
        .all(sorted.reduce((latest, row) => (row.end_date > latest ? row.end_date : latest), sorted[0].end_date), sorted[0].start_date)
      : [];
    res.json({
      rule: decisions.rule,
      requests: sorted.map(row => ({
        ...presentRequest(actor, row, holidays, decisions),
        restDays: row.counts_against_balance
          ? accountView(book.accountOf(row.user_id, Number(row.start_date.slice(0, 4))), book).restDays
          : null,
        overlaps: teamOverlaps(actor, row, others, decisions)
      }))
    });
  });

  router.get('/absence/calendar', (req, res) => {
    const actor = current(req);
    const month = req.query.month === undefined ? today().slice(0, 7) : req.query.month;
    if (!isMonth(month)) return fail(res, 400, 'Bitte wähle einen Monat.');
    const { first, last } = monthRange(month);
    const audience = calendarAudience(actor);
    const relationById = new Map(audience.map(person => [person.id, person.relation]));
    const decisions = decisionContext();
    const numbers = audience.some(person => person.relation === 'hr') ? personnelNumbers() : new Map();
    const rows = db.prepare(`${REQUEST_SELECT} WHERE r.status IN ('pending', 'approved') AND r.start_date <= ? AND r.end_date >= ? ORDER BY r.start_date`).all(last, first);
    const entries = rows
      .filter(row => relationById.has(row.user_id))
      .map(row => calendarEntry(actor, relationById.get(row.user_id), row, decisions))
      .filter(Boolean);
    res.json({
      month,
      firstDay: first,
      lastDay: last,
      today: today(),
      holidays: [...holidayMap(first, last)].map(([date, name]) => ({ date, name })),
      people: audience.map(person => ({
        id: person.id,
        name: person.name,
        relation: person.relation,
        direct: person.direct,
        viaManagerName: person.viaManagerName,
        // Nur HR sucht hier auch nach E-Mail und Personalnummer.
        ...(person.relation === 'hr' ? { email: person.email, personnelNumber: numbers.get(person.id) ?? null } : {})
      })),
      entries
    });
  });

  const approvedInMonth = month => {
    const { first, last } = monthRange(month);
    return db.prepare(`${REQUEST_SELECT} WHERE r.status = 'approved' AND r.start_date <= ? AND r.end_date >= ? ORDER BY r.start_date`).all(last, first);
  };

  /** Wer in der Datei fehlt: alle aktuellen Personen, die diese HR-Person nicht sehen darf, und Ehemalige mit Einträgen im Monat. */
  function withheldPeopleCount(actor, rowsOfMonth) {
    const withheld = new Set(rowsOfMonth.filter(row => !hrCanAccess(actor, { role: row.user_role })).map(row => row.user_id));
    for (const person of db.prepare('SELECT id, role FROM users WHERE is_system_account = 0 AND active = 1').all()) {
      if (!hrCanAccess(actor, person)) withheld.add(person.id);
    }
    return withheld.size;
  }

  // Fehlt jemand still, stimmt die Lohnabrechnung nicht. Deshalb steht es auf der Seite und in der Datei.
  const withheldNote = count => (count
    ? `Hinweis: In dieser Datei ${count === 1 ? 'fehlt 1 Person' : `fehlen ${count} Personen`} mit HR-Rolle, deren Daten du nicht sehen darfst. Die vollständige Datei lädt die HR-Administration.`
    : null);

  router.get('/absence/export/scope', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf Abwesenheiten exportieren.');
    if (!isMonth(req.query.month)) return fail(res, 400, 'Bitte wähle einen Monat.');
    settleDepartures();
    const count = withheldPeopleCount(actor, approvedInMonth(req.query.month));
    res.json({ month: req.query.month, withheldPeople: count, note: withheldNote(count) });
  });

  router.get('/absence/export', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf Abwesenheiten exportieren.');
    if (!isMonth(req.query.month)) return fail(res, 400, 'Bitte wähle einen Monat.');
    settleDepartures();
    const { first, last } = monthRange(req.query.month);
    const found = approvedInMonth(req.query.month);
    const rows = sortByName(found.filter(row => hrCanAccess(actor, { role: row.user_role })), row => row.user_name);
    const holidays = holidaysCovering(rows);
    const numbers = personnelNumbers();
    const header = ['Name', 'Personalnummer', 'E-Mail', 'Art', 'Von', 'Bis', 'Arbeitstage im Monat'];
    const lines = [header];
    for (const row of rows) {
      let daysInMonth = 0;
      for (const [date, share] of workdayShares(row, holidays)) {
        if (date >= first && date <= last) daysInMonth += share;
      }
      if (!daysInMonth) continue;
      const from = row.start_date < first ? first : row.start_date;
      const until = row.end_date > last ? last : row.end_date;
      lines.push([row.user_name, numbers.get(row.user_id) ?? '', row.user_email, row.type_name, formatDate(from), formatDate(until), formatDays(daysInMonth)]);
    }
    const exportedRows = lines.length - 1;
    const note = withheldNote(withheldPeopleCount(actor, found));
    if (note) lines.push([note, ...header.slice(1).map(() => '')]);
    log(actor.id, 'absence_exported', 'absence_requests', null, null, { month: req.query.month, rows: exportedRows });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="abwesenheiten-${req.query.month}.csv"`);
    res.send(toCsv(lines));
  });

  // Reine Hinweise bestätigt die Person selbst; Prüfaufgaben enden nur mit der Entscheidung.
  router.post('/absence/tasks/:id/done', (req, res) => {
    const actor = current(req);
    const result = db.prepare(`
      UPDATE tasks SET done = 1
      WHERE id = ? AND user_id = ? AND done = 0 AND type IN ('absence_decided', 'absence_info')
    `).run(positiveId(req.params.id), actor.id);
    if (!result.changes) return fail(res, 404, 'Aufgabe nicht gefunden.');
    res.json({ ok: true });
  });

  return {
    router,
    initialize,
    seedDemo,
    maintenance: syncApprovalTasks,
    helpArticles: HELP_ARTICLES
  };
}

module.exports = {
  GERMAN_STATES,
  countWorkdays,
  createAbsenceModule,
  csvField,
  easterSunday,
  statutoryHolidays,
  toCsv
};
