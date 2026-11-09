# Self-host with Docker

This runs the same application on your own Linux Docker host. A Node.js server provides SQLite storage and the Worker-compatible database, asset, rate-limit and scheduled-job bindings. Caddy serves the public HTTPS site. The app container runs as a non-root user, has a read-only root filesystem and does not publish its internal HTTP port.

The supplied deployment is one app instance for one guild. Its bounded rate-limit counters are held in that process and reset when it restarts. Do not scale it into multiple replicas without designing shared storage, rate limiting and job coordination first.

You need a domain or subdomain you control, a Linux host with Docker Engine and Docker Compose v2, and access to the Battle.net developer portal. An existing reverse proxy can be used instead, but preserve the origin and trusted-proxy requirements below.

## 1. Configure your guild

Clone this repository and edit `guild.config.json` as described in [customisation](CUSTOMISATION.md). Set your exact guild name/slug, region and ruleset, and set `site.origin` to your real HTTPS address, for example `https://guild.your-domain.com`. Configure your logo, banner, text and colours before building the image. Do not put credentials in that file.

Use a separate data volume for each guild. The backend binds the database to its configured guild identity and rejects reuse with a different guild. Changing an origin requires updating the registered provider callbacks too.

## 2. Prepare DNS and HTTPS

Point the domain's A/AAAA records at the Docker host's public address. Forward TCP ports80 and443 to this host and allow them through its firewall. Remove an AAAA record if the host cannot actually receive IPv6 traffic. With a public domain and working inbound ports, [Caddy obtains and renews HTTPS certificates](https://caddyserver.com/docs/automatic-https).

The supplied proxy trusts the incoming connection address. If you put a CDN or another proxy in front of it, requests will share that proxy's rate-limit bucket until you deliberately configure and validate that proxy chain. Do not simply trust caller-supplied forwarding headers or publish the app's8080 port. Keep the supplied exact trusted Caddy address,172.30.0.2, in sync with the Compose network configuration. If that subnet conflicts with your host, change both the network's addresses and `TRUSTED_PROXY_ADDRESSES` together.

## 3. Create your own Battle.net client

Create a client in the Battle.net developer portal for your guild's site. Register this exact redirect URL using your domain:

```text
https://guild.your-domain.com/auth/callback
```

Copy `.env.example` to `.env` and restrict its permissions before editing it:

```sh
cp .env.example .env
chmod 600 .env
```

Set `SITE_HOSTNAME` to the hostname from `site.origin` and enter your own `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`. Enter values in your editor or secret manager; do not place actual credentials in commands, issues, screenshots or this repository. `.env` is ignored by Git and the Docker build context. It is still a private plaintext file on your host, so protect and back it up accordingly.

The app also supports `BLIZZARD_CLIENT_ID_FILE`, `BLIZZARD_CLIENT_SECRET_FILE`, `DISCORD_BOT_TOKEN_FILE`, `DISCORD_CLIENT_SECRET_FILE` and `ADMIN_USER_IDS_FILE`. These read private mounted files at runtime. Do not set both a non-empty value and its `_FILE` setting. To use [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), add each required file under Compose's top-level `secrets`, grant it only to the app service and set the corresponding `_FILE` path to `/run/secrets/<name>`. The container user, UID1000, must be able to read the mounted file. Secrets are never build arguments or copied into the image.

## 4. Start the service

```sh
docker compose up -d --build
docker compose ps
```

The image builds the branded pages, creates the database on first start and applies the included migrations atomically. Its health check tests database access without exposing credentials. The background runner starts automatically and invokes scheduled jobs every minute; overlapping runs are skipped. Blizzard's own publication delays and API limits still apply.

Open your real HTTPS address. The public guild introduction should load; the private roster requires a verified Battle.net guild character. An empty roster remains empty until a successful import completes. A missing API profile does not mean a character has no skills. The app never infers live in-game presence from API timestamps.

The host volumes retain `guild.sqlite`, its WAL/SHM files, the administrator identity file, and Caddy's certificate state. `docker compose down` preserves named volumes. **Do not add `-v` when stopping an instance whose data you need.**

## 5. Make the verified guild owner an administrator

First sign in at the website with the Battle.net account that owns your current guild character. Then run the following with its exact character slug, not a BattleTag or Discord ID:

```sh
docker compose exec app node self-host/admin.mjs --character your-character-slug
docker compose restart app
```

The command requires exactly one freshly Battle.net-verified owner of that current guild character. It writes a private administrator-identity file in the data volume and never prints the account identifier. It grants no ownership or guild-membership exception. Leave `ADMIN_USER_IDS` empty in `.env` to use this file; an explicit environment value or `ADMIN_USER_IDS_FILE` takes precedence.

To appoint a different verified owner later, run the same command again and restart. This replaces the file's sole administrator. Protect the Docker host: anyone with host or Docker administrator access can read database files and runtime credentials.

## 6. Optional Discord bot

Create your own Discord application and bot. Register:

```text
https://guild.your-domain.com/auth/discord/callback
```

Put its public application/server IDs and private bot token/client secret in the corresponding `.env` fields or secret files. Restart the app after changing credentials. Use the administrator's Data & connection page to select the events and crafting channels and check the connection. Invite the bot with only the permissions needed for your selected features. Members authorise the bot separately and opt in to DMs. A manual Discord mapping does not grant Battle.net ownership or website membership.

Follow [the Discord guide](DISCORD.md) for callback, permission and notification details. API-only online/quest limitations remain the same on either hosting option.

## Backups and upgrades

For a simple consistent backup, stop writes, copy the whole named data volume, then restart:

```sh
mkdir -p backups
chmod 700 backups
docker compose stop app
docker compose run --rm --no-deps --entrypoint tar app -C /app/data -czf - . > backups/guild-data.tar.gz
chmod 600 backups/guild-data.tar.gz
docker compose start app
```

Treat the archive as private: it contains guild records, hashed account associations, active sessions and the administrator identifier. Back up `.env` or secret-manager entries separately and protect those copies. Caddy's certificate volume can also be backed up; otherwise Caddy can normally obtain fresh certificates after DNS and ports are restored. Test restoration on an isolated host using the same source version and a copy of the backup before relying on it.

To extract into a fresh, separate Compose project volume without starting the app or bot jobs:

```sh
docker compose -p guild-restore run --rm --no-deps -T --entrypoint tar app -C /app/data -xzf - < backups/guild-data.tar.gz
docker compose -p guild-restore run --rm --no-deps app node self-host/migrate.mjs
```

Use a new project name and empty data volume for this test. Keep restored copies private and keep live provider credentials out of the test environment. Starting a restored production bot against the same Discord server could repeat pending work. A real cutover also needs the matching guild configuration, private credentials, domain routing and provider callback registrations.

Upgrade using a reviewed source revision:

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Back up first. Startup applies new migrations once and checks the checksum of previously applied migrations. Do not edit an applied migration or point an older app revision at an upgraded database. To roll back a schema change, restore the matching source version and its database backup together. Configuration or asset changes require rebuilding the image; credential-only changes need an app restart.

## Troubleshooting

- A certificate error usually means DNS, IPv6, port forwarding or an existing service on80/443 needs attention. Follow the Caddy documentation; do not bypass browser certificate warnings.
- A400 response from the app means its Host header did not match a configured HTTPS origin. Keep `SITE_HOSTNAME`, `site.origin`, DNS and provider callback URLs aligned. The adapter ignores `X-Forwarded-Host` when choosing the site origin.
- A503 protection error means a required limiter or database binding failed. Do not disable protections to work around it.
- A missing administrator panel means the verified owner has not been pinned, the app was not restarted, or an explicit administrator environment setting overrides the private file.
- Do not publish `docker compose config`, environment dumps, database exports or provider responses in bug reports. Use the generic health/error state and a sanitised description instead.

## Verification boundary

The native adapter has automated tests for migrations, transaction rollback, persisted data, protected routes, owner-only administrator setup, asset traversal/symlink rejection, request limits, IP-header spoofing and non-overlapping background work. Docker/Caddy startup and public TLS must also be checked on the actual host with its DNS and networking. Local code tests alone do not establish that external configuration works.

References: [Docker Compose environment files](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/), [Docker secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [Caddy reverse-proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).
