// Curated planning data, not a Blizzard API response. Source status belongs to
// each field: a published level range does not establish an entry restriction.
const newDungeons={title:'Blizzard: Explore the New Dungeons of World of Warcraft: Forever (20 October 2026)',url:'https://news.blizzard.com/en-us/article/24301455/explore-the-new-dungeons-of-world-of-warcraft-forever'};
const raids={title:'Blizzard: Forever Raid Overview — Locations, Raid Sizes, and Attunement (October 2026)',url:'https://news.blizzard.com/en-us/article/24303009/world-of-warcraft-forever-raid-overviewlocations-raid-sizes-and-attunement'};
const groupFinder={title:'Endgame Tools: Forever Group Finder data (client build 1.60.1.70888)',url:'https://endgametools.com/en/wow-forever/dungeons'};
const spireFinder={title:'Endgame Tools: Lower and Upper Blackrock Spire Group Finder entries',url:'https://endgametools.com/en/wow-forever/dungeons/blackrock-spire#wings'};
const launch={title:'Blizzard: World of Warcraft: Forever Now Live! (4 November 2026)',url:'https://news.blizzard.com/en-us/article/24315820/world-of-warcraft-forever-now-live'};
const original=[
  ['ragefire-chasm','Ragefire Chasm',13,18,'Orgrimmar',60,'The Group Finder lists this dungeon for the Horde.'],
  ['deadmines','The Deadmines',17,26,'Moonbrook, Westfall',120],
  ['wailing-caverns','Wailing Caverns',15,24,'The Barrens',120],
  ['shadowfang-keep','Shadowfang Keep',20,30,'Silverpine Forest',120],
  ['blackfathom-deeps','Blackfathom Deeps',24,32,'Ashenvale',120],
  ['the-stockade','The Stockade',24,32,'Stormwind City',60,'Listed as Stormwind Stockade for the Alliance in the Group Finder.'],
  ['gnomeregan','Gnomeregan',29,38,'Dun Morogh',150],
  ['razorfen-kraul','Razorfen Kraul',29,38,'Southern Barrens',120],
  ['scarlet-monastery-graveyard','Scarlet Monastery: Graveyard',30,38,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['scarlet-monastery-library','Scarlet Monastery: Library',33,41,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['scarlet-monastery-armory','Scarlet Monastery: Armory',36,44,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['scarlet-monastery-cathedral','Scarlet Monastery: Cathedral',38,46,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['uldaman','Uldaman',41,51,'Badlands',150],
  ['razorfen-downs','Razorfen Downs',37,46,'Southern Barrens',120],
  ['zul-farrak',"Zul'Farrak",44,54,'Tanaris',120],
  ['maraudon','Maraudon',46,55,'Desolace',180,'Choose the intended route and bosses with the party before the run.'],
  ['sunken-temple',"The Temple of Atal'Hakkar",50,60,'Swamp of Sorrows',150,'Also called Sunken Temple.'],
  ['blackrock-depths','Blackrock Depths',52,60,'Blackrock Mountain',180,'This sprawling dungeon supports different run goals. State the intended route and bosses.'],
  ['lower-blackrock-spire','Lower Blackrock Spire',55,60,'Blackrock Mountain',150,'The Group Finder lists this wing separately from Upper Blackrock Spire.'],
  ['upper-blackrock-spire','Upper Blackrock Spire',59,60,'Blackrock Mountain',150,'The Group Finder lists 10 for this wing. Map-level data also shows a five-player listing for the shared Blackrock Spire map.',{capacity:10,role_limits:{Tank:2,Healer:2,Damage:6}}],
  ['dire-maul-east','Dire Maul: East',54,60,'Feralas',120,'One of Dire Maul’s three wings, offered as a separate run.'],
  ['dire-maul-west','Dire Maul: West',56,60,'Feralas',150,'One of Dire Maul’s three wings, offered as a separate run.'],
  ['dire-maul-north','Dire Maul: North',56,60,'Feralas',120,'One of Dire Maul’s three wings. State whether the party plans a tribute run.'],
  ['stratholme-living','Stratholme: Living',58,60,'Eastern Plaguelands',150,'A route within Stratholme, offered as a separate run rather than another dungeon complex.'],
  ['stratholme-undead','Stratholme: Undead',58,60,'Eastern Plaguelands',150,'A route within Stratholme, offered as a separate run rather than another dungeon complex.'],
  ['scholomance','Scholomance',58,60,'Western Plaguelands',150]
];
const additions=[
  ['hall-of-thanes','Hall of Thanes',13,18,'Beneath Ironforge, Dun Morogh',120,'Horde groups must travel through Alliance territory.'],
  ['ruins-of-lordaeron','Ruins of Lordaeron',15,20,'Ruins above the Undercity, Tirisfal Glades',120,'Alliance groups must travel through Horde territory.'],
  ['excavation-site-wetlands','Excavation Site: Wetlands',24,29,'Above Whelgar’s Excavation, Wetlands',120,'The 20 October overview publishes 24–29; earlier beta notes listed 26–31. This is a published range, not a verified entry gate.'],
  ['city-of-dalaran','City of Dalaran',28,33,'Dalaran, Alterac Mountains',150,'Requires the Dalaran attunement questline. Alliance begins with An Alarming Request in Southshore; Horde begins with Key to the City and Prison Break-In in Tarren Mill.'],
  ['the-drowned-city','The Drowned City',35,40,'Stranglethorn coast, west of Grom’gol',150,'The entrance is below the water.'],
  ['kroldok-stronghold',"Krol'dok Stronghold",40,45,'Riverglades',150,'Several paths pass through the stronghold.'],
  ['alcaz-prison','Alcaz Prison',48,53,'Alcaz Island, Dustwallow Marsh',150,'Arrange travel to the island with your party.'],
  ['blackmaw-hold','Blackmaw Hold',55,60,'Azshara',180,'A large dungeon with multiple routes.'],
  ['shapers-terrace',"Shaper's Terrace",58,60,'Northern hills of Un’Goro Crater',150,'Bring power crystals collected in Un’Goro for the consoles.']
];
const common={kind:'Dungeon',capacity:5,role_limits:{Tank:1,Healer:1,Damage:3},minimum_level:null,minimum_level_status:'unverified',role_status:'suggested',status:'available'};
const originalTemplates=original.map(([id,name,min,max,location,duration_minutes,extra='',group])=>({
  ...common,...group,id,name,recommended_level:{min,max},recommended_level_status:'group_finder',location,duration_minutes,
  capacity_status:'group_finder',notes:[extra,'The Forever Group Finder provides the suggested levels and group size. Minimum entry level and server-enforced capacity remain unverified. Role counts and duration are editable suggestions.'].filter(Boolean).join(' '),
  sources:[groupFinder,...(id.endsWith('-blackrock-spire')?[spireFinder]:[]),
    ...(id==='upper-blackrock-spire'?[{title:'ForeverDB: shared Blackrock Spire map listing',url:'https://foreverdb.net/dungeon/229-blackrock-spire'}]:[])]
}));
const newTemplates=additions.map(([id,name,min,max,location,duration_minutes,extra])=>({
  ...common,id,name,recommended_level:{min,max},recommended_level_status:'verified',location,duration_minutes,
  capacity_status:'verified',notes:extra+' Blizzard publishes the level range and five-player size. The minimum entry level is unverified; roles and duration are suggested planning defaults.',sources:[newDungeons,launch]
}));
const raidTemplates=[
  ['barrow-deeps','The Barrow Deeps',10,{Tank:2,Healer:2,Damage:6},'Mount Hyjal; connected entrances from Winterspring and Blackmaw Hold',180,'Blizzard describes an eight-boss raid.'],
  ['hyjal-summit','Hyjal Summit',20,{Tank:2,Healer:5,Damage:13},'Mount Hyjal summit near Nordrassil',240,'Blizzard describes thirteen bosses and several paths.'],
  ['onyxias-lair',"Onyxia's Lair",40,{Tank:2,Healer:8,Damage:30},'Dustwallow Marsh',120,'Every raider needs to carry the Drakefire Amulet. Complete the faction-specific attunement before the raid.']
].map(([id,name,capacity,role_limits,location,duration_minutes,extra])=>({
  id,name,kind:'Raid',capacity,role_limits,minimum_level:null,minimum_level_status:'unverified',recommended_level:{min:60,max:60},recommended_level_status:'verified',location,duration_minutes,status:'announced',capacity_status:'verified',role_status:'suggested',
  notes:extra+' Announced to unlock on 9 December 2026; not open as of this catalogue check. Blizzard’s design level is 60, which is not presented here as a separately verified entry gate. Role counts and duration are editable planning suggestions, not encounter requirements.',sources:[raids,launch]
}));
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const EVENT_CATALOGUE=freeze({
  schema_version:1,checked_at:'2026-11-12T00:00:00.000Z',game:'WoW Forever',
  templates:[...originalTemplates,...newTemplates].sort((a,b)=>a.recommended_level.min-b.recommended_level.min||a.name.localeCompare(b.name)).concat(raidTemplates),
  note:'35 run presets cover 28 dungeons. Original dungeons use the Forever Group Finder’s levels and party sizes. New dungeons use Blizzard’s published ranges and sizes. Dungeon entry levels and live instance caps are unverified. Roles and durations are editable suggestions. The three named raids are announced for 9 December 2026.'
});
