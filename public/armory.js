(() => {
  'use strict';
  const hosts=new WeakMap(),activeHosts=new Set(),cache=new Map();let generation=0;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not yet observed';
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const safeSection=section=>section&&typeof section==='object'?section:{status:'unavailable',data:null};
  function freshness(section){
    const status=section.status==='verified'?'Observed':section.data?'Previous observation':'Unavailable';
    return `<p class="armory-freshness">${status} · ${escape(time(section.observed_at))}</p>${section.note?`<p class="armory-note">${escape(section.note)}</p>`:''}${section.checked_at&&section.checked_at!==section.observed_at?`<p class="armory-attempt">Last attempt: ${escape(time(section.checked_at))}</p>`:''}`;
  }
  const slotOrder=['HEAD','NECK','SHOULDER','BACK','CHEST','SHIRT','TABARD','WRIST','HANDS','WAIST','LEGS','FEET','FINGER_1','FINGER_2','TRINKET_1','TRINKET_2','MAIN_HAND','OFF_HAND','RANGED'];
  const leftSlots=new Set(slotOrder.slice(0,8)),rightSlots=new Set(slotOrder.slice(8,16)),weaponSlots=new Set(slotOrder.slice(16));
  function itemFacts(item){
    const rows=[numeric(item.required_level)?'Requires level '+item.required_level:'',item.binding,item.weapon_damage,numeric(item.weapon_speed)?'Weapon speed '+item.weapon_speed:'',item.durability].filter(Boolean);
    const stats=Array.isArray(item.stats)?item.stats.slice(0,30):[],enchants=Array.isArray(item.enchantments)?item.enchantments.slice(0,20):[];
    return `${rows.map(value=>`<p>${escape(value)}</p>`).join('')}${stats.length?`<ul>${stats.map(stat=>`<li>${escape(stat.display||stat.name||'Returned statistic')}${!stat.display&&numeric(stat.value)?': '+escape(stat.value):''}</li>`).join('')}</ul>`:''}${item.enchantments_status==='observed'?enchants.length?`<p class="armory-detail-label">Returned enchantments</p><ul>${enchants.map(enchant=>`<li>${escape(enchant.name||'Unnamed enchantment')}</li>`).join('')}</ul>`:'<p>No enchantments were returned for this item.</p>':'<p>Enchantment data was not returned.</p>'}${!rows.length&&!stats.length?'<p>No additional item statistics were returned.</p>':''}`;
  }
  function gearItem(item,state){
    const quality=['POOR','COMMON','UNCOMMON','RARE','EPIC','LEGENDARY','ARTIFACT','HEIRLOOM'].includes(item.quality)?item.quality.toLowerCase():'unknown';
    const icon=Number.isSafeInteger(item.id)&&item.id>0&&item.icon_url===`/api/characters/${state.id}/armory/item/${item.id}/icon`?item.icon_url:null;
    return `<li class="armory-item quality-${quality}" data-armory-slot="${escape(item.slot||'UNKNOWN')}"><details class="armory-item-details" name="armory-item-${state.id}"><summary aria-label="Equipment details for ${escape(item.name||'Unnamed item')}"><span class="armory-slot-mark" aria-hidden="true">${icon?`<img src="${escape(icon)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-armory-icon><span class="armory-icon-fallback" hidden>◇</span>`:'◇'}</span><span class="armory-item-label"><strong>${escape(item.name||'Unnamed item')}</strong><span class="armory-slot-name">${escape(item.slot_name||item.slot||'Returned slot')}${numeric(item.item_level)?' · Item level '+escape(item.item_level):''}</span></span><span class="armory-item-more" aria-hidden="true">⌕</span></summary><div class="armory-item-tooltip"><h5>${escape(item.name||'Unnamed item')}</h5><p>${[item.item_subclass,item.inventory_type,numeric(item.item_level)?'Item level '+item.item_level:''].filter(Boolean).map(escape).join(' · ')||'Additional item details unavailable'}</p>${itemFacts(item)}</div></details></li>`;
  }
  function gearRail(items,side,state){
    return `<ul class="armory-gear armory-gear-${side}" aria-label="${side==='weapons'?'Returned weapons':side==='left'?'Returned left equipment slots':'Returned right equipment slots'}">${items.map(item=>gearItem(item,state)).join('')}</ul>`;
  }
  function sourceDetails(sections,payload){
    return `<details class="armory-sources"><summary><span>Blizzard snapshots · equipment ${escape(time(sections.equipment.observed_at))}</span><span>Data details</span></summary><div class="armory-source-grid">${[['equipment','Equipment'],['media','Artwork'],['statistics','Statistics']].map(([key,name])=>`<section><h5>${name}</h5>${freshness(sections[key])}</section>`).join('')}</div><p class="armory-footnote">${escape(payload.note||'Only returned equipment and statistics are shown. Missing slots and enchantment fields remain unknown. Snapshots can lag behind the game.')}</p></details>`;
  }
  function mediaURL(asset,id){
    const expected=`/api/characters/${id}/armory/media/`;
    return asset&&['main-raw','main','inset','avatar'].includes(asset.key)&&asset.url===expected+asset.key?asset.url:null;
  }
  function draw(state){
    const host=state.host,payload=state.payload;
    if(!payload){host.innerHTML=`<section class="armory-folio" aria-label="Character armory"><div class="armory-heading"><h3>Character armory</h3><span aria-hidden="true">✦</span></div><p role="status">${state.error?'The armory could not be loaded. Your saved roster and talent details remain available.':'Opening the character’s armory…'}</p>${state.error?'<button type="button" class="armory-retry" data-armory-retry>Try again</button>':''}</section>`;return;}
    const sections=payload.sections||{},equipment=safeSection(sections.equipment),statistics=safeSection(sections.statistics),media=safeSection(sections.media);
    const items=Array.isArray(equipment.data?.items)?equipment.data.items.slice(0,30).sort((a,b)=>slotOrder.indexOf(a.slot)-slotOrder.indexOf(b.slot)):[],values=Array.isArray(statistics.data?.values)?statistics.data.values.slice(0,30).filter(value=>numeric(value.value)):[];
    const assets=Array.isArray(media.data?.assets)?media.data.assets:[],asset=['main-raw','main','inset','avatar'].map(key=>assets.find(asset=>asset.key===key&&mediaURL(asset,state.id))).find(Boolean),image=mediaURL(asset,state.id);
    const itemLevel=equipment.data?.equipped_item_level;
    const left=items.filter(item=>leftSlots.has(item.slot)),right=items.filter(item=>rightSlots.has(item.slot)),weapons=items.filter(item=>weaponSlots.has(item.slot));
    const limited=Object.values({equipment,statistics,media}).some(section=>section.status!=='verified');
    host.innerHTML=`<section class="armory-folio" aria-label="Character armory"><div class="armory-heading"><h3>Character armory</h3><p>${numeric(itemLevel)?'Equipped item level '+escape(itemLevel)+' · ':''}${items.length} returned ${items.length===1?'item':'items'} · select an item for details</p></div>${state.error?'<p class="armory-note">The latest request failed. Showing the previous armory observation.</p>':''}<div class="armory-layout" aria-label="Character equipment">${gearRail(left,'left',state)}<section class="armory-portrait${asset?.key==='avatar'?' armory-avatar-only':''}" aria-label="Character artwork">${image?`<img src="${escape(image)}" alt="${escape(state.member.name||'Character')} · Blizzard character artwork" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-armory-portrait><p class="armory-image-fallback" hidden>Character artwork is temporarily unavailable.</p>`:'<div class="armory-no-art" aria-hidden="true">♜</div><p>Blizzard has not returned supported character artwork.</p>'}</section>${gearRail(right,'right',state)}${weapons.length?gearRail(weapons,'weapons',state):''}</div>${!equipment.data?'<p class="armory-empty">Equipment has not been published or could not be verified. No empty slots are inferred.</p>':!items.length?'<p class="armory-empty">Blizzard returned an empty equipped-item list. This snapshot may lag behind the game.</p>':''}<section class="armory-statistics" aria-label="Character statistics">${values.length?`<dl class="armory-stat-grid">${values.map(value=>`<div><dt>${escape(value.name||'Returned statistic')}</dt><dd>${escape(Number.isInteger(value.value)?value.value:value.value.toFixed(1))}${value.unit==='%'?'%':''}</dd></div>`).join('')}</dl>`:'<p class="armory-empty">Character statistics are not available. Missing values remain unknown.</p>'}</section><div class="armory-footer">${sourceDetails({equipment,statistics,media},payload)}<button type="button" class="armory-retry" data-armory-retry>Refresh view</button></div>${limited?'<p class="armory-limited">Some sections are unavailable or retain older observations. Open data details for their last successful checks.</p>':''}</section>`;
    const portrait=host.querySelector('[data-armory-portrait]');
    portrait?.addEventListener('error',()=>{if(hosts.get(host)!==state||host.querySelector('[data-armory-portrait]')!==portrait)return;portrait.hidden=true;const fallback=host.querySelector('.armory-image-fallback');if(fallback)fallback.hidden=false;},{once:true});
    for(const icon of host.querySelectorAll?.('[data-armory-icon]')||[])icon.addEventListener('error',()=>{icon.hidden=true;const fallback=icon.parentElement?.querySelector('.armory-icon-fallback');if(fallback)fallback.hidden=false;},{once:true});
  }
  async function request(member,force){
    const id=Number(member.id),existing=cache.get(id);
    if(!force&&existing&&existing.until>Date.now())return existing.payload||existing.promise;
    const entry={until:Date.now()+60000,payload:null,promise:null};
    entry.promise=(async()=>{
      const response=await fetch(`/api/characters/${id}/armory`,{cache:'no-store'}),payload=await response.json();
      if(window.GuildAccess?.check(response,payload)){cache.clear();throw Error('Guild access changed');}
      if(!response.ok||Number(payload?.character_id)!==id||!payload.sections||typeof payload.sections!=='object')throw Error('Armory unavailable');
      entry.payload=payload;entry.until=Date.now()+60000;return payload;
    })();
    cache.delete(id);cache.set(id,entry);while(cache.size>32)cache.delete(cache.keys().next().value);
    try{return await entry.promise;}catch(error){if(cache.get(id)===entry)cache.delete(id);throw error;}
  }
  async function mount(host,member,force=false){
    const id=Number(member?.id);if(!host||!Number.isSafeInteger(id)||id<1)return;
    let state=hosts.get(host);
    if(!state){
      state={host,sequence:0};hosts.set(host,state);
      host.addEventListener('click',event=>{if(event.target.closest?.('[data-armory-retry]')){const current=hosts.get(host);if(current?.member)mount(host,current.member,true);}});
      host.addEventListener('keydown',event=>{
        if(event.key!=='Escape')return;
        const open=[...(host.querySelectorAll?.('.armory-item-details[open]')||[])];if(!open.length)return;
        event.preventDefault();event.stopPropagation?.();for(const item of open)item.open=false;open[0].querySelector('summary')?.focus();
      });
    }
    activeHosts.add(host);for(const active of activeHosts)if(active.isConnected===false)activeHosts.delete(active);
    const sequence=++state.sequence,currentGeneration=generation,same=state.id===id;
    state.member=member;state.id=id;state.error=false;if(!same)state.payload=null;
    draw(state);
    try{const payload=await request(member,force);if(state.sequence!==sequence||host.isConnected===false||generation!==currentGeneration)return;state.payload=payload;draw(state);}
    catch{if(state.sequence!==sequence||host.isConnected===false||generation!==currentGeneration)return;state.error=true;draw(state);}
  }
  function unmount(host){activeHosts.delete(host);const state=hosts.get(host);if(state){state.sequence++;state.payload=null;state.member=null;state.id=null;host.innerHTML='';}}
  function reset(){generation++;cache.clear();for(const host of activeHosts)unmount(host);}
  window.GuildArmory={mount,unmount,reset};
})();
