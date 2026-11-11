const SECONDS_PER_DAY = 86400;

export function signInStatements(env, userId, signedInAt) {
  return [
    env.DB.prepare(`INSERT INTO site_last_sign_in(user_id,signed_in_at) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET signed_in_at=excluded.signed_in_at,recovered=0
      WHERE excluded.signed_in_at>=site_last_sign_in.signed_in_at`).bind(userId, signedInAt),
    env.DB.prepare(`INSERT INTO site_daily_traffic(day,sign_ins) VALUES(date(?,'unixepoch'),1)
      ON CONFLICT(day) DO UPDATE SET sign_ins=site_daily_traffic.sign_ins+1`).bind(signedInAt)
  ];
}

export function isDocumentView(request, response) {
  if (request.method !== 'GET' || response.status !== 200) return false;
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('text/html')) return false;
  const destination = request.headers.get('Sec-Fetch-Dest');
  const mode = request.headers.get('Sec-Fetch-Mode');
  const purpose = request.headers.get('Sec-Purpose') || request.headers.get('Purpose') || '';
  return destination === 'document' && mode === 'navigate' && !/prefetch|prerender/i.test(purpose);
}

export function recordDocumentView(env, page) {
  const welcome = page === 'welcome' ? 1 : 0;
  return env.DB.prepare(`INSERT INTO site_daily_traffic(day,welcome_views,guild_views)
    VALUES(date('now'),?,?) ON CONFLICT(day) DO UPDATE SET
      welcome_views=site_daily_traffic.welcome_views+excluded.welcome_views,
      guild_views=site_daily_traffic.guild_views+excluded.guild_views`)
    .bind(welcome, 1 - welcome).run();
}

function utcDate(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

export async function siteAnalytics(env, now) {
  const today = utcDate(now);
  const start7 = utcDate(now - 6 * SECONDS_PER_DAY);
  const start30 = utcDate(now - 29 * SECONDS_PER_DAY);
  const [start, traffic, accounts] = await Promise.all([
    env.DB.prepare("SELECT json_extract(value,'$') started_at FROM state WHERE key='site_analytics_started_at'").first(),
    env.DB.prepare(`SELECT day,welcome_views,guild_views,sign_ins FROM site_daily_traffic
      WHERE day BETWEEN ? AND ?`).bind(start30, today).all(),
    env.DB.prepare(`WITH ranked_names AS (
      SELECT l.user_id,json_extract(m.data,'$.name') character_name,
        ROW_NUMBER() OVER(PARTITION BY l.user_id ORDER BY (l.character_id=u.main_character_id) DESC,m.slug) position
      FROM character_links l JOIN users u ON u.id=l.user_id
      JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
    )
    SELECT COALESCE(r.character_name,(
      SELECT json_extract(m.data,'$.name') FROM membership m WHERE m.character_id=u.main_character_id
      ORDER BY json_extract(m.data,'$.roster_observed') DESC LIMIT 1
    )) character_name,u.created_at account_created_at,s.signed_in_at,s.recovered
    FROM users u LEFT JOIN ranked_names r ON r.user_id=u.id AND r.position=1
    LEFT JOIN site_last_sign_in s ON s.user_id=u.id
    WHERE u.ownership_status<>'admin_mapped'
    ORDER BY s.signed_in_at DESC,character_name COLLATE NOCASE,u.created_at DESC`).all()
  ]);
  const periods = [today, start7, start30].map(from => {
    const totals = {welcome_views: 0, guild_views: 0, sign_ins: 0, accounts_signed_in: 0};
    for (const day of traffic.results) {
      if (day.day < from) continue;
      totals.welcome_views += day.welcome_views;
      totals.guild_views += day.guild_views;
      totals.sign_ins += day.sign_ins;
    }
    const since = Date.parse(from) / 1000;
    totals.accounts_signed_in = accounts.results.filter(row => row.recovered === 0 && row.signed_in_at >= since && row.signed_in_at <= now).length;
    return totals;
  });
  return {
    started_at: start?.started_at ?? null,
    today: periods[0],
    last_7_days: periods[1],
    last_30_days: periods[2],
    accounts: accounts.results.map(row => ({
      character_name: row.character_name,
      account_created_at: row.account_created_at,
      last_sign_in_at: row.signed_in_at ? new Date(row.signed_in_at * 1000).toISOString() : null
    }))
  };
}
