'use strict';

/**
 * Personalakte: Datenblatt je Person, Abteilungen und Standorte, Änderungen mit Gültig-ab-Datum,
 * Austritt mit Wiedereintritt, Fristen und Datenauskunft.
 *
 * Grundregel für Vertrags- und Organisationsdaten: Das Datenblatt hält immer den heute
 * gültigen Stand und wird nur über Einträge in personnel_changes geschrieben. Je Feld gilt
 * der wirksame Eintrag mit dem jüngsten Datum. Dadurch kann eine Rückdatierung eine jüngere
 * Änderung nie überschreiben: Sie landet an ihrer Stelle im Verlauf, und nur Felder ohne
 * jüngere Änderung erreichen das Datenblatt.
 *
 * Austritt: Das Austrittsdatum ist der letzte Arbeitstag. An diesem Tag hat die Person noch
 * Zugang, gesperrt wird das Konto zu Beginn des Folgetags. So bleibt ein Austritt mit dem
 * heutigen Datum bis Mitternacht zurücknehmbar. Für eine sofortige Sperre gibt es lockNow.
 *
 * Wiedereintritt: Das Eintrittsdatum bleibt der erste Tag im Unternehmen. Der Wiedereintritt
 * steht mit eigenem Datum im Verlauf und auf dem Datenblatt, damit beide Tage sichtbar bleiben.
 */

const express = require('express');

const BUSINESS_TIME_ZONE = 'Europe/Berlin';
const EARLIEST_DATE = '1900-01-01';
const LATEST_DATE = '2100-12-31';
const FIXED_TERM_NOTICE_DAYS = 90;
const PROBATION_NOTICE_DAYS = 30;
const MAX_WEEKLY_HOURS = 60;
// Jünger kann niemand eingetreten sein. Das fängt Zahlendreher ab, ohne seltene Ausnahmen zu sperren.
const MIN_AGE_AT_ENTRY = 13;
const MAX_SEARCH_LENGTH = 120;
const HR_ROLE_NAMES = Object.freeze(['hr_staff', 'hrbp', 'hr_admin']);

const EMPLOYMENT_TYPES = Object.freeze({
  employee: 'Angestellt',
  apprentice: 'Ausbildung',
  working_student: 'Werkstudium',
  external: 'Extern'
});
const CONTRACT_TYPES = Object.freeze({ permanent: 'Unbefristet', fixed_term: 'Befristet' });
const UNIT_TYPES = Object.freeze({
  department: 'Abteilung',
  location: 'Standort',
  cost_center: 'Kostenstelle',
  legal_entity: 'Gesellschaft'
});

const CONTRACT_FIELDS = Object.freeze({
  employmentType: 'employment_type',
  contractType: 'contract_type',
  fixedTermEnd: 'fixed_term_end',
  probationEnd: 'probation_end',
  weeklyHours: 'weekly_hours'
});
const ORGANIZATION_FIELDS = Object.freeze({
  orgUnitId: 'org_unit_id',
  locationId: 'location_id',
  costCenterId: 'cost_center_id'
});
const CHANGE_FIELDS = Object.freeze({ contract: CONTRACT_FIELDS, organization: ORGANIZATION_FIELDS });
const CONTACT_FIELDS = Object.freeze({
  privateAddress: 'private_address',
  privatePhone: 'private_phone',
  emergencyContact: 'emergency_contact'
});
const MASTER_FIELDS = Object.freeze({
  personnelNumber: 'personnel_number',
  birthDate: 'birth_date',
  entryDate: 'entry_date',
  ...CONTACT_FIELDS
});

// Welche Einheitstypen darf welches Feld des Stammdatenblatts referenzieren?
const UNIT_TYPES_BY_COLUMN = Object.freeze({
  org_unit_id: Object.freeze(['department', 'legal_entity']),
  location_id: Object.freeze(['location']),
  cost_center_id: Object.freeze(['cost_center'])
});

const FIELD_LABELS = Object.freeze({
  personnel_number: 'Personalnummer',
  birth_date: 'Geburtsdatum',
  private_address: 'Private Anschrift',
  private_phone: 'Private Telefonnummer',
  emergency_contact: 'Notfallkontakt',
  employment_type: 'Beschäftigungsart',
  contract_type: 'Vertragsart',
  entry_date: 'Eintrittsdatum',
  fixed_term_end: 'Befristungsende',
  probation_end: 'Probezeitende',
  weekly_hours: 'Wochenstunden',
  org_unit_id: 'Abteilung',
  location_id: 'Standort',
  cost_center_id: 'Kostenstelle'
});
// Diese Felder sind privat: Der Verlauf nennt nur, dass sie sich geändert haben, nie ihren Inhalt.
const PRIVATE_COLUMNS = Object.freeze(['birth_date', 'private_address', 'private_phone', 'emergency_contact']);
const DATE_COLUMNS = Object.freeze(['birth_date', 'entry_date', 'fixed_term_end', 'probation_end']);

const PERSON_STATUS_LABELS = Object.freeze({
  active: 'Aktiv',
  exit_planned: 'Austritt geplant',
  left: 'Ausgetreten',
  locked: 'Gesperrt'
});
const CHANGE_KIND_LABELS = Object.freeze({
  contract: 'Vertrag',
  organization: 'Organisation',
  exit: 'Austritt',
  rehire: 'Wiedereintritt'
});
const CHANGE_STATUS_LABELS = Object.freeze({
  scheduled: 'Geplant',
  applied: 'Wirksam',
  cancelled: 'Zurückgenommen'
});

const OVERVIEW_STATUS_FILTERS = Object.freeze(['active', 'exit_planned', 'left', 'locked', 'all']);
const OVERVIEW_DEADLINE_FILTERS = Object.freeze(['fixed_term_90', 'probation_30', 'exits']);
const OVERVIEW_DATASHEET_FILTERS = Object.freeze(['missing']);

const TASK_OFFBOARDING = 'personnel_offboarding';
const TASK_DEADLINE = 'personnel_deadline';
const PERSONNEL_TASK_TYPES = Object.freeze([TASK_OFFBOARDING, TASK_DEADLINE]);

// Datenauskunft: Spalten mit Personenbezug und Dinge, die nie in die Datei gehören.
const EXPORT_PERSON_COLUMNS = Object.freeze(['user_id', 'employee_id']);
// Die Teilnahme an anonymen Befragungen bleibt draußen, sonst könnte HR Einzelne danach fragen oder unter Druck setzen.
const EXPORT_EXCLUDED_TABLES = Object.freeze(['app_sessions', 'surveys_participation']);
const EXPORT_SECRET_COLUMN = /pass(word|wort)|(^|_)hash($|_)|secret|token|(^|_)salt($|_)/i;
const EXPORT_NOTICE = 'Bitte prüfe vor der Weitergabe, ob diese Datei Daten anderer Personen enthält (zum Beispiel Namen in Kommentaren oder Verweise auf Führungskräfte), und schwärze sie falls nötig. Hinweis, bitte im Einzelfall prüfen: Daybreak ersetzt keine Rechtsberatung. Was du herausgeben oder schwärzen musst, hängt vom einzelnen Fall ab. Frag im Zweifel die Person, die bei euch für den Datenschutz zuständig ist.';
// Planungs- und Bewertungsdaten: Die Person hat unter Umständen kein Recht auf alles davon, und manches soll sie
// nicht beiläufig erfahren. Die Auskunft verschweigt sie HR nicht, markiert sie aber für eine gesonderte Prüfung.
const EXPORT_REVIEW_TABLES = /^(?:succession_|compensation_proposals$|compensation_cycle_participants$|talent_review|talent_pool|development_decisions$|feedback_|recruiting_|career_interest_notes$|personnel_deadline_notices$)/i;
const EXPORT_SCOPE = 'Enthalten sind alle Tabellen mit direktem Personenbezug (Spalte user_id oder employee_id) sowie das Benutzerkonto ohne Passwortdaten. Einträge, in denen die Person nur als Autor oder Führungskraft einer anderen Person vorkommt, und das Änderungsprotokoll sind nicht enthalten. Auch die Teilnahme an anonymen Befragungen ist bewusst nicht enthalten.';

// Lesbare Fassung der Datenauskunft: Tabellen und Felder mit verständlichen Namen, Werte mit deutscher Schreibweise.
const READABLE_SCOPE = 'Enthalten ist alles, was Daybreak direkt zu dieser Person speichert, und ihr Benutzerkonto ohne Passwort. Nicht enthalten sind Einträge, in denen die Person nur als Autorin oder Führungskraft einer anderen Person vorkommt, das Änderungsprotokoll und die Teilnahme an anonymen Befragungen. Laufende Nummern und technische Verweise stehen nur in der technischen Datei.';
const READABLE_TABLE_TITLES = Object.freeze({
  users: 'Benutzerkonto',
  personnel_records: 'Personaldaten',
  personnel_changes: 'Änderungen an Vertrag und Organisation, Austritte und Wiedereintritte',
  personnel_master_changes: 'Änderungen an den Stammdaten',
  personnel_deadline_notices: 'Erinnerungen an Fristen',
  compensation_records: 'Vergütung',
  compensation_proposals: 'Gehaltsvorschläge',
  compensation_cycle_participants: 'Teilnahme an Gehaltsrunden',
  absence_accounts: 'Urlaubskonten',
  absence_requests: 'Abwesenheiten',
  time_person_settings: 'Einstellungen zur Arbeitszeit',
  time_weeks: 'Arbeitswochen',
  time_entries: 'Arbeitszeiten',
  time_entry_history: 'Änderungen an Arbeitszeiten',
  goals: 'Ziele',
  checkins: 'Check-ins (regelmäßige Gespräche mit der Führungskraft)',
  tasks: 'Aufgaben',
  career_interests: 'Karriereinteressen',
  career_interest_notes: 'Notizen zu den Karriereinteressen',
  competency_assessments: 'Kompetenzbewertungen',
  competency_assessment_history: 'Verlauf der Kompetenzbewertungen',
  language_skills: 'Sprachkenntnisse',
  professional_experiences: 'Berufserfahrung',
  qualification_records: 'Qualifikationen und Nachweise',
  position_assignment_history: 'Verlauf der Positionen',
  learning_assignments: 'Kurse und Schulungen',
  onboarding_journeys: 'Ein- und Austrittsabläufe',
  feedback_cycle_participants: '360° Feedback',
  talent_reviews: 'Talent Review (jährliche Einschätzung von Leistung und Potenzial)',
  talent_review_session_participants: 'Talent Review: Teilnahme an Abstimmungsrunden',
  talent_pool_memberships: 'Talentpools',
  development_decisions: 'Entwicklungsmaßnahmen',
  succession_candidates: 'Nachfolgeplanung',
  succession_history: 'Verlauf der Nachfolgeplanung',
  succession_review_tasks: 'Prüfaufgaben der Nachfolgeplanung',
  recruiting_candidates: 'Bewerbungsdaten',
  recruiting_feedback: 'Bewertungen aus Vorstellungsgesprächen',
  recruiting_interview_participants: 'Teilnahme an Vorstellungsgesprächen',
  assistant_feedback: 'Rückmeldungen an den Assistenten Dayo'
});
// Laufende Nummern und Verweise ohne Aussage. Vollständig stehen sie in der technischen Datei.
const READABLE_HIDDEN_COLUMNS = new Set([
  'id', 'user_id', 'employee_id', 'assessment_id', 'baseline_record_id', 'candidate_id', 'cycle_id', 'data_tool', 'entity_id', 'entry_id',
  'history_only', 'interview_id', 'is_system_account', 'language_normalized', 'linked_goal_id', 'model', 'overdue_reminded', 'period_id', 'plan_id',
  'pool_id', 'provider', 'qualification_record_id', 'recertification_id', 'review_id', 'session_id', 'source_cycle_id', 'template_id', 'version', 'view'
]);
const READABLE_PEOPLE_COLUMNS = new Set([
  'added_by', 'admitted_by', 'assessor_id', 'assigned_by', 'calibrated_by', 'cancelled_by', 'changed_by', 'confirmed_by', 'created_by', 'decided_by',
  'finalized_by', 'manager_id', 'proposed_by', 'reopened_by', 'responsible_id', 'returned_by', 'reviewed_by', 'started_by', 'updated_by'
]);
const READABLE_REFERENCES = Object.freeze({
  org_unit_id: ['personnel_org_units', 'name'],
  location_id: ['personnel_org_units', 'name'],
  cost_center_id: ['personnel_org_units', 'name'],
  course_id: ['learning_courses', 'title'],
  type_id: ['absence_types', 'name'],
  competency_id: ['competencies', 'name'],
  grade_id: ['compensation_grades', 'name'],
  position_profile_id: ['position_profiles', 'title'],
  previous_position_profile_id: ['position_profiles', 'title']
});
const READABLE_YES_NO_COLUMNS = new Set([
  'active', 'changed_by_hr', 'confirmation_pending', 'done', 'employee_visible', 'end_half', 'expert_interest', 'feedback_completed', 'internal_projects_interest',
  'is_current', 'leadership_interest', 'mentoring_interest', 'mobility', 'nomination_completed', 'project_interest', 'relocation', 'result_released', 'start_half',
  'submitted', 'talent_pool_consent'
]);
const READABLE_COLUMN_LABELS = Object.freeze({
  achievements: 'Erfolge', acknowledged_at: 'Bestätigt am', action: 'Vorgang', active: 'Aktiv', added_by: 'Hinzugefügt von', admitted_at: 'Aufgenommen am',
  admitted_by: 'Aufgenommen von', annual_salary_cents: 'Jahresgehalt', anonymized_at: 'Anonymisiert am', answer: 'Antwort', applied_at: 'Wirksam geworden am',
  approval_status: 'Stand der Freigabe', assessment_type: 'Art der Bewertung', assessor_id: 'Bewertet von', assigned_by: 'Zugewiesen von',
  base_salary_cents: 'Grundgehalt', birth_date: 'Geburtsdatum', break_minutes: 'Pause in Minuten', calibrated_at: 'Abgestimmt am', calibrated_by: 'Abgestimmt von',
  calibrated_performance: 'Abgestimmte Leistung', calibrated_potential: 'Abgestimmtes Potenzial', calibration_reason: 'Begründung der Abstimmung',
  cancel_note: 'Hinweis zur Rücknahme', cancel_reason: 'Grund der Rücknahme', cancelled_at: 'Zurückgenommen am', cancelled_by: 'Zurückgenommen von',
  career_goals: 'Berufliche Ziele', career_path: 'Gewünschte Laufbahn', carryover_days: 'Übertrag aus dem Vorjahr (Tage)', carryover_expires: 'Übertrag verfällt am',
  certificate_number: 'Zertifikatsnummer', changed_at: 'Geändert am', changed_by: 'Geändert von', changed_by_hr: 'Von HR geändert', comment: 'Kommentar',
  competency_id: 'Kompetenz', completed_at: 'Abgeschlossen am', concerns: 'Bedenken', confirmation_note: 'Hinweis zur Bestätigung',
  confirmation_pending: 'Wartet auf Bestätigung', confirmed_by: 'Bestätigt von', contract_type: 'Vertragsart', cost_center_id: 'Kostenstelle', course_id: 'Kurs',
  created_at: 'Angelegt am', created_by: 'Angelegt von', currency: 'Währung', date: 'Datum', deadline_date: 'Frist', decided_at: 'Entschieden am',
  decided_by: 'Entschieden von', decision_comment: 'Kommentar zur Entscheidung', decision_reason: 'Begründung der Entscheidung', decision_type: 'Art der Maßnahme',
  description: 'Beschreibung', desired_fields: 'Gewünschte Arbeitsfelder', development_actions: 'Entwicklungsschritte', development_fields: 'Entwicklungsfelder',
  development_plan: 'Entwicklungsplan', development_timeframe: 'Zeitrahmen der Entwicklung', done: 'Erledigt', due_date: 'Frist', effective_date: 'Gültig ab',
  email: 'E-Mail', emergency_contact: 'Notfallkontakt', employee_comment: 'Kommentar der Person', employee_visible: 'Für die Person sichtbar',
  employment_type: 'Beschäftigungsart', end_date: 'Ende', end_half: 'Letzter Tag nur halb', end_time: 'Ende', entitlement_days: 'Urlaubsanspruch (Tage)',
  entry_date: 'Eintrittsdatum', evidence_text: 'Nachweis', expected_answer: 'Erwartete Antwort', expert_interest: 'Interesse an Fachlaufbahn', expires_at: 'Gültig bis',
  feedback_completed: 'Feedback abgeschlossen', fields: 'Geänderte Felder', final_salary_cents: 'Endgültiges Gehalt', finalized_at: 'Abgeschlossen am',
  finalized_by: 'Abgeschlossen von', fixed_term_end: 'Befristungsende', fte_basis_points: 'Beschäftigungsumfang', gaps: 'Lücken', goal_type: 'Art des Ziels',
  grade_id: 'Gehaltsband', increase_cents: 'Erhöhung', input_mode: 'Eingabe als', input_percent_points: 'Erhöhung in Prozent',
  internal_projects_interest: 'Interesse an internen Projekten', issued_at: 'Ausgestellt am', issuer: 'Ausgestellt von', key_date: 'Erster oder letzter Arbeitstag',
  key_responsibilities: 'Wichtigste Aufgaben', kind: 'Art', language: 'Sprache', leadership_interest: 'Interesse an Führung', level: 'Niveau', location_id: 'Standort',
  manager_comment: 'Kommentar der Führungskraft', manager_id: 'Führungskraft', mentoring_interest: 'Interesse an Mentoring', mobility: 'Mobil', name: 'Name',
  new_date: 'Neues Datum', new_readiness: 'Neue Einschätzung der Bereitschaft', new_values: 'Neu', next_steps: 'Nächste Schritte',
  nomination_completed: 'Auswahl der Feedbackgebenden abgeschlossen', note: 'Notiz', notes: 'Notizen', observations: 'Beobachtungen', obstacles: 'Hindernisse',
  old_date: 'Bisheriges Datum', old_readiness: 'Bisherige Einschätzung der Bereitschaft', old_values: 'Bisher', on_track: 'Einschätzung', org_unit_id: 'Abteilung',
  organization: 'Unternehmen', original_performance: 'Ursprüngliche Leistung', original_potential: 'Ursprüngliches Potenzial', performance: 'Leistung',
  performance_reason: 'Begründung der Leistung', period: 'Zeitraum', personnel_number: 'Personalnummer', phone: 'Telefon', position_profile_id: 'Position',
  position_title: 'Position', potential_reason: 'Begründung des Potenzials', previous_position_profile_id: 'Bisherige Position', previous_position_title: 'Bisherige Position',
  priority: 'Dringlichkeit', private_address: 'Private Anschrift', private_phone: 'Private Telefonnummer', probation_end: 'Probezeitende', progress: 'Fortschritt in Prozent',
  project_interest: 'Interesse an Projekten', proof_text: 'Nachweis', proposed_by: 'Vorgeschlagen von', proposed_salary_cents: 'Vorgeschlagenes Gehalt', question: 'Frage',
  rating: 'Bewertung', readiness: 'Bereitschaft', reason: 'Grund', recommendation: 'Empfehlung', record_type: 'Art des Nachweises', recorded_at: 'Erfasst am',
  relocation: 'Umzug möglich', removed_at: 'Entfernt am', removed_reason: 'Grund der Entfernung', reopen_reason: 'Grund der Wiedereröffnung', reopened_at: 'Wieder geöffnet am',
  reopened_by: 'Wieder geöffnet von', reported_completion_date: 'Gemeldeter Abschluss', responsible_id: 'Verantwortlich', result_released: 'Ergebnis freigegeben',
  resume_text: 'Lebenslauf', resume_url: 'Link zum Lebenslauf', return_reason: 'Grund der Rückgabe', returned_at: 'Zurückgegeben am', returned_by: 'Zurückgegeben von',
  review_note: 'Notiz zur Prüfung', review_year: 'Jahr der Prüfung', reviewed_at: 'Geprüft am', reviewed_by: 'Geprüft von', role: 'Rolle', role_title: 'Bezeichnung der Stelle',
  satisfaction: 'Zufriedenheit', self_development_fields: 'Selbsteinschätzung: Entwicklungsfelder', self_next_steps: 'Selbsteinschätzung: nächste Schritte',
  self_observations: 'Selbsteinschätzung: Beobachtungen', self_performance: 'Selbsteinschätzung: Leistung', self_performance_reason: 'Selbsteinschätzung: Begründung der Leistung',
  self_potential: 'Selbsteinschätzung: Potenzial', self_potential_reason: 'Selbsteinschätzung: Begründung des Potenzials', self_status: 'Stand der Selbsteinschätzung',
  self_submitted_at: 'Selbsteinschätzung abgegeben am', source: 'Herkunft', start_date: 'Beginn', start_half: 'Erster Tag nur halb', start_time: 'Beginn', started_at: 'Begonnen am',
  started_by: 'Gestartet von', status: 'Stand', strengths: 'Stärken', submitted: 'Abgegeben', submitted_at: 'Eingereicht am', summary: 'Zusammenfassung',
  talent_pool_consent: 'Einwilligung in den Talentpool', talent_pool_consent_date: 'Einwilligung erteilt am', target_date: 'Zieldatum', target_position: 'Wunschposition',
  template_name: 'Vorlage', title: 'Bezeichnung', type: 'Art', type_id: 'Art der Abwesenheit', updated_at: 'Zuletzt geändert am', updated_by: 'Zuletzt geändert von',
  variable_target_cents: 'Variabler Zielbetrag', voided_at: 'Aufgehoben am', week_start: 'Woche ab', weekly_hours: 'Wochenstunden', weekly_minutes: 'Wochensoll in Minuten',
  weight: 'Gewichtung in Prozent', year: 'Jahr'
});
const READABLE_VALUES_BY_COLUMN = Object.freeze({
  action: { update: 'Geändert', clock_out: 'Gehen gestempelt', delete: 'Gelöscht' },
  approval_status: { approved: 'Genehmigt', pending_manager_approval: 'Wartet auf die Führungskraft', pending_employee_acceptance: 'Wartet auf die Person', changes_requested_by_manager: 'Überarbeitung durch die Person', changes_requested_by_employee: 'Überarbeitung durch die Führungskraft' },
  assessment_type: { self: 'Selbsteinschätzung', manager: 'Einschätzung der Führungskraft' },
  career_path: { expert: 'Fachlaufbahn', leadership: 'Führungslaufbahn', project: 'Projektlaufbahn', undecided: 'Noch offen' },
  contract_type: { permanent: 'Unbefristet', fixed_term: 'Befristet' },
  decision_type: { development_goal: 'Entwicklungsziel', mentoring: 'Mentoring', coaching: 'Coaching', training: 'Schulung', project_responsibility: 'Projektverantwortung', job_shadowing: 'Mitlaufen bei einer anderen Stelle', job_rotation: 'Wechsel der Aufgabe auf Zeit', stretch_assignment: 'Herausfordernde Aufgabe', expert_track_preparation: 'Vorbereitung auf die Fachlaufbahn', leadership_track_preparation: 'Vorbereitung auf die Führungslaufbahn', next_review: 'Nächstes Gespräch' },
  employment_type: { employee: 'Angestellt', apprentice: 'Ausbildung', working_student: 'Werkstudium', external: 'Extern' },
  goal_type: { business: 'Fachliches Ziel', development: 'Entwicklungsziel' },
  input_mode: { amount: 'Betrag', percent: 'Prozent' },
  kind: { contract: 'Vertrag', organization: 'Organisation', exit: 'Austritt', rehire: 'Wiedereintritt', fixed_term: 'Befristung', probation: 'Probezeit', exit_blocked: 'Austritt nicht ausgeführt', onboarding: 'Einstieg', offboarding: 'Austritt' },
  level: { native: 'Muttersprache' },
  new_readiness: { ready_now: 'Sofort bereit', ready_1_2_years: 'In 1 bis 2 Jahren bereit', ready_3_plus_years: 'In 3 oder mehr Jahren bereit' },
  old_readiness: { ready_now: 'Sofort bereit', ready_1_2_years: 'In 1 bis 2 Jahren bereit', ready_3_plus_years: 'In 3 oder mehr Jahren bereit' },
  on_track: { on_track: 'Im Plan', needs_focus: 'Braucht Aufmerksamkeit', off_track: 'Gefährdet' },
  priority: { low: 'Niedrig', normal: 'Normal', high: 'Hoch', critical: 'Sehr hoch' },
  readiness: { ready_now: 'Sofort bereit', ready_1_2_years: 'In 1 bis 2 Jahren bereit', ready_3_plus_years: 'In 3 oder mehr Jahren bereit' },
  reason: { hire: 'Einstellung', cycle: 'Gehaltsrunde', promotion: 'Beförderung', correction: 'Korrektur', other: 'Sonstiges' },
  recommendation: { hire: 'Einstellen', continue: 'Im Verfahren weiterführen', reject: 'Absagen' },
  record_type: { qualification: 'Qualifikation', certificate: 'Zertifikat', education: 'Ausbildung', training: 'Schulung' },
  role: { employee: 'Mitarbeiter:in', manager: 'Führungskraft', director: 'Bereichsleitung', hr_staff: 'HR-Sachbearbeitung', hrbp: 'HR Business Partner', hr_admin: 'HR-Administration' },
  self_status: { not_started: 'Nicht begonnen', employee_draft: 'Entwurf', employee_submitted: 'Abgegeben' },
  source: { hr: 'HR', manager: 'Führungskraft', self: 'Selbst eingetragen', recertification: 'Automatisch erneuert', employee: 'Die Person selbst', learning: 'Lernen', user_creation: 'Beim Anlegen des Kontos', hr_assignment: 'Zuordnung durch HR' },
  status: {
    pending: 'Offen', approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Zurückgenommen', scheduled: 'Geplant', applied: 'Wirksam', assigned: 'Zugewiesen', started: 'Begonnen',
    completed: 'Abgeschlossen', expired: 'Abgelaufen', open: 'Offen', submitted: 'Eingereicht', returned: 'Zurückgegeben', active: 'Aktiv', planned: 'Geplant', in_progress: 'In Arbeit',
    nominating: 'Auswahl der Feedbackgebenden', feedback_open: 'Feedback läuft', in_evaluation: 'In Auswertung', valid: 'Gültig', pending_verification: 'Wartet auf Prüfung', verified: 'Geprüft',
    proposed: 'Vorgeschlagen', confirmed: 'Bestätigt', removed: 'Entfernt', paused: 'Pausiert', not_started: 'Nicht begonnen', manager_draft: 'Entwurf der Führungskraft',
    manager_submitted: 'Von der Führungskraft eingereicht', in_calibration: 'In Abstimmung', calibrated: 'Abgestimmt', finalized: 'Abgeschlossen', on_track: 'Im Plan', needs_focus: 'Braucht Aufmerksamkeit',
    off_track: 'Gefährdet', acknowledged: 'Zur Kenntnis genommen', resolved: 'Erledigt', dismissed: 'Verworfen'
  }
});
const READABLE_MONEY_FORMAT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const READABLE_NUMBER_FORMAT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const READABLE_TIME_FORMAT = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: BUSINESS_TIME_ZONE });

const HR_ONLY_MESSAGE = 'Das darf nur HR.';
const UNITS_ONLY_MESSAGE = 'Abteilungen und Standorte pflegen die HR-Administration und HR Business Partner.';
const PERSON_NOT_FOUND = 'Person nicht gefunden.';
const NO_ACCESS_MESSAGE = 'Du hast keinen Zugriff auf diese Personaldaten.';
const OWN_DATA_MESSAGE = 'Deine eigenen Personaldaten ändert eine andere HR-Person. Deine privaten Kontaktdaten kannst du unter „Meine Daten“ selbst ändern.';
const NO_OWN_RECORD_MESSAGE = 'Für dieses Konto sind keine Personaldaten hinterlegt.';

const HELP_ARTICLES = Object.freeze([
  {
    id: 'personnel-my-data',
    title: 'Meine Daten ansehen und ändern',
    roles: ['employee', 'manager', 'director', 'hr_staff', 'hr_admin', 'hrbp'],
    views: ['personnelMe'],
    keywords: ['meine daten', 'personalakte', 'anschrift', 'adresse', 'umzug', 'telefon', 'telefonnummer', 'notfallkontakt', 'stammdaten', 'stammdatenblatt', 'kostenstelle'],
    answer: 'Unter „Meine Arbeit“ findest du „Meine Daten“. Dort siehst du, was Daybreak über dich und deinen Vertrag gespeichert hat. Anschrift, Telefonnummer und Notfallkontakt änderst du selbst. Vertragsdaten, Geburtsdatum und Personalnummer pflegt HR. Im Verlauf siehst du, welche Angaben wann geändert wurden. Die Kostenstelle ist die Nummer, unter der die Buchhaltung deine Personalkosten führt.',
    steps: ['Öffne „Meine Arbeit“ und dann „Meine Daten“.', 'Klicke bei den privaten Kontaktdaten auf „Ändern“.', 'Speichere die neuen Angaben. Stimmt etwas an den Vertragsdaten nicht, wende dich an HR.'],
    actions: [{ label: 'Meine Daten öffnen', view: 'personnelMe' }]
  },
  {
    id: 'personnel-team-data',
    title: 'Was sehe ich von meinem Team in der Personalakte?',
    roles: ['manager', 'director'],
    views: ['personnelMe', 'personnelPerson'],
    keywords: ['team', 'personalakte', 'dienstliche daten', 'wochenstunden', 'befristung', 'mitarbeitende', 'private daten'],
    answer: 'Als Führungskraft siehst du für alle, die du direkt oder indirekt führst, nur dienstliche Angaben wie Vertragsart, Wochenstunden und Abteilung. Private Angaben wie Anschrift oder Geburtsdatum sehen nur die Person selbst und HR.',
    steps: ['Öffne „Meine Daten“.', 'Wähle unten im Bereich „Mein Team“ eine Person aus.'],
    actions: [{ label: 'Meine Daten öffnen', view: 'personnelMe' }]
  },
  {
    id: 'personnel-change',
    title: 'Vertrag oder Abteilung ändern, gültig ab einem bestimmten Tag',
    roles: ['hr_staff', 'hr_admin', 'hrbp', 'super_admin'],
    views: ['personnelPeople', 'personnelPerson'],
    keywords: ['vertragsänderung', 'versetzung', 'wirksamkeitsdatum', 'gültig ab', 'wochenstunden', 'rückdatieren', 'rückdatierung', 'zurücknehmen', 'kostenstelle', 'standort'],
    answer: 'Änderungen an Vertrag und Organisation erfasst du in der Akte der Person mit dem Tag, ab dem sie gelten („Gültig ab“), und einem Grund. Heute oder ein vergangenes Datum wirkt sofort, ein zukünftiges Datum wird an diesem Tag automatisch wirksam und lässt sich bis dahin zurücknehmen. Gibt es für ein Feld schon eine jüngere Änderung, wird die Rückdatierung nur nach deiner Bestätigung in den Verlauf eingetragen; der aktuelle Wert bleibt dann erhalten. Eigene Daten ändert eine andere HR-Person, außer die Organisation erlaubt es in den Genehmigungsregeln.',
    steps: ['Öffne die Person unter „Personalakte“.', 'Wähle „Vertrag ändern“ oder „Organisation ändern“.', 'Ändere die Werte, trage „Gültig ab“ und den Grund ein und speichere.'],
    actions: [{ label: 'Personalakte öffnen', view: 'personnelPeople' }]
  },
  {
    id: 'personnel-exit',
    title: 'Austritt und Wiedereintritt erfassen',
    roles: ['hr_staff', 'hr_admin', 'hrbp', 'super_admin'],
    views: ['personnelPeople', 'personnelPerson'],
    keywords: ['austritt erfassen', 'einen austritt', 'austritt', 'kündigung', 'konto sperren', 'wiedereintritt', 'ausgetreten', 'letzter tag', 'letzter arbeitstag', 'austrittsdatum', 'eintrittsdatum', 'verlässt das unternehmen', 'nachfolge', 'neue führungskraft'],
    answer: 'Den Austritt erfasst du in der Akte der Person mit Datum und Grund. Das Austrittsdatum ist der letzte Arbeitstag: An diesem Tag hat die Person noch Zugang, am Tag danach wird das Konto automatisch gesperrt. Bis dahin kannst du den Austritt zurücknehmen. Liegt das Datum in der Vergangenheit oder wählst du „Zugang sofort sperren“, gilt die Sperre sofort. Führt die Person andere, legst du gleich fest, wer übernimmt; offene Anträge und Freigaben ziehen dann mit. Daten werden nie gelöscht. Ein Wiedereintritt macht das Konto wieder nutzbar. Das Eintrittsdatum bleibt dabei der erste Tag im Unternehmen, der Wiedereintritt steht mit eigenem Datum in der Akte.',
    steps: ['Öffne die Person unter „Personalakte“.', 'Wähle „Austritt erfassen“ und trage den letzten Arbeitstag und den Grund ein.', 'Führt die Person andere, wähle die neue Führungskraft aus.'],
    actions: [{ label: 'Personalakte öffnen', view: 'personnelPeople' }]
  },
  {
    id: 'personnel-data-export',
    title: 'Datenauskunft erstellen',
    roles: ['hr_admin', 'hrbp', 'super_admin'],
    views: ['personnelPerson'],
    keywords: ['datenauskunft', 'dsgvo', 'auskunft', 'datenexport', 'export', 'herunterladen', 'auskunftsersuchen'],
    answer: 'Nur die HR-Administration kann in der Akte einer Person eine Datenauskunft erstellen: als lesbare Fassung zum Drucken oder als technische Datei. Jeder Abruf wird protokolliert. Bitte prüfe vor der Weitergabe, ob sie Daten anderer Personen enthält. Hinweis, bitte im Einzelfall prüfen: Daybreak ersetzt keine Rechtsberatung, was herauszugeben ist, hängt vom einzelnen Fall ab.',
    steps: ['Öffne als HR-Administration die Person unter „Personalakte“.', 'Wähle „Datenauskunft“ und öffne die lesbare Fassung.', 'Prüfe sie und drucke sie oder speichere sie als PDF.'],
    actions: [{ label: 'Personalakte öffnen', view: 'personnelPeople' }]
  },
  {
    id: 'personnel-org-units',
    title: 'Abteilungen, Standorte und Kostenstellen verwalten',
    roles: ['hr_admin', 'hrbp', 'super_admin'],
    views: ['personnelUnits'],
    keywords: ['organisationseinheit', 'abteilung', 'standort', 'kostenstelle', 'gesellschaft', 'deaktivieren', 'leitung'],
    answer: 'Unter „Personalakte“ findest du den Reiter „Abteilungen und Standorte“. Dort legst du Abteilungen, Standorte, Kostenstellen und Gesellschaften an. Einheiten mit zugeordneten Personen lassen sich nur deaktivieren, nicht löschen.',
    steps: ['Öffne „Personalakte“ und den Reiter „Abteilungen und Standorte“.', 'Lege eine Einheit an oder bearbeite eine vorhandene.'],
    actions: [{ label: 'Abteilungen und Standorte öffnen', view: 'personnelUnits' }]
  }
]);

class RequestError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = message => new RequestError(400, message);
const forbidden = message => new RequestError(403, message);
const notFound = message => new RequestError(404, message);
const conflict = (message, details) => new RequestError(409, message, details);

const isEmptyInput = value => value === null || value === undefined || value === '';
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseId(value) {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[1-9]\d{0,14}$/.test(text) ? Number(text) : null;
}

const businessDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Kalendertag in Deutschland. Sonst begänne „heute“ nachts zwei Stunden zu spät. */
function businessDate(moment) {
  const parts = Object.fromEntries(businessDateFormat.formatToParts(moment).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function germanDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function isRealCalendarDay(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const quoteIdentifier = name => `"${String(name).replaceAll('"', '""')}"`;

const germanCollator = new Intl.Collator('de');
const lastNameOf = name => String(name ?? '').trim().split(/\s+/).at(-1) ?? '';

/** Nachname nach deutscher Sortierung (Ä wie A), bei gleichem Nachnamen entscheidet der ganze Name. */
function compareByLastName(first, second) {
  return germanCollator.compare(lastNameOf(first.name), lastNameOf(second.name)) || germanCollator.compare(first.name, second.name);
}

const SEARCH_SPELLINGS = Object.freeze({ ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ı: 'i' });
const withoutMarks = text => text.normalize('NFD').replace(/\p{M}/gu, '');

/** Zwei Schreibweisen je Text, damit man „Köhler“ als koehler und als kohler findet und „Ayşe“ als ayse. */
function searchSpellings(text) {
  const lower = String(text ?? '').normalize('NFC').toLowerCase().replace(/[ßæœøłđı]/g, letter => SEARCH_SPELLINGS[letter]);
  const umlautsSpelledOut = lower.replace(/[äöü]/g, letter => `${withoutMarks(letter)}e`);
  return [withoutMarks(umlautsSpelledOut), withoutMarks(lower)];
}

function matchesSearch(fields, words) {
  const spellings = searchSpellings(fields.filter(Boolean).join(' '));
  return words.every(word => searchSpellings(word).some(form => spellings.some(text => text.includes(form))));
}

function createPersonnelModule(deps) {
  const {
    db, auth, current, isHr, isHrOperator, hrCanAccess, blocksSelfEdit, canAssignManager, canAssignRole, canReassignPerson, canManageAccount, canViewEmployee, changeManager, subordinateIds, cleanText, validDate, log, createTask, setUserActive, tenant, isProtectedAccount = () => false,
    now = () => new Date()
  } = deps;
  const router = express.Router();

  const today = () => businessDate(now());
  const timestamp = () => now().toISOString();
  const inTransaction = work => db.transaction(work)();
  const canAdministerHrAdmins = actor => ['hr_admin', 'super_admin'].includes(actor.role);

  function initialize() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS personnel_org_units (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('department','location','cost_center','legal_entity')),
        name TEXT NOT NULL,
        code TEXT,
        parent_id INTEGER REFERENCES personnel_org_units(id),
        leader_user_id INTEGER REFERENCES users(id),
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS personnel_org_units_code ON personnel_org_units(type, code) WHERE code IS NOT NULL;

      CREATE TABLE IF NOT EXISTS personnel_records (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        personnel_number TEXT UNIQUE,
        birth_date TEXT,
        private_address TEXT,
        private_phone TEXT,
        emergency_contact TEXT,
        employment_type TEXT CHECK(employment_type IN ('employee','apprentice','working_student','external')),
        contract_type TEXT CHECK(contract_type IN ('permanent','fixed_term')),
        entry_date TEXT,
        fixed_term_end TEXT,
        probation_end TEXT,
        weekly_hours REAL,
        org_unit_id INTEGER REFERENCES personnel_org_units(id),
        location_id INTEGER REFERENCES personnel_org_units(id),
        cost_center_id INTEGER REFERENCES personnel_org_units(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS personnel_changes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK(kind IN ('contract','organization','exit','rehire')),
        old_values TEXT NOT NULL,
        new_values TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('scheduled','applied','cancelled')),
        history_only TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        applied_at TEXT,
        cancelled_by INTEGER REFERENCES users(id),
        cancelled_at TEXT,
        cancel_note TEXT
      );
      CREATE INDEX IF NOT EXISTS personnel_changes_person ON personnel_changes(user_id, effective_date);
      CREATE INDEX IF NOT EXISTS personnel_changes_due ON personnel_changes(status, effective_date);
      CREATE UNIQUE INDEX IF NOT EXISTS personnel_changes_one_planned_exit ON personnel_changes(user_id) WHERE kind='exit' AND status='scheduled';

      CREATE TABLE IF NOT EXISTS personnel_deadline_notices (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK(kind IN ('fixed_term','probation','exit_blocked')),
        deadline_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        voided_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS personnel_deadline_notices_once ON personnel_deadline_notices(user_id, kind, deadline_date) WHERE voided_at IS NULL;

      CREATE TABLE IF NOT EXISTS personnel_master_changes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        fields TEXT NOT NULL,
        old_values TEXT,
        new_values TEXT,
        changed_by INTEGER REFERENCES users(id),
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personnel_master_changes_person ON personnel_master_changes(user_id, changed_at);
    `);
  }

  // ---------------------------------------------------------------------------
  // Eingaben prüfen
  // ---------------------------------------------------------------------------

  function readDate(value, label) {
    const isValid = typeof value === 'string'
      && value !== ''
      && validDate(value)
      && isRealCalendarDay(value)
      && value >= EARLIEST_DATE
      && value <= LATEST_DATE;
    if (!isValid) throw badRequest(`${label}: Bitte gib ein gültiges Datum an.`);
    return value;
  }

  const readOptionalDate = (value, label) => isEmptyInput(value) ? null : readDate(value, label);

  function readOptionalText(value, label, maxLength) {
    if (isEmptyInput(value)) return null;
    if (typeof value !== 'string') throw badRequest(`${label}: Bitte gib einen Text an.`);
    return cleanText(value, maxLength) || null;
  }

  function readOptionalChoice(value, choices, label) {
    if (isEmptyInput(value)) return null;
    if (typeof value !== 'string' || !Object.hasOwn(choices, value)) throw badRequest(`${label}: Dieser Wert ist nicht möglich.`);
    return value;
  }

  function readOptionalId(value, label) {
    if (isEmptyInput(value)) return null;
    const id = parseId(value);
    if (id === null) throw badRequest(`${label}: Diese Auswahl ist ungültig.`);
    return id;
  }

  function readPhone(value) {
    const phone = readOptionalText(value, FIELD_LABELS.private_phone, 40);
    if (phone !== null && !/^[+0-9][0-9 ()/.-]{2,39}$/.test(phone)) {
      throw badRequest('Private Telefonnummer: Bitte nutze nur Ziffern, Leerzeichen und die Zeichen + ( ) / - .');
    }
    return phone;
  }

  function readWeeklyHours(value) {
    if (isEmptyInput(value)) return null;
    const text = typeof value === 'number' ? String(value) : value;
    const message = `Wochenstunden: Bitte gib eine Zahl größer als 0 und höchstens ${MAX_WEEKLY_HOURS} an, zum Beispiel 38,5.`;
    if (typeof text !== 'string' || !/^\d{1,2}([.,]\d{1,2})?$/.test(text.trim())) throw badRequest(message);
    const hours = Number(text.trim().replace(',', '.'));
    if (hours <= 0 || hours > MAX_WEEKLY_HOURS) throw badRequest(message);
    return hours;
  }

  function readBirthDate(value) {
    const birthDate = readOptionalDate(value, FIELD_LABELS.birth_date);
    if (birthDate && birthDate > today()) throw badRequest('Geburtsdatum: Das Datum darf nicht in der Zukunft liegen.');
    return birthDate;
  }

  const COLUMN_READERS = Object.freeze({
    personnel_number: value => readOptionalText(value, FIELD_LABELS.personnel_number, 40),
    birth_date: readBirthDate,
    private_address: value => readOptionalText(value, FIELD_LABELS.private_address, 300),
    private_phone: readPhone,
    emergency_contact: value => readOptionalText(value, FIELD_LABELS.emergency_contact, 300),
    entry_date: value => readOptionalDate(value, FIELD_LABELS.entry_date),
    employment_type: value => readOptionalChoice(value, EMPLOYMENT_TYPES, FIELD_LABELS.employment_type),
    contract_type: value => readOptionalChoice(value, CONTRACT_TYPES, FIELD_LABELS.contract_type),
    fixed_term_end: value => readOptionalDate(value, FIELD_LABELS.fixed_term_end),
    probation_end: value => readOptionalDate(value, FIELD_LABELS.probation_end),
    weekly_hours: readWeeklyHours,
    org_unit_id: value => readOptionalId(value, FIELD_LABELS.org_unit_id),
    location_id: value => readOptionalId(value, FIELD_LABELS.location_id),
    cost_center_id: value => readOptionalId(value, FIELD_LABELS.cost_center_id)
  });

  /** Übersetzt API-Felder in Spalten. Unbekannte Felder sind ein Fehler, damit nichts still übergangen wird. */
  function readFields(input, allowedFields, describeUnknown) {
    const values = {};
    for (const [apiName, rawValue] of Object.entries(input)) {
      if (!Object.hasOwn(allowedFields, apiName)) throw describeUnknown(cleanText(apiName, 40));
      const column = allowedFields[apiName];
      values[column] = COLUMN_READERS[column](rawValue);
    }
    return values;
  }

  const bodyOf = req => isPlainObject(req.body) ? req.body : {};

  function readReason(value) {
    const reason = typeof value === 'string' ? cleanText(value, 500) : '';
    if (!reason) throw badRequest('Bitte gib einen Grund an.');
    return reason;
  }

  // ---------------------------------------------------------------------------
  // Personen und Rechte
  // ---------------------------------------------------------------------------

  function findPerson(userId) {
    return db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.active, u.manager_id,
             COALESCE(p.title, u.title) AS title, m.name AS manager_name
      FROM users u
      LEFT JOIN position_profiles p ON p.id = u.position_profile_id
      LEFT JOIN users m ON m.id = u.manager_id
      WHERE u.id = ? AND u.is_system_account = 0
    `).get(userId) || null;
  }

  /** Alle HR-Rollen arbeiten hier. Auf welche Person sie zugreifen dürfen, entscheidet hrCanAccess. */
  function requireHrOperator(req, res, next) {
    if (!isHrOperator(current(req))) throw forbidden(HR_ONLY_MESSAGE);
    next();
  }

  // Die Struktur des Unternehmens gilt für alle. Die Sachbearbeitung liest sie nur.
  function requireUnitAdmin(req, res, next) {
    const actor = current(req);
    if (!isHr(actor)) throw forbidden(isHrOperator(actor) ? UNITS_ONLY_MESSAGE : HR_ONLY_MESSAGE);
    next();
  }

  const hasHrAccess = (actor, person) => isHrOperator(actor) && hrCanAccess(actor, person);

  /** Die Rolle wird vor der Suche geprüft, damit niemand über 403 und 404 Personen erraten kann. */
  function hrTarget(req) {
    const actor = current(req);
    if (!isHrOperator(actor)) throw forbidden(HR_ONLY_MESSAGE);
    const person = findPerson(parseId(req.params.userId));
    if (!person) throw notFound(PERSON_NOT_FOUND);
    if (!hrCanAccess(actor, person)) throw forbidden(actor.id === person.id ? OWN_DATA_MESSAGE : NO_ACCESS_MESSAGE);
    return { actor, person };
  }

  function hrEditTarget(req) {
    const target = hrTarget(req);
    if (blocksSelfEdit(target.actor, target.person.id)) throw forbidden(OWN_DATA_MESSAGE);
    return target;
  }

  // Niemand sperrt sich selbst, und Konten von HR-Personen sperrt nur die HR-Administration.
  // Sonst ließe sich hier die Grenze umgehen, die auch beim direkten Sperren im Grundsystem gilt.
  function mayManageAccountOf(actor, person) {
    if (actor.id === person.id || !hrCanAccess(actor, person)) return false;
    return canAdministerHrAdmins(actor) || !HR_ROLE_NAMES.includes(person.role);
  }

  function assertMayManageAccount(actor, person) {
    if (actor.id === person.id) throw forbidden('Du kannst dein eigenes Konto nicht auf diesem Weg sperren oder entsperren. Das muss eine andere HR-Person tun.');
    if (!mayManageAccountOf(actor, person)) throw forbidden('Konten von HR-Personen sperrt oder entsperrt nur die HR-Administration.');
  }

  function accountTarget(req) {
    const target = hrTarget(req);
    assertMayManageAccount(target.actor, target.person);
    return target;
  }

  function isLastActiveHrAdmin(person) {
    if (person.role !== 'hr_admin' || !person.active) return false;
    const others = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'hr_admin' AND is_system_account = 0 AND active = 1 AND id <> ?").get(person.id).count;
    return others === 0;
  }

  /**
   * Empfänger von HR-Aufgaben: wer die Akte der Person öffnen darf. Der Titel nennt schon Name und
   * Frist, deshalb geht er nicht an HR-Personen ohne Zugriff. Die Person selbst nur, wenn es sonst niemanden gibt.
   */
  function hrRecipients(subjectId) {
    const subject = findPerson(subjectId);
    const allowed = db.prepare("SELECT id, role FROM users WHERE role IN ('hr_admin','hrbp','hr_staff') AND is_system_account = 0 AND active = 1 ORDER BY id").all()
      .filter(candidate => hrCanAccess(candidate, subject))
      .map(candidate => candidate.id);
    const others = allowed.filter(id => id !== subjectId);
    return others.length ? others : allowed;
  }

  const directReportRows = userId => db.prepare(`
    SELECT u.id, u.name, u.role, COALESCE(p.title, u.title) AS title
    FROM users u
    LEFT JOIN position_profiles p ON p.id = u.position_profile_id
    WHERE u.manager_id = ? AND u.is_system_account = 0 AND u.active = 1
  `).all(userId).sort(compareByLastName);

  const directReportsOf = userId => directReportRows(userId).map(({ id, name, title }) => ({ id, name, title }));

  const unitsLedBy = userId => db.prepare('SELECT id, name, type FROM personnel_org_units WHERE leader_user_id = ? AND active = 1 ORDER BY name')
    .all(userId)
    .map(unit => ({ id: unit.id, name: unit.name, typeLabel: UNIT_TYPES[unit.type] }));

  // ---------------------------------------------------------------------------
  // Organisationseinheiten
  // ---------------------------------------------------------------------------

  const allUnits = () => db.prepare('SELECT * FROM personnel_org_units ORDER BY name').all();
  const findUnit = unitId => db.prepare('SELECT * FROM personnel_org_units WHERE id = ?').get(unitId) || null;
  const unitsById = () => new Map(allUnits().map(unit => [unit.id, unit]));

  function unitReference(units, unitId) {
    const unit = unitId ? units.get(unitId) : null;
    return unit ? { id: unit.id, name: unit.name, code: unit.code, active: Boolean(unit.active) } : null;
  }

  function descendantUnitIds(rootId, units) {
    const childrenByParent = new Map();
    for (const unit of units) {
      if (!unit.parent_id) continue;
      childrenByParent.set(unit.parent_id, [...(childrenByParent.get(unit.parent_id) || []), unit.id]);
    }
    const found = new Set();
    const pending = [rootId];
    while (pending.length) {
      const id = pending.pop();
      if (found.has(id)) continue;
      found.add(id);
      pending.push(...(childrenByParent.get(id) || []));
    }
    return found;
  }

  /** Eine Einheit hängt unter einer Einheit gleichen Typs oder direkt unter einer Gesellschaft. */
  function assertValidParent(unitType, parentId, unitId = null) {
    if (parentId === null) return;
    if (parentId === unitId) throw badRequest('Eine Einheit kann nicht ihre eigene übergeordnete Einheit sein.');
    const parent = findUnit(parentId);
    if (!parent) throw badRequest('Die übergeordnete Einheit wurde nicht gefunden.');
    if (!parent.active) throw badRequest('Die übergeordnete Einheit ist deaktiviert.');
    if (parent.type !== unitType && parent.type !== 'legal_entity') {
      throw badRequest(`Eine Einheit vom Typ „${UNIT_TYPES[unitType]}“ passt nicht unter „${UNIT_TYPES[parent.type]}“.`);
    }
    const visited = new Set();
    let cursor = parent;
    while (cursor && !visited.has(cursor.id)) {
      if (cursor.id === unitId) throw badRequest('Diese Zuordnung würde einen Kreis im Organisationsbaum erzeugen.');
      visited.add(cursor.id);
      cursor = cursor.parent_id ? findUnit(cursor.parent_id) : null;
    }
  }

  function assertValidLeader(leaderUserId) {
    if (leaderUserId === null) return;
    const leader = db.prepare('SELECT id FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(leaderUserId);
    if (!leader) throw badRequest('Die gewählte Leitung wurde nicht gefunden oder ist nicht aktiv.');
  }

  function assertCodeFree(unitType, code, unitId = null) {
    if (code === null) return;
    const holder = db.prepare('SELECT id FROM personnel_org_units WHERE type = ? AND LOWER(code) = LOWER(?)').get(unitType, code);
    if (holder && holder.id !== unitId) throw conflict(`Der Code „${code}“ ist für diesen Typ bereits vergeben.`);
  }

  function organizationChanges(statuses) {
    const placeholders = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM personnel_changes WHERE kind = 'organization' AND status IN (${placeholders})`)
      .all(...statuses)
      .map(parseChange);
  }

  function changeReferencesUnit(change, unitId) {
    return [change.oldValues, change.newValues].some(values => Object.keys(UNIT_TYPES_BY_COLUMN).some(column => values[column] === unitId));
  }

  const countAssignedPeople = unitId => db.prepare(`
    SELECT COUNT(*) AS count FROM personnel_records
    WHERE org_unit_id = ? OR location_id = ? OR cost_center_id = ?
  `).get(unitId, unitId, unitId).count;

  function serializeUnits() {
    const units = allUnits();
    const names = new Map(db.prepare('SELECT id, name, active FROM users WHERE is_system_account = 0').all().map(person => [person.id, person]));
    const assignedByUnit = new Map();
    const assignments = db.prepare(`
      SELECT r.org_unit_id, r.location_id, r.cost_center_id
      FROM personnel_records r
      JOIN users u ON u.id = r.user_id
      WHERE u.active = 1 AND u.is_system_account = 0
    `).all();
    for (const assignment of assignments) {
      for (const unitId of [assignment.org_unit_id, assignment.location_id, assignment.cost_center_id]) {
        if (unitId) assignedByUnit.set(unitId, (assignedByUnit.get(unitId) || 0) + 1);
      }
    }
    return units.map(unit => {
      const leader = unit.leader_user_id ? names.get(unit.leader_user_id) : null;
      return {
        id: unit.id,
        type: unit.type,
        typeLabel: UNIT_TYPES[unit.type],
        name: unit.name,
        code: unit.code,
        parentId: unit.parent_id,
        leader: leader ? { id: leader.id, name: leader.name, active: Boolean(leader.active) } : null,
        active: Boolean(unit.active),
        assignedCount: assignedByUnit.get(unit.id) || 0
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Stammdatenblatt
  // ---------------------------------------------------------------------------

  const readRecord = userId => db.prepare('SELECT * FROM personnel_records WHERE user_id = ?').get(userId) || null;

  function writeRecordColumns(userId, values) {
    const columns = Object.keys(values);
    if (!columns.length) return;
    if (columns.some(column => !Object.hasOwn(FIELD_LABELS, column))) throw new Error('Unbekannte Spalte im Stammdatenblatt.');
    const stamp = timestamp();
    db.prepare('INSERT INTO personnel_records(user_id, created_at, updated_at) VALUES(?, ?, ?) ON CONFLICT(user_id) DO NOTHING').run(userId, stamp, stamp);
    const assignments = columns.map(column => `${column} = ?`).join(', ');
    db.prepare(`UPDATE personnel_records SET ${assignments}, updated_at = ? WHERE user_id = ?`).run(...columns.map(column => values[column]), stamp, userId);
  }

  // Freigabelisten statt Sperrlisten: Ein neues Feld ist erst sichtbar, wenn es hier steht.
  function businessFields(record, units) {
    const source = record || {};
    return {
      personnelNumber: source.personnel_number ?? null,
      employmentType: source.employment_type ?? null,
      employmentTypeLabel: EMPLOYMENT_TYPES[source.employment_type] ?? null,
      contractType: source.contract_type ?? null,
      contractTypeLabel: CONTRACT_TYPES[source.contract_type] ?? null,
      entryDate: source.entry_date ?? null,
      fixedTermEnd: source.fixed_term_end ?? null,
      probationEnd: source.probation_end ?? null,
      weeklyHours: source.weekly_hours ?? null,
      orgUnit: unitReference(units, source.org_unit_id),
      location: unitReference(units, source.location_id),
      costCenter: unitReference(units, source.cost_center_id)
    };
  }

  function privateFields(record) {
    const source = record || {};
    return {
      birthDate: source.birth_date ?? null,
      privateAddress: source.private_address ?? null,
      privatePhone: source.private_phone ?? null,
      emergencyContact: source.emergency_contact ?? null
    };
  }

  /** Wer erst noch eintritt, ist nicht einfach „Aktiv“. */
  function statusLabelOf(status, entryDate) {
    if (status === 'active' && entryDate && entryDate > today()) {
      const [year, month, day] = entryDate.split('-');
      return `Eintritt am ${day}.${month}.${year}`;
    }
    return PERSON_STATUS_LABELS[status];
  }

  function personStatus(active, lifecycleEvent) {
    if (lifecycleEvent?.kind === 'exit' && lifecycleEvent.status === 'scheduled') return 'exit_planned';
    if (active) return 'active';
    return lifecycleEvent?.kind === 'exit' ? 'left' : 'locked';
  }

  function latestLifecycleEvent(userId) {
    return db.prepare(`
      SELECT c.id, c.kind, c.status, c.effective_date, c.reason, c.new_values, c.created_at, creator.name AS created_by_name
      FROM personnel_changes c
      LEFT JOIN users creator ON creator.id = c.created_by
      WHERE c.user_id = ? AND c.kind IN ('exit','rehire') AND c.status IN ('scheduled','applied')
      ORDER BY c.id DESC
      LIMIT 1
    `).get(userId) || null;
  }

  function latestRehireDate(userId) {
    return db.prepare("SELECT effective_date FROM personnel_changes WHERE user_id = ? AND kind = 'rehire' AND status = 'applied' ORDER BY id DESC LIMIT 1").get(userId)?.effective_date ?? null;
  }

  function latestLifecycleEventsByPerson() {
    const events = db.prepare(`
      SELECT id, user_id, kind, status, effective_date
      FROM personnel_changes
      WHERE kind IN ('exit','rehire') AND status IN ('scheduled','applied')
      ORDER BY id
    `).all();
    return new Map(events.map(event => [event.user_id, event]));
  }

  function permissionsFor(actor, person, status) {
    const hrAccess = hasHrAccess(actor, person);
    const mayEdit = hrAccess && !blocksSelfEdit(actor, person.id);
    const mayManageAccount = hrAccess && mayManageAccountOf(actor, person);
    return {
      editMaster: mayEdit,
      recordChange: mayEdit,
      recordExit: mayManageAccount && ['active', 'locked'].includes(status),
      // Sofort sperren darf nur, wer dieses Konto auch direkt sperren dürfte.
      exitNow: mayManageAccount && canManageAccount(actor, person),
      cancelExit: mayManageAccount && status === 'exit_planned',
      rehire: mayManageAccount && canManageAccount(actor, person) && status === 'left',
      viewHistory: hrAccess || actor.id === person.id,
      dataExport: canAdministerHrAdmins(actor),
      manageUnits: isHr(actor)
    };
  }

  function successorOf(event) {
    const successorId = JSON.parse(event.new_values || '{}').successor_manager_id;
    return successorId ? db.prepare('SELECT id, name FROM users WHERE id = ? AND is_system_account = 0').get(successorId) || null : null;
  }

  function exitInfo(event, status) {
    if (event?.kind !== 'exit' || !['exit_planned', 'left'].includes(status)) return null;
    return {
      changeId: event.id,
      date: event.effective_date,
      status,
      reason: event.reason,
      recordedAt: event.created_at,
      recordedBy: event.created_by_name,
      successor: status === 'exit_planned' ? successorOf(event) : null
    };
  }

  /** Dieselbe Grenze wie bei der Zuordnung im Grundsystem. */
  const mayReassign = (actor, report) => canReassignPerson(actor, report) && !blocksSelfEdit(actor, report.id);

  function buildSheet(actor, person) {
    const record = readRecord(person.id);
    const units = unitsById();
    const event = latestLifecycleEvent(person.id);
    const status = personStatus(person.active, event);
    const hrAccess = hasHrAccess(actor, person);
    const hasFullAccess = hrAccess || actor.id === person.id;
    // Ein geplanter Austritt und sein Grund sind vertraulich, bis HR sie mitgeteilt hat.
    const visibleStatus = status === 'exit_planned' && !hrAccess ? 'active' : status;
    const sheet = {
      person: {
        id: person.id,
        name: person.name,
        title: person.title,
        email: person.email,
        role: person.role,
        managerName: person.manager_name,
        active: Boolean(person.active),
        status: visibleStatus,
        statusLabel: statusLabelOf(visibleStatus, record?.entry_date)
      },
      hasRecord: Boolean(record),
      access: hasFullAccess ? 'full' : 'business',
      business: { ...businessFields(record, units), rehireDate: latestRehireDate(person.id) },
      permissions: permissionsFor(actor, person, status)
    };
    if (hasFullAccess) sheet.private = privateFields(record);
    if (hrAccess) {
      sheet.exit = exitInfo(event, status);
      sheet.directReports = directReportRows(person.id).map(report => ({
        id: report.id,
        name: report.name,
        title: report.title,
        canReassign: mayReassign(actor, report)
      }));
      sheet.ledUnits = unitsLedBy(person.id);
    }
    return sheet;
  }

  function assertPersonnelNumberFree(personnelNumber, userId) {
    if (personnelNumber === null) return;
    const holder = db.prepare('SELECT user_id FROM personnel_records WHERE LOWER(personnel_number) = LOWER(?) AND user_id <> ?').get(personnelNumber, userId);
    if (holder) throw conflict('Diese Personalnummer ist bereits vergeben.');
  }

  /**
   * Fängt Tippfehler wie ein Geburtsjahr nach dem Eintritt ab. Geprüft wird nur, was sich gerade
   * ändert: Ein alter, schiefer Eintrag soll niemanden daran hindern, die Anschrift zu ändern.
   */
  function assertPlausibleDates(userId, record, values, changedColumns) {
    const changed = column => changedColumns.includes(column);
    if (!changed('birth_date') && !changed('entry_date')) return;
    const birthDate = changed('birth_date') ? values.birth_date : record?.birth_date ?? null;
    const entryDate = changed('entry_date') ? values.entry_date : record?.entry_date ?? null;
    if (birthDate && entryDate) {
      if (birthDate >= entryDate) {
        throw badRequest(`Das Geburtsdatum ${germanDate(birthDate)} liegt nach dem Eintrittsdatum ${germanDate(entryDate)}. Bitte prüfe beide Daten.`);
      }
      const earliestEntry = `${Number(birthDate.slice(0, 4)) + MIN_AGE_AT_ENTRY}${birthDate.slice(4)}`;
      if (entryDate < earliestEntry) {
        throw badRequest(`Geburtsdatum und Eintrittsdatum passen nicht zusammen: Beim Eintritt wäre die Person jünger als ${MIN_AGE_AT_ENTRY} Jahre. Bitte prüfe beide Daten.`);
      }
    }
    if (!changed('entry_date') || !entryDate) return;
    for (const column of ['probation_end', 'fixed_term_end']) {
      if (record?.[column] && record[column] < entryDate) {
        throw badRequest(`Eintrittsdatum: Das Datum liegt nach dem ${FIELD_LABELS[column]} ${germanDate(record[column])}.`);
      }
    }
    const event = latestLifecycleEvent(userId);
    if (event?.kind === 'exit' && event.effective_date < entryDate) {
      throw badRequest(`Eintrittsdatum: Das Datum liegt nach dem Austritt am ${germanDate(event.effective_date)}.`);
    }
  }

  /**
   * Das allgemeine Protokoll nennt nur Feldnamen, nie Inhalte. Der Verlauf der Akte nennt zusätzlich
   * wann und von wem, und bei dienstlichen Feldern auch alt und neu. Private Inhalte stehen nur im Datenblatt.
   */
  function saveDirectFields(actor, person, values, action) {
    const columns = Object.keys(values);
    if (!columns.length) throw badRequest('Du hast nichts zum Speichern angegeben.');
    if (Object.hasOwn(values, 'personnel_number')) assertPersonnelNumberFree(values.personnel_number, person.id);
    inTransaction(() => {
      const record = readRecord(person.id);
      const changedColumns = columns.filter(column => (record?.[column] ?? null) !== values[column]);
      // Das Formular schickt immer alle Felder. Was gleich bleibt, gehört nicht in den Verlauf.
      if (!changedColumns.length) return;
      assertPlausibleDates(person.id, record, values, changedColumns);
      writeRecordColumns(person.id, Object.fromEntries(changedColumns.map(column => [column, values[column]])));
      const visibleColumns = changedColumns.filter(column => !PRIVATE_COLUMNS.includes(column));
      db.prepare(`
        INSERT INTO personnel_master_changes(user_id, fields, old_values, new_values, changed_by, changed_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(
        person.id,
        JSON.stringify(changedColumns),
        JSON.stringify(Object.fromEntries(visibleColumns.map(column => [column, record?.[column] ?? null]))),
        JSON.stringify(Object.fromEntries(visibleColumns.map(column => [column, values[column]]))),
        actor.id,
        timestamp()
      );
      log(actor.id, action, 'personnel_records', person.id, null, { fields: changedColumns });
    });
  }

  function describeMasterChange(row, units) {
    const oldValues = JSON.parse(row.old_values || '{}');
    const newValues = JSON.parse(row.new_values || '{}');
    return {
      id: row.id,
      changedAt: row.changed_at,
      changedBy: row.changed_by_name,
      bySelf: row.changed_by === row.user_id,
      fields: JSON.parse(row.fields).filter(column => Object.hasOwn(FIELD_LABELS, column)).map(column => {
        const field = { column, label: FIELD_LABELS[column] };
        if (Object.hasOwn(newValues, column)) {
          field.oldText = displayValue(column, oldValues[column], units);
          field.newText = displayValue(column, newValues[column], units);
        }
        return field;
      })
    };
  }

  function masterHistory(userId, units) {
    return db.prepare(`
      SELECT c.*, editor.name AS changed_by_name
      FROM personnel_master_changes c
      LEFT JOIN users editor ON editor.id = c.changed_by
      WHERE c.user_id = ?
      ORDER BY c.changed_at DESC, c.id DESC
    `).all(userId).map(row => describeMasterChange(row, units));
  }

  // ---------------------------------------------------------------------------
  // Änderungen mit Wirksamkeitsdatum
  // ---------------------------------------------------------------------------

  function parseChange(row) {
    return {
      ...row,
      oldValues: JSON.parse(row.old_values),
      newValues: JSON.parse(row.new_values),
      historyOnly: row.history_only ? JSON.parse(row.history_only) : {}
    };
  }

  function fieldChangesOf(userId, statuses) {
    const placeholders = statuses.map(() => '?').join(',');
    return db.prepare(`
      SELECT * FROM personnel_changes
      WHERE user_id = ? AND kind IN ('contract','organization') AND status IN (${placeholders})
      ORDER BY effective_date, id
    `).all(userId, ...statuses).map(parseChange);
  }

  /** Wert eines Felds zu einem Stichtag, abgeleitet aus dem nach Datum sortierten Verlauf. */
  function valueAsOf(record, timeline, column, date) {
    const entries = timeline.filter(entry => Object.hasOwn(entry.newValues, column));
    const latestUntilDate = entries.filter(entry => entry.effective_date <= date).at(-1);
    if (latestUntilDate) return latestUntilDate.newValues[column];
    if (entries.length) return entries[0].oldValues[column] ?? null;
    return record?.[column] ?? null;
  }

  function applyFieldChange(change, actorId) {
    const record = readRecord(change.user_id);
    const applied = fieldChangesOf(change.user_id, ['applied']);
    const newValues = { ...change.newValues };
    const oldValues = {};
    const historyOnly = {};
    const columnsToWrite = {};

    for (const [column, value] of Object.entries(newValues)) {
      const younger = applied.find(entry => entry.effective_date > change.effective_date && Object.hasOwn(entry.newValues, column));
      if (younger) {
        historyOnly[column] = { changeId: younger.id, effectiveDate: younger.effective_date };
        oldValues[column] = valueAsOf(record, applied, column, change.effective_date);
        // Die jüngere Änderung setzt jetzt auf dem rückdatierten Wert auf, damit der Verlauf lückenlos
        // bleibt. Ihr „Neu“ und das Stammdatenblatt bleiben unberührt, der alte Stand steht im Protokoll.
        const previousOldValue = younger.oldValues[column] ?? null;
        younger.oldValues[column] = value;
        db.prepare('UPDATE personnel_changes SET old_values = ? WHERE id = ?').run(JSON.stringify(younger.oldValues), younger.id);
        log(actorId, 'personnel_change_predecessor_updated', 'personnel_changes', younger.id, { [column]: previousOldValue }, { [column]: value, causedByChange: change.id });
      } else {
        oldValues[column] = record?.[column] ?? null;
        columnsToWrite[column] = value;
      }
    }

    // Eine geplante Änderung kann auf einen inzwischen unbefristeten Vertrag treffen.
    const resulting = { ...record, ...columnsToWrite };
    if (resulting.contract_type === 'permanent' && resulting.fixed_term_end) {
      oldValues.fixed_term_end = record?.fixed_term_end ?? null;
      newValues.fixed_term_end = null;
      columnsToWrite.fixed_term_end = null;
      delete historyOnly.fixed_term_end;
    }

    writeRecordColumns(change.user_id, columnsToWrite);
    db.prepare(`
      UPDATE personnel_changes
      SET status = 'applied', applied_at = ?, old_values = ?, new_values = ?, history_only = ?
      WHERE id = ?
    `).run(
      timestamp(),
      JSON.stringify(oldValues),
      JSON.stringify(newValues),
      Object.keys(historyOnly).length ? JSON.stringify(historyOnly) : null,
      change.id
    );
    log(actorId, 'personnel_change_applied', 'personnel_changes', change.id, oldValues, {
      userId: change.user_id,
      kind: change.kind,
      effectiveDate: change.effective_date,
      values: newValues,
      historyOnlyFields: Object.keys(historyOnly)
    });
    return { historyOnly };
  }

  const activePersonById = userId => db.prepare('SELECT id, name, role FROM users WHERE id = ? AND is_system_account = 0 AND active = 1').get(userId) || null;

  function wouldCreateCycle(reportId, managerId) {
    const seen = new Set();
    let cursor = managerId;
    while (cursor && !seen.has(cursor)) {
      if (cursor === reportId) return true;
      seen.add(cursor);
      cursor = db.prepare('SELECT manager_id FROM users WHERE id = ?').get(cursor)?.manager_id;
    }
    return false;
  }

  /** Prüft die neue Führungskraft nach denselben Regeln wie die Zuordnung im Grundsystem. */
  function assertValidSuccessor(actor, person, successorId, promoteManager) {
    if (successorId === person.id) throw badRequest('Neue Führungskraft: Wähle bitte eine andere Person als die, die austritt.');
    const successor = activePersonById(successorId);
    if (!successor) throw badRequest('Neue Führungskraft: Diese Person wurde nicht gefunden oder ist nicht aktiv.');
    if (!canAssignManager(actor, successor)) throw forbidden('Personen aus der HR-Sachbearbeitung tragen HR Business Partner oder HR-Administration als Führungskraft ein.');
    // Wer Leute führt, braucht die passende Rolle. Sonst fehlt zum Beispiel „Mein Team“.
    if (successor.role === 'employee') {
      if (!canAssignRole(actor, 'manager')) throw forbidden(`${successor.name} ist noch nicht als Führungskraft eingetragen. Die Rolle vergeben HR Business Partner oder HR-Administration.`);
      if (!promoteManager) throw conflict(`${successor.name} ist noch nicht als Führungskraft eingetragen.`, { code: 'manager_role_required', managerName: successor.name });
    }
    if (hrCanAccess(actor, successor)) {
      const event = latestLifecycleEvent(successor.id);
      if (event?.kind === 'exit' && event.status === 'scheduled') {
        throw conflict(`${successor.name} tritt selbst am ${germanDate(event.effective_date)} aus. Wähle bitte eine andere Person.`);
      }
    }
    return successor;
  }

  /**
   * Hängt die direkt unterstellten Personen um. changeManager lässt die anderen Module ihre offenen
   * Vorgänge mitziehen, zum Beispiel Zielfreigaben und Urlaubsanträge. Wer selbst nachrückt, kommt
   * auf den Platz der austretenden Person. Wer sich nicht umhängen lässt, bleibt in der Akte stehen.
   */
  function moveDirectReports({ person, successor, responsible, actorId }) {
    // Wer die Rolle nicht vergeben darf, macht auch beim späteren Wirksamwerden niemanden zur Führungskraft.
    if (successor.role === 'employee' && !canAssignRole(responsible, 'manager')) return { moved: [], skipped: directReportRows(person.id) };
    const moved = [];
    const skipped = [];
    const nextManagerOf = report => (report.id === successor.id ? person.manager_id ?? null : successor.id);
    const successorFirst = directReportRows(person.id).sort((first, second) => Number(second.id === successor.id) - Number(first.id === successor.id));
    for (const report of successorFirst) {
      const managerId = nextManagerOf(report);
      if (!mayReassign(responsible, report) || (managerId !== null && wouldCreateCycle(report.id, managerId))) {
        skipped.push(report);
        continue;
      }
      try {
        inTransaction(() => {
          changeManager(report.id, managerId, actorId);
          log(actorId, 'manager_assigned', 'users', report.id, { managerId: person.id }, { managerId });
        });
        moved.push(report);
      } catch (error) {
        // Der Austritt darf nicht daran scheitern. Die Person bleibt zur Neuzuordnung in der Akte stehen.
        console.error(`Personalakte: Führungskraft von Person ${report.id} ließ sich nicht ändern: ${error.message}`);
        skipped.push(report);
      }
    }
    if (moved.some(report => report.id !== successor.id) && successor.role === 'employee') {
      db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(successor.id);
      log(actorId, 'user_updated', 'users', successor.id, { role: 'employee' }, { role: 'manager' });
    }
    return { moved, skipped };
  }

  /** Was bei der Erfassung für später festgelegt wurde, gilt mit den Rechten der Person, die es festgelegt hat. */
  function moveReportsToPlannedSuccessor(change, person, actorId) {
    const successorId = change.newValues.successor_manager_id;
    if (!successorId) return;
    const successor = activePersonById(successorId);
    const responsible = change.created_by ? db.prepare('SELECT id, role FROM users WHERE id = ?').get(change.created_by) : null;
    if (!successor || !responsible) return;
    moveDirectReports({ person, successor, responsible, actorId });
  }

  /** Sperrt das Konto. Die letzte aktive HR-Administration bleibt offen, sonst käme niemand mehr an die Einstellungen. */
  function applyExit(change, actor) {
    const person = findPerson(change.user_id);
    if (!person) return false;
    if (isLastActiveHrAdmin(person)) return false;
    setUserActive(person.id, false, actor);
    const stamp = timestamp();
    db.prepare("UPDATE personnel_changes SET status = 'applied', applied_at = ? WHERE id = ?").run(stamp, change.id);
    moveReportsToPlannedSuccessor(change, person, actor?.id ?? null);
    // Der Austritt ist durch. Die Warnung „nicht ausgeführt“ ist damit hinfällig.
    db.prepare('UPDATE tasks SET done = 1 WHERE type = ? AND entity_id = ? AND done = 0 AND title LIKE ?').run(TASK_OFFBOARDING, change.id, '%nicht ausgeführt%');
    // Was nach dem Austritt geplant war, kann nicht mehr eintreten. Sichtbar in der Historie.
    db.prepare(`
      UPDATE personnel_changes
      SET status = 'cancelled', cancelled_at = ?, cancel_note = 'Durch den Austritt hinfällig.'
      WHERE user_id = ? AND status = 'scheduled' AND kind IN ('contract','organization') AND effective_date > ?
    `).run(stamp, person.id, change.effective_date);
    log(actor?.id ?? null, 'personnel_exit_applied', 'personnel_changes', change.id, null, { userId: person.id, exitDate: change.effective_date });
    voidOutdatedDeadlineNotices(person.id);
    return true;
  }

  function warnAboutBlockedExit(change) {
    const person = findPerson(change.user_id);
    const noticeId = createNoticeOnce(person.id, 'exit_blocked', change.effective_date);
    if (noticeId === null) return;
    const title = `Austritt von ${cleanText(person.name, 120)} nicht ausgeführt: Lege zuerst eine weitere HR-Administration an`;
    for (const recipient of hrRecipients(person.id)) createTask(recipient, title, TASK_OFFBOARDING, change.id, change.effective_date);
  }

  function applyDueChange(changeId) {
    const row = db.prepare("SELECT * FROM personnel_changes WHERE id = ? AND status = 'scheduled'").get(changeId);
    if (!row) return;
    const change = parseChange(row);
    inTransaction(() => {
      if (change.kind === 'exit') {
        if (!applyExit(change, null)) warnAboutBlockedExit(change);
        return;
      }
      applyFieldChange(change, null);
      voidOutdatedDeadlineNotices(change.user_id);
    });
  }

  // Fällig ist eine Änderung an ihrem Tag, ein Austritt aber erst nach dem letzten Arbeitstag.
  const DUE_CONDITION = "status = 'scheduled' AND ((kind <> 'exit' AND effective_date <= ?) OR (kind = 'exit' AND effective_date < ?))";

  /** Bringt eine Person auf den Stand von heute, bevor HR auf ihrer Akte etwas ändert. */
  function applyDueChangesFor(userId) {
    const todayDate = today();
    const due = db.prepare(`
      SELECT id FROM personnel_changes
      WHERE user_id = ? AND ${DUE_CONDITION}
      ORDER BY effective_date, id
    `).all(userId, todayDate, todayDate);
    due.forEach(row => applyDueChange(row.id));
  }

  function applyAllDueChanges() {
    const todayDate = today();
    const due = db.prepare(`
      SELECT id FROM personnel_changes
      WHERE ${DUE_CONDITION}
      ORDER BY effective_date, id
    `).all(todayDate, todayDate);
    for (const row of due) {
      try {
        applyDueChange(row.id);
      } catch (error) {
        // Ein einzelner Fehler darf fällige Austritte anderer Personen nicht aufhalten.
        console.error(`Personalakte: Änderung ${row.id} konnte nicht wirksam werden: ${error.message}`);
      }
    }
  }

  function youngerConflicts(timeline, columns, effectiveDate) {
    return timeline
      .filter(entry => entry.status === 'applied' && entry.effective_date > effectiveDate)
      .map(entry => ({
        changeId: entry.id,
        effectiveDate: entry.effective_date,
        fields: columns.filter(column => Object.hasOwn(entry.newValues, column)).map(column => FIELD_LABELS[column])
      }))
      .filter(entry => entry.fields.length);
  }

  function assertAssignableUnits(columns, values) {
    for (const column of columns) {
      const allowedTypes = UNIT_TYPES_BY_COLUMN[column];
      if (!allowedTypes || values[column] === null) continue;
      const unit = findUnit(values[column]);
      if (!unit || !allowedTypes.includes(unit.type)) {
        throw badRequest(`${FIELD_LABELS[column]}: Diese Einheit passt nicht zu diesem Feld.`);
      }
      if (!unit.active) throw badRequest(`${FIELD_LABELS[column]}: „${unit.name}“ ist deaktiviert.`);
    }
  }

  function normalizeContractValues(values, baselineOf, record) {
    const has = column => Object.hasOwn(values, column);
    const contractType = has('contract_type') ? values.contract_type : baselineOf('contract_type');
    const fixedTermEnd = has('fixed_term_end') ? values.fixed_term_end : baselineOf('fixed_term_end');
    if (contractType === 'fixed_term' && !fixedTermEnd) throw badRequest('Befristungsende: Bei einem befristeten Vertrag ist das Datum nötig.');
    if (contractType !== 'fixed_term') {
      if (has('fixed_term_end') && values.fixed_term_end) throw badRequest('Befristungsende: Das gibt es nur bei einem befristeten Vertrag.');
      if (fixedTermEnd) values.fixed_term_end = null;
    }
    for (const column of ['fixed_term_end', 'probation_end']) {
      if (has(column) && values[column] && record?.entry_date && values[column] < record.entry_date) {
        throw badRequest(`${FIELD_LABELS[column]}: Das Datum liegt vor dem Eintrittsdatum.`);
      }
    }
    return values;
  }

  function insertChange({ userId, kind, oldValues, newValues, effectiveDate, reason, actor }) {
    return db.prepare(`
      INSERT INTO personnel_changes(user_id, kind, old_values, new_values, effective_date, reason, status, created_by, created_at)
      VALUES(?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
    `).run(userId, kind, JSON.stringify(oldValues), JSON.stringify(newValues), effectiveDate, reason, actor?.id ?? null, timestamp()).lastInsertRowid;
  }

  function recordChange({ actor, person, kind, values, effectiveDate, reason, confirmBackdate }) {
    applyDueChangesFor(person.id);
    return inTransaction(() => {
      const todayDate = today();
      const isFuture = effectiveDate > todayDate;
      if (isFuture && !findPerson(person.id).active) {
        throw conflict('Diese Person ist nicht aktiv. Plane Änderungen erst nach dem Wiedereintritt.');
      }

      const record = readRecord(person.id);
      const timeline = fieldChangesOf(person.id, ['applied', 'scheduled']);
      const baselineOf = column => valueAsOf(record, timeline, column, effectiveDate);
      const proposed = kind === 'contract' ? normalizeContractValues({ ...values }, baselineOf, record) : { ...values };
      const columns = Object.keys(proposed).filter(column => proposed[column] !== baselineOf(column));
      if (!columns.length) throw badRequest('Die Werte entsprechen schon dem Stand zu diesem Datum. Es gibt nichts zu ändern.');
      assertAssignableUnits(columns, proposed);

      const conflicts = isFuture ? [] : youngerConflicts(timeline, columns, effectiveDate);
      if (conflicts.length && !confirmBackdate) {
        // Je Feld zählt die nächste jüngere Änderung: Ab dann gilt die Rückdatierung nicht mehr.
        const nextChangeByField = new Map();
        for (const entry of conflicts) {
          for (const field of entry.fields) {
            if (!nextChangeByField.has(field)) nextChangeByField.set(field, entry.effectiveDate);
          }
        }
        const summary = [...nextChangeByField].map(([field, date]) => `${field} (ab ${germanDate(date)})`).join(', ');
        throw conflict(
          `Für diese Felder gilt bereits eine jüngere Änderung: ${summary}. Wenn du bestätigst, wird die Rückdatierung nur in den Verlauf eingetragen und der aktuelle Wert bleibt erhalten.`,
          { code: 'younger_change_exists', conflicts }
        );
      }

      const oldValues = Object.fromEntries(columns.map(column => [column, baselineOf(column)]));
      const newValues = Object.fromEntries(columns.map(column => [column, proposed[column]]));
      const changeId = insertChange({ userId: person.id, kind, oldValues, newValues, effectiveDate, reason, actor });
      log(actor.id, 'personnel_change_recorded', 'personnel_changes', changeId, oldValues, { userId: person.id, kind, effectiveDate, values: newValues });

      if (isFuture) return { changeId, status: 'scheduled', historyOnly: {} };
      const change = parseChange(db.prepare('SELECT * FROM personnel_changes WHERE id = ?').get(changeId));
      const { historyOnly } = applyFieldChange(change, actor.id);
      voidOutdatedDeadlineNotices(person.id);
      return { changeId, status: 'applied', historyOnly };
    });
  }

  function historyRows(userId, statuses) {
    const placeholders = statuses.map(() => '?').join(',');
    return db.prepare(`
      SELECT c.*, creator.name AS created_by_name, canceller.name AS cancelled_by_name
      FROM personnel_changes c
      LEFT JOIN users creator ON creator.id = c.created_by
      LEFT JOIN users canceller ON canceller.id = c.cancelled_by
      WHERE c.user_id = ? AND c.status IN (${placeholders})
      ORDER BY c.effective_date DESC, c.id DESC
    `).all(userId, ...statuses).map(parseChange);
  }

  function displayValue(column, value, units) {
    if (value === null || value === undefined || value === '') return '–';
    if (DATE_COLUMNS.includes(column)) return germanDate(value);
    if (column === 'employment_type') return EMPLOYMENT_TYPES[value] ?? String(value);
    if (column === 'contract_type') return CONTRACT_TYPES[value] ?? String(value);
    if (column === 'weekly_hours') return String(value).replace('.', ',');
    if (Object.hasOwn(UNIT_TYPES_BY_COLUMN, column)) return units.get(value)?.name ?? `Einheit ${value}`;
    return String(value);
  }

  function describeChange(change, units) {
    return {
      id: change.id,
      kind: change.kind,
      kindLabel: CHANGE_KIND_LABELS[change.kind],
      status: change.status,
      statusLabel: CHANGE_STATUS_LABELS[change.status],
      effectiveDate: change.effective_date,
      fields: Object.keys(change.newValues)
        .filter(column => Object.hasOwn(FIELD_LABELS, column))
        .map(column => ({
          column,
          label: FIELD_LABELS[column],
          oldText: displayValue(column, change.oldValues[column], units),
          newText: displayValue(column, change.newValues[column], units),
          replacedOn: change.historyOnly[column]?.effectiveDate ?? null
        }))
    };
  }

  function describeChangeForHr(change, units, canCancel) {
    return {
      ...describeChange(change, units),
      reason: change.reason,
      recordedAt: change.created_at,
      recordedBy: change.created_by_name,
      cancelledAt: change.cancelled_at,
      cancelledBy: change.cancelled_by_name,
      cancelNote: change.cancel_note,
      canCancel
    };
  }

  // ---------------------------------------------------------------------------
  // Fristen
  // ---------------------------------------------------------------------------

  function isWithinDays(date, todayDate, days) {
    return Boolean(date) && date >= todayDate && date <= addDays(todayDate, days);
  }

  function upcomingDeadlines(row, todayDate) {
    if (!row.active) return [];
    const deadlines = [];
    if (row.contract_type === 'fixed_term' && isWithinDays(row.fixed_term_end, todayDate, FIXED_TERM_NOTICE_DAYS)) {
      deadlines.push({ kind: 'fixed_term', date: row.fixed_term_end });
    }
    if (isWithinDays(row.probation_end, todayDate, PROBATION_NOTICE_DAYS)) {
      deadlines.push({ kind: 'probation', date: row.probation_end });
    }
    return deadlines;
  }

  /** Legt den Merker an und liefert seine ID. Liefert null, wenn es ihn schon gibt. */
  function createNoticeOnce(userId, kind, deadlineDate) {
    const result = db.prepare(`
      INSERT INTO personnel_deadline_notices(user_id, kind, deadline_date, created_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(user_id, kind, deadline_date) WHERE voided_at IS NULL DO NOTHING
    `).run(userId, kind, deadlineDate, timestamp());
    return result.changes === 1 ? result.lastInsertRowid : null;
  }

  function createDeadlineTasks(row, deadline) {
    const recipients = hrRecipients(row.id);
    // Ohne Empfänger kein Merker, sonst ginge die Erinnerung für immer verloren.
    if (!recipients.length) return;
    inTransaction(() => {
      const noticeId = createNoticeOnce(row.id, deadline.kind, deadline.date);
      if (noticeId === null) return;
      const subject = deadline.kind === 'fixed_term' ? 'Befristung' : 'Probezeit';
      const title = `${subject} von ${cleanText(row.name, 120)} endet am ${germanDate(deadline.date)}`;
      for (const recipient of recipients) createTask(recipient, title, TASK_DEADLINE, noticeId, deadline.date);
    });
  }

  function noticeStillApplies(notice, plannedExitDate) {
    if (!notice.active) return false;
    if (plannedExitDate && plannedExitDate <= notice.deadline_date) return false;
    if (notice.kind === 'probation') return notice.probation_end === notice.deadline_date;
    return notice.contract_type === 'fixed_term' && notice.fixed_term_end === notice.deadline_date;
  }

  /** Schließt Erinnerungen, deren Anlass entfallen ist (Frist verschoben, Austritt, Entfristung). */
  function voidOutdatedDeadlineNotices(userId = null) {
    const open = db.prepare(`
      SELECT n.id, n.user_id, n.kind, n.deadline_date, u.active, r.contract_type, r.fixed_term_end, r.probation_end
      FROM personnel_deadline_notices n
      JOIN users u ON u.id = n.user_id
      LEFT JOIN personnel_records r ON r.user_id = n.user_id
      WHERE n.voided_at IS NULL AND n.kind IN ('fixed_term','probation')
    `).all();
    const events = latestLifecycleEventsByPerson();
    for (const notice of open) {
      if (userId !== null && notice.user_id !== userId) continue;
      const event = events.get(notice.user_id);
      const plannedExitDate = event?.kind === 'exit' && event.status === 'scheduled' ? event.effective_date : null;
      if (noticeStillApplies(notice, plannedExitDate)) continue;
      db.prepare('UPDATE personnel_deadline_notices SET voided_at = ? WHERE id = ?').run(timestamp(), notice.id);
      closeTasks(TASK_DEADLINE, notice.id);
    }
  }

  function closeTasks(type, entityId) {
    db.prepare('UPDATE tasks SET done = 1 WHERE type = ? AND entity_id = ? AND done = 0').run(type, entityId);
  }

  function createMissingDeadlineNotices() {
    const todayDate = today();
    const rows = peopleRows().filter(row => row.active);
    for (const row of rows) {
      for (const deadline of upcomingDeadlines(row, todayDate)) {
        const plannedExitDate = row.status === 'exit_planned' ? row.lifecycle.effective_date : null;
        if (plannedExitDate && plannedExitDate <= deadline.date) continue;
        createDeadlineTasks(row, deadline);
      }
    }
  }

  function maintenance() {
    applyAllDueChanges();
    voidOutdatedDeadlineNotices();
    createMissingDeadlineNotices();
  }

  // ---------------------------------------------------------------------------
  // HR-Übersicht
  // ---------------------------------------------------------------------------

  // Die Abfrage nennt jede Spalte einzeln, damit private Felder gar nicht erst geladen werden.
  function peopleRows() {
    const rows = db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.active, m.name AS manager_name,
             COALESCE(p.title, u.title) AS title,
             r.user_id AS record_user_id, r.personnel_number, r.employment_type, r.contract_type,
             r.entry_date, r.fixed_term_end, r.probation_end, r.weekly_hours,
             r.org_unit_id, r.location_id, r.cost_center_id
      FROM users u
      LEFT JOIN personnel_records r ON r.user_id = u.id
      LEFT JOIN position_profiles p ON p.id = u.position_profile_id
      LEFT JOIN users m ON m.id = u.manager_id
      WHERE u.is_system_account = 0
    `).all();
    const events = latestLifecycleEventsByPerson();
    return rows
      .map(row => {
        const lifecycle = events.get(row.id) || null;
        return { ...row, lifecycle, status: personStatus(row.active, lifecycle) };
      })
      .sort(compareByLastName);
  }

  function overviewRow(row, units, todayDate) {
    const hasExit = row.lifecycle?.kind === 'exit' && ['exit_planned', 'left'].includes(row.status);
    return {
      id: row.id,
      name: row.name,
      lastName: lastNameOf(row.name),
      title: row.title,
      email: row.email,
      role: row.role,
      active: Boolean(row.active),
      managerName: row.manager_name,
      status: row.status,
      statusLabel: statusLabelOf(row.status, row.entry_date),
      hasRecord: row.record_user_id !== null,
      exitDate: hasExit ? row.lifecycle.effective_date : null,
      deadlines: upcomingDeadlines(row, todayDate),
      ...businessFields(row, units)
    };
  }

  function readOverviewFilters(query) {
    const readChoice = (value, allowed, label) => {
      if (isEmptyInput(value)) return null;
      if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest(`${label}: Dieser Filter ist nicht möglich.`);
      return value;
    };
    const deadline = readChoice(query.deadline, OVERVIEW_DEADLINE_FILTERS, 'Frist');
    const status = readChoice(query.status, OVERVIEW_STATUS_FILTERS, 'Status') || (deadline === 'exits' ? 'all' : 'active');
    const datasheet = readChoice(query.datasheet, OVERVIEW_DATASHEET_FILTERS, 'Datenblatt');
    if (!isEmptyInput(query.q) && typeof query.q !== 'string') throw badRequest('Suche: Bitte gib einen Text an.');
    const searchWords = cleanText(query.q ?? '', MAX_SEARCH_LENGTH).replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    let unitIds = null;
    if (!isEmptyInput(query.orgUnitId)) {
      const unitId = parseId(query.orgUnitId);
      if (unitId === null) throw badRequest('Abteilung: Dieser Filter ist nicht möglich.');
      if (!findUnit(unitId)) throw notFound('Diese Abteilung oder Einheit wurde nicht gefunden.');
      unitIds = descendantUnitIds(unitId, allUnits());
    }
    return { status, deadline, datasheet, searchWords, unitIds };
  }

  function matchesOverviewFilters(row, filters, todayDate) {
    if (filters.unitIds && ![row.org_unit_id, row.location_id, row.cost_center_id].some(id => filters.unitIds.has(id))) return false;
    if (filters.datasheet === 'missing' && row.record_user_id !== null) return false;
    if (filters.searchWords.length && !matchesSearch([row.name, row.email, row.personnel_number], filters.searchWords)) return false;
    if (filters.status === 'active' && !row.active) return false;
    if (!['active', 'all'].includes(filters.status) && row.status !== filters.status) return false;
    if (filters.deadline === 'exits') return ['exit_planned', 'left'].includes(row.status);
    if (filters.deadline === 'fixed_term_90') return upcomingDeadlines(row, todayDate).some(item => item.kind === 'fixed_term');
    if (filters.deadline === 'probation_30') return upcomingDeadlines(row, todayDate).some(item => item.kind === 'probation');
    return true;
  }

  function overviewSummary(rows, todayDate) {
    const countDeadline = kind => rows.filter(row => upcomingDeadlines(row, todayDate).some(item => item.kind === kind)).length;
    return {
      active: rows.filter(row => row.active).length,
      withoutRecord: rows.filter(row => row.active && row.record_user_id === null).length,
      fixedTermEnding: countDeadline('fixed_term'),
      probationEnding: countDeadline('probation'),
      exitsPlanned: rows.filter(row => row.status === 'exit_planned').length,
      left: rows.filter(row => row.status === 'left').length
    };
  }

  // ---------------------------------------------------------------------------
  // Datenauskunft
  // ---------------------------------------------------------------------------

  /** Die einzige Stelle, die SQLite-Systemtabellen kennt: alle Tabellen mit ihren Spalten und Personenverweisen. */
  function describeDatabaseTables() {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map(row => row.name)
      .filter(name => !name.startsWith('sqlite_'))
      .map(name => ({
        name,
        columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all().map(column => column.name),
        userReferences: db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all()
          .filter(reference => reference.table === 'users')
          .map(reference => reference.from)
      }));
  }

  function personColumnsOf(table) {
    if (table.name === 'users') return ['id'];
    return table.columns.filter(column => EXPORT_PERSON_COLUMNS.includes(column.toLowerCase()));
  }

  function withoutBinaryValues(row) {
    return Object.fromEntries(Object.entries(row).map(([column, value]) => [
      column,
      Buffer.isBuffer(value) ? `[Binärdaten, ${value.length} Bytes]` : value
    ]));
  }

  /** HR erzeugt die Auskunft. Entwürfe der Selbsteinschätzung sind privat, bis die Person sie abgibt. */
  function withoutPrivateDrafts(tableName, row) {
    if (tableName !== 'talent_reviews' || row.self_status === 'employee_submitted') return row;
    return Object.fromEntries(Object.entries(row).filter(([column]) => !column.startsWith('self_') || column === 'self_status').filter(([column]) => column !== 'criteria_draft'));
  }

  function buildDataExport(person, actor) {
    const tables = {};
    const tablesChecked = [];
    const otherPeopleColumns = {};
    for (const table of describeDatabaseTables()) {
      if (EXPORT_EXCLUDED_TABLES.includes(table.name.toLowerCase())) continue;
      const personColumns = personColumnsOf(table);
      if (!personColumns.length) continue;
      tablesChecked.push(table.name);
      const visibleColumns = table.columns.filter(column => !EXPORT_SECRET_COLUMN.test(column));
      const selection = visibleColumns.map(quoteIdentifier).join(', ');
      const condition = personColumns.map(column => `${quoteIdentifier(column)} = ?`).join(' OR ');
      const rows = db.prepare(`SELECT ${selection} FROM ${quoteIdentifier(table.name)} WHERE ${condition}`)
        .all(...personColumns.map(() => person.id))
        // Ob jemand an einer anonymen Befragung teilgenommen hat, soll HR nicht erfahren.
        .filter(row => !(table.name === 'tasks' && String(row.type || '').startsWith('surveys_')));
      if (!rows.length) continue;
      tables[table.name] = rows.map(row => withoutBinaryValues(withoutPrivateDrafts(table.name, row)));
      const references = table.userReferences.filter(column => !personColumns.includes(column) && visibleColumns.includes(column));
      if (references.length) otherPeopleColumns[table.name] = references;
    }
    return {
      meta: {
        title: 'Datenauskunft',
        organization: tenant?.name ?? null,
        person: { id: person.id, name: person.name, email: person.email },
        exportedAt: timestamp(),
        exportedBy: { id: actor.id, name: actor.name },
        notice: EXPORT_NOTICE,
        scope: EXPORT_SCOPE,
        reviewBeforeRelease: Object.keys(tables).filter(name => EXPORT_REVIEW_TABLES.test(name)),
        tablesChecked,
        columnsReferringToOtherPeople: otherPeopleColumns
      },
      tables
    };
  }

  /** Holt Namen zu Nummern nur einmal je Tabelle. Die Tabellen- und Spaltennamen stehen fest im Code. */
  function readableLookups() {
    const existingTables = new Set(describeDatabaseTables().map(table => table.name));
    const loaded = new Map();
    const namesFrom = ([table, column]) => {
      const key = `${table}.${column}`;
      if (!loaded.has(key)) {
        loaded.set(key, existingTables.has(table)
          ? new Map(db.prepare(`SELECT id, ${column} AS label FROM ${table}`).all().map(row => [row.id, row.label]))
          : new Map());
      }
      return loaded.get(key);
    };
    return { person: id => namesFrom(['users', 'name']).get(id), reference: (source, id) => namesFrom(source).get(id) };
  }

  function readableText(value) {
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return germanDate(text);
    // SQLite schreibt die Weltzeit ohne Zeitzone in die Spalte.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) return READABLE_TIME_FORMAT.format(new Date(`${text.replace(' ', 'T')}Z`));
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return READABLE_TIME_FORMAT.format(new Date(text));
    return text;
  }

  /**
   * Änderungslisten liegen als JSON in der Spalte. Hier werden sie zu „Wochenstunden: 40; Standort: Berlin“.
   * null heißt: nichts Lesbares darin. undefined heißt: Das ist gar keine solche Liste.
   */
  function readableList(text, row, lookups) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (Array.isArray(parsed)) return parsed.map(item => READABLE_COLUMN_LABELS[item] ?? FIELD_LABELS[item] ?? String(item)).join(', ') || null;
    if (!isPlainObject(parsed)) return undefined;
    const parts = Object.entries(parsed)
      .filter(([column]) => !READABLE_HIDDEN_COLUMNS.has(column) && column !== 'successor_manager_id')
      .map(([column, value]) => `${READABLE_COLUMN_LABELS[column] ?? FIELD_LABELS[column] ?? readableFallbackLabel(column)}: ${readableValue(column, value, row, lookups) ?? '–'}`);
    return parts.join('; ') || null;
  }

  function readableValue(column, value, row, lookups) {
    if (value === null || value === undefined || value === '') return null;
    if (READABLE_PEOPLE_COLUMNS.has(column)) return lookups.person(value) ?? `Nummer ${value}`;
    if (Object.hasOwn(READABLE_REFERENCES, column)) return lookups.reference(READABLE_REFERENCES[column], value) ?? `Nummer ${value}`;
    if (column.endsWith('_cents')) return `${READABLE_MONEY_FORMAT.format(Number(value) / 100)} ${row.currency === 'EUR' || !row.currency ? '€' : row.currency}`;
    if (column === 'fte_basis_points') return `${READABLE_NUMBER_FORMAT.format(Number(value) / 100)} %`;
    if (column === 'input_percent_points') return `${READABLE_NUMBER_FORMAT.format(Number(value) / 100)} %`;
    if (READABLE_YES_NO_COLUMNS.has(column)) return value ? 'Ja' : 'Nein';
    if (['old_values', 'new_values', 'fields'].includes(column)) {
      const list = readableList(value, row, lookups);
      return list === undefined ? readableText(value) : list;
    }
    const byColumn = READABLE_VALUES_BY_COLUMN[column];
    if (byColumn && Object.hasOwn(byColumn, value)) return byColumn[value];
    if (typeof value === 'number') return READABLE_NUMBER_FORMAT.format(value);
    return readableText(value);
  }

  // Ein neues Feld, für das es noch keinen Namen gibt, soll trotzdem nicht fehlen.
  function readableFallbackLabel(name) {
    const words = String(name).replaceAll('_', ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function readableEntry(table, row, lookups) {
    return Object.entries(row)
      // Die Art einer Aufgabe ist ein technischer Schlüssel, der Titel sagt schon alles.
      .filter(([column]) => !READABLE_HIDDEN_COLUMNS.has(column) && !(table === 'tasks' && column === 'type'))
      .map(([column, value]) => ({
        label: READABLE_COLUMN_LABELS[column] ?? FIELD_LABELS[column] ?? readableFallbackLabel(column),
        value: readableValue(column, value, row, lookups)
      }))
      .filter(field => field.value !== null);
  }

  function buildReadableExport(report) {
    const lookups = readableLookups();
    const knownOrder = Object.keys(READABLE_TABLE_TITLES);
    const position = table => (knownOrder.includes(table) ? knownOrder.indexOf(table) : knownOrder.length);
    const sections = Object.entries(report.tables)
      .sort(([first], [second]) => position(first) - position(second) || first.localeCompare(second))
      .map(([table, rows]) => ({
        table,
        title: READABLE_TABLE_TITLES[table] ?? readableFallbackLabel(table),
        reviewBeforeRelease: report.meta.reviewBeforeRelease.includes(table),
        entries: rows.map(row => readableEntry(table, row, lookups)).filter(fields => fields.length)
      }));
    const { title, organization, person, exportedAt, exportedBy, notice } = report.meta;
    return { meta: { title, organization, person, exportedAt, exportedAtText: readableText(exportedAt), exportedBy, notice, scope: READABLE_SCOPE }, sections };
  }

  // ---------------------------------------------------------------------------
  // Beispieldaten
  // ---------------------------------------------------------------------------

  function seedDemo() {
    const people = db.prepare('SELECT id, role FROM users WHERE is_system_account = 0 AND active = 1 ORDER BY id').all();
    if (!people.length) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM personnel_org_units').get().count) return;
    const todayDate = today();
    const stamp = timestamp();
    const hrPerson = people.find(person => person.role === 'hr_admin') || people.find(person => person.role === 'hrbp') || null;
    const leadPerson = people.find(person => person.role === 'director') || people.find(person => person.role === 'manager') || null;
    const insertUnit = db.prepare(`
      INSERT INTO personnel_org_units(type, name, code, parent_id, leader_user_id, created_by, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    const addUnit = (type, name, code, parentId = null, leaderId = null) => insertUnit.run(type, name, code, parentId, leaderId, hrPerson?.id ?? null, stamp).lastInsertRowid;
    const insertRecord = db.prepare(`
      INSERT INTO personnel_records(
        user_id, personnel_number, birth_date, private_address, private_phone, emergency_contact,
        employment_type, contract_type, entry_date, fixed_term_end, probation_end, weekly_hours,
        org_unit_id, location_id, cost_center_id, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `);

    inTransaction(() => {
      const company = addUnit('legal_entity', 'Daybreak Beispiel GmbH', 'BSP');
      const productDepartment = addUnit('department', 'Produkt', 'PROD', company, leadPerson?.id ?? null);
      const peopleDepartment = addUnit('department', 'Personal', 'PERS', company, hrPerson?.id ?? null);
      const berlin = addUnit('location', 'Berlin', 'BER', company);
      const hamburg = addUnit('location', 'Hamburg', 'HAM', company);
      const productCosts = addUnit('cost_center', '4100 Produktentwicklung', '4100', company);
      const adminCosts = addUnit('cost_center', '1000 Verwaltung', '1000', company);

      const employees = people.filter(person => person.role === 'employee');
      const fixedTermPerson = employees[0]?.id ?? null;
      const probationPerson = employees[1]?.id ?? null;
      const changingPerson = employees[2]?.id ?? null;
      const workingStudent = employees.length > 3 ? employees.at(-1).id : null;
      // Hat gerade angefangen und läuft im Modul Ein- und Austritte als Einstieg.
      const newcomer = employees[3]?.id ?? null;

      people.forEach((person, index) => {
        const isHrPerson = HR_ROLE_NAMES.includes(person.role);
        const isFixedTerm = person.id === fixedTermPerson;
        const isWorkingStudent = person.id === workingStudent;
        insertRecord.run(
          person.id,
          `B-${1000 + person.id}`,
          `19${80 + (index % 18)}-0${1 + (index % 9)}-1${index % 9}`,
          `Musterstraße ${10 + index}, 10115 Berlin`,
          `030 23125 ${String(100 + index).padStart(3, '0')}`,
          `Alex Beispiel, 030 23125 ${String(500 + index).padStart(3, '0')}`,
          isWorkingStudent ? 'working_student' : 'employee',
          isFixedTerm ? 'fixed_term' : 'permanent',
          person.id === newcomer ? addDays(todayDate, -3) : person.id === probationPerson ? addDays(todayDate, -160) : `20${16 + (index % 9)}-0${1 + (index % 9)}-01`,
          isFixedTerm ? addDays(todayDate, 60) : null,
          person.id === probationPerson ? addDays(todayDate, 20) : null,
          isWorkingStudent ? 20 : 40,
          isHrPerson ? peopleDepartment : productDepartment,
          index % 2 === 0 ? berlin : hamburg,
          isHrPerson ? adminCosts : productCosts,
          stamp,
          stamp
        );
      });

      if (changingPerson !== null) {
        const appliedId = insertChange({
          userId: changingPerson,
          kind: 'contract',
          oldValues: { weekly_hours: 40 },
          newValues: { weekly_hours: 32 },
          effectiveDate: addDays(todayDate, -90),
          reason: 'Teilzeit auf eigenen Wunsch',
          actor: hrPerson
        });
        db.prepare("UPDATE personnel_changes SET status = 'applied', applied_at = ? WHERE id = ?").run(stamp, appliedId);
        db.prepare('UPDATE personnel_records SET weekly_hours = 32 WHERE user_id = ?').run(changingPerson);
        insertChange({
          userId: changingPerson,
          kind: 'organization',
          oldValues: { location_id: berlin },
          newValues: { location_id: hamburg },
          effectiveDate: addDays(todayDate, 30),
          reason: 'Das Team zieht nach Hamburg um',
          actor: hrPerson
        });
        db.prepare('UPDATE personnel_records SET location_id = ? WHERE user_id = ?').run(berlin, changingPerson);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Schnittstellen
  // ---------------------------------------------------------------------------

  router.use('/personnel', auth, (req, res, next) => {
    // Personaldaten gehören nicht in den Browser-Zwischenspeicher gemeinsam genutzter Rechner.
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Selbstauskunft
  router.get('/personnel/me', (req, res) => {
    const actor = current(req);
    const person = findPerson(actor.id);
    if (!person) throw notFound(NO_OWN_RECORD_MESSAGE);
    res.json({ sheet: buildSheet(actor, person) });
  });

  router.patch('/personnel/me/contact', (req, res) => {
    const actor = current(req);
    const person = findPerson(actor.id);
    if (!person) throw notFound(NO_OWN_RECORD_MESSAGE);
    const values = readFields(bodyOf(req), CONTACT_FIELDS, () => forbidden('Du darfst nur deine Anschrift, deine Telefonnummer und deinen Notfallkontakt ändern.'));
    saveDirectFields(actor, person, values, 'personnel_contact_updated');
    res.json({ sheet: buildSheet(actor, person) });
  });

  // Führungskräfte: nur dienstliche Angaben der eigenen Führungslinie
  router.get('/personnel/team', (req, res) => {
    const actor = current(req);
    const teamIds = new Set(subordinateIds(actor));
    const units = unitsById();
    const team = peopleRows()
      .filter(row => teamIds.has(row.id) && row.active && canViewEmployee(actor, row.id))
      .map(row => ({
        id: row.id,
        name: row.name,
        title: row.title,
        ...businessFields(row, units)
      }));
    res.json({ team });
  });

  // HR-Übersicht
  router.get('/personnel/people', requireHrOperator, (req, res) => {
    const actor = current(req);
    const filters = readOverviewFilters(req.query);
    const todayDate = today();
    // Auch Zahlen zählen nur, wen die Person sehen darf. Sonst ließe sich aus ihnen auf andere schließen.
    const rows = peopleRows().filter(row => hrCanAccess(actor, row));
    const units = unitsById();
    res.json({
      today: todayDate,
      summary: overviewSummary(rows, todayDate),
      people: rows.filter(row => matchesOverviewFilters(row, filters, todayDate)).map(row => overviewRow(row, units, todayDate))
    });
  });

  // Nur Namen zur Auswahl, zum Beispiel für die neue Führungskraft. Daten zur Person stehen hier nicht.
  router.get('/personnel/form-options', requireHrOperator, (req, res) => {
    const asOptions = labels => Object.entries(labels).map(([value, label]) => ({ value, label }));
    res.json({
      today: today(),
      employmentTypes: asOptions(EMPLOYMENT_TYPES),
      contractTypes: asOptions(CONTRACT_TYPES),
      unitTypes: asOptions(UNIT_TYPES),
      units: serializeUnits(),
      people: db.prepare('SELECT id, name FROM users WHERE is_system_account = 0 AND active = 1').all().sort(compareByLastName)
    });
  });

  // Abteilungen, Standorte, Kostenstellen und Gesellschaften
  router.get('/personnel/org-units', requireHrOperator, (req, res) => {
    res.json({ units: serializeUnits() });
  });

  router.post('/personnel/org-units', requireUnitAdmin, (req, res) => {
    const actor = current(req);
    const body = bodyOf(req);
    const type = readOptionalChoice(body.type, UNIT_TYPES, 'Typ');
    if (!type) throw badRequest('Bitte wähle einen Typ.');
    const name = readOptionalText(body.name, 'Name', 120);
    if (!name) throw badRequest('Bitte gib einen Namen an.');
    const code = readOptionalText(body.code, 'Code', 40);
    const parentId = readOptionalId(body.parentId, 'Übergeordnete Einheit');
    const leaderUserId = readOptionalId(body.leaderUserId, 'Leitung');
    assertValidParent(type, parentId);
    assertValidLeader(leaderUserId);
    assertCodeFree(type, code);
    const id = inTransaction(() => {
      const unitId = db.prepare(`
        INSERT INTO personnel_org_units(type, name, code, parent_id, leader_user_id, created_by, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(type, name, code, parentId, leaderUserId, actor.id, timestamp()).lastInsertRowid;
      log(actor.id, 'personnel_org_unit_created', 'personnel_org_units', unitId, null, { type, name, code, parentId, leaderUserId });
      return unitId;
    });
    res.status(201).json({ id });
  });

  function loadUnit(req) {
    const unit = findUnit(parseId(req.params.unitId));
    if (!unit) throw notFound('Diese Abteilung oder Einheit wurde nicht gefunden.');
    return unit;
  }

  function assertUnitMayDeactivate(unit) {
    const activeChild = db.prepare('SELECT name FROM personnel_org_units WHERE parent_id = ? AND active = 1 ORDER BY name').get(unit.id);
    if (activeChild) throw conflict(`Unter dieser Einheit hängt noch die aktive Einheit „${activeChild.name}“. Verschiebe oder deaktiviere sie zuerst.`);
    if (organizationChanges(['scheduled']).some(change => Object.keys(UNIT_TYPES_BY_COLUMN).some(column => change.newValues[column] === unit.id))) {
      throw conflict('Es sind noch Änderungen geplant, die auf diese Einheit verweisen. Nimm sie zuerst zurück.');
    }
  }

  router.patch('/personnel/org-units/:unitId', requireUnitAdmin, (req, res) => {
    const actor = current(req);
    const unit = loadUnit(req);
    const body = bodyOf(req);
    if (body.type !== undefined && body.type !== unit.type) {
      throw badRequest('Der Typ einer Einheit lässt sich nicht ändern. Lege dafür eine neue Einheit an.');
    }
    const next = {
      name: unit.name,
      code: unit.code,
      parent_id: unit.parent_id,
      leader_user_id: unit.leader_user_id,
      active: unit.active
    };
    if (body.name !== undefined) {
      next.name = readOptionalText(body.name, 'Name', 120);
      if (!next.name) throw badRequest('Bitte gib einen Namen an.');
    }
    if (body.code !== undefined) {
      next.code = readOptionalText(body.code, 'Code', 40);
      assertCodeFree(unit.type, next.code, unit.id);
    }
    if (body.parentId !== undefined) {
      next.parent_id = readOptionalId(body.parentId, 'Übergeordnete Einheit');
      if (next.parent_id !== unit.parent_id) assertValidParent(unit.type, next.parent_id, unit.id);
    }
    if (body.leaderUserId !== undefined) {
      next.leader_user_id = readOptionalId(body.leaderUserId, 'Leitung');
      if (next.leader_user_id !== unit.leader_user_id) assertValidLeader(next.leader_user_id);
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw badRequest('Bitte gib an, ob die Einheit aktiv sein soll.');
      next.active = body.active ? 1 : 0;
    }
    if (unit.active && !next.active) assertUnitMayDeactivate(unit);
    if (!unit.active && next.active && next.parent_id && !findUnit(next.parent_id)?.active) {
      throw conflict('Die übergeordnete Einheit ist deaktiviert. Aktiviere zuerst sie.');
    }
    inTransaction(() => {
      db.prepare(`
        UPDATE personnel_org_units
        SET name = ?, code = ?, parent_id = ?, leader_user_id = ?, active = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(next.name, next.code, next.parent_id, next.leader_user_id, next.active, actor.id, timestamp(), unit.id);
      log(actor.id, 'personnel_org_unit_updated', 'personnel_org_units', unit.id, {
        name: unit.name, code: unit.code, parentId: unit.parent_id, leaderUserId: unit.leader_user_id, active: unit.active
      }, {
        name: next.name, code: next.code, parentId: next.parent_id, leaderUserId: next.leader_user_id, active: next.active
      });
    });
    res.json({ ok: true });
  });

  router.delete('/personnel/org-units/:unitId', requireUnitAdmin, (req, res) => {
    const actor = current(req);
    const unit = loadUnit(req);
    if (countAssignedPeople(unit.id)) throw conflict('Dieser Einheit sind Personen zugeordnet. Du kannst sie nur deaktivieren.');
    if (db.prepare('SELECT id FROM personnel_org_units WHERE parent_id = ? LIMIT 1').get(unit.id)) {
      throw conflict('Unter dieser Einheit hängen weitere Einheiten. Verschiebe sie zuerst oder deaktiviere die Einheit.');
    }
    if (organizationChanges(['scheduled', 'applied', 'cancelled']).some(change => changeReferencesUnit(change, unit.id))) {
      throw conflict('Diese Einheit kommt im Verlauf von Personen vor und bleibt deshalb erhalten. Du kannst sie deaktivieren.');
    }
    inTransaction(() => {
      db.prepare('DELETE FROM personnel_org_units WHERE id = ?').run(unit.id);
      log(actor.id, 'personnel_org_unit_deleted', 'personnel_org_units', unit.id, { type: unit.type, name: unit.name, code: unit.code }, null);
    });
    res.json({ ok: true });
  });

  // Aufgaben auf der Übersicht
  function loadPersonnelTask(req) {
    const taskId = parseId(req.params.taskId);
    const task = taskId === null ? null : db.prepare('SELECT id, user_id, type, entity_id FROM tasks WHERE id = ?').get(taskId);
    if (!task || !PERSONNEL_TASK_TYPES.includes(task.type)) throw notFound('Aufgabe nicht gefunden.');
    return task;
  }

  function subjectOfTask(task) {
    const source = task.type === TASK_OFFBOARDING ? 'personnel_changes' : 'personnel_deadline_notices';
    return db.prepare(`SELECT user_id FROM ${source} WHERE id = ?`).get(task.entity_id)?.user_id ?? null;
  }

  router.get('/personnel/tasks/:taskId', requireHrOperator, (req, res) => {
    const task = loadPersonnelTask(req);
    const subjectId = subjectOfTask(task);
    if (subjectId === null) throw notFound('Aufgabe nicht gefunden.');
    if (!hrCanAccess(current(req), subjectId)) throw forbidden(NO_ACCESS_MESSAGE);
    res.json({ userId: subjectId });
  });

  router.post('/personnel/tasks/:taskId/done', requireHrOperator, (req, res) => {
    const actor = current(req);
    const task = loadPersonnelTask(req);
    const subjectId = subjectOfTask(task);
    const mayCloseForAll = subjectId !== null && hrCanAccess(actor, subjectId);
    if (!mayCloseForAll && task.user_id !== actor.id) throw forbidden(NO_ACCESS_MESSAGE);
    inTransaction(() => {
      // Alle HR-Personen bekommen dieselbe Aufgabe. Wer sie erledigt, erledigt sie für alle.
      // Eine ältere Aufgabe zu einer Person ohne Zugriff darf ihr Empfänger nur bei sich schließen.
      if (mayCloseForAll) closeTasks(task.type, task.entity_id);
      else db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
      log(actor.id, 'personnel_task_done', 'tasks', task.id, null, { type: task.type, entityId: task.entity_id });
    });
    res.json({ ok: true });
  });

  // Das Datenblatt einer Person. Steht hinter den festen Pfaden, weil :userId sonst alles fängt.
  router.get('/personnel/:userId', (req, res) => {
    const actor = current(req);
    const userId = parseId(req.params.userId);
    if (userId === null) throw notFound(PERSON_NOT_FOUND);
    if (!hasHrAccess(actor, userId) && !canViewEmployee(actor, userId)) throw forbidden(NO_ACCESS_MESSAGE);
    const person = findPerson(userId);
    if (!person) throw notFound(PERSON_NOT_FOUND);
    if (!person.active && !hasHrAccess(actor, person) && actor.id !== person.id) throw forbidden(NO_ACCESS_MESSAGE);
    res.json({ sheet: buildSheet(actor, person) });
  });

  router.patch('/personnel/:userId/master', (req, res) => {
    const { actor, person } = hrEditTarget(req);
    const values = readFields(bodyOf(req), MASTER_FIELDS, name => badRequest(`Das Feld „${name}“ lässt sich hier nicht ändern. Vertrag und Organisation änderst du über „Vertrag ändern“ oder „Organisation ändern“.`));
    saveDirectFields(actor, person, values, 'personnel_master_updated');
    res.json({ sheet: buildSheet(actor, person) });
  });

  router.post('/personnel/:userId/changes', (req, res) => {
    const { actor, person } = hrEditTarget(req);
    const body = bodyOf(req);
    if (typeof body.kind !== 'string' || !Object.hasOwn(CHANGE_FIELDS, body.kind)) {
      throw badRequest('Bitte wähle aus, ob du Vertrag oder Organisation änderst.');
    }
    const effectiveDate = readDate(body.effectiveDate, 'Gültig ab');
    const reason = readReason(body.reason);
    if (!isPlainObject(body.values)) throw badRequest('Bitte gib die neuen Werte an.');
    const values = readFields(body.values, CHANGE_FIELDS[body.kind], name => badRequest(`Das Feld „${name}“ gehört nicht zu dieser Änderung.`));
    if (!Object.keys(values).length) throw badRequest('Bitte gib die neuen Werte an.');

    const outcome = recordChange({
      actor,
      person,
      kind: body.kind,
      values,
      effectiveDate,
      reason,
      confirmBackdate: body.confirmBackdate === true
    });
    const historyOnlyFields = Object.keys(outcome.historyOnly).map(column => FIELD_LABELS[column]);
    let message = `Die Änderung wird am ${germanDate(effectiveDate)} wirksam.`;
    if (outcome.status === 'applied') {
      message = historyOnlyFields.length
        ? `In den Verlauf eingetragen. Für ${historyOnlyFields.join(', ')} bleibt der Wert der jüngeren Änderung gültig.`
        : 'Die Änderung ist wirksam.';
    }
    const change = historyRows(person.id, ['scheduled', 'applied']).find(row => row.id === outcome.changeId);
    res.status(201).json({
      status: outcome.status,
      message,
      historyOnlyFields,
      change: describeChangeForHr(change, unitsById(), outcome.status === 'scheduled')
    });
  });

  router.get('/personnel/:userId/history', (req, res) => {
    const actor = current(req);
    const userId = parseId(req.params.userId);
    if (!isHrOperator(actor) && actor.id !== userId) throw forbidden(NO_ACCESS_MESSAGE);
    const person = findPerson(userId);
    if (!person) throw notFound(PERSON_NOT_FOUND);
    const hrAccess = hasHrAccess(actor, person);
    if (!hrAccess && actor.id !== userId) throw forbidden(NO_ACCESS_MESSAGE);
    const units = unitsById();
    const masterChanges = masterHistory(person.id, units);
    if (!hrAccess) {
      // Gründe und Namen aus HR bleiben bei Vertragsänderungen intern. Die Person sieht, was sich wann
      // geändert hat. Bei ihren eigenen Stammdaten sieht sie auch, wer sie geändert hat.
      res.json({ changes: historyRows(person.id, ['applied']).map(change => describeChange(change, units)), masterChanges });
      return;
    }
    const permissions = permissionsFor(actor, person, personStatus(person.active, latestLifecycleEvent(person.id)));
    const canCancel = change => change.status === 'scheduled' && (change.kind === 'exit' ? permissions.cancelExit : permissions.recordChange);
    res.json({
      changes: historyRows(person.id, ['scheduled', 'applied', 'cancelled']).map(change => describeChangeForHr(change, units, canCancel(change))),
      masterChanges
    });
  });

  router.post('/personnel/:userId/changes/:changeId/cancel', (req, res) => {
    const { actor, person } = hrEditTarget(req);
    const changeId = parseId(req.params.changeId);
    const findChange = () => changeId === null ? null : db.prepare('SELECT * FROM personnel_changes WHERE id = ? AND user_id = ?').get(changeId, person.id);
    const existing = findChange();
    if (!existing) throw notFound('Änderung nicht gefunden.');
    if (existing.kind === 'exit') assertMayManageAccount(actor, person);

    // Was fällig ist, gilt schon und lässt sich nicht mehr zurücknehmen. Ein Austritt mit dem
    // heutigen Datum gehört nicht dazu: Sein letzter Arbeitstag läuft noch.
    applyDueChangesFor(person.id);
    inTransaction(() => {
      const change = findChange();
      if (change.status !== 'scheduled') {
        const hint = change.kind === 'exit' ? 'Erfasse stattdessen einen Wiedereintritt.' : 'Erfasse stattdessen eine neue Änderung.';
        throw conflict(`Diese Änderung ist nicht mehr geplant und lässt sich nicht zurücknehmen. ${hint}`);
      }
      db.prepare(`
        UPDATE personnel_changes
        SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?
        WHERE id = ?
      `).run(actor.id, timestamp(), change.id);
      if (change.kind === 'exit') closeTasks(TASK_OFFBOARDING, change.id);
      log(actor.id, 'personnel_change_cancelled', 'personnel_changes', change.id, null, { userId: person.id, kind: change.kind, effectiveDate: change.effective_date });
    });
    res.json({ ok: true });
  });

  // Austritt und Wiedereintritt
  router.post('/personnel/:userId/exit', (req, res) => {
    const { actor, person } = accountTarget(req);
    if (isProtectedAccount(person.email)) throw conflict('In der öffentlichen Demo ist das für dieses Konto nicht möglich, damit alle weiter testen können.');
    const body = bodyOf(req);
    const exitDate = readDate(body.exitDate, 'Austrittsdatum');
    const reason = readReason(body.reason);
    const lockNow = body.lockNow === true;
    const successorId = readOptionalId(body.successorManagerId, 'Neue Führungskraft');

    applyDueChangesFor(person.id);
    const status = inTransaction(() => {
      const fresh = findPerson(person.id);
      const event = latestLifecycleEvent(person.id);
      const statusBefore = personStatus(fresh.active, event);
      if (statusBefore === 'exit_planned') throw conflict('Für diese Person ist schon ein Austritt geplant. Nimm ihn zuerst zurück.');
      if (statusBefore === 'left') throw conflict('Diese Person ist bereits ausgetreten.');
      const record = readRecord(person.id);
      if (record?.entry_date && exitDate < record.entry_date) throw badRequest('Austrittsdatum: Das Datum liegt vor dem Eintrittsdatum.');
      if (event?.kind === 'rehire' && exitDate < event.effective_date) throw badRequest('Austrittsdatum: Das Datum liegt vor dem Wiedereintritt.');
      const todayDate = today();
      if (lockNow && exitDate > todayDate) {
        throw badRequest('Sofort sperren geht nur bei einem Austritt heute. Soll die Person schon vorher keinen Zugang mehr haben, sperre ihr Konto zusätzlich unter „Mitarbeitende“.');
      }
      const takesEffectNow = exitDate < todayDate || lockNow;
      if (takesEffectNow && !canManageAccount(actor, fresh)) {
        throw forbidden('Sofort wirksam machen diesen Austritt nur HR Business Partner oder HR-Administration. Du kannst den Austritt mit einem Datum ab heute erfassen.');
      }
      if (takesEffectNow && isLastActiveHrAdmin(fresh)) {
        throw conflict('Das ist die letzte aktive HR-Administration. Lege zuerst eine weitere an, sonst käme niemand mehr an die Einstellungen.');
      }
      if (successorId !== null) assertValidSuccessor(actor, person, successorId, body.promoteManager === true);

      const changeId = insertChange({
        userId: person.id,
        kind: 'exit',
        oldValues: { active: fresh.active },
        newValues: { active: 0, ...(successorId === null ? {} : { successor_manager_id: successorId }) },
        effectiveDate: exitDate,
        reason,
        actor
      });
      log(actor.id, 'personnel_exit_recorded', 'personnel_changes', changeId, null, { userId: person.id, exitDate });
      const title = `Austritt von ${cleanText(person.name, 120)} am ${germanDate(exitDate)}: Übergabe und Zuordnungen prüfen`;
      for (const recipient of hrRecipients(person.id)) createTask(recipient, title, TASK_OFFBOARDING, changeId, exitDate);

      if (takesEffectNow) {
        const change = parseChange(db.prepare('SELECT * FROM personnel_changes WHERE id = ?').get(changeId));
        if (!applyExit(change, actor)) throw new Error('Austritt konnte nicht wirksam werden.');
        return 'left';
      }
      voidOutdatedDeadlineNotices(person.id);
      return 'exit_planned';
    });

    const directReports = directReportsOf(person.id);
    const ledUnits = unitsLedBy(person.id);
    res.status(201).json({
      status,
      message: status === 'left'
        ? 'Der Austritt ist erfasst und das Konto gesperrt.'
        : `Der Austritt ist erfasst. Letzter Arbeitstag ist der ${germanDate(exitDate)}, am ${germanDate(addDays(exitDate, 1))} wird das Konto gesperrt.`,
      directReports,
      ledUnits
    });
  });

  // Alle direkt unterstellten Personen auf einmal umhängen, zum Beispiel nach einem Austritt.
  router.post('/personnel/:userId/reassign-reports', (req, res) => {
    const { actor, person } = hrEditTarget(req);
    const body = bodyOf(req);
    const successorId = readOptionalId(body.managerId, 'Neue Führungskraft');
    if (successorId === null) throw badRequest('Bitte wähle eine neue Führungskraft aus.');
    const { moved, skipped } = inTransaction(() => {
      const successor = assertValidSuccessor(actor, person, successorId, body.promoteManager === true);
      return moveDirectReports({ person, successor, responsible: actor, actorId: actor.id });
    });
    const describe = ({ id, name, title }) => ({ id, name, title });
    res.json({ moved: moved.map(describe), skipped: skipped.map(describe) });
  });

  router.post('/personnel/:userId/rehire', (req, res) => {
    const { actor, person } = accountTarget(req);
    if (!canManageAccount(actor, person)) throw forbidden('Den Wiedereintritt erfassen hier HR Business Partner oder HR-Administration, weil er das Konto wieder freigibt.');
    const body = bodyOf(req);
    const rehireDate = readDate(body.rehireDate, 'Wiedereintrittsdatum');
    const reason = readReason(body.reason);

    inTransaction(() => {
      const event = latestLifecycleEvent(person.id);
      if (personStatus(person.active, event) !== 'left') throw conflict('Diese Person ist nicht ausgetreten. Ein Wiedereintritt ist deshalb nicht möglich.');
      if (rehireDate > today()) throw badRequest('Wiedereintrittsdatum: Der Wiedereintritt wirkt sofort. Erfasse ihn am ersten Arbeitstag oder danach.');
      if (rehireDate < event.effective_date) throw badRequest('Wiedereintrittsdatum: Das Datum liegt vor dem Austritt.');

      // Das Eintrittsdatum bleibt der erste Tag im Unternehmen. Ob frühere Zeiten zum Beispiel für die
      // Betriebszugehörigkeit zählen, hängt vom Einzelfall ab. Deshalb stehen beide Tage in der Akte.
      const changeId = insertChange({
        userId: person.id,
        kind: 'rehire',
        oldValues: { active: 0 },
        newValues: { active: 1 },
        effectiveDate: rehireDate,
        reason,
        actor
      });
      db.prepare("UPDATE personnel_changes SET status = 'applied', applied_at = ? WHERE id = ?").run(timestamp(), changeId);
      setUserActive(person.id, true, actor);
      closeTasks(TASK_OFFBOARDING, event.id);
      log(actor.id, 'personnel_rehired', 'personnel_changes', changeId, null, { userId: person.id, rehireDate });
    });
    res.status(201).json({
      status: 'active',
      message: 'Der Wiedereintritt ist erfasst und das Konto wieder aktiv. Das Eintrittsdatum bleibt unverändert. Prüfe bitte Vertrag, Organisation und Führungskraft.'
    });
  });

  // Datenauskunft
  function dataExportFor(req, format) {
    const actor = current(req);
    if (!canAdministerHrAdmins(actor)) throw forbidden('Die Datenauskunft darf nur die HR-Administration erstellen.');
    const person = findPerson(parseId(req.params.userId));
    if (!person) throw notFound(PERSON_NOT_FOUND);
    const report = buildDataExport(person, actor);
    const rowCounts = Object.fromEntries(Object.entries(report.tables).map(([name, rows]) => [name, rows.length]));
    log(actor.id, 'personnel_data_exported', 'users', person.id, null, { format, tables: rowCounts });
    return { person, report };
  }

  router.get('/personnel/:userId/data-export', (req, res) => {
    const { person, report } = dataExportFor(req, 'file');
    res.set('Content-Disposition', `attachment; filename="datenauskunft-${person.id}-${today()}.json"`);
    res.json(report);
  });

  router.get('/personnel/:userId/data-export/readable', (req, res) => {
    const { report } = dataExportFor(req, 'readable');
    res.json(buildReadableExport(report));
  });

  // Nur eigene, erwartete Fehler werden hier beantwortet. Alles andere geht an die Fehlerbehandlung der Anwendung.
  router.use((error, req, res, next) => {
    if (!(error instanceof RequestError)) return next(error);
    res.status(error.status).json({ error: error.message, ...error.details });
  });

  /** Für die Einstellung im Recruiting: Das Eintrittsdatum steht danach in der Akte. */
  function recordEntryDate({ userId, entryDate, actor }) {
    const person = findPerson(userId);
    if (!person) return false;
    saveDirectFields(actor, person, { entry_date: entryDate }, 'personnel_master_updated');
    return true;
  }

  return { router, initialize, seedDemo, maintenance, recordEntryDate, helpArticles: HELP_ARTICLES };
}

module.exports = { createPersonnelModule };
