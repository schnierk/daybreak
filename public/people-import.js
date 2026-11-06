// Mitarbeitende aus einer CSV-Datei importieren: Vorschau mit Fehlern je Zeile, dann alles oder nichts.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;

  const COLUMNS = {
    name: ['name', 'vollständiger name', 'mitarbeiter', 'mitarbeitende'],
    email: ['e-mail', 'email', 'mail', 'e-mail-adresse'],
    role: ['rolle', 'role'],
    position: ['position', 'titel', 'stelle', 'jobtitel', 'bezeichnung'],
    managerEmail: ['führungskraft-e-mail', 'führungskraft e-mail', 'führungskraft', 'manager-e-mail', 'manager', 'vorgesetzte']
  };

  /** Excel speichert CSV oft in der alten Windows-Kodierung. Ohne Umwandlung gingen Umlaute verloren. */
  async function readCsvFile(file) {
    const bytes = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  const roleLabel = role => window.loop.roles[role] || role || '–';

  /** Liest CSV mit Semikolon oder Komma und Text in Anführungszeichen. */
  function parseCsv(text) {
    const clean = text.replace(/^﻿/, '');
    const firstLine = clean.split(/\r?\n/, 1)[0] || '';
    const delimiter = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    // Die echte Zeile der Datei, damit Fehlermeldungen in Excel zu finden sind.
    let line = 1;
    let rowLine = 1;
    const finishRow = () => {
      row.push(cell);
      rows.push({ line: rowLine, cells: row });
      row = [];
      cell = '';
      rowLine = line;
    };
    for (let index = 0; index < clean.length; index += 1) {
      const character = clean[index];
      if (character === '\n') line += 1;
      if (quoted) {
        if (character === '"' && clean[index + 1] === '"') { cell += '"'; index += 1; }
        else if (character === '"') quoted = false;
        else cell += character;
      } else if (character === '"') quoted = true;
      else if (character === delimiter) { row.push(cell); cell = ''; }
      else if (character === '\n') finishRow();
      else if (character === '\r') {
        if (clean[index + 1] !== '\n') { line += 1; finishRow(); }
      } else cell += character;
    }
    if (cell || row.length) finishRow();
    return rows.filter(item => item.cells.some(value => value.trim()));
  }

  function toImportRows(table) {
    if (table.length < 2) throw new Error('Die Datei braucht eine Kopfzeile und mindestens eine Person.');
    const header = table[0].cells.map(value => value.trim().toLowerCase());
    const indexOf = names => header.findIndex(value => names.includes(value));
    const positions = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, indexOf(names)]));
    if (positions.name < 0 || positions.email < 0) throw new Error('Die Spalten „Name“ und „E-Mail“ werden gebraucht.');
    const known = new Set(Object.values(COLUMNS).flat());
    const ignoredColumns = table[0].cells.map(value => value.trim()).filter(value => value && !known.has(value.toLowerCase()));
    const rows = table.slice(1).map(({ line, cells }) => ({
      line,
      ...Object.fromEntries(Object.entries(positions).map(([key, position]) => [key, position >= 0 ? (cells[position] || '').trim() : '']))
    }));
    return { rows, ignoredColumns };
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Tabellenprogramme führen Zellen mit =, +, - oder @ am Anfang als Formel aus.
  const csvCell = value => {
    const text = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  function showResult(created) {
    const rows = created.map(person => `<tr><td>${esc(person.name)}</td><td>${esc(person.email)}</td><td><code class="tempPassword">${esc(person.temporaryPassword)}</code></td></tr>`).join('');
    ui.modal({
      title: `${ui.plural(created.length, 'Person', 'Personen')} angelegt`,
      subtitle: 'Die Zugangsdaten werden nicht noch einmal angezeigt.',
      body: `<p>Lade die Zugangsliste jetzt herunter und gib die Passwörter sicher weiter. Bei der ersten Anmeldung muss jede Person ein eigenes Passwort festlegen. Lösche die Datei danach.</p>
        <button type="button" class="btn primary" data-import-download>Zugangsliste herunterladen</button>
        <div class="tableWrap" style="margin-top:12px;max-height:320px;overflow:auto"><table class="table"><thead><tr><th>Name</th><th>E-Mail</th><th>Temporäres Passwort</th></tr></thead><tbody>${rows}</tbody></table></div>`
    });
    document.querySelector('[data-import-download]').onclick = () => {
      const lines = ['Name;E-Mail;Temporäres Passwort', ...created.map(person => [person.name, person.email, person.temporaryPassword].map(csvCell).join(';'))];
      download('daybreak-zugangsliste.csv', lines.join('\r\n'));
    };
    // Die Passwörter gibt es nur einmal. Vor dem Schließen deshalb lieber einmal nachfragen.
    document.querySelector('#uiModal').dataset.confirmClose = 'Hast du die Zugangsliste heruntergeladen? Die Passwörter werden nicht noch einmal angezeigt.';
    document.querySelector('#uiModalClose').addEventListener('click', () => window.loop.navigate('people'));
  }

  function showPreview(rows, summary, importRows, ignoredColumns) {
    const table = rows.map(row => `<tr${row.errors.length ? ' class="importError"' : ''}>
      <td>${esc(row.line)}</td>
      <td><b>${esc(row.name || '–')}</b><small>${esc(row.email || '–')}</small></td>
      <td>${esc(roleLabel(row.role))}</td>
      <td>${esc(row.title || '–')}${row.title && !row.positionMatched ? '<small>nur als Bezeichnung, kein passendes Positionsprofil</small>' : ''}</td>
      <td>${esc(row.managerEmail || '–')}</td>
      <td>${row.errors.length ? row.errors.map(esc).join('<br>') : '<span class="tag">In Ordnung</span>'}${row.sanitized ? '<small>Die Zeichen &lt; und &gt; werden aus Name und Position entfernt.</small>' : ''}</td>
    </tr>`).join('');
    const ready = summary.invalid === 0;
    // Fehler stehen oben: Bei breiten Tabellen läge die Spalte „Prüfung“ sonst außerhalb des Bildes.
    const problems = ready ? '' : `<div class="importProblems" role="alert"><b>Das ist zu korrigieren:</b><ul>${rows.filter(row => row.errors.length).slice(0, 30).map(row => `<li>Zeile ${esc(row.line)}${row.email ? ` (${esc(row.email)})` : ''}: ${row.errors.map(esc).join(' ')}</li>`).join('')}</ul></div>`;
    const ignored = ignoredColumns.length ? `<p class="muted">Diese Spalten werden nicht übernommen: ${ignoredColumns.map(esc).join(', ')}. Bekannt sind Name, E-Mail, Rolle, Position und Führungskraft-E-Mail.</p>` : '';
    ui.modal({
      title: 'Vorschau',
      subtitle: ready ? `${ui.plural(summary.total, 'Person kann', 'Personen können')} angelegt werden.` : `${summary.invalid} von ${ui.plural(summary.total, 'Zeile', 'Zeilen')} mit Fehlern. Bitte korrigiere die Datei und lade sie erneut hoch.`,
      submitLabel: `${ui.plural(summary.total, 'Person', 'Personen')} anlegen`,
      body: `${problems}${ignored}<div class="tableWrap" style="max-height:420px;overflow:auto"><table class="table"><thead><tr><th>Zeile</th><th>Person</th><th>Rolle</th><th>Position</th><th>Führungskraft</th><th>Prüfung</th></tr></thead><tbody>${table}</tbody></table></div>`,
      onSubmit: ready ? async () => {
        const result = await api('/api/users/import', { method: 'POST', body: JSON.stringify({ rows: importRows }) });
        setTimeout(() => showResult(result.created), 0);
      } : null
    });
  }

  function openImport() {
    ui.modal({
      title: 'Mitarbeitende importieren',
      subtitle: 'Aus Excel oder einem anderen System als CSV-Datei.',
      submitLabel: 'Datei prüfen',
      body: `<p>Benötigte Spalten: <b>Name</b> und <b>E-Mail</b>. Optional: <b>Rolle</b>, <b>Position</b> und <b>Führungskraft-E-Mail</b>. Du siehst zuerst eine Vorschau, angelegt wird noch nichts.</p>
        <button type="button" class="btn" data-import-template>Vorlage herunterladen</button>
        <label style="margin-top:12px">CSV-Datei</label><input type="file" name="file" accept=".csv,text/csv" required>`,
      onSubmit: async (data) => {
        if (!data.file || !data.file.size) throw new Error('Bitte wähle eine Datei aus.');
        if (data.file.size > 800 * 1024) throw new Error('Die Datei ist zu groß. Bitte teile sie in kleinere Dateien auf.');
        const { rows: importRows, ignoredColumns } = toImportRows(parseCsv(await readCsvFile(data.file)));
        const preview = await api('/api/users/import', { method: 'POST', body: JSON.stringify({ rows: importRows, dryRun: true }) });
        setTimeout(() => showPreview(preview.rows, preview.summary, importRows, ignoredColumns), 0);
      }
    });
    document.querySelector('[data-import-template]').onclick = () => {
      // Die Sachbearbeitung legt nur Mitarbeitende an. Ihre Vorlage soll ohne Fehler durchlaufen.
      if (window.loop.me.role === 'hr_staff') {
        return download('daybreak-import-vorlage.csv', 'Name;E-Mail;Rolle;Position;Führungskraft-E-Mail\r\nMax Beispiel;max.beispiel@firma.de;Mitarbeiter:in;Sachbearbeitung;\r\nMia Muster;mia.muster@firma.de;Mitarbeiter:in;Sachbearbeitung;\r\n');
      }
      download('daybreak-import-vorlage.csv', 'Name;E-Mail;Rolle;Position;Führungskraft-E-Mail\r\nErika Beispiel;erika.beispiel@firma.de;Führungskraft;Teamleitung;\r\nMax Beispiel;max.beispiel@firma.de;Mitarbeiter:in;Sachbearbeitung;erika.beispiel@firma.de\r\n');
    };
  }

  window.loop.registerModule({
    key: 'peopleImport',
    core: true,
    bind() {
      document.querySelectorAll('[data-people-import]').forEach(button => { button.onclick = openImport; });
    }
  });
})();
