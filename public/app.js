const $=s=>document.querySelector(s),api=async(url,opts={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opts}),d=await r.json();if(!r.ok){const e=Error(d.error||'Etwas ist schiefgelaufen');e.status=r.status;e.code=d.code;throw e}const method=String(opts.method||'GET').toUpperCase();if(method!=='GET'&&!url.startsWith('/api/assistant/'))window.dispatchEvent(new CustomEvent('daybreak:mutation',{detail:{url,method,data:d}}));return d};let me,view='dashboard',selectedPersonId=null,selectedPersonCanEdit=false,expandedNavGroup=null;
const roles={employee:'Mitarbeiter:in',manager:'Führungskraft',director:'Bereichsleitung',hr_staff:'HR-Sachbearbeitung',hrbp:'HR Business Partner',hr_admin:'HR-Administration',super_admin:'Systemadministration'};
// HR-Rollen vergibt nur die HR-Administration. Der Server prüft das ebenfalls.
const assignableRoles=()=>Object.entries(roles).filter(([role])=>role!=='super_admin'&&(['hr_admin','super_admin'].includes(me.role)||(me.role==='hrbp'?!['hr_admin','hrbp','hr_staff'].includes(role):role==='employee')));
const hasTeamAccess=()=>['manager','director','hr_admin','hrbp','super_admin'].includes(me.role);
let appConfig={tenant:null,modules:[],assets:{js:[],css:[]}},publicContext=null,showInactivePeople=false;
const registeredModules=new Map();
const taskActions=[];
// Detailseiten der Module: Welche Nummer gehört in die Adresse, und wie stellt das Modul sie wieder her?
const addressHandlers={};
const isOn=key=>appConfig.modules.includes(key);
const activeRegistered=()=>[...registeredModules.values()].filter(definition=>definition.core||isOn(definition.key));
// Gemeinsame Bausteine für Fachmodule, damit alle gleich aussehen und Texte sicher ausgegeben werden.
const ui={
  esc:value=>modalEscape(value),
  /** 2026-11-05 wird zu 05.11.2026. Unbekanntes bleibt, wie es ist. */
  date(value){const match=String(value??'').match(/^(\d{4})-(\d{2})-(\d{2})/);return match?`${match[3]}.${match[2]}.${match[1]}`:String(value??'')},
  plural(count,one,many){return `${count} ${count===1?one:many}`},
  /** Zahl mit Komma, wie im Deutschen üblich. */
  number(value,digits=0){return Number(value).toLocaleString('de-DE',{minimumFractionDigits:digits,maximumFractionDigits:digits})},
  toast(message,type='success'){
    document.querySelector('.talent-toast')?.remove();
    clearTimeout(ui.toastTimer);
    document.body.insertAdjacentHTML('beforeend',`<div class="talent-toast ${type==='error'?'error':''}">${modalEscape(message)}</div>`);
    ui.toastTimer=setTimeout(()=>document.querySelector('.talent-toast')?.remove(),3800);
  },
  closeModal(){document.querySelector('#uiModal')?.remove()},
  modal({title,subtitle='',body,submitLabel='Speichern',onSubmit}){
    ui.closeModal();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="uiModal"><form class="card talent-form" id="uiModalForm"><div class="modalHead"><div><h2>${modalEscape(title)}</h2>${subtitle?`<p class="muted">${modalEscape(subtitle)}</p>`:''}</div><button type="button" class="btn" id="uiModalClose" aria-label="Schließen">×</button></div><div class="error" id="uiModalError" role="alert"></div>${body}${onSubmit?`<button class="btn primary full">${modalEscape(submitLabel)}</button>`:''}</form></div>`);
    document.querySelector('#uiModalClose').onclick=ui.closeModal;
    document.querySelector('#uiModalForm').onsubmit=async event=>{
      event.preventDefault();
      if(!onSubmit)return ui.closeModal();
      const error=document.querySelector('#uiModalError'),form=event.currentTarget;
      error.textContent='';
      await oneAtATime(form,async()=>{
        try{
          const keepOpen=await onSubmit(Object.fromEntries(new FormData(form)),form);
          if(keepOpen!==true)ui.closeModal();
        }catch(err){
          error.textContent=err.message||'Speichern nicht möglich.';
          error.scrollIntoView({block:'nearest'});
        }
      });
    };
  },
  header(title,subtitle='',actions=''){return `<header class="top"><div><h1>${modalEscape(title)}</h1>${subtitle?`<p>${modalEscape(subtitle)}</p>`:''}</div>${actions?`<div>${actions}</div>`:''}</header>`},
  stat(label,value,sub=''){return `<article class="card stat"><small>${modalEscape(label)}</small><strong>${modalEscape(value)}</strong><span class="up">${modalEscape(sub)}</span></article>`},
  empty(message){return `<p class="muted">${modalEscape(message)}</p>`},
  /** Für Suchfelder: Jedes Wort muss vorkommen, Reihenfolge, Komma und Umlaute sind egal. */
  matches:(text,query)=>matchesSearch(text,query)
};
window.loop={api,roles,ui,get me(){return me},get view(){return view},get tenant(){return appConfig.tenant},isModuleEnabled:isOn,reloadConfig:()=>loadAppConfig(),registerModule(definition){registeredModules.set(definition.key,definition)},registerTaskAction(action){taskActions.push(action)},registerAddress(handlers){Object.assign(addressHandlers,handlers)},get selectedPersonId(){return selectedPersonId},get selectedPersonCanEdit(){return selectedPersonCanEdit},openTalentProfile(id){selectedPersonId=Number(id);selectedPersonCanEdit=false;view='talent';render()},navigate(next){view=next;selectedPersonId=null;selectedPersonCanEdit=false;render()}};
function sourceNote(url){return /^https?:\/\//.test(url||'')?`<p class="sourceNote">Freie Software unter der AGPL-3.0 · <a href="${modalEscape(url)}" target="_blank" rel="noopener noreferrer">Quellcode</a></p>`:''}
function login(){
  const context=publicContext||{};
  const organization=context.tenant?.name&&context.tenant.name!=='Daybreak'?context.tenant.name:'';
  const codeField=context.tenantSelectable?`<label>Firmenkennung</label><input name="tenant" value="${modalEscape(context.organizationCode||'')}" autocomplete="organization" placeholder="Leer lassen für den Hauptzugang">`:'';
  const demo=context.demoLogins?.length?`<div class="demo"><b>Demo-Logins</b><br>${context.demoLogins.map(item=>`<button type="button" class="btn demoLogin" data-email="${modalEscape(item.email)}">${modalEscape(item.label)}</button>`).join('')}</div>`:'';
  return `<main class="auth"><section class="login"><div class="login-brand"><div class="logo" role="img" aria-label="Daybreak"></div><video class="login-brand-loop" autoplay muted loop playsinline preload="metadata" disablepictureinpicture tabindex="-1" aria-hidden="true" poster="/assets/daybreak-mark.png"><source src="/assets/daybreak-login-loop.mp4" type="video/mp4"></video></div><h1>Willkommen zurück</h1><p>${organization?modalEscape(organization):'Entwicklung, die jede Person voranbringt.'}</p><form id="login">${codeField}<label>E-Mail</label><input name="email" type="email" required autocomplete="username" placeholder="name@firma.de"><label>Passwort</label><input name="password" type="password" required autocomplete="current-password"><button class="btn primary full">Anmelden</button><div id="err" class="error"></div></form>${demo}${sourceNote(context.sourceUrl)}</section></main>`;
}
async function showLogin(){
  const organization=new URLSearchParams(location.search).get('org');
  publicContext=await fetch('/api/public/context'+(organization?'?org='+encodeURIComponent(organization):'')).then(response=>response.ok?response.json():null).catch(()=>null);
  applyBranding(publicContext?.tenant?.primaryColor);
  $('#app').innerHTML=login();
  bindLogin();
}
function applyBranding(color){
  if(/^#[0-9a-fA-F]{6}$/.test(color||''))document.documentElement.style.setProperty('--blue',color);
  else document.documentElement.style.removeProperty('--blue');
}
function loadModuleAssets(){
  for(const href of appConfig.assets.css){
    if(!document.querySelector(`link[data-module-asset="${href}"]`))document.head.insertAdjacentHTML('beforeend',`<link rel="stylesheet" href="${href}" data-module-asset="${href}">`);
  }
  return appConfig.assets.js.reduce((chain,src)=>chain.then(()=>new Promise(resolve=>{
    if(document.querySelector(`script[data-module-asset="${src}"]`))return resolve();
    const script=document.createElement('script');
    script.src=src;
    script.dataset.moduleAsset=src;
    script.onload=resolve;
    script.onerror=resolve;
    document.body.appendChild(script);
  })),Promise.resolve());
}
async function loadAppConfig(){
  appConfig=await api('/api/app/config');
  applyBranding(appConfig.tenant?.primaryColor);
  await loadModuleAssets();
}
function passwordScreen(){return `<main class="auth"><section class="login"><h1>Neues Passwort festlegen</h1><p>Dein Zugang wurde mit einem temporären Passwort angelegt. Bitte lege jetzt ein eigenes Passwort fest.</p><form id="passwordForm"><label>Temporäres Passwort</label><input name="currentPassword" type="password" required autocomplete="current-password"><label>Neues Passwort (mindestens 12 Zeichen)</label><input name="newPassword" type="password" minlength="12" required autocomplete="new-password"><button class="btn primary full">Passwort speichern</button><div id="err" class="error"></div></form><button type="button" class="btn" id="passwordLogout" style="margin-top:12px">Abmelden</button>${sourceNote(appConfig.sourceUrl)}</section></main>`}
function bindPasswordScreen(){
  $('#passwordForm').onsubmit=async event=>{
    event.preventDefault();
    try{
      await api('/api/auth/password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});
      me=(await api('/api/auth/me')).user;
      await loadAppConfig();
      render();
    }catch(error){$('#err').textContent=error.message}
  };
  $('#passwordLogout').onclick=logout;
}
async function logout(){
  document.body.classList.remove('nav-open');
  await api('/api/auth/logout',{method:'POST'});
  // Neu laden, damit keine Daten der bisherigen Person oder Organisation im Speicher des Browsers bleiben.
  location.assign(location.pathname+location.search);
}
function changePasswordModal(){
  ui.modal({title:'Passwort ändern',body:'<label>Bisheriges Passwort</label><input name="currentPassword" type="password" required autocomplete="current-password"><label>Neues Passwort (mindestens 12 Zeichen)</label><input name="newPassword" type="password" minlength="12" required autocomplete="new-password">',onSubmit:async data=>{await api('/api/auth/password',{method:'POST',body:JSON.stringify(data)});ui.toast('Passwort geändert.')}});
}
function showTemporaryPassword(person,password){
  ui.modal({title:'Startpasswort',subtitle:person,body:`<p>Gib dieses Passwort persönlich weiter. Es wird nicht noch einmal angezeigt und muss bei der ersten Anmeldung geändert werden.</p><p><code class="tempPassword" id="tempPassword">${modalEscape(password)}</code> <button type="button" class="btn" id="copyPassword">Kopieren</button></p>`});
  $('#copyPassword').onclick=async event=>{
    try{
      await navigator.clipboard.writeText(password);
      event.target.textContent='Kopiert';
    }catch{
      // Ohne HTTPS verbieten Browser das Kopieren. Dann ist der Text wenigstens markiert.
      const range=document.createRange();
      range.selectNodeContents($('#tempPassword'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      event.target.textContent='Markiert: Jetzt kopieren';
    }
  };
}
const reviewViews=['reviewDashboard','reviewPeriods','reviewList','reviewDetail','reviewSessions','reviewSessionDetail','reviewMatrix','reviewPools','reviewPoolDetail','reviewDecisions'];
const feedbackViews=['feedbackDashboard','feedbackCycles','feedbackCycleDetail','feedbackParticipant','feedbackQuestionnaires','feedbackQuestionnaire','feedbackInvitation','feedbackResult'];
const peopleViews=['talentOverview','people','hierarchy','positionProfiles','competencyCatalog'];
const isHrRole=()=>['hr_admin','hrbp','super_admin'].includes(me.role),isHrOperatorRole=()=>isHrRole()||me.role==='hr_staff',isLeadershipRole=()=>['manager','director'].includes(me.role);
const foreignTalentProfile=()=>view==='talent'&&selectedPersonId&&selectedPersonId!==me.id;
const navIcon=name=>`<svg class="navIcon" viewBox="0 0 24 24" aria-hidden="true">${({dashboard:'<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',work:'<path d="M4 8h16v11H4zM9 8V5h6v3M4 12h16M10 12v2h4v-2"/>',team:'<path d="M16 19v-1.5c0-2-1.8-3.5-4-3.5s-4 1.5-4 3.5V19M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 7.5a2.5 2.5 0 0 1 0 5M19 14c1.3.6 2 1.7 2 3v1"/>',people:'<path d="M9 19v-1.3c0-2 1.6-3.7 3.7-3.7h2.6c2 0 3.7 1.6 3.7 3.7V19M14 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 7a2.5 2.5 0 1 0 0 5M3 19v-1c0-1.7 1.3-3 3-3h1"/>',review:'<path d="M7 4h10v16H7zM9 8h6M9 12h3M13 16l1.4 1.4L18 14"/>',feedback:'<path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5"/>',reports:'<path d="M5 19V9h3v10M11 19V5h3v14M17 19v-7h3v7M3 19h18"/>',admin:'<path d="M12 3l2 2.2 3-.3.7 2.9 2.7 1.5-1.2 2.7 1.2 2.7-2.7 1.5-.7 2.9-3-.3L12 21l-2-2.2-3 .3-.7-2.9-2.7-1.5L4.8 12 3.6 9.3l2.7-1.5L7 4.9l3 .3L12 3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',org:'<path d="M9 4h6v4H9zM4 16h6v4H4zM14 16h6v4h-6zM12 8v4M7 12h10M7 12v4M17 12v4"/>',calendar:'<path d="M5 6h14v14H5zM5 10h14M9 3v4M15 3v4"/>',clock:'<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"/>',briefcase:'<path d="M4 8h16v11H4zM9 8V5h6v3M4 13h16"/>',book:'<path d="M5 5a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0-2 2zM5 5v16"/>',coins:'<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M15 9h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9"/>',tree:'<path d="M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM5 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 10v3M12 13H5v2M12 13h7v2"/>',survey:'<path d="M5 5h14v14H5zM9 9h6M9 12h6M9 15h3"/>',flag:'<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',folder:'<path d="M3 7h6l2 2h10v10H3z"/>',building:'<path d="M5 21V4h9v17M14 10h5v11M8 8h3M8 12h3M8 16h3M3 21h18"/>'})[name]||''}</svg>`;
// Sammelgruppen in der Navigation, in die sich Fachmodule einordnen können.
const NAV_GROUPS={hr:{label:'Personal',icon:'building'},time:{label:'Zeit & Abwesenheit',icon:'clock'},growth:{label:'Entwicklung',icon:'book'}};
function pluginNavItems(group){return activeRegistered().flatMap(definition=>(definition.nav?.(me)||[]).filter(item=>(item.group||'main')===group))}
function navItemActive(item){
  if(item.key==='team')return view==='team'||view==='profile'||foreignTalentProfile()&&isLeadershipRole();
  if(item.key==='people')return peopleViews.includes(view)||foreignTalentProfile()&&isHrRole()||view==='profile'&&isHrOperatorRole();
  if(item.key==='review')return reviewViews.includes(view);
  if(item.key==='feedback')return feedbackViews.includes(view);
  if(item.views?.includes(view))return true;
  return view===item.route;
}
function navigationModel(){
  const childOf=item=>({route:item.route,label:item.label,active:item.views?()=>item.views.includes(view)||view===item.route:undefined});
  const myWork=[
    ...(isOn('goals')?[{route:'goals',label:'Ziele'}]:[]),
    ...(isOn('checkins')?[{route:'checkins',label:'Check-ins'}]:[]),
    ...(isOn('talent')?[{route:'talent',label:'Talentprofil',active:()=>view==='talent'&&!foreignTalentProfile()}]:[]),
    ...(isOn('talent_review')&&!isHrRole()?[{route:'reviewSelfAssessment',label:'Selbsteinschätzung'}]:[]),
    ...(isOn('talent_review')&&!isHrRole()?[{route:'myReviewResults',label:'Meine Entwicklung'}]:[]),
    ...pluginNavItems('myWork').map(childOf)
  ];
  const groups=Object.entries(NAV_GROUPS).map(([key,group])=>({key,label:group.label,icon:group.icon,children:pluginNavItems(key).map(childOf)}));
  return [
    {key:'dashboard',route:'dashboard',label:'Übersicht',icon:'dashboard'},
    {key:'myWork',label:'Meine Arbeit',icon:'work',children:myWork},
    ...(isLeadershipRole()?[{key:'team',route:'team',label:'Mein Team',icon:'team'}]:[]),
    ...(isHrOperatorRole()?[{key:'people',route:isHrRole()&&isOn('talent')?'talentOverview':'people',label:'Mitarbeitende',icon:'people'}]:[]),
    ...(isOn('talent_review')&&['manager','director','hr_admin','hrbp','super_admin'].includes(me.role)?[{key:'review',route:'reviewDashboard',label:'Talent Review',icon:'review'}]:[]),
    ...(isOn('feedback')?[{key:'feedback',route:'feedbackDashboard',label:'360° Feedback',icon:'feedback'}]:[]),
    ...groups,
    ...pluginNavItems('main'),
    ...(isOn('reports')&&['hr_admin','hrbp','director','super_admin'].includes(me.role)?[{key:'reports',route:'reports',label:'Auswertungen',icon:'reports'}]:[]),
    {key:'administration',label:'Administration',icon:'admin',children:[...(isOn('assistant')&&isHrRole()?[{route:'dayoBacklog',label:'Dayo'}]:[]),...pluginNavItems('admin').map(childOf)]},
    ...(me.role==='super_admin'&&appConfig.automationAvailable?[{key:'automation',route:'automation',label:'Systemverwaltung',icon:'admin'}]:[]),
    ...(!isHrOperatorRole()?[{key:'organization',route:'hierarchy',label:'Organisation',icon:'org'}]:[])
  ].filter(item=>!item.children||item.children.length);
}
function renderNavigation(){return navigationModel().map(item=>{
  if(item.children){
    const childActive=item.children.some(child=>child.active?child.active():view===child.route),open=childActive||expandedNavGroup===item.key;
    return `<section class="navGroup ${open?'open':''} ${childActive?'active-parent':''}"><button type="button" class="navItem navGroupToggle" data-nav-group="${item.key}" aria-expanded="${open}" aria-controls="nav-${item.key}" ${childActive?'aria-current="page"':''}>${navIcon(item.icon)}<span>${item.label}</span><svg class="navChevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button><div class="navSubmenu" id="nav-${item.key}">${item.children.map(child=>{const active=child.active?child.active():view===child.route;return `<button type="button" data-view="${child.route}" class="navSubItem ${active?'active':''}" ${active?'aria-current="page"':''}><span>${child.label}</span></button>`}).join('')}</div></section>`;
  }
  const active=navItemActive(item);
  return `<button type="button" data-view="${item.route}" class="navItem ${active?'active':''}" ${active?'aria-current="page"':''}>${navIcon(item.icon)}<span>${item.label}</span></button>`;
}).join('')}
function moduleNavigation(){
  const tab=(route,label,active=false,extra='')=>`<button type="button" data-view="${route}" class="moduleTab ${active?'active':''} ${extra}" ${active?'aria-current="page"':''}>${label}</button>`;
  if(isHrOperatorRole()&&(peopleViews.includes(view)||foreignTalentProfile())){
    const talentTabs=isHrRole()&&isOn('talent');
    return `<nav class="moduleTabs" aria-label="Mitarbeitendenbereich">${talentTabs?tab('talentOverview','Personen',view==='talentOverview'||foreignTalentProfile()):''}${tab('people','Konten',view==='people')}${tab('hierarchy','Organisation',view==='hierarchy')}${talentTabs?tab('positionProfiles','Positionen',view==='positionProfiles')+tab('competencyCatalog','Kompetenzen',view==='competencyCatalog'):''}</nav>`;
  }
  // Beschäftigte öffnen hier nur ihr eigenes Ergebnis. Die übrigen Reiter wären für sie leer.
  if(reviewViews.includes(view)&&(isHrRole()||isLeadershipRole()))return `<nav class="moduleTabs" aria-label="Talent Review">${tab('reviewDashboard','Übersicht',view==='reviewDashboard')}${tab('reviewList','Einschätzungen',['reviewList','reviewDetail'].includes(view))}${tab('reviewSessions','Kalibrierung',['reviewSessions','reviewSessionDetail'].includes(view))}${tab('reviewMatrix','9-Box',view==='reviewMatrix')}${tab('reviewPools','Talentpools',['reviewPools','reviewPoolDetail'].includes(view))}${tab('reviewDecisions','Maßnahmen',view==='reviewDecisions')}${isHrRole()?tab('reviewPeriods','Perioden',view==='reviewPeriods','moduleTabAction'):''}</nav>`;
  if(isHrRole()&&feedbackViews.includes(view))return `<nav class="moduleTabs" aria-label="360-Grad-Feedback">${tab('feedbackDashboard','Übersicht',['feedbackDashboard','feedbackInvitation','feedbackResult'].includes(view))}${tab('feedbackCycles','Feedbackrunden',['feedbackCycles','feedbackCycleDetail','feedbackParticipant'].includes(view))}${tab('feedbackQuestionnaires','Fragebögen',['feedbackQuestionnaires','feedbackQuestionnaire'].includes(view))}</nav>`;
  for(const definition of activeRegistered()){
    const tabs=definition.tabs?.(view,me)||[];
    if(tabs.length)return `<nav class="moduleTabs" aria-label="${modalEscape(definition.label||definition.key)}">${tabs.map(item=>tab(item.route,modalEscape(item.label),Boolean(item.active))).join('')}</nav>`;
  }
  return '';
}
function addModuleNavigation(content){const tabs=moduleNavigation();if(!tabs)return content;const headerEnd=content.indexOf('</header>');return headerEnd<0?tabs+content:content.slice(0,headerEnd+9)+tabs+content.slice(headerEnd+9)}
function shell(content){
  const tenant=appConfig.tenant;
  const tenantLabel=tenant&&tenant.name!=='Daybreak'?`<small class="tenantName">${modalEscape(tenant.name)}</small>`:'';
  const supportBanner=me.role==='super_admin'&&tenant&&!tenant.isPrimary?`<div class="supportBanner" role="status"><span>Support-Zugriff auf <b>${modalEscape(tenant.name)}</b>. Dieser Zugriff wird protokolliert.</span><button type="button" class="btn" data-platform-leave>Zurück zur Mandantenverwaltung</button></div>`:'';
  const note=tenant?.demoMode?'Demo mit erfundenen Daten. Alle Besucher sehen dieselben Daten, trage nichts Persönliches ein.':'';
  return `<div class="shell"><aside class="sidebar"><div class="sidebarHeader"><div class="logo"><img src="/assets/daybreak-mark.png" alt="Daybreak"><span>Daybreak</span></div><button type="button" class="navMobileToggle" aria-expanded="false" aria-controls="primaryNavigation" aria-label="Navigation öffnen"><span></span><span></span><span></span></button></div><nav class="nav" id="primaryNavigation" aria-label="Hauptnavigation">${tenantLabel}${renderNavigation()}</nav><div class="profile"><div class="avatar">${modalEscape(initialsOf(me.name))}</div><div><b>${modalEscape(me.name)}</b><small>${roles[me.role]}</small>${me.role==='super_admin'?'':'<button id="changePassword" class="btn">Passwort ändern</button> '}<button id="logout" class="btn">Abmelden</button></div></div>${sourceNote(appConfig.sourceUrl)}</aside><main class="main">${supportBanner}${addModuleNavigation(content)}${note?`<footer class="demo-note">${note}</footer>`:''}</main></div>`;
}
function stat(label,value,sub){return `<article class="card stat"><small>${label}</small><strong>${value}</strong><span class="up">${sub}</span></article>`}

// Zielstatus in einfachen Worten.
const goalStatusLabels={on_track:'Im Plan',needs_focus:'Fokus nötig',off_track:'Gefährdet'};
const goalStatusTag=status=>`<span class="tag ${status==='on_track'?'':'focus'}">${goalStatusLabels[status]||goalStatusLabels.on_track}</span>`;
const initialsOf=name=>String(name||'').split(' ').map(part=>part[0]||'').join('');
/** Dieselbe Rechnung wie auf dem Server: nur freigegebene Ziele, gewichtet. Ohne solche Ziele kein Wert. */
function goalProgressOf(goals){
  const counted=goals.filter(goal=>goal.approval_status==='approved');
  const total=counted.reduce((sum,goal)=>sum+(Number(goal.weight)||0),0);
  return total?Math.round(counted.reduce((sum,goal)=>sum+goal.progress*(Number(goal.weight)||0),0)/total):null;
}
const percentText=value=>value===null||value===undefined?'–':value+' %';
const MONTH_NAMES=['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
/** 2026-05 wird zu „Mai 2026“. */
const monthText=value=>{const match=String(value??'').match(/^(\d{4})-(\d{2})$/);return match&&MONTH_NAMES[Number(match[2])-1]?`${MONTH_NAMES[Number(match[2])-1]} ${match[1]}`:String(value??'')};
/** Findet „Ayşe“ mit „ayse“ und „Köhler“ mit „kohler“ oder „koehler“. */
function searchForms(value){
  const text=String(value??'').toLocaleLowerCase('de-DE');
  const plain=item=>item.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/ß/g,'ss').replace(/ı/g,'i');
  return [plain(text),plain(text.replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue'))];
}
/** Jedes Wort muss vorkommen, die Reihenfolge ist egal: „Schäfer, Anna“ findet „Anna Schäfer“. */
function matchesSearch(haystack,query){
  const words=searchForms(query)[0].replace(/,/g,' ').trim().split(/\s+/).filter(Boolean);
  if(!words.length)return true;
  const forms=searchForms(haystack);
  return words.every(word=>forms.some(form=>form.includes(word)));
}
const surnameFirst=name=>{const text=String(name).trim();return text.includes(',')?text:text.split(/\s+/).reverse().join(' ')};
// Eigene Selbsteinschätzungen und Hinweise sind keine Entscheidung über andere.
const isDecisionTask=task=>/approval|review|decision|offer|requisition|proposal|calibration/.test(task.type||'')&&!/self|notice|info|finalized/.test(task.type||'');
function taskActionFor(task){
  for(const definition of activeRegistered()){const html=definition.taskAction?.(task);if(html)return html}
  for(const action of taskActions){const html=action(task);if(html)return html}
  if(task.type==='goal_approval')return `<button class="btn" data-reviewgoal="${task.entity_id}">Prüfen</button>`;
  if(task.type==='goal_acceptance')return `<button class="btn" data-respondgoal="${task.entity_id}">Antworten</button>`;
  if(['goal_revision_employee','goal_revision_manager'].includes(task.type))return `<button class="btn" data-revisegoal="${task.entity_id}">Überarbeiten</button>`;
  if(task.type==='checkin'&&task.entity_id)return `<button class="btn" data-checkin="${task.entity_id}">Öffnen</button>`;
  if(task.type==='checkin_feedback_notice')return `<button class="btn" data-checkin="${task.entity_id}">Ansehen</button> <button class="btn" data-task-done="${task.id}">Erledigt</button>`;
  if(task.type==='talent_review_self_assessment')return '<button class="btn primary" data-view="reviewSelfAssessment">Öffnen</button>';
  if(/(?:_notice|_info)$/.test(task.type||''))return `<button class="btn" data-task-done="${task.id}">Erledigt</button>`;
  return '';
}
function taskRow(task){
  const today=new Date().toISOString().slice(0,10);
  const due=task.due_date?`<small class="${task.due_date<today?'overdue':''}">${task.due_date<today?'Überfällig seit':'Fällig am'} ${modalEscape(ui.date(task.due_date))}</small>`:'';
  return `<div class="row"><div class="grow"><b>${modalEscape(task.title)}</b>${due}</div>${taskActionFor(task)}</div>`;
}

async function dashboard(){
  const goalsOn=isOn('goals'),checkinsOn=isOn('checkins'),talentOn=isOn('talent');
  const [d,talent]=await Promise.all([api('/api/dashboard'),talentOn?api('/api/talent/dashboard'):Promise.resolve(null)]);
  const decisions=d.tasks.filter(isDecisionTask),others=d.tasks.filter(task=>!isDecisionTask(task));
  const decisionCard=decisions.length?`<section class="cards"><article class="card wide"><h2>Wartet auf deine Entscheidung</h2>${decisions.map(taskRow).join('')}</article></section>`:'';
  const tasksCard=`<article class="card tasksCard${goalsOn?'':' wide'}"><h2>${decisions.length?'Weitere Aufgaben':'Offene Aufgaben'}</h2>${others.length?others.map(taskRow).join(''):decisions.length?'<p class="muted">Sonst liegt nichts an.</p>':'<p class="muted">Alles erledigt. Stark!</p>'}</article>`;
  const metricCards=[goalsOn?stat('Gesamtfortschritt',percentText(d.metrics.goalProgress),'Freigegebene Ziele, gewichtet'):'',checkinsOn?stat('Leistung',d.metrics.performance?d.metrics.performance+'/5':'–','Letzter Check-in'):'',goalsOn?stat('Im Plan',d.metrics.onTrack+' von '+d.metrics.totalGoals,'Freigegebene Ziele'):''].join('');
  const priority=d.goals[0];
  // Wer neu ist, sieht sonst nur leere Karten.
  const isNew=!d.tasks.length&&!d.goals.length&&!d.checkins.length;
  const firstSteps=isNew?`<section class="cards"><article class="card wide"><h2>Deine ersten Schritte</h2><p class="muted">Schön, dass du da bist. Noch ist hier wenig los. So fängst du am besten an:</p><div class="row"><div class="grow"><b>Trag dein Talentprofil ein</b><small>Was du kannst und wohin du möchtest.</small></div>${talentOn?'<button class="btn" data-view="talent">Öffnen</button>':''}</div>${goalsOn?'<div class="row"><div class="grow"><b>Lege dein erstes Ziel an</b><small>Deine Führungskraft stimmt es mit dir ab.</small></div><button class="btn" data-open="goal">+ Ziel anlegen</button></div>':''}<p class="muted" style="margin-top:12px">Frag Dayo unten rechts, wenn du nicht weiterweißt.</p></article></section>`:'';
  const goalCard=goalsOn?`<article class="card wide goal"><div class="ring" style="--pct:${d.metrics.goalProgress??0}"><b>${percentText(d.metrics.goalProgress)}</b></div><div><small class="muted">WICHTIGSTES ZIEL</small><h2>${modalEscape(priority?.title||'Noch kein Ziel angelegt')}</h2><p>${modalEscape(priority?.description||'Lege dein erstes Ziel für das Jahr an.')}</p><div class="bar"><span style="width:${priority?.progress||0}%"></span></div></div></article>`:'';
  const summary=talent?.summary;
  const talentCard=summary?`<section class="cards"><article class="card wide talent-hero"><div><small class="muted">TALENT & ENTWICKLUNG</small><h2>${ui.plural(summary.competencyCount,'Kompetenz','Kompetenzen')} im Profil</h2><p class="muted">${summary.competencyCount===0?'Trage zuerst ein, was du kannst. Deine Führungskraft kann es dann einschätzen.':summary.missingManagerCount?ui.plural(summary.missingManagerCount,'Kompetenzbewertung wartet','Kompetenzbewertungen warten')+' auf deine Führungskraft.':'Dein Kompetenzprofil ist aktuell bewertet.'}</p><div class="talent-chips"><span class="tag">${ui.plural(summary.developmentGoalCount,'offenes Entwicklungsziel','offene Entwicklungsziele')}</span>${summary.targetPosition?`<span class="tag">Ziel: ${modalEscape(summary.targetPosition)}</span>`:''}</div></div><div class="talent-fit"><b>${summary.positionFit===null?'–':summary.positionFit+' %'}</b><small>Abdeckung der Positionsanforderungen</small><button class="btn primary" data-view="talent">Talentprofil öffnen</button></div></article></section>`:'';
  const historyCards=[checkinsOn&&d.checkins.length?`<article class="card wide"><h2>Check-in-Verlauf</h2>${d.checkins.map(c=>`<div class="row"><div class="avatar">${modalEscape(initialsOf(c.manager_name))}</div><div class="grow"><b>${modalEscape(monthText(c.period))} · ${modalEscape(c.manager_name)}</b><small>Leistung ${c.performance}/5 · ${modalEscape(c.summary.slice(0,85))}${c.summary.length>85?'…':''}</small></div>${goalStatusTag(c.on_track)}<button class="btn" data-checkin="${c.id}">Ansehen</button></div>`).join('')}</article>`:'',goalsOn&&d.goals.length?`<article class="card"><h2>Ziele im Überblick</h2>${d.goals.map(g=>`<div class="row"><div class="grow"><b>${modalEscape(g.title)}</b><div class="bar" style="margin-top:7px"><span style="width:${g.progress}%"></span></div></div><b>${g.progress} %</b></div>`).join('')}</article>`:''].join('');
  return `<header class="top"><div><h1>Hallo, ${modalEscape(me.name.split(' ')[0])} ✨</h1><p>Deine Aufgaben und Ziele auf einen Blick.</p></div>${goalsOn?'<button class="btn primary" data-open="goal">+ Ziel anlegen</button>':''}</header>${decisionCard}${firstSteps}<div class="dashboardFlow">${metricCards?`<section class="cards">${metricCards}</section>`:''}<section class="cards dashboardMain">${goalCard}${tasksCard}</section></div>${talentCard}${historyCards?`<section class="cards">${historyCards}</section>`:''}`;
}
async function goals(){
  const d=await api('/api/goals');
  const approvalLabels={approved:'Freigegeben',pending_manager_approval:'Wartet auf deine Führungskraft',pending_employee_acceptance:'Wartet auf deine Antwort',changes_requested_by_manager:'Überarbeitung nötig',changes_requested_by_employee:'Wartet auf deine Führungskraft'};
  const totalWeight=d.goals.filter(goal=>goal.approval_status==='approved').reduce((sum,goal)=>sum+(Number(goal.weight)||0),0);
  const weightHint=totalWeight&&totalWeight!==100?`<p class="muted" style="margin-top:12px">Die Gewichte deiner freigegebenen Ziele ergeben zusammen ${totalWeight} %. Das geht in die Rechnung ein, üblich sind 100 %.</p>`:'';
  const action=goal=>goal.approval_status==='pending_employee_acceptance'?`<button class="btn primary" style="float:right" data-respondgoal="${goal.id}">Antworten</button>`:goal.approval_status==='changes_requested_by_manager'?`<button class="btn primary" style="float:right" data-revisegoal="${goal.id}">Überarbeiten</button>`:goal.approval_status==='approved'?`<button class="btn" style="float:right" data-editgoal="${goal.id}">Fortschritt</button>`:'';
  const withdraw=goal=>goal.approval_status==='approved'||goal.created_by!==me.id?'':`<button class="btn" style="float:right;margin-right:6px" data-withdrawgoal="${goal.id}" data-goal-title="${modalEscape(goal.title)}">Zurückziehen</button>`;
  const card=goal=>`<article class="card"><h2>${modalEscape(goal.title)}</h2><p class="muted">${modalEscape(goal.description||'')}</p><div class="bar" style="margin:16px 0 8px"><span style="width:${goal.progress}%"></span></div><b>${goal.progress} %</b> · ${goalStatusTag(goal.status)} <span class="tag ${goal.approval_status==='approved'?'':'focus'}">${approvalLabels[goal.approval_status]||'Freigabe ausstehend'}</span><p class="muted" style="margin-top:10px">Gewicht ${modalEscape(goal.weight)} %${goal.due_date?` · bis ${modalEscape(ui.date(goal.due_date))}`:''}</p>${goal.manager_comment?`<p class="muted" style="margin-top:11px"><b>Kommentar:</b> ${modalEscape(goal.manager_comment)}</p>`:''}${action(goal)}${withdraw(goal)}</article>`;
  return `<header class="top"><div><h1>Meine Ziele</h1><p>Was du erreichen willst. Freigegebene Ziele zählen in deinen Fortschritt.</p></div><button class="btn primary" data-open="goal">+ Ziel anlegen</button></header>${weightHint}<section class="cards">${d.goals.map(card).join('')||'<p class="muted">Noch keine Ziele angelegt.</p>'}</section>`;
}
async function checkins(){
  const canWrite=['manager','director','hr_admin','hrbp','super_admin'].includes(me.role);
  const [d,written]=await Promise.all([api('/api/checkins'),canWrite?api('/api/checkins?author=me'):Promise.resolve({checkins:[]})]);
  const row=(c,who)=>`<div class="row"><div class="grow"><b>${modalEscape(monthText(c.period))} · ${modalEscape(who)}</b><small>${modalEscape(c.summary.slice(0,120))}${c.summary.length>120?'…':''}</small></div><span class="tag">${c.performance}/5</span><button class="btn" data-checkin="${c.id}">Öffnen</button></div>`;
  const writtenCard=canWrite?`<article class="card wide"><h2>Von dir erfasst</h2>${written.checkins.map(c=>row(c,c.employee_name)).join('')||'<p class="muted">Du hast noch keinen Check-in erfasst.</p>'}</article>`:'';
  return `<header class="top"><div><h1>Check-ins</h1><p>Kurze, regelmäßige Gespräche mit deiner Führungskraft, festgehalten in wenigen Sätzen.</p></div>${canWrite?'<button class="btn primary" data-open="checkin">+ Check-in erfassen</button>':''}</header><section class="cards"><article class="card wide"><h2>Deine Gespräche</h2>${d.checkins.map(c=>row(c,c.manager_name)).join('')||'<p class="muted">Noch keine Check-ins.</p>'}</article>${writtenCard}<article class="card"><h2>So funktioniert es</h2><p class="muted">Die Führungskraft hält das Gespräch fest. Du liest es, kommentierst und bewertest die Zusammenfassung mit Sternen.</p></article></section>`;
}
async function team(){
  const talentOn=isOn('talent');
  const [d,talent]=await Promise.all([api('/api/team'),talentOn?api('/api/talent/manager-dashboard'):Promise.resolve(null)]);
  const talentCard=talent?`<section class="cards"><article class="card wide"><small class="muted">TALENT IM DIREKTEN TEAM</small><h2>${ui.plural(talent.missingManagerCount,'offene Kompetenzbewertung','offene Kompetenzbewertungen')}</h2><p class="muted">${ui.plural(talent.highGapCount,'große Kompetenzlücke','große Kompetenzlücken')} · ${ui.plural(talent.openDevelopmentGoals,'offenes Entwicklungsziel','offene Entwicklungsziele')}. Öffne dazu das Talentprofil der jeweiligen Person.</p></article></section>`:'';
  const card=x=>`<article class="card"><div class="avatar">${modalEscape(initialsOf(x.name))}</div><h2 style="margin-top:10px">${modalEscape(x.name)}</h2><p class="muted">${modalEscape(x.title||roles[x.role])}</p><span class="tag ${x.direct?'':'focus'}">${x.direct?'Direkt':'Indirekt'}</span>${isOn('goals')?`<div class="bar" style="margin:14px 0 7px"><span style="width:${x.progress??0}%"></span></div><b>${x.progress===null?'Noch keine freigegebenen Ziele':x.progress+' % Ziele'}</b>`:''}${isOn('checkins')?`<small class="muted"> · Letzter Check-in ${x.performance?x.performance+'/5':'–'}</small>`:''}<div class="cardActions"><button class="btn" data-person="${x.id}" data-can-edit="${x.canEdit}">Öffnen</button>${talentOn?` <button class="btn" data-talent-person="${x.id}">Talentprofil</button>`:''}</div></article>`;
  return `<header class="top"><div><h1>Mein Team</h1><p>${ui.plural(d.team.length,'Person','Personen')} in deiner Führungslinie. Direkte Teammitglieder kannst du bearbeiten, indirekte nur lesen.</p></div></header>${talentCard}<section class="cards">${d.team.map(card).join('')||'<article class="card"><p class="muted">Dir sind noch keine Mitarbeitenden zugeordnet.</p></article>'}</section>`;
}
async function profile(){
  const goalsOn=isOn('goals'),checkinsOn=isOn('checkins');
  // Über eine gemerkte Adresse fehlt der Klick, der die Rechte mitbringt.
  if(!selectedPersonCanEdit&&hasTeamAccess())selectedPersonCanEdit=Boolean((await api('/api/team')).team.find(person=>person.id===selectedPersonId)?.canEdit);
  const users=(await api('/api/users')).users,person=users.find(u=>u.id==selectedPersonId),goals=goalsOn?(await api('/api/goals?userId='+selectedPersonId)).goals:[],checkins=checkinsOn?(await api('/api/checkins?userId='+selectedPersonId)).checkins:[];
  if(!person)throw Error('Person nicht gefunden');
  const actions=selectedPersonCanEdit?`<div>${goalsOn?'<button class="btn" data-open="goal">+ Ziel anlegen</button> ':''}${checkinsOn?'<button class="btn primary" data-open="checkin">+ Check-in erfassen</button>':''}</div>`:'<span class="tag">Nur lesen</span>';
  const approvalTag=goal=>goal.approval_status==='approved'?'':'<span class="tag focus">Noch nicht freigegeben</span>';
  const stats=[goalsOn?stat('Zielerreichung',percentText(goalProgressOf(goals)),'Freigegebene Ziele, gewichtet'):'',checkinsOn?stat('Leistung',checkins[0]?checkins[0].performance+'/5':'–','Letzter Check-in'):'',checkinsOn?stat('Check-ins',checkins.length,'Festgehaltene Gespräche'):''].join('');
  const cards=[goalsOn?`<article class="card wide"><h2>Ziele</h2>${goals.map(g=>`<div class="row"><div class="grow"><b>${modalEscape(g.title)}</b><small>Gewicht ${modalEscape(g.weight)} %${g.due_date?` · bis ${modalEscape(ui.date(g.due_date))}`:''}${g.description?` · ${modalEscape(g.description)}`:''}</small><div class="bar" style="margin-top:7px"><span style="width:${g.progress}%"></span></div></div><b>${g.progress} %</b>${goalStatusTag(g.status)}${approvalTag(g)}${selectedPersonCanEdit?`<button class="btn" data-withdrawgoal="${g.id}" data-goal-title="${modalEscape(g.title)}">Entfernen</button>`:''}</div>`).join('')||'<p class="muted">Noch keine Ziele angelegt.</p>'}</article>`:'',checkinsOn?`<article class="card"><h2>Check-in-Verlauf</h2>${checkins.map(c=>`<div class="row"><div class="grow"><b>${modalEscape(monthText(c.period))}</b><small>Leistung ${c.performance}/5${c.acknowledged_at?' · bestätigt':' · noch nicht bestätigt'}</small></div>${goalStatusTag(c.on_track)}<button class="btn" data-checkin="${c.id}">Öffnen</button></div>`).join('')||'<p class="muted">Noch keine Check-ins.</p>'}</article>`:''].join('');
  const back=isHrOperatorRole()?'<button class="btn" data-view="people">← Konten</button>':'<button class="btn" data-view="team">← Mein Team</button>';
  return `<header class="top"><div>${back}<h1 style="margin-top:14px">${modalEscape(person.name)}</h1><p>${person.title?`${modalEscape(person.title)} · `:''}${roles[person.role]}</p></div>${actions}</header>${stats?`<section class="cards">${stats}</section>`:''}${cards?`<section class="cards">${cards}</section>`:''}`;
}
function personNode(user,users){return `<li><span class="person"><span class="avatar">${modalEscape(initialsOf(user.name))}</span><span><b>${modalEscape(user.name)}</b><small>${user.title?`${modalEscape(user.title)} · `:''}${roles[user.role]}</small></span></span><ul>${users.filter(item=>item.manager_id===user.id).map(item=>personNode(item,users)).join('')}</ul></li>`}
async function hierarchy(){
  const d=await api('/api/hierarchy'),known=new Set(d.users.map(user=>user.id));
  const root=d.rootId?d.users.find(user=>user.id===d.rootId):null;
  const description=d.context==='team'?'Deine Führungskraft und Kolleg:innen auf derselben Ebene.':root?'Dein Organisationsbereich mit allen Ebenen darunter.':'Wer wem berichtet, über alle Ebenen.';
  // Wessen Führungskraft nicht mehr aktiv ist, steht oben, statt zu verschwinden.
  const roots=root?[root]:d.users.filter(user=>!user.manager_id||!known.has(user.manager_id));
  const orphaned=!root&&roots.some(user=>user.manager_id)?'<p class="muted">Bei einigen Personen fehlt eine aktive Führungskraft. Sie stehen hier auf der obersten Ebene.</p>':'';
  return `<header class="top"><div><h1>Organisation</h1><p>${description}</p></div></header><article class="card tree" style="margin-top:24px">${orphaned}<ul>${roots.map(user=>personNode(user,d.users)).join('')}</ul></article>`;
}
async function reports(){
  const d=await api('/api/reports/overview'),goalsOn=isOn('goals'),checkinsOn=isOn('checkins');
  const number=value=>value===null||value===undefined?'–':ui.number(value,1)+'/5';
  return `<header class="top"><div><h1>Auswertungen</h1><p>Überblick für HR und Bereichsleitung. Zielerreichung: freigegebene Ziele, gewichtet.</p></div></header><article class="card" style="margin-top:24px"><div class="tableWrap"><table class="table"><thead><tr><th>Name</th><th>Rolle</th>${goalsOn?'<th>Zielerreichung</th>':''}${checkinsOn?'<th>Leistung im Schnitt</th><th>Check-ins</th>':''}</tr></thead><tbody>${d.rows.map(r=>`<tr><td><b>${modalEscape(r.name)}</b><small>${modalEscape(r.title||'–')}</small></td><td>${roles[r.role]}</td>${goalsOn?`<td>${percentText(r.progress)}</td>`:''}${checkinsOn?`<td>${number(r.performance)}</td><td>${r.checkins}</td>`:''}</tr>`).join('')}</tbody></table></div></article>`;
}
async function people(){
  const d=await api('/api/users'+(showInactivePeople?'?includeInactive=true':'')),byId=Object.fromEntries(d.users.map(x=>[x.id,x])),talentOn=isOn('talent')&&isHrRole();
  const sorted=[...d.users].sort((a,b)=>surnameFirst(a.name).localeCompare(surnameFirst(b.name),'de'));
  const actions=u=>{
    const name=modalEscape(u.name);
    const parts=[];
    if(talentOn)parts.push(`<button class="btn" data-talent-person="${u.id}">Talentprofil</button>`);
    if(isHrRole()&&u.id!==me.id&&u.canAssign)parts.push(`<button class="btn" data-person="${u.id}" data-can-edit="true">Ziele & Gespräche</button>`);
    if(u.canManage&&!u.protected)parts.push(`<button class="btn" data-edit-account="${u.id}">Bearbeiten</button>`);
    if(u.canAssign)parts.push(`<button class="btn" data-assign="${u.id}">Zuordnen</button>`);
    if(u.canManage&&!u.protected)parts.push(`<button class="btn" data-reset-password="${u.id}" data-person-name="${name}">Passwort zurücksetzen</button>`,`<button class="btn" data-toggle-active="${u.id}" data-active="${u.active===0?'0':'1'}" data-person-name="${name}" data-leads="${d.users.filter(x=>x.manager_id===u.id&&x.active!==0).length}">${u.active===0?'Entsperren':'Sperren'}</button>`);
    if(u.protected)parts.push('<span class="tag" title="Dieser Zugang steht auf der Anmeldeseite und bleibt in der Demo unverändert.">Demo-Zugang</span>');
    return parts.join(' ');
  };
  const row=u=>`<tr data-people-row data-search="${modalEscape(`${u.name} ${u.email} ${u.title||''} ${roles[u.role]||''}`)}"${u.active===0?' class="rowInactive"':''}><td data-label="Name"><b>${modalEscape(u.name)}</b><small>${modalEscape(u.title||'–')}${u.active===0?' · gesperrt':''}</small></td><td data-label="E-Mail">${modalEscape(u.email)}</td><td data-label="Rolle">${roles[u.role]}</td><td data-label="Führungskraft">${u.manager_id?modalEscape(byId[u.manager_id]?.name||'–'):'Keine (oberste Ebene)'}</td><td class="peopleActions">${actions(u)}</td></tr>`;
  return `<header class="top"><div><h1>Mitarbeitende</h1><p>Konten anlegen, ändern und zuordnen, Passwörter zurücksetzen.</p></div><div><button class="btn" data-people-export>Liste herunterladen</button> <button class="btn" data-people-import>Importieren</button> <button class="btn primary" data-open="person">+ Person anlegen</button></div></header><article class="card" style="margin-top:18px"><div class="sectionHead"><div><h2>Konten und Organisationszuordnung</h2><p class="muted">Gesperrte Konten können sich nicht anmelden und erscheinen nicht mehr in Listen.</p></div><button type="button" class="btn" data-toggle-inactive-list>${showInactivePeople?'Gesperrte ausblenden':'Gesperrte anzeigen'}</button></div><div class="peopleSearch"><input type="search" data-people-search placeholder="Name, E-Mail, Position oder Rolle suchen" aria-label="Personen suchen" autocomplete="off"><small class="muted" data-people-count aria-live="polite">${ui.plural(sorted.length,'Person','Personen')}</small></div><div class="tableWrap"><table class="table peopleTable"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Führungskraft</th><th></th></tr></thead><tbody>${sorted.map(row).join('')}</tbody></table></div></article>`;
}
// Jede Ansicht hat eine eigene Adresse: Zurück, Neuladen und Lesezeichen funktionieren.
let restoringAddress=false,skipNextPop=false,scrollBeforeRender=0,renderTicket=0;
const addressItem=()=>addressHandlers[view]?addressHandlers[view].get():selectedPersonId;
const addressNow=()=>'#/'+view+(addressItem()?'/'+addressItem():'');
/** Nimmt die Nummer aus der Adresse: Sie gehört entweder zur Detailseite eines Moduls oder ist eine Person. */
function applyAddressItem(id){
  const handler=addressHandlers[view];
  if(!handler){selectedPersonId=id;return}
  selectedPersonId=null;
  handler.set(id);
}
function syncAddress(){
  const target=addressNow(),state={view,selectedPersonId,selectedPersonCanEdit,item:addressItem()??null};
  if(location.hash===target){history.replaceState({...(history.state||{}),...state},'');return}
  history.replaceState({...(history.state||{}),scrollY:scrollBeforeRender},'');
  history.pushState(state,'',target);
  window.scrollTo(0,0);
}
function readAddress(){
  const match=location.hash.match(/^#\/([A-Za-z]+)(?:\/(\d+))?$/);
  return match?{view:match[1],selectedPersonId:match[2]?Number(match[2]):null}:null;
}
window.addEventListener('popstate',async event=>{
  if(!me)return;
  if(skipNextPop){skipNextPop=false;return}
  // Zurück schließt zuerst den offenen Dialog und bleibt auf der Seite.
  const openDialog=document.querySelector('.modal');
  if(openDialog){
    skipNextPop=true;
    history.go(1);
    dialogCloseButton(openDialog)?.click();
    return;
  }
  const target=event.state||readAddress()||{view:'dashboard',selectedPersonId:null};
  view=target.view;
  applyAddressItem(target.item??target.selectedPersonId??null);
  selectedPersonCanEdit=Boolean(target.selectedPersonCanEdit);
  expandedNavGroup=null;
  await render();
  window.scrollTo(0,event.state?.scrollY||0);
});
/** Seiten, die nur bestimmte Rollen öffnen. Die Daten schützt der Server, hier geht es um keine halben Seiten. */
function viewAllowed(){
  const hr=isHrRole,rules={people:isHrOperatorRole,talentOverview:hr,positionProfiles:hr,competencyCatalog:hr,reviewPeriods:hr,dayoBacklog:hr,team:hasTeamAccess,reports:()=>['hr_admin','hrbp','director','super_admin'].includes(me.role)};
  if(rules[view]&&!rules[view]())return false;
  return activeRegistered().every(definition=>definition.allowed?.(view,me)!==false);
}
async function render(){
  const ticket=++renderTicket;
  scrollBeforeRender=window.scrollY;
  try{
    if(me?.must_change_password){
      $('#app').innerHTML=passwordScreen();
      bindPasswordScreen();
      return;
    }
    if(!viewAllowed()){
      view='dashboard';selectedPersonId=null;selectedPersonCanEdit=false;
      ui.toast('Diese Seite steht dir nicht zur Verfügung.','error');
    }
    const builtIn={automation:()=>window.automationPages.page(),dashboard,goals,checkins,team,profile,hierarchy,reports,people,dayoBacklog:()=>window.dayoAdminPages.backlog(),talent:()=>window.talentPages.profile(),talentOverview:()=>window.talentPages.overview(),competencyCatalog:()=>window.talentPages.competencies(),positionProfiles:()=>window.talentPages.positions(),reviewDashboard:()=>window.talentReviewPages.dashboard(),reviewPeriods:()=>window.talentReviewPages.periods(),reviewList:()=>window.talentReviewPages.reviews(),reviewDetail:()=>window.talentReviewPages.reviewDetail(),reviewSelfAssessment:()=>window.talentReviewPages.selfAssessment(),reviewSessions:()=>window.talentReviewPages.sessions(),reviewSessionDetail:()=>window.talentReviewPages.sessionDetail(),reviewMatrix:()=>window.talentReviewPages.matrix(),reviewPools:()=>window.talentReviewPages.pools(),reviewPoolDetail:()=>window.talentReviewPages.poolDetail(),reviewDecisions:()=>window.talentReviewPages.decisions(),myReviewResults:()=>window.talentReviewPages.myResults()};
    const page=Object.assign({},builtIn,...activeRegistered().map(definition=>definition.pages||{}))[view];
    if(!page)throw Error('Ansicht nicht verfügbar');
    const content=await page();
    // Bei schnellem Klicken zählt nur die zuletzt gewählte Seite.
    if(ticket!==renderTicket)return;
    const menuPosition=document.querySelector('.nav')?.scrollTop||0;
    $('#app').innerHTML=shell(content);
    bind();
    keepNavigationInView(menuPosition);
    if(!hasTeamAccess())document.querySelector('[data-view="team"]')?.remove();
    restoringAddress=false;
    syncAddress();
  }catch(e){
    if(ticket!==renderTicket)return;
    if(e.status===401){await showLogin();return}
    if(e.code==='password_change_required'){me={...me,must_change_password:1};return render()}
    if(e.code==='tenant_suspended'){await showLogin();return}
    // Eine gemerkte Adresse kann ins Leere zeigen, zum Beispiel auf einen Vorgang von gestern.
    if(restoringAddress){restoringAddress=false;view='dashboard';selectedPersonId=null;return render()}
    $('#app').innerHTML=shell(`<section class="card" style="margin-top:24px"><h1>Ansicht nicht verfügbar</h1><p class="muted">${e.code==='module_disabled'?'Dieses Modul ist für deine Organisation nicht aktiviert.':'Du hast keinen Zugriff auf diese Ansicht oder die Daten stehen derzeit nicht zur Verfügung.'}</p><button class="btn primary" data-view="dashboard">Zur Übersicht</button></section>`);
    bind();
    syncAddress();
  }
}
function bindShellNavigation(){
  document.querySelectorAll('[data-nav-group]').forEach(button=>button.onclick=()=>{
    const key=button.dataset.navGroup,willOpen=button.getAttribute('aria-expanded')!=='true';
    expandedNavGroup=willOpen?key:null;
    document.querySelectorAll('.navGroup').forEach(group=>{const toggle=group.querySelector('[data-nav-group]'),open=willOpen&&toggle?.dataset.navGroup===key;group.classList.toggle('open',open);toggle?.setAttribute('aria-expanded',String(open))});
  });
  const mobileToggle=document.querySelector('.navMobileToggle'),sidebar=document.querySelector('.sidebar');
  if(mobileToggle&&sidebar)mobileToggle.onclick=()=>{const open=sidebar.classList.toggle('mobile-open');document.body.classList.toggle('nav-open',open);mobileToggle.setAttribute('aria-expanded',String(open));mobileToggle.setAttribute('aria-label',open?'Navigation schließen':'Navigation öffnen')};
}
/** Das Menü bleibt, wo es war, und der aktive Reiter steht im Bild. */
function keepNavigationInView(menuPosition){
  const menu=document.querySelector('.nav');
  if(menu){
    menu.scrollTop=menuPosition;
    menu.querySelector('.active[aria-current="page"]')?.scrollIntoView({block:'nearest'});
  }
  const tab=document.querySelector('.moduleTabs .moduleTab.active');
  if(tab){
    const bar=tab.parentElement;
    bar.scrollLeft=tab.offsetLeft-bar.offsetLeft-(bar.clientWidth-tab.offsetWidth)/2;
  }
}
/** Knöpfe, die erst Daten laden: Geht das schief, soll man es sehen. */
const showingErrors=work=>Promise.resolve().then(work).catch(error=>ui.toast(error.message||'Das hat nicht geklappt.','error'));
/** Dialoge laden erst Daten. Ein zweiter Klick währenddessen öffnet keinen zweiten Dialog. */
let dialogOpening=false;
function openingDialog(work){
  if(dialogOpening)return;
  dialogOpening=true;
  showingErrors(work).finally(()=>{dialogOpening=false});
}
function bind(){
  bindShellNavigation();
  window.automationPages?.bind?.();
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{document.body.classList.remove('nav-open');expandedNavGroup=null;view=button.dataset.view;if(view==='talent'){selectedPersonId=null;selectedPersonCanEdit=false}else if(view!=='profile'){selectedPersonId=null;selectedPersonCanEdit=false}render()});
  $('#logout').onclick=logout;
  if($('#changePassword'))$('#changePassword').onclick=changePasswordModal;
  document.querySelectorAll('[data-platform-leave]').forEach(button=>button.onclick=async()=>{try{await api('/api/platform/tenants/default/enter',{method:'POST',body:'{}'});location.reload()}catch(error){ui.toast(error.message,'error')}});
  document.querySelectorAll('[data-reset-password]').forEach(button=>button.onclick=async()=>{
    if(!confirm(`Passwort von ${button.dataset.personName} zurücksetzen? Die Person wird abgemeldet.`))return;
    try{const result=await api('/api/users/'+button.dataset.resetPassword+'/password',{method:'POST',body:'{}'});showTemporaryPassword(button.dataset.personName,result.temporaryPassword)}catch(error){ui.toast(error.message,'error')}
  });
  document.querySelectorAll('[data-toggle-active]').forEach(button=>button.onclick=async()=>{
    const lock=button.dataset.active==='1',leads=Number(button.dataset.leads||0),name=button.dataset.personName;
    const leadWarning=leads?` Die Person führt ${ui.plural(leads,'Person','Personen')}. Deren offene Anträge und Aufgaben bleiben liegen, bis du sie unter „Zuordnen“ einer anderen Führungskraft gibst.`:'';
    if(lock&&!confirm(`${name} sperren? Die Person verliert sofort den Zugang.${leadWarning}`))return;
    try{
      const result=await api('/api/users/'+button.dataset.toggleActive+'/active',{method:'PATCH',body:JSON.stringify({active:!lock})});
      await render();
      ui.toast(lock?(result.directReports?`${name} ist gesperrt. Ordne jetzt ${ui.plural(result.directReports,'Person','Personen')} neu zu.`:`${name} ist gesperrt.`):`${name} ist wieder entsperrt.`);
    }catch(error){ui.toast(error.message,'error')}
  });
  document.querySelectorAll('[data-toggle-inactive-list]').forEach(button=>button.onclick=()=>{showInactivePeople=!showInactivePeople;render()});
  document.querySelectorAll('[data-edit-account]').forEach(button=>button.onclick=()=>openingDialog(()=>editAccount(button.dataset.editAccount)));
  document.querySelectorAll('[data-task-done]').forEach(button=>button.onclick=async()=>{try{await api('/api/tasks/'+button.dataset.taskDone+'/done',{method:'POST',body:'{}'});render()}catch(error){ui.toast(error.message,'error')}});
  document.querySelectorAll('[data-people-export]').forEach(button=>button.onclick=exportPeople);
  document.querySelectorAll('[data-people-search]').forEach(input=>input.oninput=()=>{
    let visible=0;
    document.querySelectorAll('[data-people-row]').forEach(row=>{const show=matchesSearch(row.dataset.search,input.value);row.hidden=!show;if(show)visible+=1});
    document.querySelector('[data-people-count]').textContent=ui.plural(visible,'Person','Personen');
  });
  document.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>openingDialog(()=>modal(button.dataset.open)));
  document.querySelectorAll('[data-checkin]').forEach(button=>button.onclick=()=>openingDialog(()=>showCheckin(button.dataset.checkin)));
  document.querySelectorAll('[data-editgoal]').forEach(button=>button.onclick=()=>openingDialog(()=>editGoal(button.dataset.editgoal)));
  document.querySelectorAll('[data-reviewgoal]').forEach(button=>button.onclick=()=>openingDialog(()=>reviewGoal(button.dataset.reviewgoal)));
  document.querySelectorAll('[data-respondgoal]').forEach(button=>button.onclick=()=>openingDialog(()=>respondGoal(button.dataset.respondgoal)));
  document.querySelectorAll('[data-revisegoal]').forEach(button=>button.onclick=()=>openingDialog(()=>reviseGoal(button.dataset.revisegoal)));
  document.querySelectorAll('[data-withdrawgoal]').forEach(button=>button.onclick=()=>showingErrors(async()=>{
    if(!confirm(`Das Ziel „${button.dataset.goalTitle}“ wirklich entfernen?`))return;
    await api('/api/goals/'+button.dataset.withdrawgoal,{method:'DELETE'});
    await render();
    ui.toast('Ziel entfernt.');
  }));
  document.querySelectorAll('[data-person]').forEach(button=>button.onclick=()=>{selectedPersonId=Number(button.dataset.person);selectedPersonCanEdit=button.dataset.canEdit==='true';view='profile';render()});
  document.querySelectorAll('[data-assign]').forEach(button=>button.onclick=()=>openingDialog(()=>assignManager(button.dataset.assign)));
  window.talentBind?.();window.talentReviewBind?.();window.dayoAdminBind?.();
  for(const definition of activeRegistered())definition.bind?.();
}
/** Läuft schon eine Speicherung, passiert beim zweiten Tippen nichts. */
async function oneAtATime(form,work){
  if(form.dataset.saving)return;
  form.dataset.saving='1';
  const button=form.querySelector('button.primary');
  if(button)button.disabled=true;
  try{
    await work();
  }finally{
    delete form.dataset.saving;
    if(button)button.disabled=false;
  }
}
/** Für Formulare in eigenen Dialogen: Fehler erscheinen im Dialog, nach Erfolg schließt er. */
function submitDialog(selector,work,successMessage){
  const form=$(selector);
  const error=document.createElement('div');
  error.className='error';
  error.setAttribute('role','alert');
  form.querySelector('.modalHead').after(error);
  form.onsubmit=event=>{
    event.preventDefault();
    error.textContent='';
    const values=Object.fromEntries(new FormData(form));
    return oneAtATime(form,async()=>{
      try{
        await work(values);
        $('#modal').remove();
        await render();
        const message=typeof successMessage==='function'?successMessage(values):successMessage;
        if(message)ui.toast(message);
      }catch(err){
        error.textContent=err.message||'Speichern nicht möglich.';
        error.scrollIntoView({block:'nearest'});
      }
    });
  };
}
/** Die Sachbearbeitung wählt nur Personen, die schon führen, und nie HR-Kolleg:innen derselben Rolle. */
const canBeManagerHere=person=>me.role!=='hr_staff'||!['hr_staff','employee'].includes(person.role);
async function assignManager(userId){
  const d=await api('/api/users'),person=d.users.find(x=>x.id==userId);
  const choices=d.users.filter(x=>x.id!=userId&&(canBeManagerHere(x)||x.id===person.manager_id)).sort((a,b)=>surnameFirst(a.name).localeCompare(surnameFirst(b.name),'de'));
  ui.modal({
    title:'Führungskraft zuordnen',
    subtitle:person.name,
    submitLabel:'Zuordnung speichern',
    body:`<label>Direkte Führungskraft</label><select name="managerId"><option value="">Keine (oberste Ebene)</option>${choices.map(x=>`<option value="${x.id}" ${person.manager_id===x.id?'selected':''}>${modalEscape(x.name)} · ${modalEscape(x.title||roles[x.role])}</option>`).join('')}</select><p class="muted">Offene Freigaben und Aufgaben zur Person gehen an die neue Führungskraft.</p>`,
    onSubmit:async data=>{
      const send=promoteManager=>api('/api/users/'+userId+'/manager',{method:'PATCH',body:JSON.stringify({managerId:data.managerId||null,promoteManager})});
      try{
        await send(false);
      }catch(err){
        if(err.code!=='manager_role_required')throw err;
        if(!confirm(`${err.message} Soll die Person die Rolle Führungskraft bekommen? Sonst fehlt ihr zum Beispiel „Mein Team“.`))return true;
        await send(true);
      }
      ui.toast('Zuordnung gespeichert.');
      render();
    }
  });
}
async function editAccount(userId){
  const [d,positionData]=await Promise.all([api('/api/users'),api('/api/positions').catch(()=>({items:[]}))]),person=d.users.find(x=>x.id==userId);
  const options=assignableRoles(),today=new Date().toISOString().slice(0,10);
  const positionOptions=positionData.items.filter(item=>item.active!==0||item.id===person.position_profile_id);
  const positionField=positionOptions.length?`<div class="two"><div><label>Position</label><select name="positionProfileId"><option value="">Keine Position</option>${positionOptions.map(item=>`<option value="${item.id}" ${item.id===person.position_profile_id?'selected':''}>${modalEscape(item.title)}</option>`).join('')}</select></div><div><label>Position gilt ab</label><input name="positionEffectiveDate" type="date" value="${today}" max="${today}"></div></div>`:'';
  const roleField=options.some(([key])=>key===person.role)
    ?`<label>Rolle</label><select name="role">${options.map(([key,label])=>`<option value="${key}" ${key===person.role?'selected':''}>${modalEscape(label)}</option>`).join('')}</select>`
    :`<label>Rolle</label><input value="${modalEscape(roles[person.role])}" disabled><p class="muted">Diese Rolle ändern HR Business Partner oder HR-Administration.</p>`;
  ui.modal({
    title:'Konto bearbeiten',
    subtitle:person.name,
    body:`<label>Name</label><input name="name" value="${modalEscape(person.name)}" required maxlength="120"><label>E-Mail (Anmeldename)</label><input name="email" type="email" value="${modalEscape(person.email)}" required maxlength="254">${positionField}<label>Bezeichnung (falls keine Position passt)</label><input name="title" value="${modalEscape(person.title||'')}" maxlength="160">${roleField}`,
    onSubmit:async data=>{
      const {positionProfileId,positionEffectiveDate,...account}=data;
      const result=await api('/api/users/'+userId,{method:'PATCH',body:JSON.stringify(account)});
      const position=positionProfileId?Number(positionProfileId):null;
      if(positionProfileId!==undefined&&position!==(person.position_profile_id??null))await api('/api/positions/assign/'+userId,{method:'PATCH',body:JSON.stringify({positionProfileId:position,effectiveDate:positionEffectiveDate})});
      ui.toast(result.emailChanged?`Konto gespeichert. Sag ${account.name} die neue Anmelde-E-Mail.`:'Konto gespeichert.');
      render();
    }
  });
}
async function exportPeople(){
  const d=await api('/api/users?includeInactive=true');
  // Tabellenprogramme führen Zellen mit =, +, - oder @ am Anfang als Formel aus.
  const cell=value=>{const text=String(value??'');return `"${(/^[=+\-@\t\r]/.test(text)?`'${text}`:text).replace(/"/g,'""')}"`};
  const byId=Object.fromEntries(d.users.map(x=>[x.id,x]));
  const lines=[['Name','E-Mail','Rolle','Bezeichnung','Führungskraft','Status'].map(cell).join(';'),...d.users.map(u=>[u.name,u.email,roles[u.role],u.title,byId[u.manager_id]?.name,u.active===0?'gesperrt':'aktiv'].map(cell).join(';'))];
  const link=document.createElement('a');
  link.href=URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`],{type:'text/csv;charset=utf-8'}));
  link.download='daybreak-mitarbeitende.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}
async function showCheckin(id){
  const {checkin:c,canRespond,canEdit}=await api('/api/checkins/'+id);
  const respond=canRespond?`<form id="feedback"><label>Dein Kommentar</label><textarea name="comment">${modalEscape(c.employee_comment||'')}</textarea><label>Wie gut trifft die Zusammenfassung das Gespräch? *</label><div class="stars" role="group" aria-label="Bewertung mit Sternen">${[1,2,3,4,5].map(i=>`<button type="button" data-star="${i}" class="${i<=c.satisfaction?'on':''}" aria-label="${i} von 5 Sternen">★</button>`).join('')}</div><input type="hidden" name="satisfaction" value="${c.satisfaction||0}"><div class="error" id="feedbackError" role="alert"></div><button class="btn primary full">Bestätigen</button></form>`
    :c.acknowledged_at?`<div class="checkinAnswer"><b>Rückmeldung von ${modalEscape(c.employee_name)}</b><p class="muted">${modalEscape(c.employee_comment||'Kein Kommentar.')}</p><p>${'★'.repeat(c.satisfaction||0)}${'☆'.repeat(5-(c.satisfaction||0))}</p></div>`:`<p class="muted">${modalEscape(c.employee_name)} hat noch nicht bestätigt.</p>`;
  document.querySelector('#modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><section class="card"><div class="modalHead"><h2>Check-in · ${modalEscape(monthText(c.period))}</h2><button class="btn" id="close" aria-label="Schließen">×</button></div><p class="muted">${modalEscape(c.summary)}</p><p><b>Erfolge:</b> ${modalEscape(c.achievements||'–')}</p><p><b>Hindernisse:</b> ${modalEscape(c.obstacles||'–')}</p><p><b>Nächste Schritte:</b> ${modalEscape(c.next_steps||'–')}</p><p><span class="tag">Leistung ${c.performance}/5</span> ${goalStatusTag(c.on_track)}</p>${respond}${canEdit?'<button class="btn" id="editCheckin">Korrigieren</button> <button class="btn" id="deleteCheckin">Löschen</button>':''}</section></div>`);
  $('#close').onclick=()=>$('#modal').remove();
  if($('#editCheckin'))$('#editCheckin').onclick=()=>{$('#modal').remove();modal('checkin',c)};
  if($('#deleteCheckin'))$('#deleteCheckin').onclick=()=>showingErrors(async()=>{
    if(!confirm(`Check-in ${monthText(c.period)} von ${c.employee_name} löschen? Die Person sieht ihn dann nicht mehr.`))return;
    await api('/api/checkins/'+id,{method:'DELETE'});
    $('#modal').remove();
    await render();
    ui.toast('Check-in gelöscht.');
  });
  if(!canRespond)return;
  document.querySelectorAll('[data-star]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-star]').forEach(s=>s.classList.toggle('on',Number(s.dataset.star)<=Number(b.dataset.star)));document.querySelector('[name=satisfaction]').value=b.dataset.star});
  $('#feedback').onsubmit=async e=>{
    e.preventDefault();
    try{
      await api('/api/checkins/'+id+'/feedback',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});
      $('#modal').remove();
      ui.toast('Danke. Deine Führungskraft sieht deine Rückmeldung.');
      render();
    }catch(err){$('#feedbackError').textContent=err.message}
  };
}
const goalFacts=g=>`<p class="muted">Gewicht ${modalEscape(g.weight)} %${g.due_date?` · bis ${modalEscape(ui.date(g.due_date))}`:''}</p>`;
async function reviewGoal(id){
  const g=(await api('/api/goals/'+id)).goal;
  document.querySelector('#modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><form class="card" id="reviewForm"><div class="modalHead"><div><h2>Ziel prüfen</h2><p class="muted">${modalEscape(g.owner_name)} · ${modalEscape(g.title)}</p></div><button type="button" class="btn" id="close" aria-label="Schließen">×</button></div><p>${modalEscape(g.description||'Keine Beschreibung hinterlegt.')}</p>${goalFacts(g)}<label for="reviewAction">Entscheidung</label><select id="reviewAction" name="action"><option value="approved">Ziel freigeben</option><option value="changes_requested">Änderungen anfordern</option></select><label for="reviewComment">Kommentar für ${modalEscape(g.owner_name)}</label><textarea id="reviewComment" name="comment" placeholder="Optional bei Freigabe, nötig bei Änderungswunsch"></textarea><button class="btn primary full">Entscheidung senden</button></form></div>`);
  $('#close').onclick=()=>$('#modal').remove();
  submitDialog('#reviewForm',form=>api('/api/goals/'+id+'/review',{method:'PATCH',body:JSON.stringify(form)}),form=>form.action==='approved'?`Ziel freigegeben. ${g.owner_name} sieht es jetzt.`:`Änderungswunsch an ${g.owner_name} geschickt.`);
}
async function respondGoal(id){
  const g=(await api('/api/goals/'+id)).goal;
  document.querySelector('#modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><form class="card" id="responseForm"><div class="modalHead"><div><h2>Zielvorschlag beantworten</h2><p class="muted">${modalEscape(g.title)}</p></div><button type="button" class="btn" id="close" aria-label="Schließen">×</button></div><p>${modalEscape(g.description||'Keine Beschreibung hinterlegt.')}</p>${goalFacts(g)}<label for="responseAction">Deine Antwort</label><select id="responseAction" name="action"><option value="accepted">Ziel annehmen</option><option value="changes_requested">Änderungen vorschlagen</option></select><label for="responseComment">Kommentar an deine Führungskraft</label><textarea id="responseComment" name="comment" placeholder="Optional bei Annahme, nötig bei Änderungswunsch"></textarea><button class="btn primary full">Antwort senden</button></form></div>`);
  $('#close').onclick=()=>$('#modal').remove();
  submitDialog('#responseForm',form=>api('/api/goals/'+id+'/employee-response',{method:'PATCH',body:JSON.stringify(form)}),form=>form.action==='accepted'?'Ziel angenommen.':'Änderungswunsch an deine Führungskraft geschickt.');
}
async function reviseGoal(id){
  const g=(await api('/api/goals/'+id)).goal;
  document.querySelector('#modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><form class="card" id="reviseForm"><div class="modalHead"><div><h2>Ziel überarbeiten</h2><p class="muted">${modalEscape(g.title)}</p></div><button type="button" class="btn" id="close" aria-label="Schließen">×</button></div><div class="card" style="padding:12px;margin:12px 0;background:#fff8e9"><b>Änderungswunsch</b><p class="muted" style="margin:5px 0 0">${modalEscape(g.manager_comment||'Bitte Ziel überarbeiten.')}</p></div><label>Zieltitel</label><input name="title" value="${modalEscape(g.title)}" required><label>Beschreibung</label><textarea name="description">${modalEscape(g.description||'')}</textarea><div class="two"><div><label>Gewicht in %</label><input name="weight" type="number" min="1" max="100" value="${modalEscape(g.weight)}"></div><div><label>Zieltermin</label><input name="dueDate" type="date" value="${modalEscape(g.due_date||'')}"></div></div><label>Fortschritt in %</label><input name="progress" type="number" min="0" max="100" value="${g.progress}"><button class="btn primary full">Überarbeiten und erneut einreichen</button></form></div>`);
  $('#close').onclick=()=>$('#modal').remove();
  submitDialog('#reviseForm',form=>{form.progress=Number(form.progress);form.weight=Number(form.weight);form.resubmit=true;return api('/api/goals/'+id,{method:'PATCH',body:JSON.stringify(form)})},'Überarbeitung geschickt.');
}
async function editGoal(id){
  const d=await api('/api/goals'),g=d.goals.find(x=>x.id==id);
  document.querySelector('#modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><form class="card" id="goalProgressForm"><div class="modalHead"><div><h2>Zielfortschritt aktualisieren</h2><p class="muted">${modalEscape(g.title)}</p></div><button type="button" class="btn" id="close" aria-label="Schließen">×</button></div><label for="goalProgress">Fortschritt: <span id="progressValue">${g.progress}</span> %</label><input id="goalProgress" name="progress" type="range" min="0" max="100" value="${g.progress}"><label for="goalStatus">Stand</label><select id="goalStatus" name="status">${Object.entries(goalStatusLabels).map(([key,label])=>`<option value="${key}" ${g.status===key?'selected':''}>${label}</option>`).join('')}</select><button class="btn primary full">Fortschritt speichern</button></form></div>`);
  $('#close').onclick=()=>$('#modal').remove();
  $('#goalProgress').oninput=e=>{$('#progressValue').textContent=e.target.value};
  submitDialog('#goalProgressForm',form=>api('/api/goals/'+id,{method:'PATCH',body:JSON.stringify({progress:Number(form.progress),status:form.status})}),'Fortschritt gespeichert.');
}
function bindLogin(){const completeLogin=async user=>{const address=readAddress();me=user;view=address?.view||'dashboard';expandedNavGroup=null;selectedPersonId=null;selectedPersonCanEdit=false;restoringAddress=Boolean(address);await loadAppConfig();applyAddressItem(address?.selectedPersonId??null);render()};$('#login').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});await completeLogin(d.user)}catch(e){$('#err').textContent=e.message}};document.querySelectorAll('.demoLogin').forEach(b=>b.onclick=async()=>{const label=b.textContent;b.disabled=true;b.textContent='Anmelden …';try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:b.dataset.email,password:'demo1234'})});await completeLogin(d.user)}catch(e){$('#err').textContent=e.message;b.disabled=false;b.textContent=label}})}
function modalEscape(value){return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
async function modal(type,existingCheckin=null){
  const isGoal=type==='goal',isPerson=type==='person';
  let team=[],positions=[],managers=[],checkinPersonField='',goalsNeedApproval=true;
  // Ohne Führungskraft gibt es niemanden, der freigibt: Das Ziel gilt dann sofort.
  if(isGoal)goalsNeedApproval=(await api('/api/app/config')).goalsNeedApproval!==false&&(view==='profile'||Boolean(me.manager_id));
  if(isPerson){
    const [positionData,userData]=await Promise.all([api('/api/positions'),api('/api/users')]);
    positions=positionData.items;
    managers=userData.users.filter(canBeManagerHere).sort((a,b)=>surnameFirst(a.name).localeCompare(surnameFirst(b.name),'de'));
  }else if(existingCheckin){
    checkinPersonField=`<label>Mitarbeiter:in</label><input value="${modalEscape(existingCheckin.employee_name)}" disabled><input type="hidden" name="employeeId" value="${existingCheckin.employee_id}">`;
  }else if(!isGoal){
    team=(await api('/api/team')).team;
    const selected=team.find(person=>person.id===selectedPersonId);
    checkinPersonField=selected
      ?`<label>Mitarbeiter:in</label><input value="${modalEscape(selected.name)} · ${modalEscape(selected.title||'')}" disabled><input type="hidden" name="employeeId" value="${selected.id}">`
      :`<label>Mitarbeiter:in</label><select name="employeeId" required><option value="">Bitte auswählen</option>${team.filter(person=>person.canEdit).map(person=>`<option value="${person.id}">${modalEscape(person.name)} · ${modalEscape(person.title||'')}</option>`).join('')}</select>`;
  }
  const personFields=`<label>Name</label><input name="name" required maxlength="120"><label>E-Mail (Anmeldename)</label><input name="email" type="email" required maxlength="254"><div class="two"><div><label>Rolle</label><select name="role">${assignableRoles().map(([key,label])=>`<option value="${modalEscape(key)}">${modalEscape(label)}</option>`).join('')}</select></div><div><label>Führungskraft</label><select name="managerId"><option value="">Keine (oberste Ebene)</option>${managers.map(person=>`<option value="${person.id}">${modalEscape(person.name)} · ${modalEscape(person.title||roles[person.role])}</option>`).join('')}</select></div></div><div class="two"><div><label>Position</label><select name="positionProfileId"><option value="">Keine Position</option>${positions.map(position=>`<option value="${position.id}">${modalEscape(position.title)}</option>`).join('')}</select></div><div><label>Position gilt ab</label><input name="positionEffectiveDate" type="date" value="${new Date().toISOString().slice(0,10)}" max="${new Date().toISOString().slice(0,10)}"></div></div><label>Bezeichnung (falls keine Position passt)</label><input name="title" maxlength="160"><p class="muted">Das Startpasswort erzeugt Daybreak. Du siehst es einmal und gibst es persönlich weiter.</p>`;
  const goalFields=`<label>Zieltitel</label><input name="title" required><label>Beschreibung</label><textarea name="description"></textarea><div class="two"><div><label>Gewicht in %</label><input name="weight" type="number" min="1" max="100" value="100"></div><div><label>Zieltermin</label><input name="dueDate" type="date" value="${new Date().getFullYear()}-12-31"></div></div><label>Fortschritt in %</label><input name="progress" type="number" min="0" max="100" value="0"><p class="muted">${!goalsNeedApproval?'Das Ziel gilt sofort.':view==='profile'?'Die Person kann diesen Vorschlag annehmen oder Änderungen anfordern.':'Deine Führungskraft bekommt das Ziel zur Freigabe.'}</p>`;
  const given=existingCheckin||{};
  const statusOptions=Object.entries(goalStatusLabels).map(([key,label])=>`<option value="${key}" ${given.on_track===key?'selected':''}>${label}</option>`).join('');
  const checkinFields=`${checkinPersonField}<label>Monat</label><input name="period" type="month" value="${modalEscape(given.period||new Date().toISOString().slice(0,7))}" max="${new Date().toISOString().slice(0,7)}" required><label>Zusammenfassung</label><textarea name="summary" required>${modalEscape(given.summary||'')}</textarea><div class="two"><div><label>Leistung (1 bis 5)</label><input name="performance" type="number" min="1" max="5" value="${modalEscape(given.performance||4)}"></div><div><label>Stand der Ziele</label><select name="onTrack">${statusOptions}</select></div></div><label>Erfolge</label><textarea name="achievements">${modalEscape(given.achievements||'')}</textarea><label>Hindernisse</label><textarea name="obstacles">${modalEscape(given.obstacles||'')}</textarea><label>Nächste Schritte</label><textarea name="nextSteps">${modalEscape(given.next_steps||'')}</textarea>`;
  document.querySelector('#modal')?.remove();
  const title=isGoal?'Ziel anlegen':isPerson?'Person anlegen':existingCheckin?'Check-in korrigieren':'Check-in erfassen';
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><form class="card" id="modalForm"><div class="modalHead"><h2>${title}</h2><button type="button" class="btn" id="close" aria-label="Schließen">×</button></div><div class="error" id="modalError" role="alert"></div>${isGoal?goalFields:isPerson?personFields:checkinFields}<button class="btn primary full">Speichern</button></form></div>`);
  $('#close').onclick=()=>$('#modal').remove();
  $('#modalForm').onsubmit=event=>{
    event.preventDefault();
    const error=$('#modalError'),form=event.target;
    error.textContent='';
    const data=Object.fromEntries(new FormData(form));
    return oneAtATime(form,async()=>{
      try{
        if(isGoal)data.userId=view==='profile'&&selectedPersonId?selectedPersonId:me.id;
        const url=isGoal?'/api/goals':isPerson?'/api/users':existingCheckin?'/api/checkins/'+existingCheckin.id:'/api/checkins';
        const send=()=>api(url,{method:existingCheckin?'PATCH':'POST',body:JSON.stringify(data)});
        let result;
        try{
          result=await send();
        }catch(err){
          if(err.code!=='manager_role_required')throw err;
          if(!confirm(`${err.message} Soll die Person die Rolle Führungskraft bekommen? Sonst fehlt ihr zum Beispiel „Mein Team“.`))return;
          data.promoteManager=true;
          result=await send();
        }
        $('#modal').remove();
        await render();
        if(isPerson&&result.temporaryPassword)showTemporaryPassword(data.name,result.temporaryPassword);
        else ui.toast(isGoal?(goalsNeedApproval?'Ziel gespeichert.':'Ziel gespeichert. Es gilt sofort.'):isPerson?'Person angelegt.':result.sameMonth?'Check-in gespeichert. Für diesen Monat gab es schon einen, als letzter zählt dieser.':'Check-in gespeichert. Die Person bekommt eine Aufgabe zum Bestätigen.');
      }catch(err){
        error.textContent=err.message||'Speichern nicht möglich.';
        error.scrollIntoView({block:'nearest'});
      }
    });
  };
}
// Alle Dialoge verhalten sich gleich: Fokus im Dialog, Escape schließt, Rückfrage bei ungesicherten Eingaben.
let dialogCounter=0,dialogReturnFocus=null;
const dialogCloseButton=dialog=>dialog.querySelector('#close,#uiModalClose,[aria-label="Schließen"],.modalHead button');
function enhanceDialog(dialog){
  if(dialog.dataset.enhanced)return;
  dialog.dataset.enhanced='1';
  dialog.setAttribute('role','dialog');
  dialog.setAttribute('aria-modal','true');
  const heading=dialog.querySelector('h2');
  if(heading){heading.id=heading.id||`dialogTitle${++dialogCounter}`;dialog.setAttribute('aria-labelledby',heading.id)}
  const close=dialogCloseButton(dialog);
  if(close&&!close.getAttribute('aria-label'))close.setAttribute('aria-label','Schließen');
  // Beschriftungen stehen im Code oft direkt vor dem Feld, ohne Verbindung für Vorlesehilfen.
  dialog.querySelectorAll('label:not([for])').forEach(label=>{
    if(label.querySelector('input,select,textarea'))return;
    const field=label.nextElementSibling;
    if(!field?.matches?.('input,select,textarea'))return;
    field.id=field.id||`dialogField${++dialogCounter}`;
    label.htmlFor=field.id;
  });
  dialogReturnFocus=dialogReturnFocus||document.activeElement;
  // Am Handy würde der Fokus sofort die Tastatur öffnen und den Dialog verdecken.
  if(window.matchMedia('(pointer:coarse)').matches)return;
  const first=dialog.querySelector('input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled])')||close;
  first?.focus();
}
function watchDialogs(){
  new MutationObserver(()=>{
    const dialogs=[...document.querySelectorAll('.modal')];
    dialogs.forEach(enhanceDialog);
    document.body.classList.toggle('modal-open',dialogs.length>0);
    if(!dialogs.length&&dialogReturnFocus){
      const target=dialogReturnFocus;
      dialogReturnFocus=null;
      if(target.isConnected)target.focus();
    }
  }).observe(document.body,{childList:true});
  document.addEventListener('input',event=>{const dialog=event.target.closest?.('.modal');if(dialog)dialog.dataset.dirty='1'},true);
  // Vor dem eigentlichen Schließen, damit es sich abbrechen lässt.
  document.addEventListener('click',event=>{
    const dialog=event.target.closest?.('.modal');
    if(!dialog||event.target!==dialogCloseButton(dialog))return;
    const question=dialog.dataset.confirmClose||(dialog.dataset.dirty?'Deine Eingaben sind noch nicht gespeichert. Trotzdem schließen?':'');
    if(question&&!confirm(question)){event.preventDefault();event.stopPropagation()}
  },true);
  document.addEventListener('keydown',event=>{
    const dialog=[...document.querySelectorAll('.modal')].pop();
    if(!dialog)return;
    if(event.key==='Escape'){event.preventDefault();dialogCloseButton(dialog)?.click();return}
    if(event.key!=='Tab')return;
    const items=[...dialog.querySelectorAll('button,input:not([type=hidden]),select,textarea,a[href]')].filter(item=>!item.disabled&&item.offsetParent!==null);
    if(!items.length)return;
    const first=items[0],last=items[items.length-1],active=document.activeElement;
    if(!dialog.contains(active)){event.preventDefault();first.focus()}
    else if(event.shiftKey&&active===first){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&active===last){event.preventDefault();first.focus()}
  });
}
(async()=>{
  if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  watchDialogs();
  try{
    me=(await api('/api/auth/me')).user;
    await loadAppConfig();
    const address=readAddress();
    if(address){
      view=address.view;
      applyAddressItem(address.selectedPersonId);
      selectedPersonCanEdit=Boolean(history.state?.selectedPersonCanEdit);
      restoringAddress=true;
    }
    render();
  }catch{
    await showLogin();
  }
})();
