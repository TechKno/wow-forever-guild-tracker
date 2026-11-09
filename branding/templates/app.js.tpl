'use strict';
const SITE_BRAND={{PUBLIC_BRAND_JSON}};
const $=id=>document.getElementById(id);
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not yet observed';
let adminStatus=null,pendingAdminTab=false,pendingAdminView='status',refreshCSRF='',refreshRequestVersion=0,refreshQueued=false,adminViewVersion=0;
let members=[],recipes=[],status=null,evidenceLoaded=false,recipeLimit=60,refreshing=false;
let rosterLinks=[],groupedRoster=true;
let openMemberSlug=null,pendingCharacterId=null;
const expandedPlayers=new Set();
const rosterSortChoices=new Set(['name','level','rank']);
let rosterPreferenceKey=null,rosterPreferenceDirty=false;
function saveRosterView(){
  rosterPreferenceDirty=true;
  if(!rosterPreferenceKey)return;
  const sort=rosterSortChoices.has($('sort').value)?$('sort').value:'name';
  try{localStorage.setItem(rosterPreferenceKey,JSON.stringify({v:1,sort,grouped:groupedRoster}));}catch{/* Display choices still work when browser storage is unavailable. */}
}
function restoreRosterView(detail){
  const id=detail?.verified&&typeof detail.user_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(detail.user_id)?detail.user_id:null;
  const key=id?'wv:roster-view:v1:'+id:null;
  if(key===rosterPreferenceKey)return;
  const keepRecentChoice=rosterPreferenceKey===null&&rosterPreferenceDirty&&key!==null;
  rosterPreferenceKey=key;
  if(!keepRecentChoice){
    $('sort').value='name';groupedRoster=true;expandedPlayers.clear();
    if(key)try{
      const raw=localStorage.getItem(key),saved=typeof raw==='string'&&raw.length<=256?JSON.parse(raw):null;
      if(saved?.v===1){if(rosterSortChoices.has(saved.sort))$('sort').value=saved.sort;if(typeof saved.grouped==='boolean')groupedRoster=saved.grouped;}
    }catch{/* Invalid or blocked storage uses the normal display defaults. */}
    rosterPreferenceDirty=false;
  }else saveRosterView();
  if(status)renderRoster();
}
window.addEventListener('guild-member',event=>restoreRosterView(event.detail));
const classID=m=>Number.isInteger(m.class_id)?m.class_id:0;
const classLabel=m=>`<span class="class-label c${classID(m)}">${escapeHTML(m.class)}</span>`;
const memberButton=m=>`<button class="member-name" data-member="${escapeHTML(m.slug)}">${escapeHTML(m.name)}</button>${membershipNote(m)}`;
const observed=m=>m.professions_status==='verified';
const roleChoices=['Tank','Healer','Damage'];
function rolePreference(member){
  const roles=roleChoices.filter(role=>Array.isArray(member?.preferred_roles)&&member.preferred_roles.includes(role));
  const primary=roles.includes(member?.primary_role)?member.primary_role:null;
  return {preferred_roles:primary?roles:[],primary_role:primary};
}
function roleBadges(member,compact=false){
  const value=rolePreference(member);
  if(compact&&value.primary_role)return `<div class="character-roles roster-role-symbols" aria-label="Preferred combat roles">${[value.primary_role,...value.preferred_roles.filter(role=>role!==value.primary_role)].map(role=>{const primary=role===value.primary_role,label=role+(primary?' · primary':' · additional');return `<span class="role-badge role-icon${primary?' primary-role':''}" data-role="${role}" role="img" aria-label="${label}" title="${label}"><svg class="role-symbol" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-role-${role.toLowerCase()}"></use></svg>${primary?'<span class="role-primary-mark" aria-hidden="true">★</span>':''}</span>`;}).join('')}</div>`;
  return value.primary_role?`<div class="character-roles" aria-label="Preferred combat roles">${[value.primary_role,...value.preferred_roles.filter(role=>role!==value.primary_role)].map(role=>`<span class="role-badge${role===value.primary_role?' primary-role':''}">${role}${role===value.primary_role?' · primary':' · additional'}</span>`).join('')}</div>`:'<span class="roles-unset">Roles not set</span>';
}
const profileState=m=>m.profile_availability==='not_published'?'unavailable':m.profile_status||'unverified';
const profileLabel=m=>m.profile_availability==='not_published'?'Not published':profileState(m)==='verified'?'Observed':m.profile_availability==='temporary_error'?'Refresh delayed':profileState(m);
const levelValue=member=>{const value=Number(member.level);return Number.isSafeInteger(value)&&value>0?value:-1;};
const byLevel=(a,b)=>levelValue(b)-levelValue(a)||a.name.localeCompare(b.name);
const scheduledDate=value=>date(typeof value==='number'?new Date(value*1000).toISOString():value);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const newestTime=values=>values.filter(validTime).sort().at(-1)||null;
const membershipLabel=member=>member.membership_source!=='character_profile'?'':!validTime(member.membership_expires_at)?'Character-profile verification unavailable':Date.parse(member.membership_expires_at)<=Date.now()?'Character-profile verification expired':'Verified through character profile';
const membershipNote=member=>membershipLabel(member)?`<small class="alt-marker">${escapeHTML(membershipLabel(member))}</small>`:'';

function renderFreshness() {
  const refresh=status?.refresh&&typeof status.refresh==='object'?status.refresh:{};
  const latest=refresh.last_success_at||newestTime([status?.sync?.roster_at,...members.flatMap(m=>[m.profile_at,m.professions_at,m.talents_at])]);
  $('last-refresh').textContent=latest?'Last successful Blizzard check: '+date(latest):'Last successful Blizzard check: waiting for Blizzard data';
  const roster=refresh.roster_at||status?.sync?.roster_at;
  const details=[];
  if(roster)details.push('Roster: '+date(roster));
  if(refresh.last_character_check_at)details.push('Character activity checked: '+date(refresh.last_character_check_at));
  if(refresh.paused_until&&new Date(typeof refresh.paused_until==='number'?refresh.paused_until*1000:refresh.paused_until).getTime()>Date.now())details.push('Blizzard checks paused until '+scheduledDate(refresh.paused_until));
  $('refresh-timing').textContent=details.join(' · ');
  const stamps=members.map(m=>m.professions_at).filter(validTime).sort();
  const oldest=refresh.oldest_professions_at||stamps[0],latestProfession=refresh.latest_professions_at||stamps.at(-1);
  $('profession-freshness').textContent=oldest?'Professions and recipes last checked: '+date(oldest)+(latestProfession&&latestProfession!==oldest?' to '+date(latestProfession):'')+'. Open a character for its own refresh times.':'Profession and recipe refresh times will appear as profiles become available.';
  const dataAge=$('visible-data-age');
  if(dataAge)dataAge.textContent=['recipes','professions','crafting','wishlists'].includes(currentView)?
    oldest?'Recipe observations: '+date(oldest)+(latestProfession&&latestProfession!==oldest?' to '+date(latestProfession):'')+` · ${stamps.length} / ${members.length} characters`:'No successful recipe checks yet':
    roster?'Roster checked: '+date(roster):'Roster: waiting for a successful Blizzard response';
}
function refreshDetails(member) {
  const reasons={activity_changed:'Blizzard activity marker changed',level_changed:'Level changed',first_refresh:'First details check',missing_details:'Details not yet available',retry:'Retrying unavailable details',safety:'Periodic safety check',safety_refresh:'Periodic safety check',unknown_activity:'Periodic check; activity marker unavailable',manual:'Administrator requested a check',unchanged:'Activity unchanged; saved recipes retained'};
  const checked=member.profile_checked_at||member.activity_checked_at||member.profile_at;
  const rows=[['Profile last checked',date(checked)],['Recipes last successfully checked',date(member.professions_at)]];
  if(member.membership_source==='character_profile'){
    rows.unshift(['Guild membership',membershipLabel(member)],['Membership last verified',date(member.membership_verified_at)],['Membership proof expires',date(member.membership_expires_at)]);
  }
  if(member.level_source==='character_profile'||member.level_source==='profile')rows.push(['Level source','Character profile']);
  if(member.profile_at&&checked!==member.profile_at)rows.push(['Previous successful profile check',date(member.profile_at)]);
  if(member.profile_source_updated_at)rows.push(['Blizzard profile timestamp',date(member.profile_source_updated_at)]);
  if(member.profile_availability==='not_published')rows.push(['Profile availability','Not published by Blizzard']);
  else if(member.profile_availability==='temporary_error')rows.push(['Profile availability','Temporarily unavailable']);
  if(member.activity_checked_at)rows.push(['Activity last checked',date(member.activity_checked_at)]);
  if(member.last_login_at)rows.push(['Blizzard activity marker',date(member.last_login_at)]);
  if(reasons[member.details_refresh_reason])rows.push(['Details check reason',reasons[member.details_refresh_reason]]);
  return `<div class="detail-group character-freshness"><h3>Check times &amp; availability</h3>${rows.map(([key,value])=>`<div class="detail-row"><span>${escapeHTML(key)}</span><span>${escapeHTML(value)}</span></div>`).join('')}${member.profile_note?`<p>${escapeHTML(member.profile_note)}</p>`:''}<p>Blizzard can return an older snapshot even after a successful check. Check times do not establish live in-game data or online status.</p></div>`;
}

function leaveGuild(){
  window.dispatchEvent(new CustomEvent('guild-access-reset'));window.GuildArmory?.reset();window.GuildAccount?.reset();window.GuildAdminOverview?.reset();window.GuildHierarchy?.reset();
  document.body.textContent='';window.location.replace('/');
}
window.GuildAccess={leave:leaveGuild,check:(response,result)=>{if(response.status===401||result?.access_required===true){leaveGuild();return true;}return false;}};
async function fetchJSON(path) {
  const response=await fetch(path,{cache:'no-store'});
  const result=await response.json();
  if(window.GuildAccess.check(response,result))throw new Error('Sign in to reopen the guildhall');
  if(!response.ok) throw new Error(result.error||'The ledger is temporarily unavailable');
  return result;
}
const ROUTES={
  overview:{panel:'overview',title:'The guild noticeboard',label:'The noticeboard',eyebrow:'PULL UP A CHAIR',description:'Good company, useful crafts, and the next grand misadventure.'},
  account:{panel:'account',title:'Manage My Account',label:'Manage My Account',eyebrow:'YOUR PLACE AT THE TABLE',description:'Your characters, combat roles and connected accounts, all in one place.'},
  admin:{panel:'admin',title:'The keeper’s overview',label:'Admin overview',eyebrow:'THE KEEPER’S LEDGER',description:'Guild health, completed imports and the changes worth your attention.'},
  hierarchy:{panel:'hierarchy',title:'The guild hierarchy',label:'Guild hierarchy',eyebrow:'OUR COMPANY, IN ORDER',description:'The people of the guild, ordered by their in-game rank.'},
  roster:{panel:'roster',title:'The guild roster',label:'Guild roster',eyebrow:'THE COMPANY WE KEEP',description:'Every main, every alt, and the skills that make us a guild.'},
  events:{panel:'hall',pane:'events',title:'Events & adventures',label:'Events & adventures',eyebrow:'GATHER YOUR PARTY',description:'Find your next adventure. Choose a character, claim a role, and meet the guild.'},
  crafting:{panel:'hall',pane:'craft',title:'The guild workbench',label:'Crafting requests',eyebrow:'MADE BY THE GUILD',description:'Find the right crafter, gather the materials, and make something useful together.'},
  wishlists:{panel:'hall',pane:'learn',title:'The recipe wishlist',label:'Recipe wishlists',eyebrow:'KEEP AN EYE OUT',description:'Let the guild know which recipes you would love to learn.'},
  members:{panel:'hall',pane:'people',title:'The people behind the characters',label:'Members & alts',eyebrow:'ONE PLAYER, MANY STORIES',description:`Bring your mains and alts together, share a story, and connect with ${SITE_BRAND.botName}.`},
  professions:{panel:'professions',title:'Guild professions',label:'Professions',eyebrow:'SKILLED HANDS',description:'Find the guild member who knows just how to make it.'},
  recipes:{panel:'recipes',title:'The guild recipe book',label:'Recipe book',eyebrow:'A SHARED BOOK OF KNOW-HOW',description:'Explore learned recipes and the guild crafters who have been observed knowing them.'},
  history:{panel:'history',title:'The guild chronicle',label:'Guild chronicle',eyebrow:'EVERY ADVENTURE LEAVES A MARK',description:'Levels gained, skills improved, and new recipes discovered along the way.'},
  adventures:{panel:'adventures',title:'The quest board',label:'Quest board',eyebrow:'LEAVE NO ADVENTURER BEHIND',description:'Compare your party’s returned quest logs before heading out together.'},
  status:{panel:'status',title:'Behind the noticeboard',label:'Data & connection',eyebrow:'THE KEEPER’S LEDGER',description:'Manage connections, Discord character mappings, and the freshness of guild data.'}
};
const paneRoutes={events:'events',craft:'crafting',learn:'wishlists',people:'members'};
let currentView='overview',currentPane='craft',navigationOpen=false,memberVerified=false,overviewHall=null;
function setNavigation(open,restoreFocus=false){
  navigationOpen=Boolean(open);const navigation=$('guild-navigation'),mobile=window.innerWidth<=960;
  navigation.classList.toggle('is-open',navigationOpen);navigation.inert=mobile&&!navigationOpen;
  if(mobile&&!navigationOpen)navigation.setAttribute('aria-hidden','true');else navigation.removeAttribute?.('aria-hidden');
  $('navigation-toggle').setAttribute('aria-expanded',String(navigationOpen));$('navigation-backdrop').hidden=!navigationOpen;
  if(document.body?.style)document.body.style.overflow=navigationOpen?'hidden':'';
  $('content').inert=navigationOpen;
  if(navigationOpen)$('guild-navigation').querySelector?.('a,button')?.focus?.();
  else if(restoreFocus)$('navigation-toggle').focus?.();
}
function renderPrivateOverview(){
  if(!memberVerified){
    $('overview-events').innerHTML='<p>Sign in to see guild events and claim your place in the party.</p>';
    $('overview-crafts').innerHTML='<p class="subtle">Sign in to see what the guild is making and who needs a hand.</p>';return;
  }
  if(!overviewHall){$('overview-events').innerHTML='<p>Checking the guild’s event board…</p>';$('overview-crafts').innerHTML='<p class="subtle">Checking the guild workbench…</p>';return;}
  const events=(overviewHall.events||[]).filter(e=>e.status==='open'&&Date.parse(e.starts_at)+(e.duration_minutes||120)*60000>Date.now()).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).slice(0,2);
  $('overview-events').innerHTML=events.length?events.map(e=>`<div class="board-event"><h3>${escapeHTML(e.title)}</h3><p>${escapeHTML(date(e.starts_at))}${e.location?' · '+escapeHTML(e.location):''}</p><p>${e.signups?.length||0} / ${Number(e.capacity)||0} places claimed</p></div>`).join(''):'<p>The board is quiet. Plan a dungeon run, a gathering, or a little well-intentioned chaos.</p>';
  const requests=(overviewHall.requests||[]).filter(r=>r.kind==='craft'&&['open','claimed'].includes(r.status)).slice(0,3);
  $('overview-crafts').innerHTML=requests.length?requests.map(r=>`<div class="board-craft"><div><strong>${escapeHTML(r.item_name)}</strong><small>${escapeHTML(r.character_name||'Guild member')} · ${Number(r.quantity)||1} craft(s)</small></div><span class="badge">${r.status==='claimed'?'Claimed':'Needs a crafter'}</span></div>`).join(''):'<p class="subtle">No open crafting requests. Browse the recipe book or ask the guild to make something.</p>';
}
function renderOverview(){
  const company=[...members].sort(byLevel).slice(0,6);
  $('overview-members').innerHTML=company.length?company.map(m=>`<div class="company-member"><span class="avatar" aria-hidden="true">${escapeHTML(m.name[0]||'?')}</span><div>${memberButton(m)}<small>${escapeHTML(m.class)}</small></div><span class="company-level" aria-label="Level ${escapeHTML(m.level??'unknown')}">${escapeHTML(m.level??'—')}</span></div>`).join(''):'<p class="subtle">Your fellow adventurers will appear after the first successful guild import.</p>';
  renderPrivateOverview();
}
function activate(view,pane) {
  if(view==='hall')view=paneRoutes[pane||currentPane]||'crafting';
  const route=ROUTES[view];if(!route)return;
  if(['status','admin'].includes(view)&&!window.GuildHall?.isAdmin()){pendingAdminTab=true;pendingAdminView=view;return;}
  const viewChanged=currentView!==view,wasNavigationOpen=navigationOpen;
  currentView=view;if(route.pane)currentPane=route.pane;
  document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!==route.panel);
  document.querySelectorAll('.nav').forEach(button=>{
    const active=button.dataset.tab===route.panel&&(route.panel!=='hall'||button.dataset.pane===(route.pane==='learn'?'craft':route.pane));
    button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute?.('aria-current');
  });
  $('page-title').textContent=route.title;$('page-subtitle').textContent=route.description;$('page-eyebrow').textContent=route.eyebrow;$('page-breadcrumb').textContent=route.label;$('page-crest').hidden=view!=='overview';
  $('hall-heading').textContent=route.panel==='hall'?route.label:'The guild hall';
  if(document.body?.dataset)document.body.dataset.view=view;
  setNavigation(false);
  if(wasNavigationOpen){$('page-title').setAttribute('tabindex','-1');$('page-title').focus?.();}
  if(viewChanged)window.scrollTo?.({top:0,behavior:'instant'});
  if(route.panel==='hall'){
    if(window.GuildHall?.pane?.()!==currentPane)window.GuildHall?.select?.(currentPane);
    window.GuildHall?.load();
  }
  if(view==='overview'){renderOverview();window.GuildHall?.load();}
  if(view==='status'){if(!evidenceLoaded)loadEvidence();window.GuildAdventures?.admin();}
  if(view==='adventures')window.GuildAdventures?.load();
  if(view==='history')window.GuildHall?.history();
  if(view==='account')window.GuildAccount?.load();
  if(view==='admin')window.GuildAdminOverview?.load();
  if(view==='hierarchy'){window.GuildHierarchy?.update(members);window.GuildHierarchy?.load();window.GuildHall?.load();}
  history.replaceState(null,'','#'+view);
  if(status)renderFreshness();
}
window.GuildRoute={pane:()=>currentPane,current:()=>currentView,open:activate};
document.querySelectorAll('.nav').forEach(button=>button.addEventListener('click',()=>activate(button.dataset.tab,button.dataset.pane)));
document.addEventListener('click',event=>{const link=event.target.closest?.('[data-route]');if(link){event.preventDefault();activate(link.dataset.route);}});
$('navigation-toggle').addEventListener('click',()=>setNavigation(!navigationOpen,true));
$('navigation-close').addEventListener('click',()=>setNavigation(false,true));
$('navigation-backdrop').addEventListener('click',()=>setNavigation(false,true));
document.addEventListener('keydown',event=>{
  if(!navigationOpen)return;
  if(event.key==='Escape'){event.preventDefault();setNavigation(false,true);return;}
  if(event.key==='Tab'){
    const controls=[...$('guild-navigation').querySelectorAll('a[href],button:not([disabled]):not([hidden])')].filter(node=>node.getClientRects().length);
    const first=controls[0],last=controls.at(-1);if(!first)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
window.addEventListener('resize',()=>{if(!navigationOpen||window.innerWidth>960)setNavigation(false);});
window.addEventListener('hashchange',()=>activate(location.hash.slice(1)||'overview'));
window.addEventListener('guild-hall-pane',event=>{if(ROUTES[currentView]?.panel==='hall'&&currentPane!==event.detail)activate('hall',event.detail);});
window.addEventListener('guild-hall-data',event=>{overviewHall=memberVerified&&event.detail?event.detail:null;renderPrivateOverview();});
window.addEventListener('guild-member',event=>{const wasVerified=memberVerified;memberVerified=Boolean(event.detail?.verified);if(!memberVerified)overviewHall=null;renderPrivateOverview();if(memberVerified&&!wasVerified&&currentView==='overview')window.GuildHall?.load();if(memberVerified&&currentView==='hierarchy')window.GuildHall?.load();});

function deriveRecipes() {
  const map=new Map();
  for(const member of members) for(const profession of member.professions||[]) for(const recipe of profession.recipes||[]) {
    if(!map.has(recipe.id)) map.set(recipe.id,{...recipe,profession:profession.name,crafters:[]});
    const entry=map.get(recipe.id);
    if(!entry.crafters.some(c=>c.slug===member.slug)) entry.crafters.push({slug:member.slug,name:member.name,stale:!observed(member),at:member.professions_at});
  }
  recipes=[...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function updateSummary() {
  const published=Boolean(status.sync?.published);
  const classes=new Set(members.map(m=>m.class).filter(c=>c&&c!=='Unknown'));
  const professions=new Set(members.flatMap(m=>(m.professions||[]).map(p=>p.name)));
  $('stat-members').textContent=published?members.length:'—';
  $('nav-count').textContent=published?members.length:'—';
  $('stat-classes').textContent=published?classes.size:'—';
  $('stat-professions').textContent=members.some(m=>m.professions_at)?professions.size:'—';
  $('stat-recipes').textContent=members.some(m=>(m.professions||[]).some(p=>p.recipe_status==='observed'))?recipes.length.toLocaleString():'—';
  const linkedIds=new Set(rosterLinks.map(l=>l.character_id)),players=new Set(rosterLinks.map(l=>l.user_id));
  $('stat-members-note').textContent=published?(players.size?`${players.size} linked ${players.size===1?'player':'players'} · ${members.filter(m=>!linkedIds.has(m.id)).length} unlinked characters`:'Characters returned by Blizzard'):'Awaiting first import';
  const coverage=members.filter(observed).length;
  $('stat-professions-note').textContent=published?`${coverage} / ${members.length} profiles with observations`:'From character profiles';
  $('connection').textContent=published?'Guild data observed':'Waiting for guild data';
  $('notice').classList.toggle('ready',published);
  $('notice').textContent=published?'Guild data is refreshed automatically. Observations may lag behind the game.':'Waiting for guild data to become available.';
  if(status.sync.status==='partial'&&published){
    const limited=members.filter(m=>['profile','professions','talents'].some(key=>m[key+'_status']!=='verified')).length;
    $('notice').textContent=`${members.length} members imported · ${limited} member profiles have limited data. Open a character for details.`;
  }
  $('notice').hidden=published&&!['partial','blocked','waiting'].includes(status.sync.status);
  $('updated').textContent=status.sync.roster_at?'Roster observed '+date(status.sync.roster_at):'Waiting for first import';
  renderFreshness();renderOverview();
  $('export').disabled=!published;
  const options=['<option value="">All classes</option>',...[...classes].sort().map(c=>`<option>${escapeHTML(c)}</option>`)];
  const selected=$('class-filter').value;
  $('class-filter').innerHTML=options.join('');
  if(classes.has(selected)) $('class-filter').value=selected;
  const pSelected=$('recipe-profession').value;
  $('recipe-profession').innerHTML='<option value="">All professions</option>'+[...new Set(recipes.map(r=>r.profession))].sort().map(p=>`<option>${escapeHTML(p)}</option>`).join('');
  $('recipe-profession').value=pSelected;
  renderCompositions();
  renderStatus();
}
function renderCompositions() {
  const counts=new Map(),professionCounts=new Map();
  members.forEach(m=>counts.set(m.class,(counts.get(m.class)||0)+1));
  const profiles=members.filter(m=>m.professions_at);
  for(const member of profiles){
    const names=new Set((member.professions||[]).map(p=>typeof p.name==='string'?p.name.trim():'').filter(Boolean));
    for(const name of names)professionCounts.set(name,(professionCounts.get(name)||0)+1);
  }
  const rows=(values,empty,label)=>values.size?[...values].sort((a,b)=>b[1]-a[1]).map(([name,count])=>`<div class="composition-row"><div><span>${escapeHTML(name)}</span><span>${count}</span></div><progress value="${count}" max="${members.length}" aria-label="${escapeHTML(name)}: ${count} ${count===1?label.replace(/s$/,''):label}"></progress></div>`).join(''):`<p class="muted">${empty}</p>`;
  $('composition').innerHTML=rows(counts,'Class distribution appears with your roster.','members');
  $('profession-composition').innerHTML=rows(professionCounts,profiles.length?'No professions were returned in the saved observations.':'Profession distribution appears as character profiles are imported.','characters');
  $('profession-composition-note').textContent=`${profiles.length} of ${members.length} character profiles have profession observations. Counts include secondary skills and each character once per profession.${profiles.some(m=>!observed(m))?' Previous observations included.':''} Unavailable profiles may have additional professions.`;
  const declared=members.map(rolePreference).filter(value=>value.primary_role),roleCounts=new Map((members.length?roleChoices:[]).map(role=>[role,declared.filter(value=>value.primary_role===role).length]));
  $('role-composition').innerHTML=rows(roleCounts,'Members can share their preferred roles in Members &amp; alts.','characters');
  $('role-composition-note').textContent=`${declared.length} of ${members.length} characters have chosen roles. Counts use primary choices only, include alts, and do not show live availability. Additional roles appear on each character.`;
}
window.addEventListener('guild-role-saved',event=>{
  const value=event.detail;if(!value||!Number.isSafeInteger(value.character_id))return;
  members=members.map(member=>member.id===value.character_id?{...member,...rolePreference(value),role_preferences_updated_at:value.role_preferences_updated_at||null}:member);
  if(status){renderRoster();renderCompositions();refreshOpenMember();}
});
function renderRoster() {
  const query=$('roster-search').value.toLowerCase().trim(),classFilter=$('class-filter').value,sort=$('sort').value;
  const roleFilter=roleChoices.includes($('role-filter').value)?$('role-filter').value:'';
  const matches=m=>(!query||`${m.name} ${m.race} ${(m.professions||[]).map(p=>p.name).join(' ')}`.toLowerCase().includes(query))&&(!classFilter||m.class===classFilter)&&(!roleFilter||rolePreference(m).preferred_roles.includes(roleFilter));
  const linkByCharacter=new Map(rosterLinks.map(l=>[l.character_id,l]));
  const grouped=groupedRoster&&rosterLinks.length>0,groups=new Map();
  for(const member of members){
    const link=grouped?linkByCharacter.get(member.id):null,key=link?'player:'+link.user_id:'character:'+member.id;
    if(!groups.has(key))groups.set(key,{key,linked:Boolean(link),main_id:link?.main_character_id,characters:[]});
    groups.get(key).characters.push(member);
  }
  let rows=[...groups.values()].filter(g=>g.characters.some(matches)).map(g=>({...g,main:g.characters.find(m=>m.id===g.main_id)||g.characters[0]}));
  rows.sort((a,b)=>sort==='level'?byLevel(a.main,b.main):
    sort==='rank'?(a.main.rank??999)-(b.main.rank??999)||a.main.name.localeCompare(b.main.name):a.main.name.localeCompare(b.main.name));
  const professionTags=chars=>[...new Map(chars.flatMap(m=>(m.professions||[]).filter(p=>p.kind==='Primary').map(p=>[p.name,p]))).values()].map(p=>`<span class="tag">${escapeHTML(p.name)}</span>`).join('');
  const singleRow=(m,isAlt=false)=>`<tr${isAlt?' class="alt-roster-row"':''}><td><span class="avatar" aria-hidden="true">${escapeHTML(m.name[0]||'?')}</span>${memberButton(m)}${isAlt?'<small class="alt-marker">Alt character</small>':''}</td><td>${classLabel(m)}${roleBadges(m,true)}</td><td>${escapeHTML(m.level??'—')}</td><td>${m.rank!=null?'Rank '+escapeHTML(m.rank):'Unknown'}</td><td><div class="combined-professions">${m.professions_at?professionTags([m])||'<span class="subtle">None returned</span>':'<span class="subtle">Not yet available</span>'}</div></td><td><span class="badge ${profileState(m)}">${escapeHTML(profileLabel(m))}</span></td></tr>`;
  $('roster-body').innerHTML=rows.map(group=>{
    if(!group.linked||group.characters.length===1)return singleRow(group.main);
    const m=group.main,alts=group.characters.filter(c=>c.id!==m.id&&(!roleFilter||matches(c))),open=expandedPlayers.has(group.key)||Boolean(query||classFilter||roleFilter);
    if(sort==='level')alts.sort(byLevel);
    const observedCount=group.characters.filter(c=>c.profile_status==='verified').length;
    const classes=[...new Set(alts.map(a=>a.class))].join(', ');
    const toggle=!roleFilter||alts.length?`<button class="alt-toggle" data-player="${escapeHTML(group.key)}" aria-expanded="${open}" aria-label="${open?'Collapse':'Expand'} alts for ${escapeHTML(m.name)}">${open?'▾':'▸'}</button>`:'';
    return `<tr class="player-roster-row"><td>${toggle}<span class="avatar" aria-hidden="true">${escapeHTML(m.name[0]||'?')}</span>${memberButton(m)}<small class="alt-marker">Main · ${group.characters.length} linked characters${roleFilter&&!matches(m)?' · matching alt below':''}</small></td><td>${classLabel(m)}${roleBadges(m,true)}${classes?`<small class="alt-marker">Alts: ${escapeHTML(classes)}</small>`:''}</td><td>${escapeHTML(m.level??'—')}</td><td>${m.rank!=null?'Rank '+escapeHTML(m.rank):'Unknown'}</td><td><div class="combined-professions">${professionTags(group.characters)||'<span class="subtle">No primary professions returned</span>'}</div></td><td><span class="badge">${observedCount} / ${group.characters.length} observed</span></td></tr>${open?alts.map(a=>singleRow(a,true)).join(''):''}`;
  }).join('');
  $('roster-empty').hidden=rows.length>0;
  if(!rows.length&&members.length)$('roster-empty').innerHTML='<h3>No members match those filters.</h3><p>Try another name, class or role. Searches include linked alts.</p>';
  const shown=rows.reduce((n,g)=>n+g.characters.length,0);
  $('roster-count').textContent=status?.sync.published?`${roleFilter?members.filter(matches).length:shown} of ${members.length} characters${roleFilter?' match '+roleFilter:''}${grouped?' · grouped by verified player links':''}`:'No verified roster yet';
  $('group-roster').disabled=!rosterLinks.length;
  $('group-roster').textContent=grouped?'Player groups on':'Combine main / alts';
  $('group-roster').classList.toggle('active',grouped);
  $('grouping-note').textContent=rosterLinks.length?'A player’s chosen main appears first, with combined professions. Expand the row to see their alts. Characters without verified ownership stay separate.':'Sign in with Battle.net to group verified main/alt characters. Each member’s links appear after their own account is verified.';
  if(grouped&&sort==='level')$('grouping-note').textContent+=' Groups sort by shown main level; alts stay under their main.';
  if(roleFilter)$('grouping-note').textContent+=` Includes primary and additional ${roleFilter} choices.${grouped?' Matching alts are shown under their main; other alts are hidden.':''}`;
}
window.addEventListener('guild-players',event=>{rosterLinks=event.detail||[];if(status){updateSummary();renderRoster();}});
document.addEventListener('click',event=>{
  const toggle=event.target.closest('[data-player]');if(!toggle)return;
  const key=toggle.dataset.player;expandedPlayers.has(key)?expandedPlayers.delete(key):expandedPlayers.add(key);renderRoster();
});

function renderProfessions() {
  const query=$('profession-search').value.toLowerCase().trim(),groups=new Map();
  for(const m of members) for(const p of m.professions||[]) {
    if(query&&!`${p.name} ${m.name}`.toLowerCase().includes(query)) continue;
    if(!groups.has(p.name)) groups.set(p.name,[]);
    groups.get(p.name).push({member:m,profession:p});
  }
  $('profession-grid').innerHTML=[...groups].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,list])=>`<article class="panel profession-card"><span class="eyebrow gold">${escapeHTML(list[0].profession.kind)} PROFESSION</span><h3>${escapeHTML(name)} <span class="subtle">· ${new Set(list.map(r=>r.member.id)).size} members</span></h3>${list.sort((a,b)=>(b.profession.skill??-1)-(a.profession.skill??-1)).map(({member:m,profession:p})=>`<div class="profession-person"><div>${memberButton(m)}<br><small>${escapeHTML(p.tier||p.kind)}${observed(m)?'':' · previous observation'}</small></div><span>${p.skill??'?'} / ${p.max_skill??'?'}</span>${p.skill!=null&&p.max_skill>0?`<progress value="${p.skill}" max="${p.max_skill}" aria-label="${escapeHTML(m.name)}: skill ${p.skill} of ${p.max_skill}"></progress>`:''}</div>`).join('')}</article>`).join('');
  $('profession-empty').hidden=groups.size>0;
}
function renderRecipes() {
  const query=$('recipe-search').value.toLowerCase().trim(),profession=$('recipe-profession').value;
  const list=recipes.filter(r=>(!profession||r.profession===profession)&&(!query||`${r.name} ${r.id} ${r.profession} ${r.crafters.map(c=>c.name).join(' ')}`.toLowerCase().includes(query)));
  $('recipe-results').innerHTML=list.slice(0,recipeLimit).map(r=>`<article class="panel recipe-card"><span class="eyebrow gold">${escapeHTML(r.profession)}</span><h3>${escapeHTML(r.name)}</h3><p>Recipe #${r.id} · ${r.crafters.length} observed ${r.crafters.length===1?'crafter':'crafters'}</p>${r.crafters.map(c=>`<button class="crafter" data-member="${escapeHTML(c.slug)}" title="Observed ${escapeHTML(date(c.at))}${c.stale?'; last refresh unavailable':''}">${escapeHTML(c.name)}${c.stale?' · stale':''}</button>`).join('')}</article>`).join('');
  $('recipe-empty').hidden=list.length>0;
  $('more-recipes').hidden=list.length<=recipeLimit;
}
function renderStatus() {
  if(!adminStatus)return;const status=adminStatus,s=status.sync,r=typeof status.refresh==='object'?status.refresh:{};
  const cadence=status.refresh_policy||(typeof status.refresh==='string'?status.refresh:`Roster every ${r.roster_interval_minutes||15} minutes. Character activity checks about every ${r.approximate_sweep_minutes||r.character_interval_minutes||15} minutes. Recent or unknown activity gets a safety check every ${r.active_details_safety_minutes||60} minutes; older activity every ${r.details_safety_hours||6} hours.`);
  $('sync-details').innerHTML=[['API client',status.configured?'Configured':'Needs setup'],['Latest import',s.message],['Last WoW success',date(r.last_success_at)],['Roster observed',date(s.roster_at)],['Character activity',date(r.last_character_check_at)],['Oldest professions',date(r.oldest_professions_at)],['Queued characters',r.pending??'Not yet available'],['Scheduler checked',date(status.scheduler?.last_completed)],['Next roster check',r.next_roster_at?scheduledDate(r.next_roster_at):s.next_at?scheduledDate(s.next_at):'Waiting for a scheduled check'],['Refresh cadence',cadence]].map(([key,value])=>`<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value)}</dd>`).join('');
  $('limits').innerHTML=status.limits.map(value=>`<li>${escapeHTML(value)}</li>`).join('');
}
async function loadEvidence() {
  try {
    if(!window.GuildHall?.isAdmin())return;
    const version=adminViewVersion;
    const [result,details]=await Promise.all([fetchJSON('/api/evidence'),fetchJSON('/api/admin/status')]);
    if(version!==adminViewVersion||!window.GuildHall?.isAdmin())return;
    adminStatus=details;renderStatus();
    $('evidence-body').innerHTML=result.endpoints.map(e=>`<tr><td title="${escapeHTML(e.namespace)}">${escapeHTML(e.path)}</td><td><span class="badge ${escapeHTML(e.status)}">${e.status==='verified'?'HTTP success observed':'Unavailable'}</span></td><td>${escapeHTML(date(e.succeeded))}</td><td>${escapeHTML(e.detail)}</td></tr>`).join('');
    $('evidence-empty').hidden=result.endpoints.length>0;
    evidenceLoaded=true;
  } catch(error) { $('evidence-empty').textContent=error.message; }
}
function openMember(slug,refresh=false) {
  const m=members.find(member=>member.slug===slug); if(!m) return;
  const dialog=$('member-dialog'),content=$('member-content');
  if(refresh&&!dialog.open)return;
  const scroll=dialog.scrollTop,contentScroll=content.scrollTop,focused=document.activeElement,inside=content.contains?.(focused);
  const focusable=inside?[...content.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')]:[];
  const focusIndex=inside?focusable.indexOf(focused):-1,focusId=inside?focused.id:'';
  openMemberSlug=slug;
  $('member-content').innerHTML=`<div class="eyebrow gold">${escapeHTML(SITE_BRAND.guildName.toUpperCase())} · ${escapeHTML(SITE_BRAND.regionRuleset.toUpperCase())}</div><h2 class="detail-title">${escapeHTML(m.name)}</h2><p>${classLabel(m)} · Level ${escapeHTML(m.level??'?')} · ${escapeHTML(m.race)}</p><section class="character-talents" aria-label="Character talent trees"><div class="detail-group"><h3>Talent trees</h3>${m.talents?.length?m.talents.map(t=>`<div class="detail-row"><span>${escapeHTML(t.name)}</span><span>${escapeHTML(t.points??'?')} points</span></div>`).join(''):'<p>No active talent points were returned. No specialisation or combat role has been inferred.</p>'}<p>Observed: ${escapeHTML(date(m.talents_at))}${m.talents_status==='stale'?' · refresh unavailable':''}</p></div></section><div class="detail-group character-role-summary"><h3>Preferred combat roles</h3>${roleBadges(m)}<p>Chosen by this character’s owner. Preferences can be changed in Manage My Account and do not change event sign-ups.</p></div>${refreshDetails(m)}<div class="detail-group character-professions"><h3>Professions &amp; learned recipes</h3>${m.professions_at?(m.professions||[]).map(p=>`<div class="detail-group"><div class="detail-row"><strong>${escapeHTML(p.name)}</strong><span>${p.skill??'?'} / ${p.max_skill??'?'}</span></div><p>${escapeHTML(p.kind)}${p.tier?' · '+escapeHTML(p.tier):''} · ${p.recipe_status==='observed'?`${p.recipes.length} recipes returned`:'Recipe coverage not exposed'}</p><div class="detail-recipes">${(p.recipes||[]).map(r=>`<span class="tag">${escapeHTML(r.name)}</span>`).join('')}</div></div>`).join('')||'<p>No professions were returned in the last observed response.</p>':'<p>Profession information is not yet available.</p>'}<p>Observed: ${escapeHTML(date(m.professions_at))}${m.professions_status==='stale'?' · showing a previous observation':''}</p></div><div class="detail-group character-data-status"><h3>Data status</h3>${['profile','professions','talents'].map(key=>`<div class="detail-row"><span>${escapeHTML(key)}</span><span class="badge ${escapeHTML(m[key+'_status']||'unverified')}">${escapeHTML(m[key+'_status']||'not yet observed')}</span></div>${m[key+'_error']?`<p>${escapeHTML(m[key+'_error'])}</p>`:''}`).join('')}</div>`;
  const armoryHost=document.createElement?.('section');if(armoryHost){armoryHost.className='character-armory';content.insertBefore?.(armoryHost,content.querySelector?.('.character-talents'));window.GuildArmory?.mount(armoryHost,m);}
  window.GuildCharacterCard?.mount(content,m);
  const talentHost=content.querySelector?.('.character-talents');if(talentHost)window.GuildTalents?.render(m,talentHost);
  if(refresh){
    if(inside){const controls=[...content.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')];const replacement=controls.find(node=>focusId&&node.id===focusId)||controls[focusIndex];replacement?.focus?.({preventScroll:true});}
    dialog.scrollTop=scroll;content.scrollTop=contentScroll;
  }else{if(!dialog.open)dialog.showModal();dialog.scrollTop=0;content.scrollTop=0;}
}
function refreshOpenMember(){
  const dialog=$('member-dialog');if(!dialog.open||!openMemberSlug)return;
  if(members.some(member=>member.slug===openMemberSlug)){openMember(openMemberSlug,true);return;}
  const scroll=dialog.scrollTop;
  window.GuildArmory?.reset();
  $('member-content').innerHTML='<h2 class="detail-title">No current guild record</h2><p>This character was not returned in the latest guild roster. Close this window and check the roster again.</p>';
  dialog.scrollTop=scroll;
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-member]');if(button)openMember(button.dataset.member);});
document.querySelector('.dialog-close').addEventListener('click',()=>{openMemberSlug=null;$('member-dialog').close();});
$('member-dialog').addEventListener('close',()=>{openMemberSlug=null;pendingCharacterId=null;window.GuildArmory?.reset();window.GuildCharacterCard?.reset();});
for(const id of ['roster-search','class-filter','role-filter']) $(id).addEventListener('input',renderRoster);
const changeRosterSort=()=>{saveRosterView();renderRoster();};
$('sort').addEventListener('input',changeRosterSort);
$('sort').addEventListener('change',changeRosterSort);
$('group-roster').addEventListener('click',()=>{groupedRoster=!groupedRoster;saveRosterView();renderRoster();});
$('profession-search').addEventListener('input',renderProfessions);
for(const id of ['recipe-search','recipe-profession']) $(id).addEventListener('input',()=>{recipeLimit=60;renderRecipes();});
$('more-recipes').addEventListener('click',()=>{recipeLimit+=60;renderRecipes();});
$('reload').addEventListener('click',()=>{evidenceLoaded=false;load(true);loadEvidence();});
$('refresh-wow').addEventListener('click',async()=>{
  if(!window.GuildHall?.isAdmin()||!refreshCSRF||refreshQueued)return;
  const version=++refreshRequestVersion,button=$('refresh-wow'),notice=$('refresh-wow-feedback');
  refreshQueued=true;button.disabled=true;button.textContent='Queuing WoW checks…';notice.hidden=false;notice.textContent='Queuing full Blizzard checks for profiles, professions, recipes and talents. Existing observations stay visible while they run.';notice.classList.remove('refresh-error');
  try{
    const response=await fetch('/api/admin/refresh',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':refreshCSRF},body:'{}'});
    const result=await response.json();
    if(version!==refreshRequestVersion||!window.GuildHall?.isAdmin())return;
    if(!response.ok)throw new Error(result.error||'The WoW refresh could not be queued.');
    notice.textContent=(result.message||'WoW checks queued.')+' Refresh times will change after Blizzard successfully returns data.';
    await load(true);await loadEvidence();
  }catch(error){if(version===refreshRequestVersion&&window.GuildHall?.isAdmin()){notice.textContent=error.message;notice.classList.add('refresh-error');}}
  finally{if(version===refreshRequestVersion){refreshQueued=false;button.disabled=!refreshCSRF;button.textContent='↻ Refresh WoW data';}}
});
$('export').addEventListener('click',()=>{
  const cell=value=>{let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  const rows=[['Name','Class','Race','Level','Guild rank','Roster observed'],...members.map(m=>[m.name,m.class,m.race,m.level,m.rank,m.roster_observed])];
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=SITE_BRAND.guildName+' roster.csv';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function openCharacterById(value){
  const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)return;
  const member=members.find(m=>m.id===id);if(member){pendingCharacterId=null;openMember(member.slug);return;}
  pendingCharacterId=id;openMemberSlug=null;window.GuildArmory?.reset();window.GuildCharacterCard?.reset();
  $('member-content').innerHTML='<h2 class="detail-title">Opening character</h2><p role="status">Checking the current guild roster…</p>';
  if(!$('member-dialog').open)$('member-dialog').showModal();
  return load(true);
}
function finishPendingCharacter(){
  if(pendingCharacterId===null)return;const member=members.find(m=>m.id===pendingCharacterId);pendingCharacterId=null;
  if(!$('member-dialog').open)return;
  if(member)openMember(member.slug);else $('member-content').innerHTML='<h2 class="detail-title">No current guild record</h2><p>This character was not returned in the current guild roster.</p>';
}

async function load(force=false) {
  if(refreshing)return;refreshing=true;
  try {
    const latest=await fetchJSON('/api/status');
    const changed=force||!status||latest.configured!==status.configured||latest.sync.updated!==status.sync.updated||latest.sync.published!==status.sync.published||latest.sync.membership_revision!==status.sync.membership_revision;
    if(changed) {
      const all=[];let cursor=0;const generation=latest.sync.published??null,revision=typeof latest.sync.membership_revision==='string'?latest.sync.membership_revision:null;
      do {const page=await fetchJSON('/api/members?cursor='+cursor+(generation?'&generation='+encodeURIComponent(generation):'')+(revision!==null?'&revision='+encodeURIComponent(revision):''));if(page.generation!==generation||revision!==null&&page.revision!==revision)throw new Error('Guild membership changed during loading; the next check will retry');all.push(...page.members);cursor=page.next;}while(cursor!==null);
      status=latest;members=all;window.GuildHierarchy?.update(members);deriveRecipes();updateSummary();renderRoster();renderProfessions();renderRecipes();refreshOpenMember();
      finishPendingCharacter();window.dispatchEvent(new CustomEvent('guild-data'));
      if(!$('status').hidden)await loadEvidence();
    } else {status=latest;renderFreshness();renderStatus();}
  } catch(error) {$('notice').hidden=false;$('notice').textContent=error.message+'. Previously loaded data remains visible.';$('notice').classList.remove('ready');$('connection').textContent='Connection unavailable';}
  finally{refreshing=false;}
}
window.addEventListener('guild-admin',event=>{if(!event.detail){adminViewVersion++;refreshRequestVersion++;refreshCSRF='';refreshQueued=false;$('refresh-wow').hidden=true;$('refresh-wow').disabled=true;$('refresh-wow').textContent='↻ Refresh WoW data';$('refresh-wow-feedback').hidden=true;$('refresh-wow-feedback').textContent='';adminStatus=null;evidenceLoaded=false;$('evidence-body').innerHTML='';$('sync-details').innerHTML='';$('limits').innerHTML='';if(pendingAdminTab||!$('status').hidden||!$('admin').hidden)activate('roster');window.GuildAdminOverview?.reset();pendingAdminTab=false;}else if(pendingAdminTab||['#status','#admin'].includes(location.hash)){const target=pendingAdminTab?pendingAdminView:location.hash.slice(1);pendingAdminTab=false;activate(target);}});
window.addEventListener('guild-member',event=>{const allowed=Boolean(event.detail?.is_admin);refreshCSRF=allowed?event.detail.csrf||'':'';$('refresh-wow').hidden=!allowed;$('refresh-wow').disabled=!refreshCSRF||refreshQueued;});
const initialTab=location.hash.slice(1);activate(ROUTES[initialTab]||initialTab==='hall'?initialTab:'overview');
load();setInterval(()=>{if(!document.hidden)load();},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});

window.GuildCharacter={open:openCharacterById};
