'use strict';

/**
 * Betreiber-Schnittstelle (nur Systemadministration): Mandanten anlegen, sperren,
 * Module freigeben, Adressen zuordnen, sichern. Personaldaten liest diese Schnittstelle
 * nicht; sie kennt pro Mandant nur die Anzahl aktiver Konten.
 */

const express = require('express');
const { MODULES, isAvailable } = require('../lib/module-catalog');
const { PlatformError, normalizeSlug } = require('../lib/platform');
const { backupTenant, resolveBackupRoot, timestampForBackup } = require('../lib/platform-backup');
const { sourceUrl } = require('../lib/project-info');
const { virtualSuperAdmin } = require('../lib/superadmin');

function createPublicRouter({ platform, runtimeFor, env = process.env }) {
  const router = express.Router();

  // Einzige Schnittstelle ohne Anmeldung: Was die Login-Seite anzeigen soll.
  router.get('/public/context', (req, res) => {
    const hostTenant = platform.tenantForHost(req.hostname);
    const requested = !hostTenant && req.query.org ? platform.tenantBySlug(String(req.query.org)) : null;
    const known = requested?.status === 'active' ? requested : null;
    const tenant = hostTenant || known || platform.primaryTenant();
    const named = Boolean(hostTenant || known) || platform.tenantCount() <= 1;
    res.json({
      tenant: named ? { name: tenant.name, primaryColor: tenant.branding.primaryColor || null } : null,
      tenantSelectable: !hostTenant && platform.tenantCount() > 1,
      organizationCode: known ? known.slug : null,
      sourceUrl: sourceUrl(env),
      demoLogins: tenant.status === 'active' && tenant.demo_mode && (named || tenant.is_primary) ? runtimeFor(tenant).demoLogins() : []
    });
  });

  return router;
}

function createPlatformRouter({ platform, runtimeFor, closeRuntime, sessionStore, env = process.env, projectRoot }) {
  const router = express.Router();

  router.use('/platform', (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!virtualSuperAdmin(req.session, env)) return res.status(403).json({ error: 'Nur die Systemadministration darf Mandanten verwalten.' });
    next();
  });

  const actorName = () => 'root@root.de';

  function findTenant(req) {
    const tenant = platform.tenantBySlug(req.params.slug);
    if (!tenant) throw new PlatformError('Mandant nicht gefunden.', 404, 'tenant_unknown');
    return tenant;
  }

  function summary(tenant) {
    const states = platform.moduleStates(tenant.id);
    let userCount = null;
    if (tenant.status === 'active') {
      try {
        userCount = runtimeFor(tenant).userCount();
      } catch {
        userCount = null;
      }
    }
    return {
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      isPrimary: tenant.is_primary,
      demoMode: tenant.demo_mode,
      supportAccess: tenant.is_primary || tenant.support_access,
      primaryColor: tenant.branding.primaryColor || null,
      domains: platform.domainsOf(tenant.id),
      userCount,
      enabledModules: states.filter(state => state.enabled && !state.alwaysOn).length,
      createdAt: tenant.created_at
    };
  }

  const guarded = handler => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof PlatformError) return res.status(error.status).json({ error: error.message, code: error.code });
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };

  router.get('/platform/catalog', (req, res) => {
    res.json({
      modules: MODULES.map(module => ({
        key: module.key,
        name: module.name,
        area: module.area,
        description: module.description,
        dependsOn: module.dependsOn || [],
        alwaysOn: Boolean(module.alwaysOn),
        status: isAvailable(module, projectRoot) ? 'available' : 'planned'
      }))
    });
  });

  router.get('/platform/tenants', guarded((req, res) => {
    res.json({ tenants: platform.listTenants().map(summary), current: req.session.user.tenant });
  }));

  router.post('/platform/tenants', guarded((req, res) => {
    const { slug, name, adminName, adminEmail, adminPassword = null, modules = null } = req.body || {};
    if (typeof adminName !== 'string' || !adminName.trim() || typeof adminEmail !== 'string' || !/^\S+@\S+\.\S+$/.test(adminEmail)) {
      throw new PlatformError('Name und E-Mail der ersten Administrationsperson sind erforderlich.', 400, 'admin_missing');
    }
    if (adminPassword !== null && (typeof adminPassword !== 'string' || adminPassword.length < 12)) {
      throw new PlatformError('Das temporäre Passwort muss mindestens 12 Zeichen haben. Lass das Feld leer, um eines zu erzeugen.', 400, 'admin_password_short');
    }
    const tenant = platform.createTenantRecord({ slug, name, modules }, actorName());
    try {
      const admin = runtimeFor(tenant).createInitialAdmin({ name: adminName, email: adminEmail, password: adminPassword });
      res.status(201).json({
        tenant: summary(tenant),
        admin: { email: adminEmail.trim().toLowerCase(), temporaryPassword: admin.temporaryPassword }
      });
    } catch (error) {
      closeRuntime(tenant.slug, { deleteFiles: true, dbPath: tenant.db_path });
      platform.removeTenantRecord(tenant.id);
      throw error;
    }
  }));

  router.get('/platform/tenants/:slug', guarded((req, res) => {
    const tenant = findTenant(req);
    res.json({
      tenant: summary(tenant),
      modules: platform.moduleStates(tenant.id).map(({ assets, ...state }) => state),
      audit: platform.auditEntries(tenant.id, 50)
    });
  }));

  router.patch('/platform/tenants/:slug', guarded((req, res) => {
    const tenant = findTenant(req);
    const body = req.body || {};
    // Der Betreiber darf eine Freigabe nur entziehen. Alles außer ausdrücklich false wird abgewiesen.
    if (body.supportAccess !== undefined && body.supportAccess !== false && !tenant.is_primary) {
      throw new PlatformError('Den Support-Zugriff kann nur die Organisation selbst freigeben.', 403, 'support_access_customer_only');
    }
    const changes = {};
    for (const field of ['name', 'status', 'demoMode', 'supportAccess', 'primaryColor']) {
      if (body[field] !== undefined) changes[field] = body[field];
    }
    const updated = platform.updateTenant(tenant.id, changes, actorName());
    if (updated.status !== 'active' && tenant.status === 'active') {
      sessionStore.revokeForTenant(updated.slug);
      closeRuntime(updated.slug);
    }
    if (updated.demo_mode !== tenant.demo_mode) closeRuntime(updated.slug);
    res.json({ tenant: summary(updated) });
  }));

  router.put('/platform/tenants/:slug/modules/:key', guarded((req, res) => {
    const tenant = findTenant(req);
    if (typeof req.body?.entitled !== 'boolean') throw new PlatformError('Bitte gib an, ob das Modul freigegeben ist.', 400, 'entitled_missing');
    const { assets, ...state } = platform.setModuleEntitled(tenant.id, req.params.key, req.body.entitled, actorName());
    res.json({ module: state });
  }));

  router.post('/platform/tenants/:slug/domains', guarded((req, res) => {
    const tenant = findTenant(req);
    res.status(201).json({ domains: platform.addDomain(tenant.id, req.body?.hostname, actorName()) });
  }));

  router.delete('/platform/tenants/:slug/domains/:hostname', guarded((req, res) => {
    const tenant = findTenant(req);
    res.json({ domains: platform.removeDomain(tenant.id, req.params.hostname, actorName()) });
  }));

  // Betreiber wechselt für Support in einen Mandanten. Immer protokolliert, immer widerrufbar.
  router.post('/platform/tenants/:slug/enter', guarded((req, res) => {
    const tenant = findTenant(req);
    if (tenant.status !== 'active') throw new PlatformError('Dieser Mandant ist nicht aktiv.', 409, 'tenant_inactive');
    if (!tenant.is_primary && !tenant.support_access) throw new PlatformError('Die Organisation hat den Support-Zugriff nicht freigegeben.', 403, 'support_access_denied');
    const hostTenant = platform.tenantForHost(req.hostname);
    if (hostTenant && hostTenant.id !== tenant.id) throw new PlatformError('Über diese Adresse ist nur der zugeordnete Mandant erreichbar.', 409, 'host_locked');
    req.session.user = { ...req.session.user, tenant: tenant.slug };
    platform.audit(actorName(), 'support_access_entered', tenant.id);
    runtimeFor(tenant).recordSupportAccess('support_access_entered');
    res.json({ tenant: summary(tenant) });
  }));

  router.post('/platform/tenants/:slug/backup', guarded(async (req, res) => {
    const tenant = findTenant(req);
    const file = await backupTenant({ tenant, backupRoot: resolveBackupRoot(env, projectRoot), stamp: timestampForBackup(), storage: platform.storage });
    platform.audit(actorName(), 'tenant_backup_created', tenant.id, { file });
    res.status(201).json({ file });
  }));

  // Bekannte Demo-Passwörter sperren und Demo-Modus beenden. Für den Weg in den Echtbetrieb.
  router.post('/platform/tenants/:slug/lock-demo-accounts', guarded(async (req, res) => {
    const tenant = findTenant(req);
    if (req.body?.confirmation !== tenant.slug) throw new PlatformError('Bitte bestätige mit der Firmenkennung.', 400, 'confirmation_missing');
    const locked = await runtimeFor(tenant).lockDemoAccounts();
    const updated = platform.updateTenant(tenant.id, { demoMode: false }, actorName());
    platform.audit(actorName(), 'demo_accounts_locked', tenant.id, { locked });
    closeRuntime(updated.slug);
    res.json({ locked, tenant: summary(updated) });
  }));

  // Endgültiges Löschen geht nur nach Archivierung und mit Sicherung als letztem Stand.
  router.delete('/platform/tenants/:slug', guarded(async (req, res) => {
    const tenant = findTenant(req);
    if (tenant.is_primary) throw new PlatformError('Der Hauptmandant kann nicht gelöscht werden.', 409, 'tenant_primary');
    if (tenant.status !== 'archived') throw new PlatformError('Archiviere den Mandanten zuerst.', 409, 'tenant_not_archived');
    if (normalizeSlug(req.body?.confirmation) !== tenant.slug) throw new PlatformError('Bitte bestätige mit der Firmenkennung.', 400, 'confirmation_missing');
    const file = await backupTenant({ tenant, backupRoot: resolveBackupRoot(env, projectRoot), stamp: timestampForBackup(), storage: platform.storage });
    sessionStore.revokeForTenant(tenant.slug);
    closeRuntime(tenant.slug, { deleteFiles: true, dbPath: tenant.db_path });
    platform.audit(actorName(), 'tenant_deleted', null, { slug: tenant.slug, finalBackup: file });
    platform.removeTenantRecord(tenant.id);
    res.json({ ok: true, finalBackup: file });
  }));

  return router;
}

module.exports = { createPlatformRouter, createPublicRouter };
