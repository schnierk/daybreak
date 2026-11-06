# Roadmap

Das ist eine Sammlung, was als Nächstes sinnvoll wäre, kein Versprechen und ohne Termine. Vorschläge sind
willkommen. Das Ziel ist ein schnell eingerichtetes und verständliches HR-System, kein Nachbau großer
Konzernlösungen.

## Stand heute

| Bereich | Reife |
| --- | --- |
| Personen und Organisation, Ziele, Check-ins, Talentprofil, Talent Review, 360°-Feedback, Dayo | gereift |
| Mehrere Organisationen, Modulschalter, Genehmigungsregeln | Grundversion |
| Personalakte, Abwesenheit, Zeiterfassung, Recruiting, Onboarding, Lernen, Nachfolge, Vergütung, Befragungen | Grundversion |
| Auswertungen | einfach |

„Grundversion“ heißt: Der Kernablauf ist vollständig und getestet, Sonderfälle großer Organisationen fehlen.

## Zuerst: Was der Einsatz mit echten Daten braucht

Siehe [Go-Live-Merkliste](GO-LIVE-MERKLISTE.md).

1. E-Mail-Versand und „Passwort vergessen“.
2. Geplante Sicherung und geprobte Wiederherstellung.
3. Zweiter Anmeldefaktor.
4. Anteilige Urlaubsansprüche, Krankheit im Urlaub, Verkürzen genehmigter Abwesenheiten.
5. Überwachung und Vorlagen für den Datenschutz.
6. Vertretung: Fällt eine Führungskraft aus, gehen ihre Freigaben heute erst nach einer neuen Zuordnung weiter.
7. Konto erst zum Eintritt aktiv. Heute ist es ab der Einstellung nutzbar, das Startpasswort gibst du deshalb erst zum Eintritt weiter.

## Danach: Was Nutzer schnell fragen werden

1. Englische Oberfläche, später weitere Sprachen.
2. Lohn-Schnittstelle (zum Beispiel DATEV).
3. Firmen-Login (SSO), Benutzerabgleich (SCIM), offene Programmierschnittstelle.
4. Öffentliche Karriereseite mit Bewerbungsformular.
5. Dokumente: Dateien in der Personalakte, Vorlagen, elektronische Unterschrift.
6. HR-Service: Anfragen als Vorgang mit Status, auch vertrauliche Fälle.
7. Testorganisation als anonymisierte Kopie für Schulungen.
8. Eigene Felder und flexiblere Rechte, zum Beispiel ein Betreuungsbereich für HR Business Partner.
9. Bessere Auswertungen: Personalbestand, Fluktuation, Abwesenheitsquote, Export.
10. Entgelttransparenz nach den EU-Vorgaben.
11. Mit PostgreSQL parallele Anfragen und mehrere Serverprozesse.

## Später

- Schichtplanung, Zusatzleistungen, interner Talentmarkt, Fremdpersonal, Personalplanung.
- Kleine Module: Anerkennung unter Kolleg:innen, Jubiläen, Beförderungsvorschlag, Antrag auf Arbeiten von anderswo,
  Weiterbildungskosten.
- Dayo: eigene Regeln je Organisation und Handeln mit Freigabe statt nur Lesen.

## Bewusst nicht gebaut

Damit nichts als „vergessen“ gilt:

- **Lohnabrechnung, Steuern, Finanzen, Einkauf:** Anderes Fachgebiet. Stattdessen Schnittstellen.
- **Personalakte:** Stichtagsabfrage, Korrektur wirksamer Änderungen, geplanter Wiedereintritt, Massenänderungen.
- **Ziele:** Eigener Abschluss eines Ziels. Bis dahin gilt ein Ziel bei 100 % als erreicht, entfernen lässt es sich jederzeit durch die Führungskraft.
- **Abwesenheit:** Gemeindefeiertage, Bundesland je Standort, Krankmeldung durch die Führungskraft für Anrufende.
- **Zeiterfassung:** Wochenstunden mit Gültigkeitsdatum, Projekte und Kostenstellen, gewählte Woche in der Adresse.
- **Talent Review:** Teilnehmende aus einer Sitzung entfernen, Ergebnisgespräch dokumentieren, Teilnahme von HR-Personen.
- **360° Feedback:** Termin und Ergebnis des Ergebnisgesprächs festhalten.
- **Recruiting:** Datei-Upload, Dubletten zusammenführen.
- **Onboarding:** Offboarding-Start aus der Personalakte, Rücknahme von „Erledigt“.
- **Lernen:** Lektionen und Tests, Frist nachträglich ändern, Zuweisung zurückziehen.
- **Befragungen:** Automatisches Öffnen, wiederkehrende Wellen, Maßnahmenplanung.
- **Vergütung:** Auszahlung von Boni, Auswertung nach Geschlecht, Weg zurück aus „in Prüfung“, Summe je Bereich für die Bereichsleitung, eigener Abgabe-Schritt für Führungskräfte.
- **Nachfolge:** Talent-Pools und Mitteilungen an Kandidaten.
