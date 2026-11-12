// Screenshot/documentation preview only. This module does not import the
// production Worker, a database driver, environment secrets or provider APIs.
import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CONFIG} from '../src/config.mjs';
import {EVENT_CATALOGUE} from '../src/event-catalogue.mjs';
import {rosterDisplayGroups} from '../src/player-groups.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),publicDirectory=join(project,'public');
const observedAt='2026-11-09T09:00:00.000Z',generation='fictional-demo-roster-v1';
const readonlyMessage='Demo data is read-only. No changes, sign-ins or Discord messages are sent.';
const demoCSS=':root{--demo-banner-height:36px}.demo-banner{position:sticky;top:0;z-index:1000;min-height:var(--demo-banner-height);padding:9px 18px;background:#dce8df;border-bottom:1px solid #9eaf9f;color:#2e4b37;font:600 12px/1.5 system-ui,sans-serif;text-align:center}.guild-page>.demo-banner{margin-left:260px}.guild-page .topbar{top:var(--demo-banner-height)}@media(max-width:960px){.guild-page>.demo-banner{margin-left:0}}@media(max-width:650px){:root{--demo-banner-height:48px}.demo-banner{padding:8px 14px;font-size:11px;line-height:16px}}';
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Demo-Data':'fictional',
  'Content-Security-Policy':"default-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
const recipes={
  bag:{id:1001,name:'Linen Bag'},bolt:{id:1002,name:'Bolt of Linen Cloth'},vest:{id:1003,name:'Green Linen Shirt'},
  potion:{id:1004,name:'Minor Healing Potion'},rage:{id:1005,name:'Rage Potion'},tube:{id:1006,name:'Copper Tube'},dummy:{id:1007,name:'Target Dummy'},
  stone:{id:1008,name:'Coarse Grinding Stone'},mace:{id:1009,name:'Bronze Mace'},wolf:{id:1010,name:'Spiced Wolf Meat'},boar:{id:1011,name:'Roasted Boar Meat'}
};
const rankLabels={'0':'Guildmaster','1':'Officer','2':'Veteran','3':'Member','4':'Initiate','5':'Reserve','6':'Recruit','7':'Newcomer','8':'Guest','9':'Visitor'};
const galleryTitles=['Moonlight at the lakeshore','The long road home','Campfire stories'];
const galleryIds=galleryTitles.map((_,index)=>`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index+1}`);
function demoGalleryArt(index){const colors=[['#1b3942','#547b76','#acc5a0'],['#8e5444','#bb8b62','#e3bf7d'],['#25354b','#4c5766','#a4a79c']][index];return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750"><rect width="1200" height="750" fill="${colors[0]}"/><circle cx="925" cy="160" r="65" fill="${colors[2]}"/><path d="M0 430 180 235 360 420 595 190 845 430 1080 240 1200 380V750H0Z" fill="${colors[1]}"/><path d="M0 540 220 420 425 500 650 370 900 505 1200 405V750H0Z" fill="${colors[0]}"/><path d="M400 750 590 510 625 510 780 750" fill="${colors[2]}" opacity=".35"/><g fill="${colors[2]}" opacity=".6"><path d="m130 540 30-105 30 105h-18v55h-24v-55ZM980 570l40-145 40 145h-25v60h-30v-60Z"/></g><text x="65" y="650" fill="#fff4d9" font-family="Georgia,serif" font-size="46">${galleryTitles[index]}</text><text x="67" y="695" fill="#fff4d9" font-family="sans-serif" font-size="20" letter-spacing="4">FICTIONAL GALLERY PREVIEW</text></svg>`;}
const demoPortrait='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 380"><defs><linearGradient id="paper" x2="0" y2="1"><stop stop-color="#e6d4ad"/><stop offset="1" stop-color="#f9f0de"/></linearGradient></defs><rect width="320" height="380" rx="14" fill="url(#paper)"/><circle cx="160" cy="120" r="77" fill="none" stroke="#b4965e" stroke-width="2"/><path d="M87 335c4-77 29-113 73-113s69 36 73 113" fill="#647653"/><path d="M124 99l36-44 36 44-14 17h-44z" fill="#53684a"/><circle cx="160" cy="145" r="42" fill="#d3b384"/><path d="M117 132c-2-49 88-54 86 0l-22-22-20 14-24-11z" fill="#66513a"/><path d="M128 184l32 30 32-30-6 34-26 20-26-20z" fill="#765b3c"/><path d="M104 258l56 28 56-28-12 50-44 34-44-34z" fill="#af8a45"/><path d="M260 320l-13-175 12-43 10 43-3 175" fill="#907348"/><text x="160" y="363" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#715b38">FICTIONAL DEMO PORTRAIT</text></svg>';
const profession=(name,id,skill,known=[],kind='Primary')=>({id,name,kind,tier:name,skill,max_skill:150,recipe_status:'observed',recipes:known});
function materialPlan(crafts=1){
  return {status:'verified',recipe_id:recipes.bag.id,recipe_name:recipes.bag.name,crafts,observed_at:observedAt,output:{value:1},
    direct:[{id:2001,name:'Bolt of Linen Cloth',quantity:3*crafts},{id:2002,name:'Coarse Thread',quantity:3*crafts}],
    shopping_list:[{id:2003,name:'Linen Cloth',quantity:6*crafts},{id:2002,name:'Coarse Thread',quantity:3*crafts}],
    components:[{recipe_id:recipes.bolt.id,recipe_name:recipes.bolt.name,crafts:3*crafts,required:3*crafts,produced:3*crafts,spare:0}],
    alternatives:[],warnings:['Fictional demonstration requirements; no provider API has been called.'],catalogue:{available:11,total:11}};
}
export function demoFixtures(){
  const rows=[
    [101,'Brann Oakshield','Paladin',2,25,1,['Tank','Healer'],'Tank',[profession('Mining',186,91),profession('Blacksmithing',164,86,[recipes.stone,recipes.mace])]],
    [102,'Liora Sunweaver','Priest',5,24,1,['Healer','Damage'],'Healer',[profession('Tailoring',197,95,[recipes.bag,recipes.bolt,recipes.vest]),profession('Enchanting',333,77)]],
    [103,'Orrin Quickstep','Rogue',4,23,2,['Damage'],'Damage',[profession('Skinning',393,105),profession('Leatherworking',165,82)]],
    [104,'Pippa Cogwhistle','Mage',8,20,2,['Damage'],'Damage',[profession('Engineering',202,88,[recipes.tube,recipes.dummy]),profession('Tailoring',197,72,[recipes.bag,recipes.bolt])]],
    [105,'Tamsin Hearthwood','Druid',11,22,1,['Healer','Damage'],'Healer',[profession('Alchemy',171,83,[recipes.potion,recipes.rage]),profession('Herbalism',182,94)]],
    [106,'Edda Moonbrook','Warlock',9,21,2,['Damage'],'Damage',[profession('Tailoring',197,65,[recipes.bag,recipes.bolt]),profession('Enchanting',333,48)]],
    [107,'Fenna Briarpath','Hunter',3,17,3,['Damage'],'Damage',[profession('Skinning',393,90),profession('Leatherworking',165,68)]],
    [108,'Dorrin Ironhand','Warrior',1,18,2,['Tank','Damage'],'Tank',[profession('Mining',186,81),profession('Blacksmithing',164,64,[recipes.stone])]],
    [109,'Merrin Cloudspark','Mage',8,12,3,['Damage'],'Damage',[profession('Herbalism',182,46),profession('Alchemy',171,37,[recipes.potion])]],
    [110,'Sable Willowmere','Priest',5,15,3,['Healer','Damage'],'Healer',[profession('Tailoring',197,48,[recipes.bag]),profession('Enchanting',333,32)]],
    [111,'Rowan Copperleaf','Warrior',1,10,3,['Tank','Damage'],'Tank',[profession('Mining',186,35),profession('Blacksmithing',164,22,[recipes.stone])]]
  ];
  const members=rows.map(([id,name,klass,class_id,level,rank,preferred_roles,primary_role,professions],index)=>({id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:klass,class_id,race:index%3===0?'Dwarf':index%3===1?'Human':'Night Elf',level,rank,
    preferred_roles,primary_role,role_preferences_updated_at:observedAt,roster_observed:observedAt,level_source:'character_profile',level_observed_at:observedAt,
    profile_at:observedAt,professions_at:observedAt,talents_at:observedAt,profile_status:'verified',professions_status:'verified',talents_status:'verified',
    professions:[...professions,profession('Cooking',185,35+index*6,[recipes.wolf,recipes.boar],'Secondary'),profession('First Aid',129,42+index*4,[],'Secondary')],
    talents:[{name:klass==='Druid'?'Restoration':'Adventurer build',points:level-9}]}));
  const owners=new Map([[101,'brann'],[102,'liora'],[103,'orrin'],[104,'pippa'],[105,'tamsin'],[106,'edda'],[107,'fenna'],[108,'dorrin'],[109,'tamsin'],[110,'tamsin'],[111,'tamsin']]);
  const isAlt=id=>owners.get(id)==='tamsin'&&id!==105;
  const links=members.map(member=>({character_id:member.id,user_id:'demo-'+owners.get(member.id),main_character_id:isAlt(member.id)?105:member.id}));
  const characters=members.filter(member=>owners.get(member.id)==='tamsin').map(member=>({...member,show_as_alt:member.id!==105}));
  const names={brann:'Oakshield',liora:'Liora',orrin:'Quietfoot',pippa:'Cogworks',tamsin:'moss.and.moon',edda:'Edda',fenna:'RangerFenna',dorrin:'Ironhand'};
  const people=Object.entries(names).map(([owner,display_name])=>({key:('fictional-'+owner).padEnd(43,'_'),display_name,discord_linked:true,name_status:'observed',identity_source:'provider',own:owner==='tamsin',characters:members.filter(member=>owners.get(member.id)===owner).map(member=>({...member,is_main:!isAlt(member.id),is_alt:isAlt(member.id),association:'provider',own:owner==='tamsin',title:member.id===105?'Keeper of the herb garden':'',biography:member.id===105?'A healer, a collector of herbs, and an enthusiastic believer in bringing snacks.':'',looking_for:member.id===105?'Relaxed dungeon parties and crafting friends.':''}))}));
  const starts=new Date();starts.setUTCDate(starts.getUTCDate()+1);starts.setUTCHours(21,0,0,0);
  const event={id:'demo-deadmines',title:'An evening in the Deadmines',kind:'Dungeon',status:'open',starts_at:starts.toISOString(),duration_minutes:120,capacity:5,location:'Moonbrook, Westfall',description:'A relaxed run, a few quests, and good company. New adventurers welcome.',host_name:'Brann Oakshield',character_id:101,own:false,
    signups:[{character_id:101,character_name:'Brann Oakshield',role:'Tank',source:'web',own:false},{character_id:105,character_name:'Tamsin Hearthwood',role:'Healer',source:'web',own:true}],role_limits:{Tank:1,Healer:1,Damage:3},pending_reactions:[]};
  const events=[
    {...event,id:'demo-ended',title:'An evening of fishing',kind:'Other',starts_at:new Date(Date.now()-3*3600000).toISOString(),
      location:'Crystal Lake, Elwynn Forest',description:'An evening by the water.',role_limits:null,signups:[]},
    event,
    {...event,id:'demo-cancelled',title:'A walk through Westfall',kind:'Roleplay',status:'cancelled',
      location:'Sentinel Hill, Westfall',description:'A quiet walk and a campfire.',role_limits:null,signups:[]}
  ];
  const requests=[
    {id:'demo-bags',kind:'craft',status:'open',recipe_id:1001,item_name:'Linen Bag',character_id:103,character_name:'Orrin Quickstep',quantity:2,created_at:observedAt,materials_preference:'provided',materials:materialPlan(2),notes:'Two bags for an adventurer whose pockets are always full.',targets:[{character_id:104,name:'Pippa Cogwhistle'}],asked_me:false,own:false,claimed_by_me:false,discord_channel_status:null},
    {id:'demo-potions',kind:'craft',status:'claimed',recipe_id:1004,item_name:'Minor Healing Potion',character_id:108,character_name:'Dorrin Ironhand',quantity:5,created_at:'2026-11-09T08:30:00.000Z',materials_preference:'discuss',materials:{status:'member_provided',manual:'5 Peacebloom, 5 Silverleaf and 5 Empty Vials.'},notes:'A little preparation before tomorrow’s adventure.',targets:[],crafter_name:'Tamsin Hearthwood',asked_me:false,own:false,claimed_by_me:true,discord_channel_status:null},
    {id:'demo-wishlist',kind:'learn',status:'open',recipe_id:null,item_name:'Red Linen Bag',character_id:102,character_name:'Liora Sunweaver',quantity:1,created_at:observedAt,notes:'Please keep an eye out while exploring.',targets:[],own:false}
  ];
  const hall={events,requests,directory:people.flatMap(person=>person.characters.map(character=>({...character,user_id:'demo-'+owners.get(character.id)}))),people,display_groups:rosterDisplayGroups(people),popular:[{recipe_id:1001,item_name:'Linen Bag',request_count:6,member_count:4,total_crafts:10,active_count:2},{recipe_id:1004,item_name:'Minor Healing Potion',request_count:4,member_count:3,total_crafts:20,active_count:1}]};
  const status={guild:{name:CONFIG.guild.name,ruleset:CONFIG.guild.region.toUpperCase()+' '+CONFIG.guild.ruleset.name},sync:{published:generation,membership_revision:generation,status:'ready',updated:observedAt,roster_at:observedAt,total:members.length},refresh:{last_success_at:observedAt,roster_at:observedAt,last_character_check_at:observedAt,oldest_professions_at:observedAt,latest_professions_at:observedAt,pending:0},demo:true};
  const me={signed_in:true,verified:true,is_admin:true,user_id:'demo-tamsin',display_name:'Tamsin Hearthwood',ownership_checked_at:observedAt,main_character_id:105,characters,player_links:links,csrf:'demo-read-only',message:'Fictional demonstration account. No real sign-in has taken place.',discord:{configured:true,linked:true,requester_dm:true,crafter_dm:false},demo:true};
  return {members,links,hall,status,me};
}
function publicCount(fixtures){return {guild_name:CONFIG.guild.name,region:CONFIG.guild.region.toUpperCase(),ruleset:CONFIG.guild.ruleset.name,game:'World of Warcraft Forever',member_count:fixtures.members.length,roster_member_count:fixtures.members.length,profile_verified_count:0,roster_observed_at:observedAt,demo:true};}
function history(fixtures,id){
  const member=fixtures.members.find(member=>member.id===id)||fixtures.members.find(member=>member.id===105),known=member.professions.find(profession=>profession.recipes.length)?.recipes[0];
  const changes=[{kind:'level',title:`Level: ${member.level-1} → ${member.level}`,observed_at:observedAt},...(known?[{kind:'recipe',title:'New recipe observed: '+known.name,detail:member.professions.find(profession=>profession.recipes.some(recipe=>recipe.id===known.id)).name,observed_at:'2026-11-09T08:15:00.000Z'}]:[])];
  const baseline={kind:'baseline',title:'Recorded baseline',detail:'Fictional demonstration history.',baseline:true,observed_at:'2026-11-08T18:00:00.000Z'};
  return {activity:changes.map((change,index)=>({id:'fictional-'+index,character_id:member.id,title:member.name+' · '+change.title,detail:change.detail||'',observed_at:change.observed_at})),observations:[...changes,baseline],snapshots:[],note:'Demo data: fictional dated changes, shown using the same interface as the real guild tracker.',demo:true};
}
function armory(fixtures,id){
  const member=fixtures.members.find(member=>member.id===id);if(!member)return null;
  const items=[
    {id:8101,slot:'CHEST',slot_name:'Chest',name:'Traveler’s Linen Tunic',quality:'UNCOMMON',item_level:18,item_subclass:'Cloth',inventory_type:'Chest',required_level:12,binding:'Soulbound',stats:[{display:'+4 Stamina'},{display:'+5 Intellect'}],enchantments_status:'not_returned',enchantments:[]},
    {id:8102,slot:'BACK',slot_name:'Back',name:'Woodland Wanderer’s Cloak',quality:'UNCOMMON',item_level:17,item_subclass:'Cloth',inventory_type:'Back',required_level:11,binding:'Binds when equipped',stats:[{display:'+3 Stamina'}],enchantments_status:'observed',enchantments:[]},
    {id:8103,slot:'HANDS',slot_name:'Hands',name:'Herbalist’s Handwraps',quality:'RARE',item_level:21,item_subclass:'Cloth',inventory_type:'Hands',required_level:16,stats:[{display:'+4 Intellect'},{display:'+2 Spirit'}],enchantments_status:'not_returned',enchantments:[]},
    {id:8104,slot:'FEET',slot_name:'Feet',name:'Soft Woodland Boots',quality:'UNCOMMON',item_level:16,item_subclass:'Cloth',inventory_type:'Feet',required_level:10,stats:[{display:'+3 Stamina'}],enchantments_status:'observed',enchantments:[{name:'Minor Stamina'}]},
    {id:8105,slot:'MAIN_HAND',slot_name:'Main hand',name:'Oakheart Walking Staff',quality:'RARE',item_level:23,item_subclass:'Staff',inventory_type:'Two-Hand',required_level:18,weapon_damage:'23–35 Damage',weapon_speed:3.2,stats:[{display:'+6 Intellect'},{display:'+4 Spirit'}],enchantments_status:'not_returned',enchantments:[]}
  ];
  const section=(data,status='verified')=>({status,data,observed_at:data?observedAt:null,checked_at:observedAt,note:'Fictional demonstration data; no Blizzard API request was made.'});
  return {character_id:id,sections:{equipment:section({items,equipped_item_level:19}),statistics:section({values:[{name:'Health',value:724},{name:'Mana',value:1050},{name:'Stamina',value:49},{name:'Intellect',value:65},{name:'Spirit',value:58},{name:'Armor',value:210},{name:'Spell critical chance',value:4.2,unit:'%'}]}),media:section({assets:[{key:'main',url:`/api/characters/${id}/armory/media/main`}]})},note:'All equipment, statistics and artwork in this preview are fictional. Missing slots are not inferred.',demo:true};
}
function adminOverview(fixtures){
  const analytics={started_at:'2026-10-20T09:00:00.000Z',
    today:{welcome_views:28,guild_views:19,sign_ins:7,accounts_signed_in:5},
    last_7_days:{welcome_views:167,guild_views:114,sign_ins:31,accounts_signed_in:8},
    last_30_days:{welcome_views:386,guild_views:259,sign_ins:77,accounts_signed_in:8}};
  const accounts=fixtures.members.slice(0,3).map((member,index)=>({
    name:member.name,characters:[member.name],signed_in:index!==2,battle_net_id:index===0?'12345678901234567890':null,
    battle_tag:index===0?'DemoAdventurer#1234':null,
    discord_ids:index===2?[]:[{id:index===0?'123456789012345678':'234567890123456789',source:index===0?'linked':'mapped',display_name:index===0?'Demo Adventurer':'Demo Smith'}],
    account_created_at:index===2?null:'2026-10-21T11:30:00.000Z',
    last_sign_in_at:[observedAt,'2026-11-08T17:25:00.000Z',null][index],
    recent_sign_ins:index===0?[observedAt,'2026-11-08T16:20:00.000Z']:[]
  }));
  return {checked_at:observedAt,analytics,accounts,health:{blizzard:{configured:true,status:'observed',last_success_at:observedAt,last_attempt_at:observedAt,failed_endpoints:0},scheduler:{status:'healthy',last_completed_at:observedAt},roster:{status:'published',observed_at:observedAt,completed_at:'2026-11-09T09:02:00.000Z'},discord:{configured:true,status:'configured',pending:1,failed:0,delivered:12,last_delivered_at:observedAt},backups:{status:'managed_by_host',note:'Fictional preview: backup availability is managed by the host; no restore check has been performed.'}},counts:{characters:fixtures.members.length,roster_characters:fixtures.members.length,profile_verified_characters:0,site_accounts:8,current_member_accounts:8,discord_linked_accounts:7,members_without_discord:1,unclaimed_characters:0},refresh:{due:1,waiting:8,unpublished:0,stale:0,failures:0,next_at:'2026-11-09T09:15:00.000Z'},attention:[{kind:'discord_unlinked',severity:'info',title:'Verified member accounts without linked Discord',count:1}],imports:[{observed_at:observedAt,completed_at:'2026-11-09T09:02:00.000Z',duration_ms:120000,member_count:9,joined:1,left:0,level_changes:3,rank_changes:1,baseline:false,status:'published'},{observed_at:'2026-11-09T08:45:00.000Z',completed_at:'2026-11-09T08:47:00.000Z',duration_ms:120000,member_count:8,joined:0,left:1,level_changes:2,rank_changes:0,baseline:false,status:'published'},{observed_at:'2026-11-09T08:30:00.000Z',completed_at:'2026-11-09T08:32:00.000Z',duration_ms:120000,member_count:9,joined:0,left:0,level_changes:1,rank_changes:0,baseline:false,status:'published'}],import_history_note:'Fictional demonstration imports. Real history begins when this feature is installed; changes reflect returned roster snapshots.',demo:true};
}
function apiData(path,url,fixtures){
  if(path==='/api/public')return publicCount(fixtures);
  if(path==='/api/event-templates')return {...EVENT_CATALOGUE,demo:true};
  if(path==='/api/gallery')return {items:url.searchParams.get('removed')==='1'?[]:galleryTitles.map((title,index)=>({id:galleryIds[index],title,caption:'An original fictional illustration for the read-only gallery preview. No member screenshot is shown.',author_name:['moss.and.moon','Oakshield','Cogworks'][index],created_at:observedAt,width:1200,height:750,image_url:`/api/gallery/${galleryIds[index]}/image`,thumbnail_url:`/api/gallery/${galleryIds[index]}/thumbnail`,can_manage:true,removed:false})),next:null,limits:{max_photos:200,max_bytes:100000000},can_upload:true,demo:true};
  if(path==='/api/status')return fixtures.status;
  if(path==='/api/members')return {generation,revision:generation,members:fixtures.members,next:null,demo:true};
  if(path==='/api/me')return fixtures.me;
  if(path==='/api/admin/overview')return adminOverview(fixtures);
  if(path==='/api/guild/ranks')return {labels:rankLabels,ranks:Object.entries(rankLabels).map(([rank,name])=>({rank:Number(rank),name,count:fixtures.members.filter(member=>member.rank===Number(rank)).length})),source:'suggested',demo:true};
  if(path==='/api/admin/status')return {...fixtures.status,configured:true,scheduler:{last_completed:observedAt},limits:['Fictional demonstration data; no provider API is called.'],refresh_policy:'Demo observations are fixed fictional fixtures.',demo:true};
  if(path==='/api/evidence')return {endpoints:[],demo:true};
  if(path==='/api/admin/discord')return {configured:false,client_id:'',guild_id:'',events_channel_id:'',craft_requests_channel_id:'',client_secret_set:false,bot_token_set:false,queue:[],verification:null,invite_url:null,callback:CONFIG.site.origin+'/auth/discord/callback',demo:true};
  if(path==='/api/admin/character-mappings')return {mappings:[],characters:fixtures.members,note:'Fictional preview; no live Discord identities are present.',demo:true};
  if(path==='/api/hall')return {...fixtures.hall,demo:true};
  if(path==='/api/history')return history(fixtures,Number(url.searchParams.get('character')));
  if(path==='/api/quests/areas')return {areas:[{id:40,name:'Westfall'},{id:12,name:'Elwynn Forest'}],observed_at:observedAt,demo:true};
  if(path==='/api/quests/compare')return {status:'observed',area:'Westfall',observed_at:observedAt,characters:[],quests:[],note:'Demo data: choose characters in a real installation to compare returned quest logs.',demo:true};
  if(/^\/api\/recipe\/\d+$/.test(path)){const crafts=Math.min(200,Math.max(1,Number(url.searchParams.get('crafts'))||1));return {...materialPlan(crafts),demo:true};}
  if(/^\/api\/crafters\/\d+$/.test(path)){
    const id=Number(path.split('/').at(-1));return {crafters:fixtures.members.filter(member=>member.professions.some(profession=>profession.recipes.some(recipe=>recipe.id===id))).map(member=>({character_id:member.id,name:member.name,class:member.class,verified:true,dm_available:false,dm_note:'Read-only demo; Discord messages are disabled.',observed_at:observedAt})),demo:true};
  }
  const talents=path.match(/^\/api\/characters\/(\d+)\/talents$/);
  if(talents){const id=Number(talents[1]),member=fixtures.members.find(member=>member.id===id);return {character_id:id,status:'verified',observed_at:observedAt,trees:member?[{id:1,name:member.talents[0].name,points:member.talents[0].points,layout_available:false,nodes:[{id:1,name:'A steady hand',rank:3,max_rank:5,description:'A fictional talent used for demonstrating the character folio.'},{id:2,name:'An adventurer’s resolve',rank:2,max_rank:5,description:'A fictional demonstration talent.'}]}]:[],note:'Demo data only.',demo:true};}
  const characterArmory=path.match(/^\/api\/characters\/(\d+)\/armory$/);if(characterArmory)return armory(fixtures,Number(characterArmory[1]));
  return null;
}
function demoHTML(html){return html.replace('</head>','<link rel="stylesheet" href="/demo.css"></head>').replace(/(<body\b[^>]*>)/,'$1<aside class="demo-banner" role="status">Demo data · Fictional characters and activity · Read-only preview</aside>');}
function reply(response,status,body,type='application/json; charset=utf-8',head=false){const content=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));response.writeHead(status,{...headers,'Content-Type':type,'Content-Length':content.byteLength});response.end(head?undefined:content);}
async function publicFile(path){
  if(path.includes('\\')||path.includes('\0')||path.split('/').some(part=>part==='.'||part==='..'||part.startsWith('.')))return null;
  if(!Object.hasOwn(types,extname(path).toLowerCase()))return null;
  const target=resolve(publicDirectory,'.'+path),rel=relative(publicDirectory,target);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))return null;
  try{
    const base=await realpath(publicDirectory),actual=await realpath(target),realRelative=relative(base,actual);
    if(isAbsolute(realRelative)||realRelative==='..'||realRelative.startsWith('..'+sep)||!(await stat(actual)).isFile())return null;
    return {body:await readFile(actual),type:types[extname(actual).toLowerCase()]};
  }catch{return null;}
}
export async function startDemoServer(options={}){
  if(Object.keys(options).some(key=>key!=='port'))throw Error('The demo accepts a port only and always binds to 127.0.0.1');
  const port=options.port??8788;if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Choose a valid local port');
  const fixtures=demoFixtures();
  const server=createServer(async(request,response)=>{
    try{
      const localPort=request.socket.localPort,allowed=new Set(['127.0.0.1:'+localPort,'localhost:'+localPort]);
      if(!allowed.has(request.headers.host)){reply(response,403,{error:'The demo is available only through its local address.'});return;}
      if(!['GET','HEAD'].includes(request.method)){reply(response,400,{error:readonlyMessage,demo:true});return;}
      if(!request.url?.startsWith('/')||request.url.startsWith('//')){reply(response,400,{error:'Invalid demo path'});return;}
      const url=new URL(request.url,'http://127.0.0.1'),path=decodeURIComponent(url.pathname),head=request.method==='HEAD';
      if(path==='/healthz'){reply(response,200,{status:'ok',demo:true},undefined,head);return;}
      if(path==='/demo.css'){reply(response,200,demoCSS,types['.css'],head);return;}
      const galleryImage=path.match(/^\/api\/gallery\/([^/]+)\/(image|thumbnail)$/);
      if(galleryImage){const index=galleryIds.indexOf(galleryImage[1]);reply(response,index>=0?200:404,index>=0?demoGalleryArt(index):{error:'Fictional gallery image not found',demo:true},index>=0?types['.svg']:undefined,head);return;}
      const portrait=path.match(/^\/api\/characters\/(\d+)\/armory\/media\/main$/);
      if(portrait){const known=fixtures.members.some(member=>member.id===Number(portrait[1]));reply(response,known?200:404,known?demoPortrait:{error:'Fictional character not found',demo:true},known?types['.svg']:undefined,head);return;}
      if(path.startsWith('/auth/')){reply(response,200,demoHTML('<!doctype html><html><head><meta charset="utf-8"><title>Read-only guild demo</title></head><body><main><h1>Read-only demonstration</h1><p>'+readonlyMessage+'</p><p>No Battle.net or Discord account is connected.</p><a href="/guild">Return to the demo guildhall</a></main></body></html>'),types['.html'],head);return;}
      if(path.startsWith('/api/')){const data=apiData(path,url,fixtures);reply(response,data?200:404,data||{error:'This endpoint is unavailable in the read-only demo.',demo:true},undefined,head);return;}
      const route=path==='/'||path==='/index.html'?'/welcome.html':path==='/guild'||path==='/guild/'?'/index.html':path;
      const file=await publicFile(route);if(!file){reply(response,404,{error:'Demo resource not found'});return;}
      reply(response,200,file.type.startsWith('text/html')?demoHTML(file.body.toString('utf8')):file.body,file.type,head);
    }catch{reply(response,400,{error:'The demo request could not be served.'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,url:'http://127.0.0.1:'+server.address().port};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);let port=8788;
  if(args.length){if(args.length!==2||args[0]!=='--port'||!/^\d+$/.test(args[1]))throw Error('Usage: node scripts/preview-demo.mjs [--port NUMBER]');port=Number(args[1]);}
  const {server,url}=await startDemoServer({port});console.log('Read-only fictional guild preview: '+url+'/guild#overview');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}
