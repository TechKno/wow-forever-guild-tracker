# Accounts, administration and hierarchy

## Administrator overview

The administrator overview is private to the verified account IDs explicitly configured in `ADMIN_USER_IDS` or the self-host administrator file. Guild rank names never grant website permissions. Ordinary members cannot read the overview API or save rank labels.

The overview distinguishes guild characters from site accounts and Discord-linked accounts. Health cards show the background scheduler, provider coverage, published roster and configured Discord delivery queue. A configured bot is not described as a verified healthy connection. Backup state is managed by the host; this page does not claim to have tested a restore.

Each completed roster publication records its observed/completed time, duration, character count, joins, departures, higher levels and rank changes. Publication, history and departure safeguards commit together. Incomplete or failed staging cannot announce completed changes. The most recent 20 imports are shown and up to 100 are retained. History begins when this feature is installed.

## Manage My Account

Members can choose a main, group their alts, change each owned character's primary/additional combat roles, link or unlink Discord, and set crafting-DM preferences. Changes still require current Battle.net ownership and the session's CSRF protection. One member cannot edit another member's characters. Rechecking Battle.net access is a new ownership sign-in; it is separate from the scheduled game-data refresh.

## Guild hierarchy

The hierarchy sorts current members by numeric guild rank, with rank 0 first. Each linked person appears once, represented by their highest-ranked current guild character. Ties prefer the highest level, then the chosen main. Other characters remain available in the roster and member directory. Missing rank data forms a separate unknown group.

Suggested labels are Guildmaster, Officer, Veteran, Member, Initiate, Reserve, Recruit, Newcomer, Guest and Visitor for ranks 0–9. These are editable presentation labels, not API-verified guild titles. The administrator can change them in the overview. Compact desktop rows are centred; phones use readable stacked cards. Larger guilds or expanded freshness details can require scrolling.

## Departures and returns

A complete new Blizzard roster that omits a previously returned character records a departure. The character disappears from active roster, directory and hierarchy views; supplemental profile proof is revoked, and future open event places for that character are freed. Historical observations and past attendance remain.

An account with another current verified guild character keeps access. An account with none is denied member routes, including private armory images. A departure marker prevents a delayed character profile or an in-flight sign-in from restoring access through the fallback. A later validated primary roster containing that character clears the marker and records its return once.

These decisions follow Blizzard's published snapshots. They cannot establish the exact moment someone joins, leaves or is removed in game. If the roster has not yet published a departure, the site cannot independently detect it. A known departed character cannot use the profile fallback to prove a return while the primary roster still omits it.

## Character armory

Open a current character from the roster, hierarchy or account page. Character, Talents, Professions and Details tabs keep the card compact. Equipment surrounds the central artwork, with weapons underneath and statistics below. Select an item for its details. Equipment, statistics and artwork have separate observation times and retry rules. Only returned fields are shown: omitted slots, enchantment fields or statistics remain unknown. Public profiles for low-level characters may be unpublished; this does not remove a roster-verified member.

Artwork is served through a member-gated proxy that accepts only verified Blizzard character-image references, checks formats and sizes, and rechecks membership. Item icons are limited to IDs in that character's observed equipped-item list and validated static-media responses. If a regional Forever icon returns 403 or 404, the proxy tries the identical file in Blizzard's shared icon store; character artwork and rate-limit responses never use this fallback. No provider tokens or upstream image URLs are sent to the browser. Successful sections are cached for 15 minutes; unavailable sections back off, retain prior successful data when available, and respect provider rate-limit pauses.
