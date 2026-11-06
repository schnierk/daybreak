const fs = require('fs');
const os = require('os');
const path = require('path');

function parseLine(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) return null;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function defaultEnvironmentFile(env = process.env) {
  if (env.DAYBREAK_ENV_FILE) return env.DAYBREAK_ENV_FILE;
  const directory = path.join(os.homedir(), '.config');
  // Frühere Versionen nannten die Datei anders. Vorhandene Installationen laufen damit unverändert weiter.
  const earlierName = path.join(directory, 'daybreak_default.env');
  const current = path.join(directory, 'daybreak.env');
  return !fs.existsSync(current) && fs.existsSync(earlierName) ? earlierName : current;
}

function loadEnvironment({ env = process.env, file = defaultEnvironmentFile(env) } = {}) {
  if (!file || !fs.existsSync(file)) return { file, loaded: false };
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const parsed = parseLine(line);
    if (parsed && env[parsed[0]] === undefined) env[parsed[0]] = parsed[1];
  }
  return { file, loaded: true };
}

module.exports = { defaultEnvironmentFile, loadEnvironment, parseLine };
