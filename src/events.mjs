export function roleLimits(event){try{return JSON.parse(event.role_limits_json||'null');}catch{return null;}}
export function eventInactive(event,now=Date.now()){
  const end=Date.parse(event?.starts_at)+(Number(event?.duration_minutes)||120)*60000;
  return !event||event.status!=='open'||!Number.isFinite(end)||end<=now;
}
export function eventTargetStatement(env,id,config,channel=config.events_channel_id||''){
  return env.DB.prepare('INSERT OR IGNORE INTO state(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM events WHERE id=?)').bind('discord_event_target:'+id,JSON.stringify({guild_id:config.guild_id,application_id:config.client_id,channel_id:channel}),id);
}
export function eventCleanupStatement(env,id){
  return env.DB.prepare(`INSERT INTO discord_outbox(id,kind,reference_id,user_id,payload,created_at) VALUES(?,'event_cleanup',?,NULL,'{}',?)
    ON CONFLICT(id) DO UPDATE SET status='pending',next_at=0,last_error=NULL WHERE discord_outbox.status IN ('sent','skipped','failed')`)
    .bind('event-cleanup:'+id,id,new Date().toISOString());
}
export function signupStatement(env,event,userId,characterId,role,note='',source='web'){
  const limits=roleLimits(event),cap=limits?(limits[role]??0):event.capacity;
  return env.DB.prepare(`INSERT INTO event_signups(event_id,user_id,character_id,role,note,updated_at,source)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM events WHERE id=? AND status='open' AND datetime(starts_at,'+'||duration_minutes||' minutes')>datetime('now'))
    AND (EXISTS(SELECT 1 FROM character_links l JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE l.user_id=? AND l.character_id=?) OR (?='discord' AND EXISTS(SELECT 1 FROM admin_discord_mappings a JOIN verified_membership m ON m.character_id=a.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE a.participant_user_id=? AND a.character_id=? AND NOT EXISTS(SELECT 1 FROM character_links l WHERE l.character_id=a.character_id AND l.user_id<>a.participant_user_id) AND NOT EXISTS(SELECT 1 FROM discord_links d WHERE (d.discord_id=a.discord_id AND d.user_id<>a.participant_user_id) OR (d.user_id=a.participant_user_id AND d.discord_id<>a.discord_id)))))
    AND NOT EXISTS(SELECT 1 FROM event_signups WHERE event_id=? AND character_id=? AND user_id<>?)
    AND (SELECT COUNT(*) FROM event_signups WHERE event_id=? AND user_id<>?)<?
    AND (SELECT COUNT(*) FROM event_signups WHERE event_id=? AND role=? AND user_id<>?)<?
    ON CONFLICT(event_id,user_id) DO UPDATE SET character_id=excluded.character_id,role=excluded.role,note=excluded.note,updated_at=excluded.updated_at,source=excluded.source`)
    .bind(event.id,userId,characterId,role,note,new Date().toISOString(),source,event.id,userId,characterId,source,userId,characterId,event.id,characterId,userId,event.id,userId,event.capacity,event.id,role,userId,cap);
}
