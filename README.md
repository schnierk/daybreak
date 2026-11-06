# Daybreak

Freie HR-Software mit einzeln schaltbaren Modulen und mehreren getrennten Organisationen.

Daybreak ist eine **Machbarkeitsstudie und Demo**. Das Projekt zeigt, wie weit man mit einem schlanken
Aufbau kommt, und richtet sich an alle, die überlegen, so ein System selbst zu bauen oder dieses hier
zu übernehmen. Es ist **noch nicht für echte Personaldaten bereit**. Was dafür fehlt, steht in der
[Go-Live-Merkliste](docs/GO-LIVE-MERKLISTE.md).

Daybreak ist kostenlos und bleibt offen: Es steht unter der [AGPL-3.0](LICENSE). Mehr dazu unten.

## In English

Daybreak is free HR software with switchable modules and multiple separated organizations. It is a
**feasibility study and demo**, not yet ready for real personnel data; see the
[go-live checklist](docs/GO-LIVE-MERKLISTE.md) (German). The user interface and most documentation are
in German so far, and an English interface is on the [roadmap](docs/ROADMAP.md). Licensed under
[AGPL-3.0](LICENSE): anyone may use, change and share it, and anyone offering a changed version over a
network must share its source code. Quick start:

```bash
npm ci && DAYBREAK_PRIMARY_DEMO=true npm start
```

Then open http://localhost:3000 and pick one of the demo logins. Contributions in English are welcome.

## Was Daybreak kann

| Bereich | Module |
| --- | --- |
| Personal | Personen und Organisation, Personalakte, Ein- und Austritte, CSV-Import |
| Gewinnung | Recruiting mit Vier-Augen-Prinzip, interne Stellenbörse |
| Zeit | Abwesenheit mit Urlaubskonten und Feiertagen, Zeiterfassung mit Wochenfreigabe |
| Leistung und Talent | Ziele, Check-ins, Talentprofil, Kompetenzen, Talent Review mit 9-Box, 360°-Feedback, Nachfolgeplanung |
| Entwicklung | Lernen und Pflichtschulungen, anonyme Mitarbeiterbefragungen |
| Vergütung | Gehaltsbänder, Historie, Gehaltsrunden mit Budget und Freigabe |
| Auswertung und Hilfe | Kennzahlen, der Assistent Dayo mit optionaler lokaler KI |
| Plattform | Mehrere Organisationen mit getrennten Daten, Module an- und abschaltbar, Genehmigungsregeln je Organisation |

Einzelheiten stehen in [docs/FUNKTIONEN.md](docs/FUNKTIONEN.md). Die meisten Module sind Grundversionen:
Der Kernablauf ist vollständig und getestet, Sonderfälle großer Organisationen fehlen. Was noch fehlt,
steht in der [Roadmap](docs/ROADMAP.md).

## Ausprobieren

Du brauchst [Node.js](https://nodejs.org) ab Version 20.

```bash
git clone https://github.com/schnierk/daybreak.git
cd daybreak
npm ci
DAYBREAK_PRIMARY_DEMO=true npm start
```

Öffne danach http://localhost:3000. Auf der Anmeldeseite stehen Knöpfe für die Demo-Zugänge. Das Passwort
ist immer `demo1234`.

| Zugang | Rolle |
| --- | --- |
| `lena@loop.local` | Mitarbeiterin |
| `felix@loop.local` | Abteilungsleiter (Führungskraft) |
| `maria@loop.local` | Bereichsleiterin |
| `hanna@loop.local` | HR-Sachbearbeitung |
| `david@loop.local` | HR Business Partner |
| `elena@loop.local` | HR-Administration |

Die Rollen unterscheiden sich vor allem darin, was sie sehen dürfen. Die Übersicht steht in [docs/FUNKTIONEN.md](docs/FUNKTIONEN.md).

Alle Daten im Demo-Modus sind erfunden. **Weil das Passwort öffentlich ist, darf der Demo-Modus nie mit
echten Personaldaten laufen.** Ohne `DAYBREAK_PRIMARY_DEMO=true` startet eine neue Installation leer und ohne
bekannte Passwörter. Wie du dann die erste Administration anlegst, steht in
[docs/BETRIEB.md](docs/BETRIEB.md).

Alternativ startet Docker die Demo: `docker compose up`.

## Aufbau

Bewusst schlicht: Node.js, Express, Vanilla JavaScript ohne Build-Schritt. Jede Organisation hat ihre
eigene SQLite-Datei, wahlweise ein eigenes [PostgreSQL](docs/POSTGRESQL.md)-Schema. Module kennen nur ihre
eigene Datenbank und können deshalb keine Daten anderer Organisationen sehen.

```
server.js              Einstieg
lib/                   Plattform: Mandanten, Modulkatalog, Sitzungen, Datenbankzugang
routes/<modul>.js      Server eines Moduls
public/<modul>.js      Oberfläche eines Moduls
test/                  Automatische Tests
docs/                  Betrieb, Modulbau, Roadmap
```

| Dokument | Inhalt |
| --- | --- |
| [docs/BETRIEB.md](docs/BETRIEB.md) | Installieren, Organisationen anlegen, sichern, aktualisieren |
| [docs/POSTGRESQL.md](docs/POSTGRESQL.md) | PostgreSQL statt SQLite, samt Umzug und ehrlicher Grenzen |
| [docs/FUNKTIONEN.md](docs/FUNKTIONEN.md) | Funktionen, Rechte, Datenmodell und Schnittstellen |
| [docs/MODUL-VERTRAG.md](docs/MODUL-VERTRAG.md) | Wie man ein neues Modul baut |
| [docs/GO-LIVE-MERKLISTE.md](docs/GO-LIVE-MERKLISTE.md) | Was vor dem Einsatz mit echten Daten zu tun ist |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Was als Nächstes kommen könnte |

## Tests

```bash
npm test
```

Die Tests starten nur kurzlebige lokale Server mit eigenen temporären Datenbanken. Gegen PostgreSQL laufen
dieselben Tests mit `DAYBREAK_TEST_DATABASE_URL=postgres://... npm test`.

## Mitmachen

Verbesserungen sind willkommen, siehe [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken bitte nicht
öffentlich melden, siehe [SECURITY.md](SECURITY.md).

## Lizenz

Copyright (C) 2026 die Mitwirkenden an Daybreak.

Daybreak steht unter der [GNU Affero General Public License 3.0](LICENSE) (AGPL-3.0). Das heißt:

- Alle dürfen Daybreak kostenlos nutzen, verändern und weitergeben, auch in Unternehmen.
- Wer es weitergibt oder eine veränderte Fassung über das Netz anbietet, muss den Quellcode dieser Fassung
  unter derselben Lizenz zugänglich machen. So kann niemand das Projekt schließen.
- Es gibt keine Gewährleistung. Du betreibst Daybreak auf eigene Verantwortung. Die rechtlichen Pflichten beim
  Umgang mit Personaldaten liegen bei dem, der es einsetzt.

Die Oberfläche zeigt deshalb immer einen Link zum Quellcode. Wer eine veränderte Fassung betreibt, trägt seine
eigene Adresse in `DAYBREAK_SOURCE_URL` ein.

Das Logo und das Video auf der Anmeldeseite gehören zum Projekt und stehen unter derselben Lizenz. Die mitgelieferten
Schriften stehen unter der SIL Open Font License, siehe `public/fonts/`.
