'use strict';

/**
 * Mitarbeiterbefragungen. Anonymität ist das zentrale Versprechen dieses Moduls und soll auch
 * gegenüber jemandem gelten, der die Datenbank liest:
 *
 * - surveys_participation hält nur fest, DASS jemand abgegeben hat, ohne Zeitpunkt.
 * - surveys_answers kennt weder Person noch Zeitpunkt. Die Zeilen sind nach einer zufälligen
 *   response_id sortiert, damit sich die Einfügereihenfolge nicht ablesen lässt.
 * - Die Abgabe erzeugt keinen Protokolleintrag.
 * - Zu einer Antwort gehören nur Vergleichsgruppe und Führungslinie, und nur so grob, dass
 *   jede Kombination mindestens so viele Eingeladene umfasst wie die Anonymitätsschwelle.
 * - Einzelantworten verlassen den Server nie: Es gibt keine Schnittstelle dafür.
 *
 * - Mit PostgreSQL werden die Zeilen einer Befragung bei jeder Abgabe neu geschrieben, weil die
 *   Datenbank sonst Reihenfolge und Zusammengehörigkeit preisgäbe (siehe hideSubmissionOrder).
 *
 * Grenzen, die sich technisch nicht ganz ausschließen lassen, stehen in der Oberfläche
 * (public/surveys.js) und werden dort genauso benannt.
 */

const crypto = require('crypto');
const express = require('express');

const MIN_THRESHOLD = 3;
const DEFAULT_THRESHOLD = 5;
const MAX_THRESHOLD = 1000;
const MAX_TITLE_LENGTH = 200;
const MAX_INTRO_LENGTH = 4000;
const MAX_QUESTION_LENGTH = 500;
const MAX_TOPIC_LENGTH = 80;
const MAX_TEXT_ANSWER_LENGTH = 2000;
const QUESTION_TYPES = Object.freeze(['scale', 'nps', 'text']);
const QUESTION_RANGES = Object.freeze({ scale: Object.freeze({ min: 1, max: 5 }), nps: Object.freeze({ min: 0, max: 10 }) });
const TARGET_ROLES = Object.freeze(['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp']);
const LEADERSHIP_ROLES = Object.freeze(['manager', 'director']);
const NO_LEAD_GROUP = 'no-lead';
const REST_GROUP = 'rest';
const INSUFFICIENT = Object.freeze({ insufficient: true, message: 'Zu wenige Antworten' });
const INVALID = Symbol('invalid');

const TEMPLATE_QUESTIONS = Object.freeze([
  ['expectations', 'scale', 'Klarheit', 'Ich weiß, was in meiner Arbeit von mir erwartet wird.'],
  ['resources', 'scale', 'Arbeitsumfeld', 'Ich habe alles, was ich für gute Arbeit brauche.'],
  ['workload', 'scale', 'Belastung', 'Meine Arbeitsmenge ist auf Dauer gut zu schaffen.'],
  ['support', 'scale', 'Führung', 'Ich bekomme Unterstützung, wenn ich sie brauche.'],
  ['openness', 'scale', 'Zusammenarbeit', 'Ich kann offen sagen, was ich denke.'],
  ['growth', 'scale', 'Entwicklung', 'Ich sehe für mich Möglichkeiten, mich weiterzuentwickeln.'],
  ['recommend', 'nps', 'Weiterempfehlung', 'Wie wahrscheinlich ist es, dass du uns als Arbeitgeber weiterempfiehlst?'],
  ['improve', 'text', 'Vorschläge', 'Was sollten wir als Erstes verbessern?']
]);

/** Alles, was nur SQLite versteht, steht an dieser einen Stelle. Für PostgreSQL wird es übersetzt. */
const sqliteOnly = Object.freeze({
  createTableWithoutRowid(db, table, definition) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${definition}) WITHOUT ROWID`);
  },
  tableExists(db, table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
});

const nowIso = () => new Date().toISOString();
const todayIso = () => nowIso().slice(0, 10);

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function increment(counts, key, by = 1) {
  counts.set(key, (counts.get(key) || 0) + by);
}

function randomOrder(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
const lineIdsOf = linePath => linePath.split('/').filter(Boolean).map(Number);
const lineMarker = managerId => `/${managerId}/`;
const toLinePath = ids => (ids.length ? `/${ids.join('/')}/` : '/');

/** Weiterempfehlungswert: Anteil der Werte 9 bis 10 minus Anteil der Werte 0 bis 6. */
function summarizeRecommendation(values) {
  const promoters = values.filter(value => value >= 9).length;
  const detractors = values.filter(value => value <= 6).length;
  const passives = values.length - promoters - detractors;
  return {
    recommendationScore: values.length ? Math.round(((promoters - detractors) / values.length) * 100) + 0 : null,
    promotersPercent: percentOf(promoters, values.length),
    passivesPercent: percentOf(passives, values.length),
    detractorsPercent: percentOf(detractors, values.length)
  };
}

function summarizeScale(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    average: values.length ? Math.round((sum / values.length) * 10) / 10 : null,
    favorablePercent: percentOf(values.filter(value => value >= 4).length, values.length),
    neutralPercent: percentOf(values.filter(value => value === 3).length, values.length),
    unfavorablePercent: percentOf(values.filter(value => value <= 2).length, values.length)
  };
}

function summarizeQuestion(question, answers) {
  const summary = { id: question.id, text: question.question_text, type: question.question_type, topic: question.topic || '' };
  if (question.question_type === 'text') {
    // Jede Frage wird für sich gemischt, damit die Position nichts über die Person hinter den Texten verrät.
    return { ...summary, texts: randomOrder(answers.map(answer => answer.text_value).filter(Boolean)) };
  }
  const values = answers.map(answer => answer.value);
  const details = question.question_type === 'nps' ? summarizeRecommendation(values) : summarizeScale(values);
  return { ...summary, ...details };
}

/**
 * Differenzschutz für den Vergleich nach Gruppen: Gezeigt wird eine Gruppe nur ab Schwelle.
 * Lägen die verdeckten Gruppen zusammen unter der Schwelle, ließen sie sich aus Gesamtwert
 * minus sichtbarer Gruppen errechnen. Dann wird zusätzlich die kleinste sichtbare verdeckt.
 */
function publishedGroups(responses, threshold) {
  const counts = new Map();
  for (const response of responses) increment(counts, response.group_key);
  const visible = new Set([...counts].filter(([key, count]) => key !== REST_GROUP && count >= threshold).map(([key]) => key));
  let hiddenCount = responses.length - [...visible].reduce((sum, key) => sum + counts.get(key), 0);
  const smallestFirst = [...visible].sort((first, second) => counts.get(first) - counts.get(second) || first.localeCompare(second));
  for (const key of smallestFirst) {
    if (hiddenCount === 0 || hiddenCount >= threshold) break;
    visible.delete(key);
    hiddenCount += counts.get(key);
  }
  return { visible, hiddenCount };
}

/**
 * Differenzschutz für Führungslinien. Grundgedanke: Alle gezeigten Mengen zerlegen die Antworten
 * in kleinste Bausteine. Hat jeder Baustein mindestens Schwelle Antworten, kann auch keine
 * Rechnung aus Summen und Differenzen weniger als Schwelle Antworten freilegen. Eine Linie wird
 * deshalb nur aufgenommen, wenn dabei kein Baustein unter die Schwelle fällt. Größere Linien
 * haben Vorrang, damit die Rechnung eindeutig ist und zwischen zwei Abrufen gleich bleibt.
 */
function publishableLines(responses, atomOf, threshold) {
  const lineCounts = new Map();
  for (const response of responses) {
    for (const id of lineIdsOf(response.line_path)) increment(lineCounts, id);
  }
  const candidates = [...lineCounts]
    .filter(([, count]) => count >= threshold)
    .sort((first, second) => second[1] - first[1] || first[0] - second[0])
    .map(([id]) => id);
  const atoms = new Map(responses.map(response => [response.response_id, String(atomOf(response))]));
  const published = new Set();
  for (const id of candidates) {
    const marker = lineMarker(id);
    const splitAtom = response => `${atoms.get(response.response_id)}|${response.line_path.includes(marker) ? 'in' : 'out'}`;
    const sizes = new Map();
    for (const response of responses) increment(sizes, splitAtom(response));
    if ([...sizes.values()].some(size => size < threshold)) continue;
    for (const response of responses) atoms.set(response.response_id, splitAtom(response));
    published.add(id);
  }
  return published;
}

/** Fasst die Antworten einer Abfrage auf je eine Zeile pro Abgabe zusammen. */
function distinctResponses(answers) {
  const byId = new Map();
  for (const answer of answers) {
    if (!byId.has(answer.response_id)) byId.set(answer.response_id, answer);
  }
  return [...byId.values()];
}

function createSurveysModule(deps) {
  const { db, auth, current, isHr, cleanText, boundedInt, validDate, log, createTask, isModuleEnabled } = deps;
  const router = express.Router();

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

  function readThreshold(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    return boundedInt(value, MIN_THRESHOLD, MAX_THRESHOLD, null);
  }

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS surveys_surveys (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        intro TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')),
        starts_at TEXT,
        ends_at TEXT,
        anonymity_threshold INTEGER NOT NULL DEFAULT ${DEFAULT_THRESHOLD} CHECK(anonymity_threshold >= ${MIN_THRESHOLD}),
        audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN ('all','roles')),
        audience_roles TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS surveys_questions (
        id INTEGER PRIMARY KEY,
        survey_id INTEGER NOT NULL REFERENCES surveys_surveys(id),
        question_text TEXT NOT NULL,
        question_type TEXT NOT NULL CHECK(question_type IN ('scale','nps','text')),
        topic TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_surveys_questions_survey ON surveys_questions(survey_id, sort_order);
      CREATE TABLE IF NOT EXISTS surveys_question_templates (
        template_key TEXT PRIMARY KEY,
        question_text TEXT NOT NULL,
        question_type TEXT NOT NULL CHECK(question_type IN ('scale','nps','text')),
        topic TEXT,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS surveys_interim_results (
        survey_id INTEGER NOT NULL REFERENCES surveys_surveys(id),
        scope_key TEXT NOT NULL,
        answer_count INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (survey_id, scope_key)
      );
    `);
    // Absichtlich ohne Zeitstempel. Eingeladene werden beim Öffnen auf einmal eingetragen.
    sqliteOnly.createTableWithoutRowid(db, 'surveys_participation', `
      survey_id INTEGER NOT NULL REFERENCES surveys_surveys(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      submitted INTEGER NOT NULL DEFAULT 0 CHECK(submitted IN (0,1)),
      PRIMARY KEY (survey_id, user_id)
    `);
    // Absichtlich ohne Bezug zu users und ohne Zeitstempel. line_path nennt nur Führungslinien,
    // die samt Vergleichsgruppe mindestens Schwelle Eingeladene umfassen.
    sqliteOnly.createTableWithoutRowid(db, 'surveys_answers', `
      survey_id INTEGER NOT NULL REFERENCES surveys_surveys(id),
      response_id TEXT NOT NULL,
      question_id INTEGER NOT NULL REFERENCES surveys_questions(id),
      value INTEGER,
      text_value TEXT,
      group_key TEXT NOT NULL,
      line_path TEXT NOT NULL DEFAULT '/',
      PRIMARY KEY (survey_id, response_id, question_id)
    `);
    const addTemplate = db.prepare(`
      INSERT INTO surveys_question_templates(template_key, question_text, question_type, topic, sort_order)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT (template_key) DO NOTHING
    `);
    TEMPLATE_QUESTIONS.forEach(([key, type, topic, text], index) => addTemplate.run(key, text, type, topic, index + 1));
  }

  // --- Lesen ----------------------------------------------------------------------------

  const surveyById = id => db.prepare('SELECT * FROM surveys_surveys WHERE id=?').get(id);
  const questionsOf = surveyId => db.prepare('SELECT * FROM surveys_questions WHERE survey_id=? ORDER BY sort_order, id').all(surveyId);
  const answersOf = surveyId => db.prepare(`
    SELECT response_id, question_id, value, text_value, group_key, line_path
    FROM surveys_answers
    WHERE survey_id=?
  `).all(surveyId);
  const participationOf = (surveyId, userId) => db.prepare('SELECT submitted FROM surveys_participation WHERE survey_id=? AND user_id=?').get(surveyId, userId);
  const invitedCountOf = surveyId => db.prepare('SELECT COUNT(*) AS count FROM surveys_participation WHERE survey_id=?').get(surveyId).count;
  const isPastEnd = survey => Boolean(survey.ends_at) && survey.ends_at < todayIso();
  const audienceRolesOf = survey => (survey.audience_roles ? JSON.parse(survey.audience_roles) : []);

  function publicQuestion(question) {
    return {
      id: question.id,
      text: question.question_text,
      type: question.question_type,
      topic: question.topic || '',
      ...(QUESTION_RANGES[question.question_type] || {})
    };
  }

  function publicSurvey(survey) {
    return {
      id: survey.id,
      title: survey.title,
      intro: survey.intro || '',
      status: survey.status,
      startsAt: survey.starts_at,
      endsAt: survey.ends_at,
      anonymityThreshold: survey.anonymity_threshold
    };
  }

  function managementView(survey, invitedCount) {
    return { ...publicSurvey(survey), audience: survey.audience, audienceRoles: audienceRolesOf(survey), invitedCount };
  }

  // --- Vergleichsgruppe und Führungslinie -----------------------------------------------

  function organizationUnitByUser() {
    if (!isModuleEnabled('personnel') || !sqliteOnly.tableExists(db, 'personnel_records')) return new Map();
    const rows = db.prepare('SELECT user_id, org_unit_id FROM personnel_records WHERE org_unit_id IS NOT NULL').all();
    return new Map(rows.map(row => [row.user_id, row.org_unit_id]));
  }

  /** Führungskräfte einer Person von ganz oben bis zur direkten Führungskraft. */
  function managerChain(userId, managerOf) {
    const chain = [];
    const seen = new Set([userId]);
    let managerId = managerOf.get(userId);
    while (managerId && !seen.has(managerId)) {
      chain.unshift(managerId);
      seen.add(managerId);
      managerId = managerOf.get(managerId);
    }
    return chain;
  }

  /**
   * Gruppen unter der Schwelle gehen schon beim Speichern in einer Sammelgruppe auf, sonst
   * könnte die Gruppe beim Lesen der Datenbank die Person verraten. Bleibt die Sammelgruppe
   * selbst zu klein, wächst sie um die kleinsten übrigen Gruppen.
   */
  function mergeSmallGroups(memberCounts, threshold) {
    const merged = new Set();
    let restSize = 0;
    for (const [key, size] of memberCounts) {
      if (size < threshold) {
        merged.add(key);
        restSize += size;
      }
    }
    const smallestFirst = [...memberCounts].sort((first, second) => first[1] - second[1] || first[0].localeCompare(second[0]));
    for (const [key, size] of smallestFirst) {
      if (restSize === 0 || restSize >= threshold) break;
      if (!merged.has(key)) {
        merged.add(key);
        restSize += size;
      }
    }
    return key => (merged.has(key) ? REST_GROUP : key);
  }

  /**
   * Ordnet alle Eingeladenen ihrer Vergleichsgruppe (nie die Person selbst) und ihrer Führungslinie zu.
   * Eine Führungslinie umfasst die Führungskraft und alle Personen darunter. Gespeichert wird
   * sie nur, soweit die Kombination aus Gruppe und Linie mindestens Schwelle Eingeladene hat.
   */
  function comparisonPlan(survey) {
    const threshold = survey.anonymity_threshold;
    const participantIds = db.prepare('SELECT user_id FROM surveys_participation WHERE survey_id=?').all(survey.id).map(row => row.user_id);
    const managerOf = new Map(db.prepare('SELECT id, manager_id FROM users').all().map(user => [user.id, user.manager_id]));
    const unitOf = organizationUnitByUser();

    const members = participantIds.map(userId => {
      const chain = managerChain(userId, managerOf);
      let naturalGroup = NO_LEAD_GROUP;
      if (unitOf.has(userId)) naturalGroup = `unit:${unitOf.get(userId)}`;
      else if (chain.length) naturalGroup = `lead:${chain[0]}`;
      return { userId, lineCandidates: [...chain, userId], naturalGroup };
    });

    const memberCounts = new Map();
    for (const member of members) increment(memberCounts, member.naturalGroup);
    const finalGroup = mergeSmallGroups(memberCounts, threshold);

    const combinationCounts = new Map();
    for (const member of members) {
      member.groupKey = finalGroup(member.naturalGroup);
      for (const id of member.lineCandidates) increment(combinationCounts, `${member.groupKey}|${id}`);
    }
    for (const member of members) {
      const line = [];
      for (const id of member.lineCandidates) {
        if (combinationCounts.get(`${member.groupKey}|${id}`) < threshold) break;
        line.push(id);
      }
      member.linePath = toLinePath(line);
    }
    return new Map(members.map(member => [member.userId, member]));
  }

  function groupLabel(key) {
    if (key === REST_GROUP) return 'Weitere Bereiche (zusammengefasst)';
    if (key === NO_LEAD_GROUP) return 'Ohne Führungskraft';
    const [kind, rawId] = key.split(':');
    const id = Number(rawId);
    if (kind === 'lead') {
      const person = db.prepare('SELECT name FROM users WHERE id=?').get(id);
      return person ? `Bereich von ${person.name}` : 'Früherer Bereich';
    }
    const unit = sqliteOnly.tableExists(db, 'personnel_org_units')
      ? db.prepare('SELECT name FROM personnel_org_units WHERE id=?').get(id)
      : null;
    return unit ? unit.name : 'Frühere Einheit';
  }

  // --- Schreiben ------------------------------------------------------------------------

  function parseSurveySettings(body, previous = null) {
    const field = (name, fallback) => (body[name] === undefined ? fallback : body[name]);
    const title = cleanText(field('title', previous?.title), MAX_TITLE_LENGTH);
    if (!title) return { error: 'Bitte gib einen Titel an.' };
    const startsAt = readDate(field('startsAt', previous?.starts_at));
    const endsAt = readDate(field('endsAt', previous?.ends_at));
    if (startsAt === INVALID || endsAt === INVALID) return { error: 'Beginn oder Ende ist kein gültiges Datum.' };
    if (startsAt && endsAt && endsAt < startsAt) return { error: 'Das Ende darf nicht vor dem Beginn liegen.' };
    const threshold = readThreshold(field('anonymityThreshold', previous?.anonymity_threshold ?? DEFAULT_THRESHOLD));
    if (threshold === null) return { error: `Die Mindestzahl an Antworten muss mindestens ${MIN_THRESHOLD} sein.` };
    const audience = field('audience', previous?.audience ?? 'all');
    if (audience !== 'all' && audience !== 'roles') return { error: 'Bitte wähle als Zielgruppe alle oder ausgewählte Rollen.' };
    const roles = audience === 'roles' ? field('audienceRoles', previous ? audienceRolesOf(previous) : []) : [];
    if (audience === 'roles' && (!Array.isArray(roles) || !roles.length || roles.some(role => !TARGET_ROLES.includes(role)))) {
      return { error: 'Bitte wähle mindestens eine gültige Rolle als Zielgruppe.' };
    }
    return {
      value: {
        title,
        intro: cleanText(field('intro', previous?.intro), MAX_INTRO_LENGTH) || null,
        startsAt,
        endsAt,
        threshold,
        audience,
        audienceRoles: audience === 'roles' ? JSON.stringify([...new Set(roles)]) : null
      }
    };
  }

  function parseQuestion(body, previous = null) {
    const field = (name, fallback) => (body[name] === undefined ? fallback : body[name]);
    const text = cleanText(field('text', previous?.question_text), MAX_QUESTION_LENGTH);
    if (!text) return { error: 'Bitte gib einen Fragetext an.' };
    const type = field('type', previous?.question_type);
    if (!QUESTION_TYPES.includes(type)) return { error: 'Bitte wähle als Art Skala 1 bis 5, Weiterempfehlung 0 bis 10 oder Freitext.' };
    return { value: { text, type, topic: cleanText(field('topic', previous?.topic), MAX_TOPIC_LENGTH) || null } };
  }

  function addQuestion(surveyId, question, sortOrder) {
    return Number(db.prepare('INSERT INTO surveys_questions(survey_id, question_text, question_type, topic, sort_order) VALUES(?, ?, ?, ?, ?)')
      .run(surveyId, question.text, question.type, question.topic, sortOrder).lastInsertRowid);
  }

  function nextSortOrder(surveyId) {
    return db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM surveys_questions WHERE survey_id=?').get(surveyId).next_order;
  }

  const createSurvey = db.transaction((settings, actorId, useTemplates) => {
    const now = nowIso();
    const id = Number(db.prepare(`
      INSERT INTO surveys_surveys(
        title, intro, status, starts_at, ends_at, anonymity_threshold, audience, audience_roles,
        created_by, created_at, updated_at
      )
      VALUES(?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      settings.title,
      settings.intro,
      settings.startsAt,
      settings.endsAt,
      settings.threshold,
      settings.audience,
      settings.audienceRoles,
      actorId,
      now,
      now
    ).lastInsertRowid);
    if (useTemplates) {
      const templates = db.prepare('SELECT * FROM surveys_question_templates ORDER BY sort_order').all();
      for (const template of templates) {
        addQuestion(id, { text: template.question_text, type: template.question_type, topic: template.topic }, template.sort_order);
      }
    }
    return id;
  });

  function targetUserIds(survey) {
    const persons = db.prepare('SELECT id, role FROM users WHERE is_system_account=0 AND active=1').all();
    if (survey.audience === 'all') return persons.map(person => person.id);
    const roles = audienceRolesOf(survey);
    return persons.filter(person => roles.includes(person.role)).map(person => person.id);
  }

  function participationTaskTitle(survey) {
    const endNote = survey.ends_at ? ` (bis ${survey.ends_at.split('-').reverse().join('.')})` : '';
    return `Befragung „${survey.title}“ ausfüllen${endNote}`;
  }

  const openSurvey = db.transaction((survey, userIds, actorId) => {
    const addParticipant = db.prepare('INSERT INTO surveys_participation(survey_id, user_id, submitted) VALUES(?, ?, 0)');
    for (const userId of userIds) {
      addParticipant.run(survey.id, userId);
      createTask(userId, participationTaskTitle(survey), 'surveys_participate', survey.id, survey.ends_at);
    }
    db.prepare("UPDATE surveys_surveys SET status='open', starts_at=COALESCE(starts_at, ?), updated_at=? WHERE id=?").run(todayIso(), nowIso(), survey.id);
    log(actorId, 'survey_opened', 'surveys_surveys', survey.id, { status: 'draft' }, { status: 'open', invitedCount: userIds.length });
  });

  /**
   * PostgreSQL legt neue Zeilen in Eingangsreihenfolge ab und merkt sich intern, welche Zeilen
   * in derselben Transaktion entstanden sind. Daraus ließe sich ablesen, wer wie geantwortet hat.
   * Darum werden alle Zeilen der Befragung neu geschrieben, geordnet nach Werten ohne Zeitbezug.
   * So teilen sie sich alle dieselbe Transaktion. SQLite kennt beides nicht (WITHOUT ROWID).
   */
  function hideSubmissionOrder(surveyId) {
    if (db.dialect !== 'postgres') return;
    db.prepare('WITH moved AS (DELETE FROM surveys_participation WHERE survey_id=? RETURNING *) INSERT INTO surveys_participation SELECT * FROM moved ORDER BY user_id').run(surveyId);
    db.prepare('WITH moved AS (DELETE FROM surveys_answers WHERE survey_id=? RETURNING *) INSERT INTO surveys_answers SELECT * FROM moved ORDER BY response_id, question_id').run(surveyId);
    db.prepare("WITH moved AS (DELETE FROM tasks WHERE type='surveys_participate' AND entity_id=? RETURNING *) INSERT INTO tasks SELECT * FROM moved ORDER BY user_id").run(surveyId);
  }

  /**
   * Schreibt Teilnahme und Antworten in einer Transaktion und erledigt die eigene Aufgabe.
   * Hier steht bewusst kein log(): Das Protokoll hat einen Zeitstempel und nennt die Person.
   * Die Rückgabe ist nur wahr oder falsch, die Zufallsnummer der Abgabe verlässt den Server nicht.
   */
  const recordResponse = db.transaction((survey, userId, answers) => {
    const marked = db.prepare('UPDATE surveys_participation SET submitted=1 WHERE survey_id=? AND user_id=? AND submitted=0').run(survey.id, userId);
    if (marked.changes !== 1) return false;
    const placement = comparisonPlan(survey).get(userId);
    const responseId = crypto.randomUUID();
    const insertAnswer = db.prepare(`
      INSERT INTO surveys_answers(survey_id, response_id, question_id, value, text_value, group_key, line_path)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    for (const answer of answers) {
      insertAnswer.run(survey.id, responseId, answer.questionId, answer.value, answer.text, placement.groupKey, placement.linePath);
    }
    db.prepare("UPDATE tasks SET done=1 WHERE type='surveys_participate' AND entity_id=? AND user_id=? AND done=0").run(survey.id, userId);
    hideSubmissionOrder(survey.id);
    return true;
  });

  /**
   * Nach dem Schließen stehen alle Antworten fest. Dann bleibt in der Datenbank nur noch so viel
   * Gruppierung übrig, wie auch gezeigt wird: Jede Kombination aus Gruppe und Linie hat
   * mindestens Schwelle Antworten oder kommt nicht vor.
   */
  function coarsenStoredComparison(survey) {
    const responses = distinctResponses(answersOf(survey.id));
    const threshold = survey.anonymity_threshold;
    const { visible } = publishedGroups(responses, threshold);
    const atomOf = response => (visible.has(response.group_key) ? response.group_key : REST_GROUP);
    const lines = publishableLines(responses, atomOf, threshold);
    const update = db.prepare('UPDATE surveys_answers SET group_key=?, line_path=? WHERE survey_id=? AND response_id=?');
    for (const response of responses) {
      const linePath = toLinePath(lineIdsOf(response.line_path).filter(id => lines.has(id)));
      const groupKey = atomOf(response);
      if (groupKey !== response.group_key || linePath !== response.line_path) {
        update.run(groupKey, linePath, survey.id, response.response_id);
      }
    }
  }

  const closeSurvey = db.transaction((survey, actorId) => {
    db.prepare("UPDATE surveys_surveys SET status='closed', updated_at=? WHERE id=?").run(nowIso(), survey.id);
    db.prepare("UPDATE tasks SET done=1 WHERE type='surveys_participate' AND entity_id=? AND done=0").run(survey.id);
    db.prepare('DELETE FROM surveys_interim_results WHERE survey_id=?').run(survey.id);
    coarsenStoredComparison(survey);
    hideSubmissionOrder(survey.id);
    log(actorId, 'survey_closed', 'surveys_surveys', survey.id, { status: 'open' }, { status: 'closed' });
  });

  function parseAnswers(questions, submitted) {
    if (!Array.isArray(submitted)) return { error: 'Bitte sende deine Antworten mit.' };
    const questionById = new Map(questions.map(question => [question.id, question]));
    const seen = new Set();
    const answers = [];
    for (const item of submitted) {
      const questionId = Number(item?.questionId);
      const question = questionById.get(questionId);
      if (!question || seen.has(questionId)) return { error: 'Mindestens eine Antwort passt nicht zu dieser Befragung.' };
      seen.add(questionId);
      if (question.question_type === 'text') {
        const text = cleanText(item.text, MAX_TEXT_ANSWER_LENGTH);
        if (text) answers.push({ questionId, value: null, text });
        continue;
      }
      const { min, max } = QUESTION_RANGES[question.question_type];
      const isNumeric = typeof item.value === 'number' || (typeof item.value === 'string' && item.value !== '');
      const value = isNumeric ? boundedInt(item.value, min, max, null) : null;
      if (value === null) return { error: `Bitte wähle bei jeder Frage einen Wert von ${min} bis ${max}.` };
      answers.push({ questionId, value, text: null });
    }
    // Alle Fragen mit Zahlenwert sind Pflicht. So gilt die Antwortzahl einer Gruppe für jede dieser
    // Fragen und niemand fällt bei einer einzelnen Frage unter die Schwelle.
    if (questions.some(question => question.question_type !== 'text' && !seen.has(question.id))) {
      return { error: 'Bitte beantworte alle Fragen mit Skala. Nur Freitexte sind freiwillig.' };
    }
    if (!answers.length) return { error: 'Bitte beantworte mindestens eine Frage.' };
    return { answers };
  }

  // --- Auswertung -----------------------------------------------------------------------

  function summarize(questions, answers) {
    return questions.map(question => summarizeQuestion(question, answers.filter(answer => answer.question_id === question.id)));
  }

  /**
   * Das Ergebnis eines Bereichs. Solange die Befragung läuft, ändert sich der Zwischenstand erst
   * nach mindestens Schwelle neuen Antworten. Sonst ließe sich aus zwei Abrufen kurz nacheinander
   * die Antwort der Person errechnen, die dazwischen abgegeben hat.
   */
  function scopeResult(survey, scopeKey, questions, answers) {
    const answerCount = distinctResponses(answers).length;
    if (survey.status !== 'open') return { answerCount, questions: summarize(questions, answers) };
    const stored = db.prepare('SELECT answer_count, payload FROM surveys_interim_results WHERE survey_id=? AND scope_key=?').get(survey.id, scopeKey);
    const threshold = survey.anonymity_threshold;
    // Wurde die Schwelle inzwischen erhöht, darf ein Stand mit weniger Antworten nicht mehr erscheinen.
    if (stored && stored.answer_count >= threshold && answerCount - stored.answer_count < threshold) {
      return { answerCount: stored.answer_count, questions: JSON.parse(stored.payload) };
    }
    const summary = summarize(questions, answers);
    db.prepare(`
      INSERT INTO surveys_interim_results(survey_id, scope_key, answer_count, payload) VALUES(?, ?, ?, ?)
      ON CONFLICT (survey_id, scope_key) DO UPDATE SET answer_count=excluded.answer_count, payload=excluded.payload
    `).run(survey.id, scopeKey, answerCount, JSON.stringify(summary));
    return { answerCount, questions: summary };
  }

  function participationSummary(invited, responded) {
    return { invited, responded, ratePercent: invited ? Math.min(100, percentOf(responded, invited)) : null };
  }

  function groupResults(survey, questions, answers, responses, plan) {
    const threshold = survey.anonymity_threshold;
    const { visible, hiddenCount } = publishedGroups(responses, threshold);
    const invitedByGroup = new Map();
    for (const member of plan.values()) increment(invitedByGroup, member.groupKey);

    const shown = [...visible]
      .map(key => {
        const groupAnswers = answers.filter(answer => answer.group_key === key);
        const result = scopeResult(survey, `group:${key}`, questions, groupAnswers);
        const invited = Math.max(invitedByGroup.get(key) || 0, result.answerCount);
        return { label: groupLabel(key), insufficient: false, ...result, participation: participationSummary(invited, result.answerCount) };
      })
      .sort((first, second) => first.label.localeCompare(second.label, 'de'));

    if (hiddenCount >= threshold) {
      const restAnswers = answers.filter(answer => !visible.has(answer.group_key));
      const result = scopeResult(survey, `group:${REST_GROUP}`, questions, restAnswers);
      const invitedElsewhere = [...visible].reduce((sum, key) => sum + (invitedByGroup.get(key) || 0), 0);
      const invited = Math.max(plan.size - invitedElsewhere, result.answerCount);
      shown.push({ label: groupLabel(REST_GROUP), insufficient: false, ...result, participation: participationSummary(invited, result.answerCount) });
    }

    // Auch Gruppen ohne jede Antwort stehen hier, damit "zu wenige" nichts über null oder eins verrät.
    const hiddenKeys = new Set([...invitedByGroup.keys(), ...responses.map(response => response.group_key)]);
    const hidden = [...hiddenKeys]
      .filter(key => key !== REST_GROUP && !visible.has(key))
      .map(key => ({ label: groupLabel(key), ...INSUFFICIENT }))
      .sort((first, second) => first.label.localeCompare(second.label, 'de'));
    return [...shown, ...hidden];
  }

  function organizationResults(survey, actor, questions, answers, responses, plan) {
    // Wer selbst abgegeben hat, kennt die eigene Antwort. Sie zählt für die Schwelle deshalb nicht mit.
    const ownAnswerCounted = participationOf(survey.id, actor.id)?.submitted ? 1 : 0;
    if (responses.length - ownAnswerCounted < survey.anonymity_threshold) return { overall: INSUFFICIENT, groups: [] };
    const overall = {
      insufficient: false,
      ...scopeResult(survey, 'all', questions, answers),
      participation: participationSummary(invitedCountOf(survey.id), responses.length)
    };
    return { overall, groups: survey.status === 'closed' ? groupResults(survey, questions, answers, responses, plan) : [] };
  }

  function lineResults(survey, actor, questions, answers, responses, plan) {
    const threshold = survey.anonymity_threshold;
    let atomOf = () => 'all';
    if (survey.status === 'closed') {
      const { visible } = publishedGroups(responses, threshold);
      atomOf = response => (visible.has(response.group_key) ? response.group_key : REST_GROUP);
    }
    const marker = lineMarker(actor.id);
    const ownPlacement = plan.get(actor.id);
    const ownAnswerCounted = participationOf(survey.id, actor.id)?.submitted && ownPlacement?.linePath.includes(marker) ? 1 : 0;
    const lineAnswers = answers.filter(answer => answer.line_path.includes(marker));
    const lineCount = distinctResponses(lineAnswers).length;
    const published = publishableLines(responses, atomOf, threshold).has(actor.id);
    if (!published || lineCount - ownAnswerCounted < threshold) return { overall: INSUFFICIENT, groups: [] };
    const invited = [...plan.values()].filter(member => member.linePath.includes(marker)).length;
    return {
      overall: {
        insufficient: false,
        ...scopeResult(survey, `line:${actor.id}`, questions, lineAnswers),
        participation: participationSummary(Math.max(invited, lineCount), lineCount)
      },
      groups: []
    };
  }

  // --- Schnittstellen -------------------------------------------------------------------

  router.use('/surveys', auth);

  router.get('/surveys/open', (req, res) => {
    const actor = current(req);
    const rows = db.prepare(`
      SELECT s.*, p.submitted
      FROM surveys_participation p
      JOIN surveys_surveys s ON s.id = p.survey_id
      WHERE p.user_id=? AND s.status='open'
    `).all(actor.id);
    const items = rows
      .filter(row => !isPastEnd(row))
      .map(row => ({ ...publicSurvey(row), submitted: Boolean(row.submitted) }))
      .sort((first, second) => Number(first.submitted) - Number(second.submitted) || first.title.localeCompare(second.title, 'de'));
    res.json({ items });
  });

  router.get('/surveys/templates', (req, res) => {
    if (!isHr(current(req))) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const templates = db.prepare('SELECT * FROM surveys_question_templates ORDER BY sort_order').all();
    res.json({ templates: templates.map(template => ({ text: template.question_text, type: template.question_type, topic: template.topic || '' })) });
  });

  router.get('/surveys', (req, res) => {
    const actor = current(req);
    const hr = isHr(actor);
    if (!hr && !LEADERSHIP_ROLES.includes(actor.role)) return res.status(403).json({ error: 'Diese Liste ist HR und Führungskräften vorbehalten.' });
    const rows = db.prepare('SELECT * FROM surveys_surveys ORDER BY created_at DESC, id DESC').all();
    if (!hr) return res.json({ items: rows.filter(row => row.status !== 'draft').map(publicSurvey) });
    const invited = new Map(db.prepare('SELECT survey_id, COUNT(*) AS count FROM surveys_participation GROUP BY survey_id').all().map(row => [row.survey_id, row.count]));
    res.json({ items: rows.map(row => managementView(row, invited.get(row.id) || 0)) });
  });

  router.post('/surveys', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const body = req.body || {};
    const parsed = parseSurveySettings(body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const id = createSurvey(parsed.value, actor.id, body.useTemplates !== false);
    log(actor.id, 'survey_created', 'surveys_surveys', id, null, {
      title: parsed.value.title,
      anonymityThreshold: parsed.value.threshold,
      audience: parsed.value.audience
    });
    res.json({ id, survey: managementView(surveyById(id), 0), questions: questionsOf(id).map(publicQuestion) });
  });

  router.get('/surveys/:id', (req, res) => {
    if (!isHr(current(req))) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const survey = surveyById(routeId(req.params.id));
    if (!survey) return res.status(404).json({ error: 'Befragung nicht gefunden.' });
    res.json({ survey: managementView(survey, invitedCountOf(survey.id)), questions: questionsOf(survey.id).map(publicQuestion) });
  });

  /** Nach dem Öffnen lassen sich nur Ende und Schwelle ändern, und die Schwelle nur nach oben. */
  function updateRunningSurvey(survey, body) {
    const changedForbidden = ['title', 'intro', 'startsAt', 'audience', 'audienceRoles'].filter(name => body[name] !== undefined);
    if (changedForbidden.length) return { status: 409, error: 'Nach dem Öffnen lassen sich nur das Ende und die Mindestzahl an Antworten ändern.' };
    let threshold = survey.anonymity_threshold;
    if (body.anonymityThreshold !== undefined) {
      threshold = readThreshold(body.anonymityThreshold);
      if (threshold === null) return { status: 400, error: `Die Mindestzahl an Antworten muss mindestens ${MIN_THRESHOLD} sein.` };
      if (threshold < survey.anonymity_threshold) return { status: 400, error: 'Nach dem Öffnen lässt sich die Mindestzahl an Antworten nicht mehr senken.' };
    }
    let endsAt = survey.ends_at;
    if (body.endsAt !== undefined) {
      endsAt = readDate(body.endsAt);
      if (endsAt === INVALID) return { status: 400, error: 'Das Ende ist kein gültiges Datum.' };
      if (endsAt && endsAt < todayIso()) return { status: 400, error: 'Das Ende darf nicht in der Vergangenheit liegen.' };
    }
    db.prepare('UPDATE surveys_surveys SET anonymity_threshold=?, ends_at=?, updated_at=? WHERE id=?').run(threshold, endsAt, nowIso(), survey.id);
    // Alle Zeilen gleich behandeln, auch die erledigten: Sonst verrieten sie, wer schon abgegeben hat.
    db.prepare("UPDATE tasks SET title=?, due_date=? WHERE type='surveys_participate' AND entity_id=?").run(participationTaskTitle({ ...survey, ends_at: endsAt }), endsAt, survey.id);
    return { before: { anonymityThreshold: survey.anonymity_threshold, endsAt: survey.ends_at }, after: { anonymityThreshold: threshold, endsAt } };
  }

  function updateDraftSurvey(survey, body) {
    const parsed = parseSurveySettings(body, survey);
    if (parsed.error) return { status: 400, error: parsed.error };
    const settings = parsed.value;
    db.prepare(`
      UPDATE surveys_surveys
      SET title=?, intro=?, starts_at=?, ends_at=?, anonymity_threshold=?, audience=?, audience_roles=?, updated_at=?
      WHERE id=?
    `).run(settings.title, settings.intro, settings.startsAt, settings.endsAt, settings.threshold, settings.audience, settings.audienceRoles, nowIso(), survey.id);
    return { before: { title: survey.title, anonymityThreshold: survey.anonymity_threshold }, after: { title: settings.title, anonymityThreshold: settings.threshold } };
  }

  router.patch('/surveys/:id', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const survey = surveyById(routeId(req.params.id));
    if (!survey) return res.status(404).json({ error: 'Befragung nicht gefunden.' });
    if (survey.status === 'closed') return res.status(409).json({ error: 'Eine geschlossene Befragung lässt sich nicht mehr ändern.' });
    const outcome = survey.status === 'open' ? updateRunningSurvey(survey, req.body || {}) : updateDraftSurvey(survey, req.body || {});
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    log(actor.id, 'survey_updated', 'surveys_surveys', survey.id, outcome.before, outcome.after);
    res.json({ survey: managementView(surveyById(survey.id), invitedCountOf(survey.id)) });
  });

  router.delete('/surveys/:id', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const survey = surveyById(routeId(req.params.id));
    if (!survey) return res.status(404).json({ error: 'Befragung nicht gefunden.' });
    if (survey.status !== 'draft') return res.status(409).json({ error: 'Nur Entwürfe lassen sich löschen.' });
    db.transaction(() => {
      db.prepare('DELETE FROM surveys_questions WHERE survey_id=?').run(survey.id);
      db.prepare('DELETE FROM surveys_surveys WHERE id=?').run(survey.id);
      log(actor.id, 'survey_deleted', 'surveys_surveys', survey.id, { title: survey.title }, null);
    })();
    res.json({ ok: true });
  });

  /** Gemeinsame Prüfung aller Fragenänderungen: nur HR und nur im Entwurf. */
  function draftForQuestionChange(req, res) {
    if (!isHr(current(req))) {
      res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
      return null;
    }
    const survey = surveyById(routeId(req.params.id));
    if (!survey) {
      res.status(404).json({ error: 'Befragung nicht gefunden.' });
      return null;
    }
    if (survey.status !== 'draft') {
      res.status(409).json({ error: 'Fragen lassen sich nur im Entwurf ändern.' });
      return null;
    }
    return survey;
  }

  const questionOf = (surveyId, questionId) => db.prepare('SELECT * FROM surveys_questions WHERE id=? AND survey_id=?').get(questionId, surveyId);

  router.post('/surveys/:id/questions', (req, res) => {
    const survey = draftForQuestionChange(req, res);
    if (!survey) return;
    const parsed = parseQuestion(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const id = addQuestion(survey.id, parsed.value, nextSortOrder(survey.id));
    log(current(req).id, 'survey_question_created', 'surveys_questions', id, null, { surveyId: survey.id, type: parsed.value.type });
    res.json({ id, question: publicQuestion(questionOf(survey.id, id)) });
  });

  router.patch('/surveys/:id/questions/:questionId', (req, res) => {
    const survey = draftForQuestionChange(req, res);
    if (!survey) return;
    const before = questionOf(survey.id, routeId(req.params.questionId));
    if (!before) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    const parsed = parseQuestion(req.body || {}, before);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { text, type, topic } = parsed.value;
    db.prepare('UPDATE surveys_questions SET question_text=?, question_type=?, topic=? WHERE id=?').run(text, type, topic, before.id);
    log(current(req).id, 'survey_question_updated', 'surveys_questions', before.id, { type: before.question_type }, { surveyId: survey.id, type });
    res.json({ question: publicQuestion(questionOf(survey.id, before.id)) });
  });

  router.delete('/surveys/:id/questions/:questionId', (req, res) => {
    const survey = draftForQuestionChange(req, res);
    if (!survey) return;
    const question = questionOf(survey.id, routeId(req.params.questionId));
    if (!question) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    db.prepare('DELETE FROM surveys_questions WHERE id=?').run(question.id);
    log(current(req).id, 'survey_question_deleted', 'surveys_questions', question.id, { surveyId: survey.id, type: question.question_type }, null);
    res.json({ ok: true });
  });

  router.post('/surveys/:id/open', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const survey = surveyById(routeId(req.params.id));
    if (!survey) return res.status(404).json({ error: 'Befragung nicht gefunden.' });
    if (survey.status !== 'draft') return res.status(409).json({ error: 'Nur ein Entwurf lässt sich öffnen.' });
    if (!questionsOf(survey.id).length) return res.status(400).json({ error: 'Bitte lege zuerst mindestens eine Frage an.' });
    const today = todayIso();
    if (survey.starts_at && survey.starts_at > today) return res.status(400).json({ error: 'Der Beginn liegt in der Zukunft. Öffne die Befragung an diesem Tag oder ändere das Datum.' });
    if (survey.ends_at && survey.ends_at < today) return res.status(400).json({ error: 'Das Ende liegt in der Vergangenheit.' });
    const userIds = targetUserIds(survey);
    if (userIds.length < survey.anonymity_threshold) {
      return res.status(400).json({ error: `Die Zielgruppe hat weniger Personen als die Mindestzahl von ${survey.anonymity_threshold} Antworten. Es könnte nie ein Ergebnis geben.` });
    }
    openSurvey(survey, userIds, actor.id);
    res.json({ survey: managementView(surveyById(survey.id), userIds.length) });
  });

  router.post('/surveys/:id/close', (req, res) => {
    const actor = current(req);
    if (!isHr(actor)) return res.status(403).json({ error: 'Nur HR verwaltet Befragungen.' });
    const survey = surveyById(routeId(req.params.id));
    if (!survey) return res.status(404).json({ error: 'Befragung nicht gefunden.' });
    if (survey.status !== 'open') return res.status(409).json({ error: 'Nur eine offene Befragung lässt sich schließen.' });
    closeSurvey(survey, actor.id);
    res.json({ ok: true });
  });

  /**
   * Die Nummer steht in der Adresse und lässt sich leicht durchprobieren. Wer nicht eingeladen ist,
   * bekommt deshalb immer dieselbe Antwort. So verrät sie weder Entwürfe noch Befragungen für andere.
   * Entwürfe trifft das von selbst: Eingeladen wird erst beim Öffnen.
   */
  function ownInvitation(req, res) {
    const survey = surveyById(routeId(req.params.id));
    const participation = survey ? participationOf(survey.id, current(req).id) : null;
    if (!participation) {
      res.status(404).json({ error: 'Befragung nicht gefunden.' });
      return null;
    }
    if (survey.status === 'closed' || isPastEnd(survey)) {
      res.status(409).json({ error: 'Diese Befragung ist bereits beendet.' });
      return null;
    }
    return { survey, participation };
  }

  router.get('/surveys/:id/form', (req, res) => {
    const invitation = ownInvitation(req, res);
    if (!invitation) return;
    const { survey, participation } = invitation;
    const submitted = Boolean(participation.submitted);
    res.json({ survey: publicSurvey(survey), submitted, questions: submitted ? [] : questionsOf(survey.id).map(publicQuestion) });
  });

  router.post('/surveys/:id/responses', (req, res) => {
    const invitation = ownInvitation(req, res);
    if (!invitation) return;
    const { survey, participation } = invitation;
    if (participation.submitted) return res.status(409).json({ error: 'Du hast bereits abgegeben. Eine zweite Abgabe ist nicht möglich.' });
    const parsed = parseAnswers(questionsOf(survey.id), req.body?.answers);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!recordResponse(survey, current(req).id, parsed.answers)) return res.status(409).json({ error: 'Du hast bereits abgegeben. Eine zweite Abgabe ist nicht möglich.' });
    res.json({ ok: true });
  });

  router.get('/surveys/:id/results', (req, res) => {
    const actor = current(req);
    const hr = isHr(actor);
    if (!hr && !LEADERSHIP_ROLES.includes(actor.role)) return res.status(403).json({ error: 'Auswertungen sind HR und Führungskräften vorbehalten.' });
    const survey = surveyById(routeId(req.params.id));
    if (!survey || (!hr && survey.status === 'draft')) return res.status(404).json({ error: 'Befragung nicht gefunden.' });
    if (survey.status === 'draft') return res.status(409).json({ error: 'Ein Entwurf hat noch keine Auswertung.' });
    const questions = questionsOf(survey.id);
    const answers = answersOf(survey.id);
    const responses = distinctResponses(answers);
    const plan = comparisonPlan(survey);
    const results = hr
      ? organizationResults(survey, actor, questions, answers, responses, plan)
      : lineResults(survey, actor, questions, answers, responses, plan);
    res.json({ survey: publicSurvey(survey), scope: hr ? 'organization' : 'line', running: survey.status === 'open', ...results });
  });

  // --- Wartung und Beispieldaten --------------------------------------------------------

  /** Schließt Befragungen, deren Ende vorbei ist. Mehrfacher Aufruf ändert nichts weiter. */
  function maintenance() {
    const ended = db.prepare("SELECT * FROM surveys_surveys WHERE status='open' AND ends_at IS NOT NULL AND ends_at < ?").all(todayIso());
    for (const survey of ended) closeSurvey(survey, null);
    return { closed: ended.length };
  }

  function seedDemo() {
    const persons = db.prepare('SELECT id, role FROM users WHERE is_system_account=0 AND active=1 ORDER BY id').all();
    // Unter der Schwelle gäbe es keine Auswertung, und erfundene Einzelantworten soll es dann nicht geben.
    if (persons.length < DEFAULT_THRESHOLD) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM surveys_surveys').get().count) return;
    const admin = persons.find(person => person.role === 'hr_admin') || persons[0];
    const today = todayIso();
    const allPersons = persons.map(person => person.id);

    const finishedId = createSurvey({
      title: 'Stimmungsbild Frühjahr (Demo)',
      intro: 'Kurze Befragung zur Zusammenarbeit im letzten Quartal.',
      startsAt: addDays(today, -60),
      endsAt: addDays(today, -30),
      threshold: DEFAULT_THRESHOLD,
      audience: 'all',
      audienceRoles: null
    }, admin.id, true);
    const finished = surveyById(finishedId);
    openSurvey(finished, allPersons, admin.id);
    const questions = questionsOf(finishedId);
    const scalePattern = [4, 5, 3, 4, 2, 5, 4];
    const recommendationPattern = [9, 10, 7, 8, 6, 9, 10];
    const demoTexts = [
      'Mehr Zeit für die Einarbeitung neuer Kolleginnen und Kollegen.',
      'Besprechungen kürzer und mit klarer Tagesordnung.'
    ];
    allPersons.forEach((userId, personIndex) => {
      const answers = questions.flatMap((question, questionIndex) => {
        if (question.question_type === 'text') {
          const text = demoTexts[personIndex];
          return text ? [{ questionId: question.id, value: null, text }] : [];
        }
        const pattern = question.question_type === 'nps' ? recommendationPattern : scalePattern;
        return [{ questionId: question.id, value: pattern[(personIndex + questionIndex) % pattern.length], text: null }];
      });
      recordResponse(finished, userId, answers);
    });
    closeSurvey(finished, admin.id);

    const runningId = createSurvey({
      title: 'Puls Herbst (Demo)',
      intro: 'Wie geht es dir gerade bei der Arbeit? Deine Antworten bleiben anonym.',
      startsAt: today,
      endsAt: addDays(today, 21),
      threshold: DEFAULT_THRESHOLD,
      audience: 'all',
      audienceRoles: null
    }, admin.id, true);
    openSurvey(surveyById(runningId), allPersons, admin.id);
  }

  const helpArticles = [
    {
      id: 'surveys-participate',
      title: 'An einer Befragung teilnehmen',
      roles: ['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin'],
      views: ['surveysHome', 'surveysFill'],
      keywords: ['befragung', 'umfrage', 'mitarbeiterbefragung', 'ausfüllen', 'anonym', 'anonymität', 'teilnehmen'],
      answer: 'Unter „Befragungen“ siehst du alle Befragungen, zu denen du eingeladen bist. Du füllst sie in einem Zug aus, ein Zwischenspeichern gibt es nicht. Daybreak speichert getrennt, dass du abgegeben hast (ohne Zeitpunkt), und deine Antworten (ohne Name, Konto und Zeitpunkt). Ergebnisse erscheinen erst ab der genannten Mindestzahl an Antworten. Schreibe in Freitexte nichts, woran man dich oder andere erkennen kann.',
      steps: ['Öffne „Befragungen“.', 'Wähle die offene Befragung.', 'Beantworte die Fragen und sende sie ab. Danach lässt sich nichts mehr ändern, weil die Antworten dir nicht mehr zugeordnet werden können.'],
      actions: [{ label: 'Befragungen öffnen', view: 'surveysHome' }]
    },
    {
      id: 'surveys-manage',
      title: 'Befragungen anlegen und öffnen',
      roles: ['hr_admin', 'hrbp', 'super_admin'],
      views: ['surveysManage', 'surveysEdit'],
      keywords: ['befragung anlegen', 'umfrage erstellen', 'anonymitätsschwelle', 'mindestzahl', 'standardfragen', 'befragung öffnen', 'befragung schließen'],
      answer: 'HR legt eine Befragung als Entwurf an, auf Wunsch mit neutralen Standardfragen. Fragen lassen sich nur im Entwurf ändern. Beim Öffnen werden die Teilnehmenden festgeschrieben und erhalten eine Aufgabe. Die Mindestzahl an Antworten (auch Anonymitätsschwelle genannt) legt fest, ab wann Ergebnisse erscheinen. Sie beträgt mindestens 3 und lässt sich nach dem Öffnen nur noch erhöhen. Einzelantworten kann auch HR nicht sehen.',
      steps: ['Öffne „Befragungen“ und den Reiter „Verwalten“.', 'Lege eine Befragung an und prüfe die Fragen.', 'Öffne sie und schließe sie am Ende. Mit einem Enddatum schließt sie sich von selbst.'],
      actions: [{ label: 'Befragungen verwalten', view: 'surveysManage' }]
    },
    {
      id: 'surveys-results',
      title: 'Auswertung lesen',
      roles: ['manager', 'director', 'hr_admin', 'hrbp', 'super_admin'],
      views: ['surveysResultsList', 'surveysResults'],
      keywords: ['auswertung befragung', 'ergebnis befragung', 'weiterempfehlungswert', 'zu wenige antworten', 'teilnahmequote', 'rücklauf'],
      answer: 'Zahlen und Freitexte erscheinen erst ab der Mindestzahl an Antworten. Führungskräfte sehen nur die Ergebnisse von allen, die sie direkt oder indirekt führen, HR die gesamte Organisation und nach dem Schließen den Vergleich nach Bereichen. „Zu wenige Antworten“ kann auch bedeuten, dass sich sonst eine kleinere Gruppe errechnen ließe. Solange eine Befragung läuft, ändert sich der Zwischenstand nur in Schritten. Der Weiterempfehlungswert ist der Anteil der Werte 9 bis 10 minus der Anteil der Werte 0 bis 6.',
      steps: ['Öffne „Befragungen“ und den Reiter „Auswertung“.', 'Wähle eine Befragung.', 'Lies die Ergebnisse als Stimmungsbild einer Gruppe, nicht als Aussage über einzelne Personen.'],
      actions: [{ label: 'Auswertung öffnen', view: 'surveysResultsList' }]
    }
  ];

  return { router, initialize, seedDemo, maintenance, helpArticles };
}

module.exports = { createSurveysModule };
