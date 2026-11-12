(()=>{
  'use strict';
  const host=document.getElementById('event-templates'),optionsHost=document.getElementById('event-template-options'),form=document.getElementById('event-form');if(!host||!optionsHost||!form)return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=100?value:null;
  const level=value=>Number.isSafeInteger(value)&&value>=1&&value<=100?value:null;
  const roles=['Tank','Healer','Damage'],icons={Tank:'🛡️',Healer:'💚',Damage:'⚔️'};
  let auth=null,generation=0,sequence=0,wanted=false,loading=false,catalogue=null,selected=null,search='',kind='',shown=3,message='',error=false;
  function safeLink(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
  function date(value){const result=new Date(value);return value&&Number.isFinite(result.getTime())?result.toLocaleDateString(undefined,{dateStyle:'medium'}):'Check date unavailable';}
  function validTemplate(value){return value&&typeof value.id==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.id)&&typeof value.name==='string'&&['Dungeon','Raid'].includes(value.kind)&&Number.isSafeInteger(value.capacity)&&value.capacity>0&&value.capacity<=40;}
  function sourceLinks(value){const sources=Array.isArray(value?.sources)?value.sources.slice(0,5):[];return sources.map(source=>{const url=safeLink(source.url);return url?`<li><a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(source.title||'Source')} ↗</a></li>`:'';}).join('');}
  function evidence(value,className=''){const links=sourceLinks(value),notes=typeof value?.notes==='string'?value.notes:Array.isArray(value?.notes)?value.notes.join(' '):'';return notes||links?`<details class="event-template-evidence ${className}"><summary>Notes &amp; sources</summary>${notes?`<p>${esc(notes)}</p>`:''}${links?`<ul>${links}</ul>`:''}</details>`:'';}
  function minimumText(value){const minimum=level(value?.minimum_level),status=value?.minimum_level_status;return minimum===null?'Minimum entry level unverified':`Minimum entry level ${minimum}${status==='verified'?' · verified':status==='guide'?' · host guidance':' · unverified'}`;}
  function recommendedText(value){
    const minimum=level(value?.recommended_level?.min),maximum=level(value?.recommended_level?.max);
    if(minimum===null||maximum===null||minimum>maximum)return 'Recommended levels unverified';
    const labels={verified:'verified',group_finder:'Group Finder',guide:'guide'};
    const label=value.recommended_level_source==='member'?'host guidance':(Object.hasOwn(labels,value.recommended_level_status)?labels[value.recommended_level_status]:'unverified');
    return `Recommended levels ${minimum===maximum?minimum:minimum+'–'+maximum} · ${label}`;
  }
  function groupSizeLabel(status){
    if(status==='verified')return 'Verified group size';
    if(status==='group_finder')return 'Group Finder size';
    return 'Planning estimate · size unverified';
  }
  function roleText(value){const limits=value?.role_limits;return limits&&roles.every(role=>count(limits[role])!==null)?roles.map(role=>`${limits[role]} ${role==='Damage'?'damage':role.toLowerCase()+(limits[role]===1?'':'s')}`).join(' · '):'Choose your party’s role balance';}
  function statusLabel(value){return value==='available'?'Available':value==='announced'?'Coming later':'Availability unverified';}
  function templateCard(value){
    const links=sourceLinks(value),notes=typeof value.notes==='string'?value.notes:Array.isArray(value.notes)?value.notes.join(' '):'';
    return `<article class="event-template-card"><div class="event-template-card-top"><span class="eyebrow gold">${esc(value.kind)}</span><span class="event-template-status ${value.status==='available'?'available':value.status==='announced'?'announced':'unverified'}">${statusLabel(value.status)}</span></div><h4>${esc(value.name)}</h4><p class="event-template-capacity"><strong>${value.capacity} players</strong><span>${groupSizeLabel(value.capacity_status)}</span></p><p class="event-template-role-guide"><span aria-hidden="true">🛡️ 💚 ⚔️</span> ${esc(roleText(value))}<small>Suggested role balance</small></p><ul class="event-template-levels"><li>${esc(minimumText(value))}</li><li>${esc(recommendedText(value))}</li></ul>${value.location?`<p class="event-template-location">${esc(value.location)}</p>`:''}${notes||links?`<details class="event-template-evidence"><summary>Notes &amp; sources</summary>${notes?`<p>${esc(notes)}</p>`:''}${links?`<ul>${links}</ul>`:''}</details>`:''}<button class="button secondary" type="button" data-event-template="${esc(value.id)}">Plan this ${value.kind==='Raid'?'raid':'dungeon'} <span aria-hidden="true">→</span></button></article>`;
  }
  function render(){
    if(!auth){host.innerHTML='<section class="panel event-template-gate"><h3>Find your next adventure</h3><p>Sign in as a verified guild member to browse dungeon and raid plans.</p></section>';return;}
    const templates=catalogue?.templates||[],filtered=templates.filter(value=>(!kind||value.kind===kind)&&(!search||[value.name,value.location,value.notes].filter(value=>typeof value==='string').join(' ').toLowerCase().includes(search.toLowerCase())));
    host.innerHTML=`<section class="panel event-template-browser"><div class="event-template-heading"><div><span class="eyebrow gold">FIND YOUR NEXT ADVENTURE</span><h3>Dungeon &amp; raid plans</h3><p>Pick a starting point, then choose your host, date and party. Nothing is created until you submit the event form.</p></div><span class="event-template-compass" aria-hidden="true">✦</span></div><div class="event-template-filters"><label><span>Find a dungeon or raid</span><input type="search" data-event-template-search value="${esc(search)}" maxlength="100" placeholder="Search by name or location…"></label><label><span>Type</span><select data-event-template-kind><option value="">Dungeons &amp; raids</option><option value="Dungeon" ${kind==='Dungeon'?'selected':''}>Dungeons</option><option value="Raid" ${kind==='Raid'?'selected':''}>Raids</option></select></label><button class="text-button" type="button" data-event-template-action="refresh" ${loading?'disabled':''}>Refresh guide</button></div><p class="event-template-feedback${error?' event-template-error':''}" role="status" aria-live="polite" ${message?'':'hidden'}>${esc(message)}</p>${loading&&!catalogue?'<p class="event-template-loading" role="status">Opening the adventure guide…</p>':catalogue?`<div class="event-template-grid">${filtered.slice(0,shown).map(templateCard).join('')}</div>${!filtered.length?'<p class="event-template-empty">No adventures match those filters. Try another name or choose both types.</p>':''}${filtered.length>shown?`<button class="button secondary event-template-more" type="button" data-event-template-action="more">Show more adventures (${filtered.length-shown})</button>`:''}<div class="event-template-footnote"><p>${filtered.length} ${filtered.length===1?'plan':'plans'}${kind?' · '+esc(kind==='Raid'?'raids':'dungeons'):''} · Guide checked ${esc(date(catalogue.checked_at))}</p><p>${esc(catalogue.note||'Group roles and durations are suggested planning defaults. Unverified fields and future releases are labelled. Recommended levels do not establish entry requirements.')}</p></div>`:'<p class="event-template-empty">The guide could not be loaded. You can still plan a custom event.</p>'}</section>`;
  }
  function renderOptions(value=null){
    const limits=value?.role_limits,hasRoles=Boolean(limits&&roles.every(role=>count(limits[role])!==null)),minimum=level(value?.minimum_level),low=level(value?.recommended_level?.min),high=level(value?.recommended_level?.max);
    optionsHost.innerHTML=`<input type="hidden" name="template_id" value="${esc(value?.id||'')}"><div class="event-plan-options"><div class="event-plan-summary">${value?`<span class="eyebrow gold">STARTING FROM THE GUIDE</span><strong>${esc(value.name)}</strong><p>${esc(statusLabel(value.status))}. ${esc(minimumText(value))}. ${esc(recommendedText(value))}.</p><button type="button" class="text-button" data-event-template-action="custom">Use as a custom plan</button>`:'<span class="eyebrow gold">MAKE THE PARTY YOUR OWN</span><p>Choose a guide or set your own party and level guidance.</p>'}</div><fieldset class="event-plan-roles"><legend>Party roles</legend><label class="event-plan-role-toggle"><input type="checkbox" name="template_role_limits" ${hasRoles?'checked':''}>Customise tank, healer and damage places</label><div class="event-plan-role-counts">${roles.map(role=>`<label><span><span aria-hidden="true">${icons[role]}</span> ${role}</span><input type="number" name="template_${role.toLowerCase()}" min="0" max="40" value="${hasRoles?limits[role]:role==='Damage'?3:1}" ${hasRoles?'':'disabled'}></label>`).join('')}</div><p class="subtle event-plan-role-note">Role places must add up to the total places. Five-person dungeons use one tank, one healer and three damage places unless customised. These limits apply to sign-ups; members choose their own role.</p></fieldset><fieldset class="event-plan-levels"><legend>Level guidance <span>(optional)</span></legend><label>Minimum entry level<input name="minimum_level" type="number" min="1" max="100" value="${minimum??''}" placeholder="Unverified"></label><div class="form-pair"><label>Recommended from<input name="template_level_min" type="number" min="1" max="100" value="${low??''}" placeholder="Any level"></label><label>Recommended to<input name="template_level_max" type="number" min="1" max="100" value="${high??''}" placeholder="Any level"></label></div><p class="subtle">These are planning guides. Changed values are labelled as host guidance, and level snapshots do not block sign-ups.</p></fieldset>${value?evidence(value,'event-plan-evidence'):''}<p class="event-plan-edit-note subtle">All defaults can be edited. Choose the host character and start time before creating the event.</p></div>`;
    updateCombat();
  }
  function updateCombat(){
    const combat=['Dungeon','Raid'].includes(form.elements.kind?.value),toggle=form.elements.template_role_limits;
    if(toggle){toggle.disabled=!combat;if(!combat)toggle.checked=false;}
    for(const role of roles){const field=form.elements['template_'+role.toLowerCase()];if(field)field.disabled=!combat||!toggle?.checked;}
    if(selected&&selected.kind!==form.elements.kind?.value){selected=null;if(form.elements.template_id)form.elements.template_id.value='';}
  }
  function reset(){auth=null;generation++;sequence++;wanted=false;loading=false;catalogue=null;selected=null;search='';kind='';shown=3;message='';error=false;render();optionsHost.innerHTML='';}
  async function load(force=false){
    wanted=true;if(!auth){render();return;}if(loading)return;if(catalogue&&!force){render();return;}
    const epoch=generation,account=auth.user_id,version=++sequence;loading=true;message='';error=false;render();
    try{
      const response=await fetch('/api/event-templates',{cache:'no-store'}),result=await response.json();
      if(window.GuildAccess?.check(response,result)||response.status===401||result?.access_required===true){reset();return;}
      if(!response.ok||result?.schema_version!==1||!Array.isArray(result.templates))throw Error('Guide unavailable');
      if(!auth||epoch!==generation||account!==auth.user_id||version!==sequence)return;
      catalogue={...result,templates:result.templates.filter(validTemplate).slice(0,100)};loading=false;render();
    }catch{if(!auth||epoch!==generation||account!==auth.user_id||version!==sequence)return;loading=false;message='The latest guide could not be loaded. Saved plans remain available, and you can create a custom event below.';error=true;render();}
  }
  function choose(id){
    const value=catalogue?.templates.find(value=>value.id===id);if(!auth||!value)return;
    selected=value;for(const [key,data]of Object.entries({title:value.name,kind:value.kind,capacity:value.capacity,location:value.location||'',duration_minutes:value.duration_minutes||120}))if(form.elements[key])form.elements[key].value=String(data);
    renderOptions(value);window.GuildHall?.compose('events');form.elements.starts_at?.focus({preventScroll:true});
    message=`${value.name} is ready in the event form. Choose your host and date, then review the editable party settings.`;error=false;render();
  }
  function read(target=form,raw={}){
    const data={...raw},fields=target.elements,combat=['Dungeon','Raid'].includes(fields.kind?.value),limitsOn=combat&&fields.template_role_limits?.checked;
    for(const key of ['template_role_limits','template_tank','template_healer','template_damage','template_level_min','template_level_max'])delete data[key];
    const number=(name,optional=false)=>{const text=String(fields[name]?.value??'').trim();if(!text&&optional)return null;const value=Number(text);if(!/^\d+$/.test(text)||!Number.isSafeInteger(value))throw Error('Use whole numbers for role places and level guidance.');return value;};
    const templateId=String(fields.template_id?.value||'');data.template_id=selected&&selected.id===templateId&&selected.kind===fields.kind?.value?templateId:null;
    delete data.role_limits;
    if(limitsOn){const limits=Object.fromEntries(roles.map(role=>[role,number('template_'+role.toLowerCase())]));if(roles.some(role=>limits[role]<0||limits[role]>40)||Object.values(limits).reduce((total,value)=>total+value,0)!==Number(fields.capacity?.value))throw Error('Tank, healer and damage places must add up to the total event places.');data.role_limits=limits;}
    const minimum=number('minimum_level',true),low=number('template_level_min',true),high=number('template_level_max',true);
    if([minimum,low,high].some(value=>value!==null&&(value<1||value>100)))throw Error('Use levels from 1 to 100, or leave unknown level guidance blank.');
    if((low===null)!==(high===null)||low!==null&&low>high)throw Error('Give both ends of the recommended level range, with the lower level first.');
    data.minimum_level=minimum;data.recommended_level=low===null?null:{min:low,max:high};return data;
  }
  function afterReset(){selected=null;if(auth)renderOptions();}
  function eventGuidance(event){
    const value=event?.template_guidance;if(!value||typeof value!=='object')return '';
    const minimum=level(value.minimum_level),low=level(value.recommended_level?.min),high=level(value.recommended_level?.max);if(!value.name&&minimum===null&&low===null)return '';
    return `<div class="event-saved-guidance">${value.name?`<p><strong>${esc(value.name)}</strong>${value.status==='announced'?' · Coming later':value.status==='unverified'?' · Availability unverified':''}</p>`:''}<p>${esc(minimumText(value))} · ${esc(recommendedText(value))}</p><p class="subtle">${value.minimum_level_source==='member'||value.recommended_level_source==='member'||value.level_guide_source==='member'?'Edited level values are host guidance.':'Level guidance from the adventure guide.'} Levels help with planning; they do not block sign-ups.</p>${evidence(value,'event-saved-evidence')}</div>`;
  }
  host.addEventListener('input',event=>{if(!event.target.matches?.('[data-event-template-search]'))return;search=String(event.target.value||'').slice(0,100);shown=3;const input=event.target,selection=input.selectionStart;render();const replacement=host.querySelector('[data-event-template-search]');replacement?.focus();replacement?.setSelectionRange?.(selection,selection);});
  host.addEventListener('change',event=>{if(event.target.matches?.('[data-event-template-kind]')){kind=['Dungeon','Raid'].includes(event.target.value)?event.target.value:'';shown=3;render();}});
  host.addEventListener('click',event=>{const choice=event.target.closest?.('[data-event-template]');if(choice){choose(choice.dataset.eventTemplate);return;}const action=event.target.closest?.('[data-event-template-action]')?.dataset.eventTemplateAction;if(action==='refresh')load(true);if(action==='more'){shown+=6;render();}});
  optionsHost.addEventListener('click',event=>{if(event.target.closest?.('[data-event-template-action="custom"]')){selected=null;if(form.elements.template_id)form.elements.template_id.value='';const summary=optionsHost.querySelector('.event-plan-summary');if(summary)summary.innerHTML='<span class="eyebrow gold">YOUR CUSTOM PLAN</span><p>These are your editable party and level guides.</p>';}});
  form.addEventListener('change',event=>{if(event.target.name==='kind'||event.target.name==='template_role_limits')updateCombat();});
  window.addEventListener('guild-member',event=>{
    const value=event.detail||{};if(!value.verified||typeof value.user_id!=='string'||!value.user_id||typeof value.csrf!=='string'||!value.csrf){reset();return;}
    const requested=wanted,changed=!auth||auth.user_id!==value.user_id||auth.csrf!==value.csrf;
    if(changed)reset();auth={user_id:value.user_id,csrf:value.csrf};if(changed)renderOptions();
    if(requested||document.getElementById('hall-events')?.hidden===false)load();else render();
  });
  window.addEventListener('guild-access-reset',reset);
  window.GuildEventTemplates={load,read,afterReset,eventGuidance,reset};render();
})();
