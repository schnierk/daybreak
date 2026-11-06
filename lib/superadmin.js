const bcrypt = require('bcryptjs');

const SUPER_ADMIN_EMAIL = 'root@root.de';
const SUPER_ADMIN_USER = Object.freeze({
  id: null,
  name: 'Systemadministration',
  email: SUPER_ADMIN_EMAIL,
  role: 'super_admin',
  title: 'Daybreak Systemadministration',
  manager_id: null
});

function configuredPasswordHash(env = process.env) {
  const value = String(env.DAYBREAK_SUPERADMIN_PASSWORD_HASH || '').trim();
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value) ? value : null;
}

function isSuperAdminConfigured(env = process.env) {
  return Boolean(configuredPasswordHash(env));
}

function remoteAddress(req) {
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
}

function isSecureSuperAdminRequest(req) {
  const address = remoteAddress(req);
  return req.secure === true || address === '127.0.0.1' || address === '::1';
}

function virtualSuperAdmin(session, env = process.env) {
  return session?.user?.kind === 'super_admin' && isSuperAdminConfigured(env) ? { ...SUPER_ADMIN_USER } : null;
}

function verifySuperAdminPassword(password, env = process.env) {
  const hash = configuredPasswordHash(env);
  return Boolean(hash && typeof password === 'string' && bcrypt.compareSync(password, hash));
}

function createLoginLimiter({ maxAttempts = 5, windowMs = 15 * 60 * 1000, keyFor = req => req.ip || remoteAddress(req) || 'unknown', maxEntries = 5000 } = {}) {
  const attempts = new Map();
  const prune = () => {
    if (attempts.size < maxEntries) return;
    const now = Date.now();
    for (const [key, record] of attempts) if (record.resetAt <= now) attempts.delete(key);
    if (attempts.size >= maxEntries) attempts.clear();
  };
  const active = req => {
    const key = keyFor(req);
    const record = attempts.get(key);
    if (!record || record.resetAt <= Date.now()) {
      attempts.delete(key);
      return null;
    }
    return record;
  };
  return {
    blocked(req) { return (active(req)?.count || 0) >= maxAttempts; },
    fail(req) {
      const key = keyFor(req);
      const record = active(req) || { count: 0, resetAt: Date.now() + windowMs };
      prune();
      record.count += 1;
      attempts.set(key, record);
    },
    success(req) { attempts.delete(keyFor(req)); }
  };
}

module.exports = {
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_USER,
  configuredPasswordHash,
  createLoginLimiter,
  isSecureSuperAdminRequest,
  isSuperAdminConfigured,
  verifySuperAdminPassword,
  virtualSuperAdmin
};
