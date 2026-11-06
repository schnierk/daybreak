// Nachfolgeplanung: Pläne für wichtige Stellen, mögliche Nachfolger:innen und Kennzahlen. Nur für HR und Bereichsleitung.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const ALLOWED_ROLES = ['hr_admin', 'hrbp', 'super_admin', 'director'];
  const HR_ROLES = ['hr_admin', 'hrbp', 'super_admin'];
  const VIEWS = ['successionHome', 'successionPlan', 'successionMetrics'];
  const CONFIDENTIAL = 'Vertraulich: Diese Angaben sind nur für die Personalplanung bestimmt. Wer hier steht, wird nicht benachrichtigt. Bitte gib nichts davon weiter. Das System zeigt nur an. Entscheidungen treffen Menschen.';
  const BENCH_LABEL = 'Anzahl möglicher Nachfolger:innen';

  const state = { planId: null, detail: null, options: null, showArchived: false };

  const isHr = () => HR_ROLES.includes(window.loop.me.role);
  const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
  const patch = (url, body) => api(url, { method: 'PATCH', body: JSON.stringify(body) });
  const reload = () => window.loop.navigate(window.loop.view);
  const dateLabel = iso => (iso ? ui.date(iso) : '–');
  const cell = value => `<td>${esc(value)}</td>`;
  const confidentialNote = () => `<p class="successionNote">${esc(CONFIDENTIAL)}</p>`;

  /** Am Handy wird aus jeder Zeile eine Karte. Dafür trägt jede Zelle die Überschrift ihrer Spalte. */
  function table(headers, rows) {
    const labelled = rows.map(row => {
      let column = 0;
      return row.replace(/<td\b/g, () => `<td data-label="${esc(headers[column++] || '')}"`);
    });
    return `<div class="tableWrap"><table class="table successionTable"><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${labelled.join('')}</tbody></table></div>`;
  }

  function options(entries, selected = '') {
    return entries.map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');
  }

  async function loadOptions() {
    state.options = await api('/api/succession/options');
    return state.options;
  }

  function levelTag(level, label) {
    return `<span class="tag ${level === 'high' ? 'successionHigh' : level === 'medium' ? 'focus' : ''}">${esc(label)}</span>`;
  }

  function benchText(bench) {
    return `${bench.ready_now} sofort · ${bench.ready_1_2_years} in 1 bis 2 Jahren · ${bench.ready_3_plus_years} in 3 oder mehr Jahren`;
  }

  // ------------------------------------------------------------------------------------
  // Pläne
  // ------------------------------------------------------------------------------------

  async function homePage() {
    const status = state.showArchived ? 'all' : 'active';
    const { plans } = await api(`/api/succession/plans?status=${status}`);
    const actions = isHr()
      ? `<button type="button" class="btn" data-succession-toggle-archived>${state.showArchived ? 'Archivierte ausblenden' : 'Archivierte anzeigen'}</button> <button type="button" class="btn primary" data-succession-plan-new>+ Plan</button>`
      : '';
    const rows = plans.map(plan => `<tr>
      <td><button type="button" class="successionLink" data-succession-plan="${esc(plan.id)}">${esc(plan.title)}</button>
        ${plan.status === 'archived' ? ' <span class="tag focus">Archiviert</span>' : ''}</td>
      ${cell(plan.holder?.name || 'Unbesetzt')}
      <td>${levelTag(plan.criticality, plan.criticalityLabel)}</td>
      <td>${levelTag(plan.risk, plan.riskLabel)}</td>
      ${cell(benchText(plan.bench))}
      ${cell(plan.bench.proposed ? `${plan.bench.proposed} offen` : '–')}
      ${cell(dateLabel(plan.plannedDeparture))}
    </tr>`);
    return `${ui.header('Nachfolgeplanung', 'Wichtige Stellen und mögliche Nachfolgen im Überblick.', actions)}
      ${confidentialNote()}
      <article class="card successionBlock">
        ${rows.length ? table(['Position', 'Stelle besetzt durch', 'Bedeutung der Stelle', 'Risiko des Ausfalls', BENCH_LABEL, 'Vorschläge', 'Geplanter Abgang'], rows) : ui.empty(isHr() ? 'Lege den ersten Plan für eine wichtige Stelle an.' : 'In deiner Führungslinie gibt es gerade keinen Nachfolgeplan, den du sehen kannst.')}
      </article>`;
  }

  async function openPlanDialog(plan = null) {
    const { people, profiles, levels } = await loadOptions();
    const levelEntries = Object.entries(levels);
    // Gesperrte Konten stehen nicht in der Auswahl. Der bisherige Wert darf beim Speichern nicht verloren gehen.
    const holderEntries = people.map(person => [person.id, person.title ? `${person.name} · ${person.title}` : person.name]);
    if (plan?.holder && !people.some(person => person.id === plan.holder.id)) holderEntries.push([plan.holder.id, `${plan.holder.name} (Konto gesperrt)`]);
    const profileEntries = profiles.map(profile => [profile.id, profile.title]);
    if (plan?.positionProfileId && !profiles.some(profile => profile.id === plan.positionProfileId)) profileEntries.push([plan.positionProfileId, `${plan.title} (nicht mehr aktiv)`]);
    const holderOptions = options(holderEntries, plan?.holder?.id);
    const statusField = plan
      ? `<label>Status</label><select name="status">${options([['active', 'Aktiv'], ['archived', 'Archiviert']], plan.status)}</select>`
      : '';
    ui.modal({
      title: plan ? 'Plan bearbeiten' : 'Neuer Nachfolgeplan',
      subtitle: 'Wähle eine Position oder benenne die Stelle frei.',
      body: `<div class="two"><div><label>Position</label><select name="positionProfileId"><option value="">Keine Position</option>${options(profileEntries, plan?.positionProfileId)}</select></div>
          <div><label>oder frei benannte Stelle</label><input name="roleName" maxlength="160" value="${esc(plan?.roleName || '')}"></div></div>
        <label>Aktuelle Stelleninhaberin oder aktueller Stelleninhaber</label>
        <select name="holderId"><option value="">Stelle ist unbesetzt</option>${holderOptions}</select>
        <div class="two"><div><label>Bedeutung der Stelle</label><select name="criticality">${options(levelEntries, plan?.criticality || 'medium')}</select></div>
          <div><label>Risiko des Ausfalls</label><select name="risk">${options(levelEntries, plan?.risk || 'medium')}</select></div></div>
        <label>Begründung des Risikos</label><textarea name="riskReason" required maxlength="2000">${esc(plan?.riskReason || '')}</textarea>
        <label>Geplanter Abgang (optional)</label><input name="plannedDeparture" type="date" value="${esc(plan?.plannedDeparture || '')}">
        ${statusField}`,
      onSubmit: async data => {
        if (plan) {
          await patch(`/api/succession/plans/${encodeURIComponent(plan.id)}`, data);
          ui.toast('Plan gespeichert.');
          reload();
        } else {
          const created = await post('/api/succession/plans', data);
          ui.toast('Plan angelegt.');
          state.planId = created.plan.id;
          window.loop.navigate('successionPlan');
        }
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // Plan im Detail
  // ------------------------------------------------------------------------------------

  function requirementsTable(items) {
    return table(['Kompetenz', 'Gefordert', 'Vorhanden', 'Stand'], items.map(item => `<tr>
      ${cell(item.competency)}
      ${cell(item.requiredLevel)}
      ${cell(item.availableLevel ?? '–')}
      ${cell(item.statusLabel)}
    </tr>`));
  }

  function coverageBlock(heading, coverage, hint) {
    if (!coverage) return '';
    const summary = coverage.total && coverage.rated
      ? `${coverage.fulfilled} von ${coverage.total} Anforderungen erfüllt${coverage.notRated ? `, ${coverage.notRated} nicht bewertet` : ''}`
      : 'Nicht bewertet';
    const details = coverage.items.length
      ? `<details><summary>Einzelne Anforderungen</summary>${requirementsTable(coverage.items)}</details>`
      : '';
    return `<div class="successionSupport"><b>${esc(heading)}</b><br>
      <span>${esc(summary)}</span>
      ${hint ? `<br><small class="muted">${esc(hint)}</small>` : ''}
      ${details}</div>`;
  }

  function nineBoxBlock(candidate, available) {
    if (!available || !('nineBox' in candidate)) return '';
    const box = candidate.nineBox;
    const text = box
      ? `${box.period}: Leistung ${box.performance} von 3, Potenzial ${box.potential} von 3${box.label ? ` (${box.label})` : ''}`
      : 'Nicht bewertet';
    return `<div class="successionSupport"><b>Letzte freigegebene 9-Box-Einordnung</b> <small class="muted">nur für HR sichtbar</small><br><span>${esc(text)}</span><br><small class="muted">Die 9-Box aus dem Talent Review ordnet nach Leistung und Potenzial ein.</small></div>`;
  }

  function historyBlock(history) {
    if (!history.length) return '';
    const rows = history.map(entry => `<tr>
      ${cell(dateLabel(entry.changedAt))}
      ${cell(entry.oldReadinessLabel || 'Neu aufgenommen')}
      ${cell(entry.newReadinessLabel)}
      ${cell(entry.changedBy)}
    </tr>`);
    return `<details class="successionHistory"><summary>Verlauf der Bereitschaft</summary>${table(['Datum', 'Vorher', 'Nachher', 'Geändert von'], rows)}</details>`;
  }

  function textBlock(label, value) {
    return value ? `<p><b>${esc(label)}:</b> ${esc(value)}</p>` : '';
  }

  function candidateCard(candidate, detail) {
    const { plan } = detail;
    const readinessTag = `<span class="tag ${candidate.readiness === 'ready_now' ? '' : 'focus'}">${esc(candidate.readinessLabel)}</span>`;
    if (candidate.limited) {
      return `<article class="card successionCandidate">
        <h3>${esc(candidate.name)}</h3>
        <p>${readinessTag}${candidate.status === 'confirmed' ? '' : ` <span class="tag focus">${esc(candidate.statusLabel)}</span>`}</p>
        <p class="muted">Diese Person gehört nicht zu deinem Bereich. Du siehst deshalb nur Name und Bereitschaft.</p>
      </article>`;
    }
    const buttons = [];
    if (plan.canEdit && plan.status === 'active') {
      buttons.push(`<button type="button" class="btn" data-succession-candidate-edit="${esc(candidate.id)}">Bearbeiten</button>`);
      if (candidate.status === 'proposed') buttons.push(`<button type="button" class="btn primary" data-succession-candidate-status="confirmed" data-candidate="${esc(candidate.id)}">Bestätigen</button>`);
      if (candidate.status !== 'removed') buttons.push(`<button type="button" class="btn" data-succession-candidate-status="removed" data-candidate="${esc(candidate.id)}">Entfernen</button>`);
      else buttons.push(`<button type="button" class="btn" data-succession-candidate-status="confirmed" data-candidate="${esc(candidate.id)}">Wieder aufnehmen</button>`);
    }
    const tags = [
      readinessTag,
      candidate.status === 'confirmed' ? '' : `<span class="tag focus">${esc(candidate.statusLabel)}</span>`,
      candidate.nominationText ? `<span class="tag successionMulti">${esc(candidate.nominationText)}</span>` : '',
      candidate.active ? '' : '<span class="tag focus">Konto gesperrt</span>'
    ].filter(Boolean).join(' ');
    const coverageHint = 'Bezieht sich auf die aktuelle Position der Person, nicht auf die Position dieses Plans.';
    const positionHeading = candidate.currentPosition?.positionTitle
      ? `Abdeckung der Anforderungen der aktuellen Position (${candidate.currentPosition.positionTitle})`
      : 'Abdeckung der Anforderungen der aktuellen Position';
    return `<article class="card successionCandidate ${candidate.status === 'removed' ? 'successionRemoved' : ''}">
      <div class="sectionHead"><div><h3>${esc(candidate.name)}</h3><small class="muted">${esc(candidate.title || '')}</small></div><div class="successionActions">${buttons.join(' ')}</div></div>
      <p>${tags}</p>
      ${textBlock('Stärken', candidate.strengths)}
      ${textBlock('Lücken', candidate.gaps)}
      ${textBlock('Entwicklungsmaßnahmen', candidate.developmentActions)}
      ${textBlock('Notiz', candidate.note)}
      ${textBlock('Vorgeschlagen von', candidate.status === 'proposed' ? candidate.proposedBy : '')}
      ${coverageBlock(positionHeading, candidate.currentPosition, coverageHint)}
      ${coverageBlock('Vergleich mit den Anforderungen der Stelle in diesem Plan', candidate.targetProfile, '')}
      ${nineBoxBlock(candidate, detail.nineBoxAvailable)}
      ${historyBlock(candidate.history)}
    </article>`;
  }

  async function planPage() {
    if (!state.planId) return homePage();
    const detail = await api(`/api/succession/plans/${encodeURIComponent(state.planId)}`);
    state.detail = detail;
    const { plan, candidates } = detail;
    const actions = [];
    if (plan.canEdit) {
      actions.push('<button type="button" class="btn" data-succession-plan-edit>Bearbeiten</button>');
      if (plan.status === 'active') {
        actions.push('<button type="button" class="btn" data-succession-reviewed>Überprüfung bestätigen</button>');
        actions.push('<button type="button" class="btn primary" data-succession-candidate-new>+ Person aufnehmen</button>');
      }
    }
    if (plan.canPropose) actions.push('<button type="button" class="btn primary" data-succession-candidate-new>+ Person vorschlagen</button>');
    const holderText = plan.holder ? `Stelle besetzt durch ${plan.holder.name}${plan.holder.active ? '' : ' (Konto gesperrt)'}` : 'Stelle ist unbesetzt';
    return `${ui.header(plan.title, holderText, actions.join(' '))}
      ${confidentialNote()}
      <section class="cards">
        <article class="card stat"><small>Bedeutung der Stelle</small><strong>${esc(plan.criticalityLabel)}</strong><span class="up">Status: ${esc(plan.statusLabel)}</span></article>
        <article class="card stat"><small>Risiko des Ausfalls</small><strong>${esc(plan.riskLabel)}</strong><span class="up">Geplanter Abgang: ${esc(dateLabel(plan.plannedDeparture))}</span></article>
        <article class="card stat"><small>${esc(BENCH_LABEL)}</small><strong>${esc(plan.bench.ready_now + plan.bench.ready_1_2_years + plan.bench.ready_3_plus_years)}</strong><span class="up">${esc(benchText(plan.bench))}</span></article>
      </section>
      <article class="card successionBlock"><h2>Begründung des Risikos</h2><p>${esc(plan.riskReason)}</p>
        <p class="muted">Zuletzt überprüft: ${esc(dateLabel(plan.lastReviewedAt))}</p></article>
      <section class="successionBlock">
        <h2>Mögliche Nachfolger:innen</h2>
        <p class="muted">Alphabetisch sortiert. Es gibt bewusst keine Rangfolge und keine Punktzahl.</p>
        ${candidates.length ? candidates.map(candidate => candidateCard(candidate, detail)).join('') : `<article class="card">${ui.empty('Noch niemand aufgenommen.')}</article>`}
      </section>`;
  }

  async function openCandidateDialog(candidate = null) {
    const { candidates, readiness } = await loadOptions();
    const plan = state.detail.plan;
    const taken = new Set(state.detail.candidates.map(item => item.userId));
    const free = candidates.filter(person => person.id !== plan.holder?.id && !taken.has(person.id));
    const personField = candidate
      ? ''
      : `<label>Person</label><select name="userId" required><option value="">Bitte wählen</option>${options(free.map(person => [person.id, person.title ? `${person.name} · ${person.title}` : person.name]))}</select>`;
    ui.modal({
      title: candidate ? `Eintrag bearbeiten: ${candidate.name}` : (plan.canEdit ? 'Person aufnehmen' : 'Person vorschlagen'),
      subtitle: plan.canEdit ? 'Die Person wird nicht benachrichtigt.' : 'HR prüft deinen Vorschlag. Die Person wird nicht benachrichtigt.',
      body: `${personField}
        <label>Bereitschaft</label><select name="readiness" required>${options(Object.entries(readiness), candidate?.readiness || 'ready_1_2_years')}</select>
        <label>Stärken</label><textarea name="strengths" maxlength="2000">${esc(candidate?.strengths || '')}</textarea>
        <label>Lücken</label><textarea name="gaps" maxlength="2000">${esc(candidate?.gaps || '')}</textarea>
        <label>Entwicklungsmaßnahmen</label><textarea name="developmentActions" maxlength="2000">${esc(candidate?.developmentActions || '')}</textarea>
        <label>Notiz</label><textarea name="note" maxlength="2000">${esc(candidate?.note || '')}</textarea>`,
      onSubmit: async data => {
        if (candidate) await patch(`/api/succession/candidates/${encodeURIComponent(candidate.id)}`, data);
        else await post(`/api/succession/plans/${encodeURIComponent(plan.id)}/candidates`, data);
        ui.toast('Gespeichert.');
        reload();
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // Kennzahlen
  // ------------------------------------------------------------------------------------

  async function metricsPage() {
    const metrics = await api('/api/succession/metrics');
    const levels = Object.entries(metrics.levels);
    const matrixRows = levels.map(([criticality, label]) => `<tr>
      <th>${esc(label)}</th>
      ${levels.map(([risk]) => `<td class="successionMatrixCell ${metrics.riskMatrix[criticality][risk] ? 'successionMatrixFilled' : ''}">${esc(metrics.riskMatrix[criticality][risk])}</td>`).join('')}
    </tr>`);
    const benchRows = metrics.plans.map(plan => `<tr>
      <td><button type="button" class="successionLink" data-succession-plan="${esc(plan.planId)}">${esc(plan.title)}</button></td>
      ${cell(plan.bench.ready_now)}
      ${cell(plan.bench.ready_1_2_years)}
      ${cell(plan.bench.ready_3_plus_years)}
      ${cell(plan.bench.proposed)}
    </tr>`);
    const withoutReady = metrics.plansWithoutReadyCandidate.map(plan => `<div class="row"><div class="grow"><button type="button" class="successionLink" data-succession-plan="${esc(plan.planId)}">${esc(plan.title)}</button></div></div>`).join('');
    return `${ui.header('Nachfolgeplanung', 'Die Zahlen helfen beim Gespräch. Entscheidungen treffen Menschen.')}
      ${confidentialNote()}
      <section class="cards">
        ${ui.stat('Aktive Pläne', String(metrics.plans.length), 'Die du sehen darfst')}
        ${ui.stat('Pläne ohne sofort bereite Person', String(metrics.plansWithoutReadyCandidate.length), 'Nur bestätigte Einträge zählen')}
        ${ui.stat('Einträge in allen Plänen', String(metrics.nominations.gross), ui.plural(metrics.nominations.net, 'verschiedene Person', 'verschiedene Personen'))}
      </section>
      <article class="card successionBlock"><h2>Pläne nach Bedeutung und Risiko</h2>
        <p class="muted">Anzahl der Pläne: Bedeutung der Stelle in den Zeilen, Risiko des Ausfalls in den Spalten.</p>
        <div class="tableWrap"><table class="table successionMatrix"><thead><tr><th>Bedeutung</th>${levels.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${matrixRows.join('')}</tbody></table></div>
      </article>
      <article class="card successionBlock"><h2>${esc(BENCH_LABEL)} je Plan</h2>
        ${benchRows.length ? table(['Plan', 'Sofort bereit', 'In 1 bis 2 Jahren', 'In 3 oder mehr Jahren', 'Offene Vorschläge'], benchRows) : ui.empty('Noch keine Pläne.')}
      </article>
      <article class="card successionBlock"><h2>Pläne, für die niemand sofort bereit ist</h2>
        ${withoutReady || ui.empty('Für jeden Plan ist mindestens eine Person sofort bereit.')}
      </article>`;
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

  function bind() {
    onAll('[data-succession-plan]', element => {
      state.planId = Number(element.dataset.successionPlan);
      window.loop.navigate('successionPlan');
    });
    onAll('[data-succession-toggle-archived]', () => {
      state.showArchived = !state.showArchived;
      reload();
    });
    onAll('[data-succession-plan-new]', () => openPlanDialog());
    onAll('[data-succession-plan-edit]', () => openPlanDialog(state.detail.plan));
    onAll('[data-succession-reviewed]', async () => {
      await post(`/api/succession/plans/${encodeURIComponent(state.detail.plan.id)}/reviewed`);
      ui.toast('Überprüfung bestätigt.');
      reload();
    });
    onAll('[data-succession-candidate-new]', () => openCandidateDialog());
    onAll('[data-succession-candidate-edit]', element => {
      const id = Number(element.dataset.successionCandidateEdit);
      return openCandidateDialog(state.detail.candidates.find(candidate => candidate.id === id));
    });
    onAll('[data-succession-candidate-status]', async element => {
      await patch(`/api/succession/candidates/${encodeURIComponent(element.dataset.candidate)}`, { status: element.dataset.successionCandidateStatus });
      ui.toast('Gespeichert.');
      reload();
    });
  }

  /** Unten rechts sitzt Dayo. Der Platz am Seitenende sorgt dafür, dass die letzte Zeile frei bleibt. */
  const withRoomForDayo = page => async () => `${await page()}<div class="successionPageEnd" aria-hidden="true"></div>`;

  window.loop.registerAddress?.({
    successionPlan: { get: () => state.planId, set: id => { state.planId = id; } }
  });

  window.loop.registerModule({
    key: 'succession',
    label: 'Nachfolgeplanung',
    nav(me) {
      if (!ALLOWED_ROLES.includes(me.role)) return [];
      return [{ route: 'successionHome', label: 'Nachfolgeplanung', group: 'growth', views: VIEWS }];
    },
    pages: { successionHome: withRoomForDayo(homePage), successionPlan: withRoomForDayo(planPage), successionMetrics: withRoomForDayo(metricsPage) },
    tabs(view, me) {
      if (!ALLOWED_ROLES.includes(me.role) || !VIEWS.includes(view)) return [];
      return [
        { route: 'successionHome', label: 'Pläne', active: view === 'successionHome' || view === 'successionPlan' },
        { route: 'successionMetrics', label: 'Kennzahlen', active: view === 'successionMetrics' }
      ];
    },
    bind,
    taskAction(task) {
      if (task.type !== 'succession_review' && task.type !== 'succession_candidate_proposal') return '';
      return `<button class="btn primary" data-succession-plan="${esc(task.entity_id)}">Plan öffnen</button>`;
    }
  });
})();
