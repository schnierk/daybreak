'use strict';

/**
 * Prüft die Datenbank-Schicht direkt gegen PostgreSQL. Läuft nur, wenn eine Testdatenbank
 * angegeben ist: DAYBREAK_TEST_DATABASE_URL=postgres://... npm test
 */

const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { PostgresDatabase } = require('../lib/postgres/database');
const { openTestDatabase } = require('../lib/testing/test-database');

const connectionString = process.env.DAYBREAK_TEST_DATABASE_URL;

describe('PostgreSQL-Schicht', { skip: !connectionString }, () => {
  let db;

  before(() => {
    db = openTestDatabase();
    db.exec(`
      CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT UNIQUE, age INTEGER, score REAL, photo BLOB);
      CREATE TABLE notes (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), body TEXT NOT NULL CHECK(length(body) > 0));
    `);
  });

  after(() => db.close());

  test('get, all und run verhalten sich wie bei SQLite', () => {
    const insert = db.prepare('INSERT INTO people(email,age,score) VALUES(?,?,?)');
    const first = insert.run('a@test', 30, 1.5);
    assert.ok(Number.isInteger(first.lastInsertRowid) && first.lastInsertRowid > 0);
    assert.equal(first.changes, 1);
    assert.deepEqual(db.prepare('SELECT email,age,score FROM people WHERE id=?').get(first.lastInsertRowid), { email: 'a@test', age: 30, score: 1.5 });
    assert.equal(db.prepare('SELECT * FROM people WHERE id=?').get(999999), undefined);
    assert.equal(typeof db.prepare('SELECT COUNT(*) c FROM people').get().c, 'number');
    assert.equal(typeof db.prepare('SELECT SUM(age) s FROM people').get().s, 'number');
    assert.deepEqual(db.prepare('SELECT email FROM people WHERE email=?').all('a@test'), [{ email: 'a@test' }]);
    assert.deepEqual(db.prepare('SELECT email FROM people WHERE email IN (?,?)').all(['a@test', 'x']), [{ email: 'a@test' }]);
    assert.equal(db.prepare('UPDATE people SET age=? WHERE email=?').run(31, 'a@test').changes, 1);
    assert.equal(db.prepare('DELETE FROM people WHERE email=?').run('niemand').changes, 0);
  });

  test('Datenbankfehler tragen dieselben Kennungen wie bei SQLite', () => {
    db.prepare('INSERT INTO people(email) VALUES(?)').run('doppelt@test');
    assert.throws(() => db.prepare('INSERT INTO people(email) VALUES(?)').run('doppelt@test'), error => error.code === 'SQLITE_CONSTRAINT_UNIQUE');
    assert.throws(() => db.prepare('INSERT INTO notes(person_id,body) VALUES(?,?)').run(424242, 'x'), error => error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY');
    const { id } = db.prepare('SELECT id FROM people LIMIT 1').get();
    assert.throws(() => db.prepare('INSERT INTO notes(person_id,body) VALUES(?,?)').run(id, ''), error => error.code === 'SQLITE_CONSTRAINT_CHECK');
    assert.throws(() => db.prepare('INSERT INTO notes(person_id) VALUES(?)').run(id), error => error.code === 'SQLITE_CONSTRAINT_NOTNULL');
  });

  test('Ein unpassender Wert in einer Teilabfrage im SET-Teil geht nicht still verloren', () => {
    assert.throws(() => db.prepare('UPDATE people SET age=(SELECT age FROM people WHERE id=?) WHERE id=1').run('abc'));
    assert.equal(db.prepare('UPDATE people SET age=(SELECT age FROM people WHERE id=1) WHERE id=?').run('abc').changes, 0);
  });

  test('Ein unpassender Suchwert findet nichts, statt abzustürzen', () => {
    assert.equal(db.prepare('SELECT * FROM people WHERE id=?').get('keine-zahl'), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM people WHERE age=?').all('abc'), []);
    assert.equal(db.prepare('UPDATE people SET age=1 WHERE id=?').run('abc').changes, 0);
    assert.equal(db.prepare('DELETE FROM people WHERE id=?').run('abc').changes, 0);
    assert.equal(db.prepare('SELECT * FROM people WHERE id=?').get(Number.MAX_SAFE_INTEGER), undefined);
  });

  test('Transaktionen: alles oder nichts, auch verschachtelt', () => {
    const add = db.prepare('INSERT INTO people(email) VALUES(?)');
    const count = email => db.prepare('SELECT COUNT(*) c FROM people WHERE email=?').get(email).c;
    const failing = db.transaction(() => {
      add.run('rollback@test');
      throw new Error('Absicht');
    });
    assert.throws(failing, /Absicht/);
    assert.equal(count('rollback@test'), 0);
    assert.equal(db.inTransaction, false);

    const outer = db.transaction(() => {
      add.run('aussen@test');
      assert.equal(db.inTransaction, true);
      assert.throws(db.transaction(() => {
        add.run('innen@test');
        throw new Error('Absicht');
      }), /Absicht/);
      return 'fertig';
    });
    assert.equal(outer(), 'fertig');
    assert.equal(count('aussen@test'), 1);
    assert.equal(count('innen@test'), 0);
  });

  test('Eine fehlgeschlagene Anweisung beendet die laufende Transaktion nicht', () => {
    const add = db.prepare('INSERT INTO people(email) VALUES(?)');
    db.transaction(() => {
      add.run('vorher@test');
      assert.throws(() => add.run('vorher@test'), error => error.code === 'SQLITE_CONSTRAINT_UNIQUE');
      add.run('nachher@test');
    })();
    assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE email IN ('vorher@test','nachher@test')").get().c, 2);
  });

  test('Feste Nummern bringen den Zähler nicht durcheinander', () => {
    const fixed = db.prepare('INSERT INTO people(id,email) VALUES(?,?)').run(5000, 'fest@test');
    assert.equal(fixed.lastInsertRowid, 5000);
    const next = db.prepare('INSERT INTO people(email) VALUES(?)').run('danach@test');
    assert.ok(next.lastInsertRowid > 5000);

    // Ohne Spaltenliste bemerkt die Schicht die feste Nummer erst beim Zusammenstoß.
    db.exec("INSERT INTO people(id,email) VALUES(6000,'direkt@test')");
    db.execRaw(`SELECT setval(pg_get_serial_sequence('people','id'), 5999)`);
    const repaired = db.prepare('INSERT INTO people(email) VALUES(?)').run('repariert@test');
    assert.ok(repaired.lastInsertRowid > 6000);

    db.execRaw(`SELECT setval(pg_get_serial_sequence('people','id'), 5999)`);
    const ignored = db.prepare('INSERT OR IGNORE INTO people(email) VALUES(?)').run('ignoriert@test');
    assert.equal(ignored.changes, 1, 'Der Zusammenstoß mit dem Zähler darf nicht verschluckt werden');
    assert.equal(db.prepare('INSERT OR IGNORE INTO people(email) VALUES(?)').run('ignoriert@test').changes, 0);
  });

  test('Binärwerte kommen als Buffer an', () => {
    const { lastInsertRowid } = db.prepare('INSERT INTO people(email,photo) VALUES(?,?)').run('bild@test', Buffer.from([0, 255, 7]));
    const { photo } = db.prepare('SELECT photo FROM people WHERE id=?').get(lastInsertRowid);
    assert.ok(Buffer.isBuffer(photo));
    assert.deepEqual([...photo], [0, 255, 7]);
  });

  test('Tabellenauskünfte funktionieren wie bei SQLite', () => {
    const columns = db.prepare('PRAGMA table_info(notes)').all();
    assert.deepEqual(columns.map(column => column.name), ['id', 'person_id', 'body']);
    assert.equal(columns.find(column => column.name === 'id').pk, 1);
    assert.equal(columns.find(column => column.name === 'body').notnull, 1);
    assert.deepEqual(db.pragma('table_info(notes)').map(column => column.name), ['id', 'person_id', 'body']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(notes)').all(), [{ table: 'people', from: 'person_id', to: 'id' }]);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all('people'), [{ name: 'people' }]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('gibtsnicht'), undefined);
  });

  test('Mandanten sehen nur ihr eigenes Schema, auch im schnellen Wechsel', () => {
    const other = openTestDatabase();
    try {
      other.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT)');
      other.prepare('INSERT INTO people(email) VALUES(?)').run('nur-b@test');
      const onlyHere = other.prepare('CREATE TABLE only_b (id INTEGER PRIMARY KEY)');
      onlyHere.run();
      for (let round = 0; round < 20; round += 1) {
        assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE email='nur-b@test'").get().c, 0);
        assert.equal(other.prepare("SELECT COUNT(*) c FROM people WHERE email='a@test'").get().c, 0);
      }
      assert.throws(() => db.prepare('SELECT * FROM only_b').all(), /only_b/);
      // Auch eine Abfrage an den anderen Mandanten mitten in einer Transaktion ändert das Ziel nicht.
      db.transaction(() => {
        db.prepare('INSERT INTO people(email) VALUES(?)').run('in-transaktion@test');
        assert.equal(other.prepare("SELECT COUNT(*) c FROM people WHERE email='in-transaktion@test'").get().c, 0);
        db.prepare('INSERT INTO people(email) VALUES(?)').run('in-transaktion-2@test');
      })();
      assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE email LIKE 'in-transaktion%'").get().c, 2);
      assert.equal(other.prepare("SELECT COUNT(*) c FROM people WHERE email LIKE 'in-transaktion%'").get().c, 0);
    } finally {
      other.close();
    }
  });

  test('Schemanamen werden streng geprüft', () => {
    for (const schema of ['a"; DROP SCHEMA public; --', 'public"', 'Gross', '1abc', '', 'a b', 'a-b']) {
      assert.throws(() => new PostgresDatabase({ connectionString, schema }), /Ungültiger Schemaname/, schema);
    }
  });

  test('Nach einem Verbindungsabbruch geht es mit einer neuen Verbindung weiter', () => {
    assert.throws(() => db.prepare('SELECT pg_terminate_backend(pg_backend_pid())').get());
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notes').get().c, 0);
    assert.ok(db.prepare("SELECT COUNT(*) c FROM people WHERE email='a@test'").get().c >= 1);
  });

  test('Bricht die Verbindung mitten in einer Transaktion ab, scheitert der Rest und nichts bleibt zurück', () => {
    const add = db.prepare('INSERT INTO people(email) VALUES(?)');
    assert.throws(db.transaction(() => {
      add.run('abbruch-1@test');
      assert.throws(() => db.prepare('SELECT pg_terminate_backend(pg_backend_pid())').get());
      // Auch wer den Fehler abfängt und weitermacht, schreibt nicht ohne Transaktion weiter.
      assert.throws(() => add.run('abbruch-2@test'), /während der Transaktion/);
      throw new Error('Absicht');
    }), /Absicht/);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE email LIKE 'abbruch-%'").get().c, 0);
    assert.equal(db.inTransaction, false);

    // Ein stilles Weitermachen darf nicht als erfolgreich gelten.
    assert.throws(db.transaction(() => {
      add.run('abbruch-3@test');
      assert.throws(() => db.prepare('SELECT pg_terminate_backend(pg_backend_pid())').get());
    }), /während der Transaktion/);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE email LIKE 'abbruch-%'").get().c, 0);
    assert.equal(add.run('danach-wieder-ok@test').changes, 1);
  });

  test('Eine geschlossene Verbindung nimmt keine Anfragen mehr an', () => {
    const temporary = openTestDatabase();
    const statement = temporary.prepare('SELECT 1 AS one');
    assert.equal(statement.get().one, 1);
    temporary.close();
    assert.throws(() => statement.get(), TypeError);
  });
});
