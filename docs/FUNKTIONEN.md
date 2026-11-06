# Funktionen im Einzelnen

Diese Seite beschreibt, wie die Bereiche von Daybreak zusammenspielen, wer was darf, wie die Daten aufgebaut sind und
welche Schnittstellen es gibt. Für den Einstieg lies zuerst das [README](../README.md).

## Mehrere Organisationen und Module

Jede Anfrage wird einem Mandanten zugeordnet: zuerst über die aufgerufene Adresse, sonst über die Firmenkennung beim Login und danach über die Sitzung. Für jeden Mandanten entsteht eine eigene Laufzeit mit eigener Datenbankdatei (`lib/tenant-runtime.js`). Fachmodule kennen nur diese eine Datenbank und können deshalb keine fremden Organisationendaten sehen. Eine Sitzung gilt nur im Mandanten, in dem sie entstanden ist.

Der Modulkatalog in `lib/module-catalog.js` legt Module, Abhängigkeiten und zugehörige API-Pfade fest. Der Betreiber gibt Module je Organisation frei, die HR-Administration der Organisation schaltet Freigegebenes an oder aus. Abgeschaltete Module antworten serverseitig mit `403` und dem Code `module_disabled`, ihre Daten bleiben erhalten. Die Betreiber-Schnittstelle liegt unter `/api/platform`, die Einstellungen der Organisation unter `/api/organization`.

Der Betreiber kann Organisationen verwalten, sieht aber ohne Freigabe der Organisation keine Personaldaten. Jeder Support-Zugriff wird protokolliert.

### Fachmodule

| Schlüssel | Modul | Oberfläche |
| --- | --- | --- |
| `core` | Personen & Organisation (immer an) | Mitarbeitende, Organisation |
| `personnel` | Personalakte | Meine Daten, Personal → Personalakte |
| `goals`, `checkins` | Ziele, Check-ins | Meine Arbeit |
| `talent` | Talentprofil & Kompetenzen | Meine Arbeit, Mitarbeitende |
| `talent_review` | Talent Review & 9-Box | Talent Review |
| `feedback` | 360° Feedback | 360° Feedback |
| `succession` | Nachfolgeplanung | Entwicklung |
| `learning` | Lernen & Pflichtschulungen | Entwicklung |
| `surveys` | Mitarbeiterbefragungen | Entwicklung |
| `recruiting` | Recruiting, interne Stellenbörse | Personal |
| `onboarding` | Ein- und Austritte | Personal |
| `compensation` | Vergütung | Personal, Meine Vergütung |
| `absence`, `time` | Abwesenheit, Zeiterfassung | Zeit & Abwesenheit |
| `reports` | Auswertungen | Auswertungen |
| `assistant` | Dayo | überall |

Neue Module entstehen nach der festen Konvention in [docs/MODUL-VERTRAG.md](MODUL-VERTRAG.md): `routes/<key>.js`, `public/<key>.js`, `test/<key>.test.js`. Sie liegen unter `/api/<key>`, ihre Tabellen beginnen mit `<key>_`.

## Navigation

Die linke Hauptnavigation zeigt nur rollenrelevante Arbeitsbereiche. Persönliche Funktionen wie Ziele, Check-ins, Talentprofil, Selbsteinschätzung und Entwicklung liegen gesammelt im aufklappbaren Bereich **Meine Arbeit**. Die umfangreichen Fachmodule verwenden eine zweite, kontextbezogene Reiterleiste:

- **Mitarbeitende**: Personen, Organisation, Positionen und Kompetenzen (HR Admin und HRBP)
- **Talent Review**: Übersicht, Reviews, Kalibrierung, 9-Box, Talentpools und Maßnahmen; die Zyklusverwaltung ist zusätzlich HR vorbehalten
- **360° Feedback**: eine gemeinsame Übersicht für alle Rollen; Zyklen und Fragebögen erscheinen nur für HR Admin und HRBP

Führungskräfte erhalten zusätzlich **Mein Team**, Talent Review und Organisation. Bereichsleitungen sehen außerdem die Auswertungen ihres Organisationsbereichs. Normale Beschäftigte sehen keine administrativen Einstiegspunkte. Die Ausblendung dient der Übersichtlichkeit; sämtliche Zugriffe bleiben unabhängig davon serverseitig berechtigungsgeprüft.

## Dayo – Daybreak-Begleiter

Dayo ist ein frei verschiebbares, animiertes Haustier und zugleich der kontextsensitive Hilfeassistent der Anwendung. Ein Klick zeigt einen kurzen Hinweis, ein Doppelklick öffnet den Hilfedialog; auf Touch-Geräten genügt ein Antippen. Dayo lässt sich am Fensterrand andocken, per Tastatur mit den Pfeiltasten bewegen, in den Ruhemodus versetzen oder ausblenden. Position und Einstellungen werden pro Account ausschließlich im lokalen Browser-Speicher abgelegt.

Die integrierte Wissensbasis beantwortet Bedienungs- und Prozessfragen rollenabhängig, schlägt passende Themen vor und kann direkt zur erlaubten Daybreak-Ansicht navigieren. Dayo reagiert außerdem dezent auf erfolgreiche Vorgänge wie Zielaktualisierungen oder abgeschlossene Check-ins. Proaktive Hinweise sind pro Sitzung begrenzt; Animationen berücksichtigen `prefers-reduced-motion`.

Die Endpunkte `/api/assistant/status` und `/api/assistant/chat` sind authentifiziert. Normale Fragen werden nicht in der Datenbank gespeichert. Erst wenn eine Person ausdrücklich Daumen hoch oder Daumen runter absendet, werden die betreffende Frage, Dayos Antwort und bei negativer Bewertung die erwartete Antwort für die Verbesserung gespeichert. Dayo erklärt Prozesse, bewertet aber keine Menschen und trifft keine Entscheidungen über Vergütung, Beförderung, Rankings oder Kündigungen.

### Antwortfeedback

Unter jeder regulären Dayo-Antwort erscheinen Daumen hoch und Daumen runter. Positives Feedback wird mit einem Klick bestätigt. Bei negativem Feedback öffnet sich inline ein Pflichtfeld für die erwartete beziehungsweise bessere Antwort. Erst das Absenden dieses Formulars erzeugt einen Datensatz in `assistant_feedback`; abgebrochene Bewertungen speichern nichts.

HR Admin und HRBP öffnen die Verbesserungsvorschläge unter **Administration → Dayo**. Der Arbeitsbereich zeigt Frage, tatsächliche Antwort, erwartete Antwort und technische Herkunft, bietet Status- und Prioritätsfilter und erlaubt eine interne Bearbeitungsnotiz. Vorschläge durchlaufen `open`, `in_progress`, `resolved` oder `dismissed` und besitzen die Prioritäten `low`, `normal`, `high` oder `critical`; positive Bewertungen werden getrennt als `acknowledged` abgelegt. Dieselben serverseitigen Rechte gelten für `GET /api/assistant/feedback` und `PATCH /api/assistant/feedback/:id`. Das Audit-Log enthält bei der Einreichung nur Bewertung, Provider, Werkzeug, Ansicht und Status – niemals Frage, Antwort oder Verbesserungstext. Nutzereingaben verändern weder automatisch Quellcode noch Router-Prompts. Sie bilden einen geprüften Verbesserungspool, der anschließend gezielt umgesetzt werden kann.

### Kontrollierte Datenfragen

Dayo kann außerdem berechtigte, sachliche Live-Abfragen über die eigene direkte Führungskraft, Teamgröße, Namen im zulässigen Teamkreis, genehmigte Zielerreichung, fehlende Check-ins und offene Teamaufgaben beantworten. Die Antwort wird nicht vom Sprachmodell geschätzt: Der Server erzeugt ausschließlich vorbereitete, lesende SQLite-Abfragen und prüft davor Rolle sowie Organisationsbereich. Die eigene Führungskraft ist für jede Rolle abrufbar; Führungskräfte sehen darüber hinaus nur ihren Hierarchiebaum, HR Admin und HRBP in dieser Demo die gesamte Organisation. Beschäftigte erhalten keine fremden Teamdaten.

Offensichtliche Datenfragen werden als schneller Pfad ohne Modellaufruf beantwortet. Alle übrigen Formulierungen gehen an einen einheitlichen semantischen Router: Das lokale Modell liefert in genau einem Aufruf entweder eine normale Antwort oder wählt einen Plan aus der Positivliste. Freies SQL, Tabellen-/Spaltennamen, Filterausdrücke und Schreiboperationen werden weder vom Modell noch vom Client akzeptiert. Dayo sendet keine personenbezogenen Ergebnisdaten an Ollama. Jeder ausgeführte Datenplan wird ohne Frageinhalt und ohne Ergebniswerte als `dayo_data_query_executed` im Audit-Log vermerkt. Im Dialog kennzeichnet „Geprüfte Daybreak-Daten · nur lesend“ solche Antworten.

### Lokale KI über Ollama anbinden

Ohne weitere Konfiguration verwendet Dayo die kontrollierte lokale Wissensbasis. Eine Ollama-Instanz kann später ohne Änderung am Dialog aktiviert werden:

```bash
DAYBREAK_ASSISTANT_PROVIDER=ollama \
OLLAMA_BASE_URL=http://127.0.0.1:11434 \
OLLAMA_MODEL=qwen3:4b \
DAYBREAK_ASSISTANT_THINKING=false \
DAYBREAK_ASSISTANT_KEEP_ALIVE=-1 \
OLLAMA_TIMEOUT_MS=60000 \
npm start
```

An das lokale Modell werden nur die gestellte Frage, die aktuelle Daybreak-Ansicht, die Rolle, erlaubte Werkzeugbeschreibungen und ausgewählte Hilfeartikel übertragen – keine individuellen Beschäftigten-, Bewertungs- oder Talentdaten. Der semantische Router arbeitet immer ohne Thinking und fordert eine strukturierte JSON-Entscheidung an; dadurch entfallen getrennte Planungs- und Antwortaufrufe. Harmlose appferne Fragen beantwortet Dayo kurz und respektvoll. Bei medizinischen, rechtlichen, psychologischen oder sonst ernsten Themen verweist Dayo auf qualifizierte Hilfe. `DAYBREAK_ASSISTANT_KEEP_ALIVE=-1` hält das Modell im Speicher. Ist Ollama nicht erreichbar oder liefert keine gültige Router-Antwort, fällt der Assistent automatisch auf die Wissensbasis zurück. Weitere lokale Provider können später hinter derselben Server-Schnittstelle ergänzt werden.

## Talentmanagement – Phase 1

Das Modul erweitert die bestehenden Benutzer-, Hierarchie-, Ziel-, Aufgaben- und Audit-Funktionen. Es erzeugt keine parallele Mitarbeiter- oder Zielverwaltung.

- Eigenes und zulässiges Talentprofil mit Karriereinteressen, Erfahrungen, Qualifikationen/Zertifikaten und Sprachen
- Zentraler, aktivierbarer Kompetenzkatalog mit Kategorien
- Getrennte Selbst- und Führungskräfteeinschätzungen auf einer Skala von 1 bis 5, inklusive Änderungshistorie
- Positionsprofile, zugehörige Kompetenzanforderungen und Positionszuordnung
- Nachvollziehbare Auswertung der Kompetenzlücken: Einschätzung der Führungskraft vor der eigenen, sonst „nicht bewertet“
- Entwicklungsziele als `goal_type = development` im bestehenden Ziel- und Freigabeablauf, optional mit Kompetenzverknüpfung
- Talentkarte auf dem persönlichen Übersicht, Talentstatus für direkte Teams sowie HR-Talentübersicht mit serverseitigen Filtern

Die Anwendung bezeichnet den Wert bewusst als „Abdeckung der Positionsanforderungen“. Er ist keine Eignungs- oder Leistungsentscheidung.

## Talentmanagement – Phase 2: Talent Review

Das Talent-Review-Modul ergänzt Phase 1 um einen dauerhaften, rollenbasierten Ablauf. Performance und Potenzial bleiben dabei bewusst getrennte Führungsentscheidungen: Bestehende Ziele, Check-ins, Kompetenzen und Kompetenzlückens werden als nachvollziehbare Unterstützung angezeigt, erzeugen aber keine automatische Einstufung.

- HR Admin und HRBP planen Review-Perioden als **Entwurf → Offen → Kalibrierung → Abgeschlossen → Archiviert**.
- Beim Öffnen einer Periode entstehen pro zugeordneter Person genau ein Review-Datensatz sowie getrennte Aufgaben für die Selbsteinschätzung und die direkte Führungskraft.
- Beschäftigte erstellen eine eigene Selbsteinschätzung zu Performance, Entwicklungsperspektive, Wirkung und Entwicklungsfokus. Entwürfe bleiben privat; erst die verbindliche Abgabe macht den Inhalt für die direkte Führungskraft sichtbar. Die Selbsteinschätzung ist zusätzlicher Gesprächsinput und erzeugt keine automatische 9-Box-Einstufung.
- Die direkte Führungskraft speichert zunächst einen Entwurf mit Performance (1–3), Potenzial (1–3), acht getrennten Potenzialkriterien (1–5), Beobachtungen, Begründungen und Entwicklungsfeldern und reicht ihn anschließend ein.
- HR kann eingereichte Vorschläge mit Begründung zur Überarbeitung zurückgeben. Ursprungswerte werden nie durch kalibrierte Werte überschrieben.
- Kalibrierungen sind ausschließlich in einer aktiven Sitzung, während der Kalibrierungsphase und für explizit hinzugefügte Teilnehmende möglich. Versionsnummern schützen vor unbeabsichtigtem Überschreiben.
- Die 9-Box wird ausschließlich auf dem Server aus Performance und Potenzial berechnet. Sie bietet Filter für Periode, Sitzung, Organisationsbereich, Führungskraft, Position, Status, Talentpool und Feld.
- Talentpools bewahren Vorschläge, Aufnahme, Statuswechsel, Begründung und Entfernung historisch auf. Führungskräfte schlagen nur direkte Teammitglieder vor; HR entscheidet über die Aufnahme.
- Entwicklungsmaßnahmen können optional ein vorhandenes Entwicklungsziel vom Typ `development` erzeugen und mit einer Kompetenz verknüpfen. Der bestehende Ziel- und Freigabeablauf bleibt dabei erhalten.
- Beschäftigte sehen ausschließlich explizit freigegebene, finalisierte Ergebnisse sowie ihre Entwicklungsmaßnahmen. Ihre eigene Selbsteinschätzung können sie während einer offenen Periode pflegen und abgeben; Führungsentwürfe und Kalibrierungsdiskussionen bleiben nicht sichtbar.

### Datenmodell des Talent Reviews

| Tabelle | Zweck und wichtige Beziehungen |
| --- | --- |
| `talent_review_periods` | Zyklus mit Zeitraum, Stichtag, Status und Ergebnisfreigabe; wird von `users.created_by` und `users.updated_by` referenziert. |
| `talent_reviews` | Eindeutiger Review je Periode und Beschäftigtem (`UNIQUE(period_id, employee_id)`); enthält die private bzw. abgegebene Selbsteinschätzung, ursprüngliche und kalibrierte Werte, Status und Versionsnummer. |
| `talent_review_potential_criteria` | Zentraler Katalog der acht Potenzialkriterien. |
| `talent_review_potential_ratings` | Bewertung eines Kriteriums je Review (`UNIQUE(review_id, criterion_id)`). |
| `talent_review_sessions`, `talent_review_session_participants`, `talent_review_session_cases` | Kalibrierungssitzungen, explizite Teilnahmen und zugeordnete Fälle. |
| `talent_review_history` | Fachliche Historie mit altem/neuem Wert, Akteur, Zeitpunkt und Begründung; zusätzlich wird `audit_log` geschrieben. |
| `talent_pools`, `talent_pool_memberships` | Pools und historisierte Mitgliedschaften; ein partieller Unique-Index verhindert doppelte aktive/vorgeschlagene Mitgliedschaften. |
| `development_decisions` | Verantwortete Maßnahme je Review; kann auf `goals` und `competencies` verweisen. |

SQLite-Fremdschlüssel sind aktiviert. Die Tabellen werden per `CREATE TABLE IF NOT EXISTS` und ergänzende Indizes sicher zur lokalen Datenbank hinzugefügt; bestehende Daten werden weder gelöscht noch migriert.

### API-Bereiche des Talent Reviews

- Perioden: `/talent-review/periods`, `/talent-review/periods/:id/status`, `/talent-review/periods/:id/release`
- Reviews: `/talent-review/reviews`, `/talent-review/reviews/:id`, `/talent-review/reviews/:id/self`, `/talent-review/reviews/:id/self/submit`, `/talent-review/self-reviews`, `/manager`, `/submit`, `/return`, `/calibrate`, `/finalize`
- Kalibrierung: `/talent-review/sessions`, `/sessions/:id/participants`, `/sessions/:id/cases`, `/sessions/:id/case-candidates`, `/sessions/:id/cases/bulk`, `/talent-review/periods/:id/finalize-all`
- Auswertung: `/talent-review/matrix`, `/talent-review/dashboard/hr`, `/talent-review/dashboard/manager`, `/talent-review/me`
- Entwicklung: `/talent-pools`, `/talent-pools/:id/members`, `/development-decisions`

Alle Endpunkte liegen unter `/api`, benötigen eine Session und prüfen Rollen sowie Objektzugriff serverseitig. Direkte Führungskräfte können nur ihre eigenen Entwürfe bearbeiten. Bereichsleitungen lesen ausschließlich ihren Hierarchiebaum und benötigen für Kalibrierungen zusätzlich eine explizite Sitzungsteilnahme. HRBP ist in dieser lokalen Demo global berechtigt.

### Demo-Daten

Die Datenbank erhält idempotent eine offene Periode für 2026, eine abgeschlossene historische Periode mit allen neun 9-Box-Kombinationen, Entwurfs- und Einreichungsfälle, drei Kalibrierungssitzungen, zwei Talentpools, Mitgliedschaften und eine Entwicklungsmaßnahme. Falls die vorhandene Demo-Hierarchie dafür zu klein ist, ergänzt die Anwendung fiktive Beschäftigte mit dem bekannten Demo-Passwort `demo1234`. Bereits vorhandene Daten werden nicht überschrieben.

## Berechtigungen

| Rolle | Darf |
| --- | --- |
| Mitarbeiter:in | Eigene Daten, Ziele, Check-ins, Urlaub, Zeiten, Talentprofil, Lernen, Befragungen und 360° Feedback |
| Führungskraft | Dazu das eigene Team lesen. Direkt unterstellte Personen bewerten, Ziele und Check-ins anlegen, Urlaub und Wochen freigeben |
| Bereichsleitung | Wie Führungskraft, dazu Auswertungen und Nachfolge für den eigenen Bereich. Indirekt unterstellte Personen nur lesen, ohne deren Kompetenzbewertungen |
| HR-Sachbearbeitung | Tagesgeschäft bei Personen ohne HR-Rolle: Konten für Mitarbeitende anlegen und importieren, Passwort und Sperren bei Mitarbeitenden, Personalakte, Führungskraft, Krankmeldungen, Urlaubskonten und Zeiten korrigieren, Abläufe. Dabei wählt sie nur Führungskräfte, die schon führen. **Keine** Gehälter, Bewertungen, Nachfolge, Bewerbungen, Freigaben oder Rollenvergabe |
| HR Business Partner | Alles von HR außer: Daten der HR-Administration, HR-Konten anlegen oder ändern, Organisationseinstellungen, Datenauskunft, Gehälter ändern. Vergibt Führungsrollen. Die Führungskraft von HR-Konten ändert nur die HR-Administration |
| HR-Administration | Alles in der eigenen Organisation, auch Module, Genehmigungsregeln und Protokoll |
| Systemadministration | Organisationen verwalten. In anderen Organisationen nur, wenn diese den Support-Zugriff freigeben |

Für alle HR-Rollen gilt: Die eigenen Daten ändert eine andere HR-Person, außer die Organisation erlaubt es unter **Administration → Genehmigungen**. Die HR-Sachbearbeitung bleibt auch dann von der eigenen Akte ausgenommen.
Niemand setzt sein eigenes Passwort über HR zurück, und niemand vergibt sich selbst eine Rolle.

## Regeln, die man kennen sollte

- **Positionen gehören zu den Grundfunktionen.** Sie bleiben auch bei abgeschaltetem Talent-Modul erreichbar. Abgeschaltet sind dann nur die Kompetenzanforderungen an eine Position.

- **Austritt:** Das Austrittsdatum ist der letzte Arbeitstag. Am Tag danach wird das Konto gesperrt, und bis dahin lässt sich der Austritt zurücknehmen. Für fristlose Fälle gibt es „Zugang sofort sperren“. Beim Austritt einer Führungskraft legt HR fest, wer ihre Leute übernimmt.
- **Wiedereintritt:** Das Eintrittsdatum bleibt der erste Tag im Unternehmen. Der Wiedereintritt steht mit eigenem Datum in Akte und Verlauf.
- **Führungswechsel:** Offene Freigaben, Einschätzungen, Änderungswünsche zu Zielen und Aufgaben gehen an die neue Führungskraft. Rückmeldungen zu Check-ins bekommt sie ebenfalls. Die frühere Führungskraft liest ab dem Wechsel nichts mehr mit.
- **Führungsrolle:** Sie lässt sich erst entziehen, wenn die Person niemanden mehr führt. Wird jemand Führungskraft, fragt Daybreak nach und trägt die Rolle ein.
- **Sachbearbeitung und Führung:** Die HR-Sachbearbeitung trägt nur Personen als Führungskraft ein, die schon führen, und nie sich selbst oder Kolleg:innen ihrer Rolle. Sonst käme sie über die Zuordnung an Bewertungen. Einen Austritt bei Führungskräften erfasst sie mit Datum, sofort wirksam macht ihn ein HR Business Partner oder die HR-Administration. Das gilt auch für den Wiedereintritt.
- **Vier Augen bei Gehältern:** Verbietet die Regel eigene Vorschläge, ist auch das Ändern eines fremden Vorschlags nur ein neuer Vorschlag. Entscheiden muss eine andere HR-Administration. Die Führungskraft sieht im Ergebnis, dass HR den Wert geändert hat.
- **Gesamtbudget:** Führungskräfte sehen den Anteil des verplanten Gesamtbudgets nur auf 5 Prozentpunkte gerundet und erst ab fünf Vorschlägen außerhalb ihres Teams. Sonst ließen sich einzelne Werte ableiten.
- **Kompetenzbewertung:** Die Note der direkten Führungskraft sehen sie selbst, die Person und HR, nicht die Ebenen darüber. Dort zählt in der Abdeckung nur die eigene Einschätzung der Person.
- **Ziele und Check-ins entfernen:** Vor der Freigabe zieht die Person ihr eigenes Ziel selbst zurück. Alle anderen Ziele entfernt die Führungskraft oder HR. Check-ins löscht, wer sie erfasst hat, solange die Person noch nicht bestätigt hat.
- **Lohnexporte der Sachbearbeitung:** HR-Personen fehlen darin. Seite und letzte Zeile der Datei sagen, wie viele (`/absence/export/scope`, `/time/export/scope`). Beide Dateien haben die Personalnummer als zweite Spalte.
- **Absage durch HR:** Sagt HR eine genehmigte Abwesenheit einer anderen Person ab, ist ein Grund Pflicht, und die Person erfährt ihn. Ausgenommen sind vertrauliche Arten: Dort gibt es keinen Freitext.
- **Korrektur älterer Abwesenheiten:** Was man nicht mehr selbst stornieren kann, lässt sich bei HR zur Korrektur anfragen (`/absence/requests/:id/correction`). Die Aufgabe nennt weder Art noch Freitext.
- **Krankmeldung und Führungskraft:** Die Führungskraft erfährt, dass die Person fehlt. Die Art wird ihr nicht genannt, sie kann sie sich aber denken, weil nur diese Art ohne Genehmigung gilt.
- **Genehmigungsregeln:** Wechselt eine Regel, bleiben offene Vorgänge bei denen, die sie schon haben. Neue folgen der neuen Regel.
- **Unabhängige Bewertung im Recruiting:** Fremde Bewertungen sieht nur, wer selbst schon bewertet hat, auch bei HR und der einstellenden Führungskraft.
- **Eigene Betroffenheit:** Wer sich selbst auf eine Stelle bewirbt oder in einem Nachfolgeplan steht, sieht diese Vorgänge auch als HR nicht.
- **Selbsteinschätzung:** Entwürfe sind privat, auch gegenüber HR, bis die Person abgibt.
- **Zielerreichung:** Überall dieselbe Rechnung: nur freigegebene Ziele, gewichtet.
- **Protokoll:** Administration → Protokoll zeigt, wer wann was geändert hat, und nennt Person, Modul, Regel oder Wert. Gehälter, Begründungen und ähnliche Inhalte stehen nur in der CSV-Datei, die allein die HR-Administration herunterladen kann. Abgaben zu Befragungen werden nie protokolliert.
- **HR-Personen im Talent Review:** HR Business Partner und HR-Administration nehmen nicht selbst teil. Sie organisieren den Ablauf und würden sonst ihre eigene Einschätzung sehen.
- **HR greift ein:** Legt HR für eine Person ein Ziel oder einen Check-in an oder ändert ein Ziel, bekommt die direkte Führungskraft einen Hinweis.
- **Öffentliche Demo:** Die sechs Zugänge auf der Anmeldeseite sind geschützt. Alles andere dürfen Besucher ändern. `DAYBREAK_DEMO_RESET_HOUR` legt die Beispieldaten täglich neu an.
- **Spitze Klammern:** Die Zeichen `<` und `>` entfernt Daybreak aus Texten, die gespeichert werden. In der Importvorschau steht es dabei.
- **Offene Vorgänge:** Die Seite zeigt auch, was bei gesperrten Konten liegt. Diese Vorgänge stehen ganz oben.

Alle Talentendpunkte benötigen eine Session. Objektberechtigungen werden serverseitig geprüft; ausgeblendete Schaltflächen sind keine Berechtigungsgrenze.

## Datenmodell

Die bestehenden Tabellen `users`, `goals` und `audit_log` werden erweitert um:

- `users.position_profile_id` → `position_profiles.id`
- `goals.goal_type` mit `business`, `performance` oder `development`
- Audit-Werte `audit_log.old_values` und `audit_log.new_values`

Neue Talenttabellen:

- `career_interests`, `career_interest_notes`
- `professional_experiences`
- `qualification_records`
- `language_skills`
- `competencies`
- `competency_assessments`, `competency_assessment_history`
- `position_profiles`, `position_requirements`, `position_assignment_history` (alte/neue Position, Datum, ab dem sie gilt, Erfassung und bearbeitender Account)
- `goal_competencies`

Die Tabellen verwenden Fremdschlüssel, eindeutige Namen bzw. Verknüpfungen und Indizes für die häufigen Talentprofil- und Abfragen zu Kompetenzlücken. Erfahrungen, Qualifikationen, Sprachen, Kompetenzen, Positionen und Anforderungen werden bei einer fachlichen Entfernung deaktiviert statt physisch gelöscht.

## Wichtige API-Bereiche

Alle Routen liegen unter `/api`:

- `/talent/profile`, `/talent/profile/:userId`, `/talent/dashboard`, `/talent/manager-dashboard`
- `/talent/career-interests`, `/talent/experiences`, `/talent/qualifications`, `/talent/languages`
- `/competencies`, `/talent/competencies/self-assessment`, `/talent/competencies/manager-assessment`
- `/positions`, `/positions/:id/requirements`, `/positions/assign/:userId`
- `/talent/skill-gap/:userId`, `/talent/development-goals`, `/talent/overview`

Ziele und Check-ins: `/goals`, `/goals/:id` (auch `DELETE`), `/goals/:id/review`, `/goals/:id/employee-response`, `/checkins`, `/checkins/:id` (auch `DELETE`), `/checkins/:id/feedback`.

## Talentmanagement – 360° Feedback

Das 360°-Feedback-Modul ist ein entwicklungsorientierter, eigenständiger Ablauf innerhalb von Daybreak. Es erzeugt weder Performance-, Potenzial- oder Vergütungsentscheidungen noch Ranglisten.

- HR Admin und HRBP verwalten versionierte Fragebögen, Zyklen und Statuswechsel: **Entwurf → Nominierung → Feedback geöffnet → Auswertung → Abgeschlossen → Archiviert**.
- Teilnahmen enthalten automatisch eine Selbsteinschätzung und – falls vorhanden – die direkte Führungskraft. Beschäftigte, Führungskraft und HR können weitere Feedback-Geber vorschlagen; die Gruppe wird serverseitig aus der Hierarchie bestimmt.
- Eingeladene Personen bearbeiten ausschließlich ihre eigene Einladung, speichern Entwürfe und senden ihre Antworten verbindlich ab. Ratingfragen verwenden 1–5 oder „nicht beurteilbar“; Freitext wird serverseitig bereinigt und in der UI escaped.
- Selbst- und Führungskräftefeedback bleiben getrennt sichtbar. Peer-, direkt Unterstellte- und Stakeholderfeedback wird erst ab drei eingereichten Rückmeldungen ausgegeben. Kleinere anonyme Gruppen werden nur zusammengefasst gezeigt, wenn auch die Kombination den Mindestwert erreicht.
- Ergebnisberichte durchlaufen **ausstehend → berechnet → geprüft → für Führungskraft freigegeben → für Mitarbeitende freigegeben → geschlossen**. Rohantworten werden nicht als Ergebnis-API ausgeliefert.
- Entwicklungsmaßnahmen können ein vorhandenes Entwicklungsziel vom Typ `development` erzeugen und optional mit einer Kompetenz sowie der bestehenden Zielgenehmigung verknüpfen.
- Aufgaben entstehen für Nominierung, Nominierungsprüfung, Feedbackabgabe, Ergebnisprüfung, Ergebnisgespräch und Entwicklungsmaßnahmen. Zustände „offen“, „bald fällig“, „überfällig“ und „abgeschlossen“ werden im System dargestellt.

### 360°-Datenmodell und API

Neue SQLite-Tabellen sind `feedback_questionnaires`, `feedback_questionnaire_sections`, `feedback_questions`, `feedback_cycles`, `feedback_cycle_participants`, `feedback_nominations`, `feedback_invitations`, `feedback_responses`, `feedback_result_statuses`, `feedback_development_actions` und `feedback_history`. Sie verwenden Fremdschlüssel, eindeutige Constraints für Teilnahmen, Nominierungen, Einladungen und Antworten sowie Indizes für Zyklus-, Einladungs- und Ergebnisabfragen.

Alle Endpunkte liegen unter `/api/feedback`, zum Beispiel:

- `/feedback/cycles`, `/feedback/cycles/:id/status`, `/feedback/cycles/:id/deadlines`, `/feedback/cycles/:id/participants`, `/feedback/cycles/:id/progress`
- `/feedback/questionnaires`, `/feedback/questionnaires/:id/version`, `/feedback/questionnaires/:id/sections`
- `/feedback/participants/:id/nominations`, `/feedback/nominations/:id`
- `/feedback/invitations`, `/feedback/invitations/:id/responses`, `/feedback/invitations/:id/submit`
- `/feedback/results/:participantId`, `/feedback/results/:participantId/calculate`, `/feedback/results/:participantId/status`
- `/feedback/participants/:id/development-actions`, `/feedback/dashboard`, `/feedback/history/:participantId`

Die Seed-Daten ergänzen idempotent einen offenen 2026er-Demozyklus und einen abgeschlossenen historischen 2025er-Zyklus. Bereits bestehende Nutzer-, Talent-, Ziel-, Check-in- und Review-Daten bleiben unverändert.
