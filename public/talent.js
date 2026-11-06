(()=>{
  const careerPaths={expert:'Fachlaufbahn',leadership:'Führungslaufbahn',project:'Projektlaufbahn',undecided:'Noch nicht festgelegt'};
  const categories={technical:'Fachkompetenz',leadership:'Führungskompetenz',digital:'Digitale Kompetenz',methodological:'Methodenkompetenz',social:'Soziale Kompetenz',language:'Sprachkompetenz',business:'Geschäftskompetenz'};
  const qualificationTypes={qualification:'Qualifikation',certificate:'Zertifikat',education:'Ausbildung / Studium',training:'Weiterbildung'};
  const qualificationStates={valid:'Gültig',expired:'Abgelaufen',pending_verification:'Prüfung ausstehend',verified:'Verifiziert'};
  const gapStates={fulfilled:'Erfüllt',partial:'Teilweise erfüllt',development_needed:'Entwicklungsbedarf',high_development_needed:'Hoher Entwicklungsbedarf',not_rated:'Nicht bewertet'};
  const sourceLabels={manager:'Führungskraft',employee:'Selbsteinschätzung',none:'Nicht bewertet'};
  const levelLabels={1:'Grundlagen',2:'Praktische Kenntnisse',3:'Selbstständige Anwendung',4:'Fortgeschrittene Anwendung',5:'Expertenniveau'};
  const state={profile:null,competencies:[],positions:[],positionId:null,overview:{search:'',managerId:'',positionId:'',competencyId:'',missingManager:false,gapStatus:''}};
  let overviewSearchTimer=null;
  const api=(url,opts)=>window.loop.api(url,opts);
  const ownId=()=>window.loop.me.id;
  const isHr=()=>['hr_admin','hrbp','super_admin'].includes(window.loop.me.role);
  const isManager=()=>['manager','director'].includes(window.loop.me.role);
  const esc=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const selectedId=()=>window.loop.selectedPersonId||ownId();
  const optionList=(items,value,label,selected='')=>items.map(item=>`<option value="${item[value]}" ${String(item[value])===String(selected)?'selected':''}>${esc(item[label])}</option>`).join('');
  const stars=value=>value?`<span class="rating" title="${levelLabels[value]}">${'★'.repeat(value)}<i>${value}/5</i></span>`:'<span class="muted">Nicht bewertet</span>';
  const yesNo=value=>value?'Ja':'Nein';
  function toast(message,type='success'){
    document.querySelector('.talent-toast')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="talent-toast ${type}">${esc(message)}</div>`);
    window.setTimeout(()=>document.querySelector('.talent-toast')?.remove(),3600);
  }
  function closeModal(){document.querySelector('#talentModal')?.remove()}
  function showModal(title,content,onSubmit,submitLabel='Speichern'){
    closeModal();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="talentModal"><form class="card talent-form" id="talentForm"><div class="modalHead"><div><h2>${esc(title)}</h2><p class="muted">Pflichtfelder sind mit * markiert.</p></div><button type="button" class="btn" id="talentClose">×</button></div><div id="talentFormError" class="error"></div>${content}<button class="btn primary full">${esc(submitLabel)}</button></form></div>`);
    document.querySelector('#talentClose').onclick=closeModal;
    document.querySelector('#talentForm').onsubmit=async event=>{
      event.preventDefault();
      const error=document.querySelector('#talentFormError');
      error.textContent='';
      try{await onSubmit(Object.fromEntries(new FormData(event.currentTarget)));closeModal()}catch(err){error.textContent=err.message||'Speichern nicht möglich.'}
    };
  }
  function refreshProfile(){window.loop.openTalentProfile(state.profile?.user.id||ownId())}
  function route(page){window.loop.navigate(page)}
  function profileEndpoint(){const id=selectedId();return id===ownId()?'/api/talent/profile':'/api/talent/profile/'+id}
  function roleLabel(role){return window.loop.roles[role]||role}
  function editRights(profile){return {own:profile.user.id===ownId(),direct:isManager()&&profile.user.manager_id===ownId(),hr:isHr()}}
  function positionHistory(items){
    if(!items?.length)return `<div class="talent-notes"><h3>Bisherige Positionen</h3><p class="muted">Noch keine Änderung festgehalten. Neue Zuordnungen stehen hier mit dem Datum, ab dem sie gelten.</p></div>`;
    return `<div class="talent-notes"><h3>Bisherige Positionen</h3><p class="muted">Ab wann die Position gilt und wann das eingetragen wurde.</p><div class="talent-list">${items.map(item=>{
      const previous=item.previous_position_title||'Keine Positionszuordnung';
      const current=item.position_title||'Keine Positionszuordnung';
      const change=item.previous_position_profile_id===null?'Erstzuordnung':`Geändert von ${previous}`;
      return `<div class="talent-item"><div><b>${esc(current)}</b><small>Gilt seit ${esc(window.loop.ui.date(item.effective_date))}</small><p>${esc(change)}</p><small>Eingetragen am ${esc(new Date(`${String(item.recorded_at).replace(' ','T')}${/[zZ]|[+-]\d\d:\d\d$/.test(item.recorded_at)?'':'Z'}`).toLocaleString('de-DE',{dateStyle:'medium',timeStyle:'short'}))}${item.changed_by_name?` · ${esc(item.changed_by_name)}`:''}</small></div><span class="tag">Position</span></div>`;
    }).join('')}</div></div>`;
  }
  function careerDetails(career){
    const history=positionHistory(state.profile?.positionHistory||[]);
    if(!career)return `<p class="muted">Noch keine freiwilligen Karriereinteressen hinterlegt.</p>${history}`;
    const flags=[['Führungsverantwortung',career.leadership_interest],['Fachlaufbahn',career.expert_interest],['Projektlaufbahn',career.project_interest],['Mentoring',career.mentoring_interest],['Interne Projekte',career.internal_projects_interest],['Mobilität',career.mobility],['Standortwechsel',career.relocation]];
    return `<div class="talent-detail"><b>${careerPaths[career.career_path]||career.career_path}</b>${career.target_position?`<span class="tag">Zielposition: ${esc(career.target_position)}</span>`:''}<p>${esc(career.desired_fields||'Keine gewünschten Tätigkeitsfelder angegeben.')}</p><div class="talent-chips">${flags.filter(([,active])=>active).map(([label])=>`<span class="tag">${label}</span>`).join('')||'<span class="muted">Keine zusätzlichen Interessen ausgewählt.</span>'}</div>${career.development_timeframe?`<small>Entwicklungszeitraum: ${esc(career.development_timeframe)}</small>`:''}${career.career_goals?`<p><b>Berufliche Ziele:</b> ${esc(career.career_goals)}</p>`:''}</div>${history}`;
  }
  function comparisonsTable(comparisons,{inlineManager=false,managerHidden=false}={}){
    if(!comparisons.length)return '<p class="muted">Noch keine Kompetenzbewertungen hinterlegt.</p>';
    const managerCell=item=>inlineManager
      ?`<select data-manager-rating><option value="">Nicht bewertet</option>${[1,2,3,4,5].map(value=>`<option value="${value}" ${item.manager?.rating===value?'selected':''}>${value} · ${levelLabels[value]}</option>`).join('')}</select>`
      :stars(item.manager?.rating);
    const row=item=>`<tr ${inlineManager?`class="manager-assessment-row" data-competency-id="${item.competencyId}" data-competency-name="${esc(item.name)}" data-original-rating="${item.manager?.rating||''}" data-original-comment="${esc(item.manager?.comment||'')}"`:''}><td><b>${esc(item.name)}</b><small>${categories[item.category]}</small></td><td data-label="Selbst">${stars(item.self?.rating)}</td>${managerHidden?'':`<td data-label="Führungskraft">${managerCell(item)}</td>`}${inlineManager?`<td><textarea data-manager-comment placeholder="Begründung für die Einschätzung">${esc(item.manager?.comment||'')}</textarea></td>`:''}${managerHidden?'':`<td data-label="Differenz">${item.difference===null?'<span class="muted">–</span>':`<span class="difference ${item.difference>0?'positive':item.difference<0?'negative':''}">${item.difference>0?'+':''}${item.difference}</span>`}</td>`}<td data-label="Stand"><small>${item.latestAt?esc(window.loop.ui.date(item.latestAt)):'–'}</small></td></tr>`;
    const content=`<div class="tableWrap"><table class="table talent-table manager-assessments"><thead><tr><th>Kompetenz</th><th>Selbst</th>${managerHidden?'':'<th>Führungskraft</th>'}${inlineManager?'<th>Begründung</th>':''}${managerHidden?'':'<th>Differenz</th>'}<th>Stand</th></tr></thead><tbody>${comparisons.map(row).join('')}</tbody></table></div>`;
    return inlineManager?`<form id="managerAssessmentForm"><p class="muted">Bewerte direkt in der Tabelle. Nur geänderte Zeilen werden gespeichert. Eine Begründung ist optional; mit „Nicht bewertet“ entfernst du eine vorhandene Führungskräfteeinschätzung.</p>${content}<div class="manager-assessment-actions"><span class="muted">Die Selbsteinschätzung bleibt unverändert und wird gegenübergestellt.</span><button type="submit" class="btn primary">Änderungen speichern</button></div></form>`:managerHidden?`<p class="muted">Hier steht die eigene Einschätzung. Die Bewertung durch die direkte Führungskraft sehen nur sie, die Person und HR.</p>${content}`:content;
  }
  function gapTable(gap){
    if(!gap.position)return '<p class="muted">Für die aktuelle Position ist noch kein Positionsprofil zugeordnet.</p>';
    if(!gap.requirements.length)return `<p class="muted">Für „${esc(gap.position.title)}“ sind noch keine Kompetenzanforderungen hinterlegt.</p>`;
    return `<div class="fit-summary"><div><small>AKTUELLE POSITION</small><b>${esc(gap.position.title)}</b></div><div><small>ABDECKUNG DER POSITIONSANFORDERUNGEN</small><b>${gap.fit===null?'–':gap.fit+' %'}</b></div></div><p class="muted talent-formula">Zeigt, wie weit die Bewertungen die Anforderungen der Position abdecken. Wichtige Anforderungen zählen stärker. Mehr als gefordert gleicht nichts anderes aus.</p><div class="tableWrap"><table class="table talent-table"><thead><tr><th>Kompetenz</th><th>Soll</th><th>Ist</th><th>Quelle</th><th>Lücke</th><th>Status</th></tr></thead><tbody>${gap.requirements.map(item=>`<tr><td><b>${esc(item.competency)}</b><small>${categories[item.category]} · Gewicht ${item.weight}</small></td><td>${item.requiredLevel}/5</td><td>${item.availableLevel===null?'–':item.availableLevel+'/5'}</td><td>${sourceLabels[item.source]}</td><td>${item.gap===null?'–':item.gap}</td><td><span class="tag ${item.status==='fulfilled'?'':item.status==='high_development_needed'?'danger':'focus'}">${gapStates[item.status]}</span><small>${esc(item.recommendation)}</small></td></tr>`).join('')}</tbody></table></div>`;
  }
  function listCard(title,items,renderItem,action){return `<article class="card"><div class="sectionHead"><h2>${title}</h2>${action||''}</div>${items.length?`<div class="talent-list">${items.map(renderItem).join('')}</div>`:'<p class="muted">Noch keine Einträge.</p>'}</article>`}
  async function profile(){
    const [data,competencyData]=await Promise.all([api(profileEndpoint()),api('/api/competencies')]);
    const p=data.profile; state.profile=p;
    const rights=editRights(p);
    const comparisons=rights.direct?competencyData.items.map(competency=>p.comparisons.find(item=>item.competencyId===competency.id)||({competencyId:competency.id,name:competency.name,category:competency.category,self:null,manager:null,difference:null,latestAt:null})):p.comparisons;
    const back=selectedId()!==ownId()?`<button class="btn" data-talent-action="back-team">← ${isHr()?'Mitarbeitende':'Mein Team'}</button>`:'';
    const assignment=rights.hr?'<button class="btn" data-talent-action="assign-position">Position zuordnen</button>':'';
    const experience=entry=>`<div class="talent-item"><div><b>${esc(entry.role_title)}</b><small>${esc(entry.organization)} · ${esc(window.loop.ui.date(entry.start_date))} – ${entry.is_current?'heute':esc(window.loop.ui.date(entry.end_date||''))}</small><p>${esc(entry.description||entry.key_responsibilities||'')}</p></div>${rights.own?`<div><button class="btn" data-talent-action="edit-experience" data-id="${entry.id}">Bearbeiten</button><button class="btn" data-talent-action="delete-experience" data-id="${entry.id}">Entfernen</button></div>`:''}</div>`;
    const qualification=entry=>`<div class="talent-item"><div><b>${esc(entry.title)}</b><small>${qualificationTypes[entry.record_type]}${entry.issuer?' · '+esc(entry.issuer):''}${entry.issued_at?' · '+esc(window.loop.ui.date(entry.issued_at)):''}</small><p><span class="tag ${entry.display_status==='expired'?'danger':''}">${qualificationStates[entry.display_status]||entry.display_status}</span>${entry.expires_at?` <span class="muted">gültig bis ${esc(window.loop.ui.date(entry.expires_at))}</span>`:''}</p></div>${rights.own?`<div><button class="btn" data-talent-action="edit-qualification" data-id="${entry.id}">Bearbeiten</button><button class="btn" data-talent-action="delete-qualification" data-id="${entry.id}">Entfernen</button></div>`:''}</div>`;
    const language=entry=>`<div class="talent-item"><div><b>${esc(entry.language)} · ${esc(entry.level)}</b><small>${esc(entry.comment||'Kein Kommentar')}</small></div>${rights.own?`<div><button class="btn" data-talent-action="edit-language" data-id="${entry.id}">Bearbeiten</button><button class="btn" data-talent-action="delete-language" data-id="${entry.id}">Entfernen</button></div>`:''}</div>`;
    return `<header class="top"><div>${back}<h1 style="margin-top:${back?'14px':'0'}">Talent & Entwicklung</h1><p>${esc(p.user.name)} · ${esc(p.user.title||roleLabel(p.user.role))}${p.user.position_profile_title?' · Positionsprofil: '+esc(p.user.position_profile_title):''}</p></div><div>${assignment}${rights.own?'<button class="btn primary" data-talent-action="edit-career">Karriereinteressen pflegen</button>':''}</div></header><section class="cards talent-grid"><article class="card wide"><div class="sectionHead"><h2>Karriereinteressen</h2>${rights.hr?'<button class="btn" data-talent-action="career-note">HR-Hinweis ergänzen</button>':''}</div>${careerDetails(p.career)}${p.careerNotes.length?`<div class="talent-notes">${p.careerNotes.map(note=>`<p><b>HR-Hinweis · ${esc(note.author_name)}</b><br>${esc(note.note)}</p>`).join('')}</div>`:''}</article><article class="card"><small>PASST ZUR POSITION</small><strong class="big-number">${p.summary.positionFit===null?'–':p.summary.positionFit+' %'}</strong><p class="muted">So weit decken die Bewertungen die Anforderungen der Position ab.</p></article><article class="card"><small>ENTWICKLUNG</small><strong class="big-number">${p.summary.developmentGoalCount}</strong><p class="muted">Offene Entwicklungsziele</p></article></section><section class="cards talent-grid">${listCard('Berufliche Erfahrungen',p.experiences,experience,rights.own?'<button class="btn" data-talent-action="add-experience">+ Erfahrung</button>':'')}${listCard('Qualifikationen & Zertifikate',p.qualifications,qualification,rights.own?'<button class="btn" data-talent-action="add-qualification">+ Qualifikation</button>':'')}${listCard('Sprachkenntnisse',p.languages,language,rights.own?'<button class="btn" data-talent-action="add-language">+ Sprache</button>':'')}</section><section class="cards"><article class="card wide"><div class="sectionHead"><h2>Kompetenzprofil</h2><div>${rights.own?'<button class="btn" data-talent-action="self-assessment">Selbsteinschätzung</button>':''}</div></div>${comparisonsTable(comparisons,{inlineManager:rights.direct,managerHidden:Boolean(p.managerRatingsHidden)})}</article><article class="card"><h2>Skala 1–5</h2>${Object.entries(levelLabels).map(([level,label])=>`<p><b>${level}</b> · ${label}</p>`).join('')}<p class="muted">Selbst- und Führungskräfteeinschätzungen bleiben getrennt.</p></article></section><section class="cards"><article class="card wide"><div class="sectionHead"><h2>Kompetenzlücken</h2><span class="tag">keine automatische Eignungsentscheidung</span></div>${gapTable(p.skillGap)}</article></section><section class="cards"><article class="card wide"><div class="sectionHead"><h2>Entwicklungsziele</h2>${(rights.own||rights.direct||rights.hr)?'<button class="btn primary" data-talent-action="development-goal">+ Entwicklungsziel</button>':''}</div>${p.developmentGoals.length?`<div class="talent-list">${p.developmentGoals.map(goal=>`<div class="talent-item"><div><b>${esc(goal.title)}</b><small>${esc(goal.competencies||'Ohne Kompetenzverknüpfung')} · Termin ${esc(window.loop.ui.date(goal.due_date||'–'))}</small><div class="bar"><span style="width:${goal.progress}%"></span></div></div><div><b>${goal.progress}%</b><small>${esc(goal.approval_status==='approved'?'Genehmigt':'In Abstimmung')}</small></div></div>`).join('')}</div>`:'<p class="muted">Noch kein Entwicklungsziel angelegt. Diese Ziele nutzen denselben Genehmigungsworkflow wie alle anderen Ziele.</p>'}</article></section>`;
  }
  function careerForm(){
    const c=state.profile.career||{};
    const boxes=[['leadershipInterest','Interesse an Führungsverantwortung',c.leadership_interest],['expertInterest','Interesse an Fachlaufbahn',c.expert_interest],['projectInterest','Interesse an Projektlaufbahn',c.project_interest],['mentoringInterest','Interesse an Mentoring',c.mentoring_interest],['internalProjectsInterest','Interesse an internen Projekten',c.internal_projects_interest],['mobility','Mobilitätsbereitschaft',c.mobility],['relocation','Bereitschaft zum Standortwechsel',c.relocation]];
    showModal('Karriereinteressen pflegen',`<label>Bevorzugter Karrierepfad *</label><select name="careerPath">${Object.entries(careerPaths).map(([key,label])=>`<option value="${key}" ${c.career_path===key?'selected':''}>${label}</option>`).join('')}</select><label>Gewünschte Tätigkeitsfelder</label><input name="desiredFields" value="${esc(c.desired_fields||'')}"><label>Gewünschte Zielposition</label><input name="targetPosition" value="${esc(c.target_position||'')}"><div class="checkboxes">${boxes.map(([name,label,checked])=>`<label><input type="checkbox" name="${name}" ${checked?'checked':''}> ${label}</label>`).join('')}</div><label>Gewünschter Entwicklungszeitraum</label><input name="developmentTimeframe" value="${esc(c.development_timeframe||'')}" placeholder="z. B. 12–24 Monate"><label>Berufliche Ziele</label><textarea name="careerGoals">${esc(c.career_goals||'')}</textarea>`,async form=>{await api('/api/talent/career-interests',{method:'PATCH',body:JSON.stringify(form)});toast('Karriereinteressen gespeichert.');refreshProfile()});
  }
  function experienceForm(entry=null){
    const value=(key)=>esc(entry?.[key]||'');
    showModal(entry?'Berufserfahrung bearbeiten':'Berufserfahrung ergänzen',`<label>Tätigkeitsbezeichnung *</label><input name="roleTitle" required value="${value('role_title')}"><label>Unternehmen / Organisation *</label><input name="organization" required value="${value('organization')}"><div class="two"><div><label>Beginn *</label><input type="date" name="startDate" required value="${value('start_date')}"></div><div><label>Ende</label><input type="date" name="endDate" value="${value('end_date')}"></div></div><label class="checkline"><input type="checkbox" name="isCurrent" ${entry?.is_current?'checked':''}> Aktuelle Tätigkeit</label><label>Beschreibung</label><textarea name="description">${value('description')}</textarea><label>Wichtigste Aufgaben</label><textarea name="responsibilities">${value('key_responsibilities')}</textarea>`,async form=>{await api(entry?'/api/talent/experiences/'+entry.id:'/api/talent/experiences',{method:entry?'PATCH':'POST',body:JSON.stringify(form)});toast('Berufserfahrung gespeichert.');refreshProfile()});
  }
  function qualificationForm(entry=null){
    const value=(key)=>esc(entry?.[key]||'');
    showModal(entry?'Qualifikation bearbeiten':'Qualifikation ergänzen',`<label>Typ *</label><select name="recordType">${Object.entries(qualificationTypes).map(([key,label])=>`<option value="${key}" ${entry?.record_type===key?'selected':''}>${label}</option>`).join('')}</select><label>Bezeichnung *</label><input name="title" required value="${value('title')}"><label>Ausstellende Institution</label><input name="issuer" value="${value('issuer')}"><div class="two"><div><label>Ausstellungsdatum</label><input type="date" name="issuedAt" value="${value('issued_at')}"></div><div><label>Ablaufdatum</label><input type="date" name="expiresAt" value="${value('expires_at')}"></div></div><label>Zertifikatsnummer</label><input name="certificateNumber" value="${value('certificate_number')}"><label>Status *</label><select name="status">${Object.entries(qualificationStates).map(([key,label])=>`<option value="${key}" ${entry?.status===key?'selected':''}>${label}</option>`).join('')}</select><label>Nachweistext</label><textarea name="evidenceText">${value('evidence_text')}</textarea>`,async form=>{await api(entry?'/api/talent/qualifications/'+entry.id:'/api/talent/qualifications',{method:entry?'PATCH':'POST',body:JSON.stringify(form)});toast('Qualifikation gespeichert.');refreshProfile()});
  }
  function languageForm(entry=null){
    showModal(entry?'Sprachkenntnis bearbeiten':'Sprachkenntnis ergänzen',`<label>Sprache *</label><input name="language" required value="${esc(entry?.language||'')}"><label>Niveau *</label><select name="level">${['A1','A2','B1','B2','C1','C2','native'].map(level=>`<option value="${level}" ${entry?.level===level?'selected':''}>${level==='native'?'Muttersprache':level}</option>`).join('')}</select><label>Kommentar</label><textarea name="comment">${esc(entry?.comment||'')}</textarea>`,async form=>{await api(entry?'/api/talent/languages/'+entry.id:'/api/talent/languages',{method:entry?'PATCH':'POST',body:JSON.stringify(form)});toast('Sprachkenntnis gespeichert.');refreshProfile()});
  }
  async function assessmentForm(type){
    const competencies=(await api('/api/competencies')).items;
    const p=state.profile;
    const intro=type==='self'?'Deine Selbsteinschätzung ist nur für dich änderbar.':'Die Begründung ist für eine Führungskräftebewertung verpflichtend.';
    showModal(type==='self'?'Selbsteinschätzung abgeben':'Kompetenz bewerten',`<p class="muted">${intro}</p><label>Kompetenz *</label><select name="competencyId" required><option value="">Bitte auswählen</option>${competencies.map(item=>`<option value="${item.id}" >${esc(item.name)} · ${categories[item.category]}</option>`).join('')}</select><label>Bewertung 1–5 *</label><select name="rating">${[1,2,3,4,5].map(value=>`<option value="${value}" ${value===3?'selected':''}>${value} · ${levelLabels[value]}</option>`).join('')}</select><label>${type==='self'?'Kommentar':'Begründung'} ${type==='manager'?'*':''}</label><textarea name="comment" ${type==='manager'?'required':''}></textarea>${type==='self'?'<label>Nachweistext</label><textarea name="evidenceText"></textarea>':''}`,async form=>{const endpoint=type==='self'?'/api/talent/competencies/self-assessment':'/api/talent/competencies/manager-assessment';if(type==='manager')form.userId=p.user.id;await api(endpoint,{method:'POST',body:JSON.stringify(form)});toast(type==='self'?'Selbsteinschätzung gespeichert.':'Führungskräftebewertung gespeichert.');refreshProfile()});
    // Wer eine Kompetenz wählt, sieht die eigene letzte Einschätzung dazu und ändert sie.
    if(type==='self'){
      const fields=document.querySelector('.modal form');
      fields.competencyId.onchange=()=>{
        const existing=p.comparisons.find(item=>item.competencyId===Number(fields.competencyId.value))?.self;
        fields.rating.value=existing?.rating||3;
        fields.comment.value=existing?.comment||'';
      };
    }
  }
  async function developmentGoalForm(){
    const competencies=(await api('/api/competencies')).items;
    const p=state.profile;
    showModal('Entwicklungsziel anlegen',`<p class="muted">Dieses Ziel läuft durch den bestehenden Abstimmungs- und Freigabeablauf.</p><label>Zieltitel *</label><input name="title" required placeholder="z. B. Präsentationskompetenz auf Niveau 4 entwickeln"><label>Beschreibung</label><textarea name="description"></textarea><div class="two"><div><label>Gewichtung</label><input name="weight" type="number" min="1" max="100" value="20"></div><div><label>Zieltermin *</label><input name="dueDate" type="date" required value="2026-12-31"></div></div><label>Verknüpfte Kompetenzen</label><div class="checkboxes">${competencies.map(item=>`<label><input type="checkbox" name="competency-${item.id}"> ${esc(item.name)}</label>`).join('')}</div>`,async form=>{const ids=Object.keys(form).filter(key=>key.startsWith('competency-')).map(key=>Number(key.replace('competency-','')));Object.keys(form).filter(key=>key.startsWith('competency-')).forEach(key=>delete form[key]);form.userId=p.user.id;form.goalType='development';const goal=await api('/api/goals',{method:'POST',body:JSON.stringify(form)});for(const competencyId of ids)await api('/api/talent/development-goals/'+goal.id+'/competencies',{method:'POST',body:JSON.stringify({competencyId})});toast('Entwicklungsziel angelegt und dem Ablauf übergeben.');refreshProfile()});
  }
  async function careerNote(){showModal('HR-Hinweis ergänzen','<p class="muted">Diesen Hinweis sieht nur HR, nicht die Person und nicht ihre Führungskraft.</p><label>Hinweis *</label><textarea name="note" required></textarea>',async form=>{await api('/api/talent/career-interests/'+state.profile.user.id+'/notes',{method:'POST',body:JSON.stringify(form)});toast('HR-Hinweis gespeichert.');refreshProfile()})}
  async function assignPosition(){const positions=(await api('/api/positions')).items,p=state.profile,today=new Date().toISOString().slice(0,10);showModal('Positionsprofil zuordnen',`<label>Positionsprofil</label><select name="positionProfileId"><option value="">Keine Zuordnung</option>${optionList(positions,'id','title',p.user.position_profile_id)}</select><label>Offiziell wirksam ab *</label><input type="date" name="effectiveDate" required value="${today}"><p class="muted">Diese Angabe kann vom Tag der Erfassung in Daybreak abweichen und wird in der Positionshistorie gespeichert.</p>`,async form=>{await api('/api/positions/assign/'+p.user.id,{method:'PATCH',body:JSON.stringify(form)});toast('Positionszuordnung und Historie gespeichert.');refreshProfile()})}
  async function competencies(){
    const data=await api('/api/competencies?includeInactive=true'); state.competencies=data.items;
    return `<header class="top"><div><h1>Kompetenzkatalog</h1><p>Aktive Kompetenzen können bewertet und Positionsanforderungen zugeordnet werden.</p></div><button class="btn primary" data-talent-action="add-competency">+ Kompetenz anlegen</button></header><section class="cards"><article class="card wide"><div class="tableWrap"><table class="table talent-table"><thead><tr><th>Kompetenz</th><th>Kategorie</th><th>Status</th><th></th></tr></thead><tbody>${data.items.map(item=>`<tr><td><b>${esc(item.name)}</b><small>${esc(item.description||'Keine Beschreibung')}</small></td><td>${categories[item.category]}</td><td><span class="tag ${item.active?'':'focus'}">${item.active?'Aktiv':'Inaktiv'}</span></td><td><button class="btn" data-talent-action="edit-competency" data-id="${item.id}">Bearbeiten</button> <button class="btn" data-talent-action="toggle-competency" data-id="${item.id}">${item.active?'Deaktivieren':'Aktivieren'}</button></td></tr>`).join('')}</tbody></table></div></article></section>`;
  }
  function competencyForm(item=null){showModal(item?'Kompetenz bearbeiten':'Kompetenz anlegen',`<label>Name *</label><input name="name" required value="${esc(item?.name||'')}"><label>Kategorie *</label><select name="category">${Object.entries(categories).map(([key,label])=>`<option value="${key}" ${item?.category===key?'selected':''}>${label}</option>`).join('')}</select><label>Beschreibung</label><textarea name="description">${esc(item?.description||'')}</textarea>`,async form=>{await api(item?'/api/competencies/'+item.id:'/api/competencies',{method:item?'PATCH':'POST',body:JSON.stringify(form)});toast('Kompetenz gespeichert.');route('competencyCatalog')})}
  async function positions(){
    const [positionData,competencyData]=await Promise.all([api('/api/positions?includeInactive=true'),api('/api/competencies?includeInactive=true')]);
    state.positions=positionData.items; state.competencies=competencyData.items;
    if(!state.positionId||!state.positions.some(item=>item.id===state.positionId))state.positionId=state.positions[0]?.id||null;
    const selected=state.positions.find(item=>item.id===state.positionId);
    const requirements=selected?(await api('/api/positions/'+selected.id+'/requirements')).items:[];
    return `<header class="top"><div><h1>Positionsprofile</h1><p>Wiederverwendbare Positionen mit transparenten Kompetenzanforderungen.</p></div><button class="btn primary" data-talent-action="add-position">+ Positionsprofil</button></header><section class="cards"><article class="card"><h2>Positionsprofile</h2><div class="talent-list">${state.positions.map(item=>`<div class="talent-item ${item.id===state.positionId?'selected':''}"><button class="plainButton" data-talent-action="select-position" data-id="${item.id}"><b>${esc(item.title)}</b><small>${item.active?'Aktiv':'Inaktiv'}</small></button><div><button class="btn" data-talent-action="edit-position" data-id="${item.id}">Bearbeiten</button><button class="btn" data-talent-action="toggle-position" data-id="${item.id}">${item.active?'Deaktivieren':'Aktivieren'}</button></div></div>`).join('')||'<p class="muted">Noch kein Positionsprofil.</p>'}</div></article><article class="card wide">${selected?`<div class="sectionHead"><div><h2>${esc(selected.title)}</h2><p class="muted">${esc(selected.description||'Keine Beschreibung')}</p></div><button class="btn primary" data-talent-action="add-requirement">+ Anforderung</button></div>${requirements.length?`<div class="tableWrap"><table class="table talent-table"><thead><tr><th>Kompetenz</th><th>Soll</th><th>Pflicht</th><th>Gewicht</th><th>Status</th><th></th></tr></thead><tbody>${requirements.map(item=>`<tr><td><b>${esc(item.competency_name)}</b><small>${categories[item.category]}</small></td><td>${item.required_level}/5</td><td>${yesNo(item.mandatory)}</td><td>${item.weight}</td><td><span class="tag ${item.active?'':'focus'}">${item.active?'Aktiv':'Inaktiv'}</span></td><td><button class="btn" data-talent-action="edit-requirement" data-id="${item.id}">Bearbeiten</button> <button class="btn" data-talent-action="toggle-requirement" data-id="${item.id}">${item.active?'Deaktivieren':'Aktivieren'}</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Noch keine Kompetenzanforderungen definiert.</p>'}`:'<p class="muted">Lege zuerst ein Positionsprofil an.</p>'}</article></section>`;
  }
  function positionForm(item=null){showModal(item?'Positionsprofil bearbeiten':'Positionsprofil anlegen',`<label>Titel *</label><input name="title" required value="${esc(item?.title||'')}"><label>Beschreibung</label><textarea name="description">${esc(item?.description||'')}</textarea>`,async form=>{await api(item?'/api/positions/'+item.id:'/api/positions',{method:item?'PATCH':'POST',body:JSON.stringify(form)});toast('Positionsprofil gespeichert.');route('positionProfiles')})}
  function requirementForm(item=null){
    const choices=state.competencies.filter(comp=>comp.active||comp.id===item?.competency_id);
    showModal(item?'Anforderung bearbeiten':'Kompetenzanforderung ergänzen',`${item?'':`<label>Kompetenz *</label><select name="competencyId" required><option value="">Bitte auswählen</option>${choices.map(comp=>`<option value="${comp.id}">${esc(comp.name)} · ${categories[comp.category]}</option>`).join('')}</select>`}<label>Erforderliches Niveau *</label><select name="requiredLevel">${[1,2,3,4,5].map(level=>`<option value="${level}" ${item?.required_level===level?'selected':''}>${level} · ${levelLabels[level]}</option>`).join('')}</select><label>Gewicht (1–100) *</label><input type="number" name="weight" min="1" max="100" value="${item?.weight||1}"><label class="checkline"><input type="checkbox" name="mandatory" ${item?.mandatory||!item?'checked':''}> Pflichtkompetenz</label><label>Kommentar</label><textarea name="comment">${esc(item?.comment||'')}</textarea>`,async form=>{const url=item?'/api/positions/requirements/'+item.id:'/api/positions/'+state.positionId+'/requirements';await api(url,{method:item?'PATCH':'POST',body:JSON.stringify(form)});toast('Positionsanforderung gespeichert.');route('positionProfiles')})
  }
  function overviewQuery(){const q=new URLSearchParams();Object.entries(state.overview).forEach(([key,value])=>{if(value)q.set(key,value)});return q.toString()}
  async function overview(){
    const [result,users,positions,competencies]=await Promise.all([api('/api/talent/overview?'+overviewQuery()),api('/api/users'),api('/api/positions'),api('/api/competencies')]);
    const accounts=Object.fromEntries(users.users.map(user=>[user.id,user]));
    const isActive=key=>Boolean(state.overview[key]);
    const filterClass=key=>`filterControl${isActive(key)?' is-active':''}`;
    const activeCount=Object.keys(state.overview).filter(isActive).length;
    return `<header class="top"><div><h1>Mitarbeitende</h1><p>Konten, Führungskräftezuordnung, Positionen und Talentdaten zentral verwalten.</p></div><button class="btn primary" data-open="person">+ Person anlegen</button></header><article class="card overview-filter-card"><div class="filterHeader"><div><h2>Personen filtern</h2><p class="muted">Die Ergebnisliste aktualisiert sich automatisch.</p></div><span class="filterStatus ${activeCount?'is-active':''}">${activeCount?`${activeCount} Filter aktiv`:'Alle Mitarbeitenden'}</span></div><form id="talentOverviewFilters" class="filterGrid"><div class="${filterClass('search')}"><label>Suche</label><input name="search" value="${esc(state.overview.search)}" placeholder="Name oder Position" autocomplete="off"></div><div class="${filterClass('managerId')}"><label>Direkte Führungskraft</label><select name="managerId"><option value="">Alle</option>${optionList(users.users,'id','name',state.overview.managerId)}</select></div><div class="${filterClass('positionId')}"><label>Positionsprofil</label><select name="positionId"><option value="">Alle</option>${optionList(positions.items,'id','title',state.overview.positionId)}</select></div><div class="${filterClass('competencyId')}"><label>Kompetenz vorhanden</label><select name="competencyId"><option value="">Alle</option>${optionList(competencies.items,'id','name',state.overview.competencyId)}</select></div><div class="${filterClass('gapStatus')}"><label>Kompetenzlücke</label><select name="gapStatus"><option value="">Alle</option>${Object.entries(gapStates).map(([key,label])=>`<option value="${key}" ${state.overview.gapStatus===key?'selected':''}>${label}</option>`).join('')}</select></div><label class="filterControl filterCheck ${isActive('missingManager')?'is-active':''}"><input type="checkbox" name="missingManager" ${state.overview.missingManager?'checked':''}><span><b>Fehlende Bewertung</b><small>Ohne Führungskräfteeinschätzung</small></span></label><div class="filterActions"><button type="button" class="btn filterReset" data-talent-filter-reset ${activeCount?'':'disabled'}><span aria-hidden="true">↺</span> Alle zurücksetzen</button></div></form></article><article class="card" style="margin-top:16px"><div class="tableWrap"><table class="table talent-table"><thead><tr><th>Person & Konto</th><th>Direkte Führungskraft</th><th>Kompetenzen</th><th>Offene Entwicklungsziele</th><th>Positionsabdeckung</th><th>Hohe Lücken</th><th></th></tr></thead><tbody>${result.rows.map(row=>{const account=accounts[row.id]||row,manager=row.manager_id?accounts[row.manager_id]?.name||'–':'Keine (oberste Ebene)';return `<tr><td><b>${esc(row.name)}</b><small>${esc(account.email||'–')} · ${esc(roleLabel(account.role))}<br>${esc(row.title||'–')}</small></td><td>${esc(manager)}</td><td>${row.competencyCount}<small>${row.missingManagerCount?' · '+row.missingManagerCount+' ohne Führungskraft':''}</small></td><td>${row.developmentGoalCount}</td><td>${row.positionFit===null?'–':row.positionFit+'%'}</td><td>${row.highGapCount}</td><td><button class="btn primary" data-talent-person="${row.id}">Talentprofil</button> <button class="btn" data-assign="${row.id}">Führungskraft</button></td></tr>`;}).join('')||'<tr><td colspan="7" class="muted">Keine Personen für diesen Filter.</td></tr>'}</tbody></table></div></article>`;
  }
  async function action(name,id){
    const p=state.profile;
    if(name==='back-team')return route(isHr()?'talentOverview':'team');
    if(name==='edit-career')return careerForm();
    if(name==='career-note')return careerNote();
    if(name==='add-experience')return experienceForm();
    if(name==='edit-experience')return experienceForm(p.experiences.find(item=>item.id===Number(id)));
    if(name==='delete-experience'&&confirm('Berufserfahrung wirklich ausblenden?')){await api('/api/talent/experiences/'+id,{method:'DELETE'});toast('Berufserfahrung entfernt.');return refreshProfile()}
    if(name==='add-qualification')return qualificationForm();
    if(name==='edit-qualification')return qualificationForm(p.qualifications.find(item=>item.id===Number(id)));
    if(name==='delete-qualification'&&confirm('Qualifikation wirklich ausblenden?')){await api('/api/talent/qualifications/'+id,{method:'DELETE'});toast('Qualifikation entfernt.');return refreshProfile()}
    if(name==='add-language')return languageForm();
    if(name==='edit-language')return languageForm(p.languages.find(item=>item.id===Number(id)));
    if(name==='delete-language'&&confirm('Sprachkenntnis wirklich ausblenden?')){await api('/api/talent/languages/'+id,{method:'DELETE'});toast('Sprachkenntnis entfernt.');return refreshProfile()}
    if(name==='self-assessment')return assessmentForm('self');
    if(name==='manager-assessment')return assessmentForm('manager');
    if(name==='development-goal')return developmentGoalForm();
    if(name==='assign-position')return assignPosition();
    if(name==='add-competency')return competencyForm();
    if(name==='edit-competency')return competencyForm(state.competencies.find(item=>item.id===Number(id)));
    if(name==='toggle-competency'){const item=state.competencies.find(item=>item.id===Number(id));if(confirm(`${item.active?'Deaktivieren':'Aktivieren'}: ${item.name}?`)){await api('/api/competencies/'+id+'/active',{method:'PATCH',body:JSON.stringify({active:!item.active})});toast('Kompetenzstatus geändert.');return route('competencyCatalog')}}
    if(name==='add-position')return positionForm();
    if(name==='select-position'){state.positionId=Number(id);return route('positionProfiles')}
    if(name==='edit-position')return positionForm(state.positions.find(item=>item.id===Number(id)));
    if(name==='toggle-position'){const item=state.positions.find(item=>item.id===Number(id));if(confirm(`${item.active?'Deaktivieren':'Aktivieren'}: ${item.title}?`)){await api('/api/positions/'+id+'/active',{method:'PATCH',body:JSON.stringify({active:!item.active})});toast('Positionsprofilstatus geändert.');return route('positionProfiles')}}
    if(name==='add-requirement')return requirementForm();
    const req=(await api('/api/positions/'+state.positionId+'/requirements')).items.find(item=>item.id===Number(id));
    if(name==='edit-requirement')return requirementForm(req);
    if(name==='toggle-requirement'&&confirm(`${req.active?'Deaktivieren':'Aktivieren'}: ${req.competency_name}?`)){await api('/api/positions/requirements/'+id+'/active',{method:'PATCH',body:JSON.stringify({active:!req.active})});toast('Anforderungsstatus geändert.');return route('positionProfiles')}
  }
  window.talentPages={profile,competencies,positions,overview};
  window.talentBind=()=>{
    document.querySelectorAll('[data-talent-person]').forEach(button=>button.onclick=()=>window.loop.openTalentProfile(button.dataset.talentPerson));
    document.querySelectorAll('[data-talent-action]').forEach(button=>button.onclick=()=>action(button.dataset.talentAction,button.dataset.id).catch(error=>toast(error.message,'error')));
    const managerAssessmentForm=document.querySelector('#managerAssessmentForm');
    if(managerAssessmentForm)managerAssessmentForm.onsubmit=async event=>{
      event.preventDefault();
      const assessments=[];
      for(const row of managerAssessmentForm.querySelectorAll('[data-competency-id]')){
        const rating=row.querySelector('[data-manager-rating]').value;
        const comment=row.querySelector('[data-manager-comment]').value.trim();
        if(rating===row.dataset.originalRating&&comment===row.dataset.originalComment)continue;
        if(!rating&&comment&&row.dataset.originalRating==='')return toast(`Für „${row.dataset.competencyName}“ wähle bitte erst eine Bewertung aus oder entferne die Begründung.`,'error');
        assessments.push({competencyId:Number(row.dataset.competencyId),rating:rating?Number(rating):null,comment});
      }
      if(!assessments.length)return toast('Es wurden keine Änderungen erkannt.');
      try{
        await api('/api/talent/competencies/manager-assessments',{method:'POST',body:JSON.stringify({userId:state.profile.user.id,assessments})});
        toast(`${assessments.length} Kompetenzbewertung${assessments.length===1?'':'en'} gespeichert.`);
        refreshProfile();
      }catch(error){toast(error.message||'Kompetenzbewertungen konnten nicht gespeichert werden.','error');}
    };
    const filters=document.querySelector('#talentOverviewFilters');
    if(filters){
      const applyFilters=()=>{if(!filters.isConnected)return;const data=new FormData(filters),values=Object.fromEntries(data);state.overview={search:values.search||'',managerId:values.managerId||'',positionId:values.positionId||'',competencyId:values.competencyId||'',missingManager:data.has('missingManager'),gapStatus:values.gapStatus||''};route('talentOverview')};
      filters.onsubmit=event=>{event.preventDefault();window.clearTimeout(overviewSearchTimer);applyFilters()};
      filters.querySelectorAll('select,input[type="checkbox"]').forEach(control=>control.onchange=applyFilters);
      // Die Seite wird beim Suchen neu aufgebaut. Fokus und alles seither Getippte bleiben erhalten.
      const searchInput=filters.elements.search;
      if(state.searchTyping!==undefined&&Date.now()-state.searchTypedAt<3000){
        searchInput.value=state.searchTyping;
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length,searchInput.value.length);
        if(state.searchTyping!==state.overview.search)overviewSearchTimer=window.setTimeout(applyFilters,300);
      }
      searchInput.oninput=()=>{state.searchTyping=searchInput.value;state.searchTypedAt=Date.now();window.clearTimeout(overviewSearchTimer);overviewSearchTimer=window.setTimeout(applyFilters,300)};
      filters.querySelector('[data-talent-filter-reset]').onclick=()=>{window.clearTimeout(overviewSearchTimer);state.searchTyping=undefined;state.overview={search:'',managerId:'',positionId:'',competencyId:'',missingManager:false,gapStatus:''};route('talentOverview')};
    }
  };
})();
