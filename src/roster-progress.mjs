const level=(data,path)=>`CASE WHEN json_type(${data},'${path}')='integer' AND json_extract(${data},'${path}')>0 THEN json_extract(${data},'${path}') ELSE 0 END`;

// Called only in the atomic batch that publishes a complete, validated roster.
// A character profile is optional: low-level characters can have roster levels
// for a long time before Blizzard publishes their individual profile.
export function rosterProgressStatements(env,{generation,previous,owner,observedAt}){
  const comparisons=`WITH comparisons AS (
    SELECT n.character_id,json_extract(n.data,'$.name') name,${level('n.data','$.level')} returned_level,
      MAX(${level('o.data','$.level')},
        CASE WHEN json_extract(c.data,'$.profile_at') IS NOT NULL OR json_extract(c.data,'$.profile_status')='verified' THEN ${level('c.data','$.profile.level')} ELSE 0 END,
        COALESCE((SELECT MAX(${level('h.data','$.level')}) FROM snapshots h WHERE h.character_id=n.character_id),0)) previous_level,
      EXISTS(SELECT 1 FROM snapshots h WHERE h.character_id=n.character_id AND ${level('h.data','$.level')}>0) saved_level
    FROM membership n LEFT JOIN membership o ON o.character_id=n.character_id AND o.generation=?
      LEFT JOIN characters c ON c.id=n.character_id
    WHERE n.generation=? AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')
  )`;
  const statements=[];
  if(previous)statements.push(env.DB.prepare(`INSERT OR IGNORE INTO activity(id,character_id,kind,title,detail,observed_at)
    SELECT 'joined:'||?||':'||n.character_id,n.character_id,'joined',json_extract(n.data,'$.name')||' appeared in the guild roster',
      'First observed in this returned guild roster; this is not an exact in-game join time',?
    FROM membership n WHERE n.generation=?
      AND NOT EXISTS(SELECT 1 FROM membership o WHERE o.generation=? AND o.character_id=n.character_id)
      AND NOT EXISTS(SELECT 1 FROM activity a WHERE a.character_id=n.character_id AND a.kind='joined'
        AND a.observed_at>=COALESCE((SELECT MAX(l.observed_at) FROM activity l WHERE l.character_id=n.character_id AND l.kind='left'),''))
      AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND lease=? AND generation=? AND phase='stage')`)
    .bind(generation,observedAt,generation,previous,owner,generation));
  statements.push(env.DB.prepare(comparisons+` INSERT OR IGNORE INTO activity(id,character_id,kind,title,detail,observed_at)
    SELECT 'roster-level:'||?||':'||character_id,character_id,'level',name||' reached level '||returned_level,
      'Previously observed at level '||previous_level||' · Blizzard guild roster',?
    FROM comparisons WHERE returned_level>previous_level AND previous_level>0`)
    .bind(previous||'',generation,owner,generation,generation,observedAt));
  statements.push(env.DB.prepare(comparisons+` INSERT OR IGNORE INTO snapshots(character_id,observed_at,data)
    SELECT character_id,?,json_object('level',MAX(returned_level,previous_level),'level_source',CASE WHEN returned_level>=previous_level THEN 'roster' ELSE 'retained' END,
      'level_observed_at',?,'profile_observed_at',NULL,'professions',NULL,'professions_observed_at',NULL,
      'change_schema',1,'changes',json_array(CASE WHEN returned_level>previous_level AND previous_level>0 THEN 'Level: '||previous_level||' → '||returned_level ELSE 'Level first observed: '||MAX(returned_level,previous_level) END),
      'baseline',json(CASE WHEN returned_level>previous_level AND previous_level>0 THEN 'false' ELSE 'true' END),
      'observation_events_schema',1,'observation_events',json_array(json_object(
        'kind',CASE WHEN returned_level>previous_level AND previous_level>0 THEN 'level' ELSE 'baseline' END,
        'title',CASE WHEN returned_level>previous_level AND previous_level>0 THEN 'Level: '||previous_level||' → '||returned_level ELSE 'Recorded baseline' END,
        'detail',CASE WHEN returned_level>previous_level AND previous_level>0 THEN 'Blizzard guild roster' ELSE 'Level '||MAX(returned_level,previous_level)||' · '||CASE WHEN returned_level>=previous_level THEN 'Blizzard guild roster' ELSE 'Previously verified character data' END END,
        'baseline',json(CASE WHEN returned_level>previous_level AND previous_level>0 THEN 'false' ELSE 'true' END))))
    FROM comparisons WHERE returned_level>0 AND (returned_level>previous_level OR NOT saved_level)`)
    .bind(previous||'',generation,owner,generation,observedAt,observedAt));
  return statements;
}

export function profileJoinedStatement(env,userId){
  return env.DB.prepare(`INSERT OR IGNORE INTO activity(id,character_id,kind,title,detail,observed_at)
    SELECT 'joined:'||m.character_id,m.character_id,'joined',json_extract(m.data,'$.name')||' was verified in the guild',
      'First verified through Battle.net ownership and a matching guild profile; this is not an exact in-game join time',json_extract(m.data,'$.membership_verified_at')
    FROM verified_membership m JOIN sync s ON s.id=1 AND m.generation=s.published
      JOIN profile_members p ON p.character_id=m.character_id AND p.data=m.data
    WHERE p.user_id=? AND json_extract(m.data,'$.membership_source')='character_profile'
      AND NOT EXISTS(SELECT 1 FROM activity a WHERE a.character_id=m.character_id AND a.kind='joined')`)
    .bind(userId);
}
