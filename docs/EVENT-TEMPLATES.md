# Dungeon and raid event suggestions

The Events & adventures page includes a searchable guide of 35 dungeon runs and three announced raids. The dungeon runs cover 28 complexes: Scarlet Monastery, Blackrock Spire, Dire Maul and Stratholme have separate wing or route presets so members can state the intended run.

Choosing a suggestion fills the event name, type, group size, tank/healer/damage places, level guidance, meeting place and an estimated duration. It opens the existing event form; the member still chooses a host and start time and explicitly creates the event. Suggestions never create events or send Discord messages by themselves. Defaults can be adjusted before creation.

## What is verified

- The nine new dungeons use Blizzard's published five-player sizes and level ranges from its [20 October dungeon overview](https://news.blizzard.com/en-us/article/24301455/explore-the-new-dungeons-of-world-of-warcraft-forever).
- The original dungeons use recommended levels and party sizes from the [Forever Group Finder in client build 1.60.1.70888](https://endgametools.com/en/wow-forever/dungeons). It lists [Lower Blackrock Spire for five players and Upper for ten](https://endgametools.com/en/wow-forever/dungeons/blackrock-spire#wings). The guide labels these as Group Finder sizes. Server-enforced player caps are unverified.
- The Barrow Deeps, Hyjal Summit and Onyxia's Lair use Blizzard's announced 10-, 20- and 40-player sizes and level-60 design guidance. The catalogue checked on 12 November 2026 marks them as announced for 9 December, based on the [raid overview](https://news.blizzard.com/en-us/article/24303009/world-of-warcraft-forever-raid-overviewlocations-raid-sizes-and-attunement). Attunement notes include Onyxia's Drakefire Amulet.

No hard minimum entry levels are claimed: a published level range is not proof of an enforced entry gate. Tank/healer/damage splits and durations are suggested starting points, not Blizzard encounter requirements. Hosts can add their own level guide; the saved event labels changed guidance as host-provided. Level guides do not block sign-ups or establish attunement completion.

The catalogue is a dated, sourced planning guide rather than an API-verified inventory. It does not add unannounced later Classic raids as if they were supported Forever content. Review the supplied sources when new content opens or game requirements change.

## Hosting and customisation

Edit `src/event-catalogue.mjs` to update the curated suggestions and per-field provenance. `GET /api/event-templates` requires current guild membership. Server validation resolves a selected template ID and ignores client-supplied claims that a field is verified. Role-place counts must be whole numbers, fit within the event capacity, and add up to the total.

Migration `0022_event_templates.sql` adds the template ID and a guidance snapshot to new events. Older custom events keep their existing behaviour. Changed catalogue entries do not rewrite earlier event snapshots. Raids use the same protected sign-up, Discord announcement, role-reaction and cleanup paths as dungeon events. The bot publishes only after a member creates a real event; tests use mocked Discord calls.
