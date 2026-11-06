(function () {
  'use strict';

  const STORAGE_PREFIX = 'daybreak.dayo.preferences.';
  const SESSION_PREFIX = 'daybreak.dayo.session.';
  const rootId = 'dayoRoot';
  const panelId = 'dayoPanel';
  const restoreId = 'dayoRestore';
  const feedbackContexts = new WeakMap();
  // So viel von Dayo bleibt sichtbar, wenn er einem Knopf Platz macht. Groß genug zum Antippen.
  const VISIBLE_WHEN_TUCKED = 30;
  const CONTROL_SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,label,[role="button"]';
  const state = {
    userId: null,
    root: null,
    panel: null,
    restore: null,
    preferences: null,
    dragging: null,
    dragged: false,
    clickTimer: null,
    bubbleTimer: null,
    moodTimer: null,
    grimaceTimer: null,
    tuckTimer: null,
    tucked: false,
    statusView: null,
    assistantStatus: null,
    messagesStarted: false,
    answering: false
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
  const currentUser = () => window.loop?.me || null;
  const currentView = () => window.loop?.view || 'dashboard';
  const storageKey = userId => STORAGE_PREFIX + userId;
  const defaultPreferences = () => ({ x: null, y: null, quiet: false, hidden: false });
  const usesTouch = () => window.matchMedia('(pointer: coarse)').matches;
  // Unterhalb dieser Breite gibt es die Handy-Ansicht der Seite. Dort öffnet ein Tipp, auch mit der Maus.
  const opensOnSingleTap = () => usesTouch() || window.innerWidth <= 900;
  const dialogIsOpen = () => document.body.classList.contains('modal-open');
  const answeredFromData = response => response.dataQuery && !response.dataQuery.denied;

  function loadPreferences(userId) {
    try {
      return { ...defaultPreferences(), ...JSON.parse(localStorage.getItem(storageKey(userId)) || '{}') };
    } catch {
      return defaultPreferences();
    }
  }

  function savePreferences() {
    if (!state.userId || !state.preferences) return;
    try { localStorage.setItem(storageKey(state.userId), JSON.stringify(state.preferences)); } catch { /* Browser-Speicher ist optional. */ }
  }

  function petMarkup() {
    return `<div class="dayo-bubble" role="status" aria-live="polite"></div>
      <button type="button" class="dayo-pet" aria-label="Dayo öffnen oder verschieben" aria-expanded="false" aria-controls="${panelId}">
        <svg class="dayo-svg" viewBox="0 0 118 132" aria-hidden="true">
          <g class="dayo-shadow"><ellipse cx="59" cy="123" rx="34" ry="5"/></g>
          <g class="dayo-arms">
            <g class="dayo-limb-motion dayo-arm-left">
              <path class="dayo-limb-outline" d="M19 66C10 63 8 54 13 48"/>
              <path class="dayo-limb" d="M19 66C10 63 8 54 13 48"/>
            </g>
            <g class="dayo-limb-motion dayo-arm-right">
              <path class="dayo-limb-outline" d="M96 65c10-5 13-14 8-20"/>
              <path class="dayo-limb" d="M96 65c10-5 13-14 8-20"/>
            </g>
          </g>
          <g class="dayo-body">
            <path class="dayo-face-panel" d="M45 37v48h12c15 0 24-8 24-24s-9-24-24-24H45Z"/>
            <path class="dayo-body-shape" fill-rule="evenodd" d="M24 12h35c31 0 49 20 49 49S90 110 59 110H24a12 12 0 0 1-12-12V24a12 12 0 0 1 12-12Zm21 25v48h12c15 0 24-8 24-24s-9-24-24-24H45Z"/>
            <path class="dayo-highlight" d="M27 22h28c23 0 38 10 43 29"/>
          </g>
          <g class="dayo-face">
            <g class="dayo-eye-motion dayo-eye-motion-left">
              <g class="dayo-eye-blink">
                <ellipse class="dayo-eye" cx="36.5" cy="46" rx="8" ry="10.2"/>
                <circle class="dayo-pupil" cx="36.5" cy="46" r="2.25"/>
              </g>
            </g>
            <g class="dayo-eye-motion dayo-eye-motion-right">
              <g class="dayo-eye-blink">
                <ellipse class="dayo-eye" cx="62.5" cy="46" rx="8" ry="10.2"/>
                <circle class="dayo-pupil" cx="62.5" cy="46" r="2.25"/>
              </g>
            </g>
            <path class="dayo-brow dayo-brow-left" d="M29 33q8-5 16 0"/>
            <path class="dayo-brow dayo-brow-right" d="M54 33q8-5 16 0"/>
            <path class="dayo-nose" d="M49 57q4 4 0 7q3 2 6 0"/>
          </g>
          <g class="dayo-mouth-group">
            <path class="dayo-mouth-outline" d="M28 69Q50 88 76 69"/>
            <path class="dayo-mouth" d="M28 69Q50 88 76 69"/>
          </g>
          <g class="dayo-cheeks"><circle cx="25" cy="65" r="4.5"/><circle cx="79" cy="65" r="4.5"/></g>
          <g class="dayo-feet">
            <g class="dayo-limb-motion dayo-foot-left">
              <path class="dayo-limb-outline" d="M35 109q-7 7-14 2"/>
              <path class="dayo-limb" d="M35 109q-7 7-14 2"/>
            </g>
            <g class="dayo-limb-motion dayo-foot-right">
              <path class="dayo-limb-outline" d="M74 109q8 7 15 1"/>
              <path class="dayo-limb" d="M74 109q8 7 15 1"/>
            </g>
          </g>
        </svg>
        <span class="dayo-name">Dayo</span>
      </button>`;
  }

  function panelMarkup() {
    return `<aside class="dayo-panel" id="${panelId}" role="dialog" aria-modal="false" aria-labelledby="dayoTitle" aria-hidden="true" inert>
      <header class="dayo-panel-header">
        <div class="dayo-panel-avatar" aria-hidden="true"><span>D</span><i></i></div>
        <div><strong id="dayoTitle">Dayo</strong><small>Dein Daybreak-Begleiter</small></div>
        <button type="button" class="dayo-icon-button" data-dayo-settings aria-label="Dayo-Einstellungen" title="Einstellungen">•••</button>
        <button type="button" class="dayo-icon-button" data-dayo-close aria-label="Assistent schließen">×</button>
      </header>
      <section class="dayo-settings" hidden>
        <button type="button" data-dayo-quiet></button>
        <button type="button" data-dayo-hide>Dayo ausblenden</button>
        <p>Deine Fragen werden nicht gespeichert. Nur wenn du eine Antwort mit dem Daumen bewertest, sichert Daybreak Frage, Antwort und deinen Vorschlag für die Prüfung durch HR.</p>
      </section>
      <div class="dayo-provider"><span class="dayo-provider-dot"></span><span data-dayo-provider>Lokale Daybreak-Hilfe</span></div>
      <div class="dayo-messages" data-dayo-messages aria-live="polite"></div>
      <div class="dayo-suggestions" data-dayo-suggestions></div>
      <form class="dayo-form" data-dayo-form>
        <label class="sr-only" for="dayoQuestion">Frage an Dayo</label>
        <textarea id="dayoQuestion" name="message" rows="2" maxlength="500" placeholder="Wie funktioniert …?" required></textarea>
        <button type="submit" aria-label="Frage senden" title="Frage senden">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14"/></svg>
        </button>
      </form>
    </aside>`;
  }

  function restoreMarkup() {
    return `<button type="button" class="dayo-restore" id="${restoreId}" aria-label="Dayo wieder einblenden" title="Dayo wieder einblenden"><span>D</span><i></i></button>`;
  }

  function mount() {
    const user = currentUser();
    if (!user || !document.querySelector('.shell')) return;
    unmount();
    state.userId = user.id;
    state.preferences = loadPreferences(user.id);
    document.body.insertAdjacentHTML('beforeend', `<div class="dayo-root" id="${rootId}" data-mood="happy">${petMarkup()}</div>${panelMarkup()}${restoreMarkup()}`);
    state.root = document.getElementById(rootId);
    state.panel = document.getElementById(panelId);
    state.restore = document.getElementById(restoreId);
    bindPet();
    bindPanel();
    applyPreferences();
    scheduleGreeting();
    scheduleGrimace();
  }

  function unmount() {
    clearTimeout(state.clickTimer);
    clearTimeout(state.bubbleTimer);
    clearTimeout(state.moodTimer);
    clearTimeout(state.grimaceTimer);
    clearTimeout(state.tuckTimer);
    document.body.classList.remove('has-dayo');
    document.getElementById(rootId)?.remove();
    document.getElementById(panelId)?.remove();
    document.getElementById(restoreId)?.remove();
    Object.assign(state, { userId: null, root: null, panel: null, restore: null, preferences: null, dragging: null, tucked: false, messagesStarted: false, assistantStatus: null, statusView: null, answering: false });
  }

  function sync() {
    const user = currentUser();
    const authenticated = !!user && !!document.querySelector('.shell') && (window.loop?.isModuleEnabled?.('assistant') ?? true);
    if (!authenticated) {
      if (state.root || state.panel) unmount();
      return;
    }
    if (state.userId !== user.id || !state.root) mount();
  }

  function applyPreferences() {
    if (!state.root || !state.preferences) return;
    state.root.classList.toggle('is-quiet', state.preferences.quiet);
    state.root.hidden = state.preferences.hidden;
    state.restore.hidden = !state.preferences.hidden;
    document.body.classList.toggle('has-dayo', !state.preferences.hidden);
    const margin = window.innerWidth <= 620 ? 10 : 18;
    const defaultX = window.innerWidth - (state.root.offsetWidth || 104) - margin;
    const defaultY = window.innerHeight - (state.root.offsetHeight || 124) - margin;
    const x = Number.isFinite(state.preferences.x) ? state.preferences.x : defaultX;
    const y = Number.isFinite(state.preferences.y) ? state.preferences.y : defaultY;
    setPosition(x, y, false);
    state.root.querySelector('.dayo-pet').title = `${opensOnSingleTap() ? 'Antippen für Hilfe.' : 'Doppelklick für Hilfe, einfacher Klick für einen Tipp.'} Du kannst Dayo frei verschieben.`;
    updateQuietButton();
    scheduleTuckCheck();
  }

  function homePosition() {
    return { x: parseFloat(state.root.style.left) || 0, y: parseFloat(state.root.style.top) || 0 };
  }

  function controlUnderDayo() {
    const { x, y } = homePosition();
    const width = state.root.offsetWidth;
    const height = state.root.offsetHeight;
    const isDayo = element => state.root.contains(element) || state.panel?.contains(element) || state.restore?.contains(element);
    for (const horizontal of [0.15, 0.5, 0.85]) {
      for (const vertical of [0.15, 0.5, 0.85]) {
        const onTop = document.elementsFromPoint(x + width * horizontal, y + height * vertical).find(element => !isDayo(element));
        if (onTop?.closest(CONTROL_SELECTOR)) return true;
      }
    }
    return false;
  }

  function setTucked(tucked) {
    state.tucked = tucked;
    state.root.classList.toggle('is-tucked', tucked);
    if (!tucked) return;
    const { x } = homePosition();
    const shift = state.root.dataset.side === 'left'
      ? -(x + state.root.offsetWidth - VISIBLE_WHEN_TUCKED)
      : window.innerWidth - x - VISIBLE_WHEN_TUCKED;
    state.root.style.setProperty('--dayo-tuck-x', `${Math.round(shift)}px`);
  }

  /** Liegt unter Dayo ein Knopf oder Feld, weicht er an den Rand aus. So bleibt alles erreichbar, und er selbst auch. */
  function scheduleTuckCheck() {
    clearTimeout(state.tuckTimer);
    state.tuckTimer = setTimeout(() => {
      if (!state.root || state.root.hidden || state.dragging || isPanelOpen() || dialogIsOpen()) return;
      setTucked(controlUnderDayo());
    }, 160);
  }

  function setPosition(x, y, persist = true) {
    if (!state.root) return;
    const width = state.root.offsetWidth || 104;
    const height = state.root.offsetHeight || 124;
    const safeX = Math.min(Math.max(6, x), Math.max(6, window.innerWidth - width - 6));
    const safeY = Math.min(Math.max(76, y), Math.max(76, window.innerHeight - height - 6));
    state.root.style.left = `${safeX}px`;
    state.root.style.top = `${safeY}px`;
    state.root.dataset.side = safeX + width / 2 < window.innerWidth / 2 ? 'left' : 'right';
    updateGaze(safeX, safeY, width, height);
    if (persist && state.preferences) {
      state.preferences.x = Math.round(safeX);
      state.preferences.y = Math.round(safeY);
      savePreferences();
    }
    if (isPanelOpen()) positionPanel();
  }

  function updateGaze(x, y, width, height) {
    if (!state.root) return;
    const relativeX = Math.max(-1, Math.min(1, (window.innerWidth / 2 - (x + width / 2)) / Math.max(1, (window.innerWidth - width) / 2)));
    const relativeY = Math.max(-1, Math.min(1, (window.innerHeight / 2 - (y + height / 2)) / Math.max(1, (window.innerHeight - height) / 2)));
    state.root.style.setProperty('--dayo-look-x', `${(relativeX * 3.5).toFixed(2)}px`);
    state.root.style.setProperty('--dayo-look-y', `${(relativeY * 4).toFixed(2)}px`);

    const horizontal = relativeX > .24 ? 'right' : relativeX < -.24 ? 'left' : 'center';
    const vertical = relativeY > .24 ? 'down' : relativeY < -.24 ? 'up' : 'center';
    state.root.dataset.gaze = horizontal === 'center' ? vertical : vertical === 'center' ? horizontal : `${vertical}-${horizontal}`;
  }

  function bindPet() {
    const pet = state.root.querySelector('.dayo-pet');
    pet.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const { x, y } = homePosition();
      state.dragging = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
      state.dragged = false;
      pet.setPointerCapture?.(event.pointerId);
      state.root.classList.add('is-dragging');
    });
    pet.addEventListener('pointermove', event => {
      if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
      const dx = event.clientX - state.dragging.startX;
      const dy = event.clientY - state.dragging.startY;
      if (Math.hypot(dx, dy) > 5) {
        state.dragged = true;
        if (state.tucked) setTucked(false);
      }
      if (state.dragged) setPosition(state.dragging.x + dx, state.dragging.y + dy, false);
    });
    pet.addEventListener('pointerup', event => {
      if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
      const wasDragged = state.dragged;
      state.dragging = null;
      state.root.classList.remove('is-dragging');
      if (wasDragged) {
        const rect = state.root.getBoundingClientRect();
        const snapX = rect.left < 34 ? 8 : rect.right > window.innerWidth - 34 ? window.innerWidth - rect.width - 8 : rect.left;
        setPosition(snapX, rect.top, true);
        scheduleTuckCheck();
      } else if (event.pointerType !== 'mouse' || opensOnSingleTap() || state.tucked) {
        openPanel();
      }
      setTimeout(() => { state.dragged = false; }, 0);
    });
    pet.addEventListener('click', event => {
      if (state.dragged || event.detail === 0 || opensOnSingleTap() || state.tucked) return;
      clearTimeout(state.clickTimer);
      state.clickTimer = setTimeout(() => showContextQuip(), 240);
    });
    pet.addEventListener('dblclick', event => {
      event.preventDefault();
      clearTimeout(state.clickTimer);
      openPanel();
    });
    pet.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPanel();
      }
      const step = event.shiftKey ? 20 : 8;
      const { x, y } = homePosition();
      if (event.key === 'ArrowLeft') setPosition(x - step, y);
      if (event.key === 'ArrowRight') setPosition(x + step, y);
      if (event.key === 'ArrowUp') setPosition(x, y - step);
      if (event.key === 'ArrowDown') setPosition(x, y + step);
      if (event.key.startsWith('Arrow')) scheduleTuckCheck();
    });
    state.restore.addEventListener('click', () => {
      state.preferences.hidden = false;
      savePreferences();
      applyPreferences();
      say('Da bin ich wieder! Bereit für den nächsten Schritt?', 'happy', true);
    });
  }

  function bindPanel() {
    state.panel.querySelector('[data-dayo-close]').addEventListener('click', () => {
      closePanel();
      state.root?.querySelector('.dayo-pet')?.focus({ preventScroll: true });
    });
    const settings = state.panel.querySelector('.dayo-settings');
    state.panel.querySelector('[data-dayo-settings]').addEventListener('click', () => { settings.hidden = !settings.hidden; });
    state.panel.querySelector('[data-dayo-quiet]').addEventListener('click', () => {
      state.preferences.quiet = !state.preferences.quiet;
      savePreferences();
      applyPreferences();
      if (!state.preferences.quiet) say('Ruhemodus aus. Ich melde mich dezent, versprochen.', 'happy', true);
    });
    state.panel.querySelector('[data-dayo-hide]').addEventListener('click', () => {
      state.preferences.hidden = true;
      savePreferences();
      closePanel();
      applyPreferences();
    });
    state.panel.querySelector('[data-dayo-form]').addEventListener('submit', event => {
      event.preventDefault();
      const input = event.currentTarget.elements.message;
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      ask(question);
    });
    state.panel.addEventListener('click', event => {
      const suggestion = event.target.closest('[data-dayo-question]');
      const action = event.target.closest('[data-dayo-view]');
      const rating = event.target.closest('[data-dayo-rating]');
      const cancelFeedback = event.target.closest('[data-dayo-feedback-cancel]');
      if (suggestion) ask(suggestion.dataset.dayoQuestion);
      if (action) {
        const targetView = action.dataset.dayoView;
        closePanel();
        window.loop?.navigate(targetView);
        setTimeout(() => say('Da sind wir. Ich bleibe in der Nähe.', 'proud', true), 450);
      }
      if (rating) handleAnswerRating(rating);
      if (cancelFeedback) resetAnswerFeedback(cancelFeedback.closest('.dayo-message'));
    });
    state.panel.addEventListener('submit', event => {
      const form = event.target.closest('[data-dayo-feedback-form]');
      if (!form) return;
      event.preventDefault();
      submitNegativeFeedback(form);
    });
    document.addEventListener('keydown', handleEscape);
  }

  function handleEscape(event) {
    // Bei offenem Dialog gehört die Taste dem Dialog.
    if (event.key !== 'Escape' || !isPanelOpen() || dialogIsOpen()) return;
    closePanel();
    state.root?.querySelector('.dayo-pet')?.focus({ preventScroll: true });
  }

  function isPanelOpen() {
    return state.panel?.classList.contains('is-open');
  }

  async function openPanel() {
    if (!state.panel || state.preferences?.hidden) return;
    state.panel.classList.add('is-open');
    state.panel.setAttribute('aria-hidden', 'false');
    state.panel.removeAttribute('inert');
    state.root.querySelector('.dayo-pet').setAttribute('aria-expanded', 'true');
    setMood('curious', 1600);
    positionPanel();
    if (!state.messagesStarted) {
      state.messagesStarted = true;
      appendAssistant({
        title: `Hallo ${currentUser()?.name?.split(' ')[0] || ''}!`,
        answer: 'Ich erkläre dir Daybreak und bringe dich direkt zur passenden Funktion. Was möchtest du wissen?',
        steps: [], actions: []
      });
    }
    await refreshStatus();
    focusQuestion();
  }

  // Am Handy würde der Fokus die Tastatur öffnen und die Antwort verdecken.
  function focusQuestion() {
    if (!usesTouch()) state.panel?.querySelector('#dayoQuestion')?.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!state.panel) return;
    state.panel.classList.remove('is-open');
    state.panel.setAttribute('aria-hidden', 'true');
    state.panel.setAttribute('inert', '');
    state.root?.querySelector('.dayo-pet')?.setAttribute('aria-expanded', 'false');
    scheduleTuckCheck();
  }

  function positionPanel() {
    if (!state.panel || !state.root || !isPanelOpen()) return;
    if (window.innerWidth <= 620) {
      state.panel.style.left = '12px';
      state.panel.style.top = 'auto';
      state.panel.style.bottom = '12px';
      return;
    }
    state.panel.style.bottom = 'auto';
    const petRect = state.root.getBoundingClientRect();
    const panelWidth = state.panel.offsetWidth || 390;
    const panelHeight = state.panel.offsetHeight || 560;
    const openLeft = petRect.left > window.innerWidth / 2;
    const left = openLeft ? petRect.left - panelWidth - 14 : petRect.right + 14;
    const top = Math.min(Math.max(12, petRect.top + petRect.height / 2 - panelHeight / 2), Math.max(12, window.innerHeight - panelHeight - 12));
    state.panel.style.left = `${Math.min(Math.max(12, left), window.innerWidth - panelWidth - 12)}px`;
    state.panel.style.top = `${top}px`;
  }

  async function refreshStatus() {
    const view = currentView();
    if (state.statusView === view && state.assistantStatus) {
      renderSuggestions(state.assistantStatus.suggestions || []);
      return;
    }
    try {
      const status = await window.loop.api(`/api/assistant/status?view=${encodeURIComponent(view)}`);
      state.assistantStatus = status;
      state.statusView = view;
      state.panel.querySelector('[data-dayo-provider]').textContent = status.label;
      state.panel.classList.toggle('uses-local-ai', status.provider === 'ollama');
      renderSuggestions(status.suggestions || []);
    } catch {
      state.panel.querySelector('[data-dayo-provider]').textContent = 'Lokale Hilfe vorübergehend nicht erreichbar';
      renderSuggestions([]);
    }
  }

  function renderSuggestions(suggestions) {
    const container = state.panel?.querySelector('[data-dayo-suggestions]');
    if (!container) return;
    container.innerHTML = suggestions.length
      ? suggestions.map(item => `<button type="button" data-dayo-question="${escapeHtml(item.question)}">${escapeHtml(item.label)}</button>`).join('')
      : '';
  }

  function appendUser(question) {
    const messages = state.panel.querySelector('[data-dayo-messages]');
    messages.insertAdjacentHTML('beforeend', `<article class="dayo-message is-user"><p>${escapeHtml(question)}</p></article>`);
    messages.scrollTop = messages.scrollHeight;
  }

  function appendAssistant(response, { question = '', rateable = false } = {}) {
    const messages = state.panel.querySelector('[data-dayo-messages]');
    const steps = response.steps?.length ? `<ol>${response.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : '';
    const actions = response.actions?.length ? `<div class="dayo-answer-actions">${response.actions.map(action => `<button type="button" data-dayo-view="${escapeHtml(action.view)}">${escapeHtml(action.label)} <span>→</span></button>`).join('')}</div>` : '';
    const source = answeredFromData(response) ? '<small class="dayo-data-source">Geprüfte Daybreak-Daten · nur lesend</small>' : '';
    const feedback = rateable ? `<div class="dayo-answer-feedback" data-dayo-feedback><span>War das hilfreich?</span><button type="button" data-dayo-rating="1" aria-label="Antwort hilfreich" title="Daumen hoch">👍</button><button type="button" data-dayo-rating="-1" aria-label="Antwort nicht hilfreich" title="Daumen runter">👎</button><div class="dayo-feedback-detail" data-dayo-feedback-detail></div></div>` : '';
    messages.insertAdjacentHTML('beforeend', `<article class="dayo-message is-assistant"><span class="dayo-message-mark">D</span><div><strong>${escapeHtml(response.title || 'Dayos Antwort')}</strong><p>${escapeHtml(response.answer)}</p>${source}${steps}${actions}${feedback}</div></article>`);
    if (rateable) feedbackContexts.set(messages.lastElementChild, { question, response, view: currentView() });
    messages.scrollTop = messages.scrollHeight;
  }

  function handleAnswerRating(button) {
    const article = button.closest('.dayo-message');
    const context = feedbackContexts.get(article);
    if (!context || article.classList.contains('has-feedback')) return;
    if (button.dataset.dayoRating === '1') {
      submitAnswerFeedback(article, 1, '');
      return;
    }
    const detail = article.querySelector('[data-dayo-feedback-detail]');
    article.querySelectorAll('[data-dayo-rating]').forEach(item => item.classList.toggle('is-selected', item === button));
    detail.innerHTML = `<form class="dayo-feedback-form" data-dayo-feedback-form>
      <label>Was hätte Dayo besser beantworten sollen?</label>
      <textarea name="expectedAnswer" rows="3" maxlength="1500" placeholder="Beschreibe kurz, welche Antwort du erwartet hättest …" required></textarea>
      <div><button type="submit">Verbesserung senden</button><button type="button" data-dayo-feedback-cancel>Abbrechen</button></div>
      <small data-dayo-feedback-error></small>
    </form>`;
    detail.querySelector('textarea')?.focus();
    article.closest('[data-dayo-messages]').scrollTop = article.closest('[data-dayo-messages]').scrollHeight;
  }

  function resetAnswerFeedback(article) {
    if (!article || article.classList.contains('has-feedback')) return;
    article.querySelector('[data-dayo-feedback-detail]').innerHTML = '';
    article.querySelectorAll('[data-dayo-rating]').forEach(item => item.classList.remove('is-selected'));
  }

  function submitNegativeFeedback(form) {
    const expectedAnswer = form.elements.expectedAnswer.value.trim();
    if (!expectedAnswer) return;
    submitAnswerFeedback(form.closest('.dayo-message'), -1, expectedAnswer);
  }

  async function submitAnswerFeedback(article, rating, expectedAnswer) {
    const context = feedbackContexts.get(article);
    const feedback = article?.querySelector('[data-dayo-feedback]');
    if (!context || !feedback || article.classList.contains('has-feedback')) return;
    const controls = feedback.querySelectorAll('button,textarea');
    controls.forEach(control => { control.disabled = true; });
    const error = feedback.querySelector('[data-dayo-feedback-error]');
    if (error) error.textContent = '';
    try {
      await window.loop.api('/api/assistant/feedback', {
        method: 'POST',
        body: JSON.stringify({
          rating,
          question: context.question,
          answer: context.response.answer,
          expectedAnswer,
          provider: context.response.provider,
          model: context.response.model,
          dataTool: context.response.dataQuery?.tool,
          view: context.view
        })
      });
      article.classList.add('has-feedback', rating === 1 ? 'feedback-positive' : 'feedback-negative');
      feedback.innerHTML = `<span class="dayo-feedback-thanks">${rating === 1 ? 'Danke für dein Feedback!' : 'Danke! Dein Verbesserungsvorschlag wurde gespeichert.'}</span>`;
      setMood(rating === 1 ? 'proud' : 'curious', 1800);
    } catch (feedbackError) {
      controls.forEach(control => { control.disabled = false; });
      const target = feedback.querySelector('[data-dayo-feedback-error]') || feedback;
      target.textContent = feedbackError.message || 'Feedback konnte gerade nicht gespeichert werden.';
    }
  }

  function setTyping(active) {
    const messages = state.panel.querySelector('[data-dayo-messages]');
    messages.querySelector('.dayo-typing')?.remove();
    if (active) messages.insertAdjacentHTML('beforeend', '<div class="dayo-typing" aria-label="Dayo denkt nach"><i></i><i></i><i></i></div>');
    messages.scrollTop = messages.scrollHeight;
  }

  function setAnswering(active) {
    state.answering = active;
    state.root?.classList.toggle('is-answering', active);
    state.panel?.setAttribute('aria-busy', String(active));
    if (active && state.root) {
      clearTimeout(state.moodTimer);
      state.root.dataset.mood = 'thinking';
    }
  }

  async function ask(question) {
    if (!state.panel || !question || state.answering) return;
    if (!isPanelOpen()) await openPanel();
    appendUser(question);
    renderSuggestions([]);
    setTyping(true);
    setAnswering(true);
    const submit = state.panel.querySelector('[data-dayo-form] button[type="submit"]');
    submit.disabled = true;
    try {
      const response = await window.loop.api('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ message: question.slice(0, 500), context: { view: currentView() } })
      });
      setTyping(false);
      // Antworten auf persönliche Themen lassen sich nicht bewerten, weil dabei die Frage gespeichert würde.
      appendAssistant(response, { question, rateable: response.rateable !== false });
      renderSuggestions(response.suggestions || []);
      state.panel.querySelector('[data-dayo-provider]').textContent = response.provider === 'ollama' ? `Lokale KI · ${response.model}` : answeredFromData(response) ? 'Geprüfte Daybreak-Daten · nur lesend' : response.fallbackFrom ? 'Lokale Hilfe · KI gerade nicht erreichbar' : 'Lokale Daybreak-Hilfe';
      setMood(response.confidence === 0 ? 'curious' : 'proud', 1800);
    } catch (error) {
      setTyping(false);
      appendAssistant({ title: 'Kurze Denkpause', answer: error.message || 'Die Hilfe ist gerade nicht erreichbar. Bitte versuche es erneut.', steps: [], actions: [] });
      setMood('surprised', 1800);
    } finally {
      setAnswering(false);
      submit.disabled = false;
      focusQuestion();
    }
  }

  function updateQuietButton() {
    const button = state.panel?.querySelector('[data-dayo-quiet]');
    if (button) button.textContent = state.preferences?.quiet ? 'Ruhemodus ausschalten' : 'Ruhemodus einschalten';
  }

  function setMood(mood, duration = 1800) {
    if (!state.root) return;
    clearTimeout(state.moodTimer);
    state.root.dataset.mood = mood;
    state.moodTimer = setTimeout(() => { if (state.root) state.root.dataset.mood = 'happy'; }, duration);
  }

  function say(text, mood = 'happy', force = false) {
    if (!state.root || (!force && state.preferences?.quiet) || state.preferences?.hidden) return;
    const bubble = state.root.querySelector('.dayo-bubble');
    clearTimeout(state.bubbleTimer);
    bubble.textContent = text;
    bubble.classList.add('is-visible');
    setMood(mood, 2600);
    state.bubbleTimer = setTimeout(() => bubble.classList.remove('is-visible'), 6200);
  }

  function showContextQuip() {
    const view = currentView();
    const quips = {
      dashboard: ['Ein guter Tag beginnt mit einer klaren Aufgabe.', 'Ich habe nachgesehen: Du bist genau richtig hier.', 'Kleine Schritte. Große Entwicklung.'],
      goals: ['Fortschritt ist Fortschritt – auch in kleinen Schritten.', 'Ein Ziel ohne nächsten Schritt ist nur ein hübscher Satz.', 'Ich drücke die Daumen. Mit beiden imaginären Händen.'],
      checkins: ['Gute Gespräche verdienen gute Notizen.', 'Zuhören ist auch eine Superkraft.', 'Ein ehrlicher Check-in schlägt zehn Statusmails.'],
      talent: ['Talente wachsen nicht auf Knopfdruck. Zum Glück.', 'Dein Profil darf sich mit dir verändern.', 'Neugier steht jedem Kompetenzprofil gut.'],
      team: ['Teams sind keine Tabellen. Gut, dass wir beides haben.', 'Entwicklung gelingt am besten im Gespräch.', 'Führung beginnt manchmal mit einer guten Frage.'],
      feedbackDashboard: ['Feedback ist ein Geschenk. Die Schleife spare ich mir.', 'Mehr Perspektiven, weniger blinde Flecken.', 'Klar, fair und hilfreich – so mag ich Feedback.'],
      reviewDashboard: ['Potenzial ist kein Etikett, sondern Gesprächsstoff.', 'Erst beobachten, dann einordnen.', 'Gute Entscheidungen brauchen Kontext.']
    };
    const options = quips[view] || ['Ich bin bereit, wenn du eine Frage hast.', 'Ein Doppelklick, und ich erkläre dir Daybreak.', 'Heute schon etwas Neues entdeckt?'];
    say(options[Math.floor(Math.random() * options.length)], ['silly', 'proud', 'curious'][Math.floor(Math.random() * 3)], true);
  }

  function scheduleGreeting() {
    const key = SESSION_PREFIX + state.userId;
    let count = 0;
    try { count = Number(sessionStorage.getItem(key) || 0); } catch { /* optional */ }
    if (count >= 2 || state.preferences?.quiet || state.preferences?.hidden) return;
    setTimeout(() => {
      if (!state.root || state.preferences?.quiet) return;
      const firstName = currentUser()?.name?.split(' ')[0] || 'du';
      const greetings = [`Hallo ${firstName}! Ich bin Dayo. ${opensOnSingleTap() ? 'Tipp mich an' : 'Doppelklick'}, wenn du Hilfe brauchst.`, `Schön, dass du da bist, ${firstName}. Lass uns etwas bewegen.`];
      say(greetings[count % greetings.length], 'happy');
      try { sessionStorage.setItem(key, String(count + 1)); } catch { /* optional */ }
    }, 1200);
  }

  function scheduleGrimace() {
    clearTimeout(state.grimaceTimer);
    state.grimaceTimer = setTimeout(() => {
      if (state.root && !state.preferences?.quiet && !state.preferences?.hidden && !isPanelOpen()) setMood(['silly', 'sleepy', 'surprised', 'playful'][Math.floor(Math.random() * 4)], 2400);
      scheduleGrimace();
    }, 28000 + Math.random() * 26000);
  }

  function celebrate(text) {
    if (!state.root) return;
    setMood('celebrate', 3000);
    const confetti = document.createElement('span');
    confetti.className = 'dayo-confetti';
    const directions = [[-58,-42],[-44,-64],[-20,-72],[8,-76],[35,-65],[58,-40],[54,-8],[28,-18],[-30,-20],[-55,-5]];
    confetti.innerHTML = directions.map(([x,y], index) => `<i style="--i:${index};--x:${x}px;--y:${y}px"></i>`).join('');
    state.root.appendChild(confetti);
    setTimeout(() => confetti.remove(), 1800);
    say(text, 'celebrate');
  }

  function handleMutation(event) {
    const { url = '', method = '' } = event.detail || {};
    if (method === 'POST' && url === '/api/goals') celebrate('Ziel angelegt! Jetzt darf es wachsen.');
    else if (method === 'PATCH' && /^\/api\/goals\/\d+$/.test(url)) celebrate('Fortschritt gespeichert. Sehr schön!');
    else if (method === 'POST' && url === '/api/checkins') celebrate('Check-in dokumentiert. Gespräch geschafft, Klarheit gewonnen.');
    else if (method === 'PATCH' && /\/checkins\/\d+\/feedback$/.test(url)) celebrate('Danke für deine Rückmeldung!');
    else if (method === 'PATCH' && url.includes('/career-interests')) celebrate('Deine Karriereinteressen sind gespeichert.');
    else if (method === 'POST' && url.includes('/submit')) celebrate('Eingereicht! Ich mache den kleinen Erfolgs-Tanz.');
  }

  const app = document.getElementById('app');
  if (app) {
    new MutationObserver(() => sync()).observe(app, { childList: true, subtree: false });
    new MutationObserver(() => { if (state.root) scheduleTuckCheck(); }).observe(app, { childList: true, subtree: true });
  }
  // Nur ein Verschieben von Hand wird gespeichert. Sonst bliebe Dayo nach einer Größenänderung irgendwo mitten im Fenster.
  window.addEventListener('resize', () => {
    if (state.root) applyPreferences();
  });
  document.addEventListener('scroll', () => {
    if (state.root) scheduleTuckCheck();
  }, { capture: true, passive: true });
  // Die Sprechblase hört beim ersten Tipp auf. Der Tipp selbst geht durch sie hindurch an den Knopf darunter.
  document.addEventListener('pointerdown', () => {
    state.root?.querySelector('.dayo-bubble')?.classList.remove('is-visible');
  }, { capture: true, passive: true });
  window.addEventListener('daybreak:mutation', handleMutation);
  sync();
})();
