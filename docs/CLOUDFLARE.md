# Deploy on Cloudflare Workers

This guide deploys the dashboard, static assets, minute scheduler and a private D1 database. Use a separate Worker and database for each guild. You need Node.js 24 or newer, npm, a Cloudflare account, and access to the Battle.net developer portal. Discord is optional.

The project can use Cloudflare's free tier, subject to its current limits and your usage. It does not guarantee a permanently free deployment. Check the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before choosing a plan or shortening refresh intervals.

## 1. Install and configure your guild

```sh
git clone https://github.com/TechKno/wow-forever-guild-tracker.git
cd wow-forever-guild-tracker
npm ci
npx wrangler login
```

Edit `guild.config.json` using [the customisation guide](CUSTOMISATION.md). Set the exact guild name, its API slug, region, locale, and the ruleset's exact API ID and name. Configure the public text, colours, logo and banner before building. This file is public configuration: never put credentials, account identifiers or access tokens in it.

Set `site.origin` to the exact HTTPS address you will use, with no path, for example `https://guild.your-domain.com`. For a `workers.dev` address, first find your account's Workers subdomain in Cloudflare, then use `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev`. This must match the chosen Worker name. Do not guess the account subdomain.

The only default sign-in origin is the configured canonical origin. If you intentionally serve another address, list its exact HTTPS origin in `site.additionalOrigins`, route it to this Worker, and register the matching callbacks with both sign-in providers. Wildcards and arbitrary Host headers cannot extend the allowlist.

## 2. Create your database and deployment configuration

Choose new names for your Worker and database. Run:

```sh
npx wrangler d1 create your-guild-ledger
```

Copy the new database UUID from Cloudflare's response and substitute it below. It identifies your own database; the repository deliberately contains no working production database ID.

For a custom domain in an active Cloudflare DNS zone:

```sh
node scripts/configure-cloudflare.mjs --worker your-guild-ledger --database your-guild-ledger --database-id YOUR-D1-UUID --domain guild.your-domain.com
```

For `workers.dev`, omit `--domain`:

```sh
node scripts/configure-cloudflare.mjs --worker your-guild-ledger --database your-guild-ledger --database-id YOUR-D1-UUID
```

The helper validates the values and writes a local, Git-ignored `wrangler.jsonc` from `wrangler.example.jsonc`. The optional domain must exactly match `site.origin`'s hostname. The helper refuses to replace an existing configured deployment unless you explicitly use `--force`; review it first to avoid selecting another deployment's database.

Keep these generated settings: D1 bound as `DB`, static assets bound as `ASSETS`, all assets routed through the Worker, implicit HTML handling disabled, four request-rate bindings, and `SECURITY_LIMITS_REQUIRED` enabled. The minute cron trigger drives incremental imports, Discord deliveries and cleanup. Cloudflare's cron schedules use UTC; this trigger runs every minute in every time zone. See [D1 setup](https://developers.cloudflare.com/d1/get-started/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) and [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## 3. Create a Battle.net client and store its credentials

In the [Battle.net developer portal](https://develop.battle.net/access/clients), create your own application. Use your real site as its Service URL and register this exact Redirect URL, substituting your configured origin:

```text
https://guild.your-domain.com/auth/callback
```

Describe the intended use as a guild dashboard that reads guild roster, character, profession, recipe and talent snapshots, and verifies members through Battle.net sign-in. The app uses a server-side client-credentials token for data requests and an authorization-code flow with PKCE and `openid wow.profile` for member sign-in. Client secrets stay on the server. Consult Blizzard's [OAuth documentation](https://develop.battle.net/documentation/guides/using-oauth) for its current client-registration requirements; the developer portal may redirect to Blizzard's newer documentation site.

First publish the application without credentials, so Cloudflare has a Worker to attach the secrets to:

```sh
npm run deploy
```

This builds public branding, applies the repository's migrations to the configured remote D1 database, then deploys the Worker while retaining existing Cloudflare secrets and variables. Before credentials are set, sign-in and imports remain unavailable.

Enter each credential at Wrangler's hidden interactive prompt:

```sh
npx wrangler secret put BLIZZARD_CLIENT_ID
npx wrangler secret put BLIZZARD_CLIENT_SECRET
```

Do not append the values to commands. You can instead use Cloudflare's Worker Settings → Variables and Secrets: choose **Secret**, enter the value privately, and deploy the change. Wrangler's `secret put` also creates and deploys a new Worker version. See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 4. Verify membership and select the administrator

Allow the scheduler to complete its initial roster import, then visit the configured site. The public landing page shows an observed character count when available. Open `/healthz` to check database reachability. Sign in using the Battle.net account that owns a character in the configured guild.

Only verified guild members can enter the dashboard. A successful OAuth login alone does not grant membership. If the provider's roster is delayed, the fallback requires both a character returned by the signed-in account and a current character profile matching the configured guild ID, guild name and ruleset. It never admits a character merely because someone typed its name. When Blizzard publishes neither membership source, access stays refused until verifiable data is available.

After your own account successfully signs in, run this with one of your exact verified character slugs, including its surname:

```sh
node scripts/admin-cloudflare.mjs first-last
```

The helper resolves exactly one freshly verified current-guild owner and stores that account as the sole administrator in the encrypted `ADMIN_USER_IDS` secret. It prints a confirmation without the private account identifier. If ownership is missing, stale or ambiguous, sign in again and resolve that condition before retrying. Refresh the website after the helper succeeds. There is no public first-user-admin or bootstrap endpoint.

Check the administrator's Data & connection page for the most recent roster import, character observations, scheduler completion and provider failures. A refresh request queues work; it does not make Blizzard publish newer data immediately.

## 5. Optional Discord bot

Create your own application and bot in the [Discord developer portal](https://discord.com/developers/applications). Under OAuth2, register:

```text
https://guild.your-domain.com/auth/discord/callback
```

Store the bot token and OAuth2 client secret privately:

```sh
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_CLIENT_SECRET
```

In the dashboard's administrator settings, save the Application ID, Server ID, Events text-channel ID and Craft Requests text-channel ID. These IDs are configuration, not secrets. Install the bot using **Add bot to this server** and approve **Create Events**. Give it **View Channel**, **Send Messages**, **Read Message History** and **Add Reactions** in both configured text channels. Use **Check bot connection** to verify the installation and channel access. The application polls its own messages through Discord's REST API; a separate bot process, public interactions endpoint and Message Content privileged intent are not required by this implementation.

Members sign in with Battle.net first, then link their own Discord account and choose requester/crafter DM preferences. Discord identity does not replace verified Battle.net ownership or guild checks. Admins may map Discord identities to characters for guild presentation; those mappings do not grant login access. Users must opt in to receive DMs, and Discord privacy settings can still refuse delivery.

Events are posted in the configured Events channel with role reactions and a Discord scheduled event. Removed or expired events are queued for cleanup. Open craft requests use the configured Craft Requests channel when no crafter was selected or the selected crafter cannot receive a DM; completion or cancellation queues deletion. These tasks are asynchronous and depend on the bot retaining access. See Discord's [OAuth2](https://discord.com/developers/docs/topics/oauth2) and [permissions](https://discord.com/developers/docs/topics/permissions) references.

## Refresh behaviour and API coverage

The default configuration checks the roster every 900 seconds and processes one due character check per scheduler run. Recently active or unknown-activity profiles receive detail checks after 900 seconds; older profiles after 3600 seconds. Activity is an observed profile timestamp, **not live in-game online status**. Website activity and Discord presence do not establish whether a WoW character is online. Larger guilds and rate limits can make the effective refresh interval longer.

These are community-documented Forever endpoints. EU Roleplay was observed in the original deployment; other region/ruleset combinations have configuration and validation tests but have not been verified against live data. Returned ruleset and guild metadata must match before an import is accepted. Missing profession, recipe or talent fields remain unknown or unavailable rather than being invented or treated as empty. Provider snapshots can lag, and a successful HTTP response does not establish complete or current coverage. The [community client reference](https://github.com/Pinta365/blizzard_api/tree/main/src/wow_forever) describes the endpoints this application was built against.

Edit the bounded intervals in `guild.config.json` and redeploy to change the policy. Shorter intervals increase requests and database work without overcoming provider publication delays. An in-game addon or another explicitly trusted reporting source would be needed to support actual live online checks; this project remains API-only.

## Updates, backups and private operational data

Before updating, export the correct remote database to a private directory outside the repository:

```sh
npx wrangler d1 export your-guild-ledger --remote --output ../private-backups/guild-backup.sql
```

Create that directory first. The export contains private account links, character data, sessions and Discord configuration. Protect it like a credential store, keep it out of Git and public support tickets, and test restores into a separate private database. Cloudflare documents [D1 export and import](https://developers.cloudflare.com/d1/best-practices/import-export-data/). An export can block database requests while it runs, so choose a quiet time.

For an update, preserve your private deployment configuration and secrets, review configuration/migration changes, install the locked dependencies, then deploy:

```sh
npm ci
npm test
npm run deploy
```

The build regenerates public files from the branding templates, so customise `guild.config.json` and the documented templates rather than generated output. Keep remote database exports, raw deployment logs, provider responses and local credentials private. The deploy helper suppresses raw tool output; investigate failures locally without pasting unreviewed logs into public issues.

The database is bound to its guild name, slug, region and ruleset. Reusing it for another guild or ruleset fails closed. Create a fresh D1 database and separate Worker for another guild. For an origin-only change, retain the guild identity, update routes and registered callbacks, rebuild and redeploy.

Rotate credentials by replacing their Cloudflare secrets and deploying. Keep secrets out of `guild.config.json`, `wrangler.example.jsonc`, committed environment files, build arguments and screenshots. If a secret was exposed, invalidating the old provider credential is necessary; changing its storage type alone does not invalidate an older copy.
