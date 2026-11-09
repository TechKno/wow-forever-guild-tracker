import {GUILD} from './config.mjs';
import {currentUser,requireMember,requireWrite,bodyJSON,ownCharacter,WebError,stamp} from './auth.mjs';
import {discordView,requestNotifications,outboxStatement,discordReady,discordConfig} from './discord.mjs';
import {signupStatement,roleLimits,eventTargetStatement,eventCleanupStatement,eventInactive} from './events.mjs';
import {chosenCrafters} from './crafters.mjs';
import {materialPlan} from './materials.mjs';
import {mergeMember} from './logic.mjs';
import {memberDirectory} from './discord-people.mjs';
import {currentRolePreferences,withRolePreferences,saveRolePreferences} from './character-roles.mjs';
import {eventTemplateSettings,eventTemplateGuidance} from './event-templates.mjs';
import {rosterDisplayGroups,effectivePlayerMains} from './player-groups.mjs';
import {accountSyncView} from './account-refresh.mjs';
export function text(value,max,minimum=0){
  if(typeof value!=='string')throw new WebError('Check the text fields');
  const clean=value.trim().replaceAll('\u0000','');
  if(clean.length<minimum||clean.length>max)throw new WebError(`Use between ${minimum} and ${max} characters`);
  return clean;
}
function choice(value,allowed){if(!allowed.includes(value))throw new WebError('Choose a valid option');return value;}
function integer(value,min,max){const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new WebError(`Enter a number from ${min} to ${max}`);return n;}
const changed=result=>Number(result.meta?.changes??result.changes??0)>0;
export async function sessionView(request,env){
  const user=await currentUser(request,env);
  if(!user)return {signed_in:false};
  const rolePreferences=user.verified?await currentRolePreferences(env):new Map();
  const main=user.characters.find(c=>c.id===user.main_character_id)||user.characters[0];
  const links=user.verified?await env.DB.prepare(`SELECT l.user_id,l.character_id,l.show_as_alt,u.main_character_id FROM character_links l
    JOIN users u ON u.id=l.user_id JOIN verified_membership m ON m.character_id=l.character_id
    WHERE m.generation=(SELECT published FROM sync WHERE id=1) AND u.ownership_status='verified'
    ORDER BY m.slug`).all():{results:[]};
  const effectiveMains=effectivePlayerMains(links.results),playerLinks=links.results.filter(row=>row.character_id===effectiveMains.get(row.user_id)||row.show_as_alt===1)
    .map(row=>({user_id:row.user_id,character_id:row.character_id,main_character_id:effectiveMains.get(row.user_id)}));
  return {signed_in:true,verified:user.verified,is_admin:user.is_admin,user_id:user.id,csrf:user.csrf,main_character_id:main?.id??null,
    account_updated_at:Number.isFinite(Date.parse(user.updated_at))?new Date(user.updated_at).toISOString():null,
    ownership_checked_at:Number.isFinite(user.ownership_checked)&&user.ownership_checked>0?new Date(user.ownership_checked*1000).toISOString():null,
    account_sync:await accountSyncView(env,user),
    discord:await discordView(env,user),display_name:main?.name||'Battle.net member',characters:user.characters.map(c=>withRolePreferences(c,rolePreferences)),player_links:playerLinks,
    message:user.verified?'Guild character ownership verified by Battle.net':user.ownership_status!=='verified'?
      'Signed in, but Blizzard did not return a verifiable Forever account character list. Sign in again to retry.':
      `No current ${GUILD} character was returned for this account. Blizzard account data can take time to update.`};
}
export async function hallView(request,env){
  const user=await currentUser(request,env);requireMember(user);
  const [requests,events,signups,directory,popular,targets,pendingReactions,craftPosts]=await Promise.all([
    env.DB.prepare(`SELECT r.*,json_extract(m.data,'$.name') character_name,json_extract(cm.data,'$.name') crafter_name
      FROM requests r LEFT JOIN verified_membership m ON m.character_id=r.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
      LEFT JOIN users c ON c.id=r.crafter_id LEFT JOIN verified_membership cm ON cm.character_id=c.main_character_id AND cm.generation=(SELECT published FROM sync WHERE id=1)
      ORDER BY r.created_at DESC LIMIT 150`).all(),
    env.DB.prepare(`SELECT e.*,de.discord_id discord_event_id,dp.channel_id discord_channel_id,dp.message_id discord_message_id,dp.last_error reaction_sync_error,json_extract(m.data,'$.name') host_name FROM events e LEFT JOIN discord_events de ON de.event_id=e.id LEFT JOIN discord_event_posts dp ON dp.event_id=e.id
      LEFT JOIN verified_membership m ON m.character_id=e.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
      WHERE e.starts_at>? ORDER BY e.starts_at LIMIT 60`).bind(new Date(Date.now()-7*86400000).toISOString()).all(),
    env.DB.prepare(`SELECT es.*,json_extract(m.data,'$.name') character_name FROM event_signups es JOIN events e ON e.id=es.event_id
      LEFT JOIN verified_membership m ON m.character_id=es.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
      WHERE e.starts_at>? ORDER BY es.updated_at`).bind(new Date(Date.now()-7*86400000).toISOString()).all(),
    env.DB.prepare(`SELECT l.character_id,l.user_id,l.show_as_alt,u.main_character_id,m.data,c.data details,p.title,p.biography,p.looking_for,p.updated_at
      FROM character_links l JOIN users u ON u.id=l.user_id JOIN verified_membership m ON m.character_id=l.character_id
      LEFT JOIN characters c ON c.id=m.character_id
      LEFT JOIN character_profiles p ON p.character_id=l.character_id AND p.user_id=l.user_id
      WHERE m.generation=(SELECT published FROM sync WHERE id=1) ORDER BY m.slug`).all(),
    env.DB.prepare(`SELECT recipe_id,MAX(item_name) item_name,COUNT(*) request_count,SUM(quantity) total_crafts,
      COUNT(DISTINCT owner_id) member_count,SUM(CASE WHEN status IN ('open','claimed') THEN 1 ELSE 0 END) active_count
      FROM requests WHERE kind='craft' AND status<>'cancelled' AND created_at>=?
      GROUP BY CASE WHEN recipe_id IS NOT NULL THEN 'recipe:'||recipe_id ELSE 'manual:'||LOWER(TRIM(item_name)) END ORDER BY request_count DESC,total_crafts DESC LIMIT 8`)
      .bind(new Date(Date.now()-30*86400000).toISOString()).all(),
    env.DB.prepare(`SELECT t.request_id,t.character_id,json_extract(m.data,'$.name') name FROM request_targets t LEFT JOIN verified_membership m ON m.character_id=t.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE t.request_id IN (SELECT id FROM requests ORDER BY created_at DESC LIMIT 150)`).all(),
    env.DB.prepare("SELECT event_id,display_name,result,signature FROM discord_event_reactions WHERE signature<>'' AND result NOT IN ('confirmed','removed') ORDER BY first_seen LIMIT 100").all(),
    env.DB.prepare("SELECT o.reference_id request_id,o.status,o.last_error,p.guild_id,p.channel_id,p.message_id FROM discord_outbox o LEFT JOIN discord_craft_posts p ON p.request_id=o.reference_id WHERE o.kind='craft_post' AND o.reference_id IN (SELECT id FROM requests ORDER BY created_at DESC LIMIT 150)").all()
  ]);
  const discordGuild=(await discordConfig(env)).guild_id,rolePreferences=await currentRolePreferences(env);
  const effectiveMains=effectivePlayerMains(directory.results);
  const characters=directory.results.map(d=>{const roster=JSON.parse(d.data),view=mergeMember(roster,d.details?JSON.parse(d.details):{}),isMain=effectiveMains.get(d.user_id)===d.character_id;return withRolePreferences({...roster,level:view.level,level_source:view.level_source,level_observed_at:view.level_observed_at,user_id:d.user_id,is_main:isMain,is_alt:Boolean(d.show_as_alt)&&!isMain,title:d.title||'',biography:d.biography||'',looking_for:d.looking_for||'',own:d.user_id===user.id},rolePreferences);});
  const people=await memberDirectory(env,user,characters,rolePreferences);
  return {discord_guild_id:discordGuild,popular:popular.results,requests:requests.results.map(r=>{const {materials_json,change_id,...safe}=r;const post=craftPosts.results.find(p=>p.request_id===r.id),active=['open','claimed'].includes(r.status);return {...safe,discord_message_url:active&&post?.message_id?`https://discord.com/channels/${post.guild_id}/${post.channel_id}/${post.message_id}`:null,discord_channel_status:!active||!post?null:post.status==='failed'?'failed':post.message_id?'posted':'pending',discord_channel_note:active&&post?.last_error?post.last_error:null,targets:targets.results.filter(t=>t.request_id===r.id).map(t=>({character_id:t.character_id,name:t.name||'Former guild character'})),asked_me:targets.results.some(t=>t.request_id===r.id&&user.characters.some(c=>c.id===t.character_id)),materials_preference:r.materials,materials:materials_json?JSON.parse(materials_json):null,own:r.owner_id===user.id,claimed_by_me:r.crafter_id===user.id};}),
    events:events.results.map(e=>{const {template_json,...safe}=e;return {...safe,template_guidance:eventTemplateGuidance(e),discord_message_url:e.discord_message_id?`https://discord.com/channels/${discordGuild}/${e.discord_channel_id}/${e.discord_message_id}`:null,pending_reactions:pendingReactions.results.filter(p=>p.event_id===e.id).map(p=>({name:p.display_name,reason:p.result,roles:p.signature.split('|')})),role_limits:roleLimits(e),own:e.owner_id===user.id,signups:signups.results.filter(s=>s.event_id===e.id).map(s=>({...s,own:s.user_id===user.id}))};}),
    directory:characters,people,display_groups:rosterDisplayGroups(people)};
}
async function recipeName(env,id){
  const rows=await env.DB.prepare(`SELECT c.data FROM characters c JOIN verified_membership m ON m.character_id=c.id WHERE m.generation=(SELECT published FROM sync WHERE id=1)`).all();
  for(const row of rows.results)for(const p of JSON.parse(row.data).professions||[])for(const r of p.recipes||[])if(r.id===id)return r.name;
  throw new WebError('That recipe has not been observed in the current guild data');
}
export async function mutateHall(request,env){
  const user=await currentUser(request,env);requireMember(user);requireWrite(request,user);
  const body=await bodyJSON(request),path=new URL(request.url).pathname;
  if(path==='/api/hall/roles')return saveRolePreferences(env,user,body);
  if(path==='/api/hall/main'){
    const char=ownCharacter(user,body.character_id);
    let selected=null;
    if(body.alt_ids!==undefined){
      if(!Array.isArray(body.alt_ids)||body.alt_ids.length>100)throw new WebError('Choose your alt characters');
      selected=new Set(body.alt_ids.map(id=>ownCharacter(user,id).id));selected.delete(char.id);
    }
    const at=new Date(Math.max(Date.now(),Date.parse(user.updated_at)||0)+1).toISOString(),wanted=[...new Set([char.id,...(selected||[])])],marks=wanted.map(()=>'?').join(',');
    const statements=[env.DB.prepare(`UPDATE users SET main_character_id=?,updated_at=? WHERE id=? AND ownership_status='verified'
      AND ownership_checked=? AND ownership_checked>unixepoch()-86400 AND ownership_checked<=unixepoch()+60
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=users.id AND s.token_hash=? AND s.expires>unixepoch())
      AND (SELECT COUNT(DISTINCT l.character_id) FROM character_links l JOIN verified_membership m ON m.character_id=l.character_id
        AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE l.user_id=users.id AND l.character_id IN (${marks}))=?`)
      .bind(char.id,at,user.id,user.ownership_checked,user.token_hash,...wanted,wanted.length)];
    if(selected){
      const ids=user.characters.map(character=>character.id),chosen=[...selected];
      statements.push(env.DB.prepare(`UPDATE character_links SET show_as_alt=CASE WHEN ${chosen.length?'character_id IN ('+chosen.map(()=>'?').join(',')+')':'0'} THEN 1 ELSE 0 END
        WHERE user_id=? AND character_id IN (${ids.map(()=>'?').join(',')}) AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.main_character_id=? AND u.updated_at=?)`)
        .bind(...chosen,user.id,...ids,user.id,char.id,at));
    }
    const [saved]=await env.DB.batch(statements);if(!changed(saved))throw new WebError('Character ownership changed; refresh the page before saving your main and alts',403);
    return {message:'Your main and alt choices were saved',account_updated_at:at};
  }
  if(path==='/api/hall/profile'){
    const char=ownCharacter(user,body.character_id);
    await env.DB.prepare(`INSERT INTO character_profiles(character_id,user_id,title,biography,looking_for,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(character_id) DO UPDATE SET user_id=excluded.user_id,title=excluded.title,biography=excluded.biography,looking_for=excluded.looking_for,updated_at=excluded.updated_at`)
      .bind(char.id,user.id,text(body.title||'',80),text(body.biography||'',1500),text(body.looking_for||'',300),stamp()).run();return {message:'Roleplay profile saved for guild members'};
  }
  if(path==='/api/hall/requests'){
    const char=ownCharacter(user,body.character_id),kind=choice(body.kind,['craft','learn']);
    const limit=kind==='craft'?20:100,quotaMessage=kind==='craft'?'Complete or cancel an existing request before opening more than 20 crafting requests.':'Remove or complete an existing wishlist entry before opening more than 100 entries.';
    const active=await env.DB.prepare("SELECT COUNT(*) count FROM requests WHERE owner_id=? AND kind=? AND status IN ('open','claimed')").bind(user.id,kind).first();
    if(active.count>=limit)throw new WebError(quotaMessage,429);
    const id=body.recipe_id?integer(body.recipe_id,1,2147483647):null;
    const name=id?await recipeName(env,id):text(body.item_name,100,3);
    const crafts=kind==='craft'?integer(body.quantity??1,1,200):1;
    let plan=null;
    if(kind==='craft'){
      if(id)plan=await materialPlan(env,id,crafts,body.component_choices||{},body.expand_components!==false);
      if(!plan||plan.status!=='verified'){
        if(typeof body.manual_materials!=='string'||body.manual_materials.trim().length<3)throw new WebError('Choose a recipe with verified requirements or enter the total materials manually');
        const manual=text(body.manual_materials,1200,3);
        plan={status:'member_provided',crafts,manual,observed_at:stamp(),note:'Member-supplied totals; not verified by Blizzard'};
      }
    }
    const targetIds=kind==='craft'?await chosenCrafters(env,id,body.target_character_ids||[]):[];
    const row={recipient_mode:'selected',target_character_ids:targetIds,id:crypto.randomUUID(),kind,owner_id:user.id,character_id:char.id,recipe_id:id,item_name:name,quantity:crafts,recipient_name:char.name,updated_at:stamp()};
    const notifications=await requestNotifications(env,row,'created');
    const [created]=await env.DB.batch([env.DB.prepare(`INSERT INTO requests(id,kind,owner_id,character_id,recipe_id,item_name,quantity,materials,notes,status,created_at,updated_at,materials_json,recipient_mode,recipient_name) SELECT ?,?,?,?,?,?,?,?,?,'open',?,?,?,'selected',? WHERE (SELECT COUNT(*) FROM requests WHERE owner_id=? AND kind=? AND status IN ('open','claimed'))<?`)
      .bind(row.id,kind,user.id,char.id,id,name,crafts,
        choice(body.materials||'discuss',['provided','need_help','discuss']),text(body.notes||'',600),row.updated_at,row.updated_at,plan?JSON.stringify(plan):null,row.recipient_name,user.id,kind,limit),...targetIds.map(cid=>env.DB.prepare('INSERT INTO request_targets SELECT ?,? WHERE EXISTS(SELECT 1 FROM requests WHERE id=?)').bind(row.id,cid,row.id)),...notifications]);
    if(!changed(created))throw new WebError(quotaMessage,429);
    return {message:kind==='craft'?'Crafting request posted':'Recipe wishlist entry added'};
  }
  const requestMatch=path.match(/^\/api\/hall\/requests\/([a-f0-9-]{36})$/);
  if(requestMatch){
    const row=await env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(requestMatch[1]).first();if(!row)throw new WebError('Request not found',404);
    const change=crypto.randomUUID(),changedAt=stamp();let statement;
    if(body.action==='claim'&&row.kind==='craft')statement=env.DB.prepare("UPDATE requests SET status='claimed',crafter_id=?,updated_at=?,change_id=? WHERE id=? AND status='open'").bind(user.id,changedAt,change,row.id);
    else if(body.action==='complete'&&(row.owner_id===user.id||(row.kind==='craft'&&row.crafter_id===user.id)))statement=env.DB.prepare("UPDATE requests SET status='complete',updated_at=?,change_id=? WHERE id=? AND status IN ('open','claimed')").bind(changedAt,change,row.id);
    else if(body.action==='cancel'&&row.owner_id===user.id)statement=env.DB.prepare("UPDATE requests SET status='cancelled',updated_at=?,change_id=? WHERE id=? AND status IN ('open','claimed')").bind(changedAt,change,row.id);
    else if(body.action==='release'&&row.crafter_id===user.id)statement=env.DB.prepare("UPDATE requests SET status='open',crafter_id=NULL,updated_at=?,change_id=? WHERE id=? AND crafter_id=? AND status='claimed'").bind(changedAt,change,row.id,user.id);
    else throw new WebError('You cannot make that change to this request',403);
    const notifications=await requestNotifications(env,{...row,updated_at:changedAt,change_id:change},body.action);
    const [result]=await env.DB.batch([statement,...notifications]);
    if(!changed(result))throw new WebError('This request changed. Refresh the guild hall and try again.',409);
    return {message:'Request updated'};
  }
  if(path==='/api/hall/events'){
    const char=ownCharacter(user,body.character_id),starts=new Date(body.starts_at);
    const quotaMessage='Finish or cancel an existing event before planning more than 5 active events.';
    const active=await env.DB.prepare("SELECT COUNT(*) count FROM events WHERE owner_id=? AND status='open' AND datetime(starts_at,'+'||duration_minutes||' minutes')>datetime('now')").bind(user.id).first();
    if(active.count>=5)throw new WebError(quotaMessage,429);
    if(!Number.isFinite(starts.valueOf())||starts.valueOf()<Date.now()-3600000||starts.valueOf()>Date.now()+365*86400000)throw new WebError('Choose an event time within the next year');
    const settings=eventTemplateSettings(body),id=crypto.randomUUID(),duration=integer(body.duration_minutes??settings.template_guidance?.duration_minutes??120,15,720),kind=settings.kind;
    if(['Dungeon','Raid'].includes(kind)&&starts.valueOf()<Date.now()+60000)throw new WebError('Choose a dungeon or raid start time at least one minute ahead');
    const statements=[env.DB.prepare("INSERT INTO events(id,owner_id,character_id,title,kind,description,location,starts_at,capacity,created_at,duration_minutes,role_limits_json,template_id,template_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM events WHERE owner_id=? AND status='open' AND datetime(starts_at,'+'||duration_minutes||' minutes')>datetime('now'))<5")
      .bind(id,user.id,char.id,text(body.title??settings.template_guidance?.name,100,3),kind,text(body.description||'',1000),text(body.location??settings.template_guidance?.location??'',100),starts.toISOString(),settings.capacity,stamp(),duration,settings.role_limits?JSON.stringify(settings.role_limits):null,settings.template_id,settings.template_guidance?JSON.stringify(settings.template_guidance):null,user.id)];
    if(['Dungeon','Raid'].includes(kind)&&await discordReady(env))statements.push(outboxStatement(env,'event:'+id+':create','event',id,null,{}));
    const config=await discordConfig(env);if(await discordReady(env))statements.push(eventTargetStatement(env,id,config));
    if(config.events_channel_id&&await discordReady(env))statements.push(outboxStatement(env,'event-post:'+id+':create','event_post',id,null,{}));
    const [created]=await env.DB.batch(statements);if(!changed(created))throw new WebError(quotaMessage,429);
    return {message:statements.length>1?'Event created. Discord updates are queued.':'Event created'};
  }
  const eventMatch=path.match(/^\/api\/hall\/events\/([a-f0-9-]{36})$/);
  if(eventMatch){
    const event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(eventMatch[1]).first();if(!event)throw new WebError('Event not found',404);
    if(body.action==='cancel'||body.action==='remove'){
      if(event.owner_id!==user.id)throw new WebError('Only the host can cancel this event',403);
      if(event.status==='cancelled')return {message:'This event is already cancelled.'};
      const statements=[env.DB.prepare("UPDATE events SET status='cancelled' WHERE id=?").bind(event.id),eventCleanupStatement(env,event.id)];
      await env.DB.batch(statements);return {message:'Event cancelled. Its Discord announcement and event are queued for deletion; website history is retained.'};
    }
    if(body.action==='leave'){
      const previous=await env.DB.prepare('SELECT user_id FROM event_signups WHERE event_id=? AND user_id=?').bind(event.id,user.id).first();
      if(!previous)return {message:'You are not signed up for this event.'};
      const statements=[env.DB.prepare('DELETE FROM event_signups WHERE event_id=? AND user_id=?').bind(event.id,user.id),env.DB.prepare("UPDATE discord_event_reactions SET handled=1,result='removed' WHERE event_id=? AND user_id=?").bind(event.id,user.id)],config=await discordConfig(env);
      if(config.events_channel_id&&await discordReady(env))statements.push(outboxStatement(env,'event-post:'+event.id+':leave:'+crypto.randomUUID(),'event_post',event.id,null,{}));
      await env.DB.batch(statements);return {message:'Your sign-up was removed'};
    }
    if(body.action!=='join')throw new WebError('Choose a valid action');
    const allowed=['Dungeon','Raid'].includes(event.kind)?['Tank','Healer','Damage']:event.kind==='Roleplay'?['Roleplay','Social']:['Tank','Healer','Damage','Roleplay','Social'];
    const char=ownCharacter(user,body.character_id),role=choice(body.role,allowed),note=text(body.note||'',200);
    if(eventInactive(event))throw new WebError('This role or event is full, or the event was cancelled',409);
    const previous=await env.DB.prepare('SELECT character_id,role,note,source FROM event_signups WHERE event_id=? AND user_id=?').bind(event.id,user.id).first();
    if(previous?.source==='web'&&previous.character_id===char.id&&previous.role===role&&previous.note===note)return {message:'Your event sign-up is already saved.'};
    const statements=[signupStatement(env,event,user.id,char.id,role,note,'web'),env.DB.prepare("UPDATE discord_event_reactions SET handled=1,result='confirmed' WHERE event_id=? AND user_id=? AND EXISTS(SELECT 1 FROM event_signups WHERE event_id=? AND user_id=? AND character_id=? AND role=? AND source='web')").bind(event.id,user.id,event.id,user.id,char.id,role)],config=await discordConfig(env);
    if(config.events_channel_id&&await discordReady(env))statements.push(outboxStatement(env,'event-post:'+event.id+':join:'+crypto.randomUUID(),'event_post',event.id,null,{}));
    const [result]=await env.DB.batch(statements);
    if(!changed(result))throw new WebError('This role or event is full, or the event was cancelled',409);
    return {message:'Event sign-up saved'};
  }
  throw new WebError('Not found',404);
}
