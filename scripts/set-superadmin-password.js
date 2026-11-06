#!/usr/bin/env node
const path = require('path');
const bcrypt = require('bcryptjs');
const { defaultEnvironmentFile } = require('../config/load-env');
const { updateEnvironmentValues } = require('../config/update-env');

function validatePassword(password) {
  if (password.length < 16) return 'Das Passwort muss mindestens 16 Zeichen lang sein.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) return 'Verwende Groß- und Kleinbuchstaben, Zahl und Sonderzeichen.';
  return null;
}

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return reject(new Error('Dieses Kommando benötigt ein interaktives Terminal.'));
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';
    const onData = char => {
      if (char === '\u0003') process.exit(130);
      if (char === '\r' || char === '\n') {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        return resolve(value);
      }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else if (char >= ' ') value += char;
    };
    process.stdin.on('data', onData);
  });
}

function updateEnvironmentFile(file, hash) {
  updateEnvironmentValues(file, { DAYBREAK_SUPERADMIN_PASSWORD_HASH: hash });
}

async function main() {
  const file = path.resolve(process.argv[2] || defaultEnvironmentFile());
  console.log(`Super-Admin: root@root.de\nZiel: ${file}\nDas Passwort wird weder angezeigt noch gespeichert.`);
  const first = await hiddenQuestion('Neues Passwort: ');
  const error = validatePassword(first);
  if (error) throw new Error(error);
  const second = await hiddenQuestion('Passwort wiederholen: ');
  if (first !== second) throw new Error('Die Passwörter stimmen nicht überein.');
  updateEnvironmentFile(file, bcrypt.hashSync(first, 12));
  console.log('Passwort-Hash wurde sicher gespeichert. Starte Daybreak anschließend neu.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { updateEnvironmentFile, validatePassword };
