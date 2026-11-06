'use strict';

/**
 * Einstellungen, die eine Organisation selbst verwaltet: welche freigegebenen Module an
 * sind, Anzeigename, Farbe und ob der Betreiber zu Supportzwecken hineinsehen darf.
 */

const express = require('express');
const { PlatformError } = require('../lib/platform');
const catalog = require('../lib/module-catalog');
const { sourceUrl } = require('../lib/project-info');

// Wofür ein Protokolleintrag steht, in einfachen Worten. Unbekanntes bleibt lesbar, siehe actionLabel.
const AUDIT_LABELS = {
  user_created: 'Konto angelegt',
  user_imported: 'Konto importiert',
  users_import_completed: 'Import abgeschlossen',
  user_updated: 'Konto geändert',
  user_deactivated: 'Konto gesperrt',
  user_reactivated: 'Konto entsperrt',
  manager_assigned: 'Führungskraft zugeordnet',
  password_changed: 'Eigenes Passwort geändert',
  compensation_cycle_review_started: 'Gehaltsrunde in die Prüfung gegeben',
  personnel_change_predecessor_updated: 'Änderung in der Personalakte angepasst',
  recruiting_internal_move_offered: 'Interner Wechsel angeboten',
  automation_job_created: 'Programmierauftrag angelegt',
  automation_job_queued: 'Programmierauftrag gestartet',
  automation_job_cancelled: 'Programmierauftrag abgebrochen',
  automation_publication_requested: 'Veröffentlichung angefordert',
  automation_publication_spawn_failed: 'Veröffentlichung nicht gestartet',
  time_clocked_in: 'Kommen gebucht',
  time_clocked_out: 'Gehen gebucht',
  personnel_rehired: 'Wiedereintritt erfasst',
  users_import_started: 'Import gestartet',
  password_reset_by_hr: 'Passwort durch HR zurückgesetzt',
  position_assigned: 'Position zugeordnet',
  module_enabled: 'Modul eingeschaltet',
  module_disabled: 'Modul abgeschaltet',
  approval_rule_changed: 'Genehmigungsregel geändert',
  organization_settings_updated: 'Einstellungen der Organisation geändert',
  support_access_entered: 'Support-Zugriff geöffnet',
  goal_created: 'Ziel angelegt',
  goal_updated: 'Ziel geändert',
  goal_approved: 'Ziel freigegeben',
  goal_changes_requested: 'Änderung am Ziel gewünscht',
  goal_resubmitted: 'Ziel neu eingereicht',
  goal_progress_updated: 'Zielfortschritt aktualisiert',
  manager_goal_accepted: 'Zielvorschlag angenommen',
  manager_goal_changes_requested: 'Änderung am Zielvorschlag gewünscht',
  checkin_created: 'Check-in erfasst',
  checkin_updated: 'Check-in korrigiert',
  checkin_acknowledged: 'Check-in bestätigt',
  checkin_deleted: 'Check-in gelöscht',
  absence_correction_requested: 'Korrektur einer Abwesenheit angefragt',
  learning_completion_reported: 'Kursabschluss gemeldet',
  tenant_backup_created: 'Sicherung einer Organisation erstellt',
  recruiting_offer_accepted: 'Angebot angenommen',
  competency_activated: 'Kompetenz aktiviert',
  self_assessment_created: 'Eigene Kompetenzeinschätzung eingetragen',
  self_assessment_updated: 'Eigene Kompetenzeinschätzung geändert',
  self_assessment_cleared: 'Eigene Kompetenzeinschätzung entfernt',
  manager_assessment_created: 'Kompetenzbewertung eingetragen',
  manager_assessment_updated: 'Kompetenzbewertung geändert',
  manager_assessment_cleared: 'Kompetenzbewertung entfernt',
  position_activated: 'Position aktiviert',
  position_requirement_activated: 'Positionsanforderung aktiviert',
  talent_review_goal_linked: 'Ziel mit einer Maßnahme verknüpft',
  talent_review_status_changed: 'Stand im Talent Review geändert',
  talent_review_employee_release_changed: 'Freigabe des Ergebnisses für die Person geändert',
  talent_review_self_draft_saved: 'Selbsteinschätzung als Entwurf gespeichert',
  talent_review_self_submitted: 'Selbsteinschätzung abgegeben',
  talent_review_manager_draft_saved: 'Einschätzung als Entwurf gespeichert',
  talent_review_participant_added: 'Teilnahme an einer Sitzung ergänzt',
  module_entitled: 'Modul freigegeben',
  module_entitlement_removed: 'Modulfreigabe entzogen',
  feedback_submitted: 'Feedback abgegeben',
  feedback_declined: 'Feedback-Anfrage abgelehnt',
  feedback_result_calculated: '360°-Bericht berechnet',
  feedback_result_reviewed: '360°-Bericht geprüft',
  feedback_result_released_manager: '360°-Bericht für die Führungskraft freigegeben',
  feedback_result_released_employee: '360°-Bericht für die Person freigegeben',
  feedback_result_closed: '360°-Bericht geschlossen',
  goal_withdrawn: 'Ziel zurückgezogen',
  recruiting_demo_seeded: 'Beispieldaten für Recruiting angelegt',
  talent_review_manager_changed: 'Führungskraft der Einschätzung gewechselt'
};
// Ältere Einträge enthalten Entwürfe der Selbsteinschätzung im Klartext. Die sind privat.
const PRIVATE_AUDIT_ACTION = /self_|draft/;
// Die meisten Aktionen heißen <Bereich>_<Tätigkeit>. So bleibt die Liste kurz und auch Neues lesbar.
const AUDIT_SUBJECTS = {
  absence_account: 'Urlaubskonto', absence_request: 'Abwesenheitsantrag', absence_type: 'Abwesenheitsart', absence_holiday: 'Feiertag', absence_holidays: 'Feiertage', absence_settings: 'Einstellungen zur Abwesenheit', absence: 'Abwesenheiten',
  time_entry: 'Zeiteintrag', time_week: 'Arbeitswoche', time_settings: 'Einstellungen zur Zeiterfassung', time_person_hours: 'Wochenstunden', time: 'Zeiten',
  compensation_cycle_participant: 'Person in der Gehaltsrunde', compensation_cycle: 'Gehaltsrunde', compensation_grade: 'Gehaltsband', compensation_proposal: 'Gehaltsvorschlag', compensation_record: 'Vergütungseintrag', compensation: 'Vergütung',
  succession_candidate: 'Kandidat:in für die Nachfolge', succession_plan: 'Nachfolgeplan',
  recruiting_application: 'Bewerbung', recruiting_candidate: 'Bewerber:in', recruiting_feedback: 'Bewertung im Gespräch', recruiting_interview: 'Gespräch', recruiting_offer: 'Angebot', recruiting_requisition: 'Stellenanforderung', recruiting_settings: 'Einstellungen zum Recruiting', recruiting_stage: 'Recruiting-Stufe',
  onboarding_journey: 'Ablauf', onboarding_task: 'Aufgabe im Ablauf', onboarding_tasks: 'Aufgaben im Ablauf', onboarding_template_task: 'Vorlagenaufgabe', onboarding_template: 'Vorlage',
  personnel_change: 'Änderung in der Personalakte', personnel_exit: 'Austritt', personnel_org_unit: 'Organisationseinheit', personnel_master: 'Stammdaten', personnel_task: 'Aufgabe zur Personalakte', personnel_data: 'Datenauskunft',
  learning_assignment: 'Kurszuweisung', learning_completion: 'Kursabschluss', learning_course: 'Kurs', learning_report: 'Lernbericht',
  survey_question: 'Frage der Befragung', survey: 'Befragung',
  feedback_cycle: '360°-Zyklus', feedback_development_action: 'Entwicklungsmaßnahme', feedback_invitation: 'Feedback-Einladung', feedback_nomination: 'Nominierung', feedback_nominations: 'Nominierungen', feedback_participant: 'Person im 360°-Zyklus', feedback_question: 'Frage', feedback_questionnaire: 'Fragebogen', feedback_result_meeting: 'Ergebnisgespräch', feedback_result: '360°-Ergebnis', feedback_section: 'Fragebogen-Abschnitt',
  talent_review_period: 'Talent-Review-Periode', talent_review_session_case: 'Fall in der Kalibrierung', talent_review_session: 'Kalibrierungssitzung', talent_review: 'Talent Review', talent_pool_membership: 'Platz im Talentpool', talent_pool: 'Talentpool',
  career_interests: 'Karriereinteressen', career_interest_note: 'HR-Hinweis', competency: 'Kompetenz', position_requirement: 'Positionsanforderung', position: 'Position', experience: 'Berufserfahrung', language: 'Sprachkenntnis', qualification: 'Qualifikation', development_goal_competency: 'Kompetenz im Entwicklungsziel', development_decision: 'Entwicklungsmaßnahme',
  assistant_feedback: 'Rückmeldung an Dayo', dayo_data_query: 'Datenfrage an Dayo', tenant: 'Organisation', domain: 'Adresse', demo_accounts: 'Demo-Zugänge', demo_password: 'Demo-Passwort'
};
const AUDIT_ACTIVITIES = {
  created: 'angelegt', added: 'ergänzt', updated: 'geändert', deleted: 'gelöscht', removed: 'entfernt', cancelled: 'abgebrochen', completed: 'abgeschlossen', closed: 'abgeschlossen', opened: 'geöffnet', started: 'gestartet',
  submitted: 'abgegeben', approved: 'freigegeben', rejected: 'abgelehnt', returned: 'zurückgegeben', reviewed: 'geprüft', shortened: 'verkürzt', exported: 'exportiert', imported: 'importiert', anonymized: 'anonymisiert', hired: 'eingestellt',
  moved: 'verschoben', filled: 'besetzt', recorded: 'erfasst', applied: 'wirksam geworden', reopened: 'wieder geöffnet', withdrawn: 'zurückgezogen', expired: 'abgelaufen', declined: 'abgelehnt', proposed: 'vorgeschlagen', saved: 'gespeichert',
  executed: 'gestellt', deactivated: 'deaktiviert', linked: 'verknüpft', unlinked: 'gelöst', locked: 'gesperrt', calculated: 'berechnet', versioned: 'neu versioniert', done: 'erledigt', calibrated: 'kalibriert', finalized: 'abgeschlossen', released: 'freigegeben', archived: 'archiviert'
};
function actionLabel(action) {
  const text = String(action || '');
  if (AUDIT_LABELS[text]) return AUDIT_LABELS[text];
  const parts = text.split('_');
  for (let split = parts.length - 1; split > 0; split -= 1) {
    const subject = AUDIT_SUBJECTS[parts.slice(0, split).join('_')];
    const activity = AUDIT_ACTIVITIES[parts.slice(split).join('_')];
    if (subject && activity) return `${subject} ${activity}`;
  }
  return AUDIT_SUBJECTS[text] || text.replace(/_/g, ' ');
}

// Tabellenprogramme führen Zellen mit =, +, - oder @ am Anfang als Formel aus.
const csvCell = value => {
  const text = String(value ?? '');
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

// Was das Protokoll im Klartext zeigt. Alles andere, etwa Gehälter oder Begründungen, bleibt in der CSV-Datei.
const AUDIT_FIELDS = {
  name: 'Name', email: 'E-Mail', title: 'Bezeichnung', role: 'Rolle', managerId: 'Führungskraft', userId: 'Person', employeeId: 'Person',
  active: 'Aktiv', status: 'Stand', approvalStatus: 'Stand', weight: 'Gewicht', dueDate: 'Termin', exitDate: 'Austritt', effectiveDate: 'Gilt ab',
  period: 'Zeitraum', module: 'Modul', key: 'Regel', value: 'Einstellung', positionProfileId: 'Position'
};
const AUDIT_ENTITIES = {
  users: 'Konto', goals: 'Ziel', checkins: 'Check-in', tasks: 'Aufgabe', tenant_modules: 'Modul', organization_settings: 'Genehmigungsregel', tenants: 'Organisation',
  absence_requests: 'Abwesenheit', absence_accounts: 'Urlaubskonto', absence_types: 'Abwesenheitsart', absence_holidays: 'Feiertag', absence_settings: 'Abwesenheit: Einstellungen',
  time_entries: 'Zeiteintrag', time_weeks: 'Arbeitswoche', time_settings: 'Zeiterfassung: Einstellungen', time_person_settings: 'Zeiterfassung: Person',
  personnel_changes: 'Personalakte', personnel_org_units: 'Organisationseinheit', compensation_cycles: 'Gehaltsrunde', compensation_proposals: 'Gehaltsvorschlag', compensation_records: 'Gehalt', compensation_grades: 'Gehaltsband',
  recruiting_offers: 'Angebot', recruiting_candidates: 'Bewerber:in', recruiting_requisitions: 'Stelle', recruiting_applications: 'Bewerbung', recruiting_stages: 'Bewerbungsschritt', recruiting_interviews: 'Gespräch', recruiting_feedback: 'Bewertung im Gespräch', recruiting_settings: 'Recruiting: Einstellungen',
  surveys_surveys: 'Befragung', surveys_questions: 'Frage', learning_assignments: 'Kurszuweisung', learning_courses: 'Kurs', succession_plans: 'Nachfolgeplan', succession_candidates: 'Kandidat:in',
  onboarding_journeys: 'Ablauf', onboarding_journey_tasks: 'Aufgabe im Ablauf', onboarding_templates: 'Vorlage', onboarding_template_tasks: 'Vorlagenaufgabe', assistant_feedback: 'Rückmeldung an Dayo', assistant_query: 'Datenfrage an Dayo',
  talent_review: 'Talent Review', talent_review_session: 'Kalibrierungssitzung', development_decision: 'Entwicklungsmaßnahme', position_profiles: 'Position', competencies: 'Kompetenz'
};
const AUDIT_ROLES = { employee: 'Mitarbeiter:in', manager: 'Führungskraft', director: 'Bereichsleitung', hr_staff: 'HR-Sachbearbeitung', hrbp: 'HR Business Partner', hr_admin: 'HR-Administration', super_admin: 'Systemadministration' };
// Stände im Klartext. Was hier fehlt, zeigt das Protokoll lieber gar nicht als roh auf Englisch.
const AUDIT_STATES = {
  approved: 'Freigegeben', rejected: 'Abgelehnt', submitted: 'Abgegeben', draft: 'Entwurf', open: 'Offen', closed: 'Abgeschlossen', completed: 'Abgeschlossen', cancelled: 'Abgebrochen', active: 'Aktiv',
  pending_manager_approval: 'Wartet auf die Führungskraft', pending_employee_acceptance: 'Wartet auf die Person', changes_requested_by_manager: 'Änderungswunsch der Führungskraft', changes_requested_by_employee: 'Änderungswunsch der Person',
  on_track: 'Im Plan', needs_focus: 'Fokus nötig', off_track: 'Gefährdet', suspended: 'Gesperrt', archived: 'Archiviert'
};
const parseAuditValues = text => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const germanDate = text => String(text).replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2.$1');

function createOrganizationRouter({ db, auth, current, platform, tenantId, log, approvalRule, listApprovalRules, setApprovalRule, isModuleEnabled, env = process.env }) {
  const router = express.Router();
  const configRouter = express.Router();
  const tenantNow = () => platform.tenantById(tenantId);
  const canAdminister = actor => ['hr_admin', 'super_admin'].includes(actor?.role);

  function publicModuleState(state) {
    return {
      key: state.key,
      name: state.name,
      area: state.area,
      description: state.description,
      dependsOn: state.dependsOn,
      alwaysOn: state.alwaysOn,
      status: state.status,
      entitled: state.entitled,
      switchedOn: state.switchedOn,
      enabled: state.enabled
    };
  }

  function settingsOf(tenant) {
    return {
      slug: tenant.slug,
      name: tenant.name,
      isPrimary: tenant.is_primary,
      demoMode: tenant.demo_mode,
      supportAccess: tenant.support_access,
      primaryColor: tenant.branding.primaryColor || null
    };
  }

  function sendError(res, error) {
    if (error instanceof PlatformError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }

  // Grunddaten für die Oberfläche: Name der Organisation und aktive Module.
  configRouter.get('/app/config', auth, (req, res) => {
    const tenant = tenantNow();
    const states = platform.moduleStates(tenantId);
    res.json({
      tenant: settingsOf(tenant),
      sourceUrl: sourceUrl(env),
      automationAvailable: Boolean(tenant.is_primary && platform.storage.kind === 'sqlite' && env.DAYBREAK_GIT_REPOSITORY),
      goalsNeedApproval: approvalRule('goals.approval') !== 'none',
      modules: states.filter(state => state.enabled).map(state => state.key),
      assets: {
        js: states.flatMap(state => state.assets.js),
        css: states.flatMap(state => state.assets.css)
      }
    });
  });

  router.use('/organization', auth, (req, res, next) => {
    if (!canAdminister(current(req))) return res.status(403).json({ error: 'Nur die HR-Administration darf die Organisationseinstellungen ändern.' });
    next();
  });

  router.get('/organization/modules', (req, res) => {
    res.json({ modules: platform.moduleStates(tenantId).map(publicModuleState) });
  });

  router.patch('/organization/modules/:key', (req, res) => {
    const actor = current(req);
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Bitte gib an, ob das Modul an oder aus sein soll.' });
    try {
      const state = platform.setModuleEnabled(tenantId, req.params.key, req.body.enabled, actor.email);
      log(actor.id, req.body.enabled ? 'module_enabled' : 'module_disabled', 'tenant_modules', null, null, { module: req.params.key });
      res.json({ module: publicModuleState(state) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/organization/approval-rules', (req, res) => {
    const enabled = new Set(platform.moduleStates(tenantId).filter(state => state.enabled).map(state => state.key));
    res.json({ rules: listApprovalRules().filter(rule => enabled.has(rule.module)) });
  });

  router.put('/organization/approval-rules/:key', (req, res) => {
    const actor = current(req);
    const value = typeof req.body?.value === 'string' ? req.body.value : '';
    if (!setApprovalRule(req.params.key, value, actor)) return res.status(400).json({ error: 'Diese Regel oder Einstellung gibt es nicht.' });
    res.json({ ok: true, rules: listApprovalRules() });
  });

  /** Macht aus einem Protokolleintrag zwei lesbare Angaben: wen oder was es betrifft und was sich geändert hat. */
  function auditReader() {
    const people = new Map(db.prepare('SELECT id,name FROM users').all().map(person => [person.id, person.name]));
    const moduleNames = new Map(platform.moduleStates(tenantId).map(state => [state.key, state.name]));
    const rules = new Map(listApprovalRules().map(rule => [rule.key, rule]));
    const positions = new Map(db.prepare('SELECT id,title FROM position_profiles').all().map(position => [position.id, position.title]));
    const shown = (field, value, values) => {
      if (value === null || value === undefined || value === '') return '–';
      if (['status', 'approvalStatus'].includes(field)) return AUDIT_STATES[value] || null;
      if (field === 'positionProfileId') return positions.get(value) || `Nr. ${value}`;
      if (['managerId', 'userId', 'employeeId'].includes(field)) return people.get(value) || `Nr. ${value}`;
      if (field === 'role') return AUDIT_ROLES[value] || String(value);
      if (field === 'active') return value ? 'Ja' : 'Nein';
      if (field === 'module') return moduleNames.get(value) || String(value);
      if (field === 'key') return rules.get(value)?.title || String(value);
      if (field === 'value') return rules.get(values.key)?.options?.find(option => option.value === value)?.label || String(value);
      if (field === 'weight') return `${value} %`;
      return germanDate(String(value)).slice(0, 80);
    };
    return row => {
      const before = parseAuditValues(row.old_values);
      const after = parseAuditValues(row.new_values);
      const changes = [];
      for (const [field, label] of Object.entries(AUDIT_FIELDS)) {
        if (!(field in before) && !(field in after)) continue;
        const was = shown(field, before[field], before);
        const now = shown(field, after[field], after);
        if (was === null || now === null) continue;
        if (field in before && field in after && was === now) {
          // Worum es geht, steht immer dabei.
          if (['key', 'module', 'userId', 'employeeId'].includes(field)) changes.push(`${label}: ${now}`);
          continue;
        }
        changes.push(field in before && field in after ? `${label}: ${was} → ${now}` : `${label}: ${field in after ? now : was}`);
      }
      const person = row.entity === 'users' ? people.get(row.entity_id) : null;
      const subject = person || AUDIT_ENTITIES[row.entity] || (row.entity ? 'Sonstiges' : '');
      return { subject: person || !row.entity_id ? subject : `${subject} Nr. ${row.entity_id}`, detail: changes.slice(0, 5).join(' · ') };
    };
  }

  function auditRows({ limit, before, action }) {
    const conditions = [];
    const values = [];
    if (before) {
      conditions.push('a.id < ?');
      values.push(before);
    }
    if (action) {
      conditions.push('a.action = ?');
      values.push(action);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT a.id,a.action,a.entity,a.entity_id,a.old_values,a.new_values,a.created_at,u.name actor_name
      FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ${where} ORDER BY a.id DESC LIMIT ?`).all(...values, limit)
      .map(row => (PRIVATE_AUDIT_ACTION.test(row.action) ? { ...row, old_values: null, new_values: null } : row))
      .map(row => ({ ...row, label: actionLabel(row.action) }));
  }

  /** Datenbankzeit (UTC) als deutsche Ortszeit, damit die Datei zur Seite passt. */
  const localTime = value => new Date(`${String(value).replace(' ', 'T')}${/[zZ]|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z'}`).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'medium' });

  router.get('/organization/audit', (req, res) => {
    const before = Number(req.query.before);
    const action = typeof req.query.action === 'string' ? req.query.action.slice(0, 80) : '';
    const read = auditReader();
    const entries = auditRows({ limit: 100, before: Number.isInteger(before) && before > 0 ? before : null, action }).map(row => ({ ...row, ...read(row) }));
    const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(row => ({ key: row.action, label: actionLabel(row.action) }));
    res.json({ entries, actions, hasMore: entries.length === 100 });
  });

  router.get('/organization/audit.csv', (req, res) => {
    const rows = auditRows({ limit: 5000, before: null, action: typeof req.query.action === 'string' ? req.query.action.slice(0, 80) : '' });
    const read = auditReader();
    const lines = [['Zeitpunkt', 'Wer', 'Was', 'Betrifft', 'Änderung', 'Bereich', 'Nummer', 'Vorher', 'Nachher'].map(csvCell).join(';')];
    for (const row of rows) {
      const { subject, detail } = read(row);
      lines.push([localTime(row.created_at), row.actor_name || 'System', row.label, subject, detail, row.entity, row.entity_id, row.old_values, row.new_values].map(csvCell).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="daybreak-protokoll.csv"');
    res.send(`\ufeff${lines.join('\r\n')}`);
  });

  /**
   * Was wo liegen bleibt. Aufgaben zu Befragungen fehlen absichtlich: Sonst wäre ablesbar, wer
   * noch nicht teilgenommen hat. Das soll auch HR nicht erfahren.
   */
  router.get('/organization/open-tasks', (req, res) => {
    // Vorgänge bei gesperrten Konten sind die, die sonst niemand mehr bemerkt.
    const rows = db.prepare(`SELECT t.id,t.title,t.type,t.due_date,t.created_at,u.name person_name,u.active person_active
      FROM tasks t JOIN users u ON u.id=t.user_id
      WHERE t.done=0 AND u.is_system_account=0 ORDER BY u.active, COALESCE(t.due_date,'9999-12-31'), t.id LIMIT 1000`).all();
    const tasks = rows.filter(row => {
      const type = String(row.type || '');
      if (type.startsWith('surveys_') || /(?:_notice|_info)$/.test(type)) return false;
      const moduleKey = catalog.moduleForTaskType(type);
      return !moduleKey || isModuleEnabled(moduleKey);
    });
    res.json({ tasks });
  });

  router.get('/organization/settings', (req, res) => {
    res.json({ settings: settingsOf(tenantNow()) });
  });

  router.patch('/organization/settings', (req, res) => {
    const actor = current(req);
    const before = tenantNow();
    if (before.demo_mode && actor.role !== 'super_admin') return res.status(403).json({ error: 'In der öffentlichen Demo bleiben Name und Farbe unverändert.', code: 'demo_protected' });
    const changes = {};
    if (req.body?.name !== undefined) changes.name = req.body.name;
    if (req.body?.primaryColor !== undefined) changes.primaryColor = req.body.primaryColor || '';
    if (typeof req.body?.supportAccess === 'boolean' && !before.is_primary) changes.supportAccess = req.body.supportAccess;
    try {
      const tenant = platform.updateTenant(tenantId, changes, actor.email);
      log(actor.id, 'organization_settings_updated', 'tenants', tenantId, settingsOf(before), settingsOf(tenant));
      res.json({ settings: settingsOf(tenant) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return { router, configRouter };
}

module.exports = { actionLabel, createOrganizationRouter };
