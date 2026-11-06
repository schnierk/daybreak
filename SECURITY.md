# Sicherheit

Daybreak verwaltet in der Praxis Personaldaten. Sicherheitslücken nehmen wir deshalb ernst, auch wenn das Projekt
heute eine Demo ist.

## Lücke melden

Bitte melde Lücken **nicht** als öffentliches Issue. Nutze auf GitHub unter **Security → Report a vulnerability** eine
private Meldung. Beschreibe, was passiert, wie man es nachstellt und welche Rolle dafür nötig ist.

Das Projekt wird in der Freizeit betreut. Es gibt keine zugesagten Antwortzeiten und keine Prämien. Wer eine Lücke
verantwortungsvoll meldet, wird auf Wunsch genannt.

## Was als Lücke gilt

- Zugriff auf Daten einer anderen Organisation.
- Zugriff auf Daten oder Funktionen über die eigene Rolle hinaus, zum Beispiel Gehälter oder Krankmeldungen.
- Einschleusen von Skripten oder SQL, Umgehen der Anmeldung, Übernahme fremder Sitzungen.
- Rückschlüsse auf einzelne Personen aus anonymen Befragungen oder 360°-Feedback.

## Was keine Lücke ist

- Die öffentlich bekannten Demo-Passwörter. Sie gelten nur im Demo-Modus, und der ist nur für erfundene Daten gedacht.
- Dass in einer öffentlichen Demo alle Besucher dieselben Daten sehen und ändern können.
- Dass die Systemadministration (`root@root.de`) in der eigenen Installation viel darf.

## Hinweise für den Betrieb

Bevor echte Daten hineinkommen: [docs/GO-LIVE-MERKLISTE.md](docs/GO-LIVE-MERKLISTE.md). Daybreak gibt es ohne Gewährleistung.
Die Verantwortung für einen sicheren Betrieb liegt bei dem, der es einsetzt.
