# Go-Live-Merkliste

Daybreak ist heute eine Demo mit erfundenen Daten. Wer es mit **echten Personaldaten** einsetzen will,
muss vorher die folgenden Punkte klären. Ein Teil davon ist Technik, ein Teil Entscheidung, ein Teil Recht.
Die Pflichten liegen bei dem, der Daybreak betreibt. Diese Liste ist keine Rechtsberatung.

## Sofort entscheiden

Diese Einstellungen stehen für die Demo bewusst locker. Prüfe jede, bevor echte Daten hineinkommen.

- [ ] **Demo-Modus aus.** Unter *Mandanten → Hauptmandant → Demo-Passwörter sperren*. Alle bekannten Passwörter
  werden unbrauchbar, die Demo-Knöpfe verschwinden. Eine neue Installation ohne `DAYBREAK_PRIMARY_DEMO=true`
  startet ohnehin ohne.
- [ ] **HR genehmigt eigene Gehaltsvorschläge?** Voreingestellt darf eine HR-Administration Gehaltsvorschläge
  genehmigen, die sie selbst gemacht hat, damit die Demo mit einer Person funktioniert. Im Echtbetrieb sollte das
  meist ein Vier-Augen-Vorgang sein. Einstellung: *Administration → Genehmigungen → Eigene Gehaltsvorschläge*.
- [ ] **Alle anderen Genehmigungsregeln** durchgehen: *Administration → Genehmigungen*. Dort legt jede Organisation
  fest, wer Ziele, Urlaub, Zeiten, Stellen und Angebote freigibt und ob HR die eigene Akte ändern darf.
- [ ] **Beispieldaten entfernen.** Nimm eine frische Installation, statt eine Demo-Datenbank umzuwidmen.
- [ ] **Rollen vergeben.** HR-Administration, HR Business Partner und HR-Sachbearbeitung sehen unterschiedlich viel. Gib jeder Person nur die
  Rolle, die sie braucht. HR Business Partner sehen alle Gehälter und Bewertungen außer denen der HR-Administration; einen eingeschränkten
  Betreuungsbereich gibt es noch nicht.
- [ ] **Neue Konten sind sofort aktiv.** Bei einer Einstellung entsteht das Konto gleich, auch wenn der Eintritt später liegt. Gib das Startpasswort deshalb erst zum Eintritt weiter.
- [ ] **Gehaltsrunde mit nur einer HR-Administration:** Verbietet die Regel eigene Vorschläge, braucht jede Änderung an einem Vorschlag eine zweite HR-Administration. Lege sie an, bevor die Runde in die Prüfung geht.
- [ ] **Vier Augen:** Eine HR-Administration kann sich selbst ein zweites Konto anlegen. Technisch lässt sich das nicht verhindern. Das Protokoll zeigt es, also prüfe es regelmäßig.
- [ ] **Vier Augen im Talent Review:** Ist HR zugleich die Führungskraft, kann dieselbe Person eine Einschätzung einreichen, zurückgeben und abschließen. Lege fest, wer das in solchen Fällen tut.
- [ ] **Automatische Programmierung aus,** falls sie eingerichtet wurde.

## Technik, die vorher fehlt

- [ ] **HTTPS** über einen Proxy, dazu `DAYBREAK_TRUST_PROXY` und `SESSION_COOKIE_SECURE=auto`.
- [ ] **E-Mail-Versand.** Daybreak verschickt noch keine E-Mails. Passwörter müssen von Hand verteilt werden,
  „Passwort vergessen“ gibt es nicht, und Erinnerungen erscheinen nur auf der Übersicht.
- [ ] **Regelmäßige Sicherung** auf einen anderen Rechner, dazu eine geprobte Wiederherstellung. `npm run backup` sichert,
  plant aber nichts. Bei SQLite: Die Datenbanken sind nicht verschlüsselt. Verschlüssle den Datenträger.
- [ ] **Zweiter Anmeldefaktor,** mindestens für HR und Systemadministration. Fehlt noch.
- [ ] **Überwachung** von Fehlern, Auslastung und Anmeldeversuchen. Fehlt noch.
- [ ] **Unabhängige Sicherheitsprüfung.** Die vorhandenen Prüfungen ersetzen kein externes Gutachten.

## Fachliche Lücken mit Alltagswirkung

- [ ] Anteiliger Urlaubsanspruch bei Ein- und Austritt.
- [ ] Krankheit während des Urlaubs und das Verkürzen genehmigter Abwesenheiten.
- [ ] Feiertage nach Gemeinde und Standort.
- [ ] Lohnabrechnung gibt es nicht, nur CSV-Exporte. Eine Schnittstelle (zum Beispiel DATEV) fehlt.
- [ ] Prüfe die Regeln zu Pausen, Ruhezeiten und Zeiterfassung gegen das, was bei euch gilt.

## Recht und Mitbestimmung

Ohne Anspruch auf Vollständigkeit:

- [ ] **Datenschutz:** Verzeichnis der Verarbeitungen, Rechtsgrundlagen, Löschfristen, Datenschutzbeauftragte einbinden,
  Datenschutz-Folgenabschätzung prüfen. Daybreak löscht nichts automatisch endgültig, außer der Anonymisierung im Recruiting.
- [ ] **Auskunftsrecht:** Die Datenauskunft in der Personalakte erzeugt einen Export. Bewertungs- und Planungsdaten sind darin
  markiert (`reviewBeforeRelease`). Was davon herausgegeben wird, muss im Einzelfall jemand mit Fachwissen entscheiden.
- [ ] **Betriebsrat:** Zeiterfassung, Leistungsbewertung, 360°-Feedback und Befragungen sind in Deutschland meist
  mitbestimmungspflichtig.
- [ ] **Lokale KI:** Dayo sendet mit Ollama Fragen an das eingestellte Modell. Prüfe, wo es läuft und was es protokolliert.
- [ ] **Befragungen auf PostgreSQL:** Wer die Datenbank verwaltet, muss vertrauenswürdig sein. Siehe
  [POSTGRESQL.md](POSTGRESQL.md).
- [ ] **Betrieb für andere:** Wer Daybreak für andere Organisationen betreibt, braucht zusätzlich Verträge zur
  Auftragsverarbeitung. Der Support-Zugriff des Betreibers bleibt aus, bis die Organisation ihn freigibt.
- [ ] **AGPL:** Wer eine veränderte Fassung über das Netz anbietet, muss deren Quellcode bereitstellen. Trage die
  Adresse in `DAYBREAK_SOURCE_URL` ein.
