import {CONFIG,GUILD,SLUG,LOCALE,RULESET_ID,RULESET_NAME,RULESET_LABEL,providerURL,ensureDeploymentIdentity} from './config.mjs';
import {progressStatements} from './progress.mjs';
import {rosterProgressStatements} from './roster-progress.mjs';
import {syncHistoryStatements} from './admin-overview.mjs';
import {normalizeTalentBuild} from './talent-data.mjs';
import {validateProfileMember,profileMemberRefreshStatement,profileMemberDeleteStatement} from './guild-membership.mjs';
import {recheckOneProfileMember} from './profile-membership-refresh.mjs';
export {GUILD,SLUG};
const RULESET = RULESET_ID;
const ROSTER_INTERVAL = CONFIG.refresh.rosterSeconds;
const CHARACTER_INTERVAL = CONFIG.refresh.activeSeconds;
const ACTIVE_SAFETY = CONFIG.refresh.activeSeconds;
const INACTIVE_SAFETY = CONFIG.refresh.inactiveSeconds;
const CLASS_NAMES = {1:'Warrior',2:'Paladin',3:'Hunter',4:'Rogue',5:'Priest',7:'Shaman',8:'Mage',9:'Warlock',11:'Druid'};
const timestamp = () => new Date().toISOString();
const epoch = () => Math.floor(Date.now()/1000);
let tokenCache;

export class APIError extends Error {
  constructor(message,status=0,retryAfter=0) { super(message); this.status=status; this.retryAfter=retryAfter; }
}
export function retryAfter(value,now=Date.now()) {
  if(!value)return 0;
  const seconds=/^\d+(?:\.\d+)?$/.test(value.trim())?Number(value):Math.ceil((Date.parse(value)-now)/1000);
  return Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):0;
}
export function normalizeLogin(value) {
  if(typeof value!=='number'||!Number.isFinite(value))return null;
  const ms=value<100000000000?value*1000:value;
  return ms>=Date.UTC(2004,0,1)&&ms<=Date.now()+300000?new Date(ms).toISOString():null;
}
export function label(value) {
  if(typeof value==='string') return value;
  if(value && typeof value==='object') return label(value.name || value[LOCALE] || value.en_GB || value.en_US || '');
  return '';
}
export function normalizeProfessions(payload) {
  if(!payload || !['primaries','secondaries'].some(k=>Object.hasOwn(payload,k))) throw new APIError('Profession response format is unrecognised');
  const result=[];
  for(const [kind,field] of [['Primary','primaries'],['Secondary','secondaries']]) {
    const entries=Object.hasOwn(payload,field)?payload[field]:[];
    if(!Array.isArray(entries)) throw new APIError('Profession list format is unrecognised');
    for(const entry of entries) {
      const prof=entry.profession??{};
      if(entry.tiers!==undefined && !Array.isArray(entry.tiers)) throw new APIError('Profession tier format is unrecognised');
      for(const tier of entry.tiers?.length ? entry.tiers : [entry]) {
        const present=Object.hasOwn(tier,'known_recipes') && tier.known_recipes!==null;
        const recipes=tier.known_recipes??[];
        if(!Array.isArray(recipes)) throw new APIError('Known recipe list format is unrecognised');
        result.push({id:prof.id??null,name:label(prof)||'Unknown profession',kind,tier:label(tier.tier),
          skill:Number.isFinite(tier.skill_points)?tier.skill_points:null,
          max_skill:Number.isFinite(tier.max_skill_points)?tier.max_skill_points:null,
          recipe_status:present?'observed':'not_exposed',
          recipes:recipes.filter(r=>Number.isSafeInteger(r.id)).map(r=>({id:r.id,name:label(r)||`Recipe #${r.id}`}))});
      }
    }
  }
  return result;
}
export function normalizeTalents(payload) {
  if(!Array.isArray(payload?.specialization_groups)) throw new APIError('Talent response format is unrecognised');
  const group=payload.specialization_groups.find(g=>g.is_active===true);
  if(!group) return null;
  if(!Array.isArray(group.specializations))throw new APIError('Active talent tree list was incomplete; previous observation retained');
  return group.specializations.map(s=>({name:s.specialization_name||label(s.specialization),points:s.spent_points??null}));
}
export function validateRoster(ruleset,guild,roster,settings=CONFIG) {
  const expected=settings.guild;
  if(ruleset?.id!==expected.ruleset.id || label(ruleset).toLowerCase()!==expected.ruleset.name.toLowerCase()) throw new APIError('Configured ruleset could not be verified');
  if(label(guild).toLowerCase()!==expected.name.toLowerCase() || guild?.ruleset?.id!==expected.ruleset.id || !Number.isSafeInteger(guild.id)||guild.id<=0) throw new APIError('Guild name or configured ruleset does not match; import stopped');
  if(!Array.isArray(roster?.members) || roster.guild?.id!==guild.id) throw new APIError('Guild roster identity or format did not match; previous roster retained');
  const slugs=new Set(),identities=new Set();
  return roster.members.map(row=>{
    const c=row.character??{};
    const slug=c.slug || [c.name,c.surname].filter(Boolean).join('-').toLowerCase();
    if(!c.id || !slug || slugs.has(slug)||identities.has(c.id)) throw new APIError('Roster contains missing or duplicate character identities');
    slugs.add(slug);identities.add(c.id);
    return {id:c.id,slug,name:[c.name,c.surname].filter(Boolean).join(' '),level:c.level??null,rank:row.rank??null,
      class_id:c.playable_class?.id??null,class:label(c.playable_class)||CLASS_NAMES[c.playable_class?.id]||'Unknown',
      race:label(c.playable_race)||'Unknown',roster_observed:timestamp()};
  });
}
async function evidence(env,path,namespace,status,detail) {
  const stamp=timestamp();
  await env.DB.prepare(`INSERT INTO evidence(path,namespace,attempted,succeeded,status,detail) VALUES(?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET namespace=excluded.namespace,attempted=excluded.attempted,
    succeeded=CASE WHEN excluded.status='verified' THEN excluded.succeeded ELSE evidence.succeeded END,
    status=excluded.status,detail=excluded.detail`).bind(path,namespace,stamp,status==='verified'?stamp:null,status,detail).run();
}
async function requestJSON(url,options={}) {
  const {observe,...fetchOptions}=options;
  let response;
  try { response=await fetch(url,{...fetchOptions,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(20000)}); }
  catch { throw new APIError('Could not reach Blizzard; previous data retained'); }
  if(!response.ok) { const delay=retryAfter(response.headers.get('Retry-After'));await response.body?.cancel(); throw new APIError(`Blizzard returned HTTP ${response.status}`,response.status,delay); }
  if(Number(response.headers.get('Content-Length'))>4000000) { await response.body?.cancel(); throw new APIError('Blizzard response exceeded the size limit'); }
  let value;
  try { const text=await response.text(); if(text.length>4000000) throw 0; value=JSON.parse(text); }
  catch { throw new APIError('Blizzard returned an unreadable or oversized response'); }
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new APIError('Blizzard response format is unrecognised');
  observe?.({checked_at:timestamp(),last_modified:response.headers.get('Last-Modified'),date:response.headers.get('Date'),age:response.headers.get('Age'),cache_control:response.headers.get('Cache-Control'),cache_status:response.headers.get('CF-Cache-Status')});
  return value;
}
export async function accessToken(env) {
  if(tokenCache && tokenCache.client===env.BLIZZARD_CLIENT_ID && tokenCache.expires>Date.now()) return tokenCache.value;
  if(!env.BLIZZARD_CLIENT_ID || !env.BLIZZARD_CLIENT_SECRET) throw new APIError('Battle.net API credentials have not been configured');
  const result=await requestJSON('https://oauth.battle.net/token',{method:'POST',headers:{
    Authorization:'Basic '+btoa(env.BLIZZARD_CLIENT_ID+':'+env.BLIZZARD_CLIENT_SECRET),
    'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  if(typeof result.access_token!=='string') throw new APIError('Blizzard did not issue an access token');
  tokenCache={client:env.BLIZZARD_CLIENT_ID,value:result.access_token,expires:Date.now()+Math.max(1,(result.expires_in||3600)-60)*1000};
  await evidence(env,'/token','OAuth client_credentials','verified','Token issued; retained in server memory only');
  return tokenCache.value;
}
export async function apiObservation(env,path,namespace='profile') {
  const target=providerURL(path,namespace),ns=new URL(target).searchParams.get('namespace');
  const paused=await state(env,'blizzard_cooldown');
  if(paused>epoch())throw new APIError('Blizzard rate limit; waiting before another API request',429,paused-epoch());
  try {
    let result,metadata;
    for(let attempt=0;attempt<2;attempt++) {
      try { result=await requestJSON(target,
        {headers:{Authorization:'Bearer '+await accessToken(env),Accept:'application/json','Cache-Control':'no-cache',Pragma:'no-cache'},observe:value=>metadata=value}); break; }
      catch(error) { if(error.status===401 && attempt===0) { tokenCache=undefined; continue; } throw error; }
    }
    await evidence(env,path,ns,'verified','HTTP 200 observed; individual field coverage is shown separately');
    return {data:result,metadata};
  } catch(error) {
    if(error.status===429)await env.DB.prepare(`INSERT INTO state(key,value) VALUES('blizzard_cooldown',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(state.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)`)
      .bind(String(epoch()+Math.max(60,error.retryAfter||300))).run();
    await evidence(env,path,ns,'unavailable',error instanceof APIError?error.message:'Lookup could not complete');
    throw error;
  }
}
export async function api(env,path,namespace='profile'){return (await apiObservation(env,path,namespace)).data;}
export async function state(env,key) {
  const row=await env.DB.prepare('SELECT value FROM state WHERE key=?').bind(key).first();
  return row?JSON.parse(row.value):null;
}
async function saveState(env,key,value) {
  return env.DB.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)').bind(key,JSON.stringify(value)).run();
}
function syncUpdateStatement(env,owner,fields) {
  const entries=Object.entries({...fields,updated:timestamp()});
  return env.DB.prepare(`UPDATE sync SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE id=1 AND lease=?`)
    .bind(...entries.map(([,v])=>v),owner);
}
async function syncUpdate(env,owner,fields) {
  await syncUpdateStatement(env,owner,fields).run();
}
export function mergeMember(roster,details={}) {
  const proofAt=Date.parse(roster.membership_verified_at||''),previousAttempt=Date.parse(details.profile_checked_at||details.profile_at||'1970-01-01T00:00:00Z');
  if(roster.membership_source==='character_profile'&&Number.isFinite(proofAt)&&proofAt>previousAttempt&&Date.parse(roster.membership_expires_at)>Date.now()){
    details={...details,profile:{class:roster.class,race:roster.race,level:roster.level},profile_at:roster.membership_verified_at,profile_checked_at:roster.membership_verified_at,profile_status:'verified',profile_availability:'published',profile_error:undefined,profile_note:undefined};
  }
  const profile=details.profile||{},validLevel=v=>Number.isSafeInteger(v)&&v>0;
  // Blizzard's independently cached endpoints can disagree even when fetched in order.
  const profileWins=validLevel(profile.level)&&(!validLevel(roster.level)||profile.level>roster.level);
  const recentProfile=details.profile_status==='verified'&&details.profile_at>roster.roster_observed;
  return {...roster,...details,...(recentProfile?profile:{}),
    level:profileWins?profile.level:roster.level??profile.level??null,
    level_source:profileWins?'profile':roster.membership_source==='character_profile'?'character_profile':'roster',level_observed_at:profileWins?details.profile_at:roster.membership_verified_at||roster.roster_observed};
}
export async function refreshView(env) {
  const sync=await env.DB.prepare('SELECT published,roster_at,next_at,total FROM sync WHERE id=1').first();
  const row=await env.DB.prepare(`SELECT MAX(json_extract(c.data,'$.profile_at')) last_character_check_at,
    MAX(json_extract(c.data,'$.professions_at')) latest_professions_at,MIN(json_extract(c.data,'$.professions_at')) oldest_professions_at,
    SUM(CASE WHEN COALESCE(q.next_at,0)<=? THEN 1 ELSE 0 END) pending
    FROM verified_membership m LEFT JOIN characters c ON c.id=m.character_id LEFT JOIN character_refresh q ON q.character_id=m.character_id WHERE m.generation=?`)
    .bind(epoch(),sync.published||'').first();
  const dates=[sync.roster_at,row?.last_character_check_at,row?.latest_professions_at].filter(Boolean).sort();
  return {last_success_at:dates.at(-1)||null,roster_at:sync.roster_at,last_character_check_at:row?.last_character_check_at||null,
    oldest_professions_at:row?.oldest_professions_at||null,latest_professions_at:row?.latest_professions_at||null,
    next_roster_at:sync.next_at?new Date(sync.next_at*1000).toISOString():null,
    roster_interval_minutes:15,character_interval_minutes:15,details_safety_hours:1,active_details_safety_minutes:15,
    approximate_sweep_minutes:Math.max(15,sync.total||0),pending:row?.pending||0,paused_until:await state(env,'blizzard_cooldown')>epoch()?new Date((await state(env,'blizzard_cooldown'))*1000).toISOString():null};
}
export async function probeCharacter(env,value){
  const cid=Number(value),row=await env.DB.prepare(`SELECT m.data roster,c.data details FROM verified_membership m LEFT JOIN characters c ON c.id=m.character_id
    WHERE m.generation=(SELECT published FROM sync WHERE id=1) AND (m.slug=? OR m.character_id=?) LIMIT 1`).bind(String(value),Number.isSafeInteger(cid)?cid:0).first();
  if(!row){
    const slug=String(value).normalize('NFC').toLowerCase(),parts=slug.split('-');
    if(parts.length!==2||parts.some(part=>part.length>40||!/^\p{L}[\p{L}\p{M}]*$/u.test(part)))return null;
    const result={checked_at:timestamp(),character:{name:parts.join(' '),slug},saved:null,ownership_verified:false,persisted:false,blizzard:{}};
    try{
      const observation=await apiObservation(env,'/profile/wow/character/'+encodeURIComponent(slug)),profile=observation.data;
      let guildVerified=false;try{validateProfileMember(profile,{id:profile.id,slug,name:parts[0],surname:parts[1]},await state(env,'guild'));guildVerified=true;}catch{}
      result.character={id:profile.id,name:[profile.name,profile.surname].filter(Boolean).join(' '),slug};
      result.blizzard.profile={status:'observed',level:profile.level??null,guild_id:profile.guild?.id??null,guild_name:label(profile.guild)||null,ruleset_id:profile.ruleset?.id??null,guild_verified:guildVerified,metadata:observation.metadata};
    }catch(error){result.blizzard.profile={status:'unavailable',http_status:error.status||null,note:error instanceof APIError?error.message:'Blizzard profile could not be checked'};}
    result.note='Read-only profile diagnostic. This does not add a member or verify account ownership; the actual character owner must sign in with Battle.net.';
    return result;
  }
  const member=JSON.parse(row.roster),details=row.details?JSON.parse(row.details):{},result={checked_at:timestamp(),character:{id:member.id,name:member.name,slug:member.slug},saved:{level:mergeMember(member,details).level,roster_at:member.roster_observed,profile_at:details.profile_at||null},blizzard:{}};
  const knownGuild=await state(env,'guild');
  for(const [key,path]of [['roster',`/data/wow/guild/${SLUG}/roster`],['profile',`/profile/wow/character/${encodeURIComponent(member.slug)}`]]){
    try{
      const observation=await apiObservation(env,path),data=observation.data;
      if(key==='profile'&&(data.id!==member.id||data.ruleset?.id!==RULESET))throw new APIError('Returned profile identity did not match');
      if(key==='roster'&&(!Array.isArray(data.members)||data.guild?.id!==knownGuild?.id))throw new APIError('Returned roster identity did not match');
      const character=key==='roster'?data.members.find(r=>r.character?.id===member.id)?.character:data;
      result.blizzard[key]={status:'observed',level:character?.level??null,activity_marker:key==='profile'?normalizeLogin(data.last_login_timestamp):undefined,metadata:observation.metadata};
    }catch(error){result.blizzard[key]={status:'unavailable',http_status:error.status||null,note:error instanceof APIError?error.message:'Blizzard check could not complete'};}
  }
  result.note='These requests bypass the tracker and Cloudflare response caches. Blizzard can still return an older game snapshot; a successful check does not establish when the in-game value changed.';
  return result;
}
export async function queueRefresh(env,options={}) {
  const now=epoch();
  const cid=options.character_id===undefined?null:Number(options.character_id);
  if(cid!==null&&(!Number.isSafeInteger(cid)||!await env.DB.prepare('SELECT character_id FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1) AND character_id=?').bind(cid).first()))throw new APIError('Choose a current guild character',400);
  const key=cid===null?'manual_refresh_requested':'manual_refresh_requested:'+cid;
  const requested=await env.DB.prepare(`INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(state.value AS INTEGER)<=? RETURNING value`)
    .bind(key,String(now),now-300).first();
  if(requested)await env.DB.batch([
    env.DB.prepare("UPDATE sync SET next_at=0,updated=?,status='syncing',message='Full WoW refresh queued' WHERE id=1").bind(timestamp()),
    env.DB.prepare(`INSERT INTO character_refresh(character_id,next_at,requested_at) SELECT character_id,0,? FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1) AND (? IS NULL OR character_id=?)
      ON CONFLICT(character_id) DO UPDATE SET next_at=0,requested_at=excluded.requested_at`).bind(Date.now(),cid,cid)
  ]);
  return {queued:Boolean(requested),message:requested?'Full WoW refresh queued. The selected profiles, professions, recipes and talents will be checked in scheduled batches, respecting Blizzard pauses.':'A WoW refresh was already requested recently. Scheduled checks are still running.',refresh:await refreshView(env)};
}
function boundedBackoff(failures,status) {
  return status===404?3600:Math.min(3600,300*2**Math.min(4,Math.max(0,failures-1)));
}
export function refreshReason(data,schedule,profile,member) {
  if((schedule.requested_at||0)>(data.professions_request_ack||0))return 'manual';
  const at=data.professions_at;
  if(!at)return 'first_refresh';
  const marker=normalizeLogin(profile.last_login_timestamp),ms=marker?Date.parse(marker):null;
  const changed=ms!==null&&ms!==schedule.last_detail_login;
  const level=Math.max(profile.level||0,member.level||0);
  if(changed)return 'activity_changed';
  if(level>(schedule.details_level??data.profile?.level??0))return 'level_changed';
  if(data.professions_status!=='verified')return 'retry';
  const safety=ms===null||ms>Date.now()-86400000?ACTIVE_SAFETY:INACTIVE_SAFETY;
  return Date.now()-Date.parse(at)>=safety*1000?'safety':null;
}
function verifiedProfessions(response,prior) {
  const result=normalizeProfessions(response);
  const key=p=>`${p.id??p.name}|${p.tier||''}`;
  const byKey=new Map(result.map(p=>[key(p),p]));
  for(const p of prior.professions||[]) {
    const field=p.kind==='Primary'?'primaries':'secondaries';
    if(!Object.hasOwn(response,field))throw new APIError('Profession list was incomplete; previous observation retained');
    const next=byKey.get(key(p));
    const sameProfession=result.filter(n=>p.id&&n.id?n.id===p.id:n.name===p.name);
    if(p.recipe_status==='observed'&&sameProfession.some(n=>n.recipe_status!=='observed'))throw new APIError('Profession tiers or learned recipes were omitted; previous observation retained');
    if(next&&p.recipe_status==='observed'&&next.recipe_status!=='observed')throw new APIError('Known recipe list was omitted; previous observation retained');
  }
  return result;
}
async function refreshCharacter(env,row) {
  const member=JSON.parse(row.roster),prior=row.details?JSON.parse(row.details):null,data=prior?structuredClone(prior):{};
  // Pin the proof before a provider request can race a newer owner/sign-in.
  const membershipProof=member.membership_source==='character_profile'?await env.DB.prepare('SELECT * FROM profile_members WHERE character_id=?').bind(member.id).first():null;
  const at=timestamp(),schedule=row,now=epoch();let profile,profileError,delay=CHARACTER_INTERVAL,detailLogin=schedule.last_detail_login,detailsLevel=schedule.details_level;
  const failed=(key,error)=>{
    data[key+'_status']=data[key+'_at']?'stale':'unavailable';
    data[key+'_error']=error instanceof APIError?error.message:'Lookup could not complete';
    data[key+'_failures']=(data[key+'_failures']||0)+1;
    const wait=Math.max(boundedBackoff(data[key+'_failures'],error.status),error.retryAfter||0);
    data[key+'_retry_at']=now+wait;delay=Math.min(delay,wait);
  };
  data.profile_checked_at=at;
  try {
    const observation=await apiObservation(env,`/profile/wow/character/${encodeURIComponent(member.slug)}`);profile=observation.data;
    if(member.membership_source==='character_profile'){
      const proof=membershipProof;
      if(proof){
        let verified;
        try{const [first,surname]=member.slug.split('-');verified=validateProfileMember(profile,{id:member.id,slug:member.slug,name:first,surname},await state(env,'guild'));}
        catch{await profileMemberDeleteStatement(env,proof).run();throw new APIError('Character guild membership could not be verified');}
        await profileMemberRefreshStatement(env,proof,verified).run();
      }
    }
    if(profile.id!==member.id||profile.ruleset?.id!==RULESET)throw new APIError('Character identity or configured ruleset did not match');
    data.profile={class:label(profile.character_class)||member.class,race:label(profile.race)||member.race,level:Number.isSafeInteger(profile.level)?profile.level:member.level};
    data.profile_at=at;data.profile_status='verified';delete data.profile_error;
    data.profile_availability='published';delete data.profile_note;
    const modified=Date.parse(observation.metadata?.last_modified||'');data.profile_source_updated_at=Number.isFinite(modified)?new Date(modified).toISOString():null;
    data.last_login_at=normalizeLogin(profile.last_login_timestamp);data.activity_checked_at=at;
  } catch(error) {profileError=error;failed('profile',error);delay=Math.max(boundedBackoff((schedule.failures||0)+1,error.status),error.retryAfter||0);
    data.profile_availability=error.status===404?'not_published':'temporary_error';
    data.profile_note=error.status===404?(member.level<10?'Blizzard has not published this profile. Community testing finds Forever profiles appear from level 10 after logging out; this is not an official support guarantee. We will retry automatically.':'Blizzard returned no published profile for this guild character. A logout to character selection may allow its snapshot to publish; we will retry automatically.'):'The latest Blizzard check failed. Any previously observed profile is retained and will be retried.';
  }
  let detailReason=null,detailAttempted=false;
  if(profile&&!profileError) {
    detailReason=refreshReason(data,schedule,profile,member);data.details_refresh_reason=detailReason||'unchanged';
    const marker=data.last_login_at?Date.parse(data.last_login_at):null;
    for(const [key,suffix]of [['professions','/professions'],['talents','/specializations']]) {
      const keyMarker=key==='professions'?schedule.last_detail_login:data.talents_activity_marker;
      const requested=(schedule.requested_at||0)>(data[key+'_request_ack']||0);
      const markerChanged=marker!==null&&marker!==keyMarker;
      const safety=marker===null||marker>Date.now()-86400000?ACTIVE_SAFETY:INACTIVE_SAFETY;
      const needs=key==='professions'?Boolean(detailReason):requested||!data.talents_at||data.talents_status!=='verified'||markerChanged||Math.max(profile.level||0,member.level||0)>(data.talents_level??0)||Date.now()-Date.parse(data.talents_at)>=safety*1000;
      if(!needs)continue;
      // A stable unavailable endpoint backs off independently of successful detail calls.
      if(data[key+'_retry_at']>now&&marker===data[key+'_attempt_marker']&&(!requested||schedule.requested_at===data[key+'_attempt_request']))continue;
      if(key==='professions')detailAttempted=true;
      data[key+'_attempt_marker']=marker;
      data[key+'_attempt_request']=schedule.requested_at||0;data[key+'_checked_at']=timestamp();
      try {
        const response=await api(env,`/profile/wow/character/${encodeURIComponent(member.slug)}${suffix}`);
        if(response.character?.id!==member.id)throw new APIError('Character identity did not match');
        const normalized=key==='professions'?verifiedProfessions(response,data):normalizeTalents(response);
        const build=key==='talents'?normalizeTalentBuild(response,member.id):null;
        data[key]=normalized;if(build)data.talent_build=build;
        data[key+'_at']=timestamp();data[key+'_status']='verified';delete data[key+'_error'];delete data[key+'_retry_at'];delete data[key+'_failures'];
        data[key+'_request_ack']=schedule.requested_at||0;
        if(key==='professions'){detailLogin=marker;detailsLevel=Math.max(profile.level||0,member.level||0);}
        else {data.talents_activity_marker=marker;data.talents_level=Math.max(profile.level||0,member.level||0);}
      } catch(error) {failed(key,error);if(error.status===429)break;}
    }
  }
  const result=profileError?'profile_unavailable':detailAttempted?(data.professions_status==='verified'?'details_refreshed':'details_unavailable'):'activity_checked';
  const savedLevel=await env.DB.prepare("SELECT MAX(json_extract(data,'$.level')) level FROM snapshots WHERE character_id=? AND json_type(data,'$.level')='integer'").bind(member.id).first();
  const validLevel=value=>Number.isSafeInteger(value)&&value>0?value:0;
  const beforeLevel=Math.max(validLevel(savedLevel?.level),prior?.profile_at||prior?.profile_status==='verified'?validLevel(prior?.profile?.level):0);
  const afterLevel=data.profile_status==='verified'?Math.max(beforeLevel,validLevel(member.level),validLevel(data.profile?.level)):0;
  const rosterWins=validLevel(member.level)>validLevel(data.profile?.level);
  const statements=progressStatements(env,member,prior,data,{levelBefore:beforeLevel,levelAfter:afterLevel,
    levelSource:rosterWins?'roster':'profile',levelObservedAt:rosterWins?member.roster_observed: data.profile_at});

  statements.push(env.DB.prepare('INSERT OR REPLACE INTO characters(id,data,updated) VALUES(?,?,?)').bind(member.id,JSON.stringify(data),timestamp()));
  statements.push(env.DB.prepare(`UPDATE character_refresh SET next_at=?,last_attempt=?,last_result=?,failures=?,last_detail_login=?,details_level=? WHERE character_id=?`)
    .bind(now+delay,at,result,profileError?(schedule.failures||0)+1:0,detailLogin??null,detailsLevel??null,member.id));
  await env.DB.batch(statements);
  return {member:member.name,result};
}
async function rosterStep(env,job,owner) {
  if(job.phase==='roster') {
    const started=timestamp();
    const ruleset=await api(env,'/data/wow/ruleset/'+RULESET,'dynamic'),guild=await api(env,`/data/wow/guild/${SLUG}`),roster=await api(env,`/data/wow/guild/${SLUG}/roster`);
    const members=validateRoster(ruleset,guild,roster),generation=crypto.randomUUID();
    await saveState(env,'staging',{members,guild:{id:guild.id,name:GUILD,ruleset:RULESET_LABEL,ruleset_id:RULESET,region:CONFIG.guild.region,faction:label(guild.faction)},generation,started_at:started,fetched_at:timestamp()});
    await syncUpdate(env,owner,{phase:'stage',cursor:0,generation,total:members.length,status:'syncing',message:'Guild verified; preparing roster',next_at:0});
    return;
  }
  const staging=await state(env,'staging');
  if(!staging||staging.generation!==job.generation)throw new APIError('Staging data did not match; previous published roster retained');
  const chunk=staging.members.slice(job.cursor,job.cursor+12);
  if(chunk.length)await env.DB.batch(chunk.map(m=>env.DB.prepare('INSERT OR REPLACE INTO membership(generation,slug,character_id,data) VALUES(?,?,?,?)').bind(job.generation,m.slug,m.id,JSON.stringify(m))));
  const cursor=job.cursor+chunk.length;
  if(cursor<staging.members.length){await syncUpdate(env,owner,{cursor,message:`Preparing roster · ${cursor} / ${job.total}`});return;}
  const publication=rosterProgressStatements(env,{generation:job.generation,previous:job.published,owner,observedAt:staging.fetched_at||timestamp()});
  // A complete new roster supersedes older supplemental proofs for departures.
  // Every marker/proof change commits with its published roster and chronicle.
  if(job.published){
    publication.unshift(env.DB.prepare(`INSERT INTO membership_departures(character_id,slug,observed_at)
      SELECT o.character_id,o.slug,? FROM membership o WHERE o.generation=?
        AND NOT EXISTS(SELECT 1 FROM membership n WHERE n.generation=? AND n.character_id=o.character_id)
        AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')
      ON CONFLICT(character_id) DO UPDATE SET slug=excluded.slug,observed_at=excluded.observed_at`)
      .bind(staging.fetched_at||timestamp(),job.published,job.generation,owner,job.generation));
    publication.splice(1,0,env.DB.prepare(`DELETE FROM profile_members WHERE character_id IN (
      SELECT o.character_id FROM membership o WHERE o.generation=?
        AND NOT EXISTS(SELECT 1 FROM membership n WHERE n.generation=? AND n.character_id=o.character_id))
      AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`)
      .bind(job.published,job.generation,owner,job.generation));
  }
  publication.push(env.DB.prepare(`DELETE FROM membership_departures WHERE character_id IN (SELECT character_id FROM membership WHERE generation=?)
    AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`).bind(job.generation,owner,job.generation));
  if(job.published){
    // Vacate a departed character's live party place while keeping historical
    // event records. The usual poll will update the owned Discord announcement.
    const departed=`SELECT o.character_id FROM membership o WHERE o.generation=? AND NOT EXISTS(
      SELECT 1 FROM membership n WHERE n.generation=? AND n.character_id=o.character_id)`;
    const liveEvents="SELECT id FROM events WHERE status='open' AND datetime(starts_at,'+'||duration_minutes||' minutes')>datetime('now')";
    publication.push(env.DB.prepare(`UPDATE discord_event_posts SET next_poll_at=MIN(next_poll_at,?)
      WHERE event_id IN (SELECT event_id FROM event_signups WHERE character_id IN (${departed}) AND event_id IN (${liveEvents}))
        AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`)
      .bind(epoch(),job.published,job.generation,owner,job.generation));
    publication.push(env.DB.prepare(`DELETE FROM event_signups WHERE character_id IN (${departed}) AND event_id IN (${liveEvents})
      AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`)
      .bind(job.published,job.generation,owner,job.generation));
  }
  if(job.published)publication.push(env.DB.prepare(`INSERT OR IGNORE INTO activity(id,character_id,kind,title,detail,observed_at)
    SELECT 'left:'||?||':'||m.character_id,m.character_id,'left',json_extract(m.data,'$.name')||' no longer appears in the roster',
    'A change in the returned roster; not an independent confirmation of leaving the guild',? FROM membership m WHERE m.generation=?
    AND NOT EXISTS(SELECT 1 FROM membership n WHERE n.generation=? AND n.character_id=m.character_id)
    AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`)
    .bind(job.generation,timestamp(),job.published,job.generation,owner,job.generation));
  await env.DB.prepare(`INSERT OR IGNORE INTO character_refresh(character_id,next_at) SELECT character_id,0 FROM membership WHERE generation=?`).bind(job.generation).run();
  // A newly changed roster level wakes a backed-off character without repeatedly waking the same observation.
  await env.DB.prepare(`UPDATE character_refresh SET next_at=MIN(next_at,?) WHERE character_id IN (
    SELECT n.character_id FROM membership n LEFT JOIN membership o ON o.character_id=n.character_id AND o.generation=?
    WHERE n.generation=? AND (o.character_id IS NULL OR json_extract(n.data,'$.level')<>json_extract(o.data,'$.level')))`)
    .bind(epoch(),job.published||'',job.generation).run();
  await saveState(env,'guild',staging.guild);
  const observed=staging.fetched_at||timestamp();
  const completed=timestamp();
  publication.push(...syncHistoryStatements(env,{generation:job.generation,previous:job.published,owner,observedAt:observed,startedAt:staging.started_at||observed,completedAt:completed}));
  publication.push(syncUpdateStatement(env,owner,{published:job.generation,phase:'roster',cursor:0,roster_at:observed,completed_at:completed,next_at:Math.floor(Date.parse(observed)/1000)+ROSTER_INTERVAL,status:'syncing',message:'Roster refreshed; activity checks continue independently'}));
  await env.DB.batch(publication);
  await env.DB.prepare('DELETE FROM membership WHERE generation<>? AND generation<>?').bind(job.generation,job.published||'').run();
  await env.DB.prepare('DELETE FROM character_refresh WHERE character_id NOT IN (SELECT character_id FROM verified_membership WHERE generation=?)').bind(job.generation).run();
}
export async function tick(env) {
  await ensureDeploymentIdentity(env);
  const owner=crypto.randomUUID();
  const job=await env.DB.prepare('UPDATE sync SET lease=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING *').bind(owner,epoch()+180,epoch()).first();
  if(!job)return {busy:true};
  try {
    if(!env.BLIZZARD_CLIENT_ID||!env.BLIZZARD_CLIENT_SECRET){await syncUpdate(env,owner,{status:'waiting',message:'Connect your Battle.net API client in Cloudflare settings'});return;}
    const paused=await state(env,'blizzard_cooldown');
    if(paused>epoch()){await syncUpdate(env,owner,{status:'partial',message:'Blizzard requested a pause; saved data remains available'});return {paused_until:paused};}
    if(job.phase==='members') {await syncUpdate(env,owner,{phase:'roster',cursor:0,next_at:0});job.phase='roster';job.next_at=0;}
    let rosterError;
    if(job.phase==='stage'||job.next_at<=epoch())try{await rosterStep(env,job,owner);}catch(error){
      rosterError=error;await syncUpdate(env,owner,{phase:'roster',cursor:0,status:'partial',message:error instanceof APIError?error.message:'Roster refresh could not complete; previous data retained',next_at:epoch()+Math.max(300,error.retryAfter||0)});
    }
    if(await state(env,'blizzard_cooldown')>epoch())return;
    const current=await env.DB.prepare('SELECT * FROM sync WHERE id=1').first();
    if(!current.published)return;
    await env.DB.prepare(`INSERT OR IGNORE INTO character_refresh(character_id) SELECT character_id FROM verified_membership WHERE generation=?`).bind(current.published).run();
    const row=await env.DB.prepare(`SELECT q.*,m.data roster,c.data details FROM character_refresh q JOIN verified_membership m ON m.character_id=q.character_id AND m.generation=?
      LEFT JOIN characters c ON c.id=q.character_id WHERE q.next_at<=? ORDER BY q.next_at,COALESCE(q.last_attempt,''),m.slug LIMIT 1`).bind(current.published,epoch()).first();
    const lastProofJob=await state(env,'profile_membership_last_check');
    const rechecked=!row||!lastProofJob||epoch()-lastProofJob>=120?await recheckOneProfileMember(env):null;
    if(rechecked)await saveState(env,'profile_membership_last_check',epoch());
    const result=rechecked||(row?await refreshCharacter(env,row):null);
    if(current.phase==='roster'&&!rosterError){
      const counts=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN c.data IS NULL OR COALESCE(json_extract(c.data,'$.profile_status'),'')<>'verified' OR COALESCE(json_extract(c.data,'$.professions_status'),'')<>'verified' OR COALESCE(json_extract(c.data,'$.talents_status'),'')<>'verified' THEN 1 ELSE 0 END) errors
        FROM verified_membership m LEFT JOIN characters c ON c.id=m.character_id WHERE m.generation=?`).bind(current.published).first();
      await syncUpdate(env,owner,{errors:counts.errors||0,status:counts.errors?'partial':'ready',message:result?`${result.member} · ${result.result==='details_refreshed'?'professions and recipes refreshed':result.result==='activity_checked'?'activity checked; saved recipes retained':result.result==='membership_refreshed'?'guild membership verified through character profile':result.result==='membership_in_roster'?'now included in the guild roster':result.result==='membership_unverified'?'profile membership is no longer verified':'some data unavailable; retry scheduled'}`:'Activity checks up to date'});
    } else if(result)await syncUpdate(env,owner,{});
    return result;
  } catch(error) {await syncUpdate(env,owner,{status:'partial',message:error instanceof APIError?error.message:'Refresh could not complete; previous data retained'});}
  finally {await env.DB.prepare('UPDATE sync SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').bind(owner).run();}
}
