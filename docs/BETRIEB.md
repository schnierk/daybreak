# Daybreak betreiben

Diese Anleitung ist für alle, die Daybreak selbst installieren. Die Person, die eine Installation verwaltet,
heißt hier **Betreiber** und meldet sich als `root@root.de` an. Außer Installieren und Aktualisieren geht alles
in der Weboberfläche.

Bevor echte Personaldaten hineinkommen, lies die [Go-Live-Merkliste](GO-LIVE-MERKLISTE.md).

## Installieren

Du brauchst Node.js ab Version 20.

```bash
npm ci --omit=dev
```

Lege eine Einstellungsdatei an (Vorlage: `.env.example`) und setze das Passwort der Systemadministration. Das
Kommando fragt es verdeckt ab und speichert nur einen Hash:

```bash
npm run superadmin:password -- /pfad/zu/daybreak.env
```

Starte Daybreak mit dieser Datei:

```bash
DAYBREAK_ENV_FILE=/pfad/zu/daybreak.env npm start
```

Melde dich als `root@root.de` an und lege unter **Mitarbeitende → Konten** die erste HR-Administration an. Aus
Sicherheitsgründen geht diese Anmeldung nur vom selben Rechner oder über HTTPS.

Ohne weitere Einstellung ist Daybreak nur vom selben Rechner erreichbar. Für den Dauerbetrieb nimm einen Dienst, der Daybreak
nach Abstürzen neu startet (zum Beispiel systemd oder pm2), und einen Proxy für HTTPS. Setze dann `DAYBREAK_TRUST_PROXY=loopback` und
`SESSION_COOKIE_SECURE=auto`. Ohne `DAYBREAK_TRUST_PROXY` vertraut Daybreak der weitergeleiteten Adresse nicht: Der Proxy muss dann die
ursprüngliche Adresse als `Host` weitergeben, sonst lehnt die Herkunftsprüfung Änderungen ab.

## So liegen die Daten

- **Jede Organisation (Mandant) hat ihre eigene Datenbank.** Dadurch können sich Daten verschiedener Organisationen
  nicht vermischen, auch nicht durch einen Programmfehler in einem Modul.
- **Steuerungsdatenbank** `data/control.db`: Liste der Organisationen, freigegebene Module, Adressen, Anmeldungen,
  Betreiber-Protokoll. Sie enthält keine Personaldaten.
- **Datenbanken der Organisationen** liegen unter `data/tenants/<firmenkennung>.db`, die erste Organisation in `loop.db`.
- Mit PostgreSQL liegen sie in eigenen Schemas, siehe [POSTGRESQL.md](POSTGRESQL.md).

## Eine Organisation anlegen

1. Als `root@root.de` anmelden, **Mandanten → Neuer Mandant**.
2. Name, Firmenkennung (zum Beispiel `muster`), erste Administrationsperson und freigegebene Module eingeben.
3. Das temporäre Passwort erscheint einmalig. Gib es sicher weiter.
4. Die Person meldet sich an und muss sofort ein eigenes Passwort festlegen. Die neue Organisation startet leer.

So melden sich die Mitarbeitenden an:

- **Mit Firmenkennung** auf der Anmeldeseite, oder über `https://deine-adresse/?org=muster`, dann ist sie vorausgefüllt.
- **Über eine eigene Adresse**, zum Beispiel `hr.muster.de`: beim Mandanten unter **Eigene Adressen** eintragen und auf
  den Server leiten.
- **Über eine Unteradresse**, zum Beispiel `muster.example.org`: einmalig `DAYBREAK_BASE_DOMAIN=example.org` setzen.

## Module und Genehmigungen

| Wer | Wo | Was |
| --- | --- | --- |
| Betreiber | Mandanten → Verwalten → **Freigegebene Module** | Legt fest, was die Organisation überhaupt nutzen darf |
| HR-Administration | Administration → **Module** | Schaltet Freigegebenes an oder aus |
| HR-Administration | Administration → **Genehmigungen** | Legt fest, wer was freigibt |

- Abgeschaltete Module sind serverseitig gesperrt. Ihre Daten bleiben erhalten.
- Abhängigkeiten werden geprüft: Talent braucht zum Beispiel Ziele.
- Ganz neue Module sind bei der ersten Organisation automatisch an, bei anderen erst nach deiner Freigabe.
- Genehmigungsregeln gelten sofort und nur für neue Vorgänge.

## Support-Zugriff

Als Betreiber kannst du Organisationen verwalten, aber **nicht in ihre Personaldaten hineinsehen**, solange sie es nicht
erlauben.

- Die HR-Administration erlaubt das unter **Administration → Organisation**.
- Danach erscheint bei dir **Support-Zugriff öffnen**. Jeder Zugriff wird in beiden Protokollen festgehalten.
- Wird die Freigabe entzogen, bist du sofort draußen.

## Sichern

```bash
DAYBREAK_ENV_FILE=/pfad/zu/daybreak.env npm run backup
```

Das sichert Steuerung und alle Organisationen in einen neuen Ordner unter `DAYBREAK_BACKUP_ROOT`. Die Dateien sind nur für
den Eigentümer lesbar. Plane das regelmäßig und kopiere die Sicherung auf einen anderen Rechner.

Wiederherstellen bei SQLite: Daybreak beenden, die `.db`-Dateien an ihren Platz kopieren, Daybreak starten.

Eine gelöschte Organisation stellst du wieder her, indem du sie zuerst mit derselben Firmenkennung neu anlegst. Beende Daybreak
dann, kopiere ihre gesicherte Datei über die neue und starte wieder. Modulfreigaben und eigene Adressen trägst du neu ein.
Für PostgreSQL steht das in [POSTGRESQL.md](POSTGRESQL.md).

## Eine Organisation beenden

1. **Sperren**: Niemand kommt mehr hinein, alle sind sofort abgemeldet. Lässt sich rückgängig machen.
2. **Archivieren**: wie Sperren, für beendete Nutzung.
3. **Endgültig löschen**: nur nach Archivieren und mit Eingabe der Firmenkennung. Vorher entsteht automatisch eine letzte
   Sicherung. Lösche sie, wenn die vereinbarte Frist abgelaufen ist.

## Öffentliche Demo betreiben

Mit `DAYBREAK_PRIMARY_DEMO=true` entsteht eine Demo mit erfundenen Daten. Auf der Anmeldeseite stehen Knöpfe, und jeder kommt
mit dem öffentlich bekannten Passwort `demo1234` hinein, auch als HR-Administration. **Nie mit echten Personaldaten.**

Die sechs Zugänge auf der Anmeldeseite sind geschützt, Modulschalter und Genehmigungsregeln stehen stündlich wieder auf Anfang.
Alles andere dürfen Besucher ändern, damit sie die Funktionen ausprobieren können: Sie können zum Beispiel andere Beispielpersonen
umbenennen oder sperren, und das sehen auch die Nächsten. Wer eine Demo offen betreibt, stellt deshalb mit `DAYBREAK_DEMO_RESET_HOUR=4` ein,
dass Daybreak einmal am Tag um diese Stunde (Serverzeit) alle Beispieldaten neu anlegt. Alle Besucher sind danach abgemeldet.

Das wirkt nur auf die erste Organisation und nur im Demo-Modus. Andere Organisationen und die Aufträge der automatischen Programmierung
bleiben erhalten. Der letzte Stand liegt bis zum nächsten Reset daneben (`<Datenbank>-vor-reset`). Läuft gerade ein Programmierauftrag, fällt der
Reset an diesem Tag aus.

**Achtung bei alten Demo-Datenbanken.** Startet Daybreak ohne diese Einstellung mit einer Datenbank, die aus einer früheren Demo
stammt, zeigt die Anmeldeseite zwar keine Knöpfe mehr, das bekannte Passwort funktioniert aber weiter. Daybreak warnt dann im
Serverprotokoll. Sperre diese Konten als Systemadministration unter der Organisation mit „Demo-Passwörter sperren“.

Damit Besucher die Demo nicht für andere kaputt machen, gilt im Demo-Modus:

- Die Zugänge der Anmeldeseite lassen sich nicht sperren, nicht austreten lassen und nicht ändern, und ihr Passwort bleibt.
- Name und Farbe der Organisation ändert nur die Systemadministration.
- Module und Genehmigungen dürfen alle ausprobieren. Stündlich gilt wieder der Ausgangszustand.
- Es gibt höchstens 200 Konten, und ein Import umfasst höchstens 50 Personen.

Alle anderen Daten können Besucher ändern, und alle sehen dasselbe. Wer das nicht möchte, setzt die Demo regelmäßig auf
eine Kopie der Datenbank zurück: Daybreak beenden, Datei ersetzen, Daybreak starten.

Demo-Konten entstehen nur mit ausdrücklichem `DAYBREAK_PRIMARY_DEMO=true`. Eine wiederhergestellte Datenbank bekommt sie nie von selbst.

Gibt es neben `@loop.local` weitere Konten, entstehen keine Beispieldaten in den neueren Modulen. So bekommen echte Personen keine
erfundenen Gehälter oder Krankmeldungen. Wenn sicher alle Konten erfunden sind, setze `DAYBREAK_DEMO_DATA_FOR_ALL_ACCOUNTS=true`.

Beenden: **Mandanten → Hauptmandant → Demo-Passwörter sperren**. Konten mit dem Demo-Passwort werden unbrauchbar, die Knöpfe
verschwinden, und neue Passwörter vergibst du unter **Mitarbeitende → Passwort zurücksetzen**.

## Aktualisieren

1. Sichern: `npm run backup`.
2. Stand notieren: `git rev-parse HEAD`.
3. Neuen Stand holen und einspielen: `git pull` und `npm ci --omit=dev`.
4. Daybreak neu starten.

Beim Start kommen nur Spalten und Tabellen hinzu, gelöscht wird nichts. Zum Zurückrollen gehst du auf den notierten Stand, führst
wieder `npm ci --omit=dev` aus und startest neu. Eine ältere Version kommt mit zusätzlichen Spalten klar. Bei größeren Sprüngen nimm im
Zweifel die Sicherung.

## Einstellungen

Alle Werte stehen auch in `.env.example`.

| Name | Bedeutung | Standard |
| --- | --- | --- |
| `DAYBREAK_ENV_FILE` | Ort der Einstellungsdatei | `~/.config/daybreak.env` |
| `HOST`, `PORT` | Adresse und Anschluss, auf denen Daybreak lauscht | `127.0.0.1`, `3000` |
| `SESSION_SECRET` | Geheimnis für Anmeldungen. Ohne ihn ist nach jedem Neustart eine neue Anmeldung nötig | zufällig je Start |
| `DAYBREAK_DB_PATH` | Datenbank der ersten Organisation | `loop.db` im Projektordner |
| `DAYBREAK_DATA_DIR` | Ablage für Steuerung und weitere Organisationen | Ordner `data` neben der ersten Datenbank |
| `DAYBREAK_DATABASE_URL` | PostgreSQL statt SQLite | nicht gesetzt |
| `DAYBREAK_PRIMARY_TENANT_NAME` | Name der ersten Organisation | `Daybreak` |
| `DAYBREAK_DEMO_RESET_HOUR` | Stunde (0 bis 23, Serverzeit), zu der eine Demo täglich neu angelegt wird | nicht gesetzt |
| `DAYBREAK_PRIMARY_DEMO` | Demo-Daten bei der ersten Einrichtung, nur mit `true` | aus |
| `DAYBREAK_DEMO_DATA_FOR_ALL_ACCOUNTS` | Beispieldaten trotz Konten außerhalb von `@loop.local` | aus |
| `DAYBREAK_BASE_DOMAIN` | Hauptadresse für Unteradressen | nicht gesetzt |
| `DAYBREAK_TRUST_PROXY` | Vertrauenswürdiger Proxy davor, z. B. `loopback` | nicht gesetzt |
| `SESSION_COOKIE_SECURE` | `true`, `false` oder `auto` | in Produktion `true` |
| `DAYBREAK_BACKUP_ROOT` | Ablage für Sicherungen | Ordner `backups` neben dem Projekt |
| `DAYBREAK_SOURCE_URL` | Link zum Quellcode (AGPL) | das Projekt auf GitHub |
| `DAYBREAK_ASSISTANT_PROVIDER` | `ollama` für lokale KI in Dayo | eingebaute Hilfe |

## Automatische Programmierung (optional)

Daybreak bringt eine Funktion mit, die aus geprüften Dayo-Vorschlägen Programmieraufträge an den KI-Coding-Agenten Codex macht. Sie ist
für die eigene Weiterentwicklung gedacht und auf einen einzelnen Server zugeschnitten. Sie erscheint nur, wenn `DAYBREAK_GIT_REPOSITORY`
gesetzt ist, und nur mit SQLite. Ändere damit nichts an einem System mit echten Daten.

- Nur die Systemadministration kann Aufträge anlegen.
- Jeder Auftrag läuft in einem eigenen Arbeitsordner ohne Produktionsdatenbank und ohne Einstellungsdatei.
- Nach erfolgreichen Tests entsteht ein eigener Git-Zweig. Veröffentlicht wird nur nach ausdrücklicher Bestätigung, und nur wenn
  `DAYBREAK_AUTOMATION_PUBLISH_ENABLED=true` gesetzt ist. Geschützte Dateien sind davon ausgenommen.
