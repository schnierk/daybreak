# Mitmachen

Schön, dass du helfen möchtest. Fehlermeldungen, Vorschläge, Texte und Code sind willkommen, auf Deutsch oder
Englisch. Contributions in English are just as welcome.

## Loslegen

```bash
npm ci
npm test
DAYBREAK_PRIMARY_DEMO=true npm start
```

Daybreak braucht Node.js ab Version 20. Es gibt keinen Build-Schritt: Der Code in `public/` läuft direkt im Browser.

## Regeln für Änderungen

- **Tests gehören dazu.** Neue Funktionen und behobene Fehler bekommen einen Test. `npm test` muss grün sein.
- **Beide Datenbanken.** Schreib SQL so, wie SQLite es versteht. Für PostgreSQL wird es übersetzt. Prüfe nach Möglichkeit
  auch dort: `DAYBREAK_TEST_DATABASE_URL=postgres://... npm test`.
- **Neue Fachmodule** folgen dem [Modul-Vertrag](docs/MODUL-VERTRAG.md).
- **Rechte prüft der Server.** Etwas in der Oberfläche auszublenden reicht nie.
- **Keine neuen Abhängigkeiten** ohne guten Grund. Das Projekt lebt davon, schlank zu bleiben.
- **Keine echten Personendaten,** auch nicht in Tests, Beispielen oder Screenshots.
- **Oberflächentexte** sind einfach und verständlich, auch für Menschen ohne Technikwissen.

## Lizenz deiner Beiträge

Daybreak steht unter der [AGPL-3.0](LICENSE). Mit einem Beitrag stimmst du zu, dass er unter derselben Lizenz steht.
Reiche nur Code ein, den du selbst geschrieben hast oder dessen Lizenz dazu passt.

## Sicherheitslücken

Bitte nicht öffentlich melden, siehe [SECURITY.md](SECURITY.md).
