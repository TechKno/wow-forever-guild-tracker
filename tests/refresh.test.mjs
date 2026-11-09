import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import worker from '../src/worker.mjs';
import {tick,normalizeLogin,mergeMember,queueRefresh,api,apiObservation} from '../src/logic.mjs';
import {digest,random,ORIGIN} from '../src/auth.mjs';
import {loadRecipe,hydrateOneRecipe,buildMaterialPlan} from '../src/materials.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
const ago=ms=>new Date(Date.now()-ms).toISOString();
const oldLogin=()=>Date.now()-2*86400000;
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
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.run());raw.exec('COMMIT');return rows;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(count=1){
  const DB=database(),at=ago(5*60000),login=oldLogin();
  await DB.prepare("UPDATE sync SET phase='roster',published='current',status='ready',roster_at=?,updated=?,next_at=?,total=? WHERE id=1").bind(at,at,epoch()+900,count).run();
  const members=[];
  for(let i=0;i<count;i++){
    const id=71+i,name=i?'Later Character':'Example Character',slug=i?'later-character':'example-character';
    const member={id,name,slug,level:20,class:'Mage',class_id:8,race:'Human',roster_observed:at};members.push(member);
    const data={profile:{level:20,class:'Mage',race:'Human'},profile_status:'verified',profile_at:at,professions_status:'verified',professions_at:at,talents_status:'verified',talents_at:at,talents_activity_marker:login,talents_level:20,talents:[],last_login_at:new Date(login).toISOString(),professions:[{id:171,name:'Alchemy',kind:'Primary',tier:'Alchemy',skill:80,max_skill:150,recipe_status:'observed',recipes:[{id:2330,name:'Minor Healing Potion'}]}]};
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',slug,id,JSON.stringify(member)).run();
    await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(id,JSON.stringify(data),at).run();
    await DB.prepare('INSERT INTO character_refresh(character_id,next_at,last_detail_login,details_level) VALUES(?,?,?,?)').bind(id,0,login,20).run();
  }
  const env={DB,BLIZZARD_CLIENT_ID:'refresh-fixture-'+random(),BLIZZARD_CLIENT_SECRET:'fixture-secret'};
  return {DB,env,at,login,members};
}
function provider(f,{profile,professions,talents,status,headers}={}){
  const calls=[];
  return {calls,fetch:async(input,options)=>{
    const url=new URL(input),path=url.pathname;calls.push({path,options});
    if(path==='/token')return Response.json({access_token:'fixture-refresh-token',expires_in:3600});
    const member=f.members.find(m=>path.includes('/character/'+m.slug))||f.members[0];
    const section=path.endsWith('/professions')?'professions':path.endsWith('/specializations')?'talents':path.startsWith('/profile/')?'profile':'roster';
    let body=path==='/data/wow/ruleset/3'?{id:3,name:'Roleplay'}:path.endsWith('/roster')?{guild:{id:18},members:f.members.map(m=>({character:{id:m.id,name:m.name.split(' ')[0],surname:m.name.split(' ').slice(1).join(' '),slug:m.slug,level:m.level,playable_class:{id:8},playable_race:{id:1}},rank:0}))}:path==='/data/wow/guild/example-guild'?{id:18,name:'Example Guild',ruleset:{id:3}}:section==='professions'?{character:{id:member.id},primaries:[{profession:{id:171,name:'Alchemy'},tiers:[{skill_points:81,max_skill_points:150,known_recipes:[{id:2330,name:'Minor Healing Potion'},{id:2331,name:'Minor Mana Potion'}]}]}],secondaries:[]}:section==='talents'?{character:{id:member.id},specialization_groups:[]}:{id:member.id,ruleset:{id:3},character_class:{name:'Mage'},race:{name:'Human'},level:member.level,last_login_timestamp:f.login};
    const override=section==='profile'?profile:section==='professions'?professions:section==='talents'?talents:undefined;
    if(override!==undefined)body=typeof override==='function'?override(member,body):override;
    const code=typeof status==='function'?status(member,section):status||200;
    return new Response(JSON.stringify(body),{status:code,headers:{'Content-Type':'application/json',...headers}});
  }};
}
async function withProvider(mock,run){const original=globalThis.fetch;globalThis.fetch=mock.fetch;try{return await run();}finally{globalThis.fetch=original;}}
async function cached(f,id=71){return JSON.parse((await f.DB.prepare('SELECT data FROM characters WHERE id=?').bind(id).first()).data);}
async function due(f,id=71){await f.DB.prepare('UPDATE character_refresh SET next_at=0 WHERE character_id=?').bind(id).run();}
async function signedIn(f,id='refresh-admin',character=71){
  const token=random(),csrf=random(),now=new Date().toISOString();
  await f.DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind(id,'subject-'+id,character,epoch(),now,now).run();
  await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(character,id,now).run();
  await f.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,epoch()+3600).run();
  return {id,request(path,body,csrfValue=csrf){return new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-wv_session='+token,Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrfValue},body:body===undefined?undefined:JSON.stringify(body)});}};
}

test('activity timestamp accepts plausible milliseconds or seconds and rejects absent or future values',()=>{
  const ms=1762600000000;
  assert.equal(normalizeLogin(ms),new Date(ms).toISOString());
  assert.equal(normalizeLogin(ms/1000),new Date(ms).toISOString());
  for(const value of [null,undefined,0,-1,'1762600000000',Date.now()+86400000,10,NaN])assert.equal(normalizeLogin(value),null);
});

test('a higher returned roster level survives a lagging profile even if that profile was fetched later',()=>{
  const roster={id:71,name:'Example Character',level:21,roster_observed:ago(60000),class:'Mage'};
  const details={profile_status:'verified',profile_at:new Date().toISOString(),profile:{level:20,class:'Mage'}};
  assert.equal(mergeMember(roster,details).level,21);
  assert.equal(mergeMember({...roster,level:19},details).level,20);
});

test('unchanged activity checks avoid profession and talent requests while preserving their observation times',async()=>{
  const f=await fixture(),mock=provider(f);
  await withProvider(mock,()=>tick(f.env));
  assert.deepEqual(mock.calls.filter(c=>c.path.startsWith('/profile/')).map(c=>c.path),['/profile/wow/character/example-character']);
  const data=await cached(f);assert.equal(data.professions_at,f.at);assert.equal(data.professions[0].recipes.length,1);
  assert.equal(data.last_login_at,new Date(f.login).toISOString());
  assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM snapshots WHERE character_id=71').first()).count,0,'An unchanged profile-only check must not create a repeated observation or re-date cached profession data');
  const schedule=await f.DB.prepare('SELECT * FROM character_refresh WHERE character_id=71').first();
  assert(schedule.next_at>=epoch()+895);
});

test('an advanced activity marker refreshes learned recipes once and then becomes the comparison baseline',async()=>{
  const f=await fixture(),login=f.login+3600000,mock=provider(f,{profile:(member,body)=>({...body,last_login_timestamp:login})});
  await withProvider(mock,async()=>{await tick(f.env);await due(f);await tick(f.env);});
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/specializations')).length,1);
  assert.equal((await cached(f)).professions[0].recipes.length,2);
  const schedule=await f.DB.prepare('SELECT * FROM character_refresh WHERE character_id=71').first();assert.equal(schedule.last_detail_login,login);
});

test('a level change refreshes professions even if the activity marker has not advanced',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>({...body,level:21})});
  await withProvider(mock,()=>tick(f.env));
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1);
  assert.equal((await cached(f)).profile.level,21);
  assert.equal((await f.DB.prepare('SELECT details_level FROM character_refresh WHERE character_id=71').first()).details_level,21);
});

test('a higher roster level triggers one detail refresh rather than repeating against a lagging profile level',async()=>{
  const f=await fixture();f.members[0].level=21;
  await f.DB.prepare("UPDATE membership SET data=json_set(data,'$.level',21) WHERE character_id=71").run();
  const mock=provider(f,{profile:(member,body)=>({...body,level:20})});
  await withProvider(mock,async()=>{await tick(f.env);await due(f);await tick(f.env);});
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/specializations')).length,1);
});

test('unknown activity refreshes details after fifteen minutes without implying offline',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>{const value={...body};delete value.last_login_timestamp;return value;}});
  await withProvider(mock,async()=>{
    await tick(f.env);assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,0);
    await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_at',?,'$.talents_at',?) WHERE id=71").bind(ago(16*60000),ago(16*60000)).run();
    await due(f);await tick(f.env);
  });
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1);
  assert.equal((await cached(f)).last_login_at,null);
});

test('old activity receives an hourly detail check while fresh observations are retained',async()=>{
  const f=await fixture(),mock=provider(f);
  await withProvider(mock,async()=>{
    await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_at',?,'$.talents_at',?) WHERE id=71").bind(ago(59*60000),ago(59*60000)).run();
    await tick(f.env);assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,0);
    await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_at',?,'$.talents_at',?) WHERE id=71").bind(ago(61*60000),ago(61*60000)).run();
    await due(f);await tick(f.env);
  });
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/specializations')).length,1);
});

test('recent but unchanged activity receives a fifteen-minute safety check during a continuing play session',async()=>{
  const f=await fixture();f.login=Date.now()-2*3600000;const mock=provider(f);
  await f.DB.prepare('UPDATE character_refresh SET last_detail_login=? WHERE character_id=71').bind(f.login).run();
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_at',?,'$.talents_at',?,'$.talents_activity_marker',?) WHERE id=71").bind(ago(16*60000),ago(16*60000),f.login).run();
  await withProvider(mock,()=>tick(f.env));
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/specializations')).length,1);
});

test('a full manual refresh persists through partial validation failure and retries only the unacknowledged endpoint',async()=>{
  const f=await fixture();let validProfessions=false;
  const mock=provider(f,{professions:(member,body)=>validProfessions?body:{character:{id:member.id}}});
  await queueRefresh(f.env);
  const requested=(await f.DB.prepare('SELECT requested_at FROM character_refresh WHERE character_id=71').first()).requested_at;
  assert(requested>0);
  await withProvider(mock,async()=>{
    await tick(f.env);
    let data=await cached(f);
    assert.equal(data.details_refresh_reason,'manual');assert.equal(data.professions_status,'stale');
    assert.equal(data.professions_at,f.at);assert.equal(data.professions_request_ack,undefined,'HTTP 200 without a complete recipe list must not acknowledge the requested refresh');
    assert.equal(data.professions_attempt_request,requested);assert.equal(data.talents_request_ack,requested);
    assert.equal((await f.DB.prepare('SELECT requested_at FROM character_refresh WHERE character_id=71').first()).requested_at,requested);
    const retryAt=data.professions_retry_at;assert(retryAt>=epoch()+295);
    validProfessions=true;await due(f);await tick(f.env);
    assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,1,'The same outstanding manual request must retain endpoint backoff');
    assert.equal((await cached(f)).professions_retry_at,retryAt);
    await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_retry_at',0) WHERE id=71").run();
    await due(f);await tick(f.env);
    data=await cached(f);assert.equal(data.professions_request_ack,requested);assert.equal(data.professions_status,'verified');
    assert.equal(data.professions[0].recipes.length,2);
  });
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,2);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/specializations')).length,1,'The already validated talent endpoint must not repeat for the same request');
});

test('API observations bypass caches and retain upstream response dates without changing the body-only API',async()=>{
  const f=await fixture(),modified=new Date(Date.now()-3600000).toUTCString(),date=new Date().toUTCString();
  const mock=provider(f,{headers:{'Last-Modified':modified,Date:date,Age:'123','Cache-Control':'max-age=3600','CF-Cache-Status':'HIT'}});
  await withProvider(mock,async()=>{
    const result=await apiObservation(f.env,'/profile/wow/character/example-character');
    assert.equal(result.data.level,20);assert(Number.isFinite(Date.parse(result.metadata.checked_at)));
    assert.deepEqual({...result.metadata,checked_at:null},{checked_at:null,last_modified:modified,date,age:'123',cache_control:'max-age=3600',cache_status:'HIT'});
    const body=await api(f.env,'/profile/wow/character/example-character');assert.equal(body.id,71);assert.equal(body.metadata,undefined);
  });
  for(const call of mock.calls){assert.equal(call.options.cache,'no-store');if(call.path!=='/token')assert.equal(new Headers(call.options.headers).get('Cache-Control'),'no-cache');}
});

test('a failing character is deferred without starving the following guild character',async()=>{
  const f=await fixture(2),mock=provider(f,{status:(member,section)=>member.id===71&&section==='profile'?503:200});
  await withProvider(mock,async()=>{await tick(f.env);await tick(f.env);});
  assert(mock.calls.some(c=>c.path==='/profile/wow/character/later-character'));
  assert.equal(mock.calls.filter(c=>c.path==='/profile/wow/character/example-character').length,1);
  assert.equal((await cached(f)).professions[0].recipes[0].id,2330);
  assert((await f.DB.prepare('SELECT next_at FROM character_refresh WHERE character_id=71').first()).next_at>=epoch()+295);
});

test('roster publication can complete independently of a failing character profile',async()=>{
  const f=await fixture(2),mock=provider(f,{status:(member,section)=>member.id===71&&section==='profile'?503:200});
  await f.DB.prepare('UPDATE sync SET next_at=0 WHERE id=1').run();
  await withProvider(mock,async()=>{for(let i=0;i<4;i++)await tick(f.env);});
  const sync=await f.DB.prepare('SELECT published,roster_at,next_at FROM sync WHERE id=1').first();
  assert.notEqual(sync.published,'current');assert(Date.parse(sync.roster_at)>Date.parse(f.at));
  assert(sync.next_at>=epoch()+850,'Next roster work should follow the short roster cadence, not wait for all characters');
});

test('unavailable profiles back off for an hour without issuing two known-unavailable detail lookups',async()=>{
  const f=await fixture(),mock=provider(f,{status:(member,section)=>section==='profile'?404:200});
  await withProvider(mock,()=>tick(f.env));
  assert.equal(mock.calls.filter(c=>c.path.startsWith('/profile/')).length,1);
  assert((await f.DB.prepare('SELECT next_at FROM character_refresh WHERE character_id=71').first()).next_at>=epoch()+3595);
  const data=await cached(f);
  assert.equal(data.professions[0].recipes[0].id,2330);assert.equal(data.profile.level,20);assert.equal(data.profile_at,f.at);
  assert.equal(data.profile_availability,'not_published');assert.equal(data.profile_status,'stale');
  assert(Date.parse(data.profile_checked_at)>Date.parse(f.at));assert.match(data.profile_note,/Blizzard/i);assert.match(data.profile_note,/retry/i);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM snapshots WHERE character_id=71').first()).count,0,'An unsuccessful profile check must not create a newly dated snapshot from old profession data');
});

test('a changed roster level wakes an unpublished profile before its hourly retry is due',async()=>{
  const f=await fixture(),mock=provider(f,{status:(member,section)=>section==='profile'?404:200});
  await withProvider(mock,async()=>{
    await tick(f.env);
    const before=(await f.DB.prepare('SELECT next_at FROM character_refresh WHERE character_id=71').first()).next_at;
    assert(before>epoch()+3500);f.members[0].level=21;
    await f.DB.prepare('UPDATE sync SET next_at=0 WHERE id=1').run();
    await tick(f.env);await tick(f.env);
  });
  assert.equal(mock.calls.filter(c=>c.path==='/profile/wow/character/example-character').length,2);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')||c.path.endsWith('/specializations')).length,0);
  assert.equal((await cached(f)).profile_at,f.at,'A failed retry must preserve the last successful profile timestamp');
});

for(const format of ['seconds','http-date'])test('Blizzard 429 '+format+' Retry-After pauses subsequent refresh calls',async()=>{
  const f=await fixture(2),until=Date.now()+1800000,mock=provider(f,{status:(member,section)=>section==='profile'?429:200,headers:{'Retry-After':format==='seconds'?'1800':new Date(until).toUTCString()}});
  await withProvider(mock,async()=>{await tick(f.env);const count=mock.calls.length;await queueRefresh(f.env);await tick(f.env);assert.equal(mock.calls.length,count,'A manual refresh must also respect the provider cooldown');});
  const user=await signedIn(f),response=await worker.fetch(user.request('/api/status'),f.env),data=await response.json();assert.equal(response.status,200);
  assert(Date.parse(data.refresh.paused_until)>=until-3000);
});

test('a request during the final seconds of a cooldown cannot extend that cooldown or call Blizzard',async()=>{
  const f=await fixture(),until=epoch()+30;
  await f.DB.prepare("INSERT INTO state(key,value) VALUES('blizzard_cooldown',?)").bind(String(until)).run();
  let called=false;const mock={fetch:async()=>{called=true;throw Error('Cooldown must prevent network requests');}};
  await withProvider(mock,async()=>{await assert.rejects(api(f.env,'/profile/wow/character/example-character'),error=>error.status===429);});
  assert.equal(called,false);assert.equal((await f.DB.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").first()).value,String(until));
});

test('identity mismatches cannot update cached levels or enable detail requests',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>({...body,id:999,level:60})});
  await withProvider(mock,()=>tick(f.env));
  assert.equal((await cached(f)).profile.level,20);assert.equal(mock.calls.filter(c=>c.path.endsWith('/professions')).length,0);
});

test('incomplete successful profession and talent payloads retain prior verified observations as stale',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>({...body,level:21}),professions:{character:{id:71}},talents:{character:{id:71}}});
  await withProvider(mock,()=>tick(f.env));
  const data=await cached(f);assert.equal(data.professions_status,'stale');assert.equal(data.professions_at,f.at);
  assert.equal(data.professions[0].recipes[0].id,2330);assert.equal(data.talents_status,'stale');assert.equal(data.talents_at,f.at);
});

test('an omitted profession tier cannot disguise a missing learned-recipe list as a new empty profession',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>({...body,level:21}),professions:{character:{id:71},primaries:[{profession:{id:171,name:'Alchemy'},skill_points:81}],secondaries:[]}});
  await withProvider(mock,()=>tick(f.env));
  const data=await cached(f);assert.equal(data.professions_status,'stale');assert.equal(data.professions_at,f.at);
  assert.equal(data.professions[0].tier,'Alchemy');assert.equal(data.professions[0].recipes[0].id,2330);
});

test('an incomplete active talent group retains the last observed talent points',async()=>{
  const f=await fixture(),previous=[{name:'Frost',points:10}];
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.talents',json(?)) WHERE id=71").bind(JSON.stringify(previous)).run();
  const mock=provider(f,{profile:(member,body)=>({...body,level:21}),talents:{character:{id:71},specialization_groups:[{is_active:true}]}});
  await withProvider(mock,()=>tick(f.env));
  const data=await cached(f);assert.equal(data.talents_status,'stale');assert.equal(data.talents_at,f.at);assert.deepEqual(data.talents,previous);
});

test('a level observed before a profession failure is recorded once rather than lost on retry',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>({...body,level:21}),status:(member,section)=>section==='professions'?503:200});
  await withProvider(mock,async()=>{await tick(f.env);await due(f);await tick(f.env);});
  const rows=await f.DB.prepare("SELECT * FROM activity WHERE character_id=71 AND kind='level'").all();
  assert.equal(rows.results.length,1);assert(rows.results[0].title.includes('21'));
  assert.equal((await cached(f)).profile.level,21);assert.equal((await cached(f)).professions[0].recipes.length,1);
});

test('progress and refreshed character data roll back together when the observation batch fails',async()=>{
  const f=await fixture(),mock=provider(f,{profile:(member,body)=>({...body,level:21})}),originalBatch=f.DB.batch.bind(f.DB);
  let injected=false;
  f.DB.batch=async statements=>{
    if(!injected&&statements.some(s=>/INSERT(?: OR REPLACE)? INTO characters/i.test(s.sql))){injected=true;return originalBatch([...statements,f.DB.prepare('INSERT INTO missing_refresh_test_table VALUES(1)')]);}
    return originalBatch(statements);
  };
  await withProvider(mock,()=>tick(f.env));
  assert(injected,'Character observations must share a transaction with progress history');
  assert.equal((await cached(f)).profile.level,20);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM activity WHERE character_id=71 AND kind='level'").first()).count,0);
});

test('member freshness uses successful Blizzard observations rather than a failed job attempt time',async()=>{
  const f=await fixture(),now=new Date().toISOString();
  await f.DB.prepare("UPDATE sync SET updated=?,status='blocked' WHERE id=1").bind(now).run();
  const user=await signedIn(f),response=await worker.fetch(user.request('/api/status'),f.env),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.refresh.last_success_at,f.at);assert.notEqual(data.refresh.last_success_at,now);
  assert.equal(data.refresh.roster_at,f.at);assert(!JSON.stringify(data).includes('fixture-secret'));
});

test('expired material requirements survive a failed refresh with their original observation time',async()=>{
  const f=await fixture(),observed=ago(3*86400000),recipe={id:2330,name:'Minor Healing Potion',verified:true,reagents:[{id:2447,name:'Peacebloom',quantity:1}],output:{id:118,value:1},observed_at:observed};
  await f.DB.prepare('INSERT INTO recipe_details VALUES(?,?,?)').bind(recipe.id,JSON.stringify(recipe),epoch()-1).run();
  const mock={fetch:async input=>new URL(input).pathname==='/token'?Response.json({access_token:'fixture-refresh-token',expires_in:3600}):Response.json({error:'Unavailable'},{status:503})};
  const result=await withProvider(mock,()=>loadRecipe(f.env,2330));
  assert.equal(result.verified,true);assert.equal(result.stale,true);assert.equal(result.observed_at,observed);assert.deepEqual(result.reagents,recipe.reagents);
  const stored=await f.DB.prepare('SELECT expires FROM recipe_details WHERE id=2330').first();assert(stored.expires>=epoch()+595&&stored.expires<=epoch()+605);
  const plan=buildMaterialPlan(result,2,[]);assert.deepEqual(plan.shopping_list,[{id:2447,name:'Peacebloom',quantity:2}]);assert(plan.warnings.some(w=>w.includes('previously verified')));
});

test('background recipe hydration respects the shared Blizzard cooldown',async()=>{
  const f=await fixture(),until=epoch()+1800;
  await f.DB.prepare("INSERT INTO state(key,value) VALUES('blizzard_cooldown',?)").bind(String(until)).run();
  let called=false;const mock={fetch:async()=>{called=true;throw Error('Recipe hydration must not call Blizzard during cooldown');}};
  const result=await withProvider(mock,()=>hydrateOneRecipe(f.env));
  assert.equal(called,false);assert.equal(result.processed,null);assert.equal(result.paused_until,until);
});

test('admin refresh queues WoW work only with administrator identity and CSRF',async()=>{
  const f=await fixture(),user=await signedIn(f);
  const request=csrfValue=>user.request('/api/admin/refresh',{},csrfValue);
  assert.equal((await worker.fetch(new Request(ORIGIN+'/api/admin/refresh',{method:'POST'}),f.env)).status,401);
  assert.equal((await worker.fetch(request(),f.env)).status,403);
  f.env.ADMIN_USER_IDS='refresh-admin';
  assert.equal((await worker.fetch(request('wrong'),f.env)).status,403);
  await f.DB.prepare('UPDATE character_refresh SET next_at=?').bind(epoch()+900).run();
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('Queuing must not directly invoke Blizzard');};
  try{const response=await worker.fetch(request(),f.env),data=await response.json();assert.equal(response.status,200);assert(data.queued);}
  finally{globalThis.fetch=original;}
  assert((await f.DB.prepare('SELECT next_at FROM sync WHERE id=1').first()).next_at<=epoch());
  assert((await f.DB.prepare('SELECT next_at FROM character_refresh WHERE character_id=71').first()).next_at<=epoch());
});

test('targeted admin refresh queues only a current character and rejects invalid targets without changing the queue',async()=>{
  const f=await fixture(2),user=await signedIn(f),next=epoch()+900;f.env.ADMIN_USER_IDS=user.id;
  await f.DB.prepare('UPDATE character_refresh SET next_at=?').bind(next).run();
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('previous','former-character',99,JSON.stringify({id:99,name:'Former Character'})).run();
  for(const character_id of [99,999,'invalid',71.5]){
    const response=await worker.fetch(user.request('/api/admin/refresh',{character_id}),f.env);
    assert.equal(response.status,400);assert.match((await response.json()).error,/current guild character/i);
  }
  assert.equal((await f.DB.prepare('SELECT SUM(requested_at) total FROM character_refresh').first()).total,0);
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('Queuing must not directly invoke Blizzard');};
  try{const response=await worker.fetch(user.request('/api/admin/refresh',{character_id:71}),f.env);assert.equal(response.status,200);assert.equal((await response.json()).queued,true);}
  finally{globalThis.fetch=original;}
  const target=await f.DB.prepare('SELECT * FROM character_refresh WHERE character_id=71').first(),other=await f.DB.prepare('SELECT * FROM character_refresh WHERE character_id=72').first();
  assert(target.requested_at>0);assert(target.next_at<=epoch());assert.equal(other.next_at,next);assert.equal(other.requested_at,0);
});

test('member, signed-in character and guild hall views agree when the profile level is ahead of the roster',async()=>{
  const f=await fixture(),user=await signedIn(f);
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.profile.level',21,'$.profile_at',?) WHERE id=71").bind(new Date().toISOString()).run();
  const [members,me,hall]=await Promise.all(['/api/members','/api/me','/api/hall'].map(async path=>{
    const response=await worker.fetch(user.request(path),f.env);assert.equal(response.status,200);return response.json();
  }));
  assert.equal(members.members.find(c=>c.id===71).level,21);assert.equal(me.characters.find(c=>c.id===71).level,21);
  assert.equal(hall.directory.find(c=>c.id===71).level,21);
});

test('direct Blizzard character checks require an administrator and reject invalid character paths before contacting Blizzard',async()=>{
  const f=await fixture(),user=await signedIn(f),path='/api/admin/character-check?character=example-character';
  let calls=0;
  await withProvider({fetch:async()=>{calls++;throw Error('This request must not contact Blizzard');}},async()=>{
    assert.equal((await worker.fetch(new Request(ORIGIN+path),f.env)).status,401);
    assert.equal((await worker.fetch(user.request(path),f.env)).status,403);
    f.env.ADMIN_USER_IDS=user.id;
    const response=await worker.fetch(user.request('/api/admin/character-check?character=unknown%2Fcharacter'),f.env);
    assert.equal(response.status,404);assert.match((await response.json()).error,/current guild character/i);
  });
  assert.equal(calls,0);
});

test('an admin source check exposes safe evidence of Blizzard lag without replacing saved character observations',async()=>{
  const f=await fixture(),user=await signedIn(f);f.env.ADMIN_USER_IDS=user.id;f.members[0].level=11;
  await f.DB.prepare("UPDATE membership SET data=json_set(data,'$.level',11) WHERE character_id=71").run();
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.profile.level',10) WHERE id=71").run();
  await f.DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify({id:18,name:'Example Guild',ruleset:'EU Roleplay'})).run();
  const before=await Promise.all(['membership','characters','character_refresh','sync','snapshots','activity'].map(table=>f.DB.prepare('SELECT * FROM '+table).all()));
  const profileModified=new Date(Date.now()-2*3600000).toUTCString(),rosterModified=new Date(Date.now()-3600000).toUTCString(),date=new Date().toUTCString();
  const mock=provider(f,{profile:(member,body)=>({...body,level:10,private_access_token:'private-upstream-value'}),headers:{'Last-Modified':profileModified,Date:date,Age:'600','Cache-Control':'max-age=10800','CF-Cache-Status':'HIT'}}),baseFetch=mock.fetch;
  mock.fetch=async(input,options)=>{
    const response=await baseFetch(input,options);
    if(new URL(input).pathname.endsWith('/roster'))response.headers.set('Last-Modified',rosterModified);
    return response;
  };
  const response=await withProvider(mock,()=>worker.fetch(user.request('/api/admin/character-check?character=example-character'),f.env));
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const result=await response.json();
  assert.equal(result.saved.level,11);assert.equal(result.saved.profile_at,f.at);
  assert.equal(result.blizzard.roster.status,'observed');assert.equal(result.blizzard.roster.level,11);
  assert.equal(result.blizzard.profile.status,'observed');assert.equal(result.blizzard.profile.level,10);
  assert.equal(result.blizzard.roster.metadata.last_modified,rosterModified);assert.equal(result.blizzard.profile.metadata.last_modified,profileModified);
  assert.equal(result.blizzard.profile.metadata.cache_control,'max-age=10800');assert.equal(result.blizzard.profile.metadata.age,'600');
  assert.match(result.note,/Blizzard.*older/i);
  const visible=JSON.stringify(result);for(const sensitive of ['private-upstream-value','private_access_token','fixture-secret','fixture-refresh-token'])assert(!visible.includes(sensitive));
  const after=await Promise.all(['membership','characters','character_refresh','sync','snapshots','activity'].map(table=>f.DB.prepare('SELECT * FROM '+table).all()));
  assert.deepEqual(after,before,'A diagnostic check must not advance saved levels, observations, history or refresh scheduling');
  for(const call of mock.calls.filter(c=>c.path!=='/token')){assert.equal(call.options.cache,'no-store');assert.equal(new Headers(call.options.headers).get('Cache-Control'),'no-cache');}
});

test('an admin source check respects the shared Blizzard pause without extending it or contacting Blizzard',async()=>{
  const f=await fixture(),user=await signedIn(f),until=epoch()+1800;f.env.ADMIN_USER_IDS=user.id;
  await f.DB.prepare("INSERT INTO state(key,value) VALUES('blizzard_cooldown',?)").bind(String(until)).run();
  let calls=0;
  const response=await withProvider({fetch:async()=>{calls++;throw Error('The source check must respect the existing Blizzard pause');}},()=>worker.fetch(user.request('/api/admin/character-check?character=example-character'),f.env));
  assert.equal(response.status,200);assert.equal(calls,0);
  const result=await response.json();assert.equal(result.saved.level,20);
  for(const source of [result.blizzard.roster,result.blizzard.profile]){assert.equal(source.status,'unavailable');assert.equal(source.http_status,429);assert.equal(source.level,undefined);}
  assert.equal((await f.DB.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").first()).value,String(until));
  assert.equal((await cached(f)).profile_at,f.at);
});

test('browser retries a failed member page even when the server revision has not changed',async()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),elements=new Map(),calls=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{id,hidden:id==='status',value:'',disabled:false,textContent:'',innerHTML:'',classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){},showModal(){}});return elements.get(id);};
  let fail=true;
  const payload={sync:{published:'current',updated:'revision-a',roster_at:ago(60000),status:'ready',total:0},refresh:{last_success_at:ago(60000)}};
  const context=vm.createContext({document:{hidden:false,getElementById:element,querySelector:()=>element('dialog-close'),querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){},dispatchEvent(){}},location:{hash:''},history:{replaceState(){}},CustomEvent:class{constructor(type){this.type=type;}},URL,Blob,console,setTimeout,clearTimeout,setInterval(){},fetch:async path=>{calls.push(path);return path==='/api/status'?Response.json(payload):fail?Response.json({error:'Temporary member failure'},{status:503}):Response.json({generation:'current',members:[],next:null});}});
  vm.runInContext(source,context);
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('status',context),null,'A failed member page must not commit the new server revision');
  fail=false;await vm.runInContext('load()',context);
  assert.equal(calls.filter(path=>path.startsWith('/api/members')).length,2);
  assert(calls.filter(path=>path.startsWith('/api/members')).every(path=>path.includes('generation=current')),'Pages must use the status generation from the beginning');
  assert.equal(vm.runInContext('status.sync.updated',context),'revision-a');
});
