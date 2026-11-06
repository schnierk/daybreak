// Onboarding & Offboarding: begleitete Abläufe für Ein- und Austritte.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const KIND_LABELS = { onboarding: 'Einstieg', offboarding: 'Austritt' };
  const KEY_DATE_LABELS = { onboarding: 'Erster Arbeitstag', offboarding: 'Letzter Arbeitstag' };
  const KEY_DAY_NAMES = { onboarding: 'ersten Arbeitstag', offboarding: 'letzten Arbeitstag' };
  const OFFBOARDING_NOTE = 'Ein Austrittsablauf verteilt nur Aufgaben. Er trägt keinen Austritt in die Personalakte ein und sperrt kein Konto. Beides erfasst HR in der Personalakte unter „Austritt erfassen“.';
  const STATUS_LABELS = { active: 'Läuft', completed: 'Abgeschlossen', cancelled: 'Abgebrochen' };
  const ASSIGNEE_LABELS = { person: 'Die Person selbst', manager: 'Führungskraft', hr: 'HR' };
  const JOURNEY_VIEWS = ['onboardingHome', 'onboardingJourney'];
  const TEMPLATE_VIEWS = ['onboardingTemplates', 'onboardingTemplate'];

  const state = { journeyId: null, templateId: null, statusFilter: 'active', kindFilter: '' };
  // Gilt nur für die angemeldete Person, die in `userId` steht.
  const myJourneys = { userId: null, items: [], loading: false };

  // Die Sachbearbeitung (hr_staff) verwaltet Abläufe, aber keine Vorlagen.
  const managesTemplates = me => ['hr_admin', 'hrbp', 'super_admin'].includes(me.role);
  const isLead = me => managesTemplates(me) || ['hr_staff', 'manager', 'director'].includes(me.role);
  const refresh = () => window.loop.navigate(window.loop.view);

  function formatDate(value) {
    if (!value) return '–';
    const [year, month, day] = String(value).slice(0, 10).split('-');
    return `${day}.${month}.${year}`;
  }

  function offsetLabel(days, kind) {
    const distance = Math.abs(days);
    if (distance === 0) return `Am ${KEY_DAY_NAMES[kind]}`;
    const unit = distance === 1 ? 'Tag' : 'Tage';
    return days < 0 ? `${distance} ${unit} vorher` : `${distance} ${unit} danach`;
  }

  function actionButton(label, action, data = {}, primary = false) {
    const attributes = Object.entries(data).map(([key, value]) => `data-${key}="${esc(value)}"`).join(' ');
    return `<button type="button" class="btn ${primary ? 'primary' : ''}" data-onboarding-action="${esc(action)}" ${attributes}>${esc(label)}</button>`;
  }

  function options(items, selected = '') {
    return items
      .map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`)
      .join('');
  }

  function statusTag(status) {
    return `<span class="tag ${status === 'active' ? 'focus' : ''}">${esc(STATUS_LABELS[status] || status)}</span>`;
  }

  function progressBar(progress) {
    return `<div class="onboarding-progress">
      <div class="bar"><span style="width:${esc(progress.percent)}%"></span></div>
      <b>${esc(progress.percent)} %</b>
      <small class="muted">${esc(progress.done)} von ${esc(progress.total)} erledigt</small>
    </div>`;
  }

  function responsibleLabel(task) {
    if (task.assigneeName) return task.assigneeName;
    return task.assigneeType === 'manager' ? 'HR, weil keine Führungskraft zugeordnet ist' : ASSIGNEE_LABELS[task.assigneeType];
  }

  function taskRow(task, journeyStatus) {
    const details = [`Fällig: ${formatDate(task.dueDate)}`];
    if (task.assigneeType) details.push(`Zuständig: ${responsibleLabel(task)}`);
    if (task.done && task.doneAt) details.push(`Erledigt am ${formatDate(task.doneAt)}${task.doneByName ? ` von ${task.doneByName}` : ''}`);
    return `<div class="row onboarding-task ${task.done ? 'onboarding-task-done' : ''}">
      <div class="grow">
        <b>${esc(task.title)}</b>
        <small>${esc(details.join(' · '))}</small>
        ${task.description ? `<p class="muted onboarding-task-text">${esc(task.description)}</p>` : ''}
      </div>
      <span class="tag ${task.done ? '' : 'focus'}">${task.done ? 'Erledigt' : journeyStatus === 'cancelled' ? 'Entfallen' : 'Offen'}</span>
      ${task.canComplete ? actionButton('Erledigt', 'complete', { id: task.id }, true) : ''}
    </div>`;
  }

  /** Die betroffene Person sieht eigene Aufgaben und nur die Anzahl der übrigen. */
  function personJourneyBody(journey) {
    const others = journey.otherTasks;
    const hint = others.total
      ? `<p class="muted">Außerdem kümmern sich deine Führungskraft und HR um ${esc(others.total)} ${others.total === 1 ? 'Aufgabe' : 'Aufgaben'}, davon ${esc(others.done)} erledigt.</p>`
      : '';
    return `${journey.tasks.map(task => taskRow(task, journey.status)).join('') || ui.empty('Für dich selbst stehen hier keine Aufgaben an.')}${hint}`;
  }

  async function homePage() {
    const query = new URLSearchParams();
    if (state.statusFilter) query.set('status', state.statusFilter);
    if (state.kindFilter) query.set('kind', state.kindFilter);
    const { journeys } = await api(`/api/onboarding/journeys?${query}`);
    const rows = journeys.map(journey => `<tr>
      <td><b>${esc(journey.personName)}</b><small>${esc(journey.templateName)}</small></td>
      <td data-label="Art">${esc(KIND_LABELS[journey.kind] || journey.kind)}</td>
      <td data-label="Datum">${esc(formatDate(journey.keyDate))}<small>${esc(KEY_DATE_LABELS[journey.kind])}</small></td>
      <td class="onboarding-progress-cell">${progressBar(journey.progress)}</td>
      <td data-label="Stand">${statusTag(journey.status)}</td>
      <td>${actionButton('Öffnen', 'open-journey', { id: journey.id })}</td>
    </tr>`).join('');
    const statusOptions = options([['', 'Alle Stände'], ...Object.entries(STATUS_LABELS)], state.statusFilter);
    // Sonst wirkt ein laufender Ablauf wie ein erfasster Austritt.
    const offboardingNote = journeys.some(journey => journey.kind === 'offboarding') ? `<p class="onboarding-note">${esc(OFFBOARDING_NOTE)}</p>` : '';
    const kindOptions = options([['', 'Ein- und Austritte'], ...Object.entries(KIND_LABELS)], state.kindFilter);
    return `${ui.header('Ein- und Austritte', 'Begleitete Abläufe mit klaren Aufgaben und Fristen.', actionButton('+ Ablauf starten', 'start-journey', {}, true))}
      <article class="card" style="margin-top:18px">
        <div class="onboarding-filters">
          <select id="onboardingStatusFilter" aria-label="Stand filtern">${statusOptions}</select>
          <select id="onboardingKindFilter" aria-label="Art filtern">${kindOptions}</select>
        </div>
        ${rows
          ? `<div class="tableWrap"><table class="table onboarding-table"><thead><tr><th>Person</th><th>Art</th><th>Datum</th><th>Fortschritt</th><th>Stand</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${offboardingNote}`
          : ui.empty('Hier gibt es gerade keinen passenden Ablauf.')}
      </article>`;
  }

  async function journeyPage() {
    if (!state.journeyId) {
      const backView = isLead(window.loop.me) ? 'onboardingHome' : 'onboardingMine';
      return `${ui.empty('Bitte wähle zuerst einen Ablauf aus.')}<button type="button" class="btn" data-view="${esc(backView)}">Zu den Abläufen</button>`;
    }
    const { journey } = await api(`/api/onboarding/journeys/${encodeURIComponent(state.journeyId)}`);
    const me = window.loop.me;
    const isPersonView = journey.viewer === 'person';
    const backRoute = isLead(me) ? 'onboardingHome' : 'onboardingMine';
    const title = isPersonView ? `Mein ${KIND_LABELS[journey.kind]}` : `${KIND_LABELS[journey.kind]}: ${journey.personName}`;
    const actions = `<div class="onboarding-actions">
      <button type="button" class="btn" data-view="${esc(backRoute)}">← Zurück</button>
      ${journey.canCancel ? actionButton('Ablauf abbrechen', 'cancel-journey', { id: journey.id }) : ''}
    </div>`;
    const body = isPersonView ? personJourneyBody(journey) : journey.tasks.map(task => taskRow(task, journey.status)).join('');
    const offboardingNote = journey.kind === 'offboarding' && !isPersonView && journey.status !== 'cancelled'
      ? `<p class="onboarding-note">${esc(OFFBOARDING_NOTE)}</p>`
      : '';
    return `${ui.header(title, `${journey.templateName} · ${KEY_DATE_LABELS[journey.kind]}: ${formatDate(journey.keyDate)}`, actions)}
      ${offboardingNote}
      <article class="card" style="margin-top:18px">
        <div class="sectionHead"><h2>Fortschritt</h2>${statusTag(journey.status)}</div>
        ${progressBar(journey.progress)}
        ${journey.cancelReason ? `<p class="muted">Grund für den Abbruch: ${esc(journey.cancelReason)}</p>` : ''}
      </article>
      <article class="card" style="margin-top:18px">
        <h2>Aufgaben</h2>
        ${body}
      </article>`;
  }

  async function minePage() {
    const { journeys } = await api('/api/onboarding/mine');
    if (!journeys.length) {
      return `${ui.header('Mein Einstieg', 'Hier erscheinen deine Aufgaben, sobald ein Ablauf für dich läuft.')}
        <article class="card" style="margin-top:18px">${ui.empty('Für dich läuft gerade kein Ablauf.')}</article>`;
    }
    const cards = journeys.map(journey => `<article class="card" style="margin-top:18px">
      <div class="sectionHead">
        <div><h2>${esc(KIND_LABELS[journey.kind])}</h2><p class="muted">${esc(KEY_DATE_LABELS[journey.kind])}: ${esc(formatDate(journey.keyDate))}</p></div>
        ${statusTag(journey.status)}
      </div>
      ${progressBar(journey.progress)}
      ${personJourneyBody(journey)}
    </article>`).join('');
    const title = journeys[0].kind === 'offboarding' ? 'Mein Austritt' : 'Mein Einstieg';
    return `${ui.header(title, 'Deine Aufgaben und der Stand auf einen Blick.')}${cards}`;
  }

  /** Vorlagen pflegt die Sachbearbeitung nicht. Über eine gespeicherte Adresse käme sie sonst zu Knöpfen ohne Wirkung. */
  function templatesNotAllowed() {
    return `${ui.empty('Vorlagen pflegt die HR-Administration oder der HR Business Partner.')}<button type="button" class="btn" data-view="onboardingHome">Zu den Abläufen</button>`;
  }

  async function templatesPage() {
    if (!managesTemplates(window.loop.me)) return templatesNotAllowed();
    const { templates } = await api('/api/onboarding/templates?includeInactive=true');
    const rows = templates.map(template => `<tr>
      <td><b>${esc(template.name)}</b><small>${esc(template.description || '')}</small></td>
      <td data-label="Art">${esc(KIND_LABELS[template.kind] || template.kind)}</td>
      <td data-label="Aufgaben">${esc(template.tasks.length)}</td>
      <td data-label="Stand"><span class="tag ${template.active ? '' : 'focus'}">${template.active ? 'Aktiv' : 'Abgeschaltet'}</span></td>
      <td>${actionButton('Bearbeiten', 'open-template', { id: template.id })}</td>
    </tr>`).join('');
    return `${ui.header('Vorlagen', 'Änderungen gelten nur für neue Abläufe. Laufende Abläufe bleiben unverändert.', actionButton('+ Vorlage anlegen', 'new-template', {}, true))}
      <article class="card" style="margin-top:18px">
        <div class="tableWrap"><table class="table onboarding-table"><thead><tr><th>Vorlage</th><th>Art</th><th>Aufgaben</th><th>Stand</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      </article>`;
  }

  async function templatePage() {
    if (!managesTemplates(window.loop.me)) return templatesNotAllowed();
    if (!state.templateId) return `${ui.empty('Bitte wähle zuerst eine Vorlage aus.')}<button type="button" class="btn" data-view="onboardingTemplates">Zu den Vorlagen</button>`;
    const { template } = await api(`/api/onboarding/templates/${encodeURIComponent(state.templateId)}`);
    const rows = template.tasks.map(task => `<tr>
      <td><b>${esc(task.title)}</b><small>${esc(task.description || '')}</small></td>
      <td data-label="Zuständig">${esc(ASSIGNEE_LABELS[task.assigneeType] || task.assigneeType)}</td>
      <td data-label="Termin">${esc(offsetLabel(task.offsetDays, template.kind))}</td>
      <td class="onboarding-actions">
        ${actionButton('Bearbeiten', 'edit-template-task', { id: task.id })}
        ${actionButton('Entfernen', 'delete-template-task', { id: task.id })}
      </td>
    </tr>`).join('');
    const actions = `<div class="onboarding-actions">
      <button type="button" class="btn" data-view="onboardingTemplates">← Alle Vorlagen</button>
      ${actionButton('Name ändern', 'edit-template', { id: template.id })}
      ${actionButton(template.active ? 'Abschalten' : 'Einschalten', 'toggle-template', { id: template.id, active: template.active ? '0' : '1' })}
      ${actionButton('+ Aufgabe', 'new-template-task', { id: template.id }, true)}
    </div>`;
    return `${ui.header(template.name, `${KIND_LABELS[template.kind]} · ${template.active ? 'aktiv' : 'abgeschaltet'}`, actions)}
      <article class="card" style="margin-top:18px">
        ${template.description ? `<p class="muted">${esc(template.description)}</p>` : ''}
        ${rows
          ? `<div class="tableWrap"><table class="table onboarding-table"><thead><tr><th>Aufgabe</th><th>Zuständig</th><th>Termin</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : ui.empty('Diese Vorlage hat noch keine Aufgaben. Ohne Aufgaben lässt sie sich nicht starten.')}
      </article>`;
  }

  function templateTaskFields(task = {}) {
    return `<label>Titel</label><input name="title" required maxlength="200" value="${esc(task.title || '')}">
      <label>Beschreibung</label><textarea name="description" maxlength="2000">${esc(task.description || '')}</textarea>
      <div class="two">
        <div><label>Zuständig</label><select name="assigneeType">${options(Object.entries(ASSIGNEE_LABELS), task.assigneeType || 'person')}</select></div>
        <div><label>Abstand in Tagen</label><input name="offsetDays" type="number" min="-730" max="730" value="${esc(task.offsetDays ?? 0)}"></div>
      </div>
      <p class="muted">Der Abstand zählt vom ersten Arbeitstag beim Einstieg, vom letzten beim Austritt. Eine negative Zahl bedeutet davor, zum Beispiel -7 für eine Woche vorher.</p>`;
  }

  /** Beim Austritt sieht die Person ihre Aufgaben sofort. Deshalb gibt es vorher eine Rückfrage. */
  function confirmStart(data, meta) {
    const template = meta.templates.find(item => String(item.id) === String(data.templateId));
    if (template?.kind !== 'offboarding') return true;
    const person = meta.people.find(item => String(item.id) === String(data.userId));
    return confirm(`Austritt für ${person?.name || 'diese Person'} mit dem letzten Arbeitstag ${formatDate(data.keyDate)} starten? Die Person sieht ihre Aufgaben sofort in der Übersicht. Personalakte und Konto ändern sich dadurch nicht.`);
  }

  async function submitStart(data) {
    const start = body => api('/api/onboarding/journeys', { method: 'POST', body: JSON.stringify(body) });
    try {
      return await start(data);
    } catch (error) {
      if (error.code !== 'past_key_date' || !confirm(`${error.message} Trotzdem starten?`)) throw error;
      return start({ ...data, confirmPastDate: true });
    }
  }

  const actions = {
    'open-journey': ({ id }) => {
      state.journeyId = id;
      window.loop.navigate('onboardingJourney');
    },
    'open-task': async ({ id }) => {
      const { journeyId } = await api(`/api/onboarding/tasks/${encodeURIComponent(id)}`);
      state.journeyId = journeyId;
      window.loop.navigate('onboardingJourney');
    },
    'start-journey': async () => {
      const meta = await api('/api/onboarding/meta');
      if (!meta.people.length) {
        ui.toast('Dir sind keine Personen direkt zugeordnet.', 'error');
        return;
      }
      const templateGroup = kind => {
        const choices = meta.templates.filter(template => template.kind === kind).map(template => [template.id, template.name]);
        return choices.length ? `<optgroup label="${esc(KIND_LABELS[kind])}">${options(choices)}</optgroup>` : '';
      };
      const offersOffboarding = meta.templates.some(template => template.kind === 'offboarding');
      ui.modal({
        title: 'Ablauf starten',
        subtitle: 'Die Aufgaben werden an die Person, die Führungskraft und HR verteilt.',
        submitLabel: 'Starten',
        body: `<label>Person</label><select name="userId" required><option value="">Bitte wählen</option>${options(meta.people.map(person => [person.id, person.name]))}</select>
          <label>Vorlage</label><select name="templateId" required><option value="">Bitte wählen</option>${templateGroup('onboarding')}${templateGroup('offboarding')}</select>
          <label>Erster oder letzter Arbeitstag</label><input name="keyDate" type="date" required>
          <p class="muted">Beim Einstieg trägst du den ersten Arbeitstag ein, beim Austritt den letzten.</p>
          ${offersOffboarding ? `<p class="onboarding-note">${esc(OFFBOARDING_NOTE)}</p>` : ''}`,
        onSubmit: async data => {
          if (!confirmStart(data, meta)) return true;
          const { id } = await submitStart(data);
          myJourneys.userId = null;
          state.journeyId = id;
          ui.toast('Ablauf gestartet.');
          window.loop.navigate('onboardingJourney');
        }
      });
    },
    complete: async ({ id }) => {
      const result = await api(`/api/onboarding/tasks/${encodeURIComponent(id)}/complete`, { method: 'POST', body: '{}' });
      ui.toast(result.journeyStatus === 'completed' ? 'Geschafft! Der Ablauf ist abgeschlossen.' : 'Aufgabe erledigt.');
      myJourneys.userId = null;
      refresh();
    },
    'cancel-journey': ({ id }) => {
      ui.modal({
        title: 'Ablauf abbrechen',
        subtitle: 'Offene Aufgaben verschwinden aus den Übersichten. Das lässt sich nicht rückgängig machen, du kannst den Ablauf aber neu starten.',
        submitLabel: 'Ablauf abbrechen',
        body: '<label>Grund (optional)</label><textarea name="reason" maxlength="500"></textarea>',
        onSubmit: async data => {
          await api(`/api/onboarding/journeys/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify(data) });
          myJourneys.userId = null;
          ui.toast('Ablauf abgebrochen.');
          refresh();
        }
      });
    },
    'open-template': ({ id }) => {
      state.templateId = id;
      window.loop.navigate('onboardingTemplate');
    },
    'new-template': () => {
      ui.modal({
        title: 'Vorlage anlegen',
        submitLabel: 'Anlegen',
        body: `<label>Name</label><input name="name" required maxlength="160">
          <label>Art</label><select name="kind">${options(Object.entries(KIND_LABELS))}</select>
          <label>Beschreibung (optional)</label><textarea name="description" maxlength="2000"></textarea>`,
        onSubmit: async data => {
          const { id } = await api('/api/onboarding/templates', { method: 'POST', body: JSON.stringify(data) });
          state.templateId = id;
          window.loop.navigate('onboardingTemplate');
        }
      });
    },
    'edit-template': async ({ id }) => {
      const { template } = await api(`/api/onboarding/templates/${encodeURIComponent(id)}`);
      ui.modal({
        title: 'Vorlage bearbeiten',
        body: `<label>Name</label><input name="name" required maxlength="160" value="${esc(template.name)}">
          <label>Beschreibung (optional)</label><textarea name="description" maxlength="2000">${esc(template.description || '')}</textarea>`,
        onSubmit: async data => {
          await api(`/api/onboarding/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
          refresh();
        }
      });
    },
    'toggle-template': async ({ id, active }) => {
      await api(`/api/onboarding/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: active === '1' }) });
      refresh();
    },
    'new-template-task': ({ id }) => {
      ui.modal({
        title: 'Aufgabe ergänzen',
        body: templateTaskFields(),
        onSubmit: async data => {
          await api(`/api/onboarding/templates/${encodeURIComponent(id)}/tasks`, { method: 'POST', body: JSON.stringify(data) });
          refresh();
        }
      });
    },
    'edit-template-task': async ({ id }) => {
      const { template } = await api(`/api/onboarding/templates/${encodeURIComponent(state.templateId)}`);
      const task = template.tasks.find(item => String(item.id) === String(id));
      if (!task) throw new Error('Diese Aufgabe gibt es nicht mehr.');
      ui.modal({
        title: 'Aufgabe bearbeiten',
        body: templateTaskFields(task),
        onSubmit: async data => {
          await api(`/api/onboarding/template-tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
          refresh();
        }
      });
    },
    'delete-template-task': async ({ id }) => {
      if (!confirm('Aufgabe aus der Vorlage entfernen? Laufende Abläufe behalten ihre Kopie.')) return;
      await api(`/api/onboarding/template-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      refresh();
    }
  };

  async function runAction(element) {
    const { onboardingAction, ...data } = element.dataset;
    try {
      await actions[onboardingAction]?.(data);
    } catch (error) {
      ui.toast(error.message || 'Das hat leider nicht geklappt.', 'error');
    }
  }

  function bind() {
    document.querySelectorAll('[data-onboarding-action]').forEach(element => {
      element.onclick = () => runAction(element);
    });
    const statusFilter = document.querySelector('#onboardingStatusFilter');
    if (statusFilter) {
      statusFilter.onchange = () => {
        state.statusFilter = statusFilter.value;
        refresh();
      };
    }
    const kindFilter = document.querySelector('#onboardingKindFilter');
    if (kindFilter) {
      kindFilter.onchange = () => {
        state.kindFilter = kindFilter.value;
        refresh();
      };
    }
  }

  /**
   * Die Navigation wird ohne Warten gebaut, ob ein Ablauf existiert, steht aber erst nach der Antwort
   * des Servers fest. Deshalb wird nur auf der Übersicht neu gezeichnet: Dort geht nichts verloren.
   */
  function loadMyJourneys(me) {
    if (myJourneys.loading || myJourneys.userId === me.id) return;
    myJourneys.loading = true;
    api('/api/onboarding/mine')
      .then(({ journeys }) => {
        const hadEntry = myJourneys.userId === me.id && myJourneys.items.length > 0;
        myJourneys.userId = me.id;
        myJourneys.items = journeys;
        if (journeys.length > 0 && !hadEntry && window.loop.view === 'dashboard') window.loop.navigate('dashboard');
      })
      .catch(() => {
        myJourneys.userId = me.id;
        myJourneys.items = [];
      })
      .finally(() => {
        myJourneys.loading = false;
      });
  }

  function navigationItems(me) {
    loadMyJourneys(me);
    const items = [];
    if (isLead(me)) {
      items.push({ route: 'onboardingHome', label: 'Ein- und Austritte', group: 'hr', views: [...JOURNEY_VIEWS, ...TEMPLATE_VIEWS] });
    }
    const own = myJourneys.userId === me.id ? myJourneys.items : [];
    if (own.length) {
      items.push({ route: 'onboardingMine', label: own[0].kind === 'offboarding' ? 'Mein Austritt' : 'Mein Einstieg', group: 'myWork' });
    }
    return items;
  }

  window.loop.registerAddress?.({
    onboardingJourney: { get: () => state.journeyId, set: id => { state.journeyId = id; } },
    onboardingTemplate: { get: () => state.templateId, set: id => { state.templateId = id; } }
  });

  window.loop.registerModule({
    key: 'onboarding',
    label: 'Ein- und Austritte',
    nav: navigationItems,
    pages: {
      onboardingHome: homePage,
      onboardingJourney: journeyPage,
      onboardingMine: minePage,
      onboardingTemplates: templatesPage,
      onboardingTemplate: templatePage
    },
    tabs(view, me) {
      if (!managesTemplates(me) || ![...JOURNEY_VIEWS, ...TEMPLATE_VIEWS].includes(view)) return [];
      return [
        { route: 'onboardingHome', label: 'Abläufe', active: JOURNEY_VIEWS.includes(view) },
        { route: 'onboardingTemplates', label: 'Vorlagen', active: TEMPLATE_VIEWS.includes(view) }
      ];
    },
    bind,
    taskAction(task) {
      if (task.type !== 'onboarding_task') return '';
      return actionButton('Öffnen', 'open-task', { id: task.entity_id });
    }
  });
})();
