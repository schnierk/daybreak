'use strict';

/**
 * Zeiterfassung: Arbeitszeiten, Kommen/Gehen, Wochen zur Freigabe, Soll und Saldo.
 *
 * Bewusst ohne Leistungsbewertung, Rangliste oder Überwachung: Führungskräfte sehen Zeiten erst,
 * wenn sie eingereicht wurden, und Listen sind nur nach Woche und Name sortiert. Hinweise zu
 * Pausen und Ruhezeiten blockieren nie und sind als Prüfhinweis gekennzeichnet.
 *
 * Eine geänderte Genehmigungsregel gilt nur für neue Einreichungen: Wer eine Prüfaufgabe schon hat,
 * behält sie und kann weiter entscheiden. Beim Wechsel der Führungskraft ziehen Aufgaben dagegen um.
 * Wo HR in fremde Zeiten schreibt, sind Grund und Hinweis an die Person Pflicht.
 */

const express = require('express');
const { ensureColumn } = require('../lib/core-helpers');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;
const YEAR_WINDOW = 5;
const WORKDAYS_PER_WEEK = 5;
const DEFAULT_WEEKLY_HOURS = 40;
const MAX_WEEKLY_HOURS = 80;
const MAX_BREAK_MINUTES = 720;
const MAX_CLOCK_SPAN_MINUTES = 16 * 60;
const WEEK_LIST_LIMIT = 200;

// Sagt, was zu prüfen ist. Die Zeiten können stimmen und trotzdem nicht erlaubt sein, oder umgekehrt.
const HINT_CHECK = 'Bitte prüfe, ob das stimmt und bei euch erlaubt ist.';
const HINT_CHECK_ABSENCE = 'Bitte prüfe, ob beides stimmt.';
const DAILY_LIMIT_MINUTES = 10 * 60;
const LONG_DAY_MINUTES = 9 * 60;
const LONG_DAY_BREAK_MINUTES = 45;
const NORMAL_DAY_MINUTES = 6 * 60;
const NORMAL_DAY_BREAK_MINUTES = 30;
const MIN_REST_MINUTES = 11 * 60;
const MIN_COUNTED_BREAK_MINUTES = 15;
// Bis zu dieser Lücke über Mitternacht gilt die Arbeit als durchgehende Schicht (23:59 bis 00:00).
const CONTINUOUS_SHIFT_GAP_MINUTES = 1;
// Kürzere Lücken nach einer Nachtschicht sind Pausen in der Schicht, längere beenden sie.
const SHIFT_END_GAP_MINUTES = 2 * 60;

const WEEK_STATUSES = Object.freeze(['open', 'submitted', 'approved', 'returned']);
const EDITABLE_STATUSES = Object.freeze(['open', 'returned']);
const MANAGER_VISIBLE_STATUSES = Object.freeze(['submitted', 'approved', 'returned']);
const STATUS_LABELS = Object.freeze({ open: 'offen', submitted: 'eingereicht', approved: 'genehmigt', returned: 'zurückgegeben' });
const WEEKDAY_NAMES = Object.freeze(['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']);

const ALL_ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
const LEADERSHIP_ROLES = Object.freeze(['manager', 'director', 'hr_admin', 'hrbp', 'super_admin']);
const HR_ROLES = Object.freeze(['hr_admin', 'hrbp', 'super_admin']);
const HR_OPERATOR_ROLES = Object.freeze(['hr_staff', 'hr_admin', 'hrbp', 'super_admin']);
// Wer Wochen als HR entscheiden kann. Die Sachbearbeitung gehört bewusst nicht dazu.
const HR_DECIDER_ROLES = Object.freeze(['hr_admin', 'hrbp']);

const HELP_ARTICLES = Object.freeze([
  {
    id: 'time-record',
    title: 'Arbeitszeit erfassen',
    roles: ALL_ROLES,
    views: ['timeHome'],
    keywords: ['zeit erfassen', 'arbeitszeit', 'zeiterfassung', 'kommen gehen', 'stempeln', 'pause eintragen', 'nachtschicht'],
    answer: 'Unter „Zeiterfassung“ startest du deine Arbeitszeit mit „Kommen“ und beendest sie mit „Gehen“, oder du trägst Beginn, Ende und Pause von Hand ein. Arbeit über Mitternacht steht in zwei Einträgen, einer endet um 24:00 und der nächste beginnt um 00:00.',
    steps: ['Öffne „Zeit & Abwesenheit“ und dann „Zeiterfassung“.', 'Wähle „Kommen“ und später „Gehen“, oder „+ Eintrag“ für eine Eingabe von Hand.', 'Reiche die Woche ein, wenn sie vollständig ist.'],
    actions: [{ label: 'Zeiterfassung öffnen', view: 'timeHome' }]
  },
  {
    id: 'time-week',
    title: 'Woche einreichen und Saldo verstehen',
    roles: ALL_ROLES,
    views: ['timeHome'],
    keywords: ['woche einreichen', 'woche zurückziehen', 'saldo', 'überstunden', 'soll', 'zeitkonto', 'zurückgegeben', 'hinweis ruhezeit'],
    answer: 'Das Soll ist die vorgesehene Arbeitszeit, das Ist die erfasste Zeit. Der Saldo ist das Ist minus dem Soll bis heute: Plus heißt Überstunden, Minus heißt Fehlstunden. Feiertage und genehmigte Abwesenheiten mindern das Soll. Wochen ganz ohne Einträge zählen nicht mit. Nach dem Einreichen ist die Woche gesperrt, auch für „Kommen“ und „Gehen“. Bis zur Entscheidung kannst du sie zurückziehen. Hinweise zu Pausen und Ruhezeiten blockieren nichts. Sie bitten dich nur zu prüfen, ob die Zeiten stimmen und bei euch erlaubt sind.',
    steps: ['Prüfe Einträge und Hinweise der Woche.', 'Wähle „Woche einreichen“, am besten erst, wenn die Woche vorbei ist.', 'Hast du zu früh eingereicht, wähle „Zurückziehen“. Wurde die Woche zurückgegeben, korrigiere sie und reiche sie erneut ein.'],
    actions: [{ label: 'Zeiterfassung öffnen', view: 'timeHome' }]
  },
  {
    id: 'time-approval',
    title: 'Wochen prüfen',
    roles: LEADERSHIP_ROLES,
    views: ['timeTeam'],
    keywords: ['woche genehmigen', 'zeiten prüfen', 'stunden freigeben', 'woche zurückgeben', 'wer genehmigt zeiten'],
    answer: 'Im Reiter „Team“ siehst du eingereichte Wochen der Personen, die du direkt oder über andere führst. Bei jeder Woche steht, wer entscheidet. Das ist je nach Regel eurer Organisation die direkte Führungskraft oder HR, nie die Person selbst. Noch nicht eingereichte Zeiten sind für Führungskräfte bewusst nicht sichtbar.',
    steps: ['Öffne „Zeiterfassung“ und den Reiter „Team“.', 'Öffne die Woche und prüfe Einträge und Hinweise.', 'Genehmige sie oder gib sie mit einem Kommentar zurück.'],
    actions: [{ label: 'Team öffnen', view: 'timeTeam' }]
  },
  {
    id: 'time-setup',
    title: 'Zeiterfassung einrichten und exportieren',
    roles: [...HR_ROLES, 'hr_staff'],
    views: ['timeHr'],
    keywords: ['wochenstunden', 'sollstunden', 'export lohnabrechnung zeit', 'woche wieder öffnen', 'teilzeit'],
    answer: 'Im Reiter „HR“ legst du die übliche Wochenstundenzahl und bei Bedarf eine eigene Zahl je Person fest. Ist die Personalakte eingeschaltet und dort eine Wochenstundenzahl hinterlegt, gilt diese. Genehmigte Wochen kannst du mit Begründung wieder öffnen, und du findest dort den Monatsexport.',
    steps: ['Prüfe die übliche Wochenstundenzahl.', 'Trage abweichende Wochenstunden je Person ein.', 'Lade zum Monatsende den Export für die Lohnabrechnung herunter.'],
    actions: [{ label: 'HR-Bereich öffnen', view: 'timeHr' }]
  },
  {
    id: 'time-correction',
    title: 'Zeiten anderer Personen korrigieren',
    roles: HR_OPERATOR_ROLES,
    views: ['timeHr'],
    keywords: ['zeiten korrigieren', 'zeit nachtragen', 'eintrag korrigieren', 'fremde zeiten', 'korrektur zeiterfassung'],
    answer: 'Im Reiter „HR“ wählst du bei einer Person „Zeiten“. Einträge ergänzt, änderst oder löschst du immer mit einem Grund. Der Grund steht im Verlauf der Woche, und die Person bekommt einen Hinweis. Eine genehmigte Woche öffnest du vorher mit einer Begründung wieder. Deine eigenen genehmigten Wochen und Wochenstunden ändert eine andere HR-Person.',
    steps: ['Öffne „Zeiterfassung“ und den Reiter „HR“.', 'Suche die Person und wähle „Zeiten“.', 'Ändere den Eintrag und nenne den Grund.'],
    actions: [{ label: 'HR-Bereich öffnen', view: 'timeHr' }]
  }
]);

/** Einzige Stelle mit SQLite-eigenen Schemaabfragen: Gibt es die Tabelle eines anderen Moduls mit diesen Spalten? */
function tableHasColumns(db, table, columns) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return false;
  const present = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
  return columns.every(column => present.has(column));
}

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

function mondayOf(isoDate) {
  return addDays(isoDate, -((weekdayOf(isoDate) + 6) % 7));
}

function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

/** Viele tippen 17.30, 17,30, 1730 oder 8:15. Alles Eindeutige wird zu HH:MM, alles andere bleibt und fällt später durch. */
function normalizeTime(value) {
  if (typeof value !== 'string') return value;
  const match = value.trim().match(/^(\d{1,2})(?:[:.,]?(\d{2}))?$/);
  if (!match) return value;
  return `${match[1].padStart(2, '0')}:${match[2] ?? '00'}`;
}

function isStartTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Ein Ende um 24:00 ist erlaubt, damit Arbeit über Mitternacht ohne Lücke in zwei Einträge passt. */
function isEndTime(value) {
  return value === '24:00' || isStartTime(value);
}

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(total) {
  const sign = total < 0 ? '-' : '';
  const absolute = Math.abs(total);
  return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, '0')}`;
}

function netMinutes(entry) {
  if (entry.end_time === null) return 0;
  return toMinutes(entry.end_time) - toMinutes(entry.start_time) - entry.break_minutes;
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

function createTimeModule({
  db, auth, current, isHr, isHrOperator, hrCanAccess, blocksSelfEdit, canViewEmployee, subordinateIds, cleanText, log, createTask,
  approvalRule, onManagerChanged, isModuleEnabled = () => false, now = berlinNow
}) {
  const router = express.Router();
  const today = () => now().date;
  const timestamp = () => new Date().toISOString();

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS time_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        weekly_hours REAL NOT NULL,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS time_person_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        weekly_hours REAL NOT NULL,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS time_entries (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        break_minutes INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_time_entries_user_date ON time_entries(user_id, date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_running ON time_entries(user_id) WHERE end_time IS NULL;
      CREATE TABLE IF NOT EXISTS time_entry_history (
        id INTEGER PRIMARY KEY,
        entry_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id),
        action TEXT NOT NULL CHECK (action IN ('update', 'clock_out', 'delete')),
        old_date TEXT NOT NULL,
        new_date TEXT,
        old_values TEXT NOT NULL,
        new_values TEXT,
        changed_by INTEGER NOT NULL REFERENCES users(id),
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_time_entry_history_user ON time_entry_history(user_id, old_date);
      CREATE TABLE IF NOT EXISTS time_weeks (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        week_start TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'approved', 'returned')),
        weekly_minutes REAL,
        submitted_at TEXT,
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_comment TEXT,
        reopened_by INTEGER REFERENCES users(id),
        reopened_at TEXT,
        reopen_reason TEXT,
        UNIQUE (user_id, week_start)
      );
      CREATE INDEX IF NOT EXISTS idx_time_weeks_status ON time_weeks(status, week_start);
    `);
    ensureColumn(db, 'time_entry_history', 'reason', 'TEXT');
    // Ältere Datenbanken kennen in ihrer CHECK-Regel nur update, clock_out und delete. Deshalb steht
    // „von HR angelegt“ in einer eigenen Spalte; die Regel lässt sich ohne Umbau nicht erweitern.
    ensureColumn(db, 'time_entry_history', 'is_creation', 'INTEGER NOT NULL DEFAULT 0');
    db.prepare(`
      INSERT INTO time_settings (id, weekly_hours)
      VALUES (1, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(DEFAULT_WEEKLY_HOURS);
  }

  // ---------------------------------------------------------------- Personen und Rechte

  function personById(id) {
    return db.prepare('SELECT id, name, email, role, manager_id, active FROM users WHERE id = ? AND is_system_account = 0').get(id);
  }

  /** HR-Zugriff auf eine Person. Die Sachbearbeitung ist dabei, anders als bei isHr; siehe hrCanAccess. */
  const hrMaySee = (actor, person) => isHrOperator(actor) && hrCanAccess(actor, person);

  /** Die direkte Führungskraft, sonst die HR-Administration. Gesperrte Führungskräfte zählen nicht. */
  function approverIds(person) {
    if (person.manager_id && approvalRule('time.approval') !== 'hr') {
      const manager = db.prepare('SELECT id FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(person.manager_id);
      if (manager) return [manager.id];
    }
    const hrWithRole = role => db.prepare('SELECT id FROM users WHERE role = ? AND is_system_account = 0 AND active = 1 AND id <> ?')
      .all(role, person.id)
      .map(row => row.id);
    const admins = hrWithRole('hr_admin');
    return admins.length ? admins : hrWithRole('hrbp');
  }

  /** Regel und offene Prüfaufgaben einer Anfrage. Sonst fragten lange Listen für jede Zeile neu nach. */
  function decisionContext() {
    let holders = null;
    const holdersOf = weekId => {
      if (!holders) {
        holders = new Map();
        for (const task of db.prepare("SELECT entity_id, user_id FROM tasks WHERE type = 'time_week_approval' AND done = 0").all()) {
          if (!holders.has(task.entity_id)) holders.set(task.entity_id, []);
          holders.get(task.entity_id).push(task.user_id);
        }
      }
      return holders.get(weekId) || [];
    };
    return { rule: approvalRule('time.approval'), holdersOf };
  }

  /**
   * Wer eine Prüfaufgabe aus der Zeit vor einer Regeländerung hat, kann weiter entscheiden. Dasselbe gilt
   * für den HR Business Partner, der mangels zweiter HR-Administration über die HR-Leitung entscheidet.
   */
  function canDecideWeek(actor, person, weekId, decisions = decisionContext()) {
    if (actor.id === person.id) return false;
    const holdsTask = () => weekId !== null && decisions.holdersOf(weekId).includes(actor.id);
    if (isHr(actor)) return hrCanAccess(actor, person) || holdsTask();
    if (person.manager_id !== actor.id) return false;
    return decisions.rule !== 'hr' || holdsTask();
  }

  /** Wer darf eine Prüfaufgabe weiter halten? Fällt jemand weg, muss sie neu verteilt werden. */
  function canHoldApproval(holderId, person) {
    if (holderId === person.id) return false;
    const holder = db.prepare('SELECT role FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(holderId);
    if (!holder) return false;
    return HR_DECIDER_ROLES.includes(holder.role) || holderId === person.manager_id;
  }

  /** Noch nicht Eingereichtes bleibt bei der Person und HR. Live-Einblick wäre Überwachung. */
  function canViewWeek(actor, userId, status) {
    if (actor.id === userId || hrMaySee(actor, userId)) return true;
    return MANAGER_VISIBLE_STATUSES.includes(status) && canViewEmployee(actor, userId);
  }

  function canEditEntriesOf(actor, userId) {
    return actor.id === userId || hrMaySee(actor, userId);
  }

  /** Wer entscheidet? Die Führungskraft mit Namen, sonst schlicht HR. Die Liste der HR-Personen hilft niemandem. */
  function deciderOf(person, weekId, decisions) {
    const holders = weekId === null ? [] : decisions.holdersOf(weekId);
    if (!holders.length && decisions.rule === 'none') return { kind: 'none', name: null };
    const responsible = holders.length ? holders : approverIds(person);
    if (!responsible.length) return { kind: 'nobody', name: null };
    if (responsible.length === 1 && responsible[0] === person.manager_id) {
      return { kind: 'manager', name: personById(person.manager_id)?.name ?? null };
    }
    return { kind: 'hr', name: 'HR' };
  }

  // ---------------------------------------------------------------- Angaben anderer Module

  const knownTables = new Set();

  /** Gibt es die Tabelle eines anderen Moduls schon? Einmal gefunden, bleibt sie: Das spart Abfragen je Person. */
  function hasTable(table, columns) {
    const key = `${table}:${columns.join(',')}`;
    if (knownTables.has(key)) return true;
    if (!tableHasColumns(db, table, columns)) return false;
    knownTables.add(key);
    return true;
  }

  function personnelNumbers() {
    if (!isModuleEnabled('personnel') || !hasTable('personnel_records', ['user_id', 'personnel_number'])) return new Map();
    const rows = db.prepare('SELECT user_id, personnel_number FROM personnel_records WHERE personnel_number IS NOT NULL').all();
    return new Map(rows.map(row => [row.user_id, row.personnel_number]));
  }

  /** Letzte Arbeitstage aktuell gesperrter Personen, so wie die Personalakte den Austritt festhält. */
  function exitDates() {
    if (!hasTable('personnel_changes', ['user_id', 'kind', 'status', 'effective_date'])) return new Map();
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

  // ---------------------------------------------------------------- Soll

  function readSettings() {
    return db.prepare('SELECT weekly_hours FROM time_settings WHERE id = 1').get();
  }

  function personnelHours(userId) {
    if (!isModuleEnabled('personnel') || !hasTable('personnel_records', ['user_id', 'weekly_hours'])) return null;
    const record = db.prepare('SELECT weekly_hours FROM personnel_records WHERE user_id = ?').get(userId);
    return typeof record?.weekly_hours === 'number' && record.weekly_hours > 0 ? record.weekly_hours : null;
  }

  function weeklyHoursFor(userId) {
    const fromPersonnel = personnelHours(userId);
    if (fromPersonnel !== null) return { hours: fromPersonnel, source: 'personnel' };
    const personal = db.prepare('SELECT weekly_hours FROM time_person_settings WHERE user_id = ?').get(userId);
    if (personal) return { hours: personal.weekly_hours, source: 'person' };
    return { hours: readSettings().weekly_hours, source: 'default' };
  }

  function absenceAvailable() {
    return isModuleEnabled('absence')
      && hasTable('absence_holidays', ['date', 'name'])
      && hasTable('absence_requests', ['user_id', 'status', 'start_date', 'end_date', 'start_half', 'end_half']);
  }

  /** Die Art einer Abwesenheit wird hier gar nicht erst gelesen: Sie könnte vertraulich sein. */
  function absenceCalendar(userId, first, last) {
    if (!absenceAvailable()) return { holidays: new Map(), absences: [] };
    const holidays = db.prepare('SELECT date, name FROM absence_holidays WHERE date >= ? AND date <= ?').all(first, last);
    const absences = db.prepare(`
      SELECT start_date, end_date, start_half, end_half
      FROM absence_requests
      WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?
    `).all(userId, last, first);
    return { holidays: new Map(holidays.map(holiday => [holiday.date, holiday.name])), absences };
  }

  function absentShare(calendar, date) {
    let share = 0;
    for (const absence of calendar.absences) {
      if (absence.start_date > date || absence.end_date < date) continue;
      const isHalf = (date === absence.start_date && absence.start_half) || (date === absence.end_date && absence.end_half);
      share += isHalf ? 0.5 : 1;
    }
    return Math.min(1, share);
  }

  // ---------------------------------------------------------------- Wochen berechnen

  function loadContext(userId, first, last) {
    const entries = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, start_time').all(userId, first, last);
    const entriesByDate = new Map();
    for (const entry of entries) {
      if (!entriesByDate.has(entry.date)) entriesByDate.set(entry.date, []);
      entriesByDate.get(entry.date).push(entry);
    }
    const weeks = db.prepare(`
      SELECT w.*, d.name AS decided_by_name
      FROM time_weeks w
      LEFT JOIN users d ON d.id = w.decided_by
      WHERE w.user_id = ? AND w.week_start >= ? AND w.week_start <= ?
    `).all(userId, mondayOf(first), last);
    // Kommen und Gehen ist der normale Weg, und das Anlegen durch HR zeigt die Ansicht eigens an. Geändert ist beides nicht.
    const changedIds = db.prepare("SELECT DISTINCT entry_id FROM time_entry_history WHERE user_id = ? AND action <> 'clock_out' AND is_creation = 0").all(userId).map(row => row.entry_id);
    return {
      userId,
      entriesByDate,
      weeks: new Map(weeks.map(week => [week.week_start, week])),
      changedIds: new Set(changedIds),
      firstEntryDate: db.prepare('SELECT MIN(date) AS date FROM time_entries WHERE user_id = ? AND end_time IS NOT NULL').get(userId).date,
      calendar: absenceCalendar(userId, first, last),
      hours: weeklyHoursFor(userId)
    };
  }

  function entryView(entry, changedIds) {
    return {
      id: entry.id,
      userId: entry.user_id,
      date: entry.date,
      startTime: entry.start_time,
      endTime: entry.end_time,
      breakMinutes: entry.break_minutes,
      note: entry.note,
      netMinutes: netMinutes(entry),
      running: entry.end_time === null,
      changed: changedIds.has(entry.id),
      enteredByOther: entry.created_by !== entry.user_id
    };
  }

  /**
   * Das Soll einer genehmigten Woche bleibt bei ihrer damaligen Wochenstundenzahl, sonst würde ein
   * Wechsel auf Teilzeit die Vergangenheit umrechnen. Feiertage und Abwesenheiten wirken immer aktuell.
   * Zum Saldo zählt das Soll erst ab dem ersten Eintrag der Person und nur bis heute; der heutige Tag
   * erst mit dem ersten abgeschlossenen Eintrag. Wochen ohne Einträge zählen gar nicht, denn sonst
   * entstünde bei jeder nicht erfassten Urlaubswoche ein falsches Minus.
   */
  function computeWeek(context, weekStart) {
    const row = context.weeks.get(weekStart) || null;
    const weeklyMinutes = row?.weekly_minutes ?? context.hours.hours * 60;
    const dailyMinutes = weeklyMinutes / WORKDAYS_PER_WEEK;
    const todayDate = today();
    const days = [];
    let target = 0;
    let due = 0;
    let actualMinutes = 0;
    let closedCount = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(weekStart, offset);
      const entries = context.entriesByDate.get(date) || [];
      const closed = entries.filter(entry => entry.end_time !== null);
      const dayActual = closed.reduce((sum, entry) => sum + netMinutes(entry), 0);
      const weekday = weekdayOf(date);
      const holidayName = context.calendar.holidays.get(date) || null;
      const share = absentShare(context.calendar, date);
      const dayTarget = weekday === 0 || weekday === 6 || holidayName ? 0 : dailyMinutes * (1 - share);
      const isDue = context.firstEntryDate !== null
        && date >= context.firstEntryDate
        && (date < todayDate || (date === todayDate && closed.length > 0));
      target += dayTarget;
      if (isDue) due += dayTarget;
      actualMinutes += dayActual;
      closedCount += closed.length;
      days.push({
        date,
        weekday: WEEKDAY_NAMES[weekday],
        targetMinutes: Math.round(dayTarget),
        actualMinutes: dayActual,
        holidayName,
        absentShare: share,
        entries: entries.map(entry => entryView(entry, context.changedIds))
      });
    }
    const counted = closedCount > 0;
    const dueMinutes = counted ? Math.round(due) : 0;
    return {
      row,
      weekStart,
      weekEnd: addDays(weekStart, 6),
      status: row?.status || 'open',
      days,
      targetMinutes: Math.round(target),
      dueMinutes,
      actualMinutes,
      balanceMinutes: actualMinutes - dueMinutes,
      counted,
      closedCount,
      hasRunning: days.some(day => day.entries.some(entry => entry.running)),
      weeklyMinutes,
      hoursSource: context.hours.source
    };
  }

  function computeWeekFor(userId, weekStart) {
    return computeWeek(loadContext(userId, weekStart, addDays(weekStart, 6)), weekStart);
  }

  function totalBalanceMinutes(userId) {
    const range = db.prepare('SELECT MIN(date) AS first, MAX(date) AS last FROM time_entries WHERE user_id = ? AND end_time IS NOT NULL').get(userId);
    if (!range.first) return 0;
    const firstWeek = mondayOf(range.first);
    const lastWeek = mondayOf(range.last);
    const context = loadContext(userId, firstWeek, addDays(lastWeek, 6));
    let total = 0;
    for (let week = firstWeek; week <= lastWeek; week = addDays(week, 7)) total += computeWeek(context, week).balanceMinutes;
    return total;
  }

  /**
   * Wochenstunden und Gesamtsaldo aller genannten Personen in wenigen Abfragen. Einzeln wären es rund
   * ein Dutzend je Person, und das blockiert den Server spürbar, sobald die Liste länger wird.
   */
  function hoursAndBalances(userIds) {
    const groupByUser = rows => {
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.user_id)) grouped.set(row.user_id, []);
        grouped.get(row.user_id).push(row);
      }
      return grouped;
    };
    const fallback = readSettings().weekly_hours;
    const personal = new Map(db.prepare('SELECT user_id, weekly_hours FROM time_person_settings').all().map(row => [row.user_id, row.weekly_hours]));
    const fromPersonnel = isModuleEnabled('personnel') && hasTable('personnel_records', ['user_id', 'weekly_hours'])
      ? new Map(db.prepare('SELECT user_id, weekly_hours FROM personnel_records WHERE weekly_hours > 0').all().map(row => [row.user_id, row.weekly_hours]))
      : new Map();
    const entriesByUser = groupByUser(db.prepare('SELECT * FROM time_entries WHERE end_time IS NOT NULL ORDER BY date, start_time').all());
    const weeksByUser = groupByUser(db.prepare('SELECT * FROM time_weeks').all());
    const withAbsence = absenceAvailable();
    const holidays = withAbsence ? new Map(db.prepare('SELECT date, name FROM absence_holidays').all().map(row => [row.date, row.name])) : new Map();
    const absencesByUser = withAbsence
      ? groupByUser(db.prepare("SELECT user_id, start_date, end_date, start_half, end_half FROM absence_requests WHERE status = 'approved'").all())
      : new Map();

    const result = new Map();
    for (const userId of userIds) {
      let hours;
      if (fromPersonnel.has(userId)) hours = { hours: fromPersonnel.get(userId), source: 'personnel' };
      else if (personal.has(userId)) hours = { hours: personal.get(userId), source: 'person' };
      else hours = { hours: fallback, source: 'default' };
      const entries = entriesByUser.get(userId) || [];
      let totalBalance = 0;
      if (entries.length) {
        const entriesByDate = new Map();
        for (const entry of entries) {
          if (!entriesByDate.has(entry.date)) entriesByDate.set(entry.date, []);
          entriesByDate.get(entry.date).push(entry);
        }
        const context = {
          userId,
          entriesByDate,
          weeks: new Map((weeksByUser.get(userId) || []).map(week => [week.week_start, week])),
          changedIds: new Set(),
          firstEntryDate: entries[0].date,
          calendar: { holidays, absences: absencesByUser.get(userId) || [] },
          hours
        };
        const lastWeek = mondayOf(entries[entries.length - 1].date);
        for (let week = mondayOf(entries[0].date); week <= lastWeek; week = addDays(week, 7)) {
          totalBalance += computeWeek(context, week).balanceMinutes;
        }
      }
      result.set(userId, { hours, totalBalanceMinutes: totalBalance });
    }
    return result;
  }

  // ---------------------------------------------------------------- Hinweise

  function hint(code, date, text, check = HINT_CHECK) {
    return { code, date, message: `${text} ${check}` };
  }

  function dayHints(date, entries, holidayName, absentShare = 0) {
    const hints = [];
    const closed = entries.filter(entry => entry.end_time !== null);
    const net = closed.reduce((sum, entry) => sum + netMinutes(entry), 0);
    const label = `Am ${formatDate(date)}`;
    if (net > DAILY_LIMIT_MINUTES) {
      hints.push(hint('daily_limit', date, `${label} sind ${formatMinutes(net)} Stunden Arbeitszeit erfasst (mehr als 10 Stunden).`));
    }
    let breaks = closed.reduce((sum, entry) => sum + entry.break_minutes, 0);
    for (let index = 1; index < closed.length; index += 1) {
      const gap = toMinutes(closed[index].start_time) - toMinutes(closed[index - 1].end_time);
      if (gap >= MIN_COUNTED_BREAK_MINUTES) breaks += gap;
    }
    if (net > LONG_DAY_MINUTES && breaks < LONG_DAY_BREAK_MINUTES) {
      hints.push(hint('short_break', date, `${label} sind bei ${formatMinutes(net)} Stunden Arbeitszeit nur ${breaks} Minuten Pause erfasst (weniger als 45 Minuten bei über 9 Stunden).`));
    } else if (net > NORMAL_DAY_MINUTES && net <= LONG_DAY_MINUTES && breaks < NORMAL_DAY_BREAK_MINUTES) {
      hints.push(hint('short_break', date, `${label} sind bei ${formatMinutes(net)} Stunden Arbeitszeit nur ${breaks} Minuten Pause erfasst (weniger als 30 Minuten bei über 6 Stunden).`));
    }
    if (entries.length && weekdayOf(date) === 0) {
      hints.push(hint('sunday_or_holiday', date, `${label} (Sonntag) ist Arbeitszeit erfasst.`));
    } else if (entries.length && holidayName) {
      hints.push(hint('sunday_or_holiday', date, `${label} (Feiertag: ${holidayName}) ist Arbeitszeit erfasst.`));
    }
    // Die Art bleibt offen: Auch die Führungskraft liest diesen Hinweis, wenn die Woche eingereicht ist.
    if (entries.length && absentShare >= 1) {
      hints.push(hint('absent_day', date, `${label} ist Arbeitszeit erfasst, obwohl für den ganzen Tag eine Abwesenheit eingetragen ist.`, HINT_CHECK_ABSENCE));
    }
    return hints;
  }

  /**
   * Ruhezeit liegt zwischen zwei Arbeitstagen, nicht in der Mittagspause. Eine Ausnahme ist nötig:
   * Nach einer Nachtschicht über Mitternacht liegt die Ruhezeit bis zur nächsten Schicht am selben Datum.
   */
  function restHints(closedEntries, entryBefore) {
    const hints = [];
    let previous = entryBefore;
    let inOvernightShift = false;
    for (const entry of closedEntries) {
      if (previous) {
        const dayDifference = (toUtcMs(entry.date) - toUtcMs(previous.date)) / DAY_MS;
        const gap = dayDifference * MINUTES_PER_DAY + toMinutes(entry.start_time) - toMinutes(previous.end_time);
        const continuesOvernight = dayDifference > 0 && gap <= CONTINUOUS_SHIFT_GAP_MINUTES;
        const isRest = dayDifference > 0
          ? !continuesOvernight
          : inOvernightShift && gap >= SHIFT_END_GAP_MINUTES;
        if (isRest && gap < MIN_REST_MINUTES) {
          hints.push(hint('short_rest', entry.date, `Vor dem Arbeitsbeginn am ${formatDate(entry.date)} um ${entry.start_time} lagen nur ${formatMinutes(gap)} Stunden Ruhezeit (weniger als 11 Stunden).`));
        }
        if (continuesOvernight) inOvernightShift = true;
        else if (isRest) inOvernightShift = false;
      }
      previous = entry;
    }
    return hints;
  }

  /** Der letzte Eintrag davor zählt nur, wenn die Betrachtenden ihn auch sehen dürfen. */
  function visibleEntryBefore(actor, userId, weekStart) {
    const entry = db.prepare(`
      SELECT date, start_time, end_time
      FROM time_entries
      WHERE user_id = ? AND date < ? AND end_time IS NOT NULL
      ORDER BY date DESC, start_time DESC
      LIMIT 1
    `).get(userId, weekStart);
    if (!entry) return null;
    return canViewWeek(actor, userId, weekStatus(userId, entry.date)) ? entry : null;
  }

  function weekHints(week, actor, userId) {
    const entryBefore = visibleEntryBefore(actor, userId, week.weekStart);
    const rows = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, start_time').all(userId, week.weekStart, week.weekEnd);
    const hints = [];
    for (const day of week.days) {
      hints.push(...dayHints(day.date, rows.filter(entry => entry.date === day.date), day.holidayName, day.absentShare));
    }
    hints.push(...restHints(rows.filter(entry => entry.end_time !== null), entryBefore));
    return hints.sort((left, right) => left.date.localeCompare(right.date));
  }

  function hintsForDate(actor, userId, date) {
    return weekHints(computeWeekFor(userId, mondayOf(date)), actor, userId);
  }

  // ---------------------------------------------------------------- Wochenzeilen

  function weekRow(userId, weekStart) {
    return db.prepare('SELECT * FROM time_weeks WHERE user_id = ? AND week_start = ?').get(userId, weekStart);
  }

  function weekStatus(userId, date) {
    return weekRow(userId, mondayOf(date))?.status || 'open';
  }

  function ensureWeekRow(userId, weekStart) {
    db.prepare(`
      INSERT INTO time_weeks (user_id, week_start, status)
      VALUES (?, ?, 'open')
      ON CONFLICT (user_id, week_start) DO NOTHING
    `).run(userId, weekStart);
    return weekRow(userId, weekStart);
  }

  function lockedWeekMessage(userId, date) {
    return `Die Woche ab ${formatDate(mondayOf(date))} ist ${STATUS_LABELS[weekStatus(userId, date)]} und kann nicht mehr bearbeitet werden.`;
  }

  function closeTasks(weekId, types) {
    const update = db.prepare('UPDATE tasks SET done = 1 WHERE type = ? AND entity_id = ? AND done = 0');
    for (const type of types) update.run(type, weekId);
  }

  function approvalTitle(person, weekStart) {
    return `Zeiten prüfen: ${person.name}, Woche ab ${formatDate(weekStart)}`;
  }

  function parseWeek(value) {
    if (value === undefined) return mondayOf(today());
    return isRealDate(value) ? mondayOf(value) : null;
  }

  /** Bis zur Entscheidung gehört die Woche noch der Person. Ohne Freigaberegel hat niemand entschieden. */
  function isWithdrawable(row) {
    if (!row) return false;
    return row.status === 'submitted' || (row.status === 'approved' && row.decided_by === null);
  }

  /** Geht „Kommen“ gerade? Die Oberfläche bietet es sonst gar nicht erst an. */
  function clockState(userId) {
    const { date } = now();
    const row = weekRow(userId, mondayOf(date));
    if (row && !EDITABLE_STATUSES.includes(row.status)) {
      return { canClockIn: false, reason: 'week_locked', weekId: row.id, weekStart: row.week_start, statusLabel: STATUS_LABELS[row.status], canWithdraw: isWithdrawable(row) };
    }
    if (absentShare(absenceCalendar(userId, date, date), date) >= 1) return { canClockIn: false, reason: 'absent' };
    return { canClockIn: true, reason: null };
  }

  function weekView(actor, person, week, decisions = decisionContext()) {
    const row = week.row;
    const own = actor.id === person.id;
    const editable = EDITABLE_STATUSES.includes(week.status);
    return {
      id: row?.id || null,
      person: { id: person.id, name: person.name },
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      status: week.status,
      statusLabel: STATUS_LABELS[week.status],
      submittedAt: row?.submitted_at || null,
      decidedAt: row?.decided_at || null,
      decidedByName: row?.decided_by_name || null,
      decisionComment: row?.decision_comment || null,
      reopenedAt: row?.reopened_at || null,
      reopenReason: row?.reopen_reason || null,
      targetMinutes: week.targetMinutes,
      dueMinutes: week.dueMinutes,
      actualMinutes: week.actualMinutes,
      balanceMinutes: week.balanceMinutes,
      counted: week.counted,
      weeklyHours: week.weeklyMinutes / 60,
      hoursSource: week.hoursSource,
      days: week.days,
      hints: weekHints(week, actor, person.id),
      inProgress: today() <= week.weekEnd,
      decider: deciderOf(person, row?.id ?? null, decisions),
      canEdit: editable && canEditEntriesOf(actor, person.id),
      canSubmit: own && editable && week.closedCount > 0 && !week.hasRunning,
      canWithdraw: own && isWithdrawable(row),
      canDecide: week.status === 'submitted' && canDecideWeek(actor, person, row?.id ?? null, decisions),
      canReopen: week.status === 'approved' && hrMaySee(actor, person) && !blocksSelfEdit(actor, person.id)
    };
  }

  // ---------------------------------------------------------------- Einträge prüfen und schreiben

  function readEntryInput(body, existing) {
    const pick = (field, column, fallback) => {
      if (body[field] !== undefined) return body[field];
      return existing ? existing[column] : fallback;
    };
    const input = {
      date: pick('date', 'date'),
      start: normalizeTime(pick('startTime', 'start_time')),
      end: normalizeTime(pick('endTime', 'end_time')),
      breakMinutes: pick('breakMinutes', 'break_minutes', 0),
      note: body.note === undefined ? (existing?.note ?? null) : (cleanText(body.note, 500) || null)
    };
    if (!isRealDate(input.date)) return { error: 'Bitte gib ein gültiges Datum an.' };
    if (input.date > today()) return { error: 'Zeiten in der Zukunft lassen sich nicht erfassen.' };
    if (Number(input.date.slice(0, 4)) < Number(today().slice(0, 4)) - YEAR_WINDOW) return { error: 'Dieses Datum liegt zu weit zurück.' };
    if (!isStartTime(input.start)) return { error: 'Bitte gib den Beginn als Uhrzeit an, zum Beispiel 08:30.' };
    const staysRunning = existing && existing.end_time === null && input.end === null;
    if (!staysRunning && !isEndTime(input.end)) return { error: 'Bitte gib das Ende als Uhrzeit an, zum Beispiel 17:30.' };

    const breakMinutes = Number(input.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > MAX_BREAK_MINUTES) return { error: 'Die Pause muss eine ganze Zahl von Minuten sein.' };
    input.breakMinutes = breakMinutes;
    if (!staysRunning) {
      const duration = toMinutes(input.end) - toMinutes(input.start);
      if (duration <= 0) return { error: 'Das Ende muss nach dem Beginn liegen. Arbeit über Mitternacht trägst du als zwei Einträge ein (bis 24:00 und ab 00:00).' };
      if (breakMinutes >= duration) return { error: 'Die Pause muss kürzer sein als die erfasste Zeit.' };
    }
    return { input };
  }

  /** Ein laufender Eintrag belegt den Rest des Tages, weil sein Ende noch offen ist. */
  function findOverlap(userId, date, start, end, exceptId = 0) {
    const others = db.prepare('SELECT id, start_time, end_time FROM time_entries WHERE user_id = ? AND date = ? AND id <> ?').all(userId, date, exceptId);
    const from = toMinutes(start);
    const until = end === null ? MINUTES_PER_DAY : toMinutes(end);
    return others.find(other => {
      const otherFrom = toMinutes(other.start_time);
      const otherUntil = other.end_time === null ? MINUTES_PER_DAY : toMinutes(other.end_time);
      return from < otherUntil && otherFrom < until;
    }) || null;
  }

  function overlapMessage(other) {
    const until = other.end_time === null ? 'läuft noch' : `bis ${other.end_time}`;
    return `Das überschneidet sich mit einem anderen Eintrag an diesem Tag (ab ${other.start_time}, ${until}).`;
  }

  function historyValues(entry) {
    return {
      date: entry.date,
      startTime: entry.start_time,
      endTime: entry.end_time,
      breakMinutes: entry.break_minutes,
      note: entry.note
    };
  }

  function writeHistory(action, before, after, actor, reason = null) {
    db.prepare(`
      INSERT INTO time_entry_history (entry_id, user_id, action, old_date, new_date, old_values, new_values, changed_by, changed_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      before.id,
      before.user_id,
      action,
      before.date,
      after ? after.date : null,
      JSON.stringify(historyValues(before)),
      after ? JSON.stringify(historyValues(after)) : null,
      actor.id,
      timestamp(),
      reason
    );
  }

  /** Legt HR einen Eintrag für eine andere Person an, gehört das in deren Verlauf. Eigene Einträge nicht. */
  function writeCreationHistory(entry, actor, reason) {
    db.prepare(`
      INSERT INTO time_entry_history (entry_id, user_id, action, old_date, new_date, old_values, new_values, changed_by, changed_at, reason, is_creation)
      VALUES (?, ?, 'update', ?, ?, 'null', ?, ?, ?, ?, 1)
    `).run(entry.id, entry.user_id, entry.date, entry.date, JSON.stringify(historyValues(entry)), actor.id, timestamp(), reason);
  }

  const correctionProblem = 'Bitte nenne einen Grund für die Korrektur. Die Person sieht ihn im Verlauf der Woche.';

  /** Wer in fremde Zeiten schreibt, muss das begründen. Eigene Änderungen brauchen keinen Grund. */
  const correctionReason = (actor, userId, body) => (actor.id === userId ? null : cleanText(body.reason, 500));

  function notifyAboutCorrection(actor, userId, date, verb, reason) {
    if (actor.id === userId || !personById(userId)?.active) return;
    const week = ensureWeekRow(userId, mondayOf(date));
    createTask(userId, `HR hat deine Zeiten vom ${formatDate(date)} ${verb}. Grund: ${reason}`, 'time_correction_notice', week.id);
  }

  function entryById(id) {
    return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
  }

  function insertEntry(userId, date, start, end, breakMinutes, note, actorId) {
    return db.prepare(`
      INSERT INTO time_entries (user_id, date, start_time, end_time, break_minutes, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, date, start, end, breakMinutes, note, actorId, timestamp()).lastInsertRowid;
  }

  function closeRunningEntry(entry, endTime, breakMinutes, actor) {
    db.prepare('UPDATE time_entries SET end_time = ?, break_minutes = ?, updated_at = ? WHERE id = ?').run(endTime, breakMinutes, timestamp(), entry.id);
    writeHistory('clock_out', entry, entryById(entry.id), actor);
  }

  function runningEntryOf(userId) {
    return db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND end_time IS NULL').get(userId) || null;
  }

  // ---------------------------------------------------------------- Wartung und Demo

  /** Verteilt die Prüfaufgaben einer Woche neu, wenn sich die Zuständigkeit geändert hat. */
  function reassignApprovalTasks(person, week) {
    const responsible = approverIds(person);
    const openTasks = db.prepare("SELECT id, user_id FROM tasks WHERE type = 'time_week_approval' AND entity_id = ? AND done = 0").all(week.id);
    for (const task of openTasks) {
      if (!responsible.includes(task.user_id)) db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
    }
    for (const userId of responsible) {
      if (!openTasks.some(task => task.user_id === userId)) createTask(userId, approvalTitle(person, week.week_start), 'time_week_approval', week.id);
    }
  }

  // Wechselt die Führungskraft, wechselt auch die Entscheidung über eingereichte Wochen.
  onManagerChanged?.(({ userId }) => {
    const person = personById(userId);
    if (!person) return;
    for (const week of db.prepare("SELECT id, week_start FROM time_weeks WHERE user_id = ? AND status = 'submitted'").all(userId)) {
      reassignApprovalTasks(person, week);
    }
  });

  /**
   * Gesperrte Konten dürfen keine eingereichte Woche liegen lassen. Eine geänderte Regel verschiebt nichts:
   * Wer die Aufgabe hat und weiter entscheiden darf, behält sie. So stimmt der Text bei den Genehmigungsregeln.
   */
  function syncApprovalTasks() {
    const submitted = db.prepare("SELECT id, user_id, week_start FROM time_weeks WHERE status = 'submitted'").all();
    db.transaction(() => {
      for (const week of submitted) {
        const person = personById(week.user_id);
        if (!person) continue;
        const openTasks = db.prepare("SELECT id, user_id FROM tasks WHERE type = 'time_week_approval' AND entity_id = ? AND done = 0").all(week.id);
        const stillValid = openTasks.filter(task => canHoldApproval(task.user_id, person));
        for (const task of openTasks) {
          if (!stillValid.includes(task)) db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
        }
        if (stillValid.length) continue;
        for (const userId of approverIds(person)) createTask(userId, approvalTitle(person, week.week_start), 'time_week_approval', week.id);
      }
    })();
  }

  function seedDemo() {
    const people = db.prepare('SELECT id, name, manager_id FROM users WHERE is_system_account = 0 AND active = 1 ORDER BY id').all();
    if (!people.length) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count > 0) return;
    const employees = people.filter(person => person.manager_id && people.some(other => other.id === person.manager_id));
    if (!employees.length) return;
    const fillWeek = (person, weekStart) => {
      for (let offset = 0; offset < 5; offset += 1) {
        insertEntry(person.id, addDays(weekStart, offset), '08:30', '17:15', 45, null, person.id);
      }
    };
    const thisWeek = mondayOf(today());
    const lastWeek = addDays(thisWeek, -7);
    const weekBefore = addDays(thisWeek, -14);

    const approved = employees[0];
    fillWeek(approved, weekBefore);
    const approvedWeek = ensureWeekRow(approved.id, weekBefore);
    db.prepare(`
      UPDATE time_weeks
      SET status = 'approved', submitted_at = ?, decided_by = ?, decided_at = ?, weekly_minutes = ?
      WHERE id = ?
    `).run(timestamp(), approved.manager_id, timestamp(), weeklyHoursFor(approved.id).hours * 60, approvedWeek.id);

    const submitted = employees[1 % employees.length];
    fillWeek(submitted, lastWeek);
    const submittedWeek = ensureWeekRow(submitted.id, lastWeek);
    db.prepare("UPDATE time_weeks SET status = 'submitted', submitted_at = ? WHERE id = ?").run(timestamp(), submittedWeek.id);
    createTask(submitted.manager_id, approvalTitle(submitted, lastWeek), 'time_week_approval', submittedWeek.id);
  }

  // ---------------------------------------------------------------- Routen

  router.use('/time', auth);

  router.get('/time/week', (req, res) => {
    const actor = current(req);
    const weekStart = parseWeek(req.query.week);
    if (!weekStart) return fail(res, 400, 'Bitte gib ein gültiges Datum für die Woche an.');
    const userId = req.query.userId === undefined ? actor.id : positiveId(req.query.userId);
    if (!userId) return fail(res, 400, 'Die angegebene Person ist ungültig.');
    const decisions = decisionContext();
    const row = weekRow(userId, weekStart);
    // Wer die Prüfaufgabe hat, muss die Woche auch sehen können. Das betrifft den Vertreter der HR-Leitung.
    const holdsTask = Boolean(row) && decisions.holdersOf(row.id).includes(actor.id);
    if (!holdsTask && !canViewEmployee(actor, userId) && !hrMaySee(actor, userId)) return fail(res, 403, 'Du darfst die Zeiten dieser Person nicht sehen.');
    const person = personById(userId);
    if (!person) return fail(res, 404, 'Person nicht gefunden.');
    if (!holdsTask && !canViewWeek(actor, userId, row?.status || 'open')) return fail(res, 403, 'Diese Woche wurde noch nicht eingereicht.');

    const view = weekView(actor, person, computeWeekFor(userId, weekStart), decisions);
    if (actor.id === userId || hrMaySee(actor, person)) {
      view.totalBalanceMinutes = totalBalanceMinutes(userId);
      const running = runningEntryOf(userId);
      view.running = running ? entryView(running, new Set()) : null;
    }
    if (actor.id === userId) view.clock = clockState(userId);
    res.json({ week: view });
  });

  router.get('/time/history', (req, res) => {
    const actor = current(req);
    const weekStart = parseWeek(req.query.week);
    if (!weekStart) return fail(res, 400, 'Bitte gib ein gültiges Datum für die Woche an.');
    const userId = req.query.userId === undefined ? actor.id : positiveId(req.query.userId);
    if (!userId) return fail(res, 400, 'Die angegebene Person ist ungültig.');
    if (!canViewWeek(actor, userId, weekStatus(userId, weekStart))) return fail(res, 403, 'Du darfst diesen Verlauf nicht sehen.');
    if (!personById(userId)) return fail(res, 404, 'Person nicht gefunden.');
    const weekEnd = addDays(weekStart, 6);
    const rows = db.prepare(`
      SELECT h.*, u.name AS changed_by_name
      FROM time_entry_history h
      JOIN users u ON u.id = h.changed_by
      WHERE h.user_id = ? AND ((h.old_date >= ? AND h.old_date <= ?) OR (h.new_date >= ? AND h.new_date <= ?))
      ORDER BY h.changed_at DESC, h.id DESC
    `).all(userId, weekStart, weekEnd, weekStart, weekEnd);
    res.json({
      history: rows.map(row => ({
        id: row.id,
        entryId: row.entry_id,
        action: row.is_creation ? 'create' : row.action,
        before: JSON.parse(row.old_values),
        after: row.new_values ? JSON.parse(row.new_values) : null,
        reason: row.reason,
        changedByName: row.changed_by_name,
        changedAt: row.changed_at
      }))
    });
  });

  router.post('/time/entries', (req, res) => {
    const actor = current(req);
    const body = bodyOf(req);
    const userId = [undefined, null, ''].includes(body.userId) ? actor.id : positiveId(body.userId);
    if (!userId) return fail(res, 400, 'Die angegebene Person ist ungültig.');
    if (!canEditEntriesOf(actor, userId)) return fail(res, 403, 'Zeiten darf nur die Person selbst oder HR erfassen.');
    if (!personById(userId)) return fail(res, 404, 'Person nicht gefunden.');
    const { input, error } = readEntryInput(body, null);
    if (error) return fail(res, 400, error);
    if (!EDITABLE_STATUSES.includes(weekStatus(userId, input.date))) return fail(res, 409, lockedWeekMessage(userId, input.date));
    const overlap = findOverlap(userId, input.date, input.start, input.end);
    if (overlap) return fail(res, 400, overlapMessage(overlap));
    const reason = correctionReason(actor, userId, body);
    if (actor.id !== userId && !reason) return fail(res, 400, correctionProblem);

    const id = db.transaction(() => {
      const newId = insertEntry(userId, input.date, input.start, input.end, input.breakMinutes, input.note, actor.id);
      log(actor.id, 'time_entry_created', 'time_entries', newId, null, { userId, date: input.date, ...(reason ? { reason } : {}) });
      if (reason) {
        writeCreationHistory(entryById(newId), actor, reason);
        notifyAboutCorrection(actor, userId, input.date, 'ergänzt', reason);
      }
      return newId;
    })();
    res.status(201).json({ entry: entryView(entryById(id), new Set()), hints: hintsForDate(actor, userId, input.date) });
  });

  router.patch('/time/entries/:id', (req, res) => {
    const actor = current(req);
    const entry = entryById(positiveId(req.params.id));
    if (!entry) return fail(res, 404, 'Eintrag nicht gefunden.');
    if (!canEditEntriesOf(actor, entry.user_id)) return fail(res, 403, 'Zeiten darf nur die Person selbst oder HR ändern.');
    const body = bodyOf(req);
    const { input, error } = readEntryInput(body, entry);
    if (error) return fail(res, 400, error);
    for (const date of [entry.date, input.date]) {
      if (!EDITABLE_STATUSES.includes(weekStatus(entry.user_id, date))) return fail(res, 409, lockedWeekMessage(entry.user_id, date));
    }
    const overlap = findOverlap(entry.user_id, input.date, input.start, input.end, entry.id);
    if (overlap) return fail(res, 400, overlapMessage(overlap));
    const reason = correctionReason(actor, entry.user_id, body);
    if (actor.id !== entry.user_id && !reason) return fail(res, 400, correctionProblem);

    db.transaction(() => {
      db.prepare(`
        UPDATE time_entries
        SET date = ?, start_time = ?, end_time = ?, break_minutes = ?, note = ?, updated_at = ?
        WHERE id = ?
      `).run(input.date, input.start, input.end, input.breakMinutes, input.note, timestamp(), entry.id);
      writeHistory('update', entry, entryById(entry.id), actor, reason);
      log(actor.id, 'time_entry_updated', 'time_entries', entry.id, { date: entry.date }, { date: input.date, ...(reason ? { reason } : {}) });
      if (reason) notifyAboutCorrection(actor, entry.user_id, input.date, 'geändert', reason);
    })();
    res.json({ entry: entryView(entryById(entry.id), new Set([entry.id])), hints: hintsForDate(actor, entry.user_id, input.date) });
  });

  router.delete('/time/entries/:id', (req, res) => {
    const actor = current(req);
    const entry = entryById(positiveId(req.params.id));
    if (!entry) return fail(res, 404, 'Eintrag nicht gefunden.');
    if (!canEditEntriesOf(actor, entry.user_id)) return fail(res, 403, 'Zeiten darf nur die Person selbst oder HR löschen.');
    if (!EDITABLE_STATUSES.includes(weekStatus(entry.user_id, entry.date))) return fail(res, 409, lockedWeekMessage(entry.user_id, entry.date));
    const reason = correctionReason(actor, entry.user_id, bodyOf(req));
    if (actor.id !== entry.user_id && !reason) return fail(res, 400, correctionProblem);

    const weekStart = mondayOf(entry.date);
    db.transaction(() => {
      writeHistory('delete', entry, null, actor, reason);
      db.prepare('DELETE FROM time_entries WHERE id = ?').run(entry.id);
      log(actor.id, 'time_entry_deleted', 'time_entries', entry.id, { userId: entry.user_id, date: entry.date }, reason ? { reason } : null);
      if (reason) notifyAboutCorrection(actor, entry.user_id, entry.date, 'gelöscht', reason);
      // Eine leere Woche lässt sich nicht einreichen, also gibt es zu ihr auch nichts mehr zu tun.
      const week = weekRow(entry.user_id, weekStart);
      const remaining = db.prepare('SELECT COUNT(*) AS count FROM time_entries WHERE user_id = ? AND date >= ? AND date <= ?').get(entry.user_id, weekStart, addDays(weekStart, 6)).count;
      if (week && remaining === 0) closeTasks(week.id, ['time_week_returned', 'time_week_reopened']);
    })();
    res.json({ ok: true, hints: hintsForDate(actor, entry.user_id, entry.date) });
  });

  router.post('/time/clock/in', (req, res) => {
    const actor = current(req);
    const person = personById(actor.id);
    if (!person) return fail(res, 404, 'Für dieses Konto gibt es keine Zeiterfassung.');
    if (runningEntryOf(actor.id)) return fail(res, 400, 'Du bist schon eingestempelt.');
    const { date, time } = now();
    if (!EDITABLE_STATUSES.includes(weekStatus(actor.id, date))) return fail(res, 409, lockedWeekMessage(actor.id, date));
    if (absentShare(absenceCalendar(actor.id, date, date), date) >= 1) {
      return fail(res, 409, 'Für heute ist bei dir eine Abwesenheit eingetragen. Arbeitest du doch, nimm sie zuerst zurück oder wende dich an HR.');
    }
    const overlap = findOverlap(actor.id, date, time, null);
    if (overlap) return fail(res, 400, overlapMessage(overlap));
    const id = db.transaction(() => {
      const newId = insertEntry(actor.id, date, time, null, 0, null, actor.id);
      log(actor.id, 'time_clocked_in', 'time_entries', newId, null, { date });
      return newId;
    })();
    res.status(201).json({ entry: entryView(entryById(id), new Set()) });
  });

  router.post('/time/clock/out', (req, res) => {
    const actor = current(req);
    const running = runningEntryOf(actor.id);
    if (!running) return fail(res, 400, 'Du bist gerade nicht eingestempelt.');
    const body = bodyOf(req);
    const breakMinutes = body.breakMinutes === undefined || body.breakMinutes === '' ? running.break_minutes : Number(body.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > MAX_BREAK_MINUTES) return fail(res, 400, 'Die Pause muss eine ganze Zahl von Minuten sein.');
    const { date, time } = now();
    if (!EDITABLE_STATUSES.includes(weekStatus(actor.id, running.date))) return fail(res, 409, lockedWeekMessage(actor.id, running.date));

    if (running.date === date) {
      const duration = toMinutes(time) - toMinutes(running.start_time);
      if (duration <= 0) return fail(res, 400, 'Das Ende muss nach dem Beginn liegen. Warte bitte mindestens eine Minute.');
      if (breakMinutes >= duration) return fail(res, 400, 'Die Pause muss kürzer sein als die erfasste Zeit.');
      db.transaction(() => {
        closeRunningEntry(running, time, breakMinutes, actor);
        log(actor.id, 'time_clocked_out', 'time_entries', running.id, null, { date });
      })();
      return res.json({ entries: [entryView(entryById(running.id), new Set())], hints: hintsForDate(actor, actor.id, date) });
    }

    // Ein vergessenes Gehen darf nicht unbemerkt zu einer Riesenschicht werden.
    const isNextDay = addDays(running.date, 1) === date;
    const span = MINUTES_PER_DAY - toMinutes(running.start_time) + toMinutes(time);
    if (!isNextDay || span > MAX_CLOCK_SPAN_MINUTES) {
      return fail(res, 400, `Dein Eintrag vom ${formatDate(running.date)} läuft noch. Bitte trage das Ende dort von Hand ein.`);
    }
    if (!EDITABLE_STATUSES.includes(weekStatus(actor.id, date))) return fail(res, 409, lockedWeekMessage(actor.id, date));
    const firstPartMinutes = MINUTES_PER_DAY - toMinutes(running.start_time);
    if (breakMinutes >= firstPartMinutes) return fail(res, 400, 'Die Pause muss kürzer sein als die erfasste Zeit.');
    const secondPartHasTime = toMinutes(time) > 0;
    if (secondPartHasTime) {
      const overlap = findOverlap(actor.id, date, '00:00', time);
      if (overlap) return fail(res, 400, overlapMessage(overlap));
    }
    const newId = db.transaction(() => {
      closeRunningEntry(running, '24:00', breakMinutes, actor);
      log(actor.id, 'time_clocked_out', 'time_entries', running.id, null, { date: running.date });
      if (!secondPartHasTime) return null;
      const id = insertEntry(actor.id, date, '00:00', time, 0, running.note, actor.id);
      log(actor.id, 'time_entry_created', 'time_entries', id, null, { userId: actor.id, date });
      return id;
    })();
    const entries = [entryView(entryById(running.id), new Set())];
    if (newId) entries.push(entryView(entryById(newId), new Set()));
    res.json({ entries, hints: hintsForDate(actor, actor.id, date) });
  });

  router.post('/time/weeks/submit', (req, res) => {
    const actor = current(req);
    const person = personById(actor.id);
    if (!person) return fail(res, 404, 'Für dieses Konto gibt es keine Zeiterfassung.');
    const weekStart = parseWeek(bodyOf(req).week);
    if (!weekStart) return fail(res, 400, 'Bitte gib ein gültiges Datum für die Woche an.');
    const existing = weekRow(actor.id, weekStart);
    if (existing && !EDITABLE_STATUSES.includes(existing.status)) return fail(res, 409, `Diese Woche ist bereits ${STATUS_LABELS[existing.status]}.`);
    const week = computeWeekFor(actor.id, weekStart);
    if (week.hasRunning) return fail(res, 400, 'In dieser Woche läuft noch ein Eintrag. Bitte beende ihn zuerst.');
    if (!week.closedCount) return fail(res, 400, 'Diese Woche enthält noch keine Einträge.');

    const withoutApproval = approvalRule('time.approval') === 'none';
    const responsible = withoutApproval ? [] : approverIds(person);
    const status = withoutApproval ? 'approved' : 'submitted';
    const row = db.transaction(() => {
      const weekEntry = ensureWeekRow(actor.id, weekStart);
      const submittedAt = timestamp();
      db.prepare(`
        UPDATE time_weeks
        SET status = ?, submitted_at = ?, decided_by = NULL, decided_at = ?, decision_comment = NULL, weekly_minutes = ?
        WHERE id = ?
      `).run(status, submittedAt, withoutApproval ? submittedAt : null, withoutApproval ? weeklyHoursFor(actor.id).hours * 60 : null, weekEntry.id);
      closeTasks(weekEntry.id, ['time_week_returned', 'time_week_reopened']);
      for (const userId of responsible) createTask(userId, approvalTitle(person, weekStart), 'time_week_approval', weekEntry.id);
      log(actor.id, 'time_week_submitted', 'time_weeks', weekEntry.id, { status: existing?.status || 'open' }, { status });
      return weekEntry;
    })();
    const warning = withoutApproval || responsible.length ? undefined : 'Gerade kann niemand außer dir diese Woche entscheiden. Bitte lege eine weitere Person mit HR-Rechten an.';
    res.json({ id: row.id, status, warning });
  });

  router.post('/time/weeks/:id/withdraw', (req, res) => {
    const actor = current(req);
    const row = db.prepare('SELECT * FROM time_weeks WHERE id = ?').get(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Woche nicht gefunden.');
    if (actor.id !== row.user_id) return fail(res, 403, 'Eine Woche zieht nur die Person selbst zurück.');
    if (!isWithdrawable(row)) return fail(res, 409, 'Über diese Woche ist schon entschieden. Nur HR kann sie wieder öffnen.');
    db.transaction(() => {
      db.prepare(`
        UPDATE time_weeks
        SET status = 'open', submitted_at = NULL, decided_at = NULL, weekly_minutes = NULL
        WHERE id = ?
      `).run(row.id);
      closeTasks(row.id, ['time_week_approval']);
      log(actor.id, 'time_week_withdrawn', 'time_weeks', row.id, { status: row.status }, { status: 'open' });
    })();
    res.json({ ok: true, status: 'open' });
  });

  router.get('/time/weeks', (req, res) => {
    const actor = current(req);
    const scope = req.query.scope === undefined ? 'team' : req.query.scope;
    if (!['team', 'all'].includes(scope)) return fail(res, 400, 'Dieser Bereich ist unbekannt.');
    if (scope === 'all' && !isHrOperator(actor)) return fail(res, 403, 'Nur HR darf alle Wochen sehen.');
    const status = req.query.status === undefined ? 'submitted' : req.query.status;
    if (status !== 'all' && !WEEK_STATUSES.includes(status)) return fail(res, 400, 'Dieser Status ist unbekannt.');
    if (scope === 'team' && status === 'open') return fail(res, 403, 'Offene Wochen sind nur für die Person selbst und HR sichtbar.');

    const conditions = [];
    const params = [];
    const placeholders = values => values.map(() => '?').join(', ');
    if (scope === 'team') {
      // Auch wer inzwischen gesperrt ist, kann noch eine Woche offen haben, die entschieden werden muss.
      const directReports = db.prepare('SELECT id FROM users WHERE manager_id = ? AND is_system_account = 0').all(actor.id).map(row => row.id);
      const reports = [...new Set([...subordinateIds(actor), ...directReports])];
      if (!reports.length) return res.json({ weeks: [], rule: approvalRule('time.approval') });
      conditions.push(`w.user_id IN (${placeholders(reports)})`);
      params.push(...reports);
    }
    if (status !== 'all') {
      conditions.push('w.status = ?');
      params.push(status);
    } else if (scope === 'team') {
      conditions.push(`w.status IN (${placeholders(MANAGER_VISIBLE_STATUSES)})`);
      params.push(...MANAGER_VISIBLE_STATUSES);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const found = db.prepare(`
      SELECT w.id, w.user_id, w.week_start, w.status, w.submitted_at, u.name AS user_name, u.email AS user_email,
        u.role AS user_role, u.manager_id AS user_manager_id, m.name AS manager_name
      FROM time_weeks w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN users m ON m.id = u.manager_id
      ${where}
      ORDER BY w.week_start DESC, w.id
      LIMIT ?
    `).all(...params, WEEK_LIST_LIMIT + 1);
    const truncated = found.length > WEEK_LIST_LIMIT;
    const decisions = decisionContext();
    const visible = found.slice(0, WEEK_LIST_LIMIT).filter(row => scope === 'team'
      || hrCanAccess(actor, { role: row.user_role })
      || decisions.holdersOf(row.id).includes(actor.id));
    const rows = sortByName(visible, row => row.user_name).sort((left, right) => right.week_start.localeCompare(left.week_start));
    const numbers = scope === 'all' ? personnelNumbers() : new Map();
    res.json({
      rule: decisions.rule,
      truncated,
      limit: WEEK_LIST_LIMIT,
      weeks: rows.map(row => {
        const week = computeWeekFor(row.user_id, row.week_start);
        const person = { id: row.user_id, manager_id: row.user_manager_id, role: row.user_role };
        return {
          id: row.id,
          userId: row.user_id,
          userName: row.user_name,
          ...(scope === 'all' ? { userEmail: row.user_email, personnelNumber: numbers.get(row.user_id) ?? null } : {}),
          weekStart: row.week_start,
          weekEnd: week.weekEnd,
          status: row.status,
          statusLabel: STATUS_LABELS[row.status],
          submittedAt: row.submitted_at,
          targetMinutes: week.targetMinutes,
          dueMinutes: week.dueMinutes,
          actualMinutes: week.actualMinutes,
          balanceMinutes: week.balanceMinutes,
          direct: row.user_manager_id === actor.id,
          managerName: row.manager_name,
          deciderName: row.status === 'submitted' ? deciderOf(person, row.id, decisions).name : null,
          canDecide: row.status === 'submitted' && canDecideWeek(actor, person, row.id, decisions),
          canReopen: row.status === 'approved' && hrMaySee(actor, { role: row.user_role }) && !blocksSelfEdit(actor, row.user_id)
        };
      })
    });
  });

  router.get('/time/weeks/:id', (req, res) => {
    const actor = current(req);
    const row = db.prepare('SELECT id, user_id, week_start, status FROM time_weeks WHERE id = ?').get(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Woche nicht gefunden.');
    if (!canViewWeek(actor, row.user_id, row.status) && !decisionContext().holdersOf(row.id).includes(actor.id)) return fail(res, 403, 'Du darfst diese Woche nicht sehen.');
    res.json({ week: { id: row.id, userId: row.user_id, weekStart: row.week_start, status: row.status } });
  });

  router.post('/time/weeks/:id/decision', (req, res) => {
    const actor = current(req);
    const row = db.prepare('SELECT * FROM time_weeks WHERE id = ?').get(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Woche nicht gefunden.');
    const person = personById(row.user_id);
    if (!person) return fail(res, 404, 'Person nicht gefunden.');
    if (actor.id === row.user_id) return fail(res, 403, 'Über deine eigene Woche kannst du nicht selbst entscheiden.');
    if (!canDecideWeek(actor, person, row.id)) {
      return fail(res, 403, actor.role === 'hr_staff'
        ? 'Die HR-Sachbearbeitung entscheidet keine Wochen. Das tun die Führungskraft oder die HR-Administration.'
        : 'Nur die direkte Führungskraft oder HR darf diese Woche entscheiden.');
    }
    const body = bodyOf(req);
    if (!['approve', 'return'].includes(body.decision)) return fail(res, 400, 'Bitte wähle „genehmigen“ oder „zurückgeben“.');
    const comment = cleanText(body.comment, 1000) || null;
    if (body.decision === 'return' && !comment) return fail(res, 400, 'Bitte schreibe kurz, was korrigiert werden soll.');
    if (row.status !== 'submitted') return fail(res, 409, 'Diese Woche wartet nicht auf eine Entscheidung.');

    const status = body.decision === 'approve' ? 'approved' : 'returned';
    db.transaction(() => {
      db.prepare(`
        UPDATE time_weeks
        SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ?, weekly_minutes = ?
        WHERE id = ?
      `).run(status, actor.id, timestamp(), comment, status === 'approved' ? weeklyHoursFor(row.user_id).hours * 60 : null, row.id);
      closeTasks(row.id, ['time_week_approval']);
      if (status === 'returned' && person.active) createTask(row.user_id, `Deine Zeiten der Woche ab ${formatDate(row.week_start)} wurden zurückgegeben. Bitte korrigiere sie.`, 'time_week_returned', row.id);
      log(actor.id, `time_week_${status}`, 'time_weeks', row.id, { status: row.status }, { status });
    })();
    res.json({ ok: true, status });
  });

  router.post('/time/weeks/:id/reopen', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf eine genehmigte Woche wieder öffnen.');
    const row = db.prepare('SELECT * FROM time_weeks WHERE id = ?').get(positiveId(req.params.id));
    if (!row) return fail(res, 404, 'Woche nicht gefunden.');
    if (!hrCanAccess(actor, row.user_id)) return fail(res, 403, 'Die Woche dieser Person darfst du nicht wieder öffnen.');
    if (blocksSelfEdit(actor, row.user_id)) return fail(res, 403, 'Deine eigene Woche öffnet eine andere HR-Person.');
    const reason = cleanText(bodyOf(req).reason, 1000);
    if (!reason) return fail(res, 400, 'Bitte gib eine Begründung an.');
    if (row.status !== 'approved') return fail(res, 409, 'Nur eine genehmigte Woche lässt sich wieder öffnen.');
    db.transaction(() => {
      db.prepare(`
        UPDATE time_weeks
        SET status = 'open', weekly_minutes = NULL, reopened_by = ?, reopened_at = ?, reopen_reason = ?
        WHERE id = ?
      `).run(actor.id, timestamp(), reason, row.id);
      if (actor.id !== row.user_id && personById(row.user_id)?.active) createTask(row.user_id, `HR hat deine Woche ab ${formatDate(row.week_start)} wieder geöffnet. Bitte prüfe sie und reiche sie erneut ein.`, 'time_week_reopened', row.id);
      log(actor.id, 'time_week_reopened', 'time_weeks', row.id, { status: 'approved' }, { status: 'open' });
    })();
    res.json({ ok: true, status: 'open' });
  });

  router.get('/time/settings', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf die Einstellungen sehen.');
    res.json({ settings: { weeklyHours: readSettings().weekly_hours, personnelActive: isModuleEnabled('personnel'), absenceActive: isModuleEnabled('absence'), canEdit: isHr(actor) } });
  });

  router.put('/time/settings', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return fail(res, 403, 'Nur HR darf die Einstellungen ändern.');
    const hours = Number(bodyOf(req).weeklyHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_WEEKLY_HOURS) return fail(res, 400, `Die Wochenstunden müssen über 0 und höchstens bei ${MAX_WEEKLY_HOURS} liegen.`);
    const before = readSettings().weekly_hours;
    db.prepare('UPDATE time_settings SET weekly_hours = ?, updated_by = ?, updated_at = ? WHERE id = 1').run(hours, actor.id, timestamp());
    log(actor.id, 'time_settings_updated', 'time_settings', 1, { weeklyHours: before }, { weeklyHours: hours });
    res.json({ settings: { weeklyHours: hours } });
  });

  router.get('/time/people', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf diese Übersicht sehen.');
    const people = sortByName(db.prepare('SELECT id, name, email, role, active FROM users WHERE is_system_account = 0').all()
      .filter(person => hrCanAccess(actor, person)));
    const balances = hoursAndBalances(people.map(person => person.id));
    const numbers = personnelNumbers();
    const exits = exitDates();
    res.json({
      people: people.map(person => {
        const { hours, totalBalanceMinutes: total } = balances.get(person.id);
        return {
          id: person.id,
          name: person.name,
          email: person.email,
          personnelNumber: numbers.get(person.id) ?? null,
          active: Boolean(person.active),
          exitDate: exits.get(person.id) ?? null,
          weeklyHours: hours.hours,
          hoursSource: hours.source,
          totalBalanceMinutes: total,
          canSetHours: !blocksSelfEdit(actor, person.id)
        };
      })
    });
  });

  router.put('/time/people/:userId/hours', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf Wochenstunden festlegen.');
    const person = personById(positiveId(req.params.userId));
    if (!person) return fail(res, 404, 'Person nicht gefunden.');
    if (!hrCanAccess(actor, person)) return fail(res, 403, 'Die Wochenstunden dieser Person darfst du nicht ändern.');
    if (blocksSelfEdit(actor, person.id)) return fail(res, 403, 'Deine eigenen Wochenstunden ändert eine andere HR-Person.');
    const body = bodyOf(req);
    const raw = body.weeklyHours;
    const clearing = raw === null || raw === '';
    const hours = clearing ? null : Number(raw);
    if (!clearing && (!Number.isFinite(hours) || hours < 0 || hours > MAX_WEEKLY_HOURS)) return fail(res, 400, `Die Wochenstunden müssen zwischen 0 und ${MAX_WEEKLY_HOURS} liegen.`);
    const reason = cleanText(body.reason, 500);
    if (!reason) return fail(res, 400, 'Bitte nenne einen Grund für die Änderung.');
    const before = db.prepare('SELECT weekly_hours FROM time_person_settings WHERE user_id = ?').get(person.id)?.weekly_hours ?? null;
    db.transaction(() => {
      if (clearing) {
        db.prepare('DELETE FROM time_person_settings WHERE user_id = ?').run(person.id);
      } else {
        db.prepare(`
          INSERT INTO time_person_settings (user_id, weekly_hours, updated_by, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET weekly_hours = excluded.weekly_hours, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(person.id, hours, actor.id, timestamp());
      }
      log(actor.id, 'time_person_hours_updated', 'time_person_settings', person.id, { weeklyHours: before }, { weeklyHours: hours, reason });
      if (person.active && actor.id !== person.id) {
        const week = ensureWeekRow(person.id, mondayOf(today()));
        createTask(person.id, `HR hat deine Wochenstunden geändert. Grund: ${reason}`, 'time_correction_notice', week.id);
      }
    })();
    const effective = weeklyHoursFor(person.id);
    res.json({ weeklyHours: effective.hours, hoursSource: effective.source });
  });

  const closedEntriesInMonth = month => {
    const { first, last } = monthRange(month);
    return db.prepare(`
      SELECT e.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
      FROM time_entries e
      JOIN users u ON u.id = e.user_id
      WHERE e.date >= ? AND e.date <= ? AND e.end_time IS NOT NULL
      ORDER BY e.date, e.start_time
    `).all(first, last);
  };

  /** Wer in der Datei fehlt: alle aktuellen Personen, die diese HR-Person nicht sehen darf, und Ehemalige mit Einträgen im Monat. */
  function withheldPeopleCount(actor, entriesOfMonth) {
    const withheld = new Set(entriesOfMonth.filter(entry => !hrCanAccess(actor, { role: entry.user_role })).map(entry => entry.user_id));
    for (const person of db.prepare('SELECT id, role FROM users WHERE is_system_account = 0 AND active = 1').all()) {
      if (!hrCanAccess(actor, person)) withheld.add(person.id);
    }
    return withheld.size;
  }

  // Fehlt jemand still, stimmt die Lohnabrechnung nicht. Deshalb steht es auf der Seite und in der Datei.
  const withheldNote = count => (count
    ? `Hinweis: In dieser Datei ${count === 1 ? 'fehlt 1 Person' : `fehlen ${count} Personen`} mit HR-Rolle, deren Daten du nicht sehen darfst. Die vollständige Datei lädt die HR-Administration.`
    : null);

  router.get('/time/export/scope', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf Zeiten exportieren.');
    if (!isMonth(req.query.month)) return fail(res, 400, 'Bitte wähle einen Monat.');
    const count = withheldPeopleCount(actor, closedEntriesInMonth(req.query.month));
    res.json({ month: req.query.month, withheldPeople: count, note: withheldNote(count) });
  });

  router.get('/time/export', (req, res) => {
    const actor = current(req);
    if (!isHrOperator(actor)) return fail(res, 403, 'Nur HR darf Zeiten exportieren.');
    if (!isMonth(req.query.month)) return fail(res, 400, 'Bitte wähle einen Monat.');
    const { first, last } = monthRange(req.query.month);
    const found = closedEntriesInMonth(req.query.month);
    const entries = sortByName(found.filter(entry => hrCanAccess(actor, { role: entry.user_role })), entry => entry.user_name);
    const numbers = personnelNumbers();
    const weeks = db.prepare('SELECT user_id, week_start, status FROM time_weeks WHERE week_start >= ? AND week_start <= ?').all(mondayOf(first), last);
    const statusByWeek = new Map(weeks.map(week => [`${week.user_id}:${week.week_start}`, week.status]));
    const header = ['Name', 'Personalnummer', 'E-Mail', 'Datum', 'Beginn', 'Ende', 'Pause (Min.)', 'Arbeitszeit (Std.)', 'Wochenstatus', 'Notiz'];
    const lines = [header];
    for (const entry of entries) {
      const status = statusByWeek.get(`${entry.user_id}:${mondayOf(entry.date)}`) || 'open';
      lines.push([
        entry.user_name,
        numbers.get(entry.user_id) ?? '',
        entry.user_email,
        formatDate(entry.date),
        entry.start_time,
        entry.end_time,
        entry.break_minutes,
        (netMinutes(entry) / 60).toFixed(2).replace('.', ','),
        STATUS_LABELS[status],
        entry.note
      ]);
    }
    const exportedRows = lines.length - 1;
    const note = withheldNote(withheldPeopleCount(actor, found));
    if (note) lines.push([note, ...header.slice(1).map(() => '')]);
    log(actor.id, 'time_exported', 'time_entries', null, null, { month: req.query.month, rows: exportedRows });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zeiten-${req.query.month}.csv"`);
    res.send(toCsv(lines));
  });

  return {
    router,
    initialize,
    seedDemo,
    maintenance: syncApprovalTasks,
    helpArticles: HELP_ARTICLES
  };
}

module.exports = { createTimeModule, csvField, tableHasColumns, toCsv };
