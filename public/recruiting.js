// Recruiting: Stellen, Bewerbungen, Gespräche, Angebote, Einstellung und interne Stellenbörse.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const REQUISITION_LABELS = {
    draft: 'Entwurf',
    pending_approval: 'Zur Freigabe',
    open: 'Offen',
    paused: 'Pausiert',
    filled: 'Besetzt',
    cancelled: 'Abgebrochen'
  };
  const APPLICATION_LABELS = { active: 'Aktiv', rejected: 'Abgesagt', withdrawn: 'Zurückgezogen', hired: 'Eingestellt' };
  const OFFER_LABELS = {
    draft: 'Entwurf',
    pending_approval: 'Zur Freigabe',
    approved: 'Freigegeben',
    accepted: 'Angenommen',
    declined: 'Abgelehnt',
    withdrawn: 'Zurückgezogen'
  };
  const ATTENTION_STATUSES = ['draft', 'pending_approval', 'paused', 'rejected', 'withdrawn', 'declined'];

  const MANAGE_VIEWS = ['recruitingHome', 'recruitingRequisition', 'recruitingApplication', 'recruitingCandidates', 'recruitingSettings'];
  const INTERVIEW_VIEWS = ['recruitingInterviews', 'recruitingInterview'];
  const BOARD_VIEW = 'recruitingBoard';

  const state = {
    requisitionId: null,
    applicationId: null,
    interviewId: null,
    statusFilter: '',
    candidateSearch: '',
    talentPoolOnly: false
  };

  // Die HR-Sachbearbeitung (hr_staff) ist im Recruiting eine normale Person.
  const isHrRole = me => ['hr_admin', 'hrbp', 'super_admin'].includes(me.role);
  const canManage = me => isHrRole(me) || ['manager', 'director'].includes(me.role);
  const managesOrganizationSettings = me => ['hr_admin', 'super_admin'].includes(me.role);
  const refresh = () => window.loop.navigate(window.loop.view);
  const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
  const patch = (url, body = {}) => api(url, { method: 'PATCH', body: JSON.stringify(body) });
  const idPart = value => encodeURIComponent(value);

  function formatDate(value) {
    if (!value) return '–';
    const [year, month, day] = String(value).slice(0, 10).split('-');
    return `${day}.${month}.${year}`;
  }

  function formatDateTime(value) {
    if (!value) return '–';
    const time = String(value).slice(11, 16);
    return time ? `${formatDate(value)}, ${time} Uhr` : formatDate(value);
  }

  function actionButton(label, action, data = {}, { primary = false, title = '' } = {}) {
    const attributes = Object.entries(data).map(([key, value]) => `data-${key}="${esc(value)}"`).join(' ');
    const titleAttribute = title ? `title="${esc(title)}" aria-label="${esc(title)}"` : '';
    return `<button type="button" class="btn ${primary ? 'primary' : ''}" data-recruiting-action="${esc(action)}" ${attributes} ${titleAttribute}>${esc(label)}</button>`;
  }

  function options(items, selected = '') {
    return items
      .map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`)
      .join('');
  }

  function statusTag(labels, status) {
    return `<span class="tag ${ATTENTION_STATUSES.includes(status) ? 'focus' : ''}">${esc(labels[status] || status)}</span>`;
  }

  const applicationStatus = application => (application.withdrawn ? 'withdrawn' : application.status);

  /** Ohne Freigaberegel hat niemand freigegeben. Das Angebot heißt dann auch nicht so. */
  const offerLabel = (status, approvalSkipped) => (status === 'approved' && approvalSkipped ? 'Fertig, ohne Freigabe' : OFFER_LABELS[status] || status);

  function backToStart(message, view, label) {
    return `${ui.empty(message)}<button type="button" class="btn" data-view="${esc(view)}">${esc(label)}</button>`;
  }

  function textBlock(label, value) {
    if (!value) return '';
    return `<p class="recruiting-text"><b>${esc(label)}</b><br>${esc(value)}</p>`;
  }

  function resumeBlock(resumeText, resumeUrl) {
    const link = resumeUrl && /^https?:\/\//i.test(resumeUrl)
      ? `<p><a href="${esc(resumeUrl)}" target="_blank" rel="noopener noreferrer">Lebenslauf öffnen</a></p>`
      : '';
    return `${link}${textBlock('Lebenslauf', resumeText)}`;
  }

  // --- Übersicht: Stellen und Kennzahlen -----------------------------------------------------

  function metricsSection(metrics) {
    const time = metrics.timeToFill;
    const stageRows = metrics.applicationsByStage
      .map(stage => `<div class="row"><div class="grow">${esc(stage.name)}</div><b>${esc(stage.count)}</b></div>`)
      .join('');
    return `<section class="cards">
      ${ui.stat('Offene Stellen', metrics.openRequisitions, `${metrics.pendingApproval} ${metrics.pendingApproval === 1 ? 'wartet' : 'warten'} auf Freigabe`)}
      ${ui.stat('Zeit bis Besetzung', time.averageDays === null ? '–' : `${ui.number(time.averageDays, 1)} ${time.averageDays === 1 ? 'Tag' : 'Tage'}`, `Durchschnitt aus ${ui.plural(time.filledCount, 'besetzten Stelle', 'besetzten Stellen')}`)}
      <article class="card"><h2>Bewerbungen je Stufe</h2>${stageRows}</article>
    </section>`;
  }

  async function homePage() {
    const me = window.loop.me;
    const query = state.statusFilter ? `?status=${encodeURIComponent(state.statusFilter)}` : '';
    const [{ requisitions, canCreate }, metrics] = await Promise.all([
      api(`/api/recruiting/requisitions${query}`),
      isHrRole(me) ? api('/api/recruiting/metrics') : Promise.resolve(null)
    ]);
    const rows = requisitions.map(requisition => `<tr>
      <td><b>${esc(requisition.title)}</b><small>${esc([requisition.positionTitle, requisition.internalPosting ? 'intern ausgeschrieben' : ''].filter(Boolean).join(' · '))}</small></td>
      <td data-label="Stand">${statusTag(REQUISITION_LABELS, requisition.status)}</td>
      <td data-label="Einstellende Führungskraft">${esc(requisition.hiringManagerName)}</td>
      <td data-label="Aktive Bewerbungen">${requisition.ownCandidacy ? '–' : esc(requisition.activeApplications)}</td>
      <td data-label="Besetzt">${requisition.ownCandidacy ? '–' : `${esc(requisition.hiredCount)} von ${esc(requisition.openings)}`}</td>
      <td data-label="Zieltermin">${esc(formatDate(requisition.targetDate))}</td>
      <td>${requisition.ownCandidacy
        ? '<span class="tag focus">Eigene Bewerbung</span>'
        : actionButton('Öffnen', 'open-requisition', { id: requisition.id })}</td>
    </tr>`).join('');
    const statusChoices = options([['', 'Alle Stände'], ...Object.entries(REQUISITION_LABELS)], state.statusFilter);
    const createButton = canCreate ? actionButton('+ Stelle anfordern', 'new-requisition', {}, { primary: true }) : '';
    return `${ui.header('Recruiting', isHrRole(me) ? 'Alle Stellen und Bewerbungen deiner Organisation.' : 'Deine Stellen und ihre Bewerbungen.', createButton)}
      ${metrics ? metricsSection(metrics) : ''}
      <article class="card" style="margin-top:18px">
        <div class="sectionHead">
          <h2>Stellen</h2>
          <select id="recruitingStatusFilter" class="recruiting-filter" aria-label="Stand filtern">${statusChoices}</select>
        </div>
        ${rows
          ? `<div class="tableWrap"><table class="table recruiting-table"><thead><tr><th>Stelle</th><th>Stand</th><th>Einstellende Führungskraft</th><th>Aktive Bewerbungen</th><th>Besetzt</th><th>Zieltermin</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : ui.empty('Hier gibt es noch keine passende Stelle.')}
      </article>`;
  }

  function requisitionSubtitle(rule) {
    return rule === 'none'
      ? 'Du legst zunächst einen Entwurf an und öffnest die Stelle dann. Eine Freigabe ist bei euch nicht nötig.'
      : 'Du legst zunächst einen Entwurf an und reichst ihn dann zur Freigabe bei HR ein.';
  }

  async function requisitionForm(requisition = null) {
    const meta = await api('/api/recruiting/meta');
    const permitsManagerChoice = !requisition || isHrRole(window.loop.me);
    const managerChoices = meta.hiringManagers.map(person => [person.id, person.name]);
    const selectedManager = requisition?.hiringManagerId ?? (managerChoices.some(([id]) => id === window.loop.me.id) ? window.loop.me.id : '');
    const managerField = permitsManagerChoice && managerChoices.length > 1
      ? `<label>Einstellende Führungskraft</label><select name="hiringManagerId" required>${options(managerChoices, selectedManager)}</select>`
      : '';
    const positionField = meta.talentEnabled && meta.positions.length
      ? `<label>Position (optional)</label><select name="positionProfileId"><option value="">Keine Position zuordnen</option>${options(meta.positions.map(position => [position.id, position.title]), requisition?.positionProfileId ?? '')}</select>`
      : '';
    ui.modal({
      title: requisition ? 'Stelle bearbeiten' : 'Stelle anfordern',
      subtitle: requisition ? '' : requisitionSubtitle(meta.requisitionRule),
      submitLabel: requisition ? 'Speichern' : 'Entwurf anlegen',
      body: `<label>Titel</label><input name="title" required maxlength="180" value="${esc(requisition?.title || '')}">
        ${positionField}
        <div class="two">
          <div><label>Anzahl Stellen</label><input name="openings" type="number" min="1" max="500" value="${esc(requisition?.openings ?? 1)}" required></div>
          <div><label>Zieltermin (optional)</label><input name="targetDate" type="date" value="${esc(requisition?.targetDate || '')}"></div>
        </div>
        ${managerField}
        <label>Beschreibung</label><textarea name="description" maxlength="8000">${esc(requisition?.description || '')}</textarea>
        <label class="checkRow"><input type="checkbox" name="internalPosting" ${requisition?.internalPosting ? 'checked' : ''}> Intern ausschreiben: In der Stellenbörse für alle Beschäftigten sichtbar, sobald die Stelle offen ist</label>`,
      onSubmit: async data => {
        const body = { ...data, internalPosting: data.internalPosting === 'on' };
        if (requisition) {
          await patch(`/api/recruiting/requisitions/${idPart(requisition.id)}`, body);
          refresh();
          return;
        }
        const { id, handedOver } = await post('/api/recruiting/requisitions', body);
        if (handedOver && !isHrRole(window.loop.me)) {
          ui.toast(meta.requisitionRule === 'none'
            ? 'Der Entwurf liegt jetzt bei der gewählten Führungskraft. Sie öffnet die Stelle.'
            : 'Der Entwurf liegt jetzt bei der gewählten Führungskraft. Sie reicht ihn zur Freigabe ein.');
          refresh();
          return;
        }
        state.requisitionId = id;
        window.loop.navigate('recruitingRequisition');
      }
    });
  }

  // --- Eine Stelle: Spaltenansicht -----------------------------------------------------------

  function requisitionButtons(requisition, permissions) {
    const step = (label, name, primary = false) => actionButton(label, 'requisition-step', { id: requisition.id, step: name }, { primary });
    return [
      permissions.canEdit ? actionButton('Bearbeiten', 'edit-requisition', { id: requisition.id }) : '',
      permissions.canSubmit ? step(permissions.submitOpensDirectly ? 'Stelle öffnen' : 'Zur Freigabe einreichen', 'submit', true) : '',
      permissions.canApprove ? step('Freigeben', 'approve', true) : '',
      permissions.canReturn ? step('Zurückgeben', 'return') : '',
      permissions.canPause ? step('Pausieren', 'pause') : '',
      permissions.canResume ? step('Fortsetzen', 'resume', true) : '',
      permissions.canFill ? step('Als besetzt markieren', 'fill') : '',
      permissions.canCancel ? step('Abbrechen', 'cancel') : ''
    ].join('');
  }

  function neighbouringStages(stages, stageId) {
    const movable = stages.filter(stage => stage.kind === 'normal' && stage.active);
    const index = movable.findIndex(stage => stage.id === stageId);
    return {
      previous: index > 0 ? movable[index - 1] : null,
      next: index >= 0 && index < movable.length - 1 ? movable[index + 1] : null
    };
  }

  function boardCard(card, stages, canMoveApplications) {
    const facts = [];
    if (card.internal) facts.push('Intern');
    if (card.interviewCount) facts.push(`${card.interviewCount} ${card.interviewCount === 1 ? 'Gespräch' : 'Gespräche'}`);
    if (card.ratingsHidden) facts.push('Bewertungen siehst du nach deiner eigenen');
    else if (card.feedbackCount) facts.push(`Schnitt ${ui.number(card.averageRating, 1)} von 5 aus ${ui.plural(card.feedbackCount, 'Bewertung', 'Bewertungen')}`);
    const { previous, next } = neighbouringStages(stages, card.stageId);
    const movable = canMoveApplications && card.status === 'active';
    return `<article class="recruiting-card">
      <b>${esc(card.candidateName)}</b>
      ${facts.length ? `<small>${esc(facts.join(' · '))}</small>` : ''}
      ${card.offerStatus ? `<span class="tag focus recruiting-card-tag">Angebot: ${esc(offerLabel(card.offerStatus, card.offerApprovalSkipped))}</span>` : ''}
      <div class="recruiting-card-actions">
        ${movable && previous ? actionButton('←', 'move', { id: card.id, stage: previous.id }, { title: `Zurück nach ${previous.name}` }) : '<span></span>'}
        ${actionButton('Öffnen', 'open-application', { id: card.id })}
        ${movable && next ? actionButton('→', 'move', { id: card.id, stage: next.id }, { title: `Weiter nach ${next.name}` }) : '<span></span>'}
      </div>
    </article>`;
  }

  async function requisitionPage() {
    if (!state.requisitionId) return backToStart('Bitte wähle zuerst eine Stelle aus.', 'recruitingHome', 'Zu den Stellen');
    const board = await api(`/api/recruiting/requisitions/${idPart(state.requisitionId)}/board`);
    const { requisition, permissions, stages, applications, rejected, canMoveApplications, hiddenApplications } = board;
    const columns = stages.map(stage => {
      const cards = applications.filter(card => card.stageId === stage.id);
      return `<section class="recruiting-column" aria-label="${esc(stage.name)}">
        <h3>${esc(stage.name)} <span class="tag">${esc(cards.length)}</span></h3>
        ${cards.map(card => boardCard(card, stages, canMoveApplications)).join('')}
      </section>`;
    }).join('');
    const rejectedRows = rejected.map(card => `<div class="row">
      <div class="grow"><b>${esc(card.candidateName)}</b><small>${esc(card.rejectionReasonLabel || '')}</small></div>
      ${actionButton('Öffnen', 'open-application', { id: card.id })}
    </div>`).join('');
    const activeCount = applications.filter(card => card.status === 'active').length;
    const closedHint = ['filled', 'cancelled'].includes(requisition.status) && activeCount
      ? `<p class="recruiting-note">Noch ${esc(ui.plural(activeCount, 'aktive Bewerbung', 'aktive Bewerbungen'))}. Bitte sage ihnen ab, damit niemand im Ungewissen bleibt.</p>`
      : '';
    const conflictHint = hiddenApplications
      ? `<p class="recruiting-note">${esc(ui.plural(hiddenApplications, 'Bewerbung ist', 'Bewerbungen sind'))} für dich ausgeblendet, weil du dich selbst auf eine Stelle beworben hast, auf die sich auch diese Personen beworben haben. Das bearbeitet eine andere HR-Person.</p>`
      : '';
    const headerActions = `<div class="recruiting-actions">
      <button type="button" class="btn" data-view="recruitingHome">← Alle Stellen</button>
      ${requisitionButtons(requisition, permissions)}
      ${permissions.canAddApplication ? actionButton('+ Bewerbung', 'add-application', { id: requisition.id }, { primary: true }) : ''}
    </div>`;
    const facts = [
      requisition.positionTitle ? `Position: ${requisition.positionTitle}` : '',
      `Einstellend: ${requisition.hiringManagerName}`,
      `Plätze: ${requisition.hiredCount} von ${requisition.openings} besetzt`,
      requisition.targetDate ? `Zieltermin: ${formatDate(requisition.targetDate)}` : ''
    ].filter(Boolean).join(' · ');
    return `${ui.header(requisition.title, facts, headerActions)}
      <article class="card" style="margin-top:18px">
        <div class="recruiting-actions">
          ${statusTag(REQUISITION_LABELS, requisition.status)}
          ${requisition.internalPosting ? '<span class="tag">Intern ausgeschrieben</span>' : ''}
        </div>
        ${requisition.returnComment ? `<p class="recruiting-note"><b>Rückmeldung von HR:</b> ${esc(requisition.returnComment)}</p>` : ''}
        ${closedHint}
        ${conflictHint}
        ${textBlock('Beschreibung', requisition.description)}
      </article>
      <div class="recruiting-board">${columns}</div>
      ${rejectedRows ? `<article class="card" style="margin-top:18px"><h2>Abgesagt oder zurückgezogen (${esc(rejected.length)})</h2>${rejectedRows}</article>` : ''}`;
  }

  function candidateFields(meta, { hr }) {
    const consent = hr
      ? `<label class="checkRow"><input type="checkbox" name="talentPoolConsent"> Einwilligung für den Talentpool liegt vor</label>
        <label>Datum der Einwilligung</label><input name="talentPoolConsentDate" type="date">`
      : '';
    return `<label>Name</label><input name="name" maxlength="160" ${hr ? '' : 'required'}>
      <div class="two">
        <div><label>E-Mail</label><input name="email" type="email" maxlength="254" ${hr ? '' : 'required'}></div>
        <div><label>Telefon (optional)</label><input name="phone" maxlength="40"></div>
      </div>
      <label>Quelle (optional)</label><select name="source"><option value=""></option>${options(meta.sources.map(source => [source, source]))}</select>
      <label>Link zum Lebenslauf (optional)</label><input name="resumeUrl" type="url" maxlength="1000" placeholder="https://">
      <label>Lebenslauf als Text (optional)</label><textarea name="resumeText" maxlength="20000"></textarea>
      <label>Notizen (optional)</label><textarea name="notes" maxlength="4000"></textarea>
      <p class="muted">Bitte erfasse keine Fotos, kein Geburtsdatum und keine Angaben wie Herkunft, Religion oder Gesundheit.</p>
      ${consent}`;
  }

  function readCandidateForm(data) {
    return {
      name: data.name,
      email: data.email,
      phone: data.phone,
      source: data.source,
      resumeUrl: data.resumeUrl,
      resumeText: data.resumeText,
      notes: data.notes,
      ...(data.talentPoolConsent === 'on' ? { talentPoolConsent: true, talentPoolConsentDate: data.talentPoolConsentDate || undefined } : {})
    };
  }

  async function addApplicationDialog(requisitionId) {
    const hr = isHrRole(window.loop.me);
    const [meta, existing] = await Promise.all([
      api('/api/recruiting/meta'),
      hr ? api('/api/recruiting/candidates') : Promise.resolve({ candidates: [] })
    ]);
    const existingField = hr && existing.candidates.length
      ? `<label>Vorhandene Person (optional)</label>
        <select name="candidateId"><option value="">Neue Person erfassen</option>${options(existing.candidates.map(candidate => [candidate.id, `${candidate.name} · ${candidate.email || ''}`]))}</select>
        <p class="muted">Wählst du hier jemanden aus, bleiben die Felder darunter leer.</p>`
      : '';
    ui.modal({
      title: 'Bewerbung erfassen',
      subtitle: 'Die Person startet in der ersten Stufe.',
      submitLabel: 'Bewerbung anlegen',
      body: `${existingField}${candidateFields(meta, { hr })}`,
      onSubmit: async data => {
        const body = data.candidateId ? { candidateId: data.candidateId } : { candidate: readCandidateForm(data) };
        await post(`/api/recruiting/requisitions/${idPart(requisitionId)}/applications`, body);
        ui.toast('Bewerbung angelegt.');
        refresh();
      }
    });
  }

  // --- Eine Bewerbung ------------------------------------------------------------------------

  function feedbackItem(feedback) {
    return `<div class="recruiting-feedback">
      <div class="recruiting-actions">
        <b>${esc(feedback.authorName)}</b>
        <span class="tag">${esc(feedback.rating)} von 5</span>
        <span class="tag">${esc(feedback.recommendationLabel)}</span>
      </div>
      ${textBlock('Stärken', feedback.strengths)}
      ${textBlock('Bedenken', feedback.concerns)}
    </div>`;
  }

  const HIDDEN_FEEDBACK_HINT = 'Bewertungen anderer Personen siehst du erst, wenn du selbst bewertet hast. So bleibt jede Einschätzung unabhängig.';

  function participantNames(interview) {
    return interview.participants
      .map(person => (person.submitted === undefined ? person.name : `${person.name} ${person.submitted ? '(bewertet)' : '(offen)'}`))
      .join(', ');
  }

  function interviewBlock(interview, applicationActive) {
    const planned = interview.status === 'planned';
    const buttons = [
      interview.canSubmitFeedback ? actionButton('Bewerten', 'open-interview', { id: interview.id }, { primary: true }) : '',
      planned && applicationActive ? actionButton('Ändern', 'edit-interview', { id: interview.id }) : '',
      planned && applicationActive ? actionButton('Absagen', 'cancel-interview', { id: interview.id }) : ''
    ].join('');
    return `<div class="recruiting-interview">
      <div class="sectionHead">
        <div>
          <b>${esc(formatDateTime(interview.scheduledAt))}</b>
          ${planned ? '' : ' <span class="tag focus">Abgesagt</span>'}
          <small class="recruiting-block">${esc(interview.location || 'Kein Ort angegeben')}</small>
          <small class="recruiting-block">${esc(participantNames(interview))}</small>
        </div>
        <div class="recruiting-actions">${buttons}</div>
      </div>
      ${interview.feedbackOpensAt ? '<p class="muted">Bewerten kannst du ab dem Termin.</p>' : ''}
      ${interview.feedbackVisible ? '' : `<p class="muted">${esc(HIDDEN_FEEDBACK_HINT)}</p>`}
      ${interview.feedback.map(feedbackItem).join('')}
    </div>`;
  }

  function offerSubmitLabel(offerRule) {
    return offerRule === 'none' ? 'Angebot fertigstellen' : 'Zur Freigabe geben';
  }

  function offerBlock(offer, offerRule) {
    const buttons = [
      offer.canEdit ? actionButton('Bearbeiten', 'offer-edit', { id: offer.id }) : '',
      offer.canSubmit ? actionButton(offerSubmitLabel(offerRule), 'offer-submit', { id: offer.id }, { primary: true }) : '',
      offer.canApprove ? actionButton('Freigeben', 'offer-approve', { id: offer.id }, { primary: true }) : '',
      offer.canReturn ? actionButton('Zurückgeben', 'offer-return', { id: offer.id }) : '',
      offer.canRespond ? actionButton('Angenommen', 'offer-response', { id: offer.id, accepted: 'true' }, { primary: true }) : '',
      offer.canRespond ? actionButton('Abgelehnt', 'offer-response', { id: offer.id, accepted: 'false' }) : ''
    ].join('');
    return `<div class="recruiting-interview">
      <div class="sectionHead">
        <div>
          <b>${esc(offer.positionTitle)}</b> <span class="tag ${ATTENTION_STATUSES.includes(offer.status) ? 'focus' : ''}">${esc(offerLabel(offer.status, offer.approvalSkipped))}</span>
          <small class="recruiting-block">Eintritt am ${esc(formatDate(offer.startDate))} · erstellt von ${esc(offer.createdByName || '–')}</small>
          ${offer.approvedByName ? `<small class="recruiting-block">${esc(offer.approvalSkipped ? 'Fertiggestellt von' : 'Freigegeben von')} ${esc(offer.approvedByName)}</small>` : ''}
        </div>
        <div class="recruiting-actions">${buttons}</div>
      </div>
      ${textBlock('Vergütung', offer.compensation)}
      ${offer.returnComment ? `<p class="recruiting-note"><b>Rückmeldung:</b> ${esc(offer.returnComment)}</p>` : ''}
      ${offer.approvalBlockedForYou ? '<p class="muted">Du hast dieses Angebot erstellt oder zuletzt geändert. Eine andere HR-Person muss es freigeben.</p>' : ''}
    </div>`;
  }

  function historyRow(entry, withdrawn) {
    let description = `${entry.fromStageName || 'Start'} → ${entry.toStageName || '–'}`;
    if (!entry.fromStatus) description = `Bewerbung angelegt in ${entry.toStageName || '–'}`;
    else if (entry.toStatus === 'rejected') description = withdrawn ? 'Zurückgezogen' : 'Abgesagt';
    else if (entry.toStatus === 'hired') description = 'Eingestellt';
    return `<div class="row"><div class="grow"><b>${esc(description)}</b><small>${esc(formatDate(entry.changedAt))} · ${esc(entry.changedByName || 'System')}</small></div></div>`;
  }

  function candidatePanel(data) {
    const { candidate, permissions, application } = data;
    const duplicateHint = (candidate.duplicates || []).length
      ? `<p class="recruiting-note">Vielleicht doppelt erfasst: Dieselbe E-Mail gehört auch zu ${esc(candidate.duplicates.map(item => item.name).join(', '))}.</p>`
      : '';
    const employeeHint = candidate.matchingEmployee
      ? `<p class="recruiting-note">Diese E-Mail gehört zum Konto von ${esc(candidate.matchingEmployee.name)}. Bei einer Einstellung entsteht kein neues Konto.</p>`
      : '';
    const consent = candidate.talentPoolConsent
      ? `Ja, seit ${formatDate(candidate.talentPoolConsentDate)}`
      : 'Nein';
    const facts = [
      ['E-Mail', candidate.email || '–'],
      ['Telefon', candidate.phone || '–'],
      ['Quelle', candidate.source || '–'],
      ['Talentpool', consent]
    ].map(([label, value]) => `<div class="row"><div class="grow"><small>${esc(label)}</small><b>${esc(value)}</b></div></div>`).join('');
    const buttons = [
      permissions.canEditCandidate ? actionButton('Bearbeiten', 'edit-candidate', { id: candidate.id, full: permissions.canEditCandidateFully ? '1' : '0' }) : '',
      permissions.canAnonymize ? actionButton('Anonymisieren', 'anonymize', { id: candidate.id }) : ''
    ].join('');
    return `<article class="card">
      <div class="sectionHead"><h2>Person</h2><div class="recruiting-actions">${buttons}</div></div>
      ${candidate.anonymized ? '<p class="recruiting-note">Diese Person wurde anonymisiert.</p>' : ''}
      ${duplicateHint}${employeeHint}
      ${facts}
      ${textBlock('Nachricht zur Bewerbung', application.message)}
      ${resumeBlock(candidate.resumeText, candidate.resumeUrl)}
      ${textBlock('Notizen', candidate.notes)}
    </article>`;
  }

  function statusPanel(data) {
    const { application, permissions, stages, candidate } = data;
    const stageChoices = stages.filter(stage => stage.kind === 'normal');
    const stageSelect = permissions.canMove
      ? `<label for="recruitingStageSelect">Stufe ändern</label>
        <select id="recruitingStageSelect" data-id="${esc(application.id)}">${options(stageChoices.map(stage => [stage.id, stage.name]), application.stageId)}</select>`
      : '';
    const withdrawn = application.rejectionReason === 'candidate_withdrew';
    const rejectedBlock = application.status === 'rejected'
      ? `<p class="recruiting-text"><b>${withdrawn ? 'Grund (nur intern)' : 'Absagegrund (nur intern)'}</b><br>${esc(application.rejectionReasonLabel || '–')}</p>${textBlock('Interne Notiz', application.rejectionNote)}`
      : '';
    const buttons = [
      permissions.canHire ? actionButton('Einstellen', 'hire', { id: application.id, name: candidate.name, internal: candidate.internal || candidate.matchingEmployee ? '1' : '0' }, { primary: true }) : '',
      permissions.canReject ? actionButton('Absagen', 'reject', { id: application.id }) : '',
      permissions.canCopyRejectionText ? actionButton('Absagetext', 'rejection-text', { id: application.id }) : ''
    ].join('');
    const hireHint = application.status === 'active' && !permissions.canHire && data.access === 'hr'
      ? '<p class="muted">Einstellen geht, sobald das Angebot angenommen wurde und noch ein Platz frei ist.</p>'
      : '';
    return `<article class="card">
      <div class="sectionHead"><h2>Stand</h2>${statusTag(APPLICATION_LABELS, withdrawn ? 'withdrawn' : application.status)}</div>
      <p><b>${esc(application.stageName)}</b><br><small class="muted">Beworben am ${esc(formatDate(application.appliedAt))}</small></p>
      ${stageSelect}
      ${rejectedBlock}
      <div class="recruiting-actions" style="margin-top:12px">${buttons}</div>
      ${hireHint}
    </article>`;
  }

  function managingApplicationPage(data) {
    const { application, requisition, candidate, interviews, offers, history, permissions } = data;
    const active = application.status === 'active';
    const backButton = `<button type="button" class="btn" data-recruiting-action="open-requisition" data-id="${esc(requisition.id)}">← Zur Stelle</button>`;
    return `${ui.header(candidate.name, requisition.title, backButton)}
      <div class="recruiting-detail">
        <div class="recruiting-stack">
          ${statusPanel(data)}
          <article class="card">
            <div class="sectionHead">
              <h2>Gespräche</h2>
              ${permissions.canPlanInterview ? actionButton('+ Gespräch', 'plan-interview', { id: application.id }) : ''}
            </div>
            ${interviews.map(interview => interviewBlock(interview, active)).join('') || ui.empty('Noch kein Gespräch geplant.')}
          </article>
          <article class="card">
            <div class="sectionHead">
              <h2>Angebot</h2>
              ${permissions.canCreateOffer ? actionButton('+ Angebot', 'offer-new', { id: application.id }) : ''}
            </div>
            ${offers.map(offer => offerBlock(offer, data.offerRule)).join('') || ui.empty('Noch kein Angebot erstellt.')}
          </article>
        </div>
        <div class="recruiting-stack">
          ${candidatePanel(data)}
          <article class="card"><h2>Verlauf</h2>${history.map(entry => historyRow(entry, application.rejectionReason === 'candidate_withdrew')).join('')}</article>
        </div>
      </div>`;
  }

  function interviewerApplicationPage(data) {
    const { candidate, requisition, interviews } = data;
    const rows = interviews.map(interview => `<div class="row">
      <div class="grow"><b>${esc(formatDateTime(interview.scheduledAt))}</b><small>${esc(interview.location || 'Kein Ort angegeben')}</small></div>
      ${actionButton(interview.canSubmitFeedback ? 'Bewerten' : 'Öffnen', 'open-interview', { id: interview.id }, { primary: interview.canSubmitFeedback })}
    </div>`).join('');
    return `${ui.header(candidate.name, requisition.title)}
      <section class="cards">
        <article class="card wide">
          <h2>Zur Vorbereitung</h2>
          ${resumeBlock(candidate.resumeText, candidate.resumeUrl) || ui.empty('Es liegt kein Lebenslauf vor.')}
          ${textBlock('Stelle', requisition.description)}
        </article>
        <article class="card"><h2>Deine Gespräche</h2>${rows}</article>
      </section>`;
  }

  function selfApplicationPage(data) {
    const { application, requisition } = data;
    return `${ui.header(requisition.title, 'Deine eigene Bewerbung')}
      <article class="card" style="margin-top:18px">
        <p>${statusTag(APPLICATION_LABELS, applicationStatus(application))} <b>${esc(application.stageName)}</b></p>
        <p class="muted">Beworben am ${esc(formatDate(application.appliedAt))}. Bewertungen und Angebotsdetails zu deiner eigenen Bewerbung siehst du hier nicht.</p>
        <button type="button" class="btn" data-view="${BOARD_VIEW}">Zur Stellenbörse</button>
      </article>`;
  }

  async function applicationPage() {
    if (!state.applicationId) return backToStart('Bitte wähle zuerst eine Bewerbung aus.', canManage(window.loop.me) ? 'recruitingHome' : BOARD_VIEW, canManage(window.loop.me) ? 'Zu den Stellen' : 'Zur Stellenbörse');
    const data = await api(`/api/recruiting/applications/${idPart(state.applicationId)}`);
    if (data.access === 'self') return selfApplicationPage(data);
    if (data.access === 'interviewer') return interviewerApplicationPage(data);
    return managingApplicationPage(data);
  }

  // --- Absage --------------------------------------------------------------------------------

  async function copyToClipboard(textarea) {
    textarea.focus();
    textarea.select();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(textarea.value);
      else if (!document.execCommand('copy')) throw new Error('copy');
      ui.toast('Text kopiert.');
    } catch {
      ui.toast('Kopieren hat nicht geklappt. Der Text ist markiert, drücke Strg + C.', 'error');
    }
  }

  function showRejectionText({ subject, text }) {
    ui.modal({
      title: 'Absagetext zum Kopieren',
      subtitle: 'Daybreak versendet keine E-Mails. Füge den Text in dein E-Mail-Programm ein.',
      body: `<textarea id="recruitingCopyText" class="recruiting-copy" readonly>${esc(`Betreff: ${subject}\n\n${text}`)}</textarea>
        <button type="button" class="btn primary full" id="recruitingCopyButton">Text kopieren</button>`
    });
    document.querySelector('#recruitingCopyButton').onclick = () => copyToClipboard(document.querySelector('#recruitingCopyText'));
  }

  async function rejectDialog(applicationId) {
    const meta = await api('/api/recruiting/meta');
    ui.modal({
      title: 'Bewerbung absagen',
      subtitle: 'Grund und Notiz bleiben intern und erscheinen nicht im Absagetext.',
      submitLabel: 'Absagen',
      body: `<label>Grund</label><select name="reason" required><option value="">Bitte wählen</option>${options(meta.rejectionReasons.map(reason => [reason.key, reason.label]))}</select>
        <label>Interne Notiz (optional)</label><textarea name="note" maxlength="2000"></textarea>`,
      onSubmit: async data => {
        const { rejectionText } = await post(`/api/recruiting/applications/${idPart(applicationId)}/reject`, data);
        refresh();
        if (!rejectionText) {
          ui.toast('Die Bewerbung ist als zurückgezogen vermerkt.');
          return false;
        }
        showRejectionText(rejectionText);
        return true;
      }
    });
  }

  // --- Gespräche -----------------------------------------------------------------------------

  async function interviewForm({ applicationId, interview = null }) {
    const { people } = await api(`/api/recruiting/applications/${idPart(applicationId)}/participant-options`);
    const selected = new Set((interview?.participants || []).map(person => String(person.id)));
    const checklist = people.map(person => `<label class="checkRow">
      <input type="checkbox" name="participantIds" value="${esc(person.id)}" ${selected.has(String(person.id)) ? 'checked' : ''}>
      <span>${esc(person.name)}${person.title ? ` <small class="muted">${esc(person.title)}</small>` : ''}</span>
    </label>`).join('');
    ui.modal({
      title: interview ? 'Gespräch ändern' : 'Gespräch planen',
      subtitle: 'Jede beteiligte Person bekommt eine Aufgabe und bewertet ab dem Termin. Daybreak verschickt keine Einladung.',
      body: `<label>Termin</label><input name="scheduledAt" type="datetime-local" required value="${esc(interview?.scheduledAt || '')}">
        <label>Ort oder Videolink (optional)</label><input name="location" maxlength="200" value="${esc(interview?.location || '')}">
        <label>Beteiligte Personen</label><div class="recruiting-checklist">${checklist}</div>`,
      onSubmit: async (data, form) => {
        const participantIds = new FormData(form).getAll('participantIds');
        if (!participantIds.length) throw new Error('Bitte wähle mindestens eine Person aus.');
        const body = { scheduledAt: data.scheduledAt, location: data.location, participantIds };
        if (interview) await patch(`/api/recruiting/interviews/${idPart(interview.id)}`, body);
        else await post(`/api/recruiting/applications/${idPart(applicationId)}/interviews`, body);
        ui.toast(interview ? 'Gespräch geändert.' : 'Gespräch geplant.');
        refresh();
      }
    });
  }

  function feedbackDialog(interviewId, recommendations) {
    ui.modal({
      title: 'Gespräch bewerten',
      subtitle: 'Deine Bewertung lässt sich danach nicht mehr ändern. Fremde Bewertungen siehst du erst danach.',
      submitLabel: 'Bewertung abgeben',
      body: `<label>Bewertung</label><select name="rating" required><option value="">Bitte wählen</option>${options([5, 4, 3, 2, 1].map(value => [value, `${value} von 5`]))}</select>
        <label>Stärken</label><textarea name="strengths" maxlength="4000"></textarea>
        <label>Bedenken</label><textarea name="concerns" maxlength="4000"></textarea>
        <label>Empfehlung</label><select name="recommendation" required><option value="">Bitte wählen</option>${options(recommendations.map(item => [item.key, item.label]))}</select>
        <p class="muted">Bewerte nur, was für die Stelle wichtig ist. Herkunft, Alter, Gesundheit oder Familienplanung gehören nicht hierher.</p>`,
      onSubmit: async data => {
        await post(`/api/recruiting/interviews/${idPart(interviewId)}/feedback`, data);
        ui.toast('Bewertung abgegeben.');
        refresh();
      }
    });
  }

  async function interviewsPage() {
    const { interviews } = await api('/api/recruiting/interviews/mine');
    const rows = interviews.map(interview => `<div class="row">
      <div class="grow">
        <b>${esc(interview.candidateName)}</b>
        <small>${esc(interview.requisitionTitle)} · ${esc(formatDateTime(interview.scheduledAt))}${interview.location ? ` · ${esc(interview.location)}` : ''}</small>
      </div>
      <span class="tag ${interview.submitted ? '' : 'focus'}">${interview.submitted ? 'Bewertet' : interview.canSubmitFeedback ? 'Offen' : 'Termin steht noch aus'}</span>
      ${actionButton(interview.canSubmitFeedback ? 'Bewerten' : 'Öffnen', 'open-interview', { id: interview.id }, { primary: interview.canSubmitFeedback })}
    </div>`).join('');
    return `${ui.header('Meine Gespräche', 'Gespräche, zu denen du eingeteilt bist.')}
      <article class="card" style="margin-top:18px">${rows || ui.empty('Du bist gerade keinem Gespräch zugewiesen.')}</article>`;
  }

  async function interviewPage() {
    if (!state.interviewId) return backToStart('Bitte wähle zuerst ein Gespräch aus.', 'recruitingInterviews', 'Zu meinen Gesprächen');
    const data = await api(`/api/recruiting/interviews/${idPart(state.interviewId)}`);
    const { interview, candidate, requisition, access } = data;
    const backButton = access === 'interviewer'
      ? '<button type="button" class="btn" data-view="recruitingInterviews">← Meine Gespräche</button>'
      : actionButton('← Zur Bewerbung', 'open-application', { id: interview.applicationId });
    const feedbackSection = interview.feedbackVisible
      ? (interview.feedback.map(feedbackItem).join('') || ui.empty('Es liegt noch keine Bewertung vor.'))
      : ui.empty(HIDDEN_FEEDBACK_HINT);
    return `${ui.header(candidate.name, `${requisition.title} · ${formatDateTime(interview.scheduledAt)}`, backButton)}
      <section class="cards">
        <article class="card wide">
          <h2>Zur Vorbereitung</h2>
          <p class="muted">${esc(interview.location || 'Kein Ort angegeben')} · Beteiligt: ${esc(participantNames(interview))}</p>
          ${resumeBlock(candidate.resumeText, candidate.resumeUrl) || ui.empty('Es liegt kein Lebenslauf vor.')}
          ${textBlock('Stelle', requisition.description)}
        </article>
        <article class="card">
          <h2>Deine Bewertung</h2>
          ${interview.ownFeedback
            ? feedbackItem(interview.ownFeedback)
            : interview.canSubmitFeedback
              ? actionButton('Jetzt bewerten', 'give-feedback', { id: interview.id }, { primary: true })
              : ui.empty(interview.feedbackOpensAt ? `Bewerten kannst du ab dem Termin: ${formatDateTime(interview.feedbackOpensAt)}.` : 'Hier ist keine Bewertung von dir vorgesehen.')}
        </article>
      </section>
      <article class="card" style="margin-top:18px"><h2>Alle Bewertungen</h2>${feedbackSection}</article>`;
  }

  // --- Angebot und Einstellung ---------------------------------------------------------------

  const OFFER_FORM_HINTS = {
    four_eyes: 'Danach gibt es eine HR-Person frei. Wer es erstellt oder zuletzt geändert hat, darf das nicht selbst tun.',
    hr: 'Danach gibt es eine HR-Person frei. Das darf auch die Person sein, die es erstellt hat.',
    none: 'Eine Freigabe ist bei euch nicht nötig. Sobald es fertig ist, trägst du die Antwort der Person ein.'
  };

  function offerForm({ applicationId, offer = null, positionTitle = '', offerRule }) {
    ui.modal({
      title: offer ? 'Angebot bearbeiten' : 'Angebot erstellen',
      subtitle: OFFER_FORM_HINTS[offerRule] || OFFER_FORM_HINTS.four_eyes,
      body: `<label>Eintrittsdatum</label><input name="startDate" type="date" required value="${esc(offer?.startDate || '')}">
        <label>Position</label><input name="positionTitle" maxlength="180" value="${esc(offer?.positionTitle || positionTitle)}">
        <label>Vergütung (Freitext)</label><textarea name="compensation" maxlength="2000">${esc(offer?.compensation || '')}</textarea>`,
      onSubmit: async data => {
        if (offer) await patch(`/api/recruiting/offers/${idPart(offer.id)}`, data);
        else await post(`/api/recruiting/applications/${idPart(applicationId)}/offers`, data);
        ui.toast(offer ? 'Angebot gespeichert.' : 'Angebot erstellt.');
        refresh();
      }
    });
  }

  async function currentApplicationDetail() {
    return api(`/api/recruiting/applications/${idPart(state.applicationId)}`);
  }

  /**
   * Die Akte gehört dem Modul Personalakte und wird deshalb über dessen Schnittstelle geschrieben.
   * Ein vorhandenes Konto behält sein Eintrittsdatum: Ein interner Wechsel ist kein neuer Eintritt.
   */
  async function recordEntryDate(result) {
    if (result.internal || !result.personnelEnabled || !result.entryDate) return null;
    const date = formatDate(result.entryDate);
    if (result.entryDateRecorded) return `Das Eintrittsdatum ${date} steht jetzt in der Personalakte. Vertrag und Vergütung trägst du dort selbst ein, denn das Angebot enthält sie nur als freien Text.`;
    try {
      await patch(`/api/personnel/${idPart(result.userId)}/master`, { entryDate: result.entryDate });
      return `Das Eintrittsdatum ${date} steht jetzt in der Personalakte. Vertrag und Vergütung trägst du dort selbst ein, denn das Angebot enthält sie nur als freien Text.`;
    } catch (error) {
      return `Das Eintrittsdatum konnte nicht in die Personalakte übernommen werden: ${error.message} Bitte trage den ${date} dort selbst ein.`;
    }
  }

  const isFutureDate = date => Boolean(date) && date > new Date().toISOString().slice(0, 10);

  function showHireResult(result, name, entryDateNote) {
    const notes = [];
    if (entryDateNote) notes.push(entryDateNote);
    if (result.journeyId) notes.push('Der Einstiegs-Ablauf wurde gestartet.');
    if (result.onboardingNote) notes.push(result.onboardingNote);
    if (result.requisitionFilled) notes.push('Alle Plätze sind vergeben, die Stelle ist jetzt besetzt.');
    if (result.remainingActiveApplications > 0) {
      notes.push(`Es ${result.remainingActiveApplications === 1 ? 'ist noch 1 Bewerbung' : `sind noch ${result.remainingActiveApplications} Bewerbungen`} aktiv.`);
    }
    const noteList = notes.map(note => `<p class="muted">${esc(note)}</p>`).join('');
    if (result.internal) {
      const change = result.positionChange;
      ui.modal({
        title: 'Interner Wechsel',
        subtitle: name,
        body: `<p>Für diese Person gibt es schon ein Konto, deshalb wurde kein neues angelegt. Daybreak hat den Wechsel protokolliert, das Konto aber nicht verändert.</p>
          <p><b>Bitte unter „Mitarbeitende“ im Reiter „Konten“ über „Zuordnen“ prüfen und selbst eintragen:</b></p>
          <p>Position: ${esc(change.positionTitle)}<br>Führungskraft: ${esc(change.managerName)}<br>Ab: ${esc(formatDate(change.startDate))}</p>
          ${noteList}
          <button type="button" class="btn primary full" id="recruitingOpenPeople">Zu „Konten“</button>`
      });
      document.querySelector('#recruitingOpenPeople').onclick = () => {
        ui.closeModal();
        window.loop.navigate('people');
      };
      return;
    }
    const passwordHint = isFutureDate(result.entryDate)
      ? `Das Konto ist ab sofort aktiv. Gib dieses temporäre Passwort deshalb erst zum Eintritt am ${esc(formatDate(result.entryDate))} persönlich weiter.`
      : 'Gib dieses temporäre Passwort persönlich weiter.';
    ui.modal({
      title: 'Konto angelegt',
      subtitle: name,
      body: `<p>${passwordHint} Es wird nicht noch einmal angezeigt und muss bei der ersten Anmeldung geändert werden.</p>
        <p><code class="tempPassword">${esc(result.temporaryPassword || '')}</code></p>
        ${noteList}`
    });
  }

  async function hireDialog({ id, name, internal }) {
    const isInternal = internal === '1';
    const meta = await api('/api/recruiting/meta');
    let templates = [];
    if (meta.onboardingEnabled) {
      templates = (await api('/api/onboarding/templates?kind=onboarding')).templates.filter(template => template.tasks.length > 0);
    }
    const templateField = templates.length > 1
      ? `<label>Vorlage für den Einstieg</label><select name="templateId">${options(templates.map(template => [template.id, template.name]))}</select>`
      : '';
    const onboardingFields = meta.onboardingEnabled
      ? `${isInternal ? '<label class="checkRow"><input type="checkbox" name="startOnboarding"> Einstiegs-Ablauf für die neue Stelle starten</label>' : '<p class="muted">Der Einstiegs-Ablauf startet automatisch mit dem Eintrittsdatum.</p>'}${templateField}`
      : '';
    const roleField = isInternal
      ? ''
      : `<label>Rolle im neuen Konto</label>
        <select name="role">${options(meta.hireRoles.map(role => [role.key, role.label]), 'employee')}</select>`;
    ui.modal({
      title: 'Person einstellen',
      subtitle: name,
      submitLabel: 'Einstellen',
      body: `<p>${isInternal
        ? 'Die Person hat schon ein Konto. Es entsteht kein neues, der Wechsel wird dir angeboten und protokolliert.'
        : 'Daybreak legt jetzt ein Konto an und zeigt das temporäre Passwort genau einmal. Das Konto ist sofort aktiv, auch wenn der Eintritt später ist.'}</p>${roleField}${onboardingFields}`,
      onSubmit: async data => {
        const body = {};
        if (data.templateId) body.templateId = data.templateId;
        if (data.startOnboarding === 'on') body.startOnboarding = true;
        if (data.role) body.role = data.role;
        const result = await post(`/api/recruiting/applications/${idPart(id)}/hire`, body);
        const entryDateNote = await recordEntryDate(result);
        refresh();
        showHireResult(result, name, entryDateNote);
        return true;
      }
    });
  }

  // --- Bewerbende ----------------------------------------------------------------------------

  async function candidatesPage() {
    const query = new URLSearchParams();
    if (state.candidateSearch) query.set('q', state.candidateSearch);
    if (state.talentPoolOnly) query.set('talentPool', 'true');
    const { candidates, retentionMonths } = await api(`/api/recruiting/candidates?${query}`);
    const rows = candidates.map(candidate => `<tr>
      <td><b>${esc(candidate.name)}</b><small>${esc(candidate.email || '')}${candidate.internal ? ' · intern' : ''}</small></td>
      <td data-label="Quelle">${esc(candidate.source || '–')}</td>
      <td data-label="Talentpool">${candidate.talentPoolConsent ? `Ja, seit ${esc(formatDate(candidate.talentPoolConsentDate))}` : 'Nein'}</td>
      <td data-label="Bewerbungen">${esc(candidate.applicationCount)} (${esc(candidate.activeApplications)} aktiv)</td>
      <td data-label="Letzte Absage">${esc(formatDate(candidate.lastRejectedAt))}</td>
      <td class="recruiting-actions">
        ${actionButton('Bearbeiten', 'edit-candidate', { id: candidate.id, full: '1' })}
        ${candidate.activeApplications ? '' : actionButton('Anonymisieren', 'anonymize', { id: candidate.id })}
      </td>
    </tr>`).join('');
    return `${ui.header('Bewerbende', 'Alle erfassten Personen und der Talentpool.', actionButton('+ Person', 'new-candidate', {}, { primary: true }))}
      <p class="recruiting-note" style="margin-top:18px">Hinweis, bitte im Einzelfall prüfen: Abgesagte Bewerbende werden ${esc(retentionMonths)} Monate nach der letzten Absage automatisch anonymisiert, außer es liegt eine gültige Einwilligung für den Talentpool vor. Name, Kontaktdaten, Notizen, Lebenslauf und Freitexte verschwinden dabei endgültig.</p>
      <article class="card" style="margin-top:18px">
        <form id="recruitingCandidateSearch" class="recruiting-search">
          <input name="q" type="search" placeholder="Name oder E-Mail suchen" aria-label="Suche" value="${esc(state.candidateSearch)}">
          <label class="checkRow"><input type="checkbox" name="talentPool" ${state.talentPoolOnly ? 'checked' : ''}> Nur Talentpool</label>
          <button class="btn">Suchen</button>
        </form>
        ${rows
          ? `<div class="tableWrap"><table class="table recruiting-table"><thead><tr><th>Person</th><th>Quelle</th><th>Talentpool</th><th>Bewerbungen</th><th>Letzte Absage</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : ui.empty('Keine passende Person gefunden.')}
      </article>`;
  }

  async function candidateEditDialog({ id, full }) {
    const fullAccess = full === '1';
    const [{ candidate }, meta] = await Promise.all([
      api(`/api/recruiting/candidates/${idPart(id)}`),
      fullAccess ? api('/api/recruiting/meta') : Promise.resolve({ sources: [] })
    ]);
    const identityFields = fullAccess
      ? `${candidate.internal
        ? `<p class="muted">Name und E-Mail stammen aus dem Konto: ${esc(candidate.name)}, ${esc(candidate.email || '')}.</p>`
        : `<label>Name</label><input name="name" required maxlength="160" value="${esc(candidate.name)}">
          <label>E-Mail</label><input name="email" type="email" required maxlength="254" value="${esc(candidate.email || '')}">`}
        <label>Quelle</label><select name="source"><option value=""></option>${options(meta.sources.map(source => [source, source]), candidate.source || '')}</select>`
      : '';
    const consentFields = fullAccess
      ? `<label class="checkRow"><input type="checkbox" name="talentPoolConsent" ${candidate.talentPoolConsent ? 'checked' : ''}> Einwilligung für den Talentpool liegt vor</label>
        <label>Datum der Einwilligung</label><input name="talentPoolConsentDate" type="date" value="${esc(candidate.talentPoolConsentDate || '')}">`
      : '';
    ui.modal({
      title: 'Person bearbeiten',
      body: `${identityFields}
        <label>Telefon</label><input name="phone" maxlength="40" value="${esc(candidate.phone || '')}">
        <label>Link zum Lebenslauf</label><input name="resumeUrl" type="url" maxlength="1000" value="${esc(candidate.resumeUrl || '')}">
        <label>Lebenslauf als Text</label><textarea name="resumeText" maxlength="20000">${esc(candidate.resumeText || '')}</textarea>
        <label>Notizen</label><textarea name="notes" maxlength="4000">${esc(candidate.notes || '')}</textarea>
        <p class="muted">Bitte erfasse keine Fotos, kein Geburtsdatum und keine Angaben wie Herkunft, Religion oder Gesundheit.</p>
        ${consentFields}`,
      onSubmit: async data => {
        const body = { phone: data.phone, resumeUrl: data.resumeUrl, resumeText: data.resumeText, notes: data.notes };
        if (fullAccess) {
          body.source = data.source;
          body.talentPoolConsent = data.talentPoolConsent === 'on';
          if (data.talentPoolConsentDate) body.talentPoolConsentDate = data.talentPoolConsentDate;
          if (!candidate.internal) {
            body.name = data.name;
            body.email = data.email;
          }
        }
        await patch(`/api/recruiting/candidates/${idPart(id)}`, body);
        refresh();
      }
    });
  }

  async function newCandidateDialog() {
    const meta = await api('/api/recruiting/meta');
    ui.modal({
      title: 'Person erfassen',
      subtitle: 'Zum Beispiel für den Talentpool. Eine Bewerbung ordnest du später auf der Stelle zu.',
      body: candidateFields(meta, { hr: true }),
      onSubmit: async data => {
        await post('/api/recruiting/candidates', readCandidateForm(data));
        refresh();
      }
    });
  }

  // --- Einstellungen -------------------------------------------------------------------------

  async function settingsPage() {
    const [{ settings, canManage: canChange }, { stages }] = await Promise.all([
      api('/api/recruiting/settings'),
      api('/api/recruiting/stages?includeInactive=true')
    ]);
    const activeNormal = stages.filter(stage => stage.active && stage.kind === 'normal');
    const stageRow = stage => {
      const index = activeNormal.findIndex(item => item.id === stage.id);
      const moveButtons = stage.active && stage.kind === 'normal'
        ? `${index > 0 ? actionButton('↑', 'stage-move', { id: stage.id, direction: 'up' }, { title: `${stage.name} nach oben` }) : ''}
          ${index < activeNormal.length - 1 ? actionButton('↓', 'stage-move', { id: stage.id, direction: 'down' }, { title: `${stage.name} nach unten` }) : ''}`
        : '';
      const toggle = stage.kind === 'hired'
        ? '<span class="tag">Fester Abschluss</span>'
        : actionButton(stage.active ? 'Abschalten' : 'Einschalten', 'stage-toggle', { id: stage.id, active: stage.active ? '0' : '1' });
      return `<div class="row recruiting-stage ${stage.active ? '' : 'recruiting-inactive'}">
        <div class="grow"><b>${esc(stage.name)}</b>${stage.active ? '' : '<small>Abgeschaltet</small>'}</div>
        ${canChange ? `<div class="recruiting-actions">
          ${moveButtons}
          ${actionButton('Umbenennen', 'stage-rename', { id: stage.id, name: stage.name })}
          ${toggle}
        </div>` : ''}
      </div>`;
    };
    const retentionField = canChange
      ? `<form id="recruitingRetentionForm" class="talent-form">
            <div class="error" id="recruitingRetentionError"></div>
            <label for="recruitingRetentionMonths">Abgesagte Bewerbende anonymisieren nach (Monaten)</label>
            <input id="recruitingRetentionMonths" name="retentionMonths" type="number" min="${esc(settings.minRetentionMonths)}" max="${esc(settings.maxRetentionMonths)}" required value="${esc(settings.retentionMonths)}">
            <p class="muted">Erlaubt sind ${esc(settings.minRetentionMonths)} bis ${esc(settings.maxRetentionMonths)} Monate.</p>
            <button class="btn primary">Speichern</button>
          </form>`
      : `<p>Abgesagte Bewerbende werden nach <b>${esc(settings.retentionMonths)} Monaten</b> anonymisiert.</p>`;
    return `${ui.header('Einstellungen', 'Stufen und Aufbewahrungsfrist für deine ganze Organisation.')}
      ${canChange ? '' : '<p class="recruiting-note" style="margin-top:18px">Diese Einstellungen gelten für alle. Ändern kann sie nur die HR-Administration.</p>'}
      <section class="recruiting-detail" style="margin-top:18px">
        <article class="card">
          <div class="sectionHead"><h2>Stufen</h2>${canChange ? actionButton('+ Stufe', 'stage-add') : ''}</div>
          <p class="muted">So laufen Bewerbungen von links nach rechts durch die Spaltenansicht. In „Eingestellt“ gelangt eine Bewerbung nur über „Einstellen“.</p>
          ${stages.map(stageRow).join('')}
        </article>
        <article class="card">
          <h2>Aufbewahrung</h2>
          ${retentionField}
          <p class="recruiting-note"><b>Achtung:</b> Nach Ablauf der Frist löscht Daybreak Name, Kontaktdaten, Notizen, Lebenslauf und Freitexte automatisch und endgültig. Das lässt sich nicht rückgängig machen.</p>
          <p class="recruiting-note">Hinweis, bitte im Einzelfall prüfen: Welche Frist für euch passt, hängt von euren Regelungen und dem Einzelfall ab. Abgelehnte können sich oft noch Monate nach der Absage beschweren, eine zu kurze Frist nimmt dir dann die Unterlagen. Eine gültige Einwilligung für den Talentpool nimmt eine Person von der automatischen Anonymisierung aus.</p>
        </article>
      </section>`;
  }

  // --- Stellenbörse --------------------------------------------------------------------------

  async function boardPage() {
    const { jobs, myApplications } = await api('/api/recruiting/job-board');
    const jobCards = jobs.map(job => `<article class="card recruiting-job">
      <h2>${esc(job.title)}</h2>
      <small class="muted">${esc([job.positionTitle, `Ansprechperson: ${job.contactName}`, job.targetDate ? `Zieltermin: ${formatDate(job.targetDate)}` : ''].filter(Boolean).join(' · '))}</small>
      ${job.description ? `<p class="recruiting-text">${esc(job.description)}</p>` : ''}
      <div class="recruiting-actions">
        ${job.alreadyApplied ? `<span class="tag">${job.applicationWithdrawn ? 'Du hast deine Bewerbung zurückgezogen' : 'Du hast dich beworben'}</span>` : ''}
        ${job.canApply ? actionButton('Bewerben', 'apply', { id: job.id, title: job.title }, { primary: true }) : ''}
      </div>
      ${job.applyBlockedReason ? `<p class="muted">${esc(job.applyBlockedReason)}</p>` : ''}
    </article>`).join('');
    const applicationRows = myApplications.map(application => `<div class="row">
      <div class="grow">
        <b>${esc(application.requisitionTitle)}</b>
        <small>Beworben am ${esc(formatDate(application.appliedAt))}${application.status === 'active' ? ` · Stufe: ${esc(application.stageName)}` : ''}</small>
      </div>
      ${statusTag(APPLICATION_LABELS, applicationStatus(application))}
      ${application.canWithdraw ? actionButton('Zurückziehen', 'withdraw', { id: application.id }) : ''}
    </div>`).join('');
    return `${ui.header('Stellenbörse', 'Offene Stellen in deiner Organisation.')}
      <p class="recruiting-note" style="margin-top:18px">Deine Führungskraft erfährt nicht automatisch von deiner Bewerbung. Sehen können sie nur HR, die einstellende Führungskraft der jeweiligen Stelle und wer für ein Gespräch eingeteilt ist.</p>
      ${jobCards ? `<section class="cards">${jobCards}</section>` : `<article class="card" style="margin-top:18px">${ui.empty('Gerade ist keine Stelle intern ausgeschrieben.')}</article>`}
      ${applicationRows ? `<article class="card" style="margin-top:18px"><h2>Meine Bewerbungen</h2>${applicationRows}</article>` : ''}`;
  }

  function applyDialog({ id, title }) {
    ui.modal({
      title: 'Auf diese Stelle bewerben',
      subtitle: title,
      submitLabel: 'Bewerbung abschicken',
      body: `<p class="muted">Sichtbar für HR und die einstellende Führungskraft der Stelle, nicht automatisch für deine eigene Führungskraft.</p>
        <label>Kurze Nachricht (optional)</label><textarea name="message" maxlength="2000"></textarea>
        <label>Link zum Lebenslauf (optional)</label><input name="resumeUrl" type="url" maxlength="1000" placeholder="https://">
        <label>Lebenslauf als Text (optional)</label><textarea name="resumeText" maxlength="20000"></textarea>`,
      onSubmit: async data => {
        await post(`/api/recruiting/job-board/${idPart(id)}/apply`, data);
        ui.toast('Deine Bewerbung ist eingegangen.');
        refresh();
      }
    });
  }

  // --- Aktionen ------------------------------------------------------------------------------

  function openPage(view, key, id) {
    state[key] = id;
    window.loop.navigate(view);
  }

  const REQUISITION_STEP_MESSAGES = {
    approve: 'Die Stelle ist freigegeben und jetzt offen.',
    pause: 'Die Stelle ist pausiert.',
    resume: 'Die Stelle ist wieder offen.',
    cancel: 'Die Stelle ist abgebrochen.',
    fill: 'Die Stelle ist als besetzt markiert.'
  };

  async function requisitionStep({ id, step }) {
    if (step === 'return') {
      ui.modal({
        title: 'Stelle zurückgeben',
        subtitle: 'Die einstellende Führungskraft bekommt deine Rückmeldung als Aufgabe.',
        submitLabel: 'Zurückgeben',
        body: '<label>Was soll geändert werden?</label><textarea name="comment" required maxlength="1000"></textarea>',
        onSubmit: async data => {
          await post(`/api/recruiting/requisitions/${idPart(id)}/return`, data);
          ui.toast('Die Stelle ist zurückgegeben.');
          refresh();
        }
      });
      return;
    }
    if (step === 'cancel' && !confirm('Diese Stelle wirklich abbrechen? Das lässt sich nicht rückgängig machen.')) return;
    if (step === 'fill' && !confirm('Diese Stelle als besetzt markieren? Danach lässt sich niemand mehr einstellen.')) return;
    const { status } = await post(`/api/recruiting/requisitions/${idPart(id)}/${step}`);
    const submitMessage = status === 'open' ? 'Die Stelle ist jetzt offen.' : 'Die Stelle wartet jetzt auf die Freigabe durch HR.';
    ui.toast(step === 'submit' ? submitMessage : REQUISITION_STEP_MESSAGES[step]);
    refresh();
  }

  async function findInterview(interviewId) {
    const detail = await currentApplicationDetail();
    const interview = (detail.interviews || []).find(item => String(item.id) === String(interviewId));
    if (!interview) throw new Error('Dieses Gespräch gibt es nicht mehr.');
    return interview;
  }

  const actions = {
    'open-requisition': ({ id }) => openPage('recruitingRequisition', 'requisitionId', id),
    'open-application': ({ id }) => openPage('recruitingApplication', 'applicationId', id),
    'open-interview': ({ id }) => openPage('recruitingInterview', 'interviewId', id),
    'new-requisition': () => requisitionForm(),
    'edit-requisition': async ({ id }) => {
      const { requisition } = await api(`/api/recruiting/requisitions/${idPart(id)}`);
      await requisitionForm(requisition);
    },
    'requisition-step': requisitionStep,
    'add-application': ({ id }) => addApplicationDialog(id),
    move: async ({ id, stage }) => {
      await post(`/api/recruiting/applications/${idPart(id)}/move`, { stageId: stage });
      refresh();
    },
    reject: ({ id }) => rejectDialog(id),
    'rejection-text': async ({ id }) => {
      const { rejectionText } = await api(`/api/recruiting/applications/${idPart(id)}/rejection-text`);
      showRejectionText(rejectionText);
    },
    'plan-interview': ({ id }) => interviewForm({ applicationId: id }),
    'edit-interview': async ({ id }) => interviewForm({ applicationId: state.applicationId, interview: await findInterview(id) }),
    'cancel-interview': async ({ id }) => {
      if (!confirm('Dieses Gespräch absagen? Offene Bewertungsaufgaben verschwinden.')) return;
      await post(`/api/recruiting/interviews/${idPart(id)}/cancel`);
      refresh();
    },
    'give-feedback': async ({ id }) => {
      const { recommendations } = await api(`/api/recruiting/interviews/${idPart(id)}`);
      feedbackDialog(id, recommendations);
    },
    'offer-new': async ({ id }) => {
      const detail = await currentApplicationDetail();
      offerForm({ applicationId: id, positionTitle: detail.requisition.title, offerRule: detail.offerRule });
    },
    'offer-edit': async ({ id }) => {
      const detail = await currentApplicationDetail();
      const offer = detail.offers.find(item => String(item.id) === String(id));
      if (!offer) throw new Error('Dieses Angebot gibt es nicht mehr.');
      offerForm({ offer, offerRule: detail.offerRule });
    },
    'offer-submit': async ({ id }) => {
      const { status } = await post(`/api/recruiting/offers/${idPart(id)}/submit`);
      ui.toast(status === 'approved'
        ? 'Das Angebot ist fertig. Trage die Antwort der Person ein, sobald sie vorliegt.'
        : 'Das Angebot wartet jetzt auf die Freigabe.');
      refresh();
    },
    'offer-approve': async ({ id }) => {
      await post(`/api/recruiting/offers/${idPart(id)}/approve`);
      ui.toast('Angebot freigegeben.');
      refresh();
    },
    'offer-return': ({ id }) => {
      ui.modal({
        title: 'Angebot zurückgeben',
        submitLabel: 'Zurückgeben',
        body: '<label>Was soll geändert werden?</label><textarea name="comment" required maxlength="1000"></textarea>',
        onSubmit: async data => {
          await post(`/api/recruiting/offers/${idPart(id)}/return`, data);
          ui.toast('Das Angebot ist zurückgegeben.');
          refresh();
        }
      });
    },
    'offer-response': async ({ id, accepted }) => {
      await post(`/api/recruiting/offers/${idPart(id)}/response`, { accepted: accepted === 'true' });
      ui.toast(accepted === 'true' ? 'Angebot angenommen. HR kann die Person jetzt einstellen.' : 'Absage der Person eingetragen.');
      refresh();
    },
    hire: hireDialog,
    'new-candidate': () => newCandidateDialog(),
    'edit-candidate': candidateEditDialog,
    anonymize: async ({ id }) => {
      if (!confirm('Diese Person jetzt endgültig anonymisieren? Name, Kontaktdaten, Notizen, Lebenslauf und Freitexte gehen verloren.')) return;
      await post(`/api/recruiting/candidates/${idPart(id)}/anonymize`);
      ui.toast('Person anonymisiert.');
      refresh();
    },
    apply: applyDialog,
    withdraw: async ({ id }) => {
      if (!confirm('Bewerbung wirklich zurückziehen? Auf diese Stelle kannst du dich danach nicht erneut bewerben.')) return;
      await post(`/api/recruiting/job-board/applications/${idPart(id)}/withdraw`);
      ui.toast('Deine Bewerbung ist zurückgezogen.');
      refresh();
    },
    'stage-add': () => {
      ui.modal({
        title: 'Stufe ergänzen',
        subtitle: 'Die neue Stufe steht zunächst direkt vor „Eingestellt“.',
        body: '<label>Name</label><input name="name" required maxlength="80">',
        onSubmit: async data => {
          await post('/api/recruiting/stages', data);
          refresh();
        }
      });
    },
    'stage-rename': ({ id, name }) => {
      ui.modal({
        title: 'Stufe umbenennen',
        body: `<label>Name</label><input name="name" required maxlength="80" value="${esc(name)}">`,
        onSubmit: async data => {
          await patch(`/api/recruiting/stages/${idPart(id)}`, data);
          refresh();
        }
      });
    },
    'stage-move': async ({ id, direction }) => {
      await post(`/api/recruiting/stages/${idPart(id)}/move`, { direction });
      refresh();
    },
    'stage-toggle': async ({ id, active }) => {
      await patch(`/api/recruiting/stages/${idPart(id)}`, { active: active === '1' });
      refresh();
    }
  };

  async function runAction(element) {
    const { recruitingAction, ...data } = element.dataset;
    try {
      await actions[recruitingAction]?.(data);
    } catch (error) {
      ui.toast(error.message || 'Das hat leider nicht geklappt.', 'error');
    }
  }

  function bind() {
    document.querySelectorAll('[data-recruiting-action]').forEach(element => {
      element.onclick = () => runAction(element);
    });
    const statusFilter = document.querySelector('#recruitingStatusFilter');
    if (statusFilter) {
      statusFilter.onchange = () => {
        state.statusFilter = statusFilter.value;
        refresh();
      };
    }
    const stageSelect = document.querySelector('#recruitingStageSelect');
    if (stageSelect) {
      stageSelect.onchange = async () => {
        try {
          await post(`/api/recruiting/applications/${idPart(stageSelect.dataset.id)}/move`, { stageId: stageSelect.value });
          ui.toast('Stufe geändert.');
        } catch (error) {
          ui.toast(error.message, 'error');
        }
        refresh();
      };
    }
    const searchForm = document.querySelector('#recruitingCandidateSearch');
    if (searchForm) {
      searchForm.onsubmit = event => {
        event.preventDefault();
        state.candidateSearch = searchForm.elements.q.value.trim();
        state.talentPoolOnly = searchForm.elements.talentPool.checked;
        refresh();
      };
    }
    const retentionForm = document.querySelector('#recruitingRetentionForm');
    if (retentionForm) {
      retentionForm.onsubmit = async event => {
        event.preventDefault();
        const retentionMonths = retentionForm.elements.retentionMonths.value;
        const save = async (confirmAnonymization = false) => {
          await patch('/api/recruiting/settings', { retentionMonths, ...(confirmAnonymization ? { confirmAnonymization: true } : {}) });
          ui.toast('Frist gespeichert.');
          refresh();
        };
        try {
          await save();
        } catch (error) {
          if (error.code === 'retention_confirmation_needed' && confirm(`${error.message} Das lässt sich nicht rückgängig machen. Frist trotzdem speichern?`)) {
            await save(true).catch(saveError => {
              document.querySelector('#recruitingRetentionError').textContent = saveError.message;
            });
            return;
          }
          document.querySelector('#recruitingRetentionError').textContent = error.code === 'retention_confirmation_needed'
            ? 'Die Frist bleibt unverändert.'
            : error.message;
        }
      };
    }
  }

  const TASK_BUTTONS = {
    recruiting_approval: ['Prüfen', 'open-requisition'],
    recruiting_requisition_assigned: ['Öffnen', 'open-requisition'],
    recruiting_requisition_returned: ['Überarbeiten', 'open-requisition'],
    recruiting_feedback: ['Bewerten', 'open-interview'],
    recruiting_offer_approval: ['Prüfen', 'open-application'],
    recruiting_offer_returned: ['Überarbeiten', 'open-application'],
    recruiting_offer_response: ['Antwort eintragen', 'open-application'],
    recruiting_hire_decision: ['Einstellen', 'open-application'],
    recruiting_internal_application: ['Öffnen', 'open-application']
  };

  window.loop.registerAddress?.({
    recruitingRequisition: { get: () => state.requisitionId, set: id => { state.requisitionId = id; } },
    recruitingApplication: { get: () => state.applicationId, set: id => { state.applicationId = id; } },
    recruitingInterview: { get: () => state.interviewId, set: id => { state.interviewId = id; } }
  });

  window.loop.registerModule({
    key: 'recruiting',
    label: 'Recruiting',
    nav(me) {
      const manages = canManage(me);
      const items = [];
      if (manages) items.push({ route: 'recruitingHome', label: 'Recruiting', group: 'hr', views: [...MANAGE_VIEWS, ...INTERVIEW_VIEWS] });
      items.push({
        route: BOARD_VIEW,
        label: 'Stellenbörse',
        group: 'myWork',
        views: manages ? [BOARD_VIEW] : [BOARD_VIEW, ...INTERVIEW_VIEWS, 'recruitingApplication']
      });
      return items;
    },
    pages: {
      recruitingHome: homePage,
      recruitingRequisition: requisitionPage,
      recruitingApplication: applicationPage,
      recruitingCandidates: candidatesPage,
      recruitingSettings: settingsPage,
      recruitingBoard: boardPage,
      recruitingInterviews: interviewsPage,
      recruitingInterview: interviewPage
    },
    tabs(view, me) {
      if (!canManage(me)) {
        if (![BOARD_VIEW, ...INTERVIEW_VIEWS, 'recruitingApplication'].includes(view)) return [];
        return [
          { route: BOARD_VIEW, label: 'Stellenbörse', active: view === BOARD_VIEW },
          { route: 'recruitingInterviews', label: 'Meine Gespräche', active: view !== BOARD_VIEW }
        ];
      }
      if (![...MANAGE_VIEWS, ...INTERVIEW_VIEWS].includes(view)) return [];
      const hr = isHrRole(me);
      return [
        { route: 'recruitingHome', label: 'Stellen', active: ['recruitingHome', 'recruitingRequisition', 'recruitingApplication'].includes(view) },
        ...(hr ? [{ route: 'recruitingCandidates', label: 'Bewerbende', active: view === 'recruitingCandidates' }] : []),
        { route: 'recruitingInterviews', label: 'Meine Gespräche', active: INTERVIEW_VIEWS.includes(view) },
        ...(managesOrganizationSettings(me) ? [{ route: 'recruitingSettings', label: 'Einstellungen', active: view === 'recruitingSettings' }] : [])
      ];
    },
    bind,
    taskAction(task) {
      const button = TASK_BUTTONS[task.type];
      return button ? actionButton(button[0], button[1], { id: task.entity_id }) : '';
    }
  });
})();
