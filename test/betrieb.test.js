'use strict';

/**
 * Was im Betrieb schiefgehen kann: Datenbank weg, Sicherung abgebrochen.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createDaybreakApp } = require('../lib/create-app');
const { backupTenant } = require('../lib/platform-backup');

const projectRoot = path.resolve(__dirname, '..');

test('Ein abgebrochenes pg_dump gilt nicht als Sicherung', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-pgdump-'));
  const programs = path.join(directory, 'programme');
  fs.mkdirSync(programs);
  fs.writeFileSync(path.join(programs, 'pg_dump'), '#!/bin/sh\necho halbe Sicherung > "$6"\nkill -9 $$\n', { mode: 0o755 });
  const earlierPath = process.env.PATH;
  process.env.PATH = `${programs}:${earlierPath}`;
  t.after(() => {
    process.env.PATH = earlierPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const backupRoot = path.join(directory, 'sicherungen');
  await assert.rejects(
    backupTenant({
      tenant: { slug: 'firma', db_path: 'postgres:t_firma' },
      backupRoot,
      stamp: 'jetzt',
      storage: { connectionString: 'postgres://nutzer@127.0.0.1/datenbank', schemaOf: () => 't_firma' }
    }),
    /vorzeitig beendet/
  );
  assert.deepEqual(fs.readdirSync(path.join(backupRoot, 'tenants-jetzt')), [], 'Es bleibt keine halbe Datei liegen');
});

test('Die Seiten werden auch ohne erreichbare Datenbank ausgeliefert', { skip: Boolean(process.env.DAYBREAK_TEST_DATABASE_URL) }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daybreak-ohne-db-'));
  const daybreak = createDaybreakApp({
    env: { DAYBREAK_DB_PATH: path.join(directory, 'firma.db'), DAYBREAK_BACKUP_ROOT: path.join(directory, 'sicherungen'), SESSION_COOKIE_SECURE: 'false', SESSION_SECRET: 'nur-fuer-den-test' },
    projectRoot
  });
  const server = await new Promise(resolve => {
    const listener = daybreak.app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    try {
      daybreak.close();
    } catch {
      // Die Steuerung ist in diesem Test schon geschlossen.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Ab hier scheitert jede Abfrage an die Steuerung, also auch Sitzung und Mandantensuche.
  daybreak.platform.db.close();
  const headers = { cookie: 'connect.sid=s%3Airgendwas.irgendwas' };
  for (const address of ['/', '/app.js', '/style.css', '/irgendeine/adresse']) {
    const response = await fetch(`${baseUrl}${address}`, { headers });
    assert.equal(response.status, 200, address);
    assert.ok(response.headers.get('content-security-policy'), `Auch ${address} trägt die Sicherheitsregeln`);
  }
  assert.equal((await fetch(`${baseUrl}/api/public/context`, { headers })).status, 500);
});
