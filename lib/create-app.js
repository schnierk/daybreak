'use strict';

/**
 * Baut die gesamte Anwendung: gemeinsame Sitzungen und Sicherheitsregeln, Erkennung des
 * Mandanten und Weiterleitung jeder Anfrage an die Laufzeit genau dieses Mandanten.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { createDemoReset } = require('./demo-reset');
const { createPasswordPool } = require('./password-pool');
const { createPlatform, normalizeSlug } = require('./platform');
const { DatabaseSessionStore, SESSION_MAX_AGE_MS } = require('./session-store');
const { resolveDataDir } = require('./storage');
const { createTenantRuntime } = require('./tenant-runtime');
const { createLoginLimiter, virtualSuperAdmin } = require('./superadmin');
const { createPlatformRouter, createPublicRouter } = require('../routes/platform');

/** NUL-Zeichen haben in keiner Anfrage etwas verloren. PostgreSQL kann sie auch nicht verarbeiten. */
function containsNul(value, depth = 0) {
  if (typeof value === 'string') return value.includes('\u0000');
  if (!value || typeof value !== 'object' || depth > 8) return false;
  return Object.entries(value).some(([key, item]) => key.includes('\u0000') || containsNul(item, depth + 1));
}

function createDaybreakApp({ env = process.env, projectRoot = path.resolve(__dirname, '..') } = {}) {
  const primaryDbPath = path.resolve(env.DAYBREAK_DB_PATH || path.join(projectRoot, 'loop.db'));
  const dataDir = resolveDataDir(env, primaryDbPath);
  const platform = createPlatform({ dataDir, primaryDbPath, env, projectRoot });
  const sessionStore = new DatabaseSessionStore(platform.db);
  const superAdminLoginLimiter = createLoginLimiter();
  const passwordChecks = createPasswordPool();
  const runtimes = new Map();

  function runtimeFor(tenant) {
    let runtime = runtimes.get(tenant.slug);
    if (!runtime) {
      runtime = createTenantRuntime({ tenant, platform, env, projectRoot, superAdminLoginLimiter, passwordChecks, sessionStore });
      runtimes.set(tenant.slug, runtime);
    }
    return runtime;
  }

  function closeRuntime(slug, { deleteFiles = false, dbPath = null } = {}) {
    const runtime = runtimes.get(slug);
    if (runtime) {
      runtime.close();
      runtimes.delete(slug);
    }
    if (deleteFiles && dbPath) platform.storage.remove(dbPath);
  }

  // Der Hauptmandant startet sofort, damit Veröffentlichungen nach einem Neustart abgeschlossen werden.
  runtimeFor(platform.primaryTenant());

  const demoReset = createDemoReset({ env, platform, sessionStore, runtimeFor, closeRuntime });
  demoReset.start();

  const app = express();
  app.disable('x-powered-by');
  if (env.DAYBREAK_TRUST_PROXY) app.set('trust proxy', env.DAYBREAK_TRUST_PROXY);

  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    let url = req.originalUrl;
    try {
      url = decodeURIComponent(req.originalUrl);
    } catch {
      return res.status(400).json({ error: 'Die Anfrage ist ungültig.' });
    }
    if (url.includes('\u0000') || containsNul(req.body)) return res.status(400).json({ error: 'Die Anfrage ist ungültig.' });
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Die Seiten selbst brauchen keine Datenbank. Hängt sie, bleibt die Anwendung so wenigstens erreichbar.
  app.use(express.static(path.join(projectRoot, 'public'), { setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); } }));
  app.use((req, res, next) => (req.path.startsWith('/api/') ? next() : res.sendFile(path.join(projectRoot, 'public', 'index.html'))));

  const sessionSecret = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  // "auto": sicheres Cookie, sobald die Verbindung als HTTPS erkannt wird (braucht DAYBREAK_TRUST_PROXY).
  const sessionCookieSecure = env.SESSION_COOKIE_SECURE === 'auto' ? 'auto' : env.SESSION_COOKIE_SECURE === 'true' || (env.SESSION_COOKIE_SECURE !== 'false' && env.NODE_ENV === 'production');
  app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: SESSION_MAX_AGE_MS, httpOnly: true, sameSite: 'lax', secure: sessionCookieSecure }
  }));

  // Schutz vor untergeschobenen Anfragen fremder Websites (CSRF): Absender muss zur Adresse passen.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Moderne Browser nennen fremde Absender auch ohne Origin. Werkzeuge wie curl haben kein Cookie der Person.
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Die Anfrage kommt von einer nicht erlaubten Herkunft.', code: 'origin_rejected' });
    const origin = req.get('origin');
    if (!origin) return next();
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    // Der weitergeleiteten Adresse trauen wir nur hinter einem ausdrücklich eingestellten Proxy.
    const forwardedHost = app.get('trust proxy') ? req.get('x-forwarded-host') : null;
    if (originHost && (originHost === req.get('host') || originHost === forwardedHost)) return next();
    res.status(403).json({ error: 'Die Anfrage kommt von einer nicht erlaubten Herkunft.', code: 'origin_rejected' });
  });

  // Welcher Mandant ist gemeint? Adresse schlägt alles; sonst Firmenkennung beim Login, Sitzung oder Hauptmandant.
  app.use((req, res, next) => {
    const hostTenant = platform.tenantForHost(req.hostname);
    let tenant = hostTenant;
    if (!tenant) {
      if (req.method === 'POST' && req.path === '/api/auth/login') {
        const code = normalizeSlug(req.body?.tenant);
        tenant = code ? platform.tenantBySlug(code) : platform.primaryTenant();
        if (!tenant) return res.status(401).json({ error: 'E-Mail oder Passwort ist nicht korrekt.' });
      } else {
        const sessionSlug = req.session?.user?.tenant;
        tenant = sessionSlug ? platform.tenantBySlug(sessionSlug) : null;
        if (!tenant) tenant = platform.primaryTenant();
      }
    }
    // Die Systemadministration fällt aus einem gesperrten Mandanten auf den Hauptmandanten zurück.
    if (!hostTenant && tenant.status !== 'active' && req.session?.user && virtualSuperAdmin(req.session, env)) {
      tenant = platform.primaryTenant();
      req.session.user = { ...req.session.user, tenant: tenant.slug };
    }
    req.tenant = tenant;
    next();
  });

  app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.use('/api', createPublicRouter({ platform, runtimeFor, env }));
  app.use('/api', createPlatformRouter({ platform, runtimeFor, closeRuntime, sessionStore, env, projectRoot }));

  app.use((req, res, next) => {
    if (req.tenant.status === 'active' || !req.path.startsWith('/api/')) return next();
    res.status(403).json({ error: 'Der Zugang deiner Organisation ist derzeit gesperrt.', code: 'tenant_suspended' });
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    runtimeFor(req.tenant).router(req, res, next);
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Kaputte Anfragen (z. B. ungültiges JSON) sind kein Serverfehler und sollen das Protokoll nicht füllen.
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'Die Anfrage ist ungültig.' });
    console.error('Unbehandelter Anwendungsfehler', err);
    res.status(500).json({ error: 'Ein interner Fehler ist aufgetreten. Bitte erneut versuchen.' });
  });

  function close() {
    demoReset.stop();
    for (const slug of [...runtimes.keys()]) closeRuntime(slug);
    passwordChecks.close();
    platform.close();
  }

  return { app, platform, runtimeFor, demoReset, close };
}

module.exports = { createDaybreakApp };
