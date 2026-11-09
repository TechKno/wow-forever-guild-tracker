# Optional Discord integration

The dashboard works without Discord. Each guild operator supplies their own application, bot and server; no shared bot credential is included.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Use your configured bot name.
2. Register `https://YOUR-SITE/auth/discord/callback` as its OAuth2 redirect. It must match `site.origin`; register explicit aliases only if you use them.
3. Add `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` to the host's server configuration. Store `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_SECRET` as encrypted Cloudflare secrets or private Docker secret files. Never commit their values.
4. Install the bot into the intended server. For scheduled events it needs Create Events. For event/craft text channels, grant View Channel, Send Messages, Read Message History and Add Reactions. Do not grant Administrator just for this app.
5. After provisioning a website administrator, use Data & connection to select the existing Events and Craft requests channels and check the connection.
6. Members may authorise the bot from Members & alts and explicitly opt in to DMs. Existing private WoW/Discord account connections are not readable by this website. Administrator mappings provide bot associations but do not grant website membership or Battle.net ownership.

Craft requests can target observed crafters. The bot uses eligible opted-in DMs, with a craft-channel fallback when no crafter was chosen or delivery is unavailable. The requester and verified capable crafters may confirm channel completion; bot-owned posts are queued for removal on completion/cancellation. Members choose their event roles; Discord Interested responses are separate from confirmed party signups.

Bot work is processed in bounded scheduled batches. Permission errors and provider rate limits can delay posting, reactions and cleanup. Discord may refuse DMs even after an opt-in. Use a private test channel and fictional requests while testing your installation.

See [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) and [permission documentation](https://docs.discord.com/developers/topics/permissions).
