'use strict';

/**
 * Genehmigungsregeln, die jede Organisation selbst festlegt. Wer was freigibt, ist von
 * Firma zu Firma verschieden. Die Module fragen nur die Regel ab; dieser Katalog beschreibt,
 * welche Regeln es gibt, welche Möglichkeiten sie haben und was ohne Entscheidung gilt.
 *
 * `goLive`: Die Voreinstellung passt für die Demo, muss aber vor dem Echtbetrieb bewusst
 * neu entschieden werden. Die Oberfläche und docs/GO-LIVE-MERKLISTE.md weisen darauf hin.
 */

const APPROVAL_RULES = Object.freeze([
  {
    key: 'goals.approval',
    module: 'goals',
    title: 'Ziele',
    question: 'Müssen neue Ziele abgestimmt werden?',
    defaultValue: 'manager',
    options: [
      { value: 'manager', label: 'Ja, zwischen Person und direkter Führungskraft' },
      { value: 'none', label: 'Nein, Ziele gelten sofort' }
    ]
  },
  {
    key: 'absence.approval',
    module: 'absence',
    title: 'Abwesenheit',
    question: 'Wer genehmigt Urlaub und andere genehmigungspflichtige Abwesenheiten?',
    defaultValue: 'manager',
    options: [
      { value: 'manager', label: 'Direkte Führungskraft oder HR' },
      { value: 'hr', label: 'Nur HR' },
      { value: 'none', label: 'Niemand, Anträge gelten sofort' }
    ]
  },
  {
    key: 'time.approval',
    module: 'time',
    title: 'Zeiterfassung',
    question: 'Wer gibt eingereichte Arbeitswochen frei?',
    defaultValue: 'manager',
    options: [
      { value: 'manager', label: 'Direkte Führungskraft oder HR' },
      { value: 'hr', label: 'Nur HR' },
      { value: 'none', label: 'Niemand, eingereichte Wochen gelten sofort' }
    ]
  },
  {
    key: 'recruiting.requisition',
    module: 'recruiting',
    title: 'Stellenanforderungen',
    question: 'Müssen neue Stellen freigegeben werden?',
    defaultValue: 'hr',
    options: [
      { value: 'hr', label: 'Ja, durch HR' },
      { value: 'none', label: 'Nein, eingereichte Stellen sind sofort offen' }
    ]
  },
  {
    key: 'recruiting.offer',
    module: 'recruiting',
    title: 'Angebote',
    question: 'Wie werden Angebote an Bewerbende freigegeben?',
    defaultValue: 'four_eyes',
    options: [
      { value: 'four_eyes', label: 'Vier Augen: HR, aber nie die Person, die es erstellt oder geändert hat' },
      { value: 'hr', label: 'HR, auch das eigene Angebot' },
      { value: 'none', label: 'Ohne Freigabe' }
    ]
  },
  {
    key: 'compensation.self_approval',
    module: 'compensation',
    title: 'Gehaltsvorschläge',
    question: 'Darf eine HR-Administration Gehaltsvorschläge genehmigen, die sie selbst abgegeben hat?',
    defaultValue: 'allowed',
    goLive: true,
    options: [
      { value: 'allowed', label: 'Ja' },
      { value: 'denied', label: 'Nein, das muss eine andere HR-Administration tun' }
    ]
  },
  {
    key: 'personnel.hr_self_edit',
    module: 'personnel',
    title: 'Eigene Personalakte',
    question: 'Darf HR die eigenen Stamm- und Vertragsdaten selbst ändern?',
    defaultValue: 'denied',
    options: [
      { value: 'denied', label: 'Nein, das muss eine andere HR-Person tun' },
      { value: 'allowed', label: 'Ja, zum Beispiel wenn es nur eine HR-Person gibt' }
    ]
  }
]);

const RULES_BY_KEY = new Map(APPROVAL_RULES.map(rule => [rule.key, rule]));

function getApprovalRule(key) {
  return RULES_BY_KEY.get(key) || null;
}

module.exports = { APPROVAL_RULES, getApprovalRule };
