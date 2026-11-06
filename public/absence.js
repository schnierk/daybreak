// Abwesenheit: eigenes Konto und Anträge, Teamkalender und Entscheidungen, HR-Verwaltung.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const VIEWS = ['absenceHome', 'absenceTeam', 'absenceHr'];
  const HR_ROLES = ['hr_admin', 'hrbp', 'hr_staff', 'super_admin'];
  // Die Sachbearbeitung ändert keine Arten, Feiertage und Voreinstellungen.
  const FULL_HR_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const LEADERSHIP_ROLES = ['manager', 'director', 'hr_admin', 'hrbp', 'super_admin'];
  const STATUS_LABELS = { pending: 'Offen', approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Storniert' };
  const HALF_PART_LABELS = { morning: 'vormittags', afternoon: 'nachmittags' };
  const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const YEAR_WINDOW = 5;
  const CALENDAR_SEARCH_FROM = 12;
  // Ehrlich statt beruhigend: Die Führungskraft erfährt das Fehlen und kann sich den Grund denken.
  const CONFIDENTIAL_NOTE_FOR_PERSON = 'Deine Führungskraft erfährt, dass du fehlst. Die Art wird ihr nicht genannt, sie kann sie sich aber denken, weil fast alles andere einen Antrag braucht. Dein Team sieht nur „abwesend“.';
  const CONFIDENTIAL_NOTE_FOR_HR = 'Die Führungskraft erfährt, dass die Person fehlt. Die Art wird ihr nicht genannt, sie kann sie sich aber denken. Das Team sieht nur „abwesend“.';
  const MAX_SICK_DAYS_AHEAD = 14;
  const CALENDAR_GROUPS = [
    ['self', 'Du'],
    ['direct', 'Direkt unterstellt'],
    ['indirect', 'Indirekt unterstellt'],
    ['colleague', 'Außerhalb deiner Führung'],
    ['hr', 'Alle weiteren Personen']
  ];

  // Zustand der geöffneten Seite. Er lebt nur im Browser der angemeldeten Person.
  const state = {
    year: null,
    hrYear: null,
    month: null,
    hrStatus: '',
    hrSection: 'requests',
    jumpToCalendar: false,
    showLeft: false,
    searches: {},
    types: [],
    approval: null,
    accounts: [],
    holidayState: null
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

  const currentYear = () => Number(todayInGermany().slice(0, 4));
  const formatDate = isoDate => (isoDate ? isoDate.split('-').reverse().join('.') : '–');
  const formatRange = (first, last) => (first === last ? formatDate(first) : `${formatDate(first)} bis ${formatDate(last)}`);
  const formatDays = days => String(days ?? 0).replace('.', ',');
  const dayCount = days => (days === 1 ? '1 Arbeitstag' : `${formatDays(days)} Arbeitstage`);
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

  function shiftMonth(month, delta) {
    const [year, monthNumber] = month.split('-').map(Number);
    return new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7);
  }

  function halfNote(request) {
    if (request.startDate === request.endDate) {
      if (!request.startHalf && !request.endHalf) return '';
      return request.halfDayPart ? ` (${HALF_PART_LABELS[request.halfDayPart]})` : ' (halber Tag)';
    }
    const parts = [];
    if (request.startHalf) parts.push('erster Tag nur nachmittags');
    if (request.endHalf) parts.push('letzter Tag nur vormittags');
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  function statusTag(request) {
    if (request.status === 'approved' && !request.requiresApproval) return '<span class="tag">Eingetragen</span>';
    const emphasized = ['pending', 'rejected'].includes(request.status) ? ' focus' : '';
    return `<span class="tag${emphasized}">${esc(STATUS_LABELS[request.status] || request.status)}</span>`;
  }

  /** Wer entscheidet oder entschieden hat, und warum etwas hinfällig wurde. */
  function statusNotes(request) {
    const notes = [];
    if (request.status === 'pending' && request.personInactive) notes.push('Konto gesperrt');
    if (request.status === 'pending' && request.pendingWith) notes.push(`Entscheidet: ${request.pendingWith}`);
    if (['approved', 'rejected'].includes(request.status) && request.decidedByName) {
      notes.push(`${STATUS_LABELS[request.status]} von ${request.decidedByName}`);
    }
    if (request.cancelReason) notes.push(request.status === 'cancelled' ? `Grund: ${request.cancelReason}` : request.cancelReason);
    return notes.map(text => `<small class="muted absence-note">${esc(text)}</small>`).join('');
  }

  /** Der Server lässt nur Jahre in diesem Abstand zu; weiter führt der Knopf deshalb nicht. */
  function yearSwitch(year, attribute) {
    const button = (target, label, text) => {
      const disabled = Math.abs(target - currentYear()) > YEAR_WINDOW ? ' disabled' : '';
      return `<button type="button" class="btn" ${attribute}="${esc(target)}" aria-label="${label}"${disabled}>${text}</button>`;
    };
    return `<div class="absence-switch">
      ${button(year - 1, 'Jahr davor', '‹')}
      <b>${esc(year)}</b>
      ${button(year + 1, 'Jahr danach', '›')}
    </div>`;
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
    return `<div class="absence-search">
      <input type="search" data-absence-search="${esc(listKey)}" value="${esc(state.searches[listKey] || '')}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
      <small class="muted" data-absence-search-count="${esc(listKey)}" role="status"></small>
    </div>`;
  }

  /** Blendet Zeilen nur aus, statt neu zu zeichnen: So behält das Suchfeld beim Tippen den Fokus. */
  function applyListFilter(listKey) {
    const rows = document.querySelectorAll(`[data-absence-row="${listKey}"]`);
    const query = state.searches[listKey] || '';
    let visible = 0;
    rows.forEach(row => {
      const show = (row.dataset.left !== '1' || state.showLeft) && matchesSearch(row.dataset.search, query);
      row.hidden = !show;
      if (show) visible += 1;
    });
    // Eine Gruppe im Kalender verschwindet mit ihrer letzten Zeile.
    document.querySelectorAll(`[data-absence-group="${listKey}"]`).forEach(head => {
      let next = head.nextElementSibling;
      let hasVisibleRow = false;
      while (next && !next.dataset.absenceGroup) {
        if (!next.hidden) hasVisibleRow = true;
        next = next.nextElementSibling;
      }
      head.hidden = !hasVisibleRow;
    });
    const count = document.querySelector(`[data-absence-search-count="${listKey}"]`);
    if (count) count.textContent = query.trim() ? `${visible} von ${rows.length} gefunden` : '';
    const empty = document.querySelector(`[data-absence-search-empty="${listKey}"]`);
    if (empty) empty.hidden = visible > 0 || rows.length === 0;
  }

  // ------------------------------------------------------------------
  // Mein Bereich
  // ------------------------------------------------------------------

  function carryoverNote(account) {
    if (!account.carryoverDays) return 'keine Resttage aus dem Vorjahr';
    if (account.carryoverExpiredDays > 0) return `aus dem Vorjahr, ${formatDays(account.carryoverExpiredDays)} am ${formatDate(account.carryoverExpires)} verfallen`;
    return account.carryoverExpires ? `aus dem Vorjahr, gültig bis ${formatDate(account.carryoverExpires)}` : 'aus dem Vorjahr, verfällt nicht';
  }

  function accountStats(account) {
    return `<section class="cards absence-stats">
      ${ui.stat('Anspruch', formatDays(account.entitlementDays), `Tage ${account.year}`)}
      ${ui.stat('Übertrag', formatDays(account.carryoverDays), carryoverNote(account))}
      ${ui.stat('Genommen', formatDays(account.takenDays), 'Tage bis heute')}
      ${ui.stat('Geplant', formatDays(account.plannedDays), account.pendingDays ? `davon ${formatDays(account.pendingDays)} noch offen` : 'genehmigt und künftig')}
      ${ui.stat('Rest', formatDays(account.restDays), 'Tage frei')}
    </section>`;
  }

  function accountNotices(account) {
    const notices = [];
    if (account.carryoverExpiringDays > 0) {
      notices.push(`${formatDays(account.carryoverExpiringDays)} Tage Übertrag verfallen am ${formatDate(account.carryoverExpires)}, wenn du sie bis dahin nicht einplanst.`);
    } else if (account.carryoverExpiredDays > 0) {
      notices.push(`${formatDays(account.carryoverExpiredDays)} Tage Übertrag sind am ${formatDate(account.carryoverExpires)} verfallen.`);
    }
    if (account.correction) notices.push(correctionText(account.correction));
    return notices.map(text => `<p class="absence-notice">${esc(text)}</p>`).join('');
  }

  function correctionText(correction) {
    const date = String(correction.at || '').slice(0, 10);
    const who = correction.byName ? ` von ${correction.byName}` : '';
    return `Zuletzt angepasst${who}${date ? ` am ${formatDate(date)}` : ''}. Grund: ${correction.reason}`;
  }

  /** Was schon begonnen hat, ändert nur HR. Damit das keine Sackgasse ist, geht die Bitte mit einem Klick dorthin. */
  function correctionAction(request, range) {
    if (!request.canRequestCorrection) return '';
    if (request.correctionRequested) return '<small class="muted">Korrektur bei HR angefragt</small>';
    return `<div>
      <button type="button" class="btn" data-absence-correction="${esc(request.id)}" data-absence-label="${esc(range)}">Korrektur bei HR anfragen</button>
      <small class="muted absence-note">Das ändert nur HR.</small>
    </div>`;
  }

  function ownRequestRow(request) {
    const comments = [request.comment, request.decisionComment ? `Antwort: ${request.decisionComment}` : '']
      .filter(Boolean)
      .map(text => `<small class="muted absence-note">${esc(text)}</small>`)
      .join('');
    const range = formatRange(request.startDate, request.endDate);
    const cancel = request.canCancel
      ? `<button type="button" class="btn" data-absence-cancel="${esc(request.id)}" data-absence-label="${esc(range)}">Stornieren</button>`
      : correctionAction(request, range);
    return `<tr>
      <td data-label="Zeitraum"><div><b>${esc(range)}</b>${esc(halfNote(request))}${comments}</div></td>
      <td data-label="Art">${esc(request.typeName)}</td>
      <td data-label="Arbeitstage">${esc(formatDays(request.days))}</td>
      <td data-label="Status"><div>${statusTag(request)}${statusNotes(request)}</div></td>
      <td class="absence-card-actions">${cancel}</td>
    </tr>`;
  }

  async function homePage() {
    const year = state.year || currentYear();
    const [{ account }, { requests }, { types, approval }] = await Promise.all([
      api(`/api/absence/account?year=${encodeURIComponent(year)}`),
      api(`/api/absence/requests?year=${encodeURIComponent(year)}`),
      api('/api/absence/types')
    ]);
    state.types = types;
    state.approval = approval;
    const sick = types.find(type => type.code === 'sick');
    const actions = `<div class="absence-actions">
      ${sick ? '<button type="button" class="btn" data-absence-sick>Krank melden</button>' : ''}
      <button type="button" class="btn primary" data-absence-new>+ Antrag</button>
    </div>`;
    const rows = requests.map(ownRequestRow).join('');
    return `${ui.header('Abwesenheit', 'Dein Urlaubskonto und deine Anträge.', actions)}
      <div class="sectionHead absence-head"><h2>Konto</h2>${yearSwitch(year, 'data-absence-year')}</div>
      ${accountStats(account)}
      ${accountNotices(account)}
      <article class="card absence-section">
        <h2>Meine Anträge ${esc(year)}</h2>
        ${rows
          ? `<div class="tableWrap"><table class="table absence-cards"><thead><tr><th>Zeitraum</th><th>Art</th><th>Arbeitstage</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : ui.empty('In diesem Jahr gibt es noch keine Anträge.')}
      </article>`;
  }

  // ------------------------------------------------------------------
  // Antrag und Krankmeldung
  // ------------------------------------------------------------------

  function dateFields({ latestStart = '' } = {}) {
    return `<div class="two">
        <div><label>Von</label><input name="startDate" type="date" required${latestStart ? ` max="${esc(latestStart)}"` : ''}></div>
        <div><label>Bis</label><input name="endDate" type="date" required></div>
      </div>
      <fieldset class="absence-scope" id="absenceSingleDay" hidden>
        <legend>Wie lange?</legend>
        <label class="checkRow"><input type="radio" name="dayScope" value="full" checked> Ganzer Tag</label>
        <label class="checkRow"><input type="radio" name="dayScope" value="morning"> Nur vormittags</label>
        <label class="checkRow"><input type="radio" name="dayScope" value="afternoon"> Nur nachmittags</label>
      </fieldset>
      <fieldset class="absence-scope" id="absenceSeveralDays" hidden>
        <legend>Halbe Tage</legend>
        <label class="checkRow"><input type="checkbox" name="startHalf"> Am ersten Tag erst ab mittags</label>
        <label class="checkRow"><input type="checkbox" name="endHalf"> Am letzten Tag nur bis mittags</label>
      </fieldset>`;
  }

  /** Das Ende folgt dem Anfang, damit ein einzelner Tag nur einmal eingegeben werden muss. */
  function bindDateFields() {
    const start = document.querySelector('#uiModalForm [name="startDate"]');
    const end = document.querySelector('#uiModalForm [name="endDate"]');
    if (!start || !end) return;
    const singleDay = document.querySelector('#absenceSingleDay');
    const severalDays = document.querySelector('#absenceSeveralDays');
    const showScope = () => {
      const bothSet = start.value && end.value;
      singleDay.hidden = !bothSet || start.value !== end.value;
      severalDays.hidden = !bothSet || start.value === end.value;
    };
    start.onchange = () => {
      if (!end.value || end.value < start.value) end.value = start.value;
      showScope();
    };
    end.onchange = showScope;
  }

  /** Bei einem Tag zählt die Auswahl vormittags oder nachmittags, bei mehreren Tagen die beiden Häkchen. */
  function requestBody(data) {
    const { dayScope, ...body } = data;
    if (data.startDate !== data.endDate) return body;
    delete body.startHalf;
    delete body.endHalf;
    if (HALF_PART_LABELS[dayScope]) body.halfDayPart = dayScope;
    return body;
  }

  function showSavedMessage(result) {
    if (result.warning) ui.toast(result.warning, 'error');
    else ui.toast(result.status === 'pending' ? `Antrag gestellt: ${dayCount(result.days)}.` : `Eingetragen: ${dayCount(result.days)}.`);
  }

  async function submitRequest(data) {
    const result = await send('/api/absence/requests', 'POST', requestBody(data));
    showSavedMessage(result);
    // Die Liste zeigt ein Jahr. Sie springt dorthin, damit der neue Antrag zu sehen ist.
    const year = Number(data.startDate.slice(0, 4));
    if (window.loop.view === 'absenceHr') state.hrYear = year;
    else state.year = year;
    refresh();
  }

  function selectableTypes() {
    return state.types.filter(type => type.active);
  }

  /** Sagt vor dem Absenden, was mit dem Antrag geschieht. Das hängt von Art und Regel der Organisation ab. */
  function approvalHint(type, hrMode) {
    if (!type) return '';
    const route = state.approval || {};
    if (!type.requiresApproval) {
      const privacy = type.confidential
        ? (hrMode ? CONFIDENTIAL_NOTE_FOR_HR : CONFIDENTIAL_NOTE_FOR_PERSON)
        : 'Alle anderen sehen nur „abwesend“.';
      return `Das braucht keine Genehmigung und wird sofort eingetragen. ${privacy}`;
    }
    if (route.rule === 'none') return 'Bei euch gilt das sofort, ohne Genehmigung.';
    if (type.confidential) return 'Das entscheidet nur HR. Alle anderen sehen nur „abwesend“.';
    if (hrMode) return route.rule === 'hr' ? 'Der Antrag geht zur Entscheidung an HR.' : 'Der Antrag geht zur Entscheidung an die Führungskraft der Person, ohne Führungskraft an HR.';
    if (route.decider === 'manager') return `Dein Antrag geht an ${route.name}, deine direkte Führungskraft.`;
    if (route.decider === 'nobody') return 'Gerade kann niemand außer dir entscheiden. Bitte lege eine weitere Person mit HR-Rechten an.';
    return 'Dein Antrag geht an HR.';
  }

  function requestModal({ people = null, hrMode = false, presetCode = null } = {}) {
    const types = selectableTypes();
    const typeOptions = types
      .map(type => `<option value="${esc(type.id)}" ${type.code === presetCode ? 'selected' : ''}>${esc(type.name)}</option>`)
      .join('');
    const isDuplicate = duplicateNames(people || [], person => person.userName);
    const personOption = person => {
      const left = person.active === false;
      const email = isDuplicate(person) && person.userEmail ? ` · ${person.userEmail}` : '';
      return `<option value="${esc(person.userId)}" data-left="${left ? '1' : '0'}">${esc(surnameFirst(person.userName))}${esc(email)}${left ? ' (ausgetreten)' : ''}</option>`;
    };
    const personField = people
      ? `<label>Person</label><select name="userId" required id="absencePersonSelect"><option value="">Bitte auswählen</option>${people.map(personOption).join('')}</select>
        <p class="absence-notice" id="absenceLeftNote" hidden>Für diese Person kannst du nur noch vergangene Tage nachtragen.</p>`
      : '';
    ui.modal({
      title: hrMode ? 'Abwesenheit erfassen' : 'Antrag stellen',
      submitLabel: hrMode ? 'Erfassen' : 'Antrag stellen',
      body: `${personField}
        <label>Art</label><select name="typeId" required id="absenceTypeSelect">${typeOptions}</select>
        <p class="muted" id="absenceApprovalHint"></p>
        ${dateFields()}
        <div id="absenceCommentField"><label>Kommentar (optional)</label><textarea name="comment" maxlength="1000"></textarea></div>
        <p class="muted" id="absenceConfidentialNote" hidden>Diese Art ist vertraulich. Deshalb gibt es kein Kommentarfeld, und bitte trage nirgends eine Diagnose ein.</p>`,
      onSubmit: submitRequest
    });
    bindDateFields();
    const select = document.querySelector('#absenceTypeSelect');
    const applyType = () => {
      const type = types.find(item => String(item.id) === select.value);
      const confidential = Boolean(type?.confidential);
      const field = document.querySelector('#absenceCommentField');
      field.hidden = confidential;
      if (confidential) field.querySelector('textarea').value = '';
      document.querySelector('#absenceConfidentialNote').hidden = !confidential;
      document.querySelector('#absenceApprovalHint').textContent = approvalHint(type, hrMode);
    };
    select.onchange = applyType;
    applyType();
    const personSelect = document.querySelector('#absencePersonSelect');
    if (personSelect) {
      personSelect.onchange = () => {
        document.querySelector('#absenceLeftNote').hidden = personSelect.selectedOptions[0]?.dataset.left !== '1';
      };
    }
  }

  function sickModal() {
    const sick = state.types.find(type => type.code === 'sick');
    if (!sick) return;
    ui.modal({
      title: 'Krank melden',
      subtitle: 'Du brauchst keine Genehmigung und nennst keine Diagnose.',
      submitLabel: 'Melden',
      body: `<input type="hidden" name="typeId" value="${esc(sick.id)}">
        ${dateFields({ latestStart: addDays(todayInGermany(), MAX_SICK_DAYS_AHEAD) })}
        <p class="muted">${esc(CONFIDENTIAL_NOTE_FOR_PERSON)}</p>`,
      onSubmit: submitRequest
    });
    bindDateFields();
  }

  // ------------------------------------------------------------------
  // Team
  // ------------------------------------------------------------------

  function overlapNote(request) {
    if (!request.overlaps?.length) return '';
    const names = request.overlaps
      .map(other => `${other.userName}${other.pending ? ' (beantragt)' : ''}, ${formatRange(other.startDate, other.endDate)}`)
      .join('; ');
    return `<small class="absence-overlap">Im selben Zeitraum fehlt im Team: ${esc(names)}</small>`;
  }

  function approvalRow(request) {
    const details = [
      request.typeName,
      dayCount(request.days),
      request.restDays === null ? '' : `Rest, wenn alles Offene genehmigt wird: ${formatDays(request.restDays)}`
    ].filter(Boolean).join(' · ');
    const label = `${request.userName}: ${formatRange(request.startDate, request.endDate)}`;
    return `<div class="row absence-approval">
      <div class="grow">
        <b>${esc(label)}${esc(halfNote(request))}</b>
        <small class="absence-note">${esc(details)}</small>
        ${request.comment ? `<small class="muted absence-note">${esc(request.comment)}</small>` : ''}
        ${overlapNote(request)}
      </div>
      <button type="button" class="btn" data-absence-show-month="${esc(request.startDate.slice(0, 7))}">Im Kalender zeigen</button>
      <button type="button" class="btn" data-absence-decide="${esc(request.id)}" data-absence-decision="reject" data-absence-label="${esc(label)}">Ablehnen</button>
      <button type="button" class="btn primary" data-absence-decide="${esc(request.id)}" data-absence-decision="approve" data-absence-label="${esc(label)}">Genehmigen</button>
    </div>`;
  }

  function approvalsCard(requests, rule) {
    const me = window.loop.me;
    const ruleNote = () => {
      if (isFullHr(me)) return rule === 'none' ? 'Neue Anträge gelten bei euch sofort. Diese hier sind noch von früher.' : '';
      if (rule === 'hr') return 'Neue Anträge entscheidet bei euch HR. Diese hier hast du noch von früher.';
      if (rule === 'none') return 'Neue Anträge gelten bei euch sofort. Diese hier hast du noch von früher.';
      return '';
    };
    const emptyText = () => {
      if (rule === 'none') return 'Anträge gelten bei euch sofort. Es gibt nichts zu entscheiden.';
      if (rule === 'hr' && !isFullHr(me)) return 'Anträge entscheidet bei euch HR. Es kommt nichts mehr zu dir.';
      return 'Gerade wartet kein Antrag auf deine Entscheidung.';
    };
    const note = requests.length && ruleNote() ? `<p class="muted">${esc(ruleNote())}</p>` : '';
    return `<article class="card absence-section">
      <h2>Offene Anträge</h2>
      ${note}
      ${requests.length ? requests.map(approvalRow).join('') : ui.empty(emptyText())}
    </article>`;
  }

  function markFor(entries, date) {
    const isHalfDay = entry => (entry.startHalf && date === entry.startDate) || (entry.endHalf && date === entry.endDate);
    if (entries.some(isHalfDay)) return '½';
    return entries[0].status === 'pending' ? '○' : '●';
  }

  function dayCell(person, date, holidays, todayDate, entries) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const holiday = holidays.get(date);
    const classes = ['absence-day'];
    if (isWeekend) classes.push('absence-weekend');
    if (holiday) classes.push('absence-holiday');
    if (date === todayDate) classes.push('absence-today');
    const onThisDay = entries.filter(entry => entry.startDate <= date && entry.endDate >= date);
    if (!onThisDay.length || isWeekend || holiday) {
      const title = holiday ? ` title="${esc(holiday)}"` : '';
      return `<td class="${classes.join(' ')}"${title}></td>`;
    }
    const isPending = onThisDay.every(entry => entry.status === 'pending');
    const isGeneric = onThisDay.every(entry => !entry.typeName);
    classes.push(isPending ? 'absence-mark-pending' : isGeneric ? 'absence-mark-generic' : 'absence-mark');
    const labels = onThisDay.map(entry => {
      const part = entry.halfDayPart ? ` ${HALF_PART_LABELS[entry.halfDayPart]}` : '';
      return `${entry.label}${part}${entry.status === 'pending' ? ' (beantragt)' : ''}, ${formatRange(entry.startDate, entry.endDate)}`;
    }).join('; ');
    const text = `${person.name}: ${labels}`;
    return `<td class="${classes.join(' ')}" title="${esc(text)}" aria-label="${esc(text)}">${esc(markFor(onThisDay, date))}</td>`;
  }

  function calendarGroupOf(person) {
    if (person.relation === 'self') return 'self';
    if (person.direct) return 'direct';
    if (person.relation === 'report') return 'indirect';
    return person.relation === 'colleague' ? 'colleague' : 'hr';
  }

  function calendarRow(person, calendar, days, holidays) {
    const entries = calendar.entries.filter(entry => entry.userId === person.id);
    const cells = days.map(date => dayCell(person, date, holidays, calendar.today, entries)).join('');
    const via = person.viaManagerName ? `<small class="muted absence-note">über ${esc(person.viaManagerName)}</small>` : '';
    return `<tr data-absence-row="calendar" data-search="${esc(searchText(person))}">
      <th scope="row" class="absence-person">${esc(person.name)}${via}</th>${cells}
    </tr>`;
  }

  function calendarTable(calendar) {
    const days = [];
    for (let date = calendar.firstDay; date <= calendar.lastDay; date = addDays(date, 1)) days.push(date);
    const holidays = new Map(calendar.holidays.map(holiday => [holiday.date, holiday.name]));
    const head = days.map(date => {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const muted = weekday === 0 || weekday === 6 ? ' class="absence-weekend"' : '';
      return `<th${muted}><span>${esc(WEEKDAYS[weekday])}</span><br>${esc(Number(date.slice(8)))}</th>`;
    }).join('');
    // Wer niemanden führt, sieht in dieser Gruppe einfach das eigene Team.
    const leadsSomeone = calendar.people.some(person => person.relation === 'report' || person.direct);
    const rows = CALENDAR_GROUPS.map(([key, label]) => {
      const members = calendar.people.filter(person => calendarGroupOf(person) === key);
      if (!members.length) return '';
      const heading = key === 'colleague' && !leadsSomeone ? 'Dein Team' : label;
      return `<tr class="absence-group" data-absence-group="calendar"><th colspan="${days.length + 1}" scope="rowgroup"><span>${esc(heading)}</span></th></tr>
        ${members.map(person => calendarRow(person, calendar, days, holidays)).join('')}`;
    }).join('');
    return `<div class="tableWrap"><table class="absence-calendar">
      <thead><tr><th class="absence-person">Person</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function monthLabel(month) {
    const [year, monthNumber] = month.split('-').map(Number);
    return `${MONTH_NAMES[monthNumber - 1]} ${year}`;
  }

  function calendarCard(calendar) {
    const holidayList = calendar.holidays.length
      ? `<p class="muted absence-note">Feiertage: ${calendar.holidays.map(holiday => `${esc(formatDate(holiday.date))} ${esc(holiday.name)}`).join(', ')}</p>`
      : '';
    const search = calendar.people.length >= CALENDAR_SEARCH_FROM ? listSearch('calendar', 'Person im Kalender suchen') : '';
    const currentMonth = calendar.today.slice(0, 7);
    const backToNow = calendar.month === currentMonth ? '' : `<button type="button" class="btn" data-absence-month="${esc(currentMonth)}">Aktueller Monat</button>`;
    return `<article class="card absence-section" id="absenceCalendarCard">
      <div class="sectionHead">
        <h2>Teamkalender</h2>
        <div class="absence-actions">
          ${backToNow}
          <div class="absence-switch">
            <button type="button" class="btn" data-absence-month="${esc(shiftMonth(calendar.month, -1))}" aria-label="Monat davor">‹</button>
            <b>${esc(monthLabel(calendar.month))}</b>
            <button type="button" class="btn" data-absence-month="${esc(shiftMonth(calendar.month, 1))}" aria-label="Monat danach">›</button>
          </div>
        </div>
      </div>
      ${search}
      ${calendar.people.length ? calendarTable(calendar) : ui.empty('Hier gibt es noch niemanden zu sehen.')}
      <p class="muted absence-empty-search" data-absence-search-empty="calendar" hidden>Niemanden gefunden.</p>
      <p class="absence-legend">
        <span class="absence-key absence-mark">●</span> Genehmigt, Art für dich sichtbar
        <span class="absence-key absence-mark-pending">○</span> Beantragt
        <span class="absence-key absence-mark-generic">●</span> Abwesend
        <span class="absence-key absence-holiday"></span> Feiertag
        <span>½ halber Tag</span>
      </p>
      <p class="muted absence-note">Zeig auf ein Feld oder tippe es an, um mehr zu lesen. Die Art einer Abwesenheit sehen nur die Person selbst, HR und wer darüber entscheidet. Für alle anderen steht dort „abwesend“.</p>
      ${holidayList}
    </article>`;
  }

  async function teamPage() {
    const me = window.loop.me;
    const { requests, rule } = await api('/api/absence/approvals');
    // Wartet ein Antrag, zeigt der Kalender dessen Monat. Sonst sähe man nicht, wer in dieser Zeit fehlt.
    const month = state.month || requests[0]?.startDate.slice(0, 7) || todayInGermany().slice(0, 7);
    const calendar = await api(`/api/absence/calendar?month=${encodeURIComponent(month)}`);
    const showApprovals = LEADERSHIP_ROLES.includes(me.role) || requests.length > 0;
    const approvals = showApprovals ? approvalsCard(requests, rule) : '';
    return `${ui.header('Abwesenheit im Team', 'Wer fehlt wann, und was noch auf eine Entscheidung wartet.')}${approvals}${calendarCard(calendar)}`;
  }

  function decisionModal(id, decision, label) {
    const isReject = decision === 'reject';
    ui.modal({
      title: isReject ? 'Antrag ablehnen' : 'Antrag genehmigen',
      subtitle: label || '',
      submitLabel: isReject ? 'Ablehnen' : 'Genehmigen',
      body: `<label>${isReject ? 'Begründung' : 'Kommentar (optional)'}</label><textarea name="comment" maxlength="1000"${isReject ? ' required' : ''}></textarea>`,
      onSubmit: async data => {
        await send(`/api/absence/requests/${encodeURIComponent(id)}/decision`, 'POST', { decision, comment: data.comment });
        ui.toast(isReject ? 'Antrag abgelehnt.' : 'Antrag genehmigt.');
        refresh();
      }
    });
  }

  // ------------------------------------------------------------------
  // HR
  // ------------------------------------------------------------------

  /** Aus 03-31 wird 31.03. und zurück. Das Format MM-TT ist nur für den Server gedacht. */
  const expiryForDisplay = value => {
    const match = String(value ?? '').match(/^(\d{2})-(\d{2})$/);
    return match ? `${match[2]}.${match[1]}.` : String(value ?? '');
  };
  const expiryForServer = value => {
    const match = String(value ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    return match ? `${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : String(value ?? '').trim();
  };

  function settingsCard(settings) {
    const stateOptions = Object.entries(settings.states)
      .map(([code, name]) => `<option value="${esc(code)}" ${settings.state === code ? 'selected' : ''}>${esc(name)}</option>`)
      .join('');
    return `<article class="card absence-section">
      <h2>Voreinstellungen</h2>
      <p class="muted">Gelten für Konten, die neu angelegt werden. Bestehende Konten bleiben, wie sie sind.</p>
      <form id="absenceSettingsForm" class="talent-form">
        <div class="error" id="absenceSettingsError"></div>
        <div class="two">
          <div><label>Standardanspruch (Tage)</label><input name="defaultEntitlementDays" type="number" min="0" max="366" step="0.5" required value="${esc(settings.defaultEntitlementDays)}"></div>
          <div><label>Übertrag verfällt am (Tag und Monat)</label><input name="carryoverExpiryDay" required placeholder="31.03." value="${esc(expiryForDisplay(settings.carryoverExpiryDay))}"></div>
        </div>
        <label>Bundesland</label>
        <select name="state"><option value="">Bitte auswählen</option>${stateOptions}</select>
        <label class="checkRow"><input type="checkbox" name="autoCarryover" ${settings.autoCarryover ? 'checked' : ''}> Resttage automatisch ins nächste Jahr übernehmen</label>
        <button class="btn primary">Speichern</button>
      </form>
    </article>`;
  }

  function holidaysCard(year, data) {
    const rows = data.holidays.map(holiday => `<tr>
      <td data-label="Datum">${esc(formatDate(holiday.date))}</td>
      <td data-label="Name">${esc(holiday.name)}</td>
      <td data-label="Quelle">${holiday.source === 'custom' ? '<span class="tag focus">Eigener Tag</span>' : '<span class="tag">Gesetzlich</span>'}</td>
      <td class="absence-card-actions"><button type="button" class="btn" data-absence-holiday-delete="${esc(holiday.id)}" data-absence-label="${esc(`${holiday.name}, ${formatDate(holiday.date)}`)}">Entfernen</button></td>
    </tr>`).join('');
    const notice = data.statutoryImported
      ? ''
      : `<p class="absence-notice">Für ${esc(year)} sind noch keine gesetzlichen Feiertage eingespielt. Bis dahin zählen diese Tage als Arbeitstage.</p>`;
    return `<article class="card absence-section">
      <div class="sectionHead">
        <h2>Feiertage ${esc(year)}</h2>
        ${yearSwitch(year, 'data-absence-hr-year')}
      </div>
      <div class="absence-actions absence-section-actions">
        <button type="button" class="btn" data-absence-holiday-add>+ Eigener Tag</button>
        <button type="button" class="btn primary" data-absence-import="${esc(year)}">Gesetzliche Feiertage einspielen</button>
      </div>
      ${notice}
      <p class="muted">Berechnet für ${esc(data.stateName || 'das gewählte Bundesland')}. Tage, die nur in einzelnen Gemeinden gelten, ergänzt du als eigene Tage. Bitte prüfe die Liste einmal für euren Standort.</p>
      ${rows ? `<div class="tableWrap"><table class="table absence-cards"><thead><tr><th>Datum</th><th>Name</th><th>Quelle</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ui.empty('Noch keine Feiertage eingetragen.')}
    </article>`;
  }

  function accountRow(account, isDuplicate) {
    const left = !account.active;
    const leftNote = left ? `<small class="muted absence-note">${account.exitDate ? `letzter Arbeitstag ${esc(formatDate(account.exitDate))}` : 'Konto gesperrt'}</small>` : '';
    const email = isDuplicate(account) && account.userEmail ? `<small class="muted absence-note">${esc(account.userEmail)}</small>` : '';
    const adjust = account.canAdjust
      ? `<button type="button" class="btn" data-absence-account-edit="${esc(account.userId)}">Anpassen</button>`
      : '<small class="muted">ändert eine andere HR-Person</small>';
    const expiry = account.carryoverDays ? formatDate(account.carryoverExpires) : '–';
    return `<tr data-absence-row="accounts" data-search="${esc(searchText(account))}" data-left="${left ? '1' : '0'}"${left ? ' class="rowInactive"' : ''}>
      <td data-label="Person"><div><b>${esc(surnameFirst(account.userName))}</b>${email}${leftNote}</div></td>
      <td data-label="Anspruch">${esc(formatDays(account.entitlementDays))}</td>
      <td data-label="Übertrag"><div>${esc(formatDays(account.carryoverDays))}${account.carryoverAutomatic && account.carryoverDays ? ' <small class="muted">automatisch</small>' : ''}</div></td>
      <td data-label="Gültig bis"><div>${esc(expiry)}${account.carryoverExpiredDays ? ` <small class="muted">${esc(formatDays(account.carryoverExpiredDays))} verfallen</small>` : ''}</div></td>
      <td data-label="Genommen">${esc(formatDays(account.takenDays))}</td>
      <td data-label="Geplant">${esc(formatDays(account.plannedDays))}</td>
      <td data-label="Rest"><b>${esc(formatDays(account.restDays))}</b></td>
      <td class="absence-card-actions">${adjust}</td>
    </tr>`;
  }

  function accountsCard(year, accounts) {
    const isDuplicate = duplicateNames(accounts, account => account.userName);
    const anyLeft = accounts.some(account => !account.active);
    const leftToggle = anyLeft
      ? `<label class="checkRow absence-left-toggle"><input type="checkbox" id="absenceShowLeft" ${state.showLeft ? 'checked' : ''}> Auch ausgetretene und gesperrte Personen zeigen</label>`
      : '';
    return `<article class="card absence-section">
      <div class="sectionHead"><h2>Konten</h2>${yearSwitch(year, 'data-absence-hr-year')}</div>
      <p class="muted">Der Übertrag sind die Resttage aus dem Vorjahr. „Gültig bis“ ist der Tag, nach dem nicht genommene Resttage verfallen.</p>
      ${listSearch('accounts', 'Name, E-Mail oder Personalnummer')}
      ${leftToggle}
      <div class="tableWrap"><table class="table absence-cards">
        <thead><tr><th>Person</th><th>Anspruch</th><th>Übertrag</th><th>Gültig bis</th><th>Genommen</th><th>Geplant</th><th>Rest</th><th></th></tr></thead>
        <tbody>${accounts.map(account => accountRow(account, isDuplicate)).join('')}</tbody>
      </table></div>
      <p class="muted absence-empty-search" data-absence-search-empty="accounts" hidden>Niemanden gefunden.</p>
    </article>`;
  }

  function typeFlag(active, text) {
    return active ? `<span class="tag">${esc(text)}</span>` : '';
  }

  function typeToggle(type) {
    if (type.active && !type.canDisable) return '<small class="muted">bleibt immer aktiv</small>';
    return `<button type="button" class="btn" data-absence-type-toggle="${esc(type.id)}" data-absence-type-active="${type.active ? '1' : '0'}" data-absence-label="${esc(type.name)}">${type.active ? 'Deaktivieren' : 'Aktivieren'}</button>`;
  }

  function typesCard(types) {
    const rows = types.map(type => `<tr${type.active ? '' : ' class="rowInactive"'}>
      <td data-label="Name"><div><b>${esc(type.name)}</b>${type.active ? '' : ' <small class="muted">deaktiviert</small>'}</div></td>
      <td data-label="Regeln" class="absence-flags"><div>
        ${typeFlag(type.countsAgainstBalance, 'zählt aufs Konto')}
        ${typeFlag(type.requiresApproval, 'braucht Genehmigung')}
        ${type.confidential ? '<span class="tag focus">vertraulich</span>' : ''}
      </div></td>
      <td class="absence-card-actions">${typeToggle(type)}</td>
    </tr>`).join('');
    return `<article class="card absence-section">
      <div class="sectionHead"><h2>Abwesenheitsarten</h2><button type="button" class="btn" data-absence-type-add>+ Art</button></div>
      <div class="tableWrap"><table class="table absence-cards"><thead><tr><th>Name</th><th>Regeln</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
  }

  function hrRequestRow(request) {
    const range = formatRange(request.startDate, request.endDate);
    const label = `${request.userName}: ${range}`;
    const decide = request.canDecide
      ? `<button type="button" class="btn" data-absence-decide="${esc(request.id)}" data-absence-decision="approve" data-absence-label="${esc(label)}">Genehmigen</button>
        <button type="button" class="btn" data-absence-decide="${esc(request.id)}" data-absence-decision="reject" data-absence-label="${esc(label)}">Ablehnen</button>`
      : '';
    const cancel = request.canCancel
      ? `<button type="button" class="btn" data-absence-cancel="${esc(request.id)}" data-absence-label="${esc(label)}"${request.cancelNeedsReason ? ' data-absence-cancel-reason="1"' : ''}>Stornieren</button>`
      : '';
    return `<tr data-absence-row="requests" data-search="${esc(searchText(request))}">
      <td data-label="Person"><b>${esc(surnameFirst(request.userName))}</b></td>
      <td data-label="Zeitraum"><div>${esc(range)}${esc(halfNote(request))}</div></td>
      <td data-label="Art">${esc(request.typeName)}</td>
      <td data-label="Arbeitstage">${esc(formatDays(request.days))}</td>
      <td data-label="Status"><div>${statusTag(request)}${statusNotes(request)}</div></td>
      <td class="absence-card-actions">${decide}${cancel}</td>
    </tr>`;
  }

  function requestsCard(year, requests, truncated, limit) {
    const options = [['', 'Alle Status'], ...Object.entries(STATUS_LABELS)]
      .map(([value, label]) => `<option value="${esc(value)}" ${state.hrStatus === value ? 'selected' : ''}>${esc(label)}</option>`)
      .join('');
    const rows = requests.map(hrRequestRow).join('');
    return `<article class="card absence-section">
      <div class="sectionHead"><h2>Alle Anträge ${esc(year)}</h2>${yearSwitch(year, 'data-absence-hr-year')}</div>
      <div class="absence-actions absence-section-actions">
        <select id="absenceHrStatus" aria-label="Nach Status filtern">${options}</select>
        <button type="button" class="btn" data-absence-hr-new="sick">+ Krankmeldung</button>
        <button type="button" class="btn primary" data-absence-hr-new>+ Abwesenheit</button>
      </div>
      ${rows ? listSearch('requests', 'Name, E-Mail oder Personalnummer') : ''}
      ${truncated ? `<p class="absence-notice">Es werden die neuesten ${esc(limit)} Anträge gezeigt. Wähle einen Status oder ein Jahr, um die Liste einzugrenzen.</p>` : ''}
      ${rows ? `<div class="tableWrap"><table class="table absence-cards"><thead><tr><th>Person</th><th>Zeitraum</th><th>Art</th><th>Arbeitstage</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ui.empty('Keine Anträge gefunden.')}
      <p class="muted absence-empty-search" data-absence-search-empty="requests" hidden>Niemanden gefunden.</p>
    </article>`;
  }

  const exportScope = month => api(`/api/absence/export/scope?month=${encodeURIComponent(month)}`);

  async function exportCard() {
    const month = shiftMonth(todayInGermany().slice(0, 7), -1);
    const { note } = await exportScope(month);
    return `<article class="card absence-section">
      <h2>Export für die Lohnabrechnung</h2>
      <p class="muted">Genehmigte Abwesenheiten eines Monats als CSV-Datei, die sich in Tabellenprogrammen öffnen lässt. Kommentare stehen nicht darin.</p>
      <p class="absence-notice" id="absenceExportNote"${note ? '' : ' hidden'}>${esc(note || '')}</p>
      <div class="absence-actions">
        <input id="absenceExportMonth" type="month" value="${esc(month)}" aria-label="Monat">
        <a class="btn" id="absenceExportLink" href="/api/absence/export?month=${esc(month)}" download>CSV herunterladen</a>
      </div>
    </article>`;
  }

  function hrSections(me) {
    const sections = [
      { key: 'requests', label: 'Anträge' },
      { key: 'accounts', label: 'Konten' },
      { key: 'export', label: 'Export' }
    ];
    if (isFullHr(me)) sections.push({ key: 'holidays', label: 'Feiertage' }, { key: 'settings', label: 'Arten und Voreinstellungen' });
    return sections;
  }

  function sectionTabs(sections, active) {
    return `<nav class="admin-tabs absence-tabs" aria-label="Bereiche der HR-Verwaltung">
      ${sections.map(section => `<button type="button" data-absence-section="${esc(section.key)}" class="${section.key === active ? 'active' : ''}" ${section.key === active ? 'aria-current="true"' : ''}>${esc(section.label)}</button>`).join('')}
    </nav>`;
  }

  /** Jeder Bereich lädt nur, was er zeigt. So kostet das Blättern im Jahr nur, wenn es wirklich gebraucht wird. */
  const hrSectionContent = {
    async requests(year) {
      const statusQuery = state.hrStatus ? `&status=${encodeURIComponent(state.hrStatus)}` : '';
      const [{ requests, truncated, limit }, { types, approval }] = await Promise.all([
        api(`/api/absence/requests?scope=all&year=${encodeURIComponent(year)}${statusQuery}`),
        api('/api/absence/types')
      ]);
      state.types = types;
      state.approval = approval;
      return requestsCard(year, requests, truncated, limit);
    },
    async accounts(year) {
      const { accounts } = await api(`/api/absence/accounts?year=${encodeURIComponent(year)}`);
      state.accounts = accounts;
      return accountsCard(year, accounts);
    },
    export: exportCard,
    async holidays(year) {
      const holidays = await api(`/api/absence/holidays?year=${encodeURIComponent(year)}`);
      state.holidayState = holidays.state;
      return holidaysCard(year, holidays);
    },
    async settings() {
      const [{ settings }, { types }] = await Promise.all([api('/api/absence/settings'), api('/api/absence/types?all=1')]);
      return `${settingsCard(settings)}${typesCard(types)}`;
    }
  };

  async function hrPage() {
    const me = window.loop.me;
    const sections = hrSections(me);
    if (!sections.some(section => section.key === state.hrSection)) state.hrSection = sections[0].key;
    const year = state.hrYear || currentYear();
    const content = await hrSectionContent[state.hrSection](year);
    const subtitle = isFullHr(me) ? 'Anträge, Konten, Export, Feiertage und Arten.' : 'Anträge, Konten und der Monatsexport.';
    return `${ui.header('Abwesenheit verwalten', subtitle)}${sectionTabs(sections, state.hrSection)}${content}`;
  }

  function accountModal(userId) {
    const account = state.accounts.find(item => item.userId === userId);
    if (!account) return;
    const manualCarryover = account.carryoverAutomatic ? '' : account.carryoverDays;
    const last = account.correction ? `<p class="muted">${esc(correctionText(account.correction))}</p>` : '';
    ui.modal({
      title: `Konto ${account.year} anpassen`,
      subtitle: account.userName,
      body: `${last}<div class="two">
          <div><label>Anspruch (Tage)</label><input name="entitlementDays" type="number" min="0" max="366" step="0.5" required value="${esc(account.entitlementDays)}"></div>
          <div><label>Übertrag (Tage)</label><input name="carryoverDays" type="number" min="0" max="366" step="0.5" value="${esc(manualCarryover)}" placeholder="automatisch"></div>
        </div>
        <label>Übertrag verfällt am</label><input name="carryoverExpires" type="date" value="${esc(account.carryoverExpires || '')}">
        <p class="muted">Bleibt der Übertrag leer, kommt er automatisch aus dem Rest des Vorjahres. Ohne Datum verfällt er nicht.</p>
        <label>Grund der Anpassung (Pflicht)</label><textarea name="reason" maxlength="500" required></textarea>
        <p class="muted">Die Person bekommt dazu einen Hinweis und sieht den Grund.</p>`,
      onSubmit: async data => {
        await send(`/api/absence/accounts/${encodeURIComponent(userId)}/${encodeURIComponent(account.year)}`, 'PUT', data);
        ui.toast('Konto gespeichert.');
        refresh();
      }
    });
  }

  /** Wer eine genehmigte Abwesenheit einer anderen Person absagt, nennt den Grund. Sie bekommt ihn als Hinweis. */
  function cancelWithReasonModal(id, label) {
    ui.modal({
      title: 'Genehmigte Abwesenheit stornieren',
      subtitle: label || '',
      submitLabel: 'Stornieren',
      body: `<label>Grund (Pflicht)</label><textarea name="reason" maxlength="500" required></textarea>
        <p class="muted">Die Person hat damit geplant und bekommt den Grund als Hinweis.</p>`,
      onSubmit: async data => {
        await send(`/api/absence/requests/${encodeURIComponent(id)}/cancel`, 'POST', data);
        ui.toast('Storniert. Die Person bekommt einen Hinweis.');
        refresh();
      }
    });
  }

  function holidayModal() {
    ui.modal({
      title: 'Eigenen Tag ergänzen',
      subtitle: 'Dieser Tag zählt für alle nicht als Arbeitstag.',
      body: '<label>Datum</label><input name="date" type="date" required><label>Name</label><input name="name" maxlength="80" required>',
      onSubmit: async data => {
        await send('/api/absence/holidays', 'POST', data);
        ui.toast('Tag ergänzt.');
        refresh();
      }
    });
  }

  function typeModal() {
    ui.modal({
      title: 'Abwesenheitsart ergänzen',
      body: `<label>Name</label><input name="name" maxlength="80" required>
        <label class="checkRow"><input type="checkbox" name="requiresApproval" checked> Braucht eine Genehmigung</label>
        <label class="checkRow"><input type="checkbox" name="countsAgainstBalance"> Zählt gegen das Urlaubskonto</label>
        <label class="checkRow"><input type="checkbox" name="confidential"> Vertraulich: Nur die Person und HR sehen die Art</label>
        <p class="muted">Vertrauliche Arten entscheidet nur HR, und es gibt dort kein Kommentarfeld.</p>`,
      onSubmit: async data => {
        await send('/api/absence/types', 'POST', data);
        ui.toast('Art ergänzt.');
        refresh();
      }
    });
  }

  async function importHolidays(year) {
    if (!state.holidayState) {
      ui.toast('Bitte wähle und speichere zuerst das Bundesland unter „Arten und Voreinstellungen“.', 'error');
      return;
    }
    if (!confirm(`Gesetzliche Feiertage für ${year} einspielen? Bereits eingespielte gesetzliche Tage dieses Jahres werden ersetzt, eigene Tage bleiben.`)) return;
    try {
      const result = await send('/api/absence/holidays/import', 'POST', { year });
      ui.toast(`${ui.plural(result.imported, 'Feiertag', 'Feiertage')} eingespielt.`);
      refresh();
    } catch (error) {
      ui.toast(error.message, 'error');
    }
  }

  async function saveSettings(form) {
    const data = new FormData(form);
    const error = form.querySelector('#absenceSettingsError');
    const submit = form.querySelector('button');
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = '';
    try {
      await send('/api/absence/settings', 'PUT', {
        defaultEntitlementDays: data.get('defaultEntitlementDays'),
        carryoverExpiryDay: expiryForServer(data.get('carryoverExpiryDay')),
        state: data.get('state'),
        autoCarryover: form.elements.autoCarryover.checked
      });
      ui.toast('Voreinstellungen gespeichert.');
      refresh();
    } catch (saveError) {
      error.textContent = saveError.message;
    } finally {
      submit.disabled = false;
    }
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

  function bind() {
    // Am Handy gibt es kein Zeigen. Antippen zeigt denselben Text.
    if (window.matchMedia?.('(pointer:coarse)').matches) {
      document.querySelectorAll('td[title][aria-label]').forEach(cell => {
        cell.onclick = () => ui.toast(cell.title);
      });
    }
    bindAll('[data-absence-new]', button => { button.onclick = () => requestModal(); });
    bindAll('[data-absence-sick]', button => { button.onclick = sickModal; });
    bindAll('[data-absence-year]', button => {
      button.onclick = () => {
        state.year = Number(button.dataset.absenceYear);
        refresh();
      };
    });
    bindAll('[data-absence-hr-year]', button => {
      button.onclick = () => {
        state.hrYear = Number(button.dataset.absenceHrYear);
        refresh();
      };
    });
    bindAll('[data-absence-section]', button => {
      button.onclick = () => {
        state.hrSection = button.dataset.absenceSection;
        refresh();
      };
    });
    bindAll('[data-absence-month]', button => {
      button.onclick = () => {
        state.month = button.dataset.absenceMonth;
        refresh();
      };
    });
    bindAll('[data-absence-show-month]', button => {
      button.onclick = () => {
        state.month = button.dataset.absenceShowMonth;
        state.jumpToCalendar = true;
        refresh();
      };
    });
    bindAll('[data-absence-review]', button => {
      button.onclick = guarded(async () => {
        // Ist der Antrag nicht mehr zu lesen, bleibt immer noch die Liste der offenen Anträge.
        const found = await api(`/api/absence/requests/${encodeURIComponent(button.dataset.absenceReview)}`).catch(() => null);
        if (found?.request?.startDate) state.month = found.request.startDate.slice(0, 7);
        window.loop.navigate('absenceTeam');
      });
    });
    bindAll('[data-absence-correction]', button => {
      button.onclick = guarded(async () => {
        await send(`/api/absence/requests/${encodeURIComponent(button.dataset.absenceCorrection)}/correction`, 'POST');
        ui.toast('HR hat deine Bitte bekommen.');
        refresh();
      });
    });
    bindAll('[data-absence-correction-open]', button => {
      button.onclick = guarded(async () => {
        const { request } = await api(`/api/absence/requests/${encodeURIComponent(button.dataset.absenceCorrectionOpen)}`);
        state.hrSection = 'requests';
        state.hrStatus = '';
        state.hrYear = Number(request.startDate.slice(0, 4));
        state.searches.requests = request.userName;
        window.loop.navigate('absenceHr');
      });
    });
    bindAll('[data-absence-cancel]', button => {
      button.onclick = guarded(async () => {
        if (button.dataset.absenceCancelReason === '1') {
          cancelWithReasonModal(button.dataset.absenceCancel, button.dataset.absenceLabel);
          return;
        }
        if (!confirm(`Abwesenheit ${button.dataset.absenceLabel} wirklich stornieren?`)) return;
        await send(`/api/absence/requests/${encodeURIComponent(button.dataset.absenceCancel)}/cancel`, 'POST');
        ui.toast('Storniert.');
        refresh();
      });
    });
    bindAll('[data-absence-decide]', button => {
      button.onclick = () => decisionModal(button.dataset.absenceDecide, button.dataset.absenceDecision, button.dataset.absenceLabel);
    });
    bindAll('[data-absence-task-done]', button => {
      button.onclick = guarded(async () => {
        await send(`/api/absence/tasks/${encodeURIComponent(button.dataset.absenceTaskDone)}/done`, 'POST');
        refresh();
      });
    });
    bindAll('[data-absence-account-edit]', button => {
      button.onclick = () => accountModal(Number(button.dataset.absenceAccountEdit));
    });
    bindAll('[data-absence-holiday-add]', button => { button.onclick = holidayModal; });
    bindAll('[data-absence-holiday-delete]', button => {
      button.onclick = guarded(async () => {
        if (!confirm(`${button.dataset.absenceLabel} entfernen? Der Tag zählt dann wieder als Arbeitstag.`)) return;
        await api(`/api/absence/holidays/${encodeURIComponent(button.dataset.absenceHolidayDelete)}`, { method: 'DELETE' });
        refresh();
      });
    });
    bindAll('[data-absence-import]', button => {
      button.onclick = () => importHolidays(Number(button.dataset.absenceImport));
    });
    bindAll('[data-absence-type-add]', button => { button.onclick = typeModal; });
    bindAll('[data-absence-type-toggle]', button => {
      button.onclick = guarded(async () => {
        const isActive = button.dataset.absenceTypeActive === '1';
        if (isActive && !confirm(`Art „${button.dataset.absenceLabel}“ wirklich deaktivieren? Danach kann sie niemand mehr neu wählen. Bestehende Einträge bleiben.`)) return;
        await send(`/api/absence/types/${encodeURIComponent(button.dataset.absenceTypeToggle)}`, 'PATCH', { active: !isActive });
        refresh();
      });
    });
    bindAll('[data-absence-hr-new]', button => {
      button.onclick = guarded(async () => {
        const year = state.hrYear || currentYear();
        const { accounts } = await api(`/api/absence/accounts?year=${encodeURIComponent(year)}`);
        requestModal({ people: accounts, hrMode: true, presetCode: button.dataset.absenceHrNew || null });
      });
    });

    bindAll('[data-absence-search]', input => {
      const listKey = input.dataset.absenceSearch;
      input.oninput = () => {
        state.searches[listKey] = input.value;
        applyListFilter(listKey);
      };
      applyListFilter(listKey);
    });
    const showLeft = document.querySelector('#absenceShowLeft');
    if (showLeft) {
      showLeft.onchange = () => {
        state.showLeft = showLeft.checked;
        applyListFilter('accounts');
      };
    }
    const status = document.querySelector('#absenceHrStatus');
    if (status) {
      status.onchange = () => {
        state.hrStatus = status.value;
        refresh();
      };
    }
    const settingsForm = document.querySelector('#absenceSettingsForm');
    if (settingsForm) {
      settingsForm.onsubmit = event => {
        event.preventDefault();
        saveSettings(settingsForm);
      };
    }
    const exportMonth = document.querySelector('#absenceExportMonth');
    const exportLink = document.querySelector('#absenceExportLink');
    if (exportMonth && exportLink) {
      const exportNote = document.querySelector('#absenceExportNote');
      exportMonth.onchange = guarded(async () => {
        const month = exportMonth.value;
        if (!month) return;
        exportLink.href = `/api/absence/export?month=${encodeURIComponent(month)}`;
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
    if (state.jumpToCalendar) {
      state.jumpToCalendar = false;
      document.querySelector('#absenceCalendarCard')?.scrollIntoView({ block: 'start' });
    }
  }

  window.loop.registerModule({
    key: 'absence',
    label: 'Abwesenheit',
    nav(me) {
      return [{ route: me.role === 'super_admin' ? 'absenceHr' : 'absenceHome', label: 'Abwesenheit', group: 'time', views: VIEWS }];
    },
    pages: { absenceHome: homePage, absenceTeam: teamPage, absenceHr: hrPage },
    allowed(view, me) {
      if (view === 'absenceHr') return isHrPerson(me);
      // Das technische Systemkonto hat kein eigenes Urlaubskonto.
      if (view === 'absenceHome') return me.role !== 'super_admin';
      return true;
    },
    tabs(view, me) {
      if (!VIEWS.includes(view)) return [];
      const tabs = [];
      // Das technische Systemkonto hat kein eigenes Urlaubskonto.
      if (me.role !== 'super_admin') tabs.push({ route: 'absenceHome', label: 'Mein Bereich', active: view === 'absenceHome' });
      tabs.push({ route: 'absenceTeam', label: 'Team', active: view === 'absenceTeam' });
      if (isHrPerson(me)) tabs.push({ route: 'absenceHr', label: 'HR', active: view === 'absenceHr' });
      return tabs;
    },
    bind,
    taskAction(task) {
      if (task.type === 'absence_approval') return `<button class="btn primary" data-absence-review="${esc(task.entity_id)}">Prüfen</button>`;
      if (task.type === 'absence_correction_notice') {
        return `<button class="btn primary" data-absence-correction-open="${esc(task.entity_id)}">Öffnen</button> <button class="btn" data-task-done="${esc(task.id)}">Erledigt</button>`;
      }
      const done = `<button class="btn" data-absence-task-done="${esc(task.id)}">Erledigt</button>`;
      if (task.type === 'absence_decided') return `<button class="btn" data-view="absenceHome">Ansehen</button> ${done}`;
      if (task.type === 'absence_info') {
        // Betrifft es die Person selbst, steht der Grund in ihrer eigenen Liste. Die Führungskraft plant mit dem Kalender.
        const aboutMe = /^(Deine|Für dich)/.test(task.title || '');
        return `<button class="btn" data-view="${aboutMe ? 'absenceHome' : 'absenceTeam'}">${aboutMe ? 'Ansehen' : 'Zum Kalender'}</button> ${done}`;
      }
      if (task.type === 'absence_account_notice') return `<button class="btn" data-view="absenceHome">Ansehen</button> <button class="btn" data-task-done="${esc(task.id)}">Erledigt</button>`;
      return '';
    }
  });
})();
