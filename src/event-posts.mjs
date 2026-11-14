import {eventGuideLines} from './event-templates.mjs';
import {CONFIG} from './config.mjs';
import {discordAPI,discordConfig,DeliveryError} from './discord.mjs';
import {ORIGIN,digest} from './auth.mjs';
import {activeManualMappings} from './admin-mappings.mjs';
import {signupStatement,roleLimits,eventInactive,eventTargetStatement,eventCleanupStatement} from './events.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
const snowflake=v=>typeof v==='string'&&/^\d{15,22}$/.test(v);
export const discordField=(value,max=120)=>Array.from(String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\`*_~>|\[\]\(\)]/g,'\\$&')).slice(0,max).join('');
const safe=value=>discordField(value);
export const trackerMarker=(text,id)=>typeof text==='string'&&text.trimEnd().split('\n').at(-1)==='Tracker event: '+id;
async function eventTarget(env,id,config,channel=config.events_channel_id||''){
  await eventTargetStatement(env,id,config,channel).run();
  const row=await env.DB.prepare('SELECT value FROM state WHERE key=?').bind('discord_event_target:'+id).first();
  const target=JSON.parse(row.value);
  if(!snowflake(target.guild_id)||!snowflake(target.application_id)||target.guild_id!==config.guild_id||target.application_id!==config.client_id)throw new DeliveryError('Event cleanup needs its original Discord server and bot configuration',409);
  return target;
}
export async function queueEventCleanups(env){
  const config=await discordConfig(env);
  if(snowflake(config.guild_id)&&snowflake(config.client_id))await env.DB.prepare(`INSERT OR IGNORE INTO state(key,value)
    SELECT 'discord_event_target:'||e.id,json_object('guild_id',?,'application_id',?,'channel_id',COALESCE(p.channel_id,?)) FROM events e
    LEFT JOIN discord_event_posts p ON p.event_id=e.id WHERE EXISTS(SELECT 1 FROM discord_events d WHERE d.event_id=e.id)
    OR p.event_id IS NOT NULL OR EXISTS(SELECT 1 FROM discord_outbox o WHERE o.reference_id=e.id AND o.kind IN ('event','event_post'))`)
    .bind(config.guild_id,config.client_id,config.events_channel_id||'').run();
  const due=await env.DB.prepare(`SELECT e.id FROM events e WHERE (e.status<>'open' OR datetime(e.starts_at,'+'||e.duration_minutes||' minutes')<=datetime('now'))
    AND NOT EXISTS(SELECT 1 FROM discord_outbox c WHERE c.id='event-cleanup:'||e.id AND c.status='pending')
    AND (EXISTS(SELECT 1 FROM discord_events d WHERE d.event_id=e.id) OR EXISTS(SELECT 1 FROM discord_event_posts p WHERE p.event_id=e.id)
    OR EXISTS(SELECT 1 FROM discord_outbox o WHERE o.reference_id=e.id AND o.kind IN ('event','event_post') AND
      (o.status='pending' OR (o.attempts>0 AND NOT EXISTS(SELECT 1 FROM discord_outbox c WHERE c.id='event-cleanup:'||e.id AND c.status='sent'))))) ORDER BY e.starts_at LIMIT 5`).all();
  if(due.results.length)await env.DB.batch(due.results.map(event=>eventCleanupStatement(env,event.id)));
  return {queued:due.results.length};
}
export async function deleteEventDiscord(env,id){
  const event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(id).first();
  if(event&&!eventInactive(event))return 'skipped';
  const config=await discordConfig(env);
  let post=await env.DB.prepare('SELECT * FROM discord_event_posts WHERE event_id=?').bind(id).first();
  let scheduled=await env.DB.prepare('SELECT discord_id FROM discord_events WHERE event_id=?').bind(id).first();
  const attempted=(await env.DB.prepare("SELECT DISTINCT kind FROM discord_outbox WHERE reference_id=? AND kind IN ('event','event_post') AND attempts>0").bind(id).all()).results;
  if(!post&&!scheduled&&!attempted.length)return 'sent';
  const target=await eventTarget(env,id,config,post?.channel_id||config.events_channel_id||'');
  // Reconcile a create accepted by Discord before a response/DB-write failure. Only exact tracker markers made by this bot qualify.
  if(!scheduled&&attempted.some(job=>job.kind==='event')){
    let list;try{list=await discordAPI(env,'/guilds/'+target.guild_id+'/scheduled-events');}catch(error){if(error.status!==404)throw error;list=[];}
    if(!Array.isArray(list))throw new DeliveryError('Discord did not return an event list');
    const matches=list.filter(value=>snowflake(value.id)&&value.guild_id===target.guild_id&&value.creator_id===target.application_id&&trackerMarker(value.description,id));
    if(matches.length>1)throw new DeliveryError('Multiple matching scheduled events require administrator review',409);
    const found=matches[0];
    if(found){scheduled={discord_id:found.id};await env.DB.prepare('INSERT OR REPLACE INTO discord_events(event_id,discord_id) VALUES(?,?)').bind(id,found.id).run();}
  }
  if(!post&&snowflake(target.channel_id)&&attempted.some(job=>job.kind==='event_post')){
    let messages;try{messages=await discordAPI(env,'/channels/'+target.channel_id+'/messages?limit=100');}catch(error){if(error.status!==404)throw error;messages=[];}
    if(!Array.isArray(messages))throw new DeliveryError('Discord did not return an announcement list');
    const matches=messages.filter(value=>snowflake(value.id)&&value.channel_id===target.channel_id&&value.author?.id===target.application_id&&trackerMarker(value.content,id));
    if(matches.length>1)throw new DeliveryError('Multiple matching announcements require administrator review',409);
    const found=matches[0];
    if(found){post={channel_id:target.channel_id,message_id:found.id};await env.DB.prepare('INSERT INTO discord_event_posts(event_id,channel_id,message_id) VALUES(?,?,?)').bind(id,post.channel_id,post.message_id).run();}
  }
  if(post){
    if(!snowflake(post.channel_id)||!snowflake(post.message_id)||post.channel_id!==target.channel_id)throw new DeliveryError('Announcement does not match its saved Discord destination',409);
    const path=`/channels/${post.channel_id}/messages/${post.message_id}`;
    try{
      const channel=await discordAPI(env,'/channels/'+post.channel_id);
      if(channel.guild_id!==target.guild_id)throw new DeliveryError('Announcement channel does not belong to the saved Discord server',409);
      const message=await discordAPI(env,path);
      if(message.id!==post.message_id||message.channel_id!==post.channel_id||message.author?.id!==target.application_id||!trackerMarker(message.content,id))throw new DeliveryError('Announcement ownership could not be verified; nothing was deleted',409);
      try{await discordAPI(env,path,'DELETE');}catch(error){if(error.status!==404)throw error;}
    }catch(error){if(error.status!==404)throw error;}
    await env.DB.prepare('DELETE FROM discord_event_posts WHERE event_id=? AND message_id=?').bind(id,post.message_id).run();
  }
  if(scheduled){
    if(!snowflake(scheduled.discord_id))throw new DeliveryError('Scheduled event ID is invalid',409);
    const path=`/guilds/${target.guild_id}/scheduled-events/${scheduled.discord_id}`;
    try{
      const live=await discordAPI(env,path);
      if(live.id!==scheduled.discord_id||live.guild_id!==target.guild_id||live.creator_id!==target.application_id||!trackerMarker(live.description,id))throw new DeliveryError('Scheduled event ownership could not be verified; nothing was deleted',409);
      try{await discordAPI(env,path,'DELETE');}catch(error){if(error.status!==404)throw error;}
    }catch(error){if(error.status!==404)throw error;}
    await env.DB.prepare('DELETE FROM discord_events WHERE event_id=? AND discord_id=?').bind(id,scheduled.discord_id).run();
  }
  await env.DB.prepare("UPDATE discord_outbox SET status='skipped',lease_until=0 WHERE reference_id=? AND kind IN ('event','event_post') AND status='pending'").bind(id).run();
  return 'sent';
}
export const reactionRoles=event=>['Dungeon','Raid'].includes(event.kind)?[{emoji:'🛡️',role:'Tank'},{emoji:'💚',role:'Healer'},{emoji:'⚔️',role:'Damage'}]:event.kind==='Roleplay'?[{emoji:'🎭',role:'Roleplay'},{emoji:'🍻',role:'Social'}]:[{emoji:'🛡️',role:'Tank'},{emoji:'💚',role:'Healer'},{emoji:'⚔️',role:'Damage'},{emoji:'🎭',role:'Roleplay'},{emoji:'🍻',role:'Social'}];
function signupTable(event, signups, budget){
  const limits=roleLimits(event),remaining=Math.max(0,event.capacity-signups.length);
  const rows=reactionRoles(event).map(({role})=>{
    const names=signups.filter(signup=>signup.role===role).map(signup=>
      String(signup.character_name||'Character unavailable').replace(/[\x00-\x1f\x7f-\x9f\x60]/g,' ').trim()||'Character unavailable');
    const limit=limits?.[role]??0;
    const open=limits?String(Math.max(0,Math.min(remaining,limit-names.length))):'—';
    return {role,names,shown:[],open,filled:limits?names.length+'/'+limit:String(names.length)};
  });
  function render(){
    const head=limits?'Role     Filled  Open  Characters':'Role     Filled  Characters';
    const columns=rows.map(({role,names,shown,open,filled})=>{
      const hidden=names.length-shown.length;
      const characters=[...shown,...(hidden?['+'+hidden+' more']:[])].join(', ')||'—';
      return role.padEnd(9)+filled.padEnd(8)+(limits?open.padEnd(6):'')+characters;
    });
    return ['Confirmed: '+signups.length+'/'+event.capacity+' · '+remaining+' open','\x60\x60\x60',head,...columns,'\x60\x60\x60'].join('\n');
  }
  // Share the name budget across roles, keeping every vacancy and overflow count visible.
  for(let index=0;index<signups.length;index++){
    for(const row of rows){
      if(!row.names[index]||row.shown.length!==index)continue;
      row.shown.push(row.names[index]);
      if(render().length>budget)row.shown.pop();
    }
  }
  return render();
}
export function scheduledEventDescription(event, signups, announcement){
  const link=announcement||ORIGIN+'/guild#events';
  const footer='Guild sign-ups: '+link+'\nTracker event: '+event.id;
  const table=signupTable(event,signups,1000-footer.length-2);
  const details=[event.description,...eventGuideLines(event)].filter(Boolean).map(line=>safe(line)).join('\n');
  const intro=details.slice(0,Math.max(0,1000-table.length-footer.length-4)).replace(/[\uD800-\uDBFF\\]$/,'').trimEnd();
  return [intro,table,footer].filter(Boolean).join('\n\n');
}
export async function eventSignups(env,eventId){
  const result=await env.DB.prepare(
    'SELECT json_extract(m.data,\'$.name\') character_name,s.role FROM event_signups s LEFT JOIN verified_membership m ON m.character_id=s.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE s.event_id=? ORDER BY s.updated_at,s.character_id'
  ).bind(eventId).all();
  return result.results;
}
export async function syncOneScheduledEvent(env){
  if(!env.DISCORD_BOT_TOKEN)return;
  const now=epoch();
  const pause=await env.DB.prepare("SELECT CAST(json_extract(value,'$.until') AS INTEGER) until FROM state WHERE key='discord_pause'").first();
  if(pause?.until>now)return;
  const lease=now+120;
  const row=await env.DB.prepare(
    "UPDATE discord_events SET signup_lease_until=? WHERE event_id=("+
    "SELECT d.event_id FROM discord_events d JOIN events e ON e.id=d.event_id "+
    "WHERE d.signup_revision<>d.synced_revision AND d.signup_retry_at<=? AND d.signup_lease_until<=? "+
    "AND e.status='open' AND datetime(e.starts_at,'+'||e.duration_minutes||' minutes')>datetime('now') "+
    "ORDER BY d.signup_retry_at,e.starts_at,d.event_id LIMIT 1) AND signup_lease_until<=? RETURNING *"
  ).bind(lease,now,now,now).first();
  if(!row)return;
  try{
    const [event,signups,post,config]=await Promise.all([
      env.DB.prepare('SELECT * FROM events WHERE id=?').bind(row.event_id).first(),
      eventSignups(env,row.event_id),
      env.DB.prepare('SELECT channel_id,message_id FROM discord_event_posts WHERE event_id=?').bind(row.event_id).first(),
      discordConfig(env)
    ]);
    if(eventInactive(event))return;
    const target=await eventTarget(env,event.id,config,post?.channel_id||config.events_channel_id);
    if(!snowflake(row.discord_id))throw new DeliveryError('Scheduled event ID is invalid',409);
    const path='/guilds/'+target.guild_id+'/scheduled-events/'+row.discord_id;
    const live=await discordAPI(env,path);
    if(live.id!==row.discord_id||live.guild_id!==target.guild_id||live.creator_id!==target.application_id||!trackerMarker(live.description,event.id))
      throw new DeliveryError('Scheduled event ownership could not be verified',409);
    const announcement=post?.channel_id===target.channel_id&&snowflake(post.channel_id)&&snowflake(post.message_id)
      ? 'https://discord.com/channels/'+target.guild_id+'/'+post.channel_id+'/'+post.message_id : null;
    const description=scheduledEventDescription(event,signups,announcement);
    const current=await env.DB.prepare(
      'SELECT e.* FROM events e JOIN discord_events d ON d.event_id=e.id WHERE e.id=? AND d.discord_id=? AND d.signup_revision=? AND d.signup_lease_until=?'
    ).bind(event.id,row.discord_id,row.signup_revision,lease).first();
    if(eventInactive(current))return;
    if(description!==live.description)await discordAPI(env,path,'PATCH',{description});
    await env.DB.prepare('UPDATE discord_events SET synced_revision=?,signup_retry_at=0,signup_sync_error=NULL WHERE event_id=? AND discord_id=? AND signup_lease_until=?')
      .bind(row.signup_revision,event.id,row.discord_id,lease).run();
  }catch(error){
    const retry=error.status===429?Math.max(60,error.retry||0):300;
    await env.DB.prepare('UPDATE discord_events SET signup_retry_at=?,signup_sync_error=? WHERE event_id=? AND discord_id=? AND signup_lease_until=?')
      .bind(epoch()+retry,error instanceof DeliveryError?error.message:'Scheduled event sign-ups could not be synced',row.event_id,row.discord_id,lease).run();
    if(error.status===429)await env.DB.prepare(
      "INSERT INTO state(key,value) VALUES('discord_pause',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value "+
      "WHERE CAST(json_extract(state.value,'$.until') AS INTEGER)<CAST(json_extract(excluded.value,'$.until') AS INTEGER)"
    ).bind(JSON.stringify({until:epoch()+retry})).run();
  }finally{
    await env.DB.prepare('UPDATE discord_events SET signup_lease_until=0 WHERE event_id=? AND discord_id=? AND signup_lease_until=?')
      .bind(row.event_id,row.discord_id,lease).run();
  }
}
export function eventAnnouncement(event,signups,pending=[],scheduled=null,guild=''){
  const roles=reactionRoles(event),cancelled=event.status!=='open';
  const heading=[`**${cancelled?'CANCELLED · ':''}${safe(event.title)}**`,`${safe(event.kind)} · <t:${Math.floor(Date.parse(event.starts_at)/1000)}:F> · ${event.duration_minutes||120} minutes`,event.location?'Meet at '+safe(event.location):''].filter(Boolean).join('\n');
  const lines=[];
  if(pending.length)lines.push('**Awaiting confirmation:** '+pending.slice(0,3).map(s=>`${discordField(s.display_name,32)} (${discordField(s.result,24)})`).join(', ')+(pending.length>3?` +${pending.length-3} more`:''));
  if(!cancelled)lines.push('',`React ${roles.map(r=>r.emoji+' '+r.role).join(' / ')} to claim a party role. Keep one role reaction. Remove it to withdraw a Discord signup.`, 'Match your character with one-time '+CONFIG.discord.botName+' authorisation or ask a guild administrator to assign it. Your existing WoW ↔ Discord connection stays in place. Unmatched reactions wait for confirmation.', 'Website choices stay in place until you change your reaction. Reaction checks run each minute; several events may take longer.');
  const footer=[scheduled?`Discord event: https://discord.com/events/${guild}/${scheduled}`:'',`Character choices and sign-ups: ${ORIGIN}/guild#events`,`Tracker event: ${event.id}`].filter(Boolean).join('\n');
  const tail=[...lines.filter(Boolean),footer].join('\n');
  const budget=2000-heading.length-tail.length-4;
  const details=[event.description,...eventGuideLines(event)].filter(Boolean).map(line=>discordField(line,150)).join('\n');
  const table=signupTable(event,signups,budget-Math.min(details.length,360));
  const intro=details.slice(0,Math.max(0,budget-table.length-2)).replace(/[\uD800-\uDBFF\\]$/,'').trimEnd();
  return [heading,table,intro,tail].filter(Boolean).join('\n\n');
}
async function announcementData(env,event){
  const [signups,pending,scheduled]=await Promise.all([
    eventSignups(env,event.id),
    env.DB.prepare("SELECT display_name,result FROM discord_event_reactions WHERE event_id=? AND signature<>'' AND result NOT IN ('confirmed','removed') ORDER BY first_seen LIMIT 20").bind(event.id).all(),
    env.DB.prepare('SELECT discord_id FROM discord_events WHERE event_id=?').bind(event.id).first()
  ]);const config=await discordConfig(env);return eventAnnouncement(event,signups,pending.results,scheduled?.discord_id,config.guild_id);
}
async function seedReactions(env,event,post){
  if(eventInactive(event))return;
  for(const {emoji}of reactionRoles(event))await discordAPI(env,`/channels/${post.channel_id}/messages/${post.message_id}/reactions/${encodeURIComponent(emoji)}/@me`,'PUT');
  await env.DB.prepare('UPDATE discord_event_posts SET reactions_initialized=1,last_error=NULL WHERE event_id=?').bind(event.id).run();
}
export async function publishEventPost(env,reference){
  const config=await discordConfig(env),event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(reference).first();if(!event||!snowflake(config.events_channel_id))return 'skipped';
  if(eventInactive(event)){await eventCleanupStatement(env,event.id).run();return 'skipped';}
  let post=await env.DB.prepare('SELECT * FROM discord_event_posts WHERE event_id=?').bind(event.id).first();
  await eventTarget(env,event.id,config,post?.channel_id||config.events_channel_id);
  const content=await announcementData(env,event),hash=await digest(content);
  if(!post){
    if(eventInactive(await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(event.id).first())){await eventCleanupStatement(env,event.id).run();return 'skipped';}
    const created=await discordAPI(env,'/channels/'+config.events_channel_id+'/messages','POST',{content,allowed_mentions:{parse:[]},nonce:(await digest('event-post:'+event.id)).slice(0,25),enforce_nonce:true});
    if(!snowflake(created.id))throw Error('Discord did not return a message ID');post={event_id:event.id,channel_id:config.events_channel_id,message_id:created.id,reactions_initialized:0};
    await env.DB.prepare('INSERT INTO discord_event_posts(event_id,channel_id,message_id,last_hash) VALUES(?,?,?,?)').bind(event.id,post.channel_id,post.message_id,hash).run();
  }else if(post.last_hash!==hash){await discordAPI(env,`/channels/${post.channel_id}/messages/${post.message_id}`,'PATCH',{content,allowed_mentions:{parse:[]}});await env.DB.prepare('UPDATE discord_event_posts SET last_hash=?,last_error=NULL WHERE event_id=?').bind(hash,event.id).run();}
  if(eventInactive(await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(event.id).first())){await eventCleanupStatement(env,event.id).run();return 'sent';}
  if(!post.reactions_initialized)await seedReactions(env,event,post);return 'sent';
}
export function effectivePermissions(guild,member,userId,channel){
  const roles=new Set(member.roles||[]),everyone=(guild.roles||[]).find(r=>r.id===guild.id);let permission=BigInt(everyone?.permissions||0);
  for(const role of guild.roles||[])if(roles.has(role.id))permission|=BigInt(role.permissions||0);
  if(permission&8n)return (1n<<60n)-1n;
  const overwrites=channel.permission_overwrites||[],apply=o=>{if(o)permission=(permission&~BigInt(o.deny||0))|BigInt(o.allow||0);};apply(overwrites.find(o=>o.id===guild.id));
  let deny=0n,allow=0n;for(const o of overwrites)if(o.type===0&&roles.has(o.id)){deny|=BigInt(o.deny||0);allow|=BigInt(o.allow||0);}permission=(permission&~deny)|allow;apply(overwrites.find(o=>o.type===1&&o.id===userId));return permission;
}
export async function eventChannelCheck(env){
  const config=await discordConfig(env);if(!snowflake(config.events_channel_id))return {configured:false,missing:['Events channel not selected']};
  return channelCheck(env,config.events_channel_id);
}
export async function channelCheck(env,channelId){
  const config=await discordConfig(env);if(!snowflake(channelId))return {configured:false,missing:['Channel not selected']};
  const [guild,bot,channel]=await Promise.all([discordAPI(env,'/guilds/'+config.guild_id),discordAPI(env,'/users/@me'),discordAPI(env,'/channels/'+channelId)]);
  if(channel.guild_id!==config.guild_id||![0,5].includes(channel.type))return {configured:true,valid:false,missing:['Choose a text channel in the configured guild server']};
  const member=await discordAPI(env,`/guilds/${config.guild_id}/members/${bot.id}`),permissions=effectivePermissions(guild,member,bot.id,channel);
  const needed=[['View Channel',1024n],['Send Messages',2048n],['Read Message History',65536n],['Add Reactions',64n]],missing=needed.filter(([,bit])=>!(permissions&bit)).map(([name])=>name);
  return {configured:true,valid:true,channel_name:channel.name,channel_id:channel.id,can_post:!missing.includes('View Channel')&&!missing.includes('Send Messages'),can_react:missing.length===0,missing};
}
export async function pollOneEventPost(env){
  if(!env.DISCORD_BOT_TOKEN)return;
  const now=epoch(),post=await env.DB.prepare(`UPDATE discord_event_posts SET lease_until=? WHERE event_id=(SELECT p.event_id FROM discord_event_posts p JOIN events e ON e.id=p.event_id WHERE e.status='open' AND datetime(e.starts_at,'+'||e.duration_minutes||' minutes')>datetime('now') AND p.next_poll_at<=? AND p.lease_until<? ORDER BY p.next_poll_at LIMIT 1) AND lease_until<? RETURNING *`).bind(now+180,now,now,now).first();if(!post)return;
  try{
    const event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(post.event_id).first();if(eventInactive(event)){await eventCleanupStatement(env,post.event_id).run();return;}
    if(!post.reactions_initialized)await seedReactions(env,event,post);
    const current=new Map();
    for(const {emoji,role}of reactionRoles(event)){
      const list=await discordAPI(env,`/channels/${post.channel_id}/messages/${post.message_id}/reactions/${encodeURIComponent(emoji)}?limit=100`);
      if(!Array.isArray(list)||list.length>=100)throw Error('Reaction list is incomplete; no sign-ups were changed');
      for(const user of list){if(user.bot||!snowflake(user.id))continue;if(!current.has(user.id))current.set(user.id,{roles:new Set(),name:String(user.global_name||user.username||'Discord member').slice(0,80)});current.get(user.id).roles.add(role);}
    }
    const previous=(await env.DB.prepare('SELECT * FROM discord_event_reactions WHERE event_id=?').bind(event.id).all()).results,old=new Map(previous.map(r=>[r.discord_id,r]));
    const linked=(await env.DB.prepare(`SELECT d.discord_id,u.id user_id,u.main_character_id,u.ownership_checked,m.data FROM discord_links d JOIN users u ON u.id=d.user_id JOIN character_links l ON l.user_id=u.id JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE u.ownership_status='verified'`).all()).results;
    const matches=new Map();for(const r of linked){const char=JSON.parse(r.data),existing=matches.get(r.discord_id);if(!existing||char.id===r.main_character_id)matches.set(r.discord_id,{user_id:r.user_id,char,checked:r.ownership_checked});}
    const manualRows=await activeManualMappings(env);for(const r of manualRows){const char=JSON.parse(r.roster),existing=matches.get(r.discord_id);linked.push({user_id:r.participant_user_id,main_character_id:r.preferred?char.id:null,ownership_checked:0,data:r.roster});
      if(!existing||existing.manual&&r.preferred)matches.set(r.discord_id,{user_id:r.participant_user_id,char,checked:0,trusted:true,manual:true});
    }
    const ids=new Set([...current.keys(),...old.keys()]),changes=[];
    for(const id of ids){const previous=old.get(id),value=current.get(id),signature=value?[...value.roles].sort().join('|'):'',match=matches.get(id);if(!previous||previous.signature!==signature||previous.user_id!==(match?.user_id||null)||!previous.handled)changes.push({id,previous,value,signature,match});}
    changes.sort((a,b)=>(a.previous?.last_seen||0)-(b.previous?.last_seen||0)||a.id.localeCompare(b.id));
    for(const {id,previous,value,signature,match}of changes.slice(0,10)){
      let result=signature?'unmatched':'removed',handled=1;const roles=value?[...value.roles]:[];
      if(previous?.user_id&&(!signature||previous.user_id!==match?.user_id||roles.length!==1))await env.DB.prepare("DELETE FROM event_signups WHERE event_id=? AND user_id=? AND source='discord'").bind(event.id,previous.user_id).run();
      if(signature&&roles.length!==1)result='choose one role';
      else if(signature&&match){
        const current=await env.DB.prepare('SELECT character_id FROM event_signups WHERE event_id=? AND user_id=?').bind(event.id,match.user_id).first();let character=match.char;
          if(current){const owned=linked.find(r=>r.user_id===match.user_id&&JSON.parse(r.data).id===current.character_id);if(owned)character=JSON.parse(owned.data);}
          const trusted=manualRows.some(r=>r.discord_id===id&&r.participant_user_id===match.user_id&&r.character_id===character.id);
          if(!trusted&&match.checked<now-86400){result='refresh guild sign-in';handled=0;}else{
          const saved=await signupStatement(env,event,match.user_id,character.id,roles[0],'Joined using a Discord reaction','discord').run();
          if(Number(saved.meta?.changes??saved.changes??0)>0)result='confirmed';else{result='role or event full';handled=0;}
        }
      }
      await env.DB.prepare(`INSERT INTO discord_event_reactions(event_id,discord_id,signature,user_id,handled,result,display_name,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,discord_id) DO UPDATE SET signature=excluded.signature,user_id=excluded.user_id,handled=excluded.handled,result=excluded.result,display_name=excluded.display_name,last_seen=excluded.last_seen`)
        .bind(event.id,id,signature,match?.user_id||null,handled,result,value?.name||previous?.display_name||'Discord member',previous?.first_seen||now,now).run();
    }
    await publishEventPost(env,event.id);
    await env.DB.prepare('UPDATE discord_event_posts SET next_poll_at=?,last_error=NULL WHERE event_id=?').bind(Math.floor(epoch()/60)*60+59,event.id).run();
  }catch(error){await env.DB.prepare('UPDATE discord_event_posts SET next_poll_at=?,last_error=? WHERE event_id=?').bind(epoch()+(Number.isFinite(error.retry)?Math.max(60,error.retry):300),'Reaction checks could not complete; existing sign-ups were preserved',post.event_id).run();}
  finally{await env.DB.prepare('UPDATE discord_event_posts SET lease_until=0 WHERE event_id=?').bind(post.event_id).run();}
}
