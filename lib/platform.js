'use strict';

/**
 * Steuerungsebene für den Mehrmandantenbetrieb.
 *
 * Jeder Mandant hat seine eigene Datenbank: eine SQLite-Datei oder, wenn PostgreSQL eingestellt
 * ist, ein eigenes Schema (siehe storage.js). Diese Datei hier verwaltet nur die Mandantenliste,
 * die freigegebenen Module, Adressen und das Betreiber-Protokoll in einer getrennten
 * Steuerungsdatenbank. Personaldaten liegen hier nie.
 */

const fs = require('fs');
const path = require('path');
const catalog = require('./module-catalog');
const { createStorage } = require('./storage');

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(['default', 'www', 'api', 'admin', 'platform', 'root', 'static', 'assets', 'public', 'app', 'data']);
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const TENANT_STATUSES = new Set(['active', 'suspended', 'archived']);

class PlatformError extends Error {
  constructor(message, status = 400, code = 'platform_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseBranding(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return COLOR_PATTERN.test(parsed.primaryColor || '') ? { primaryColor: parsed.primaryColor } : {};
  } catch {
    return {};
  }
}

function toTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    db_path: row.db_path,
    is_primary: row.is_primary === 1,
    demo_mode: row.demo_mode === 1,
    support_access: row.support_access === 1,
    branding: parseBranding(row.branding),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function normalizeSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function createPlatform({ dataDir, primaryDbPath, env = process.env, projectRoot = path.resolve(__dirname, '..') }) {
  const storage = createStorage({ env, primaryDbPath, dataDir });
  storage.prepare();
  const primaryLocation = storage.primaryLocation;
  const db = storage.open(storage.controlLocation());
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','archived')),
      db_path TEXT NOT NULL UNIQUE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      demo_mode INTEGER NOT NULL DEFAULT 0,
      support_access INTEGER NOT NULL DEFAULT 0,
      branding TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_primary ON tenants(is_primary) WHERE is_primary=1;
    CREATE TABLE IF NOT EXISTS tenant_domains (
      hostname TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant ON tenant_domains(tenant_id);
    CREATE TABLE IF NOT EXISTS tenant_modules (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      entitled INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(tenant_id, module_key)
    );
    CREATE TABLE IF NOT EXISTS platform_audit (
      id INTEGER PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      tenant_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const selectBySlug = db.prepare('SELECT * FROM tenants WHERE slug=?');
  const selectById = db.prepare('SELECT * FROM tenants WHERE id=?');
  const selectPrimary = db.prepare('SELECT * FROM tenants WHERE is_primary=1');
  const selectByHost = db.prepare('SELECT t.* FROM tenant_domains d JOIN tenants t ON t.id=d.tenant_id WHERE d.hostname=?');
  const selectModuleRows = db.prepare('SELECT module_key,entitled,enabled FROM tenant_modules WHERE tenant_id=?');
  const selectModuleRow = db.prepare('SELECT entitled,enabled FROM tenant_modules WHERE tenant_id=? AND module_key=?');
  const upsertModule = db.prepare(`INSERT INTO tenant_modules(tenant_id,module_key,entitled,enabled,updated_by,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id,module_key) DO UPDATE SET entitled=excluded.entitled,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`);
  const insertAudit = db.prepare('INSERT INTO platform_audit(actor,action,tenant_id,details) VALUES(?,?,?,?)');

  const baseDomain = normalizeHostname(env.DAYBREAK_BASE_DOMAIN);

  function audit(actor, action, tenantId = null, details = null) {
    insertAudit.run(String(actor || 'system'), action, tenantId, details ? JSON.stringify(details) : null);
  }

  function tenantBySlug(slug) {
    return toTenant(selectBySlug.get(normalizeSlug(slug)));
  }

  function tenantById(id) {
    return toTenant(selectById.get(id));
  }

  function primaryTenant() {
    return toTenant(selectPrimary.get());
  }

  /** Wählt den Mandanten anhand der aufgerufenen Adresse, falls sie einem zugeordnet ist. */
  function tenantForHost(hostname) {
    const host = normalizeHostname(hostname);
    if (!host) return null;
    const mapped = toTenant(selectByHost.get(host));
    if (mapped) return mapped;
    if (baseDomain && host.endsWith(`.${baseDomain}`)) {
      const label = host.slice(0, -(baseDomain.length + 1));
      if (label && !label.includes('.') && label !== 'www') return tenantBySlug(label);
    }
    return null;
  }

  function listTenants() {
    return db.prepare('SELECT * FROM tenants ORDER BY is_primary DESC, name').all().map(toTenant);
  }

  function tenantCount() {
    return db.prepare("SELECT COUNT(*) count FROM tenants WHERE status='active'").get().count;
  }

  function domainsOf(tenantId) {
    return db.prepare('SELECT hostname FROM tenant_domains WHERE tenant_id=? ORDER BY hostname').all(tenantId).map(row => row.hostname);
  }

  /** Legt fehlende Modulzeilen an. Der Hauptmandant bekommt neue Module eingeschaltet, andere Organisationen nicht. */
  function syncModuleRows() {
    const available = catalog.availableModules(projectRoot).filter(module => !module.alwaysOn);
    const write = db.transaction(() => {
      for (const tenant of listTenants()) {
        for (const module of available) {
          if (selectModuleRow.get(tenant.id, module.key)) continue;
          const on = tenant.is_primary ? 1 : 0;
          upsertModule.run(tenant.id, module.key, on, on, 'system');
        }
      }
    });
    write();
  }

  function ensurePrimaryTenant() {
    const existing = primaryTenant();
    if (existing) {
      if (existing.db_path !== primaryLocation) {
        db.prepare('UPDATE tenants SET db_path=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(primaryLocation, existing.id);
      }
      return;
    }
    // Demo-Konten mit bekanntem Passwort entstehen nur auf ausdrücklichen Wunsch. Auch eine
    // wiederhergestellte Datenbank ohne Steuerung darf sie nie von selbst bekommen.
    const legacyInstallation = storage.exists(primaryLocation);
    const demoRequested = env.DAYBREAK_PRIMARY_DEMO === 'true';
    const name = String(env.DAYBREAK_PRIMARY_TENANT_NAME || 'Daybreak').slice(0, 120);
    const id = db.prepare('INSERT INTO tenants(slug,name,db_path,is_primary,demo_mode,support_access) VALUES(?,?,?,1,?,1)')
      .run('default', name, primaryLocation, demoRequested ? 1 : 0).lastInsertRowid;
    audit('system', 'primary_tenant_created', id, { legacyInstallation, demoMode: demoRequested });
  }

  /** Berücksichtigt Freigabe, Schalter und Abhängigkeiten. Unbekannte Module sind aus. */
  function isModuleEnabled(tenantId, key, seen = new Set()) {
    const module = catalog.getModule(key);
    if (!module || module.planned) return false;
    if (module.alwaysOn) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!catalog.isAvailable(module, projectRoot)) return false;
    const row = selectModuleRow.get(tenantId, key);
    if (!row || !row.entitled || !row.enabled) return false;
    return (module.dependsOn || []).every(dependency => isModuleEnabled(tenantId, dependency, new Set(seen)));
  }

  function moduleStates(tenantId) {
    const rows = new Map(selectModuleRows.all(tenantId).map(row => [row.module_key, row]));
    return catalog.MODULES.map(module => {
      const available = catalog.isAvailable(module, projectRoot);
      const row = rows.get(module.key);
      const files = catalog.moduleFiles(module, projectRoot);
      const enabled = isModuleEnabled(tenantId, module.key);
      return {
        key: module.key,
        name: module.name,
        area: module.area,
        description: module.description,
        dependsOn: module.dependsOn || [],
        alwaysOn: Boolean(module.alwaysOn),
        status: available ? 'available' : 'planned',
        entitled: Boolean(module.alwaysOn || row?.entitled),
        switchedOn: Boolean(module.alwaysOn || row?.enabled),
        enabled,
        assets: enabled && files ? {
          js: fs.existsSync(files.publicScriptFile) ? [files.publicScript] : [],
          css: fs.existsSync(files.publicStyleFile) ? [files.publicStyle] : []
        } : { js: [], css: [] }
      };
    });
  }

  function assertSwitchable(key) {
    const module = catalog.getModule(key);
    if (!module) throw new PlatformError('Dieses Modul gibt es nicht.', 404, 'module_unknown');
    if (module.alwaysOn) throw new PlatformError(`„${module.name}“ ist eine Grundfunktion und kann nicht abgeschaltet werden.`, 409, 'module_always_on');
    if (!catalog.isAvailable(module, projectRoot)) throw new PlatformError(`„${module.name}“ ist noch nicht verfügbar.`, 409, 'module_planned');
    return module;
  }

  function nameOf(key) {
    return catalog.getModule(key)?.name || key;
  }

  /**
   * Schalter der Organisation. Einschalten verlangt Freigabe und eingeschaltete
   * Abhängigkeiten, Abschalten verlangt, dass kein anderes aktives Modul darauf aufbaut.
   * Daten bleiben beim Abschalten erhalten.
   */
  function setModuleEnabled(tenantId, key, enabled, actor) {
    const module = assertSwitchable(key);
    const row = selectModuleRow.get(tenantId, key) || { entitled: 0, enabled: 0 };
    if (enabled) {
      if (!row.entitled) throw new PlatformError(`„${module.name}“ ist für diese Organisation nicht freigegeben.`, 403, 'module_not_entitled');
      const missing = (module.dependsOn || []).filter(dependency => !isModuleEnabled(tenantId, dependency));
      if (missing.length) throw new PlatformError(`Schalte zuerst ein: ${missing.map(nameOf).join(', ')}.`, 409, 'module_dependency_missing');
    } else {
      const dependents = catalog.dependentsOf(key).filter(dependent => isModuleEnabled(tenantId, dependent));
      if (dependents.length) throw new PlatformError(`Schalte zuerst ab: ${dependents.map(nameOf).join(', ')}.`, 409, 'module_has_dependents');
    }
    upsertModule.run(tenantId, key, row.entitled, enabled ? 1 : 0, String(actor || 'system'));
    audit(actor, enabled ? 'module_enabled' : 'module_disabled', tenantId, { module: key });
    return moduleStates(tenantId).find(state => state.key === key);
  }

  /** Freigabe durch den Betreiber. Ohne Freigabe ist das Modul sofort aus. */
  function setModuleEntitled(tenantId, key, entitled, actor) {
    assertSwitchable(key);
    const row = selectModuleRow.get(tenantId, key) || { entitled: 0, enabled: 0 };
    const keys = entitled ? [...catalog.withDependencies([key])].filter(item => !catalog.getModule(item)?.alwaysOn) : [key];
    const write = db.transaction(() => {
      for (const item of keys) {
        const current = selectModuleRow.get(tenantId, item) || { entitled: 0, enabled: 0 };
        const newlyBooked = entitled && !current.entitled;
        upsertModule.run(tenantId, item, entitled ? 1 : 0, entitled ? (newlyBooked ? 1 : current.enabled) : 0, String(actor || 'system'));
      }
    });
    write();
    audit(actor, entitled ? 'module_entitled' : 'module_entitlement_removed', tenantId, { module: key, previous: row });
    return moduleStates(tenantId).find(state => state.key === key);
  }

  /** Alles Freigegebene wieder an. Für die öffentliche Demo. */
  function resetModuleSwitches(tenantId) {
    db.prepare("UPDATE tenant_modules SET enabled=entitled,updated_by='system',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND enabled<>entitled").run(tenantId);
  }

  function validateSlug(slug) {
    if (!SLUG_PATTERN.test(slug)) throw new PlatformError('Die Firmenkennung darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten (maximal 40 Zeichen).', 400, 'slug_invalid');
    if (RESERVED_SLUGS.has(slug)) throw new PlatformError('Diese Firmenkennung ist reserviert.', 400, 'slug_reserved');
    if (selectBySlug.get(slug)) throw new PlatformError('Diese Firmenkennung ist bereits vergeben.', 409, 'slug_taken');
  }

  /** Nur der Eintrag wird hier angelegt; die Datenbank entsteht beim ersten Öffnen. */
  function createTenantRecord({ slug, name, modules = null }, actor) {
    const normalized = normalizeSlug(slug);
    validateSlug(normalized);
    const displayName = String(name || '').replace(/[<>]/g, '').trim().slice(0, 120);
    if (!displayName) throw new PlatformError('Bitte gib den Namen der Organisation an.', 400, 'name_missing');
    const dbPath = storage.tenantLocation(normalized);
    if (storage.exists(dbPath)) throw new PlatformError('Für diese Firmenkennung existiert bereits eine Datenbank.', 409, 'tenant_db_exists');
    const available = catalog.availableModules(projectRoot).filter(module => !module.alwaysOn).map(module => module.key);
    const requested = Array.isArray(modules) ? modules.filter(key => available.includes(key)) : available;
    const selected = catalog.withDependencies(requested);
    const write = db.transaction(() => {
      const id = db.prepare('INSERT INTO tenants(slug,name,db_path) VALUES(?,?,?)').run(normalized, displayName, dbPath).lastInsertRowid;
      for (const key of available) {
        const on = selected.has(key) ? 1 : 0;
        upsertModule.run(id, key, on, on, String(actor || 'system'));
      }
      audit(actor, 'tenant_created', id, { slug: normalized, modules: [...selected] });
      return id;
    });
    return tenantById(write());
  }

  function removeTenantRecord(tenantId) {
    db.prepare('DELETE FROM tenants WHERE id=? AND is_primary=0').run(tenantId);
  }

  function updateTenant(tenantId, changes, actor) {
    const tenant = tenantById(tenantId);
    if (!tenant) throw new PlatformError('Mandant nicht gefunden.', 404, 'tenant_unknown');
    const next = {
      name: tenant.name,
      status: tenant.status,
      demoMode: tenant.demo_mode,
      supportAccess: tenant.support_access,
      branding: { ...tenant.branding }
    };
    if (changes.name !== undefined) {
      if (typeof changes.name !== 'string') throw new PlatformError('Bitte gib den Namen der Organisation an.', 400, 'name_missing');
      next.name = changes.name.replace(/[<>]/g, '').trim().slice(0, 120);
      if (!next.name) throw new PlatformError('Bitte gib den Namen der Organisation an.', 400, 'name_missing');
    }
    if (changes.status !== undefined) {
      if (!TENANT_STATUSES.has(changes.status)) throw new PlatformError('Ungültiger Status.', 400, 'status_invalid');
      if (tenant.is_primary && changes.status !== 'active') throw new PlatformError('Der Hauptmandant kann nicht gesperrt werden.', 409, 'tenant_primary');
      next.status = changes.status;
    }
    if (changes.demoMode !== undefined) {
      if (typeof changes.demoMode !== 'boolean') throw new PlatformError('Ungültiger Wert für den Demo-Modus.', 400, 'value_invalid');
      if (changes.demoMode && !tenant.is_primary) throw new PlatformError('Demo-Daten sind nur im Hauptmandanten erlaubt, nicht bei anderen Organisationen.', 409, 'demo_not_allowed');
      next.demoMode = changes.demoMode;
    }
    if (changes.supportAccess !== undefined) {
      if (typeof changes.supportAccess !== 'boolean') throw new PlatformError('Ungültiger Wert für den Support-Zugriff.', 400, 'value_invalid');
      next.supportAccess = changes.supportAccess;
    }
    if (changes.primaryColor !== undefined) {
      if (changes.primaryColor && (typeof changes.primaryColor !== 'string' || !COLOR_PATTERN.test(changes.primaryColor))) throw new PlatformError('Bitte gib die Farbe im Format #RRGGBB an.', 400, 'color_invalid');
      if (changes.primaryColor) next.branding.primaryColor = changes.primaryColor;
      else delete next.branding.primaryColor;
    }
    db.prepare('UPDATE tenants SET name=?,status=?,demo_mode=?,support_access=?,branding=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(next.name, next.status, next.demoMode ? 1 : 0, next.supportAccess ? 1 : 0, JSON.stringify(next.branding), tenantId);
    audit(actor, 'tenant_updated', tenantId, {
      before: { name: tenant.name, status: tenant.status, demoMode: tenant.demo_mode, supportAccess: tenant.support_access },
      after: { name: next.name, status: next.status, demoMode: next.demoMode, supportAccess: next.supportAccess }
    });
    return tenantById(tenantId);
  }

  function addDomain(tenantId, hostname, actor) {
    const host = normalizeHostname(hostname);
    if (!HOSTNAME_PATTERN.test(host)) throw new PlatformError('Bitte gib eine gültige Adresse an, zum Beispiel hr.firma.de.', 400, 'hostname_invalid');
    if (db.prepare('SELECT hostname FROM tenant_domains WHERE hostname=?').get(host)) throw new PlatformError('Diese Adresse ist bereits vergeben.', 409, 'hostname_taken');
    db.prepare('INSERT INTO tenant_domains(hostname,tenant_id) VALUES(?,?)').run(host, tenantId);
    audit(actor, 'domain_added', tenantId, { hostname: host });
    return domainsOf(tenantId);
  }

  function removeDomain(tenantId, hostname, actor) {
    const host = normalizeHostname(hostname);
    const changed = db.prepare('DELETE FROM tenant_domains WHERE hostname=? AND tenant_id=?').run(host, tenantId).changes;
    if (!changed) throw new PlatformError('Diese Adresse ist dem Mandanten nicht zugeordnet.', 404, 'hostname_unknown');
    audit(actor, 'domain_removed', tenantId, { hostname: host });
    return domainsOf(tenantId);
  }

  function auditEntries(tenantId = null, limit = 100) {
    const rows = tenantId
      ? db.prepare('SELECT * FROM platform_audit WHERE tenant_id=? ORDER BY id DESC LIMIT ?').all(tenantId, limit)
      : db.prepare('SELECT * FROM platform_audit ORDER BY id DESC LIMIT ?').all(limit);
    return rows;
  }

  ensurePrimaryTenant();
  syncModuleRows();

  return {
    db,
    dataDir,
    storage,
    audit,
    addDomain,
    auditEntries,
    createTenantRecord,
    domainsOf,
    isModuleEnabled,
    listTenants,
    moduleStates,
    primaryTenant,
    removeDomain,
    removeTenantRecord,
    resetModuleSwitches,
    setModuleEnabled,
    setModuleEntitled,
    syncModuleRows,
    tenantById,
    tenantBySlug,
    tenantCount,
    tenantForHost,
    updateTenant,
    close: () => db.close()
  };
}

module.exports = { PlatformError, SLUG_PATTERN, createPlatform, normalizeHostname, normalizeSlug };
