'use strict';

/**
 * Sichert Mandanten-Datenbanken. Arbeitet mit eigener, nur lesender Verbindung und ist
 * damit auch aus getrennten Prozessen (z. B. vor einer Veröffentlichung) nutzbar.
 * Sicherungen enthalten Personaldaten und sind deshalb nur für den Eigentümer lesbar.
 *
 * Bei SQLite entsteht eine Kopie der Datei, bei PostgreSQL mit pg_dump eine SQL-Datei.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { POSTGRES_PREFIX } = require('./storage');

function resolveBackupRoot(env, projectRoot) {
  return path.resolve(env.DAYBREAK_BACKUP_ROOT || path.join(projectRoot, '..', 'backups'));
}

function timestampForBackup() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function copyDatabase(sourcePath, targetPath) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(targetPath);
    fs.chmodSync(targetPath, 0o600);
  } finally {
    source.close();
  }
  return targetPath;
}

/** Das Passwort steht in der Umgebung, damit es nicht in der Prozessliste sichtbar wird. */
function postgresEnvironment(connectionString) {
  const url = new URL(connectionString);
  const environment = { ...process.env };
  const set = (name, value) => {
    if (value) environment[name] = decodeURIComponent(value);
  };
  set('PGHOST', url.hostname);
  set('PGPORT', url.port);
  set('PGUSER', url.username);
  set('PGPASSWORD', url.password);
  set('PGDATABASE', url.pathname.replace(/^\//, ''));
  set('PGHOST', url.searchParams.get('host'));
  set('PGSSLMODE', url.searchParams.get('sslmode'));
  return environment;
}

function dumpSchema(connectionString, schema, targetPath) {
  // Die Datei entsteht zuerst leer und geschützt, damit die Daten nie offen lesbar sind.
  fs.writeFileSync(targetPath, '', { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--schema', schema, '--no-owner', '--no-privileges', '--file', targetPath], {
      env: postgresEnvironment(connectionString),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errors = '';
    child.stderr.on('data', chunk => {
      errors += chunk;
    });
    const fail = message => {
      fs.rmSync(targetPath, { force: true });
      const error = new Error(message);
      error.status = 500;
      reject(error);
    };
    child.on('error', error => {
      fail(error.code === 'ENOENT' ? 'Für die Sicherung wird das Programm pg_dump gebraucht. Es ist nicht installiert.' : error.message);
    });
    child.on('close', code => {
      if (code === 0) resolve(targetPath);
      else if (code === null) fail('pg_dump wurde vorzeitig beendet. Die Sicherung ist nicht vollständig und wurde verworfen.');
      else fail(`pg_dump meldet einen Fehler: ${errors.trim().slice(0, 500)}`);
    });
  });
}

function backupLocation(storage, location, directory, name) {
  if (String(location).startsWith(POSTGRES_PREFIX)) {
    return dumpSchema(storage.connectionString, storage.schemaOf(location), path.join(directory, `${name}.sql`));
  }
  return copyDatabase(location, path.join(directory, `${name}.db`));
}

async function backupTenant({ tenant, backupRoot, stamp, storage }) {
  const directory = path.join(backupRoot, `tenants-${stamp}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return backupLocation(storage, tenant.db_path, directory, `tenant-${tenant.slug}`);
}

function readTenantList(storage, controlLocation) {
  const control = storage.kind === 'sqlite' ? new Database(controlLocation, { readonly: true, fileMustExist: true }) : storage.open(controlLocation);
  try {
    return control.prepare('SELECT slug,db_path FROM tenants ORDER BY id').all();
  } finally {
    control.close();
  }
}

/** Sichert Steuerungsdatenbank und alle Mandanten in einen gemeinsamen Ordner. */
async function backupAll({ storage, backupRoot, stamp = timestampForBackup() }) {
  const controlLocation = storage.controlLocation();
  if (!storage.exists(controlLocation)) return { directory: null, files: [] };
  const directory = path.join(backupRoot, `tenants-${stamp}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = [await backupLocation(storage, controlLocation, directory, 'control')];
  for (const tenant of readTenantList(storage, controlLocation)) {
    if (storage.exists(tenant.db_path)) files.push(await backupLocation(storage, tenant.db_path, directory, `tenant-${tenant.slug}`));
  }
  return { directory, files };
}

module.exports = { backupAll, backupTenant, postgresEnvironment, resolveBackupRoot, timestampForBackup };
