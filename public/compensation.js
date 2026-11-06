// Vergütung: eigene Vergütung, Vorschläge der Führungskräfte und der Arbeitsbereich für HR.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const HR_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const HR_VIEWS = ['compensationHome', 'compensationPeople', 'compensationPerson', 'compensationGrades', 'compensationCycles', 'compensationCycle', 'compensationTeam'];
  const ACCESS_MAX_AGE_MS = 5 * 60 * 1000;
  const REASONS = { hire: 'Eintritt', cycle: 'Gehaltsrunde', promotion: 'Beförderung', correction: 'Korrektur', other: 'Sonstiges' };
  const BAND_HINT = '100 % ist die Mitte des Bandes.';

  const state = {
    access: null,
    accessUserId: null,
    accessLoadedAt: 0,
    accessLoading: false,
    personId: null,
    cycleId: null,
    grades: [],
    person: null,
    cycle: null,
    rounds: []
  };

  // Nur zur Anzeige wird durch 100 geteilt. Gerechnet wird ausschließlich auf dem Server in Cent.
  function money(cents, currency = 'EUR') {
    if (cents === null || cents === undefined) return '–';
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100);
  }

  function bandLocation(value) {
    if (value === null || value === undefined) return '–';
    return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value * 100)} %`;
  }

  function percent(value) {
    if (value === null || value === undefined) return '–';
    return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value)} %`;
  }

  const fteLabel = basisPoints => `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(basisPoints / 100)} %`;
  const fteInput = basisPoints => String(basisPoints / 10000).replace('.', ',');
  const dateLabel = iso => (iso ? ui.date(iso) : '–');
  const today = () => new Date().toISOString().slice(0, 10);
  const centsToInput = cents => (cents === null || cents === undefined ? '' : `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`);
  const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
  const reload = () => window.loop.navigate(window.loop.view);
  const increaseText = (proposal, currency) => `${money(proposal.increaseCents, currency)}${proposal.percent !== null ? ` (${percent(proposal.percent)})` : ''}`;
  const showWarnings = (warnings, success) => {
    if (warnings?.length) ui.toast(warnings.map(item => item.message).join(' '), 'error');
    else ui.toast(success);
  };

  function bandTag(metrics) {
    if (metrics.bandStatus === 'above') return '<span class="tag compensationAlert">Über dem Band</span>';
    if (metrics.bandStatus === 'below') return '<span class="tag compensationAlert">Unter dem Band</span>';
    if (metrics.bandStatus === 'no_band') return '<span class="tag focus">Kein Band</span>';
    return '<span class="tag">Im Band</span>';
  }

  /** Am Handy wird aus jeder Zeile eine Karte. Dafür trägt jede Zelle die Überschrift ihrer Spalte. */
  function table(headers, rows) {
    const labelled = rows.map(row => {
      let column = 0;
      return row.replace(/<td\b/g, () => `<td data-label="${esc(headers[column++] || '')}"`);
    });
    return `<div class="tableWrap"><table class="table compensationTable"><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${labelled.join('')}</tbody></table></div>`;
  }

  const cell = value => `<td>${esc(value)}</td>`;

  const note = (text, extraClass = '') => `<p class="compensationNote ${extraClass}">${esc(text)}</p>`;

  // ------------------------------------------------------------------------------------
  // Was darf die angemeldete Person sehen?
  // ------------------------------------------------------------------------------------

  function rememberAccess(me, access) {
    state.access = access;
    state.accessUserId = me.id;
    state.accessLoadedAt = Date.now();
  }

  async function loadAccess() {
    const access = await api('/api/compensation/access');
    rememberAccess(window.loop.me, access);
    return access;
  }

  const hasOwnTeamView = () => Boolean(state.access?.openRounds?.length || state.access?.resultRounds?.length);
  const leaderEntryVisible = () => Boolean(hasOwnTeamView() || state.access?.areaSummary);

  /** Die Navigation wird ohne Warten gezeichnet. Ändert sich danach etwas, zeichnen wir sie einmal neu. */
  function refreshAccessInBackground(me) {
    if (state.accessLoading) return;
    state.accessLoading = true;
    const visibleBefore = state.accessUserId === me.id && leaderEntryVisible();
    api('/api/compensation/access')
      .then(access => {
        rememberAccess(me, access);
        const sameUser = window.loop.me?.id === me.id;
        const navChanged = !HR_ROLES.includes(me.role) && visibleBefore !== leaderEntryVisible();
        if (sameUser && navChanged && !window.loop.selectedPersonId) reload();
      })
      .catch(() => {
        state.access = null;
        state.accessUserId = me.id;
        state.accessLoadedAt = Date.now();
      })
      .finally(() => {
        state.accessLoading = false;
      });
  }

  // ------------------------------------------------------------------------------------
  // Meine Vergütung
  // ------------------------------------------------------------------------------------

  async function minePage() {
    const { current, history } = await api('/api/compensation/me');
    const intro = 'Vertraulich. HR sieht diese Angaben. Deine direkte Führungskraft sieht sie während einer Gehaltsrunde, an der du teilnimmst, und in deren Ergebnis.';
    if (!current) {
      return `${ui.header('Meine Vergütung', intro)}<article class="card compensationBlock">${ui.empty('Für dich ist noch keine Vergütung hinterlegt. Bei Fragen hilft dir HR weiter.')}</article>`;
    }
    const band = current.band
      ? `<article class="card compensationBlock"><h2>Mein Gehaltsband: ${esc(current.band.name)}</h2>
          <p>Spanne für eine Vollzeitstelle im Jahr: <b>${esc(money(current.band.minCents, current.band.currency))}</b> bis <b>${esc(money(current.band.maxCents, current.band.currency))}</b></p></article>`
      : '';
    const rows = history.map(record => `<tr>${cell(dateLabel(record.effectiveDate))}${cell(money(record.annualSalaryCents, record.currency))}${cell(fteLabel(record.fteBasisPoints))}${cell(money(record.variableTargetCents, record.currency))}${cell(record.band?.name || '–')}${cell(record.reasonLabel)}</tr>`);
    return `${ui.header('Meine Vergütung', intro)}
      <section class="cards">
        ${ui.stat('Jahresgehalt', money(current.annualSalaryCents, current.currency), `Gültig ab ${dateLabel(current.effectiveDate)}`)}
        ${ui.stat('Stellenumfang', fteLabel(current.fteBasisPoints), 'Das Jahresgehalt gilt für diesen Umfang')}
        ${ui.stat('Variable Zielvergütung', money(current.variableTargetCents, current.currency), 'Zielwert pro Jahr')}
      </section>
      ${band}
      <article class="card compensationBlock"><h2>Verlauf</h2>
        ${table(['Gültig ab', 'Jahresgehalt', 'Stellenumfang', 'Variable Zielvergütung', 'Band', 'Grund'], rows)}
      </article>`;
  }

  // ------------------------------------------------------------------------------------
  // HR: Übersicht
  // ------------------------------------------------------------------------------------

  async function homePage() {
    const [access, analytics] = await Promise.all([loadAccess(), api('/api/compensation/analytics')]);
    const exportButton = access.canExport ? '<a class="btn compensationLinkButton" href="/api/compensation/export.csv" download="verguetung.csv">Als CSV herunterladen</a>' : '';
    const bandRows = analytics.bands.map(band => `<tr>
      ${cell(band.name)}
      ${cell(`${money(band.minCents, band.currency)} – ${money(band.maxCents, band.currency)}`)}
      ${cell(band.people)}
      ${cell(band.averageCompaRatio === null ? `Erst ab ${analytics.minGroupSize} Personen` : bandLocation(band.averageCompaRatio))}
      ${cell(band.belowBand)}
      ${cell(band.aboveBand)}
    </tr>`);
    const outsideRows = analytics.outside.map(person => `<tr>
      <td><button type="button" class="compensationLink" data-comp-person="${esc(person.userId)}">${esc(person.name)}</button></td>
      ${cell(person.grade.name)}
      ${cell(`${money(person.grade.minCents, person.grade.currency)} – ${money(person.grade.maxCents, person.grade.currency)}`)}
      ${cell(money(person.fullTimeCents, person.currency))}
      ${cell(bandLocation(person.compaRatio))}
      <td><span class="tag compensationAlert">${person.direction === 'above' ? 'Über dem Band' : 'Unter dem Band'}</span></td>
    </tr>`);
    const peopleInBands = analytics.bands.reduce((total, band) => total + band.people, 0);
    return `${ui.header('Vergütung', `Überblick über Gehaltsbänder und Personen. Das System rechnet und warnt. Entscheidungen treffen Menschen. ${BAND_HINT}`, exportButton)}
      <section class="cards">
        ${ui.stat('Personen in einem Band', String(peopleInBands), `${analytics.withoutBand} ohne Band, ${analytics.withoutRecord} ohne Eintrag`)}
        ${ui.stat('Außerhalb des Bandes', String(analytics.outside.length), 'Bezogen auf Vollzeit')}
        ${ui.stat('Gehaltsbänder', String(analytics.bands.length), 'Aktive und verwendete Bänder')}
      </section>
      <article class="card compensationBlock"><h2>Verteilung je Band</h2>
        ${bandRows.length ? table(['Band', 'Spanne (Vollzeit)', 'Personen', 'Lage im Gehaltsband (Durchschnitt)', 'Unter dem Band', 'Über dem Band'], bandRows) : ui.empty('Es gibt noch keine Gehaltsbänder.')}
      </article>
      <article class="card compensationBlock"><h2>Personen außerhalb des Bandes</h2>
        ${outsideRows.length ? table(['Name', 'Band', 'Spanne (Vollzeit)', 'Gehalt (Vollzeit)', 'Lage im Gehaltsband', 'Hinweis'], outsideRows) : ui.empty('Alle Personen mit Band liegen innerhalb ihres Bandes.')}
      </article>`;
  }

  // ------------------------------------------------------------------------------------
  // HR: Personen und Historie
  // ------------------------------------------------------------------------------------

  const upcomingLine = next => (next ? `<br><small class="muted">Ab ${esc(dateLabel(next.effectiveDate))}: ${esc(money(next.annualSalaryCents, next.currency))}</small>` : '');

  async function peoplePage() {
    const [access, { people }] = await Promise.all([loadAccess(), api('/api/compensation/people')]);
    const rows = people.map(person => {
      const record = person.current;
      const action = access.canWrite && !person.isSelf ? `<button type="button" class="btn" data-comp-record-new="${esc(person.id)}">+ Eintrag</button>` : '';
      const name = `<td><button type="button" class="compensationLink" data-comp-person="${esc(person.id)}">${esc(person.name)}</button><br><small class="muted">${esc(person.title || '')}</small></td>`;
      if (!record) return `<tr>${name}<td class="muted">Noch kein Eintrag${upcomingLine(person.next)}</td><td>–</td><td>–</td><td>–</td><td></td><td>${action}</td></tr>`;
      return `<tr>${name}
        <td>${esc(money(record.annualSalaryCents, record.currency))}${upcomingLine(person.next)}</td>
        ${cell(fteLabel(record.fteBasisPoints))}
        ${cell(record.grade?.name || '–')}
        ${cell(bandLocation(record.metrics.compaRatio))}
        <td>${bandTag(record.metrics)}</td>
        <td>${action}</td></tr>`;
    });
    return `${ui.header('Vergütung', `Aktueller Stand je Person. Die Lage im Gehaltsband und die Hinweise beziehen sich auf Vollzeit. ${BAND_HINT}`)}
      <article class="card compensationBlock">
        ${rows.length ? table(['Name', 'Jahresgehalt', 'Stellenumfang', 'Band', 'Lage im Gehaltsband', 'Hinweis', ''], rows) : ui.empty('Es gibt noch keine Personen.')}
      </article>`;
  }

  async function personPage() {
    if (!state.personId) return peoplePage();
    const [access, detail] = await Promise.all([loadAccess(), api(`/api/compensation/people/${encodeURIComponent(state.personId)}`)]);
    state.person = detail;
    const { person, current, history, next } = detail;
    const canAdd = access.canWrite && !person.isSelf && person.active;
    const addButton = canAdd ? `<button type="button" class="btn primary" data-comp-record-new="${esc(person.id)}">+ Eintrag</button>` : '';
    const selfNote = person.isSelf ? note('Das ist deine eigene Vergütung. Einträge dafür muss jemand anderes vornehmen (Vier-Augen-Prinzip).') : '';
    const nextNote = next ? note(`Ab ${dateLabel(next.effectiveDate)} gilt schon ein neues Gehalt: ${money(next.annualSalaryCents, next.currency)} (${next.reasonLabel}). Die Person sieht es erst ab diesem Tag.`) : '';
    const stats = current ? `<section class="cards">
        ${ui.stat('Jahresgehalt', money(current.annualSalaryCents, current.currency), `Gültig ab ${dateLabel(current.effectiveDate)}, Umfang ${fteLabel(current.fteBasisPoints)}`)}
        ${ui.stat('Lage im Gehaltsband', bandLocation(current.metrics.compaRatio), `${BAND_HINT} Vollzeit: ${money(current.metrics.fullTimeCents, current.currency)}`)}
        ${ui.stat('Stand zwischen Minimum und Maximum', percent(current.metrics.rangePositionPercent), current.grade ? current.grade.name : 'Kein Band zugeordnet')}
      </section>` : '';
    const warnings = current?.warnings?.length ? current.warnings.map(item => note(item.message)).join('') : '';
    const rows = history.map(record => {
      const roundPeople = [
        record.proposedBy ? `Vorgeschlagen von ${record.proposedBy}` : '',
        record.decidedBy ? `entschieden von ${record.decidedBy}` : ''
      ].filter(Boolean).join(', ');
      return `<tr>
      <td>${esc(dateLabel(record.effectiveDate))}${record.future ? ' <span class="tag focus">Zukünftig</span>' : ''}</td>
      ${cell(money(record.annualSalaryCents, record.currency))}
      ${cell(fteLabel(record.fteBasisPoints))}
      ${cell(money(record.variableTargetCents, record.currency))}
      ${cell(record.grade?.name || '–')}
      ${cell(bandLocation(record.metrics.compaRatio))}
      <td>${esc(record.reasonLabel)}${roundPeople ? `<br><small class="muted">${esc(roundPeople)}</small>` : ''}</td>
      ${cell(`${record.createdBy}, ${dateLabel(record.createdAt)}`)}
    </tr>`;
    });
    return `${ui.header(person.name, person.title || 'Vergütungshistorie', addButton)}
      ${selfNote}${nextNote}${stats}${warnings}
      <article class="card compensationBlock"><h2>Historie</h2>
        <p class="muted">Einträge werden nie überschrieben. Korrekturen sind neue Einträge.</p>
        ${rows.length ? table(['Gültig ab', 'Jahresgehalt', 'Stellenumfang', 'Variable Zielvergütung', 'Band', 'Lage im Gehaltsband', 'Grund', 'Eingetragen von'], rows) : ui.empty('Noch kein Eintrag.')}
      </article>`;
  }

  async function openRecordDialog(userId) {
    const [{ grades }, detail] = await Promise.all([api('/api/compensation/grades'), api(`/api/compensation/people/${encodeURIComponent(userId)}`)]);
    const usable = grades.filter(grade => grade.active);
    const defaults = detail.entryDefaults;
    const gradeOptions = usable.map(grade => `<option value="${esc(grade.id)}" ${grade.id === defaults?.gradeId ? 'selected' : ''}>${esc(grade.name)} (${esc(money(grade.minCents, grade.currency))} – ${esc(money(grade.maxCents, grade.currency))})</option>`).join('');
    const reasonOptions = [
      // Wer schon einen Eintrag hat, tritt nicht noch einmal ein: Der Grund wird bewusst gewählt.
      defaults ? '<option value="">Bitte wählen</option>' : '',
      ...Object.entries(REASONS).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`)
    ].join('');
    const retiredGrade = defaults?.gradeId && !usable.some(grade => grade.id === defaults.gradeId)
      ? note(`Das bisherige Band „${defaults.gradeName}“ ist nicht mehr aktiv. Wähle ein anderes.`)
      : '';
    const laterEntry = detail.next
      ? note(`Ab ${dateLabel(detail.next.effectiveDate)} steht schon ein späteres Gehalt fest: ${money(detail.next.annualSalaryCents, detail.next.currency)}. Ein Eintrag mit früherem Datum gilt nur bis dahin.`)
      : '';
    ui.modal({
      title: `Vergütungseintrag: ${detail.person.name}`,
      subtitle: defaults
        ? 'Das Formular zeigt den bisherigen Stand. Ändere nur, was sich ändert. Ein neuer Eintrag ersetzt nichts, aktuell ist der jüngste bis heute.'
        : 'Der erste Eintrag für diese Person. Aktuell ist immer der jüngste Eintrag bis heute.',
      submitLabel: 'Eintragen',
      body: `${laterEntry}${retiredGrade}
        <div class="two"><div><label>Gültig ab</label><input name="effectiveDate" type="date" required value="${esc(today())}"></div>
          <div><label>Grund</label><select name="reason" required>${reasonOptions}</select></div></div>
        <div class="two"><div><label>Jahresgehalt für diesen Umfang</label><input name="annualSalary" inputmode="decimal" required value="${esc(centsToInput(defaults?.annualSalaryCents))}" placeholder="52.000,00"></div>
          <div><label>Stellenumfang (1 ist Vollzeit, 0,8 sind 80 %)</label><input name="fte" inputmode="decimal" value="${esc(defaults ? fteInput(defaults.fteBasisPoints) : '1')}" required></div></div>
        <div class="two"><div><label>Band (optional)</label><select name="gradeId"><option value="">Kein Band</option>${gradeOptions}</select></div>
          <div><label>Variable Zielvergütung (optional)</label><input name="variableTarget" inputmode="decimal" value="${esc(centsToInput(defaults?.variableTargetCents))}" placeholder="0,00"></div></div>
        <label>Währung</label><input name="currency" maxlength="3" value="${esc(defaults?.currency || '')}" placeholder="Wie im Band, sonst EUR">`,
      onSubmit: async data => {
        const result = await post(`/api/compensation/people/${encodeURIComponent(userId)}/records`, data);
        showWarnings(result.warnings, 'Eintrag gespeichert.');
        reload();
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // HR: Gehaltsbänder
  // ------------------------------------------------------------------------------------

  async function gradesPage() {
    const [access, { grades }] = await Promise.all([loadAccess(), api('/api/compensation/grades')]);
    state.grades = grades;
    const newButton = access.canWrite ? '<button type="button" class="btn primary" data-comp-grade-new>+ Band</button>' : '';
    const rows = grades.map(grade => `<tr>
      ${cell(grade.name)}
      ${cell(money(grade.minCents, grade.currency))}
      ${cell(money(grade.midCents, grade.currency))}
      ${cell(money(grade.maxCents, grade.currency))}
      ${cell(dateLabel(grade.validFrom))}
      <td>${grade.active ? '<span class="tag">Aktiv</span>' : '<span class="tag focus">Inaktiv</span>'}</td>
      <td>${access.canWrite ? `<button type="button" class="btn" data-comp-grade-edit="${esc(grade.id)}">Bearbeiten</button>` : ''}</td>
    </tr>`);
    return `${ui.header('Gehaltsbänder', 'Minimum, Mitte und Maximum als Jahresbetrag für eine Vollzeitstelle.', newButton)}
      <article class="card compensationBlock">
        ${rows.length ? table(['Bezeichnung', 'Minimum', 'Mitte', 'Maximum', 'Gültig ab', 'Status', ''], rows) : ui.empty('Lege das erste Band an, um Gehälter einordnen zu können.')}
      </article>`;
  }

  function openGradeDialog(grade = null) {
    const activeField = grade
      ? `<label class="checkRow"><input type="checkbox" name="active" ${grade.active ? 'checked' : ''}> Aktiv (kann neuen Einträgen zugeordnet werden)</label>`
      : '';
    ui.modal({
      title: grade ? 'Band bearbeiten' : 'Neues Band',
      subtitle: 'Jahresbeträge für eine Vollzeitstelle. Es muss gelten: Minimum ≤ Mitte ≤ Maximum.',
      body: `<label>Bezeichnung</label><input name="name" required maxlength="80" value="${esc(grade?.name || '')}">
        <div class="two"><div><label>Währung</label><input name="currency" required maxlength="3" value="${esc(grade?.currency || 'EUR')}"></div>
          <div><label>Gültig ab</label><input name="validFrom" type="date" required value="${esc(grade?.validFrom || today())}"></div></div>
        <div class="two"><div><label>Minimum</label><input name="min" inputmode="decimal" required value="${esc(centsToInput(grade?.minCents))}" placeholder="48.000,00"></div>
          <div><label>Mitte</label><input name="mid" inputmode="decimal" required value="${esc(centsToInput(grade?.midCents))}" placeholder="58.000,00"></div></div>
        <label>Maximum</label><input name="max" inputmode="decimal" required value="${esc(centsToInput(grade?.maxCents))}" placeholder="68.000,00">
        ${activeField}`,
      onSubmit: async data => {
        if (grade) {
          await api(`/api/compensation/grades/${encodeURIComponent(grade.id)}`, { method: 'PATCH', body: JSON.stringify({ ...data, active: data.active === 'on' }) });
        } else {
          await post('/api/compensation/grades', data);
        }
        ui.toast('Band gespeichert.');
        reload();
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // HR: Gehaltsrunden
  // ------------------------------------------------------------------------------------

  function budgetLabel(cycle) {
    if (cycle.budgetMode === 'percent') return `${percent(cycle.budgetPercent)} der Gehaltssumme`;
    return cycle.budgetAmountCents === null ? 'fester Betrag' : money(cycle.budgetAmountCents, cycle.currency);
  }

  function statusTag(status, label) {
    return `<span class="tag ${status === 'closed' ? '' : 'focus'}">${esc(label)}</span>`;
  }

  const cycleSubtitle = cycle => [
    `Gültig ab ${dateLabel(cycle.effectiveDate)}`,
    `Budget ${budgetLabel(cycle)}`,
    cycle.proposalDeadline ? `Vorschläge bis ${dateLabel(cycle.proposalDeadline)}` : ''
  ].filter(Boolean).join(', ');

  async function cyclesPage() {
    const [access, { cycles }] = await Promise.all([loadAccess(), api('/api/compensation/cycles')]);
    const newButton = access.canWrite ? '<button type="button" class="btn primary" data-comp-cycle-new>+ Gehaltsrunde</button>' : '';
    const rows = cycles.map(cycle => `<tr>
      <td><button type="button" class="compensationLink" data-comp-cycle="${esc(cycle.id)}">${esc(cycle.name)}</button></td>
      ${cell(dateLabel(cycle.effectiveDate))}
      ${cell(budgetLabel(cycle))}
      <td>${statusTag(cycle.status, cycle.statusLabel)}</td>
      ${cell(cycle.status === 'draft' ? '–' : `${cycle.counts.participants - cycle.counts.missing} von ${cycle.counts.participants}`)}
      <td>${cycle.budget?.overBudget ? '<span class="tag compensationAlert">Budget überschritten</span>' : ''}</td>
    </tr>`);
    return `${ui.header('Gehaltsrunden', 'Entwurf, offen, in Prüfung, abgeschlossen. Erst der Abschluss legt neue Vergütungseinträge an.', newButton)}
      <article class="card compensationBlock">
        ${rows.length ? table(['Name', 'Gültig ab', 'Budget', 'Status', 'Vorschläge', ''], rows) : ui.empty('Es gibt noch keine Gehaltsrunde.')}
      </article>`;
  }

  function openCycleDialog(cycle = null) {
    const mode = cycle?.budgetMode || 'percent';
    const value = cycle
      ? (cycle.budgetMode === 'percent' ? String(cycle.budgetPercent).replace('.', ',') : centsToInput(cycle.budgetAmountCents))
      : '';
    ui.modal({
      title: cycle ? 'Gehaltsrunde bearbeiten' : 'Neue Gehaltsrunde',
      subtitle: 'Änderungen sind nur möglich, solange die Runde ein Entwurf ist. Danach lässt sich nur noch die Frist ändern.',
      body: `<label>Name</label><input name="name" required maxlength="120" value="${esc(cycle?.name || '')}" placeholder="Gehaltsrunde">
        <div class="two"><div><label>Gültig ab</label><input name="effectiveDate" type="date" required value="${esc(cycle?.effectiveDate || '')}"></div>
          <div><label>Währung</label><input name="currency" required maxlength="3" value="${esc(cycle?.currency || 'EUR')}"></div></div>
        <div class="two"><div><label>Budget angeben als</label><select name="budgetMode">
            <option value="percent" ${mode === 'percent' ? 'selected' : ''}>Prozent der Gehaltssumme</option>
            <option value="amount" ${mode === 'amount' ? 'selected' : ''}>Betrag</option>
          </select></div>
          <div><label>Budget</label><input name="budgetValue" inputmode="decimal" required value="${esc(value)}" placeholder="3,0"></div></div>
        <label>Vorschläge bis (optional)</label><input name="proposalDeadline" type="date" value="${esc(cycle?.proposalDeadline || '')}">
        <p class="muted">Die Frist steht in den Aufgaben der Führungskräfte. Gesperrt wird nach ihrem Ablauf nichts. Die Gehaltssumme ist die Summe der Ausgangsgehälter aller Teilnehmenden: ihr Stand zum Gültig-ab-Datum.</p>`,
      onSubmit: async data => {
        const body = {
          name: data.name,
          effectiveDate: data.effectiveDate,
          currency: data.currency,
          proposalDeadline: data.proposalDeadline,
          budgetMode: data.budgetMode,
          ...(data.budgetMode === 'percent' ? { budgetPercent: data.budgetValue } : { budgetAmount: data.budgetValue })
        };
        if (cycle) {
          await api(`/api/compensation/cycles/${encodeURIComponent(cycle.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
          ui.toast('Gehaltsrunde gespeichert.');
          reload();
        } else {
          const created = await post('/api/compensation/cycles', body);
          ui.toast('Gehaltsrunde angelegt.');
          state.cycleId = created.cycle.id;
          window.loop.navigate('compensationCycle');
        }
      }
    });
  }

  function openDeadlineDialog(cycle) {
    ui.modal({
      title: 'Frist für Vorschläge',
      subtitle: 'Die Frist steht in den Aufgaben der Führungskräfte. Gesperrt wird nach ihrem Ablauf nichts.',
      body: `<label>Vorschläge bis (leer heißt: keine Frist)</label><input name="proposalDeadline" type="date" max="${esc(cycle.effectiveDate)}" value="${esc(cycle.proposalDeadline || '')}">`,
      onSubmit: async data => {
        await api(`/api/compensation/cycles/${encodeURIComponent(cycle.id)}`, { method: 'PATCH', body: JSON.stringify({ proposalDeadline: data.proposalDeadline }) });
        ui.toast('Frist gespeichert.');
        reload();
      }
    });
  }

  function openStartDialog(detail) {
    const people = detail.eligible.map(person => `<label class="checkRow"><input type="checkbox" name="include" value="${esc(person.userId)}" checked> ${esc(person.name)}${person.title ? ` <small class="muted">${esc(person.title)}</small>` : ''}</label>`).join('');
    ui.modal({
      title: 'Gehaltsrunde öffnen',
      subtitle: `Teilnehmende und Ausgangsgehälter werden festgeschrieben, und zwar der Stand zum ${dateLabel(detail.cycle.effectiveDate)}. Die Führungskräfte bekommen eine Aufgabe.`,
      submitLabel: 'Runde öffnen',
      body: detail.eligible.length ? `<p class="muted">Wer soll teilnehmen?</p><div class="compensationChecklist">${people}</div>` : ui.empty('Niemand hat zu diesem Datum eine Vergütung in dieser Währung.'),
      onSubmit: async (data, form) => {
        const included = new Set(new FormData(form).getAll('include').map(Number));
        const excludeUserIds = detail.eligible.filter(person => !included.has(person.userId)).map(person => person.userId);
        const result = await post(`/api/compensation/cycles/${encodeURIComponent(detail.cycle.id)}/open`, { excludeUserIds });
        ui.toast(`Runde geöffnet: ${ui.plural(result.participants, 'Person', 'Personen')}, ${ui.plural(result.tasks, 'Aufgabe', 'Aufgaben')} für Führungskräfte.`);
        reload();
      }
    });
  }

  function openAddPersonDialog(detail) {
    const { addable, withoutEntry } = detail.outside;
    const options = addable.map(person => `<option value="${esc(person.userId)}">${esc(person.title ? `${person.name} · ${person.title}` : person.name)}</option>`).join('');
    const missing = withoutEntry.length
      ? `<p class="muted">Ohne passenden Vergütungseintrag zum ${esc(dateLabel(detail.cycle.effectiveDate))}: ${esc(withoutEntry.map(person => person.name).join(', '))}. Lege für sie zuerst einen Eintrag an.</p>`
      : '';
    ui.modal({
      title: 'Person in die Runde aufnehmen',
      subtitle: `Zum Beispiel, wer erst nach dem Öffnen dazugekommen ist. Ausgang ist der Stand zum ${dateLabel(detail.cycle.effectiveDate)}. Die Gehaltssumme wächst um dieses Gehalt, die Führungskraft bekommt eine Aufgabe.`,
      submitLabel: addable.length ? 'Aufnehmen' : undefined,
      onSubmit: addable.length ? async data => {
        const { participant } = await post(`/api/compensation/cycles/${encodeURIComponent(detail.cycle.id)}/participants`, { userId: Number(data.userId) });
        ui.toast(`${participant.name} nimmt jetzt teil. Ausgangsgehalt ${money(participant.baseSalaryCents, participant.currency)}.`);
        reload();
      } : undefined,
      body: `${addable.length ? `<label>Person</label><select name="userId" required><option value="">Bitte wählen</option>${options}</select>` : ui.empty('Alle Personen mit passendem Eintrag nehmen schon teil.')}${missing}`
    });
  }

  function confirmDialog({ title, subtitle, submitLabel, action }) {
    ui.modal({ title, subtitle, submitLabel, body: '', onSubmit: action });
  }

  function decisionCell(row, cycle, canWrite) {
    if (!canWrite || cycle.status !== 'review') return '';
    const options = row.decision;
    if (options.blockedReason) return `<small class="muted">${esc(options.blockedReason)}</small>`;
    const changeLabel = options.savesProposal ? 'Wert vorschlagen' : (row.proposal ? 'Ändern' : 'Wert festlegen');
    // Entscheidungen lassen sich bis zum Abschluss korrigieren. Was schon gilt, braucht aber keinen Knopf.
    const overridden = row.proposal?.status === 'approved' && row.proposal.finalSalaryCents !== row.proposal.proposedSalaryCents;
    const alreadyApproved = row.proposal?.status === 'approved' && !overridden;
    const alreadyRejected = row.proposal?.status === 'rejected';
    return `<div class="compensationActions">
        ${options.approve && !alreadyApproved ? `<button type="button" class="btn" data-comp-decide="approve" data-user="${esc(row.userId)}">${overridden ? 'Ursprünglichen Vorschlag nehmen' : 'Genehmigen'}</button>` : ''}
        <button type="button" class="btn" data-comp-decide="change" data-user="${esc(row.userId)}">${esc(changeLabel)}</button>
        ${options.reject && !alreadyRejected ? `<button type="button" class="btn" data-comp-decide="reject" data-user="${esc(row.userId)}">Ablehnen</button>` : ''}
      </div>`;
  }

  function participantRow(row, cycle, canWrite) {
    const currency = row.currency;
    const proposal = row.proposal;
    const small = text => (text ? `<br><small class="muted">${esc(text)}</small>` : '');
    const decision = proposal
      ? `<span class="tag ${proposal.status === 'rejected' ? 'compensationAlert' : proposal.status === 'approved' ? '' : 'focus'}">${esc(proposal.statusLabel)}${proposal.changedByHr ? ', geändert' : ''}</span>`
      : '<span class="muted">Kein Vorschlag</span>';
    const warnings = [
      ...row.warnings.map(item => `<span class="tag compensationAlert" title="${esc(item.message)}">${item.code === 'above_band' ? 'Über dem Band' : 'Unter dem Band'}</span>`),
      row.newerRecordExists ? '<span class="tag focus" title="Es gibt einen Eintrag, der nicht im Ausgangsgehalt steckt. Bitte prüfen.">Neuerer Eintrag</span>' : '',
      row.active ? '' : '<span class="tag focus">Konto gesperrt</span>',
      row.isSelf ? '<span class="tag focus">Du selbst</span>' : ''
    ].filter(Boolean).join(' ');
    return `<tr>
      <td><button type="button" class="compensationLink" data-comp-person="${esc(row.userId)}">${esc(row.name)}</button>${small(row.managerName || 'Ohne Führungskraft')}</td>
      ${cell(money(row.baseSalaryCents, currency))}
      ${cell(row.grade?.name || '–')}
      ${cell(bandLocation(row.metrics.compaRatio))}
      <td>${esc(proposal ? increaseText(proposal, currency) : '–')}${small(proposal?.proposedBy ? `Vorgeschlagen von ${proposal.proposedBy}` : '')}${small(proposal?.reason ? `Begründung: ${proposal.reason}` : '')}</td>
      <td>${decision}${small(proposal?.decidedBy ? `Entschieden von ${proposal.decidedBy}, ${dateLabel(proposal.decidedAt)}` : '')}${small(proposal?.decisionReason ? `HR: ${proposal.decisionReason}` : '')}</td>
      ${cell(money(row.plannedSalaryCents, currency))}
      <td>${warnings}</td>
      <td>${decisionCell(row, cycle, canWrite)}</td>
    </tr>`;
  }

  /** Was gerade gilt, steht vor den Knöpfen, nicht erst in einer Fehlermeldung. */
  function decisionNotes(detail, canWrite) {
    if (!canWrite) return note('Du kannst diese Runde lesen. Entscheiden und Abschließen darf die HR-Administration.');
    if (detail.cycle.status !== 'review') return '';
    const { ownProposalsDenied, otherHrAdministrators } = detail.decisionRule;
    const waiting = detail.participants.filter(row => row.proposal?.status === 'submitted' && row.decision.blockedReason).length;
    const parts = [];
    if (ownProposalsDenied) parts.push('Eure Genehmigungsregel: Über eigene Vorschläge entscheidet eine andere HR-Administration. Trägst du ohne Vorschlag einen Wert ein, wird daraus ein Vorschlag.');
    if (waiting) parts.push(`${ui.plural(waiting, 'Vorschlag wartet', 'Vorschläge warten')} auf eine andere HR-Administration. Erst danach lässt sich die Runde abschließen.`);
    if (waiting && !otherHrAdministrators) {
      parts.push(`Gerade gibt es keine zweite HR-Administration. Lege eine an${ownProposalsDenied ? ' oder ändere die Regel unter „Administration“, „Genehmigungen“' : ''}.`);
    }
    return parts.length ? note(parts.join(' ')) : '';
  }

  function outsideNote(detail, canWrite) {
    if (!canWrite || detail.cycle.status !== 'open') return '';
    const { addable, withoutEntry } = detail.outside;
    if (!addable.length && !withoutEntry.length) return '';
    const parts = [];
    if (addable.length) parts.push(`${ui.plural(addable.length, 'Person', 'Personen')} mit Vergütung ${addable.length === 1 ? 'nimmt' : 'nehmen'} noch nicht teil: ${addable.map(person => person.name).join(', ')}.`);
    if (withoutEntry.length) parts.push(`Ohne passenden Vergütungseintrag: ${withoutEntry.map(person => person.name).join(', ')}.`);
    return note(parts.join(' '));
  }

  async function cyclePage() {
    if (!state.cycleId) return cyclesPage();
    const [access, detail] = await Promise.all([loadAccess(), api(`/api/compensation/cycles/${encodeURIComponent(state.cycleId)}`)]);
    state.cycle = detail;
    const { cycle, counts, budget, participants } = detail;
    const actions = [];
    if (access.canWrite && cycle.status === 'draft') {
      actions.push('<button type="button" class="btn" data-comp-cycle-edit>Bearbeiten</button>');
      if (!detail.openBlockedReason) actions.push('<button type="button" class="btn primary" data-comp-cycle-start>Runde öffnen</button>');
    }
    if (access.canWrite && cycle.status === 'open') {
      actions.push('<button type="button" class="btn" data-comp-deadline>Frist ändern</button>');
      actions.push('<button type="button" class="btn" data-comp-add-person>+ Person aufnehmen</button>');
      actions.push('<button type="button" class="btn primary" data-comp-cycle-review>In die Prüfung geben</button>');
    }
    if (access.canWrite && cycle.status === 'review') {
      if (participants.some(row => row.proposal?.status === 'submitted' && row.decision.approve)) actions.push('<button type="button" class="btn" data-comp-approve-open>Alle offenen genehmigen</button>');
      actions.push('<button type="button" class="btn primary" data-comp-cycle-close>Runde abschließen</button>');
    }

    if (cycle.status === 'draft') {
      return `${ui.header(cycle.name, cycleSubtitle(cycle), actions.join(' '))}
        ${detail.openBlockedReason ? note(detail.openBlockedReason, 'compensationNoteAlert') : ''}
        <article class="card compensationBlock"><div class="sectionHead"><h2>Entwurf</h2>${statusTag(cycle.status, cycle.statusLabel)}</div>
          <p>Beim Öffnen ${detail.eligible.length === 1 ? 'kommt' : 'kommen'} ${esc(ui.plural(detail.eligible.length, 'Person', 'Personen'))} in Frage: Wer zum ${esc(dateLabel(cycle.effectiveDate))} eine Vergütung in ${esc(cycle.currency)} hat. Einzelne Personen kannst du dann noch ausschließen.</p>
        </article>`;
    }

    const areaRows = budget.areas.map(area => `<tr>
      ${cell(area.managerName)}
      ${cell(area.participants)}
      ${cell(area.missing ? `${area.missing} offen` : 'Alle da')}
      ${cell(money(area.baseCents, cycle.currency))}
      ${cell(money(area.budgetCents, cycle.currency))}
      ${cell(money(area.plannedCents, cycle.currency))}
      <td>${area.overBudget ? `<span class="tag compensationAlert">${area.overByCents === null ? 'Über dem Budget' : `${esc(money(area.overByCents, cycle.currency))} über dem Budget`}</span>` : '<span class="tag">Im Budget</span>'}</td>
    </tr>`);
    const overall = budget.overall;
    const overNote = overall.overBudget
      ? note(`Das Gesamtbudget ist${overall.overByCents === null ? '' : ` um ${money(overall.overByCents, cycle.currency)}`} überschritten. Gesperrt wird nichts, die Entscheidung liegt bei der HR-Administration.`, 'compensationNoteAlert')
      : '';
    const partialNote = detail.partial ? note('Angaben zur HR-Leitung sind für dich ausgeblendet. Summen und Budget gelten ohne sie.') : '';
    return `${ui.header(cycle.name, cycleSubtitle(cycle), actions.join(' '))}
      <section class="cards">
        ${ui.stat('Status', cycle.statusLabel, ui.plural(counts.participants, 'Person', 'Personen'))}
        ${ui.stat('Budget gesamt', money(overall.budgetCents, cycle.currency), `Gehaltssumme ${money(overall.baseCents, cycle.currency)}`)}
        ${ui.stat('Verplant', money(overall.plannedCents, cycle.currency), overall.usedPercent === null ? '' : `${percent(overall.usedPercent)} des Budgets`)}
      </section>
      ${partialNote}${overNote}${decisionNotes(detail, access.canWrite)}${outsideNote(detail, access.canWrite)}
      <article class="card compensationBlock"><h2>Bereiche</h2>
        ${table(['Führungskraft', 'Personen', 'Vorschläge', 'Gehaltssumme', 'Budget', 'Verplant', 'Stand'], areaRows)}
      </article>
      <article class="card compensationBlock"><h2>Teilnehmende und Vorschläge</h2>
        <p class="muted">${esc(counts.missing)} ohne Vorschlag, ${esc(counts.submitted)} offen, ${esc(counts.approved)} genehmigt, ${esc(counts.rejected)} abgelehnt. Ausgangsgehalt ist der Stand zum ${esc(dateLabel(cycle.effectiveDate))}. ${esc(BAND_HINT)}</p>
        ${table(['Name', 'Ausgangsgehalt', 'Band', 'Lage im Gehaltsband', 'Vorschlag', 'Entscheidung', 'Neues Gehalt', 'Hinweise', ''], participants.map(row => participantRow(row, cycle, access.canWrite)))}
      </article>`;
  }

  function increaseFields({ mode = 'percent', value = '' } = {}) {
    return `<div class="two"><div><label>Erhöhung angeben als</label><select name="mode">
        <option value="percent" ${mode === 'percent' ? 'selected' : ''}>Prozent</option>
        <option value="amount" ${mode === 'amount' ? 'selected' : ''}>Betrag pro Jahr</option>
      </select></div>
      <div><label>Erhöhung</label><input name="value" inputmode="decimal" required value="${esc(value)}" placeholder="3,0"></div></div>`;
  }

  function openDecisionDialog(action, userId) {
    const row = state.cycle.participants.find(item => item.userId === userId);
    if (!row) return;
    const url = `/api/compensation/cycles/${encodeURIComponent(state.cycle.cycle.id)}/decisions/${encodeURIComponent(userId)}`;
    if (action === 'change' && row.decision.savesProposal) {
      ui.modal({
        title: `Wert vorschlagen: ${row.name}`,
        subtitle: `Ausgangsgehalt ${money(row.baseSalaryCents, row.currency)}. Eure Genehmigungsregel verlangt eine zweite Person: Dein Wert wird als Vorschlag gespeichert, eine andere HR-Administration entscheidet.`,
        submitLabel: 'Als Vorschlag speichern',
        body: `${increaseFields()}<label>Begründung</label><textarea name="reason" required maxlength="2000"></textarea>`,
        onSubmit: async data => {
          await post(url, { action: 'change', mode: data.mode, value: data.value, reason: data.reason });
          ui.toast('Als Vorschlag gespeichert. Entscheiden muss eine andere HR-Administration.');
          reload();
        }
      });
      return;
    }
    if (action === 'change') {
      ui.modal({
        title: row.proposal ? `Vorschlag ändern: ${row.name}` : `Wert festlegen: ${row.name}`,
        subtitle: `Ausgangsgehalt ${money(row.baseSalaryCents, row.currency)}. Eine Änderung braucht eine Begründung und gilt zugleich als Genehmigung.`,
        submitLabel: 'Speichern und genehmigen',
        body: `${increaseFields()}<label>Begründung (die Führungskraft sieht sie im Ergebnis)</label><textarea name="reason" required maxlength="2000"></textarea>`,
        onSubmit: async data => {
          await post(url, { action: 'change', mode: data.mode, value: data.value, reason: data.reason });
          ui.toast('Gespeichert und genehmigt.');
          reload();
        }
      });
      return;
    }
    if (action === 'reject') {
      ui.modal({
        title: `Vorschlag ablehnen: ${row.name}`,
        subtitle: 'Das Gehalt bleibt dann unverändert. Die Führungskraft bekommt beim Abschluss einen Hinweis.',
        submitLabel: 'Ablehnen',
        body: '<label>Begründung (optional, die Führungskraft sieht sie im Ergebnis)</label><textarea name="reason" maxlength="2000"></textarea>',
        onSubmit: async data => {
          await post(url, { action: 'reject', reason: data.reason });
          ui.toast('Vorschlag abgelehnt.');
          reload();
        }
      });
      return;
    }
    // Der Knopf nimmt einen geänderten Wert zurück. Das soll niemand aus Versehen tun.
    if (row.proposal?.status === 'approved') {
      ui.modal({
        title: `Ursprünglichen Vorschlag nehmen: ${row.name}`,
        subtitle: `Statt ${money(row.proposal.finalSalaryCents, row.currency)} gilt dann wieder der ursprüngliche Vorschlag mit ${money(row.proposal.proposedSalaryCents, row.currency)}.`,
        submitLabel: 'Ursprünglichen Vorschlag nehmen',
        body: '',
        onSubmit: async () => {
          await post(url, { action: 'approve' });
          ui.toast('Der ursprüngliche Vorschlag gilt wieder.');
          reload();
        }
      });
      return;
    }
    post(url, { action: 'approve' })
      .then(() => {
        ui.toast('Vorschlag genehmigt.');
        reload();
      })
      .catch(error => ui.toast(error.message, 'error'));
  }

  // ------------------------------------------------------------------------------------
  // Führungskräfte
  // ------------------------------------------------------------------------------------

  function worksheetRow(cycleId, row) {
    const currency = row.currency;
    const band = row.grade ? `${row.grade.name}: ${money(row.grade.minCents, row.grade.currency)} – ${money(row.grade.maxCents, row.grade.currency)}` : 'Kein Band';
    const warnings = row.warnings.map(item => `<span class="tag compensationAlert" title="${esc(item.message)}">${item.code === 'above_band' ? 'Über dem Band' : 'Unter dem Band'}</span>`).join(' ');
    return `<tr>
      <td><b>${esc(row.name)}</b><br><small class="muted">${esc(row.title || '')}</small></td>
      ${cell(money(row.baseSalaryCents, currency))}
      ${cell(fteLabel(row.fteBasisPoints))}
      ${cell(band)}
      ${cell(bandLocation(row.metrics.compaRatio))}
      ${cell(row.proposal ? increaseText(row.proposal, currency) : 'Noch offen')}
      <td>${esc(row.proposal ? money(row.proposal.proposedSalaryCents, currency) : '–')}${row.plannedMetrics?.compaRatio ? `<br><small class="muted">Lage im Gehaltsband ${esc(bandLocation(row.plannedMetrics.compaRatio))}</small>` : ''}</td>
      <td>${warnings}</td>
      <td><button type="button" class="btn" data-comp-propose="${esc(row.userId)}" data-cycle="${esc(cycleId)}">${row.proposal ? 'Ändern' : 'Vorschlagen'}</button></td>
    </tr>`;
  }

  function roundBlock(round) {
    const { cycle, budget, rows } = round;
    const area = budget.area;
    const overallText = budget.overall
      ? `Gesamt sind rund ${percent(budget.overall.usedPercent)} des Budgets verplant${budget.overall.overBudget ? ' (überschritten)' : ''}.`
      : 'Die Gesamtsumme bleibt ausgeblendet, solange außerhalb deines Teams zu wenige Vorschläge vorliegen. Sonst ließen sich daraus einzelne Werte ableiten.';
    const overNote = area.overBudget
      ? note(`Dein Bereich liegt um ${money(area.overByCents, cycle.currency)} über dem Budget. Gesperrt wird nichts, HR sieht das in der Prüfung.`, 'compensationNoteAlert')
      : '';
    const completeNote = round.missingProposals === 0
      ? note('Alle Vorschläge sind gespeichert. Du kannst sie ändern, bis HR die Runde in die Prüfung gibt. Mehr musst du nicht tun.')
      : '';
    const baseDate = dateLabel(cycle.effectiveDate);
    const tags = [
      `<span class="tag focus">Gültig ab ${esc(baseDate)}</span>`,
      cycle.proposalDeadline ? `<span class="tag focus">Vorschläge bis ${esc(dateLabel(cycle.proposalDeadline))}</span>` : ''
    ].join(' ');
    return `<section class="compensationBlock">
      <div class="sectionHead compensationRoundHead"><h2>${esc(cycle.name)}</h2><div>${tags}</div></div>
      <section class="cards">
        ${ui.stat('Budget deines Bereichs', money(area.budgetCents, cycle.currency), `Gehaltssumme ${money(area.baseCents, cycle.currency)}`)}
        ${ui.stat('Verplant', money(area.plannedCents, cycle.currency), area.usedPercent === null ? '' : `${percent(area.usedPercent)} deines Budgets`)}
        ${ui.stat('Vorschläge noch offen', String(round.missingProposals), overallText)}
      </section>
      ${overNote}${completeNote}
      <article class="card compensationBlock">
        <p class="muted">Ausgang ist das Gehalt zum ${esc(baseDate)}. Schon beschlossene Erhöhungen bis zu diesem Tag sind darin enthalten. ${esc(BAND_HINT)}</p>
        ${table(['Name', `Ausgangsgehalt zum ${baseDate}`, 'Stellenumfang', 'Band (Vollzeit)', 'Lage im Gehaltsband', 'Erhöhung', 'Neues Gehalt', 'Hinweis', ''], rows.map(row => worksheetRow(cycle.id, row)))}
      </article>
    </section>`;
  }

  function resultTag(row) {
    const style = row.result === 'rejected' ? 'compensationAlert' : (row.result === 'approved' || row.result === 'changed' ? '' : 'focus');
    return `<span class="tag ${style}">${esc(row.resultLabel)}</span>`;
  }

  function resultBlock(round, index) {
    const { cycle, rows } = round;
    const baseDate = dateLabel(cycle.effectiveDate);
    const closed = cycle.status === 'closed';
    const rejected = rows.filter(row => row.result === 'rejected').map(row => row.name);
    const rejectedNote = rejected.length
      ? note(`Abgelehnt: ${rejected.join(', ')}. Das Gehalt bleibt hier unverändert.`, 'compensationNoteAlert')
      : '';
    const body = closed
      ? `${rejectedNote}<p class="muted">Die neuen Gehälter gelten ab ${esc(baseDate)}. Deine Mitarbeitenden sehen sie ab diesem Tag und bekommen keine Nachricht. Sprich vorher mit ihnen.</p>
        ${table(['Name', 'Ausgangsgehalt', 'Vorschlag', 'Ergebnis', `Gehalt ab ${baseDate}`, 'Begründung von HR'], rows.map(row => `<tr>
          <td><b>${esc(row.name)}</b><br><small class="muted">${esc(row.title || '')}</small></td>
          ${cell(money(row.baseSalaryCents, row.currency))}
          ${cell(row.proposal ? increaseText(row.proposal, row.currency) : '–')}
          <td>${resultTag(row)}${row.decidedBy ? `<br><small class="muted">Entschieden von ${esc(row.decidedBy)}</small>` : ''}</td>
          ${cell(money(row.finalSalaryCents, row.currency))}
          ${cell(row.decisionReason || '–')}
        </tr>`))}`
      : `<p class="muted">HR prüft die Vorschläge gerade. Das Ergebnis siehst du hier, sobald die Runde abgeschlossen ist. Ändern lässt sich nichts mehr.</p>
        ${table(['Name', 'Vorschlag', `Neues Gehalt ab ${baseDate} laut Vorschlag`, 'Stand'], rows.map(row => `<tr>
          <td><b>${esc(row.name)}</b><br><small class="muted">${esc(row.title || '')}</small></td>
          ${cell(row.proposal ? increaseText(row.proposal, row.currency) : '–')}
          ${cell(row.proposal ? money(row.proposal.proposedSalaryCents, row.currency) : '–')}
          <td>${resultTag(row)}</td>
        </tr>`))}`;
    return `<details class="card compensationBlock compensationResult" ${index === 0 || !closed ? 'open' : ''}>
      <summary><b>${esc(cycle.name)}</b> ${statusTag(cycle.status, cycle.statusLabel)}</summary>
      ${body}
    </details>`;
  }

  function summaryBlock(summary) {
    if (summary.suppressed) return '';
    const totals = summary.totals.map(total => `<tr>
      ${cell(total.currency)}
      ${cell(total.people)}
      ${cell(money(total.annualSalaryCents, total.currency))}
      ${cell(money(total.variableTargetCents, total.currency))}
    </tr>`);
    const rounds = summary.rounds.map(round => `<tr>
      ${cell(round.name)}
      ${cell(round.people)}
      ${cell(money(round.budgetCents, round.currency))}
      ${cell(round.planned ? money(round.planned.plannedCents, round.currency) : `Erst ab ${summary.minGroupSize} Vorschlägen`)}
      <td>${round.planned ? (round.planned.overBudget ? `<span class="tag compensationAlert">${esc(money(round.planned.overByCents, round.currency))} über dem Budget</span>` : '<span class="tag">Im Budget</span>') : ''}</td>
    </tr>`);
    return `<article class="card compensationBlock"><h2>Summen deines weiteren Bereichs</h2>
      <p class="muted">Nur Summen ohne Einzelwerte und nur ab ${esc(summary.minGroupSize)} Personen. Deine direkten Mitarbeitenden zählen hier nicht mit.</p>
      ${totals.length ? table(['Währung', 'Personen', 'Jahresgehälter', 'Variable Zielvergütung'], totals) : ''}
      ${rounds.length ? `<h3>Laufende Gehaltsrunde</h3>${table(['Runde', 'Personen', 'Budget', 'Verplant', 'Stand'], rounds)}` : ''}
    </article>`;
  }

  async function teamPage() {
    const [{ rounds }, { results }, summary] = await Promise.all([api('/api/compensation/team'), api('/api/compensation/team/results'), api('/api/compensation/area-summary')]);
    state.rounds = rounds;
    await loadAccess();
    const intro = 'Vertraulich. Du schlägst vor, HR entscheidet. Danach siehst du hier das Ergebnis für dein Team. Weitere Gehälter siehst du nicht.';
    const content = `${rounds.map(roundBlock).join('')}${results.map(resultBlock).join('')}${summaryBlock(summary)}`;
    return `${ui.header('Vergütung', intro)}${content || `<article class="card compensationBlock">${ui.empty('Gerade läuft keine Gehaltsrunde, in der du Vorschläge abgeben kannst.')}</article>`}`;
  }

  function openProposalDialog(cycleId, userId) {
    const round = state.rounds.find(item => item.cycle.id === cycleId);
    const row = round?.rows.find(item => item.userId === userId);
    if (!row) return;
    const existing = row.proposal;
    const value = existing
      ? (existing.mode === 'percent' ? String(existing.percent).replace('.', ',') : centsToInput(existing.increaseCents))
      : '';
    ui.modal({
      title: `Vorschlag für ${row.name}`,
      subtitle: `Ausgangsgehalt zum ${dateLabel(round.cycle.effectiveDate)}: ${money(row.baseSalaryCents, row.currency)} bei ${fteLabel(row.fteBasisPoints)} Stellenumfang.`,
      submitLabel: 'Vorschlag speichern',
      body: `${increaseFields({ mode: existing?.mode || 'percent', value })}
        <label>Begründung (Pflicht, wenn Budget oder Band überschritten werden)</label>
        <textarea name="reason" maxlength="2000">${esc(existing?.reason || '')}</textarea>
        <p class="muted">Die Erhöhung bezieht sich auf das tatsächliche Jahresgehalt. Die Entscheidung trifft HR.</p>`,
      onSubmit: async data => {
        const result = await api(`/api/compensation/team/${encodeURIComponent(cycleId)}/proposals/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify(data) });
        showWarnings(result.warnings, 'Vorschlag gespeichert.');
        reload();
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // Ereignisse
  // ------------------------------------------------------------------------------------

  function onAll(selector, handler) {
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

  function closeDialogText(detail) {
    const unclear = detail.participants.filter(row => row.newerRecordExists && row.proposal?.status === 'approved').length;
    const warning = unclear ? ` Achtung: Bei ${ui.plural(unclear, 'Person', 'Personen')} gibt es einen Eintrag, der nicht im Ausgangsgehalt steckt. Prüfe das vorher.` : '';
    return `Aus allen genehmigten Vorschlägen entstehen jetzt neue Vergütungseinträge mit dem Gültig-ab-Datum der Runde. Die Führungskräfte bekommen einen Hinweis. Das geschieht genau einmal und lässt sich nicht rückgängig machen.${warning}`;
  }

  function bind() {
    onAll('[data-comp-person]', element => {
      state.personId = Number(element.dataset.compPerson);
      window.loop.navigate('compensationPerson');
    });
    onAll('[data-comp-record-new]', element => openRecordDialog(Number(element.dataset.compRecordNew)));
    onAll('[data-comp-grade-new]', () => openGradeDialog());
    onAll('[data-comp-grade-edit]', element => openGradeDialog(state.grades.find(grade => grade.id === Number(element.dataset.compGradeEdit))));
    onAll('[data-comp-cycle-new]', () => openCycleDialog());
    onAll('[data-comp-cycle]', element => {
      state.cycleId = Number(element.dataset.compCycle);
      window.loop.navigate('compensationCycle');
    });
    onAll('[data-comp-cycle-edit]', () => openCycleDialog(state.cycle.cycle));
    onAll('[data-comp-cycle-start]', () => openStartDialog(state.cycle));
    onAll('[data-comp-deadline]', () => openDeadlineDialog(state.cycle.cycle));
    onAll('[data-comp-add-person]', () => openAddPersonDialog(state.cycle));
    onAll('[data-comp-cycle-review]', () => confirmDialog({
      title: 'In die Prüfung geben',
      subtitle: 'Führungskräfte können dann keine Vorschläge mehr abgeben. Sie sehen nur noch ihre eigenen Vorschläge und nach dem Abschluss das Ergebnis für ihr Team. Das lässt sich nicht rückgängig machen.',
      submitLabel: 'In die Prüfung geben',
      action: async () => {
        await post(`/api/compensation/cycles/${encodeURIComponent(state.cycle.cycle.id)}/review`);
        ui.toast('Die Runde ist jetzt in Prüfung.');
        reload();
      }
    }));
    onAll('[data-comp-approve-open]', async () => {
      const result = await post(`/api/compensation/cycles/${encodeURIComponent(state.cycle.cycle.id)}/approve-open`);
      const left = result.skippedOwn ? ` ${ui.plural(result.skippedOwn, 'Vorschlag bleibt', 'Vorschläge bleiben')} offen: Darüber entscheidet eine andere HR-Administration.` : '';
      ui.toast(`${ui.plural(result.approved, 'Vorschlag', 'Vorschläge')} genehmigt.${left}`);
      reload();
    });
    onAll('[data-comp-cycle-close]', () => confirmDialog({
      title: 'Runde abschließen',
      subtitle: closeDialogText(state.cycle),
      submitLabel: 'Endgültig abschließen',
      action: async () => {
        const result = await post(`/api/compensation/cycles/${encodeURIComponent(state.cycle.cycle.id)}/close`);
        const entries = ui.plural(result.created, 'neuer Eintrag', 'neue Einträge');
        ui.toast(`Runde abgeschlossen: ${entries}.${result.skippedInactive ? ` ${ui.plural(result.skippedInactive, 'gesperrtes Konto', 'gesperrte Konten')} ausgelassen.` : ''}`);
        reload();
      }
    }));
    onAll('[data-comp-decide]', element => openDecisionDialog(element.dataset.compDecide, Number(element.dataset.user)));
    onAll('[data-comp-propose]', element => openProposalDialog(Number(element.dataset.cycle), Number(element.dataset.compPropose)));
  }

  /** Unten rechts sitzt Dayo. Der Platz am Seitenende sorgt dafür, dass die letzte Zeile frei bleibt. */
  const withRoomForDayo = page => async () => `${await page()}<div class="compensationPageEnd" aria-hidden="true"></div>`;

  window.loop.registerAddress?.({
    compensationPerson: { get: () => state.personId, set: id => { state.personId = id; } },
    compensationCycle: { get: () => state.cycleId, set: id => { state.cycleId = id; } }
  });

  window.loop.registerModule({
    key: 'compensation',
    label: 'Vergütung',
    nav(me) {
      if (state.accessUserId !== me.id || Date.now() - state.accessLoadedAt > ACCESS_MAX_AGE_MS) refreshAccessInBackground(me);
      const items = [];
      if (me.role !== 'super_admin') items.push({ route: 'compensationMine', label: 'Meine Vergütung', group: 'myWork' });
      if (HR_ROLES.includes(me.role)) {
        items.push({ route: 'compensationHome', label: 'Vergütung', group: 'hr', views: HR_VIEWS });
      } else if (state.accessUserId === me.id && leaderEntryVisible()) {
        items.push({ route: 'compensationTeam', label: 'Vergütung', group: 'hr', views: ['compensationTeam'] });
      }
      return items;
    },
    pages: {
      compensationMine: withRoomForDayo(minePage),
      compensationHome: withRoomForDayo(homePage),
      compensationPeople: withRoomForDayo(peoplePage),
      compensationPerson: withRoomForDayo(personPage),
      compensationGrades: withRoomForDayo(gradesPage),
      compensationCycles: withRoomForDayo(cyclesPage),
      compensationCycle: withRoomForDayo(cyclePage),
      compensationTeam: withRoomForDayo(teamPage)
    },
    tabs(view, me) {
      if (!HR_ROLES.includes(me.role) || !HR_VIEWS.includes(view)) return [];
      const ownTeam = state.accessUserId === me.id && hasOwnTeamView();
      return [
        { route: 'compensationHome', label: 'Übersicht', active: view === 'compensationHome' },
        { route: 'compensationPeople', label: 'Personen', active: view === 'compensationPeople' || view === 'compensationPerson' },
        { route: 'compensationGrades', label: 'Gehaltsbänder', active: view === 'compensationGrades' },
        { route: 'compensationCycles', label: 'Gehaltsrunden', active: view === 'compensationCycles' || view === 'compensationCycle' },
        ...(ownTeam ? [{ route: 'compensationTeam', label: 'Mein Team', active: view === 'compensationTeam' }] : [])
      ];
    },
    bind,
    taskAction(task) {
      if (task.type === 'compensation_decision') return `<button class="btn primary" data-comp-cycle="${esc(task.entity_id)}">Entscheiden</button>`;
      if (task.type === 'compensation_proposal') return '<button class="btn primary" data-view="compensationTeam">Vorschläge abgeben</button>';
      if (task.type === 'compensation_result_notice') return `<button class="btn primary" data-view="compensationTeam">Ansehen</button> <button class="btn" data-task-done="${esc(task.id)}">Erledigt</button>`;
      return '';
    }
  });
})();
