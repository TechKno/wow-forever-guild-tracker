-- A roster-observed departure cannot be overridden by a delayed character profile.
DROP VIEW verified_membership;
CREATE VIEW verified_membership AS
  SELECT generation,slug,character_id,data FROM membership
  UNION ALL
  SELECT s.published,p.slug,p.character_id,p.data
    FROM profile_members p
    JOIN sync s ON s.id=1 AND s.published IS NOT NULL
    JOIN character_links l ON l.character_id=p.character_id AND l.user_id=p.user_id
    JOIN users u ON u.id=p.user_id
    JOIN state g ON g.key='guild'
    JOIN state configured ON configured.key='deployment_identity'
    WHERE p.expires>unixepoch()
      AND p.checked_at<=unixepoch()+60
      AND p.ruleset=json_extract(configured.value,'$.ruleset_id')
      AND u.ownership_status='verified'
      AND u.ownership_checked>unixepoch()-86400
      AND u.ownership_checked<=unixepoch()+60
      AND p.guild_id=json_extract(g.value,'$.id')
      AND lower(json_extract(g.value,'$.name'))=lower(json_extract(configured.value,'$.name'))
      AND json_extract(g.value,'$.ruleset')=json_extract(configured.value,'$.ruleset')
      AND json_extract(p.data,'$.id')=p.character_id
      AND json_extract(p.data,'$.guild_id')=p.guild_id
      AND json_extract(p.data,'$.ruleset_id')=p.ruleset
      AND json_extract(p.data,'$.membership_source')='character_profile'
      AND NOT EXISTS(
        SELECT 1 FROM membership r WHERE r.generation=s.published
          AND (r.character_id=p.character_id OR r.slug=p.slug)
      )
      AND NOT EXISTS(SELECT 1 FROM membership_departures d WHERE d.character_id=p.character_id);
