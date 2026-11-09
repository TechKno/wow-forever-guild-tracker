import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {normalizeProfessions,normalizeTalents,validateRoster,tick,GUILD} from '../src/logic.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

function database(){
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return db.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:db.prepare(this.sql).all(...this.params)};}
    async run(){return db.prepare(this.sql).run(...this.params);}
  }
  return {prepare:sql=>new Statement(sql),batch:async statements=>{
    db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}
  },raw:db};
}
const character={id:71,name:'Example',surname:'Character',slug:'example-character',level:20,playable_class:{id:8},playable_race:{id:1}};
const guild={id:18,name:GUILD,ruleset:{id:3}};
const roster={guild:{id:18},members:[{character,rank:0}]};
async function memberRequest(env){
  const now=new Date().toISOString(),token=random(),csrf=random(),id='worker-member';
  let generation=(await env.DB.prepare('SELECT published FROM sync WHERE id=1').first()).published;
  if(!generation){generation='fixture-current';await env.DB.prepare('UPDATE sync SET published=? WHERE id=1').bind(generation).run();}
  await env.DB.prepare('INSERT OR IGNORE INTO membership VALUES(?,?,?,?)').bind(generation,character.slug,character.id,JSON.stringify({id:71,name:'Example Character',slug:character.slug,level:20,class:'Mage'})).run();
  await env.DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind(id,'worker-subject',71,Math.floor(Date.now()/1000),now,now).run();
  await env.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(71,id,now).run();
  await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,Math.floor(Date.now()/1000)+3600).run();
  return (path,method='GET')=>new Request(ORIGIN+path,{method,headers:{Cookie:'__Host-wv_session='+token}});
}
test('recipe omission stays unknown and explicit empty list is an observed empty list',()=>{
  const result=normalizeProfessions({character:{id:71},primaries:[{profession:{id:171,name:'Alchemy'},tiers:[{tier:{name:'Alchemy'},skill_points:80,max_skill_points:150}]}],secondaries:[{profession:{id:185,name:'Cooking'},skill_points:30,known_recipes:[]}]});
  assert.equal(result[0].recipe_status,'not_exposed');assert.equal(result[0].max_skill,150);
  assert.equal(result[1].recipe_status,'observed');assert.equal(result[1].max_skill,null);
  assert.equal(normalizeProfessions({primaries:[{profession:{name:'Alchemy'},known_recipes:null}]})[0].recipe_status,'not_exposed');
});
test('known recipes retain identity and schema changes cannot silently erase lists',()=>{
  assert.equal(normalizeProfessions({primaries:[{profession:{name:'Alchemy'},tiers:[{known_recipes:[{id:2330,name:'Minor Healing Potion'}]}]}]})[0].recipes[0].name,'Minor Healing Potion');
  assert.throws(()=>normalizeProfessions({primaries:{}}));
  assert.throws(()=>normalizeProfessions({primaries:null,secondaries:[]}));
  assert.throws(()=>normalizeProfessions({primaries:[{known_recipes:{}}]}));
});
test('guild spelling, ruleset and roster identity are enforced',()=>{
  const result=validateRoster({id:3,name:'Roleplay'},guild,roster);
  assert.equal(result[0].class,'Mage');assert.equal(result[0].rank,0);
  assert.throws(()=>validateRoster({id:3,name:'Roleplay'},{...guild,name:'Different Guild'},roster));
  assert.throws(()=>validateRoster({id:3,name:'Roleplay'},{...guild,ruleset:{id:2}},roster));
  assert.throws(()=>validateRoster({id:3,name:'Roleplay'},guild,{...roster,guild:{id:999}}));
  assert.throws(()=>validateRoster({id:3,name:'Roleplay'},guild,{guild:{id:18}}));
  assert.throws(()=>validateRoster({id:3,name:'Roleplay'},guild,{guild:{id:18},members:[{character},{character:{...character,slug:'different-name'}}]}));
});
test('talent groups are reported without an invented role or dominant specialisation',()=>{
  const result=normalizeTalents({specialization_groups:[{is_active:true,specializations:[{specialization_name:'Frost',spent_points:10},{specialization_name:'Arcane',spent_points:2}]}]});
  assert.deepEqual(result,[{name:'Frost',points:10},{name:'Arcane',points:2}]);
  assert.throws(()=>normalizeTalents({}));
});
test('missing credentials leave stored roster intact and cannot leak secrets',async()=>{
  const DB=database();await DB.prepare("UPDATE sync SET published='older' WHERE id=1").run();
  await tick({DB});
  const row=await DB.prepare('SELECT * FROM sync').first();assert.equal(row.published,'older');assert.equal(row.status,'waiting');assert.equal(row.lease,null);
  const env={DB,BLIZZARD_CLIENT_SECRET:'should-never-appear'},request=await memberRequest(env);
  const denied=await worker.fetch(new Request(ORIGIN+'/api/status'),env);assert.equal(denied.status,401);assert(!(await denied.text()).includes('should-never-appear'));
  const response=await worker.fetch(request('/api/status'),env);assert.equal(response.status,200);
  const text=await response.text();assert(!text.includes('should-never-appear'));assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('full incremental import validates identity and retains cached professions through a 404',async()=>{
  const DB=database();const originalFetch=globalThis.fetch;let failProfessions=false;const calls=[];
  const env={DB,BLIZZARD_CLIENT_ID:'fixture-client',BLIZZARD_CLIENT_SECRET:'fixture-secret'};
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});const path=new URL(url).pathname;
    const body=path==='/token'?{access_token:'fixture-token',expires_in:3600}:path==='/data/wow/ruleset/3'?{id:3,name:'Roleplay'}:
      path==='/data/wow/guild/example-guild'?guild:path.endsWith('/roster')?roster:
      path.endsWith('/professions')?{character:{id:71},primaries:[{profession:{id:171,name:'Alchemy'},tiers:[{skill_points:80,max_skill_points:150,known_recipes:[{id:2330,name:'Minor Healing Potion'}]}]}]}:
      path.endsWith('/specializations')?{character:{id:71},specialization_groups:[{is_active:true,specializations:[]}]}:{id:71,ruleset:{id:3},character_class:{name:'Mage'},race:{name:'Human'},level:20};
    return new Response(JSON.stringify(body),{status:failProfessions&&path.endsWith('/professions')?404:200,headers:{'Content-Type':'application/json'}});
  };
  try{
    for(let i=0;i<4;i++)await tick(env);
    let row=await DB.prepare('SELECT * FROM sync').first();assert.equal(row.status,'ready');assert(row.published);
    const request=await memberRequest(env),response=await worker.fetch(request('/api/members'),env);assert.equal(response.status,200);const payload=await response.json();
    assert.equal(payload.members[0].professions[0].recipes[0].id,2330);
    assert.equal(payload.members[0].class,'Mage');assert(!JSON.stringify(payload).includes('fixture-token'));
    failProfessions=true;
    await DB.prepare('UPDATE character_refresh SET next_at=0,last_detail_login=NULL,details_level=NULL WHERE character_id=71').run();
    await DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','stale') WHERE id=71").run();
    await tick(env);
    const cached=JSON.parse((await DB.prepare('SELECT data FROM characters WHERE id=71').first()).data);
    assert.equal(cached.professions_status,'stale');assert.equal(cached.professions[0].recipes[0].id,2330);
    const endpoints=(await DB.prepare('SELECT * FROM evidence WHERE path LIKE ?').bind('%/professions').all()).results;
    assert.equal(endpoints[0].status,'unavailable');assert(endpoints[0].succeeded);
    assert(calls.some(c=>new URL(c.url).searchParams.get('namespace')==='profile-forever-eu'));
    assert(calls.every(c=>!c.url.includes('fixture-secret')&&!c.url.includes('fixture-token')));
    assert(calls.every(c=>c.options.redirect==='manual'),'Workers accepts manual redirects; error mode must never be used');
  } finally{globalThis.fetch=originalFetch;}
});
test('browser routes remain read only and unknown routes cannot trigger imports',async()=>{
  const env={DB:database()},request=await memberRequest(env);
  assert.equal((await worker.fetch(request('/api/sync','POST'),env)).status,405);
  assert.equal((await worker.fetch(request('/api/credentials'),env)).status,404);
  assert.equal((await worker.fetch(request('/api/members?generation=stale'),env)).status,409);
});
