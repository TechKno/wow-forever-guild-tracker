import {CONFIG,LOCALE,ensureDeploymentIdentity} from './config.mjs';
export const PROFILE_MEMBERSHIP_TTL=3600;
const PROFILE_RECHECK_INTERVAL=900;
const CLASS_NAMES={1:'Warrior',2:'Paladin',3:'Hunter',4:'Rogue',5:'Priest',7:'Shaman',8:'Mage',9:'Warlock',11:'Druid'};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const part=value=>typeof value==='string'&&value.length<=40&&/^[\p{L}\p{M}]+$/u.test(value.normalize('NFC'))?value.normalize('NFC'):null;
const localized=value=>typeof value==='string'?value:value&&typeof value==='object'&&!Array.isArray(value)?typeof value[LOCALE]==='string'?value[LOCALE]:typeof value.en_GB==='string'?value.en_GB:typeof value.en_US==='string'?value.en_US:'':'';
const named=value=>localized(value&&typeof value==='object'&&Object.hasOwn(value,'name')?value.name:value);
const sameName=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.normalize('NFC').toLowerCase()===b.normalize('NFC').toLowerCase();

// Only structured account fields choose a profile path; response-supplied hrefs
// and manually entered character names cannot establish ownership.
export function candidateFromAccount(character){
  if(!character||!positive(character.id))return null;
  const name=part(character.name),surname=part(character.surname);
  if(!name||!surname)return null;
  return {id:character.id,name,surname,slug:(name+'-'+surname).toLowerCase()};
}

export function validateProfileMember(profile,candidate,guild,now=Date.now(),settings=CONFIG){
  const expected=settings.guild,label=expected.region.toUpperCase()+' '+expected.ruleset.name;
  const owned=candidateFromAccount(candidate),returned=candidateFromAccount(profile);
  if(!owned||!returned||candidate.slug!==owned.slug||profile.id!==owned.id||returned.slug!==owned.slug||profile.slug!==undefined&&profile.slug!==owned.slug)throw Error('Character ownership or profile identity did not match');
  if(!guild||!positive(guild.id)||!sameName(guild.name,expected.name)||guild.ruleset!==label)throw Error('The expected guild identity is unavailable');
  if(profile.ruleset?.id!==expected.ruleset.id||profile.guild?.id!==guild.id||!sameName(named(profile.guild),expected.name))throw Error('Character profile did not verify the configured guild and ruleset');
  if(!Number.isFinite(now)||now<=0)throw Error('Profile verification time is invalid');
  const checked=Math.floor(now/1000),at=new Date(checked*1000).toISOString();
  const classId=positive(profile.character_class?.id)?profile.character_class.id:null;
  return {id:owned.id,slug:owned.slug,name:returned.name+' '+returned.surname,
    level:positive(profile.level)?profile.level:null,rank:null,
    class_id:classId,class:named(profile.character_class)||CLASS_NAMES[classId]||'Unknown',race:named(profile.race)||'Unknown',
    guild_id:guild.id,ruleset_id:expected.ruleset.id,roster_observed:null,
    membership_source:'character_profile',membership_verified_at:at,
    membership_expires_at:new Date((checked+PROFILE_MEMBERSHIP_TTL)*1000).toISOString()};
}

export function profileMemberStatement(env,userId,member,settings=CONFIG){
  const ruleset=settings.guild.ruleset.id;
  const checked=Math.floor(Date.parse(member.membership_verified_at)/1000),expires=Math.floor(Date.parse(member.membership_expires_at)/1000);
  if(!positive(member.id)||!positive(member.guild_id)||member.ruleset_id!==ruleset||member.membership_source!=='character_profile'||!Number.isSafeInteger(checked)||expires-checked!==PROFILE_MEMBERSHIP_TTL||typeof userId!=='string'||!userId)throw Error('Profile membership proof is invalid');
  return env.DB.prepare(`INSERT INTO profile_members(character_id,slug,user_id,guild_id,ruleset,data,checked_at,expires,next_at,last_error)
    SELECT ?,?,?,?,?,?,?,?,?,NULL WHERE NOT EXISTS(SELECT 1 FROM membership_departures WHERE character_id=?)
    ON CONFLICT(character_id) DO UPDATE SET slug=excluded.slug,user_id=excluded.user_id,guild_id=excluded.guild_id,ruleset=excluded.ruleset,data=excluded.data,checked_at=excluded.checked_at,expires=excluded.expires,next_at=excluded.next_at,last_error=NULL`)
    .bind(member.id,member.slug,userId,member.guild_id,ruleset,JSON.stringify(member),checked,expires,checked+PROFILE_RECHECK_INTERVAL,member.id);
}

function refreshProof(member,settings=CONFIG){
  const ruleset=settings.guild.ruleset.id;
  const checked=Math.floor(Date.parse(member.membership_verified_at)/1000),expires=Math.floor(Date.parse(member.membership_expires_at)/1000);
  if(!positive(member.id)||!positive(member.guild_id)||member.ruleset_id!==ruleset||member.membership_source!=='character_profile'||!Number.isSafeInteger(checked)||expires-checked!==PROFILE_MEMBERSHIP_TTL)throw Error('Profile membership proof is invalid');
  return {checked,expires};
}

// Background work may return after a newer sign-in changes ownership or proof.
// Compare the complete selected proof and current owner before renewing it;
// unlike the sign-in upsert this can never insert or take over another proof.
export function profileMemberRefreshStatement(env,snapshot,member,settings=CONFIG){
  const {checked,expires}=refreshProof(member,settings);
  if(member.id!==snapshot.character_id)throw Error('Profile membership identity changed');
  return env.DB.prepare(`UPDATE profile_members SET slug=?,guild_id=?,ruleset=?,data=?,checked_at=?,expires=?,next_at=?,last_error=NULL
    WHERE character_id=? AND user_id=? AND checked_at=? AND data=?
      AND NOT EXISTS(SELECT 1 FROM membership_departures d WHERE d.character_id=profile_members.character_id)
      AND EXISTS(SELECT 1 FROM character_links l JOIN users u ON u.id=l.user_id
        WHERE l.character_id=profile_members.character_id AND l.user_id=profile_members.user_id
          AND u.ownership_status='verified' AND u.ownership_checked>unixepoch()-86400 AND u.ownership_checked<=unixepoch()+60)`)
    .bind(member.slug,member.guild_id,settings.guild.ruleset.id,JSON.stringify(member),checked,expires,checked+PROFILE_RECHECK_INTERVAL,
      snapshot.character_id,snapshot.user_id,snapshot.checked_at,snapshot.data);
}

export function profileMemberDeleteStatement(env,snapshot){
  return env.DB.prepare('DELETE FROM profile_members WHERE character_id=? AND user_id=? AND checked_at=? AND data=?')
    .bind(snapshot.character_id,snapshot.user_id,snapshot.checked_at,snapshot.data);
}

// Supplemental additions, revocations and expiry can change visible rows while
// the upstream roster generation stays the same. Pin browser pagination to both.
export async function membershipRevision(env){
  await ensureDeploymentIdentity(env);
  const sync=await env.DB.prepare('SELECT published FROM sync WHERE id=1').first();
  if(!sync?.published)return null;
  const rows=await env.DB.prepare("SELECT character_id,data FROM verified_membership WHERE generation=? AND json_extract(data,'$.membership_source')='character_profile' ORDER BY character_id,slug").bind(sync.published).all();
  if(!rows.results.length)return sync.published;
  const bytes=new TextEncoder().encode(JSON.stringify(rows.results.map(row=>[row.character_id,row.data])));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hash=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  return sync.published+'~'+hash;
}
