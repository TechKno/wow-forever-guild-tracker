import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {authRoute,currentUser,digest,random,ORIGIN,CALLBACK} from '../src/auth.mjs';
import {buildMaterialPlan,normalizeRecipe} from '../src/materials.mjs';
import {flushDiscord,discordAuth,dungeonPayload} from '../src/discord.mjs';
import {compareQuests,characterQuests} from '../src/quests.mjs';
import {recordProgress} from '../src/progress.mjs';
import {publishEventPost,pollOneEventPost,eventAnnouncement,effectivePermissions,reactionRoles} from '../src/event-posts.mjs';
import {signupStatement,roleLimits} from '../src/events.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
async function seedOpenRequests(DB,owner,character,count,kind='craft'){
  for(let n=0;n<count;n++)await DB.prepare("INSERT INTO requests(id,kind,owner_id,character_id,item_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(crypto.randomUUID(),kind,owner,character,'Existing request',new Date().toISOString(),new Date().toISOString()).run();
}
const root={id:100,name:'Fine Widget',verified:true,output:{id:500,value:1},reagents:[{id:2,name:'Metal Bar',quantity:3},{id:3,name:'Metal Tube',quantity:1}]};
const bar={id:200,name:'Smelt Bars',verified:true,output:{id:2,value:2},reagents:[{id:1,name:'Ore',quantity:3}]};
const tube={id:300,name:'Make Tube',verified:true,output:{id:3,value:1},reagents:[{id:2,name:'Metal Bar',quantity:1}]};
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database();await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(const [id,name]of [[101,'Alice Example'],[102,'Bob Example'],[103,'Charlie Example']]){
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',name.toLowerCase().replace(' ','-'),id,JSON.stringify({id,name,slug:name.toLowerCase().replace(' ','-'),class:'Mage',level:20})).run();
    await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(id,JSON.stringify({professions:[{name:'Engineering',recipes:[{id:100,name:'Fine Widget'},{id:200,name:'Smelt Bars'},{id:300,name:'Make Tube'}]}]}),new Date().toISOString()).run();
  }
  for(const recipe of [root,bar,tube])await DB.prepare('INSERT INTO recipe_details VALUES(?,?,?)').bind(recipe.id,JSON.stringify(recipe),epoch()+10000).run();
  const env={DB};
  async function user(id,char){
    const token=random(),csrf=random(),now=new Date().toISOString();
    await DB.prepare('INSERT INTO users VALUES(?,?,?,\'verified\',?,?,?)').bind(id,'subject-'+id,char,epoch(),now,now).run();
    await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(char,id,now).run();
    await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,epoch()+3600).run();
    return {id,token,csrf,request(path,body,options={}){return new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-wv_session='+token,Origin:options.origin||ORIGIN,'Content-Type':'application/json','X-CSRF-Token':options.csrf??csrf},body:body===undefined?undefined:JSON.stringify(body)});}};
  }
  return {env,DB,a:await user('user-a',101),b:await user('user-b',102),c:await user('user-c',103)};
}
test('component demands are combined before rounding recipe yields',()=>{
  const plan=buildMaterialPlan(root,2,[root,bar,tube]);
  assert.deepEqual(plan.shopping_list,[{id:1,name:'Ore',quantity:12}]);
  assert.equal(plan.components.find(c=>c.item_id===2).required,8);
  assert.equal(plan.components.find(c=>c.item_id===2).crafts,4);
});
test('alternative producers require a choice and ready-made components remain an option',()=>{
  const alternative={...bar,id:201,output:{id:2,value:1}};
  const undecided=buildMaterialPlan(root,1,[bar,tube,alternative]);
  assert(undecided.shopping_list.some(r=>r.id===2));assert(undecided.warnings.some(w=>w.includes('alternative')));
  const chosen=buildMaterialPlan(root,1,[bar,tube,alternative],{'2':200});assert(chosen.shopping_list.some(r=>r.id===1));
  const ready=buildMaterialPlan(root,1,[bar,tube],{'2':0});assert(ready.shopping_list.some(r=>r.id===2));
});
test('cycles, unknown yields and absent reagent data never invent raw materials',()=>{
  const a={id:1,name:'A',verified:true,output:{id:10,value:1},reagents:[{id:20,name:'B',quantity:1}]};
  const b={id:2,name:'B',verified:true,output:{id:20,value:1},reagents:[{id:10,name:'A',quantity:1}]};
  const p=buildMaterialPlan({...root,reagents:[{id:10,name:'A',quantity:1}]},1,[a,b]);
  assert.deepEqual(p.shopping_list,[{id:10,name:'A',quantity:1}]);assert(p.warnings.some(w=>w.includes('cyclic')));
  const uncertain=buildMaterialPlan(root,1,[{...bar,output:{id:2,minimum:1,maximum:3}},tube]);assert(uncertain.shopping_list.some(r=>r.id===2));
  assert.equal(normalizeRecipe({id:100,name:'Unknown'}).verified,false);
  assert.equal(buildMaterialPlan({id:100,verified:false},1,[]).status,'unavailable');
});
test('guild-only data and writes require a current verified member and CSRF protection',async()=>{
  const {env,a}=await fixture();
  assert.equal((await worker.fetch(new Request(ORIGIN+'/api/hall'),env)).status,401);
  assert.equal((await worker.fetch(a.request('/api/hall/main',{character_id:101},{origin:'https://attacker.example'}),env)).status,403);
  assert.equal((await worker.fetch(a.request('/api/hall/main',{character_id:101},{csrf:'wrong'}),env)).status,403);
  assert.equal((await worker.fetch(a.request('/api/hall/profile',{character_id:102,title:'Impersonation'}),env)).status,403);
});
test('craft requests persist the verified full material list and enforce ownership',async()=>{
  const {env,DB,a,b,c}=await fixture();
  const created=await worker.fetch(a.request('/api/hall/requests',{kind:'craft',character_id:101,recipe_id:100,quantity:2,materials:'provided'}),env);
  assert.equal(created.status,200,await created.text());
  const row=await DB.prepare('SELECT * FROM requests').first();assert.equal(JSON.parse(row.materials_json).shopping_list[0].quantity,12);
  assert.equal((await worker.fetch(b.request('/api/hall/requests/'+row.id,{action:'complete'}),env)).status,403);
  assert.equal((await worker.fetch(b.request('/api/hall/requests/'+row.id,{action:'claim'}),env)).status,200);
  assert.equal((await worker.fetch(c.request('/api/hall/requests/'+row.id,{action:'claim'}),env)).status,409);
  assert.equal((await worker.fetch(a.request('/api/hall/requests/'+row.id,{action:'complete'}),env)).status,200);
  const hall=await (await worker.fetch(a.request('/api/hall'),env)).json();assert.equal(hall.popular[0].request_count,1);assert.equal(hall.popular[0].total_crafts,2);
});

test('active crafting limits are isolated per member and completed requests release a place',async()=>{
  const {env,DB,a,b}=await fixture();botEnv(env);env.DISCORD_CRAFT_REQUESTS_CHANNEL_ID='456789012345678901';
  await seedOpenRequests(DB,a.id,101,20);
  const body=character_id=>({kind:'craft',character_id,recipe_id:100,quantity:1});
  const blocked=await worker.fetch(a.request('/api/hall/requests',body(101)),env);assert.equal(blocked.status,429);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n,0);
  assert.equal((await worker.fetch(b.request('/api/hall/requests',body(102)),env)).status,200);
  await DB.prepare("UPDATE requests SET status='complete' WHERE id=(SELECT id FROM requests WHERE owner_id=? LIMIT 1)").bind(a.id).run();
  assert.equal((await worker.fetch(a.request('/api/hall/requests',body(101)),env)).status,200);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM requests WHERE owner_id=? AND status IN ('open','claimed')").bind(a.id).first()).n,20);
});

test('a concurrent request reaching the active limit cannot create orphan targets or Discord jobs',async()=>{
  const {env,DB,a}=await fixture();botEnv(env);env.DISCORD_CRAFT_REQUESTS_CHANNEL_ID='456789012345678901';
  await seedOpenRequests(DB,a.id,101,19);
  const batch=DB.batch;let injected=false;
  DB.batch=async statements=>{if(!injected){injected=true;await seedOpenRequests(DB,a.id,101,1);}return batch(statements);};
  const response=await worker.fetch(a.request('/api/hall/requests',{kind:'craft',character_id:101,recipe_id:100,quantity:1}),env);
  assert.equal(response.status,429);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM requests').first()).n,20);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM request_targets').first()).n,0);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM state WHERE key LIKE 'discord_craft_target:%'").first()).n,0);
});

test('wishlists have a separate bounded active limit without blocking crafting',async()=>{
  const {env,DB,a}=await fixture();await seedOpenRequests(DB,a.id,101,100,'learn');
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{kind:'learn',character_id:101,item_name:'Another wish'}),env)).status,429);
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{kind:'craft',character_id:101,recipe_id:100,quantity:1}),env)).status,200);
});

test('active event limits are per host and cancelled or finished events do not consume places',async()=>{
  const {env,DB,a,b}=await fixture();botEnv(env);env.DISCORD_EVENTS_CHANNEL_ID='345678901234567890';
  const body=character_id=>({character_id,title:'Example expedition',kind:'Dungeon',starts_at:new Date(Date.now()+86400000).toISOString(),capacity:5});
  for(let n=0;n<5;n++)assert.equal((await worker.fetch(a.request('/api/hall/events',body(101)),env)).status,200);
  const jobs=(await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n;
  assert.equal((await worker.fetch(a.request('/api/hall/events',body(101)),env)).status,429);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n,jobs);
  assert.equal((await worker.fetch(b.request('/api/hall/events',body(102)),env)).status,200);
  await DB.prepare("UPDATE events SET status='cancelled' WHERE id=(SELECT id FROM events WHERE owner_id=? LIMIT 1)").bind(a.id).run();
  assert.equal((await worker.fetch(a.request('/api/hall/events',body(101)),env)).status,200);
  await DB.prepare("UPDATE events SET starts_at=? WHERE id=(SELECT id FROM events WHERE owner_id=? AND status='open' LIMIT 1)").bind(new Date(Date.now()-86400000).toISOString(),a.id).run();
  assert.equal((await worker.fetch(a.request('/api/hall/events',body(101)),env)).status,200);
});

test('unchanged website event joins and absent leaves do not mutate signups or queue bot work',async()=>{
  const {env,DB,a,b}=await fixture();botEnv(env);env.DISCORD_EVENTS_CHANNEL_ID='345678901234567890';
  assert.equal((await worker.fetch(a.request('/api/hall/events',{character_id:101,title:'Quiet expedition',kind:'Dungeon',starts_at:new Date(Date.now()+86400000).toISOString(),capacity:5}),env)).status,200);
  const event=await DB.prepare('SELECT * FROM events').first(),path='/api/hall/events/'+event.id;
  const join={action:'join',character_id:101,role:'Damage',note:'Ready'};
  assert.equal((await worker.fetch(a.request(path,join),env)).status,200);
  const before=await DB.prepare('SELECT * FROM event_signups').first(),jobs=(await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n;
  assert.equal((await worker.fetch(a.request(path,join),env)).status,200);
  assert.equal((await worker.fetch(b.request(path,{action:'leave'}),env)).status,200);
  assert.deepEqual(await DB.prepare('SELECT * FROM event_signups').first(),before);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n,jobs);
  assert.equal((await worker.fetch(a.request(path,{action:'leave'}),env)).status,200);
  const leftJobs=(await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n;
  assert.equal((await worker.fetch(a.request(path,{action:'leave'}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n,leftJobs);
});
test('manual requirements are explicit and cancelled requests do not inflate most-requested',async()=>{
  const {env,DB,a}=await fixture();
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{kind:'craft',character_id:101,item_name:'Unknown item',quantity:1}),env)).status,400);
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{kind:'craft',character_id:101,item_name:'Unknown item',quantity:1,manual_materials:'2 Example Bars'}),env)).status,200);
  const row=await DB.prepare('SELECT * FROM requests').first();assert.equal(JSON.parse(row.materials_json).status,'member_provided');
  await worker.fetch(a.request('/api/hall/requests/'+row.id,{action:'cancel'}),env);
  const hall=await (await worker.fetch(a.request('/api/hall'),env)).json();assert.equal(hall.popular.length,0);
});
test('event places cannot be overbooked or assigned to someone else’s character',async()=>{
  const {env,DB,a,b}=await fixture();
  const response=await worker.fetch(a.request('/api/hall/events',{character_id:101,title:'Example expedition',kind:'Dungeon',starts_at:new Date(Date.now()+86400000).toISOString(),capacity:1}),env);
  assert.equal(response.status,200);const event=await DB.prepare('SELECT * FROM events').first();
  assert.equal((await worker.fetch(b.request('/api/hall/events/'+event.id,{action:'join',character_id:101,role:'Tank'}),env)).status,403);
  assert.equal((await worker.fetch(a.request('/api/hall/events/'+event.id,{action:'join',character_id:101,role:'Healer'}),env)).status,200);
  assert.equal((await worker.fetch(b.request('/api/hall/events/'+event.id,{action:'join',character_id:102,role:'Damage'}),env)).status,409);
  assert.equal((await worker.fetch(b.request('/api/hall/events/'+event.id,{action:'cancel'}),env)).status,403);
});
test('guild removal immediately revokes community access without trusting an old session',async()=>{
  const {env,DB,a}=await fixture();await DB.prepare('DELETE FROM membership WHERE character_id=101').run();
  assert.equal((await currentUser(a.request('/api/me'),env)).verified,false);
  const session=await worker.fetch(a.request('/api/me'),env);assert.equal(session.status,403);assert(!Object.hasOwn(await session.json(),'characters'));
  assert.equal((await worker.fetch(a.request('/api/hall'),env)).status,403);
});
test('main and alt grouping is based on verified ownership and is never exposed to signed-out visitors',async()=>{
  const {env,DB,a}=await fixture();
  await DB.prepare("UPDATE character_links SET user_id='user-a' WHERE character_id=103").run();
  const session=await (await worker.fetch(a.request('/api/me'),env)).json();
  assert.deepEqual(session.characters.map(c=>c.id).sort(),[101,103]);
  assert.equal(session.player_links.filter(l=>l.user_id==='user-a').length,2);
  assert.equal((await worker.fetch(a.request('/api/hall/main',{character_id:103}),env)).status,200);
  const changed=await (await worker.fetch(a.request('/api/me'),env)).json();assert.equal(changed.main_character_id,103);
  assert(changed.player_links.filter(l=>l.user_id==='user-a').every(l=>l.main_character_id===103));
  const denied=await worker.fetch(new Request(ORIGIN+'/api/me'),env);assert.equal(denied.status,401);const publicView=await denied.json();assert(!Object.hasOwn(publicView,'player_links'));assert(!Object.hasOwn(publicView,'characters'));
});
test('OAuth state is browser bound, one-use, and only matched guild characters are saved',async()=>{
  const {env,DB}=await fixture();env.BLIZZARD_CLIENT_ID='fixture-client';env.BLIZZARD_CLIENT_SECRET='fixture-secret';
  const login=await authRoute(new Request(ORIGIN+'/auth/login'),env);
  const target=new URL(login.headers.get('Location')),state=target.searchParams.get('state'),binding=login.headers.get('Set-Cookie').split(';')[0];
  assert.equal(target.searchParams.get('redirect_uri'),CALLBACK);assert.equal(target.searchParams.get('code_challenge_method'),'S256');
  const callback=new Request(CALLBACK+'?state='+state+'&code=fixture-code',{headers:{Cookie:binding}});
  const wrong=await authRoute(new Request(CALLBACK+'?state='+state+'&code=fixture-code'),env);assert(wrong.headers.get('Location').includes('invalid_state'));
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert(!url.includes('fixture-secret'));assert.equal(options.redirect,'manual');
    if(url.endsWith('/token')){assert(options.body.includes('code_verifier='));return Response.json({access_token:'fixture-user-token'});}
    if(url.endsWith('/userinfo'))return Response.json({sub:'777',id:777,battletag:'NeverStore#777'});
    return Response.json({wow_accounts:[{characters:[{id:101},{id:999999}]}]});
  };
  try{
    const result=await authRoute(callback,env);assert.equal(result.status,303);assert.equal(result.headers.get('Location'),'/guild#overview');
    const user=await DB.prepare("SELECT * FROM users WHERE subject_hash=?").bind(await digest('https://oauth.battle.net|777')).first();assert.equal(user.ownership_status,'verified');
    const links=await DB.prepare('SELECT * FROM character_links WHERE user_id=?').bind(user.id).all();assert.deepEqual(links.results.map(c=>c.character_id),[101]);
    const serialized=JSON.stringify((await DB.prepare('SELECT * FROM users').all()).results)+JSON.stringify((await DB.prepare('SELECT * FROM sessions').all()).results);
    assert(!serialized.includes('NeverStore'));assert(!serialized.includes('fixture-user-token'));assert(!serialized.includes('fixture-secret'));
    const replay=await authRoute(callback,env);assert(replay.headers.get('Location').includes('expired'));
    assert(result.headers.get('Set-Cookie').includes('HttpOnly'));assert(result.headers.get('Set-Cookie').includes('Secure'));
  }finally{globalThis.fetch=original;}
});
test('progress records observed level, skill and recipe changes without fabricating a past baseline',async()=>{
  const {env,DB,a}=await fixture();const before={profile_status:'verified',profile:{level:19},professions_at:'before',professions:[{id:1,name:'Engineering',tier:'',skill:50,recipe_status:'observed',recipes:[]}]};
  const after={profile_status:'verified',profile:{level:20},professions_status:'verified',professions:[{id:1,name:'Engineering',tier:'',skill:60,recipe_status:'observed',recipes:[{id:100,name:'Fine Widget'}]}]};
  await recordProgress(env,{id:101,name:'Alice Example'},before,after);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM activity').first()).n,3);
  const response=await worker.fetch(a.request('/api/history?character=101'),env);assert.equal(response.status,200);const history=await response.json();assert.equal(history.snapshots[0].level,20);assert.equal(history.activity.length,3);
});

function botEnv(env){Object.assign(env,{DISCORD_CLIENT_ID:'123456789012345678',DISCORD_GUILD_ID:'234567890123456789',DISCORD_CLIENT_SECRET:'test-client-secret',DISCORD_BOT_TOKEN:'test-bot-token'});}
async function link(DB,user,discord,requester,crafter){await DB.prepare('INSERT INTO discord_links VALUES(?,?,?,?,?)').bind(user,discord,requester,crafter,new Date().toISOString()).run();}

test('admin identity is pinned server-side and connection endpoints reject everyone else',async()=>{
  const {env,a,b}=await fixture();env.ADMIN_USER_IDS=a.id;
  for(const path of ['/api/admin/status','/api/evidence','/api/admin/discord']){
    assert.equal((await worker.fetch(new Request(ORIGIN+path),env)).status,401);
    assert.equal((await worker.fetch(b.request(path),env)).status,403);
    assert.equal((await worker.fetch(a.request(path),env)).status,200);
  }
  const memberResponse=await worker.fetch(b.request('/api/status'),env);assert.equal(memberResponse.status,200);const memberStatus=await memberResponse.json();
  assert(!('configured' in memberStatus));assert(!('scheduler' in memberStatus));assert(!('message' in memberStatus.sync));
  assert.equal((await worker.fetch(b.request('/api/admin/discord',{client_id:'123456789012345678',guild_id:'234567890123456789',is_admin:true}),env)).status,403);
});

test('members explicitly choose which verified alts to group and cannot claim another account character',async()=>{
  const {env,DB,a,b}=await fixture();await DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=102').bind(a.id).run();
  assert.equal((await worker.fetch(a.request('/api/hall/main',{character_id:101,alt_ids:[]}),env)).status,200);
  let me=await (await worker.fetch(a.request('/api/me'),env)).json();assert(!me.player_links.some(l=>l.character_id===102));assert(me.characters.some(c=>c.id===102));
  assert.equal((await worker.fetch(a.request('/api/hall/main',{character_id:101,alt_ids:[102]}),env)).status,200);
  me=await (await worker.fetch(a.request('/api/me'),env)).json();assert(me.player_links.some(l=>l.character_id===102));
  assert.equal((await worker.fetch(a.request('/api/hall/main',{character_id:101,alt_ids:[103]}),env)).status,403);
  assert.equal((await worker.fetch(b.request('/api/hall/main',{character_id:101,alt_ids:[102]}),env)).status,403);
});

test('quest comparison distinguishes absent from unavailable and never asserts share eligibility',async()=>{
  const list=compareQuests([{id:1,name:'Quest'},{id:2,name:'Other'}],[{id:1,name:'A',active:[{id:1}],completed:[]},{id:2,name:'B',active:[],completed:[{id:2}]},{id:3,name:'C',active:null,completed:null}]);
  assert.deepEqual(list[0].characters.map(c=>c.state),['in_progress','not_observed','unknown']);assert.equal(list[1].characters[1].state,'completed');
  assert.equal(compareQuests([{id:1}],[{id:1,active:[{id:1}],completed:[{id:1}]}])[0].characters[0].state,'in_progress','repeatable quests can be active despite past completions');
  const {env,DB,a}=await fixture();assert.equal((await worker.fetch(new Request(ORIGIN+'/api/quests/areas'),env)).status,401);
  const key='profile:/profile/wow/character/alice-example/quests';
  await DB.prepare('INSERT INTO api_cache VALUES(?,?,?)').bind(key,JSON.stringify({data:{in_progress:[{id:'bad'}]},observed_at:'2026-01-01'}),epoch()+300).run();
  await DB.prepare('INSERT INTO api_cache VALUES(?,?,?)').bind(key+'/completed',JSON.stringify({data:{quests:[]},observed_at:'2026-01-01'}),epoch()+300).run();
  const data=await characterQuests(env,{id:101,name:'Alice',slug:'alice-example'});assert.equal(data.active,null);assert.deepEqual(data.completed,[]);
  assert.equal((await worker.fetch(a.request('/api/quests/compare?area=12&characters=101,999'),env)).status,400);
});

test('crafting DMs are queued atomically for requester and matching opted-in crafters and deduplicated',async()=>{
  const {env,DB,a,b,c}=await fixture();botEnv(env);
  await link(DB,a.id,'345678901234567890',1,0);await link(DB,b.id,'456789012345678901',0,1);await link(DB,c.id,'567890123456789012',0,0);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified')").run();
  const response=await worker.fetch(a.request('/api/hall/requests',{character_id:101,kind:'craft',recipe_id:100,quantity:2,target_character_ids:[102]}),env);assert.equal(response.status,200);
  let jobs=await DB.prepare('SELECT * FROM discord_outbox').all();assert.equal(jobs.results.length,2);assert.deepEqual(new Set(jobs.results.map(j=>j.user_id)),new Set([a.id,b.id]));
  const old=globalThis.fetch,sends=[];try{
    globalThis.fetch=async(url,options)=>{assert.equal(options.headers.Authorization,'Bot test-bot-token');const body=JSON.parse(options.body);if(url.endsWith('/users/@me/channels'))return Response.json({id:'678901234567890123'});sends.push(body);return Response.json({id:'789012345678901234'});};
    await flushDiscord(env);await flushDiscord(env);assert.equal(sends.length,2);for(const body of sends){assert.deepEqual(body.allowed_mentions,{parse:[]});assert(body.enforce_nonce);assert(body.content.includes('Fine Widget'));}
    const row=await DB.prepare('SELECT * FROM requests').first();
    assert.equal((await worker.fetch(b.request('/api/hall/requests/'+row.id,{action:'claim'}),env)).status,200);
    assert.equal((await worker.fetch(c.request('/api/hall/requests/'+row.id,{action:'claim'}),env)).status,409);
    jobs=await DB.prepare("SELECT * FROM discord_outbox WHERE status='pending'").all();assert.equal(jobs.results.length,1);
    // Opting out before delivery must suppress already queued requester messages.
    await worker.fetch(a.request('/api/hall/discord',{requester_dm:false,crafter_dm:false}),env);await flushDiscord(env);assert.equal(sends.length,2);
  }finally{globalThis.fetch=old;}
  const me=await (await worker.fetch(a.request('/api/me'),env)).text();assert(!me.includes('345678901234567890'));
});

test('Discord throttling delays delivery and does not retry inside the same tick',async()=>{
  const {env,DB,a}=await fixture();botEnv(env);await link(DB,a.id,'345678901234567890',1,0);
  await worker.fetch(a.request('/api/hall/requests',{character_id:101,kind:'craft',recipe_id:100,quantity:1}),env);
  const old=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return Response.json({retry_after:125},{status:429});};await flushDiscord(env);await flushDiscord(env);assert.equal(calls,1);const job=await DB.prepare('SELECT * FROM discord_outbox').first();assert.equal(job.status,'pending');assert(job.next_at>=epoch()+120);}finally{globalThis.fetch=old;}
});

test('dungeon events mirror once, reconcile timed-out creates, and propagate cancellation',async()=>{
  const {env,DB,a}=await fixture();botEnv(env);
  const starts=new Date(Date.now()+86400000).toISOString();
  assert.equal((await worker.fetch(a.request('/api/hall/events',{character_id:101,title:'Dungeon evening',kind:'Dungeon',starts_at:starts,duration_minutes:90}),env)).status,200);
  const event=await DB.prepare('SELECT * FROM events').first(),payload=dungeonPayload(event);assert.equal(Date.parse(payload.scheduled_end_time)-Date.parse(starts),90*60000);assert.equal(payload.entity_type,3);
  const old=globalThis.fetch,calls=[];let existing=[];try{
    globalThis.fetch=async(url,options)=>{calls.push({url,options});if(options.method==='GET'&&url.endsWith('/scheduled-events'))return Response.json(existing);if(options.method==='POST'){existing=[{id:'678901234567890123',description:payload.description,status:1,guild_id:env.DISCORD_GUILD_ID,creator_id:env.DISCORD_CLIENT_ID}];return Response.json(existing[0]);}if(options.method==='GET')return Response.json(existing[0]);return Response.json({status:4});};
    await flushDiscord(env);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
    // Simulate a crash after Discord accepted the event but before local mapping was saved.
    await DB.prepare('DELETE FROM discord_events').run();await DB.prepare("UPDATE discord_outbox SET status='pending'").run();await flushDiscord(env);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
    await worker.fetch(a.request('/api/hall/events/'+event.id,{action:'cancel'}),env);await flushDiscord(env);assert(calls.some(c=>c.options.method==='DELETE'&&c.url.endsWith('/scheduled-events/678901234567890123')));
  }finally{globalThis.fetch=old;}
});

test('Discord linking is bound to the signed-in member session and notifications start opted out',async()=>{
  const {env,DB,a,b}=await fixture();botEnv(env);
  const login=await discordAuth(a.request('/auth/discord/login'),env),url=new URL(login.headers.get('Location'));assert.equal(url.searchParams.get('scope'),'identify');assert(url.searchParams.get('code_challenge'));
  const callback='/auth/discord/callback?state='+url.searchParams.get('state')+'&code=test-code';
  assert((await discordAuth(b.request(callback),env)).headers.get('Location').includes('failed'));
  const old=globalThis.fetch;try{
    globalThis.fetch=async(url,options)=>url.endsWith('/oauth2/token')?Response.json({access_token:'never-save-this-token'}):Response.json({id:'345678901234567890',username:'not-stored'});
    assert((await discordAuth(a.request(callback),env)).headers.get('Location').includes('linked'));
    const link=await DB.prepare('SELECT * FROM discord_links').first();assert.equal(link.user_id,a.id);assert.equal(link.requester_dm,0);assert.equal(link.crafter_dm,0);
    assert((await discordAuth(a.request(callback),env)).headers.get('Location').includes('failed'));
    assert(!(await DB.prepare('SELECT * FROM state').all()).results.some(r=>r.value.includes('never-save')));
  }finally{globalThis.fetch=old;}
});


test('administrator bot installation uses the complete code grant without linking other members or changing settings',async()=>{
  const {env,DB,a,b}=await fixture();botEnv(env);env.ADMIN_USER_IDS=a.id;
  assert.equal((await worker.fetch(b.request('/auth/discord/install'),env)).status,403);
  const install=await discordAuth(a.request('/auth/discord/install'),env),target=new URL(install.headers.get('Location'));
  assert.equal(target.searchParams.get('response_type'),'code');assert.equal(target.searchParams.get('scope'),'bot identify');assert.equal(target.searchParams.get('permissions'),'17592186044416');assert.equal(target.searchParams.get('guild_id'),env.DISCORD_GUILD_ID);
  const callback='/auth/discord/callback?state='+target.searchParams.get('state')+'&code=test-install-code';
  const old=globalThis.fetch;try{
    globalThis.fetch=async(url,options)=>url.endsWith('/oauth2/token')?Response.json({access_token:'discard-install-token',guild:{id:env.DISCORD_GUILD_ID}}):Response.json({id:env.DISCORD_GUILD_ID});
    const done=await discordAuth(a.request(callback),env);assert(done.headers.get('Location').includes('installed'));assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_links').first()).n,0);
    assert((await discordAuth(a.request(callback),env)).headers.get('Location').includes('failed'));
  }finally{globalThis.fetch=old;}
});


test('bot diagnostics verify the configured application without exposing private values',async()=>{
  const {env,a,b}=await fixture();botEnv(env);env.ADMIN_USER_IDS=a.id;
  assert.equal((await worker.fetch(b.request('/api/admin/discord',{check:true}),env)).status,403);
  const old=globalThis.fetch;try{globalThis.fetch=async url=>url.endsWith('/applications/@me')?Response.json({id:env.DISCORD_CLIENT_ID,name:'Guild Scribe'}):Response.json({id:env.DISCORD_GUILD_ID,name:'Guild'});
    const response=await worker.fetch(a.request('/api/admin/discord',{check:true}),env),raw=await response.text(),data=JSON.parse(raw);assert(data.verification.bot_verified);assert(data.verification.installed);assert(!raw.includes(env.DISCORD_BOT_TOKEN));assert(!raw.includes(env.DISCORD_CLIENT_SECRET));
    globalThis.fetch=async()=>Response.json({id:'999999999999999999'});const mismatch=await(await worker.fetch(a.request('/api/admin/discord',{check:true}),env)).json();assert.equal(mismatch.verification.bot_verified,false);assert.equal(mismatch.verification.installed,false);
  }finally{globalThis.fetch=old;}
});


test('crafter choices expose recipe evidence and DM availability without private Discord identities',async()=>{
  const {env,DB,a,b,c}=await fixture();botEnv(env);await link(DB,b.id,'456789012345678901',0,1);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified')").run();
  assert.equal((await worker.fetch(new Request(ORIGIN+'/api/crafters/100'),env)).status,401);
  const response=await worker.fetch(a.request('/api/crafters/100'),env),raw=await response.text(),data=JSON.parse(raw);
  assert.equal(data.crafters.find(x=>x.character_id===102).dm_available,true);assert.equal(data.crafters.find(x=>x.character_id===103).dm_available,false);
  assert(!raw.includes('456789012345678901'));assert(!raw.includes('user-b'));
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','stale') WHERE id=102").run();
  const stale=await(await worker.fetch(a.request('/api/crafters/100'),env)).json();assert.equal(stale.crafters.find(x=>x.character_id===102).verified,false);
});

test('only selected opted-in crafters are asked; unselected crafters receive no DM',async()=>{
  const {env,DB,a,b,c}=await fixture();botEnv(env);
  for(const [uid,did]of [[a.id,'345678901234567890'],[b.id,'456789012345678901'],[c.id,'567890123456789012']])await link(DB,uid,did,1,1);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified')").run();
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{character_id:101,kind:'craft',recipe_id:100,quantity:1,target_character_ids:[102]}),env)).status,200);
  let jobs=(await DB.prepare('SELECT * FROM discord_outbox').all()).results;assert.equal(jobs.length,2);assert(!jobs.some(j=>j.user_id===c.id));
  const board=await(await worker.fetch(b.request('/api/hall'),env)).json();assert.equal(board.requests[0].asked_me,true);assert.equal(board.requests[0].targets[0].name,'Bob Example');
  const cboard=await(await worker.fetch(c.request('/api/hall'),env)).json();assert.equal(cboard.requests[0].asked_me,false);
  await worker.fetch(a.request('/api/hall/requests',{character_id:101,kind:'craft',recipe_id:100,quantity:1}),env);
  jobs=(await DB.prepare('SELECT * FROM discord_outbox').all()).results;assert.equal(jobs.length,3,'no selection adds only requester confirmation');
});

test('crafter selection rejects forged, stale or manual matches and deduplicates selected alts',async()=>{
  const {env,DB,a,b}=await fixture();botEnv(env);await link(DB,b.id,'456789012345678901',0,1);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified')").run();
  const base={character_id:101,kind:'craft',recipe_id:100,quantity:1};
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{...base,target_character_ids:[999]}),env)).status,400);
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{...base,recipe_id:null,item_name:'Custom item',manual_materials:'Two bars',target_character_ids:[102]}),env)).status,400);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','stale') WHERE id=102").run();
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{...base,target_character_ids:[102]}),env)).status,400);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified') WHERE id=102").run();
  await DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(b.id).run();
  assert.equal((await worker.fetch(a.request('/api/hall/requests',{...base,target_character_ids:[102,103,102]}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM request_targets').first()).n,2);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_outbox').first()).n,2,'one requester plus one crafter account');
});

test('queued targeted DMs recheck selected character ownership at delivery time',async()=>{
  const {env,DB,a,b,c}=await fixture();botEnv(env);await link(DB,b.id,'456789012345678901',0,1);
  await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified')").run();
  await DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(b.id).run();
  await worker.fetch(a.request('/api/hall/requests',{character_id:101,kind:'craft',recipe_id:100,quantity:1,target_character_ids:[102]}),env);
  await DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=102').bind(c.id).run();
  const old=globalThis.fetch;let called=false;try{globalThis.fetch=async()=>{called=true;throw Error('Must not send to a former owner');};await flushDiscord(env);assert.equal(called,false);}finally{globalThis.fetch=old;}
  assert.equal((await worker.fetch(new Request(ORIGIN+'/api/admin/presence-capability'),env)).status,401);
  assert.equal((await worker.fetch(b.request('/api/admin/presence-capability'),env)).status,403);
});

const eventChannel='678901234567890123',eventMessage='789012345678901234';
const discordMembers={a:'345678901234567890',b:'456789012345678901',c:'567890123456789012',unknown:'890123456789012345'};
async function createEvent(f,overrides={}){
  botEnv(f.env);f.env.DISCORD_EVENTS_CHANNEL_ID=eventChannel;
  const response=await worker.fetch(f.a.request('/api/hall/events',{character_id:101,title:'Local fixture expedition',kind:'Dungeon',starts_at:new Date(Date.now()+86400000).toISOString(),capacity:5,...overrides}),f.env);
  assert.equal(response.status,200,await response.text());
  return f.DB.prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT 1').first();
}
async function withEventDiscord(snapshot,run){
  const original=globalThis.fetch,state={snapshot,calls:[],responses:{},scheduled:[],message:null};
  globalThis.fetch=async(url,options={})=>{
    const method=options.method||'GET',body=options.body===undefined?undefined:JSON.parse(options.body);
    state.calls.push({url,method,body});assert.equal(options.headers.Authorization,'Bot test-bot-token');
    const path=new URL(url).pathname;
    const guildMember=path.match(/\/guilds\/234567890123456789\/members\/(\d+)$/);
    if(guildMember&&method==='GET')return state.responses['member:'+guildMember[1]]?.()||Response.json({user:{id:guildMember[1],username:'Misleading fixture name',bot:false},roles:[]});
    if(path.endsWith('/users/@me/channels')&&method==='POST')return Response.json({id:'789012345678901236'});
    if(path.endsWith('/channels/789012345678901236/messages')&&method==='POST')return Response.json({id:'789012345678901237'});
    if(path.endsWith('/scheduled-events')){
      if(method==='GET')return Response.json(state.scheduled);
      if(method==='POST'){const value={...body,id:'789012345678901235',status:1,guild_id:'234567890123456789',creator_id:'123456789012345678'};state.scheduled.push(value);return Response.json(value);}
    }
    if(path.endsWith('/scheduled-events/789012345678901235')){
      if(method==='GET')return state.scheduled[0]?Response.json(state.scheduled[0]):Response.json({},{status:404});
      if(method==='PATCH')return Response.json({...state.scheduled[0],...body});
      if(method==='DELETE'){state.scheduled=[];return new Response(null,{status:204});}
    }
    if(path.endsWith('/channels/'+eventChannel)&&method==='GET')return Response.json({id:eventChannel,guild_id:'234567890123456789'});
    if(path.endsWith('/channels/'+eventChannel+'/messages')){
      if(method==='POST'){state.message={...body,id:eventMessage,channel_id:eventChannel,author:{id:'123456789012345678'}};return Response.json(state.message);}
      if(method==='GET')return Response.json(state.message?[state.message]:[]);
    }
    if(path.endsWith('/messages/'+eventMessage)){
      if(method==='PATCH'){state.message={...state.message,...body};return Response.json(state.message);}
      if(method==='GET')return state.message?Response.json(state.message):Response.json({},{status:404});
      if(method==='DELETE'){state.message=null;return new Response(null,{status:204});}
    }
    if(path.includes('/messages/'+eventMessage+'/reactions/')){
      if(method==='PUT')return new Response(null,{status:204});
      if(method==='GET'){
        const emoji=decodeURIComponent(path.split('/reactions/')[1]),role=reactionRoles({kind:'Other'}).find(r=>r.emoji===emoji)?.role;
        assert(role,'Only the configured role emoji may be polled');
        if(state.responses[role])return state.responses[role]();
        return Response.json(state.snapshot[role]||[]);
      }
    }
    throw Error('Unexpected Discord fixture request: '+method+' '+path);
  };
  try{return await run(state);}finally{globalThis.fetch=original;}
}
async function pollEvent(f,event){
  await f.DB.prepare('UPDATE discord_event_posts SET next_poll_at=0 WHERE event_id=?').bind(event.id).run();
  await pollOneEventPost(f.env);
}
async function additionalEventMember(DB,id,characterId){
  const stamp=new Date().toISOString(),name='Fixture '+id;
  await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind(id,'subject-'+id,characterId,epoch(),stamp,stamp).run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','fixture-'+id,characterId,JSON.stringify({id:characterId,name})).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(characterId,id,stamp).run();
}

test('website events queue channel announcements and Dungeon scheduled events atomically',async()=>{
  const f=await fixture(),event=await createEvent(f);
  const jobs=(await f.DB.prepare('SELECT kind,reference_id FROM discord_outbox').all()).results;
  assert.deepEqual(jobs.map(j=>j.kind).sort(),['event','event_post']);assert(jobs.every(j=>j.reference_id===event.id));
  assert.deepEqual(roleLimits(event),{Tank:1,Healer:1,Damage:3});
  const roleplay=await createEvent(f,{kind:'Roleplay',title:'Roleplay fixture'});
  assert.equal(roleLimits(roleplay),null);
  assert.deepEqual((await f.DB.prepare('SELECT kind FROM discord_outbox WHERE reference_id=?').bind(roleplay.id).all()).results.map(j=>j.kind),['event_post']);
});

test('event delivery posts once, edits the original for joins, and deletes both Discord resources on cancellation',async()=>{
  const f=await fixture(),event=await createEvent(f,{title:'Fixture @everyone expedition'});
  await withEventDiscord({},async state=>{
    await flushDiscord(f.env);await flushDiscord(f.env);await publishEventPost(f.env,event.id);
    const creates=state.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/messages'));
    assert.equal(creates.length,1);assert.deepEqual(creates[0].body.allowed_mentions,{parse:[]});assert.equal(creates[0].body.enforce_nonce,true);assert(creates[0].body.nonce);
    const seeds=state.calls.filter(c=>c.method==='PUT');assert.equal(seeds.length,3);
    assert.deepEqual(new Set(seeds.map(c=>decodeURIComponent(new URL(c.url).pathname.split('/reactions/')[1].replace('/@me','')))),new Set(['🛡️','💚','⚔️']));
    assert.equal(state.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/scheduled-events')).length,1);
    const post=await f.DB.prepare('SELECT * FROM discord_event_posts').first();assert.equal(post.message_id,eventMessage);assert.equal(post.reactions_initialized,1);
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'join',character_id:102,role:'Healer'}),f.env)).status,200);
    await flushDiscord(f.env);
    assert(state.calls.some(c=>c.method==='PATCH'&&c.url.endsWith('/messages/'+eventMessage)&&c.body.content.includes('Bob Example')));
    assert.equal((await worker.fetch(f.a.request('/api/hall/events/'+event.id,{action:'cancel'}),f.env)).status,200);await flushDiscord(f.env);
    const edits=state.calls.filter(c=>c.method==='PATCH'&&c.url.endsWith('/messages/'+eventMessage));assert(edits.at(-1).body.content.includes('Bob Example'));
    for(const edit of edits)assert.deepEqual(edit.body.allowed_mentions,{parse:[]});
    assert.equal(state.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/messages')).length,1);assert.equal(state.calls.filter(c=>c.method==='PUT').length,3);
    assert.deepEqual(state.calls.filter(c=>c.method==='DELETE').map(c=>new URL(c.url).pathname).sort(),[
      '/api/v10/channels/'+eventChannel+'/messages/'+eventMessage,
      '/api/v10/guilds/234567890123456789/scheduled-events/789012345678901235'
    ].sort());
    assert.equal(state.message,null);assert.equal(state.scheduled.length,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM discord_event_posts WHERE event_id=?').bind(event.id).first()).count,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM discord_events WHERE event_id=?').bind(event.id).first()).count,0);
    assert.equal((await f.DB.prepare('SELECT status FROM events WHERE id=?').bind(event.id).first()).status,'cancelled');
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM event_signups WHERE event_id=?').bind(event.id).first()).count,1,'Cancellation retains website signup history');
  });
});

test('five-person Dungeon role limits are shared by web and Discord and checked within each write',async()=>{
  const f=await fixture(),event=await createEvent(f);
  for(const [id,char]of [['user-d',104],['user-e',105],['user-f',106]])await additionalEventMember(f.DB,id,char);
  assert.equal((await worker.fetch(f.a.request('/api/hall/events/'+event.id,{action:'join',character_id:101,role:'Tank'}),f.env)).status,200);
  assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'join',character_id:102,role:'Tank'}),f.env)).status,409);
  assert.equal(Number((await signupStatement(f.env,event,f.b.id,102,'Healer','','discord').run()).changes),1);
  await signupStatement(f.env,event,f.c.id,103,'Damage','','web').run();await signupStatement(f.env,event,'user-d',104,'Damage','','discord').run();
  // Both contenders prepare their writes while the final damage place is still free.
  const contenders=[signupStatement(f.env,event,'user-e',105,'Damage','','web'),signupStatement(f.env,event,'user-f',106,'Damage','','discord')];
  const outcomes=await f.DB.batch(contenders);assert.deepEqual(outcomes.map(r=>Number(r.changes)),[1,0]);
  assert.equal((await worker.fetch(f.a.request('/api/hall/events/'+event.id,{action:'join',character_id:101,role:'Healer'}),f.env)).status,409);
  const signups=(await f.DB.prepare('SELECT role,source FROM event_signups WHERE event_id=?').bind(event.id).all()).results;
  assert.equal(signups.length,5);assert.equal(signups.filter(s=>s.role==='Tank').length,1);assert.equal(signups.filter(s=>s.role==='Healer').length,1);assert.equal(signups.filter(s=>s.role==='Damage').length,3);
  await worker.fetch(f.a.request('/api/hall/events/'+event.id,{action:'cancel'}),f.env);
  assert.equal(Number((await signupStatement(f.env,event,'user-f',106,'Tank','','discord').run()).changes),0);
});

test('reaction matching uses exact linked Discord IDs and the verified main rather than display names or bots',async()=>{
  const f=await fixture(),event=await createEvent(f);await link(f.DB,f.a.id,discordMembers.a,0,0);
  await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(f.a.id).run();
  await f.DB.prepare('UPDATE users SET main_character_id=103 WHERE id=?').bind(f.a.id).run();
  await withEventDiscord({Damage:[{id:discordMembers.a,global_name:'Bob Example'},{id:discordMembers.b,global_name:'Alice Example'}],Healer:[{id:discordMembers.c,bot:true,global_name:'Alice Example'}]},async()=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    const signups=(await f.DB.prepare('SELECT * FROM event_signups').all()).results;assert.equal(signups.length,1);assert.equal(signups[0].user_id,f.a.id);assert.equal(signups[0].character_id,103);assert.equal(signups[0].source,'discord');
    const reactions=(await f.DB.prepare('SELECT * FROM discord_event_reactions').all()).results;assert.equal(reactions.length,2);assert.equal(reactions.find(r=>r.discord_id===discordMembers.b).result,'unmatched');assert(!reactions.some(r=>r.discord_id===discordMembers.c));
    assert.equal((await f.DB.prepare('SELECT last_error FROM discord_event_posts').first()).last_error,null);
  });
});

test('changed reactions retain a currently selected owned character and fall back when that character is no longer owned',async()=>{
  const f=await fixture(),event=await createEvent(f);await link(f.DB,f.a.id,discordMembers.a,0,0);
  await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(f.a.id).run();await f.DB.prepare('UPDATE users SET main_character_id=103 WHERE id=?').bind(f.a.id).run();
  await signupStatement(f.env,event,f.a.id,101,'Damage','','web').run();
  await withEventDiscord({Healer:[{id:discordMembers.a}]},async state=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT character_id FROM event_signups').first()).character_id,101);
    await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=101').bind(f.b.id).run();state.snapshot={Tank:[{id:discordMembers.a}]};await pollEvent(f,event);
    const signup=await f.DB.prepare('SELECT * FROM event_signups').first();assert.equal(signup.character_id,103);assert.equal(signup.role,'Tank');
  });
});

test('ambiguous, unmatched, stale and full reactions await confirmation and a freed role can be claimed on a later poll',async()=>{
  const f=await fixture(),event=await createEvent(f);
  for(const member of [f.a,f.b,f.c])await link(f.DB,member.id,discordMembers[member===f.a?'a':member===f.b?'b':'c'],0,0);
  await additionalEventMember(f.DB,'user-d',104);const stale='901234567890123456';await link(f.DB,'user-d',stale,0,0);await f.DB.prepare('UPDATE users SET ownership_checked=? WHERE id=?').bind(epoch()-90000,'user-d').run();
  await withEventDiscord({Tank:[{id:discordMembers.a},{id:discordMembers.b},{id:discordMembers.c}],Damage:[{id:discordMembers.a}],Healer:[{id:discordMembers.unknown,global_name:'Alice Example'},{id:stale}]},async state=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    const reactions=(await f.DB.prepare('SELECT * FROM discord_event_reactions').all()).results,byId=id=>reactions.find(r=>r.discord_id===id);
    assert.equal(byId(discordMembers.a).result,'choose one role');assert.equal(byId(discordMembers.b).result,'confirmed');assert.equal(byId(discordMembers.c).result,'role or event full');assert.equal(byId(discordMembers.unknown).result,'unmatched');assert.equal(byId(stale).result,'refresh guild sign-in');
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,1);
    const announcement=state.calls.filter(c=>c.method==='PATCH').at(-1).body.content;assert(announcement.includes('Awaiting confirmation'));assert(announcement.includes('role or event full'));
    state.snapshot.Tank=[{id:discordMembers.a},{id:discordMembers.c}];await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT user_id FROM event_signups WHERE role=\'Tank\'').first()).user_id,f.c.id);
    state.snapshot.Tank=[{id:discordMembers.c}];await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT role FROM event_signups WHERE user_id=?').bind(f.a.id).first()).role,'Damage');
  });
});

test('removing a reaction withdraws only Discord signups and later web choices survive unchanged reactions',async()=>{
  const f=await fixture(),event=await createEvent(f);await link(f.DB,f.a.id,discordMembers.a,0,0);await link(f.DB,f.b.id,discordMembers.b,0,0);
  await withEventDiscord({Tank:[{id:discordMembers.a}],Healer:[{id:discordMembers.b}]},async state=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,2);
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'join',character_id:102,role:'Damage'}),f.env)).status,200);
    state.snapshot={Healer:[{id:discordMembers.b}]};await pollEvent(f,event);
    assert.equal(await f.DB.prepare('SELECT * FROM event_signups WHERE user_id=?').bind(f.a.id).first(),null);
    let signup=await f.DB.prepare('SELECT * FROM event_signups WHERE user_id=?').bind(f.b.id).first();assert.equal(signup.role,'Damage');assert.equal(signup.source,'web');
    state.snapshot={};await pollEvent(f,event);signup=await f.DB.prepare('SELECT * FROM event_signups WHERE user_id=?').bind(f.b.id).first();assert.equal(signup.role,'Damage');
    state.snapshot={Healer:[{id:discordMembers.b}]};await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT source FROM event_signups WHERE user_id=?').bind(f.b.id).first()).source,'discord','a newly added reaction can replace the website choice');
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'leave'}),f.env)).status,200);await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,0,'unchanged old reaction cannot undo a later website withdrawal');
  });
});

test('incomplete reaction pages and API failures preserve existing signups and reaction state',async()=>{
  const f=await fixture(),event=await createEvent(f);await link(f.DB,f.a.id,discordMembers.a,0,0);
  await withEventDiscord({Tank:[{id:discordMembers.a}]},async state=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    const before=await f.DB.prepare('SELECT * FROM event_signups').all(),reactionBefore=await f.DB.prepare('SELECT * FROM discord_event_reactions').all();
    state.snapshot={Healer:Array.from({length:100},(_,i)=>({id:String(910000000000000000n+BigInt(i))}))};await pollEvent(f,event);
    assert.deepEqual(await f.DB.prepare('SELECT * FROM event_signups').all(),before);assert.deepEqual(await f.DB.prepare('SELECT * FROM discord_event_reactions').all(),reactionBefore);
    state.snapshot={};state.responses.Healer=()=>Response.json({message:'Fixture unavailable'},{status:503});await pollEvent(f,event);
    assert.deepEqual(await f.DB.prepare('SELECT * FROM event_signups').all(),before);assert.deepEqual(await f.DB.prepare('SELECT * FROM discord_event_reactions').all(),reactionBefore);
    const post=await f.DB.prepare('SELECT * FROM discord_event_posts').first();assert(post.last_error.includes('preserved'));assert(post.next_poll_at>=epoch()+59);assert.equal(post.lease_until,0);
  });
});

test('a pending full-role reaction cannot override a later website choice when that role becomes free',async()=>{
  const f=await fixture(),event=await createEvent(f);await link(f.DB,f.a.id,discordMembers.a,0,0);await link(f.DB,f.b.id,discordMembers.b,0,0);
  await withEventDiscord({Tank:[{id:discordMembers.a},{id:discordMembers.b}]},async state=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT handled FROM discord_event_reactions WHERE user_id=?').bind(f.b.id).first()).handled,0);
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'join',character_id:102,role:'Damage'}),f.env)).status,200);
    state.snapshot={Tank:[{id:discordMembers.b}]};await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT role FROM event_signups WHERE user_id=?').bind(f.b.id).first()).role,'Damage');
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'leave'}),f.env)).status,200);await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,0);
  });
});

test('reaction polling bounds identity changes and processes the remaining reactions on subsequent ticks',async()=>{
  const f=await fixture(),event=await createEvent(f);
  const users=Array.from({length:12},(_,i)=>({id:String(920000000000000000n+BigInt(i)),global_name:'Unmatched fixture '+i}));
  await withEventDiscord({Damage:users},async()=>{
    await publishEventPost(f.env,event.id);await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_event_reactions').first()).n,10);
    await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_event_reactions').first()).n,12);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,0);
  });
});

test('channel permission overwrites apply everyone, combined role, and member precedence with administrator bypass',()=>{
  const view=1024n,send=2048n,react=64n,history=65536n,guild={id:'guild',roles:[{id:'guild',permissions:String(view|send|history)},{id:'role-a',permissions:'0'},{id:'role-b',permissions:String(react)},{id:'admin',permissions:'8'}]},member={roles:['role-a','role-b']};
  const channel={permission_overwrites:[{id:'guild',type:0,deny:String(view|send),allow:'0'},{id:'role-a',type:0,deny:String(react|send),allow:String(view)},{id:'role-b',type:0,deny:'0',allow:String(react|send)},{id:'bot',type:1,deny:String(send),allow:'0'}]};
  assert.equal(effectivePermissions(guild,member,'bot',channel),view|react|history);
  assert.equal(effectivePermissions(guild,member,'another',channel),view|send|react|history,'one role allow wins over another role deny');
  assert.equal(effectivePermissions(guild,{roles:['admin']},'bot',channel)&(view|send|react|history),view|send|react|history);
});

test('event announcements stay within Discord length limits while retaining the event link and cancellation state',()=>{
  const event={id:'12345678-1234-1234-1234-123456789012',title:'@everyone '+ '😀*_'.repeat(100),kind:'Other',starts_at:new Date().toISOString(),description:'Long description '.repeat(100),location:'Long location '.repeat(100),capacity:40,duration_minutes:120,status:'open'};
  const signups=Array.from({length:40},(_,i)=>({role:['Tank','Healer','Damage','Roleplay','Social'][i%5],character_name:'😀*_'.repeat(100)})),pending=Array.from({length:20},()=>({display_name:'😀*_'.repeat(100),result:'unmatched'}));
  for(const status of ['open','cancelled']){
    const content=eventAnnouncement({...event,status},signups,pending,'789012345678901235','234567890123456789');assert(content.length<=2000);assert(content.endsWith('Tracker event: '+event.id));assert(content.includes(ORIGIN+'/guild#events'));assert(content.includes('\nDiscord event: https://discord.com/events/'));assert(content.includes('\nCharacter choices and sign-ups: '));assert(!content.includes('\\n'),'formatting uses actual newlines, not literal backslash-n text');assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(content));assert(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content));if(status==='cancelled')assert(content.includes('CANCELLED'));
  }
});

const mappingsPath='/api/admin/character-mappings';
async function mappingFixture(){
  const f=await fixture();botEnv(f.env);f.env.ADMIN_USER_IDS=f.a.id;
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified')").run();
  return f;
}
async function saveMapping(f,character,discord,options={}){
  const response=await worker.fetch(f.a.request(mappingsPath,{action:'save',character_id:character,discord_id:discord,...options}),f.env);
  assert.equal(response.status,200,await response.text());
  return f.DB.prepare('SELECT * FROM admin_discord_mappings WHERE character_id=?').bind(character).first();
}
async function removeMapping(f,character){
  const response=await worker.fetch(f.a.request(mappingsPath,{action:'remove',character_id:character}),f.env);assert.equal(response.status,200,await response.text());
}
async function requestFromMappedCrafter(f,targets=[102]){
  const response=await worker.fetch(f.a.request('/api/hall/requests',{kind:'craft',character_id:101,recipe_id:100,quantity:1,target_character_ids:targets}),f.env);assert.equal(response.status,200,await response.text());
}
async function authorizeFixtureDiscord(f,member,discord){
  const login=await discordAuth(member.request('/auth/discord/login'),f.env),state=new URL(login.headers.get('Location')).searchParams.get('state'),previous=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/oauth2/token'))return Response.json({access_token:'fixture-discord-identity-token'});
    if(url.endsWith('/users/@me')&&options.headers.Authorization==='Bearer fixture-discord-identity-token')return Response.json({id:discord,username:'Misleading fixture display name'});
    return previous(url,options);
  };
  try{const result=await discordAuth(member.request('/auth/discord/callback?state='+state+'&code=fixture-code'),f.env);assert(result.headers.get('Location').includes('discord=linked'));}finally{globalThis.fetch=previous;}
}

test('manual character mappings require the pinned admin identity and write protection',async()=>{
  const f=await mappingFixture(),body={action:'save',character_id:102,discord_id:discordMembers.b,preferred:true,crafter_dm:true,is_admin:true};
  await withEventDiscord({},async state=>{
    assert.equal((await worker.fetch(new Request(ORIGIN+mappingsPath),f.env)).status,401);
    assert.equal((await worker.fetch(f.b.request(mappingsPath),f.env)).status,403);
    assert.equal((await worker.fetch(new Request(ORIGIN+mappingsPath,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(body)}),f.env)).status,401);
    assert.equal((await worker.fetch(f.b.request(mappingsPath,body),f.env)).status,403);
    assert.equal((await worker.fetch(f.a.request(mappingsPath,body,{csrf:'forged'}),f.env)).status,403);
    assert.equal((await worker.fetch(f.a.request(mappingsPath,body,{origin:'https://attacker.example'}),f.env)).status,403);
    const response=await worker.fetch(f.a.request(mappingsPath),f.env);assert.equal(response.status,200);const view=await response.json();assert.deepEqual(view.mappings,[]);assert.deepEqual(view.characters.map(c=>c.id).sort(),[101,102,103]);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM admin_discord_mappings').first()).n,0);assert.equal(state.calls.length,0,'rejected requests never contact Discord');
  });
});

test('manual mapping validates the current guild character and exact Discord guild member before saving',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  await withEventDiscord({},async state=>{
    for(const body of [{character_id:999999,discord_id:discordMembers.b},{character_id:102,discord_id:'Bob Example'},{character_id:102,discord_id:'123'}]){
      const response=await worker.fetch(f.a.request(mappingsPath,{action:'save',...body}),f.env);assert(response.status>=400&&response.status<500);
    }
    state.responses['member:'+discordMembers.b]=()=>Response.json({message:'Unknown Member'},{status:404});
    const absent=await worker.fetch(f.a.request(mappingsPath,{action:'save',character_id:102,discord_id:discordMembers.b}),f.env);assert(absent.status>=400&&absent.status<500);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM admin_discord_mappings').first()).n,0);
    delete state.responses['member:'+discordMembers.b];
    const saved=await saveMapping(f,102,'<@'+discordMembers.b+'>');assert.equal(saved.discord_id,discordMembers.b);assert.equal(saved.crafter_dm,0);
    assert(state.calls.some(c=>c.method==='GET'&&c.url.endsWith('/guilds/'+f.env.DISCORD_GUILD_ID+'/members/'+discordMembers.b)));
    const view=await(await worker.fetch(f.a.request(mappingsPath),f.env)).json();assert.equal(view.mappings[0].character_id,102);assert.equal(view.mappings[0].name,'Bob Example');assert.equal(view.mappings[0].discord_id,discordMembers.b);assert.equal(Boolean(view.mappings[0].conflict),false);
  });
});

test('admin mappings create notification participants without granting Battle.net ownership or website access',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  const beforeSessions=(await f.DB.prepare('SELECT COUNT(*) n FROM sessions').first()).n;
  await withEventDiscord({},async()=>{
    const mapping=await saveMapping(f,102,discordMembers.b,{preferred:true}),participant=await f.DB.prepare('SELECT * FROM users WHERE id=?').bind(mapping.participant_user_id).first();
    assert.equal(participant.ownership_status,'admin_mapped');assert.notEqual(participant.id,f.b.id);assert.notEqual(participant.subject_hash,await digest('https://oauth.battle.net|'+discordMembers.b));
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_links WHERE character_id=102 OR user_id=?').bind(participant.id).first()).n,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM sessions').first()).n,beforeSessions);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_links WHERE user_id=?').bind(participant.id).first()).n,0);
    const current=await currentUser(f.b.request('/api/me'),f.env);assert.equal(current.verified,false);assert.deepEqual(current.characters,[]);
    const denied=await worker.fetch(f.b.request('/api/me'),f.env);assert.equal(denied.status,403);assert(!Object.hasOwn(await denied.json(),'characters'));assert.equal((await worker.fetch(f.b.request('/api/hall'),f.env)).status,403);
    const adminMe=await(await worker.fetch(f.a.request('/api/me'),f.env)).json();assert(!adminMe.characters.some(c=>c.id===102));
    const event=await createEvent(f);assert.equal((await worker.fetch(f.a.request('/api/hall/events/'+event.id,{action:'join',character_id:102,role:'Tank',user_id:participant.id}),f.env)).status,403);
  });
});

test('manual mappings reuse a compatible authenticated owner and reject conflicting authenticated identities',async()=>{
  const f=await mappingFixture();await link(f.DB,f.b.id,discordMembers.b,0,0);
  await withEventDiscord({},async()=>{
    const compatible=await saveMapping(f,102,discordMembers.b,{preferred:true,crafter_dm:true});assert.equal(compatible.participant_user_id,f.b.id);
    const wrongDiscord=await worker.fetch(f.a.request(mappingsPath,{action:'save',character_id:102,discord_id:discordMembers.c}),f.env);assert.equal(wrongDiscord.status,409);
    const wrongOwner=await worker.fetch(f.a.request(mappingsPath,{action:'save',character_id:103,discord_id:discordMembers.b}),f.env);assert.equal(wrongOwner.status,409);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM admin_discord_mappings').first()).n,1);assert.equal((await f.DB.prepare('SELECT user_id FROM character_links WHERE character_id=102').first()).user_id,f.b.id);
  });
});

test('mapped alts share one participant, one preferred character and one opted-in crafter DM',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id IN (102,103)').run();
  await withEventDiscord({},async state=>{
    const first=await saveMapping(f,102,discordMembers.b,{preferred:true,crafter_dm:true}),second=await saveMapping(f,103,discordMembers.b,{preferred:true,crafter_dm:true});assert.equal(first.participant_user_id,second.participant_user_id);
    const mappings=(await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results;assert.deepEqual(mappings.map(m=>m.preferred),[0,1]);
    const crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();for(const id of [102,103])assert.equal(crafters.crafters.find(c=>c.character_id===id).dm_available,true);
    assert(!JSON.stringify(crafters).includes(discordMembers.b));await requestFromMappedCrafter(f,[102,103]);
    const jobs=(await f.DB.prepare("SELECT * FROM discord_outbox WHERE kind='dm'").all()).results;assert.equal(jobs.length,2);assert.equal(jobs.filter(j=>j.user_id===first.participant_user_id).length,1);
    await flushDiscord(f.env);const recipients=state.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/users/@me/channels'));assert.equal(recipients.length,1);assert.equal(recipients[0].body.recipient_id,discordMembers.b);
    const messages=state.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/channels/789012345678901236/messages'));assert.equal(messages.length,1);assert.deepEqual(messages[0].body.allowed_mentions,{parse:[]});
  });
});

test('manual crafter DMs default off and still require verified recipe evidence and personal consent',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  await withEventDiscord({},async()=>{
    await saveMapping(f,102,discordMembers.b);let crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();assert.equal(crafters.crafters.find(c=>c.character_id===102).dm_available,false);
    await requestFromMappedCrafter(f);assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='dm'").first()).n,1,'default opt-out adds no crafter notification');
    await saveMapping(f,102,discordMembers.b,{crafter_dm:true});crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();assert.equal(crafters.crafters.find(c=>c.character_id===102).dm_available,true);
    await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','stale') WHERE id=102").run();crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();assert.equal(crafters.crafters.find(c=>c.character_id===102).dm_available,false);
    assert.equal((await worker.fetch(f.a.request('/api/hall/requests',{kind:'craft',character_id:101,recipe_id:100,target_character_ids:[102]}),f.env)).status,400);
    assert.equal((await worker.fetch(f.a.request('/api/hall/requests',{kind:'craft',character_id:101,item_name:'Unknown',manual_materials:'Two bars',target_character_ids:[102]}),f.env)).status,400);
    await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','verified') WHERE id=102").run();await removeMapping(f,102);
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(102,f.b.id,new Date().toISOString()).run();await link(f.DB,f.b.id,discordMembers.b,0,0);await saveMapping(f,102,discordMembers.b,{crafter_dm:true});
    crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();assert.equal(crafters.crafters.find(c=>c.character_id===102).dm_available,false,'authenticated personal opt-out overrides the admin checkbox');
  });
});

test('queued manual crafter notifications recheck removal and destination changes before delivery',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  await withEventDiscord({},async state=>{
    await saveMapping(f,102,discordMembers.b,{crafter_dm:true});await requestFromMappedCrafter(f);await removeMapping(f,102);await flushDiscord(f.env);
    assert.equal(state.calls.filter(c=>c.url.endsWith('/users/@me/channels')).length,0);
    await saveMapping(f,102,discordMembers.b,{crafter_dm:true});await requestFromMappedCrafter(f);await saveMapping(f,102,discordMembers.c,{crafter_dm:true});await flushDiscord(f.env);
    assert.equal(state.calls.filter(c=>c.url.endsWith('/users/@me/channels')).length,0,'a queued message must not follow an edited mapping to another Discord account');
  });
});

test('manual mappings permit exact-ID reaction claims for the preferred character and removal revokes that authority',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id IN (102,103)').run();
  await withEventDiscord({Tank:[{id:discordMembers.b,global_name:'Alice Example'}]},async state=>{
    await saveMapping(f,102,discordMembers.b,{preferred:true});const preferred=await saveMapping(f,103,discordMembers.b,{preferred:true});const event=await createEvent(f);
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    const signup=await f.DB.prepare('SELECT * FROM event_signups').first();assert(signup);assert.equal(signup.user_id,preferred.participant_user_id);assert.equal(signup.character_id,103);assert.equal(signup.source,'discord');assert.equal(signup.role,'Tank');
    await removeMapping(f,102);await removeMapping(f,103);state.snapshot={Healer:[{id:discordMembers.b,global_name:'Charlie Example'}]};await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,0);assert.equal((await f.DB.prepare('SELECT result FROM discord_event_reactions WHERE discord_id=?').bind(discordMembers.b).first()).result,'unmatched');
  });
});

test('a personal crafter opt-out survives unlinking and cannot be reversed by an administrator mapping',async()=>{
  const f=await mappingFixture();await link(f.DB,f.b.id,discordMembers.b,0,1);
  await withEventDiscord({},async state=>{
    await saveMapping(f,102,discordMembers.b,{crafter_dm:true});await requestFromMappedCrafter(f);
    assert.equal((await worker.fetch(f.b.request('/api/hall/discord',{requester_dm:false,crafter_dm:false}),f.env)).status,200);
    assert.equal((await worker.fetch(f.b.request('/api/hall/discord',{unlink:true}),f.env)).status,200);
    assert.equal((await f.DB.prepare('SELECT discord_id FROM discord_crafter_optouts').first()).discord_id,discordMembers.b);
    await saveMapping(f,102,discordMembers.b,{crafter_dm:true});
    const crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();assert.equal(crafters.crafters.find(c=>c.character_id===102).dm_available,false);
    await flushDiscord(f.env);assert.equal(state.calls.filter(c=>c.url.endsWith('/users/@me/channels')).length,0);
  });
});

test('a later verified ownership conflict suspends manual DM and reaction authority until resolved',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async state=>{
    await saveMapping(f,102,discordMembers.b,{preferred:true,crafter_dm:true});const event=await createEvent(f);await publishEventPost(f.env,event.id);await pollEvent(f,event);await requestFromMappedCrafter(f);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,1);
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(102,f.b.id,new Date().toISOString()).run();
    const mappings=await(await worker.fetch(f.a.request(mappingsPath),f.env)).json();assert(mappings.mappings[0].conflict);
    const crafters=await(await worker.fetch(f.a.request('/api/crafters/100'),f.env)).json();assert.equal(crafters.crafters.find(c=>c.character_id===102).dm_available,false);
    await flushDiscord(f.env);assert.equal(state.calls.filter(c=>c.url.endsWith('/users/@me/channels')).length,0);await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,0);assert.equal((await f.DB.prepare('SELECT result FROM discord_event_reactions').first()).result,'unmatched');
  });
});

test('manual trust applies only to the final selected character and does not refresh an unmapped provider character',async()=>{
  const f=await mappingFixture();await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(f.b.id).run();await link(f.DB,f.b.id,discordMembers.b,0,0);
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async state=>{
    await saveMapping(f,103,discordMembers.b,{preferred:true});const event=await createEvent(f);await f.DB.prepare('UPDATE users SET ownership_checked=? WHERE id=?').bind(epoch()-90000,f.b.id).run();
    await publishEventPost(f.env,event.id);await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,0,'mapping an alt does not exempt the unmapped provider main from freshness');
    assert.equal((await f.DB.prepare('SELECT result FROM discord_event_reactions').first()).result,'refresh guild sign-in');
    await signupStatement(f.env,event,f.b.id,103,'Damage','','web').run();state.snapshot={Healer:[{id:discordMembers.b}]};await pollEvent(f,event);
    let signup=await f.DB.prepare('SELECT * FROM event_signups').first();assert.equal(signup.character_id,103);assert.equal(signup.role,'Healer');assert.equal(signup.source,'discord','the exact manually mapped selected character retains authority');
    await signupStatement(f.env,event,f.b.id,102,'Damage','','web').run();state.snapshot={Tank:[{id:discordMembers.b}]};await pollEvent(f,event);
    signup=await f.DB.prepare('SELECT * FROM event_signups').first();assert.equal(signup.character_id,102);assert.equal(signup.role,'Damage');assert.equal(signup.source,'web');assert.equal((await f.DB.prepare('SELECT result FROM discord_event_reactions').first()).result,'refresh guild sign-in');
  });
});

test('resaving a manual mapping after verified ownership appears transfers its Discord signup to the compatible owner once',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async()=>{
    const manual=await saveMapping(f,102,discordMembers.b,{preferred:true}),event=await createEvent(f);await publishEventPost(f.env,event.id);await pollEvent(f,event);
    assert.equal((await f.DB.prepare('SELECT user_id FROM event_signups').first()).user_id,manual.participant_user_id);
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(102,f.b.id,new Date().toISOString()).run();
    const adopted=await saveMapping(f,102,discordMembers.b,{preferred:true});assert.equal(adopted.participant_user_id,f.b.id);await pollEvent(f,event);await saveMapping(f,102,discordMembers.b,{preferred:true});await pollEvent(f,event);
    const signups=(await f.DB.prepare('SELECT * FROM event_signups').all()).results;assert.equal(signups.length,1);assert.equal(signups[0].user_id,f.b.id);assert.equal(signups[0].character_id,102);assert.equal(signups[0].role,'Tank');assert.equal(signups[0].source,'discord');
    assert.equal((await f.DB.prepare('SELECT user_id FROM discord_event_reactions').first()).user_id,f.b.id);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups WHERE user_id=?').bind(manual.participant_user_id).first()).n,0);
  });
});

test('existing destination website choice wins when an administrator consolidates a virtual participant',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(f.b.id).run();
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async()=>{
    const manual=await saveMapping(f,102,discordMembers.b,{preferred:true}),event=await createEvent(f);
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'join',character_id:103,role:'Damage'}),f.env)).status,200);await publishEventPost(f.env,event.id);await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,2);
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(102,f.b.id,new Date().toISOString()).run();await saveMapping(f,102,discordMembers.b,{preferred:true});await pollEvent(f,event);
    const signups=(await f.DB.prepare('SELECT * FROM event_signups').all()).results;assert.equal(signups.length,1);assert.equal(signups[0].user_id,f.b.id);assert.equal(signups[0].character_id,103);assert.equal(signups[0].role,'Damage');assert.equal(signups[0].source,'web');
    const reaction=await f.DB.prepare('SELECT * FROM discord_event_reactions').first();assert.equal(reaction.user_id,f.b.id);assert.equal(reaction.handled,1);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups WHERE user_id=?').bind(manual.participant_user_id).first()).n,0);
  });
});

test('saving a provider-owned alt consolidates compatible virtual mappings into one participant and one notification',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async state=>{
    const manual=await saveMapping(f,102,discordMembers.b,{preferred:true,crafter_dm:true}),event=await createEvent(f);await publishEventPost(f.env,event.id);await pollEvent(f,event);
    await saveMapping(f,103,discordMembers.b,{preferred:true,crafter_dm:true});await pollEvent(f,event);
    const mappings=(await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results;assert.equal(mappings.length,2);assert(mappings.every(m=>m.participant_user_id===f.c.id));assert.deepEqual(mappings.map(m=>m.preferred),[0,1]);
    const signup=await f.DB.prepare('SELECT * FROM event_signups').first();assert.equal(signup.user_id,f.c.id);assert.equal(signup.character_id,102);assert.equal(signup.role,'Tank');assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,1);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_links WHERE character_id=102').first()).n,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM admin_discord_mappings WHERE participant_user_id=?').bind(manual.participant_user_id).first()).n,0);
    await requestFromMappedCrafter(f,[102,103]);assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='dm' AND user_id=?").bind(f.c.id).first()).n,1);await flushDiscord(f.env);await flushDiscord(f.env);assert.equal(state.calls.filter(c=>c.url.endsWith('/users/@me/channels')).length,1);
    const conflict=await worker.fetch(f.a.request(mappingsPath,{action:'save',character_id:101,discord_id:discordMembers.b}),f.env);assert.equal(conflict.status,409,'a different authenticated participant cannot absorb another real owner');
  });
});

test('virtual participant consolidation rejects a mapped character owned by a different verified member atomically',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id IN (102,103)').run();
  await withEventDiscord({},async()=>{
    const manual=await saveMapping(f,102,discordMembers.b,{preferred:true});await saveMapping(f,103,discordMembers.b);
    for(const [cid,uid]of [[102,f.b.id],[103,f.c.id]])await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(cid,uid,new Date().toISOString()).run();
    const before=(await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results;
    const response=await worker.fetch(f.a.request(mappingsPath,{action:'save',character_id:102,discord_id:discordMembers.b,preferred:true}),f.env);assert.equal(response.status,409);
    assert.deepEqual((await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results,before);assert(before.every(m=>m.participant_user_id===manual.participant_user_id));
  });
});

test('Discord OAuth adoption preserves a destination website choice through an unchanged old role reaction',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(f.b.id).run();await additionalEventMember(f.DB,'user-d',104);await f.DB.prepare('DELETE FROM character_links WHERE character_id=104').run();
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async()=>{
    const manual=await saveMapping(f,102,discordMembers.b,{preferred:true});await saveMapping(f,104,discordMembers.b);const event=await createEvent(f);
    assert.equal((await worker.fetch(f.b.request('/api/hall/events/'+event.id,{action:'join',character_id:103,role:'Damage'}),f.env)).status,200);await publishEventPost(f.env,event.id);await pollEvent(f,event);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,2);
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(102,f.b.id,new Date().toISOString()).run();await authorizeFixtureDiscord(f,f.b,discordMembers.b);
    assert.equal((await f.DB.prepare('SELECT participant_user_id FROM admin_discord_mappings WHERE character_id=102').first()).participant_user_id,f.b.id);assert.equal((await f.DB.prepare('SELECT participant_user_id FROM admin_discord_mappings WHERE character_id=104').first()).participant_user_id,manual.participant_user_id);
    let reaction=await f.DB.prepare('SELECT * FROM discord_event_reactions').first();assert.equal(reaction.user_id,f.b.id);assert.equal(reaction.handled,1);await pollEvent(f,event);
    const signups=(await f.DB.prepare('SELECT * FROM event_signups').all()).results;assert.equal(signups.length,1);assert.equal(signups[0].user_id,f.b.id);assert.equal(signups[0].character_id,103);assert.equal(signups[0].role,'Damage');assert.equal(signups[0].source,'web');
    reaction=await f.DB.prepare('SELECT * FROM discord_event_reactions').first();assert.equal(reaction.user_id,f.b.id);assert.equal(reaction.handled,1);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_links WHERE character_id=104').first()).n,0);
  });
});

test('Discord OAuth adopts only provider-owned manual characters and transfers their existing role claim once',async()=>{
  const f=await mappingFixture();await f.DB.prepare('DELETE FROM character_links WHERE character_id=102').run();await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=103').bind(f.b.id).run();await additionalEventMember(f.DB,'user-d',104);await f.DB.prepare('DELETE FROM character_links WHERE character_id=104').run();
  await withEventDiscord({Tank:[{id:discordMembers.b}]},async()=>{
    const manual=await saveMapping(f,102,discordMembers.b,{preferred:true});await saveMapping(f,104,discordMembers.b);const event=await createEvent(f);await publishEventPost(f.env,event.id);await pollEvent(f,event);
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(102,f.b.id,new Date().toISOString()).run();await authorizeFixtureDiscord(f,f.b,discordMembers.b);await pollEvent(f,event);
    const signups=(await f.DB.prepare('SELECT * FROM event_signups').all()).results;assert.equal(signups.length,1);assert.equal(signups[0].user_id,f.b.id);assert.equal(signups[0].character_id,102);assert.equal(signups[0].role,'Tank');assert.equal(signups[0].source,'discord');
    assert.equal((await f.DB.prepare('SELECT participant_user_id FROM admin_discord_mappings WHERE character_id=102').first()).participant_user_id,f.b.id);assert.equal((await f.DB.prepare('SELECT participant_user_id FROM admin_discord_mappings WHERE character_id=104').first()).participant_user_id,manual.participant_user_id);
    assert.equal((await f.DB.prepare('SELECT ownership_status FROM users WHERE id=?').bind(manual.participant_user_id).first()).ownership_status,'admin_mapped');assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_links WHERE character_id=104').first()).n,0);
    const me=await(await worker.fetch(f.b.request('/api/me'),f.env)).json();assert.deepEqual(me.characters.map(c=>c.id).sort(),[102,103]);
  });
});
