(()=>{
  'use strict';
  const el=id=>document.getElementById(id),esc=value=>escapeHTML(value);
  let me={signed_in:false},hall=null,hallTab='craft',busy=false,plan=null,componentChoices={},planVersion=0,planTimer,altDirty=false,altSelection=new Set(),crafterVersion=0;
  const profileDrafts=new Map();
  const roleDrafts=new Map();let rolesSaving=false;
  const materialLabels={provided:'Requester can provide materials',need_help:'Requester needs help gathering materials',discuss:'Discuss materials with the requester'};
  const characterOptions=(selectedId=me.main_character_id)=> (me.characters||[]).map(c=>`<option value="${c.id}" ${Number(c.id)===Number(selectedId)?'selected':''}>${esc(c.name)}</option>`).join('');
  function feedback(message,error=false){el('hall-feedback').hidden=false;el('hall-feedback').textContent=message;el('hall-feedback').classList.toggle('ready',!error);}
  async function send(path,data){
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf||''},body:JSON.stringify(data)});
    const result=await response.json();if(window.GuildAccess?.check(response,result))throw new Error('Sign in to reopen the guildhall');if(!response.ok)throw new Error(result.error||'That change could not be saved');return result;
  }
  let accountRefreshVersion=0,sessionRefreshVersion=0,hallRefreshQueued=false,hallPromise=null;
  const accountRevisionFloors=new Map();
  function accountRevision(session){const value=typeof session?.account_updated_at==='string'?Date.parse(session.account_updated_at):NaN;return Number.isFinite(value)?value:0;}
  function olderAccountSession(session){
    const floor=accountRevisionFloors.get(session?.user_id)||0,current=me.user_id===session?.user_id?accountRevision(me):0;
    return accountRevision(session)<Math.max(floor,current);
  }
  function accountSaved(event){
    const detail=event.detail;if(typeof detail?.user_id!=='string'||!detail.user_id||me.user_id&&me.user_id!==detail.user_id)return;
    const revision=accountRevision(detail);if(revision)accountRevisionFloors.set(detail.user_id,Math.max(revision,accountRevisionFloors.get(detail.user_id)||0));
    loadHall({queue:true});
  }
  async function refreshMe(){
    const requestVersion=++sessionRefreshVersion,accountVersion=accountRefreshVersion,session=await fetchJSON('/api/me');
    if(requestVersion!==sessionRefreshVersion||accountVersion!==accountRefreshVersion||olderAccountSession(session))return false;
    const previousAccount=me.user_id;
    me=session;
    if(previousAccount!==me.user_id||!me.verified)roleDrafts.clear();
    if(el('admin-nav'))el('admin-nav').hidden=!me.is_admin;window.dispatchEvent(new CustomEvent('guild-admin',{detail:Boolean(me.is_admin)}));
    window.dispatchEvent(new CustomEvent('guild-players',{detail:me.verified?me.player_links||[]:[]}));
    el('sign-in').textContent=me.signed_in?me.display_name:'Sign in with Battle.net';
    el('sign-in').href=me.signed_in?'#account':'/auth/login';el('sign-in').title=me.signed_in?'Manage My Account':'Sign in with Battle.net';el('sign-out').hidden=!me.signed_in;
    el('hall-gate').hidden=Boolean(me.verified);el('hall-member').hidden=!me.verified;
    el('hall-gate-message').textContent=me.signed_in?me.message:'Sign in with Battle.net to use crafting requests, wishlists, events and member profiles. Your guild characters are verified automatically.';
    el('hall-gate').querySelector('.gate-login').textContent=me.signed_in?'Refresh Battle.net character access':'Sign in with Battle.net';
    el('hall-welcome').textContent=me.verified?`Welcome, ${me.display_name}.`:'';
    if(!me.verified){hall=null;profileDrafts.clear();window.dispatchEvent(new CustomEvent('guild-hall-data',{detail:null}));}
    window.dispatchEvent(new CustomEvent('guild-member',{detail:{verified:me.verified,user_id:me.user_id,is_admin:me.is_admin,characters:me.characters||[],csrf:me.csrf}}));
    window.GuildAccount?.render(me);renderDiscord();fillOwned();return true;
  }
  function renderDiscord(){
    const d=me.discord||{};el('discord-member-status').textContent=!d.configured?`The administrator has not connected ${SITE_BRAND.botName} yet.`:d.linked?`${SITE_BRAND.botName} authorised for your Discord account. You can use event role reactions and choose crafting notifications below.`:`Authorise ${SITE_BRAND.botName} once to match your Discord account to your verified guild character, or ask a guild administrator to map your character.`;
    el('discord-link').hidden=!d.configured||d.linked;el('discord-preferences').hidden=!d.linked;
    for(const key of ['requester_dm','crafter_dm'])el('discord-preferences').elements[key].checked=Boolean(d[key]);
    el('discord-event-note').textContent=d.configured?`${SITE_BRAND.botName} can post an announcement with role reactions in the configured Discord events channel. The event card will link to the announcement when it is posted.`:`${SITE_BRAND.botName} is awaiting setup. Create your event here; a Discord announcement is not available yet.`;
  }
  function fillOwned(){
    document.querySelectorAll('.owned-characters').forEach(select=>{
      const current=select.value;select.innerHTML=characterOptions();if((me.characters||[]).some(c=>String(c.id)===current))select.value=current;
    });
    if(!altDirty){el('main-character').value=me.main_character_id||'';altSelection=new Set((me.characters||[]).filter(c=>c.show_as_alt).map(c=>c.id));}renderAltChoices();fillRoles();
  }
  function readRoleChoices(form=el('role-form')){
    const selected=[...form.querySelectorAll('input[name="preferred_role"]:checked')].map(input=>input.value);
    const roles=roleChoices.filter(role=>selected.includes(role)),primary=form.elements.primary_role?.value||null;
    return {preferred_roles:roles,primary_role:roles.includes(primary)?primary:null};
  }
  function fillRoles(){
    const id=el('role-character').value,char=(me.characters||[]).find(c=>String(c.id)===id),value=roleDrafts.get(id)||char||{};
    const selected=roleChoices.filter(role=>Array.isArray(value.preferred_roles)&&value.preferred_roles.includes(role)),primary=selected.includes(value.primary_role)?value.primary_role:null;
    el('role-options').innerHTML=roleChoices.map(role=>`<div class="role-choice-row"><label><input type="checkbox" name="preferred_role" value="${role}" ${selected.includes(role)?'checked':''} ${!char||rolesSaving?'disabled':''}>${role}</label><label class="role-primary-choice"><input type="radio" name="primary_role" value="${role}" aria-label="${role} as primary role" ${primary===role?'checked':''} ${!selected.includes(role)||rolesSaving?'disabled':''} ${selected.length?'required':''}>Primary</label></div>`).join('');
    el('role-character').disabled=rolesSaving||!me.verified;
    el('role-form').querySelector('[type="submit"]').disabled=!char||rolesSaving;
    el('clear-roles').disabled=!char||rolesSaving;
  }
  function keepRoleDraft(){
    const form=el('role-form'),value=readRoleChoices(form);roleDrafts.set(String(form.elements.character_id.value),value);
    for(const input of form.querySelectorAll('input[name="primary_role"]')){
      input.disabled=!value.preferred_roles.includes(input.value);input.required=value.preferred_roles.length>0;
      input.checked=value.primary_role===input.value;
    }
    el('role-feedback').textContent=value.preferred_roles.length&&!value.primary_role?'Choose one selected role as primary before saving.':'Unsaved changes. Save your role preferences when ready.';
  }
  async function saveRoles(event){
    event.preventDefault();if(rolesSaving)return;
    const form=event.currentTarget,id=Number(form.elements.character_id.value),value=readRoleChoices(form),account=me.user_id,csrf=me.csrf;
    if(!(me.characters||[]).some(c=>c.id===id)){el('role-feedback').textContent='Choose one of your verified characters.';return;}
    if(value.preferred_roles.length&&!value.primary_role){el('role-feedback').textContent='Choose one selected role as primary before saving.';return;}
    roleDrafts.set(String(id),value);rolesSaving=true;fillRoles();
    try{
      const saved=await send('/api/hall/roles',{character_id:id,...value});
      if(!me.verified||me.user_id!==account||me.csrf!==csrf)return;
      const change={character_id:id,...rolePreference(saved),role_preferences_updated_at:saved.role_preferences_updated_at||null};
      roleDrafts.delete(String(id));
      const update=character=>character.id===id?{...character,...change}:character;
      me.characters=me.characters.map(update);
      if(hall){hall.directory=(hall.directory||[]).map(update);for(const person of hall.people||[])person.characters=(person.characters||[]).map(update);renderDirectory();}
      window.dispatchEvent(new CustomEvent('guild-role-saved',{detail:change}));
      el('role-feedback').textContent=saved.message||'Role preferences saved. You can change them at any time.';
      await loadHall();
    }catch(error){el('role-feedback').textContent=error.message;}
    finally{rolesSaving=false;fillRoles();}
  }
  function renderAltChoices(){
    const main=Number(el('main-character').value),chars=(me.characters||[]).filter(c=>c.id!==main);
    el('alt-options').innerHTML=chars.length?chars.map(c=>`<label class="alt-choice"><input type="checkbox" name="alt_id" value="${c.id}" ${altSelection.has(c.id)?'checked':''}>${esc(c.name)}</label>`).join(''):'<p class="subtle">No other guild characters have been returned for this Battle.net account yet. Sign in again after an alt joins the guild.</p>';
  }
  function showHallTab(tab){
    if(!['craft','learn','events','people'].includes(tab))return false;
    hallTab=tab;document.querySelectorAll('.hall-pane').forEach(p=>p.hidden=p.id!=='hall-'+tab);
    document.querySelectorAll('.hall-tabs [data-hall]').forEach(b=>{b.classList.toggle('active',b.dataset.hall===tab);b.setAttribute('aria-pressed',String(b.dataset.hall===tab));});
    window.dispatchEvent(new CustomEvent('guild-hall-pane',{detail:tab}));if(tab==='events')window.GuildEventTemplates?.load();return true;
  }
  function openComposer(formId,focus=false){
    const form=el(formId),composer=form?.closest('details');if(!form)return;
    if(composer)composer.open=true;
    form.scrollIntoView({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
    if(focus)form.querySelector('input:not([type=hidden]),select,textarea')?.focus({preventScroll:true});
  }
  function matching(request){
    const recipe=recipes.find(r=>request.recipe_id?r.id===request.recipe_id:r.name.toLowerCase()===request.item_name.toLowerCase());
    return recipe?.crafters?.length?'Recipe observed for: '+recipe.crafters.map(c=>c.name+(c.stale?' (previous observation)':'')).join(', '):'No crafter recorded yet. Recipe coverage may be incomplete.';
  }
  function listMaterials(items){return `<ul class="material-list">${items.map(r=>`<li><span>${esc(r.name)}</span><strong>× ${Number(r.quantity).toLocaleString()}</strong></li>`).join('')}</ul>`;}
  function materialHTML(value,compact=false){
    if(!value)return '<p class="subtle">Material requirements have not been provided yet.</p>';
    if(value.status==='member_provided')return `<h4>Materials to provide</h4><p class="manual-materials">${esc(value.manual)}</p><span class="subtle">Member-supplied totals · not verified by Blizzard</span>`;
    if(value.status!=='verified')return '<p class="subtle">Blizzard has not returned material requirements. Enter a manual total below.</p>';
    const output=value.output?.value?`${value.output.value*value.crafts} output units from ${value.crafts} ${value.crafts===1?'craft':'crafts'}`:value.output?.minimum&&value.output?.maximum?`${value.output.minimum*value.crafts}–${value.output.maximum*value.crafts} output units; variable yield`:'Item yield not returned; quantities are per craft';
    return `<h4>Materials to provide</h4>${listMaterials(value.shopping_list)}<p class="subtle">${esc(output)}. Inventory availability is not checked.</p>${value.components.length?`<details ${compact?'':'open'}><summary>Craft these components (${value.components.length})</summary><ol class="component-list">${value.components.slice().reverse().map(c=>`<li><strong>${esc(c.recipe_name)}</strong> · ${c.crafts} ${c.crafts===1?'craft':'crafts'}<small>Need ${c.required}; makes ${c.produced}${c.spare?`; ${c.spare} spare`:''}</small></li>`).join('')}</ol></details>`:''}<details><summary>Direct recipe ingredients</summary>${listMaterials(value.direct)}</details>${value.warnings?.map(w=>`<p class="subtle">${esc(w)}</p>`).join('')||''}<p class="subtle">Requirements observed ${esc(date(value.observed_at))}. Unexpanded components stay on the list as items to provide.</p>`;
  }
  function craftDiscordStatus(request){
    if(request.kind!=='craft'||!['open','claimed'].includes(request.status))return '';
    const note=request.discord_channel_note?`<p class="subtle">${esc(request.discord_channel_note)}</p>`:'';
    if(request.discord_channel_status==='posted'){
      const url=typeof request.discord_message_url==='string'&&/^https:\/\/discord\.com\/channels\/\d{15,22}\/\d{15,22}\/\d{15,22}$/.test(request.discord_message_url)?request.discord_message_url:null;
      const completion=Number.isSafeInteger(Number(request.recipe_id))&&Number(request.recipe_id)>0?'The requester or a guild crafter who knows this recipe can confirm completion.':'Only the requester can confirm this manual item request with a Discord reaction.';
      return `<div class="request-discord"><p>${url?`<a class="button" href="${esc(url)}" target="_blank" rel="noreferrer">Open Discord craft request ↗</a>`:'Posted in the Discord craft requests channel.'}</p><p class="subtle">React ✅ after delivery. ${completion} The Discord post is removed after completion or cancellation.</p>${note}</div>`;
    }
    if(request.discord_channel_status==='pending')return `<div class="request-discord" role="status"><p class="subtle">The Discord craft channel post is queued.</p>${note}</div>`;
    if(request.discord_channel_status==='failed')return `<div class="request-discord" role="status"><p class="subtle"><strong>The Discord craft channel post could not be sent.</strong> The request is still on the guild workbench.</p>${note}</div>`;
    return note;
  }
  function requestCard(r){
    const active=['open','claimed'].includes(r.status);
    const actions=[r.kind==='craft'&&r.status==='open'?`<button class="button" data-request="${r.id}" data-action="claim">Claim request</button>`:'',
      active&&(r.own||r.claimed_by_me)?`<button class="button" data-request="${r.id}" data-action="complete">${r.kind==='learn'?'Mark learned':'Mark complete'}</button>`:'',
      r.status==='claimed'&&r.claimed_by_me?`<button class="button" data-request="${r.id}" data-action="release">Release</button>`:'',
      active&&r.own?`<button class="button" data-request="${r.id}" data-action="cancel">Cancel</button>`:''].join('');
    return `<article class="panel hall-card"><span class="request-state ${esc(r.status)}">${esc(r.status)}</span><h3>${esc(r.item_name)}</h3><p class="meta">${esc(r.character_name||'Former guild character')} · ${r.kind==='craft'?r.quantity+' '+(r.quantity===1?'craft':'crafts')+' · ':''}${esc(date(r.created_at))}</p>${r.kind==='craft'?`<p class="request-targets">${r.asked_me?'<strong>Asked you · </strong>':''}${r.targets?.length?'Asked: '+r.targets.map(t=>esc(t.name)).join(', '):'Open to the guild · no selected crafter'}</p>`:''}${r.notes?`<p class="note">${esc(r.notes)}</p>`:''}${r.kind==='craft'?`<p class="subtle">${esc(materialLabels[r.materials_preference]||'Discuss materials')}${r.crafter_name?' · Claimed by '+esc(r.crafter_name):''}</p><div class="request-materials">${materialHTML(r.materials,true)}</div>`:''}<div class="matching-crafters">${esc(matching(r))}</div>${craftDiscordStatus(r)}<div class="card-actions">${actions}</div></article>`;
  }
  function renderRequests(){
    const activeOnly=el('craft-status').value==='active';
    const craft=hall.requests.filter(r=>r.kind==='craft'&&(!activeOnly||['open','claimed'].includes(r.status)));
    const learn=hall.requests.filter(r=>r.kind==='learn'&&r.status!=='cancelled');
    el('craft-list').innerHTML=craft.length?craft.map(requestCard).join(''):'<div class="panel empty"><span class="empty-symbol" aria-hidden="true">⚒</span><h3>A quiet workbench.</h3><p>Need something made? Leave a request for the guild’s crafters.</p><button class="button primary" type="button" data-compose="craft">Request a craft</button></div>';
    el('learn-list').innerHTML=learn.length?learn.map(requestCard).join(''):'<div class="panel empty"><span class="empty-symbol" aria-hidden="true">✧</span><h3>What would you like to learn?</h3><p>Add a recipe so the guild knows what to keep an eye out for.</p><button class="button primary" type="button" data-compose="learn">Add a recipe wishlist</button></div>';
    el('popular-list').innerHTML=hall.popular?.length?`<ol class="popular-list">${hall.popular.map(r=>`<li><div><button class="member-name" data-popular="${esc(r.item_name)}" data-recipe-id="${r.recipe_id||''}">${esc(r.item_name)}</button><small>${r.request_count} ${r.request_count===1?'request':'requests'} · ${r.member_count} ${r.member_count===1?'member':'members'} · ${r.active_count} active</small></div><strong>${r.total_crafts}<small>crafts</small></strong></li>`).join('')}</ol>`:'<p class="subtle">Post requests to see what the guild needs most.</p>';
  }
  function eventCard(event){
    const ended=Date.parse(event.starts_at)+(Number(event.duration_minutes)||120)*60000<=Date.now();
    const active=event.status==='open'&&!ended;
    const signups=event.signups||[],mine=signups.find(s=>s.own),pending=event.pending_reactions||[];
    const roles=['Dungeon','Raid'].includes(event.kind)?['Tank','Healer','Damage']:event.kind==='Roleplay'?['Roleplay','Social']:['Tank','Healer','Damage','Roleplay','Social'];
    const icons={Tank:'🛡️',Healer:'💚',Damage:'⚔️',Roleplay:'🎭',Social:'🍻'};
    const count=role=>signups.filter(s=>s.role===role).length;
    const roleSummary=`<ul class="event-roles" aria-label="Confirmed places by role">${(event.role_limits?Object.keys(event.role_limits):roles).map(role=>{const limit=event.role_limits?.[role],full=limit!=null&&count(role)>=limit;return `<li class="${full?'full':''}"><span aria-hidden="true">${icons[role]||''}</span> ${esc(role)} <strong>${count(role)}${limit!=null?' / '+Number(limit):''}</strong>${full?'<span class="role-full">Full</span>':''}</li>`;}).join('')}</ul>`;
    const announcement=active&&event.discord_message_url?`<a class="button" href="${esc(event.discord_message_url)}" target="_blank" rel="noreferrer">Open Discord announcement ↗</a>`:'';
    const scheduled=active&&event.discord_event_id&&hall.discord_guild_id?`<a class="button" href="https://discord.com/events/${esc(hall.discord_guild_id)}/${esc(event.discord_event_id)}" target="_blank" rel="noreferrer">View Discord event ↗</a>`:'';
    const unconfirmed=pending.length?`<details class="event-pending" open><summary>${pending.length} Discord ${pending.length===1?'reaction not added':'reactions not added'}</summary><p>These reactions are not confirmed sign-ups and do not occupy a place.</p><ul>${pending.map(p=>`<li><strong>${esc(p.name||'Discord member')}</strong>${Array.isArray(p.roles)&&p.roles.length?' · '+p.roles.map(esc).join(', '):''}${p.reason?`<span>${esc(p.reason)}</span>`:''}</li>`).join('')}</ul></details>`:'';
    return `<article class="panel hall-card event-card"><span class="eyebrow gold">${esc(event.kind)}${event.status==='cancelled'?' · CANCELLED':ended?' · ENDED':''}</span><h3>${esc(event.title)}</h3><p class="meta">${esc(date(event.starts_at))} · ${event.duration_minutes||120} minutes · Hosted by ${esc(event.host_name||'a guild member')}</p>${event.location?`<p>Meet at ${esc(event.location)}</p>`:''}${event.description?`<p class="note">${esc(event.description)}</p>`:''}<p class="event-capacity"><strong>${signups.length} / ${event.capacity}</strong> confirmed places</p>${roleSummary}${window.GuildEventTemplates?.eventGuidance(event)||''}${announcement||scheduled?`<div class="event-discord-links">${announcement}${scheduled}</div>`:''}${announcement&&active?`<p class="subtle event-reaction-note">React to the announcement to choose your role, or sign up below. Authorise ${esc(SITE_BRAND.botName)} in Members &amp; roleplay, or ask a guild administrator to map your character. Discord changes update in batches and may take a few minutes to appear. Changes you make here stay in place until you change your Discord role reactions.</p>`:''}${active&&event.reaction_sync_error?`<p class="event-sync-error" role="status"><strong>Discord reactions need attention.</strong> ${esc(event.reaction_sync_error)} The confirmed list below shows the last saved sign-ups.</p>`:''}<h4 class="event-list-heading">Confirmed sign-ups</h4>${signups.length?`<ul class="event-attendees">${signups.map(s=>`<li><div><strong>${esc(s.character_name||'Former guild character')}</strong>${s.own?' <span class="event-you">You</span>':''}<span class="attendee-role">${esc(s.role)}</span></div><span class="signup-source ${s.source==='discord'?'discord':'web'}">${s.source==='discord'?'Discord reaction':'Website'}</span>${s.note?`<p>${esc(s.note)}</p>`:''}</li>`).join('')}</ul>`:'<p class="subtle">No confirmed sign-ups yet.</p>'}${unconfirmed}${active?`<div class="event-signup"><select data-event-character="${event.id}" aria-label="Character for ${esc(event.title)}">${characterOptions(mine?.character_id||me.main_character_id)}</select><select data-event-role="${event.id}" aria-label="Role for ${esc(event.title)}"><option value="">Choose your role</option>${roles.map(role=>{const limit=event.role_limits?.[role],full=limit!=null&&count(role)>=limit;return `<option value="${esc(role)}" ${mine?.role===role?'selected':''} ${full&&mine?.role!==role?'disabled':''}>${esc(role)}${limit!=null?` (${count(role)}/${Number(limit)}${full?' · full':''})`:''}</option>`;}).join('')}</select><button class="button" data-event="${event.id}" data-action="join">${mine?'Update sign-up':'Join event'}</button>${mine?`<button class="button" data-event="${event.id}" data-action="leave">Leave</button>`:''}${event.own?`<button class="button" data-event="${event.id}" data-action="cancel">Cancel event</button>`:''}</div>`:''}</article>`;
  }
  function renderDirectory(){
    const provenance=char=>{
      if(char.membership_source!=='character_profile')return '';
      const expires=Date.parse(char.membership_expires_at||''),label=!Number.isFinite(expires)?'Character-profile verification unavailable':expires<=Date.now()?'Character-profile verification expired':'Verified through character profile';
      return `<p class="subtle">${esc(label)}</p>`;
    };
    if(Array.isArray(hall.people)){
      el('member-directory').innerHTML=hall.people.map(person=>{
        const chars=person.characters||[],initials=Array.from(person.display_name||'?').filter(c=>!/^\s$/.test(c)).slice(0,2).join('').toUpperCase();
        const nameNote=!person.discord_linked?'Discord not linked':person.name_status==='unavailable'?'Discord name is waiting for a successful lookup':person.name_status==='stale'?'Discord name from a previous observation':'';
        return `<article class="panel hall-card person-card"><div class="person-heading"><span class="person-avatar" aria-hidden="true">${esc(initials)}</span><div><span class="eyebrow gold">${person.discord_linked?'DISCORD MEMBER':'GUILD MEMBER'}${person.own?' · YOU':''}</span><h3>${esc(person.display_name)}</h3><p class="meta">${chars.length} ${chars.length===1?'character':'characters'}${person.identity_source==='admin'?' · Discord assigned by an administrator':person.identity_source==='mixed'?' · Linked and administrator-assigned characters':''}</p></div></div>${nameNote?`<p class="person-name-note">${esc(nameNote)}</p>`:''}<ul class="person-characters">${chars.map(c=>`<li><div class="person-character-heading"><button type="button" class="person-character-open" data-open-character="${Number(c.id)}">${esc(c.name)}</button><span class="person-character-kind">${c.is_main?'Main':c.is_alt?'Alt':c.event_default?'Event default':'Character'}</span></div><p class="meta">${esc(c.class)} · Level ${esc(c.level??'?')}</p><span class="character-association ${c.association==='admin'?'admin':'provider'}">${c.association==='admin'?'Admin mapped':'Battle.net verified'}</span>${roleBadges(c)}${provenance(c)}${c.title?`<p class="rp-title">${esc(c.title)}</p>`:''}${c.biography?`<p class="person-biography">${esc(c.biography)}</p>`:''}${c.looking_for?`<p><strong>Looking for:</strong> ${esc(c.looking_for)}</p>`:''}</li>`).join('')}</ul></article>`;
      }).join('')||'<div class="panel empty"><p>Guild members appear as they sign in or an administrator maps their Discord account.</p></div>';
      return;
    }
    const groups=new Map();for(const char of hall.directory){const key=char.is_main||char.is_alt?char.user_id:'character:'+char.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(char);}
    el('member-directory').innerHTML=[...groups.values()].map(chars=>{
      const main=chars.find(c=>c.is_main)||chars[0],alts=chars.filter(c=>c!==main);
      return `<article class="panel hall-card"><span class="eyebrow gold">BATTLE.NET VERIFIED ${main.own?'· YOU':''}</span><h3>${esc(main.name)}</h3><p class="meta">${main.is_main?'Main':main.is_alt?'Alt':'Separate character'} · ${esc(main.class)} · level ${main.level??'?'}</p>${chars.map(c=>`<div class="rp-character">${c!==main?`<h4>${esc(c.name)} · alt</h4>`:''}${roleBadges(c)}${provenance(c)}${c.title?`<p class="rp-title">${esc(c.title)}</p>`:''}${c.biography?`<p>${esc(c.biography)}</p>`:c===main?'<p class="subtle">No biography shared yet.</p>':''}${c.looking_for?`<p><strong>Looking for:</strong> ${esc(c.looking_for)}</p>`:''}</div>`).join('')}${alts.length?`<div class="alt-list">Linked alts: ${alts.map(c=>esc(c.name)).join(', ')}</div>`:''}</article>`;
    }).join('')||'<div class="panel empty"><p>Verified members will appear as they sign in.</p></div>';
  }
  function fillProfile(){
    if(!hall)return;const char=hall.directory.find(c=>c.own&&String(c.id)===el('rp-character').value),form=el('rp-form');
    const value=profileDrafts.get(String(el('rp-character').value))||char;
    for(const key of ['title','biography','looking_for'])form.elements[key].value=value?.[key]||'';
  }
  function loadHall(options={}){
    if(options?.queue===true){accountRefreshVersion++;sessionRefreshVersion++;hallRefreshQueued=true;}
    if(busy)return hallPromise;busy=true;hallRefreshQueued=false;
    const version=accountRefreshVersion;
    hallPromise=(async()=>{try{if(!await refreshMe()||version!==accountRefreshVersion||!me.verified)return;const account=me.csrf,user=me.user_id,revision=accountRevision(me),result=await fetchJSON('/api/hall');if(!me.verified||me.csrf!==account||me.user_id!==user||accountRevision(me)!==revision||version!==accountRefreshVersion)return;hall=result;renderRequests();renderDirectory();
      const visibleEvents=hall.events.filter(event=>event.status!=='cancelled');
      el('event-list').innerHTML=visibleEvents.length?visibleEvents.map(eventCard).join(''):'<div class="panel empty"><span class="empty-symbol" aria-hidden="true">✦</span><h3>The noticeboard is quiet.</h3><p>Gather a dungeon party or arrange a guild evening.</p><button class="button primary" type="button" data-compose="events">Plan an event</button></div>';fillProfile();
      window.dispatchEvent(new CustomEvent('guild-hall-data',{detail:hall}));
    }catch(error){if(version===accountRefreshVersion)feedback(error.message,true);}finally{busy=false;hallPromise=null;if(hallRefreshQueued)loadHall();}})();
    return hallPromise;
  }
  function recipeInput(){
    const value=el('craft-form').elements.item_name.value.trim();
    return recipes.find(r=>`${r.name} · #${r.id}`===value)||recipes.find(r=>r.name.toLowerCase()===value.toLowerCase());
  }
  async function loadCrafters(reset=false){
    const version=++crafterVersion,recipe=recipeInput(),chosen=reset?new Set():new Set([...el('craft-crafters').querySelectorAll('input:checked')].map(i=>Number(i.value)));
    if(!recipe){el('craft-crafters').innerHTML='<p class="subtle">No observed crafter can be matched to this item. A manual request can still be posted to the guild board.</p>';return;}
    el('craft-crafters').innerHTML='<p class="subtle">Finding recipe owners…</p>';
    try{const result=await fetchJSON('/api/crafters/'+recipe.id);if(version!==crafterVersion)return;
      el('craft-crafters').innerHTML=result.crafters.length?result.crafters.map(c=>`<label class="crafter-choice"><input type="checkbox" name="target_character_id" value="${c.character_id}" ${chosen.has(c.character_id)&&c.verified?'checked':''} ${c.verified?'':'disabled'}><span><strong>${esc(c.name)}</strong><small>${esc(c.class)} · ${c.dm_available?'Discord DM available':'Discord DM unavailable'}<br>${esc(c.dm_note)}${c.observed_at?' · observed '+esc(date(c.observed_at)):''}</small></span></label>`).join(''):'<p class="subtle">No recipe owner has been observed. This does not establish that nobody can craft it.</p>';
    }catch(error){if(version===crafterVersion)el('craft-crafters').textContent=error.message;}
  }
  async function loadMaterials(reset=false){
    loadCrafters(reset);clearTimeout(planTimer);const version=++planVersion;if(reset)componentChoices={};const recipe=recipeInput();
    if(!recipe){plan=null;el('craft-materials').innerHTML='<p class="subtle">Choose a known recipe for automatic requirements, or enter the total materials manually below.</p>';el('manual-material-label').hidden=false;return;}
    el('craft-materials').innerHTML='<p class="subtle">Checking recipe materials…</p>';
    try{
      const crafts=Number(el('craft-form').elements.quantity.value)||1;
      const params=new URLSearchParams({crafts,expand:el('expand-components').checked?'1':'0',choices:JSON.stringify(componentChoices)});
      const result=await fetchJSON('/api/recipe/'+recipe.id+'?'+params);if(version!==planVersion)return;plan=result;
      el('craft-materials').innerHTML=materialHTML(plan)+(plan.alternatives?.length?`<details class="component-choices"><summary>Choose component recipes</summary>${plan.alternatives.map(a=>`<label>${esc(a.item_name)}<select data-component="${a.item_id}"><option value="0" ${a.selected===0?'selected':''}>Provide as an item</option>${a.options.map(o=>`<option value="${o.id}" ${a.selected===o.id?'selected':''}>Craft: ${esc(o.name)} (makes ${o.yield})</option>`).join('')}</select></label>`).join('')}</details>`:'')+(plan.catalogue?`<p class="subtle">Verified material data: ${plan.catalogue.available} / ${plan.catalogue.total} observed guild recipes.</p>`:'');
      el('manual-material-label').hidden=plan.status==='verified';
    }catch(error){if(version!==planVersion)return;plan=null;el('craft-materials').textContent=error.message;el('manual-material-label').hidden=false;}
  }
  function updateCatalog(){
    el('known-recipes').innerHTML=recipes.map(r=>`<option value="${esc(r.name+' · #'+r.id)}"></option>`).join('');
    const select=el('history-character'),current=select.value;
    select.innerHTML='<option value="0">Whole guild</option>'+members.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('');select.value=current||'0';
    if(!el('history').hidden)loadHistory();
  }
  function observationCard(observation){
    if(typeof observation.title==='string'&&observation.title.trim()){
      const labels={level:'Level change',skill:'Profession skill',recipe:'Recipe',profession:'Profession',coverage:'Data coverage',baseline:'Recorded baseline'};
      const detail=typeof observation.detail==='string'?observation.detail:'';
      return `<div class="history-entry observation-event"><span class="eyebrow gold">${Object.hasOwn(labels,observation.kind)?labels[observation.kind]:'Observation'}</span><strong>${esc(observation.title)}</strong>${detail?`<p>${esc(detail)}</p>`:''}<small>Observed ${esc(date(observation.observed_at))}</small></div>`;
    }
    const baseline=observation.baseline===true,changes=Array.isArray(observation.changes)?observation.changes.filter(value=>typeof value==='string'&&value.trim()):[];
    if(!baseline&&!changes.length)return '';
    const entries=changes.length?changes:[...(observation.level!=null?['Level '+observation.level]:[]),...(observation.professions||[]).map(profession=>`${profession.name}: ${profession.skill??'?'} / ${profession.max_skill??'?'}`)];
    return `<div class="history-entry"><strong>${baseline?'Recorded baseline':'Changed data'}</strong>${entries.length?`<ul class="observation-changes">${entries.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:'<p>No level or profession values were recorded.</p>'}<small>Observed ${esc(date(observation.observed_at))}</small></div>`;
  }
  async function loadHistory(){
    try{const result=await fetchJSON('/api/history?character='+el('history-character').value);
      el('history-note').textContent=result.note;
      el('activity-list').innerHTML=result.activity.length?result.activity.map(a=>`<div class="history-entry"><strong>${esc(a.title)}</strong>${a.detail?`<p>${esc(a.detail)}</p>`:''}<small>Observed ${esc(date(a.observed_at))}</small></div>`).join(''):'<p class="subtle">No changes have been observed yet. Current data forms the baseline for future milestones.</p>';
      const observations=Array.isArray(result.observations)?result.observations:result.snapshots||[];
      el('snapshot-list').innerHTML=observations.map(observationCard).join('')||'<p class="subtle">Choose a character to see their dated level, skill and recipe changes.</p>';
    }catch(error){el('activity-list').textContent=error.message;}
  }
  async function submitForm(event,kind){
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
    try{
      let data=Object.fromEntries(new FormData(form));let path='/api/hall/'+kind;
      if(kind==='craft'||kind==='learn'){
        path='/api/hall/requests';data.kind=kind;
        const recipe=recipes.find(r=>`${r.name} · #${r.id}`===data.item_name)||recipes.find(r=>r.name.toLowerCase()===data.item_name.toLowerCase());
        data.recipe_id=recipe?.id||null;data.item_name=recipe?.name||data.item_name;
        if(kind==='craft'){data.target_character_ids=new FormData(form).getAll('target_character_id').map(Number);data.component_choices=componentChoices;data.expand_components=el('expand-components').checked;}
      }
      if(kind==='main')data.alt_ids=[...altSelection].filter(id=>id!==Number(data.character_id));
      if(kind==='events'){data.starts_at=new Date(data.starts_at).toISOString();data=window.GuildEventTemplates?.read(form,data)||data;}
      const result=await send(path,data);if(kind==='main')altDirty=false;if(kind==='profile')profileDrafts.delete(String(data.character_id));feedback(result.message);
      if(['craft','learn','events'].includes(kind)){form.reset();if(kind==='events')window.GuildEventTemplates?.afterReset();componentChoices={};plan=null;crafterVersion++;el('craft-crafters').innerHTML='<p class="subtle">Choose a known recipe to see its crafters.</p>';el('craft-materials').innerHTML='';}
      await loadHall();
    }catch(error){feedback(error.message,true);}finally{button.disabled=false;}
  }
  document.querySelectorAll('.hall-tabs [data-hall]').forEach(button=>button.addEventListener('click',()=>showHallTab(button.dataset.hall)));
  el('craft-status').addEventListener('change',()=>hall&&renderRequests());
  for(const [id,kind]of [['craft-form','craft'],['learn-form','learn'],['event-form','events'],['main-form','main'],['rp-form','profile']])el(id).addEventListener('submit',event=>submitForm(event,kind));
  el('discord-preferences').addEventListener('submit',async event=>{event.preventDefault();try{const f=event.currentTarget;feedback((await send('/api/hall/discord',{requester_dm:f.elements.requester_dm.checked,crafter_dm:f.elements.crafter_dm.checked})).message);await refreshMe();}catch(error){feedback(error.message,true);}});
  el('discord-unlink').addEventListener('click',async()=>{try{feedback((await send('/api/hall/discord',{unlink:true})).message);await refreshMe();}catch(error){feedback(error.message,true);}});
  el('main-character').addEventListener('change',()=>{altDirty=true;renderAltChoices();});
  el('alt-options').addEventListener('change',event=>{if(event.target.name==='alt_id'){altDirty=true;const id=Number(event.target.value);event.target.checked?altSelection.add(id):altSelection.delete(id);}});
  el('rp-character').addEventListener('change',fillProfile);
  el('role-character').addEventListener('change',()=>{el('role-feedback').textContent='';fillRoles();});
  el('role-form').addEventListener('change',event=>{if(['preferred_role','primary_role'].includes(event.target.name))keepRoleDraft();});
  el('role-form').addEventListener('submit',saveRoles);
  el('clear-roles').addEventListener('click',()=>{roleDrafts.set(String(el('role-character').value),{preferred_roles:[],primary_role:null});fillRoles();el('role-feedback').textContent='Choices cleared in this form. Save to remove your saved role preferences.';});
  el('rp-form').addEventListener('input',event=>{if(!['title','biography','looking_for'].includes(event.target.name))return;const form=el('rp-form');profileDrafts.set(String(form.elements.character_id.value),Object.fromEntries(['title','biography','looking_for'].map(key=>[key,form.elements[key].value])));});
  el('history-character').addEventListener('change',loadHistory);
  el('sign-in').addEventListener('click',event=>{if(me.signed_in){event.preventDefault();activate('account');}});
  el('member-directory').addEventListener('click',event=>{const button=event.target.closest('[data-open-character]');if(button)window.GuildCharacter?.open(Number(button.dataset.openCharacter));});
  el('sign-out').addEventListener('click',async()=>{try{await send('/auth/logout',{});hall=null;profileDrafts.clear();window.dispatchEvent(new CustomEvent('guild-hall-data',{detail:null}));window.GuildAccess.leave();}catch(error){feedback(error.message,true);}});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-request],[data-event],[data-popular],[data-compose]');if(!button)return;
    if(button.dataset.compose){window.GuildHall.compose(button.dataset.compose);return;}
    if(button.dataset.popular){
      const recipe=recipes.find(r=>r.id===Number(button.dataset.recipeId));el('craft-form').elements.item_name.value=recipe?`${recipe.name} · #${recipe.id}`:button.dataset.popular;loadMaterials(true);openComposer('craft-form');return;
    }
    button.disabled=true;
    try{
      const id=button.dataset.request||button.dataset.event,data={action:button.dataset.action};
      if(button.dataset.event&&data.action==='join'){
        data.character_id=document.querySelector(`[data-event-character="${id}"]`).value;data.role=document.querySelector(`[data-event-role="${id}"]`).value;
      }
      const result=await send('/api/hall/'+(button.dataset.request?'requests/':'events/')+id,data);feedback(result.message);await loadHall();
    }catch(error){feedback(error.message,true);}finally{button.disabled=false;}
  });
  const materialBox=document.createElement('div');materialBox.id='craft-materials';materialBox.className='material-preview';
  const extras=document.createElement('div');extras.innerHTML='<label class="component-toggle"><input id="expand-components" type="checkbox" checked> Include craftable sub-components</label><label id="manual-material-label">Manual materials · total for this request<textarea name="manual_materials" rows="4" maxlength="1200" placeholder="For example: 8 Copper Bars, 2 Weak Flux. Confirm this list with the crafter."></textarea></label>';
  const submit=el('craft-form').querySelector('[type=submit]');submit.before(extras);submit.before(materialBox);
  const popular=document.createElement('article');popular.className='panel popular-panel';popular.innerHTML='<span class="eyebrow gold">GUILD DEMAND</span><h3>Most requested</h3><p class="subtle">Last 30 days · cancelled requests excluded · totals count crafting operations</p><div id="popular-list"></div>';el('craft-list').before(popular);
  el('craft-form').elements.quantity.parentElement.firstChild.textContent='Number of crafts';
  el('craft-form').elements.materials.value='provided';
  el('craft-form').elements.item_name.addEventListener('input',()=>{clearTimeout(planTimer);planTimer=setTimeout(()=>loadMaterials(true),350);});
  el('craft-form').elements.quantity.addEventListener('input',()=>{clearTimeout(planTimer);planTimer=setTimeout(()=>loadMaterials(),250);});
  el('expand-components').addEventListener('change',()=>loadMaterials());
  el('craft-materials').addEventListener('change',event=>{const select=event.target.closest('[data-component]');if(select){componentChoices[select.dataset.component]=Number(select.value);loadMaterials();}});
  window.addEventListener('guild-data',updateCatalog);
  window.addEventListener('guild-account-saved',accountSaved);
  window.GuildHall={load:loadHall,history:loadHistory,isAdmin:()=>Boolean(me.is_admin),select:showHallTab,pane:()=>hallTab,compose:pane=>{const form={craft:'craft-form',learn:'learn-form',events:'event-form'}[pane];if(form){showHallTab(pane);openComposer(form,true);}}};
  const initialPane=window.GuildRoute?.pane?.()||({events:'events',crafting:'craft',members:'people',wishlists:'learn'}[location.hash.slice(1)])||'craft';showHallTab(initialPane);
  const discordResult=new URLSearchParams(location.search).get('discord');if(discordResult){feedback(discordResult==='installed'?`${SITE_BRAND.botName} was installed in the configured guild server. Members can now authorise ${SITE_BRAND.botName} and choose notifications.`:discordResult==='linked'?`${SITE_BRAND.botName} authorised. Open Members & roleplay to choose your crafting notification preferences.`:discordResult==='in_use'?'That Discord account is already authorised for another guild account.':`${SITE_BRAND.botName} authorisation did not complete. Please try again.`,!['linked','installed'].includes(discordResult));history.replaceState(null,'',location.pathname+location.hash);}
  const signInError=new URLSearchParams(location.search).get('signin');
  if(signInError){feedback(signInError==='cancelled'?'Battle.net sign-in was cancelled.':'Battle.net sign-in could not complete. Please try again.',true);history.replaceState(null,'',location.pathname+location.hash);}
  updateCatalog();refreshMe().then(()=>{if(!el('hall').hidden||['roster','hierarchy'].includes(window.GuildRoute?.current?.()))loadHall();}).catch(error=>feedback(error.message,true));
  setInterval(()=>{if(!document.hidden&&(!el('hall').hidden||me.verified&&window.GuildRoute?.current?.()==='overview'))loadHall();},120000);
})();
