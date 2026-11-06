#!/usr/bin/env node
const path = require('path');
const { defaultEnvironmentFile } = require('../config/load-env');
const { updateEnvironmentValues } = require('../config/update-env');

const environmentFile = path.resolve(process.argv[2] || defaultEnvironmentFile());
const projectRoot = path.resolve(__dirname, '..');
const projectParent = path.dirname(projectRoot);

updateEnvironmentValues(environmentFile, {
  DAYBREAK_GIT_REPOSITORY: path.join(projectParent, 'repositories', 'daybreak.git'),
  DAYBREAK_AUTOMATION_JOBS_ROOT: path.join(projectParent, 'daybreak_jobs'),
  DAYBREAK_BACKUP_ROOT: path.join(projectParent, 'backups'),
  DAYBREAK_CODEX_CLI: path.join(process.env.HOME, '.local', 'bin', 'codex'),
  DAYBREAK_CODEX_MODEL: 'gpt-5.6-sol',
  DAYBREAK_AUTOMATION_PUBLISH_ENABLED: 'true',
  DAYBREAK_PM2_APP: 'daybreak',
  DAYBREAK_PM2_CLI: 'pm2'
});

console.log(`Automationspfade wurden in ${environmentFile} hinterlegt. Es wurden keine Zugangsdaten geschrieben.`);
