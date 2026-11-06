(() => {
  const loop = window.loop;
  const { ui } = loop;
  const { esc, toast } = ui;
  const api = (url, options) => loop.api(url, options);
  const isHrRole = () => ['hr_admin', 'hrbp', 'super_admin'].includes(loop.me.role);

  const emptyMatrixFilters = () => ({ sessionId: null, organizationManagerId: null, managerId: null, positionId: null, status: null, poolId: null, box: null });
  const state = {
    userId: null,
    reviewId: null,
    selfReviewId: null,
    sessionId: null,
    poolId: null,
    periodId: null,
    statusFilter: null,
    matrixPeriodId: null,
    matrixFilters: emptyMatrixFilters(),
    hasUnsavedChanges: false
  };

  /** In der Demo wechseln Rollen oft im selben Fenster. Auswahl und Filter der vorigen Person gelten dann nicht mehr. */
  function forgetOtherUser() {
    if (state.userId === loop.me?.id) return;
    Object.assign(state, { userId: loop.me?.id ?? null, reviewId: null, selfReviewId: null, sessionId: null, poolId: null, periodId: null, statusFilter: null, matrixPeriodId: null, matrixFilters: emptyMatrixFilters(), hasUnsavedChanges: false });
  }

  const REVIEW_LABELS = { not_started: 'Nicht begonnen', manager_draft: 'Entwurf', manager_submitted: 'Eingereicht', in_calibration: 'In Kalibrierung', calibrated: 'Kalibriert', finalized: 'Final abgeschlossen' };
  const SELF_LABELS = { not_started: 'Nicht begonnen', employee_draft: 'In Arbeit', employee_submitted: 'Abgegeben' };
  const PERIOD_LABELS = { draft: 'Entwurf', open: 'Offen', calibration: 'In Kalibrierung', completed: 'Abgeschlossen', archived: 'Archiviert' };
  const SESSION_LABELS = { planned: 'Geplant', active: 'Läuft', completed: 'Abgeschlossen', cancelled: 'Abgesagt' };
  const CASE_LABELS = { pending: 'Noch offen', discussed: 'Besprochen', completed: 'Erledigt' };
  const MEMBERSHIP_LABELS = { proposed: 'Vorgeschlagen', active: 'Aufgenommen', paused: 'Pausiert', completed: 'Beendet', removed: 'Entfernt' };
  const DECISION_LABELS = { planned: 'Geplant', in_progress: 'In Umsetzung', completed: 'Abgeschlossen', cancelled: 'Abgebrochen' };
  const FINISHED_STATES = new Set(['calibrated', 'finalized', 'completed', 'employee_submitted', 'active', 'discussed']);

  const MANAGER_SCALES = {
    performance: ['Braucht Unterstützung', 'Solide Leistung', 'Starke Leistung'],
    potential: ['Gezielt entwickeln', 'Kann wachsen', 'Bereit für die nächste Herausforderung']
  };
  const SELF_SCALES = {
    performance: ['Ich brauche mehr Unterstützung', 'Ich liefere solide Ergebnisse', 'Ich liefere starke Ergebnisse'],
    potential: ['Ich möchte mich gezielt entwickeln', 'Ich sehe Raum zum Wachsen', 'Ich bin bereit für eine nächste Herausforderung']
  };

  // ---------------------------------------------------------------------------
  // Kleine Bausteine
  // ---------------------------------------------------------------------------

  const date = value => (value ? esc(ui.date(value)) : '–');
  const tag = (labels, value) => `<span class="tag ${FINISHED_STATES.has(value) ? '' : 'focus'}">${esc(labels[value] || value || '–')}</span>`;
  const reviewTag = status => tag(REVIEW_LABELS, status);
  const scoreText = (performance, potential) => `Leistung ${performance} · Potenzial ${potential}`;
  const button = (label, action, id = '', primary = false) => `<button type="button" class="btn ${primary ? 'primary' : ''}" data-tr-action="${action}" ${id !== '' ? `data-id="${esc(id)}"` : ''}>${esc(label)}</button>`;
  const backButton = (label, action) => `<button type="button" class="btn tr-back" data-tr-action="${action}">← ${esc(label)}</button>`;
  const option = (items, selected, mapper = item => [item.id, item.name]) => items.map(item => {
    const [value, label] = mapper(item);
    return `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const activePeriod = periods => periods.find(period => ['open', 'calibration'].includes(period.status)) || periods[0];
  const periods = async () => (await api('/api/talent-review/periods')).items;
  const meta = () => api('/api/talent-review/meta');
  const leaders = users => {
    const managerIds = new Set(users.map(person => person.manager_id));
    return users.filter(person => managerIds.has(person.id));
  };
  const nameList = (items, limit = 8) => {
    const names = items.slice(0, limit).map(item => item.employee_name || item.name).join(', ');
    return items.length > limit ? `${names} und ${items.length - limit} weitere` : names;
  };

  function layoutTitle(title, subtitle, actions = '') {
    return `<header class="top"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="tr-actions">${actions}</div></header>`;
  }

  const countRow = (count, one, many) => `<div class="tr-keyvalue"><b>${esc(count)}</b><span>${esc(count === 1 ? one : many)}</span></div>`;

  function stat(label, value, sub = '') {
    return `<article class="card stat"><small>${esc(label)}</small><strong>${esc(value)}</strong><span class="up">${esc(sub)}</span></article>`;
  }

  let fieldCount = 0;
  function field(label, control, hint = '') {
    fieldCount += 1;
    const id = `trField${fieldCount}`;
    return `<label for="${id}">${esc(label)}</label>${control(id)}${hint ? `<small class="tr-hint">${esc(hint)}</small>` : ''}`;
  }
  const inputField = (label, name, { value = '', type = 'text', required = false, hint = '', attributes = '' } = {}) => field(label, id => `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}"${required ? ' required' : ''} ${attributes}>`, hint);
  const textField = (label, name, { value = '', required = false, hint = '', attributes = '', placeholder = '', max = 4000 } = {}) => field(label, id => `<textarea id="${id}" name="${name}" maxlength="${max}" placeholder="${esc(placeholder)}"${required ? ' required' : ''} ${attributes}>${esc(value)}</textarea>`, hint);
  const selectField = (label, name, options, { hint = '', attributes = '' } = {}) => field(label, id => `<select id="${id}" name="${name}" ${attributes}>${options}</select>`, hint);

  const counterText = (length, minimum) => (length >= minimum ? `${length} Zeichen, Mindestlänge erreicht` : `${length} von mindestens ${minimum} Zeichen zum Einreichen`);

  /** Pflichttext eines Entwurfs: Speichern geht immer, die Mindestlänge gilt erst beim Einreichen und steht deshalb sichtbar daneben. */
  function requiredTextField(label, name, value, minimum, placeholder = '') {
    const content = value || '';
    return `${textField(label, name, { value: content, placeholder, max: name === 'observations' ? 4000 : 3000, attributes: `data-min-length="${minimum}"` })}<small class="tr-hint" data-tr-counter>${esc(counterText(content.trim().length, minimum))}</small>`;
  }

  const scoreOptions = (labels, selected) => `<option value="">Bitte wählen</option>${labels.map((label, index) => {
    const value = index + 1;
    return `<option value="${value}" ${selected === value ? 'selected' : ''}>${value} · ${esc(label)}</option>`;
  }).join('')}`;

  function openDialog({ title, subtitle = '', body, submitLabel = 'Speichern', onSubmit }) {
    ui.modal({ title, subtitle, body, submitLabel, onSubmit });
    const submit = document.querySelector('#uiModalForm button.primary');
    if (submit) {
      submit.insertAdjacentHTML('afterend', '<button type="button" class="btn full tr-dialog-cancel">Abbrechen</button>');
      document.querySelector('#uiModalForm .tr-dialog-cancel').addEventListener('click', ui.closeModal);
    }
  }

  const confirmDialog = ({ title, message, confirmLabel, onConfirm }) => openDialog({ title, body: `<div class="tr-confirm">${message}</div>`, submitLabel: confirmLabel, onSubmit: onConfirm });

  /**
   * Meldet, was eine Sammelaktion geschafft hat. Klappte alles, genügt ein Hinweis. Sonst nennt ein Dialog jede Person mit Grund.
   * Er öffnet sich erst im nächsten Schritt, weil der auslösende Dialog sich gerade noch schließt.
   */
  function reportBulkResult({ done, failed, one, many }) {
    const doneText = ui.plural(done.length, one, many);
    if (!failed.length) {
      toast(`${doneText}.`);
      return;
    }
    toast(`${doneText}, ${failed.length} nicht.`, 'error');
    window.setTimeout(() => {
      ui.modal({
        title: 'Nicht alles hat geklappt',
        subtitle: doneText,
        body: `${done.length ? `<p><b>Geklappt:</b> ${esc(nameList(done, 30))}.</p>` : ''}
          <p><b>Nicht geklappt:</b></p>
          <ul>${failed.map(item => `<li><b>${esc(item.employee_name || `Nummer ${item.reviewId}`)}:</b> ${esc(item.reason)}</li>`).join('')}</ul>
          <button type="button" class="btn full tr-dialog-cancel">Schließen</button>`
      });
      document.querySelector('#uiModalForm .tr-dialog-cancel').addEventListener('click', ui.closeModal);
    }, 0);
  }

  function supportCard(support) {
    const goals = support.goals || {};
    const checkins = support.checkins || {};
    const fit = support.skillGap?.fit;
    const outOfFive = value => (value === null || value === undefined ? '–' : `${esc(ui.number(value, Number.isInteger(value) ? 0 : 1))} von 5`);
    return `<article class="card">
      <h2>Zahlen zur Orientierung</h2>
      <div class="tr-support">
        <span>Zielerreichung</span><b>${goals.weightedProgress === null || goals.weightedProgress === undefined ? '–' : `${esc(goals.weightedProgress)} %`}</b>
        <span>Letzter Check-in</span><b>${outOfFive(checkins.latestPerformance)}</b>
        <span>Check-ins im Schnitt</span><b>${outOfFive(checkins.averagePerformance)}</b>
        <span>Passung zur Position</span><b>${fit === null || fit === undefined ? '–' : `${esc(fit)} %`}</b>
      </div>
      <p class="muted">${support.periodFinished
    ? 'Ziele mit Zieltermin in dieser Periode und Check-ins aus dieser Zeit. Der Fortschritt der Ziele und die Passung zur Position sind der Stand von heute.'
    : 'Stand von heute. Die Zahlen helfen beim Begründen, die Entscheidung trifft ein Mensch.'}</p>
    </article>`;
  }

  // ---------------------------------------------------------------------------
  // Übersicht
  // ---------------------------------------------------------------------------

  const EXPLAINER = 'Im Talent Review schätzt die Führungskraft einmal je Periode Leistung und Potenzial jeder Person ein. In der Kalibrierung vergleichen Führungskräfte ihre Einschätzungen, damit überall derselbe Maßstab gilt. Die 9-Box zeigt das Ergebnis in neun Feldern.';

  function miniMatrix(counts) {
    const cells = [3, 2, 1].flatMap(potential => [1, 2, 3].map(performance => `<div class="tr-mini-cell"><small>Potenzial ${potential}<br>Leistung ${performance}</small><b>${esc(counts[`${potential}-${performance}`] || 0)}</b></div>`));
    return `<div class="tr-mini-matrix">${cells.join('')}</div>`;
  }

  function reviewRows(rows) {
    if (!rows.length) return '<p class="muted">Hier gibt es gerade keine Einschätzungen.</p>';
    return `<div class="talent-list">${rows.map(item => {
      const person = [item.employee_title, item.manager_name ? `Führungskraft: ${item.manager_name}` : ''].filter(Boolean).join(' · ');
      const result = item.boxKey ? `<span class="tr-box">${esc(scoreText(item.performance, item.potential))}</span>` : '';
      return `<div class="talent-item" data-review-row data-name="${esc(`${item.employee_name} ${item.employee_title || ''}`)}" data-manager="${esc(item.manager_name || '')}">
        <div>
          <b>${esc(item.employee_name)}</b>
          <small>${esc(person)}</small>
          <div class="tr-tags">
            <span class="tr-state">Einschätzung: ${reviewTag(item.status)}</span>
            <span class="tr-state">Selbsteinschätzung: ${tag(SELF_LABELS, item.self_status || 'not_started')}</span>
            ${item.period_name ? `<span class="tr-state muted">${esc(item.period_name)}</span>` : ''}
          </div>
          ${item.return_reason ? `<p class="tr-note">Von HR zurückgegeben: ${esc(item.return_reason)}</p>` : ''}
        </div>
        <div class="tr-item-actions">${result} ${button(item.canEdit ? 'Schreiben' : 'Öffnen', 'review-open', item.id, item.canEdit)}</div>
      </div>`;
    }).join('')}</div>`;
  }

  function teamOverview(data, currentPeriod) {
    return `<article class="card wide"><div class="sectionHead"><h2>Dein direktes Team</h2>${currentPeriod ? `<span class="tag">${esc(currentPeriod.name)}</span>` : ''}</div>${reviewRows(data.items || [])}</article>`;
  }

  async function hrDashboard(currentPeriod) {
    const query = currentPeriod ? `?periodId=${currentPeriod.id}` : '';
    const [data, team] = await Promise.all([api(`/api/talent-review/dashboard/hr${query}`), api(`/api/talent-review/dashboard/manager${query}`)]);
    const metrics = data.metrics;
    const placed = Object.values(data.boxes || {}).reduce((sum, count) => sum + count, 0);
    const notSubmitted = (metrics.notStarted || 0) + (metrics.drafts || 0);
    const missing = data.missingPeople ? `<div class="tr-callout">
        <p><b>${esc(ui.plural(data.missingPeople, 'Person fehlt', 'Personen fehlen'))} in dieser Periode.</b> Wer nach dem Öffnen dazugekommen ist, wird nicht von selbst aufgenommen.</p>
        ${button('Personen aufnehmen', 'period-people', currentPeriod.id, true)}
      </div>` : '';
    return `${layoutTitle('Talent Review', 'Steuere die Periode, erkenne, was offen ist, und begleite die Entwicklung.', `${button('+ Periode', 'period-create', '', true)} ${button('9-Box öffnen', 'matrix')}`)}
      <section class="cards">
        ${stat('In dieser Periode', metrics.included || 0, ui.plural(metrics.included || 0, 'Person', 'Personen'))}
        ${stat('Noch nicht eingereicht', notSubmitted, `${metrics.notStarted || 0} nicht begonnen, ${ui.plural(metrics.drafts || 0, 'Entwurf', 'Entwürfe')}`)}
        ${stat('Bereit oder in Kalibrierung', (metrics.submitted || 0) + (metrics.inCalibration || 0), `${metrics.calibrated || 0} kalibriert, ${metrics.finalized || 0} abgeschlossen`)}
      </section>
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead"><div><small class="muted">${esc(data.period?.name || 'Keine offene Periode')}</small><h2>9-Box-Verteilung</h2></div>${button('9-Box öffnen', 'matrix')}</div>
          ${miniMatrix(data.boxes || {})}
          <p class="muted">${esc(ui.plural(placed, 'Person', 'Personen'))} eingeordnet. Die 9-Box ergibt sich aus Leistung und Potenzial.</p>
        </article>
        <article class="card">
          <h2>Das steht an</h2>
          ${missing}
          ${countRow(metrics.selfSubmitted || 0, 'Selbsteinschätzung abgegeben', 'Selbsteinschätzungen abgegeben')}
          ${countRow(data.sessions || 0, 'geplante oder laufende Sitzung', 'geplante oder laufende Sitzungen')}
          ${countRow(data.pools || 0, 'aktiver Talentpool', 'aktive Talentpools')}
          ${countRow(data.decisions || 0, 'offene Entwicklungsmaßnahme', 'offene Entwicklungsmaßnahmen')}
        </article>
      </section>
      ${team.items?.length ? `<section class="cards">${teamOverview(team, currentPeriod)}<article class="card"><h2>Du bist hier auch Führungskraft</h2><p class="muted">Für dein direktes Team schreibst du die Einschätzungen selbst. Es gilt dasselbe wie für alle anderen Führungskräfte.</p></article></section>` : ''}
      <section class="cards tr-quick">
        <article class="card"><h2>Einschätzungen</h2><p class="muted">Sehen, was fehlt, zurückgeben und final abschließen.</p>${button('Einschätzungen öffnen', 'reviews', '', true)}</article>
        <article class="card"><h2>Kalibrierung</h2><p class="muted">Sitzungen, Teilnehmende und Fälle verwalten.</p>${button('Sitzungen öffnen', 'sessions')}</article>
        <article class="card"><h2>Talentpools</h2><p class="muted">Vorschläge nachvollziehbar entscheiden.</p>${button('Talentpools öffnen', 'pools')}</article>
      </section>
      <section class="cards"><article class="card wide"><h2>So funktioniert es</h2><p class="muted">${esc(EXPLAINER)}</p></article></section>`;
  }

  async function managerDashboard(currentPeriod) {
    const data = await api(`/api/talent-review/dashboard/manager${currentPeriod ? `?periodId=${currentPeriod.id}` : ''}`);
    const { metrics } = data;
    return `${layoutTitle('Talent Review für dein Team', 'Schreibe deine Einschätzungen und reiche sie für die Kalibrierung ein.', `${button('Alle Einschätzungen', 'reviews', '', true)} ${button('Meine Ergebnisse', 'my-results')}`)}
      <section class="cards">
        ${stat('Noch offen', metrics.notStarted || 0, 'nicht begonnen')}
        ${stat('Entwürfe', metrics.drafts || 0, 'noch nicht eingereicht')}
        ${stat('Eingereicht', metrics.submitted || 0, 'warten auf die Kalibrierung')}
      </section>
      <section class="cards">
        ${teamOverview(data, currentPeriod)}
        <article class="card">
          <h2>Entwicklung im Blick</h2>
          ${countRow(metrics.decisions || 0, 'offene Maßnahme', 'offene Maßnahmen')}
          ${countRow(metrics.poolProposals || 0, 'Vorschlag für Talentpools', 'Vorschläge für Talentpools')}
          <p class="muted">Was Führungskräfte unter dir schreiben, siehst du erst, wenn sie es eingereicht haben. Vorher siehst du nur den Stand.</p>
        </article>
      </section>
      <section class="cards"><article class="card wide"><h2>So funktioniert es</h2><p class="muted">${esc(EXPLAINER)}</p></article></section>`;
  }

  async function dashboard() {
    const [rights, list] = await Promise.all([meta(), periods()]);
    if (!rights.canReview && !rights.canManagePeriods) return myResults();
    const currentPeriod = activePeriod(list);
    if (!state.periodId) state.periodId = currentPeriod?.id || null;
    return rights.canManagePeriods ? hrDashboard(currentPeriod) : managerDashboard(currentPeriod);
  }

  // ---------------------------------------------------------------------------
  // Perioden
  // ---------------------------------------------------------------------------

  function periodRow(period) {
    const actions = [];
    if (period.status === 'draft') actions.push(button('Bearbeiten', 'period-edit', period.id));
    if (period.nextStatuses?.length) actions.push(button('Stand ändern', 'period-status', period.id));
    if (period.missingPeopleCount) actions.push(button(`Personen aufnehmen (${period.missingPeopleCount})`, 'period-people', period.id));
    if (period.readyToFinalizeCount) actions.push(button(`Kalibrierte abschließen (${period.readyToFinalizeCount})`, 'period-finalize-all', period.id, true));
    if (period.status === 'completed') actions.push(button(period.employee_results_visible ? 'Freigabe zurücknehmen' : 'Ergebnisse freigeben', 'period-release', period.id, !period.employee_results_visible));
    actions.push(button('Einschätzungen', 'reviews-period', period.id));
    const finished = ['completed', 'archived'].includes(period.status);
    const release = finished ? `<span class="tr-state muted">${period.employee_results_visible ? 'Ergebnisse für Beschäftigte freigegeben' : 'Ergebnisse noch nicht freigegeben'}</span>` : '';
    return `<div class="talent-item">
      <div>
        <b>${esc(period.name)}</b>
        <small>${esc(period.description || '')}</small>
        <small>${date(period.start_date)} bis ${date(period.end_date)} · Stichtag ${date(period.assessment_date)}</small>
        <div class="tr-tags">${tag(PERIOD_LABELS, period.status)} ${release}</div>
      </div>
      <div class="tr-item-actions">${actions.join(' ')}</div>
    </div>`;
  }

  async function periodPage() {
    const list = await periods();
    return `${layoutTitle('Perioden', 'HR plant eine Periode, öffnet sie, kalibriert, schließt ab und archiviert.', isHrRole() ? button('+ Neue Periode', 'period-create', '', true) : '')}
      <section class="cards">
        <article class="card wide">${list.length ? `<div class="talent-list">${list.map(periodRow).join('')}</div>` : '<p class="muted">Noch keine Perioden angelegt.</p>'}</article>
        <article class="card">
          <h2>Die Stände einer Periode</h2>
          <p><b>Entwurf:</b> Zeitraum vorbereiten.</p>
          <p><b>Offen:</b> Führungskräfte und Beschäftigte schreiben.</p>
          <p><b>In Kalibrierung:</b> Sitzungen vergleichen die eingereichten Einschätzungen. Von hier führt ein Weg zurück auf „Offen“.</p>
          <p><b>Abgeschlossen:</b> Alle sind final abgeschlossen, Ergebnisse lassen sich freigeben.</p>
          <p><b>Archiviert:</b> Endgültig beendet. Alle offenen Aufgaben schließen sich.</p>
        </article>
      </section>`;
  }

  function periodForm(existing = null) {
    const value = name => existing?.[name] || '';
    openDialog({
      title: existing ? 'Periode bearbeiten' : 'Neue Periode',
      subtitle: 'Pflichtfelder sind mit * markiert.',
      body: `${inputField('Name *', 'name', { value: value('name'), required: true })}
        ${textField('Beschreibung', 'description', { value: value('description') })}
        <div class="two">
          <div>${inputField('Beginn *', 'startDate', { type: 'date', value: value('start_date'), required: true })}</div>
          <div>${inputField('Ende *', 'endDate', { type: 'date', value: value('end_date'), required: true })}</div>
        </div>
        ${inputField('Stichtag für die Einschätzungen *', 'assessmentDate', { type: 'date', value: value('assessment_date'), required: true, hint: 'Bis dahin sollen die Einschätzungen fertig sein. Dieses Datum steht auch als Frist in den Aufgaben.' })}`,
      onSubmit: async data => {
        await api(existing ? `/api/talent-review/periods/${existing.id}` : '/api/talent-review/periods', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify(data) });
        toast(existing ? 'Periode gespeichert.' : 'Periode als Entwurf angelegt.');
        loop.navigate('reviewPeriods');
      }
    });
  }

  function statusConsequences(next, period, open) {
    if (next === 'open' && period.status === 'draft') {
      return '<div class="tr-callout"><p>Für jede aktive Person mit Führungskraft entsteht eine Einschätzung mit Aufgaben für die Führungskraft und die Person selbst.</p></div>';
    }
    if (next === 'open') {
      return '<div class="tr-callout"><p>Führungskräfte und Beschäftigte können wieder schreiben. Offene Aufgaben kommen zurück. Bereits Eingereichtes bleibt eingereicht.</p></div>';
    }
    if (next === 'calibration') {
      const waiting = open.notSubmitted.length
        ? `<p><b>${esc(ui.plural(open.notSubmitted.length, 'Einschätzung ist', 'Einschätzungen sind'))} noch nicht eingereicht:</b> ${esc(nameList(open.notSubmitted))}.</p>`
        : '<p>Alle Einschätzungen sind eingereicht.</p>';
      const selfWaiting = open.selfNotSubmitted ? `<p>${esc(ui.plural(open.selfNotSubmitted, 'Selbsteinschätzung fehlt', 'Selbsteinschätzungen fehlen'))} noch.</p>` : '';
      return `<div class="tr-callout ${open.notSubmitted.length ? 'warning' : ''}">${waiting}${selfWaiting}<p>In der Kalibrierung kann niemand mehr schreiben, und Nicht-Eingereichtes lässt sich keiner Sitzung zuordnen. Du kannst jederzeit zurück auf „Offen“ wechseln.</p></div>`;
    }
    if (next === 'completed') {
      return open.notFinalized.length
        ? `<div class="tr-callout warning"><p><b>Das geht noch nicht.</b> Nicht final abgeschlossen: ${esc(nameList(open.notFinalized))}.</p></div>`
        : '<div class="tr-callout"><p>Alle Einschätzungen sind final abgeschlossen. Danach kannst du die Ergebnisse für die Beschäftigten freigeben.</p></div>';
    }
    if (next === 'archived') {
      return `<div class="tr-callout warning">
        <p><b>Archivieren lässt sich nicht rückgängig machen.</b> Die Periode endet, alle offenen Aufgaben und Sitzungen schließen sich. Gespeicherte Einschätzungen bleiben erhalten.</p>
        ${open.notFinalized.length ? `<p>Noch nicht final abgeschlossen: ${esc(nameList(open.notFinalized))}.</p>` : ''}
        <label class="checkline"><input type="checkbox" name="confirmArchive" required> Ja, ich möchte diese Periode endgültig archivieren.</label>
      </div>`;
    }
    return '';
  }

  async function periodStatusDialog(id) {
    const [list, open] = await Promise.all([periods(), api(`/api/talent-review/periods/${id}/open-items`)]);
    const period = list.find(item => item.id === Number(id));
    if (!period) return;
    const choiceLabel = next => (next === 'open' && period.status === 'calibration' ? 'Zurück auf „Offen“' : PERIOD_LABELS[next]);
    const confirmLabels = { open: 'Auf „Offen“ stellen', calibration: 'In die Kalibrierung wechseln', completed: 'Periode abschließen', archived: 'Endgültig archivieren' };
    openDialog({
      title: 'Stand der Periode ändern',
      subtitle: `${period.name} · jetzt: ${PERIOD_LABELS[period.status]}`,
      body: `${selectField('Neuer Stand *', 'status', option(period.nextStatuses, '', next => [next, choiceLabel(next)]))}
        <div id="trStatusConsequences"></div>
        ${textField('Notiz fürs Protokoll (freiwillig)', 'reason', { max: 1000 })}`,
      submitLabel: confirmLabels[period.nextStatuses[0]],
      onSubmit: async data => {
        await api(`/api/talent-review/periods/${period.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: data.status, reason: data.reason }) });
        toast(`Die Periode steht jetzt auf „${PERIOD_LABELS[data.status]}“.`);
        loop.navigate('reviewPeriods');
      }
    });
    const select = document.querySelector('#uiModalForm [name=status]');
    const showConsequences = () => {
      document.querySelector('#trStatusConsequences').innerHTML = statusConsequences(select.value, period, open);
      document.querySelector('#uiModalForm button.primary').textContent = confirmLabels[select.value];
    };
    select.addEventListener('change', showConsequences);
    showConsequences();
  }

  async function periodPeopleDialog(id) {
    const [list, people] = await Promise.all([periods(), api(`/api/talent-review/periods/${id}/people`)]);
    const period = list.find(item => item.id === Number(id));
    if (!period) return;
    const withoutManager = people.withoutManager.length
      ? `<div class="tr-callout"><p><b>Noch ohne Führungskraft:</b> ${esc(nameList(people.withoutManager))}. Ordne ihnen zuerst eine Führungskraft zu, sonst kann niemand für sie schreiben.</p></div>`
      : '';
    if (!people.missing.length) {
      ui.modal({ title: 'Personen aufnehmen', subtitle: period.name, body: `<p class="muted">Alle aktiven Personen mit Führungskraft sind schon in dieser Periode.</p>${withoutManager}` });
      return;
    }
    openDialog({
      title: 'Personen aufnehmen',
      subtitle: period.name,
      body: `<p class="muted">Diese Personen sind nach dem Öffnen der Periode dazugekommen. Für jede entstehen eine Einschätzung und die Aufgaben.</p>
        <div class="tr-person-list">${people.missing.map(person => `<label class="checkline"><input type="checkbox" name="employeeId" value="${esc(person.id)}" checked> ${esc(person.name)}<small class="muted"> · Führungskraft: ${esc(person.manager_name)}</small></label>`).join('')}</div>
        ${withoutManager}`,
      submitLabel: 'Aufnehmen',
      onSubmit: async (_, form) => {
        const employeeIds = new FormData(form).getAll('employeeId').map(Number);
        if (!employeeIds.length) throw new Error('Wähle mindestens eine Person aus.');
        const result = await api(`/api/talent-review/periods/${period.id}/people`, { method: 'POST', body: JSON.stringify({ employeeIds }) });
        toast(`${ui.plural(result.added, 'Person', 'Personen')} aufgenommen.`);
        loop.navigate(loop.view);
      }
    });
  }

  async function periodReleaseDialog(id) {
    const [list, open] = await Promise.all([periods(), api(`/api/talent-review/periods/${id}/open-items`)]);
    const period = list.find(item => item.id === Number(id));
    if (!period) return;
    const release = !period.employee_results_visible;
    confirmDialog({
      title: release ? 'Ergebnisse freigeben?' : 'Freigabe zurücknehmen?',
      message: release
        ? `<p>${esc(open.resultsVisibleTo === 1
          ? `1 Person sieht danach ihr Ergebnis aus „${period.name}“ und bekommt eine Aufgabe dazu.`
          : `${open.resultsVisibleTo} Personen sehen danach ihr Ergebnis aus „${period.name}“ und bekommen eine Aufgabe dazu.`)}</p><p class="muted">Die Begründung aus der Kalibrierung bleibt verborgen.</p>`
        : `<p>Die Beschäftigten sehen ihr Ergebnis aus „${esc(period.name)}“ dann nicht mehr.</p>`,
      confirmLabel: release ? 'Ergebnisse freigeben' : 'Freigabe zurücknehmen',
      onConfirm: async () => {
        await api(`/api/talent-review/periods/${id}/release`, { method: 'PATCH', body: JSON.stringify({ employeeVisible: release }) });
        toast(release ? 'Die Ergebnisse sind freigegeben.' : 'Die Freigabe ist zurückgenommen.');
        loop.navigate('reviewPeriods');
      }
    });
  }

  async function finalizeAllDialog(id) {
    const [list, open] = await Promise.all([periods(), api(`/api/talent-review/periods/${id}/open-items`)]);
    const period = list.find(item => item.id === Number(id));
    const ready = open.readyToFinalize;
    if (!period || !ready.length) throw new Error('Gerade wartet keine kalibrierte Einschätzung auf den Abschluss.');
    const count = ui.plural(ready.length, 'Einschätzung', 'Einschätzungen');
    const stillOpen = open.notFinalized.length - ready.length;
    confirmDialog({
      title: `${count} final abschließen?`,
      message: `<p><b>${esc(nameList(ready, 30))}</b></p>
        <p>Danach lassen sie sich nicht mehr ändern.</p>
        ${stillOpen > 0 ? `<p class="muted">${esc(ui.plural(stillOpen, 'weitere Einschätzung ist', 'weitere Einschätzungen sind'))} noch nicht kalibriert und ${stillOpen === 1 ? 'bleibt' : 'bleiben'} offen.</p>` : ''}
        <p class="muted">${period.employee_results_visible ? 'Die Personen sehen ihr Ergebnis sofort, denn diese Periode ist freigegeben.' : 'Die Personen sehen ihr Ergebnis erst, wenn HR die Ergebnisse der Periode freigibt.'}</p>`,
      confirmLabel: `${count} final abschließen`,
      onConfirm: async () => {
        const result = await api(`/api/talent-review/periods/${period.id}/finalize-all`, { method: 'POST', body: JSON.stringify({ reviewIds: ready.map(item => item.id) }) });
        reportBulkResult({ done: result.finalized, failed: result.failed, one: 'Einschätzung final abgeschlossen', many: 'Einschätzungen final abgeschlossen' });
        loop.navigate(loop.view);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Einschätzungen: Liste und Einzelansicht
  // ---------------------------------------------------------------------------

  async function reviewPage() {
    const list = await periods();
    const selected = state.periodId === 'all' ? null : (state.periodId || activePeriod(list)?.id || null);
    if (state.periodId !== 'all') state.periodId = selected;
    const query = new URLSearchParams();
    if (selected) query.set('periodId', selected);
    if (state.statusFilter) query.set('status', state.statusFilter);
    const data = await api(`/api/talent-review/reviews${query.size ? `?${query}` : ''}`);
    const statusOptions = Object.keys(REVIEW_LABELS).map(status => [status, REVIEW_LABELS[status]]);
    const readyToFinalize = list.find(period => period.id === selected)?.readyToFinalizeCount || 0;
    const filters = `<select class="tr-period-select" id="trReviewPeriod" aria-label="Periode"><option value="">Alle Perioden</option>${option(list, selected)}</select>
      <select class="tr-period-select" id="trReviewStatus" aria-label="Stand"><option value="">Alle Stände</option>${option(statusOptions, state.statusFilter, item => item)}</select>
      ${readyToFinalize ? button(`Kalibrierte abschließen (${readyToFinalize})`, 'period-finalize-all', selected, true) : ''}
      ${button('9-Box öffnen', 'matrix')}`;
    const managerNames = [...new Set(data.items.map(item => item.manager_name).filter(Boolean))].sort((first, second) => first.localeCompare(second, 'de'));
    const listFilters = data.items.length > 3
      ? `<div class="tr-list-filters">
          <input type="search" id="trReviewSearch" placeholder="Name oder Position suchen" aria-label="Einschätzungen suchen" autocomplete="off">
          ${managerNames.length > 1 ? `<select id="trReviewManager" aria-label="Führungskraft"><option value="">Alle Führungskräfte</option>${managerNames.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select>` : ''}
        </div>`
      : '';
    return `${layoutTitle('Einschätzungen', 'Wer wo steht, und was als Nächstes dran ist.', filters)}
      <section class="cards">
        <article class="card wide"><div class="sectionHead"><h2 id="trReviewCount">${esc(ui.plural(data.items.length, 'Einschätzung', 'Einschätzungen'))}</h2></div>${listFilters}${reviewRows(data.items)}</article>
        <article class="card">
          <h2>So läuft es</h2>
          <p class="muted">Die direkte Führungskraft schätzt Leistung, Potenzial und acht Kriterien ein. Nach dem Einreichen bleibt ihre ursprüngliche Einschätzung erhalten, auch wenn die Kalibrierung etwas ändert.</p>
          <p class="muted">Du siehst hier, was zu deiner Aufgabe gehört. Solange eine Führungskraft unter dir noch schreibt, siehst du nur den Stand.</p>
        </article>
      </section>`;
  }

  function reviewActions(data) {
    const { permissions, review } = data;
    return [
      permissions.canCalibrate ? button('Kalibrieren', 'review-calibrate', review.id, true) : '',
      permissions.canFinalize ? button('Final abschließen', 'review-finalize', review.id, true) : '',
      permissions.canReturn ? button('Zurückgeben', 'review-return', review.id) : ''
    ].join(' ');
  }

  function reviewHero(data) {
    const r = data.review;
    if (data.scope === 'status') {
      return `<article class="card wide"><h2>Noch beim Schreiben</h2><p class="muted">${esc(data.manager?.name || 'Die Führungskraft')} hat diese Einschätzung noch nicht eingereicht. Den Inhalt siehst du ab dem Einreichen.</p></article>`;
    }
    const calibrated = r.calibrated_performance ? `<p class="tr-note"><b>Begründung der Kalibrierung:</b> ${esc(r.calibration_reason || 'Keine Abweichung vom Vorschlag.')}</p>` : '';
    return `<article class="card wide tr-review-hero">
      <div>
        <small>Ursprüngliche Einschätzung der Führungskraft</small>
        <div class="tr-score-row">
          <div><span>Leistung</span><b>${esc(r.original_performance || '–')}<i>von 3</i></b></div>
          <div><span>Potenzial</span><b>${esc(r.original_potential || '–')}<i>von 3</i></b></div>
        </div>
        ${calibrated}
      </div>
      <div class="tr-effective">
        <small>${r.calibrated_performance ? 'Ergebnis nach der Kalibrierung' : 'Aktueller Stand'}</small>
        <b>${r.boxKey ? esc(scoreText(r.performance, r.potential)) : 'Noch nicht eingeordnet'}</b>
        <span>${esc(r.boxLabel || '')}</span>
      </div>
    </article>`;
  }

  function selfAssessmentCard(self, scope, heading = 'Selbsteinschätzung der Person') {
    if (self?.status !== 'employee_submitted') {
      return `<article class="card wide"><div class="sectionHead"><div><h2>${esc(heading)}</h2><p class="muted">Noch nicht abgegeben. Entwürfe bleiben privat, auch gegenüber HR.</p></div>${tag(SELF_LABELS, self?.status || 'not_started')}</div></article>`;
    }
    if (self.performance === undefined) {
      const reason = scope === 'status' ? 'Du siehst sie, sobald die Führungskraft ihre Einschätzung eingereicht hat.' : 'Sie bleibt bei den Führungskräften dieser Person und bei HR.';
      return `<article class="card wide"><div class="sectionHead"><div><h2>${esc(heading)}</h2><p class="muted">Abgegeben am ${date(self.submittedAt)}. ${esc(reason)}</p></div>${tag(SELF_LABELS, self.status)}</div></article>`;
    }
    return `<article class="card wide">
      <div class="sectionHead"><div><h2>${esc(heading)}</h2><p class="muted">Abgegeben am ${date(self.submittedAt)}. Sie hilft im Gespräch und fließt nicht automatisch in die 9-Box ein.</p></div>${tag(SELF_LABELS, self.status)}</div>
      <div class="tr-score-row tr-self-score">
        <div><span>Leistung</span><b>${esc(self.performance)}<i>von 3</i></b></div>
        <div><span>Entwicklungsperspektive</span><b>${esc(self.potential)}<i>von 3</i></b></div>
      </div>
      <div class="tr-read-grid tr-self-grid">
        <div><small>Begründung zur Leistung</small><p>${esc(self.performanceReason)}</p></div>
        <div><small>Begründung zur Entwicklung</small><p>${esc(self.potentialReason)}</p></div>
        <div><small>Erfolge und Wirkung</small><p>${esc(self.observations)}</p></div>
        <div><small>Entwicklungsfokus</small><p>${esc(self.developmentFields || 'Nicht ergänzt.')}</p></div>
        <div><small>Nächste Schritte</small><p>${esc(self.nextSteps || 'Nicht ergänzt.')}</p></div>
      </div>
    </article>`;
  }

  function criterionField(item, rating, unratedComment) {
    return `<div class="tr-criterion" data-criterion-id="${esc(item.id)}">
      ${selectField(`${item.label} *`, `criterion-${item.id}`, `<option value="">Bitte wählen</option>${[1, 2, 3, 4, 5].map(value => `<option value="${value}" ${rating?.rating === value ? 'selected' : ''}>${value} von 5</option>`).join('')}`)}
      <textarea name="criterion-comment-${esc(item.id)}" maxlength="1000" placeholder="Konkrete Beobachtung" aria-label="Beobachtung zu ${esc(item.label)}">${esc(rating?.comment || unratedComment || '')}</textarea>
    </div>`;
  }

  const formActions = (saveLabel, saveAction, submitLabel, submitAction, id) => `<div class="tr-form-actions">
      ${button(saveLabel, saveAction, id)} ${button(submitLabel, submitAction, id, true)}
      <span class="tr-save-note" data-tr-save-note role="status" aria-live="polite"></span>
    </div>`;

  function managerForm(data) {
    const r = data.review;
    const { limits } = data;
    const ratings = Object.fromEntries(data.ratings.map(item => [item.criterion_id, item]));
    const actions = formActions('Als Entwurf speichern', 'review-save', 'Speichern und einreichen', 'review-submit', r.id);
    const returned = r.return_reason ? `<div class="tr-callout warning"><p><b>Von HR zurückgegeben:</b> ${esc(r.return_reason)}</p></div>` : '';
    return `<section class="cards">
      <form class="card wide tr-review-form" id="trManagerReview" data-review-id="${esc(r.id)}">
        <div class="sectionHead"><div><h2>Deine Einschätzung</h2><p class="muted">Du kannst jederzeit unvollständig speichern. Zum Einreichen brauchst du Leistung und Potenzial, je ${esc(limits.reason)} Zeichen Begründung, ${esc(limits.observations)} Zeichen Beobachtungen und eine Note für alle ${esc(data.criteria.length)} Kriterien.</p></div></div>
        ${returned}
        <div class="tr-problems" data-tr-problems role="alert" hidden></div>
        ${actions}
        <div class="two">
          <div>
            ${selectField('Leistung (1 bis 3) *', 'performance', scoreOptions(MANAGER_SCALES.performance, r.original_performance))}
            ${requiredTextField('Begründung zur Leistung *', 'performanceReason', r.performance_reason, limits.reason)}
          </div>
          <div>
            ${selectField('Potenzial (1 bis 3) *', 'potential', scoreOptions(MANAGER_SCALES.potential, r.original_potential))}
            ${requiredTextField('Begründung zum Potenzial *', 'potentialReason', r.potential_reason, limits.reason)}
          </div>
        </div>
        ${requiredTextField('Beobachtungen *', 'observations', r.observations, limits.observations)}
        ${textField('Entwicklungsfelder', 'developmentFields', { value: r.development_fields || '' })}
        ${textField('Nächste Schritte', 'nextSteps', { value: r.next_steps || '' })}
        <h2 class="sectionTitle">Potenzialkriterien (1 bis 5)</h2>
        <div class="tr-criteria">${(data.criteria || []).map(item => criterionField(item, ratings[item.id], data.unratedComments?.[item.id])).join('')}</div>
        ${actions}
      </form>
      <article class="card">
        <h2>So liest du die Skalen</h2>
        <p><b>Leistung</b><br>1: braucht Unterstützung · 2: solide · 3: stark</p>
        <p><b>Potenzial</b><br>1: gezielt entwickeln · 2: kann wachsen · 3: bereit für die nächste Herausforderung</p>
        <p class="muted">Das Feld in der 9-Box gibst du nicht ein. Es ergibt sich aus diesen beiden Werten.</p>
      </article>
    </section>`;
  }

  function reviewReadOnly(data) {
    const r = data.review;
    if (data.scope === 'status') return '';
    const ratings = data.ratings.length ? `<h2 class="sectionTitle">Potenzialkriterien</h2>
      <div class="tr-rating-list">${data.ratings.map(item => `<div><b>${esc(item.label)}</b><span class="rating">${'★'.repeat(item.rating)}<i>${esc(item.rating)} von 5</i></span><small>${esc(item.comment || '')}</small></div>`).join('')}</div>` : '';
    const previous = data.scope === 'session' ? '' : `<article class="card"><h2>Frühere Perioden</h2>${data.previous.length
      ? data.previous.map(item => `<p><b>${esc(item.period_name)}</b><br>${esc(scoreText(item.performance, item.potential))}</p>`).join('')
      : '<p class="muted">Noch kein abgeschlossenes Ergebnis aus früheren Perioden.</p>'}</article>`;
    return `<section class="cards">
      <article class="card wide">
        <h2>Begründung und Entwicklung</h2>
        <div class="tr-read-grid">
          <div><small>Leistung</small><p>${esc(r.performance_reason || 'Noch nicht beschrieben.')}</p></div>
          <div><small>Potenzial</small><p>${esc(r.potential_reason || 'Noch nicht beschrieben.')}</p></div>
          <div><small>Beobachtungen</small><p>${esc(r.observations || 'Noch nicht beschrieben.')}</p></div>
          <div><small>Nächste Schritte</small><p>${esc(r.next_steps || 'Noch nicht beschrieben.')}</p></div>
        </div>
        ${ratings}
      </article>
      ${previous}
    </section>`;
  }

  function decisionsCard(data, wide = true) {
    const list = data.decisions.length
      ? `<div class="talent-list">${data.decisions.map(item => `<div class="talent-item"><div><b>${esc(item.decision_label)}</b><small>${esc(item.description)} · Zieltermin ${date(item.target_date)}</small></div><div class="tr-item-actions">${tag(DECISION_LABELS, item.status)} ${item.linked_goal_id ? '<span class="tag">Ziel verknüpft</span>' : ''}</div></div>`).join('')}</div>`
      : '<p class="muted">Noch keine Entwicklungsmaßnahmen.</p>';
    return `<article class="card ${wide ? 'wide' : ''}"><div class="sectionHead"><h2>Entwicklungsmaßnahmen</h2>${data.permissions.canCreateDecision ? button('+ Maßnahme', 'decision-create', data.review.id, true) : ''}</div>${list}</article>`;
  }

  function historyAndDecisions(data) {
    if (data.scope === 'session') return '';
    const items = data.history.slice(0, 8).map(item => `<p><b>${esc(item.label)}</b><small>${esc(item.actor_name)} · ${date(item.created_at)}</small>${item.reason ? `<span>${esc(item.reason)}</span>` : ''}</p>`);
    return `<section class="cards">
      ${decisionsCard(data)}
      <article class="card"><h2>Verlauf</h2>${items.length ? `<div class="tr-history">${items.join('')}</div>` : '<p class="muted">Noch keine Änderungen.</p>'}</article>
    </section>`;
  }

  /** Was die Person selbst nach der Freigabe sieht: ihr Ergebnis, nichts aus der Kalibrierung. */
  function employeeResultPage(data) {
    const r = data.review;
    const ratings = data.ratings.length ? `<h2 class="sectionTitle">Potenzialkriterien</h2>
      <div class="tr-rating-list">${data.ratings.map(item => `<div><b>${esc(item.label)}</b><span class="rating">${'★'.repeat(item.rating)}<i>${esc(item.rating)} von 5</i></span><small>${esc(item.comment || '')}</small></div>`).join('')}</div>` : '';
    const previous = data.previous.length ? `<article class="card"><h2>Frühere Perioden</h2>${data.previous.map(item => `<p><b>${esc(item.period_name)}</b><br>${esc(scoreText(item.performance, item.potential))}</p>`).join('')}</article>` : '';
    return `${layoutTitle(`Dein Ergebnis: ${esc(data.period.name)}`, `Führungskraft: ${esc(data.manager?.name || '–')}`, backButton('Meine Entwicklung', 'my-results'))}
      <section class="cards">
        <article class="card wide tr-review-hero">
          <div>
            <small>Dein Ergebnis</small>
            <div class="tr-score-row">
              <div><span>Leistung</span><b>${esc(r.performance)}<i>von 3</i></b></div>
              <div><span>Potenzial</span><b>${esc(r.potential)}<i>von 3</i></b></div>
            </div>
          </div>
          <div class="tr-effective"><small>Das bedeutet</small><b>${esc(r.boxLabel || '–')}</b></div>
        </article>
        ${supportCard(data.support)}
      </section>
      <section class="cards">
        <article class="card wide">
          <h2>Einschätzung deiner Führungskraft</h2>
          <div class="tr-read-grid">
            <div><small>Leistung</small><p>${esc(r.performance_reason || 'Nicht beschrieben.')}</p></div>
            <div><small>Potenzial</small><p>${esc(r.potential_reason || 'Nicht beschrieben.')}</p></div>
            <div><small>Beobachtungen</small><p>${esc(r.observations || 'Nicht beschrieben.')}</p></div>
            <div><small>Entwicklungsfelder</small><p>${esc(r.development_fields || 'Nicht beschrieben.')}</p></div>
            <div><small>Nächste Schritte</small><p>${esc(r.next_steps || 'Nicht beschrieben.')}</p></div>
          </div>
          ${ratings}
        </article>
        ${previous}
      </section>
      <section class="cards tr-single">${selfAssessmentCard(data.selfAssessment, 'employee', 'Deine Selbsteinschätzung')}</section>
      <section class="cards tr-single">${decisionsCard(data)}</section>`;
  }

  async function reviewDetail() {
    if (!state.reviewId) return reviewPage();
    const data = await api(`/api/talent-review/reviews/${state.reviewId}`);
    if (data.scope === 'employee') return employeeResultPage(data);
    const r = data.review;
    const hint = data.calibrationHint ? `<section class="cards"><article class="card wide tr-callout-card"><div class="tr-callout"><p>${esc(data.calibrationHint)}</p></div></article></section>` : '';
    const heading = [data.employee.title, `Führungskraft: ${data.manager?.name || '–'}`, data.period.name].filter(Boolean).map(esc).join(' · ');
    return `${layoutTitle(`Talent Review: ${esc(data.employee.name)}`, heading, `<span data-tr-review-status>${reviewTag(r.status)}</span> ${reviewActions(data)}`)}
      <div class="tr-backrow">${backButton('Alle Einschätzungen', 'reviews')}</div>
      ${hint}
      ${data.permissions.canEdit
    ? `<section class="cards">${selfAssessmentCard(data.selfAssessment, data.scope)}${supportCard(data.support)}</section>${managerForm(data)}`
    : `<section class="cards">${reviewHero(data)}${supportCard(data.support)}</section><section class="cards tr-single">${selfAssessmentCard(data.selfAssessment, data.scope)}</section>${reviewReadOnly(data)}`}
      ${historyAndDecisions(data)}`;
  }

  const clockTime = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  function showFormProblems(form, problems) {
    const box = form.querySelector('[data-tr-problems]');
    if (!box) return;
    box.hidden = !problems.length;
    box.innerHTML = problems.length ? `<b>Das fehlt noch:</b><ul>${problems.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '';
    if (problems.length) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** Nach dem Speichern bleibt die Seite stehen: Was während einer langsamen Antwort getippt wurde, bleibt im Formular. */
  function confirmSaved(form, note) {
    form.querySelectorAll('[data-tr-save-note]').forEach(element => {
      element.textContent = note;
      element.classList.add('saved');
    });
    form.querySelector('[data-tr-problems]')?.setAttribute('hidden', '');
  }

  function setFormBusy(form, busy) {
    form.setAttribute('aria-busy', String(busy));
    form.querySelectorAll('[data-tr-action]').forEach(element => {
      element.disabled = busy;
    });
    if (busy) form.querySelectorAll('[data-tr-save-note]').forEach(element => {
      element.textContent = 'Wird gespeichert …';
      element.classList.remove('saved');
    });
  }

  async function whileSaving(form, work) {
    setFormBusy(form, true);
    const typedSinceStart = state.hasUnsavedChanges;
    state.hasUnsavedChanges = false;
    try {
      return await work();
    } catch (error) {
      state.hasUnsavedChanges = typedSinceStart || state.hasUnsavedChanges;
      form.querySelectorAll('[data-tr-save-note]').forEach(element => {
        element.textContent = 'Nicht gespeichert. Deine Eingaben stehen noch im Formular.';
        element.classList.remove('saved');
      });
      throw error;
    } finally {
      setFormBusy(form, false);
    }
  }

  function readManagerForm(form) {
    const values = Object.fromEntries(new FormData(form));
    const criteria = [...form.querySelectorAll('[data-criterion-id]')].map(element => {
      const id = element.dataset.criterionId;
      return { criterionId: Number(id), rating: values[`criterion-${id}`], comment: values[`criterion-comment-${id}`] };
    });
    return {
      performance: values.performance,
      potential: values.potential,
      performanceReason: values.performanceReason,
      potentialReason: values.potentialReason,
      observations: values.observations,
      developmentFields: values.developmentFields,
      nextSteps: values.nextSteps,
      criteria
    };
  }

  async function saveManagerDraft(form) {
    const result = await api(`/api/talent-review/reviews/${form.dataset.reviewId}/manager`, { method: 'PATCH', body: JSON.stringify(readManagerForm(form)) });
    const status = document.querySelector('[data-tr-review-status]');
    if (status) status.innerHTML = reviewTag(result.status);
    confirmSaved(form, `Entwurf um ${clockTime()} Uhr gespeichert.`);
    return result;
  }

  async function saveManagerReview(form) {
    await whileSaving(form, () => saveManagerDraft(form));
    toast('Entwurf gespeichert.');
  }

  async function submitManagerReview(form) {
    const submitted = await whileSaving(form, async () => {
      const draft = await saveManagerDraft(form);
      if (draft.missing?.length) {
        showFormProblems(form, draft.missing);
        return false;
      }
      await api(`/api/talent-review/reviews/${form.dataset.reviewId}/submit`, { method: 'POST' });
      return true;
    });
    if (!submitted) {
      toast('Dein Entwurf ist gespeichert. Zum Einreichen fehlt noch etwas.', 'error');
      return;
    }
    toast('Einschätzung eingereicht.');
    loop.navigate('reviewDetail');
  }

  function returnReviewDialog(id) {
    openDialog({
      title: 'Einschätzung zurückgeben',
      subtitle: 'Die Führungskraft bekommt eine Aufgabe und kann überarbeiten.',
      body: textField('Begründung für die Führungskraft *', 'reason', { required: true, attributes: 'minlength="10"', hint: 'Mindestens 10 Zeichen.', max: 3000 }),
      submitLabel: 'Zurückgeben',
      onSubmit: async data => {
        await api(`/api/talent-review/reviews/${id}/return`, { method: 'POST', body: JSON.stringify(data) });
        toast('Die Einschätzung ist zurückgegeben.');
        loop.navigate('reviewDetail');
      }
    });
  }

  async function finalizeDialog(id) {
    const data = await api(`/api/talent-review/reviews/${id}`);
    const r = data.review;
    confirmDialog({
      title: 'Final abschließen?',
      message: `<p><b>${esc(data.employee.name)}:</b> ${esc(scoreText(r.performance, r.potential))}${r.boxLabel ? ` (${esc(r.boxLabel)})` : ''}</p>
        <p>Danach lässt sich diese Einschätzung nicht mehr ändern.</p>
        <p class="muted">${data.period.employee_results_visible ? 'Die Person sieht das Ergebnis sofort, denn die Ergebnisse dieser Periode sind freigegeben.' : 'Die Person sieht das Ergebnis erst, wenn HR die Ergebnisse der Periode freigibt.'}</p>`,
      confirmLabel: 'Final abschließen',
      onConfirm: async () => {
        await api(`/api/talent-review/reviews/${id}/finalize`, { method: 'POST' });
        toast('Einschätzung final abgeschlossen.');
        loop.navigate('reviewDetail');
      }
    });
  }

  async function calibrateDialog(id) {
    const data = await api(`/api/talent-review/reviews/${id}`);
    const r = data.review;
    if (!data.permissions.canCalibrate) {
      toast(data.calibrationHint || 'Kalibrieren ist hier gerade nicht möglich.', 'error');
      return;
    }
    const sessionLabel = item => `${item.title} · ${ui.date(item.session_date)}`;
    const session = data.calibrationSessions.length === 1
      ? `<input type="hidden" name="sessionId" value="${esc(data.calibrationSessions[0].id)}"><p class="muted">Sitzung: ${esc(sessionLabel(data.calibrationSessions[0]))}</p>`
      : selectField('Sitzung *', 'sessionId', option(data.calibrationSessions, '', item => [item.id, sessionLabel(item)]));
    openDialog({
      title: `Kalibrieren: ${data.employee.name}`,
      subtitle: `Vorschlag der Führungskraft: ${scoreText(r.original_performance, r.original_potential)}`,
      body: `${session}
        <div class="two">
          <div>${selectField('Leistung (1 bis 3) *', 'performance', scoreOptions(MANAGER_SCALES.performance, r.calibrated_performance || r.original_performance))}</div>
          <div>${selectField('Potenzial (1 bis 3) *', 'potential', scoreOptions(MANAGER_SCALES.potential, r.calibrated_potential || r.original_potential))}</div>
        </div>
        ${textField('Begründung', 'reason', { max: 3000, hint: `Nur nötig, wenn du vom Vorschlag abweichst: mindestens ${data.limits.reason} Zeichen. Die Person selbst sieht diese Begründung nicht.` })}
        <input type="hidden" name="version" value="${esc(r.version)}">`,
      submitLabel: 'Kalibrierung speichern',
      onSubmit: async form => {
        await api(`/api/talent-review/reviews/${id}/calibrate`, { method: 'POST', body: JSON.stringify(form) });
        toast('Kalibrierung gespeichert.');
        loop.navigate('reviewDetail');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Kalibrierungssitzungen
  // ---------------------------------------------------------------------------

  async function sessionPage() {
    const [list, rights] = await Promise.all([api('/api/talent-review/sessions'), meta()]);
    const rows = list.items.map(item => `<div class="talent-item">
      <div><b>${esc(item.title)}</b><small>${esc(item.period_name)} · ${date(item.session_date)} · Moderation: ${esc(item.moderator_name)}</small></div>
      <div class="tr-item-actions">${tag(SESSION_LABELS, item.status)} ${button('Öffnen', 'session-open', item.id)}</div>
    </div>`);
    return `${layoutTitle('Kalibrierung', 'In der Kalibrierung vergleichen Führungskräfte ihre Einschätzungen, damit überall derselbe Maßstab gilt.', rights.canManagePeriods ? button('+ Sitzung', 'session-create', '', true) : '')}
      <section class="cards">
        <article class="card wide">${rows.length ? `<div class="talent-list">${rows.join('')}</div>` : `<p class="muted">${rights.canManagePeriods ? 'Noch keine Sitzungen angelegt.' : 'Du nimmst gerade an keiner Sitzung teil.'}</p>`}</article>
        <article class="card">
          <h2>Wer was sieht</h2>
          <p class="muted">Kalibrieren können nur die Personen, die HR zur Sitzung hinzugefügt hat. Fälle außerhalb ihres Bereichs sehen sie nur, solange die Sitzung läuft. Den eigenen Fall sieht und kalibriert niemand.</p>
        </article>
      </section>`;
  }

  async function sessionDetail() {
    if (!state.sessionId) return sessionPage();
    const data = await api(`/api/talent-review/sessions/${state.sessionId}`);
    const { session } = data;
    const running = session.status === 'active';
    const open = ['planned', 'active'].includes(session.status);
    const manage = data.canManage && open ? `${button('Stand ändern', 'session-status', session.id)} ${button('+ Teilnehmende', 'session-participant', session.id)} ${button('+ Fall', 'session-case', session.id)} ${button('Alle Eingereichten aufnehmen', 'session-cases-all', session.id, true)}` : '';
    const notRunning = !running && data.cases.some(item => !item.canOpen) ? '<p class="muted">Fälle außerhalb deines Bereichs lassen sich öffnen, solange die Sitzung läuft.</p>' : '';
    const cases = data.cases.map(item => `<div class="talent-item">
      <div>
        <b>${esc(item.employee_name)}</b>
        <small>${esc(item.employee_title || '')}${item.manager_name ? ` · Führungskraft: ${esc(item.manager_name)}` : ''}</small>
        <div class="tr-tags">${reviewTag(item.review_status)} ${tag(CASE_LABELS, item.case_status)}</div>
        ${item.moderator_note ? `<p class="tr-note"><b>Hinweis für die Sitzung:</b> ${esc(item.moderator_note)}</p>` : ''}
        ${item.outcome_label ? `<p class="tr-note"><b>Ergebnis:</b> ${esc(item.outcome_label)}</p>` : ''}
      </div>
      <div class="tr-item-actions">${item.canOpen ? button('Öffnen', 'review-open', item.review_id) : '<small class="muted">Noch nicht einsehbar</small>'}</div>
    </div>`);
    return `${layoutTitle(`Sitzung: ${esc(session.title)}`, `${esc(data.period.name)} · ${date(session.session_date)} · ${tag(SESSION_LABELS, session.status)}`, manage)}
      <div class="tr-backrow">${backButton('Alle Sitzungen', 'sessions')}</div>
      ${session.description ? `<p class="muted">${esc(session.description)}</p>` : ''}
      <section class="cards">
        <article class="card wide">
          <h2>Fälle</h2>
          ${cases.length ? `<div class="talent-list">${cases.join('')}</div>` : '<p class="muted">Dieser Sitzung sind noch keine eingereichten Einschätzungen zugeordnet.</p>'}
          ${notRunning}
        </article>
        <article class="card"><h2>Teilnehmende</h2>${data.participants.map(item => `<p><b>${esc(item.name)}</b><br><small>${esc(loop.roles[item.role] || item.role)}</small></p>`).join('')}</article>
      </section>`;
  }

  async function sessionForm() {
    const [list, users] = await Promise.all([periods(), api('/api/users')]);
    const usable = list.filter(period => !['completed', 'archived'].includes(period.status));
    if (!usable.length) throw new Error('Es gibt gerade keine Periode, für die eine Sitzung möglich ist.');
    const moderators = users.users.filter(person => ['manager', 'director', 'hr_admin', 'hrbp'].includes(person.role));
    openDialog({
      title: 'Kalibrierungssitzung anlegen',
      subtitle: 'Pflichtfelder sind mit * markiert.',
      body: `${selectField('Periode *', 'periodId', option(usable, activePeriod(usable)?.id))}
        ${inputField('Titel *', 'title', { required: true })}
        ${inputField('Datum *', 'sessionDate', { type: 'date', required: true })}
        ${textField('Beschreibung', 'description')}
        ${selectField('Moderation *', 'moderatorId', option(moderators, loop.me.id, person => [person.id, `${person.name} · ${loop.roles[person.role] || person.role}`]), { hint: 'Moderieren können Führungskräfte und HR.' })}
        ${selectField('Nur ein Bereich (freiwillig)', 'organizationManagerId', `<option value="">Nicht eingegrenzt</option>${option(leaders(users.users), '')}`, { hint: 'Dann lassen sich nur Personen aus dem Bereich dieser Führungskraft zuordnen.' })}`,
      onSubmit: async data => {
        await api('/api/talent-review/sessions', { method: 'POST', body: JSON.stringify(data) });
        toast('Sitzung angelegt.');
        loop.navigate('reviewSessions');
      }
    });
  }

  async function sessionParticipantForm() {
    const [users, session] = await Promise.all([api('/api/users'), api(`/api/talent-review/sessions/${state.sessionId}`)]);
    const taken = new Set(session.participants.map(person => person.id));
    const people = users.users.filter(person => ['manager', 'director', 'hr_admin', 'hrbp'].includes(person.role) && !taken.has(person.id));
    if (!people.length) throw new Error('Alle Führungskräfte und HR-Personen nehmen schon teil.');
    openDialog({
      title: 'Teilnehmende Person hinzufügen',
      subtitle: 'Sie sieht die Fälle, solange die Sitzung läuft, und kann sie kalibrieren.',
      body: selectField('Person *', 'userId', option(people, '', person => [person.id, `${person.name} · ${loop.roles[person.role] || person.role}`])),
      submitLabel: 'Hinzufügen',
      onSubmit: async data => {
        await api(`/api/talent-review/sessions/${state.sessionId}/participants`, { method: 'POST', body: JSON.stringify(data) });
        toast('Person hinzugefügt.');
        loop.navigate('reviewSessionDetail');
      }
    });
  }

  async function sessionCaseForm() {
    const session = await api(`/api/talent-review/sessions/${state.sessionId}`);
    const taken = new Set(session.cases.map(item => item.review_id));
    const reviews = (await api(`/api/talent-review/reviews?periodId=${session.session.period_id}`)).items
      .filter(item => ['manager_submitted', 'in_calibration', 'calibrated'].includes(item.status) && !taken.has(item.id));
    if (!reviews.length) throw new Error('Gerade gibt es keine eingereichte Einschätzung, die du hier zuordnen kannst.');
    openDialog({
      title: 'Fall hinzufügen',
      subtitle: 'Zuordnen lassen sich nur eingereichte Einschätzungen.',
      body: `${selectField('Einschätzung *', 'reviewId', option(reviews, '', item => [item.id, `${item.employee_name} · ${REVIEW_LABELS[item.status]}`]), { hint: 'Ein schon kalibrierter Fall wird dadurch neu besprochen.' })}
        ${inputField('Reihenfolge', 'displayOrder', { type: 'number', value: 0, attributes: 'min="0"' })}
        ${textField('Hinweis für die Sitzung', 'moderatorNote', { max: 2000, hint: 'Die Teilnehmenden sehen ihn bei diesem Fall. Die Person selbst sieht ihn nicht.' })}`,
      submitLabel: 'Hinzufügen',
      onSubmit: async data => {
        await api(`/api/talent-review/sessions/${state.sessionId}/cases`, { method: 'POST', body: JSON.stringify(data) });
        toast('Fall hinzugefügt.');
        loop.navigate('reviewSessionDetail');
      }
    });
  }

  async function sessionAllCasesDialog() {
    const data = await api(`/api/talent-review/sessions/${state.sessionId}/case-candidates`);
    if (!data.candidates.length) throw new Error('Gerade wartet keine eingereichte Einschätzung auf eine Sitzung.');
    const reviewIds = data.candidates.map(item => item.id);
    const count = ui.plural(reviewIds.length, 'Fall', 'Fälle');
    confirmDialog({
      title: `${count} aufnehmen?`,
      message: `<p><b>${esc(nameList(data.candidates, 30))}</b></p>
        ${data.notSubmitted.length ? `<p class="muted">${esc(ui.plural(data.notSubmitted.length, 'Einschätzung ist', 'Einschätzungen sind'))} noch nicht eingereicht und ${data.notSubmitted.length === 1 ? 'bleibt' : 'bleiben'} draußen: ${esc(nameList(data.notSubmitted))}.</p>` : ''}
        ${data.outside.length ? `<p class="muted">Außerhalb des Bereichs dieser Sitzung: ${esc(nameList(data.outside))}.</p>` : ''}`,
      confirmLabel: `${count} aufnehmen`,
      onConfirm: async () => {
        const result = await api(`/api/talent-review/sessions/${state.sessionId}/cases/bulk`, { method: 'POST', body: JSON.stringify({ reviewIds }) });
        reportBulkResult({ done: result.added, failed: result.failed, one: 'Fall aufgenommen', many: 'Fälle aufgenommen' });
        loop.navigate('reviewSessionDetail');
      }
    });
  }

  async function sessionStatusForm() {
    const data = await api(`/api/talent-review/sessions/${state.sessionId}`);
    const choices = { planned: [['active', 'Sitzung starten'], ['cancelled', 'Absagen']], active: [['completed', 'Abschließen'], ['cancelled', 'Absagen']] }[data.session.status] || [];
    const startHint = data.session.status === 'planned' && data.period.status !== 'calibration'
      ? '<div class="tr-callout warning"><p>Starten geht erst, wenn die Periode in der Kalibrierung ist. Das stellst du unter „Perioden“ um.</p></div>'
      : '';
    openDialog({
      title: 'Stand der Sitzung ändern',
      subtitle: data.session.title,
      body: `${selectField('Neuer Stand *', 'status', option(choices, '', item => item))}${startHint}
        <p class="muted">Endet die Sitzung, sehen die Teilnehmenden Fälle außerhalb ihres Bereichs nicht mehr.</p>`,
      onSubmit: async form => {
        await api(`/api/talent-review/sessions/${state.sessionId}`, { method: 'PATCH', body: JSON.stringify(form) });
        toast('Stand der Sitzung geändert.');
        loop.navigate('reviewSessionDetail');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 9-Box
  // ---------------------------------------------------------------------------

  async function matrixPage() {
    const [list, sessions, userData, positionData, poolData, metadata] = await Promise.all([periods(), api('/api/talent-review/sessions'), api('/api/users'), api('/api/positions'), api('/api/talent-pools'), meta()]);
    const listPeriod = state.periodId === 'all' ? null : state.periodId;
    const selected = state.matrixPeriodId === 'all' ? null : (state.matrixPeriodId || listPeriod || activePeriod(list)?.id || null);
    if (state.matrixPeriodId !== 'all') state.matrixPeriodId = selected;
    const filters = state.matrixFilters;
    const query = new URLSearchParams();
    if (selected) query.set('periodId', selected);
    Object.entries(filters).forEach(([key, value]) => {
      if (value) query.set(key, value);
    });
    const data = await api(`/api/talent-review/matrix${query.size ? `?${query}` : ''}`);
    const sessionOptions = sessions.items.filter(item => !selected || item.period_id === selected);
    const people = leaders(userData.users);
    const statuses = Object.keys(REVIEW_LABELS).map(status => [status, REVIEW_LABELS[status]]);
    const boxOptions = Object.entries(metadata.boxes).map(([key, label]) => [key, `${label} (Leistung ${key[2]}, Potenzial ${key[0]})`]);
    const filterSelect = (key, label, items, mapper) => `<label class="tr-filter"><span>${esc(label)}</span><select data-tr-matrix-filter="${key}"><option value="">Alle</option>${option(items, filters[key], mapper)}</select></label>`;
    const hasFilter = Object.values(filters).some(Boolean);
    const cells = [3, 2, 1].flatMap(potential => [1, 2, 3].map(performance => {
      const box = data.boxes[`${potential}-${performance}`];
      const persons = box.reviews.length
        ? box.reviews.map(item => `<button type="button" class="tr-person-chip" data-tr-action="review-open" data-id="${esc(item.id)}">${esc(item.employee_name)}<span>${esc(item.employee_title || '')}</span></button>`).join('')
        : '<span class="muted">Keine Person</span>';
      return `<section class="tr-nine-cell"><small>Potenzial ${potential} · Leistung ${performance}</small><h3>${esc(box.label)}</h3>${persons}</section>`;
    }));
    return `${layoutTitle('9-Box', 'Die 9-Box ordnet jede Person nach Leistung (waagerecht) und Potenzial (senkrecht) in eines von neun Feldern ein.', `<select class="tr-period-select" id="trMatrixPeriod" data-tr-matrix-filter="periodId" aria-label="Periode"><option value="">Alle Perioden</option>${option(list, selected)}</select>`)}
      <section class="card tr-filter-card">
        <div class="tr-filter-grid">
          ${filterSelect('sessionId', 'Sitzung', sessionOptions, item => [item.id, item.title])}
          ${filterSelect('organizationManagerId', 'Bereich von', people, item => [item.id, item.name])}
          ${filterSelect('managerId', 'Direkte Führungskraft', people, item => [item.id, item.name])}
          ${filterSelect('positionId', 'Position', positionData.items || [], item => [item.id, item.title])}
          ${filterSelect('status', 'Stand', statuses, item => item)}
          ${filterSelect('poolId', 'Talentpool', poolData.items || [], item => [item.id, item.name])}
          ${filterSelect('box', '9-Box-Feld', boxOptions, item => item)}
        </div>
        ${hasFilter ? `<div class="tr-form-actions">${button('Filter zurücksetzen', 'matrix-reset')}</div>` : ''}
      </section>
      <section class="cards">
        <article class="card wide">
          <div class="tr-axis-label tr-axis-top">Potenzial nach oben, Leistung nach rechts</div>
          <div class="tr-nine-grid">${cells.join('')}</div>
        </article>
        <article class="card">
          <h2>${esc(ui.plural(data.total, 'Person', 'Personen'))} eingeordnet</h2>
          <p class="muted">Du siehst nur Personen, für die du zuständig bist. Einschätzungen aus den Teams unter dir erscheinen ab dem Einreichen.</p>
          <p class="muted">Die 9-Box trifft keine Personalentscheidung. Sie hilft beim Vergleichen.</p>
        </article>
      </section>`;
  }

  // ---------------------------------------------------------------------------
  // Talentpools
  // ---------------------------------------------------------------------------

  async function poolPage() {
    const data = await api('/api/talent-pools');
    const cards = data.items.map(item => `<article class="card">
      <small>${item.active ? 'AKTIV' : 'NICHT AKTIV'}</small>
      <h2>${esc(item.name)}</h2>
      <p class="muted">${esc(item.description || item.purpose || 'Ohne Beschreibung')}</p>
      ${data.canManage ? countRow(item.member_count, 'Person aufgenommen oder vorgeschlagen', 'Personen aufgenommen oder vorgeschlagen') : countRow(item.member_count, 'Person aus deinem Bereich', 'Personen aus deinem Bereich')}
      ${button('Öffnen', 'pool-open', item.id, true)}
    </article>`);
    const empty = data.canManage ? 'Noch keine Talentpools angelegt.' : 'Gerade gibt es keinen aktiven Talentpool.';
    return `${layoutTitle('Talentpools', 'In einem Talentpool stehen Personen, die eine Organisation gezielt weiterentwickeln möchte. Führungskräfte schlagen vor, HR entscheidet.', data.canManage ? button('+ Talentpool', 'pool-create', '', true) : '')}
      <section class="cards">${cards.length ? cards.join('') : `<article class="card"><p class="muted">${esc(empty)}</p></article>`}</section>`;
  }

  async function poolDetail() {
    if (!state.poolId) return poolPage();
    const data = await api(`/api/talent-pools/${state.poolId}/members`);
    const rows = data.items.map(item => `<div class="talent-item">
      <div>
        <b>${esc(item.employee_name)}</b>
        <small>${esc(item.employee_title || '')}${item.period_name ? ` · ${esc(item.period_name)}` : ''}${item.proposed_by_name ? ` · Vorschlag von ${esc(item.proposed_by_name)}` : ''}</small>
        <div class="tr-tags">${tag(MEMBERSHIP_LABELS, item.status)}</div>
        <p class="tr-note"><b>Begründung:</b> ${esc(item.reason)}</p>
        ${item.development_plan ? `<p class="tr-note"><b>Entwicklungsplan:</b> ${esc(item.development_plan)}</p>` : ''}
        ${item.removed_reason ? `<p class="tr-note"><b>Entfernt am ${date(item.removed_at)}:</b> ${esc(item.removed_reason)}</p>` : ''}
      </div>
      <div class="tr-item-actions">${data.canDecide && item.status !== 'removed' ? button('Entscheiden', 'pool-member-status', item.id) : ''}</div>
    </div>`);
    const empty = data.canDecide ? 'Noch niemand in diesem Talentpool.' : 'Noch niemand aus deinem Bereich in diesem Talentpool.';
    return `${layoutTitle(`Talentpool: ${esc(data.pool.name)}`, esc(data.pool.purpose || data.pool.description || 'Entwicklung sichtbar machen.'), data.canPropose ? button('+ Vorschlag', 'pool-member', data.pool.id, true) : '')}
      <div class="tr-backrow">${backButton('Alle Talentpools', 'pools')}</div>
      <section class="cards">
        <article class="card wide">${rows.length ? `<div class="talent-list">${rows.join('')}</div>` : `<p class="muted">${esc(empty)}</p>`}</article>
        <article class="card"><h2>Nichts geht verloren</h2><p class="muted">Auch wer entfernt wird, bleibt hier mit Zeitpunkt und Grund nachvollziehbar stehen.</p></article>
      </section>`;
  }

  async function poolForm() {
    const users = (await api('/api/users')).users.filter(person => ['hr_admin', 'hrbp'].includes(person.role));
    openDialog({
      title: 'Talentpool anlegen',
      subtitle: 'Pflichtfelder sind mit * markiert.',
      body: `${inputField('Name *', 'name', { required: true })}
        ${textField('Beschreibung', 'description')}
        ${textField('Zweck', 'purpose')}
        ${selectField('Verantwortlich *', 'responsibleId', option(users, loop.me.id), { hint: 'Diese Person bekommt die Vorschläge zur Entscheidung.' })}`,
      onSubmit: async data => {
        await api('/api/talent-pools', { method: 'POST', body: JSON.stringify(data) });
        toast('Talentpool angelegt.');
        loop.navigate('reviewPools');
      }
    });
  }

  async function poolMemberForm() {
    const [users, list, rights] = await Promise.all([api('/api/users'), periods(), meta()]);
    const people = users.users.filter(person => person.id !== loop.me.id && (rights.canManagePeriods || person.manager_id === loop.me.id));
    if (!people.length) throw new Error('In deinem direkten Team gibt es niemanden, den du vorschlagen kannst.');
    openDialog({
      title: 'Person für den Talentpool vorschlagen',
      subtitle: 'Sich selbst kann niemand vorschlagen.',
      body: `${selectField('Person *', 'employeeId', option(people, '', person => [person.id, `${person.name}${person.title ? ` · ${person.title}` : ''}`]))}
        ${selectField('Periode', 'periodId', `<option value="">Keine Zuordnung</option>${option(list, state.periodId === 'all' ? '' : state.periodId)}`)}
        ${textField('Begründung *', 'reason', { required: true, attributes: 'minlength="10"', hint: 'Mindestens 10 Zeichen.', max: 3000 })}
        ${textField('Entwicklungsplan', 'developmentPlan')}`,
      submitLabel: 'Vorschlagen',
      onSubmit: async data => {
        await api(`/api/talent-pools/${state.poolId}/members`, { method: 'POST', body: JSON.stringify(data) });
        toast('Vorschlag angelegt. HR entscheidet.');
        loop.navigate('reviewPoolDetail');
      }
    });
  }

  async function poolMemberStatus(id) {
    const data = await api(`/api/talent-pools/${state.poolId}/members`);
    const member = data.items.find(item => item.id === Number(id));
    if (!member) throw new Error('Diese Mitgliedschaft gibt es hier nicht mehr.');
    const choices = [['active', 'Aufnehmen'], ['paused', 'Pausieren'], ['completed', 'Beenden'], ['removed', 'Entfernen']];
    openDialog({
      title: `Entscheiden: ${member.employee_name}`,
      subtitle: `Jetzt: ${MEMBERSHIP_LABELS[member.status]}`,
      body: `${selectField('Neuer Stand *', 'status', option(choices, member.status === 'proposed' ? 'active' : member.status, item => item))}
        ${textField('Grund', 'reason', { max: 3000, hint: 'Pflicht beim Entfernen: mindestens 10 Zeichen.' })}
        ${textField('Entwicklungsplan', 'developmentPlan', { value: member.development_plan || '' })}`,
      onSubmit: async form => {
        await api(`/api/talent-pools/memberships/${id}`, { method: 'PATCH', body: JSON.stringify(form) });
        toast('Entscheidung gespeichert.');
        loop.navigate('reviewPoolDetail');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Selbsteinschätzung
  // ---------------------------------------------------------------------------

  const SELF_ASSESSMENT_READERS = 'Sobald du abgibst, lesen sie deine direkte Führungskraft und HR. Hat deine Führungskraft ihre Einschätzung eingereicht, lesen auch die Führungskräfte über ihr mit.';

  function selfForm(current, limits) {
    const { self } = current;
    const actions = formActions('Entwurf speichern', 'self-save', 'Speichern und abgeben', 'self-submit', current.id);
    return `<form class="card wide tr-review-form" id="trSelfReview" data-review-id="${esc(current.id)}">
      <div class="sectionHead"><div><h2>Deine Selbsteinschätzung</h2><p class="muted">Dein Entwurf ist privat: Niemand sieht ihn, auch HR nicht. ${esc(SELF_ASSESSMENT_READERS)}</p><p class="muted">Du kannst jederzeit unvollständig speichern. Zum Abgeben brauchst du beide Werte, je ${esc(limits.reason)} Zeichen Begründung und ${esc(limits.observations)} Zeichen zu deinen Erfolgen.</p></div></div>
      <div class="tr-problems" data-tr-problems role="alert" hidden></div>
      ${actions}
      <div class="two">
        <div>
          ${selectField('Meine Leistung (1 bis 3) *', 'performance', scoreOptions(SELF_SCALES.performance, self.performance))}
          ${requiredTextField('Warum schätze ich meine Leistung so ein? *', 'performanceReason', self.performanceReason, limits.reason)}
        </div>
        <div>
          ${selectField('Meine Entwicklungsperspektive (1 bis 3) *', 'potential', scoreOptions(SELF_SCALES.potential, self.potential))}
          ${requiredTextField('Warum schätze ich meine Entwicklungsperspektive so ein? *', 'potentialReason', self.potentialReason, limits.reason)}
        </div>
      </div>
      ${requiredTextField('Erfolge und Wirkung im Zeitraum *', 'observations', self.observations, limits.observations, 'Worauf bist du stolz? Was hat deine Arbeit bewirkt?')}
      ${textField('Entwicklungsfokus', 'developmentFields', { value: self.developmentFields || '', placeholder: 'Was möchtest du gezielt weiterentwickeln?' })}
      ${textField('Nächste Schritte', 'nextSteps', { value: self.nextSteps || '', placeholder: 'Welche nächsten Schritte wünschst oder planst du?' })}
      ${actions}
    </form>`;
  }

  async function selfAssessmentPage() {
    const data = await api('/api/talent-review/self-reviews');
    const openItems = data.items.filter(item => item.period.status === 'open');
    const current = openItems.find(item => item.id === state.selfReviewId) || openItems[0];
    const past = data.items.filter(item => item.period.status !== 'open');
    const otherOpen = openItems.filter(item => item !== current).map(item => button(item.period.name, 'self-open', item.id)).join(' ');
    const results = button('Meine Ergebnisse', 'my-results');
    if (!current) {
      return `${layoutTitle('Meine Selbsteinschätzung', 'Im Talent Review kannst du deine Arbeit und Entwicklung selbst einschätzen.', results)}
        <section class="cards">
          <article class="card wide"><h2>Gerade ist nichts offen</h2><p class="muted">Sobald HR eine Periode öffnet und dich aufnimmt, schreibst du hier deine Selbsteinschätzung. Du bekommst dann auch eine Aufgabe.</p></article>
          ${past.length ? `<article class="card"><h2>Frühere Perioden</h2>${past.map(item => `<p><b>${esc(item.period.name)}</b><br>${tag(SELF_LABELS, item.self.status)}</p>`).join('')}</article>` : ''}
        </section>`;
    }
    const { self } = current;
    const content = current.canEdit ? selfForm(current, data.limits) : selfAssessmentCard(self, 'employee', 'Deine Selbsteinschätzung');
    return `${layoutTitle('Meine Selbsteinschätzung', `${esc(current.period.name)} · Stichtag ${date(current.period.assessmentDate)} · ${tag(SELF_LABELS, self.status)}`, `${otherOpen} ${results}`)}
      <section class="cards">${content}${supportCard(current.support)}</section>
      <section class="cards">
        <article class="card wide">
          <h2>Was mit deiner Selbsteinschätzung passiert</h2>
          <p class="muted">${esc(SELF_ASSESSMENT_READERS)} Sie hilft im Gespräch. Das Feld in der 9-Box ergibt sich nur aus der Einschätzung deiner Führungskraft und der Kalibrierung.</p>
          ${self.status === 'employee_submitted' ? '<p class="muted">Nach der Abgabe lässt sie sich nicht mehr ändern.</p>' : ''}
        </article>
      </section>`;
  }

  async function saveSelfDraft(form) {
    const body = Object.fromEntries(new FormData(form));
    const result = await api(`/api/talent-review/reviews/${form.dataset.reviewId}/self`, { method: 'PATCH', body: JSON.stringify(body) });
    confirmSaved(form, `Entwurf um ${clockTime()} Uhr gespeichert.`);
    return result;
  }

  async function saveSelfAssessment(form) {
    await whileSaving(form, () => saveSelfDraft(form));
    toast('Entwurf gespeichert. Er bleibt privat, bis du abgibst.');
  }

  async function submitSelfAssessment(form) {
    const submitted = await whileSaving(form, async () => {
      const draft = await saveSelfDraft(form);
      if (draft.missing?.length) {
        showFormProblems(form, draft.missing);
        return false;
      }
      return true;
    });
    if (!submitted) {
      toast('Dein Entwurf ist gespeichert. Zum Abgeben fehlt noch etwas.', 'error');
      return;
    }
    confirmDialog({
      title: 'Selbsteinschätzung abgeben?',
      message: `<p>${esc(SELF_ASSESSMENT_READERS)}</p><p>Danach kannst du sie nicht mehr ändern.</p>`,
      confirmLabel: 'Verbindlich abgeben',
      onConfirm: async () => {
        await api(`/api/talent-review/reviews/${form.dataset.reviewId}/self/submit`, { method: 'POST' });
        toast('Selbsteinschätzung abgegeben.');
        loop.navigate('reviewSelfAssessment');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Entwicklungsmaßnahmen
  // ---------------------------------------------------------------------------

  async function decisionPage() {
    const data = await api('/api/development-decisions');
    const rows = data.items.map(item => `<div class="talent-item">
      <div>
        <b>${esc(item.employee_name)} · ${esc(item.decision_label)}</b>
        <small>${esc(item.description)} · Verantwortlich: ${esc(item.responsible_name || '–')} · bis ${date(item.target_date)}</small>
        ${item.goal_title ? `<p class="tr-note">Verknüpftes Entwicklungsziel: ${esc(item.goal_title)}</p>` : ''}
      </div>
      <div class="tr-item-actions">${tag(DECISION_LABELS, item.status)} ${item.canEdit ? button('Stand ändern', 'decision-status', item.id) : ''}</div>
    </div>`);
    return `${layoutTitle('Entwicklungsmaßnahmen', 'Was aus dem Talent Review folgt, wer es umsetzt und bis wann.', data.canCreate ? button('+ Maßnahme', 'decision-create', '', true) : '')}
      <section class="cards">
        <article class="card wide">${rows.length ? `<div class="talent-list">${rows.join('')}</div>` : '<p class="muted">Noch keine Entwicklungsmaßnahmen.</p>'}</article>
        <article class="card"><h2>Verknüpfung mit Zielen</h2><p class="muted">Auf Wunsch entsteht aus einer Maßnahme ein Entwicklungsziel. Die Person nimmt es wie jedes andere Ziel an.</p></article>
      </section>`;
  }

  async function decisionForm(reviewId = null) {
    const [reviewData, users, metadata, competencies] = await Promise.all([api('/api/talent-review/reviews'), api('/api/users'), meta(), api('/api/competencies')]);
    const editable = reviewData.items.filter(item => item.employee_id !== loop.me.id && (metadata.canManagePeriods || item.employee_manager_id === loop.me.id));
    const selectedReview = editable.find(item => item.id === Number(reviewId));
    const reviews = reviewId ? (selectedReview ? [selectedReview] : []) : editable;
    if (!reviews.length) throw new Error('Gerade gibt es keine Einschätzung, für die du eine Maßnahme anlegen kannst.');
    openDialog({
      title: 'Entwicklungsmaßnahme anlegen',
      subtitle: 'Pflichtfelder sind mit * markiert.',
      body: `${selectField('Einschätzung *', 'reviewId', option(reviews, reviewId, item => [item.id, `${item.employee_name} · ${item.period_name || ''}`]))}
        ${selectField('Maßnahme *', 'decisionType', option(Object.entries(metadata.decisionTypes), '', item => item))}
        ${textField('Beschreibung *', 'description', { required: true, attributes: 'minlength="10"', hint: 'Mindestens 10 Zeichen.' })}
        ${selectField('Verantwortlich', 'responsibleId', `<option value="">Noch niemand</option>${option(users.users, '')}`, { hint: 'Diese Person bekommt eine Aufgabe.' })}
        <div class="two">
          <div>${inputField('Beginn', 'startDate', { type: 'date' })}</div>
          <div>${inputField('Zieltermin', 'targetDate', { type: 'date' })}</div>
        </div>
        ${selectField('Passende Kompetenz', 'competencyId', `<option value="">Keine</option>${option(competencies.items || [], '')}`)}
        <label class="checkline"><input type="checkbox" name="createGoal"> Zusätzlich als Entwicklungsziel anlegen</label>
        ${inputField('Titel des Entwicklungsziels', 'goalTitle', { hint: 'Nur nötig, wenn du ein Entwicklungsziel anlegst.' })}`,
      onSubmit: async (data, form) => {
        await api('/api/development-decisions', { method: 'POST', body: JSON.stringify({ ...data, createGoal: new FormData(form).has('createGoal') }) });
        toast('Entwicklungsmaßnahme angelegt.');
        loop.navigate(reviewId ? 'reviewDetail' : 'reviewDecisions');
      }
    });
  }

  async function decisionStatusForm(id) {
    const data = await api('/api/development-decisions');
    const decision = data.items.find(item => item.id === Number(id));
    if (!decision) throw new Error('Diese Maßnahme gibt es hier nicht mehr.');
    openDialog({
      title: 'Stand der Maßnahme ändern',
      subtitle: `${decision.employee_name} · ${decision.decision_label}`,
      body: `${selectField('Stand *', 'status', option(Object.entries(DECISION_LABELS), decision.status, item => item))}
        ${textField('Notiz', 'reason', { max: 1000 })}`,
      onSubmit: async form => {
        await api(`/api/development-decisions/${id}`, { method: 'PATCH', body: JSON.stringify(form) });
        toast('Stand der Maßnahme geändert.');
        loop.navigate('reviewDecisions');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Meine Entwicklung
  // ---------------------------------------------------------------------------

  async function myResults() {
    const data = await api('/api/talent-review/me');
    const results = data.reviews.map(item => `<div class="talent-item">
      <div><b>${esc(item.periodName)}</b><small>${esc(scoreText(item.performance, item.potential))}${item.boxLabel ? ` · ${esc(item.boxLabel)}` : ''}</small></div>
      <div class="tr-item-actions">${button('Details', 'review-open', item.id)}</div>
    </div>`);
    const decisions = data.decisions.map(item => `<div class="talent-item">
      <div><b>${esc(item.decision_label)}</b><small>${esc(item.description)} · Zieltermin ${date(item.target_date)}</small></div>
      <div class="tr-item-actions">${tag(DECISION_LABELS, item.status)}</div>
    </div>`);
    return `${layoutTitle('Meine Entwicklung', 'Deine Ergebnisse aus dem Talent Review siehst du hier, sobald HR sie freigegeben hat.')}
      <section class="cards">
        <article class="card wide"><h2>Freigegebene Ergebnisse</h2>${results.length ? `<div class="talent-list">${results.join('')}</div>` : '<p class="muted">Für dich sind noch keine Ergebnisse freigegeben.</p>'}</article>
        <article class="card"><h2>So liest du dein Ergebnis</h2><p class="muted">Leistung und Potenzial gehen von 1 bis 3. Daraus ergibt sich eines von neun Feldern, die 9-Box. Es beschreibt den heutigen Stand und hilft, die nächsten Schritte zu planen.</p></article>
      </section>
      <section class="cards">
        <article class="card wide"><h2>Meine Maßnahmen</h2>${decisions.length ? `<div class="talent-list">${decisions.join('')}</div>` : '<p class="muted">Keine Maßnahmen geplant.</p>'}</article>
      </section>`;
  }

  // ---------------------------------------------------------------------------
  // Aktionen
  // ---------------------------------------------------------------------------

  const managerFormElement = () => document.querySelector('#trManagerReview');
  const selfFormElement = () => document.querySelector('#trSelfReview');

  const ACTIONS = {
    'period-create': () => periodForm(),
    'period-edit': async id => periodForm((await periods()).find(period => period.id === Number(id))),
    'period-status': id => periodStatusDialog(id),
    'period-people': id => periodPeopleDialog(id),
    'period-release': id => periodReleaseDialog(id),
    'period-finalize-all': id => finalizeAllDialog(id),
    reviews: () => loop.navigate('reviewList'),
    'reviews-period': id => {
      state.periodId = Number(id);
      state.statusFilter = null;
      loop.navigate('reviewList');
    },
    matrix: () => loop.navigate('reviewMatrix'),
    'matrix-reset': () => {
      state.matrixFilters = emptyMatrixFilters();
      loop.navigate('reviewMatrix');
    },
    'my-results': () => loop.navigate('myReviewResults'),
    'review-open': id => {
      state.reviewId = Number(id);
      loop.navigate('reviewDetail');
    },
    'self-open': id => {
      state.selfReviewId = Number(id);
      loop.navigate('reviewSelfAssessment');
    },
    'self-save': () => saveSelfAssessment(selfFormElement()),
    'self-submit': () => submitSelfAssessment(selfFormElement()),
    'review-save': () => saveManagerReview(managerFormElement()),
    'review-submit': () => submitManagerReview(managerFormElement()),
    'review-return': id => returnReviewDialog(id),
    'review-calibrate': id => calibrateDialog(id),
    'review-finalize': id => finalizeDialog(id),
    sessions: () => loop.navigate('reviewSessions'),
    'session-create': () => sessionForm(),
    'session-open': id => {
      state.sessionId = Number(id);
      loop.navigate('reviewSessionDetail');
    },
    'session-status': () => sessionStatusForm(),
    'session-participant': () => sessionParticipantForm(),
    'session-case': () => sessionCaseForm(),
    'session-cases-all': () => sessionAllCasesDialog(),
    pools: () => loop.navigate('reviewPools'),
    'pool-create': () => poolForm(),
    'pool-open': id => {
      state.poolId = Number(id);
      loop.navigate('reviewPoolDetail');
    },
    'pool-proposal-open': async id => {
      state.poolId = (await api(`/api/talent-pools/memberships/${id}`)).poolId;
      loop.navigate('reviewPoolDetail');
    },
    'pool-member': () => poolMemberForm(),
    'pool-member-status': id => poolMemberStatus(id),
    decisions: () => loop.navigate('reviewDecisions'),
    'decision-create': async id => {
      // Nach dem Anlegen lädt die Seite neu. Ein offener Entwurf wird vorher gesichert, damit nichts verloren geht.
      const form = managerFormElement();
      if (form && state.hasUnsavedChanges) await saveManagerReview(form);
      return decisionForm(id || null);
    },
    'decision-status': id => decisionStatusForm(id)
  };

  function bind() {
    state.hasUnsavedChanges = false;
    document.querySelectorAll('[data-tr-action]').forEach(element => {
      element.onclick = async () => {
        const run = ACTIONS[element.dataset.trAction];
        if (!run || element.disabled) return;
        forgetOtherUser();
        element.disabled = true;
        try {
          await run(element.dataset.id);
        } catch (error) {
          toast(error.message || 'Das hat nicht geklappt.', 'error');
        } finally {
          element.disabled = false;
        }
      };
    });
    document.querySelectorAll('.tr-review-form').forEach(form => {
      form.addEventListener('input', event => {
        state.hasUnsavedChanges = true;
        const minimum = Number(event.target.dataset?.minLength);
        if (minimum) event.target.parentElement.querySelectorAll('[data-tr-counter]').forEach(counter => {
          if (counter.previousElementSibling === event.target) counter.textContent = counterText(event.target.value.trim().length, minimum);
        });
      });
    });
    document.querySelector('#trReviewPeriod')?.addEventListener('change', event => {
      state.periodId = Number(event.target.value) || 'all';
      loop.navigate('reviewList');
    });
    const filterReviewRows = () => {
      const query = document.querySelector('#trReviewSearch')?.value || '';
      const manager = document.querySelector('#trReviewManager')?.value || '';
      let shown = 0;
      document.querySelectorAll('[data-review-row]').forEach(row => {
        const visible = ui.matches(row.dataset.name, query) && (!manager || row.dataset.manager === manager);
        row.style.display = visible ? '' : 'none';
        if (visible) shown += 1;
      });
      const count = document.querySelector('#trReviewCount');
      if (count) count.textContent = ui.plural(shown, 'Einschätzung', 'Einschätzungen');
    };
    document.querySelector('#trReviewSearch')?.addEventListener('input', filterReviewRows);
    document.querySelector('#trReviewManager')?.addEventListener('change', filterReviewRows);
    document.querySelector('#trReviewStatus')?.addEventListener('change', event => {
      state.statusFilter = event.target.value || null;
      loop.navigate('reviewList');
    });
    document.querySelectorAll('[data-tr-matrix-filter]').forEach(element => element.addEventListener('change', event => {
      const key = event.currentTarget.dataset.trMatrixFilter;
      const { value } = event.currentTarget;
      if (key === 'periodId') {
        state.matrixPeriodId = Number(value) || 'all';
        state.matrixFilters.sessionId = null;
      } else {
        state.matrixFilters[key] = value || null;
      }
      loop.navigate('reviewMatrix');
    }));
  }

  // Ohne das würde der Browser das Formular absenden: Die Texte stünden in der Adresszeile und die Seite lädt neu.
  document.addEventListener('submit', event => {
    if (!event.target.matches('.tr-review-form')) return;
    event.preventDefault();
    if (event.target.getAttribute('aria-busy') === 'true') return;
    const save = event.target.id === 'trSelfReview' ? saveSelfAssessment : saveManagerReview;
    save(event.target).catch(error => toast(error.message || 'Speichern hat nicht geklappt.', 'error'));
  });

  // Wer ungespeicherte Eingaben hat, wird vor dem Verlassen gefragt.
  document.addEventListener('click', event => {
    if (!state.hasUnsavedChanges || !event.target.closest('[data-view],.tr-back,#logout')) return;
    if (window.confirm('Du hast ungespeicherte Eingaben. Trotzdem verlassen?')) {
      state.hasUnsavedChanges = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener('beforeunload', event => {
    if (state.hasUnsavedChanges) event.preventDefault();
  });
  // Das Zurück des Browsers lässt sich nicht aufhalten. Damit nichts verloren geht, sichert es den Entwurf.
  window.addEventListener('popstate', () => {
    const form = document.querySelector('.tr-review-form');
    if (!form || !state.hasUnsavedChanges) return;
    state.hasUnsavedChanges = false;
    const save = form.id === 'trSelfReview' ? saveSelfDraft : saveManagerDraft;
    save(form)
      .then(() => toast('Dein Entwurf wurde gesichert.'))
      .catch(error => toast(error.message || 'Speichern hat nicht geklappt.', 'error'));
  });

  loop.registerTaskAction(task => {
    const open = (label, action) => `<button type="button" class="btn" data-tr-action="${action}" data-id="${esc(task.entity_id)}">${esc(label)}</button>`;
    const actions = {
      talent_review_start: () => open('Schreiben', 'review-open'),
      talent_review_returned: () => open('Überarbeiten', 'review-open'),
      talent_review_submitted: () => open('Öffnen', 'review-open'),
      talent_review_finalized: () => open('Ansehen', 'review-open'),
      talent_review_calibration: () => open('Sitzung öffnen', 'session-open'),
      talent_pool_proposal: () => open('Entscheiden', 'pool-proposal-open'),
      development_decision: () => open('Öffnen', 'decisions'),
      talent_review_self_assessment: () => open('Schreiben', 'self-open')
    };
    return actions[task.type]?.() || '';
  });

  const addressOf = key => ({
    get: () => state[key],
    set: id => {
      // Die Nummer kommt, bevor die Seite aufgebaut wird, und gehört schon zur angemeldeten Person.
      forgetOtherUser();
      state[key] = id;
    }
  });
  loop.registerAddress({
    reviewDetail: addressOf('reviewId'),
    reviewSelfAssessment: addressOf('selfReviewId'),
    reviewSessionDetail: addressOf('sessionId'),
    reviewPoolDetail: addressOf('poolId')
  });

  const page = render => (...args) => {
    forgetOtherUser();
    return render(...args);
  };
  window.talentReviewPages = {
    dashboard: page(dashboard),
    periods: page(periodPage),
    reviews: page(reviewPage),
    reviewDetail: page(reviewDetail),
    selfAssessment: page(selfAssessmentPage),
    sessions: page(sessionPage),
    sessionDetail: page(sessionDetail),
    matrix: page(matrixPage),
    pools: page(poolPage),
    poolDetail: page(poolDetail),
    decisions: page(decisionPage),
    myResults: page(myResults)
  };
  window.talentReviewBind = bind;
  loop.openTalentReview = id => {
    forgetOtherUser();
    state.reviewId = Number(id);
    loop.navigate('reviewDetail');
  };
})();
