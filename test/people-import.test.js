const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { MAX_ROWS, createPeopleImportModule } = require('../routes/peopleImport');

let h;
before(async () => {
  h = await createModuleHarness(createPeopleImportModule);
});
after(() => h.close());

const url = '/api/users/import';
const person = (name, email, extra = {}) => ({ name, email, role: 'Mitarbeiter:in', position: '', managerEmail: '', ...extra });
const countUsers = () => h.db.prepare('SELECT COUNT(*) count FROM users').get().count;

test('Ohne Anmeldung und ohne HR-Rolle ist kein Import möglich', async () => {
  const rows = [person('Test', 'test@firma.example')];
  assert.equal((await h.api(null, 'POST', url, { rows })).status, 401);
  assert.equal((await h.api('anna', 'POST', url, { rows })).status, 403);
  assert.equal((await h.api('manager', 'POST', url, { rows })).status, 403);
  assert.equal((await h.api('director', 'POST', url, { rows })).status, 403);
});

test('Die Vorschau meldet Fehler je Zeile und ändert nichts', async () => {
  const before = countUsers();
  const response = await h.api('hr', 'POST', url, {
    dryRun: true,
    rows: [
      person('', 'ohne.name@firma.example'),
      person('Kaputt', 'keine-mail'),
      person('Doppelt Eins', 'doppelt@firma.example'),
      person('Doppelt Zwei', 'doppelt@firma.example'),
      person('Schon Da', 'anna@test.local'),
      person('Falsche Rolle', 'rolle@firma.example', { role: 'Chef' }),
      person('Reserviert', 'root@root.de'),
      person('Sich Selbst', 'selbst@firma.example', { managerEmail: 'selbst@firma.example' }),
      person('Ohne Chef', 'ohnechef@firma.example', { managerEmail: 'gibt.es.nicht@firma.example' }),
      person('Passt', 'passt@firma.example')
    ]
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.summary.total, 10);
  assert.equal(response.data.summary.valid, 1);
  const errorsFor = line => response.data.rows.find(row => row.line === line).errors.join(' ');
  assert.match(errorsFor(1), /Name fehlt/);
  assert.match(errorsFor(2), /ungültig/);
  assert.match(errorsFor(3), /mehrfach/);
  assert.match(errorsFor(5), /bereits vergeben/);
  assert.match(errorsFor(6), /Unbekannte Rolle/);
  assert.match(errorsFor(7), /reserviert/);
  assert.match(errorsFor(8), /eigene Führungskraft/);
  assert.match(errorsFor(9), /nicht gefunden|weder/);
  assert.deepEqual(response.data.rows[9].errors, []);
  assert.equal(countUsers(), before);
});

test('Ringe in der Führungslinie werden erkannt', async () => {
  const response = await h.api('hr', 'POST', url, {
    dryRun: true,
    rows: [
      person('A', 'ring.a@firma.example', { managerEmail: 'ring.b@firma.example' }),
      person('B', 'ring.b@firma.example', { managerEmail: 'ring.c@firma.example' }),
      person('C', 'ring.c@firma.example', { managerEmail: 'ring.a@firma.example' })
    ]
  });
  assert.equal(response.data.summary.invalid, 3);
  assert.match(response.data.rows[0].errors.join(' '), /Ring/);
});

test('Enthält die Datei Fehler, wird nichts angelegt', async () => {
  const before = countUsers();
  const response = await h.api('hr', 'POST', url, { rows: [person('Gut', 'gut.eins@firma.example'), person('', 'schlecht@firma.example')] });
  assert.equal(response.status, 400);
  assert.equal(countUsers(), before);
});

test('Import legt Personen mit Führungslinie und temporären Passwörtern an', async () => {
  const positionId = h.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Teamleitung','teamleitung')").run().lastInsertRowid;
  const response = await h.api('hr', 'POST', url, {
    rows: [
      // Bewusst in "falscher" Reihenfolge: Die Führungskraft steht erst weiter unten.
      person('Max Beispiel', 'MAX@firma.example', { managerEmail: 'erika@firma.example' }),
      person('Erika Beispiel', 'erika@firma.example', { role: 'Führungskraft', position: 'teamleitung', managerEmail: 'director@test.local' }),
      person('Ohne Rolle', 'ohnerolle@firma.example', { role: '' })
    ]
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.created.length, 3);

  const max = h.db.prepare('SELECT * FROM users WHERE email=?').get('max@firma.example');
  const erika = h.db.prepare('SELECT * FROM users WHERE email=?').get('erika@firma.example');
  const director = h.db.prepare("SELECT id FROM users WHERE email='director@test.local'").get();
  assert.equal(max.manager_id, erika.id);
  assert.equal(erika.manager_id, director.id);
  assert.equal(erika.role, 'manager');
  assert.equal(erika.position_profile_id, positionId);
  const history = h.db.prepare('SELECT position_title,source FROM position_assignment_history WHERE user_id=?').all(erika.id);
  assert.deepEqual(history, [{ position_title: 'Teamleitung', source: 'import' }]);
  assert.equal(h.db.prepare('SELECT role FROM users WHERE email=?').get('ohnerolle@firma.example').role, 'employee');
  assert.equal(max.must_change_password, 1);
  assert.equal(max.active, 1);

  const created = response.data.created.find(item => item.email === 'max@firma.example');
  assert.ok(created.temporaryPassword.length >= 12);
  assert.equal(await bcrypt.compare(created.temporaryPassword, max.password_hash), true);
  assert.notEqual(max.password_hash, created.temporaryPassword);

  const audit = h.db.prepare("SELECT old_values,new_values FROM audit_log WHERE action='user_imported' AND entity_id=?").get(max.id);
  assert.ok(audit);
  assert.equal(String(audit.new_values).includes(created.temporaryPassword), false);
});

test('Ein HR Business Partner kann keine HR-Administration importieren', async () => {
  const forbidden = await h.api('bp', 'POST', url, { dryRun: true, rows: [person('Neue Admin', 'neu.admin@firma.example', { role: 'HR Admin' })] });
  assert.match(forbidden.data.rows[0].errors.join(' '), /HR-Administration/);
  const allowed = await h.api('hr', 'POST', url, { dryRun: true, rows: [person('Neue Admin', 'neu.admin@firma.example', { role: 'HR Admin' })] });
  assert.deepEqual(allowed.data.rows[0].errors, []);
});

test('Ungültige Anfragen und zu große Dateien werden abgewiesen', async () => {
  assert.equal((await h.api('hr', 'POST', url, { rows: [] })).status, 400);
  assert.equal((await h.api('hr', 'POST', url, { rows: 'keine liste' })).status, 400);
  assert.equal((await h.api('hr', 'POST', url, {})).status, 400);
  const tooMany = Array.from({ length: MAX_ROWS + 1 }, (_, index) => ({ name: 'x', email: `x${index}@firma.example` }));
  assert.equal((await h.api('hr', 'POST', url, { rows: tooMany })).status, 400);
});

test('Spitze Klammern im Namen werden entfernt', async () => {
  const response = await h.api('hr', 'POST', url, { rows: [person('<script>Böse</script>', 'klammer@firma.example')] });
  assert.equal(response.status, 201);
  assert.equal(h.db.prepare('SELECT name FROM users WHERE email=?').get('klammer@firma.example').name.includes('<'), false);
});

test('Ein neues Konto mit Position erhält einen Eintrag in der Positionshistorie', () => {
  const positionId = h.db.prepare("INSERT INTO position_profiles(title,title_normalized) VALUES('Sachbearbeitung','sachbearbeitung')").run().lastInsertRowid;
  const hr = { id: 1 };
  const created = h.deps.createUserAccount({ name: 'Neu Eingestellt', email: 'neu.eingestellt@firma.example', positionProfileId: positionId, positionEffectiveDate: '2027-01-01', actor: hr });
  const rows = h.db.prepare('SELECT position_profile_id,effective_date,changed_by,source FROM position_assignment_history WHERE user_id=?').all(created.id);
  assert.deepEqual(rows, [{ position_profile_id: positionId, effective_date: '2027-01-01', changed_by: 1, source: 'user_creation' }]);
});
