import {currentUser,requireAdmin,requireWrite,bodyJSON,WebError,stamp,digest} from './auth.mjs';
import {discordAPI,discordConfig} from './discord.mjs';
import {cacheDiscordProfile} from './discord-people.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
export function discordId(value){const match=typeof value==='string'?value.trim().match(/^(?:(\d{15,22})|<@!?(\d{15,22})>)$/):null;if(!match)throw new WebError('Enter the Discord member’s user ID or mention');return match[1]||match[2];}
export async function activeManualMappings(env){
  const rows=await env.DB.prepare(`SELECT a.*,m.data roster,c.data details FROM admin_discord_mappings a JOIN verified_membership m ON m.character_id=a.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) LEFT JOIN characters c ON c.id=a.character_id
    WHERE NOT EXISTS(SELECT 1 FROM character_links l WHERE l.character_id=a.character_id AND l.user_id<>a.participant_user_id)
    AND NOT EXISTS(SELECT 1 FROM discord_links d WHERE d.discord_id=a.discord_id AND d.user_id<>a.participant_user_id)
    AND NOT EXISTS(SELECT 1 FROM discord_links d WHERE d.user_id=a.participant_user_id AND d.discord_id<>a.discord_id)`).all();return rows.results;
}
export async function mappingView(env){
  const config=await discordConfig(env);
  const rows=await env.DB.prepare(`SELECT a.*,json_extract(m.data,'$.name') name,l.user_id provider_owner,d.user_id discord_owner,du.discord_id participant_discord,o.discord_id opted_out,
    COALESCE(NULLIF(dp.nickname,''),NULLIF(dp.global_name,''),NULLIF(dp.username,'')) discord_name,dp.status discord_name_status,dp.observed_at discord_name_at,dp.next_at discord_name_next_at FROM admin_discord_mappings a
    LEFT JOIN verified_membership m ON m.character_id=a.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
    LEFT JOIN character_links l ON l.character_id=a.character_id LEFT JOIN discord_links d ON d.discord_id=a.discord_id
    LEFT JOIN discord_links du ON du.user_id=a.participant_user_id LEFT JOIN discord_crafter_optouts o ON o.discord_id=a.discord_id
    LEFT JOIN discord_profiles dp ON dp.discord_id=a.discord_id AND dp.guild_id=? ORDER BY a.updated_at DESC`).bind(config.guild_id).all();
  const chars=await env.DB.prepare('SELECT data FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1) ORDER BY slug').all();
  return {mappings:rows.results.map(r=>({character_id:r.character_id,name:r.name||'Former guild character',discord_id:r.discord_id,
    display_name:r.discord_name||'Discord member · name unavailable',name_status:r.discord_name?(r.discord_name_status==='observed'&&r.discord_name_next_at>epoch()?'observed':'stale'):'unavailable',name_observed_at:r.discord_name_at||null,
    preferred:Boolean(r.preferred),crafter_dm:Boolean(r.crafter_dm),updated_at:r.updated_at,
    conflict:!r.name?'Character is no longer in the guild':r.provider_owner&&r.provider_owner!==r.participant_user_id||r.discord_owner&&r.discord_owner!==r.participant_user_id||r.participant_discord&&r.participant_discord!==r.discord_id?'A verified account association conflicts with this manual mapping':r.opted_out?'Member’s personal DM opt-out takes precedence':''})),characters:chars.results.map(r=>{const c=JSON.parse(r.data);return {id:c.id,name:c.name};}),note:'Administrator mappings support bot notifications and party roles. Battle.net still controls website membership and character ownership. Personal notification choices take precedence.'};
}
export async function mappingRoute(request,env){
  const admin=await currentUser(request,env);requireAdmin(admin);if(request.method==='GET')return mappingView(env);requireWrite(request,admin);
  const body=await bodyJSON(request),cid=Number(body.character_id);if(!Number.isSafeInteger(cid)||cid<1)throw new WebError('Choose a guild character');
  const previous=await env.DB.prepare('SELECT * FROM admin_discord_mappings WHERE character_id=?').bind(cid).first();
  if(body.action==='remove'){
    if(!previous)throw new WebError('Mapping not found',404);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM admin_discord_mappings WHERE character_id=?').bind(cid),
      env.DB.prepare(`DELETE FROM event_signups WHERE character_id=? AND user_id=? AND source='discord' AND NOT EXISTS(SELECT 1 FROM character_links l JOIN discord_links d ON d.user_id=l.user_id WHERE l.character_id=? AND l.user_id=? AND d.discord_id=?)`).bind(cid,previous.participant_user_id,cid,previous.participant_user_id,previous.discord_id),
      env.DB.prepare('UPDATE discord_event_reactions SET handled=0 WHERE discord_id=?').bind(previous.discord_id),
      env.DB.prepare('INSERT INTO admin_mapping_audit VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),admin.id,cid,previous.discord_id,'removed',stamp())
    ]);return {message:'Manual Discord mapping removed',...await mappingView(env)};
  }
  if(body.action!=='save')throw new WebError('Choose save or remove');
  const roster=await env.DB.prepare('SELECT character_id FROM verified_membership WHERE character_id=? AND generation=(SELECT published FROM sync WHERE id=1)').bind(cid).first();if(!roster)throw new WebError('Choose a current guild character');
  const did=discordId(body.discord_id),config=await discordConfig(env);let member;
  try{member=await discordAPI(env,`/guilds/${config.guild_id}/members/${did}`);}catch{throw new WebError('That Discord member could not be verified in the guild server');}
  if(member.user?.id!==did||member.user.bot)throw new WebError('Choose a person who is a member of the guild Discord server');
  await cacheDiscordProfile(env,did,member);
  const owner=await env.DB.prepare('SELECT user_id FROM character_links WHERE character_id=?').bind(cid).first(),authorized=await env.DB.prepare('SELECT user_id FROM discord_links WHERE discord_id=?').bind(did).first();
  if(owner&&authorized&&owner.user_id!==authorized.user_id)throw new WebError('This Discord account and character are associated with different verified members',409);
  const existingActor=await env.DB.prepare('SELECT participant_user_id FROM admin_discord_mappings WHERE discord_id=? ORDER BY preferred DESC,updated_at LIMIT 1').bind(did).first();
  let uid=authorized?.user_id||owner?.user_id||existingActor?.participant_user_id;
  if(uid){const current=await env.DB.prepare('SELECT discord_id FROM discord_links WHERE user_id=?').bind(uid).first();if(current&&current.discord_id!==did)throw new WebError('This character’s verified account is authorised to a different Discord user',409);}
  else{const hash='admin:'+await digest('example-admin-discord|'+did),created=stamp();
    await env.DB.prepare("INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,'admin_mapped',0,?,?) ON CONFLICT(subject_hash) DO NOTHING").bind(crypto.randomUUID(),hash,cid,created,created).run();uid=(await env.DB.prepare('SELECT id FROM users WHERE subject_hash=?').bind(hash).first()).id;}
  const actors=await env.DB.prepare(`SELECT DISTINCT a.participant_user_id,u.ownership_status FROM admin_discord_mappings a JOIN users u ON u.id=a.participant_user_id WHERE a.discord_id=? AND a.participant_user_id<>?`).bind(did,uid).all();
  const actorMigrations=[];
  for(const actor of actors.results){
    const conflict=await env.DB.prepare(`SELECT a.character_id FROM admin_discord_mappings a JOIN character_links l ON l.character_id=a.character_id WHERE a.discord_id=? AND a.participant_user_id=? AND l.user_id<>? LIMIT 1`).bind(did,actor.participant_user_id,uid).first();
    if(actor.ownership_status!=='admin_mapped'||conflict)throw new WebError('This Discord account has conflicting participant assignments. Remove or correct those mappings first.',409);
    actorMigrations.push(
      env.DB.prepare(`DELETE FROM event_signups WHERE user_id=? AND source='discord' AND character_id IN (SELECT character_id FROM admin_discord_mappings WHERE discord_id=?) AND EXISTS(SELECT 1 FROM event_signups n WHERE n.event_id=event_signups.event_id AND n.user_id=?)`).bind(actor.participant_user_id,did,uid),
      env.DB.prepare(`UPDATE event_signups SET user_id=? WHERE user_id=? AND source='discord' AND character_id IN (SELECT character_id FROM admin_discord_mappings WHERE discord_id=?)`).bind(uid,actor.participant_user_id,did),
      env.DB.prepare(`UPDATE admin_discord_mappings SET participant_user_id=? WHERE discord_id=? AND participant_user_id=?`).bind(uid,did,actor.participant_user_id),
      env.DB.prepare(`UPDATE discord_event_reactions SET user_id=?,handled=CASE WHEN EXISTS(SELECT 1 FROM event_signups s WHERE s.event_id=discord_event_reactions.event_id AND s.user_id=? AND s.source='web') THEN 1 ELSE 0 END,result=CASE WHEN EXISTS(SELECT 1 FROM event_signups s WHERE s.event_id=discord_event_reactions.event_id AND s.user_id=? AND s.source='web') THEN 'confirmed' ELSE result END WHERE discord_id=? AND user_id=?`).bind(uid,uid,uid,did,actor.participant_user_id)
    );
  }
  const other=await env.DB.prepare('SELECT character_id FROM admin_discord_mappings WHERE participant_user_id=? AND discord_id<>? AND character_id<>? LIMIT 1').bind(uid,did,cid).first();if(other)throw new WebError('This member already has a manual mapping to another Discord account',409);
  const preferred=body.preferred===true,dm=body.crafter_dm===true,statements=[...actorMigrations];
  if(previous&&previous.discord_id!==did){statements.push(env.DB.prepare("DELETE FROM event_signups WHERE character_id=? AND user_id=? AND source='discord'").bind(cid,previous.participant_user_id));statements.push(env.DB.prepare('UPDATE discord_event_reactions SET handled=0 WHERE discord_id=?').bind(previous.discord_id));}
  if(preferred)statements.push(env.DB.prepare('UPDATE admin_discord_mappings SET preferred=0 WHERE discord_id=?').bind(did));
  statements.push(env.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET discord_id=excluded.discord_id,participant_user_id=excluded.participant_user_id,preferred=excluded.preferred,crafter_dm=excluded.crafter_dm,mapped_by=excluded.mapped_by,updated_at=excluded.updated_at').bind(cid,did,uid,preferred?1:0,dm?1:0,admin.id,stamp()));
  statements.push(env.DB.prepare("UPDATE discord_event_reactions SET handled=CASE WHEN EXISTS(SELECT 1 FROM event_signups s WHERE s.event_id=discord_event_reactions.event_id AND s.user_id=discord_event_reactions.user_id AND s.source='web') THEN 1 ELSE 0 END WHERE discord_id=?").bind(did));
  statements.push(env.DB.prepare('INSERT INTO admin_mapping_audit VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),admin.id,cid,did,previous?'updated':'created',stamp()));
  await env.DB.batch(statements);return {message:'Manual Discord mapping saved',...await mappingView(env)};
}
export async function adoptOwnedManualMappings(env,discordUserId,userId){
  // Discord control does not prove ownership of every manual character. Only provider-owned rows transfer.
  const owned=`SELECT a.character_id,a.participant_user_id FROM admin_discord_mappings a JOIN character_links l ON l.character_id=a.character_id AND l.user_id=? WHERE a.discord_id=? AND a.participant_user_id<>?`;
  const args=[userId,discordUserId,userId];
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM event_signups WHERE source='discord' AND user_id<>? AND EXISTS(SELECT 1 FROM admin_discord_mappings a WHERE a.character_id=event_signups.character_id AND a.participant_user_id=event_signups.user_id AND a.discord_id=?) AND EXISTS(SELECT 1 FROM event_signups n WHERE n.event_id=event_signups.event_id AND n.user_id=? AND n.source='web')`).bind(userId,discordUserId,userId),
    env.DB.prepare(`UPDATE discord_event_reactions SET user_id=?,handled=1,result='confirmed' WHERE discord_id=? AND EXISTS(SELECT 1 FROM event_signups n WHERE n.event_id=discord_event_reactions.event_id AND n.user_id=? AND n.source='web')`).bind(userId,discordUserId,userId),
    env.DB.prepare(`WITH owned AS (${owned}) UPDATE discord_event_reactions SET user_id=?,handled=0 WHERE discord_id=? AND EXISTS(SELECT 1 FROM event_signups s JOIN owned o ON o.character_id=s.character_id AND o.participant_user_id=s.user_id WHERE s.event_id=discord_event_reactions.event_id AND s.user_id=discord_event_reactions.user_id AND s.source='discord')`).bind(...args,userId,discordUserId),
    env.DB.prepare(`WITH owned AS (${owned}) DELETE FROM event_signups WHERE source='discord' AND (character_id,user_id) IN (SELECT character_id,participant_user_id FROM owned) AND EXISTS(SELECT 1 FROM event_signups n WHERE n.event_id=event_signups.event_id AND n.user_id=?)`).bind(...args,userId),
    env.DB.prepare(`WITH owned AS (${owned}) DELETE FROM event_signups WHERE source='discord' AND (character_id,user_id) IN (SELECT character_id,participant_user_id FROM owned) AND rowid NOT IN (SELECT MIN(s.rowid) FROM event_signups s JOIN owned o ON o.character_id=s.character_id AND o.participant_user_id=s.user_id WHERE s.source='discord' GROUP BY s.event_id)`).bind(...args),
    env.DB.prepare(`WITH owned AS (${owned}) UPDATE event_signups SET user_id=? WHERE source='discord' AND (character_id,user_id) IN (SELECT character_id,participant_user_id FROM owned)`).bind(...args,userId),
    env.DB.prepare('UPDATE admin_discord_mappings SET participant_user_id=?,updated_at=? WHERE discord_id=? AND EXISTS(SELECT 1 FROM character_links l WHERE l.character_id=admin_discord_mappings.character_id AND l.user_id=?)').bind(userId,stamp(),discordUserId,userId)
  ]);
}

export async function notificationCrafters(env,recipeId){
  const rows=await env.DB.prepare(`SELECT l.user_id,d.discord_id,c.id character_id,c.data FROM character_links l JOIN characters c ON c.id=l.character_id JOIN verified_membership m ON m.character_id=c.id AND m.generation=(SELECT published FROM sync WHERE id=1) JOIN users u ON u.id=l.user_id JOIN discord_links d ON d.user_id=l.user_id WHERE d.crafter_dm=1 AND u.ownership_status='verified' AND u.ownership_checked>? AND NOT EXISTS(SELECT 1 FROM discord_crafter_optouts o WHERE o.discord_id=d.discord_id)`).bind(epoch()-86400).all();
  const result=[];const knows=data=>data.professions_status==='verified'&&(data.professions||[]).some(p=>(p.recipes||[]).some(r=>r.id===recipeId));
  for(const row of rows.results)if(knows(JSON.parse(row.data)))result.push({user_id:row.user_id,discord_id:row.discord_id,character_id:row.character_id});
  const manual=await activeManualMappings(env),optouts=new Set((await env.DB.prepare('SELECT discord_id FROM discord_crafter_optouts').all()).results.map(r=>r.discord_id)),personal=new Map((await env.DB.prepare('SELECT user_id,discord_id,crafter_dm FROM discord_links').all()).results.map(r=>[r.discord_id,r]));
  for(const row of manual)if(row.crafter_dm&&!optouts.has(row.discord_id)&&!personal.has(row.discord_id)&&row.details&&knows(JSON.parse(row.details)))result.push({user_id:row.participant_user_id,discord_id:row.discord_id,character_id:row.character_id});
  return result;
}
