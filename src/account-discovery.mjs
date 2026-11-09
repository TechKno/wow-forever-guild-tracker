import {digest,stamp} from './auth.mjs';
const epoch=()=>Math.floor(Date.now()/1000);

// Ownership comes only from a recent authenticated account reply. The public
// guild roster supplies membership; it cannot identify an account by itself.
export async function discoverRosterAccounts(env){
  const now=epoch();
  await env.DB.prepare('DELETE FROM account_character_ownership WHERE expires_at<=?').bind(now).run();
  const sync=await env.DB.prepare('SELECT published FROM sync WHERE id=1').first();
  if(!sync?.published)return {linked:0,queued:0};
  const linked=await env.DB.prepare(`INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt)
    SELECT a.character_id,a.user_id,strftime('%Y-%m-%dT%H:%M:%fZ',a.checked_at,'unixepoch'),1
    FROM account_character_ownership a JOIN users u ON u.id=a.user_id
    JOIN membership m ON m.character_id=a.character_id AND m.generation=?
    LEFT JOIN character_links l ON l.character_id=a.character_id
    WHERE a.expires_at>? AND a.checked_at<=? AND u.ownership_status='verified'
      AND u.ownership_checked>=a.checked_at AND u.ownership_checked>? AND u.ownership_checked<=?
      AND NOT EXISTS(SELECT 1 FROM membership_departures d WHERE d.character_id=a.character_id)
      AND (l.character_id IS NULL OR (l.user_id<>a.user_id AND COALESCE(julianday(l.verified_at),0)<julianday(a.checked_at,'unixepoch')))
      AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND published=?)
    ON CONFLICT(character_id) DO UPDATE SET user_id=excluded.user_id,verified_at=excluded.verified_at,show_as_alt=1
      WHERE character_links.user_id<>excluded.user_id AND COALESCE(julianday(character_links.verified_at),0)<julianday(excluded.verified_at)
    RETURNING user_id`).bind(sync.published,now,now,now-86400,now+60,sync.published).all();
  if(linked.results.length){
    const at=stamp(),users=[...new Set(linked.results.map(row=>row.user_id))];
    await env.DB.prepare(`UPDATE users SET updated_at=CASE WHEN COALESCE(julianday(updated_at),0)>=julianday(?)
      THEN strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at)+1.0/86400000) ELSE ? END WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(at,at,JSON.stringify(users)).run();
  }
  const [roster,previous]=await Promise.all([
    env.DB.prepare(`SELECT m.character_id,l.character_id linked FROM membership m LEFT JOIN character_links l ON l.character_id=m.character_id
      WHERE m.generation=? ORDER BY m.character_id`).bind(sync.published).all(),
    env.DB.prepare("SELECT value FROM state WHERE key='account_discovery_seen_roster'").first()
  ]);
  let seen=new Set();try{const ids=JSON.parse(previous?.value||'[]');if(Array.isArray(ids))seen=new Set(ids.filter(Number.isSafeInteger));}catch{}
  const ids=roster.results.map(row=>row.character_id),arrivals=roster.results.filter(row=>!row.linked&&!seen.has(row.character_id)).map(row=>row.character_id);
  const statements=[];
  if(arrivals.length){
    const revision=await digest('guild-account-arrivals:'+sync.published+':'+JSON.stringify(arrivals));
    statements.push(env.DB.prepare(`UPDATE account_refresh SET requested_revision=?,next_at=MIN(next_at,?)
      WHERE encrypted_credential IS NOT NULL AND expires_at>? AND EXISTS(SELECT 1 FROM users u WHERE u.id=account_refresh.user_id AND u.ownership_status='verified')
        AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=account_refresh.user_id AND s.expires>?)
        AND EXISTS(SELECT 1 FROM sync WHERE id=1 AND published=?)`).bind(revision,now,now,now,sync.published));
  }
  statements.push(env.DB.prepare(`INSERT INTO state(key,value) SELECT 'account_discovery_seen_roster',?
    WHERE EXISTS(SELECT 1 FROM sync WHERE id=1 AND published=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(ids),sync.published));
  const results=await env.DB.batch(statements);
  return {linked:linked.results.length,queued:arrivals.length?Number(results[0]?.meta?.changes??results[0]?.changes??0):0};
}
