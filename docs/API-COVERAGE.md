# API coverage and verification boundaries

Battle.net OAuth is used for application tokens and member sign-in. Sign-in must prove ownership of a current configured-guild character. If the guild roster is delayed, an account-owned individual profile can supply short-lived supplemental membership proof only when its character ID/name, guild identity and configured ruleset match. Missing evidence does not grant access.

After a successful member sign-in, a private ownership index records the character IDs returned across every WoW account for up to 24 hours. A new guild roster entry is first matched against this index without another provider request. Newly unmatched arrivals queue authenticated account-summary checks for known accounts with active sessions and unexpired encrypted user tokens. One due account is processed per scheduler run; unchanged unmatched roster entries do not trigger repeated polling. New verified guild characters default to grouped alts, while the saved main and explicit separate-character choices are preserved. Ordinary level, profession and recipe refreshes do not prove character ownership.

The user access token is encrypted on the server and retained only until its reported expiry or 24 hours after sign-in, whichever comes first. Expiry, revocation, sign-out or a changed encryption context stops further provider checks. No refresh token is retained or assumed to be supported. Existing installations discarded earlier user tokens and full-account ownership indexes, so members must sign in once after upgrading to enable discovery; older credentials cannot be reconstructed. Private character IDs can include characters not yet in the guild, but their names and details are not stored or published. The ID index expires within 24 hours and is deleted on sign-out.

Forever endpoints and namespaces are community documented. Only the original EU Roleplay integration had live provider testing. Other region/ruleset combinations are configurable and synthetically tested; verify the ruleset index, exact guild slug, roster and character endpoints for your own installation. Do not substitute Retail or Classic namespaces and assume the response establishes Forever ownership.

The integration distinguishes observed, stale, unavailable and unverified fields. An absent profile does not remove an otherwise verified roster member. Recipe capability requires observed recipe IDs; profession names alone do not prove a member knows an item. Recursive materials are used only when their recipe requirements are actually available.

Profile/roster data may lag behind the game. Activity timestamps are refresh hints, not verified live online status. Observations record when the app detected a change, not an invented in-game timestamp or unseen intermediate levels. Identical checks are omitted from history; genuine level/skill/recipe changes remain separate dated records.

Useful sources:

- [Battle.net developer documentation](https://community.developer.battle.net/documentation/guides/using-oauth) for OAuth. The documentation site can be intermittently unavailable.
- [Community Forever client source](https://github.com/Pinta365/blizzard_api/tree/main/src/wow_forever) for endpoint coverage; this is community evidence, not an official completeness guarantee.
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) for the scheduler configuration.

Fresh cloning/building does not establish live Blizzard or Discord coverage. Synthetic tests and a Docker build do not replace an end-to-end login and provider check on the operator's own guild.
