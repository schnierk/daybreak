const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { createDaybreakApp } = require('../lib/create-app');
const { moduleForPath, moduleForTaskType, withDependencies } = require('../lib/module-catalog');
const { backupAll } = require('../lib/platform-backup');

const ROOT_PASSWORD = 'SuperRoot!Mandanten2026';
const NEW_PASSWORD_A = 'NeuesPasswortAcme!2026';
const NEW_PASSWORD_B = 'NeuesPasswortBeta!2026';

let directory;
let server;
let daybreak;
let port;

/** Eigener HTTP-Aufruf, weil fetch den Host-Kopf nicht setzen darf. */
function call(method, url, { body, cookie, host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: url,
      headers: {
        host: host || `127.0.0.1:${port}`,
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        const setCookie = response.headers['set-cookie']?.[0]?.split(';', 1)[0] || null;
        resolve({ status: response.statusCode, data, cookie: setCookie, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function login(email, password, options = {}) {
  const { tenant, host } = options;
  const response = await call('POST', '/api/auth/login', { body: { email, password, ...(tenant ? { tenant } : {}) }, host });
  return response;
}

const rootSession = async () => {
  const response = await login('root@root.de', ROOT_PASSWORD);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.cookie;
};

async function adminSession(tenant, email, newPassword, temporaryPassword) {
  let response = await login(email, newPassword, { tenant });
  if (response.status === 200) return response.cookie;
  response = await login(email, temporaryPassword, { tenant });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const changed = await call('POST', '/api/auth/password', { cookie: response.cookie, body: { currentPassword: temporaryPassword, newPassword } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  return response.cookie;
}

const tempPasswords = {};
const isPostgres = Boolean(process.env.DAYBREAK_TEST_DATABASE_URL);

/** Öffnet die Daten eines Mandanten direkt, an der Anwendung vorbei. */
function openTenantData(slug) {
  const { storage } = daybreak.platform;
  const location = storage.tenantLocation(slug);
  return isPostgres ? storage.open(location) : new Database(location, { readonly: true });
}
const tenantDataExists = slug => daybreak.platform.storage.exists(daybreak.platform.storage.tenantLocation(slug));

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-mandanten-test-'));
  daybreak = createDaybreakApp({
    env: {
      DAYBREAK_DB_PATH: path.join(directory, 'primary.db'),
      DAYBREAK_BACKUP_ROOT: path.join(directory, 'backups'),
      DAYBREAK_SUPERADMIN_PASSWORD_HASH: bcrypt.hashSync(ROOT_PASSWORD, 4),
      DAYBREAK_BASE_DOMAIN: 'daybreak.test',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_SECRET: 'nur-fuer-den-test'
    },
    projectRoot: path.resolve(__dirname, '..')
  });
  await new Promise(resolve => {
    server = daybreak.app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  daybreak.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Neuinstallation startet ohne Demo-Daten und ohne bekannte Passwörter', async () => {
  const primary = daybreak.platform.primaryTenant();
  assert.equal(primary.demo_mode, false);
  const context = await call('GET', '/api/public/context');
  assert.deepEqual(context.data.demoLogins, []);
  const demoLogin = await login('elena@loop.local', 'demo1234');
  assert.equal(demoLogin.status, 401);
});

test('Der Betreiber legt Mandanten an, gewöhnliche Sitzungen dürfen das nicht', async () => {
  assert.equal((await call('GET', '/api/platform/tenants')).status, 401);
  const cookie = await rootSession();
  for (const [slug, name] of [['acme', 'Acme GmbH'], ['beta', 'Beta AG']]) {
    const created = await call('POST', '/api/platform/tenants', {
      cookie,
      body: { slug, name, adminName: `${name} Admin`, adminEmail: 'chef@example.test' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.ok(created.data.admin.temporaryPassword.length >= 12);
    tempPasswords[slug] = created.data.admin.temporaryPassword;
  }
  const acme = await login('chef@example.test', tempPasswords.acme, { tenant: 'acme' });
  assert.equal(acme.status, 200);
  assert.equal((await call('GET', '/api/platform/tenants', { cookie: acme.cookie })).status, 403);
  assert.equal(tenantDataExists('acme'), true);
});

test('Ungültige und reservierte Firmenkennungen werden abgewiesen', async () => {
  const cookie = await rootSession();
  for (const slug of ['../boese', 'Mit Leerzeichen', 'default', 'www', 'a/b', '']) {
    const response = await call('POST', '/api/platform/tenants', {
      cookie,
      body: { slug, name: 'Test', adminName: 'A', adminEmail: 'a@example.test' }
    });
    assert.ok([400, 409].includes(response.status), `${slug}: ${response.status}`);
  }
});

test('Ein temporäres Passwort sperrt alles außer der Passwortänderung', async () => {
  const session = await login('chef@example.test', tempPasswords.acme, { tenant: 'acme' });
  assert.equal(session.data.user.must_change_password, 1);
  const blocked = await call('GET', '/api/users', { cookie: session.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'password_change_required');
  const weak = await call('POST', '/api/auth/password', { cookie: session.cookie, body: { currentPassword: tempPasswords.acme, newPassword: 'zu-kurz' } });
  assert.equal(weak.status, 400);
  const wrong = await call('POST', '/api/auth/password', { cookie: session.cookie, body: { currentPassword: 'falsch', newPassword: NEW_PASSWORD_A } });
  assert.equal(wrong.status, 400);
  const changed = await call('POST', '/api/auth/password', { cookie: session.cookie, body: { currentPassword: tempPasswords.acme, newPassword: NEW_PASSWORD_A } });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/api/users', { cookie: session.cookie })).status, 200);
});

test('Daten bleiben getrennt, auch bei gleicher E-Mail und gleicher interner Nummer', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const beta = await adminSession('beta', 'chef@example.test', NEW_PASSWORD_B, tempPasswords.beta);

  const acmeCreated = await call('POST', '/api/users', { cookie: acme, body: { name: 'Nur Bei Acme', email: 'nur.acme@example.test', password: 'TemporaeresPasswort1!', role: 'employee' } });
  assert.equal(acmeCreated.status, 200, JSON.stringify(acmeCreated.data));
  const goal = await call('POST', '/api/goals', { cookie: acme, body: { title: 'Geheimes Acme-Ziel' } });
  assert.equal(goal.status, 200, JSON.stringify(goal.data));

  const acmeUsers = (await call('GET', '/api/users', { cookie: acme })).data.users.map(user => user.email);
  const betaUsers = (await call('GET', '/api/users', { cookie: beta })).data.users.map(user => user.email);
  assert.ok(acmeUsers.includes('nur.acme@example.test'));
  assert.equal(betaUsers.includes('nur.acme@example.test'), false);

  // Dieselbe interne Nummer zeigt in Beta nicht auf das Acme-Ziel.
  const foreignGoal = await call('GET', `/api/goals/${goal.data.id}`, { cookie: beta });
  assert.notEqual(foreignGoal.data?.goal?.title, 'Geheimes Acme-Ziel');

  // Die Daten liegen wirklich getrennt.
  const betaFile = openTenantData('beta');
  assert.equal(betaFile.prepare("SELECT COUNT(*) count FROM users WHERE email='nur.acme@example.test'").get().count, 0);
  assert.equal(betaFile.prepare("SELECT COUNT(*) count FROM goals WHERE title='Geheimes Acme-Ziel'").get().count, 0);
  betaFile.close();
});

test('Eine Sitzung gilt nur im eigenen Mandanten, auch mit manipulierter Adresse', async () => {
  const cookie = await rootSession();
  const added = await call('POST', '/api/platform/tenants/beta/domains', { cookie, body: { hostname: 'hr.beta.example' } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);

  // Acme-Sitzung mit Beta-Adresse: nicht angemeldet.
  assert.equal((await call('GET', '/api/auth/me', { cookie: acme })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: acme, host: 'hr.beta.example' })).status, 401);
  assert.equal((await call('GET', '/api/users', { cookie: acme, host: 'hr.beta.example' })).status, 401);
  assert.equal((await call('GET', '/api/users', { cookie: acme, host: 'beta.daybreak.test' })).status, 401);

  // Auf einer zugeordneten Adresse lässt sich die Firmenkennung nicht überschreiben.
  const forced = await login('chef@example.test', NEW_PASSWORD_A, { tenant: 'acme', host: 'hr.beta.example' });
  assert.equal(forced.status, 401);
  const proper = await login('chef@example.test', NEW_PASSWORD_B, { host: 'hr.beta.example' });
  assert.equal(proper.status, 200);
});

test('Unerwartete Datentypen bei der Anmeldung führen nicht zum Serverfehler', async () => {
  for (const body of [{ email: { toString: 1 }, password: 'x' }, { email: ['a@b.de'], password: ['x'] }, { email: 'a@b.de', password: 'x', tenant: { toString: 1 } }, { email: null, password: null, tenant: 5 }]) {
    const response = await call('POST', '/api/auth/login', { body });
    assert.equal(response.status, 401, JSON.stringify(body));
  }
});

test('Unbekannte Firmenkennung und falsches Passwort liefern dieselbe Antwort', async () => {
  const unknownTenant = await login('chef@example.test', NEW_PASSWORD_A, { tenant: 'gibt-es-nicht' });
  const wrongPassword = await login('chef@example.test', 'FalschesPasswort!!', { tenant: 'acme' });
  assert.equal(unknownTenant.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(unknownTenant.data, wrongPassword.data);
});

test('Die Login-Seite verrät keine Organisationsnamen', async () => {
  const shared = await call('GET', '/api/public/context');
  assert.equal(shared.data.tenant, null);
  assert.equal(shared.data.tenantSelectable, true);
  const byCode = await call('GET', '/api/public/context?org=acme');
  assert.equal(byCode.data.tenant.name, 'Acme GmbH');
  const unknown = await call('GET', '/api/public/context?org=gibt-es-nicht');
  assert.equal(unknown.data.tenant, null);
  const byHost = await call('GET', '/api/public/context', { host: 'hr.beta.example' });
  assert.equal(byHost.data.tenant.name, 'Beta AG');
  assert.equal(byHost.data.tenantSelectable, false);
});

test('Modulschalter wirken serverseitig und nur im eigenen Mandanten', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const beta = await adminSession('beta', 'chef@example.test', NEW_PASSWORD_B, tempPasswords.beta);

  assert.equal((await call('GET', '/api/feedback/cycles', { cookie: acme })).status, 200);
  const off = await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));

  const blocked = await call('GET', '/api/feedback/cycles', { cookie: acme });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'module_disabled');
  // Andere Schreibweisen des Pfades dürfen den Schalter nicht umgehen: Es dürfen nie Daten zurückkommen.
  for (const variant of ['/api/FEEDBACK/cycles', '/API/feedback/cycles', '/api/feedback/cycles/', '/api/%66eedback/cycles', '//api/feedback/cycles']) {
    const response = await call('GET', variant, { cookie: acme });
    assert.equal(Array.isArray(response.data?.cycles), false, variant);
  }
  assert.equal((await call('GET', '/api/FEEDBACK/cycles', { cookie: acme })).status, 403);
  assert.equal((await call('GET', '/api/feedback/cycles', { cookie: beta })).status, 200);

  const config = await call('GET', '/api/app/config', { cookie: acme });
  assert.equal(config.data.modules.includes('feedback'), false);
  assert.equal(config.data.modules.includes('goals'), true);

  const on = await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal((await call('GET', '/api/feedback/cycles', { cookie: acme })).status, 200);
});

test('Abhängigkeiten zwischen Modulen werden eingehalten', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const blocked = await call('PATCH', '/api/organization/modules/goals', { cookie: acme, body: { enabled: false } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'module_has_dependents');

  assert.equal((await call('PATCH', '/api/organization/modules/talent_review', { cookie: acme, body: { enabled: false } })).status, 200);
  const stillNeeded = await call('PATCH', '/api/organization/modules/talent', { cookie: acme, body: { enabled: false } });
  assert.equal(stillNeeded.status, 409);
  assert.match(stillNeeded.data.error, /Nachfolgeplanung/);
  assert.equal((await call('PATCH', '/api/organization/modules/succession', { cookie: acme, body: { enabled: false } })).status, 200);
  const free = await call('PATCH', '/api/organization/modules/talent', { cookie: acme, body: { enabled: false } });
  assert.equal(free.status, 200, JSON.stringify(free.data));
  const needsTalent = await call('PATCH', '/api/organization/modules/talent_review', { cookie: acme, body: { enabled: true } });
  assert.equal(needsTalent.status, 409);
  assert.equal(needsTalent.data.code, 'module_dependency_missing');
  assert.equal((await call('PATCH', '/api/organization/modules/talent', { cookie: acme, body: { enabled: true } })).status, 200);
  assert.equal((await call('PATCH', '/api/organization/modules/talent_review', { cookie: acme, body: { enabled: true } })).status, 200);
  assert.equal((await call('PATCH', '/api/organization/modules/succession', { cookie: acme, body: { enabled: true } })).status, 200);

  const core = await call('PATCH', '/api/organization/modules/core', { cookie: acme, body: { enabled: false } });
  assert.equal(core.status, 409);
  const planned = await call('PATCH', '/api/organization/modules/benefits', { cookie: acme, body: { enabled: true } });
  assert.equal(planned.status, 409);
});

test('Nicht freigegebene Module kann die Organisation nicht selbst einschalten', async () => {
  const root = await rootSession();
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const removed = await call('PUT', '/api/platform/tenants/acme/modules/checkins', { cookie: root, body: { entitled: false } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await call('GET', '/api/checkins', { cookie: acme })).status, 403);
  const forbidden = await call('PATCH', '/api/organization/modules/checkins', { cookie: acme, body: { enabled: true } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.code, 'module_not_entitled');
  assert.equal((await call('PUT', '/api/platform/tenants/acme/modules/checkins', { cookie: root, body: { entitled: true } })).status, 200);
  assert.equal((await call('GET', '/api/checkins', { cookie: acme })).status, 200);
});

test('Nur die HR-Administration darf Module und Einstellungen ändern', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const created = await call('POST', '/api/users', { cookie: acme, body: { name: 'Erika Beschaeftigt', email: 'erika@example.test', password: 'TemporaeresPasswort1!', role: 'employee' } });
  assert.equal(created.status, 200);
  const employee = await login('erika@example.test', 'TemporaeresPasswort1!', { tenant: 'acme' });
  assert.equal(employee.status, 200);
  assert.equal((await call('POST', '/api/auth/password', { cookie: employee.cookie, body: { currentPassword: 'TemporaeresPasswort1!', newPassword: 'ErikasEigenesPasswort1!' } })).status, 200);
  assert.equal((await call('PATCH', '/api/organization/modules/feedback', { cookie: employee.cookie, body: { enabled: false } })).status, 403);
  assert.equal((await call('PATCH', '/api/organization/settings', { cookie: employee.cookie, body: { supportAccess: true } })).status, 403);
  assert.equal((await call('GET', '/api/organization/modules', { cookie: employee.cookie })).status, 403);
});

test('Support-Zugriff braucht die Freigabe der Organisation und ist sofort widerrufbar', async () => {
  const root = await rootSession();
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);

  const denied = await call('POST', '/api/platform/tenants/acme/enter', { cookie: root, body: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'support_access_denied');
  const selfGranted = await call('PATCH', '/api/platform/tenants/acme', { cookie: root, body: { supportAccess: true } });
  assert.equal(selfGranted.status, 403);
  const directLogin = await login('root@root.de', ROOT_PASSWORD, { tenant: 'acme' });
  assert.equal(directLogin.status, 403);

  assert.equal((await call('PATCH', '/api/organization/settings', { cookie: acme, body: { supportAccess: true } })).status, 200);
  const entered = await call('POST', '/api/platform/tenants/acme/enter', { cookie: root, body: {} });
  assert.equal(entered.status, 200, JSON.stringify(entered.data));
  const seen = await call('GET', '/api/users', { cookie: root });
  assert.equal(seen.status, 200);
  assert.ok(seen.data.users.some(user => user.email === 'nur.acme@example.test'));
  assert.equal(seen.data.users.some(user => user.email === 'system-root@daybreak.internal'), false);
  // Programmierfunktion und Systemverwaltung gibt es nur im Hauptmandanten.
  assert.equal((await call('GET', '/api/automation/status', { cookie: root })).status, 404);

  const acmeFile = openTenantData('acme');
  assert.equal(acmeFile.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='support_access_entered'").get().count, 1);
  acmeFile.close();

  assert.equal((await call('PATCH', '/api/organization/settings', { cookie: acme, body: { supportAccess: false } })).status, 200);
  assert.equal((await call('GET', '/api/users', { cookie: root })).status, 401);
});

test('Der Betreiber kann sich die Support-Freigabe mit keinem Datentyp selbst erteilen', async () => {
  const root = await rootSession();
  const before = daybreak.platform.tenantBySlug('acme').support_access;
  assert.equal(before, false);
  for (const value of [true, 1, 'true', 'ja', [true], { a: 1 }, null]) {
    const response = await call('PATCH', '/api/platform/tenants/acme', { cookie: root, body: { supportAccess: value } });
    assert.equal(response.status, 403, `Wert ${JSON.stringify(value)}: ${response.status}`);
    assert.equal(daybreak.platform.tenantBySlug('acme').support_access, false, JSON.stringify(value));
  }
  assert.equal((await call('POST', '/api/platform/tenants/acme/enter', { cookie: root, body: {} })).status, 403);
  // Entziehen bleibt erlaubt.
  assert.equal((await call('PATCH', '/api/platform/tenants/acme', { cookie: root, body: { supportAccess: false } })).status, 200);
  // Auch die Organisation setzt die Freigabe nur mit einem echten Wahrheitswert.
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  assert.equal((await call('PATCH', '/api/organization/settings', { cookie: acme, body: { supportAccess: 1 } })).status, 200);
  assert.equal(daybreak.platform.tenantBySlug('acme').support_access, false);
  // Weitere Felder lassen sich nicht mit falschen Datentypen setzen.
  assert.equal((await call('PATCH', '/api/platform/tenants/default', { cookie: root, body: { demoMode: 1 } })).status, 400);
  assert.equal((await call('PATCH', '/api/platform/tenants/acme', { cookie: root, body: { name: ['x'] } })).status, 400);
  assert.equal((await call('PATCH', '/api/platform/tenants/acme', { cookie: root, body: { primaryColor: ['#000000'] } })).status, 400);
});

test('Passwortänderungen bremsen andere Organisationen nicht aus', async () => {
  const session = await adminSession('beta', 'chef@example.test', NEW_PASSWORD_B, tempPasswords.beta);
  const attempts = Array.from({ length: 12 }, () => call('POST', '/api/auth/password', { cookie: session, body: { currentPassword: 'falsch-falsch-falsch', newPassword: 'NochEinNeuesPasswort1!' } }));
  await new Promise(resolve => setTimeout(resolve, 30));
  const started = Date.now();
  const other = await call('GET', '/api/public/context');
  const waited = Date.now() - started;
  assert.equal(other.status, 200);
  const results = await Promise.all(attempts);
  for (const result of results) assert.ok([400, 429].includes(result.status), String(result.status));
  // Eine blockierende Prüfung bräuchte hier mehrere Sekunden.
  assert.ok(waited < 400, `Fremde Anfrage wartete ${waited} ms`);
  // Der Grenzwert je Person greift danach.
  assert.equal((await call('POST', '/api/auth/password', { cookie: session, body: { currentPassword: 'falsch-falsch-falsch', newPassword: 'NochEinNeuesPasswort1!' } })).status, 429);
});

test('Sicherheitskopfzeilen sind gesetzt und der Server nennt seine Technik nicht', async () => {
  const response = await call('GET', '/api/public/context');
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.match(response.headers['content-security-policy'], /font-src 'self'/);
  assert.equal(String(response.headers['content-security-policy']).includes('googleapis'), false);
});

test('Gesperrte Mandanten verlieren sofort den Zugang und sind reaktivierbar', async () => {
  const root = await rootSession();
  const beta = await adminSession('beta', 'chef@example.test', NEW_PASSWORD_B, tempPasswords.beta);
  assert.equal((await call('PATCH', '/api/platform/tenants/beta', { cookie: root, body: { status: 'suspended' } })).status, 200);
  const blocked = await call('GET', '/api/users', { cookie: beta });
  assert.ok([401, 403].includes(blocked.status));
  const relogin = await login('chef@example.test', NEW_PASSWORD_B, { tenant: 'beta' });
  assert.equal(relogin.status, 403);
  assert.equal(relogin.data.code, 'tenant_suspended');
  assert.equal((await call('PATCH', '/api/platform/tenants/beta', { cookie: root, body: { status: 'active' } })).status, 200);
  assert.equal((await login('chef@example.test', NEW_PASSWORD_B, { tenant: 'beta' })).status, 200);
  const primary = await call('PATCH', '/api/platform/tenants/default', { cookie: root, body: { status: 'suspended' } });
  assert.equal(primary.status, 409);
});

test('Gesperrte Konten verlieren den Zugang, auch mit laufender Sitzung', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const created = await call('POST', '/api/users', { cookie: acme, body: { name: 'Ausgetreten', email: 'weg@example.test', password: 'TemporaeresPasswort1!', role: 'employee' } });
  const session = await login('weg@example.test', 'TemporaeresPasswort1!', { tenant: 'acme' });
  assert.equal(session.status, 200);
  assert.equal((await call('PATCH', `/api/users/${created.data.id}/active`, { cookie: acme, body: { active: false } })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: session.cookie })).status, 401);
  assert.equal((await login('weg@example.test', 'TemporaeresPasswort1!', { tenant: 'acme' })).status, 401);
  const list = await call('GET', '/api/users', { cookie: acme });
  assert.equal(list.data.users.some(user => user.email === 'weg@example.test'), false);
  const inactive = await call('GET', '/api/users?includeInactive=true', { cookie: acme });
  assert.equal(inactive.data.users.some(user => user.email === 'weg@example.test'), true);
  assert.equal((await call('PATCH', `/api/users/${created.data.id}/active`, { cookie: acme, body: { active: true } })).status, 200);
});

test('Passwort-Rücksetzung durch HR beendet Sitzungen und erzwingt eine Änderung', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const created = await call('POST', '/api/users', { cookie: acme, body: { name: 'Vergesslich', email: 'vergessen@example.test', password: 'TemporaeresPasswort1!', role: 'employee' } });
  const session = await login('vergessen@example.test', 'TemporaeresPasswort1!', { tenant: 'acme' });
  const reset = await call('POST', `/api/users/${created.data.id}/password`, { cookie: acme, body: {} });
  assert.equal(reset.status, 200);
  assert.ok(reset.data.temporaryPassword.length >= 12);
  assert.equal((await call('GET', '/api/auth/me', { cookie: session.cookie })).status, 401);
  assert.equal((await login('vergessen@example.test', 'TemporaeresPasswort1!', { tenant: 'acme' })).status, 401);
  const fresh = await login('vergessen@example.test', reset.data.temporaryPassword, { tenant: 'acme' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.user.must_change_password, 1);
});

test('Ein HR Business Partner kann keine HR-Administration anlegen oder übernehmen', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const created = await call('POST', '/api/users', { cookie: acme, body: { name: 'Partner', email: 'partner@example.test', password: 'TemporaeresPasswort1!', role: 'hrbp' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const session = await login('partner@example.test', 'TemporaeresPasswort1!', { tenant: 'acme' });
  assert.equal((await call('POST', '/api/auth/password', { cookie: session.cookie, body: { currentPassword: 'TemporaeresPasswort1!', newPassword: 'PartnerEigenesPasswort1!' } })).status, 200);
  const escalate = await call('POST', '/api/users', { cookie: session.cookie, body: { name: 'Neu', email: 'neu.admin@example.test', password: 'TemporaeresPasswort1!', role: 'hr_admin' } });
  assert.equal(escalate.status, 403);
  const admins = (await call('GET', '/api/users', { cookie: acme })).data.users.filter(user => user.role === 'hr_admin');
  assert.equal((await call('POST', `/api/users/${admins[0].id}/password`, { cookie: session.cookie, body: {} })).status, 403);
  assert.equal((await call('PATCH', `/api/users/${admins[0].id}/active`, { cookie: session.cookie, body: { active: false } })).status, 403);
  assert.equal((await call('PATCH', '/api/organization/modules/feedback', { cookie: session.cookie, body: { enabled: false } })).status, 403);
});

test('Die letzte aktive HR-Administration lässt sich nicht aussperren', async () => {
  const beta = await adminSession('beta', 'chef@example.test', NEW_PASSWORD_B, tempPasswords.beta);
  const second = await call('POST', '/api/users', { cookie: beta, body: { name: 'Zweite Admin', email: 'zweite@example.test', password: 'TemporaeresPasswort1!', role: 'hr_admin' } });
  assert.equal(second.status, 200);
  const secondSession = await login('zweite@example.test', 'TemporaeresPasswort1!', { tenant: 'beta' });
  assert.equal((await call('POST', '/api/auth/password', { cookie: secondSession.cookie, body: { currentPassword: 'TemporaeresPasswort1!', newPassword: 'ZweiteAdminPasswort1!' } })).status, 200);
  const users = (await call('GET', '/api/users', { cookie: beta })).data.users;
  const first = users.find(user => user.email === 'chef@example.test');
  // Die zweite Person sperrt die erste: erlaubt, denn es bleibt eine aktive HR-Administration.
  assert.equal((await call('PATCH', `/api/users/${first.id}/active`, { cookie: secondSession.cookie, body: { active: false } })).status, 200);
  const root = await rootSession();
  // Jetzt ist die zweite die letzte. Nur über den Support käme jemand an sie heran, deshalb direkt prüfen.
  assert.equal((await call('PATCH', '/api/organization/settings', { cookie: secondSession.cookie, body: { supportAccess: true } })).status, 200);
  assert.equal((await call('POST', '/api/platform/tenants/beta/enter', { cookie: root, body: {} })).status, 200);
  assert.equal((await call('PATCH', `/api/users/${second.data.id}/active`, { cookie: root, body: { active: false } })).status, 409);
  assert.equal((await call('PATCH', `/api/users/${first.id}/active`, { cookie: secondSession.cookie, body: { active: true } })).status, 200);
  assert.equal((await call('PATCH', '/api/organization/settings', { cookie: secondSession.cookie, body: { supportAccess: false } })).status, 200);
});

test('Datumsangaben müssen echte Kalendertage sein', async () => {
  const { validDate } = require('../lib/core-helpers');
  assert.equal(validDate('2026-02-28'), true);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2026-02-31'), false);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(validDate(['2026-01-01']), false);
  assert.equal(validDate(''), true);
  assert.equal(validDate(null), true);
});

test('Kaputte Anfragen ergeben keinen Serverfehler', async () => {
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject);
    request.end('{kein json');
  });
  assert.equal(response, 400);
});

test('Datenbanken der Organisationen sind nur für den Eigentümer lesbar', { skip: isPostgres }, () => {
  assert.equal(fs.statSync(path.join(directory, 'data', 'tenants', 'acme.db')).mode & 0o777, 0o600);
});

test('Wiederholte Fehlversuche werden pro Konto gebremst', async () => {
  const email = 'bremse@example.test';
  let last;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    last = await login(email, 'falsch-falsch-falsch', { tenant: 'acme' });
  }
  assert.equal(last.status, 429);
  const other = await login('chef@example.test', NEW_PASSWORD_A, { tenant: 'acme' });
  assert.equal(other.status, 200);
});

test('Anfragen von fremden Websites werden abgewiesen', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const foreign = await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, origin: 'https://boese.example', body: { enabled: false } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'origin_rejected');
  const same = await call('GET', '/api/organization/modules', { cookie: acme, origin: 'https://boese.example' });
  assert.equal(same.status, 200);
  const own = await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, origin: `http://127.0.0.1:${port}`, body: { enabled: true } });
  assert.equal(own.status, 200);
});

test('Aufgaben abgeschalteter Module verschwinden aus der Übersicht und kommen wieder', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const runtime = daybreak.runtimeFor(daybreak.platform.tenantBySlug('acme'));
  const admin = runtime.db.prepare("SELECT id FROM users WHERE email='chef@example.test'").get();
  runtime.db.prepare("INSERT INTO tasks(user_id,title,type,due_date) VALUES(?,?,?,?)").run(admin.id, 'Feedback abgeben', 'feedback_invitation', '2099-01-01');
  const visible = await call('GET', '/api/dashboard', { cookie: acme });
  assert.ok(visible.data.tasks.some(task => task.title === 'Feedback abgeben'));
  assert.equal((await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, body: { enabled: false } })).status, 200);
  const hidden = await call('GET', '/api/dashboard', { cookie: acme });
  assert.equal(hidden.data.tasks.some(task => task.title === 'Feedback abgeben'), false);
  assert.equal((await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, body: { enabled: true } })).status, 200);
});

test('Dayo beantwortet Fragen nur zu eingeschalteten Modulen', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  const question = { message: 'Wie funktioniert die 360 Grad Feedback Nominierung?', context: { view: 'dashboard' } };
  const before360 = await call('POST', '/api/assistant/chat', { cookie: acme, body: question });
  assert.equal(before360.data.id, 'feedback-nomination');
  assert.equal((await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, body: { enabled: false } })).status, 200);
  const after360 = await call('POST', '/api/assistant/chat', { cookie: acme, body: question });
  assert.notEqual(after360.data.id, 'feedback-nomination');
  assert.equal((await call('PATCH', '/api/organization/modules/feedback', { cookie: acme, body: { enabled: true } })).status, 200);
});

test('Unbekannte Schnittstellen antworten als Daten, nicht mit der Startseite', async () => {
  const acme = await adminSession('acme', 'chef@example.test', NEW_PASSWORD_A, tempPasswords.acme);
  assert.equal((await call('GET', '/api/gibt-es-nicht', { cookie: acme })).status, 404);
  assert.equal((await call('GET', '/api/gibt-es-nicht')).status, 401);
});

test('Demo-Passwörter lassen sich für den Echtbetrieb sperren', async () => {
  const root = await rootSession();
  const primary = daybreak.platform.primaryTenant();
  const runtime = daybreak.runtimeFor(primary);
  runtime.db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Demo Person','demo.person@example.test',?,'employee')").run(bcrypt.hashSync('demo1234', 4));
  assert.equal((await login('demo.person@example.test', 'demo1234')).status, 200);
  assert.equal((await call('POST', '/api/platform/tenants/default/lock-demo-accounts', { cookie: root, body: { confirmation: 'falsch' } })).status, 400);
  const locked = await call('POST', '/api/platform/tenants/default/lock-demo-accounts', { cookie: root, body: { confirmation: 'default' } });
  assert.equal(locked.status, 200, JSON.stringify(locked.data));
  assert.equal(locked.data.locked, 1);
  assert.equal((await login('demo.person@example.test', 'demo1234')).status, 401);
});

test('Demo-Modus ist für Organisationen nicht einschaltbar', async () => {
  const root = await rootSession();
  const response = await call('PATCH', '/api/platform/tenants/acme', { cookie: root, body: { demoMode: true } });
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'demo_not_allowed');
});

test('Sicherung umfasst Steuerung und alle Mandanten und ist nur für den Eigentümer lesbar', async () => {
  const backupRoot = path.join(directory, 'backup-test');
  const result = await backupAll({ storage: daybreak.platform.storage, backupRoot, stamp: 'test' });
  const names = result.files.map(file => path.basename(file)).sort();
  const extension = isPostgres ? 'sql' : 'db';
  assert.ok(names.includes(`control.${extension}`));
  assert.ok(names.includes(`tenant-acme.${extension}`));
  assert.ok(names.includes(`tenant-beta.${extension}`));
  assert.ok(names.includes(`tenant-default.${extension}`));
  for (const file of result.files) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const backupFile = name => path.join(backupRoot, 'tenants-test', name);
  if (isPostgres) {
    assert.ok(fs.readFileSync(backupFile('tenant-acme.sql'), 'utf8').includes('nur.acme@example.test'));
    assert.equal(fs.readFileSync(backupFile('tenant-beta.sql'), 'utf8').includes('nur.acme@example.test'), false);
  } else {
    const copy = new Database(backupFile('tenant-acme.db'), { readonly: true });
    assert.ok(copy.prepare("SELECT COUNT(*) count FROM users WHERE email='nur.acme@example.test'").get().count === 1);
    copy.close();
  }
});

test('Löschen geht nur nach Archivierung, mit Bestätigung und letzter Sicherung', async () => {
  const root = await rootSession();
  const created = await call('POST', '/api/platform/tenants', { cookie: root, body: { slug: 'weg', name: 'Weg GmbH', adminName: 'A', adminEmail: 'a@example.test' } });
  assert.equal(created.status, 201);
  assert.equal(tenantDataExists('weg'), true);
  assert.equal((await call('DELETE', '/api/platform/tenants/weg', { cookie: root, body: { confirmation: 'weg' } })).status, 409);
  assert.equal((await call('PATCH', '/api/platform/tenants/weg', { cookie: root, body: { status: 'archived' } })).status, 200);
  assert.equal((await call('DELETE', '/api/platform/tenants/weg', { cookie: root, body: { confirmation: 'falsch' } })).status, 400);
  const removed = await call('DELETE', '/api/platform/tenants/weg', { cookie: root, body: { confirmation: 'weg' } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(tenantDataExists('weg'), false);
  assert.equal(fs.existsSync(removed.data.finalBackup), true);
  assert.equal((await call('DELETE', '/api/platform/tenants/default', { cookie: root, body: { confirmation: 'default' } })).status, 409);
});

test('Beispieldaten neuer Module entstehen nur, wenn es ausschließlich Demo-Konten gibt', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-seed-test-'));
  const projectRoot = path.resolve(__dirname, '..');
  const start = (name, demo, dataDir) => createDaybreakApp({
    env: { DAYBREAK_DB_PATH: path.join(folder, name), DAYBREAK_DATA_DIR: path.join(folder, dataDir), DAYBREAK_PRIMARY_DEMO: demo ? 'true' : 'false', SESSION_SECRET: 'test' },
    projectRoot
  });
  const records = app => app.runtimeFor(app.platform.primaryTenant()).db.prepare('SELECT COUNT(*) count FROM personnel_records').get().count;
  try {
    // Reine Demo-Installation: Beispieldaten sind da.
    const demo = start('demo.db', true, 'data-demo');
    assert.ok(records(demo) > 0);
    demo.close();

    // Bestehende Datenbank mit echter Person: Die neuen Module bleiben leer.
    const first = start('echt.db', false, 'data-echt');
    first.runtimeFor(first.platform.primaryTenant()).db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Echte Person','echt@firma.example','x','hr_admin')").run();
    first.platform.updateTenant(first.platform.primaryTenant().id, { demoMode: true }, 'test');
    first.close();
    const second = start('echt.db', true, 'data-echt');
    assert.equal(second.platform.primaryTenant().demo_mode, true);
    assert.equal(records(second), 0);
    second.close();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Der Katalog ordnet Pfade, Aufgaben und Abhängigkeiten richtig zu', () => {
  assert.equal(moduleForPath('/goals'), 'goals');
  assert.equal(moduleForPath('/goals/5/review'), 'goals');
  assert.equal(moduleForPath('/talent-review/periods'), 'talent_review');
  assert.equal(moduleForPath('/talent/profile'), 'talent');
  assert.equal(moduleForPath('/positions'), null);
  assert.equal(moduleForPath('/positions/assign/4'), null);
  assert.equal(moduleForPath('/positions/4/requirements'), 'talent');
  assert.equal(moduleForPath('/positions/requirements/4'), 'talent');
  assert.equal(moduleForPath('/users'), null);
  assert.equal(moduleForPath('/absence/requests'), 'absence');
  assert.equal(moduleForTaskType('goal_approval'), 'goals');
  assert.equal(moduleForTaskType('checkin'), 'checkins');
  assert.equal(moduleForTaskType('talent_pool_proposal'), 'talent_review');
  assert.equal(moduleForTaskType('absence_approval'), 'absence');
  assert.equal(moduleForTaskType('unbekannt'), null);
  assert.deepEqual([...withDependencies(['talent_review'])].sort(), ['goals', 'talent', 'talent_review']);
});
