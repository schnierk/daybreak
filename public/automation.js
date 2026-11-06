(function () {
  let snapshot = null;
  let autoRefreshTimer = null;
  const AUTO_REFRESH_MS = 5000;
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = value => value ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(`${value.replace(' ', 'T')}Z`)) : '–';
  const formatReset = value => value ? new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Zeitpunkt nicht verfügbar';
  const statusLabel = status => ({ draft: 'Entwurf', queued: 'Warteschlange', running: 'Codex arbeitet', candidate_ready: 'Kandidat bereit', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen' }[status] || status);
  const deploymentLabel = status => ({ publishing: 'Veröffentlichung läuft', restart_pending: 'Produktiv-Neustart läuft', published: 'Produktiv', publish_failed: 'Veröffentlichung fehlgeschlagen' }[status] || status);
  const planLabel = plan => ({ plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', team: 'ChatGPT Team', business: 'ChatGPT Business', enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu', free: 'ChatGPT Free' }[plan] || plan || 'ChatGPT');

  function windowLabel(minutes) {
    if (minutes === 10080) return 'Wochenkontingent';
    if (minutes === 1440) return 'Tageskontingent';
    if (minutes && minutes % 1440 === 0) return `${minutes / 1440}-Tage-Kontingent`;
    if (minutes && minutes % 60 === 0) return `${minutes / 60}-Stunden-Kontingent`;
    return 'Nutzungskontingent';
  }

  function usagePanel(usage) {
    if (!usage?.available) return `<section class="automation-usage is-unavailable"><div><small class="muted">CODEX-NUTZUNG</small><h2>Kontingent momentan nicht abrufbar</h2><p>Daybreak zeigt keine geschätzten Werte an. Die Programmierfunktion bleibt davon unberührt.</p></div></section>`;
    const windows = [...usage.windows].sort((left, right) => (right.windowDurationMins || 0) - (left.windowDurationMins || 0));
    const cards = windows.map(window => `<article class="automation-quota-card ${window.remainingPercent <= 20 ? 'is-low' : ''}"><div class="automation-quota-head"><div><small>${windowLabel(window.windowDurationMins)}</small><strong>${window.remainingPercent}%</strong><span>verfügbar</span></div><div class="automation-quota-ring" style="--remaining:${window.remainingPercent}%"><b>${window.remainingPercent}%</b></div></div><div class="automation-quota-bar"><span style="width:${window.remainingPercent}%"></span></div><div class="automation-quota-meta"><span>${window.usedPercent}% verwendet</span><span>Reset: ${escapeHtml(formatReset(window.resetsAt))}</span></div></article>`).join('');
    return `<section class="automation-usage"><div class="sectionHead"><div><small class="muted">CODEX-NUTZUNG · ${escapeHtml(planLabel(usage.planType))}</small><h2>Verfügbares Programmierkontingent</h2><p class="muted">Direkt von Codex gemeldet · Stand ${escapeHtml(new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(new Date(usage.fetchedAt)))}</p></div>${usage.rateLimitReachedType ? '<span class="automation-job-status is-failed">Limit erreicht</span>' : '<span class="automation-job-status is-candidate_ready">Live-Daten</span>'}</div><div class="automation-quota-grid">${cards}</div></section>`;
  }

  function readinessItem(ok, label, detail = '') {
    return `<article class="automation-check ${ok ? 'is-ready' : 'is-missing'}"><span>${ok ? '✓' : '!'}</span><div><b>${label}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div></article>`;
  }

  function publicationPanel(job, status) {
    if (job.deployment_status === 'publishing') return '<div class="automation-working automation-publishing"><span></span><div><b>Daybreak wird veröffentlicht</b><small>Zusammenführung, vollständiger Test, Datenbanksicherung und Neustart laufen. Diese Ansicht aktualisiert sich automatisch.</small></div></div>';
    if (job.deployment_status === 'restart_pending') return '<div class="automation-working automation-publishing"><span></span><div><b>Daybreak startet mit dem neuen Stand</b><small>Der neue Produktivprozess bestätigt den Commit automatisch nach dem Neustart.</small></div></div>';
    if (job.deployment_status === 'published') return `<section class="automation-publication-success"><span>✓</span><div><small>PRODUKTIV VERÖFFENTLICHT</small><h3>Daybreak wurde erfolgreich aktualisiert</h3><p>${formatDate(job.deployed_at)} · Commit <code>${escapeHtml((job.deployment_commit || '').slice(0, 12))}</code></p></div></section>`;
    if (job.deployment_status === 'publish_failed') return `<section class="automation-publication-failed"><b>Veröffentlichung nicht abgeschlossen</b><p>${escapeHtml(job.deployment_error || 'Der sichere Veröffentlichungsprozess wurde beendet.')}</p></section>`;
    if (job.status === 'candidate_ready' && !status.publicationReady) return '<p class="automation-publication-hint">Die Veröffentlichung ist auf diesem Server noch nicht freigeschaltet.</p>';
    return '';
  }

  function jobActions(job, status) {
    const actions = [];
    if (['draft', 'failed'].includes(job.status)) actions.push(`<button class="btn primary" data-automation-queue="${job.id}" ${status.ready ? '' : 'disabled'}>Isoliert programmieren & testen</button>`);
    if (['draft', 'queued'].includes(job.status)) actions.push(`<button class="btn" data-automation-cancel="${job.id}">Abbrechen</button>`);
    if (job.status === 'candidate_ready' && ['publish_failed', null, undefined, ''].includes(job.deployment_status)) actions.push(`<button class="btn automation-publish-button" data-automation-publish="${job.id}" ${status.publicationReady ? '' : 'disabled'}>${job.deployment_status === 'publish_failed' ? 'Veröffentlichung erneut versuchen' : 'Jetzt produktiv veröffentlichen'}</button>`);
    return actions.join('');
  }

  async function page() {
    clearTimeout(autoRefreshTimer);
    const [status, feedback, jobs] = await Promise.all([
      window.loop.api('/api/automation/status'),
      window.loop.api('/api/automation/feedback'),
      window.loop.api('/api/automation/jobs')
    ]);
    snapshot = { status, feedback: feedback.items, jobs: jobs.jobs };
    const feedbackRows = snapshot.feedback.map(item => `<tr><td><b>#${item.id} · ${escapeHtml(item.user_name)}</b><small>${escapeHtml(item.question)}</small></td><td>${escapeHtml(item.expected_answer)}</td><td><span class="tag">${escapeHtml(item.priority)}</span></td><td>${item.automation_status ? `<span class="automation-job-status is-${item.automation_status}">${statusLabel(item.automation_status)}</span>` : `<button class="btn" data-automation-feedback="${item.id}">Auftrag vorbereiten</button>`}</td></tr>`).join('');
    const jobRows = snapshot.jobs.map(job => `<article class="card automation-job"><div class="sectionHead"><div><small class="muted">PROGRAMMIERAUFTRAG #${job.id}</small><h2>${job.deployment_status ? deploymentLabel(job.deployment_status) : statusLabel(job.status)}</h2></div><div class="automation-status-stack"><span class="automation-job-status is-${job.status}">${statusLabel(job.status)}</span>${job.deployment_status ? `<span class="automation-job-status is-${job.deployment_status}">${deploymentLabel(job.deployment_status)}</span>` : ''}</div></div><p>${escapeHtml(job.objective)}</p><div class="automation-job-meta"><span>Erstellt ${formatDate(job.created_at)}</span>${job.branch ? `<code>${escapeHtml(job.branch)}</code>` : ''}${job.candidate_commit ? `<code>${escapeHtml(job.candidate_commit.slice(0, 12))}</code>` : ''}</div>${['queued', 'running'].includes(job.status) ? '<div class="automation-working"><span></span><div><b>Codex arbeitet im Hintergrund</b><small>Diese Ansicht aktualisiert sich automatisch alle fünf Sekunden.</small></div></div>' : ''}${publicationPanel(job, status)}${job.summary ? `<section class="automation-codex-answer"><div class="automation-answer-icon">C</div><div><small>CODEX-ARBEITSBERICHT</small><h3>Bericht aus der isolierten Bearbeitung</h3><p class="automation-answer-note">Maßgeblich für die Freigabe sind das anschließend ausgeführte Testergebnis und das Veröffentlichungsprotokoll.</p><pre>${escapeHtml(job.summary)}</pre></div></section>` : ''}${job.test_output ? `<details><summary>Testergebnis des Kandidaten</summary><pre>${escapeHtml(job.test_output)}</pre></details>` : ''}${job.deployment_output ? `<details><summary>Veröffentlichungsprotokoll</summary><pre>${escapeHtml(job.deployment_output)}</pre></details>` : ''}${job.error_message ? `<details open class="automation-error"><summary>Fehler</summary><pre>${escapeHtml(job.error_message)}</pre></details>` : ''}<div class="automation-actions">${jobActions(job, status)}</div></article>`).join('');
    const liveRefresh = snapshot.jobs.some(job => ['queued', 'running'].includes(job.status) || ['publishing', 'restart_pending'].includes(job.deployment_status));
    return `<header class="top"><div><small class="muted">SYSTEMVERWALTUNG</small><h1>Automatische Programmierung</h1><p>Codex erstellt Änderungen isoliert und testet sie. Einen fertigen Kandidaten kann ausschließlich der Super-Admin anschließend bewusst produktiv veröffentlichen.</p></div><span class="automation-security-badge">Super-Admin · Fach- und Systemrechte</span></header>
      <section class="automation-guard"><div><b>Kontrollierte Veröffentlichung</b><p>HR Admin und HRBP haben weder Navigation noch API-Zugriff. Vor jeder Veröffentlichung prüft Daybreak Commit und Schutzliste erneut, führt alle Tests aus, sichert SQLite und startet nur die vorhandene Produktionsinstanz neu.</p></div><span>Nur nach Bestätigung</span></section>
      ${usagePanel(status.codexUsage)}
      <section class="automation-readiness">${readinessItem(status.gitReady, 'Git verfügbar')}${readinessItem(status.repositoryReady, 'Zentrales Repository')}${readinessItem(status.codexInstalled, 'Codex CLI', status.codexVersion)}${readinessItem(status.codexAuthenticated, 'Codex-Zugang')}${readinessItem(status.workerReady, 'Isolierter Worker')}${readinessItem(status.ready, status.ready ? 'Programmierfunktion bereit' : 'Einrichtung unvollständig', `Modell: ${status.model}`)}${readinessItem(status.publicationReady, status.publicationReady ? 'Veröffentlichung bereit' : 'Veröffentlichung gesperrt', status.processManagerApp || 'Nur auf dem freigegebenen Produktivserver')}</section>
      <section class="cards"><article class="card wide"><div class="sectionHead"><div><h2>Geprüfte Dayo-Vorschläge</h2><p class="muted">Aus einem Vorschlag entsteht zunächst nur ein bearbeitbarer Auftrag.</p></div></div><div class="tableWrap"><table class="table"><thead><tr><th>Feedback</th><th>Erwartetes Ergebnis</th><th>Priorität</th><th></th></tr></thead><tbody>${feedbackRows || '<tr><td colspan="4" class="muted">Keine offenen Verbesserungsvorschläge.</td></tr>'}</tbody></table></div></article><article class="card"><h2>Eigener Auftrag</h2><form id="automationManualForm"><label for="automationObjective">Gewünschtes Ergebnis</label><textarea id="automationObjective" name="objective" rows="7" minlength="20" maxlength="4000" required placeholder="Beschreibe beobachtbares Verhalten und Akzeptanzkriterien."></textarea><button class="btn primary full">Entwurf anlegen</button><div class="error" data-automation-error></div></form></article></section>
      <header class="top automation-list-head"><div><h2>Programmieraufträge</h2><p>${snapshot.jobs.length} Aufträge · Produktiv wird ein Kandidat erst nach einer ausdrücklichen Superadmin-Freigabe.</p></div><div class="automation-refresh-actions">${liveRefresh ? '<span class="automation-live-refresh"><i></i> Live · alle 5 Sek.</span>' : ''}<button class="btn" data-automation-refresh>Aktualisieren</button></div></header><section class="automation-jobs">${jobRows || '<article class="card"><p class="muted">Noch kein Programmierauftrag angelegt.</p></article>'}</section>`;
  }

  async function mutate(url, options) {
    try {
      await window.loop.api(url, options);
      window.loop.navigate('automation');
    } catch (error) {
      const target = document.querySelector('[data-automation-error]');
      if (target) target.textContent = error.message;
      else window.alert(error.message);
    }
  }

  function bind() {
    if (window.loop.view !== 'automation') return;
    if (snapshot?.jobs.some(job => ['queued', 'running'].includes(job.status) || ['publishing', 'restart_pending'].includes(job.deployment_status))) {
      autoRefreshTimer = setTimeout(() => {
        if (window.loop.view === 'automation') window.loop.navigate('automation');
      }, AUTO_REFRESH_MS);
    }
    document.querySelector('[data-automation-refresh]')?.addEventListener('click', () => window.loop.navigate('automation'));
    document.querySelector('#automationManualForm')?.addEventListener('submit', event => {
      event.preventDefault();
      mutate('/api/automation/jobs', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    });
    document.querySelectorAll('[data-automation-feedback]').forEach(button => button.addEventListener('click', () => {
      const item = snapshot.feedback.find(entry => entry.id === Number(button.dataset.automationFeedback));
      if (!item) return;
      const objective = `Verbessere Daybreak für diese Nutzererwartung:\n\nFrage: ${item.question}\n\nBisherige Antwort: ${item.answer}\n\nErwartetes Ergebnis: ${item.expected_answer}`;
      document.body.insertAdjacentHTML('beforeend', `<div class="modal" id="modal"><form class="card" id="automationDraftForm"><div class="modalHead"><div><h2>Programmierauftrag vorbereiten</h2><p class="muted">Dayo-Feedback #${item.id}</p></div><button type="button" class="btn" id="close">×</button></div><label for="draftObjective">Gewünschtes Ergebnis und Akzeptanzkriterien</label><textarea id="draftObjective" name="objective" rows="12" minlength="20" maxlength="4000" required>${escapeHtml(objective)}</textarea><div class="error" data-automation-error></div><button class="btn primary full">Als Entwurf speichern</button></form></div>`);
      document.querySelector('#close').onclick = () => document.querySelector('#modal')?.remove();
      document.querySelector('#automationDraftForm').onsubmit = event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        data.feedbackId = item.id;
        mutate('/api/automation/jobs', { method: 'POST', body: JSON.stringify(data) });
      };
    }));
    document.querySelectorAll('[data-automation-queue]').forEach(button => button.addEventListener('click', () => mutate(`/api/automation/jobs/${button.dataset.automationQueue}/queue`, { method: 'POST' })));
    document.querySelectorAll('[data-automation-cancel]').forEach(button => button.addEventListener('click', () => mutate(`/api/automation/jobs/${button.dataset.automationCancel}/cancel`, { method: 'POST' })));
    document.querySelectorAll('[data-automation-publish]').forEach(button => button.addEventListener('click', () => {
      const job = snapshot.jobs.find(entry => entry.id === Number(button.dataset.automationPublish));
      if (!job) return;
      document.body.insertAdjacentHTML('beforeend', `<div class="modal" id="modal"><form class="card automation-publish-modal" id="automationPublishForm"><div class="modalHead"><div><small class="muted">PROGRAMMIERAUFTRAG #${job.id}</small><h2>Kandidat produktiv veröffentlichen?</h2></div><button type="button" class="btn" id="close">×</button></div><div class="automation-publish-warning"><span>!</span><p><b>Daybreak wird kurz neu gestartet.</b><br>Vorher werden der Kandidat erneut geprüft, alle Tests ausgeführt und die SQLite-Datenbank gesichert.</p></div><dl><div><dt>Branch</dt><dd><code>${escapeHtml(job.branch)}</code></dd></div><div><dt>Kandidat</dt><dd><code>${escapeHtml(job.candidate_commit.slice(0, 12))}</code></dd></div></dl><label class="automation-confirm-check"><input type="checkbox" required> Ich habe die Codex-Antwort geprüft und möchte diesen Kandidaten jetzt produktiv setzen.</label><div class="error" data-automation-error></div><button class="btn automation-publish-button full">Prüfen & produktiv veröffentlichen</button></form></div>`);
      document.querySelector('#close').onclick = () => document.querySelector('#modal')?.remove();
      document.querySelector('#automationPublishForm').onsubmit = event => {
        event.preventDefault();
        mutate(`/api/automation/jobs/${job.id}/publish`, { method: 'POST', body: JSON.stringify({ confirmation: 'VERÖFFENTLICHEN' }) });
      };
    }));
  }

  window.automationPages = { page, bind };
})();
