import {discordAPI,discordConfig,DeliveryError,requestNotifications} from './discord.mjs';
import {ORIGIN,digest} from './auth.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
const stamp=()=>new Date().toISOString();
const snowflake=value=>typeof value==='string'&&/^\d{15,22}$/.test(value);
const active=row=>row?.kind==='craft'&&['open','claimed'].includes(row.status);
const marker=id=>'Tracker craft request: '+id;
const hasMarker=(content,id)=>typeof content==='string'&&content.split('\n').some(line=>line.trim()===marker(id));
const safe=(value,max=140)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\`*_~>|\[\]\(\)]/g,'\\$&').slice(0,max);
const changed=result=>Number(result?.meta?.changes??result?.changes??0)>0;
function reference(id){if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,120}$/.test(id))throw new DeliveryError('Craft request reference is invalid',400);return id;}
async function request(env,id){return env.DB.prepare(`SELECT r.*,json_extract(m.data,'$.name') character_name FROM requests r LEFT JOIN verified_membership m ON m.character_id=r.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE r.id=?`).bind(id).first();}
async function paused(env){
  const row=await env.DB.prepare("SELECT value FROM state WHERE key='discord_pause'").first(),until=row?JSON.parse(row.value)?.until:0;
  if(until>epoch())throw new DeliveryError('Discord requested a pause before another craft check',429,until-epoch());
}
async function protect(env,run){
  await paused(env);
  try{return await run();}catch(error){
    if(error.status===429){
      const until=epoch()+Math.max(1,Number(error.retry)||60);
      await env.DB.prepare(`INSERT INTO state(key,value) VALUES('discord_pause',json_object('until',?)) ON CONFLICT(key) DO UPDATE SET value=json_object('until',MAX(COALESCE(json_extract(state.value,'$.until'),0),?))`).bind(until,until).run();
    }
    throw error;
  }
}
export function craftTargetStatement(env,id,config){
  reference(id);
  return env.DB.prepare(`INSERT OR IGNORE INTO state(key,value) SELECT ?,json_object('guild_id',?,'application_id',?,'channel_id',?,'recipient_name',COALESCE(NULLIF(r.recipient_name,''),json_extract(m.data,'$.name'),'')) FROM requests r LEFT JOIN verified_membership m ON m.character_id=r.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE r.id=?`)
    .bind('discord_craft_target:'+id,config.guild_id||'',config.client_id||'',config.craft_requests_channel_id||'',id);
}
export function craftPostStatement(env,id,reason='fallback',change=null){
  reference(id);
  return env.DB.prepare(`INSERT OR IGNORE INTO discord_outbox(id,kind,reference_id,user_id,payload,created_at) SELECT ?,'craft_post',r.id,NULL,json_object('reason',?,'recipient_name',COALESCE(NULLIF(r.recipient_name,''),json_extract(m.data,'$.name'),'')),? FROM requests r LEFT JOIN verified_membership m ON m.character_id=r.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE r.id=? AND r.kind='craft' AND r.status IN ('open','claimed')${change?' AND r.change_id=?':''}`)
    .bind('craft-post:'+id,safe(reason,80),stamp(),id,...(change?[change]:[]));
}
export function craftCleanupStatement(env,id,change=null){
  reference(id);
  return env.DB.prepare(`INSERT INTO discord_outbox(id,kind,reference_id,user_id,payload,created_at) SELECT ?,'craft_cleanup',?,NULL,'{}',? WHERE EXISTS(SELECT 1 FROM requests WHERE id=? AND status NOT IN ('open','claimed')${change?' AND change_id=?':''}) ON CONFLICT(id) DO UPDATE SET status='pending',next_at=0,last_error=NULL WHERE discord_outbox.status IN ('sent','skipped','failed')`)
    .bind('craft-cleanup:'+id,id,stamp(),id,...(change?[change]:[]));
}
async function target(env,id,config,create=false){
  if(create)await craftTargetStatement(env,id,config).run();
  const row=await env.DB.prepare('SELECT value FROM state WHERE key=?').bind('discord_craft_target:'+id).first();
  if(!row)return null;
  const value=JSON.parse(row.value);
  if(!snowflake(value.guild_id)||!snowflake(value.application_id)||!snowflake(value.channel_id)||value.guild_id!==config.guild_id||value.application_id!==config.client_id)throw new DeliveryError('Craft request needs its original Discord server, channel and bot configuration',409);
  return value;
}
function matches(message,pin,id,messageId=null){return snowflake(message?.id)&&(!messageId||message.id===messageId)&&message.channel_id===pin.channel_id&&message.author?.id===pin.application_id&&hasMarker(message.content,id);}
async function channel(env,pin){const value=await discordAPI(env,'/channels/'+pin.channel_id);if(value.id!==pin.channel_id||value.guild_id!==pin.guild_id||![0,5].includes(value.type))throw new DeliveryError('Craft request channel does not match its original Discord server',409);}
function pinnedPost(post,pin){
  if(post.guild_id!==pin.guild_id||post.application_id!==pin.application_id||post.channel_id!==pin.channel_id||post.message_id!==null&&!snowflake(post.message_id))throw new DeliveryError('Craft message does not match its pinned destination',409);
}
async function ownedMessage(env,pin,id,post){
  pinnedPost(post,pin);await channel(env,pin);
  const value=await discordAPI(env,`/channels/${pin.channel_id}/messages/${post.message_id}`);
  if(!matches(value,pin,id,post.message_id))throw new DeliveryError('Craft message ownership could not be verified; nothing was changed',409);
  return value;
}
async function reconcile(env,pin,id){
  const values=await discordAPI(env,'/channels/'+pin.channel_id+'/messages?limit=100');
  if(!Array.isArray(values)||values.length>100)throw new DeliveryError('Discord did not return a bounded craft message list',409);
  const found=values.filter(value=>matches(value,pin,id));
  if(found.length>1)throw new DeliveryError('Multiple matching craft messages require administrator review',409);
  if(found.length)return found[0];
  if(values.length===100)throw new DeliveryError('The craft message could be outside the latest 100 messages; automatic creation is paused',409);
  return null;
}
async function saveMessage(env,id,message,hash=null){
  await env.DB.prepare('UPDATE discord_craft_posts SET message_id=?,posted_at=COALESCE(posted_at,?),last_hash=COALESCE(?,last_hash) WHERE request_id=? AND (message_id IS NULL OR message_id=?)').bind(message.id,stamp(),hash,id,message.id).run();
  return env.DB.prepare('SELECT * FROM discord_craft_posts WHERE request_id=?').bind(id).first();
}
function materials(row){
  let plan;try{plan=JSON.parse(row.materials_json||'null');}catch{}
  if(plan?.status==='member_provided')return ['**Total materials (provided by requester):** '+safe(plan.manual,650)];
  if(plan?.status!=='verified'||!Array.isArray(plan.shopping_list))return ['Material totals are not verified. Check the request on the website.'];
  const lines=['**Total materials to provide:**'];
  for(const value of plan.shopping_list.slice(0,6))lines.push(`${safe(value.quantity,20)} × ${safe(value.name,70)}`);
  if(plan.shopping_list.length>6)lines.push(`+ ${plan.shopping_list.length-6} more materials on the website.`);
  const section=(values,max)=>{const value=values.join('\n');return value.length<=max?value:value.slice(0,max-48)+'… Full material snapshot on the website.';};
  const sections=[section(lines,450)];
  if(Array.isArray(plan.components)&&plan.components.length){const components=['**Components included in those totals:**'];for(const value of plan.components.slice(0,3))components.push(`${safe(value.required,20)} × ${safe(value.item_name,70)} (${safe(value.crafts,15)} component craft(s))`);if(plan.components.length>3)components.push('Further components are listed on the website.');sections.push(section(components,330));}
  return sections;
}
async function announcement(env,row,pin){
  const targets=await env.DB.prepare(`SELECT json_extract(m.data,'$.name') name FROM request_targets t LEFT JOIN verified_membership m ON m.character_id=t.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE t.request_id=? ORDER BY t.character_id LIMIT 12`).bind(row.id).all();
  const recipient=pin.recipient_name||row.recipient_name||row.character_name;
  if(!recipient)throw new DeliveryError('The exact recipient character name is unavailable',409);
  const selected=targets.results.slice(0,4).map(value=>safe(value.name||'Former guild crafter',70)).join(', ')+(targets.results.length>4?' + more on the website':'');
  const lines=[`**Craft request · ${safe(row.item_name)}**`,`${row.quantity} craft(s)`,`**Send the completed item to: ${safe(recipient,240)}**`,row.recipe_id?'React ✅ when complete. The requester or any linked/mapped guild member who has a verified recipe can complete this request.':'React ✅ when complete. Only the linked/mapped requester can complete this manual item request.',targets.results.length?'Selected crafters: '+selected:'Guild crafters are welcome to help.',...materials(row)];
  const footer=`Full materials and request details: ${ORIGIN}/guild#crafting\n${marker(row.id)}`;
  return lines.join('\n').slice(0,1999-footer.length).replace(/[\uD800-\uDBFF]$/,'')+'\n'+footer;
}
export async function publishCraftPost(env,id){
  reference(id);
  return protect(env,async()=>{
    const config=await discordConfig(env),row=await request(env,id);
    if(!active(row)){await craftCleanupStatement(env,id).run();return 'skipped';}
    let pin=await target(env,id,config);
    if(!pin&&!snowflake(config.craft_requests_channel_id))return 'skipped';
    pin=pin||await target(env,id,config,true);
    if(!pin)return 'skipped';
    const name=pin.recipient_name||row.recipient_name||row.character_name;
    if(!name)throw new DeliveryError('The recipient character name could not be pinned',409);
    await env.DB.prepare('INSERT OR IGNORE INTO discord_craft_posts(request_id,guild_id,application_id,channel_id,recipient_name) VALUES(?,?,?,?,?)').bind(id,pin.guild_id,pin.application_id,pin.channel_id,name).run();
    let post=await env.DB.prepare('UPDATE discord_craft_posts SET publish_until=? WHERE request_id=? AND publish_until<? RETURNING *').bind(epoch()+180,id,epoch()).first();
    if(!post)throw new DeliveryError('The craft announcement is already being processed',409,60);
    try{
      pinnedPost(post,pin);await channel(env,pin);
      const content=await announcement(env,row,pin),hash=await digest(content);
      if(!post.message_id&&post.create_attempted_at){const found=await reconcile(env,pin,id);if(found)post=await saveMessage(env,id,found);}
      if(!active(await request(env,id))){await craftCleanupStatement(env,id).run();return 'skipped';}
      if(!post.message_id){
        await env.DB.prepare('UPDATE discord_craft_posts SET create_attempted_at=? WHERE request_id=?').bind(stamp(),id).run();
        const created=await discordAPI(env,'/channels/'+pin.channel_id+'/messages','POST',{content,allowed_mentions:{parse:[]},nonce:(await digest('craft-post:'+id)).slice(0,25),enforce_nonce:true});
        if(!snowflake(created.id))throw new DeliveryError('Discord did not return a craft message ID');
        post=await saveMessage(env,id,created,hash);
      }
      if(!active(await request(env,id))){await craftCleanupStatement(env,id).run();return 'sent';}
      await ownedMessage(env,pin,id,post);
      if(post.last_hash!==hash){await discordAPI(env,`/channels/${pin.channel_id}/messages/${post.message_id}`,'PATCH',{content,allowed_mentions:{parse:[]}});await env.DB.prepare('UPDATE discord_craft_posts SET last_hash=? WHERE request_id=?').bind(hash,id).run();}
      if(!post.reactions_initialized&&active(await request(env,id))){
        await discordAPI(env,`/channels/${pin.channel_id}/messages/${post.message_id}/reactions/${encodeURIComponent('✅')}/@me`,'PUT');
        await env.DB.prepare('UPDATE discord_craft_posts SET reactions_initialized=1,last_error=NULL WHERE request_id=?').bind(id).run();
      }
      return 'sent';
    }finally{await env.DB.prepare('UPDATE discord_craft_posts SET publish_until=0 WHERE request_id=?').bind(id).run();}
  });
}
export async function deleteCraftPost(env,id){
  reference(id);
  return protect(env,async()=>{
    if(active(await request(env,id)))return 'skipped';
    let post=await env.DB.prepare('SELECT * FROM discord_craft_posts WHERE request_id=?').bind(id).first();
    if(!post){await env.DB.prepare("UPDATE discord_outbox SET status='skipped',lease_until=0 WHERE reference_id=? AND kind='craft_post' AND status='pending'").bind(id).run();return 'sent';}
    if(post.publish_until>epoch())throw new DeliveryError('The craft create is still finishing; cleanup will retry',409,60);
    const pin=await target(env,id,await discordConfig(env));
    if(!pin)throw new DeliveryError('The original craft destination is missing',409);
    pinnedPost(post,pin);
    if(!post.message_id&&post.create_attempted_at){
      try{await channel(env,pin);const found=await reconcile(env,pin,id);if(found)post=await saveMessage(env,id,found);}
      catch(error){if(error.status!==404)throw error;}
    }
    if(post.message_id){
      try{await ownedMessage(env,pin,id,post);try{await discordAPI(env,`/channels/${pin.channel_id}/messages/${post.message_id}`,'DELETE');}catch(error){if(error.status!==404)throw error;}}
      catch(error){if(error.status!==404)throw error;}
    }
    await env.DB.batch([env.DB.prepare('DELETE FROM discord_craft_posts WHERE request_id=?').bind(id),env.DB.prepare("UPDATE discord_outbox SET status='skipped',lease_until=0 WHERE reference_id=? AND kind='craft_post' AND status='pending'").bind(id)]);
    return 'sent';
  });
}
export async function queueCraftCleanups(env){
  const rows=await env.DB.prepare(`SELECT r.id FROM requests r WHERE r.kind='craft' AND r.status NOT IN ('open','claimed') AND EXISTS(SELECT 1 FROM discord_craft_posts p WHERE p.request_id=r.id) AND NOT EXISTS(SELECT 1 FROM discord_outbox o WHERE o.id='craft-cleanup:'||r.id AND o.status='pending') ORDER BY r.updated_at LIMIT 5`).all();
  if(rows.results.length)await env.DB.batch(rows.results.map(row=>craftCleanupStatement(env,row.id)));
  return {queued:rows.results.length};
}
async function reactions(env,pin,post){
  const values=[],seen=new Set();let after='';
  for(let page=0;page<3;page++){
    const list=await discordAPI(env,`/channels/${pin.channel_id}/messages/${post.message_id}/reactions/${encodeURIComponent('✅')}?limit=100${after?'&after='+after:''}`);
    if(!Array.isArray(list)||list.length>100)throw new DeliveryError('The completion reaction list is incomplete',409);
    for(const value of list){if(!snowflake(value?.id)||seen.has(value.id))throw new DeliveryError('The completion reaction list is incomplete',409);seen.add(value.id);values.push(value);}
    if(list.length<100)return values;
    const last=list.at(-1).id;if(after&&BigInt(last)<=BigInt(after))throw new DeliveryError('The completion reaction list is incomplete',409);after=last;
  }
  throw new DeliveryError('The completion reaction list exceeds the safe polling limit; no request was changed',409);
}
// These SQL checks deliberately ignore notification consent: recipe capability and ownership are separate from DM preferences.
const currentMembership=`JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)`;
const capability=`EXISTS(SELECT 1 FROM characters c JOIN json_each(c.data,'$.professions') p JOIN json_each(p.value,'$.recipes') recipe WHERE c.id=l.character_id AND json_extract(c.data,'$.professions_status')='verified' AND json_extract(p.value,'$.recipe_status')='observed' AND json_extract(recipe.value,'$.id')=requests.recipe_id)`;
const manualValid=`NOT EXISTS(SELECT 1 FROM character_links own WHERE own.character_id=l.character_id AND own.user_id<>l.participant_user_id) AND NOT EXISTS(SELECT 1 FROM discord_links linked WHERE (linked.discord_id=l.discord_id AND linked.user_id<>l.participant_user_id) OR (linked.user_id=l.participant_user_id AND linked.discord_id<>l.discord_id))`;
function completion(env,id,discordId,change,at){
  return env.DB.prepare(`UPDATE requests SET status='complete',updated_at=?,change_id=? WHERE id=? AND kind='craft' AND status IN ('open','claimed') AND (
    EXISTS(SELECT 1 FROM discord_links d JOIN users u ON u.id=d.user_id JOIN character_links l ON l.user_id=u.id ${currentMembership} WHERE d.discord_id=? AND u.ownership_status='verified' AND u.ownership_checked>? AND (u.id=requests.owner_id OR (requests.recipe_id IS NOT NULL AND ${capability})))
    OR EXISTS(SELECT 1 FROM admin_discord_mappings l ${currentMembership} WHERE l.discord_id=? AND ${manualValid} AND (l.character_id=requests.character_id OR (requests.recipe_id IS NOT NULL AND ${capability}))))`)
    .bind(at,change,id,discordId,epoch()-86400,discordId);
}
export async function pollOneCraftPost(env){
  if(!env.DISCORD_BOT_TOKEN)return;
  try{await paused(env);}catch(error){if(error.status===429)return;throw error;}
  const now=epoch(),minute=Math.floor(now/60);
  const clock=await env.DB.prepare(`INSERT INTO state(key,value) VALUES('craft_poll_minute',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(state.value AS INTEGER)<? RETURNING value`).bind(String(minute),minute).first();if(!clock)return;
  const post=await env.DB.prepare(`UPDATE discord_craft_posts SET lease_until=? WHERE request_id=(SELECT p.request_id FROM discord_craft_posts p JOIN requests r ON r.id=p.request_id WHERE r.kind='craft' AND r.status IN ('open','claimed') AND p.message_id IS NOT NULL AND p.next_poll_at<=? AND p.lease_until<? AND p.publish_until<? ORDER BY p.next_poll_at,p.request_id LIMIT 1) AND lease_until<? RETURNING *`).bind(now+180,now,now,now,now).first();if(!post)return;
  try{
    await protect(env,async()=>{
      const pin=await target(env,post.request_id,await discordConfig(env));if(!pin)throw new DeliveryError('The original craft destination is missing',409);
      await ownedMessage(env,pin,post.request_id,post);
      const people=await reactions(env,pin,post),row=await request(env,post.request_id);
      if(!active(row)){await craftCleanupStatement(env,post.request_id).run();return;}
      for(const person of people){
        if(person.bot||person.id===pin.application_id)continue;
        const change=crypto.randomUUID(),at=stamp(),notifications=await requestNotifications(env,{...row,status:'complete',updated_at:at,change_id:change},'complete');
        const results=await env.DB.batch([completion(env,row.id,person.id,change,at),craftCleanupStatement(env,row.id,change),...notifications]);
        if(changed(results[0]))return;
      }
    });
    await env.DB.prepare('UPDATE discord_craft_posts SET next_poll_at=?,last_error=NULL WHERE request_id=?').bind(epoch()+60,post.request_id).run();
  }catch(error){
    await env.DB.prepare('UPDATE discord_craft_posts SET next_poll_at=?,last_error=? WHERE request_id=?').bind(epoch()+Math.max(60,Number(error.retry)||300),'Craft completion checks could not finish; the request has been preserved',post.request_id).run();
  }finally{await env.DB.prepare('UPDATE discord_craft_posts SET lease_until=0 WHERE request_id=?').bind(post.request_id).run();}
}
export async function craftChannelCheck(env){
  return protect(env,async()=>{const config=await discordConfig(env);if(!snowflake(config.craft_requests_channel_id))return {configured:false,missing:['Craft requests channel not selected']};const {channelCheck}=await import('./event-posts.mjs');return channelCheck(env,config.craft_requests_channel_id);});
}
