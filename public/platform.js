// Mandantenverwaltung für die Systemadministration: Organisationen anlegen, Module freigeben, sperren, sichern.
(() => {
  const { api, ui } = window.loop;
  const esc = ui.esc;
  const state = { slug: null };

  const STATUS_LABEL = { active: 'Aktiv', suspended: 'Gesperrt', archived: 'Archiviert' };
  const statusTag = status => `<span class="tag ${status === 'active' ? '' : 'focus'}">${esc(STATUS_LABEL[status] || status)}</span>`;
  const openTenant = slug => { state.slug = slug; window.loop.navigate('platformTenantDetail'); };
  const reload = () => window.loop.navigate(window.loop.view);

  async function run(action, success) {
    try {
      const result = await action();
      if (success) ui.toast(success);
      return result;
    } catch (error) {
      ui.toast(error.message, 'error');
      return null;
    }
  }

  async function tenantsPage() {
    const { tenants } = await api('/api/platform/tenants');
    const rows = tenants.map(tenant => `<tr>
      <td><b>${esc(tenant.name)}</b><small>${tenant.isPrimary ? 'Hauptmandant' : esc(tenant.slug)}${tenant.demoMode ? ' · Demo' : ''}</small></td>
      <td>${statusTag(tenant.status)}</td>
      <td>${tenant.userCount === null ? '–' : esc(tenant.userCount)}</td>
      <td>${esc(tenant.enabledModules)}</td>
      <td>${tenant.domains.map(esc).join('<br>') || '–'}</td>
      <td><button class="btn" data-platform-open="${esc(tenant.slug)}">Verwalten</button></td>
    </tr>`).join('');
    return `${ui.header('Mandanten', 'Jede Organisation hat eine eigene Datenbank und eigene Module.', '<button class="btn primary" data-platform-create>+ Mandant anlegen</button>')}
      <article class="card" style="margin-top:18px"><div class="tableWrap"><table class="table">
        <thead><tr><th>Organisation</th><th>Status</th><th>Aktive Konten</th><th>Module</th><th>Adressen</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></article>`;
  }

  async function createTenantModal() {
    const { modules } = await api('/api/platform/catalog');
    const bookable = modules.filter(module => module.status === 'available' && !module.alwaysOn);
    const choices = bookable.map(module => `<label class="checkRow"><input type="checkbox" name="module_${esc(module.key)}" checked> ${esc(module.name)}</label>`).join('');
    ui.modal({
      title: 'Mandant anlegen',
      subtitle: 'Die neue Organisation startet ohne Demo-Daten.',
      submitLabel: 'Mandant anlegen',
      body: `<label>Name der Organisation</label><input name="name" required maxlength="120" placeholder="Muster GmbH">
        <label>Firmenkennung</label><input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,38}[a-z0-9]?" placeholder="muster" title="Kleinbuchstaben, Ziffern und Bindestriche">
        <label>Name der ersten Administrationsperson</label><input name="adminName" required>
        <label>E-Mail der ersten Administrationsperson</label><input name="adminEmail" type="email" required>
        <h3 style="margin-top:14px">Freigegebene Module</h3><div class="checkGrid">${choices}</div>`,
      onSubmit: async data => {
        const selected = bookable.filter(module => data[`module_${module.key}`]).map(module => module.key);
        const result = await api('/api/platform/tenants', {
          method: 'POST',
          body: JSON.stringify({ name: data.name, slug: data.slug, adminName: data.adminName, adminEmail: data.adminEmail, modules: selected })
        });
        setTimeout(() => {
          ui.modal({
            title: 'Mandant angelegt',
            subtitle: result.tenant.name,
            body: `<p>Zugang für die erste Administrationsperson. Bitte jetzt notieren und sicher weitergeben: Das Passwort wird nicht noch einmal angezeigt und muss bei der ersten Anmeldung geändert werden.</p>
              <p><b>Firmenkennung:</b> <code>${esc(result.tenant.slug)}</code><br><b>E-Mail:</b> <code>${esc(result.admin.email)}</code><br><b>Temporäres Passwort:</b> <code class="tempPassword">${esc(result.admin.temporaryPassword)}</code></p>`
          });
          reload();
        }, 0);
      }
    });
  }

  async function detailPage() {
    const { tenant, modules, audit } = await api(`/api/platform/tenants/${encodeURIComponent(state.slug)}`);
    const bookable = modules.filter(module => !module.alwaysOn);
    const moduleRows = bookable.map(module => `<tr>
      <td><b>${esc(module.name)}</b><small>${esc(module.area)}</small></td>
      <td>${module.status === 'planned' ? '<span class="tag focus">Geplant</span>' : `<label class="moduleSwitch"><input type="checkbox" data-platform-entitle="${esc(module.key)}" ${module.entitled ? 'checked' : ''} aria-label="${esc(module.name)} freigeben"><span>${module.entitled ? 'Freigegeben' : 'Nicht freigegeben'}</span></label>`}</td>
      <td>${module.status === 'planned' ? '–' : module.enabled ? '<span class="tag">An</span>' : '<span class="tag focus">Aus</span>'}</td>
    </tr>`).join('');
    const domains = tenant.domains.map(host => `<div class="row"><div class="grow"><b>${esc(host)}</b></div><button class="btn" data-platform-remove-domain="${esc(host)}">Entfernen</button></div>`).join('') || ui.empty('Noch keine eigene Adresse. Die Anmeldung läuft über die Firmenkennung.');
    const auditRows = audit.map(entry => `<div class="row"><div class="grow"><b>${esc(entry.action)}</b><small>${esc(entry.created_at)} · ${esc(entry.actor)}</small></div></div>`).join('') || ui.empty('Noch keine Einträge.');
    const actions = [];
    actions.push(tenant.supportAccess && tenant.status === 'active'
      ? '<button class="btn" data-platform-enter>Support-Zugriff öffnen</button>'
      : '<button class="btn" disabled title="Die Organisation hat den Support-Zugriff nicht freigegeben.">Kein Support-Zugriff freigegeben</button>');
    actions.push('<button class="btn" data-platform-backup>Jetzt sichern</button>');
    // Auch ohne Demo-Modus: Eine alte Demo-Datenbank kann noch Konten mit dem bekannten Passwort enthalten.
    actions.push('<button class="btn" data-platform-lock-demo>Demo-Passwörter sperren</button>');
    if (!tenant.isPrimary) {
      if (tenant.status === 'active') actions.push('<button class="btn" data-platform-status="suspended">Sperren</button>');
      else actions.push('<button class="btn" data-platform-status="active">Reaktivieren</button>');
      if (tenant.status !== 'archived') actions.push('<button class="btn" data-platform-status="archived">Archivieren</button>');
      if (tenant.status === 'archived') actions.push('<button class="btn" data-platform-delete>Endgültig löschen</button>');
    }
    return `<header class="top"><div><button class="btn" data-view="platformTenants">← Alle Mandanten</button>
        <h1 style="margin-top:14px">${esc(tenant.name)}</h1><p>Firmenkennung ${esc(tenant.slug)} · ${tenant.userCount === null ? 'Konten nicht abrufbar' : `${esc(tenant.userCount)} aktive Konten`} · ${statusTag(tenant.status)}</p></div></header>
      <section class="cards">
        <article class="card wide"><h2>Aktionen</h2><div class="platformActions">${actions.join(' ')}</div>
          ${tenant.demoMode ? '<p class="muted" style="margin-top:12px">Demo-Modus aktiv: Auf der Login-Seite stehen Demo-Knöpfe, und bekannte Demo-Passwörter funktionieren. Nicht für echte Personaldaten geeignet.</p>' : ''}</article>
      </section>
      <section class="cards">
        <article class="card wide"><h2>Freigegebene Module</h2><p class="muted">Freigegebene Module kann die Organisation selbst an- und abschalten. Eine entzogene Freigabe schaltet das Modul sofort ab; die Daten bleiben erhalten.</p>
          <div class="tableWrap"><table class="table"><thead><tr><th>Modul</th><th>Freigabe</th><th>Zustand</th></tr></thead><tbody>${moduleRows}</tbody></table></div></article>
      </section>
      <section class="cards">
        <article class="card"><h2>Eigene Adressen</h2>${domains}<form id="platformDomainForm" class="talent-form" style="margin-top:12px"><label>Neue Adresse</label><input name="hostname" placeholder="hr.firma.de" required><button class="btn">Hinzufügen</button></form></article>
        <article class="card wide"><h2>Protokoll</h2>${auditRows}</article>
      </section>`;
  }

  function confirmBySlug({ title, text, submitLabel, onConfirm }) {
    ui.modal({
      title,
      subtitle: state.slug,
      submitLabel,
      body: `<p>${esc(text)}</p><label>Zur Bestätigung die Firmenkennung eingeben</label><input name="confirmation" required autocomplete="off">`,
      onSubmit: async data => {
        await onConfirm(data.confirmation);
        setTimeout(reload, 0);
      }
    });
  }

  function bind() {
    document.querySelectorAll('[data-platform-open]').forEach(button => { button.onclick = () => openTenant(button.dataset.platformOpen); });
    document.querySelectorAll('[data-platform-create]').forEach(button => { button.onclick = () => run(createTenantModal); });
    document.querySelectorAll('[data-platform-entitle]').forEach(input => {
      input.onchange = async () => {
        await run(() => api(`/api/platform/tenants/${encodeURIComponent(state.slug)}/modules/${encodeURIComponent(input.dataset.platformEntitle)}`, { method: 'PUT', body: JSON.stringify({ entitled: input.checked }) }));
        reload();
      };
    });
    document.querySelectorAll('[data-platform-enter]').forEach(button => {
      button.onclick = async () => {
        const result = await run(() => api(`/api/platform/tenants/${encodeURIComponent(state.slug)}/enter`, { method: 'POST', body: '{}' }));
        if (result) location.reload();
      };
    });
    document.querySelectorAll('[data-platform-backup]').forEach(button => {
      button.onclick = async () => { await run(() => api(`/api/platform/tenants/${encodeURIComponent(state.slug)}/backup`, { method: 'POST', body: '{}' }), 'Sicherung erstellt.'); };
    });
    document.querySelectorAll('[data-platform-status]').forEach(button => {
      button.onclick = async () => {
        const status = button.dataset.platformStatus;
        if (status !== 'active' && !confirm('Alle Personen dieser Organisation werden sofort abgemeldet. Fortfahren?')) return;
        await run(() => api(`/api/platform/tenants/${encodeURIComponent(state.slug)}`, { method: 'PATCH', body: JSON.stringify({ status }) }), 'Status geändert.');
        reload();
      };
    });
    document.querySelectorAll('[data-platform-lock-demo]').forEach(button => {
      button.onclick = () => confirmBySlug({
        title: 'Demo-Passwörter sperren',
        text: 'Alle Konten mit dem bekannten Demo-Passwort werden unbrauchbar, und der Demo-Modus endet. Betroffene brauchen danach ein neues Passwort von HR. Das lässt sich nicht rückgängig machen.',
        submitLabel: 'Demo-Passwörter sperren',
        onConfirm: async confirmation => {
          const result = await api(`/api/platform/tenants/${encodeURIComponent(state.slug)}/lock-demo-accounts`, { method: 'POST', body: JSON.stringify({ confirmation }) });
          ui.toast(`${result.locked} Konten gesperrt.`);
        }
      });
    });
    document.querySelectorAll('[data-platform-delete]').forEach(button => {
      button.onclick = () => confirmBySlug({
        title: 'Mandant endgültig löschen',
        text: 'Die Datenbank dieser Organisation wird gelöscht. Vorher entsteht automatisch eine letzte Sicherung.',
        submitLabel: 'Endgültig löschen',
        onConfirm: async confirmation => {
          await api(`/api/platform/tenants/${encodeURIComponent(state.slug)}`, { method: 'DELETE', body: JSON.stringify({ confirmation }) });
          state.slug = null;
          setTimeout(() => window.loop.navigate('platformTenants'), 0);
        }
      });
    });
    document.querySelectorAll('[data-platform-remove-domain]').forEach(button => {
      button.onclick = async () => {
        await run(() => api(`/api/platform/tenants/${encodeURIComponent(state.slug)}/domains/${encodeURIComponent(button.dataset.platformRemoveDomain)}`, { method: 'DELETE' }), 'Adresse entfernt.');
        reload();
      };
    });
    const domainForm = document.querySelector('#platformDomainForm');
    if (domainForm) {
      domainForm.onsubmit = async event => {
        event.preventDefault();
        await run(() => api(`/api/platform/tenants/${encodeURIComponent(state.slug)}/domains`, { method: 'POST', body: JSON.stringify({ hostname: new FormData(domainForm).get('hostname') }) }), 'Adresse hinzugefügt.');
        reload();
      };
    }
  }

  window.loop.registerModule({
    key: 'platform',
    core: true,
    nav(me) {
      return me.role === 'super_admin' && window.loop.tenant?.isPrimary
        ? [{ key: 'platform', route: 'platformTenants', label: 'Mandanten', icon: 'building', views: ['platformTenants', 'platformTenantDetail'] }]
        : [];
    },
    pages: { platformTenants: tenantsPage, platformTenantDetail: detailPage },
    bind
  });
})();
