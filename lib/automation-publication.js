const path = require('path');

const CONFIRMATION_TEXT = 'VERÖFFENTLICHEN';
const SAFE_BRANCH = /^automation\/dayo-[a-z0-9_-]+-job-[1-9][0-9]*$/;
const SAFE_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_PM2_APP = /^[A-Za-z0-9_-]+$/;

const PROTECTED_PATHS = [
  /^(?:\.env(?:\..*)?|loop\.db(?:-.*)?|.*\.(?:sqlite|sqlite3))$/,
  /^(?:package\.json|package-lock\.json)$/,
  /^config\//,
  /^lib\/superadmin\.js$/,
  /^lib\/(?:approval-rules|create-app|platform|platform-backup|storage|tenant-runtime|core-helpers|module-catalog|session-store|password-pool|password-worker)\.js$/,
  /^lib\/postgres\//,
  /^routes\/(?:platform|organization|peopleImport)\.js$/,
  /^public\/(?:platform|organization|people-import)\.(?:js|css)$/,
  /^data(?:\/|$)/,
  /^lib\/automation-publication\.js$/,
  /^routes\/automation\.js$/,
  /^public\/automation\.(?:js|css)$/,
  /^scripts\/(?:configure-automation|run-automation-job|publish-automation-job|set-superadmin-password|backup-all|migrate-to-postgres)\.js$/,
  /^server\.js$/,
  /^\.git(?:\/|$)/
];

function isProtectedPublicationPath(file) {
  const normalized = String(file || '').split(path.sep).join('/').replace(/^\.\//, '');
  return !normalized || normalized.includes('../') || PROTECTED_PATHS.some(pattern => pattern.test(normalized));
}

function validateCandidate(job) {
  if (!job || job.status !== 'candidate_ready') return 'Nur ein fertig getesteter Kandidat kann veröffentlicht werden.';
  if (!SAFE_BRANCH.test(String(job.branch || ''))) return 'Der Kandidaten-Branch entspricht nicht dem erlaubten Format.';
  if (!SAFE_COMMIT.test(String(job.base_commit || '')) || !SAFE_COMMIT.test(String(job.candidate_commit || ''))) return 'Die Git-Commitdaten des Kandidaten sind unvollständig.';
  return null;
}

module.exports = {
  CONFIRMATION_TEXT,
  SAFE_BRANCH,
  SAFE_COMMIT,
  SAFE_PM2_APP,
  isProtectedPublicationPath,
  validateCandidate
};
