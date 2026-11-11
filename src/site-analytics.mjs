const SECONDS_PER_DAY = 86400;

export function signInStatements(env, userId, signedInAt, battleNetId, battleTag = null) {
  return [
    env.DB.prepare(`INSERT INTO site_battlenet_identities(user_id,account_id,battle_tag) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET account_id=excluded.account_id,recovery_pending=0,
      battle_tag=COALESCE(excluded.battle_tag,site_battlenet_identities.battle_tag)`).bind(userId,battleNetId,battleTag),
    env.DB.prepare('INSERT INTO site_sign_in_history(user_id,signed_in_at) VALUES(?,?)').bind(userId,signedInAt),
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
    env.DB.prepare(`SELECT s.signed_in_at FROM site_last_sign_in s
      JOIN users u ON u.id=s.user_id WHERE u.ownership_status<>'admin_mapped' AND s.recovered=0
      AND s.signed_in_at BETWEEN ? AND ?`).bind(Date.parse(start30)/1000,now).all()
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
    totals.accounts_signed_in = accounts.results.filter(row => row.signed_in_at >= since).length;
    return totals;
  });
  return {
    started_at: start?.started_at ?? null,
    today: periods[0],
    last_7_days: periods[1],
    last_30_days: periods[2]
  };
}
