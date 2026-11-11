import {currentUser,requireMember,requireAdmin} from './auth.mjs';
import {siteAnalytics} from './site-analytics.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const count=value=>Number.isSafeInteger(value)&&value>0?value:0;
const asState=row=>{try{return row?JSON.parse(row.value):null;}catch{return null;}};

// This is part of the same transaction as chronicle changes and publication.
// There is no completed-import record for a partial/failed staging attempt.
export function syncHistoryStatements(env,{generation,previous,owner,observedAt,startedAt,completedAt}){
  const duration=Math.max(0,Date.parse(completedAt)-Date.parse(startedAt||observedAt));
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO roster_imports(generation,observed_at,completed_at,duration_ms,member_count,joined,departed,level_changes,rank_changes,baseline)
      SELECT ?,?,?,?,
        (SELECT COUNT(*) FROM membership n WHERE n.generation=?),
        CASE WHEN ?='' THEN 0 ELSE (SELECT COUNT(*) FROM membership n WHERE n.generation=? AND NOT EXISTS(SELECT 1 FROM membership o WHERE o.generation=? AND o.character_id=n.character_id)) END,
        CASE WHEN ?='' THEN 0 ELSE (SELECT COUNT(*) FROM membership o WHERE o.generation=? AND NOT EXISTS(SELECT 1 FROM membership n WHERE n.generation=? AND n.character_id=o.character_id)) END,
        (SELECT COUNT(*) FROM activity a WHERE a.kind='level' AND a.id IN (SELECT 'roster-level:'||?||':'||n.character_id FROM membership n WHERE n.generation=?)),
        (SELECT COUNT(*) FROM membership n JOIN membership o ON o.character_id=n.character_id AND o.generation=?
          WHERE n.generation=? AND json_type(n.data,'$.rank')='integer' AND json_type(o.data,'$.rank')='integer' AND json_extract(n.data,'$.rank')<>json_extract(o.data,'$.rank')),
        CASE WHEN ?='' THEN 1 ELSE 0 END
      WHERE EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`)
      .bind(generation,observedAt,completedAt,Number.isFinite(duration)?duration:0,generation,
        previous||'',generation,previous||'',previous||'',previous||'',generation,
        generation,generation,previous||'',generation,previous||'',owner,generation),
    env.DB.prepare(`DELETE FROM roster_imports WHERE generation NOT IN (SELECT generation FROM roster_imports ORDER BY completed_at DESC,generation DESC LIMIT 100)
      AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`).bind(owner,generation)
  ];
}

export async function adminOverview(request,env){
  const user=await currentUser(request,env);requireMember(user);requireAdmin(user);
  const now=epoch(),checkedAt=new Date().toISOString();
  const [sync,stateRows,counts,queue,provider,discordQueue,imports,analytics]=await Promise.all([
    env.DB.prepare('SELECT phase,status,roster_at,completed_at,next_at,updated FROM sync WHERE id=1').first(),
    env.DB.prepare("SELECT key,value FROM state WHERE key IN ('scheduler','blizzard_cooldown','discord_pause','discord_config')").all(),
    env.DB.prepare(`WITH current_accounts AS (
      SELECT u.id FROM users u WHERE u.ownership_status='verified' AND u.ownership_checked>? AND u.ownership_checked<=?
        AND EXISTS(SELECT 1 FROM character_links l JOIN verified_membership m ON m.character_id=l.character_id
          WHERE l.user_id=u.id AND m.generation=(SELECT published FROM sync WHERE id=1)))
      SELECT (SELECT COUNT(*) FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1)) characters,
        (SELECT COUNT(*) FROM membership WHERE generation=(SELECT published FROM sync WHERE id=1)) roster_characters,
        (SELECT COUNT(*) FROM users WHERE ownership_status<>'admin_mapped') site_accounts,
        (SELECT COUNT(*) FROM current_accounts) current_member_accounts,
        (SELECT COUNT(*) FROM current_accounts a JOIN discord_links d ON d.user_id=a.id) discord_linked_accounts,
        (SELECT COUNT(*) FROM verified_membership m WHERE m.generation=(SELECT published FROM sync WHERE id=1)
          AND NOT EXISTS(SELECT 1 FROM character_links l JOIN current_accounts a ON a.id=l.user_id WHERE l.character_id=m.character_id)) unclaimed_characters`)
      .bind(now-86400,now+60).first(),
    env.DB.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN COALESCE(q.next_at,0)<=? THEN 1 ELSE 0 END) due,
      SUM(CASE WHEN q.next_at>? THEN 1 ELSE 0 END) waiting,
      SUM(CASE WHEN json_extract(c.data,'$.profile_availability')='not_published' THEN 1 ELSE 0 END) unpublished,
      SUM(CASE WHEN json_extract(c.data,'$.profile_status')='stale' OR json_extract(c.data,'$.professions_status')='stale' OR json_extract(c.data,'$.talents_status')='stale' THEN 1 ELSE 0 END) stale,
      SUM(CASE WHEN q.failures>0 THEN 1 ELSE 0 END) failures,
      MIN(q.next_at) next_at
      FROM verified_membership m LEFT JOIN character_refresh q ON q.character_id=m.character_id LEFT JOIN characters c ON c.id=m.character_id
      WHERE m.generation=(SELECT published FROM sync WHERE id=1)`).bind(now,now).first(),
    env.DB.prepare("SELECT MAX(attempted) last_attempt_at,MAX(succeeded) last_success_at,SUM(CASE WHEN status='unavailable' THEN 1 ELSE 0 END) failed_endpoints FROM evidence").first(),
    env.DB.prepare("SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) delivered FROM discord_outbox").first(),
    env.DB.prepare('SELECT observed_at,completed_at,duration_ms,member_count,joined,departed,level_changes,rank_changes,baseline FROM roster_imports ORDER BY completed_at DESC,generation DESC LIMIT 20').all(),
    siteAnalytics(env,now)
  ]);
  const states=new Map(stateRows.results.map(row=>[row.key,asState(row)])),scheduler=states.get('scheduler'),discord=states.get('discord_config')||{};
  const completed=date(scheduler?.last_completed),schedulerAge=completed?Date.now()-Date.parse(completed):null;
  const configured=Boolean(env.BLIZZARD_CLIENT_ID&&env.BLIZZARD_CLIENT_SECRET),paused=Number(states.get('blizzard_cooldown'))>now;
  const discordConfigured=Boolean(env.DISCORD_BOT_TOKEN&&env.DISCORD_CLIENT_SECRET&&(env.DISCORD_CLIENT_ID||discord.client_id)&&(env.DISCORD_GUILD_ID||discord.guild_id));
  const schedulerStatus=!completed||schedulerAge< -60000?'unknown':schedulerAge>5*60000?'delayed':'healthy';
  const attention=[];
  if(!configured)attention.push({kind:'blizzard_configuration',severity:'warning',title:'Connect the Battle.net API client'});
  if(schedulerStatus!=='healthy')attention.push({kind:'scheduler',severity:'warning',title:completed?'Background jobs have not completed recently':'No completed background job has been observed'});
  if(paused)attention.push({kind:'blizzard_pause',severity:'info',title:'Blizzard requested a temporary pause'});
  if(count(queue?.unpublished))attention.push({kind:'unpublished_profiles',severity:'info',title:'Characters waiting for Blizzard to publish profiles',count:count(queue.unpublished)});
  if(count(queue?.stale))attention.push({kind:'stale_observations',severity:'warning',title:'Characters retaining older detail observations',count:count(queue.stale)});
  if(count(discordQueue?.failed))attention.push({kind:'discord_delivery',severity:'warning',title:'Discord deliveries need attention',count:count(discordQueue.failed)});
  const missingDiscord=Math.max(0,count(counts?.current_member_accounts)-count(counts?.discord_linked_accounts));
  if(missingDiscord)attention.push({kind:'discord_unlinked',severity:'info',title:'Verified member accounts without linked Discord',count:missingDiscord});
  return {checked_at:checkedAt,analytics,
    health:{blizzard:{configured,status:!configured?'not_configured':paused?'paused':count(provider?.failed_endpoints)?'limited':provider?.last_success_at?'observed':'unknown',last_success_at:date(provider?.last_success_at),last_attempt_at:date(provider?.last_attempt_at),failed_endpoints:count(provider?.failed_endpoints)},
      scheduler:{status:schedulerStatus,last_completed_at:completed},
      roster:{status:sync?.phase==='stage'?'importing':sync?.roster_at?'published':'waiting',observed_at:date(sync?.roster_at),completed_at:date(sync?.completed_at)},
      discord:{configured:discordConfigured,status:!discordConfigured?'not_configured':count(discordQueue?.failed)?'needs_attention':'configured',pending:count(discordQueue?.pending),failed:count(discordQueue?.failed),delivered:count(discordQueue?.delivered),last_delivered_at:null},
      backups:{status:'managed_by_host',note:'Backup availability is managed by the hosting platform; no restore check is performed here.'}},
    counts:{characters:count(counts?.characters),roster_characters:count(counts?.roster_characters),profile_verified_characters:Math.max(0,count(counts?.characters)-count(counts?.roster_characters)),site_accounts:count(counts?.site_accounts),current_member_accounts:count(counts?.current_member_accounts),discord_linked_accounts:count(counts?.discord_linked_accounts),members_without_discord:missingDiscord,unclaimed_characters:count(counts?.unclaimed_characters)},
    refresh:{due:count(queue?.due),waiting:count(queue?.waiting),unpublished:count(queue?.unpublished),stale:count(queue?.stale),failures:count(queue?.failures),next_at:queue?.next_at>0?new Date(queue.next_at*1000).toISOString():null},
    attention,imports:imports.results.map(row=>({...row,left:row.departed,baseline:Boolean(row.baseline),status:'published'})),
    import_history_note:'The latest 20 completed roster imports are shown; up to 100 are retained. History starts when this feature was installed. Joins and departures describe differences in Blizzard’s returned roster, not exact in-game times. Profile-only checks continue separately.'};
}
