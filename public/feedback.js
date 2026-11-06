(() => {
  const { ui } = window.loop;
  const { esc } = ui;
  const api = (url, options) => window.loop.api(url, options);
  const send = (url, method, body = {}) => api(url, { method, body: JSON.stringify(body) });
  const currentUser = () => window.loop.me;
  const isHrPerson = () => ['hr_admin', 'hrbp', 'super_admin'].includes(currentUser().role);
  const isLeader = () => ['manager', 'director'].includes(currentUser().role);
  const go = target => window.loop.navigate(target);

  // Die Nummern kommen beim Neuladen und im neuen Reiter aus der Adresse (siehe registerAddress unten).
  const state = { cycleId: null, participantId: null, invitationId: null, questionnaireId: null };

  const labels = {
    draft: 'Entwurf',
    nomination: 'Vorschläge sammeln',
    open: 'Feedback läuft',
    evaluation: 'Auswertung',
    completed: 'Abgeschlossen',
    archived: 'Archiviert',
    planned: 'Geplant',
    nominating: 'Vorschläge laufen',
    feedback_open: 'Feedback läuft',
    in_evaluation: 'In Auswertung',
    cancelled: 'Abgesagt',
    pending: 'Noch nicht berechnet',
    calculated: 'Berechnet, noch nicht geprüft',
    reviewed: 'Geprüft',
    released_for_manager: 'Für die Führungskraft freigegeben',
    released_for_employee: 'Für die Person freigegeben',
    closed: 'Bericht abgeschlossen',
    proposed: 'Vorgeschlagen',
    approved: 'Bestätigt',
    rejected: 'Vorschlag abgelehnt',
    invited: 'Eingeladen',
    started: 'In Bearbeitung',
    submitted: 'Abgegeben',
    declined: 'Anfrage abgelehnt',
    self: 'Selbsteinschätzung',
    manager: 'Führungskraft',
    peer: 'Kolleg:innen',
    direct_report: 'Direkt unterstellte Personen',
    stakeholder: 'Weitere Personen',
    anonymous_combined: 'Mehrere Gruppen zusammen'
  };
  const developmentLabels = {
    development_goal: 'Entwicklungsziel',
    coaching: 'Coaching',
    mentoring: 'Mentoring',
    training: 'Weiterbildung',
    job_shadowing: 'Hospitation',
    project_assignment: 'Projektaufgabe',
    job_rotation: 'Wechsel auf Zeit in einen anderen Bereich',
    follow_up_feedback: 'Erneutes Feedback'
  };
  const questionTypeLabels = { rating: 'Bewertung (1–5)', text: 'Freitext' };
  const historyLabels = {
    feedback_participant_added: 'In die Runde aufgenommen',
    feedback_nomination_proposed: 'Person vorgeschlagen',
    feedback_nomination_approved: 'Vorschlag bestätigt',
    feedback_nomination_rejected: 'Vorschlag abgelehnt',
    feedback_nominations_completed: 'Vorschläge abgeschlossen',
    feedback_invitation_created: 'Anfrage verschickt',
    feedback_submitted: 'Feedback abgegeben',
    feedback_invitation_declined: 'Anfrage abgelehnt',
    feedback_reopened: 'Abgabe wieder geöffnet',
    feedback_result_calculated: 'Bericht berechnet',
    feedback_result_reviewed: 'Bericht geprüft',
    feedback_result_released_for_manager: 'Für die Führungskraft freigegeben',
    feedback_result_released_for_employee: 'Für die Person freigegeben',
    feedback_result_closed: 'Bericht abgeschlossen',
    feedback_result_meeting_completed: 'Ergebnisgespräch vorbereitet',
    feedback_development_action_created: 'Entwicklungsmaßnahme festgehalten',
    feedback_manager_changed: 'Führungskraft gewechselt'
  };
  const RELEASED_FOR_MANAGER = ['released_for_manager', 'released_for_employee', 'closed'];
  const RELEASED_FOR_EMPLOYEE = ['released_for_employee', 'closed'];
  const GOOD_STATES = ['completed', 'submitted', 'approved', 'reviewed', 'released_for_employee', 'released_for_manager', 'closed'];
  const BAD_STATES = ['rejected', 'declined', 'cancelled'];

  const pretty = value => labels[value] || value || '–';
  const tag = value => `<span class="tag ${BAD_STATES.includes(value) ? 'danger' : GOOD_STATES.includes(value) ? '' : 'focus'}">${esc(pretty(value))}</span>`;
  const date = value => (value ? esc(ui.date(value)) : '–');
  const score = value => ui.number(value, 2);
  const signedScore = value => (value > 0 ? `+${score(value)}` : score(value));
  const todayText = () => new Date().toISOString().slice(0, 10);
  const daysFromToday = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const dateTime = value => {
    const text = String(value || '');
    const parsed = new Date(/[zZ]$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed.getTime()) ? esc(text) : esc(parsed.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }));
  };
  const button = (label, action, id = '', primary = false, extraClass = '') => `<button type="button" class="btn ${primary ? 'primary' : ''} ${extraClass}" data-fb-action="${esc(action)}"${id !== '' ? ` data-id="${esc(id)}"` : ''}>${esc(label)}</button>`;
  const header = (heading, subtitle, actions = '') => `<header class="top"><div><h1>${esc(heading)}</h1><p>${esc(subtitle)}</p></div><div class="fb-actions">${actions}</div></header>`;
  const option = (value, label, selected) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
  const personOptions = (people, selected = '') => people.map(person => option(person.id, person.title ? `${person.name} · ${person.title}` : person.name, selected)).join('');
  const modal = (title, body, onSubmit, submitLabel = 'Speichern', subtitle = 'Pflichtfelder sind mit * markiert.') => ui.modal({ title, subtitle, body, onSubmit, submitLabel });
  const EXPIRED_TAG = '<span class="tag danger">Frist abgelaufen</span>';

  /** Eine Zeile einer Liste. Die Zeilen in details sind schon maskiert, weil sie Daten und Marken enthalten dürfen. */
  function listRow(heading, details, actions = '') {
    return `<div class="talent-item">
      <div><b>${esc(heading)}</b>${details.filter(Boolean).map(line => `<small>${line}</small>`).join('')}</div>
      <div class="fb-actions">${actions}</div>
    </div>`;
  }

  const list = (rows, emptyMessage) => (rows.length ? `<div class="talent-list">${rows.join('')}</div>` : ui.empty(emptyMessage));
  const moveButton = (action, id, label, arrow) => `<button type="button" class="btn" data-fb-action="${esc(action)}" data-id="${esc(id)}" aria-label="${esc(label)}">${arrow}</button>`;

  function confirmAction({ title, text, confirmLabel, onConfirm }) {
    ui.modal({
      title,
      body: `<p>${esc(text)}</p><button type="button" class="btn full" data-fb-cancel>Abbrechen</button>`,
      submitLabel: confirmLabel,
      onSubmit: onConfirm
    });
    document.querySelector('[data-fb-cancel]').onclick = ui.closeModal;
  }

  const deadlineOf = cycle => (cycle.status === 'nomination' ? cycle.nomination_deadline : cycle.feedback_deadline);
  const deadlinePassed = cycle => ['nomination', 'open'].includes(cycle.status) && deadlineOf(cycle) < todayText();

  // ------------------------------------------------------------------ Übersicht

  async function dashboard() {
    const data = await api('/api/feedback/dashboard');
    const openRequests = data.invitations.filter(item => ['invited', 'started'].includes(item.status));
    const showTeam = isLeader() || data.teamCycles.length > 0;
    const intro = isHrPerson()
      ? 'Plane Feedbackrunden, schütze die Anonymität und begleite die nächsten Schritte.'
      : isLeader()
        ? 'Prüfe Vorschläge, gib Feedback und bereite Ergebnisgespräche vor.'
        : 'Gib Kolleg:innen Feedback und sieh dir an, wie andere dich erleben.';

    const requestRow = item => {
      const expired = item.reminder === 'overdue';
      const reminder = expired ? EXPIRED_TAG : item.reminder === 'due_soon' ? '<span class="tag focus">Bald fällig</span>' : '';
      const openButton = expired ? '' : button(item.status === 'started' ? 'Weiter ausfüllen' : 'Feedback geben', 'invitation-open', item.id, true);
      return listRow(
        item.employeeName,
        [`${esc(item.cycleName)} · ${esc(pretty(item.feedbackGroup))} · bis ${date(item.deadline)}`, expired ? 'HR kann die Frist verlängern.' : ''],
        reminder + openButton
      );
    };

    const ownRow = item => {
      const released = RELEASED_FOR_EMPLOYEE.includes(item.result_status);
      const collecting = item.cycle_status === 'nomination' && !item.nomination_completed;
      return listRow(
        item.cycle_name,
        [`${esc(pretty(item.status))} · ${released ? 'Bericht freigegeben' : 'Bericht noch nicht freigegeben'}`],
        button(collecting ? 'Personen vorschlagen' : 'Ansehen', 'participant-open', item.id, collecting)
          + (released ? button('Bericht öffnen', 'result-open', item.id, true) : '')
      );
    };

    const teamRow = item => listRow(
      item.employee_name,
      [`${esc(item.cycle_name)} · ${esc(pretty(item.status))}`],
      button(item.cycle_status === 'nomination' ? 'Vorschläge prüfen' : 'Öffnen', 'participant-open', item.id)
        + (RELEASED_FOR_MANAGER.includes(item.result_status) ? button('Bericht', 'result-open', item.id, true) : '')
    );
    const teamCard = showTeam
      ? `<article class="card"><h2>Mein Team</h2>${list(data.teamCycles.map(teamRow), 'Niemand aus deinem Team ist gerade in einer Feedbackrunde.')}</article>`
      : `<article class="card"><h2>Wofür ist der Bericht?</h2>
          <p class="muted">Der Bericht hilft dir beim Nachdenken über deine Entwicklung. Er führt nicht automatisch zu einer Bewertung deiner Leistung.</p>
        </article>`;

    const hrRow = cycle => {
      const running = ['nomination', 'open'].includes(cycle.status);
      return listRow(
        cycle.name,
        [`${esc(pretty(cycle.status))}${running ? ` · Frist ${date(deadlineOf(cycle))}` : ''}`],
        (running && cycle.deadlineState === 'overdue' ? EXPIRED_TAG : '') + button('Öffnen', 'cycle-open', cycle.id)
      );
    };
    const hrCard = isHrPerson()
      ? `<section class="cards"><article class="card wide"><h2>Feedbackrunden</h2>${list(data.hrCycles.map(hrRow), 'Es gibt noch keine Feedbackrunde.')}</article></section>`
      : '';

    return `${header('360° Feedback', intro)}
      <section class="cards">
        ${ui.stat('Offene Anfragen', data.metrics.openInvitations, 'warten auf deine Rückmeldung')}
        ${ui.stat('Freigegebene Berichte', data.metrics.releasedReports, 'über dich')}
        ${showTeam ? ui.stat('Laufend in deinem Team', data.metrics.teamOpen, data.metrics.teamOpen === 1 ? 'Person' : 'Personen') : ui.stat('Deine Feedbackrunden', data.ownCycles.length, 'an denen du teilnimmst')}
      </section>
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead"><div><small class="muted">FÜR DICH ZU TUN</small><h2>Feedbackanfragen</h2></div></div>
          ${list(openRequests.map(requestRow), 'Gerade wartet niemand auf deine Rückmeldung.')}
        </article>
        <article class="card"><h2>So funktioniert 360° Feedback</h2>
          <p class="muted">Eine Person bekommt Rückmeldung aus mehreren Blickwinkeln: von sich selbst, von der Führungskraft und von anderen. Antworten von Kolleg:innen erscheinen erst ab mindestens drei Rückmeldungen, zusammengefasst und ohne Namen.</p>
        </article>
      </section>
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead"><h2>Dein 360° Feedback</h2></div>
          ${list(data.ownCycles.map(ownRow), 'Du bist gerade in keiner Feedbackrunde.')}
        </article>
        ${teamCard}
      </section>
      ${hrCard}`;
  }

  // ------------------------------------------------------------------ Feedbackrunden (HR)

  async function cycles() {
    if (!isHrPerson()) throw Error('Nur HR verwaltet Feedbackrunden.');
    const data = await api('/api/feedback/cycles');
    const row = item => listRow(
      item.name,
      [
        `${date(item.start_date)} bis ${date(item.end_date)} · ${esc(item.questionnaire_name)}, Version ${esc(item.questionnaire_version)} · ${esc(ui.plural(item.participant_count, 'Person', 'Personen'))}`,
        esc(item.description || '')
      ],
      tag(item.status) + (deadlinePassed(item) ? EXPIRED_TAG : '') + button('Öffnen', 'cycle-open', item.id, true)
    );
    return `${header('Feedbackrunden', 'Eine Runde legt fest, wer in welchem Zeitraum 360° Feedback bekommt.', button('+ Feedbackrunde', 'cycle-create', '', true))}
      <section class="cards">
        <article class="card wide">${list(data.items.map(row), 'Es gibt noch keine Feedbackrunde.')}</article>
        <article class="card"><h2>Die Schritte einer Runde</h2>
          <p><b>Entwurf</b><br><span class="muted">Personen aufnehmen und Fristen festlegen.</span></p>
          <p><b>Vorschläge sammeln</b><br><span class="muted">Wer soll Feedback geben? Die Führungskraft bestätigt.</span></p>
          <p><b>Feedback läuft</b><br><span class="muted">Alle Eingeladenen antworten.</span></p>
          <p><b>Auswertung</b><br><span class="muted">Berichte berechnen, prüfen und freigeben.</span></p>
        </article>
      </section>`;
  }

  async function cycleDetail() {
    if (!isHrPerson()) throw Error('Nur HR verwaltet Feedbackrunden.');
    if (!state.cycleId) return cycles();
    const { cycle } = await api(`/api/feedback/cycles/${state.cycleId}`);
    const running = ['nomination', 'open'].includes(cycle.status);
    const canAddPeople = ['draft', 'nomination'].includes(cycle.status);
    const expired = deadlinePassed(cycle);
    const actions = [
      tag(cycle.status),
      canAddPeople ? button('+ Person aufnehmen', 'participant-add', '', true) : '',
      cycle.status === 'draft' ? button('Bearbeiten', 'cycle-edit') : '',
      running ? button('Frist verlängern', 'cycle-deadlines') : '',
      ['draft', 'nomination', 'open', 'evaluation', 'completed'].includes(cycle.status) ? button('Nächster Schritt', 'cycle-status') : '',
      button('Zurück', 'cycles')
    ].join(' ');
    const alert = expired
      ? `<p class="fb-alert" role="status"><b>Die Frist ist am ${date(deadlineOf(cycle))} abgelaufen.</b> ${cycle.status === 'open' ? 'Niemand kann mehr antworten.' : 'Niemand kann mehr Personen vorschlagen.'} Verlängere die Frist oder gehe zum nächsten Schritt.</p>`
      : '';
    const row = item => {
      const reportButtons = [
        item.permissions.calculateResult ? button('Berechnen', 'result-calculate', item.id, true) : '',
        item.permissions.readResult ? button('Bericht', 'result-open', item.id, true) : ''
      ].join(' ');
      return listRow(
        item.employee_name,
        [
          `${item.employee_title ? `${esc(item.employee_title)} · ` : ''}Führungskraft: ${esc(item.manager_name || 'keine')}`,
          `${esc(`${item.submitted} von ${item.invitations} abgegeben`)} · ${esc(pretty(item.status))}`
        ],
        tag(item.result_status) + button('Teilnahme', 'participant-open', item.id) + reportButtons
      );
    };
    return `${header(cycle.name, 'Personen, Vorschläge, Fortschritt und Berichte an einem Ort.', actions)}
      ${alert}
      <section class="cards">
        ${ui.stat('Personen', cycle.participants.length, 'bekommen Feedback')}
        ${ui.stat('Eingeladen', cycle.participants.reduce((total, item) => total + item.invitations, 0), 'Anfragen')}
        ${ui.stat('Abgegeben', cycle.participants.reduce((total, item) => total + item.submitted, 0), 'Rückmeldungen')}
      </section>
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead"><div>
            <h2>Personen in dieser Runde</h2>
            <p class="muted">Nur HR sieht Namen und Zeitpunkte der Abgaben. Führungskraft und betroffene Person sehen nur Zahlen je Gruppe. Berichte nennen keine Namen von Kolleg:innen.</p>
          </div></div>
          ${list(cycle.participants.map(row), 'Noch niemand ist in dieser Runde.')}
        </article>
        <article class="card"><h2>Fristen</h2>
          <p><b>Vorschläge bis</b><br>${date(cycle.nomination_deadline)}</p>
          <p><b>Feedback bis</b><br>${date(cycle.feedback_deadline)}</p>
          <p><b>Anonymität</b><br>Antworten erscheinen ab ${esc(cycle.anonymous_minimum)} Rückmeldungen.</p>
        </article>
      </section>`;
  }

  // ------------------------------------------------------------------ Teilnahme

  function groupCounts(groups) {
    return groups.map(item => {
      const counted = item.submitted === null
        ? `${ui.plural(item.invited, 'Person', 'Personen')} eingeladen`
        : `${item.submitted} von ${item.invited} abgegeben${item.declined ? `, ${item.declined} abgelehnt` : ''}`;
      return `<p><b>${esc(pretty(item.group))}</b><br><span class="muted">${esc(counted)}</span></p>`;
    }).join('');
  }

  function progressCard(progress, permissions, minimum) {
    const hidden = progress.groups.some(item => item.submitted === null);
    return `<article class="card"><h2>Fortschritt</h2>
      ${groupCounts(progress.groups) || ui.empty('Es gibt noch keine Anfragen.')}
      ${hidden ? `<p class="muted">Gruppen unter ${esc(minimum)} Personen zeigen keine Zahl der Abgaben, damit niemand erkennbar wird.</p>` : ''}
      ${permissions.viewHistory ? '' : '<p class="muted">Du siehst nur Zahlen je Gruppe. Wer wann abgegeben hat, sieht nur HR.</p>'}
    </article>`;
  }

  async function participant() {
    if (!state.participantId) return dashboard();
    const data = await api(`/api/feedback/participants/${state.participantId}/nominations`);
    const { participant: person, nominations, progress, permissions } = data;
    const isOwn = person.employee_id === currentUser().id;
    const history = permissions.viewHistory ? (await api(`/api/feedback/history/${person.id}`)).items : null;
    const actions = [
      isHrPerson() && !isOwn ? button('Zur Feedbackrunde', 'cycle-open', person.cycle_id) : button('Zur Übersicht', 'feedback-dashboard'),
      permissions.proposeNominations ? button('+ Person vorschlagen', 'nomination-create', '', true) : '',
      permissions.finishNominating ? button('Vorschläge abschließen', 'nominations-complete') : '',
      permissions.calculateResult ? button('Bericht berechnen', 'result-calculate', person.id, true) : '',
      permissions.readResult ? button('Bericht', 'result-open', person.id, true) : ''
    ].join(' ');
    const expired = person.cycle_status === 'nomination' && person.nomination_deadline < todayText();
    const row = item => {
      const decide = permissions.decideNominations && item.status === 'proposed'
        ? button('Bestätigen', 'nomination-approve', item.id, true) + button('Ablehnen', 'nomination-reject', item.id)
        : '';
      return listRow(
        item.giver_name,
        [
          `${item.giver_title ? `${esc(item.giver_title)} · ` : ''}${esc(pretty(item.feedback_group))} · vorgeschlagen von ${esc(item.proposer_name)}`,
          item.rejection_reason ? `Begründung: ${esc(item.rejection_reason)}` : ''
        ],
        tag(item.status) + decide
      );
    };
    const historyRow = item => listRow(
      historyLabels[item.action] || 'Änderung',
      [`${dateTime(item.created_at)}${item.actor_name ? ` · ${esc(item.actor_name)}` : ''}${item.metadata?.group ? ` · ${esc(pretty(item.metadata.group))}` : ''}`]
    );
    const historyCard = history
      ? `<section class="cards"><article class="card wide"><details class="fb-history">
          <summary>Verlauf anzeigen (nur für HR, ${esc(ui.plural(history.length, 'Eintrag', 'Einträge'))})</summary>
          ${list(history.map(historyRow), 'Noch kein Eintrag.')}
        </details></article></section>`
      : '';
    const proposalHint = permissions.proposeNominations ? `Bis ${date(person.nomination_deadline)} kannst du Personen vorschlagen. ` : '';
    return `${header(isOwn ? 'Dein 360° Feedback' : `360° Feedback für ${person.employee_name}`, `${person.cycle_name} · ${pretty(person.cycle_status)}`, actions)}
      ${expired ? `<p class="fb-alert" role="status"><b>Die Frist für Vorschläge ist am ${date(person.nomination_deadline)} abgelaufen.</b> HR kann sie verlängern.</p>` : ''}
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead"><div>
            <h2>Wer soll Feedback geben?</h2>
            <p class="muted">${proposalHint}In welche Gruppe jemand gehört, ergibt sich aus der Organisation.</p>
          </div></div>
          ${list(nominations.map(row), 'Noch niemand vorgeschlagen.')}
        </article>
        ${progressCard(progress, permissions, person.anonymous_minimum)}
      </section>
      ${historyCard}`;
  }

  // ------------------------------------------------------------------ Fragebögen

  async function questionnaires() {
    if (!isHrPerson()) throw Error('Nur HR verwaltet Fragebögen.');
    const data = await api('/api/feedback/questionnaires');
    const card = item => `<article class="card">
        <small class="muted">${item.active ? 'AKTIV' : 'INAKTIV'} · VERSION ${esc(item.version)}</small>
        <h2>${esc(item.name)}</h2>
        <p class="muted">${esc(item.description || 'Ohne Beschreibung')}</p>
        <p>${item.used || item.frozen ? '<span class="tag focus">Wird verwendet, nicht mehr änderbar</span>' : '<span class="tag">Änderbar</span>'}</p>
        ${button('Öffnen', 'questionnaire-open', item.id, true)}
      </article>`;
    return `${header('Fragebögen', 'Sobald eine Feedbackrunde einen Fragebogen verwendet, bleibt er unverändert. Änderungen gehen dann über eine neue Version.', button('+ Fragebogen', 'questionnaire-create', '', true))}
      <section class="cards">${data.items.length ? data.items.map(card).join('') : `<article class="card">${ui.empty('Es gibt noch keinen Fragebogen.')}</article>`}</section>`;
  }

  async function questionnaire() {
    if (!isHrPerson()) throw Error('Nur HR verwaltet Fragebögen.');
    if (!state.questionnaireId) return questionnaires();
    const { questionnaire: item } = await api(`/api/feedback/questionnaires/${state.questionnaireId}`);
    const locked = !!(item.used || item.frozen);
    const questionRow = (question, index, section) => {
      const controls = locked ? '' : `<div class="fb-actions">
        ${index > 0 ? moveButton('question-up', question.id, 'Frage nach oben', '↑') : ''}
        ${index < section.questions.length - 1 ? moveButton('question-down', question.id, 'Frage nach unten', '↓') : ''}
        ${button('Bearbeiten', 'question-edit', question.id)}
        ${button('Löschen', 'question-delete', question.id)}
      </div>`;
      const selfNote = question.self_question_text
        ? `In der Selbsteinschätzung: ${esc(question.self_question_text)}`
        : /\bPerson\b/.test(question.question_text) ? 'In der Selbsteinschätzung bleibt der Wortlaut gleich.' : '';
      const notes = `${question.required ? 'Pflichtfrage' : 'Freiwillig'}${question.competency_name ? ` · ${esc(question.competency_name)}` : ''}${question.active ? '' : ' · inaktiv'}`;
      return `<div class="fb-question">
        <div class="fb-question-main">
          <span class="tag">${esc(questionTypeLabels[question.question_type] || 'Frage')}</span>
          <b>${esc(question.question_text)}</b>
          <small>${notes}</small>
          ${selfNote ? `<small>${selfNote}</small>` : ''}
        </div>
        ${controls}
      </div>`;
    };
    const sectionBlock = (section, index) => {
      const controls = locked ? '' : `<div class="fb-actions">
        ${index > 0 ? moveButton('section-up', section.id, 'Abschnitt nach oben', '↑') : ''}
        ${index < item.sections.length - 1 ? moveButton('section-down', section.id, 'Abschnitt nach unten', '↓') : ''}
        ${button('Bearbeiten', 'section-edit', section.id)}
        ${button('Löschen', 'section-delete', section.id)}
        ${button('+ Frage', 'question-create', section.id, true)}
      </div>`;
      return `<section class="fb-question-section">
        <div class="sectionHead">
          <div><h2>${esc(section.title)}</h2><p class="muted">${esc(section.description || '')}</p></div>
          ${controls}
        </div>
        ${section.questions.length ? section.questions.map((question, questionIndex) => questionRow(question, questionIndex, section)).join('') : ui.empty('Noch keine Fragen.')}
      </section>`;
    };
    const actions = [
      button('Zurück', 'questionnaires'),
      locked ? '' : button('Name ändern', 'questionnaire-edit'),
      locked ? '' : button('+ Abschnitt', 'section-create'),
      button('Neue Version', 'questionnaire-version', '', locked)
    ].join(' ');
    return `${header(item.name, `Version ${item.version} · ${locked ? 'wird verwendet und bleibt unverändert' : 'noch änderbar'}`, actions)}
      <section class="cards">
        <article class="card wide">${item.sections.length ? item.sections.map(sectionBlock).join('') : ui.empty('Lege den ersten Abschnitt an.')}</article>
        <article class="card"><h2>Bewertung</h2><p class="muted">1 heißt „trifft nicht zu“, 5 heißt „trifft vollständig zu“. Wer etwas nicht einschätzen kann, wählt „nicht beurteilbar“. Das zählt nicht als Note.</p></article>
      </section>`;
  }

  // ------------------------------------------------------------------ Feedback geben

  const SCALE_HINTS = { 1: 'trifft nicht zu', 5: 'trifft vollständig zu' };

  function ratingQuestion(question) {
    const selected = question.response?.numericValue;
    const options = [1, 2, 3, 4, 5].map(value => {
      const name = `${value} von 5${SCALE_HINTS[value] ? `: ${SCALE_HINTS[value]}` : ''}`;
      return `<label class="fb-score" title="${esc(name)}"><input type="radio" name="rating-${esc(question.id)}" value="${value}" aria-label="${esc(name)}" ${selected === value ? 'checked data-selected="1"' : ''}><span aria-hidden="true">${value}</span></label>`;
    }).join('');
    return `<fieldset class="fb-rating" data-question="${esc(question.id)}" data-type="rating" data-required="${question.required ? 1 : 0}">
      <legend>${esc(question.question_text)}${question.required ? ' *' : ''}</legend>
      <small>${esc(question.help_text || '1 = trifft nicht zu · 5 = trifft vollständig zu')}</small>
      <div class="fb-rating-options">${options}<label class="fb-na"><input type="checkbox" name="na-${esc(question.id)}" ${question.response?.notApplicable ? 'checked' : ''}> nicht beurteilbar</label></div>
    </fieldset>`;
  }

  function textQuestion(question) {
    return `<div class="fb-text-question" data-question="${esc(question.id)}" data-type="text" data-required="${question.required ? 1 : 0}">
      <label for="fbText${esc(question.id)}">${esc(question.question_text)}${question.required ? ' *' : ''}</label>
      ${question.help_text ? `<small>${esc(question.help_text)}</small>` : ''}
      <textarea id="fbText${esc(question.id)}" name="text-${esc(question.id)}" maxlength="4000">${esc(question.response?.textValue || '')}</textarea>
    </div>`;
  }

  async function invitation() {
    if (!state.invitationId) return dashboard();
    const data = await api(`/api/feedback/invitations/${state.invitationId}`);
    const isSelf = data.invitation.feedbackGroup === 'self';
    state.invitationIsSelf = isSelf;
    const anonymous = !['self', 'manager'].includes(data.invitation.feedbackGroup);
    const confidentiality = anonymous
      ? `Dein Name erscheint nicht im Bericht. Deine Antworten erscheinen erst ab ${data.invitation.anonymousMinimum} Rückmeldungen, zusammengefasst. Kommentare stehen wörtlich im Bericht: Schreib sie so, dass man dich nicht daran erkennt.`
      : isSelf
        ? 'Deine Selbsteinschätzung steht unter deinem Namen im Bericht. Deine Führungskraft kann sie nach der Freigabe lesen.'
        : 'Deine Antworten stehen als Sicht der Führungskraft im Bericht. Sie sind nicht anonym.';
    const questions = section => section.questions.map(question => (question.question_type === 'rating' ? ratingQuestion(question) : textQuestion(question))).join('');
    return `${header(isSelf ? 'Deine Selbsteinschätzung' : `360° Feedback für ${data.invitation.employeeName}`, `${pretty(data.invitation.feedbackGroup)} · abgeben bis ${ui.date(data.invitation.deadline)}`, button('Zurück', 'feedback-dashboard'))}
      <form class="fb-response-form" id="fbResponseForm" data-invitation-id="${esc(data.invitation.id)}" novalidate>
        <section class="cards">
          <article class="card wide fb-form-hero"><div><small>FORTSCHRITT</small><h2 id="fbProgress"></h2><p class="muted">Du kannst zwischendurch speichern und später weitermachen. Fragen mit * sind Pflicht.${data.invitation.selfWordingIncomplete ? ' Wo in einer Frage „die Person“ steht, bist du gemeint.' : ''}</p></div><div>${tag(data.invitation.status)}</div></article>
          <article class="card"><h2>Vertraulichkeit</h2><p class="muted">${esc(confidentiality)}</p></article>
        </section>
        ${data.sections.map(section => `<section class="card fb-form-section"><h2>${esc(section.title)}</h2><p class="muted">${esc(section.description || '')}</p>${questions(section)}</section>`).join('')}
        <div class="fb-submitbar">
          <div class="fb-submitbar-main">${button('Verbindlich absenden', 'response-submit', '', true)}${button('Entwurf speichern', 'response-draft')}</div>
          ${button('Anfrage ablehnen', 'response-decline', '', false, 'fb-decline')}
        </div>
      </form>`;
  }

  const isAnswered = element => (element.dataset.type === 'text'
    ? element.querySelector('textarea').value.trim().length > 0
    : !!element.querySelector('input:checked'));

  function updateResponseProgress(form) {
    const questions = [...form.querySelectorAll('[data-question]')];
    const label = form.querySelector('#fbProgress');
    if (label) label.textContent = `${questions.filter(isAnswered).length} von ${ui.plural(questions.length, 'Frage', 'Fragen')} beantwortet`;
  }

  /** Note und „nicht beurteilbar“ schließen sich aus. Ein zweiter Klick auf die Note hebt sie wieder auf. */
  function bindResponseForm() {
    const form = document.querySelector('#fbResponseForm');
    // Doppelte Empfänger würden eine Note beim selben Klick wählen und wieder aufheben.
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    updateResponseProgress(form);
    const noteChange = group => {
      group.classList.remove('fb-missing');
      form.dataset.unsaved = '1';
      updateResponseProgress(form);
    };
    form.addEventListener('submit', event => event.preventDefault());
    form.addEventListener('click', event => {
      const radio = event.target.closest?.('input[type=radio]');
      if (!radio) return;
      const group = radio.closest('[data-question]');
      if (radio.dataset.selected) {
        radio.checked = false;
        delete radio.dataset.selected;
      } else {
        group.querySelectorAll('input[type=radio]').forEach(other => delete other.dataset.selected);
        radio.dataset.selected = '1';
        group.querySelector('input[type=checkbox]').checked = false;
      }
      noteChange(group);
    });
    // Die Leertaste löst auf einer schon gewählten Note keinen Klick aus. Sie soll sie trotzdem aufheben können.
    form.addEventListener('keydown', event => {
      const radio = event.target.closest?.('input[type=radio]');
      if (event.key !== ' ' || !radio?.checked) return;
      event.preventDefault();
      radio.checked = false;
      delete radio.dataset.selected;
      noteChange(radio.closest('[data-question]'));
    });
    form.addEventListener('change', event => {
      const checkbox = event.target.closest?.('input[type=checkbox]');
      if (!checkbox) return;
      const group = checkbox.closest('[data-question]');
      if (checkbox.checked) {
        group.querySelectorAll('input[type=radio]').forEach(radio => {
          radio.checked = false;
          delete radio.dataset.selected;
        });
      }
      noteChange(group);
    });
    form.addEventListener('input', event => {
      const textarea = event.target.closest?.('textarea');
      if (textarea) noteChange(textarea.closest('[data-question]'));
    });
  }

  function responsePayload(form) {
    return [...form.querySelectorAll('[data-question]')].map(element => {
      const questionId = Number(element.dataset.question);
      if (element.dataset.type === 'text') return { questionId, textValue: element.querySelector('textarea').value };
      const checked = element.querySelector('input[type=radio]:checked');
      return { questionId, numericValue: checked ? Number(checked.value) : null, notApplicable: element.querySelector('input[type=checkbox]').checked };
    });
  }

  function askToSubmit() {
    const form = document.querySelector('#fbResponseForm');
    const missing = [...form.querySelectorAll('[data-question][data-required="1"]')].filter(element => !isAnswered(element));
    form.querySelectorAll('.fb-missing').forEach(element => element.classList.remove('fb-missing'));
    if (missing.length) {
      missing.forEach(element => element.classList.add('fb-missing'));
      missing[0].scrollIntoView({ block: 'center' });
      missing[0].querySelector('input,textarea')?.focus({ preventScroll: true });
      ui.toast(`Es ${missing.length === 1 ? 'fehlt noch 1 Pflichtfrage' : `fehlen noch ${missing.length} Pflichtfragen`}. Die offenen Fragen sind markiert.`, 'error');
      return;
    }
    confirmAction({
      title: 'Feedback verbindlich absenden?',
      text: 'Danach kannst du deine Antworten nicht mehr ändern.',
      confirmLabel: 'Verbindlich absenden',
      onConfirm: async () => {
        await send(`/api/feedback/invitations/${state.invitationId}/submit`, 'POST', { answers: responsePayload(form) });
        delete form.dataset.unsaved;
        ui.toast('Danke! Dein Feedback ist abgegeben.');
        go('feedbackDashboard');
      }
    });
  }

  function askToDecline() {
    confirmAction({
      title: 'Anfrage wirklich ablehnen?',
      text: state.invitationIsSelf
        ? 'Du gibst dann keine Selbsteinschätzung ab. Das lässt sich nicht rückgängig machen.'
        : 'Du gibst dann kein Feedback ab. Das lässt sich nicht rückgängig machen. Die Person sieht nicht, dass du es warst.',
      confirmLabel: 'Anfrage ablehnen',
      onConfirm: async () => {
        await send(`/api/feedback/invitations/${state.invitationId}/decline`, 'POST');
        delete document.querySelector('#fbResponseForm')?.dataset.unsaved;
        ui.toast('Die Anfrage ist abgelehnt.');
        go('feedbackDashboard');
      }
    });
  }

  // ------------------------------------------------------------------ Bericht

  const releaseSteps = {
    reviewed: {
      label: 'Als geprüft markieren',
      title: 'Bericht als geprüft markieren?',
      text: () => 'Danach kannst du ihn für die Führungskraft freigeben. Niemand sonst sieht ihn dadurch.',
      done: 'Der Bericht ist geprüft.'
    },
    released_for_manager: {
      label: 'Für die Führungskraft freigeben',
      title: 'Für die Führungskraft freigeben?',
      text: report => `${report.participant.managerName || 'Die Führungskraft'} kann den Bericht danach lesen und bekommt die Aufgabe, das Ergebnisgespräch vorzubereiten.`,
      done: 'Die Führungskraft kann den Bericht jetzt lesen.'
    },
    released_for_employee: {
      label: 'Für die Person freigeben',
      title: 'Für die Person freigeben?',
      text: report => `${report.participant.employeeName} kann den Bericht danach lesen. Das lässt sich nicht zurücknehmen.`,
      done: 'Die Person kann den Bericht jetzt lesen.'
    },
    closed: {
      label: 'Bericht abschließen',
      title: 'Bericht abschließen?',
      text: () => 'Offene Aufgaben dazu schließen sich. Der Bericht bleibt lesbar.',
      done: 'Der Bericht ist abgeschlossen.'
    }
  };
  let shownReport = null;

  function scoreTiles(groups) {
    const tile = group => `<div class="fb-result-score"><span>${esc(pretty(group.group))}</span><b>${esc(score(group.average))}<i>/5</i></b><small>aus ${esc(ui.plural(group.questionCount, 'Frage', 'Fragen'))}</small></div>`;
    return groups.length ? groups.map(tile).join('') : '<span class="muted">Zu wenige Antworten für eine Anzeige.</span>';
  }

  function resultGroups(items) {
    return items.map(item => `<div class="fb-result-section"><h3>${esc(item.title)}</h3><div class="fb-result-grid">${scoreTiles(item.groups)}</div></div>`).join('');
  }

  function comparisonTable(comparisons) {
    const differenceClass = value => (value > 0 ? 'positive' : value < 0 ? 'negative' : '');
    const row = item => `<tr>
      <td>${esc(item.question)}</td>
      <td class="fb-num" data-label="Selbst">${item.self === null ? '–' : esc(score(item.self))}</td>
      <td class="fb-num" data-label="Andere">${item.external === null ? '–' : esc(score(item.external))}</td>
      <td class="fb-num difference ${differenceClass(item.difference)}" data-label="Unterschied">${item.difference === null ? '–' : esc(signedScore(item.difference))}</td>
    </tr>`;
    return `<table class="fb-compare"><thead><tr><th>Frage</th><th class="fb-num">Selbst</th><th class="fb-num">Andere</th><th class="fb-num">Unterschied</th></tr></thead><tbody>${comparisons.map(row).join('')}</tbody></table>`;
  }

  function commentBlocks(comments) {
    const byQuestion = new Map();
    for (const comment of comments) {
      if (!byQuestion.has(comment.questionId)) byQuestion.set(comment.questionId, { question: comment.question, items: [] });
      byQuestion.get(comment.questionId).items.push(comment);
    }
    return [...byQuestion.values()].map(block => `<div class="fb-comment-block"><h3>${esc(block.question)}</h3><div class="fb-comments">${block.items.map(comment => `<blockquote><small>${esc(pretty(comment.group))}</small><p>${esc(comment.text)}</p></blockquote>`).join('')}</div></div>`).join('');
  }

  async function result() {
    if (!state.participantId) return dashboard();
    const data = await api(`/api/feedback/results/${state.participantId}`);
    const { result: report, status, permissions, actions } = data;
    shownReport = report;
    const isOwn = report.participant.employeeId === currentUser().id;
    const step = releaseSteps[permissions.nextStatus];
    const buttons = [
      isHrPerson() && !isOwn ? button('Zur Feedbackrunde', 'cycle-open', report.cycle.id) : button('Zur Teilnahme', 'participant-open', report.participant.id),
      step ? button(step.label, 'result-status', permissions.nextStatus, true) : '',
      permissions.develop ? button('+ Entwicklungsmaßnahme', 'development-create') : ''
    ].join(' ');
    const external = report.comparisons.filter(item => item.external !== null);
    const strengths = external.filter(item => item.external >= 4).sort((a, b) => b.external - a.external).slice(0, 3);
    const potential = external.filter(item => item.external < 3.5).sort((a, b) => a.external - b.external).slice(0, 3);
    const reflectionList = items => items.map(item => `<p class="muted">${esc(item.question)} · ${esc(score(item.external))}/5</p>`).join('');
    const minimum = report.cycle.minimumAnonymousGroupSize;
    const someAnswersHidden = report.responseRate.groups.some(item => !['self', 'manager'].includes(item.group) && (item.submitted === null || item.submitted < minimum));
    const hiddenNote = someAnswersHidden ? `<p class="muted">Von manchen Gruppen gibt es weniger als ${esc(minimum)} Antworten. Sie bleiben verborgen, damit niemand erkennbar wird.</p>` : '';
    const actionRow = item => `<p><b>${esc(developmentLabels[item.action_type] || 'Maßnahme')}</b><br><span class="muted">${esc(item.description)}${item.target_date ? ` · bis ${date(item.target_date)}` : ''}</span></p>`;
    const meetingCard = permissions.develop && report.participant.managerId
      ? `<article class="card"><h2>Ergebnisgespräch</h2>${status.meeting_completed_at
        ? `<p class="muted">Die Vorbereitung ist seit ${date(status.meeting_completed_at)} abgeschlossen.</p>`
        : permissions.completeMeeting
          ? `<p class="muted">Lies den Bericht und überlege, worüber ihr sprechen wollt. Wenn du damit fertig bist, schließe die Aufgabe hier ab.</p>${button('Vorbereitung abschließen', 'meeting-complete', '', true)}`
          : `<p class="muted">${esc(report.participant.managerName || 'Die Führungskraft')} bereitet das Gespräch vor.</p>`}</article>`
      : '';
    return `${header('360°-Bericht', `${report.cycle.name} · ${report.participant.employeeName}`, `${isOwn ? '' : tag(status.status)} ${buttons}`)}
      <section class="cards">
        ${ui.stat('Antworten', `${report.responseRate.submitted} von ${report.responseRate.invited}`, `${report.responseRate.percentage} % haben geantwortet`)}
        ${ui.stat('Anonymität', `ab ${minimum}`, 'Rückmeldungen sichtbar')}
        ${ui.stat('Berechnet am', date(status.calculated_at), 'aus allen abgegebenen Antworten')}
      </section>
      <section class="cards">
        <article class="card wide"><h2>Ergebnisse nach Thema</h2>${hiddenNote}${resultGroups(report.sections) || ui.empty('Es gibt zu wenige Antworten für eine Anzeige.')}</article>
        <article class="card"><h2>Zum Nachdenken</h2>
          <p><b>Das gelingt besonders gut</b></p>${reflectionList(strengths) || ui.empty('Noch nichts Eindeutiges.')}
          <p><b>Hier liegt Potenzial</b></p>${reflectionList(potential) || ui.empty('Noch nichts Eindeutiges.')}
        </article>
      </section>
      ${report.competencies.length ? `<section class="cards"><article class="card wide"><h2>Ergebnisse nach Kompetenz</h2>${resultGroups(report.competencies)}</article></section>` : ''}
      <section class="cards">
        <article class="card wide"><h2>Selbsteinschätzung und Sicht der anderen</h2>${report.comparisons.length ? `<div class="tableWrap">${comparisonTable(report.comparisons)}</div>` : ui.empty('Dieser Fragebogen hat keine Bewertungsfragen.')}</article>
        <article class="card"><h2>Antworten je Gruppe</h2>${groupCounts(report.responseRate.groups) || ui.empty('Niemand wurde eingeladen.')}<h2 class="fb-subheading">So wird gerechnet</h2><p class="muted">${esc(report.calculation.rule)}</p></article>
      </section>
      <section class="cards">
        <article class="card wide"><h2>Kommentare</h2>${report.comments.length ? commentBlocks(report.comments) : ui.empty('Es gibt keine Kommentare, die gezeigt werden dürfen.')}</article>
        <div class="fb-side-cards">
          ${meetingCard}
          <article class="card"><h2>Entwicklungsmaßnahmen</h2>${actions.length ? actions.map(actionRow).join('') : ui.empty('Noch keine Maßnahmen.')}</article>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------------ Dialoge

  async function cycleForm(existing = null) {
    const questionnaireChoices = existing ? [] : (await api('/api/feedback/questionnaires')).items.filter(item => item.active);
    if (!existing && !questionnaireChoices.length) throw Error('Lege zuerst einen Fragebogen an.');
    const field = key => esc(existing?.[key] ?? '');
    const body = `<label>Name *</label><input name="name" required value="${field('name')}">
      <label>Beschreibung</label><textarea name="description">${field('description')}</textarea>
      ${existing ? '' : `<label>Fragebogen *</label><select name="questionnaireId">${questionnaireChoices.map(item => option(item.id, `${item.name}, Version ${item.version}`)).join('')}</select><p class="muted">Der Fragebogen lässt sich danach nicht mehr wechseln.</p>`}
      <div class="two"><div><label>Start *</label><input type="date" name="startDate" required value="${field('start_date')}"></div><div><label>Ende *</label><input type="date" name="endDate" required value="${field('end_date')}"></div></div>
      <div class="two"><div><label>Vorschläge bis *</label><input type="date" name="nominationDeadline" required value="${field('nomination_deadline')}"></div><div><label>Feedback bis *</label><input type="date" name="feedbackDeadline" required value="${field('feedback_deadline')}"></div></div>
      ${existing ? '' : '<label>Antworten sichtbar ab</label><input name="anonymousMinimum" type="number" min="3" value="3"><p class="muted">Weniger als 3 ist nicht möglich, sonst wären einzelne Personen erkennbar.</p>'}`;
    modal(existing ? 'Feedbackrunde bearbeiten' : 'Feedbackrunde anlegen', body, async values => {
      if (existing) await send(`/api/feedback/cycles/${existing.id}`, 'PATCH', values);
      else await send('/api/feedback/cycles', 'POST', values);
      ui.toast(existing ? 'Die Änderungen sind gespeichert.' : 'Die Feedbackrunde ist als Entwurf angelegt.');
      go(existing ? 'feedbackCycleDetail' : 'feedbackCycles');
    });
  }

  async function participantForm() {
    const [{ users }, { cycle }] = await Promise.all([api('/api/users'), api(`/api/feedback/cycles/${state.cycleId}`)]);
    const taken = new Set(cycle.participants.map(item => item.employee_id));
    const people = users.filter(user => user.canAssign !== false && !taken.has(user.id));
    if (!people.length) throw Error('Alle Personen, die du aufnehmen darfst, sind schon in dieser Runde.');
    modal('Person aufnehmen', `<label>Wer soll Feedback bekommen? *</label><select name="employeeId">${personOptions(people)}</select>`, async values => {
      await send(`/api/feedback/cycles/${state.cycleId}/participants`, 'POST', values);
      ui.toast('Die Person ist aufgenommen. Selbsteinschätzung und Führungskraft sind schon eingeplant.');
      go('feedbackCycleDetail');
    }, 'Aufnehmen');
  }

  const phaseChoices = {
    nomination: { label: 'Vorschläge sammeln', hint: 'Die aufgenommenen Personen schlagen vor, wer ihnen Feedback geben soll.' },
    open: { label: 'Feedback starten', hint: 'Alle bestätigten Personen bekommen eine Anfrage.' },
    evaluation: { label: 'Auswertung starten', hint: 'Danach kann niemand mehr antworten. Offene Anfragen verfallen.' },
    completed: { label: 'Runde abschließen', hint: 'Berichte lassen sich weiter berechnen und freigeben.' },
    archived: { label: 'Archivieren', hint: 'Die Runde ist damit beendet, offene Aufgaben dazu schließen sich. Das lässt sich nicht rückgängig machen.' }
  };
  const PHASE_STEPS = { draft: ['nomination', 'archived'], nomination: ['open', 'archived'], open: ['evaluation', 'nomination', 'archived'], evaluation: ['completed', 'archived'], completed: ['archived'] };

  async function cycleStatusForm() {
    const { cycle } = await api(`/api/feedback/cycles/${state.cycleId}`);
    const steps = PHASE_STEPS[cycle.status] || [];
    const describe = step => (step === 'nomination' && cycle.status === 'open'
      ? { label: 'Vorschläge noch einmal öffnen', hint: 'Noch nicht abgegebene Anfragen ruhen so lange. Abgegebene Antworten bleiben erhalten.' }
      : phaseChoices[step]);
    const body = `<label>Nächster Schritt *</label><select name="status">${steps.map(step => option(step, describe(step).label)).join('')}</select>
      ${steps.map(step => `<p class="muted"><b>${esc(describe(step).label)}:</b> ${esc(describe(step).hint)}</p>`).join('')}`;
    modal('Nächster Schritt', body, async values => {
      await send(`/api/feedback/cycles/${state.cycleId}/status`, 'PATCH', values);
      ui.toast(`Die Runde ist jetzt im Schritt „${pretty(values.status)}“.`);
      go('feedbackCycleDetail');
    }, 'Übernehmen');
  }

  async function cycleDeadlineForm() {
    const { cycle } = await api(`/api/feedback/cycles/${state.cycleId}`);
    const suggested = deadline => (deadline < todayText() ? daysFromToday(14) : deadline);
    const nominationValue = cycle.status === 'nomination' ? suggested(cycle.nomination_deadline) : cycle.nomination_deadline;
    const body = `<p class="muted">Offene Aufgaben bekommen automatisch die neue Frist. Eine Frist lässt sich hier nur nach hinten verschieben.</p>
      <div class="two">
        <div><label>Vorschläge bis *</label><input type="date" name="nominationDeadline" required value="${esc(nominationValue)}"></div>
        <div><label>Feedback bis *</label><input type="date" name="feedbackDeadline" required value="${esc(suggested(cycle.feedback_deadline))}"></div>
      </div>`;
    modal('Frist verlängern', body, async values => {
      await send(`/api/feedback/cycles/${state.cycleId}/deadlines`, 'PATCH', values);
      ui.toast(`Die Frist ist verlängert: Feedback bis ${ui.date(values.feedbackDeadline)}.`);
      go('feedbackCycleDetail');
    }, 'Frist speichern');
  }

  async function nominationForm() {
    const [{ users }, { permissions }] = await Promise.all([
      api(`/api/feedback/nominations/candidates?participantId=${state.participantId}`),
      api(`/api/feedback/participants/${state.participantId}/nominations`)
    ]);
    if (!users.length) throw Error('Es gibt niemanden mehr, den du vorschlagen kannst.');
    const groupField = permissions.proposeStakeholder
      ? '<label>Gruppe</label><select name="feedbackGroup"><option value="peer">Automatisch aus der Organisation</option><option value="stakeholder">Weitere Person, zum Beispiel aus einem anderen Bereich</option></select>'
      : '<p class="muted">In welche Gruppe die Person gehört, ergibt sich aus der Organisation.</p>';
    modal('Person vorschlagen', `<label>Wer soll Feedback geben? *</label><select name="giverId">${personOptions(users)}</select>${groupField}`, async values => {
      await send(`/api/feedback/participants/${state.participantId}/nominations`, 'POST', values);
      ui.toast('Der Vorschlag ist eingereicht.');
      go('feedbackParticipant');
    }, 'Vorschlagen');
  }

  async function askToCompleteNominations() {
    const { nominations, participant: person } = await api(`/api/feedback/participants/${state.participantId}/nominations`);
    const others = nominations.filter(item => !['self', 'manager'].includes(item.feedback_group) && item.status !== 'rejected').length;
    const warning = others < person.anonymous_minimum ? ` Antworten erscheinen erst ab ${person.anonymous_minimum} Rückmeldungen. Mit weniger Personen bleiben sie verborgen.` : '';
    confirmAction({
      title: 'Vorschläge abschließen?',
      text: `Du hast ${ui.plural(others, 'Person', 'Personen')} vorgeschlagen.${warning} Deine Aufgabe schließt sich damit. Bis zur Frist kannst du trotzdem noch jemanden ergänzen.`,
      confirmLabel: 'Vorschläge abschließen',
      onConfirm: async () => {
        await send(`/api/feedback/participants/${state.participantId}/nominations/complete`, 'POST');
        ui.toast('Deine Vorschläge sind abgeschlossen.');
        go('feedbackParticipant');
      }
    });
  }

  function questionnaireForm(existing = null) {
    const body = `<label>Name *</label><input name="name" required value="${esc(existing?.name ?? '')}">
      <label>Beschreibung</label><textarea name="description">${esc(existing?.description ?? '')}</textarea>
      ${existing ? `<label class="checkline"><input type="checkbox" name="active" ${existing.active ? 'checked' : ''}> Aktiv: kann für neue Feedbackrunden gewählt werden</label>` : ''}`;
    modal(existing ? 'Fragebogen bearbeiten' : 'Fragebogen anlegen', body, async values => {
      if (existing) {
        await send(`/api/feedback/questionnaires/${existing.id}`, 'PATCH', { ...values, active: !!values.active });
        ui.toast('Die Änderungen sind gespeichert.');
      } else {
        const created = await send('/api/feedback/questionnaires', 'POST', values);
        state.questionnaireId = created.id;
        ui.toast('Der Fragebogen ist angelegt.');
      }
      go('feedbackQuestionnaire');
    });
  }

  function sectionForm(existing = null) {
    const body = `<label>Titel *</label><input name="title" required value="${esc(existing?.title ?? '')}"><label>Beschreibung</label><textarea name="description">${esc(existing?.description ?? '')}</textarea>`;
    modal(existing ? 'Abschnitt bearbeiten' : 'Abschnitt anlegen', body, async values => {
      if (existing) await send(`/api/feedback/questionnaires/sections/${existing.id}`, 'PATCH', values);
      else await send(`/api/feedback/questionnaires/${state.questionnaireId}/sections`, 'POST', values);
      ui.toast(existing ? 'Der Abschnitt ist gespeichert.' : 'Der Abschnitt ist angelegt.');
      go('feedbackQuestionnaire');
    });
  }

  async function questionForm(sectionId, existing = null) {
    const { items: competencies } = await api('/api/competencies');
    const body = `<label>Fragetext *</label><textarea name="questionText" required>${esc(existing?.question_text ?? '')}</textarea>
      <p class="muted">Schreib zum Beispiel „Die Person hört aktiv zu.“ In der Selbsteinschätzung steht dann „Du hörst aktiv zu.“</p>
      <label>Art der Frage *</label><select name="questionType">${Object.entries(questionTypeLabels).map(([value, label]) => option(value, label, existing?.question_type ?? 'rating')).join('')}</select>
      <label class="checkline"><input type="checkbox" name="required" ${existing && !existing.required ? '' : 'checked'}> Pflichtfrage</label>
      <label>Gehört zur Kompetenz</label><select name="competencyId"><option value="">Keine</option>${competencies.map(item => option(item.id, item.name, existing?.competency_id)).join('')}</select>
      <label>Erklärung zur Frage</label><textarea name="helpText">${esc(existing?.help_text ?? '')}</textarea>`;
    modal(existing ? 'Frage bearbeiten' : 'Frage anlegen', body, async values => {
      const payload = { ...values, required: !!values.required };
      if (existing) await send(`/api/feedback/questions/${existing.id}`, 'PATCH', payload);
      else await send(`/api/feedback/questionnaires/sections/${sectionId}/questions`, 'POST', payload);
      ui.toast(existing ? 'Die Frage ist gespeichert.' : 'Die Frage ist angelegt.');
      go('feedbackQuestionnaire');
    });
  }

  async function findInQuestionnaire(kind, id) {
    const { questionnaire: item } = await api(`/api/feedback/questionnaires/${state.questionnaireId}`);
    const wanted = Number(id);
    if (kind === 'section') return item.sections.find(section => section.id === wanted);
    return item.sections.flatMap(section => section.questions).find(question => question.id === wanted);
  }

  async function developmentForm() {
    const [{ users }, { items: competencies }] = await Promise.all([api('/api/users'), api('/api/competencies')]);
    const body = `<label>Maßnahme *</label><select name="actionType">${Object.entries(developmentLabels).map(([value, label]) => option(value, label)).join('')}</select>
      <label>Beschreibung *</label><textarea name="description" required minlength="10"></textarea>
      <div class="two"><div><label>Verantwortlich</label><select name="responsibleId"><option value="">Noch offen</option>${personOptions(users)}</select></div><div><label>Zieltermin</label><input type="date" name="targetDate"></div></div>
      <label>Kompetenz</label><select name="competencyId"><option value="">Keine</option>${competencies.map(item => option(item.id, item.name)).join('')}</select>
      <label class="checkline"><input type="checkbox" name="createGoal"> Zusätzlich als Entwicklungsziel anlegen</label>
      <label>Titel des Entwicklungsziels</label><input name="goalTitle">`;
    modal('Entwicklungsmaßnahme festhalten', body, async values => {
      await send(`/api/feedback/participants/${state.participantId}/development-actions`, 'POST', { ...values, createGoal: !!values.createGoal });
      ui.toast('Die Entwicklungsmaßnahme ist gespeichert.');
      go('feedbackResult');
    });
  }

  // ------------------------------------------------------------------ Knöpfe

  const moveQuestion = async (id, direction) => {
    await send(`/api/feedback/questions/${id}/move`, 'POST', { direction });
    go('feedbackQuestionnaire');
  };
  const moveSection = async (id, direction) => {
    await send(`/api/feedback/questionnaires/sections/${id}/move`, 'POST', { direction });
    go('feedbackQuestionnaire');
  };

  const actions = {
    'feedback-dashboard': () => go('feedbackDashboard'),
    cycles: () => go('feedbackCycles'),
    'cycle-create': () => cycleForm(),
    'cycle-open': id => {
      state.cycleId = Number(id);
      go('feedbackCycleDetail');
    },
    'cycle-edit': async () => cycleForm((await api(`/api/feedback/cycles/${state.cycleId}`)).cycle),
    'cycle-status': () => cycleStatusForm(),
    'cycle-deadlines': () => cycleDeadlineForm(),
    'participant-add': () => participantForm(),
    'participant-open': id => {
      state.participantId = Number(id);
      go('feedbackParticipant');
    },
    'task-target': async target => {
      const separator = target.lastIndexOf(':');
      const { participantId } = await api(`/api/feedback/task-target?type=${encodeURIComponent(target.slice(0, separator))}&id=${encodeURIComponent(target.slice(separator + 1))}`);
      state.participantId = participantId;
      go('feedbackParticipant');
    },
    'nomination-create': () => nominationForm(),
    'nominations-complete': () => askToCompleteNominations(),
    'nomination-approve': async id => {
      await send(`/api/feedback/nominations/${id}`, 'PATCH', { status: 'approved' });
      ui.toast('Der Vorschlag ist bestätigt.');
      go('feedbackParticipant');
    },
    'nomination-reject': id => modal('Vorschlag ablehnen', '<label>Begründung *</label><textarea name="rejectionReason" required minlength="3"></textarea><p class="muted">Die Person, die den Vorschlag gemacht hat, sieht die Begründung.</p>', async values => {
      await send(`/api/feedback/nominations/${id}`, 'PATCH', { status: 'rejected', rejectionReason: values.rejectionReason });
      ui.toast('Der Vorschlag ist abgelehnt.');
      go('feedbackParticipant');
    }, 'Ablehnen'),
    'invitation-open': id => {
      state.invitationId = Number(id);
      go('feedbackInvitation');
    },
    'response-draft': async () => {
      const form = document.querySelector('#fbResponseForm');
      await send(`/api/feedback/invitations/${state.invitationId}/responses`, 'PUT', { answers: responsePayload(form) });
      delete form.dataset.unsaved;
      ui.toast('Dein Entwurf ist gespeichert.');
    },
    'response-submit': () => askToSubmit(),
    'response-decline': () => askToDecline(),
    'result-calculate': async id => {
      const { result: report } = await send(`/api/feedback/results/${id}/calculate`, 'POST');
      state.participantId = Number(id);
      ui.toast(report ? 'Der Bericht ist berechnet. Prüfe ihn jetzt.' : 'Der Bericht ist berechnet.');
      go(report ? 'feedbackResult' : 'feedbackParticipant');
    },
    'result-open': id => {
      state.participantId = Number(id);
      go('feedbackResult');
    },
    'result-status': nextStatus => {
      const step = releaseSteps[nextStatus];
      confirmAction({
        title: step.title,
        text: step.text(shownReport),
        confirmLabel: step.label,
        onConfirm: async () => {
          await send(`/api/feedback/results/${state.participantId}/status`, 'PATCH', { status: nextStatus });
          ui.toast(step.done);
          go('feedbackResult');
        }
      });
    },
    'meeting-complete': () => confirmAction({
      title: 'Vorbereitung abschließen?',
      text: 'Die Aufgabe „Ergebnisgespräch vorbereiten“ schließt sich damit.',
      confirmLabel: 'Vorbereitung abschließen',
      onConfirm: async () => {
        await send(`/api/feedback/results/${state.participantId}/meeting`, 'POST');
        ui.toast('Die Vorbereitung ist abgeschlossen.');
        go('feedbackResult');
      }
    }),
    'development-create': () => developmentForm(),
    questionnaires: () => go('feedbackQuestionnaires'),
    'questionnaire-create': () => questionnaireForm(),
    'questionnaire-edit': async () => questionnaireForm((await api(`/api/feedback/questionnaires/${state.questionnaireId}`)).questionnaire),
    'questionnaire-open': id => {
      state.questionnaireId = Number(id);
      go('feedbackQuestionnaire');
    },
    'questionnaire-version': async () => {
      const created = await send(`/api/feedback/questionnaires/${state.questionnaireId}/version`, 'POST');
      state.questionnaireId = created.id;
      ui.toast('Die neue Version ist angelegt und noch änderbar.');
      go('feedbackQuestionnaire');
    },
    'section-create': () => sectionForm(),
    'section-edit': async id => sectionForm(await findInQuestionnaire('section', id)),
    'section-up': id => moveSection(id, 'up'),
    'section-down': id => moveSection(id, 'down'),
    'section-delete': async id => {
      const section = await findInQuestionnaire('section', id);
      confirmAction({
        title: 'Abschnitt löschen?',
        text: `„${section.title}“ wird mit ${ui.plural(section.questions.length, 'Frage', 'Fragen')} gelöscht.`,
        confirmLabel: 'Abschnitt löschen',
        onConfirm: async () => {
          await send(`/api/feedback/questionnaires/sections/${id}`, 'DELETE');
          ui.toast('Der Abschnitt ist gelöscht.');
          go('feedbackQuestionnaire');
        }
      });
    },
    'question-create': id => questionForm(Number(id)),
    'question-edit': async id => {
      const question = await findInQuestionnaire('question', id);
      return questionForm(question.section_id, question);
    },
    'question-up': id => moveQuestion(id, 'up'),
    'question-down': id => moveQuestion(id, 'down'),
    'question-delete': async id => {
      const question = await findInQuestionnaire('question', id);
      confirmAction({
        title: 'Frage löschen?',
        text: `„${question.question_text}“ wird gelöscht.`,
        confirmLabel: 'Frage löschen',
        onConfirm: async () => {
          await send(`/api/feedback/questions/${id}`, 'DELETE');
          ui.toast('Die Frage ist gelöscht.');
          go('feedbackQuestionnaire');
        }
      });
    }
  };

  function bindFeedback() {
    document.querySelectorAll('[data-fb-action]').forEach(element => {
      element.onclick = async () => {
        // Ein Doppelklick darf nichts zweimal absenden.
        if (element.dataset.busy) return;
        element.dataset.busy = '1';
        try {
          await actions[element.dataset.fbAction]?.(element.dataset.id);
        } catch (error) {
          ui.toast(error.message || 'Das hat gerade nicht geklappt.', 'error');
        } finally {
          delete element.dataset.busy;
        }
      };
    });
    bindResponseForm();
  }

  window.loop.registerTaskAction(task => {
    const id = task.entity_id;
    const openReport = label => button(label, 'result-open', id, true);
    const done = `<button type="button" class="btn" data-task-done="${esc(task.id)}">Erledigt</button>`;
    switch (task.type) {
      case 'feedback_nominate': return button('Personen vorschlagen', 'participant-open', id, true);
      case 'feedback_nomination_review': return button('Prüfen', 'task-target', `${task.type}:${id}`, true);
      case 'feedback_nomination_rejected_notice': return `${button('Ansehen', 'task-target', `${task.type}:${id}`)} ${done}`;
      case 'feedback_submit': return button('Feedback geben', 'invitation-open', id, true);
      case 'feedback_result_review': return openReport('Bericht prüfen');
      case 'feedback_result_meeting': return openReport('Bericht öffnen');
      case 'feedback_result': return openReport('Bericht öffnen');
      case 'feedback_development_action_notice': return `${button('Bericht öffnen', 'result-open', id)} ${done}`;
      case 'feedback_development_action': return button('Ansehen', 'task-target', `${task.type}:${id}`);
      default: return '';
    }
  });

  // ------------------------------------------------------------------ Ungespeicherte Eingaben

  // Das Merkmal hängt am Formular selbst: Baut sich die Seite neu auf, ist es von allein weg.
  const unsavedForm = () => document.querySelector('#fbResponseForm[data-unsaved]');

  function mayLeaveForm() {
    const form = unsavedForm();
    if (!form) return true;
    if (!window.confirm('Du hast ungespeicherte Eingaben. Trotzdem verlassen?')) return false;
    delete form.dataset.unsaved;
    return true;
  }

  /** Die Anwendung hat die Ansicht und bei Zurück auch die Adresse schon gewechselt. Beides kommt zurück. */
  function stayOnForm() {
    const invitationId = Number(unsavedForm().dataset.invitationId);
    const address = `#/feedbackInvitation/${invitationId}`;
    view = 'feedbackInvitation';
    state.invitationId = invitationId;
    if (location.hash === address) return;
    const { scrollY } = window;
    history.pushState({ view, selectedPersonId: null, selectedPersonCanEdit: false, item: invitationId }, '', address);
    // Zurück rollt die Seite nach dem Seitenaufbau noch an die alte Stelle.
    setTimeout(() => window.scrollTo(0, scrollY), 0);
  }

  document.addEventListener('click', event => {
    if (!event.target.closest?.('#logout') || mayLeaveForm()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener('beforeunload', event => {
    if (!unsavedForm()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // ------------------------------------------------------------------ Einbindung in die Anwendung

  const addressFor = key => ({
    get: () => state[key],
    set: id => {
      state[key] = id;
    }
  });
  window.loop.registerAddress({
    feedbackCycleDetail: addressFor('cycleId'),
    feedbackParticipant: addressFor('participantId'),
    feedbackQuestionnaire: addressFor('questionnaireId'),
    feedbackInvitation: addressFor('invitationId'),
    feedbackResult: addressFor('participantId')
  });

  const pages = {
    feedbackDashboard: dashboard,
    feedbackCycles: cycles,
    feedbackCycleDetail: cycleDetail,
    feedbackParticipant: participant,
    feedbackQuestionnaires: questionnaires,
    feedbackQuestionnaire: questionnaire,
    feedbackInvitation: invitation,
    feedbackResult: result
  };
  const standardBind = bind;
  bind = function feedbackBindWrapper() {
    standardBind();
    bindFeedback();
  };
  const standardRender = render;
  render = async function feedbackRender() {
    // Jeder Weg weg vom Formular läuft hier durch: Knöpfe, Dayo und auch Zurück im Browser.
    if (!mayLeaveForm()) return stayOnForm();
    const page = pages[view];
    if (!page || me?.must_change_password) return standardRender();
    try {
      document.querySelector('#app').innerHTML = shell(await page());
      bind();
      if (!hasTeamAccess()) document.querySelector('[data-view="team"]')?.remove();
      restoringAddress = false;
      syncAddress();
    } catch (error) {
      if (error.status === 401 || error.code === 'tenant_suspended') {
        view = 'dashboard';
        return standardRender();
      }
      if (error.code === 'password_change_required') {
        me = { ...me, must_change_password: 1 };
        return standardRender();
      }
      // Eine gemerkte Adresse kann auf einen Vorgang zeigen, den es nicht mehr gibt.
      if (restoringAddress) {
        restoringAddress = false;
        view = 'feedbackDashboard';
        return render();
      }
      document.querySelector('#app').innerHTML = shell(`<section class="card fb-unavailable">
        <h1>Das geht gerade nicht</h1>
        <p class="muted">${esc(error.message || 'Die Daten stehen gerade nicht zur Verfügung.')}</p>
        <button type="button" class="btn primary" data-view="feedbackDashboard">Zur Übersicht</button>
      </section>`);
      bind();
      syncAddress();
    }
  };
  if (window.loop.me) setTimeout(() => render(), 0);
})();
