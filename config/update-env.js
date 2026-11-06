const fs = require('fs');
const path = require('path');

function updateEnvironmentValues(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, rawValue] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Ungültiger Env-Schlüssel: ${key}`);
    const value = String(rawValue);
    if (/\r|\n/.test(value)) throw new Error(`Ungültiger mehrzeiliger Wert für ${key}`);
    const line = `${key}=${value}`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    content = expression.test(content)
      ? content.replace(expression, line)
      : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporaryFile, file);
  fs.chmodSync(file, 0o600);
}

module.exports = { updateEnvironmentValues };
