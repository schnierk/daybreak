'use strict';

/**
 * Testhilfe für Fachmodule: startet ein Modul auf einer leeren Testdatenbank mit
 * einer kleinen Beispielorganisation. Eine Anfrage nennt über "as" die angemeldete Person.
 * Berührt weder Produktivdaten noch die Steuerungsdatenbank.
 *
 *   hr(1, HR-Admin)
 *   bp(2, HR Business Partner)
 *   director(3)
 *     manager(4)
 *       anna(5, Mitarbeiterin)
 *       ben(6, Mitarbeiter)
 *     clara(7, Mitarbeiterin, gehört nicht zum Team von manager)
 */

const express = require('express');
const { openTestDatabase } = require('./test-database');
const { createCoreHelpers, initializeCoreSchema } = require('../core-helpers');
const { createTalentModule } = require('../../routes/talent');

const PEOPLE = {
  hr: { id: 1, name: 'Hanna HR', role: 'hr_admin', manager: null },
  bp: { id: 2, name: 'Boris Partner', role: 'hrbp', manager: null },
  director: { id: 3, name: 'Dora Direktor', role: 'director', manager: null },
  manager: { id: 4, name: 'Malte Manager', role: 'manager', manager: 3 },
  anna: { id: 5, name: 'Anna Ahrens', role: 'employee', manager: 4 },
  ben: { id: 6, name: 'Ben Berg', role: 'employee', manager: 4 },
  clara: { id: 7, name: 'Clara Cordes', role: 'employee', manager: 3 }
};

async function createModuleHarness(factory, { isModuleEnabled = () => true, tenant = { slug: 'test', name: 'Testfirma' }, extra = {} } = {}) {
  const db = openTestDatabase();
  initializeCoreSchema(db);
  const helpers = createCoreHelpers(db);

  const current = req => {
    const id = Number(req.get('x-test-user'));
    return id ? db.prepare('SELECT id,name,email,role,title,manager_id FROM users WHERE id=? AND is_system_account=0 AND active=1').get(id) || null : null;
  };
  const auth = (req, res, next) => current(req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' });
  const deps = { db, auth, current, isModuleEnabled, tenant, ...helpers, ...extra };

  // Talent liefert Positionsprofile und Kompetenzen, auf die Module verweisen dürfen.
  const talent = createTalentModule({ ...deps });
  talent.initialize();
  deps.skillGap = talent.skillGap;
  const addUser = db.prepare("INSERT INTO users(id,name,email,password_hash,role,manager_id) VALUES(?,?,?,'!TEST!',?,?)");
  for (const [key, person] of Object.entries(PEOPLE)) addUser.run(person.id, person.name, `${key}@test.local`, person.role, person.manager);

  const instance = factory(deps);
  instance.initialize?.();

  const app = express();
  app.use(express.json());
  app.use('/api', instance.router);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: String(err?.stack || err) });
  });

  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /** Ruft die API auf. Beispiel: await api('anna', 'POST', '/api/absence/requests', { ... }) */
  async function api(person, method, url, body) {
    const headers = {};
    if (person) headers['x-test-user'] = String(PEOPLE[person]?.id ?? person);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }

  return { api, close, db, deps, instance, people: PEOPLE };
}

module.exports = { PEOPLE, createModuleHarness };
