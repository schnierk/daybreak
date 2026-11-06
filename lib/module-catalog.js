'use strict';

/**
 * Der Modulkatalog ist die einzige Stelle, an der festgelegt ist, welche
 * Fachmodule es gibt, wovon sie abhängen und welche API-Pfade zu ihnen gehören.
 *
 * - `alwaysOn`  : Grundfunktion, kann nicht abgeschaltet werden.
 * - `dependsOn` : Module, die eingeschaltet sein müssen, damit dieses funktioniert.
 * - `api`       : API-Pfade relativ zu /api. Ein Text passt auf den Pfad selbst und
 *                 alles darunter, ein regulärer Ausdruck wird direkt geprüft.
 * - `taskTypes` : Aufgabentypen des Moduls; sie verschwinden vom Dashboard, wenn das
 *                 Modul abgeschaltet ist.
 * - `planned`   : Noch nicht gebaut. Wird angezeigt, lässt sich aber nicht einschalten.
 *
 * Neue Module folgen einer festen Dateikonvention (siehe docs/MODUL-VERTRAG.md):
 * routes/<key>.js exportiert create<Key>Module, public/<key>.js ist die Oberfläche.
 * Solange routes/<key>.js fehlt, gilt das Modul automatisch als "geplant".
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const conventionModule = definition => ({
  ...definition,
  conventional: true,
  api: [`/${definition.key}`],
  taskTypes: [new RegExp(`^${definition.key}_`)]
});

const MODULES = Object.freeze([
  {
    key: 'core',
    name: 'Personen & Organisation',
    area: 'Personal',
    description: 'Konten, Rollen, Führungslinien, Organigramm und Positionen. Grundlage aller anderen Module.',
    alwaysOn: true,
    dependsOn: [],
    api: [],
    taskTypes: []
  },
  conventionModule({
    key: 'personnel',
    name: 'Personalakte',
    area: 'Personal',
    description: 'Persönliche Daten, Vertrag, Abteilung, Austritt und Datenauskunft.',
    dependsOn: []
  }),
  {
    key: 'goals',
    name: 'Ziele',
    area: 'Talent & Leistung',
    description: 'Ziele mit Gewichtung, Fortschritt und Genehmigungsablauf.',
    dependsOn: [],
    api: ['/goals'],
    taskTypes: [/^goal_/]
  },
  {
    key: 'checkins',
    name: 'Check-ins',
    area: 'Talent & Leistung',
    description: 'Regelmäßige dokumentierte Gespräche zwischen Führungskraft und Mitarbeitenden.',
    dependsOn: [],
    api: ['/checkins'],
    taskTypes: [/^checkin/]
  },
  {
    key: 'talent',
    name: 'Talentprofil & Kompetenzen',
    area: 'Talent & Leistung',
    description: 'Karriereinteressen, Qualifikationen, Kompetenzkatalog, Positionsanforderungen und Kompetenzlücken-Analyse.',
    dependsOn: ['goals'],
    api: ['/talent', '/competencies', /^\/positions\/requirements(\/|$)/, /^\/positions\/[^/]+\/requirements(\/|$)/],
    taskTypes: []
  },
  {
    key: 'talent_review',
    name: 'Talent Review & 9-Box',
    area: 'Talent & Leistung',
    description: 'Regelmäßige Einschätzung von Leistung und Potenzial, Kalibrierung, 9-Box, Talentpools und Entwicklungsmaßnahmen.',
    dependsOn: ['talent', 'goals'],
    api: ['/talent-review', '/talent-pools', '/development-decisions'],
    taskTypes: [/^talent_review_/, /^talent_pool_/, /^development_decision$/]
  },
  {
    key: 'feedback',
    name: '360° Feedback',
    area: 'Talent & Leistung',
    description: 'Fragebögen, Vorschläge für Feedbackgebende, anonyme Auswertung und Ergebnisgespräche.',
    dependsOn: ['goals'],
    api: ['/feedback'],
    taskTypes: [/^feedback_/]
  },
  conventionModule({
    key: 'succession',
    name: 'Nachfolgeplanung',
    area: 'Talent & Leistung',
    description: 'Schlüsselpositionen, Nachfolgekandidaten mit Bereitschaftsgrad und Risikoeinschätzung.',
    dependsOn: ['talent']
  }),
  conventionModule({
    key: 'learning',
    name: 'Lernen & Pflichtschulungen',
    area: 'Talent & Leistung',
    description: 'Kurskatalog, Zuweisungen, Pflichtschulungen mit Fristen und Nachweisen.',
    dependsOn: []
  }),
  conventionModule({
    key: 'recruiting',
    name: 'Recruiting',
    area: 'Gewinnung',
    description: 'Stellenanforderungen, Bewerbungen, Auswahlprozess, Angebot und Einstellung.',
    dependsOn: []
  }),
  conventionModule({
    key: 'onboarding',
    name: 'Onboarding & Offboarding',
    area: 'Gewinnung',
    description: 'Checklisten-Vorlagen und begleitete Abläufe für neue und austretende Mitarbeitende.',
    dependsOn: []
  }),
  conventionModule({
    key: 'absence',
    name: 'Abwesenheit',
    area: 'Arbeitszeit',
    description: 'Urlaubskonten, Anträge mit Genehmigung, Krankmeldungen und Teamkalender.',
    dependsOn: []
  }),
  conventionModule({
    key: 'time',
    name: 'Zeiterfassung',
    area: 'Arbeitszeit',
    description: 'Arbeitszeiten erfassen, Wochen freigeben, Überstunden-Salden und Hinweise zu Ruhezeiten.',
    dependsOn: []
  }),
  conventionModule({
    key: 'compensation',
    name: 'Vergütung',
    area: 'Vergütung',
    description: 'Gehaltsbänder, Vergütungshistorie und Gehaltsrunden mit Budget und Freigabe.',
    dependsOn: []
  }),
  conventionModule({
    key: 'surveys',
    name: 'Mitarbeiterbefragungen',
    area: 'Mitarbeitererlebnis',
    description: 'Kurze anonyme Befragungen mit Mindestzahl an Antworten und Auswertung nach Bereichen.',
    dependsOn: []
  }),
  {
    key: 'reports',
    name: 'Auswertungen',
    area: 'Auswertung & Assistenz',
    description: 'Überblick über Zielerreichung, Leistung und Gespräche für HR und Bereichsleitung.',
    dependsOn: [],
    api: ['/reports'],
    taskTypes: []
  },
  {
    key: 'assistant',
    name: 'Dayo-Assistent',
    area: 'Auswertung & Assistenz',
    description: 'Kontextsensitive Hilfe und geprüfte, nur lesende Datenfragen.',
    dependsOn: [],
    api: ['/assistant'],
    taskTypes: []
  },
  // Geplant: sichtbar als Fahrplan, ohne Schalter. Siehe docs/ROADMAP.md.
  { key: 'payroll_export', name: 'Lohn-Schnittstelle (z. B. DATEV)', area: 'Vergütung', description: 'Übergabe von Stamm-, Zeit- und Abwesenheitsdaten an ein vorhandenes Lohnprogramm. Eine eigene Lohnabrechnung ist bewusst nicht vorgesehen.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'benefits', name: 'Zusatzleistungen', area: 'Vergütung', description: 'Betriebliche Altersvorsorge, Jobrad, Zuschüsse und deren Verwaltung.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'scheduling', name: 'Schichtplanung', area: 'Arbeitszeit', description: 'Dienstpläne erstellen, Schichten tauschen, Besetzung prüfen.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'helpdesk', name: 'HR-Service & Tickets', area: 'Mitarbeitererlebnis', description: 'Anfragen an HR als Vorgang mit Status, Zuständigkeit und Wissensbasis.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'documents', name: 'Dokumente & E-Signatur', area: 'Personal', description: 'Personalakte mit Dateien, Vorlagen und elektronischer Unterschrift.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'marketplace', name: 'Interner Talentmarkt', area: 'Talent & Leistung', description: 'Interne Projekte und Einsätze, passend zu Kompetenzen und Karriereinteressen.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'contingent', name: 'Fremdpersonal', area: 'Gewinnung', description: 'Zeitarbeit, Freelancer und Dienstleister verwalten.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'workforce_planning', name: 'Personalplanung', area: 'Auswertung & Assistenz', description: 'Stellenpläne, Szenarien für Organisationsänderungen und Budgets.', planned: true, dependsOn: [], api: [], taskTypes: [] },
  { key: 'integrations', name: 'Schnittstellen & Anmeldung (API, SSO, SCIM)', area: 'Plattform', description: 'Dokumentierte Programmierschnittstelle, Firmen-Login (SSO) und automatischer Benutzerabgleich.', planned: true, dependsOn: [], api: [], taskTypes: [] }
]);

const BY_KEY = new Map(MODULES.map(module => [module.key, module]));

function moduleFiles(module, projectRoot = PROJECT_ROOT) {
  if (!module.conventional) return null;
  const factoryName = `create${module.key.charAt(0).toUpperCase()}${module.key.slice(1)}Module`;
  return {
    routeFile: path.join(projectRoot, 'routes', `${module.key}.js`),
    publicScript: `/${module.key}.js`,
    publicStyle: `/${module.key}.css`,
    publicScriptFile: path.join(projectRoot, 'public', `${module.key}.js`),
    publicStyleFile: path.join(projectRoot, 'public', `${module.key}.css`),
    factoryName
  };
}

/** Ein Modul ist verfügbar, wenn es fertig gebaut ist. Geplante Module haben keinen Schalter. */
function isAvailable(module, projectRoot = PROJECT_ROOT) {
  if (!module || module.planned) return false;
  if (!module.conventional) return true;
  return fs.existsSync(moduleFiles(module, projectRoot).routeFile);
}

function getModule(key) {
  return BY_KEY.get(key) || null;
}

function availableModules(projectRoot = PROJECT_ROOT) {
  return MODULES.filter(module => isAvailable(module, projectRoot));
}

function matchesRule(rule, pathname) {
  if (rule instanceof RegExp) return rule.test(pathname);
  return pathname === rule || pathname.startsWith(`${rule}/`);
}

function normalizePath(pathname) {
  let value = String(pathname || '');
  try {
    value = decodeURIComponent(value);
  } catch {
    // Ungültige Kodierung bleibt unverändert; solche Pfade passen ohnehin auf keine Route.
  }
  return value.toLowerCase().replace(/\/{2,}/g, '/');
}

/**
 * Findet zu einem API-Pfad (relativ zu /api) das zuständige Modul. Der Router unterscheidet
 * Groß- und Kleinschreibung nicht, deshalb darf es auch diese Prüfung nicht tun.
 */
function moduleForPath(pathname) {
  const normalized = normalizePath(pathname);
  for (const module of MODULES) {
    if ((module.api || []).some(rule => matchesRule(rule, normalized))) return module.key;
  }
  return null;
}

function moduleForTaskType(type) {
  const value = String(type || '');
  for (const module of MODULES) {
    if ((module.taskTypes || []).some(rule => rule.test(value))) return module.key;
  }
  return null;
}

/** Ergänzt eine Modulauswahl um alle Module, von denen sie abhängt. */
function withDependencies(keys) {
  const result = new Set();
  const visit = key => {
    const module = getModule(key);
    if (!module || result.has(key)) return;
    result.add(key);
    (module.dependsOn || []).forEach(visit);
  };
  keys.forEach(visit);
  return result;
}

function dependentsOf(key) {
  return MODULES.filter(module => (module.dependsOn || []).includes(key)).map(module => module.key);
}

module.exports = {
  MODULES,
  availableModules,
  dependentsOf,
  getModule,
  isAvailable,
  moduleFiles,
  moduleForPath,
  moduleForTaskType,
  withDependencies
};
