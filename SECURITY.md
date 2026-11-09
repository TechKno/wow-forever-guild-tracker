# Security and operator responsibilities

Use your own Battle.net client and database. Keep provider credentials in encrypted host secrets or private secret mounts. Never place them in `guild.config.json`, browser code, issue reports, screenshots or Git history. `.env`, `.dev.vars`, runtime databases, backups, deployment configuration and logs are excluded from the source repository; the release check looks for credential patterns and accidentally tracked operational files.

The app checks Battle.net character ownership and current guild membership, keeps administrator access separate, and guards writes with same-origin CSRF checks. A manual Discord association does not establish ownership or website access. Private pages/assets/APIs are gated before static assets are served; public counts do not expose the roster. Guild identity is bound to the database to prevent accidental reuse across guilds.

Deploy HTTPS. Do not disable origin checks, secure cookies, the Worker-first static asset handler, rate-limit bindings or preview-URL restrictions to work around a setup failure. The Docker app should stay on its private network behind Caddy; do not expose its internal HTTP port publicly or trust arbitrary forwarded client-IP headers. In-memory self-host rate limits reset on restart and are intended for one app process, not independent replicas.

Administrator provisioning is an operator action after a guild member signs in and ownership is freshly verified. Provision only the intended owner. Hosted administrator settings are encrypted secrets; self-hosted settings stay in a private server file. Record operator access outside public issues.

Backups and logs can contain private member/account identifiers. Encrypt or restrict them, and do not upload production exports into issues or demo fixtures. Rotate a credential if it has been exposed; removing it from a file does not invalidate older copies. This repository's example credentials are empty and its screenshots are fictional demo data.

For a vulnerability, use the repository's private vulnerability-reporting route if enabled, or contact the maintainer through their GitHub profile before sharing a reproducible report. Do not open a public issue containing a working exploit, token or member export.

No software review guarantees complete security. Keep Node.js, container images, Wrangler and dependencies updated and review changes before operating an internet-facing instance.
