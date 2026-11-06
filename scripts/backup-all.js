#!/usr/bin/env node
/**
 * Sichert die Steuerungsdatenbank und alle Datenbanken der Organisationen in einen neuen Ordner.
 * Aufruf: npm run backup
 */
const path = require('path');
const { loadEnvironment } = require('../config/load-env');
const { backupAll, resolveBackupRoot } = require('../lib/platform-backup');
const { createStorage, resolveDataDir } = require('../lib/storage');

loadEnvironment();

const projectRoot = path.resolve(__dirname, '..');
const primaryDbPath = path.resolve(process.env.DAYBREAK_DB_PATH || path.join(projectRoot, 'loop.db'));

const dataDir = resolveDataDir(process.env, primaryDbPath);
const storage = createStorage({ env: process.env, primaryDbPath, dataDir });

backupAll({ storage, backupRoot: resolveBackupRoot(process.env, projectRoot) })
  .then(({ directory, files }) => {
    if (!directory) {
      console.log('Noch keine Steuerungsdatenbank vorhanden, nichts zu sichern.');
      return;
    }
    console.log(`Sicherung abgeschlossen: ${files.length} Datei(en) in ${directory}`);
  })
  .catch(error => {
    console.error(`Sicherung fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
