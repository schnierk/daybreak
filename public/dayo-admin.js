(function () {
  'use strict';

  const state = {
    filters: { status: 'active', priority: '', search: '' },
    feedback: [],
    summary: { total: 0, open: 0, inProgress: 0, resolved: 0, dismissed: 0 }
  };
  const statusLabels = { open: 'Offen', in_progress: 'In Bearbeitung', resolved: 'Umgesetzt', dismissed: 'Verworfen' };
  const priorityLabels = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', critical: 'Kritisch' };
  const sourceLabels = { knowledge: 'Wissensbasis', data: 'Daten aus Daybreak', ollama: 'Lokale KI' };
  const toolLabels = {
    my_manager_name: 'Eigene Führungskraft',
    my_goals_progress: 'Eigene Ziele',
    team_member_count: 'Teamgröße',
    team_member_names: 'Namen im Team',
    team_goals_at_completion: 'Erreichte Ziele',
    team_goals_below_progress: 'Zielfortschritt',
    team_checkins_missing: 'Fehlende Check-ins',
    team_open_task_count: 'Offene Aufgaben',
    feedback_nomination_counts: 'Nominierungen im 360° Feedback'
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
  const api = (...args) => window.loop.api(...args);

  function formatDate(value) {
    if (!value) return '–';
    const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function matchesFilters(item) {
    const { status, priority, search } = state.filters;
    if (status === 'active' && !['open', 'in_progress'].includes(item.status)) return false;
    if (status && status !== 'active' && item.status !== status) return false;
    if (priority && item.priority !== priority) return false;
    if (search) {
      const haystack = [item.user_name, item.question, item.answer, item.expected_answer, item.review_note, item.data_tool, item.model].join(' ').toLocaleLowerCase('de-DE');
      if (!haystack.includes(search.toLocaleLowerCase('de-DE'))) return false;
    }
    return true;
  }

  function options(values, current, labels) {
    return values.map(value => `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(labels[value])}</option>`).join('');
  }

  function feedbackCard(item) {
    const initials = item.user_name.split(' ').map(part => part[0]).join('').slice(0, 2);
    const source = [sourceLabels[item.provider], item.model, toolLabels[item.data_tool]].filter(Boolean).join(' · ') || sourceLabels.knowledge;
    return `<article class="dayo-backlog-card" data-feedback-id="${item.id}">
      <div class="dayo-backlog-card-head">
        <div class="dayo-backlog-person"><span class="avatar">${escapeHtml(initials)}</span><span><b>${escapeHtml(item.user_name)}</b><small>${formatDate(item.created_at)} · Vorschlag #${item.id}</small></span></div>
        <div class="dayo-backlog-badges"><span class="dayo-priority priority-${escapeHtml(item.priority)}">${escapeHtml(priorityLabels[item.priority] || item.priority)}</span><span class="dayo-workflow status-${escapeHtml(item.status)}">${escapeHtml(statusLabels[item.status] || item.status)}</span></div>
      </div>
      <div class="dayo-backlog-question"><small>FRAGE AN DAYO</small><h2>${escapeHtml(item.question)}</h2></div>
      <div class="dayo-answer-comparison">
        <section><small>DAYOS ANTWORT</small><p>${escapeHtml(item.answer)}</p></section>
        <section class="expected"><small>ERWARTETE ANTWORT</small><p>${escapeHtml(item.expected_answer || 'Keine erwartete Antwort beschrieben.')}</p></section>
      </div>
      <div class="dayo-backlog-meta"><span>Quelle: ${escapeHtml(source)}</span>${item.reviewer_name ? `<span>Geprüft von ${escapeHtml(item.reviewer_name)}${item.reviewed_at ? ` · ${formatDate(item.reviewed_at)}` : ''}</span>` : '<span>Noch nicht geprüft</span>'}</div>
      ${item.review_note ? `<div class="dayo-review-note"><b>Interne Notiz</b><p>${escapeHtml(item.review_note)}</p></div>` : ''}
      <details class="dayo-review-editor">
        <summary>Vorschlag prüfen und bearbeiten <span aria-hidden="true">→</span></summary>
        <form data-dayo-feedback-review="${item.id}">
          <div class="two"><div><label>Status</label><select name="status">${options(['open', 'in_progress', 'resolved', 'dismissed'], item.status, statusLabels)}</select></div><div><label>Priorität</label><select name="priority">${options(['low', 'normal', 'high', 'critical'], item.priority, priorityLabels)}</select></div></div>
          <label>Interne Notiz</label>
          <textarea name="reviewNote" rows="4" maxlength="1500" placeholder="Was soll verbessert werden, wie wurde entschieden oder wo wurde es umgesetzt?">${escapeHtml(item.review_note || '')}</textarea>
          <div class="dayo-review-actions"><small data-dayo-review-error></small><button type="submit" class="btn primary">Änderungen speichern</button></div>
        </form>
      </details>
    </article>`;
  }

  function filteredFeedback() {
    return state.feedback.filter(matchesFilters);
  }

  function metric(label, value, status, hint) {
    const active = state.filters.status === status;
    return `<button type="button" class="dayo-backlog-metric ${active ? 'is-active' : ''}" data-dayo-status-shortcut="${status}"><small>${escapeHtml(label)}</small><strong>${value}</strong><span>${escapeHtml(hint)}</span></button>`;
  }

  async function backlog() {
    const data = await api('/api/assistant/feedback?kind=improvements');
    state.feedback = data.feedback || [];
    state.summary = { ...state.summary, ...(data.summary || {}) };
    const items = filteredFeedback();
    const activeFilterCount = Number(state.filters.status !== 'active') + Number(!!state.filters.priority) + Number(!!state.filters.search);
    return `<header class="top dayo-backlog-top"><div><small class="dayo-admin-kicker">ADMINISTRATION · DAYO</small><h1>Vorschläge für Dayo</h1><p>Hier stehen Antworten, die jemand mit dem Daumen nach unten bewertet hat, zusammen mit der erwarteten Antwort. Du prüfst sie und hältst fest, was daraus wird.</p></div><span class="dayo-safe-badge">Dayo lernt nicht von selbst</span></header>
      <section class="dayo-backlog-metrics" aria-label="Stand der Vorschläge">
        ${metric('Offen', state.summary.open, 'open', 'wartet auf Prüfung')}
        ${metric('In Bearbeitung', state.summary.inProgress, 'in_progress', 'wird gerade umgesetzt')}
        ${metric('Umgesetzt', state.summary.resolved, 'resolved', 'ist erledigt')}
        ${metric('Verworfen', state.summary.dismissed, 'dismissed', 'wird nicht umgesetzt')}
      </section>
      <article class="card dayo-backlog-info"><span class="dayo-backlog-info-icon">D</span><div><b>Eine Bewertung ändert Dayo nie von selbst.</b><p>HR prüft die Vorschläge und hält die Entscheidung fest. Dayos Antworten ändern sich erst, wenn jemand die Hilfetexte im Programm anpasst.</p></div></article>
      <article class="card dayo-backlog-filters">
        <form data-dayo-backlog-filters>
          <div><label>Suche</label><input name="search" value="${escapeHtml(state.filters.search)}" placeholder="Person, Frage oder erwartete Antwort"></div>
          <div><label>Status</label><select name="status"><option value="active" ${state.filters.status === 'active' ? 'selected' : ''}>Offen & in Bearbeitung</option><option value="" ${state.filters.status === '' ? 'selected' : ''}>Alle</option>${options(['open', 'in_progress', 'resolved', 'dismissed'], state.filters.status, statusLabels)}</select></div>
          <div><label>Priorität</label><select name="priority"><option value="">Alle Prioritäten</option>${options(['critical', 'high', 'normal', 'low'], state.filters.priority, priorityLabels)}</select></div>
          <button type="submit" class="btn primary">Anzeigen</button>
          <button type="button" class="btn" data-dayo-filter-reset ${activeFilterCount ? '' : 'disabled'}>Zurücksetzen</button>
        </form>
        <div class="dayo-backlog-result"><b>${items.length}</b> von ${state.summary.total === 1 ? '1 Vorschlag' : `${state.summary.total} Vorschlägen`} sichtbar</div>
      </article>
      <section class="dayo-backlog-list">
        ${items.length ? items.map(feedbackCard).join('') : `<article class="card dayo-backlog-empty"><span>✓</span><h2>Für diesen Filter ist alles erledigt.</h2><p class="muted">Neue Vorschläge erscheinen hier, sobald jemand eine Antwort mit dem Daumen nach unten bewertet und beschreibt, was er erwartet hätte.</p>${state.summary.total ? '<button type="button" class="btn" data-dayo-show-all>Alle Vorschläge anzeigen</button>' : ''}</article>`}
      </section>`;
  }

  function notify(message, error = false) {
    document.querySelector('.dayo-admin-toast')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="dayo-admin-toast ${error ? 'is-error' : ''}" role="status">${escapeHtml(message)}</div>`);
    setTimeout(() => document.querySelector('.dayo-admin-toast')?.remove(), 3200);
  }

  function bind() {
    const filters = document.querySelector('[data-dayo-backlog-filters]');
    if (filters) filters.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      state.filters = { status: values.status || '', priority: values.priority || '', search: String(values.search || '').trim() };
      window.loop.navigate('dayoBacklog');
    };
    document.querySelector('[data-dayo-filter-reset]')?.addEventListener('click', () => {
      state.filters = { status: 'active', priority: '', search: '' };
      window.loop.navigate('dayoBacklog');
    });
    document.querySelector('[data-dayo-show-all]')?.addEventListener('click', () => {
      state.filters = { status: '', priority: '', search: '' };
      window.loop.navigate('dayoBacklog');
    });
    document.querySelectorAll('[data-dayo-status-shortcut]').forEach(button => button.addEventListener('click', () => {
      state.filters.status = button.dataset.dayoStatusShortcut;
      window.loop.navigate('dayoBacklog');
    }));
    document.querySelectorAll('[data-dayo-feedback-review]').forEach(form => form.onsubmit = async event => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      const error = form.querySelector('[data-dayo-review-error]');
      const payload = Object.fromEntries(new FormData(form));
      submit.disabled = true;
      error.textContent = '';
      try {
        await api(`/api/assistant/feedback/${form.dataset.dayoFeedbackReview}`, { method: 'PATCH', body: JSON.stringify(payload) });
        notify('Vorschlag gespeichert.');
        window.loop.navigate('dayoBacklog');
      } catch (requestError) {
        error.textContent = requestError.message || 'Änderung konnte nicht gespeichert werden.';
        submit.disabled = false;
      }
    });
  }

  window.dayoAdminPages = { backlog };
  window.dayoAdminBind = bind;
})();
