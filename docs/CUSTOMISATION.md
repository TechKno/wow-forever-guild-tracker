# Customising your guild

Edit `guild.config.json`, then run `npm run build`. The generated pages and browser scripts are built from `branding/templates/`; edit those templates for structural UI changes rather than changing generated files directly.

| Setting | Purpose |
| --- | --- |
| `guild.name` / `guild.slug` | Exact guild name and lowercase hyphenated identifier returned by the API. A misspelling is significant. |
| `guild.region` / `guild.locale` | `eu` or `us`, plus a locale such as `en_GB`. Configurable does not mean provider coverage has been verified. |
| `guild.ruleset.id` / `name` | Exact Forever ruleset ID/name; imports must verify the configured identity. The example is Roleplay3. |
| `site.origin` | Your canonical HTTPS origin, with no path, query or credentials. Register its exact callback URLs. |
| `site.additionalOrigins` | Explicit extra HTTPS origins, if needed. No wildcard hosts or automatic trust of a request Host header. Register callbacks for each origin you intend to use. |
| `site.title`, `tagline`, `description`, `motto` | Public presentation text, safely escaped into the pages. |
| `site.logo` / `site.hero` | Local files beneath `/assets/`; the logo is also used as the favicon. Remote image URLs and traversal paths are rejected. |
| `site.theme.accent` / `background` | Six-digit hex colours. The theme is designed for a light parchment background. |
| `discord.botName` | The displayed bot name; create/configure your own Discord application separately. |
| `refresh.*Seconds` | Roster, active and inactive safety-check intervals. Intervals are validated; inactive must be no shorter than active. The minute scheduler processes bounded work, so actual delays depend on queue size and provider pauses. |

Secrets and administrator account identifiers are deliberately **not** part of this file. Unknown configuration keys are rejected so credentials cannot accidentally be added to the public branding configuration.

Use a fresh database when changing the guild/region/ruleset identity. A database is bound to its original guild configuration; changing a title, colour, logo, site origin or bot display name does not change the guild identity.

The neutral crest/banner are original SVGs that you may replace under the project licence. Keep replacement files local and do not commit private guild screenshots or artwork you lack permission to redistribute.
