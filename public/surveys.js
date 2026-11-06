// Mitarbeiterbefragungen: teilnehmen, verwalten und auswerten. Einzelantworten gibt es nirgends zu sehen.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const VIEWS = ['surveysHome', 'surveysFill', 'surveysManage', 'surveysEdit', 'surveysResultsList', 'surveysResults'];
  const HR_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const LEADER_ROLES = ['manager', 'director'];
  const STATUS_TAGS = {
    draft: '<span class="tag focus">Entwurf</span>',
    open: '<span class="tag">Offen</span>',
    closed: '<span class="tag focus">Geschlossen</span>'
  };
  const QUESTION_TYPES = [['scale', 'Skala von 1 bis 5'], ['nps', 'Weiterempfehlung von 0 bis 10'], ['text', 'Freitext']];
  const IDENTIFYING_HINT = 'Bitte schreibe keine Namen oder Angaben, an denen man dich oder andere erkennen kann. Dein Text erscheint in der Auswertung im Wortlaut.';

  const state = { surveyId: null };

  const isHr = person => HR_ROLES.includes(person.role);
  const isLeader = person => LEADER_ROLES.includes(person.role);
  const send = (url, method, body = {}) => api(url, { method, body: JSON.stringify(body) });
  const reload = () => window.loop.navigate(window.loop.view);
  const germanDate = value => (value ? String(value).split('-').reverse().join('.') : '');
  const germanNumber = value => Number(value).toLocaleString('de-DE');
  const signed = value => (value > 0 ? `+${value}` : String(value));
  const targetRoles = () => Object.entries(window.loop.roles).filter(([role]) => role !== 'super_admin');

  function periodLabel(survey) {
    if (survey.startsAt && survey.endsAt) return `${germanDate(survey.startsAt)} bis ${germanDate(survey.endsAt)}`;
    if (survey.endsAt) return `bis ${germanDate(survey.endsAt)}`;
    if (survey.startsAt) return `seit ${germanDate(survey.startsAt)}`;
    return 'ohne festes Ende';
  }

  function goTo(view, surveyId) {
    state.surveyId = surveyId;
    window.loop.navigate(view);
  }

  /** Beschreibt genau, was das System tut, und auch, was es nicht leisten kann. */
  function anonymityCard(threshold) {
    const minimum = threshold ? `${threshold} Antworten` : 'einer Mindestzahl an Antworten';
    // Das muss zur Datenauskunft passen: Die Teilnahme bleibt dort draußen (routes/personnel.js, EXPORT_EXCLUDED_TABLES).
    const personnelNote = window.loop.isModuleEnabled('personnel')
      ? '<li><b>Nicht in der Datenauskunft:</b> Die HR-Administration kann eine Datenauskunft zu einer Person erstellen. Darin steht weder, ob du abgegeben hast, noch, was du geantwortet hast.</li>'
      : '';
    return `<article class="card surveys-promise">
      <h2>So schützen wir deine Anonymität</h2>
      <ul>
        <li><b>Getrennte Speicherung:</b> Eine Liste hält nur fest, ob du abgegeben hast, ohne Zeitpunkt. Deine Antworten liegen davon getrennt, ohne Name, ohne Konto und ohne Zeitpunkt, unter einer Zufallsnummer. Zwischen beiden gibt es keine Verbindung.</li>
        <li><b>Nur grobe Zuordnung:</b> Zu deinen Antworten werden nur dein Bereich und die Führungskräfte über dir gespeichert, und nur so grob, dass mindestens so viele Eingeladene dazugehören wie die Mindestzahl an Antworten. Kleinere Bereiche werden schon beim Speichern zusammengefasst.</li>
        <li><b>Ergebnisse erst ab ${esc(minimum)}:</b> Das gilt auch für HR und Führungskräfte. Einzelantworten kann niemand abrufen, dafür gibt es keine Funktion. Bereiche bleiben verborgen, wenn sich sonst eine kleinere Gruppe errechnen ließe.</li>
        <li><b>Kein Protokoll der Abgabe:</b> Deine Abgabe erzeugt keinen Protokolleintrag. Deine Aufgabe wird ohne Zeitpunkt als erledigt markiert.</li>
        <li><b>Zwischenstände in Schritten:</b> Solange die Befragung läuft, ändert sich das Ergebnis erst nach mehreren neuen Antworten. So lässt sich deine Antwort nicht aus zwei Abrufen errechnen.</li>
        ${personnelNote}
      </ul>
      <h3>Was das System nicht verhindern kann</h3>
      <ul>
        <li>Freitexte erscheinen im Wortlaut. Was du dort schreibst, kann dich erkennbar machen.</li>
        <li>Antworten in einem Bereich alle gleich, ist das am Ergebnis zu sehen.</li>
        <li>Wer sich den letzten Zwischenstand merkt, sieht beim Schließen, wie die letzten Antworten das Ergebnis verändert haben. Waren es nur wenige, lässt das Rückschlüsse auf diese Antworten zu, aber nicht darauf, von wem sie stammen.</li>
        <li>Wer direkt auf die Datenbank oder ihre Sicherungen zugreifen kann, sieht die Liste der Abgaben und getrennt davon die Antworten samt grober Zuordnung. Haben in einem Bereich erst sehr wenige abgegeben, oder vergleicht jemand mehrere Sicherungen, lässt sich der Kreis der Personen eingrenzen. Nach dem Schließen fasst Daybreak kleine Gruppen auch in der Datenbank zusammen.</li>
      </ul>
    </article>`;
  }

  // --- Nicht abgesendete Antworten ------------------------------------------------------

  // Das Merkmal hängt am Formular selbst: Baut sich die Seite neu auf, ist es von allein weg.
  const unsentForm = () => document.querySelector('#surveysFillForm[data-unsent]');

  function mayLeaveForm() {
    const form = unsentForm();
    if (!form) return true;
    if (!window.confirm('Deine Antworten sind noch nicht abgesendet und gehen verloren. Trotzdem verlassen?')) return false;
    delete form.dataset.unsent;
    return true;
  }

  /** Die Anwendung hat die Ansicht und bei Zurück auch die Adresse schon gewechselt. Beides kommt zurück. */
  function stayOnForm() {
    const surveyId = Number(unsentForm().dataset.surveyId);
    const address = `#/surveysFill/${surveyId}`;
    view = 'surveysFill';
    state.surveyId = surveyId;
    if (location.hash === address) return;
    const { scrollY } = window;
    history.pushState({ view, selectedPersonId: null, selectedPersonCanEdit: false, item: surveyId }, '', address);
    // Zurück rollt die Seite nach dem Seitenaufbau noch an die alte Stelle.
    setTimeout(() => window.scrollTo(0, scrollY), 0);
  }

  // Jeder Weg weg vom Formular läuft hier durch: Knöpfe, Dayo und auch Zurück im Browser.
  const renderAfterCheck = render;
  render = async function surveysRender() {
    if (!mayLeaveForm()) {
      stayOnForm();
      return;
    }
    await renderAfterCheck();
  };

  document.addEventListener('click', event => {
    if (!event.target.closest?.('#logout') || mayLeaveForm()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener('beforeunload', event => {
    if (!unsentForm()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // --- Teilnehmen -----------------------------------------------------------------------

  function openSurveyRow(item) {
    const action = item.submitted
      ? '<span class="tag">Abgegeben</span>'
      : `<button type="button" class="btn primary" data-surveys-fill="${esc(item.id)}">Ausfüllen</button>`;
    return `<div class="row surveys-row">
      <div class="grow">
        <b>${esc(item.title)}</b>
        <small>${esc(periodLabel(item))} · Ergebnisse ab ${esc(item.anonymityThreshold)} Antworten</small>
        ${item.intro ? `<small>${esc(item.intro)}</small>` : ''}
      </div>
      ${action}
    </div>`;
  }

  async function homePage() {
    const { items } = await api('/api/surveys/open');
    return `${ui.header('Befragungen', 'Deine Meinung zählt. Hier siehst du, wozu du gerade eingeladen bist.')}
      <section class="surveys-stack">
        <article class="card">
          <h2>Offene Befragungen</h2>
          ${items.map(openSurveyRow).join('') || ui.empty('Gerade gibt es keine offene Befragung für dich.')}
        </article>
        ${anonymityCard(null)}
      </section>`;
  }

  function choiceQuestion(question) {
    const values = [];
    for (let value = question.min; value <= question.max; value += 1) values.push(value);
    const [lowText, highText] = question.type === 'nps'
      ? ['sehr unwahrscheinlich', 'sehr wahrscheinlich']
      : ['trifft gar nicht zu', 'trifft voll zu'];
    const options = values.map(value => `<label class="surveys-choice">
        <input type="radio" name="question-${esc(question.id)}" value="${esc(value)}" required>
        <span>${esc(value)}</span>
      </label>`).join('');
    return `<fieldset class="surveys-question" data-surveys-question="${esc(question.id)}" data-surveys-type="${esc(question.type)}">
      <legend>${esc(question.text)}</legend>
      ${question.topic ? `<small class="muted">${esc(question.topic)}</small>` : ''}
      <div class="surveys-choices">${options}</div>
      <div class="surveys-scale-ends"><small>${esc(question.min)} = ${esc(lowText)}</small><small>${esc(question.max)} = ${esc(highText)}</small></div>
    </fieldset>`;
  }

  function textQuestion(question) {
    return `<fieldset class="surveys-question" data-surveys-question="${esc(question.id)}" data-surveys-type="text">
      <legend>${esc(question.text)}</legend>
      ${question.topic ? `<small class="muted">${esc(question.topic)}</small>` : ''}
      <textarea name="question-${esc(question.id)}" maxlength="2000" placeholder="Freiwillig"></textarea>
      <small class="surveys-warning">${esc(IDENTIFYING_HINT)}</small>
    </fieldset>`;
  }

  async function fillPage() {
    if (!state.surveyId) return homePage();
    const data = await api(`/api/surveys/${encodeURIComponent(state.surveyId)}/form`);
    if (data.submitted) {
      return `${ui.header(data.survey.title, 'Danke, du hast bereits abgegeben.', '<button type="button" class="btn" data-view="surveysHome">Zur Übersicht</button>')}
        <section class="surveys-stack"><article class="card"><p class="muted">Eine zweite Abgabe oder eine Änderung ist nicht möglich, weil deine Antworten dir nicht mehr zugeordnet werden können.</p></article></section>`;
    }
    const questions = data.questions.map(question => (question.type === 'text' ? textQuestion(question) : choiceQuestion(question))).join('');
    return `${ui.header(data.survey.title, periodLabel(data.survey), '<button type="button" class="btn" data-view="surveysHome">Zurück</button>')}
      <section class="surveys-stack">
        <form class="card surveys-form" id="surveysFillForm" data-survey-id="${esc(data.survey.id)}">
          ${data.survey.intro ? `<p>${esc(data.survey.intro)}</p>` : ''}
          ${questions}
          <div class="error" id="surveysFillError"></div>
          <p class="muted">Ein Zwischenspeichern gibt es nicht. Nach dem Absenden kannst du nichts mehr ändern, weil deine Antworten dir nicht mehr zugeordnet werden können.</p>
          <button class="btn primary">Antworten absenden</button>
        </form>
        ${anonymityCard(data.survey.anonymityThreshold)}
      </section>`;
  }

  function collectAnswers(form) {
    const formData = new FormData(form);
    return [...form.querySelectorAll('[data-surveys-question]')].map(fieldset => {
      const questionId = Number(fieldset.dataset.surveysQuestion);
      const raw = formData.get(`question-${questionId}`);
      return fieldset.dataset.surveysType === 'text'
        ? { questionId, text: raw || '' }
        : { questionId, value: raw === null ? null : Number(raw) };
    });
  }

  // --- Verwalten ------------------------------------------------------------------------

  function manageRow(survey) {
    const results = survey.status === 'draft' ? '' : `<button type="button" class="btn" data-surveys-results="${esc(survey.id)}">Auswertung</button>`;
    return `<tr>
      <td><b>${esc(survey.title)}</b><small>${esc(periodLabel(survey))}</small></td>
      <td data-label="Status">${STATUS_TAGS[survey.status] || ''}</td>
      <td data-label="Mindestzahl Antworten">${esc(survey.anonymityThreshold)}</td>
      <td data-label="Eingeladen">${survey.status === 'draft' ? '–' : esc(survey.invitedCount)}</td>
      <td class="surveys-actions">
        <button type="button" class="btn" data-surveys-edit="${esc(survey.id)}">Details</button>
        ${results}
      </td>
    </tr>`;
  }

  async function managePage() {
    const { items } = await api('/api/surveys');
    const table = items.length
      ? `<div class="tableWrap"><table class="table surveys-table">
          <thead><tr><th>Befragung</th><th>Status</th><th>Mindestzahl Antworten</th><th>Eingeladen</th><th></th></tr></thead>
          <tbody>${items.map(manageRow).join('')}</tbody>
        </table></div>`
      : ui.empty('Noch keine Befragungen. Lege die erste an, die Standardfragen helfen beim Start.');
    return `${ui.header('Befragungen verwalten', 'Vom Entwurf über die offene Phase bis zur Auswertung.', '<button type="button" class="btn primary" data-surveys-new>+ Befragung anlegen</button>')}
      <section class="surveys-stack"><article class="card">
        ${table}
        <p class="muted surveys-hint">Mindestzahl Antworten: Ergebnisse erscheinen erst ab dieser Zahl, damit niemand erkennt, wer was geantwortet hat. Fachleute nennen das Anonymitätsschwelle.</p>
      </article></section>`;
  }

  function settingsFields(survey) {
    const audience = survey?.audience || 'all';
    const selectedRoles = survey?.audienceRoles || [];
    return `<label>Titel</label><input name="title" required maxlength="200" value="${esc(survey?.title)}">
      <label>Einleitung</label><textarea name="intro" maxlength="4000">${esc(survey?.intro)}</textarea>
      <div class="two">
        <div><label>Beginn (leer = beim Öffnen)</label><input name="startsAt" type="date" value="${esc(survey?.startsAt)}"></div>
        <div><label>Ende (leer = bis du schließt)</label><input name="endsAt" type="date" value="${esc(survey?.endsAt)}"></div>
      </div>
      <label>Mindestzahl an Antworten (mindestens 3)</label>
      <input name="anonymityThreshold" type="number" min="3" required value="${esc(survey?.anonymityThreshold ?? 5)}">
      <p class="muted">Ergebnisse erscheinen erst ab dieser Zahl an Antworten, damit niemand erkennt, wer was geantwortet hat. Fachleute nennen das Anonymitätsschwelle. Nach dem Öffnen lässt sich der Wert nur noch erhöhen.</p>
      <label>Zielgruppe</label>
      <select name="audience" data-surveys-audience>
        <option value="all" ${audience === 'all' ? 'selected' : ''}>Alle</option>
        <option value="roles" ${audience === 'roles' ? 'selected' : ''}>Ausgewählte Rollen</option>
      </select>
      <div data-surveys-roles ${audience === 'roles' ? '' : 'hidden'}>
        <div class="checkboxes">${targetRoles().map(([role, label]) => `<label class="checkline"><input type="checkbox" name="audienceRoles" value="${esc(role)}" ${selectedRoles.includes(role) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>
      </div>`;
  }

  function bindAudienceSwitch() {
    document.querySelector('[data-surveys-audience]')?.addEventListener('change', event => {
      document.querySelector('[data-surveys-roles]').hidden = event.target.value !== 'roles';
    });
  }

  function settingsPayload(data, form) {
    return {
      title: data.title,
      intro: data.intro,
      startsAt: data.startsAt || null,
      endsAt: data.endsAt || null,
      anonymityThreshold: Number(data.anonymityThreshold),
      audience: data.audience,
      audienceRoles: new FormData(form).getAll('audienceRoles')
    };
  }

  function openCreateForm() {
    ui.modal({
      title: 'Befragung anlegen',
      subtitle: 'Sie bleibt ein Entwurf, bis du sie öffnest.',
      submitLabel: 'Entwurf anlegen',
      body: `${settingsFields(null)}
        <label class="checkline"><input type="checkbox" name="useTemplates" checked> Neutrale Standardfragen übernehmen</label>`,
      onSubmit: async (data, form) => {
        const result = await send('/api/surveys', 'POST', { ...settingsPayload(data, form), useTemplates: data.useTemplates === 'on' });
        ui.toast('Entwurf angelegt.');
        goTo('surveysEdit', result.id);
      }
    });
    bindAudienceSwitch();
  }

  function openDraftSettings(survey) {
    ui.modal({
      title: 'Einstellungen',
      body: settingsFields(survey),
      onSubmit: async (data, form) => {
        await send(`/api/surveys/${survey.id}`, 'PATCH', settingsPayload(data, form));
        ui.toast('Einstellungen gespeichert.');
        reload();
      }
    });
    bindAudienceSwitch();
  }

  function openRunningSettings(survey) {
    ui.modal({
      title: 'Ende und Mindestzahl an Antworten',
      subtitle: 'Während eine Befragung läuft, lässt sich nur noch das ändern.',
      body: `<label>Ende</label><input name="endsAt" type="date" value="${esc(survey.endsAt)}">
        <label>Mindestzahl an Antworten (nur erhöhen)</label>
        <input name="anonymityThreshold" type="number" min="${esc(survey.anonymityThreshold)}" required value="${esc(survey.anonymityThreshold)}">`,
      onSubmit: async data => {
        await send(`/api/surveys/${survey.id}`, 'PATCH', { endsAt: data.endsAt || null, anonymityThreshold: Number(data.anonymityThreshold) });
        ui.toast('Gespeichert.');
        reload();
      }
    });
  }

  function openQuestionForm(surveyId, question) {
    const options = QUESTION_TYPES.map(([value, label]) => `<option value="${esc(value)}" ${question?.type === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
    ui.modal({
      title: question ? 'Frage bearbeiten' : 'Frage hinzufügen',
      body: `<label>Frage</label><textarea name="text" required maxlength="500">${esc(question?.text)}</textarea>
        <div class="two">
          <div><label>Art</label><select name="type">${options}</select></div>
          <div><label>Thema (optional)</label><input name="topic" maxlength="80" value="${esc(question?.topic)}"></div>
        </div>
        <p class="muted">Fragen mit Skala sind beim Ausfüllen Pflicht, Freitexte sind freiwillig.</p>`,
      onSubmit: async data => {
        const url = question ? `/api/surveys/${surveyId}/questions/${question.id}` : `/api/surveys/${surveyId}/questions`;
        await send(url, question ? 'PATCH' : 'POST', data);
        reload();
      }
    });
  }

  function questionRow(question, editable) {
    const typeLabel = QUESTION_TYPES.find(([value]) => value === question.type)?.[1] || '';
    const actions = editable
      ? `<div class="surveys-actions">
          <button type="button" class="btn" data-surveys-edit-question="${esc(question.id)}">Bearbeiten</button>
          <button type="button" class="btn" data-surveys-delete-question="${esc(question.id)}">Entfernen</button>
        </div>`
      : '';
    return `<div class="row surveys-row">
      <div class="grow"><b>${esc(question.text)}</b><small>${esc([typeLabel, question.topic].filter(Boolean).join(' · '))}</small></div>
      ${actions}
    </div>`;
  }

  // Die Daten der gerade offenen Bearbeitungsseite, damit die Dialoge nicht erneut laden müssen.
  let editing = null;

  async function editPage() {
    if (!state.surveyId) return managePage();
    const data = await api(`/api/surveys/${encodeURIComponent(state.surveyId)}`);
    editing = data;
    const { survey, questions } = data;
    const isDraft = survey.status === 'draft';
    const audienceLabel = survey.audience === 'all'
      ? 'Alle'
      : survey.audienceRoles.map(role => window.loop.roles[role] || role).join(', ');
    const actions = [
      '<button type="button" class="btn" data-view="surveysManage">Zurück</button>',
      survey.status !== 'closed' ? '<button type="button" class="btn" data-surveys-settings>Einstellungen</button>' : '',
      isDraft ? '<button type="button" class="btn" data-surveys-delete>Löschen</button>' : '',
      isDraft ? '<button type="button" class="btn primary" data-surveys-open>Befragung öffnen</button>' : '',
      survey.status === 'open' ? '<button type="button" class="btn primary" data-surveys-close>Befragung schließen</button>' : '',
      survey.status !== 'draft' ? `<button type="button" class="btn" data-surveys-results="${esc(survey.id)}">Auswertung</button>` : ''
    ].filter(Boolean).join(' ');
    const addQuestion = isDraft ? '<button type="button" class="btn" data-surveys-add-question>+ Frage</button>' : '';
    return `${ui.header(survey.title, periodLabel(survey), actions)}
      <section class="cards">
        ${ui.stat('Status', { draft: 'Entwurf', open: 'Offen', closed: 'Geschlossen' }[survey.status], survey.status === 'draft' ? 'noch nicht sichtbar' : '')}
        ${ui.stat('Mindestzahl an Antworten', survey.anonymityThreshold, 'erst dann gibt es ein Ergebnis')}
        ${ui.stat(survey.status === 'draft' ? 'Zielgruppe' : 'Eingeladen', survey.status === 'draft' ? audienceLabel : survey.invitedCount, survey.status === 'draft' ? 'wird beim Öffnen festgeschrieben' : 'festgeschrieben beim Öffnen')}
      </section>
      <section class="surveys-stack">
        <article class="card">
          <div class="sectionHead"><div><h2>Fragen</h2>${isDraft ? '' : '<p class="muted">Nach dem Öffnen lassen sich Fragen nicht mehr ändern.</p>'}</div>${addQuestion}</div>
          ${questions.map(question => questionRow(question, isDraft)).join('') || ui.empty('Noch keine Fragen.')}
        </article>
        ${survey.intro ? `<article class="card"><h2>Einleitung</h2><p class="muted">${esc(survey.intro)}</p></article>` : ''}
      </section>`;
  }

  // --- Auswertung -----------------------------------------------------------------------

  function resultsListRow(survey) {
    return `<div class="row surveys-row">
      <div class="grow"><b>${esc(survey.title)}</b><small>${esc(periodLabel(survey))}</small></div>
      ${STATUS_TAGS[survey.status] || ''}
      <button type="button" class="btn primary" data-surveys-results="${esc(survey.id)}">Ansehen</button>
    </div>`;
  }

  async function resultsListPage() {
    const { items } = await api('/api/surveys');
    const visible = items.filter(survey => survey.status !== 'draft');
    return `${ui.header('Auswertung', isHr(window.loop.me) ? 'Ergebnisse der gesamten Organisation.' : 'Ergebnisse von allen, die du direkt oder indirekt führst.')}
      <section class="surveys-stack"><article class="card">${visible.map(resultsListRow).join('') || ui.empty('Noch keine Befragung mit Auswertung.')}</article></section>`;
  }

  function scaleResult(question) {
    return `<div class="surveys-result-value"><strong>${esc(germanNumber(question.average))}</strong><span class="muted">von 5</span></div>
      <div class="bar"><span style="width:${(Number(question.average) / 5) * 100}%"></span></div>
      <small class="muted">${esc(question.favorablePercent)} % stimmen zu · ${esc(question.neutralPercent)} % teils · ${esc(question.unfavorablePercent)} % stimmen nicht zu</small>`;
  }

  function recommendationResult(question) {
    return `<div class="surveys-result-value"><strong>${esc(signed(question.recommendationScore))}</strong><span class="muted">Weiterempfehlungswert</span></div>
      <small class="muted">${esc(question.promotersPercent)} % gaben 9 bis 10 · ${esc(question.passivesPercent)} % gaben 7 bis 8 · ${esc(question.detractorsPercent)} % gaben 0 bis 6</small>
      <small class="muted">Der Weiterempfehlungswert ist der Anteil der Werte 9 bis 10 minus der Anteil der Werte 0 bis 6.</small>`;
  }

  function textResult(question) {
    if (!question.texts.length) return '<small class="muted">Keine Freitexte.</small>';
    return `<small class="muted">In zufälliger Reihenfolge und ohne Angaben zur Person.</small>
      ${question.texts.map(text => `<blockquote class="surveys-quote">${esc(text)}</blockquote>`).join('')}`;
  }

  function questionResult(question) {
    let content = textResult;
    if (question.type === 'scale') content = scaleResult;
    if (question.type === 'nps') content = recommendationResult;
    return `<div class="surveys-result">
      <b>${esc(question.text)}</b>
      ${question.topic ? `<small class="muted">${esc(question.topic)}</small>` : ''}
      ${content(question)}
    </div>`;
  }

  function groupResult(group) {
    if (group.insufficient) {
      return `<div class="row surveys-row"><div class="grow"><b>${esc(group.label)}</b></div><span class="tag focus">${esc(group.message)}</span></div>`;
    }
    const rate = group.participation.ratePercent === null ? '' : ` · Teilnahme ${group.participation.ratePercent} %`;
    return `<details class="surveys-group">
      <summary><b>${esc(group.label)}</b> <span class="muted">${esc(ui.plural(group.answerCount, 'Antwort', 'Antworten'))}${esc(rate)}</span></summary>
      ${group.questions.map(questionResult).join('')}
    </details>`;
  }

  function interimNote(threshold) {
    return `<article class="card surveys-interim">
      <h2>Zwischenstand</h2>
      <p class="muted">Die Befragung läuft noch. Der Stand ändert sich erst nach mindestens ${esc(threshold)} neuen Antworten, damit sich keine einzelne Antwort errechnen lässt. Der Vergleich nach Bereichen erscheint nach dem Schließen.</p>
    </article>`;
  }

  async function resultsPage() {
    if (!state.surveyId) return resultsListPage();
    const data = await api(`/api/surveys/${encodeURIComponent(state.surveyId)}/results`);
    const threshold = data.survey.anonymityThreshold;
    const scopeLabel = data.scope === 'line' ? 'Alle, die du direkt oder indirekt führst' : 'Gesamte Organisation';
    const back = '<button type="button" class="btn" data-view="surveysResultsList">Zurück</button>';
    const head = ui.header(data.survey.title, `${scopeLabel} · Ergebnisse ab ${threshold} Antworten`, back);
    const running = data.running ? interimNote(threshold) : '';
    if (data.overall.insufficient) {
      return `${head}
        <section class="surveys-stack">
          ${running}
          <article class="card">
            <h2>${esc(data.overall.message)}</h2>
            <p class="muted">Ergebnisse erscheinen erst ab ${esc(threshold)} Antworten. Eine eigene Antwort zählt dabei für dich nicht mit. Auch wenn sich aus den übrigen Zahlen eine kleinere Gruppe errechnen ließe, bleibt die Auswertung verborgen.</p>
          </article>
        </section>`;
    }
    const { participation } = data.overall;
    // Bleibt nur eine einzige sichtbare Gruppe, stünden dort dieselben Zahlen wie im Gesamtergebnis.
    const comparableGroups = data.groups.filter(group => !group.insufficient);
    let groups = '';
    if (comparableGroups.length > 1) {
      groups = `<article class="card">
          <h2>Vergleich nach Bereichen</h2>
          <p class="muted">Bereiche unter der Schwelle sind zusammengefasst oder ausgeblendet, auch wenn sich sonst eine kleinere Gruppe errechnen ließe.</p>
          ${data.groups.map(groupResult).join('')}
        </article>`;
    } else if (!data.running && data.scope === 'organization') {
      groups = `<article class="card">
          <h2>Vergleich nach Bereichen</h2>
          <p class="muted">Für einen Vergleich gibt es zu wenige Antworten oder zu kleine Bereiche. Bereiche unter der Schwelle werden zusammengefasst, damit sich keine kleine Gruppe errechnen lässt.</p>
        </article>`;
    }
    return `${head}
      <section class="cards">
        ${ui.stat(data.running ? 'Antworten im Zwischenstand' : 'Antworten', data.overall.answerCount, scopeLabel)}
        ${ui.stat('Teilnahme', participation.ratePercent === null ? '–' : `${participation.ratePercent} %`, `${participation.responded} von ${participation.invited} Eingeladenen`)}
      </section>
      <section class="surveys-stack">
        ${running}
        <article class="card">
          <h2>Ergebnisse</h2>
          ${data.overall.questions.map(questionResult).join('')}
        </article>
        ${groups}
      </section>`;
  }

  // --- Ereignisse -----------------------------------------------------------------------

  const guarded = action => async () => {
    try {
      await action();
    } catch (error) {
      ui.toast(error.message, 'error');
    }
  };

  function bindFillForm() {
    const form = document.querySelector('#surveysFillForm');
    if (!form) return;
    form.oninput = () => {
      form.dataset.unsent = '1';
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const errorBox = document.querySelector('#surveysFillError');
      errorBox.textContent = '';
      const button = form.querySelector('button.primary');
      button.disabled = true;
      try {
        await send(`/api/surveys/${encodeURIComponent(state.surveyId)}/responses`, 'POST', { answers: collectAnswers(form) });
        delete form.dataset.unsent;
        ui.toast('Danke! Deine Antworten sind gespeichert.');
        goTo('surveysHome', null);
      } catch (error) {
        errorBox.textContent = error.message;
        button.disabled = false;
      }
    };
  }

  function onClick(selector, handler) {
    const element = document.querySelector(selector);
    if (element) element.onclick = handler;
  }

  function bindEditPage() {
    const surveyId = editing?.survey.id;
    onClick('[data-surveys-settings]', () => {
      if (editing.survey.status === 'draft') openDraftSettings(editing.survey);
      else openRunningSettings(editing.survey);
    });
    onClick('[data-surveys-add-question]', () => openQuestionForm(surveyId, null));
    document.querySelectorAll('[data-surveys-edit-question]').forEach(button => {
      button.onclick = () => openQuestionForm(surveyId, editing.questions.find(question => question.id === Number(button.dataset.surveysEditQuestion)));
    });
    document.querySelectorAll('[data-surveys-delete-question]').forEach(button => {
      button.onclick = guarded(async () => {
        await send(`/api/surveys/${surveyId}/questions/${encodeURIComponent(button.dataset.surveysDeleteQuestion)}`, 'DELETE');
        reload();
      });
    });
    onClick('[data-surveys-open]', guarded(async () => {
      if (!confirm('Befragung öffnen? Die Teilnehmenden werden festgeschrieben und erhalten eine Aufgabe. Fragen lassen sich danach nicht mehr ändern.')) return;
      await send(`/api/surveys/${surveyId}/open`, 'POST');
      ui.toast('Die Befragung ist offen.');
      reload();
    }));
    onClick('[data-surveys-close]', guarded(async () => {
      if (!confirm('Befragung schließen? Danach kann niemand mehr antworten.')) return;
      await send(`/api/surveys/${surveyId}/close`, 'POST');
      ui.toast('Die Befragung ist geschlossen.');
      reload();
    }));
    onClick('[data-surveys-delete]', guarded(async () => {
      if (!confirm('Diesen Entwurf löschen?')) return;
      await send(`/api/surveys/${surveyId}`, 'DELETE');
      goTo('surveysManage', null);
    }));
  }

  function bind() {
    document.querySelectorAll('[data-surveys-fill]').forEach(button => {
      button.onclick = () => goTo('surveysFill', Number(button.dataset.surveysFill));
    });
    document.querySelectorAll('[data-surveys-edit]').forEach(button => {
      button.onclick = () => goTo('surveysEdit', Number(button.dataset.surveysEdit));
    });
    document.querySelectorAll('[data-surveys-results]').forEach(button => {
      button.onclick = () => goTo('surveysResults', Number(button.dataset.surveysResults));
    });
    document.querySelectorAll('[data-surveys-new]').forEach(button => {
      button.onclick = openCreateForm;
    });
    bindFillForm();
    if (window.loop.view === 'surveysEdit') bindEditPage();
  }

  const surveyAddress = { get: () => state.surveyId, set: id => { state.surveyId = id; } };
  window.loop.registerAddress({ surveysFill: surveyAddress, surveysEdit: surveyAddress, surveysResults: surveyAddress });

  window.loop.registerModule({
    key: 'surveys',
    label: 'Befragungen',
    nav() {
      return [{ route: 'surveysHome', label: 'Befragungen', group: 'myWork', views: VIEWS }];
    },
    allowed(view, me) {
      if (view === 'surveysManage' || view === 'surveysEdit') return isHr(me);
      if (view === 'surveysResultsList' || view === 'surveysResults') return isHr(me) || isLeader(me);
      return true;
    },
    pages: {
      surveysHome: homePage,
      surveysFill: fillPage,
      surveysManage: managePage,
      surveysEdit: editPage,
      surveysResultsList: resultsListPage,
      surveysResults: resultsPage
    },
    tabs(view, me) {
      if (!VIEWS.includes(view)) return [];
      const tabs = [{ route: 'surveysHome', label: 'Offene Befragungen', active: view === 'surveysHome' || view === 'surveysFill' }];
      if (isHr(me)) tabs.push({ route: 'surveysManage', label: 'Verwalten', active: view === 'surveysManage' || view === 'surveysEdit' });
      if (isHr(me) || isLeader(me)) tabs.push({ route: 'surveysResultsList', label: 'Auswertung', active: view === 'surveysResultsList' || view === 'surveysResults' });
      return tabs.length > 1 ? tabs : [];
    },
    bind,
    taskAction(task) {
      if (task.type !== 'surveys_participate') return '';
      return `<button class="btn primary" data-surveys-fill="${esc(task.entity_id)}">Ausfüllen</button>`;
    }
  });
})();
