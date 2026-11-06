'use strict';

/**
 * Laufzeit eines einzelnen Mandanten: eigene Datenbank, eigene Fachmodule, eigene Routen.
 *
 * Für jede Organisation wird genau eine solche Laufzeit erzeugt. Weil alle Fachmodule nur die
 * hier übergebene Datenbank kennen, können Daten verschiedener Organisationen nicht vermischt werden.
 * Die Fachrouten stammen unverändert aus dem früheren server.js, ergänzt um Modulschalter.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const catalog = require('./module-catalog');
const {
  GENERATED_PASSWORD_COST,
  TEMP_PASSWORD_COST,
  createCoreHelpers,
  generateTemporaryPassword,
  initializeCoreSchema,
  passwordProblem
} = require('./core-helpers');
const { createTalentModule, GOAL_TYPES } = require('../routes/talent');
const { createTalentReviewModule } = require('../routes/talentReview');
const { createFeedbackModule } = require('../routes/feedback');
const { createAssistantModule } = require('../routes/assistant');
const { createAccountsRouter } = require('../routes/accounts');
const { createAutomationModule } = require('../routes/automation');
const { createPerformanceRouter } = require('../routes/performance');
const { createOrganizationRouter } = require('../routes/organization');
const { createPeopleImportModule } = require('../routes/peopleImport');
const {
  SUPER_ADMIN_EMAIL,
  configuredPasswordHash,
  isSecureSuperAdminRequest,
  isSuperAdminConfigured,
  virtualSuperAdmin,
  createLoginLimiter
} = require('./superadmin');

const DEMO_PASSWORD = 'demo1234';
const DEMO_LOGINS = [
  { email: 'lena@loop.local', label: 'Mitarbeiterin' },
  { email: 'felix@loop.local', label: 'Abteilungsleiter' },
  { email: 'maria@loop.local', label: 'Bereichsleiterin' },
  { email: 'hanna@loop.local', label: 'HR-Sachbearbeitung' },
  { email: 'david@loop.local', label: 'HR Business Partner' },
  { email: 'elena@loop.local', label: 'HR-Administration' }
];
// Damit niemand die öffentliche Demo mit Massen von Konten unbrauchbar macht.
const DEMO_MAX_ACCOUNTS = 200;
const DEMO_PROTECTED = { error: 'In der öffentlichen Demo ist das für dieses Konto nicht möglich, damit alle weiter testen können.', code: 'demo_protected' };
// Vergleichswert, damit eine unbekannte E-Mail genauso lange dauert wie ein falsches Passwort.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), TEMP_PASSWORD_COST);

function createTenantRuntime({ tenant: initialTenant, platform, env = process.env, projectRoot = path.resolve(__dirname, '..'), superAdminLoginLimiter, passwordChecks, sessionStore = null }) {
  const slug = initialTenant.slug;
  const tenantId = initialTenant.id;
  const dbPath = initialTenant.db_path;
  const liveTenant = () => platform.tenantById(tenantId);
  const isModuleEnabled = key => platform.isModuleEnabled(tenantId, key);
  // In der öffentlichen Demo darf niemand die Zugänge der Login-Seite für andere unbrauchbar machen.
  const isProtectedAccount = email => Boolean(liveTenant()?.demo_mode) && DEMO_LOGINS.some(login => login.email === email);

  const db = platform.storage.open(dbPath);
  initializeCoreSchema(db);

  const helpers = createCoreHelpers(db, { revokeUserSessions: userId => sessionStore?.revokeForUser(slug, userId) });
  const { approvalRule, blocksSelfEdit, boundedInt, canAssignManager, canAssignRole, canReassignPerson, canEditEmployee, canManageAccount, canViewEmployee, changeManager, cleanText, createTask, createUserAccount, goalProgress, hrCanAccess, isHr, isHrOperator, listApprovalRules, log, onManagerChanged, resetApprovalRules, setApprovalRule, setUserActive, subordinateIds, validDate } = helpers;
  const textOf = value => (typeof value === 'string' ? value : '');
  const loginEmail = req => textOf(req.body?.email).trim().toLowerCase() || 'unknown';
  // Fehlversuche zählen je Konto und Absender, damit Fremde ein Konto nicht einfach aussperren können.
  // Die zweite, höhere Grenze bremst verteilte Angriffe auf ein einzelnes Konto.
  const userLoginLimiter = createLoginLimiter({ maxAttempts: 10, keyFor: req => `${loginEmail(req)}|${req.ip || ''}` });
  const accountLoginLimiter = createLoginLimiter({ maxAttempts: 50, keyFor: loginEmail });
  const passwordChangeLimiter = createLoginLimiter({ maxAttempts: 10, keyFor: req => String(current(req)?.id || 'unknown') });
  const BUSY_MESSAGE = { error: 'Der Dienst ist gerade stark ausgelastet. Bitte versuche es gleich noch einmal.' };
  const taskVisible = task => {
    const key = catalog.moduleForTaskType(task.type);
    return !key || isModuleEnabled(key);
  };

  function seed() {
  if (db.prepare('SELECT COUNT(*) count FROM users WHERE is_system_account=0').get().count) return;
  const add = db.prepare('INSERT INTO users(name,email,password_hash,role,title,manager_id) VALUES(?,?,?,?,?,?)');
  const pass = bcrypt.hashSync('demo1234', 10);
  const elena = add.run('Elena Hoffmann', 'elena@loop.local', pass, 'hr_admin', 'Chief People Officer', null).lastInsertRowid;
  const maria = add.run('Maria Keller', 'maria@loop.local', pass, 'director', 'Head of Product', elena).lastInsertRowid;
  const lena = add.run('Lena Schmitt', 'lena@loop.local', pass, 'employee', 'Senior Product Designer', maria).lastInsertRowid;
  const tom = add.run('Tom Köhler', 'tom@loop.local', pass, 'employee', 'Product Designer', maria).lastInsertRowid;
  const julia = add.run('Julia Meier', 'julia@loop.local', pass, 'employee', 'UX Researcher', maria).lastInsertRowid;
  const bp = add.run('David Brandt', 'david@loop.local', pass, 'hrbp', 'HR Business Partner', elena).lastInsertRowid;
  const goal = db.prepare('INSERT INTO goals(user_id,title,description,weight,progress,status,due_date,created_by) VALUES(?,?,?,?,?,?,?,?)');
  goal.run(lena, 'Design System skalieren', 'Komponentenbibliothek für alle Produktteams ausbauen und dokumentieren.', 45, 74, 'on_track', '2026-12-31', maria);
  goal.run(lena, 'Mentoring etablieren', 'Zwei Kolleg:innen aktiv im Designprozess begleiten.', 25, 86, 'on_track', '2026-12-31', maria);
  goal.run(lena, 'Research Ops aufbauen', 'Standard für Research-Repositories und Insights definieren.', 30, 52, 'needs_focus', '2026-12-31', maria);
  goal.run(tom, 'Mobile Design Library', 'Design patterns für Mobile etablieren.', 100, 89, 'on_track', '2026-12-31', maria);
  goal.run(julia, 'Research Repository', 'Zentrales Insight Repository veröffentlichen.', 100, 54, 'needs_focus', '2026-12-31', maria);
  const ci = db.prepare('INSERT INTO checkins(employee_id,manager_id,period,summary,achievements,obstacles,next_steps,performance,on_track,employee_comment,satisfaction,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  ci.run(lena,maria,'2026-06','Lena hat das Design System sichtbar vorangebracht und übernimmt im Team Verantwortung. Research Ops braucht bis zum nächsten Gespräch einen konkreten Plan.','Komponentenbibliothek und Mentoring-Format gestartet.','Abstimmung mit Engineering für Research Ops.','Research-Ops-Plan priorisieren; Komponenten-Doku finalisieren.',4,'on_track','Ich stimme zu und möchte die Research-Partner früh einbinden.',5,'2026-06-28');
  ci.run(lena,maria,'2026-05','Sehr gute Zusammenarbeit und klare Wirkung im Produktteam.','Mentoring und Design Critiques etabliert.','Kapazität in zwei Initiativen.','Priorisierung mit Product Management klären.',4,'on_track','',null,null);
  ci.run(lena,maria,'2026-04','Q2-Ziele wurden geschärft. Research Ops verdient jetzt mehr Fokus.','Ziele klar ausgerichtet.','Research-Repository noch nicht gestartet.','Konkrete Meilensteine definieren.',4,'needs_focus','',null,null);
  const mayCheckin = db.prepare("SELECT id FROM checkins WHERE employee_id=? AND period='2026-05'").get(lena)?.id;
  createTask(lena, 'Check-in Mai 2026 lesen und bestätigen', 'checkin', mayCheckin);
  }

  /** Die Demo zeigt alle sechs Rollen. Auch eine ältere Demo-Datenbank bekommt die fehlenden Konten. */
  function ensureDemoRoles() {
    const byEmail = email => db.prepare('SELECT id FROM users WHERE email=?').get(email)?.id;
    const elena = byEmail('elena@loop.local');
    const maria = byEmail('maria@loop.local');
    if (!elena || !maria) return;
    const add = db.prepare('INSERT OR IGNORE INTO users(name,email,password_hash,role,title,manager_id) VALUES(?,?,?,?,?,?)');
    const password = bcrypt.hashSync(DEMO_PASSWORD, 10);
    if (!byEmail('hanna@loop.local')) add.run('Hanna Vogt', 'hanna@loop.local', password, 'hr_staff', 'HR-Sachbearbeiterin', elena);
    if (!byEmail('felix@loop.local')) {
      add.run('Felix Neumann', 'felix@loop.local', password, 'manager', 'Abteilungsleiter Design', maria);
      const felix = byEmail('felix@loop.local');
      db.prepare("UPDATE users SET manager_id=? WHERE email IN ('tom@loop.local','julia@loop.local') AND manager_id=?").run(felix, maria);
    }
    // Alte Beispielaufgaben ohne Vorgang blieben für immer offen.
    db.prepare("UPDATE tasks SET done=1 WHERE done=0 AND entity_id IS NULL AND type IN ('checkin','goal')").run();
  }

  /** Zählt für die Grenze in der öffentlichen Demo. */
  function demoAccountsFull() {
    if (!liveTenant()?.demo_mode) return false;
    return db.prepare('SELECT COUNT(*) count FROM users WHERE is_system_account=0').get().count >= DEMO_MAX_ACCOUNTS;
  }

  let superAdminAuditActorId = null;
  function ensureSuperAdminAuditActor() {
    if (!isSuperAdminConfigured(env)) return null;
    const email = 'system-root@daybreak.internal';
    const existing = db.prepare('SELECT id FROM users WHERE is_system_account=1 AND email=?').get(email);
    if (existing) {
      db.prepare("UPDATE users SET name='Systemadministration',password_hash='!ENV_MANAGED!',role='hr_admin',title='Daybreak Super-Admin',manager_id=NULL,is_system_account=1 WHERE id=?").run(existing.id);
      return existing.id;
    }
    return db.prepare("INSERT INTO users(name,email,password_hash,role,title,manager_id,is_system_account) VALUES(?,?,'!ENV_MANAGED!','hr_admin',?,NULL,1)").run('Systemadministration', email, 'Daybreak Super-Admin').lastInsertRowid;
  }

  /**
   * Ermittelt die angemeldete Person. Eine Sitzung gilt nur im Mandanten, in dem sie
   * entstanden ist; gesperrte Konten und entzogener Support-Zugriff wirken sofort.
   */
  function current(req) {
    const sessionUser = req.session?.user;
    if (!sessionUser || sessionUser.tenant !== slug) return null;
    const systemActor = virtualSuperAdmin(req.session, env);
    if (systemActor) {
      const tenantNow = liveTenant();
      if (!tenantNow || (!tenantNow.is_primary && !tenantNow.support_access)) return null;
      return { ...systemActor, id: superAdminAuditActorId };
    }
    if (sessionUser.kind === 'super_admin') return null;
    const id = Number(sessionUser.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare('SELECT id,name,email,role,title,manager_id,must_change_password FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) || null;
  }

  function auth(req, res, next) {
    const actor = current(req);
    if (!actor) return res.status(401).json({ error: 'Nicht angemeldet' });
    next();
  }

  const moduleDeps = { db, auth, current, isHr, canAssignManager, canAssignRole, canReassignPerson, canManageAccount, canViewEmployee, canEditEmployee, subordinateIds, cleanText, boundedInt, validDate, log, createTask, createUserAccount, setUserActive, approvalRule, isModuleEnabled, isProtectedAccount, isHrOperator, hrCanAccess, blocksSelfEdit, onManagerChanged, changeManager, goalProgress, tenant: { slug, name: initialTenant.name } };

  const demoMode = initialTenant.demo_mode;
  if (demoMode) {
    seed();
    ensureDemoRoles();
  }

  const talent = createTalentModule({ db, auth, current, isHr, isHrOperator, canViewEmployee, canEditEmployee, cleanText, boundedInt, validDate, log, hrCanAccess, blocksSelfEdit });
  talent.initialize();
  if (demoMode) talent.seed();
  const talentReview = createTalentReviewModule({ db, auth, current, isHr, canViewEmployee, canEditEmployee, cleanText, boundedInt, validDate, log, createTask, isModuleEnabled, onManagerChanged, hrCanAccess, goalProgress, skillGap: talent.skillGap, demoPasswordHash: demoMode ? bcrypt.hashSync(DEMO_PASSWORD, 10) : null });
  talentReview.initialize();
  if (demoMode) talentReview.seed();
  const feedback = createFeedbackModule({ db, auth, current, isHr, canViewEmployee, canEditEmployee, cleanText, validDate, log, createTask, onManagerChanged, hrCanAccess, blocksSelfEdit });
  feedback.initialize();
  if (demoMode) feedback.seed();
  superAdminAuditActorId = ensureSuperAdminAuditActor();
  moduleDeps.skillGap = talent.skillGap;

  // Neue Fachmodule werden über die Dateikonvention aus dem Katalog geladen.
  const conventionalRouters = [];
  const extraArticles = [];
  const maintenanceJobs = [];
  // Erfundene Gehälter, Austritte oder Krankmeldungen dürfen nie bei echten Personen landen.
  // Beispieldaten entstehen deshalb nur, wenn es ausschließlich Demo-Konten gibt. Wer sicher weiß,
  // dass alle Konten erfunden sind, kann das mit DAYBREAK_DEMO_DATA_FOR_ALL_ACCOUNTS=true übergehen.
  const onlyDemoAccounts = env.DAYBREAK_DEMO_DATA_FOR_ALL_ACCOUNTS === 'true' || !db.prepare("SELECT 1 FROM users WHERE is_system_account=0 AND email NOT LIKE '%@loop.local' LIMIT 1").get();
  for (const definition of catalog.MODULES.filter(module => module.conventional && catalog.isAvailable(module, projectRoot))) {
    const files = catalog.moduleFiles(definition, projectRoot);
    const factory = require(files.routeFile)[files.factoryName];
    if (typeof factory !== 'function') throw new Error(`${files.routeFile} exportiert ${files.factoryName} nicht.`);
    const instance = factory(moduleDeps);
    // Die Personalakte stellt dem Recruiting das Eintragen des Eintrittsdatums bereit.
    if (instance.recordEntryDate) moduleDeps.recordEntryDate = instance.recordEntryDate;
    instance.initialize?.();
    if (demoMode && onlyDemoAccounts) instance.seedDemo?.();
    if (instance.router) conventionalRouters.push(instance.router);
    if (instance.maintenance) maintenanceJobs.push({ key: definition.key, run: instance.maintenance });
    for (const article of instance.helpArticles || []) extraArticles.push({ ...article, module: definition.key });
  }

  const assistant = createAssistantModule({ auth, current, cleanText, db, canViewEmployee, isHr, log, env, isModuleEnabled, extraArticles });
  // Die Automatisierung arbeitet aus getrennten Prozessen direkt auf der SQLite-Datei.
  const automation = initialTenant.is_primary && platform.storage.kind === 'sqlite' ? createAutomationModule({ db, auth, current, cleanText, dbPath, projectRoot, env }) : null;
  const organization = createOrganizationRouter({ db, auth, current, platform, tenantId, log, approvalRule, listApprovalRules, setApprovalRule, isModuleEnabled, env });
  const peopleImport = createPeopleImportModule({ db, auth, current, isHr, isHrOperator, canAssignManager, canAssignRole, cleanText, log, recordInitialPosition: helpers.recordInitialPosition, demoAccountsFull, demoRowLimit: () => (liveTenant()?.demo_mode ? 50 : null) });
  const accounts = createAccountsRouter({
    db, auth, current, isHr, isHrOperator, canManageAccount, canAssignManager, canAssignRole, canReassignPerson, canViewEmployee, hrCanAccess, blocksSelfEdit,
    changeManager, cleanText, validDate, log, createTask, setUserActive, passwordProblem, generateTemporaryPassword,
    passwordChecks, passwordCosts: { chosen: TEMP_PASSWORD_COST, generated: GENERATED_PASSWORD_COST }, busyMessage: BUSY_MESSAGE,
    revokeSessions: userId => sessionStore?.revokeForUser(slug, userId), recordPositionHistory: talent.recordPositionHistory,
    isProtectedAccount, protectedMessage: DEMO_PROTECTED, demoAccountsFull
  });
  const performance = createPerformanceRouter({
    db, auth, current, isHr, canEditEmployee, canViewEmployee, subordinateIds, cleanText, boundedInt, validDate,
    log, createTask, approvalRule, isModuleEnabled, goalProgress, onManagerChanged, goalTypes: GOAL_TYPES, taskVisible
  });

  const app = express.Router();

  /** Besucher der Demo dürfen Module und Genehmigungen ausprobieren. Stündlich gilt wieder der Ausgangszustand. */
  function resetDemoSettings() {
    if (!liveTenant()?.demo_mode) return;
    platform.resetModuleSwitches(tenantId);
    resetApprovalRules();
  }

  // Wartung (z. B. fällige Austritte) läuft höchstens stündlich, ausgelöst durch normale Anfragen.
  let lastMaintenance = 0;
  app.use((req, res, next) => {
    if (Date.now() - lastMaintenance < 60 * 60 * 1000) return next();
    lastMaintenance = Date.now();
    resetDemoSettings();
    for (const job of maintenanceJobs) {
      if (!isModuleEnabled(job.key)) continue;
      try {
        job.run();
      } catch (error) {
        console.error(`Wartung von Modul ${job.key} im Mandanten ${slug} fehlgeschlagen`, error);
      }
    }
    next();
  });

  function establishSession(req, res, user) {
    req.session.regenerate(error => {
      if (error) return res.status(500).json({ error: 'Anmeldung konnte nicht abgeschlossen werden.' });
      req.session.user = user;
      req.session.save(saveError => saveError ? res.status(500).json({ error: 'Anmeldung konnte nicht abgeschlossen werden.' }) : res.json({ user: current(req) }));
    });
  }

  app.post('/api/auth/register', (req, res) => res.status(403).json({ error: 'Öffentliche Registrierung ist deaktiviert. Accounts werden durch HR angelegt.' }));

  app.post('/api/auth/login', async (req, res) => {
    const email = textOf(req.body?.email).trim().toLowerCase();
    const password = textOf(req.body?.password);
    if (email === SUPER_ADMIN_EMAIL) {
      if (superAdminLoginLimiter.blocked(req)) return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' });
      if (!isSecureSuperAdminRequest(req)) return res.status(403).json({ error: 'Die Systemadministration ist nur lokal, über einen SSH-Tunnel oder über HTTPS erreichbar.' });
      const rootHash = configuredPasswordHash(env);
      if (!rootHash || !await passwordChecks.compare(password, rootHash)) {
        superAdminLoginLimiter.fail(req);
        return res.status(401).json({ error: 'E-Mail oder Passwort ist nicht korrekt.' });
      }
      superAdminLoginLimiter.success(req);
      const tenantNow = liveTenant();
      if (!tenantNow.is_primary && !tenantNow.support_access) return res.status(403).json({ error: 'Der Support-Zugriff ist für diese Organisation nicht freigegeben.' });
      return establishSession(req, res, { kind: 'super_admin', tenant: slug });
    }
    if (userLoginLimiter.blocked(req) || accountLoginLimiter.blocked(req)) return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte versuche es in 15 Minuten noch einmal oder wende dich an HR.' });
    if (passwordChecks.busy()) return res.status(429).json(BUSY_MESSAGE);
    const user = db.prepare('SELECT * FROM users WHERE email=? AND is_system_account=0').get(email);
    const passwordMatches = await passwordChecks.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches || user.active !== 1) {
      userLoginLimiter.fail(req);
      accountLoginLimiter.fail(req);
      return res.status(401).json({ error: 'E-Mail oder Passwort ist nicht korrekt.' });
    }
    userLoginLimiter.success(req);
    accountLoginLimiter.success(req);
    return establishSession(req, res, { id: user.id, tenant: slug });
  });

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: current(req) }));

  app.post('/api/auth/password', auth, async (req, res) => {
    const actor = current(req);
    if (actor.role === 'super_admin') return res.status(400).json({ error: 'Das Passwort der Systemadministration wird auf dem Server gesetzt.' });
    if (isProtectedAccount(actor.email)) return res.status(403).json(DEMO_PROTECTED);
    if (passwordChangeLimiter.blocked(req)) return res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
    if (passwordChecks.busy()) return res.status(429).json(BUSY_MESSAGE);
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor.id);
    const matches = await passwordChecks.compare(currentPassword, row.password_hash);
    if (!matches) {
      passwordChangeLimiter.fail(req);
      return res.status(400).json({ error: 'Das bisherige Passwort ist nicht korrekt.' });
    }
    const weakness = passwordProblem(newPassword);
    if (weakness) return res.status(400).json({ error: weakness });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'Das neue Passwort muss sich vom bisherigen unterscheiden.' });
    const newHash = await passwordChecks.hash(newPassword, TEMP_PASSWORD_COST);
    db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(newHash, actor.id);
    passwordChangeLimiter.success(req);
    sessionStore?.revokeForUser(slug, actor.id, req.sessionID);
    log(actor.id, 'password_changed', 'users', actor.id);
    res.json({ ok: true });
  });

  app.use('/api', organization.configRouter);

  // Wer ein temporäres Passwort hat, muss es zuerst ändern. Das gilt serverseitig für alle Routen.
  app.use('/api', (req, res, next) => {
    if (current(req)?.must_change_password) return res.status(403).json({ error: 'Bitte ändere zuerst dein temporäres Passwort.', code: 'password_change_required' });
    next();
  });

  // Modulschalter: Abgeschaltete Module sind serverseitig nicht erreichbar, nicht nur unsichtbar.
  app.use('/api', (req, res, next) => {
    const key = catalog.moduleForPath(req.path);
    if (!key || isModuleEnabled(key)) return next();
    if (!current(req)) return res.status(401).json({ error: 'Nicht angemeldet' });
    res.status(403).json({ error: 'Dieses Modul ist für deine Organisation nicht aktiviert.', code: 'module_disabled', module: key });
  });

  app.use('/api', organization.router);
  app.use('/api', peopleImport.router);
  app.use('/api', feedback.router);
  app.use('/api', assistant.router);
  if (automation) app.use('/api', automation.router);

  app.use('/api', accounts.router);
  app.use('/api', performance.router);
  app.use('/api', talent.router);
  app.use('/api', talentReview.router);
  for (const router of conventionalRouters) app.use('/api', router);

  app.use('/api', (req, res) => res.status(current(req) ? 404 : 401).json({ error: current(req) ? 'Diese Schnittstelle gibt es nicht.' : 'Nicht angemeldet' }));

  /** Legt das erste Administrationskonto einer neuen Organisation an. */
  function createInitialAdmin({ name, email, password = null, actor = null }) {
    return createUserAccount({ name, email, role: 'hr_admin', title: 'HR Administration', password, actor });
  }

  /** Macht bekannte Demo-Passwörter unbrauchbar. Betroffene erhalten von HR ein neues Passwort. */
  async function lockDemoAccounts() {
    const users = db.prepare('SELECT id,password_hash FROM users WHERE is_system_account=0').all();
    let locked = 0;
    for (const user of users) {
      if (!await passwordChecks.compare(DEMO_PASSWORD, user.password_hash)) continue;
      const replacement = await passwordChecks.hash(generateTemporaryPassword(), GENERATED_PASSWORD_COST);
      db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(replacement, user.id);
      sessionStore?.revokeForUser(slug, user.id);
      log(null, 'demo_password_locked', 'users', user.id);
      locked += 1;
    }
    return locked;
  }

  /**
   * Eine alte Demo-Datenbank ohne Steuerung gilt nicht mehr als Demo, die bekannten Passwörter
   * funktionieren aber weiter. Das soll niemand übersehen.
   */
  async function warnAboutOpenDemoPasswords() {
    const candidates = db.prepare(`SELECT password_hash FROM users WHERE is_system_account=0 AND active=1 AND email IN (${DEMO_LOGINS.map(() => '?').join(',')})`).all(...DEMO_LOGINS.map(login => login.email));
    const open = await Promise.all(candidates.map(user => passwordChecks.compare(DEMO_PASSWORD, user.password_hash)));
    const count = open.filter(Boolean).length;
    if (count) console.warn(`Achtung: In der Organisation „${slug}“ gelten bei ${count} Konten noch die bekannten Demo-Passwörter. Sperre sie unter Plattform → Organisation → „Demo-Passwörter sperren“.`);
  }
  if (!initialTenant.demo_mode) warnAboutOpenDemoPasswords().catch(() => {});

  function demoLogins() {
    if (!liveTenant()?.demo_mode) return [];
    return DEMO_LOGINS.filter(login => db.prepare('SELECT id FROM users WHERE email=? AND active=1').get(login.email));
  }

  return {
    slug,
    db,
    router: app,
    createInitialAdmin,
    demoLogins,
    lockDemoAccounts,
    log,
    resetDemoSettings,
    userCount: () => db.prepare('SELECT COUNT(*) count FROM users WHERE is_system_account=0 AND active=1').get().count,
    recordSupportAccess: action => log(superAdminAuditActorId, action, 'tenants', tenantId),
    close: () => db.close()
  };
}

module.exports = { createTenantRuntime, GOAL_TYPES };
