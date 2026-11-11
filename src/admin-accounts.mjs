import {activeManualMappings} from './admin-mappings.mjs';
import {displayManualMappings} from './discord-people.mjs';

const isoTime = value => Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000).toISOString() : null;

export async function adminAccounts(env) {
  const [accounts, roster, history, activeMappings] = await Promise.all([
    env.DB.prepare(`SELECT u.id,u.main_character_id,u.created_at,b.account_id battle_net_id,
      d.discord_id,s.signed_in_at,(
        SELECT json_extract(m.data,'$.name') FROM membership m WHERE m.character_id=u.main_character_id
        ORDER BY json_extract(m.data,'$.roster_observed') DESC LIMIT 1
      ) former_name
      FROM users u LEFT JOIN site_battlenet_identities b ON b.user_id=u.id
      LEFT JOIN discord_links d ON d.user_id=u.id
      LEFT JOIN site_last_sign_in s ON s.user_id=u.id WHERE u.ownership_status<>'admin_mapped'`).all(),
    env.DB.prepare(`SELECT m.character_id,json_extract(m.data,'$.name') character_name,
      l.user_id,u.ownership_status,d.discord_id FROM verified_membership m
      LEFT JOIN character_links l ON l.character_id=m.character_id LEFT JOIN users u ON u.id=l.user_id
      LEFT JOIN discord_links d ON d.user_id=u.id
      WHERE m.generation=(SELECT published FROM sync WHERE id=1) ORDER BY m.slug`).all(),
    env.DB.prepare(`SELECT user_id,signed_in_at FROM (
      SELECT user_id,signed_in_at,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY signed_in_at DESC,id DESC) position
      FROM site_sign_in_history WHERE signed_in_at>=unixepoch()-90*86400
    ) WHERE position<=10 ORDER BY signed_in_at DESC`).all(),
    activeManualMappings(env)
  ]);

  const recent = new Map();
  for (const event of history.results) {
    if (!recent.has(event.user_id)) recent.set(event.user_id, []);
    recent.get(event.user_id).push(isoTime(event.signed_in_at));
  }
  const byUser = new Map(accounts.results.map(row => [row.id, {
    name: row.former_name || 'Battle.net account',
    mainId: row.main_character_id,
    characters: [],
    signed_in: true,
    battle_net_id: row.battle_net_id,
    discord_ids: row.discord_id ? [{id: row.discord_id, source: 'linked'}] : [],
    last_sign_in_at: isoTime(row.signed_in_at),
    recent_sign_ins: recent.get(row.id) || [],
    account_created_at: row.created_at
  }]));
  const byDiscord = new Map(accounts.results.filter(row => row.discord_id).map(row => [row.discord_id, byUser.get(row.id)]));
  const providers = roster.results.filter(row => row.ownership_status === 'verified');
  const mappings = await displayManualMappings(env, providers, activeMappings);
  const mappingByCharacter = new Map(mappings.map(row => [row.character_id, row]));
  const mappedOwners = new Map();
  for (const mapping of mappings) {
    const account = byUser.get(mapping.display_owner_id || mapping.participant_user_id);
    if (!account || byDiscord.has(mapping.discord_id)) continue;
    if (!mappedOwners.has(mapping.discord_id)) mappedOwners.set(mapping.discord_id, new Set());
    mappedOwners.get(mapping.discord_id).add(account);
  }
  for (const [id, owners] of mappedOwners) {
    if (owners.size !== 1) continue;
    const [account] = owners;
    byDiscord.set(id, account);
    account.discord_ids.push({id, source: 'mapped'});
  }

  const rows = [...byUser.values()];
  for (const character of roster.results) {
    const mapping = mappingByCharacter.get(character.character_id);
    let account = byUser.get(character.user_id) || (mapping ? byDiscord.get(mapping.discord_id) : null);
    if (!account) {
      account = {
        name: character.character_name,
        mainId: character.character_id,
        characters: [],
        signed_in: false,
        battle_net_id: null,
        discord_ids: mapping ? [{id: mapping.discord_id, source: 'mapped'}] : [],
        last_sign_in_at: null,
        recent_sign_ins: [],
        account_created_at: null
      };
      if (mapping) byDiscord.set(mapping.discord_id, account);
      rows.push(account);
    }
    if (account.mainId === character.character_id || account.characters.length === 0) account.name = character.character_name;
    account.characters.push(character.character_name);
  }
  return rows
    .sort((a,b) => Number(b.signed_in)-Number(a.signed_in) ||
      (b.last_sign_in_at || '').localeCompare(a.last_sign_in_at || '') || a.name.localeCompare(b.name))
    .map(({mainId, ...row}) => row);
}
