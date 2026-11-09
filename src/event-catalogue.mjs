// Curated planning data, not a Blizzard API response. Source status belongs to
// each field: a published level range does not establish an entry restriction.
const newDungeons={title:'Blizzard: Explore the New Dungeons of World of Warcraft: Forever (20 October 2026)',url:'https://news.blizzard.com/en-us/article/24301455/explore-the-new-dungeons-of-world-of-warcraft-forever'};
const raids={title:'Blizzard: Forever Raid Overview — Locations, Raid Sizes, and Attunement (October 2026)',url:'https://news.blizzard.com/en-us/article/24303009/world-of-warcraft-forever-raid-overviewlocations-raid-sizes-and-attunement'};
const guide={title:'Method: Forever dungeon planning recommendations (4 November 2026)',url:'https://www.method.gg/wow-forever/wow-forever-dungeon-xp-explained-and-all-dungeons-by-level'};
const beta={title:'Blizzard: Forever beta development notes (1 October 2026)',url:'https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-%E2%80%93-updated-november-2/2360696/4'};
const launch={title:'Blizzard: World of Warcraft: Forever Now Live! (4 November 2026)',url:'https://news.blizzard.com/en-us/article/24315820/world-of-warcraft-forever-now-live'};
const original=[
  ['ragefire-chasm','Ragefire Chasm',13,18,'Orgrimmar',60],
  ['deadmines','The Deadmines',17,20,'Moonbrook, Westfall',120],
  ['wailing-caverns','Wailing Caverns',18,24,'The Barrens',120],
  ['shadowfang-keep','Shadowfang Keep',21,26,'Silverpine Forest',120],
  ['blackfathom-deeps','Blackfathom Deeps',23,28,'Ashenvale',120],
  ['the-stockade','The Stockade',25,29,'Stormwind City',60],
  ['gnomeregan','Gnomeregan',29,34,'Dun Morogh',150],
  ['razorfen-kraul','Razorfen Kraul',30,38,'Southern Barrens',120],
  ['scarlet-monastery-graveyard','Scarlet Monastery: Graveyard',30,38,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['scarlet-monastery-library','Scarlet Monastery: Library',33,41,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['scarlet-monastery-armory','Scarlet Monastery: Armory',36,44,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['scarlet-monastery-cathedral','Scarlet Monastery: Cathedral',38,46,'Tirisfal Glades',90,'A wing of Scarlet Monastery, offered as a separate run rather than a separate dungeon complex.'],
  ['uldaman','Uldaman',37,45,'Badlands',150,'Blizzard allowed access from level 30 during beta; this does not establish the live entry restriction.'],
  ['razorfen-downs','Razorfen Downs',37,45,'Southern Barrens',120,'Blizzard allowed access from level 25 during beta; this does not establish the live entry restriction.'],
  ['zul-farrak',"Zul'Farrak",40,47,'Tanaris',120],
  ['maraudon','Maraudon',45,51,'Desolace',180,'Choose the intended route and bosses with the party before the run.'],
  ['sunken-temple',"The Temple of Atal'Hakkar",50,55,'Swamp of Sorrows',150],
  ['blackrock-depths','Blackrock Depths',52,60,'Blackrock Mountain',180,'This sprawling dungeon supports different run goals. State the intended route and bosses.'],
  ['lower-blackrock-spire','Lower Blackrock Spire',57,60,'Blackrock Mountain',150,'A run within Blackrock Spire; the live Forever player limit has not been independently verified.'],
  ['upper-blackrock-spire','Upper Blackrock Spire',60,60,'Blackrock Mountain',150,'A run within Blackrock Spire. Five places is an editable planning default, not a verified live cap; do not assume the old Classic 10-player limit.'],
  ['dire-maul-east','Dire Maul: East',58,60,'Feralas',120,'One of Dire Maul’s three wings, offered as a separate run.'],
  ['dire-maul-west','Dire Maul: West',60,60,'Feralas',150,'One of Dire Maul’s three wings, offered as a separate run.'],
  ['dire-maul-north','Dire Maul: North',60,60,'Feralas',120,'One of Dire Maul’s three wings. State whether the party plans a tribute run.'],
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
const originalTemplates=original.map(([id,name,min,max,location,duration_minutes,extra=''])=>({
  ...common,id,name,recommended_level:{min,max},recommended_level_status:'guide',location,duration_minutes,
  capacity_status:'unverified',notes:[extra,'Level range is Method’s planning recommendation. Five places and the role split are editable planning defaults; Forever entry minimum and current player cap have not been verified.'].filter(Boolean).join(' '),
  sources:[guide,...(['uldaman','razorfen-downs'].includes(id)?[beta]:[]),...(['blackrock-depths','lower-blackrock-spire','upper-blackrock-spire'].includes(id)?[raids]:[])]
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
  schema_version:1,checked_at:'2026-11-09T00:00:00.000Z',game:'WoW Forever',
  templates:[...originalTemplates,...newTemplates].sort((a,b)=>a.recommended_level.min-b.recommended_level.min||a.name.localeCompare(b.name)).concat(raidTemplates),
  note:'35 dungeon run presets cover 28 dungeon complexes, with Scarlet Monastery, Blackrock Spire, Dire Maul and Stratholme split into useful runs. The three named raids are announced for 9 December 2026. This is a curated planning catalogue, not a complete API inventory: original-dungeon ranges are guide recommendations, unverified player caps are marked, and no hard minimum entry levels are claimed. Unnamed future raids, Molten Core and later Classic raids are not presented as supported Forever content. Role counts and durations are editable suggestions.'
});
