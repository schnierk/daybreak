// Lernen und Pflichtschulungen: Meine Kurse, Mein Team, Kurskatalog und Erfüllungsquoten.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const VIEWS = ['learningHome', 'learningTeam', 'learningCourses', 'learningReport'];
  const HR_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const LEADER_ROLES = ['manager', 'director'];
  const COURSE_TYPES = [['online', 'Online'], ['classroom', 'Präsenz'], ['document', 'Dokument'], ['external', 'Extern']];

  const isHr = person => HR_ROLES.includes(person.role);
  const isLeader = person => LEADER_ROLES.includes(person.role);
  // Der HR-Leitung weist nur die HR-Administration gezielt Kurse zu.
  const assignableRoles = me => Object.entries(window.loop.roles).filter(([role]) => role !== 'super_admin' && !(role === 'hr_admin' && me.role === 'hrbp'));
  const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
  const reload = () => window.loop.navigate(window.loop.view);
  const germanDate = value => (value ? String(value).split('-').reverse().join('.') : '–');
  const isoInDays = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  function durationLabel(minutes) {
    if (!minutes) return '';
    if (minutes < 60) return `${minutes} Min.`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
  }

  function courseMeta(item) {
    return [item.courseTypeLabel, item.provider, durationLabel(item.durationMinutes)].filter(Boolean).map(esc).join(' · ');
  }

  function courseLink(url) {
    return url ? `<a class="btn learning-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Kurs öffnen</a>` : '';
  }

  function statusTag(item) {
    if (item.confirmationPending) return '<span class="tag focus">Wartet auf Bestätigung</span>';
    if (item.overdue) return '<span class="tag danger">Überfällig</span>';
    if (item.status === 'expired') return '<span class="tag focus">Abgelaufen</span>';
    return `<span class="tag">${esc(item.statusLabel)}</span>`;
  }

  const mandatoryTag = item => (item.mandatory ? '<span class="tag focus">Pflicht</span>' : '');

  function assignmentDates(item) {
    const parts = [];
    if (item.dueDate && !item.completedAt) parts.push(`Frist: ${germanDate(item.dueDate)}`);
    if (item.completedAt) parts.push(`Abgeschlossen: ${germanDate(item.completedAt)}`);
    if (item.expiresAt) parts.push(`Gültig bis: ${germanDate(item.expiresAt)}`);
    return parts.join(' · ');
  }

  function ownAssignmentRow(item) {
    const isOpen = item.status === 'assigned' || item.status === 'started';
    const start = item.status === 'assigned' ? `<button type="button" class="btn" data-learning-start="${esc(item.id)}">Beginnen</button>` : '';
    const complete = isOpen && !item.confirmationPending
      ? `<button type="button" class="btn primary" data-learning-complete="${esc(item.id)}" data-learning-title="${esc(item.courseTitle)}">Abschluss melden</button>`
      : '';
    const note = item.confirmationNote ? `<small class="learning-note">Nicht bestätigt: ${esc(item.confirmationNote)}</small>` : '';
    const proof = item.proofText ? `<small>Nachweis: ${esc(item.proofText)}</small>` : '';
    return `<div class="row learning-row">
      <div class="grow"><b>${esc(item.courseTitle)}</b><small>${courseMeta(item)}</small><small>${esc(assignmentDates(item))}</small>${proof}${note}</div>
      <div class="learning-actions">${mandatoryTag(item)}${statusTag(item)}${isOpen ? courseLink(item.linkUrl) : ''}${start}${complete}</div>
    </div>`;
  }

  function catalogRow(course) {
    const action = course.canEnroll
      ? `<button type="button" class="btn primary" data-learning-enroll="${esc(course.id)}">Eintragen</button>`
      : course.alreadyOpen ? '<span class="tag">Bereits eingetragen</span>' : '';
    const competency = course.competency ? `<small>Stärkt: ${esc(course.competency.name)}</small>` : '';
    return `<div class="row learning-row">
      <div class="grow"><b>${esc(course.title)}</b><small>${courseMeta(course)}</small>${course.description ? `<small>${esc(course.description)}</small>` : ''}${competency}</div>
      <div class="learning-actions">${mandatoryTag(course)}${courseLink(course.linkUrl)}${action}</div>
    </div>`;
  }

  const sectionCard = (title, content, hint = '') => `<article class="card learning-section">
    <div class="sectionHead"><div><h2>${esc(title)}</h2>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div></div>
    ${content}
  </article>`;

  async function homePage() {
    const data = await api('/api/learning/my');
    const overdue = data.overdue.length ? sectionCard('Überfällig', data.overdue.map(ownAssignmentRow).join('')) : '';
    return `${ui.header('Lernen', 'Deine Kurse, Pflichtschulungen und Nachweise an einem Ort.')}
      <section class="cards">
        ${ui.stat('Offen', data.open.length, 'Kurse in Arbeit')}
        ${ui.stat('Überfällig', data.overdue.length, 'Frist überschritten')}
        ${ui.stat('Abgeschlossen', data.completed.length, 'mit Datum und Nachweis')}
      </section>
      <section class="learning-stack">
        ${overdue}
        ${sectionCard('Offen', data.open.map(ownAssignmentRow).join('') || ui.empty('Gerade ist nichts offen.'))}
        ${sectionCard('Abgeschlossen', data.completed.map(ownAssignmentRow).join('') || ui.empty('Noch keine Abschlüsse.'))}
        ${sectionCard('Katalog', data.catalog.map(catalogRow).join('') || ui.empty('Der Katalog ist noch leer.'), 'Für freiwillige Kurse trägst du dich selbst ein. Pflichtkurse werden dir zugewiesen.')}
      </section>`;
  }

  function teamAssignmentRow(item, me) {
    const isOpen = item.status === 'assigned' || item.status === 'started';
    const record = isHr(me) && isOpen && !item.confirmationPending && item.userId !== me.id
      ? `<button type="button" class="btn" data-learning-complete="${esc(item.id)}" data-learning-title="${esc(item.courseTitle)}">Abschluss erfassen</button>`
      : '';
    return `<tr>
      <td><b>${esc(item.courseTitle)}</b>${item.mandatory ? ' <span class="tag focus">Pflicht</span>' : ''}</td>
      <td data-label="Status">${statusTag(item)}</td>
      <td data-label="Frist">${esc(germanDate(item.dueDate))}</td>
      <td data-label="Abschluss">${esc(germanDate(item.completedAt))}</td>
      <td data-label="Gültig bis">${esc(germanDate(item.expiresAt))}</td>
      <td>${record}</td>
    </tr>`;
  }

  function personDetails(person, me) {
    const summary = [
      `${person.open} offen`,
      person.overdue ? `${person.overdue} überfällig` : '',
      `${person.completed} abgeschlossen`,
      person.expired ? `${person.expired} abgelaufen` : ''
    ].filter(Boolean).join(' · ');
    const table = person.assignments.length
      ? `<div class="tableWrap"><table class="table learning-table">
          <thead><tr><th>Kurs</th><th>Status</th><th>Frist</th><th>Abschluss</th><th>Gültig bis</th><th></th></tr></thead>
          <tbody>${person.assignments.map(item => teamAssignmentRow(item, me)).join('')}</tbody>
        </table></div>`
      : ui.empty('Keine Kurse zugewiesen.');
    return `<details class="learning-person">
      <summary><b>${esc(person.name)}</b> <span class="muted">${esc(summary)}</span>${person.overdue ? ' <span class="tag danger">Überfällig</span>' : ''}</summary>
      ${table}
    </details>`;
  }

  function pendingRow(item) {
    const proof = item.proofText ? `<small>Nachweis: ${esc(item.proofText)}</small>` : '<small>Ohne Nachweis gemeldet.</small>';
    return `<div class="row learning-row">
      <div class="grow"><b>${esc(item.userName)}: ${esc(item.courseTitle)}</b>${proof}</div>
      <div class="learning-actions">
        <button type="button" class="btn primary" data-learning-confirm="${esc(item.id)}">Bestätigen</button>
        <button type="button" class="btn" data-learning-reject="${esc(item.id)}">Nicht bestätigen</button>
      </div>
    </div>`;
  }

  async function teamPage() {
    const me = window.loop.me;
    const data = await api('/api/learning/team');
    const pending = data.pendingConfirmations.length
      ? sectionCard('Wartet auf deine Bestätigung', data.pendingConfirmations.map(pendingRow).join(''))
      : '';
    const subtitle = isHr(me) ? 'Der Lernstand aller Personen.' : 'Der Lernstand aller, die du direkt oder indirekt führst.';
    return `${ui.header(isHr(me) ? 'Alle Personen' : 'Mein Team', subtitle, '<button type="button" class="btn primary" data-learning-assign>+ Kurs zuweisen</button>')}
      <section class="learning-stack">
        ${pending}
        ${sectionCard('Stand je Person', data.people.map(person => personDetails(person, me)).join('') || ui.empty('Dir sind noch keine Personen zugeordnet.'))}
      </section>`;
  }

  function courseTableRow(course) {
    const validity = course.validityMonths ? ui.plural(course.validityMonths, 'Monat', 'Monate') : 'unbegrenzt';
    return `<tr>
      <td><b>${esc(course.title)}</b><small>${esc(course.provider)}</small></td>
      <td data-label="Art">${esc(course.courseTypeLabel)}</td>
      <td data-label="Verbindlichkeit">${course.mandatory ? `<div><span class="tag focus">Pflicht</span>${course.requiresConfirmation ? '<small>mit Bestätigung</small>' : ''}</div>` : '<span class="tag">Freiwillig</span>'}</td>
      <td data-label="Gültigkeit">${esc(validity)}</td>
      <td data-label="Status">${course.active ? '<span class="tag">Aktiv</span>' : '<span class="tag focus">Inaktiv</span>'}</td>
      <td class="learning-actions">
        <button type="button" class="btn" data-learning-edit-course="${esc(course.id)}">Bearbeiten</button>
        ${course.active ? `<button type="button" class="btn" data-learning-assign="${esc(course.id)}">Zuweisen</button>` : ''}
      </td>
    </tr>`;
  }

  async function coursesPage() {
    const { courses } = await api('/api/learning/courses?includeInactive=true');
    const table = courses.length
      ? `<div class="tableWrap"><table class="table learning-table">
          <thead><tr><th>Kurs</th><th>Art</th><th>Verbindlichkeit</th><th>Gültigkeit</th><th>Status</th><th></th></tr></thead>
          <tbody>${courses.map(courseTableRow).join('')}</tbody>
        </table></div>`
      : ui.empty('Noch keine Kurse. Lege den ersten Kurs an.');
    return `${ui.header('Kurse', 'Daybreak verwaltet Kurse und Nachweise. Die Lerninhalte selbst liegen beim Anbieter oder hinter dem Link.', '<button type="button" class="btn primary" data-learning-new-course>+ Kurs anlegen</button>')}
      <section class="learning-stack">${sectionCard('Kurskatalog', table)}</section>`;
  }

  const rateLabel = percent => (percent === null ? '–' : `${percent} %`);

  function complianceRow(name, entry) {
    return `<tr>
      <td><b>${esc(name)}</b></td>
      <td data-label="Quote"><span>${esc(rateLabel(entry.ratePercent))}<div class="bar learning-bar"><span style="width:${Number(entry.ratePercent) || 0}%"></span></div></span></td>
      <td data-label="Erfüllt">${esc(entry.fulfilled)} von ${esc(entry.required)}</td>
      <td data-label="Überfällig">${entry.overdue ? `<span class="tag danger">${esc(entry.overdue)}</span>` : '0'}</td>
    </tr>`;
  }

  function complianceTable(rows) {
    return `<div class="tableWrap"><table class="table learning-table">
      <thead><tr><th>Name</th><th>Quote</th><th>Erfüllt</th><th>Überfällig</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  async function reportPage() {
    const data = await api('/api/learning/report');
    const courses = data.courses.length
      ? complianceTable(data.courses.map(course => complianceRow(course.title, course)).join(''))
      : ui.empty('Es gibt noch keine aktiven Pflichtkurse.');
    const people = data.people.length
      ? complianceTable(data.people.map(person => complianceRow(person.name, person)).join(''))
      : ui.empty('Es sind noch keine Pflichtkurse zugewiesen.');
    const exportLink = '<a class="btn learning-link" href="/api/learning/report/export.csv" download>Als CSV herunterladen</a>';
    return `${ui.header('Erfüllung', 'Wie viele Zuweisungen von Pflichtkursen mit einem gültigen Abschluss erfüllt sind.', exportLink)}
      <section class="cards">
        ${ui.stat('Erfüllungsquote', rateLabel(data.overall.ratePercent), `${data.overall.fulfilled} von ${data.overall.required} Zuweisungen`)}
        ${ui.stat('Überfällig', data.overall.overdue, 'Frist überschritten')}
      </section>
      <section class="learning-stack">
        ${sectionCard('Je Pflichtkurs', courses)}
        ${sectionCard('Je Person', people)}
      </section>`;
  }

  function optionList(entries, selected) {
    return entries.map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
  }

  async function openCourseForm(courseId) {
    const talentOn = window.loop.isModuleEnabled('talent');
    const [{ courses }, competencies] = await Promise.all([
      api('/api/learning/courses?includeInactive=true'),
      talentOn ? api('/api/competencies') : Promise.resolve({ items: [] })
    ]);
    const course = courses.find(item => item.id === courseId) || null;
    const competencyField = talentOn
      ? `<label>Stärkt diese Kompetenz (optional)</label><select name="competencyId"><option value="">Keine</option>${optionList(competencies.items.map(item => [item.id, item.name]), course?.competency?.id)}</select>`
      : '';
    const activeField = course
      ? `<label class="checkline"><input type="checkbox" name="active" ${course.active ? 'checked' : ''}> Kurs ist aktiv und im Katalog sichtbar</label>`
      : '';
    ui.modal({
      title: course ? 'Kurs bearbeiten' : 'Kurs anlegen',
      subtitle: 'Lerninhalte werden nicht in Daybreak gespeichert.',
      body: `<label>Titel</label><input name="title" required maxlength="200" value="${esc(course?.title)}">
        <label>Beschreibung</label><textarea name="description">${esc(course?.description)}</textarea>
        <div class="two">
          <div><label>Art</label><select name="courseType">${optionList(COURSE_TYPES, course?.courseType)}</select></div>
          <div><label>Anbieter</label><input name="provider" maxlength="200" value="${esc(course?.provider)}"></div>
        </div>
        <label>Link (http oder https)</label><input name="linkUrl" type="url" placeholder="https://" value="${esc(course?.linkUrl)}">
        <div class="two">
          <div><label>Dauer in Minuten</label><input name="durationMinutes" type="number" min="1" value="${esc(course?.durationMinutes)}"></div>
          <div><label>Gültigkeit in Monaten (leer = unbegrenzt)</label><input name="validityMonths" type="number" min="1" value="${esc(course?.validityMonths)}"></div>
        </div>
        ${competencyField}
        <label class="checkline"><input type="checkbox" name="mandatory" ${course?.mandatory ? 'checked' : ''}> Pflichtkurs</label>
        <label class="checkline"><input type="checkbox" name="requiresConfirmation" ${course?.requiresConfirmation ? 'checked' : ''}> Abschluss muss bestätigt werden (nur bei Pflichtkursen)</label>
        ${activeField}
        <p class="muted">Bei Pflichtkursen mit Gültigkeit weist Daybreak 30 Tage vor Ablauf automatisch neu zu.</p>`,
      onSubmit: async data => {
        const body = {
          ...data,
          mandatory: data.mandatory === 'on',
          requiresConfirmation: data.requiresConfirmation === 'on'
        };
        if (course) body.active = data.active === 'on';
        await api(course ? `/api/learning/courses/${course.id}` : '/api/learning/courses', {
          method: course ? 'PATCH' : 'POST',
          body: JSON.stringify(body)
        });
        ui.toast(course ? 'Kurs gespeichert.' : 'Kurs angelegt.');
        reload();
      }
    });
  }

  function targetSection(me, people) {
    const peopleField = `<div data-learning-target="users">
      <label>Personen (mehrere mit Strg oder gedrückter Taste wählen)</label>
      <select name="userIds" multiple size="6" ${isHr(me) ? '' : 'required'}>${optionList(people.map(person => [person.id, person.name]))}</select>
    </div>`;
    if (!isHr(me)) return peopleField;
    const rolesField = `<div data-learning-target="roles" hidden>
      <label>Rollen</label>
      <div class="checkboxes">${assignableRoles(me).map(([role, label]) => `<label class="checkline"><input type="checkbox" name="roles" value="${esc(role)}"> ${esc(label)}</label>`).join('')}</div>
    </div>`;
    return `<label>Wem zuweisen?</label>
      <select name="targetType" data-learning-target-type>
        <option value="users">Einzelnen Personen</option>
        <option value="roles">Ganzen Rollen</option>
        <option value="all">Allen</option>
      </select>
      ${peopleField}${rolesField}`;
  }

  async function openAssignForm(presetCourseId) {
    const me = window.loop.me;
    const [{ courses }, { users }] = await Promise.all([api('/api/learning/courses'), api('/api/users')]);
    if (!courses.length) {
      ui.toast('Es gibt noch keine aktiven Kurse.', 'error');
      return;
    }
    // canAssign kommt vom Server. Sich selbst darf HR immer einen Kurs geben.
    const people = isHr(me)
      ? users.filter(person => person.canAssign !== false || person.id === me.id)
      : users.filter(person => person.manager_id === me.id);
    ui.modal({
      title: 'Kurs zuweisen',
      subtitle: 'Wer den Kurs schon offen hat, bekommt ihn nicht doppelt.',
      submitLabel: 'Zuweisen',
      body: `<label>Kurs</label>
        <select name="courseId" required>${optionList(courses.map(course => [course.id, course.mandatory ? `${course.title} (Pflicht)` : course.title]), presetCourseId)}</select>
        <label>Frist</label><input name="dueDate" type="date" min="${esc(isoInDays(0))}" value="${esc(isoInDays(30))}">
        ${targetSection(me, people)}
        <p class="muted">Jede Person erhält eine Aufgabe auf ihrer Übersicht. E-Mails versendet Daybreak nicht.</p>`,
      onSubmit: async (data, form) => {
        const formData = new FormData(form);
        const body = { courseId: Number(data.courseId), dueDate: data.dueDate || null };
        const target = data.targetType || 'users';
        if (target === 'all') body.all = true;
        if (target === 'roles') body.roles = formData.getAll('roles');
        if (target === 'users') body.userIds = formData.getAll('userIds').map(Number);
        const result = await post('/api/learning/assignments', body);
        ui.toast(result.alreadyOpen
          ? `${ui.plural(result.created, 'Person', 'Personen')} neu zugewiesen, ${ui.plural(result.alreadyOpen, 'Person hatte', 'Personen hatten')} den Kurs schon offen.`
          : `${ui.plural(result.created, 'Person', 'Personen')} neu zugewiesen.`);
        reload();
      }
    });
    document.querySelector('[data-learning-target-type]')?.addEventListener('change', event => {
      document.querySelectorAll('[data-learning-target]').forEach(section => {
        section.hidden = section.dataset.learningTarget !== event.target.value;
      });
    });
  }

  function openCompleteForm(assignmentId, title) {
    ui.modal({
      title: 'Abschluss melden',
      subtitle: title,
      submitLabel: 'Abschluss melden',
      body: `<label>Abgeschlossen am</label><input name="completedAt" type="date" max="${esc(isoInDays(0))}" value="${esc(isoInDays(0))}" required>
        <label>Nachweis (optional, als Text)</label><textarea name="proof" maxlength="2000" placeholder="Zum Beispiel Zertifikatsnummer oder Teilnahmebestätigung"></textarea>
        <p class="muted">Dateien lädst du hier nicht hoch. Bei manchen Pflichtkursen bestätigt deine Führungskraft oder HR den Abschluss.</p>`,
      onSubmit: async data => {
        const result = await post(`/api/learning/assignments/${encodeURIComponent(assignmentId)}/complete`, data);
        ui.toast(result.confirmationPending ? 'Gemeldet. Der Abschluss wartet jetzt auf die Bestätigung.' : 'Abschluss gespeichert.');
        reload();
      }
    });
  }

  function openRejectForm(assignmentId) {
    ui.modal({
      title: 'Abschluss nicht bestätigen',
      submitLabel: 'Nicht bestätigen',
      body: '<label>Warum nicht? Die Person sieht diesen Text.</label><textarea name="comment" required maxlength="2000"></textarea>',
      onSubmit: async data => {
        await post(`/api/learning/assignments/${encodeURIComponent(assignmentId)}/confirm`, { approved: false, comment: data.comment });
        ui.toast('Die Person kann den Abschluss erneut melden.');
        reload();
      }
    });
  }

  async function runAction(action, message) {
    try {
      await action();
      if (message) ui.toast(message);
      reload();
    } catch (error) {
      ui.toast(error.message, 'error');
    }
  }

  const showErrors = action => async () => {
    try {
      await action();
    } catch (error) {
      ui.toast(error.message, 'error');
    }
  };

  async function openOverdueTask(assignmentId) {
    const mine = await api('/api/learning/my');
    const isMine = [...mine.open, ...mine.overdue, ...mine.completed].some(item => item.id === assignmentId);
    window.loop.navigate(isMine ? 'learningHome' : 'learningTeam');
  }

  function bind() {
    document.querySelectorAll('[data-learning-start]').forEach(button => {
      button.onclick = () => runAction(() => post(`/api/learning/assignments/${encodeURIComponent(button.dataset.learningStart)}/start`), 'Viel Erfolg beim Lernen.');
    });
    document.querySelectorAll('[data-learning-enroll]').forEach(button => {
      button.onclick = () => runAction(() => post(`/api/learning/courses/${encodeURIComponent(button.dataset.learningEnroll)}/enroll`), 'Du bist eingetragen.');
    });
    document.querySelectorAll('[data-learning-complete]').forEach(button => {
      button.onclick = () => openCompleteForm(button.dataset.learningComplete, button.dataset.learningTitle);
    });
    document.querySelectorAll('[data-learning-confirm]').forEach(button => {
      button.onclick = () => runAction(() => post(`/api/learning/assignments/${encodeURIComponent(button.dataset.learningConfirm)}/confirm`, { approved: true }), 'Abschluss bestätigt.');
    });
    document.querySelectorAll('[data-learning-reject]').forEach(button => {
      button.onclick = () => openRejectForm(button.dataset.learningReject);
    });
    document.querySelectorAll('[data-learning-assign]').forEach(button => {
      button.onclick = showErrors(() => openAssignForm(Number(button.dataset.learningAssign) || null));
    });
    document.querySelectorAll('[data-learning-new-course]').forEach(button => {
      button.onclick = showErrors(() => openCourseForm(null));
    });
    document.querySelectorAll('[data-learning-edit-course]').forEach(button => {
      button.onclick = showErrors(() => openCourseForm(Number(button.dataset.learningEditCourse)));
    });
    document.querySelectorAll('[data-learning-overdue]').forEach(button => {
      button.onclick = showErrors(() => openOverdueTask(Number(button.dataset.learningOverdue)));
    });
  }

  window.loop.registerModule({
    key: 'learning',
    label: 'Lernen',
    nav() {
      return [{ route: 'learningHome', label: 'Lernen', group: 'growth', views: VIEWS }];
    },
    pages: { learningHome: homePage, learningTeam: teamPage, learningCourses: coursesPage, learningReport: reportPage },
    allowed(view, me) {
      if (['learningCourses', 'learningReport'].includes(view)) return isHr(me);
      return view !== 'learningTeam' || isHr(me) || isLeader(me);
    },
    tabs(view, me) {
      if (!VIEWS.includes(view)) return [];
      const tabs = [{ route: 'learningHome', label: 'Meine Kurse', active: view === 'learningHome' }];
      if (isHr(me) || isLeader(me)) tabs.push({ route: 'learningTeam', label: isHr(me) ? 'Alle Personen' : 'Mein Team', active: view === 'learningTeam' });
      if (isHr(me)) {
        tabs.push({ route: 'learningCourses', label: 'Kurse', active: view === 'learningCourses' });
        tabs.push({ route: 'learningReport', label: 'Erfüllung', active: view === 'learningReport' });
      }
      return tabs.length > 1 ? tabs : [];
    },
    bind,
    taskAction(task) {
      if (task.type === 'learning_assignment') return '<button class="btn primary" data-view="learningHome">Öffnen</button>';
      if (task.type === 'learning_confirmation') return '<button class="btn primary" data-view="learningTeam">Prüfen</button>';
      if (task.type === 'learning_overdue') return `<button class="btn primary" data-learning-overdue="${esc(task.entity_id)}">Ansehen</button>`;
      return '';
    }
  });
})();
