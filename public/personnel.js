// Personalakte: Meine Daten, Übersicht für HR, Akte einer Person, Datenauskunft und Abteilungen.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  // Die Sachbearbeitung arbeitet in der Akte mit, pflegt aber nicht den Aufbau des Unternehmens.
  const HR_OPERATOR_ROLES = ['hr_admin', 'hrbp', 'hr_staff', 'super_admin'];
  const UNIT_ADMIN_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const HR_VIEWS = ['personnelPeople', 'personnelPerson', 'personnelUnits', 'personnelExport'];
  const STATUS_FILTERS = [
    ['', 'Aktiv'],
    ['exit_planned', 'Austritt geplant'],
    ['left', 'Ausgetreten'],
    ['locked', 'Gesperrt'],
    ['all', 'Alle']
  ];
  const DEADLINE_FILTERS = [
    ['', 'Alle'],
    ['fixed_term_90', 'Befristung endet in 90 Tagen'],
    ['probation_30', 'Probezeit endet in 30 Tagen'],
    ['exits', 'Austritte']
  ];
  const DATASHEET_FILTERS = [
    ['', 'Alle'],
    ['missing', 'Ohne Datenblatt']
  ];
  const DEADLINE_LABELS = { fixed_term: 'Befristung endet', probation: 'Probezeit endet' };
  const TASK_TYPES = ['personnel_offboarding', 'personnel_deadline'];
  const SEARCH_DELAY_MS = 200;
  // Wird das Stichwort „Austrittsdatum“ an einer Stelle anders erklärt als hier, stimmt die Sperre nicht mehr.
  const EXIT_DATE_LABEL = 'Austrittsdatum (letzter Arbeitstag)';

  // Zustand der geöffneten Seite. Er lebt nur im Browser der angemeldeten Person.
  const state = {
    selectedUserId: null,
    sheet: null,
    units: [],
    filters: { q: '', orgUnitId: '', status: '', deadline: '', datasheet: '' }
  };
  let searchTimer = null;
  let latestSearch = 0;

  const isHrRole = person => HR_OPERATOR_ROLES.includes(person.role);
  const mayManageUnits = person => UNIT_ADMIN_ROLES.includes(person.role);
  const send = (url, method, body = {}) => api(url, { method, body: JSON.stringify(body) });
  const personUrl = (userId, suffix = '') => `/api/personnel/${encodeURIComponent(userId)}${suffix}`;
  const refresh = () => window.loop.navigate(window.loop.view);

  // ------------------------------------------------------------------
  // Darstellung
  // ------------------------------------------------------------------

  const orDash = value => (value === null || value === undefined || value === '' ? '–' : value);
  const formatDate = isoDate => (isoDate ? isoDate.split('-').reverse().join('.') : '–');
  const formatHours = hours => (hours === null || hours === undefined ? '–' : String(hours).replace('.', ','));
  const unitName = unit => {
    if (!unit) return '–';
    return unit.active ? unit.name : `${unit.name} (deaktiviert)`;
  };

  function formatDateTime(isoMoment) {
    if (!isoMoment) return '–';
    return new Date(isoMoment).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });
  }

  /** Heutiger Kalendertag in Deutschland, derselbe Maßstab wie auf dem Server. */
  function todayInGermany() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function facts(entries) {
    const items = entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('');
    return `<dl class="personnel-facts">${items}</dl>`;
  }

  function businessFacts(business) {
    return facts([
      ['Personalnummer', orDash(business.personnelNumber)],
      ['Beschäftigungsart', orDash(business.employmentTypeLabel)],
      ['Vertragsart', orDash(business.contractTypeLabel)],
      ['Eintrittsdatum', formatDate(business.entryDate)],
      ...(business.rehireDate ? [['Wiedereintritt', formatDate(business.rehireDate)]] : []),
      ['Befristungsende', formatDate(business.fixedTermEnd)],
      ['Probezeitende', formatDate(business.probationEnd)],
      ['Wochenstunden', formatHours(business.weeklyHours)],
      ['Abteilung', unitName(business.orgUnit)],
      ['Standort', unitName(business.location)],
      ['Kostenstelle', unitName(business.costCenter)]
    ]);
  }

  const COST_CENTER_HINT = 'Die Kostenstelle ist die Nummer, unter der die Buchhaltung die Personalkosten führt.';

  function privateFacts(privateData) {
    return facts([
      ['Geburtsdatum', formatDate(privateData.birthDate)],
      ['Private Anschrift', orDash(privateData.privateAddress)],
      ['Private Telefonnummer', orDash(privateData.privatePhone)],
      ['Notfallkontakt', orDash(privateData.emergencyContact)]
    ]);
  }

  const statusTag = (status, label) => `<span class="tag ${status === 'active' ? '' : 'focus'}">${esc(label)}</span>`;

  function changeField(field) {
    const replaced = field.replacedOn
      ? ` <span class="tag focus">Gilt nur bis zur jüngeren Änderung vom ${esc(formatDate(field.replacedOn))}</span>`
      : '';
    return `<div><b>${esc(field.label)}:</b> ${esc(field.oldText)} → ${esc(field.newText)}${replaced}</div>`;
  }

  // „Austritt ab“ klänge, als begänne er dort. Der Austritt bezeichnet den letzten Arbeitstag.
  function changeHeading(change) {
    if (change.kind === 'exit') return `Austritt: letzter Arbeitstag ${formatDate(change.effectiveDate)}`;
    if (change.kind === 'rehire') return `Wiedereintritt am ${formatDate(change.effectiveDate)}`;
    return `${change.kindLabel} ab ${formatDate(change.effectiveDate)}`;
  }

  function changeEntry(change) {
    const recorded = change.recordedAt
      ? `<small class="muted">Erfasst am ${esc(formatDateTime(change.recordedAt))}${change.recordedBy ? ` von ${esc(change.recordedBy)}` : ''}</small>`
      : '';
    const reason = change.reason ? `<div class="muted">Grund: ${esc(change.reason)}</div>` : '';
    const cancelled = change.status === 'cancelled'
      ? `<small class="muted">Zurückgenommen${change.cancelledBy ? ` von ${esc(change.cancelledBy)}` : ''}${change.cancelNote ? `: ${esc(change.cancelNote)}` : ''}</small>`
      : '';
    const cancelButton = change.canCancel
      ? `<button type="button" class="btn" data-personnel-cancel-change="${esc(change.id)}">Zurücknehmen</button>`
      : '';
    return `<div class="personnel-change">
      <div class="personnel-change-head">
        <b>${esc(changeHeading(change))}</b>
        ${statusTag(change.status === 'applied' ? 'active' : 'other', change.statusLabel)}
        <span class="grow"></span>
        ${cancelButton}
      </div>
      ${change.fields.map(changeField).join('')}
      ${reason}
      ${recorded}
      ${cancelled}
    </div>`;
  }

  /** Privates bleibt ohne Inhalt: Der Verlauf sagt, dass sich die Anschrift geändert hat, nicht wie sie lautet. */
  function masterField(field) {
    if (field.newText === undefined) return `<div><b>${esc(field.label)}</b> wurde geändert</div>`;
    return `<div><b>${esc(field.label)}:</b> ${esc(field.oldText)} → ${esc(field.newText)}</div>`;
  }

  function masterEntry(change) {
    const isOwnFile = state.sheet?.person.id === window.loop.me.id;
    const editor = change.bySelf ? (isOwnFile ? 'dir' : 'der Person selbst') : orDash(change.changedBy);
    return `<div class="personnel-change">
      <div class="personnel-change-head"><b>Angaben geändert</b></div>
      ${change.fields.map(masterField).join('')}
      <small class="muted">Am ${esc(formatDateTime(change.changedAt))} von ${esc(editor)}</small>
    </div>`;
  }

  /** Vertragsänderungen und Stammdaten in einer Liste, das Neueste zuerst. */
  function historyEntries(changes, masterChanges = []) {
    const entries = [
      ...changes.map(change => ({ day: change.effectiveDate, html: changeEntry(change) })),
      ...masterChanges.map(change => ({ day: change.changedAt.slice(0, 10), html: masterEntry(change) }))
    ];
    return entries.sort((first, second) => second.day.localeCompare(first.day)).map(entry => entry.html).join('');
  }

  function historyCard({ changes, masterChanges }) {
    const entries = historyEntries(changes, masterChanges) || ui.empty('Noch keine Änderungen erfasst.');
    return `<article class="card wide"><h2>Verlauf</h2>${entries}</article>`;
  }

  // ------------------------------------------------------------------
  // Meine Daten
  // ------------------------------------------------------------------

  function teamCard(team) {
    if (!team.length) return '';
    const rows = team.map(person => `<tr>
      <td><b>${esc(person.name)}</b><small>${esc(orDash(person.title))}</small></td>
      <td data-label="Abteilung">${esc(unitName(person.orgUnit))}</td>
      <td data-label="Vertrag">${esc(orDash(person.contractTypeLabel))}</td>
      <td data-label="Stunden">${esc(formatHours(person.weeklyHours))}</td>
      <td><button type="button" class="btn" data-personnel-open="${esc(person.id)}">Öffnen</button></td>
    </tr>`).join('');
    return `<article class="card wide">
      <h2>Mein Team</h2>
      <p class="muted">Für dein Team siehst du nur dienstliche Angaben.</p>
      <div class="tableWrap"><table class="table personnel-table">
        <thead><tr><th>Name</th><th>Abteilung</th><th>Vertrag</th><th>Stunden</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </article>`;
  }

  async function myPage() {
    const [{ sheet }, history, { team }] = await Promise.all([
      api('/api/personnel/me'),
      api(personUrl(window.loop.me.id, '/history')),
      api('/api/personnel/team')
    ]);
    state.sheet = sheet;
    const emptyHint = sheet.hasRecord ? '' : ui.empty('HR hat für dich noch keine Daten hinterlegt. Deine Kontaktdaten kannst du trotzdem schon eintragen.');
    // Erlaubt die Organisation HR die eigene Akte, gehört der Weg dorthin auch auf diese Seite.
    const ownFileButton = sheet.permissions.editMaster
      ? `<button type="button" class="btn" data-personnel-open="${esc(sheet.person.id)}">Eigene Akte bearbeiten</button>`
      : '';
    const correctionHint = sheet.permissions.editMaster
      ? 'Deine Organisation erlaubt dir, deine eigene Akte selbst zu ändern. Jede Änderung steht im Verlauf.'
      : 'Stimmt hier etwas nicht? Dann wende dich bitte an HR.';
    return `${ui.header('Meine Daten', 'Was Daybreak über dich und deinen Vertrag gespeichert hat. Anschrift, Telefon und Notfallkontakt kannst du selbst ändern.')}
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead">
            <h2>Dienstliche Angaben</h2>
            ${ownFileButton}
          </div>
          ${emptyHint}
          ${businessFacts(sheet.business)}
          <p class="muted personnel-hint">${esc(correctionHint)} ${esc(COST_CENTER_HINT)}</p>
        </article>
        <article class="card">
          <div class="sectionHead">
            <h2>Private Angaben</h2>
            <button type="button" class="btn" data-personnel-edit-contact>Ändern</button>
          </div>
          ${privateFacts(sheet.private)}
          <p class="muted personnel-hint">Diese Angaben sehen nur du und HR. Dein Geburtsdatum pflegt HR.</p>
        </article>
        ${historyCard(history)}
        ${teamCard(team)}
      </section>`;
  }

  function openOwnContactModal() {
    const data = state.sheet.private;
    ui.modal({
      title: 'Private Angaben ändern',
      subtitle: 'Diese Angaben sehen nur du und HR.',
      body: contactInputs(data),
      onSubmit: async form => {
        await send('/api/personnel/me/contact', 'PATCH', {
          privateAddress: form.privateAddress,
          privatePhone: form.privatePhone,
          emergencyContact: form.emergencyContact
        });
        ui.toast('Deine Angaben sind gespeichert.');
        refresh();
      }
    });
  }

  // ------------------------------------------------------------------
  // Formularbausteine
  // ------------------------------------------------------------------

  const fieldId = name => `personnel-field-${name}`;
  const fieldLabel = (label, name) => `<label for="${esc(fieldId(name))}">${esc(label)}</label>`;
  const textInput = (label, name, value, attributes = '') => `${fieldLabel(label, name)}<input id="${esc(fieldId(name))}" name="${esc(name)}" value="${esc(value ?? '')}" ${attributes}>`;
  const dateInput = (label, name, value, attributes = '') => `${fieldLabel(label, name)}<input id="${esc(fieldId(name))}" type="date" name="${esc(name)}" value="${esc(value ?? '')}" ${attributes}>`;
  const textArea = (label, name, value, attributes = '') => `${fieldLabel(label, name)}<textarea id="${esc(fieldId(name))}" name="${esc(name)}" ${attributes}>${esc(value ?? '')}</textarea>`;

  function optionTags(options, selected) {
    return options.map(option => {
      const isSelected = String(option.value) === String(selected ?? '');
      return `<option value="${esc(option.value)}" ${isSelected ? 'selected' : ''}>${esc(option.label)}</option>`;
    }).join('');
  }

  const selectInput = (label, name, options, selected, attributes = '') => `${fieldLabel(label, name)}<select id="${esc(fieldId(name))}" name="${esc(name)}" ${attributes}>${optionTags(options, selected)}</select>`;

  function contactInputs(data) {
    return `${textArea('Private Anschrift', 'privateAddress', data.privateAddress, 'maxlength="300"')}
      ${textInput('Private Telefonnummer', 'privatePhone', data.privatePhone, 'maxlength="40" inputmode="tel"')}
      ${textArea('Notfallkontakt', 'emergencyContact', data.emergencyContact, 'maxlength="300" placeholder="Name und Telefonnummer"')}`;
  }

  // ------------------------------------------------------------------
  // HR-Übersicht
  // ------------------------------------------------------------------

  function deadlineTags(row) {
    const tags = row.deadlines.map(deadline => `<span class="tag focus">${esc(DEADLINE_LABELS[deadline.kind] || 'Frist')} ${esc(formatDate(deadline.date))}</span>`);
    if (row.exitDate) tags.push(`<span class="tag focus">Austritt ${esc(formatDate(row.exitDate))}</span>`);
    return tags.join(' ');
  }

  /** Die Liste ist nach Nachnamen sortiert, also steht er auch vorn. */
  function sortedName(row) {
    const firstNames = row.name.trim().slice(0, -row.lastName.length).trim();
    return firstNames ? `${row.lastName}, ${firstNames}` : row.lastName;
  }

  function peopleRow(row) {
    const emptyRecord = row.hasRecord ? '' : '<small class="muted">Noch kein Datenblatt</small>';
    const deadlines = deadlineTags(row);
    return `<tr>
      <td><b>${esc(sortedName(row))}</b><small>${esc(orDash(row.title))}</small><small class="personnel-email">${esc(orDash(row.email))}</small>${emptyRecord}</td>
      <td data-label="Personalnr.">${esc(orDash(row.personnelNumber))}</td>
      <td data-label="Abteilung">${esc(unitName(row.orgUnit))}</td>
      <td data-label="Standort">${esc(unitName(row.location))}</td>
      <td data-label="Vertrag">${esc(orDash(row.contractTypeLabel))}</td>
      <td data-label="Status">${statusTag(row.status, row.statusLabel)}</td>
      <td ${deadlines ? 'data-label="Fristen"' : ''}>${deadlines}</td>
      <td><button type="button" class="btn" data-personnel-open="${esc(row.id)}">Öffnen</button></td>
    </tr>`;
  }

  function peopleResults(people) {
    const count = `<p class="muted personnel-count">${esc(ui.plural(people.length, 'Person', 'Personen'))}, sortiert nach Nachnamen</p>`;
    if (!people.length) {
      const hint = state.filters.q ? ' Vielleicht ist die Person ausgetreten oder gesperrt: Stelle den Status auf „Alle“.' : '';
      return ui.empty(`Zu dieser Auswahl gibt es keine Personen.${hint}`);
    }
    return `${count}<div class="tableWrap"><table class="table personnel-table">
        <thead><tr><th>Name</th><th>Personalnr.</th><th>Abteilung</th><th>Standort</th><th>Vertrag</th><th>Status</th><th>Fristen</th><th></th></tr></thead>
        <tbody>${people.map(peopleRow).join('')}</tbody>
      </table></div>`;
  }

  function peopleUrl() {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(state.filters)) {
      if (value) query.set(name, value);
    }
    const queryText = query.toString();
    return `/api/personnel/people${queryText ? `?${queryText}` : ''}`;
  }

  /** Beim Tippen wird nur die Ergebnisliste neu gezeichnet, sonst verlöre das Suchfeld den Fokus. */
  async function showSearchResults() {
    latestSearch += 1;
    const thisSearch = latestSearch;
    const { people } = await api(peopleUrl());
    if (thisSearch !== latestSearch) return;
    const results = document.querySelector('[data-personnel-results]');
    if (!results) return;
    results.innerHTML = peopleResults(people);
    bind();
  }

  function onSearchInput(value) {
    state.filters.q = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      showSearchResults().catch(error => ui.toast(error.message, 'error'));
    }, SEARCH_DELAY_MS);
  }

  function filterCard(units) {
    const unitOptions = [{ value: '', label: 'Alle Einheiten' }, ...units.map(unit => ({
      value: unit.id,
      label: `${unit.name} (${unit.typeLabel})${unit.active ? '' : ', deaktiviert'}`
    }))];
    const asOptions = pairs => pairs.map(([value, label]) => ({ value, label }));
    return `<article class="card personnel-filter-card">
      <div class="personnel-search">
        ${textInput('Suche', 'q', state.filters.q, 'type="search" autocomplete="off" placeholder="Name, E-Mail oder Personalnummer" data-personnel-search')}
      </div>
      <div class="personnel-filters">
        <div>${selectInput('Abteilung oder Standort', 'orgUnitId', unitOptions, state.filters.orgUnitId, 'data-personnel-filter="orgUnitId"')}</div>
        <div>${selectInput('Status', 'status', asOptions(STATUS_FILTERS), state.filters.status, 'data-personnel-filter="status"')}</div>
        <div>${selectInput('Frist', 'deadline', asOptions(DEADLINE_FILTERS), state.filters.deadline, 'data-personnel-filter="deadline"')}</div>
        <div>${selectInput('Datenblatt', 'datasheet', asOptions(DATASHEET_FILTERS), state.filters.datasheet, 'data-personnel-filter="datasheet"')}</div>
      </div>
    </article>`;
  }

  async function peoplePage() {
    const [{ people, summary }, { units }] = await Promise.all([api(peopleUrl()), api('/api/personnel/org-units')]);
    return `${ui.header('Personalakte', 'Stammdaten, Verträge und Austritte an einem Ort.')}
      <section class="personnel-stats">
        ${ui.stat('Aktive Personen', summary.active, '')}
        ${ui.stat('Ohne Datenblatt', summary.withoutRecord, 'noch keine Daten erfasst')}
        ${ui.stat('Befristung endet', summary.fixedTermEnding, 'in den nächsten 90 Tagen')}
        ${ui.stat('Probezeit endet', summary.probationEnding, 'in den nächsten 30 Tagen')}
        ${ui.stat('Austritte geplant', summary.exitsPlanned, '')}
      </section>
      ${filterCard(units)}
      <article class="card personnel-list-card" data-personnel-results>${peopleResults(people)}</article>`;
  }

  // ------------------------------------------------------------------
  // Akte einer Person
  // ------------------------------------------------------------------

  function exitCard(sheet) {
    // Austritte bleiben bei HR. Der Server liefert sie anderen gar nicht erst.
    if (!Object.hasOwn(sheet, 'exit')) return '';
    const { permissions, exit } = sheet;
    const buttons = [];
    if (permissions.recordExit) buttons.push('<button type="button" class="btn" data-personnel-exit>Austritt erfassen</button>');
    if (permissions.cancelExit && exit?.changeId) buttons.push(`<button type="button" class="btn" data-personnel-cancel-change="${esc(exit.changeId)}">Austritt zurücknehmen</button>`);
    if (permissions.rehire) buttons.push('<button type="button" class="btn primary" data-personnel-rehire>Wiedereintritt erfassen</button>');
    if (permissions.dataExport) buttons.push('<button type="button" class="btn" data-personnel-export>Datenauskunft</button>');
    const exitFacts = exit
      ? facts([
        [EXIT_DATE_LABEL, formatDate(exit.date)],
        ['Grund', orDash(exit.reason)],
        ['Erfasst von', orDash(exit.recordedBy)],
        ...(exit.successor ? [['Neue Führungskraft danach', exit.successor.name]] : [])
      ])
      : ui.empty('Es ist kein Austritt erfasst.');
    const lockHint = exit?.status === 'exit_planned'
      ? '<p class="muted personnel-hint">Am letzten Arbeitstag hat die Person noch Zugang. Am Tag danach wird das Konto gesperrt. Bis dahin kannst du den Austritt zurücknehmen.</p>'
      : '';
    const rehireHint = permissions.rehire
      ? '<p class="muted personnel-hint">War der Austritt ein Versehen? Erfasse einen Wiedereintritt mit demselben Datum und nenne den Grund.</p>'
      : '';
    const handoverHint = exit && window.loop.isModuleEnabled('onboarding')
      ? '<p class="muted personnel-hint">Für die Übergabe kannst du unter „Ein- und Austritte“ einen Ablauf starten.</p>'
      : '';
    if (handoverHint) buttons.push('<button type="button" class="btn" data-view="onboardingHome">Ein- und Austritte öffnen</button>');
    return `<article class="card">
      <h2>${permissions.dataExport ? 'Austritt und Auskunft' : 'Austritt'}</h2>
      ${exitFacts}
      ${lockHint}
      ${rehireHint}
      ${handoverHint}
      <div class="personnel-actions">${buttons.join('')}</div>
    </article>`;
  }

  function successorOptions(people, excludedIds, emptyLabel = 'Bitte auswählen') {
    return [{ value: '', label: emptyLabel }, ...people
      .filter(person => !excludedIds.includes(person.id))
      .map(person => ({ value: person.id, label: person.name }))];
  }

  function reassignCard(sheet, people) {
    const relevant = ['exit_planned', 'left', 'locked'].includes(sheet.person.status);
    if (!relevant || (!sheet.directReports?.length && !sheet.ledUnits?.length)) return '';
    const reports = sheet.directReports || [];
    const movable = reports.filter(report => report.canReassign);
    const rows = reports.map(report => (report.canReassign
      ? `<div class="row personnel-reassign">
          <div class="grow"><b>${esc(report.name)}</b><small>${esc(orDash(report.title))}</small></div>
          <select aria-label="Neue Führungskraft für ${esc(report.name)}" data-personnel-reassign-select="${esc(report.id)}">${optionTags(successorOptions(people, [sheet.person.id, report.id]), '')}</select>
          <button type="button" class="btn" data-personnel-reassign="${esc(report.id)}">Zuordnen</button>
        </div>`
      : `<div class="row">
          <div class="grow"><b>${esc(report.name)}</b><small>${esc(orDash(report.title))}</small></div>
          <span class="muted">Das ordnet die HR-Administration neu zu.</span>
        </div>`)).join('');
    const bulk = movable.length > 1
      ? `<div class="row personnel-reassign">
          <div class="grow"><b>Alle auf einmal</b><small>${esc(ui.plural(movable.length, 'Person', 'Personen'))} bekommen dieselbe neue Führungskraft.</small></div>
          <select aria-label="Neue Führungskraft für alle" data-personnel-reassign-all-select>${optionTags(successorOptions(people, [sheet.person.id]), '')}</select>
          <button type="button" class="btn primary" data-personnel-reassign-all>Alle zuordnen</button>
        </div>`
      : '';
    const units = (sheet.ledUnits || []).map(unit => `<div class="row">
      <div class="grow"><b>${esc(unit.name)}</b><small>${esc(unit.typeLabel)}</small></div>
      ${sheet.permissions.manageUnits
    ? '<button type="button" class="btn" data-view="personnelUnits">Leitung ändern</button>'
    : '<span class="muted">Die Leitung ändert die HR-Administration oder ein HR Business Partner.</span>'}
    </div>`).join('');
    const successorNote = sheet.exit?.successor
      ? `<p class="muted">Vorgemerkt: ${esc(sheet.exit.successor.name)} übernimmt am Tag nach dem letzten Arbeitstag. Wenn du hier jemanden zuordnest, gilt das sofort.</p>`
      : '<p class="muted">Offene Anträge und Freigaben gehen sonst an ein Konto, das bald gesperrt ist oder schon gesperrt wurde. Sie ziehen mit, sobald du hier jemanden zuordnest.</p>';
    return `<article class="card wide personnel-reassign-card">
      <h2>Wer übernimmt?</h2>
      <p>Diese Person führt noch andere Personen oder Einheiten.</p>
      ${successorNote}
      ${bulk}
      ${rows}
      ${units}
    </article>`;
  }

  async function personPage() {
    const me = window.loop.me;
    const backView = isHrRole(me) ? 'personnelPeople' : 'personnelMe';
    const backButton = `<button type="button" class="btn" data-view="${esc(backView)}">← Zurück</button>`;
    if (!state.selectedUserId) {
      return `${ui.header('Personalakte', 'Bitte wähle zuerst eine Person aus.', backButton)}`;
    }
    const { sheet } = await api(personUrl(state.selectedUserId));
    state.sheet = sheet;
    const { person, permissions, business } = sheet;
    const history = permissions.viewHistory ? await api(personUrl(person.id, '/history')) : null;
    const needsPeopleList = ['exit_planned', 'left'].includes(person.status) && sheet.directReports?.some(report => report.canReassign);
    const people = needsPeopleList ? (await api('/api/personnel/form-options')).people : [];

    const editButtons = [];
    if (permissions.editMaster) editButtons.push('<button type="button" class="btn" data-personnel-edit-master>Stammdaten bearbeiten</button>');
    if (permissions.recordChange) {
      editButtons.push('<button type="button" class="btn" data-personnel-change="contract">Vertrag ändern</button>');
      editButtons.push('<button type="button" class="btn" data-personnel-change="organization">Organisation ändern</button>');
    }
    const ownSheetHint = isHrRole(me) && person.id === me.id
      ? `<p class="muted personnel-hint">${permissions.editMaster
        ? 'Das ist deine eigene Akte. Deine Organisation erlaubt dir, sie selbst zu ändern. Jede Änderung steht im Verlauf.'
        : 'Das ist deine eigene Akte. Vertrag und Organisation ändert eine andere HR-Person, deine Kontaktdaten änderst du unter „Meine Daten“.'}</p>`
      : '';
    const privateCard = sheet.private
      ? `<article class="card"><h2>Private Angaben</h2>${privateFacts(sheet.private)}<p class="muted personnel-hint">Nur für die Person selbst und HR sichtbar.</p></article>`
      : `<article class="card"><h2>Private Angaben</h2>${ui.empty('Private Angaben sehen nur die Person selbst und HR.')}</article>`;
    const emptyHint = sheet.hasRecord ? '' : ui.empty('Für diese Person gibt es noch kein Datenblatt: HR hat noch keine Personaldaten erfasst.');
    const subtitle = [person.title, person.managerName ? `Führungskraft: ${person.managerName}` : ''].filter(Boolean).join(' · ');

    return `${ui.header(person.name, subtitle, backButton)}
      <p class="personnel-status-line">${statusTag(person.status, person.statusLabel)}</p>
      <section class="cards">
        <article class="card wide">
          <div class="sectionHead">
            <h2>Dienstliche Angaben</h2>
            <div class="personnel-actions">${editButtons.join('')}</div>
          </div>
          ${emptyHint}
          ${businessFacts(business)}
          ${ownSheetHint}
        </article>
        ${privateCard}
        ${reassignCard(sheet, people)}
        ${history ? historyCard(history) : ''}
        ${exitCard(sheet)}
      </section>`;
  }

  function openMasterModal() {
    const { person, business, private: privateData } = state.sheet;
    ui.modal({
      title: 'Stammdaten bearbeiten',
      subtitle: person.name,
      body: `<div class="two">
          <div>${textInput('Personalnummer', 'personnelNumber', business.personnelNumber, 'maxlength="40"')}</div>
          <div>${dateInput('Eintrittsdatum', 'entryDate', business.entryDate)}</div>
        </div>
        ${dateInput('Geburtsdatum', 'birthDate', privateData.birthDate)}
        ${contactInputs(privateData)}
        <p class="muted personnel-hint">Der Verlauf der Akte nennt, welches Feld wann von wem geändert wurde. Private Inhalte stehen dort nicht.</p>`,
      onSubmit: async form => {
        await send(personUrl(person.id, '/master'), 'PATCH', {
          personnelNumber: form.personnelNumber,
          entryDate: form.entryDate,
          birthDate: form.birthDate,
          privateAddress: form.privateAddress,
          privatePhone: form.privatePhone,
          emergencyContact: form.emergencyContact
        });
        ui.toast('Stammdaten gespeichert.');
        refresh();
      }
    });
  }

  function contractChangeInputs(business, options) {
    const withEmpty = list => [{ value: '', label: 'Nicht angegeben' }, ...list];
    return `<div class="two">
        <div>${selectInput('Beschäftigungsart', 'employmentType', withEmpty(options.employmentTypes), business.employmentType)}</div>
        <div>${selectInput('Vertragsart', 'contractType', withEmpty(options.contractTypes), business.contractType, 'data-personnel-contract-type')}</div>
      </div>
      <div class="two">
        <div>${dateInput('Befristungsende', 'fixedTermEnd', business.fixedTermEnd, business.contractType === 'fixed_term' ? '' : 'disabled')}</div>
        <div>${dateInput('Probezeitende', 'probationEnd', business.probationEnd)}</div>
      </div>
      ${textInput('Wochenstunden', 'weeklyHours', business.weeklyHours, 'type="number" step="0.01" min="0.01" max="60"')}`;
  }

  function organizationChangeInputs(business, options) {
    const unitChoices = (types, current) => [
      { value: '', label: 'Nicht angegeben' },
      ...options.units
        .filter(unit => types.includes(unit.type) && (unit.active || unit.id === current?.id))
        .map(unit => ({ value: unit.id, label: `${unit.name}${unit.code ? ` (${unit.code})` : ''}${unit.active ? '' : ', deaktiviert'}` }))
    ];
    return `${selectInput('Abteilung', 'orgUnitId', unitChoices(['department', 'legal_entity'], business.orgUnit), business.orgUnit?.id)}
      ${selectInput('Standort', 'locationId', unitChoices(['location'], business.location), business.location?.id)}
      ${selectInput('Kostenstelle', 'costCenterId', unitChoices(['cost_center'], business.costCenter), business.costCenter?.id)}
      <p class="muted personnel-hint">${esc(COST_CENTER_HINT)}</p>`;
  }

  function initialChangeValues(kind, business) {
    const text = value => (value === null || value === undefined ? '' : String(value));
    if (kind === 'contract') {
      return {
        employmentType: text(business.employmentType),
        contractType: text(business.contractType),
        fixedTermEnd: text(business.fixedTermEnd),
        probationEnd: text(business.probationEnd),
        weeklyHours: text(business.weeklyHours)
      };
    }
    return {
      orgUnitId: text(business.orgUnit?.id),
      locationId: text(business.location?.id),
      costCenterId: text(business.costCenter?.id)
    };
  }

  async function openChangeModal(kind) {
    const options = await api('/api/personnel/form-options');
    const { person, business } = state.sheet;
    const initial = initialChangeValues(kind, business);
    ui.modal({
      title: kind === 'contract' ? 'Vertrag ändern' : 'Organisation ändern',
      subtitle: person.name,
      submitLabel: 'Änderung speichern',
      body: `${kind === 'contract' ? contractChangeInputs(business, options) : organizationChangeInputs(business, options)}
        ${dateInput('Gültig ab', 'effectiveDate', options.today, 'required')}
        ${textArea('Grund', 'reason', '', 'required maxlength="500" placeholder="Zum Beispiel: Vertragsverlängerung oder Versetzung"')}
        <p class="muted personnel-hint">Heute oder ein vergangenes Datum wirkt sofort. Ein zukünftiges Datum wird an diesem Tag automatisch wirksam und lässt sich bis dahin zurücknehmen.</p>
        <div class="personnel-notice" data-personnel-confirm-box hidden>
          <p data-personnel-confirm-text></p>
          <label class="checkRow"><input type="checkbox" name="confirmBackdate"> Ja, in den Verlauf eintragen</label>
        </div>`,
      onSubmit: async (form, formElement) => {
        // Nur Felder senden, die wirklich geändert wurden. Das Formular zeigt den heutigen Stand,
        // eine spätere Änderung darf nicht versehentlich ältere Werte wieder einsetzen.
        const values = {};
        for (const [name, initialValue] of Object.entries(initial)) {
          const value = form[name] ?? '';
          if (value !== initialValue) values[name] = value;
        }
        if (!Object.keys(values).length) throw new Error('Du hast noch nichts geändert.');
        try {
          const result = await send(personUrl(person.id, '/changes'), 'POST', {
            kind,
            effectiveDate: form.effectiveDate,
            reason: form.reason,
            values,
            confirmBackdate: form.confirmBackdate === 'on'
          });
          ui.toast(result.message);
          refresh();
        } catch (error) {
          if (error.code !== 'younger_change_exists') throw error;
          formElement.querySelector('[data-personnel-confirm-box]').hidden = false;
          formElement.querySelector('[data-personnel-confirm-text]').textContent = error.message;
          return true;
        }
        return false;
      }
    });
    const contractType = document.querySelector('[data-personnel-contract-type]');
    if (contractType) {
      contractType.onchange = () => {
        const endDate = contractType.form.elements.fixedTermEnd;
        endDate.disabled = contractType.value !== 'fixed_term';
      };
    }
  }

  /** Führt die Person andere, muss HR entscheiden: Sonst gehen Freigaben an ein gesperrtes Konto. */
  function exitSuccessorField(person, directReports, people) {
    const movable = directReports.filter(report => report.canReassign);
    if (!movable.length) return '';
    const names = movable.map(report => report.name).join(', ');
    const options = [
      { value: '', label: 'Bitte auswählen' },
      { value: 'later', label: 'Noch offen, ich entscheide später' },
      ...successorOptions(people, [person.id]).slice(1)
    ];
    return `<div class="personnel-notice">
        <b>Wer übernimmt?</b>
        <p>${esc(person.name)} führt ${esc(ui.plural(movable.length, 'Person', 'Personen'))} direkt: ${esc(names)}. Offene Anträge und Freigaben gingen sonst an ein gesperrtes Konto.</p>
        ${selectInput('Neue Führungskraft', 'successorManagerId', options, '', 'required')}
        <p class="muted personnel-hint">Sie übernimmt am Tag nach dem letzten Arbeitstag, offene Vorgänge ziehen dann mit. Rückt jemand aus dem Team nach, kommt diese Person selbst auf den frei werdenden Platz.</p>
      </div>`;
  }

  function bindLockNowChoice() {
    const dateField = document.querySelector('[data-personnel-exit-date]');
    const lockNowRow = document.querySelector('[data-personnel-lock-now]');
    if (!dateField || !lockNowRow) return;
    // Nur am letzten Arbeitstag selbst gibt es etwas zu entscheiden: Ein älteres Datum sperrt ohnehin sofort.
    dateField.onchange = () => {
      lockNowRow.hidden = dateField.value !== todayInGermany() || !state.sheet.permissions.exitNow;
      if (lockNowRow.hidden) lockNowRow.querySelector('input').checked = false;
    };
  }

  async function submitExit(person, form, promoteManager = false) {
    const successor = form.successorManagerId && form.successorManagerId !== 'later' ? Number(form.successorManagerId) : null;
    const body = { exitDate: form.exitDate, reason: form.reason, lockNow: form.lockNow === 'on', successorManagerId: successor, promoteManager };
    try {
      return await send(personUrl(person.id, '/exit'), 'POST', body);
    } catch (error) {
      if (error.code !== 'manager_role_required') throw error;
      if (!window.confirm(`${error.message} Soll die Person die Rolle „Führungskraft“ bekommen, sobald sie übernimmt?`)) return null;
      return submitExit(person, form, true);
    }
  }

  async function openExitModal() {
    const { person, directReports = [] } = state.sheet;
    const people = directReports.some(report => report.canReassign) ? (await api('/api/personnel/form-options')).people : [];
    ui.modal({
      title: 'Austritt erfassen',
      subtitle: person.name,
      submitLabel: 'Austritt erfassen',
      body: `<p class="muted">Das Austrittsdatum ist der letzte Arbeitstag. An diesem Tag hat die Person noch Zugang, am Tag danach wird das Konto automatisch gesperrt. Bis dahin kannst du den Austritt zurücknehmen. Liegt das Datum in der Vergangenheit, wird sofort gesperrt. Es werden keine Daten gelöscht.</p>
        ${dateInput(EXIT_DATE_LABEL, 'exitDate', '', 'required data-personnel-exit-date')}
        <label class="checkline personnel-lock-now" data-personnel-lock-now hidden><input type="checkbox" name="lockNow"> Zugang sofort sperren, zum Beispiel bei einer fristlosen Kündigung</label>
        ${textArea('Grund', 'reason', '', 'required maxlength="500"')}
        <p class="muted personnel-hint">Den Grund sehen nur HR-Personen.</p>
        ${exitSuccessorField(person, directReports, people)}`,
      onSubmit: async form => {
        const locksNow = form.exitDate < todayInGermany() || form.lockNow === 'on';
        if (locksNow && !window.confirm(`${person.name} verliert sofort den Zugang. Fortfahren?`)) return true;
        const result = await submitExit(person, form);
        if (!result) return true;
        const reports = result.directReports.length;
        ui.toast(reports && !form.successorManagerId?.match(/^\d+$/)
          ? `${result.message} ${ui.plural(reports, 'direkt unterstellte Person braucht', 'direkt unterstellte Personen brauchen')} eine neue Führungskraft.`
          : result.message);
        refresh();
        return false;
      }
    });
    bindLockNowChoice();
  }

  function openRehireModal() {
    const { person } = state.sheet;
    ui.modal({
      title: 'Wiedereintritt erfassen',
      subtitle: person.name,
      submitLabel: 'Konto wieder freischalten',
      body: `<p class="muted">Das Konto wird sofort wieder nutzbar. Das Eintrittsdatum bleibt der erste Tag im Unternehmen, der Wiedereintritt steht mit seinem eigenen Datum in der Akte und im Verlauf. So bleiben beide Tage sichtbar, zum Beispiel wenn frühere Zeiten für die Betriebszugehörigkeit zählen.</p>
        ${dateInput('Wiedereintritt am', 'rehireDate', todayInGermany(), 'required')}
        ${textArea('Grund', 'reason', '', 'required maxlength="500"')}`,
      onSubmit: async form => {
        const result = await send(personUrl(person.id, '/rehire'), 'POST', { rehireDate: form.rehireDate, reason: form.reason });
        ui.toast(result.message);
        refresh();
      }
    });
  }

  function downloadAsFile(fileName, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadTechnicalExport(person) {
    const report = await api(personUrl(person.id, '/data-export'));
    downloadAsFile(`datenauskunft-${person.id}-${todayInGermany()}.json`, report);
    ui.toast('Die Datei ist erstellt und der Abruf protokolliert.');
  }

  function openExportModal() {
    const { person } = state.sheet;
    ui.modal({
      title: 'Datenauskunft',
      subtitle: person.name,
      submitLabel: 'Lesbare Fassung öffnen',
      body: `<div class="personnel-notice">
          <b>Bitte vor der Weitergabe prüfen</b>
          <p>Planungs- und Bewertungsdaten wie Nachfolge oder Gehaltsvorschläge sind gesondert gekennzeichnet. Kläre vor der Weitergabe, ob sie herauszugeben sind.</p>
          <p>Die Auskunft kann Daten anderer Personen enthalten, zum Beispiel Namen in Kommentaren oder von Führungskräften. Prüfe sie und schwärze solche Angaben, bevor du sie weitergibst.</p>
          <p>Hinweis, bitte im Einzelfall prüfen: Daybreak ersetzt keine Rechtsberatung. Was du herausgeben oder schwärzen musst, hängt vom einzelnen Fall ab. Frag im Zweifel die Person, die bei euch für den Datenschutz zuständig ist.</p>
        </div>
        <p class="muted">Enthalten ist alles, was Daybreak direkt zu dieser Person speichert, und ihr Benutzerkonto ohne Passwort. Einträge, in denen sie nur als Autorin oder Führungskraft einer anderen Person vorkommt, und das Änderungsprotokoll sind nicht enthalten. Jeder Abruf wird protokolliert.</p>
        <p class="muted">Die lesbare Fassung kannst du drucken oder als PDF speichern. Für Fachleute gibt es auch alle Rohdaten: <button type="button" class="btn" data-personnel-export-file>Technische Datei herunterladen (JSON)</button></p>`,
      onSubmit: async () => {
        window.loop.navigate('personnelExport');
      }
    });
    const fileButton = document.querySelector('[data-personnel-export-file]');
    if (fileButton) {
      fileButton.onclick = () => downloadTechnicalExport(person).catch(error => ui.toast(error.message, 'error'));
    }
  }

  function exportEntry(fields) {
    const items = fields.map(field => `<div><dt>${esc(field.label)}</dt><dd>${esc(field.value)}</dd></div>`).join('');
    return `<dl class="personnel-export-entry">${items}</dl>`;
  }

  function exportSection(section) {
    const review = section.reviewBeforeRelease ? '<span class="tag focus">Vor der Weitergabe gesondert prüfen</span>' : '';
    return `<section class="card personnel-export-section">
      <div class="personnel-change-head"><h2>${esc(section.title)}</h2>${review}</div>
      ${section.entries.map(exportEntry).join('')}
    </section>`;
  }

  async function exportPage() {
    const back = '<button type="button" class="btn personnel-no-print" data-view="personnelPerson">← Zurück zur Akte</button>';
    if (!state.selectedUserId) return ui.header('Datenauskunft', 'Bitte wähle zuerst eine Person aus.', back);
    const report = await api(personUrl(state.selectedUserId, '/data-export/readable'));
    const { meta, sections } = report;
    const actions = `${back} <button type="button" class="btn primary personnel-no-print" data-personnel-print>Drucken oder als PDF speichern</button>`;
    const organization = meta.organization ? `${meta.organization}, ` : '';
    return `<div class="personnel-export">
      ${ui.header(`Datenauskunft: ${meta.person.name}`, `${organization}erstellt am ${meta.exportedAtText} von ${meta.exportedBy.name}`, actions)}
      <section class="personnel-notice personnel-no-print">
        <b>Vor der Weitergabe prüfen</b>
        <p>${esc(meta.notice)}</p>
      </section>
      <p class="muted">${esc(meta.scope)}</p>
      ${sections.map(exportSection).join('') || ui.empty('Zu dieser Person ist nichts gespeichert.')}
    </div>`;
  }

  // ------------------------------------------------------------------
  // Organisationseinheiten
  // ------------------------------------------------------------------

  /** Reihenfolge für die Baumansicht: jede Einheit steht direkt unter ihrer übergeordneten. */
  function unitsInTreeOrder(units) {
    const childrenOf = new Map();
    for (const unit of units) {
      const siblings = childrenOf.get(unit.parentId ?? null) || [];
      siblings.push(unit);
      childrenOf.set(unit.parentId ?? null, siblings);
    }
    const ordered = [];
    const seen = new Set();
    const visit = (parentId, depth) => {
      for (const unit of childrenOf.get(parentId) || []) {
        if (seen.has(unit.id)) continue;
        seen.add(unit.id);
        ordered.push({ unit, depth });
        visit(unit.id, depth + 1);
      }
    };
    visit(null, 0);
    return ordered;
  }

  function unitRow({ unit, depth }, mayEdit) {
    const leader = unit.leader ? `${unit.leader.name}${unit.leader.active ? '' : ' (nicht mehr aktiv)'}` : '–';
    const toggleLabel = unit.active ? 'Deaktivieren' : 'Aktivieren';
    const actions = mayEdit
      ? `<div class="personnel-actions">
          <button type="button" class="btn" data-personnel-unit-edit="${esc(unit.id)}">Bearbeiten</button>
          <button type="button" class="btn" data-personnel-unit-toggle="${esc(unit.id)}">${esc(toggleLabel)}</button>
          ${unit.assignedCount ? '' : `<button type="button" class="btn" data-personnel-unit-delete="${esc(unit.id)}">Löschen</button>`}
        </div>`
      : '';
    return `<tr class="${unit.active ? '' : 'personnel-unit-inactive'}">
      <td><span class="personnel-unit-name" style="padding-left:${Number(depth) * 18}px"><b>${esc(unit.name)}</b></span></td>
      <td data-label="Typ">${esc(unit.typeLabel)}</td>
      <td data-label="Kürzel">${esc(orDash(unit.code))}</td>
      <td data-label="Leitung">${esc(leader)}</td>
      <td data-label="Personen">${esc(unit.assignedCount)}</td>
      <td data-label="Status">${statusTag(unit.active ? 'active' : 'other', unit.active ? 'Aktiv' : 'Deaktiviert')}</td>
      <td>${actions}</td>
    </tr>`;
  }

  async function unitsPage() {
    const { units } = await api('/api/personnel/org-units');
    state.units = units;
    const mayEdit = mayManageUnits(window.loop.me);
    const addButton = mayEdit ? '<button type="button" class="btn primary" data-personnel-unit-new>+ Einheit</button>' : '';
    const table = units.length
      ? `<div class="tableWrap"><table class="table personnel-table">
          <thead><tr><th>Name</th><th>Typ</th><th>Kürzel</th><th>Leitung</th><th>Personen</th><th>Status</th><th></th></tr></thead>
          <tbody>${unitsInTreeOrder(units).map(entry => unitRow(entry, mayEdit)).join('')}</tbody>
        </table></div>`
      : ui.empty('Noch keine Einheiten. Lege am besten zuerst deine Gesellschaft an, darunter Abteilungen, Standorte und Kostenstellen.');
    return `${ui.header('Abteilungen und Standorte', `Gesellschaften, Abteilungen, Standorte und Kostenstellen. ${COST_CENTER_HINT}`, addButton)}
      <article class="card personnel-list-card">${table}</article>
      <p class="muted personnel-hint">Einheiten mit zugeordneten Personen lassen sich nur deaktivieren, nicht löschen.</p>`;
  }

  function descendantsOf(unitId, units) {
    const found = new Set([unitId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const unit of units) {
        if (unit.parentId && found.has(unit.parentId) && !found.has(unit.id)) {
          found.add(unit.id);
          grew = true;
        }
      }
    }
    return found;
  }

  async function openUnitModal(unit = null) {
    const options = await api('/api/personnel/form-options');
    const blockedParents = unit ? descendantsOf(unit.id, options.units) : new Set();
    const parentOptions = (type, selected) => {
      const choices = options.units
        .filter(candidate => !blockedParents.has(candidate.id))
        .filter(candidate => candidate.type === type || candidate.type === 'legal_entity')
        .filter(candidate => candidate.active || candidate.id === selected)
        .map(candidate => ({ value: candidate.id, label: `${candidate.name} (${candidate.typeLabel})` }));
      return optionTags([{ value: '', label: 'Keine (oberste Ebene)' }, ...choices], selected);
    };
    const leaderOptions = [{ value: '', label: 'Keine Leitung' }, ...options.people.map(person => ({ value: person.id, label: person.name }))];
    const startType = unit?.type || 'department';
    const typeField = unit
      ? `<label>Typ</label><input value="${esc(unit.typeLabel)}" disabled>`
      : selectInput('Typ', 'type', options.unitTypes, startType, 'data-personnel-unit-type');
    ui.modal({
      title: unit ? 'Einheit bearbeiten' : 'Einheit anlegen',
      body: `${typeField}
        ${textInput('Name', 'name', unit?.name, 'required maxlength="120"')}
        ${textInput('Kürzel oder Nummer', 'code', unit?.code, 'maxlength="40" placeholder="Zum Beispiel die Nummer der Kostenstelle"')}
        ${fieldLabel('Übergeordnete Einheit', 'parentId')}<select id="${esc(fieldId('parentId'))}" name="parentId">${parentOptions(startType, unit?.parentId ?? '')}</select>
        ${selectInput('Leitung', 'leaderUserId', leaderOptions, unit?.leader?.id ?? '')}`,
      onSubmit: async form => {
        const body = { name: form.name, code: form.code, parentId: form.parentId, leaderUserId: form.leaderUserId };
        if (unit) await send(`/api/personnel/org-units/${encodeURIComponent(unit.id)}`, 'PATCH', body);
        else await send('/api/personnel/org-units', 'POST', { ...body, type: form.type });
        ui.toast('Einheit gespeichert.');
        refresh();
      }
    });
    const typeSelect = document.querySelector('[data-personnel-unit-type]');
    if (typeSelect) {
      typeSelect.onchange = () => {
        typeSelect.form.elements.parentId.innerHTML = parentOptions(typeSelect.value, '');
      };
    }
  }

  // ------------------------------------------------------------------
  // Ereignisse
  // ------------------------------------------------------------------

  function openPerson(userId) {
    state.selectedUserId = Number(userId);
    window.loop.navigate('personnelPerson');
  }

  function onClick(selector, handler) {
    document.querySelectorAll(selector).forEach(element => {
      element.onclick = async () => {
        try {
          await handler(element);
        } catch (error) {
          ui.toast(error.message, 'error');
        }
      };
    });
  }

  /** Wer noch nicht als Führungskraft eingetragen ist, bekommt die Rolle erst nach Rückfrage. */
  async function withRoleConsent(request) {
    try {
      return await request(false);
    } catch (error) {
      if (error.code !== 'manager_role_required') throw error;
      if (!window.confirm(`${error.message} Soll die Person die Rolle „Führungskraft“ bekommen?`)) return null;
      return request(true);
    }
  }

  function bind() {
    onClick('[data-personnel-open]', element => openPerson(element.dataset.personnelOpen));
    onClick('[data-personnel-edit-contact]', openOwnContactModal);
    onClick('[data-personnel-edit-master]', openMasterModal);
    onClick('[data-personnel-change]', element => openChangeModal(element.dataset.personnelChange));
    onClick('[data-personnel-exit]', openExitModal);
    onClick('[data-personnel-rehire]', openRehireModal);
    onClick('[data-personnel-export]', openExportModal);

    onClick('[data-personnel-cancel-change]', async element => {
      if (!window.confirm('Diese geplante Änderung wirklich zurücknehmen?')) return;
      await send(personUrl(state.sheet.person.id, `/changes/${encodeURIComponent(element.dataset.personnelCancelChange)}/cancel`), 'POST');
      ui.toast('Zurückgenommen.');
      refresh();
    });

    onClick('[data-personnel-reassign]', async element => {
      const reportId = element.dataset.personnelReassign;
      const managerId = document.querySelector(`[data-personnel-reassign-select="${CSS.escape(reportId)}"]`).value;
      if (!managerId) throw new Error('Bitte wähle eine neue Führungskraft aus.');
      const assign = body => send(`/api/users/${encodeURIComponent(reportId)}/manager`, 'PATCH', body);
      if (!await withRoleConsent(promoteManager => assign({ managerId: Number(managerId), ...(promoteManager ? { promoteManager } : {}) }))) return;
      ui.toast('Neue Führungskraft zugeordnet. Offene Vorgänge ziehen mit.');
      refresh();
    });

    onClick('[data-personnel-reassign-all]', async () => {
      const managerId = document.querySelector('[data-personnel-reassign-all-select]').value;
      if (!managerId) throw new Error('Bitte wähle eine neue Führungskraft aus.');
      const url = personUrl(state.sheet.person.id, '/reassign-reports');
      const result = await withRoleConsent(promoteManager => send(url, 'POST', { managerId: Number(managerId), promoteManager }));
      if (!result) return;
      const moved = ui.plural(result.moved.length, 'Person', 'Personen');
      ui.toast(result.skipped.length
        ? `${moved} zugeordnet. Bei ${result.skipped.map(person => person.name).join(', ')} ging das nicht, bitte einzeln prüfen.`
        : `${moved} zugeordnet. Offene Vorgänge ziehen mit.`);
      refresh();
    });

    document.querySelectorAll('[data-personnel-filter]').forEach(select => {
      select.onchange = () => {
        state.filters[select.dataset.personnelFilter] = select.value;
        refresh();
      };
    });

    document.querySelectorAll('[data-personnel-search]').forEach(input => {
      input.oninput = () => onSearchInput(input.value);
    });

    onClick('[data-personnel-print]', () => window.print());

    const findUnit = element => state.units.find(unit => String(unit.id) === element.dataset.personnelUnitEdit
      || String(unit.id) === element.dataset.personnelUnitToggle
      || String(unit.id) === element.dataset.personnelUnitDelete);
    onClick('[data-personnel-unit-new]', () => openUnitModal());
    onClick('[data-personnel-unit-edit]', element => openUnitModal(findUnit(element)));
    onClick('[data-personnel-unit-toggle]', async element => {
      const unit = findUnit(element);
      await send(`/api/personnel/org-units/${encodeURIComponent(unit.id)}`, 'PATCH', { active: !unit.active });
      ui.toast(unit.active ? 'Einheit deaktiviert.' : 'Einheit aktiviert.');
      refresh();
    });
    onClick('[data-personnel-unit-delete]', async element => {
      const unit = findUnit(element);
      if (!window.confirm(`„${unit.name}“ wirklich löschen?`)) return;
      await api(`/api/personnel/org-units/${encodeURIComponent(unit.id)}`, { method: 'DELETE' });
      ui.toast('Einheit gelöscht.');
      refresh();
    });

    onClick('[data-personnel-task-open]', async element => {
      const { userId } = await api(`/api/personnel/tasks/${encodeURIComponent(element.dataset.personnelTaskOpen)}`);
      openPerson(userId);
    });
    onClick('[data-personnel-task-done]', async element => {
      await send(`/api/personnel/tasks/${encodeURIComponent(element.dataset.personnelTaskDone)}/done`, 'POST');
      ui.toast('Aufgabe erledigt.');
      refresh();
    });
  }

  window.loop.registerAddress?.({
    personnelPerson: { get: () => state.selectedUserId, set: id => { state.selectedUserId = id; } },
    personnelExport: { get: () => state.selectedUserId, set: id => { state.selectedUserId = id; } }
  });

  window.loop.registerModule({
    key: 'personnel',
    label: 'Personalakte',
    nav(me) {
      const items = [];
      // Die Systemadministration ist keine Person und hat deshalb kein eigenes Datenblatt.
      if (me.role !== 'super_admin') {
        items.push({
          route: 'personnelMe',
          label: 'Meine Daten',
          group: 'myWork',
          views: isHrRole(me) ? ['personnelMe'] : ['personnelMe', 'personnelPerson']
        });
      }
      if (isHrRole(me)) items.push({ route: 'personnelPeople', label: 'Personalakte', group: 'hr', views: HR_VIEWS });
      return items;
    },
    pages: {
      personnelMe: myPage,
      personnelPeople: peoplePage,
      personnelPerson: personPage,
      personnelUnits: unitsPage,
      personnelExport: exportPage
    },
    tabs(view, me) {
      // Die Sachbearbeitung hat nur die Personenliste, ein einzelner Reiter wäre sinnlos.
      if (!mayManageUnits(me) || !HR_VIEWS.includes(view)) return [];
      return [
        { route: 'personnelPeople', label: 'Personen', active: view !== 'personnelUnits' },
        { route: 'personnelUnits', label: 'Abteilungen und Standorte', active: view === 'personnelUnits' }
      ];
    },
    bind,
    taskAction(task) {
      if (!TASK_TYPES.includes(task.type)) return '';
      return `<button type="button" class="btn" data-personnel-task-open="${esc(task.id)}">Öffnen</button>
        <button type="button" class="btn" data-personnel-task-done="${esc(task.id)}">Erledigt</button>`;
    }
  });
})();
