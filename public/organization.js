// Einstellungen einer Organisation: Modulschalter, Name, Farbe und Support-Freigabe.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  /** Hinweis für die öffentliche Demo, in der alle Besucher dieselben Einstellungen sehen. */
  function demoHint() {
    return window.loop.tenant?.demoMode
      ? '<p class="orgRuleHint" role="note">Öffentliche Demo: Deine Änderung gilt für alle Besucher und wird stündlich zurückgesetzt.</p>'
      : '';
  }

  let auditFilter = '';

  const STATUS_TAG = {
    alwaysOn: '<span class="tag">Immer an</span>',
    planned: '<span class="tag focus">Geplant</span>',
    notBooked: '<span class="tag focus">Nicht freigegeben</span>'
  };

  function moduleCard(module, namesByKey) {
    const needs = module.dependsOn.length
      ? `<small class="muted">Benötigt: ${module.dependsOn.map(key => esc(namesByKey[key] || key)).join(', ')}</small>`
      : '';
    let control;
    if (module.alwaysOn) control = STATUS_TAG.alwaysOn;
    else if (module.status === 'planned') control = STATUS_TAG.planned;
    else if (!module.entitled) control = STATUS_TAG.notBooked;
    else {
      control = `<label class="moduleSwitch"><input type="checkbox" data-org-module="${esc(module.key)}" ${module.switchedOn ? 'checked' : ''} aria-label="${esc(module.name)} einschalten"><span>${module.enabled ? 'An' : 'Aus'}</span></label>`;
    }
    return `<article class="card moduleCard ${module.enabled ? 'moduleOn' : ''}">
      <div class="moduleCardHead"><h3>${esc(module.name)}</h3>${control}</div>
      <p class="muted">${esc(module.description)}</p>
      ${needs}
    </article>`;
  }

  async function modulesPage() {
    const { modules } = await api('/api/organization/modules');
    const namesByKey = Object.fromEntries(modules.map(module => [module.key, module.name]));
    const areas = [...new Set(modules.map(module => module.area))];
    const sections = areas.map(area => `<section class="moduleArea">
      <h2>${esc(area)}</h2>
      <div class="moduleGrid">${modules.filter(module => module.area === area).map(module => moduleCard(module, namesByKey)).join('')}</div>
    </section>`).join('');
    return `${ui.header('Module', 'Schalte Fachbereiche für deine Organisation an oder aus. Beim Abschalten bleiben alle Daten erhalten.')}${demoHint()}${sections}`;
  }

  async function settingsPage() {
    const { settings } = await api('/api/organization/settings');
    const support = settings.isPrimary ? '' : `<label class="checkRow"><input type="checkbox" name="supportAccess" ${settings.supportAccess ? 'checked' : ''}> Support-Zugriff durch den Betreiber erlauben</label>
      <p class="muted">Nur wenn du das erlaubst, kann der Betreiber bei Problemen in eure Organisation hineinsehen. Jeder Zugriff wird protokolliert. Du kannst die Freigabe jederzeit wieder entziehen; sie wirkt sofort.</p>`;
    // Die Systemadministration darf auch die Demo umbenennen, Besucher nicht.
    const locked = settings.demoMode && window.loop.me?.role !== 'super_admin';
    const lockedHint = locked ? '<p class="orgRuleHint" role="note">In der öffentlichen Demo bleiben Name und Farbe unverändert.</p>' : '';
    return `${ui.header('Organisation', 'Name und Erscheinungsbild für alle Mitarbeitenden.')}
      <article class="card" style="margin-top:18px;max-width:620px">
        ${lockedHint}
        <form id="orgSettingsForm" class="talent-form">
          <div class="error" id="orgSettingsError"></div>
          <fieldset class="orgFieldset" ${locked ? 'disabled' : ''}>
          <label>Name der Organisation</label><input name="name" value="${esc(settings.name)}" required maxlength="120">
          <label>Hauptfarbe</label><input name="primaryColor" type="color" value="${esc(settings.primaryColor || '#4c67ec')}">
          ${support}
          <button class="btn primary">Speichern</button>
          </fieldset>
        </form>
        <p class="muted" style="margin-top:14px">Firmenkennung für die Anmeldung: <b>${esc(settings.slug)}</b></p>
      </article>`;
  }

  async function approvalsPage() {
    const { rules } = await api('/api/organization/approval-rules');
    const rows = rules.map(rule => `<article class="card orgRule">
      <div class="orgRuleText">
        <h3>${esc(rule.title)}</h3>
        <p class="muted">${esc(rule.question)}</p>
        ${rule.goLive ? '<p class="orgRuleHint">Vor dem Echtbetrieb neu entscheiden. Diese Voreinstellung ist für die Demo gedacht.</p>' : ''}
      </div>
      <label class="orgRuleChoice"><span class="muted">Regel</span>
        <select data-org-rule="${esc(rule.key)}" aria-label="${esc(rule.question)}">
          ${rule.options.map(option => `<option value="${esc(option.value)}" ${option.value === rule.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
        </select>
      </label>
    </article>`).join('');
    return `${ui.header('Genehmigungen', 'Lege fest, wer in eurer Organisation was freigibt. Änderungen gelten sofort und nur für neue Vorgänge.')}${demoHint()}
      <section class="orgRules">${rows || ui.empty('Für eure eingeschalteten Module gibt es keine einstellbaren Regeln.')}</section>`;
  }

  async function auditPage() {
    const query = new URLSearchParams();
    if (auditFilter) query.set('action', auditFilter);
    const { entries, actions, hasMore } = await api(`/api/organization/audit?${query}`);
    const when = value => new Date(`${String(value).replace(' ', 'T')}${/[zZ]|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z'}`).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
    const row = entry => `<tr><td>${esc(when(entry.created_at))}</td><td>${esc(entry.actor_name || 'System')}</td><td><b>${esc(entry.label)}</b>${entry.detail ? `<small>${esc(entry.detail)}</small>` : ''}</td><td>${esc(entry.subject || '')}</td></tr>`;
    return `${ui.header('Protokoll', 'Wer hat wann was geändert. Inhalte wie Gehälter oder Krankheiten stehen hier nicht im Klartext, und Abgaben zu Befragungen werden nie protokolliert.', `<a class="btn" href="/api/organization/audit.csv${auditFilter ? `?action=${encodeURIComponent(auditFilter)}` : ''}" download>Als CSV herunterladen</a>`)}
      <article class="card" style="margin-top:18px">
        <label for="orgAuditFilter">Nur diese Änderung zeigen</label>
        <select id="orgAuditFilter" data-org-audit-filter style="max-width:420px"><option value="">Alles</option>${actions.map(item => `<option value="${esc(item.key)}" ${item.key === auditFilter ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select>
        <div class="tableWrap" style="margin-top:12px"><table class="table"><thead><tr><th>Wann</th><th>Wer</th><th>Was</th><th>Betrifft</th></tr></thead><tbody>${entries.map(row).join('')}</tbody></table></div>
        ${entries.length ? '' : ui.empty('Noch keine Einträge.')}
        ${hasMore ? '<p class="muted" style="margin-top:12px">Gezeigt werden die letzten 100 Einträge. Die CSV-Datei enthält bis zu 5.000.</p>' : ''}
      </article>`;
  }

  async function openTasksPage() {
    const { tasks } = await api('/api/organization/open-tasks');
    const byPerson = new Map();
    for (const task of tasks) byPerson.set(task.person_name, (byPerson.get(task.person_name) || 0) + 1);
    const top = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter(task => task.due_date && task.due_date < today).length;
    const lockedCount = tasks.filter(task => !task.person_active).length;
    const row = task => `<tr><td>${esc(task.person_name)}${task.person_active ? '' : ' <span class="tag focus">Konto gesperrt</span>'}</td><td>${esc(task.title)}</td><td class="${task.due_date && task.due_date < today ? 'overdue' : ''}">${task.due_date ? esc(ui.date(task.due_date)) : '–'}</td></tr>`;
    return `${ui.header('Offene Vorgänge', 'Was gerade bei wem liegt. Teilnahmen an Befragungen fehlen hier absichtlich.')}
      <section class="cards">${ui.stat('Offen', tasks.length, 'Aufgaben mit einem Vorgang')}${ui.stat('Überfällig', overdue, 'Frist überschritten')}${ui.stat('Am meisten bei', top[0] ? top[0][0] : '–', top[0] ? ui.plural(top[0][1], 'Aufgabe', 'Aufgaben') : 'Keine offenen Aufgaben')}</section>
      ${lockedCount ? `<article class="card" style="margin-top:18px"><b>${esc(ui.plural(lockedCount, 'Vorgang liegt', 'Vorgänge liegen'))} bei gesperrten Konten.</b><p class="muted">Sie stehen oben in der Liste. Ordne die betroffenen Personen unter „Mitarbeitende“ einer anderen Führungskraft zu, dann ziehen Freigaben und Aufgaben mit.</p></article>` : ''}
      <article class="card"><div class="tableWrap"><table class="table"><thead><tr><th>Bei</th><th>Aufgabe</th><th>Frist</th></tr></thead><tbody>${tasks.map(row).join('')}</tbody></table></div>${tasks.length ? '' : ui.empty('Gerade ist nichts offen.')}</article>`;
  }

  function bind() {
    document.querySelectorAll('[data-org-audit-filter]').forEach(select => {
      select.onchange = () => {
        auditFilter = select.value;
        window.loop.navigate('orgAudit');
      };
    });
    document.querySelectorAll('[data-org-rule]').forEach(select => {
      select.onchange = async () => {
        try {
          await api(`/api/organization/approval-rules/${encodeURIComponent(select.dataset.orgRule)}`, { method: 'PUT', body: JSON.stringify({ value: select.value }) });
          ui.toast('Regel gespeichert.');
        } catch (error) {
          ui.toast(error.message, 'error');
          window.loop.navigate('orgApprovals');
        }
      };
    });
    document.querySelectorAll('[data-org-module]').forEach(input => {
      input.onchange = async () => {
        try {
          await api(`/api/organization/modules/${encodeURIComponent(input.dataset.orgModule)}`, { method: 'PATCH', body: JSON.stringify({ enabled: input.checked }) });
          await window.loop.reloadConfig();
          ui.toast(input.checked ? 'Modul eingeschaltet.' : 'Modul abgeschaltet. Die Daten bleiben erhalten.');
        } catch (error) {
          ui.toast(error.message, 'error');
        }
        window.loop.navigate('orgModules');
      };
    });
    const form = document.querySelector('#orgSettingsForm');
    if (form) {
      form.onsubmit = async event => {
        event.preventDefault();
        const data = new FormData(form);
        const body = { name: data.get('name'), primaryColor: data.get('primaryColor') };
        if (form.elements.supportAccess) body.supportAccess = form.elements.supportAccess.checked;
        try {
          await api('/api/organization/settings', { method: 'PATCH', body: JSON.stringify(body) });
          await window.loop.reloadConfig();
          ui.toast('Einstellungen gespeichert.');
          window.loop.navigate('orgSettings');
        } catch (error) {
          document.querySelector('#orgSettingsError').textContent = error.message;
        }
      };
    }
  }

  window.loop.registerModule({
    key: 'organization',
    core: true,
    nav(me) {
      if (!['hr_admin', 'super_admin'].includes(me.role)) return [];
      return [
        { route: 'orgModules', label: 'Module', group: 'admin' },
        { route: 'orgApprovals', label: 'Genehmigungen', group: 'admin' },
        { route: 'orgSettings', label: 'Organisation', group: 'admin' },
        { route: 'orgOpenTasks', label: 'Offene Vorgänge', group: 'admin' },
        { route: 'orgAudit', label: 'Protokoll', group: 'admin' }
      ];
    },
    pages: { orgModules: modulesPage, orgApprovals: approvalsPage, orgSettings: settingsPage, orgAudit: auditPage, orgOpenTasks: openTasksPage },
    bind
  });
})();
