# Modul-Vertrag: So baut man ein Fachmodul für Daybreak

Dieses Dokument ist für alle verbindlich, die an einem Fachmodul arbeiten.

## 1. Bevor du anfängst

- Keine neuen Abhängigkeiten ohne guten Grund.
- Starte einen Testserver nur mit eigener Datenbank und ohne fremde Einstellungen:
  `DAYBREAK_ENV_FILE=/nonexistent DAYBREAK_DB_PATH=/tmp/daybreak-test/test.db DAYBREAK_PRIMARY_DEMO=true PORT=3199 HOST=127.0.0.1 node server.js`
- Teste nie gegen eine Installation mit echten Daten.

## 2. Dateien eines Moduls (feste Konvention)

Für ein Modul mit dem Schlüssel `<key>` (im Katalog `lib/module-catalog.js` bereits eingetragen):

| Datei | Inhalt |
| --- | --- |
| `routes/<key>.js` | Server: exportiert `create<Key>Module` (`absence` → `createAbsenceModule`) |
| `public/<key>.js` | Oberfläche, wird nur geladen, wenn das Modul an ist |
| `public/<key>.css` | Optional, eigene Styles |
| `test/<key>.test.js` | Tests |

Sobald `routes/<key>.js` existiert, gilt das Modul als verfügbar, wird beim Start geladen und erscheint im Modulschalter. Sonst ist nichts einzutragen.

## 3. Server

```js
'use strict';
const express = require('express');

function createAbsenceModule(deps) {
  const { db, auth, current, isHr, canViewEmployee, canEditEmployee, subordinateIds, cleanText,
    boundedInt, validDate, log, createTask, createUserAccount, setUserActive, isModuleEnabled,
    skillGap, tenant } = deps;
  const router = express.Router();

  function initialize() { /* CREATE TABLE IF NOT EXISTS ...; Stammdaten für alle Organisationen */ }
  function seedDemo() { /* nur Beispieldaten, idempotent, nur im Demo-Mandanten */ }
  function maintenance() { /* optional, idempotent, läuft höchstens stündlich */ }

  router.use('/absence', auth);
  router.get('/absence/requests', (req, res) => { /* ... */ });

  return { router, initialize, seedDemo, maintenance, helpArticles: [] };
}

module.exports = { createAbsenceModule };
```

### Mandantentrennung

Jede Organisation hat ihre eigene Datenbank und ihre eigene Instanz deines Moduls. Deshalb:

- `db` ist schon die richtige Datenbank. Es gibt keine `tenant_id`-Spalte.
- **Kein veränderlicher Zustand auf Dateiebene** (kein `let`, keine `Map`/`Array` als Cache außerhalb der Fabrikfunktion). Nur unveränderliche Konstanten. Sonst würden sich Organisationen Daten teilen.

### Schnittstellen und Datenbank

- API-Pfade liegen ausschließlich unter `/api/<key>/...`. Nur so greift der Modulschalter. Der Router wird unter `/api` eingehängt, im Code steht also `/<key>/...`.
- Eigene Tabellen beginnen mit `<key>_`. Fremde Tabellen nur lesen (`users`, `position_profiles`, `competencies` usw.). Geschrieben wird dort nur über die Bausteine aus `deps`.
- Tabellen per `CREATE TABLE IF NOT EXISTS`, Fremdschlüssel auf `users(id)`. Bestehende Daten nie löschen oder umbauen.
- SQL nur mit `?`-Platzhaltern und so, wie SQLite es versteht. Für PostgreSQL wird es automatisch übersetzt (`lib/postgres/translate.js`). Nur Standard-SQL verwenden, also keine SQLite-Sonderfunktionen wie `strftime` oder `printf`. Sortierung und Filter über feste Positivlisten, nie mit Nutzereingaben im SQL-Text.

### Rechte

- Jede Route prüft Rolle **und** konkretes Objekt auf dem Server. Ausblenden in der Oberfläche ist kein Schutz.
- Rollen: `employee`, `manager`, `director`, `hr_staff` (HR-Sachbearbeitung), `hrbp`, `hr_admin`, `super_admin`.
- `isHr(actor)` umfasst `hr_admin`, `hrbp` und `super_admin`. **`hr_staff` gehört absichtlich nicht dazu:** Ohne ausdrückliche Freigabe ist die Sachbearbeitung eine normale Person. `isHrOperator(actor)` schließt sie mit ein.
- `hrCanAccess(actor, personOderId)`: Darf diese HR-Person die Daten der anderen Person sehen und ändern? `hr_admin` immer, `hrbp` nicht bei `hr_admin`, `hr_staff` nur bei Personen ohne HR-Rolle.
- `blocksSelfEdit(actor, personId)`: HR ändert eigene Daten nicht, außer die Organisation erlaubt es in den Genehmigungsregeln.
- `canViewEmployee(actor, id)`: Person selbst, HR, oder jemand aus der Führungslinie darüber. `canEditEmployee(actor, id)`: Person selbst, HR, oder die direkte Führungskraft. `subordinateIds(actor)`: alle unterstellten Personen.
- Eingaben immer prüfen: `cleanText`, `boundedInt`, `validDate`. Bei Fehlern `400` mit verständlicher deutscher Meldung, ohne Recht `403`, nicht gefunden `404`.
- Auch andere Mitarbeitende und Organisationen sind mögliche Angreifer: Fremde IDs in der URL dürfen nie fremde Daten liefern.

### Bausteine

- Protokoll jeder Änderung: `log(actor.id, 'absence_request_created', 'absence_requests', id, vorher, nachher)`. Keine Gesundheitsdaten, Gehälter oder Passwörter ins Protokoll schreiben, nur dass sich etwas geändert hat.
- Aufgaben: `createTask(userId, titel, '<key>_irgendwas', objektId, frist)`. Der Titel nennt Person und Vorgang. Gib eine Frist nur mit, wenn es eine gibt. Reine Hinweise bekommen einen Typ, der auf `_notice` endet; die Übersicht zeigt dann selbst „Erledigt“. Alle anderen Aufgaben brauchen einen Knopf (`taskAction`) und schließen sich, wenn der Vorgang erledigt oder hinfällig ist. Der Typ **muss** mit `<key>_` beginnen, sonst verschwindet die Aufgabe beim Abschalten nicht. Erledigen: `db.prepare("UPDATE tasks SET done=1 WHERE type=? AND entity_id=? AND done=0").run(...)`.
- Konto anlegen: `createUserAccount({ name, email, role, title, managerId, positionProfileId, actor })` liefert `{ id, temporaryPassword }`. Konto sperren: `setUserActive(userId, false, actor)`.
- Führungswechsel: `onManagerChanged(({ userId, previousManagerId, managerId, actorId }) => { ... })`. Läuft in derselben Transaktion wie der Wechsel. `actorId` ist, wer gewechselt hat, und kann bei geplanten Wechseln `null` sein. Melde dich an, damit offene Vorgänge und Aufgaben mitziehen.
- Zielerreichung: Nutze `goalProgress(goals)`, die einzige Rechnung dafür (nur freigegebene Ziele, gewichtet, ohne Ziele `null`).
- Andere Module nur nutzen, wenn `isModuleEnabled('<anderer key>')` wahr ist. Dein Modul muss ohne sie funktionieren, sofern es nicht in `dependsOn` steht.
- `actor.id` der Systemadministration ist ein technisches Konto. Behandle sie wie HR.

### Demo und Stammdaten

- `initialize()` läuft bei jeder Organisation. Hier hinein gehören neutrale Stammdaten (z. B. Abwesenheitsarten), keine Beispielpersonen.
- `seedDemo()` läuft nur im Demo-Mandanten und nur, wenn es ausschließlich Demo-Konten (`@loop.local`) gibt. Es muss mehrfach aufrufbar sein und legt nie Konten an. Nur erfundene Inhalte zu bereits vorhandenen Personen. Prüfe `SELECT id FROM users WHERE is_system_account=0 AND active=1`; fehlen Personen, tue nichts.
- Listen von Personen immer mit `is_system_account=0 AND active=1` filtern.

### Dayo-Hilfe

`helpArticles` wird nur angezeigt, wenn das Modul an ist. Form:
`{ id, title, roles: ['employee', ...], views: ['absenceHome'], keywords: ['urlaub', ...], answer, steps: [...], actions: [{ label, view }] }`

## 4. Oberfläche

```js
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  async function home() {
    const data = await api('/api/absence/requests');
    return `${ui.header('Abwesenheit', 'Urlaub und Abwesenheiten', '<button class="btn primary" data-absence-new>+ Antrag</button>')}...`;
  }

  window.loop.registerModule({
    key: 'absence',
    label: 'Abwesenheit',
    nav(me) { return [{ route: 'absenceHome', label: 'Abwesenheit', group: 'time', views: ['absenceHome', 'absenceTeam'] }]; },
    pages: { absenceHome: home },
    tabs(view, me) { return []; },              // Reiter: [{ route, label, active }]
    bind() { /* Ereignisse an data-Attribute hängen */ },
    taskAction(task) { return task.type === 'meinmodul_freigabe' ? '<button class="btn" data-view="meinModulTeam">Prüfen</button>' : ''; }
  });
})();
```

- Navigationsgruppen: `myWork` (Meine Arbeit), `hr` (Personal), `time` (Zeit & Abwesenheit), `growth` (Entwicklung), `admin` (Administration), `main` (eigener Eintrag). Persönliches gehört nach `myWork` oder in die Fachgruppe. Halte die Navigation kurz.
- Ansichtsnamen beginnen mit dem Modulnamen (`absenceHome`).
- **Jeder dynamische Wert** wird mit `esc(...)` ausgegeben, auch in Attributen. Der Server filtert nur `<` und `>`.
- Kein `onclick="..."` im HTML und keine fremden Skripte: Die Sicherheitsrichtlinie (CSP) verbietet das. Ereignisse in `bind()` über `document.querySelectorAll('[data-...]')`.
- Formate: `ui.date('2026-11-05')` wird zu `05.11.2026`, `ui.plural(3, 'Vorschlag', 'Vorschläge')` zu `3 Vorschläge`, `ui.number(4.5, 1)` zu `4,5`.
- Nummer in der Adresse: Detailseiten melden sich mit `window.loop.registerAddress({ meineSeite: { get: () => state.id, set: id => { state.id = id; } } })` an. Neuladen, Lesezeichen und Zurück bleiben dann auf dem Vorgang. Die Seite muss ihre Daten mit dieser Nummer selbst laden können.
- Seiten nur für bestimmte Rollen: `allowed(view, me)` in `registerModule`. Antwortet es `false`, führt die Oberfläche zur Übersicht. Die Daten schützt trotzdem immer der Server.
- Bausteine: `ui.modal({ title, subtitle, body, submitLabel, onSubmit: async data => {...} })` (Fehler erscheinen automatisch im Dialog), `ui.toast(text, 'error')`, `ui.header(...)`, `ui.stat(label, wert, zusatz)`, `ui.empty(text)`. Nach dem Speichern `window.loop.navigate(window.loop.view)`.
- Vorhandene Klassen: `card`, `cards`, `wide`, `top`, `btn`, `btn primary`, `tag`, `tag focus`, `row`, `grow`, `muted`, `table`, `tableWrap`, `two`, `sectionHead`, `talent-form`. Eigene Klassen in `public/<key>.css` mit dem Modulnamen als Präfix.
- Daten der Person: `window.loop.me` (`id`, `name`, `role`). Andere Module prüfen: `window.loop.isModuleEnabled('talent')`.
- Texte auf Deutsch, in einfacher Sprache und per Du, wie im Rest der Anwendung.

## 5. Tests

Pflicht. `lib/testing/module-harness.js` startet dein Modul auf einer leeren Testdatenbank mit einer Beispielorganisation:

```js
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createModuleHarness } = require('../lib/testing/module-harness');
const { createAbsenceModule } = require('../routes/absence');

let h;
before(async () => { h = await createModuleHarness(createAbsenceModule); });
after(() => h.close());

test('Mitarbeitende sehen fremde Anträge nicht', async () => {
  const response = await h.api('anna', 'GET', '/api/absence/requests?userId=6');
  assert.equal(response.status, 403);
});
```

Personen: `hr` (1), `bp` (2), `director` (3), `manager` (4, unter director), `anna` (5) und `ben` (6) unter manager, `clara` (7) unter director. Ohne Person (`null`) ist die Anfrage nicht angemeldet.

Prüfe mindestens: Anfragen ohne Anmeldung (401), jede Rollengrenze, fremde IDs, ungültige Eingaben, den Hauptablauf von Anfang bis Ende, Sonderfälle, und dass `isModuleEnabled` für andere Module beachtet wird. Ausführen:

`DAYBREAK_ENV_FILE=/nonexistent node --test test/<key>.test.js`

Am Ende muss zusätzlich der gesamte Testlauf grün sein: `DAYBREAK_ENV_FILE=/nonexistent node --test`. Melde ehrlich, falls etwas rot ist, auch wenn es nicht von dir stammt.

## 6. Fachliche Grundlagen

Daybreak soll einfacher sein: wenige Klicks, klare Sprache, sinnvolle Voreinstellungen. Lieber ein vollständiger, geprüfter Kernablauf als viele halbe Funktionen. Baue keine Scheinfunktionen und keine Knöpfe ohne Wirkung.

Keine Rechtsaussagen in der Oberfläche als Tatsache darstellen. Gesetzliche Hinweise sagen klar, was zu prüfen ist, zum Beispiel: „Bitte prüfe, ob das stimmt und bei euch erlaubt ist.“

## 7. Stil

Lesbarer, mehrzeiliger Code mit sprechenden Namen. Keine langen Einzeiler wie im älteren Bestandscode. Kommentare nur dort, wo das Warum nicht offensichtlich ist.
