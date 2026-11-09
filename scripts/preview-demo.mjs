// Screenshot/documentation preview only. This module does not import the
// production Worker, a database driver, environment secrets or provider APIs.
import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CONFIG} from '../src/config.mjs';

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
    [109,'Merrin Cloudspark','Mage',8,12,3,['Damage'],'Damage',[profession('Herbalism',182,46),profession('Alchemy',171,37,[recipes.potion])]]
  ];
  const members=rows.map(([id,name,klass,class_id,level,rank,preferred_roles,primary_role,professions],index)=>({id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:klass,class_id,race:index%3===0?'Dwarf':index%3===1?'Human':'Night Elf',level,rank,
    preferred_roles,primary_role,role_preferences_updated_at:observedAt,roster_observed:observedAt,level_source:'character_profile',level_observed_at:observedAt,
    profile_at:observedAt,professions_at:observedAt,talents_at:observedAt,profile_status:'verified',professions_status:'verified',talents_status:'verified',
    professions:[...professions,profession('Cooking',185,35+index*6,[recipes.wolf,recipes.boar],'Secondary'),profession('First Aid',129,42+index*4,[],'Secondary')],
    talents:[{name:klass==='Druid'?'Restoration':'Adventurer build',points:level-9}]}));
  const owners=new Map([[101,'brann'],[102,'liora'],[103,'orrin'],[104,'pippa'],[105,'tamsin'],[106,'edda'],[107,'fenna'],[108,'dorrin'],[109,'tamsin']]);
  const links=members.map(member=>({character_id:member.id,user_id:'demo-'+owners.get(member.id),main_character_id:member.id===109?105:member.id}));
  const characters=members.filter(member=>owners.get(member.id)==='tamsin').map(member=>({...member,show_as_alt:member.id!==105}));
  const names={brann:'Oakshield',liora:'Liora',orrin:'Quietfoot',pippa:'Cogworks',tamsin:'moss.and.moon',edda:'Edda',fenna:'RangerFenna',dorrin:'Ironhand'};
  const people=Object.entries(names).map(([owner,display_name])=>({key:'fictional-'+owner,display_name,discord_linked:true,name_status:'observed',identity_source:'provider',own:owner==='tamsin',characters:members.filter(member=>owners.get(member.id)===owner).map(member=>({...member,is_main:member.id!==109,is_alt:member.id===109,association:'provider',own:owner==='tamsin',title:member.id===105?'Keeper of the herb garden':'',biography:member.id===105?'A healer, a collector of herbs, and an enthusiastic believer in bringing snacks.':'',looking_for:member.id===105?'Relaxed dungeon parties and crafting friends.':''}))}));
  const starts=new Date();starts.setUTCDate(starts.getUTCDate()+1);starts.setUTCHours(21,0,0,0);
  const event={id:'demo-deadmines',title:'An evening in the Deadmines',kind:'Dungeon',status:'open',starts_at:starts.toISOString(),duration_minutes:120,capacity:5,location:'Moonbrook, Westfall',description:'A relaxed run, a few quests, and good company. New adventurers welcome.',host_name:'Brann Oakshield',character_id:101,own:false,
    signups:[{character_id:101,character_name:'Brann Oakshield',role:'Tank',source:'web',own:false},{character_id:105,character_name:'Tamsin Hearthwood',role:'Healer',source:'web',own:true}],role_limits:{Tank:1,Healer:1,Damage:3},pending_reactions:[]};
  const requests=[
    {id:'demo-bags',kind:'craft',status:'open',recipe_id:1001,item_name:'Linen Bag',character_id:103,character_name:'Orrin Quickstep',quantity:2,created_at:observedAt,materials_preference:'provided',materials:materialPlan(2),notes:'Two bags for an adventurer whose pockets are always full.',targets:[{character_id:104,name:'Pippa Cogwhistle'}],asked_me:false,own:false,claimed_by_me:false,discord_channel_status:null},
    {id:'demo-potions',kind:'craft',status:'claimed',recipe_id:1004,item_name:'Minor Healing Potion',character_id:108,character_name:'Dorrin Ironhand',quantity:5,created_at:'2026-11-09T08:30:00.000Z',materials_preference:'discuss',materials:{status:'member_provided',manual:'5 Peacebloom, 5 Silverleaf and 5 Empty Vials.'},notes:'A little preparation before tomorrow’s adventure.',targets:[],crafter_name:'Tamsin Hearthwood',asked_me:false,own:false,claimed_by_me:true,discord_channel_status:null},
    {id:'demo-wishlist',kind:'learn',status:'open',recipe_id:null,item_name:'Red Linen Bag',character_id:102,character_name:'Liora Sunweaver',quantity:1,created_at:observedAt,notes:'Please keep an eye out while exploring.',targets:[],own:false}
  ];
  const hall={events:[event],requests,directory:people.flatMap(person=>person.characters.map(character=>({...character,user_id:'demo-'+owners.get(character.id)}))),people,popular:[{recipe_id:1001,item_name:'Linen Bag',request_count:6,member_count:4,total_crafts:10,active_count:2},{recipe_id:1004,item_name:'Minor Healing Potion',request_count:4,member_count:3,total_crafts:20,active_count:1}]};
  const status={guild:{name:CONFIG.guild.name,ruleset:CONFIG.guild.region.toUpperCase()+' '+CONFIG.guild.ruleset.name},sync:{published:generation,membership_revision:generation,status:'ready',updated:observedAt,roster_at:observedAt,total:members.length},refresh:{last_success_at:observedAt,roster_at:observedAt,last_character_check_at:observedAt,oldest_professions_at:observedAt,latest_professions_at:observedAt,pending:0},demo:true};
  const me={signed_in:true,verified:true,is_admin:false,user_id:'demo-tamsin',display_name:'Tamsin Hearthwood',main_character_id:105,characters,player_links:links,csrf:'demo-read-only',message:'Fictional demonstration account. No real sign-in has taken place.',discord:{configured:false,linked:false},demo:true};
  return {members,links,hall,status,me};
}
function publicCount(fixtures){return {guild_name:CONFIG.guild.name,region:CONFIG.guild.region.toUpperCase(),ruleset:CONFIG.guild.ruleset.name,game:'World of Warcraft Forever',member_count:fixtures.members.length,roster_member_count:fixtures.members.length,profile_verified_count:0,roster_observed_at:observedAt,demo:true};}
function history(fixtures,id){
  const member=fixtures.members.find(member=>member.id===id)||fixtures.members.find(member=>member.id===105),known=member.professions.find(profession=>profession.recipes.length)?.recipes[0];
  const changes=[{kind:'level',title:`Level: ${member.level-1} → ${member.level}`,observed_at:observedAt},...(known?[{kind:'recipe',title:'New recipe observed: '+known.name,detail:member.professions.find(profession=>profession.recipes.some(recipe=>recipe.id===known.id)).name,observed_at:'2026-11-09T08:15:00.000Z'}]:[])];
  const baseline={kind:'baseline',title:'Recorded baseline',detail:'Fictional demonstration history.',baseline:true,observed_at:'2026-11-08T18:00:00.000Z'};
  return {activity:changes.map((change,index)=>({id:'fictional-'+index,character_id:member.id,title:member.name+' · '+change.title,detail:change.detail||'',observed_at:change.observed_at})),observations:[...changes,baseline],snapshots:[],note:'Demo data: fictional dated changes, shown using the same interface as the real guild tracker.',demo:true};
}
function apiData(path,url,fixtures){
  if(path==='/api/public')return publicCount(fixtures);
  if(path==='/api/status')return fixtures.status;
  if(path==='/api/members')return {generation,revision:generation,members:fixtures.members,next:null,demo:true};
  if(path==='/api/me')return fixtures.me;
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
