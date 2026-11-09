# API coverage and verification boundaries

Battle.net OAuth is used for application tokens and member sign-in. Sign-in must prove ownership of a current configured-guild character. If the guild roster is delayed, an account-owned individual profile can supply short-lived supplemental membership proof only when its character ID/name, guild identity and configured ruleset match. Missing evidence does not grant access.

Forever endpoints and namespaces are community documented. Only the original EU Roleplay integration had live provider testing. Other region/ruleset combinations are configurable and synthetically tested; verify the ruleset index, exact guild slug, roster and character endpoints for your own installation. Do not substitute Retail or Classic namespaces and assume the response establishes Forever ownership.

The integration distinguishes observed, stale, unavailable and unverified fields. An absent profile does not remove an otherwise verified roster member. Recipe capability requires observed recipe IDs; profession names alone do not prove a member knows an item. Recursive materials are used only when their recipe requirements are actually available.

Profile/roster data may lag behind the game. Activity timestamps are refresh hints, not verified live online status. Observations record when the app detected a change, not an invented in-game timestamp or unseen intermediate levels. Identical checks are omitted from history; genuine level/skill/recipe changes remain separate dated records.

Useful sources:

- [Battle.net developer documentation](https://community.developer.battle.net/documentation/guides/using-oauth) for OAuth. The documentation site can be intermittently unavailable.
- [Community Forever client source](https://github.com/Pinta365/blizzard_api/tree/main/src/wow_forever) for endpoint coverage; this is community evidence, not an official completeness guarantee.
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) for the scheduler configuration.

Fresh cloning/building does not establish live Blizzard or Discord coverage. Synthetic tests and a Docker build do not replace an end-to-end login and provider check on the operator's own guild.
