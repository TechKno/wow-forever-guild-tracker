import {GUILD,RULESET_LABEL,CONFIG} from './config.mjs';
import {currentUser,requireMember,requireAdmin,requireWrite,bodyJSON,WebError,ORIGIN,LEGACY_ORIGIN,isSiteOrigin,random,digest,stamp} from './auth.mjs';
import {publishEventPost,eventChannelCheck,deleteEventDiscord,trackerMarker,discordField,scheduledEventDescription,eventSignups} from './event-posts.mjs';
import {eventInactive,eventTargetStatement,eventCleanupStatement} from './events.mjs';
import {notificationCrafters,adoptOwnedManualMappings} from './admin-mappings.mjs';
import {state} from './logic.mjs';
import {cacheDiscordProfile} from './discord-people.mjs';
import {craftPostStatement,craftCleanupStatement,craftTargetStatement,publishCraftPost,deleteCraftPost,craftChannelCheck} from './craft-posts.mjs';
const API='https://discord.com/api/v10';
const epoch=()=>Math.floor(Date.now()/1000);
const snowflake=v=>typeof v==='string'&&/^\d{15,22}$/.test(v);
export async function discordConfig(env){const saved=await state(env,'discord_config')||{};return {client_id:env.DISCORD_CLIENT_ID||saved.client_id||'',guild_id:env.DISCORD_GUILD_ID||saved.guild_id||'',events_channel_id:env.DISCORD_EVENTS_CHANNEL_ID||saved.events_channel_id||'',craft_requests_channel_id:env.DISCORD_CRAFT_REQUESTS_CHANNEL_ID||saved.craft_requests_channel_id||''};}
export async function discordReady(env){const c=await discordConfig(env);return snowflake(c.client_id)&&snowflake(c.guild_id)&&Boolean(env.DISCORD_CLIENT_SECRET&&env.DISCORD_BOT_TOKEN);}
export async function discordView(env,user){
  const link=await env.DB.prepare('SELECT requester_dm,crafter_dm FROM discord_links WHERE user_id=?').bind(user.id).first();
  return {configured:await discordReady(env),linked:Boolean(link),requester_dm:Boolean(link?.requester_dm),crafter_dm:Boolean(link?.crafter_dm)};
}
export async function verifyDiscord(env){
  const config=await discordConfig(env),result={checked_at:stamp(),bot_verified:false,installed:false};
  try{const app=await discordAPI(env,'/applications/@me');if(app.id!==config.client_id){result.error='Bot token belongs to a different application';return result;}result.bot_verified=true;result.application_name=app.name;
    try{const guild=await discordAPI(env,'/guilds/'+config.guild_id);result.installed=guild.id===config.guild_id;if(result.installed)result.server_name=guild.name;}catch{result.error='Bot is not installed in this server, or Discord refused access';}
  }catch{result.error='Bot token could not be verified with Discord';}
  if(config.events_channel_id){try{result.event_channel=await eventChannelCheck(env);}catch{result.event_channel={configured:true,missing:['Channel permissions could not be checked']};}}
  if(config.craft_requests_channel_id){try{result.craft_channel=await craftChannelCheck(env);}catch{result.craft_channel={configured:true,missing:['Channel permissions could not be checked']};}}
  return result;
}
export async function discordAdmin(request,env){
  const user=await currentUser(request,env);requireAdmin(user);
  const origin=new URL(request.url).origin;if(!isSiteOrigin(origin))throw new WebError('Use the live guild dashboard to configure Discord',400);
  let verification=null;if(request.method==='POST'){
    requireWrite(request,user);const data=await bodyJSON(request);
    if(data.check===true)verification=await verifyDiscord(env);else{
    if(!snowflake(data.client_id)||!snowflake(data.guild_id))throw new WebError('Enter the Discord application ID and server ID');
    const previous=await discordConfig(env),channel=data.events_channel_id??(previous.guild_id===data.guild_id?previous.events_channel_id:''),craftChannel=data.craft_requests_channel_id??(previous.guild_id===data.guild_id?previous.craft_requests_channel_id:'');
    for(const [value,label]of [[channel,'events'],[craftChannel,'craft requests']])if(value){if(!snowflake(value))throw new WebError('Enter a valid '+label+' channel ID');const target=await discordAPI(env,'/channels/'+value);if(target.guild_id!==data.guild_id||![0,5].includes(target.type))throw new WebError('Choose a text channel in this Discord server');}
    await env.DB.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('discord_config',?)").bind(JSON.stringify({client_id:data.client_id,guild_id:data.guild_id,events_channel_id:channel,craft_requests_channel_id:craftChannel})).run();
    }
  }
  const c=await discordConfig(env),counts=await env.DB.prepare('SELECT status,COUNT(*) count FROM discord_outbox GROUP BY status').all();
  return {...c,verification,configured:await discordReady(env),client_secret_set:Boolean(env.DISCORD_CLIENT_SECRET),bot_token_set:Boolean(env.DISCORD_BOT_TOKEN),callback:origin+'/auth/discord/callback',
    invite_url:await discordReady(env)?origin+'/auth/discord/install':null,
    queue:counts.results};
}
function redirect(path){return new Response(null,{status:303,headers:{Location:path,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
async function provider(url,options){
  const response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();throw new Error('Discord authorization failed');}
  const raw=await response.text();if(raw.length>100000)throw new Error('Discord response too large');return JSON.parse(raw);
}
export async function discordAuth(request,env){
  const url=new URL(request.url),user=await currentUser(request,env);
  if(['/auth/discord/login','/auth/discord/install'].includes(url.pathname)&&request.method==='GET'){
    if(!isSiteOrigin(url.origin))throw new WebError('Use the live guild dashboard to connect Discord',400);
    const install=url.pathname==='/auth/discord/install';requireMember(user);if(install)requireAdmin(user);if(!await discordReady(env))throw new WebError('The administrator has not connected the Discord bot yet',503);
    const token=random(),verifier=random(),config=await discordConfig(env);
    await env.DB.prepare('INSERT INTO discord_states(state_hash,user_id,session_hash,expires,verifier,purpose,origin) VALUES(?,?,?,?,?,?,?)').bind(await digest(token),user.id,user.token_hash,epoch()+600,verifier,install?'install':'link',url.origin).run();
    const params=new URLSearchParams({response_type:'code',client_id:config.client_id,redirect_uri:url.origin+'/auth/discord/callback',scope:install?'bot identify':'identify',state:token,prompt:'consent',code_challenge:await digest(verifier),code_challenge_method:'S256'});
    if(install){params.set('permissions','17592186044416');params.set('guild_id',config.guild_id);params.set('disable_guild_select','true');}
    return redirect('https://discord.com/oauth2/authorize?'+params);
  }
  if(url.pathname==='/auth/discord/callback'&&request.method==='GET'){
    if(!isSiteOrigin(url.origin))return redirect('/guild?discord=failed#members');
    if(!user||!user.verified)return redirect('/guild?discord=signin#members');
    const token=url.searchParams.get('state')||'';if(!/^[A-Za-z0-9_-]{43}$/.test(token))return redirect('/guild?discord=failed#members');
    const pending=await env.DB.prepare('DELETE FROM discord_states WHERE state_hash=? AND user_id=? AND session_hash=? AND expires>? AND COALESCE(origin,?)=? RETURNING *').bind(await digest(token),user.id,user.token_hash,epoch(),LEGACY_ORIGIN,url.origin).first();
    if(!pending||url.searchParams.has('error'))return redirect('/guild?discord=failed#members');
    const code=url.searchParams.get('code');if(!code||code.length>2048)return redirect('/guild?discord=failed#members');
    try{
      const config=await discordConfig(env),token=await provider(API+'/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.client_id,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:(pending.origin||LEGACY_ORIGIN)+'/auth/discord/callback',code_verifier:pending.verifier})});
      if(typeof token.access_token!=='string')throw 0;
      if(pending.purpose==='install'){
        requireAdmin(user);if(token.guild&&token.guild.id!==config.guild_id)throw 0;
        const guild=await discordAPI(env,'/guilds/'+config.guild_id);if(guild.id!==config.guild_id)throw 0;
        return redirect('/guild?discord=installed#status');
      }
      const info=await provider(API+'/users/@me',{headers:{Authorization:'Bearer '+token.access_token}});if(!snowflake(info.id)||info.bot)throw 0;
      const existing=await env.DB.prepare('SELECT user_id FROM discord_links WHERE discord_id=?').bind(info.id).first();if(existing&&existing.user_id!==user.id)return redirect('/guild?discord=in_use#members');
      await env.DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET discord_id=excluded.discord_id,requester_dm=CASE WHEN discord_links.discord_id=excluded.discord_id THEN discord_links.requester_dm ELSE 0 END,crafter_dm=CASE WHEN discord_links.discord_id=excluded.discord_id THEN discord_links.crafter_dm ELSE 0 END,linked_at=excluded.linked_at').bind(user.id,info.id,stamp()).run();
      await adoptOwnedManualMappings(env,info.id,user.id);
      await cacheDiscordProfile(env,info.id,info);
      return redirect('/guild?discord=linked#members');
    }catch{return redirect('/guild?discord=failed#members');}
  }
  return null;
}
export async function discordPreferences(request,env){
  const user=await currentUser(request,env);requireMember(user);requireWrite(request,user);const body=await bodyJSON(request);
  if(body.unlink===true){const link=await env.DB.prepare('SELECT discord_id FROM discord_links WHERE user_id=?').bind(user.id).first();const statements=[];if(link)statements.push(env.DB.prepare('INSERT OR REPLACE INTO discord_crafter_optouts VALUES(?,?)').bind(link.discord_id,stamp()));await env.DB.batch([...statements,env.DB.prepare('DELETE FROM discord_links WHERE user_id=?').bind(user.id),env.DB.prepare("UPDATE discord_outbox SET status='skipped',last_error='Account unlinked' WHERE user_id=? AND status='pending'").bind(user.id)]);return {message:'Discord unlinked. Queued DMs will be skipped.'};}
  if(typeof body.requester_dm!=='boolean'||typeof body.crafter_dm!=='boolean')throw new WebError('Choose your notification preferences');
  const link=await env.DB.prepare('SELECT user_id,discord_id FROM discord_links WHERE user_id=?').bind(user.id).first();if(!link)throw new WebError('Link your Discord account first');
  await env.DB.batch([env.DB.prepare('UPDATE discord_links SET requester_dm=?,crafter_dm=? WHERE user_id=?').bind(body.requester_dm?1:0,body.crafter_dm?1:0,user.id),body.crafter_dm?env.DB.prepare('DELETE FROM discord_crafter_optouts WHERE discord_id=?').bind(link.discord_id):env.DB.prepare('INSERT OR REPLACE INTO discord_crafter_optouts VALUES(?,?)').bind(link.discord_id,stamp())]);return {message:'Discord notification preferences saved'};
}
export function outboxStatement(env,id,kind,reference,user,payload,change=null){
  const table=kind==='dm'?'requests':['event','event_post'].includes(kind)?'events':null;
  const guard=change?' WHERE EXISTS(SELECT 1 FROM requests WHERE id=? AND change_id=?)':table?' WHERE EXISTS(SELECT 1 FROM '+table+' WHERE id=?)':'';
  const sql='INSERT OR IGNORE INTO discord_outbox(id,kind,reference_id,user_id,payload,created_at) SELECT ?,?,?,?,?,?'+guard;
  return env.DB.prepare(sql).bind(id,kind,reference,user,JSON.stringify(payload),stamp(),...(change?[reference,change]:table?[reference]:[]));
}
export async function requestNotifications(env,row,action){
  if(row.kind!=='craft')return [];
  const statements=[],config=await discordConfig(env);
  if(['complete','cancel'].includes(action))statements.push(craftCleanupStatement(env,row.id,row.change_id||null));
  const ready=await discordReady(env),selected=row.recipient_mode==='selected'?new Set(row.target_character_ids||[]):null;
  const candidates=action==='created'&&row.recipe_id&&ready?await notificationCrafters(env,row.recipe_id):[];
  if(action==='created'&&snowflake(config.craft_requests_channel_id)){
    statements.push(craftTargetStatement(env,row.id,config));
    const fallback=!selected||!selected.size||[...selected].some(cid=>!candidates.some(candidate=>candidate.character_id===cid));
    if(fallback)statements.push(craftPostStatement(env,row.id,!selected?.size?'No specific crafter selected':'A selected crafter cannot receive DMs',row.change_id||null));
  }
  if(['claim','release'].includes(action))statements.push(env.DB.prepare(`UPDATE discord_outbox SET status='pending',next_at=0,lease_until=0 WHERE id=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND change_id=?)`).bind('craft-post:'+row.id,row.id,row.change_id||''));
  if(!ready)return statements;
  const recipients=new Map([['owner:'+row.owner_id,{uid:row.owner_id,preference:'requester'}]]);
  if(action==='created'&&row.recipe_id){
    for(const r of candidates)if(r.user_id!==row.owner_id&&(!selected||selected.has(r.character_id)))recipients.set('discord:'+r.discord_id,{uid:r.user_id,preference:'crafter',expected_discord_id:r.discord_id});
  }
  statements.push(...[...recipients.values()].map(({uid,preference,expected_discord_id})=>outboxStatement(env,`request:${row.id}:${action}:${row.updated_at}:${uid}:${expected_discord_id||'owner'}`,'dm',row.id,uid,{preference,expected_discord_id,action,item:row.item_name,crafts:row.quantity},row.change_id||null)));
  return statements;
}

export class DeliveryError extends Error{constructor(message,status=0,retry=0){super(message);this.status=status;this.retry=retry;}}
export async function discordAPI(env,path,method='GET',body){
  let response;try{response=await fetch(API+path,{method,headers:{Authorization:'Bot '+env.DISCORD_BOT_TOKEN,'Content-Type':'application/json','User-Agent':'WoWForeverGuildTracker ('+ORIGIN+', 3.0)'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw new DeliveryError('Discord could not be reached');}
  const raw=await response.text();let data={};try{data=JSON.parse(raw);}catch{}
  if(!response.ok)throw new DeliveryError(response.status===403?'Discord refused the message or event; check DMs and bot permissions':`Discord returned HTTP ${response.status}`,response.status,Math.max(1,Number(data.retry_after)||60));
  return data;
}
export function dungeonPayload(event,signups=[]){
  const plain=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,100);
  return {name:plain(event.title),privacy_level:2,entity_type:3,entity_metadata:{location:plain(event.location)||'World of Warcraft Forever · '+RULESET_LABEL},scheduled_start_time:event.starts_at,scheduled_end_time:new Date(Date.parse(event.starts_at)+(event.duration_minutes||120)*60000).toISOString(),description:scheduledEventDescription(event,signups)};
}
async function craftFallback(env,job,reason){
  if(job.kind!=='dm'||JSON.parse(job.payload).preference!=='crafter')return false;
  const config=await discordConfig(env);if(!snowflake(config.craft_requests_channel_id))return false;
  const row=await env.DB.prepare("SELECT id FROM requests WHERE id=? AND kind='craft' AND status IN ('open','claimed')").bind(job.reference_id).first();if(!row)return false;
  await craftPostStatement(env,row.id,reason).run();return true;
}
async function deliver(env,job){
  if(job.kind==='craft_cleanup')return deleteCraftPost(env,job.reference_id);
  if(job.kind==='craft_post')return publishCraftPost(env,job.reference_id);
  if(job.kind==='event_cleanup')return deleteEventDiscord(env,job.reference_id);
  if(job.kind==='event_post')return publishEventPost(env,job.reference_id);
  const config=await discordConfig(env),payload=JSON.parse(job.payload);
  if(job.kind==='dm'){
    const row=await env.DB.prepare("SELECT r.*,json_extract(m.data,'$.name') character_name FROM requests r LEFT JOIN verified_membership m ON m.character_id=r.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE r.id=?").bind(job.reference_id).first();if(!row||row.kind!=='craft'||payload.preference==='crafter'&&row.status!=='open'||payload.action==='created'&&!['open','claimed'].includes(row.status)||payload.action==='complete'&&row.status!=='complete'||payload.action==='cancel'&&row.status!=='cancelled'||payload.action==='claim'&&row.status!=='claimed'||payload.action==='release'&&row.status!=='open')return 'skipped';
    let did;
    if(payload.preference==='crafter'){
      const targets=row.recipient_mode==='selected'?new Set((await env.DB.prepare('SELECT character_id FROM request_targets WHERE request_id=?').bind(job.reference_id).all()).results.map(r=>r.character_id)):null;
      const candidate=(await notificationCrafters(env,row.recipe_id)).find(r=>r.user_id===job.user_id&&(!payload.expected_discord_id||r.discord_id===payload.expected_discord_id)&&(!targets||targets.has(r.character_id)));
      if(!candidate)return await craftFallback(env,job,'A selected crafter cannot receive DMs')?'fell_back':'skipped';did=candidate.discord_id;
    }else{
      const link=await env.DB.prepare(`SELECT d.* FROM discord_links d JOIN users u ON u.id=d.user_id WHERE d.user_id=? AND u.ownership_status='verified' AND u.ownership_checked>? AND EXISTS(SELECT 1 FROM character_links l JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE l.user_id=d.user_id)`).bind(job.user_id,epoch()-86400).first();
      if(!link||!link.requester_dm)return 'skipped';did=link.discord_id;
    }
    const channel=await discordAPI(env,'/users/@me/channels','POST',{recipient_id:did});if(!snowflake(channel.id))throw new DeliveryError('Discord did not return a DM channel');
    const nonce=(await digest(job.id)).slice(0,25);
    await discordAPI(env,'/channels/'+channel.id+'/messages','POST',{content:`${GUILD} · ${payload.preference==='crafter'?'A guild member needs a recipe you know':payload.action==='created'?'Your crafting request was posted':'Your crafting request was updated ('+payload.action+')'}\n${discordField(payload.item,160)} · ${payload.crafts} craft(s)\nSend completed item to: ${discordField(row.character_name||row.recipient_name||'the requester’s selected character',240)}\n${ORIGIN}/guild#crafting`,allowed_mentions:{parse:[]},nonce,enforce_nonce:true});return 'sent';
  }
  const event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(job.reference_id).first();if(!event||!['Dungeon','Raid'].includes(event.kind))return 'skipped';
  if(eventInactive(event)){await eventCleanupStatement(env,event.id).run();return 'skipped';}
  await eventTargetStatement(env,event.id,config).run();
  const target=await state(env,'discord_event_target:'+event.id);
  if(target.guild_id!==config.guild_id||target.application_id!==config.client_id)throw new DeliveryError('Event needs its original Discord server and bot configuration',409);
  const path='/guilds/'+config.guild_id+'/scheduled-events';let mapping=await env.DB.prepare('SELECT discord_id FROM discord_events WHERE event_id=?').bind(event.id).first();
  if(!mapping){
    // Reconcile an earlier timeout/crash before retrying a create; Discord events lack an idempotency key.
    const list=await discordAPI(env,path);if(!Array.isArray(list))throw new DeliveryError('Discord did not return an event list');
    const matches=list.filter(e=>e.guild_id===config.guild_id&&e.creator_id===config.client_id&&trackerMarker(e.description,event.id));
    if(matches.length>1)throw new DeliveryError('Multiple matching scheduled events require administrator review',409);
    const found=matches[0];
    if(found){mapping={discord_id:found.id};await env.DB.prepare('INSERT OR REPLACE INTO discord_events(event_id,discord_id) VALUES(?,?)').bind(event.id,found.id).run();}
  }
  if(eventInactive(await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(event.id).first())){await eventCleanupStatement(env,event.id).run();return 'skipped';}
  if(mapping)return 'sent';if(Date.parse(event.starts_at)<Date.now()+10000)return 'skipped';
  const created=await discordAPI(env,path,'POST',dungeonPayload(event,await eventSignups(env,event.id)));if(!snowflake(created.id))throw new DeliveryError('Discord did not return an event ID');
  await env.DB.prepare('INSERT OR REPLACE INTO discord_events(event_id,discord_id) VALUES(?,?)').bind(event.id,created.id).run();
  if(eventInactive(await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(event.id).first()))await eventCleanupStatement(env,event.id).run();
  return 'sent';
}
async function flushJobs(env){
  if(!await discordReady(env))return;
  const pause=await state(env,'discord_pause');if(pause?.until>epoch())return;
  // One minute lease is longer than the two bounded HTTP calls. Each cron handles at most three jobs.
  for(let n=0;n<3;n++){
    const now=epoch(),job=await env.DB.prepare(`UPDATE discord_outbox SET lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM discord_outbox WHERE status='pending' AND next_at<=? AND lease_until<? ORDER BY CASE WHEN kind IN ('event_cleanup','craft_cleanup') THEN 0 ELSE 1 END,created_at LIMIT 1) AND lease_until<? RETURNING *`).bind(now+120,now,now,now).first();if(!job)return;
    try{const result=await deliver(env,job);await env.DB.prepare('UPDATE discord_outbox SET status=?,lease_until=0,last_error=NULL WHERE id=?').bind(result,job.id).run();if(['event_cleanup','craft_cleanup'].includes(job.kind))return;}
    catch(error){
      const permanent=[400,401,403,404].includes(error.status),rateLimited=error.status===429;
      const fallback=!rateLimited&&(permanent||job.attempts>=5)&&await craftFallback(env,job,'A selected crafter’s DM could not be delivered');
      const durable=['event_cleanup','craft_cleanup'].includes(job.kind)||job.kind==='craft_post'&&error.status===409;
      const status=fallback?'fell_back':rateLimited||durable?'pending':permanent||job.attempts>=5?'failed':'pending',retry=rateLimited?error.retry:Math.min(3600,60*2**Math.min(job.attempts,6));
      await env.DB.prepare('UPDATE discord_outbox SET status=?,lease_until=0,next_at=?,last_error=?,attempts=CASE WHEN ? THEN MAX(0,attempts-1) ELSE attempts END WHERE id=?').bind(status,epoch()+retry,error instanceof DeliveryError?error.message:'Delivery could not complete',rateLimited?1:0,job.id).run();
      if(error.status===429)await env.DB.prepare("INSERT OR REPLACE INTO state VALUES('discord_pause',?)").bind(JSON.stringify({until:epoch()+retry})).run();return;
    }
  }
}

export async function flushDiscord(env){
  if(!await discordReady(env))return;
  const owner=random(),lease=JSON.stringify({owner,until:epoch()+180});
  const acquired=await env.DB.prepare("INSERT INTO state(key,value) VALUES('discord_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(state.value,'$.until') AS INTEGER)<? RETURNING value").bind(lease,epoch()).first();
  if(!acquired)return;try{await flushJobs(env);}finally{await env.DB.prepare("DELETE FROM state WHERE key='discord_lease' AND value=?").bind(lease).run();}
}
