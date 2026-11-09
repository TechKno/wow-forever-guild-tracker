import {discordAPI,discordConfig,discordReady} from './discord.mjs';
import {activeManualMappings} from './admin-mappings.mjs';
import {digest,stamp} from './auth.mjs';
import {mergeMember,state} from './logic.mjs';
import {currentRolePreferences,withRolePreferences} from './character-roles.mjs';
const epoch=()=>Math.floor(Date.now()/1000),snowflake=value=>typeof value==='string'&&/^\d{15,22}$/.test(value);
const name=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80)||null:null;
export function discordDisplayName(profile){return name(profile?.nickname)||name(profile?.global_name)||name(profile?.username)||null;}

export async function cacheDiscordProfile(env,discordId,member){
  const config=await discordConfig(env),guildMember=Boolean(member?.user),user=member?.user||member;
  if(!snowflake(config.guild_id)||!snowflake(discordId)||user?.id!==discordId||user.bot)return false;
  const nickname=guildMember?name(member.nick):null,global=name(user.global_name),username=name(user.username);
  if(!nickname&&!global&&!username)return false;
  const at=stamp(),previous=!guildMember?await env.DB.prepare('SELECT nickname,observed_at,status FROM discord_profiles WHERE guild_id=? AND discord_id=?').bind(config.guild_id,discordId).first():null;
  const observed=!guildMember&&previous?.nickname?previous.observed_at:at,status=!guildMember&&previous?.nickname?previous.status:'observed';
  await env.DB.prepare(`INSERT INTO discord_profiles(guild_id,discord_id,nickname,global_name,username,observed_at,attempted_at,next_at,failures,status)
    VALUES(?,?,?,?,?,?,?,?,0,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET
    nickname=CASE WHEN ? THEN excluded.nickname ELSE discord_profiles.nickname END,
    global_name=excluded.global_name,username=excluded.username,observed_at=excluded.observed_at,attempted_at=excluded.attempted_at,
    next_at=excluded.next_at,failures=0,status=excluded.status`)
    .bind(config.guild_id,discordId,nickname,global,username,observed,at,epoch()+(guildMember?21600:60),status,guildMember?1:0).run();
  return true;
}

async function verifiedRows(env){
  return (await env.DB.prepare(`SELECT l.character_id,l.user_id,l.show_as_alt,u.main_character_id,u.ownership_checked,m.data roster,c.data details,
    d.discord_id,p.title,p.biography,p.looking_for,p.updated_at FROM character_links l JOIN users u ON u.id=l.user_id
    JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
    LEFT JOIN characters c ON c.id=m.character_id LEFT JOIN discord_links d ON d.user_id=l.user_id
    LEFT JOIN character_profiles p ON p.character_id=l.character_id AND p.user_id=l.user_id
    WHERE u.ownership_status='verified' ORDER BY m.slug`).all()).results;
}
export async function memberDirectory(env,user,directory=null,rolePreferences=null){
  rolePreferences??=await currentRolePreferences(env);
  const config=await discordConfig(env),[providers,manual,profiles]=await Promise.all([
    verifiedRows(env),activeManualMappings(env),env.DB.prepare('SELECT * FROM discord_profiles WHERE guild_id=?').bind(config.guild_id).all()
  ]);
  const cached=new Map(profiles.results.map(p=>[p.discord_id,p])),existing=new Map((directory||[]).map(c=>[c.id,c])),manualByCharacter=new Map(manual.map(m=>[m.character_id,m])),groups=new Map(),providerCharacters=new Set();
  // Directory grouping may describe an account's verified characters. It does not create notification or event authority for them.
  const providerUsers=new Set(providers.map(row=>row.user_id)),assignedAccounts=new Map();
  for(const row of manual)if(providerUsers.has(row.participant_user_id)&&snowflake(row.discord_id)){
    if(!assignedAccounts.has(row.participant_user_id))assignedAccounts.set(row.participant_user_id,new Set());assignedAccounts.get(row.participant_user_id).add(row.discord_id);
  }
  function add(key,did,character,association,participant){
    if(!groups.has(key))groups.set(key,{discord_id:did,characters:[],sources:new Set(),own:false});
    const group=groups.get(key);group.sources.add(association);group.own||=participant===user.id;
    if(!group.characters.some(c=>c.id===character.id))group.characters.push(withRolePreferences(character,rolePreferences));
  }
  for(const row of providers){
    const roster=JSON.parse(row.roster),details=row.details?JSON.parse(row.details):{},assigned=manualByCharacter.get(roster.id);
    const accountIds=assignedAccounts.get(row.user_id),accountDiscord=accountIds?.size===1?[...accountIds][0]:null;
    const personal=snowflake(row.discord_id)?row.discord_id:null,did=personal||(assigned?.participant_user_id===row.user_id&&snowflake(assigned.discord_id)?assigned.discord_id:null)||accountDiscord;
    const char={...mergeMember(roster,details),...existing.get(roster.id),is_main:row.main_character_id===roster.id,is_alt:Boolean(row.show_as_alt)&&row.main_character_id!==roster.id,
      title:row.title||'',biography:row.biography||'',looking_for:row.looking_for||'',own:row.user_id===user.id,association:'provider'};
    providerCharacters.add(roster.id);add(did?'discord:'+did:'account:'+row.user_id,did,char,personal?'provider':did?'admin':'provider',row.user_id);
  }
  for(const row of manual){
    if(providerCharacters.has(row.character_id)||!snowflake(row.discord_id))continue;
    const roster=JSON.parse(row.roster),details=row.details?JSON.parse(row.details):{};
    const char={...mergeMember(roster,details),is_main:false,is_alt:false,event_default:Boolean(row.preferred),own:row.participant_user_id===user.id,association:'admin',title:'',biography:'',looking_for:''};
    add('discord:'+row.discord_id,row.discord_id,char,'admin',row.participant_user_id);
  }
  const result=[];
  for(const [key,group]of groups){
    group.characters.sort((a,b)=>Number(b.is_main)-Number(a.is_main)||Number(Boolean(b.event_default))-Number(Boolean(a.event_default))||a.name.localeCompare(b.name));
    const profile=cached.get(group.discord_id),display=discordDisplayName(profile),linked=Boolean(group.discord_id),main=group.characters.find(c=>c.is_main)||group.characters[0];
    result.push({key:await digest('directory:'+key),display_name:linked?display||'Discord member · name unavailable':main.name,
      discord_linked:linked,name_status:linked?(display?(profile.status==='observed'&&profile.next_at>epoch()?'observed':'stale'):'unavailable'):'unlinked',
      name_observed_at:linked?profile?.observed_at||null:null,identity_source:linked?(group.sources.size>1?'mixed':group.sources.has('admin')?'admin':'provider'):'unlinked',
      own:group.own,characters:group.characters});
  }
  return result.sort((a,b)=>Number(b.own)-Number(a.own)||a.display_name.localeCompare(b.display_name));
}

export async function refreshOneDiscordProfile(env){
  if(!await discordReady(env))return {processed:false};
  const pause=await state(env,'discord_pause');if(pause?.until>epoch())return {processed:false,paused:true};
  const config=await discordConfig(env),[providers,manual,profiles]=await Promise.all([
    verifiedRows(env),activeManualMappings(env),env.DB.prepare('SELECT * FROM discord_profiles WHERE guild_id=? ORDER BY next_at,discord_id').bind(config.guild_id).all()
  ]);
  const ids=new Set([...providers.map(r=>r.discord_id),...manual.map(r=>r.discord_id)].filter(snowflake)),cached=new Map(profiles.results.map(r=>[r.discord_id,r]));
  const missing=[...ids].filter(id=>!cached.has(id)).slice(0,25);
  if(missing.length)await env.DB.batch(missing.map(id=>env.DB.prepare('INSERT OR IGNORE INTO discord_profiles(guild_id,discord_id) VALUES(?,?)').bind(config.guild_id,id)));
  const row=missing.length?{discord_id:missing[0],failures:0}:profiles.results.find(p=>ids.has(p.discord_id)&&p.next_at<=epoch());
  if(!row)return {processed:false};
  try{
    const member=await discordAPI(env,`/guilds/${config.guild_id}/members/${row.discord_id}`);
    if(!await cacheDiscordProfile(env,row.discord_id,member))throw Error('Discord identity or name was unavailable');
    return {processed:true,status:'observed'};
  }catch(error){
    const failures=(row.failures||0)+1,delay=error.status===429?Math.max(60,error.retry||60):[403,404].includes(error.status)?3600:Math.min(21600,300*2**Math.min(6,failures-1)),until=epoch()+delay;
    await env.DB.prepare(`UPDATE discord_profiles SET attempted_at=?,next_at=?,failures=?,status='unavailable' WHERE guild_id=? AND discord_id=?`)
      .bind(stamp(),until,failures,config.guild_id,row.discord_id).run();
    if(error.status===429)await env.DB.prepare(`INSERT INTO state(key,value) VALUES('discord_pause',?) ON CONFLICT(key) DO UPDATE SET value=json_object('until',MAX(COALESCE(json_extract(state.value,'$.until'),0),json_extract(excluded.value,'$.until')))`)
      .bind(JSON.stringify({until})).run();
    return {processed:true,status:'unavailable'};
  }
}
