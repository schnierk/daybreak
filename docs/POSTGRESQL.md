# Daybreak mit PostgreSQL betreiben

Daybreak läuft von Haus aus mit SQLite. Das braucht keine Einrichtung und reicht für die Demo und
für kleinere Organisationen. Wer Daybreak selbst betreibt und schon PostgreSQL nutzt, kann stattdessen
PostgreSQL einstellen. Die Fachmodule bleiben dabei unverändert.

## Einschalten

Lege eine leere Datenbank an und trage ihre Adresse in die Einstellungen ein:

```bash
createdb daybreak
```

```
DAYBREAK_DATABASE_URL=postgres://benutzer:passwort@localhost:5432/daybreak
```

Beim nächsten Start legt Daybreak alles selbst an. Ohne diesen Eintrag bleibt es bei SQLite.

Der Datenbankbenutzer braucht das Recht, Schemas anzulegen (`CREATE` auf der Datenbank).
Getestet ist Daybreak mit PostgreSQL 16, auch mit deutscher Sortierung.

## Vorhandene Daten umziehen

Beende Daybreak und rufe das Umzugswerkzeug auf:

```bash
DAYBREAK_DATABASE_URL=postgres://benutzer:passwort@localhost:5432/daybreak npm run migrate:postgres
```

- Die SQLite-Dateien werden nur gelesen und bleiben unverändert. Sie sind deine Rückfallebene.
- Gibt es am Ziel schon Daten, bricht das Werkzeug ab und ändert nichts.
- Geht beim Umzug etwas schief, wird alles Neue wieder entfernt. Die Meldung nennt Tabelle und Zeile.
- Die Anzahl der Zeilen wird je Tabelle verglichen.
- Sitzungen werden nicht übernommen. Alle melden sich nach dem Umzug neu an.

Wieder zurück zu SQLite geht es, indem du `DAYBREAK_DATABASE_URL` entfernst. Dann gilt der Stand der
SQLite-Dateien vom Umzug. Spätere Änderungen in PostgreSQL werden nicht zurückgeführt.

## So liegen die Daten

| | SQLite | PostgreSQL |
| --- | --- | --- |
| Je Organisation | eine eigene Datei | ein eigenes Schema (`daybreak_t_<kennung>`) |
| Steuerung, Sitzungen | `data/control.db` | Schema `daybreak_control` |

Jede Abfrage nennt ihr Schema ausdrücklich. Organisationen bleiben so getrennt wie bei SQLite.

## Sichern und Wiederherstellen

```bash
npm run backup
```

Mit PostgreSQL entsteht je Organisation eine SQL-Datei, die nur der Eigentümer lesen darf. Dafür muss
`pg_dump` auf dem Rechner installiert sein, in derselben oder einer neueren Version als der Server.

**Die ganze Installation wiederherstellen.** Beende Daybreak und spiele alle Dateien des Sicherungsordners in
eine leere Datenbank ein, die Steuerung zuerst. Das Passwort steht in der Umgebung, damit es nicht in der
Prozessliste auftaucht:

```bash
export PGPASSWORD='dein-passwort'
```

```bash
psql --host localhost --username benutzer --dbname daybreak --set ON_ERROR_STOP=1 --file control.sql
```

Dasselbe danach für jede Datei `tenant-*.sql`. Starte Daybreak erst, wenn alle eingespielt sind. Stellst du nur eine
Organisation in eine leere Datenbank ein, fehlt ihr Eintrag in der Steuerung, und niemand kommt hinein.

**Eine einzelne Organisation zurücksetzen.** Beende Daybreak, entferne ihr Schema mit
`DROP SCHEMA daybreak_t_acme CASCADE` und spiele `tenant-acme.sql` ein. Die Steuerung bleibt, wie sie ist.

**Eine gelöschte Organisation wiederherstellen.** Lege sie zuerst mit derselben Firmenkennung neu an, damit die
Steuerung sie kennt. Verfahre danach wie beim Zurücksetzen. Modulfreigaben und eigene Adressen trägst du neu ein.

**Passende Programmversion.** `pg_dump` muss mindestens so neu sein wie der Server, sonst bricht die Sicherung mit einer
Meldung ab. Das Docker-Bild bringt Version 17 mit und sichert Server bis Version 17.

Probe das Wiederherstellen, bevor du dich darauf verlässt.

## Ehrliche Grenzen

**Anfragen laufen nacheinander.** Der Fachcode erwartet eine Datenbank, die sofort antwortet, wie
SQLite. Deshalb wartet Daybreak auf jede Antwort von PostgreSQL und nutzt je Serverprozess nur eine
Verbindung. Daybreak wird mit PostgreSQL also nicht schneller als mit SQLite, und mehrere Serverprozesse
gleichzeitig sind nicht vorgesehen. Für kleine und mittlere Organisationen reicht das. PostgreSQL lohnt
sich vor allem wegen der vorhandenen Abläufe für Sicherung, Überwachung und Betrieb. Wer viele Hundert
Personen gleichzeitig bedienen will, müsste die Module auf asynchrone Abfragen umstellen.

**Anonyme Befragungen.** SQLite speichert Antworten ohne Spur der Reihenfolge. PostgreSQL merkt sich
intern, in welcher Reihenfolge und in welcher Transaktion Zeilen entstanden sind. Daybreak schreibt
deshalb bei jeder Abgabe alle Zeilen der Befragung neu, geordnet nach Werten ohne Zeitbezug. Das schützt
gegen späteres Lesen der Datenbank und gegen eine einzelne Sicherungsdatei. Es schützt nicht vor jemandem, der
die Datenbank während der Befragung laufend beobachtet, zwei Sicherungen vor und nach einer Abgabe vergleicht,
die Protokolle des Datenbankservers auswertet oder alte Zeilenstände aus den Datenbankdateien liest, bevor
PostgreSQL sie aufgeräumt hat. Das Vergleichen zweier Sicherungen verrät auch bei SQLite, wer wann abgegeben hat.
Wer die Datenbank verwaltet, muss für solche Befragungen also vertrauenswürdig sein.

Der Aufwand je Abgabe wächst mit der Zahl der Antworten, und währenddessen warten alle anderen Anfragen. Bei
5.000 Personen mit 8 Fragen waren es im Test rund 0,5 Sekunden je Abgabe. Für Befragungen bis einige Hundert
Personen merkt man das nicht.

**Hängende Datenbank.** Antwortet PostgreSQL nicht, bricht eine Anfrage nach spätestens 20 Sekunden ab, und für die
nächsten 10 Sekunden lehnt Daybreak Anfragen sofort ab, statt zu warten. Einzelne Anweisungen enden nach 15 Sekunden, das
Warten auf eine Sperre nach 5 Sekunden. Eine lange Sperre in der Datenbank trifft dabei alle Organisationen.

**Automatische Programmierung.** Diese Funktion arbeitet aus eigenen Prozessen direkt auf der
SQLite-Datei und steht mit PostgreSQL nicht zur Verfügung.

**Sortierung von Texten.** SQLite sortiert nach Zeichencode, PostgreSQL nach der Sprache der Datenbank.
Namen können deshalb in einer anderen, meist natürlicheren Reihenfolge erscheinen.

**Groß- und Kleinschreibung bei Suchen.** Suchen mit `LIKE` beachten bei SQLite die Schreibweise nur für
einfache Buchstaben nicht, bei PostgreSQL für alle Buchstaben einschließlich Umlauten.

## Tests gegen PostgreSQL

```bash
DAYBREAK_TEST_DATABASE_URL=postgres://benutzer@localhost:5432/daybreak_test npm test
```

Jeder Testlauf legt eigene Schemas an. Nimm dafür eine eigene Testdatenbank, nie die mit echten Daten.
