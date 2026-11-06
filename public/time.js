// Zeiterfassung: eigene Zeiten mit Kommen/Gehen, eingereichte Wochen im Team, HR-Verwaltung.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const VIEWS = ['timeHome', 'timeTeam', 'timeHr', 'timeHrPerson'];
  const HR_ROLES = ['hr_admin', 'hrbp', 'hr_staff', 'super_admin'];
  // Die Sachbearbeitung ändert die übliche Wochenstundenzahl nicht und entscheidet keine Wochen.
  const FULL_HR_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const TEAM_TAB_ROLES = ['manager', 'director', 'hr_staff', 'hr_admin', 'hrbp', 'super_admin'];
  const TEAM_STATUS_FILTERS = [['submitted', 'Eingereicht'], ['approved', 'Genehmigt'], ['returned', 'Zurückgegeben'], ['all', 'Alle']];
  const HOUR_SOURCE_LABELS = { personnel: 'aus der Personalakte', person: 'eigene Angabe', default: 'Voreinstellung' };

  // Zustand der geöffneten Seite. Er lebt nur im Browser der angemeldeten Person.
  const state = {
    weekStart: null,
    teamStatus: 'submitted',
    hrSection: 'people',
    hrPersonId: null,
    hrWeekStart: null,
    jumpToPersonRow: null,
    showLeft: false,
    searches: {},
    week: null,
    hrWeek: null,
    people: []
  };

  const send = (url, method, body = {}) => api(url, { method, body: JSON.stringify(body) });
  const refresh = () => window.loop.navigate(window.loop.view);
  const isHrPerson = person => HR_ROLES.includes(person.role);
  const isFullHr = person => FULL_HR_ROLES.includes(person.role);

  // ------------------------------------------------------------------
  // Darstellung
  // ------------------------------------------------------------------

  function todayInGermany() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  const formatDate = isoDate => (isoDate ? isoDate.split('-').reverse().join('.') : '–');
  const shortDate = isoDate => `${isoDate.split('-').reverse().slice(0, 2).join('.')}.`;
  const surnameFirst = name => {
    const text = String(name).trim();
    // „Müller, Anna“ steht schon richtig. Nur ohne Komma ist das letzte Wort der Nachname.
    if (text.includes(',')) return text;
    const parts = text.split(/\s+/);
    if (parts.length < 2) return text;
    const surname = parts.pop();
    return `${surname}, ${parts.join(' ')}`;
  };

  /** Heißen zwei Personen gleich, unterscheidet sie erst die E-Mail. */
  function duplicateNames(items, nameOf) {
    const seen = new Map();
    for (const item of items) {
      const key = surnameFirst(nameOf(item)).toLocaleLowerCase('de');
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    return item => (seen.get(surnameFirst(nameOf(item)).toLocaleLowerCase('de')) || 0) > 1;
  }

  function addDays(isoDate, days) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  function formatMinutes(total) {
    const absolute = Math.abs(total);
    return `${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, '0')}`;
  }

  function formatBalance(total) {
    if (total === 0) return '0:00';
    return `${total > 0 ? '+' : '−'}${formatMinutes(total)}`;
  }

  const formatHours = hours => String(hours).replace('.', ',');

  /** Kalenderwoche nach ISO 8601: Die Woche mit dem ersten Donnerstag des Jahres ist Woche 1. */
  function isoWeekNumber(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
    const firstThursdayWeek = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    const dayDifference = (date - firstThursdayWeek) / 86400000;
    return 1 + Math.round((dayDifference - 3 + ((firstThursdayWeek.getUTCDay() + 6) % 7)) / 7);
  }

  const weekRange = week => `${shortDate(week.weekStart)} bis ${formatDate(week.weekEnd)}`;
  const weekTitle = week => `Kalenderwoche ${isoWeekNumber(week.weekStart)}: ${weekRange(week)}`;

  function statusTag(week) {
    const emphasized = ['submitted', 'returned'].includes(week.status) ? ' focus' : '';
    const label = String(week.statusLabel || '');
    return `<span class="tag${emphasized}">${esc(label.charAt(0).toLocaleUpperCase('de') + label.slice(1))}</span>`;
  }

  function hintsCard(hints) {
    if (!hints.length) return '';
    return `<div class="time-hints" role="note">
      <h3>Hinweise</h3>
      <ul>${hints.map(item => `<li>${esc(item.message)}</li>`).join('')}</ul>
    </div>`;
  }

  function dayNote(day) {
    const notes = [];
    if (day.holidayName) notes.push(day.holidayName);
    if (day.absentShare === 1) notes.push('abwesend');
    else if (day.absentShare > 0) notes.push('halber Tag abwesend');
    return notes.length ? `<small class="muted time-note">${esc(notes.join(' · '))}</small>` : '';
  }

  const entryLabel = entry => `${formatDate(entry.date)}, ${entry.startTime} bis ${entry.endTime || 'offen'}`;

  function entryActions(entry, week) {
    if (!week.canEdit) return '';
    return `<div class="time-actions">
      <button type="button" class="btn" data-time-edit="${esc(entry.id)}">Ändern</button>
      <button type="button" class="btn" data-time-delete="${esc(entry.id)}">Löschen</button>
    </div>`;
  }

  function entryTags(entry) {
    const tags = [];
    if (entry.enteredByOther) tags.push('<span class="tag">von HR eingetragen</span>');
    if (entry.changed) tags.push('<span class="tag">geändert</span>');
    return tags.join(' ');
  }

  function dayRows(day, week) {
    const dayCell = `<div><b>${esc(day.weekday)}</b><small class="time-note">${esc(formatDate(day.date))}</small>${dayNote(day)}</div>`;
    const freeClass = day.targetMinutes ? '' : 'time-free';
    if (!day.entries.length) {
      return `<tr class="${freeClass} time-day-empty"><td data-label="Tag">${dayCell}</td><td colspan="4" class="muted time-no-entry">–</td><td data-label="Soll">${esc(formatMinutes(day.targetMinutes))}</td><td></td></tr>`;
    }
    return day.entries.map((entry, index) => `<tr class="${freeClass}">
      <td data-label="Tag">${index === 0 ? dayCell : `<small class="muted">${esc(formatDate(day.date))}</small>`}</td>
      <td data-label="Zeit"><div>${esc(entry.startTime)} bis ${entry.running ? '<span class="tag focus">läuft</span>' : esc(entry.endTime)}</div></td>
      <td data-label="Pause">${esc(entry.breakMinutes)} Min.</td>
      <td data-label="Stunden"><div>${entry.running ? '–' : esc(formatMinutes(entry.netMinutes))} ${entryTags(entry)}</div></td>
      <td data-label="Notiz">${entry.note ? `<small class="muted">${esc(entry.note)}</small>` : ''}</td>
      <td data-label="Soll">${index === 0 ? esc(formatMinutes(day.targetMinutes)) : ''}</td>
      <td class="time-card-actions">${entryActions(entry, week)}</td>
    </tr>`).join('');
  }

  function weekTable(week) {
    return `<div class="tableWrap"><table class="table time-table time-cards">
      <thead><tr><th>Tag</th><th>Zeit</th><th>Pause</th><th>Stunden</th><th>Notiz</th><th>Soll</th><th></th></tr></thead>
      <tbody>${week.days.map(day => dayRows(day, week)).join('')}</tbody>
    </table></div>`;
  }

  function weekNotices(week) {
    const notices = [];
    if (week.status === 'returned' && week.decisionComment) notices.push(`Zurückgegeben: ${week.decisionComment}`);
    if (week.status === 'open' && week.reopenReason) notices.push(`Von HR wieder geöffnet: ${week.reopenReason}`);
    if (week.status === 'approved' && week.decisionComment) notices.push(`Kommentar: ${week.decisionComment}`);
    return notices.map(text => `<p class="time-notice">${esc(text)}</p>`).join('');
  }

  function weekStats(week, showTotal) {
    return `<section class="cards time-stats">
      ${ui.stat('Soll der Woche', formatMinutes(week.targetMinutes), `vorgesehen bei ${formatHours(week.weeklyHours)} Stunden pro Woche`)}
      ${ui.stat('Soll bis heute', formatMinutes(week.dueMinutes), week.counted ? 'davon bisher fällig' : 'Woche ohne Einträge zählt nicht')}
      ${ui.stat('Ist', formatMinutes(week.actualMinutes), 'erfasste Arbeitszeit')}
      ${ui.stat('Saldo der Woche', formatBalance(week.balanceMinutes), 'Ist minus Soll bis heute')}
      ${showTotal ? ui.stat('Gesamtsaldo', formatBalance(week.totalBalanceMinutes), 'alle Wochen mit Einträgen zusammen') : ''}
    </section>
    <p class="muted time-explain">Soll ist die vorgesehene Arbeitszeit, Ist die erfasste. Der Saldo ist der Unterschied: Plus heißt Überstunden, Minus heißt Fehlstunden.</p>`;
  }

  function weekSwitch(week, attribute) {
    return `<div class="time-switch">
      <button type="button" class="btn" ${attribute}="${esc(addDays(week.weekStart, -7))}" aria-label="Woche davor">‹</button>
      <b>${esc(weekTitle(week))}</b>
      <button type="button" class="btn" ${attribute}="${esc(addDays(week.weekStart, 7))}" aria-label="Woche danach">›</button>
    </div>`;
  }

  /** Wer über die Woche entscheidet, oder wer es getan hat. */
  function deciderNote(week) {
    if (week.status === 'approved' && week.decidedByName) return `Genehmigt von ${week.decidedByName}`;
    if (week.status === 'returned' && week.decidedByName) return `Zurückgegeben von ${week.decidedByName}`;
    if (!['open', 'returned', 'submitted'].includes(week.status)) return '';
    if (week.decider?.kind === 'none') return 'Gilt nach dem Einreichen sofort';
    if (week.decider?.kind === 'nobody') return 'Gerade kann niemand darüber entscheiden';
    return week.decider?.name ? `Entscheidet: ${week.decider.name}` : '';
  }

  // ------------------------------------------------------------------
  // Suche in langen Listen
  // ------------------------------------------------------------------

  const stripMarks = text => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss');

  /** Ayşe findet sich unter „ayse“, Köhler unter „kohler“ und „koehler“. */
  function searchForms(text) {
    const lower = String(text ?? '').toLocaleLowerCase('de');
    const spelledOut = lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    return [stripMarks(lower), stripMarks(spelledOut)];
  }

  /** Jedes Wort muss vorkommen, Reihenfolge und Komma sind egal: „Schäfer, Anna“ findet „Anna Schäfer“. */
  function matchesSearch(haystack, query) {
    const words = searchForms(query)[0].replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const forms = searchForms(haystack);
    return words.every(word => forms.some(form => form.includes(word)));
  }

  const searchText = item => [item.userName || item.name, item.userEmail || item.email, item.personnelNumber].filter(Boolean).join(' ');

  function listSearch(listKey, placeholder) {
    return `<div class="time-search">
      <input type="search" data-time-search="${esc(listKey)}" value="${esc(state.searches[listKey] || '')}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
      <small class="muted" data-time-search-count="${esc(listKey)}" role="status"></small>
    </div>`;
  }

  /** Blendet Zeilen nur aus, statt neu zu zeichnen: So behält das Suchfeld beim Tippen den Fokus. */
  function applyListFilter(listKey) {
    const rows = document.querySelectorAll(`[data-time-row="${listKey}"]`);
    const query = state.searches[listKey] || '';
    let visible = 0;
    rows.forEach(row => {
      const show = (row.dataset.left !== '1' || state.showLeft) && matchesSearch(row.dataset.search, query);
      row.hidden = !show;
      if (show) visible += 1;
    });
    const count = document.querySelector(`[data-time-search-count="${listKey}"]`);
    if (count) count.textContent = query.trim() ? `${visible} von ${rows.length} gefunden` : '';
    const empty = document.querySelector(`[data-time-search-empty="${listKey}"]`);
    if (empty) empty.hidden = visible > 0 || rows.length === 0;
  }

  // ------------------------------------------------------------------
  // Meine Zeiten
  // ------------------------------------------------------------------

  function blockedClockCard(clock) {
    if (clock.reason === 'week_locked') {
      const action = clock.canWithdraw
        ? `<button type="button" class="btn primary" data-time-withdraw="${esc(clock.weekId)}">Woche zurückziehen</button>`
        : '';
      const hint = clock.canWithdraw
        ? 'Ziehst du sie zurück, kannst du wieder stempeln.'
        : 'Musst du noch etwas ändern, kann HR sie wieder öffnen.';
      return `<article class="card time-clock time-clock-blocked">
        <div><b>Stempeln geht gerade nicht.</b><small class="muted time-note">Diese Woche (ab ${esc(formatDate(clock.weekStart))}) ist ${esc(clock.statusLabel)}. ${esc(hint)}</small></div>
        ${action}
      </article>`;
    }
    return `<article class="card time-clock time-clock-blocked">
      <div><b>Für heute ist bei dir eine Abwesenheit eingetragen.</b><small class="muted time-note">Deshalb gibt es hier kein „Kommen“. Arbeitest du doch, nimm sie zuerst zurück oder wende dich an HR.</small></div>
      <button type="button" class="btn" data-view="absenceHome">Zur Abwesenheit</button>
    </article>`;
  }

  function clockCard(week) {
    const running = week.running;
    if (!running) {
      if (week.clock && !week.clock.canClockIn) return blockedClockCard(week.clock);
      return `<article class="card time-clock">
        <div><b>Du bist gerade nicht eingestempelt.</b></div>
        <button type="button" class="btn primary" data-time-clock-in>Kommen</button>
      </article>`;
    }
    const isOlder = running.date !== todayInGermany();
    const since = isOlder ? `dem ${formatDate(running.date)} um ${running.startTime}` : `heute um ${running.startTime}`;
    const jump = running.date < week.weekStart || running.date > week.weekEnd
      ? `<button type="button" class="btn" data-time-week="${esc(running.date)}">Zum Eintrag</button>`
      : '';
    return `<article class="card time-clock time-clock-running">
      <div><b>Eingestempelt seit ${esc(since)}.</b>${isOlder ? '<small class="muted time-note">Hast du das Gehen vergessen? Trage das Ende sonst im Eintrag von Hand ein.</small>' : ''}</div>
      <div class="time-actions">${jump}<button type="button" class="btn primary" data-time-clock-out>Gehen</button></div>
    </article>`;
  }

  async function homePage() {
    const query = state.weekStart ? `?week=${encodeURIComponent(state.weekStart)}` : '';
    const { week } = await api(`/api/time/week${query}`);
    state.week = week;
    const actions = week.canEdit ? '<button type="button" class="btn" data-time-new>+ Eintrag</button>' : '';
    const submit = week.canSubmit ? '<button type="button" class="btn primary" data-time-submit>Woche einreichen</button>' : '';
    const withdraw = week.canWithdraw ? `<button type="button" class="btn" data-time-withdraw="${esc(week.id)}">Zurückziehen</button>` : '';
    const decider = deciderNote(week);
    return `${ui.header('Zeiterfassung', 'Deine Arbeitszeiten, Woche für Woche.', actions)}
      ${clockCard(week)}
      ${weekStats(week, true)}
      <article class="card time-section">
        <div class="sectionHead">
          ${weekSwitch(week, 'data-time-week')}
          <div class="time-actions">
            ${statusTag(week)}
            <button type="button" class="btn" data-time-history>Verlauf</button>
            ${withdraw}
            ${submit}
          </div>
        </div>
        ${decider ? `<p class="muted time-decider">${esc(decider)}</p>` : ''}
        ${weekNotices(week)}
        ${hintsCard(week.hints)}
        ${weekTable(week)}
      </article>`;
  }

  /** Viele tippen 17.30 oder 1730. Das Feld zeigt danach, was gemeint war; der Server versteht es auch so. */
  function normalizeTimeInput(input) {
    const match = input.value.trim().match(/^(\d{1,2})(?:[:.,]?(\d{2}))?$/);
    if (match) input.value = `${match[1].padStart(2, '0')}:${match[2] ?? '00'}`;
  }

  function bindTimeInputs() {
    document.querySelectorAll('#uiModalForm [data-time-input]').forEach(input => {
      input.onblur = () => normalizeTimeInput(input);
    });
  }

  function timeInput(name, label, value, required, placeholder) {
    return `<div><label>${esc(label)}</label><input name="${esc(name)}" data-time-input inputmode="decimal" autocomplete="off" ${required ? 'required' : ''} placeholder="${esc(placeholder)}" value="${esc(value || '')}"></div>`;
  }

  function entryFormFields(entry, defaultDate, isOwn) {
    const isRunning = entry?.running;
    const reason = isOwn ? '' : `<label>Grund der Korrektur (Pflicht)</label><textarea name="reason" maxlength="500" required></textarea>
      <p class="muted">Die Person bekommt dazu einen Hinweis. Der Grund steht im Verlauf der Woche.</p>`;
    return `<label>Datum</label><input name="date" type="date" required value="${esc(entry?.date || defaultDate)}">
      <div class="two">
        ${timeInput('startTime', 'Beginn', entry?.startTime, true, '08:30')}
        ${timeInput('endTime', 'Ende', entry?.endTime, !isRunning, '17:30')}
      </div>
      <p class="muted">Schreib die Uhrzeit, wie du magst: 17:30, 17.30 oder 1730.</p>
      <label>Pause in Minuten</label><input name="breakMinutes" type="number" min="0" max="720" step="1" value="${esc(entry?.breakMinutes ?? 0)}">
      <label>Notiz (optional)</label><input name="note" maxlength="500" value="${esc(entry?.note || '')}">
      ${reason}
      <p class="muted">Arbeit über Mitternacht trägst du als zwei Einträge ein: bis 24:00 und ab 00:00.</p>`;
  }

  function reportHints(hints) {
    if (hints?.length) ui.toast('Gespeichert. Bitte beachte die Hinweise in der Wochenansicht.');
    else ui.toast('Gespeichert.');
  }

  function entryModal(week, entry = null) {
    const today = todayInGermany();
    const defaultDate = today >= week.weekStart && today <= week.weekEnd ? today : week.weekStart;
    const isOwn = week.person.id === window.loop.me.id;
    ui.modal({
      title: entry ? 'Eintrag ändern' : 'Eintrag ergänzen',
      subtitle: isOwn ? '' : week.person.name,
      body: entryFormFields(entry, defaultDate, isOwn),
      onSubmit: async data => {
        const body = { ...data };
        if (entry?.running && !data.endTime) delete body.endTime;
        const result = entry
          ? await send(`/api/time/entries/${encodeURIComponent(entry.id)}`, 'PATCH', body)
          : await send('/api/time/entries', 'POST', isOwn ? body : { ...body, userId: week.person.id });
        reportHints(result.hints);
        refresh();
      }
    });
    bindTimeInputs();
  }

  function findEntry(week, id) {
    for (const day of week.days) {
      const entry = day.entries.find(item => item.id === id);
      if (entry) return entry;
    }
    return null;
  }

  /** Eigene Einträge löscht die Person nach kurzer Rückfrage. Bei fremden gehört der Grund dazu. */
  async function deleteEntry(week, entry) {
    const label = entryLabel(entry);
    if (week.person.id === window.loop.me.id) {
      if (!confirm(`Eintrag vom ${label} löschen? Im Verlauf bleibt er nachvollziehbar.`)) return;
      await api(`/api/time/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      ui.toast('Eintrag gelöscht.');
      refresh();
      return;
    }
    ui.modal({
      title: 'Eintrag löschen',
      subtitle: `${week.person.name}: ${label}`,
      submitLabel: 'Löschen',
      body: `<label>Grund der Korrektur (Pflicht)</label><textarea name="reason" maxlength="500" required></textarea>
        <p class="muted">Die Person bekommt dazu einen Hinweis. Im Verlauf der Woche bleibt der Eintrag nachvollziehbar.</p>`,
      onSubmit: async data => {
        await api(`/api/time/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE', body: JSON.stringify(data) });
        ui.toast('Eintrag gelöscht.');
        refresh();
      }
    });
  }

  function historyValues(values) {
    if (!values) return 'gelöscht';
    const end = values.endTime || 'offen';
    return `${formatDate(values.date)}, ${values.startTime} bis ${end}, ${values.breakMinutes} Min. Pause${values.note ? `, ${values.note}` : ''}`;
  }

  async function historyModal(week) {
    const query = `?week=${encodeURIComponent(week.weekStart)}&userId=${encodeURIComponent(week.person.id)}`;
    const { history } = await api(`/api/time/history${query}`);
    const labels = { create: 'Eingetragen', update: 'Geändert', delete: 'Gelöscht', clock_out: 'Gehen erfasst' };
    const rows = history.map(row => `<div class="row">
      <div class="grow">
        <b>${esc(labels[row.action] || 'Bearbeitet')} von ${esc(row.changedByName)}</b>
        <small class="muted time-note">${esc(new Date(row.changedAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }))}</small>
        ${row.reason ? `<small class="time-note"><b>Grund:</b> ${esc(row.reason)}</small>` : ''}
        ${row.before ? `<small class="time-note">Vorher: ${esc(historyValues(row.before))}</small>` : ''}
        ${row.after ? `<small class="time-note">Nachher: ${esc(historyValues(row.after))}</small>` : ''}
      </div>
    </div>`).join('');
    ui.modal({
      title: 'Verlauf der Woche',
      subtitle: weekTitle(week),
      body: rows || ui.empty('In dieser Woche wurde bisher nichts geändert oder gelöscht.')
    });
  }

  function clockOutModal() {
    ui.modal({
      title: 'Gehen',
      subtitle: 'Wie lange war deine Pause?',
      submitLabel: 'Gehen',
      body: '<label>Pause in Minuten</label><input name="breakMinutes" type="number" min="0" max="720" step="1" value="0" required>',
      onSubmit: async data => {
        const result = await send('/api/time/clock/out', 'POST', data);
        reportHints(result.hints);
        refresh();
      }
    });
  }

  async function submitWeek(week) {
    const result = await send('/api/time/weeks/submit', 'POST', { week: week.weekStart });
    if (result.warning) ui.toast(result.warning, 'error');
    else ui.toast(result.status === 'approved' ? 'Woche eingereicht. Sie gilt bei euch sofort.' : 'Woche eingereicht.');
    refresh();
  }

  /** Einreichen sperrt die Woche. Das sollte niemanden mitten in der Woche überraschen. */
  function submitWarningModal(week) {
    const afterwards = week.decider?.kind === 'none'
      ? 'Bei euch gilt sie dann sofort. Du kannst sie danach zurückziehen.'
      : 'Bis zur Entscheidung kannst du sie zurückziehen.';
    ui.modal({
      title: 'Woche schon einreichen?',
      subtitle: weekTitle(week),
      submitLabel: 'Trotzdem einreichen',
      body: `<p>Diese Woche läuft noch bis ${esc(formatDate(week.weekEnd))}. Nach dem Einreichen ist sie gesperrt: Du kannst nicht mehr stempeln und keine Einträge ändern.</p>
        <p class="muted">${esc(afterwards)}</p>`,
      onSubmit: () => submitWeek(week)
    });
  }

  // ------------------------------------------------------------------
  // Team
  // ------------------------------------------------------------------

  function teamPersonNote(week, asHr) {
    const notes = [];
    if (!asHr) notes.push(week.direct ? 'direkt unterstellt' : `indirekt unterstellt, über ${week.managerName || 'eine andere Führungskraft'}`);
    if (week.status === 'submitted' && !week.canDecide && week.deciderName) notes.push(`entscheidet: ${week.deciderName}`);
    return notes.length ? `<small class="muted time-note">${esc(notes.join(', '))}</small>` : '';
  }

  function teamRow(week, asHr) {
    return `<tr data-time-row="weeks" data-search="${esc(searchText(week))}">
      <td data-label="Person"><div><b>${esc(asHr ? surnameFirst(week.userName) : week.userName)}</b>${teamPersonNote(week, asHr)}</div></td>
      <td data-label="Woche"><div>Kalenderwoche ${esc(isoWeekNumber(week.weekStart))}<small class="muted time-note">${esc(weekRange(week))}</small></div></td>
      <td data-label="Soll">${esc(formatMinutes(week.targetMinutes))}</td>
      <td data-label="Soll bis heute">${esc(formatMinutes(week.dueMinutes))}</td>
      <td data-label="Ist">${esc(formatMinutes(week.actualMinutes))}</td>
      <td data-label="Saldo">${esc(formatBalance(week.balanceMinutes))}</td>
      <td data-label="Status">${statusTag(week)}</td>
      <td class="time-card-actions"><button type="button" class="btn" data-time-review="${esc(week.userId)}" data-time-review-week="${esc(week.weekStart)}">Öffnen</button></td>
    </tr>`;
  }

  function teamRuleNote(rule, asHr) {
    if (rule === 'none') return 'Eingereichte Wochen gelten bei euch sofort. Offene von früher lassen sich hier noch entscheiden.';
    if (rule === 'hr' && !asHr) return 'Wochen entscheidet bei euch HR. Du siehst sie hier, und entscheiden kannst du nur, was du noch von früher hast.';
    return '';
  }

  async function teamPage() {
    const me = window.loop.me;
    const asHr = isHrPerson(me);
    const scope = asHr ? 'all' : 'team';
    const { weeks, rule, truncated, limit } = await api(`/api/time/weeks?scope=${scope}&status=${encodeURIComponent(state.teamStatus)}`);
    const options = TEAM_STATUS_FILTERS
      .map(([value, label]) => `<option value="${esc(value)}" ${state.teamStatus === value ? 'selected' : ''}>${esc(label)}</option>`)
      .join('');
    const rows = weeks.map(week => teamRow(week, asHr)).join('');
    const subtitle = asHr
      ? 'Eingereichte Wochen. Soll ist die vorgesehene Zeit, Ist die erfasste, Saldo der Unterschied bis heute.'
      : 'Eingereichte Wochen der Personen, die du direkt oder über andere führst. Noch nicht Eingereichtes bleibt bei der Person.';
    const ruleNote = teamRuleNote(rule, isFullHr(me));
    return `${ui.header('Zeiten im Team', subtitle)}
      <article class="card time-section">
        <div class="sectionHead">
          <h2>Wochen</h2>
          <select id="timeTeamStatus" class="time-select" aria-label="Nach Status filtern">${options}</select>
        </div>
        ${ruleNote ? `<p class="muted">${esc(ruleNote)}</p>` : ''}
        ${asHr && rows ? listSearch('weeks', 'Name, E-Mail oder Personalnummer') : ''}
        ${truncated ? `<p class="time-notice">Es werden die neuesten ${esc(limit)} Wochen gezeigt. Wähle einen Status, um die Liste einzugrenzen.</p>` : ''}
        ${rows
          ? `<div class="tableWrap"><table class="table time-cards"><thead><tr><th>Person</th><th>Woche</th><th>Soll</th><th>Soll bis heute</th><th>Ist</th><th>Saldo</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : ui.empty('Hier liegt gerade nichts.')}
        <p class="muted time-empty-search" data-time-search-empty="weeks" hidden>Niemanden gefunden.</p>
      </article>`;
  }

  async function reviewModal(userId, weekStart) {
    const { week } = await api(`/api/time/week?week=${encodeURIComponent(weekStart)}&userId=${encodeURIComponent(userId)}`);
    const summary = `<p class="muted">Soll der Woche ${esc(formatMinutes(week.targetMinutes))} · Soll bis heute ${esc(formatMinutes(week.dueMinutes))} · Ist ${esc(formatMinutes(week.actualMinutes))} · Saldo ${esc(formatBalance(week.balanceMinutes))} · ${statusTag(week)}</p>`;
    const body = `${summary}${weekNotices(week)}${hintsCard(week.hints)}${weekTable({ ...week, canEdit: false })}`;
    if (week.canDecide) {
      ui.modal({
        title: week.person.name,
        subtitle: weekTitle(week),
        submitLabel: 'Entscheidung speichern',
        body: `${body}
          <label>Entscheidung</label>
          <select name="decision"><option value="approve">Genehmigen</option><option value="return">Zurückgeben</option></select>
          <label>Kommentar (beim Zurückgeben nötig)</label><textarea name="comment" maxlength="1000"></textarea>`,
        onSubmit: async data => {
          await send(`/api/time/weeks/${encodeURIComponent(week.id)}/decision`, 'POST', data);
          ui.toast(data.decision === 'approve' ? 'Woche genehmigt.' : 'Woche zurückgegeben.');
          refresh();
        }
      });
    } else if (week.canReopen) {
      ui.modal({
        title: week.person.name,
        subtitle: weekTitle(week),
        submitLabel: 'Woche wieder öffnen',
        body: `${body}
          <label>Begründung für das Wiederöffnen</label><textarea name="reason" maxlength="1000" required></textarea>`,
        onSubmit: async data => {
          await send(`/api/time/weeks/${encodeURIComponent(week.id)}/reopen`, 'POST', data);
          ui.toast('Woche wieder geöffnet.');
          refresh();
        }
      });
    } else {
      const decider = deciderNote(week);
      ui.modal({ title: week.person.name, subtitle: weekTitle(week), body: `${decider ? `<p class="muted">${esc(decider)}</p>` : ''}${body}` });
    }
    document.querySelector('#uiModalForm')?.classList.add('time-review');
  }

  // ------------------------------------------------------------------
  // HR
  // ------------------------------------------------------------------

  function personRow(person, isDuplicate) {
    const left = !person.active;
    const email = isDuplicate(person) && person.email ? `<small class="muted time-note">${esc(person.email)}</small>` : '';
    const leftNote = left ? `<small class="muted time-note">${person.exitDate ? `letzter Arbeitstag ${esc(formatDate(person.exitDate))}` : 'Konto gesperrt'}</small>` : '';
    const isOpen = person.id === state.hrPersonId;
    const classes = [left ? 'rowInactive' : '', isOpen ? 'time-row-open' : ''].filter(Boolean).join(' ');
    return `<tr data-time-row="people" data-time-person-row="${esc(person.id)}" data-search="${esc(searchText(person))}" data-left="${left ? '1' : '0'}"${classes ? ` class="${classes}"` : ''}>
      <td data-label="Person"><div><b>${esc(surnameFirst(person.name))}</b>${email}${leftNote}</div></td>
      <td data-label="Wochenstunden"><div>${esc(formatHours(person.weeklyHours))} Std. <small class="muted">${esc(HOUR_SOURCE_LABELS[person.hoursSource] || '')}</small></div></td>
      <td data-label="Gesamtsaldo">${esc(formatBalance(person.totalBalanceMinutes))}</td>
      <td class="time-actions time-card-actions">
        <button type="button" class="btn" data-time-hr-person="${esc(person.id)}">Zeiten</button>
        ${person.canSetHours ? `<button type="button" class="btn" data-time-hours="${esc(person.id)}">Wochenstunden</button>` : ''}
      </td>
    </tr>`;
  }

  function peopleCard(people) {
    const isDuplicate = duplicateNames(people, person => person.name);
    const anyLeft = people.some(person => !person.active);
    const leftToggle = anyLeft
      ? `<label class="checkRow time-left-toggle"><input type="checkbox" id="timeShowLeft" ${state.showLeft ? 'checked' : ''}> Auch ausgetretene und gesperrte Personen zeigen</label>`
      : '';
    return `<article class="card time-section">
      <h2>Personen</h2>
      <p class="muted">Nach Nachname sortiert, ohne Bewertung. Der Gesamtsaldo ist der Unterschied zwischen erfasster und vorgesehener Zeit, nur aus Wochen mit Einträgen.</p>
      ${listSearch('people', 'Name, E-Mail oder Personalnummer')}
      ${leftToggle}
      <div class="tableWrap"><table class="table time-cards"><thead><tr><th>Person</th><th>Wochenstunden</th><th>Gesamtsaldo</th><th></th></tr></thead><tbody>${people.map(person => personRow(person, isDuplicate)).join('')}</tbody></table></div>
      <p class="muted time-empty-search" data-time-search-empty="people" hidden>Niemanden gefunden.</p>
    </article>`;
  }

  function hrWeekCard(week) {
    const actions = [];
    if (week.canEdit) actions.push('<button type="button" class="btn" data-time-hr-new>+ Eintrag</button>');
    actions.push('<button type="button" class="btn" data-time-hr-history>Verlauf</button>');
    if (week.canDecide || week.canReopen) {
      actions.push(`<button type="button" class="btn primary" data-time-review="${esc(week.person.id)}" data-time-review-week="${esc(week.weekStart)}">${week.canDecide ? 'Entscheiden' : 'Wieder öffnen'}</button>`);
    }
    const decider = deciderNote(week);
    return `<article class="card time-section time-person-card">
      <div class="sectionHead">
        ${weekSwitch(week, 'data-time-hr-week')}
        <div class="time-actions">${statusTag(week)}${actions.join('')}</div>
      </div>
      ${decider ? `<p class="muted time-decider">${esc(decider)}</p>` : ''}
      ${weekStats(week, true)}
      ${weekNotices(week)}
      ${hintsCard(week.hints)}
      ${weekTable(week)}
    </article>`;
  }

  function settingsCard(settings) {
    return `<article class="card time-section">
      <h2>Übliche Wochenstunden</h2>
      <p class="muted">Gilt von Montag bis Freitag für alle ohne eigene Angabe.${settings.personnelActive ? ' Steht in der Personalakte eine Wochenstundenzahl, hat diese Vorrang.' : ''}</p>
      <form id="timeSettingsForm" class="talent-form time-inline">
        <div class="error" id="timeSettingsError"></div>
        <input name="weeklyHours" type="number" min="0.25" max="80" step="0.25" required value="${esc(settings.weeklyHours)}" aria-label="Wochenstunden">
        <button class="btn primary">Speichern</button>
      </form>
    </article>`;
  }

  const exportScope = month => api(`/api/time/export/scope?month=${encodeURIComponent(month)}`);

  async function exportCard() {
    const [year, month] = todayInGermany().split('-').map(Number);
    const lastMonth = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
    const { note } = await exportScope(lastMonth);
    return `<article class="card time-section">
      <h2>Export für die Lohnabrechnung</h2>
      <p class="muted">Alle beendeten Einträge eines Monats mit Wochenstatus als CSV-Datei, die sich in Tabellenprogrammen öffnen lässt.</p>
      <p class="time-notice" id="timeExportNote"${note ? '' : ' hidden'}>${esc(note || '')}</p>
      <div class="time-actions">
        <input id="timeExportMonth" type="month" value="${esc(lastMonth)}" aria-label="Monat">
        <a class="btn" id="timeExportLink" href="/api/time/export?month=${esc(lastMonth)}" download>CSV herunterladen</a>
      </div>
    </article>`;
  }

  function hrSections(me) {
    const sections = [
      { key: 'people', label: 'Personen und Zeiten' },
      { key: 'export', label: 'Export' }
    ];
    if (isFullHr(me)) sections.push({ key: 'settings', label: 'Voreinstellung' });
    return sections;
  }

  function sectionTabs(sections, active) {
    return `<nav class="admin-tabs time-tabs" aria-label="Bereiche der HR-Verwaltung">
      ${sections.map(section => `<button type="button" data-time-section="${esc(section.key)}" class="${section.key === active ? 'active' : ''}" ${section.key === active ? 'aria-current="true"' : ''}>${esc(section.label)}</button>`).join('')}
    </nav>`;
  }

  async function hrPeopleSection() {
    const { people } = await api('/api/time/people');
    state.people = people;
    return peopleCard(people);
  }

  /** Eigene Seite mit der Nummer in der Adresse: Neuladen, Lesezeichen und Zurück bleiben bei der Person. */
  async function hrPersonPage() {
    if (!state.hrPersonId) {
      window.loop.navigate('timeHr');
      return '';
    }
    const weekQuery = state.hrWeekStart ? `&week=${encodeURIComponent(state.hrWeekStart)}` : '';
    let week;
    try {
      ({ week } = await api(`/api/time/week?userId=${encodeURIComponent(state.hrPersonId)}${weekQuery}`));
    } catch (error) {
      // Sonst führte jeder weitere Weg hierher in denselben Fehler.
      state.hrPersonId = null;
      throw error;
    }
    state.hrWeek = week;
    const back = '<button type="button" class="btn" data-time-hr-close>← Zur Liste</button>';
    return `${ui.header(`Zeiten von ${week.person.name}`, 'Einträge ansehen und mit einem Grund korrigieren.', back)}${hrWeekCard(week)}`;
  }

  async function hrPage() {
    const me = window.loop.me;
    const sections = hrSections(me);
    if (!sections.some(section => section.key === state.hrSection)) state.hrSection = sections[0].key;
    let content = '';
    if (state.hrSection === 'people') content = await hrPeopleSection();
    else if (state.hrSection === 'export') content = await exportCard();
    else content = settingsCard((await api('/api/time/settings')).settings);
    const subtitle = isFullHr(me) ? 'Wochenstunden, Korrekturen und der Monatsexport.' : 'Zeiten korrigieren und der Monatsexport.';
    return `${ui.header('Zeiterfassung verwalten', subtitle)}${sectionTabs(sections, state.hrSection)}${content}`;
  }

  function hoursModal(personId) {
    const person = state.people.find(item => item.id === personId);
    if (!person) return;
    const note = person.hoursSource === 'personnel'
      ? '<p class="muted">Für diese Person gilt die Angabe aus der Personalakte. Ein Wert hier wird erst genutzt, wenn dort keiner steht.</p>'
      : '';
    ui.modal({
      title: 'Wochenstunden festlegen',
      subtitle: person.name,
      body: `<label>Wochenstunden</label><input name="weeklyHours" type="number" min="0" max="80" step="0.25" value="${person.hoursSource === 'person' ? esc(person.weeklyHours) : ''}" placeholder="Voreinstellung">
        <p class="muted">Leer lassen, um die Voreinstellung zu nutzen. Genehmigte Wochen behalten ihre bisherige Zahl.</p>${note}
        <label>Grund der Änderung (Pflicht)</label><textarea name="reason" maxlength="500" required></textarea>
        <p class="muted">Die Person bekommt dazu einen Hinweis.</p>`,
      onSubmit: async data => {
        await send(`/api/time/people/${encodeURIComponent(personId)}/hours`, 'PUT', data);
        ui.toast('Wochenstunden gespeichert.');
        refresh();
      }
    });
  }

  // ------------------------------------------------------------------
  // Ereignisse
  // ------------------------------------------------------------------

  /** Führt eine Aktion aus und zeigt Fehler als Meldung, damit nichts still scheitert. */
  function guarded(action) {
    return async () => {
      try {
        await action();
      } catch (error) {
        ui.toast(error.message, 'error');
      }
    };
  }

  function bindAll(selector, attach) {
    document.querySelectorAll(selector).forEach(attach);
  }

  /** Die Wochenansicht gibt es für die eigene Person und für HR; Knöpfe wirken auf die jeweils geöffnete. */
  const activeWeek = () => (window.loop.view === 'timeHrPerson' ? state.hrWeek : state.week);

  /** Zurück in der langen Liste steht man wieder bei der Person. Erst danach, denn der Seitenwechsel scrollt nach oben. */
  function jumpAfterRender() {
    if (!state.jumpToPersonRow) return;
    const row = document.querySelector(`[data-time-person-row="${state.jumpToPersonRow}"]`);
    state.jumpToPersonRow = null;
    setTimeout(() => row?.scrollIntoView({ block: 'center' }), 0);
  }

  function bind() {
    bindAll('[data-time-clock-in]', button => {
      button.onclick = guarded(async () => {
        await send('/api/time/clock/in', 'POST');
        ui.toast('Eingestempelt.');
        refresh();
      });
    });
    bindAll('[data-time-clock-out]', button => { button.onclick = clockOutModal; });
    bindAll('[data-time-new]', button => { button.onclick = () => entryModal(state.week); });
    bindAll('[data-time-hr-new]', button => { button.onclick = () => entryModal(state.hrWeek); });
    bindAll('[data-time-week]', button => {
      button.onclick = () => {
        state.weekStart = button.dataset.timeWeek;
        refresh();
      };
    });
    bindAll('[data-time-hr-week]', button => {
      button.onclick = () => {
        state.hrWeekStart = button.dataset.timeHrWeek;
        refresh();
      };
    });
    bindAll('[data-time-section]', button => {
      button.onclick = () => {
        state.hrSection = button.dataset.timeSection;
        refresh();
      };
    });
    bindAll('[data-time-edit]', button => {
      button.onclick = () => {
        const week = activeWeek();
        const entry = findEntry(week, Number(button.dataset.timeEdit));
        if (entry) entryModal(week, entry);
      };
    });
    bindAll('[data-time-delete]', button => {
      button.onclick = guarded(async () => {
        const week = activeWeek();
        const entry = findEntry(week, Number(button.dataset.timeDelete));
        if (entry) await deleteEntry(week, entry);
      });
    });
    bindAll('[data-time-history]', button => { button.onclick = guarded(() => historyModal(state.week)); });
    bindAll('[data-time-hr-history]', button => { button.onclick = guarded(() => historyModal(state.hrWeek)); });
    bindAll('[data-time-submit]', button => {
      button.onclick = guarded(async () => {
        if (state.week.inProgress) submitWarningModal(state.week);
        else await submitWeek(state.week);
      });
    });
    bindAll('[data-time-withdraw]', button => {
      button.onclick = guarded(async () => {
        await send(`/api/time/weeks/${encodeURIComponent(button.dataset.timeWithdraw)}/withdraw`, 'POST');
        ui.toast('Woche zurückgezogen. Du kannst wieder stempeln und ändern.');
        refresh();
      });
    });
    bindAll('[data-time-review]', button => {
      button.onclick = guarded(() => reviewModal(button.dataset.timeReview, button.dataset.timeReviewWeek));
    });
    bindAll('[data-time-hr-person]', button => {
      button.onclick = () => {
        state.hrPersonId = Number(button.dataset.timeHrPerson);
        state.hrWeekStart = null;
        window.loop.navigate('timeHrPerson');
      };
    });
    bindAll('[data-time-hr-close]', button => {
      button.onclick = () => {
        state.jumpToPersonRow = state.hrPersonId;
        window.loop.navigate('timeHr');
      };
    });
    bindAll('[data-time-hours]', button => {
      button.onclick = () => hoursModal(Number(button.dataset.timeHours));
    });
    // Aufgabenknöpfe auf der Übersicht: springen direkt in die betroffene Woche.
    bindAll('[data-time-open-week]', button => {
      button.onclick = guarded(async () => {
        const { week } = await api(`/api/time/weeks/${encodeURIComponent(button.dataset.timeOpenWeek)}`);
        state.weekStart = week.weekStart;
        window.loop.navigate('timeHome');
      });
    });
    bindAll('[data-time-review-task]', button => {
      button.onclick = guarded(async () => {
        const { week } = await api(`/api/time/weeks/${encodeURIComponent(button.dataset.timeReviewTask)}`);
        await reviewModal(week.userId, week.weekStart);
      });
    });

    bindAll('[data-time-search]', input => {
      const listKey = input.dataset.timeSearch;
      input.oninput = () => {
        state.searches[listKey] = input.value;
        applyListFilter(listKey);
      };
      applyListFilter(listKey);
    });
    const showLeft = document.querySelector('#timeShowLeft');
    if (showLeft) {
      showLeft.onchange = () => {
        state.showLeft = showLeft.checked;
        applyListFilter('people');
      };
    }
    const teamStatus = document.querySelector('#timeTeamStatus');
    if (teamStatus) {
      teamStatus.onchange = () => {
        state.teamStatus = teamStatus.value;
        refresh();
      };
    }
    const settingsForm = document.querySelector('#timeSettingsForm');
    if (settingsForm) {
      settingsForm.onsubmit = async event => {
        event.preventDefault();
        const error = settingsForm.querySelector('#timeSettingsError');
        const submit = settingsForm.querySelector('button');
        if (submit.disabled) return;
        submit.disabled = true;
        error.textContent = '';
        try {
          await send('/api/time/settings', 'PUT', { weeklyHours: new FormData(settingsForm).get('weeklyHours') });
          ui.toast('Wochenstunden gespeichert.');
          refresh();
        } catch (saveError) {
          error.textContent = saveError.message;
        } finally {
          submit.disabled = false;
        }
      };
    }
    const exportMonth = document.querySelector('#timeExportMonth');
    const exportLink = document.querySelector('#timeExportLink');
    if (exportMonth && exportLink) {
      const exportNote = document.querySelector('#timeExportNote');
      exportMonth.onchange = guarded(async () => {
        const month = exportMonth.value;
        if (!month) return;
        exportLink.href = `/api/time/export?month=${encodeURIComponent(month)}`;
        const { note } = await exportScope(month);
        // Bei schnellem Umschalten zählt nur der zuletzt gewählte Monat.
        if (exportMonth.value !== month) return;
        exportNote.textContent = note || '';
        exportNote.hidden = !note;
      });
      // Ohne Monat antwortet der Server mit einem Fehler, und der Browser meldet nur „Download fehlgeschlagen“.
      exportLink.onclick = event => {
        if (exportMonth.value) return;
        event.preventDefault();
        ui.toast('Bitte wähle zuerst einen Monat.', 'error');
      };
    }
    jumpAfterRender();
  }

  window.loop.registerModule({
    key: 'time',
    label: 'Zeiterfassung',
    nav(me) {
      return [{ route: me.role === 'super_admin' ? 'timeHr' : 'timeHome', label: 'Zeiterfassung', group: 'time', views: VIEWS }];
    },
    pages: { timeHome: homePage, timeTeam: teamPage, timeHr: hrPage, timeHrPerson: hrPersonPage },
    allowed(view, me) {
      if (['timeHr', 'timeHrPerson'].includes(view)) return isHrPerson(me);
      if (view === 'timeTeam') return TEAM_TAB_ROLES.includes(me.role);
      // Das technische Systemkonto erfasst keine eigenen Zeiten.
      if (view === 'timeHome') return me.role !== 'super_admin';
      return true;
    },
    tabs(view, me) {
      if (!VIEWS.includes(view)) return [];
      const tabs = [];
      // Das technische Systemkonto erfasst keine eigenen Zeiten.
      if (me.role !== 'super_admin') tabs.push({ route: 'timeHome', label: 'Meine Zeiten', active: view === 'timeHome' });
      if (TEAM_TAB_ROLES.includes(me.role)) tabs.push({ route: 'timeTeam', label: 'Team', active: view === 'timeTeam' });
      if (isHrPerson(me)) tabs.push({ route: 'timeHr', label: 'HR', active: ['timeHr', 'timeHrPerson'].includes(view) });
      return tabs;
    },
    bind,
    taskAction(task) {
      if (task.type === 'time_week_approval') return `<button class="btn primary" data-time-review-task="${esc(task.entity_id)}">Prüfen</button>`;
      if (task.type === 'time_week_returned' || task.type === 'time_week_reopened') {
        return `<button class="btn" data-time-open-week="${esc(task.entity_id)}">Öffnen</button>`;
      }
      if (task.type === 'time_correction_notice') {
        return `<button class="btn" data-time-open-week="${esc(task.entity_id)}">Ansehen</button> <button class="btn" data-task-done="${esc(task.id)}">Erledigt</button>`;
      }
      return '';
    }
  });

  window.loop.registerAddress({
    timeHrPerson: {
      get: () => state.hrPersonId,
      set: id => {
        state.hrPersonId = id;
        state.hrWeekStart = null;
      }
    }
  });
})();
