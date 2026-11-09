import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';
import {normalizeTalentIndex} from '../src/talents.mjs';
import {normalizeTalentBuild} from '../src/talent-data.mjs';

const CHARACTER=71,TREE=100,SPECS=[62,63,64],BUILD_PATH='/profile/wow/character/example-character/specializations',INDEX_PATH='/data/wow/talent-tree/index';
const epoch=()=>Math.floor(Date.now()/1000),layoutPath=id=>`/data/wow/talent-tree/${TREE}/playable-specialization/${id}`;
function database(){
  const raw=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(name,directory),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),env={DB,BLIZZARD_CLIENT_ID:'talent-fixture-'+random(),BLIZZARD_CLIENT_SECRET:'fixture-secret'};
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  const member={id:CHARACTER,name:'Example Character',slug:'example-character',class:'Mage',class_id:8,level:20};
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',member.slug,CHARACTER,JSON.stringify(member)).run();
  await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(CHARACTER,JSON.stringify({}),new Date().toISOString()).run();
  const now=new Date().toISOString(),token=random(),csrf=random();
  await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind('talent-member','talent-subject',CHARACTER,epoch(),now,now).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(CHARACTER,'talent-member',now).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),'talent-member',csrf,epoch()+3600).run();
  return {DB,env,member,request:(path,method='GET')=>new Request(ORIGIN+path,{method,headers:{Cookie:'__Host-wv_session='+token}})};
}
function buildPayload(characterId=CHARACTER){return {character:{id:characterId},specialization_groups:[{is_active:true,specializations:[{specialization:{id:62,name:'Arcane'},spent_points:2,talents:[{talent:{id:500,name:'Arcane Focus'},talent_rank:2,spell_tooltip:{spell:{id:600},description:'Observed second rank'}}]}]}]};}
function indexPayload(){return {class_talent_trees:[{name:'Mage',key:{href:`https://eu.api.blizzard.com/data/wow/talent-tree/${TREE}`}}],spec_talent_trees:SPECS.map(id=>({name:'Tree '+id,key:{href:'https://eu.api.blizzard.com'+layoutPath(id)}}))};}
function layoutPayload(specId){return {id:TREE,name:'Tree '+specId,playable_class:{id:8},playable_specialization:{id:specId},spec_talent_nodes:[{id:1000+specId,display_row:1,display_col:2,ranks:[1,2,3].map(rank=>({rank,tooltip:{talent:{id:specId===62?500:500+specId,name:specId===62?'Arcane Focus':'Other Talent'},spell_tooltip:{spell:{id:600+specId},description:'Static rank '+rank}}}))}]};}
function provider(f,overrides={}){
  const calls=[];
  return {calls,fetch:async(input,options)=>{
    const url=new URL(input);calls.push({url,options});
    if(url.hostname==='oauth.battle.net'&&url.pathname==='/token')return Response.json({access_token:'fixture-talent-token',expires_in:3600});
    assert.equal(url.origin,'https://eu.api.blizzard.com','Provider references must never choose a remote host');
    const path=url.pathname,override=overrides[path];
    if(override!==undefined){const result=typeof override==='function'?await override(url,options):override;return result instanceof Response?result:Response.json(result);}
    if(path===BUILD_PATH)return Response.json(buildPayload());
    if(path===INDEX_PATH)return Response.json(indexPayload());
    const spec=SPECS.find(id=>path===layoutPath(id));if(spec)return Response.json(layoutPayload(spec));
    assert.fail('Unexpected provider path: '+path);
  }};
}
async function withProvider(mock,run){const original=globalThis.fetch;globalThis.fetch=mock.fetch;try{return await run();}finally{globalThis.fetch=original;}}
async function get(f,id=CHARACTER,suffix=''){const response=await worker.fetch(f.request(`/api/characters/${id}/talents${suffix}`),f.env);return {response,data:await response.json()};}
const dataCalls=mock=>mock.calls.filter(call=>call.url.hostname==='eu.api.blizzard.com');
const cache=(f,key)=>f.DB.prepare('SELECT * FROM talent_cache WHERE cache_key=?').bind(key).first();

test('talent GET requires verified guild membership and rejects unknown, former and invalid IDs before provider calls',async()=>{
  const f=await fixture(),mock=provider(f);
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('previous','former-character',72,JSON.stringify({...f.member,id:72,slug:'former-character'})).run();
  await f.DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(73,JSON.stringify({}),new Date().toISOString()).run();
  await withProvider(mock,async()=>{
    const denied=await worker.fetch(new Request(`${ORIGIN}/api/characters/${CHARACTER}/talents`),f.env);
    assert.equal(denied.status,401);assert(!(await denied.text()).includes('Example Character'));
    assert.equal(mock.calls.length,0);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM talent_cache').first()).n,0);
    for(const id of [0,72,73,999999,'9007199254740993','-1','https%3A%2F%2Fevil.example']){
      const {response,data}=await get(f,id);assert.equal(response.status,404);assert(data.error);
    }
    assert.equal(mock.calls.length,0);
    const {response,data}=await get(f);assert.equal(response.status,200);assert.equal(data.character_id,CHARACTER);assert.equal(data.status,'verified');
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert(data.trees.some(tree=>tree.id===62&&tree.points===2));
    const post=await worker.fetch(f.request(`/api/characters/${CHARACTER}/talents`,'POST'),f.env);assert.equal(post.status,405);
  });
});

test('repeated talent clicks reuse cached build, index and all layouts with their observation timestamps',async()=>{
  const f=await fixture(),mock=provider(f);
  await withProvider(mock,async()=>{
    const first=await get(f),count=mock.calls.length,second=await get(f);assert.equal(count,6);assert.equal(mock.calls.length,count);assert.deepEqual(second.data,first.data);
    assert.equal(dataCalls(mock).filter(call=>call.url.pathname===BUILD_PATH).length,1);
    assert.deepEqual(first.data.trees.map(tree=>tree.id),SPECS);assert(first.data.trees.every(tree=>tree.layout_available&&tree.layout_observed_at));
    const chosen=first.data.trees[0].nodes.find(node=>node.id===500);assert.equal(chosen.rank,2);assert.equal(chosen.max_rank,3);assert.equal(chosen.description,'Observed second rank');
    assert(first.data.trees.slice(1).every(tree=>tree.points===0&&tree.nodes.every(node=>node.rank===0)));
    for(const call of dataCalls(mock)){
      assert.equal(call.url.searchParams.get('namespace'),call.url.pathname.startsWith('/profile/')?'profile-forever-eu':'static-forever-eu');assert.equal(call.url.searchParams.get('locale'),'en_GB');
      assert.equal(call.options.redirect,'manual');assert.equal(call.options.cache,'no-store');
    }
    assert(!JSON.stringify(first.data).includes('fixture-secret'));assert(!JSON.stringify(first.data).includes('fixture-talent-token'));
  });
});

test('index references cannot redirect requests to arbitrary hosts, paths or supplied query arguments',async()=>{
  const f=await fixture(),index=indexPayload();
  const attacks=['https://evil.example/data/wow/talent-tree/999/playable-specialization/999','https://eu.api.blizzard.com.evil.example/data/wow/talent-tree/999/playable-specialization/999','http://eu.api.blizzard.com/data/wow/talent-tree/999/playable-specialization/999','https://eu.api.blizzard.com/profile/wow/character/other/specializations','https://eu.api.blizzard.com/data/wow/talent-tree/999/playable-specialization/999/extra','https://eu.api.blizzard.com/data/wow/talent-tree/999%2Fplayable-specialization%2F999'];
  index.spec_talent_trees.unshift(...attacks.map(href=>({name:'Untrusted',key:{href}})));
  index.spec_talent_trees.find(ref=>ref.name==='Tree 62').key.href+='?namespace=profile-attacker&access_token=untrusted#ignored';
  const mock=provider(f,{[INDEX_PATH]:index});
  await withProvider(mock,async()=>{
    const {response,data}=await get(f,CHARACTER,'?url=https://evil.example/steal&character=other');assert.equal(response.status,200);assert.equal(data.status,'verified');
    assert.deepEqual(dataCalls(mock).map(call=>call.url.pathname),[BUILD_PATH,INDEX_PATH,...SPECS.map(layoutPath)]);
    assert(mock.calls.every(call=>!call.url.href.includes('untrusted')&&!call.url.href.includes('attacker')&&!call.url.href.includes('evil.example')));
  });
});

test('an index without valid Blizzard class and specialization paths is rejected rather than used for lookups',async()=>{
  const invalid=['https://evil.example/data/wow/talent-tree/100','http://eu.api.blizzard.com/data/wow/talent-tree/100','https://eu.api.blizzard.com/data/wow/talent-tree/100/extra','https://eu.api.blizzard.com/data/wow/talent-tree/100/playable-specialization/62'];
  for(const href of invalid)assert.throws(()=>normalizeTalentIndex({...indexPayload(),class_talent_trees:[{name:'Mage',key:{href}}]}),/usable talent tree index/i);
  const f=await fixture(),mock=provider(f,{[INDEX_PATH]:{class_talent_trees:indexPayload().class_talent_trees,spec_talent_trees:[{key:{href:'https://evil.example/data/wow/talent-tree/100/playable-specialization/62'}}]}});
  await withProvider(mock,async()=>{
    const {data}=await get(f);assert.equal(data.status,'verified');assert.equal(data.trees[0].layout_available,false);assert.match(data.note,/layouts could not be refreshed/i);
    assert.deepEqual(dataCalls(mock).map(call=>call.url.pathname),[BUILD_PATH,INDEX_PATH]);assert.equal((await cache(f,'index')).status,'unavailable');
  });
});

test('static layout class and specialization identities must match the selected class and indexed tree',async()=>{
  for(const field of ['playable_class','playable_specialization']){
    const f=await fixture(),wrong=layoutPayload(62);wrong[field].id=999;
    const mock=provider(f,{[layoutPath(62)]:wrong});
    await withProvider(mock,async()=>{
      const {data}=await get(f),tree=data.trees.find(tree=>tree.id===62);assert.equal(tree.layout_available,false);assert.equal(tree.nodes[0].rank,2);assert.equal(tree.nodes[0].row,null);
      assert.equal((await cache(f,'layout:8:100:62')).status,'unavailable');assert.match(data.note,/layouts could not be refreshed/i);
      assert(data.trees.filter(tree=>tree.id!==62).every(tree=>tree.layout_available));
    });
  }
});

test('malformed newer build and layout responses preserve the previous observations and original timestamps as stale',async()=>{
  const f=await fixture(),overrides={},mock=provider(f,overrides),observed='2026-01-02T03:04:05.000Z';
  await withProvider(mock,async()=>{
    const first=(await get(f)).data;
    await f.DB.prepare("UPDATE talent_cache SET observed_at=?,next_at=0 WHERE cache_key IN ('build:71','layout:8:100:62')").bind(observed).run();
    overrides[BUILD_PATH]=buildPayload(999);overrides[layoutPath(62)]={...layoutPayload(62),playable_class:{id:9}};
    const result=(await get(f)).data,tree=result.trees.find(tree=>tree.id===62);assert.equal(result.status,'stale');assert.equal(result.observed_at,observed);assert.notEqual(result.checked_at,observed);assert.match(result.note,/previous talent build/i);
    assert.equal(tree.layout_observed_at,observed);assert.deepEqual(tree.nodes,first.trees.find(tree=>tree.id===62).nodes);assert.equal(tree.points,2);
    assert.equal((await cache(f,'build:71')).observed_at,observed);assert.equal((await cache(f,'layout:8:100:62')).status,'stale');
    const count=mock.calls.length;await get(f);assert.equal(mock.calls.length,count,'Malformed responses must back off instead of retrying every click');
  });
});

test('404 talent resources back off for an hour and never turn unknown allocations into an empty build',async()=>{
  const f=await fixture(),mock=provider(f,{[BUILD_PATH]:()=>Response.json({error:'Not found'},{status:404}),[layoutPath(62)]:()=>Response.json({error:'Not found'},{status:404})});
  await withProvider(mock,async()=>{
    const first=(await get(f)).data,count=mock.calls.length;assert.equal(first.status,'unavailable');assert.equal(first.observed_at,null);assert(first.trees.flatMap(tree=>tree.nodes).every(node=>node.rank===null));
    for(const key of ['build:71','layout:8:100:62']){const row=await cache(f,key);assert.equal(row.status,'unavailable');assert(row.next_at>=epoch()+3598);assert.equal(row.observed_at,null);}
    await get(f);assert.equal(mock.calls.length,count);
    await f.DB.prepare("UPDATE talent_cache SET next_at=0 WHERE cache_key='build:71'").run();await get(f);assert.equal(mock.calls.length,count+1,'A due resource may retry while unrelated cached resources remain untouched');
  });
});

test('a Blizzard 429 pauses all talent resources and another character without additional provider calls',async()=>{
  const f=await fixture(),mock=provider(f,{[BUILD_PATH]:()=>Response.json({error:'Rate limited'},{status:429,headers:{'Retry-After':'1200'}})});
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','second-character',72,JSON.stringify({...f.member,id:72,slug:'second-character'})).run();
  await withProvider(mock,async()=>{
    const first=(await get(f)).data;assert.equal(first.status,'unavailable');assert.equal(dataCalls(mock).length,1);assert.equal(dataCalls(mock)[0].url.pathname,BUILD_PATH);
    const until=JSON.parse((await f.DB.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").first()).value);assert(until>=epoch()+1198);
    const count=mock.calls.length;await get(f);const other=(await get(f,72)).data;assert.equal(mock.calls.length,count);assert.equal(other.status,'unavailable');assert.match(other.note,/not returned/i);
  });
});

test('fresh normalized talents from the regular character refresh avoid a duplicate profile talent request',async()=>{
  const f=await fixture(),at=new Date(Date.now()-60000).toISOString(),build=normalizeTalentBuild(buildPayload(),CHARACTER),mock=provider(f);
  await f.DB.prepare('UPDATE characters SET data=? WHERE id=?').bind(JSON.stringify({talent_build:build,talents_status:'verified',talents_at:at}),CHARACTER).run();
  await withProvider(mock,async()=>{
    const first=(await get(f)).data;assert.equal(first.status,'verified');assert.equal(first.observed_at,at);assert.equal(first.checked_at,at);assert.equal(first.trees.find(tree=>tree.id===62).nodes[0].rank,2);
    assert(!dataCalls(mock).some(call=>call.url.pathname===BUILD_PATH));assert.equal(await cache(f,'build:71'),null);
    const count=mock.calls.length;await get(f);assert.equal(mock.calls.length,count);
    await f.DB.prepare('UPDATE characters SET data=? WHERE id=?').bind(JSON.stringify({talent_build:build,talents_status:'verified',talents_at:new Date(Date.now()-16*60000).toISOString()}),CHARACTER).run();
    await get(f);assert.equal(dataCalls(mock).filter(call=>call.url.pathname===BUILD_PATH).length,1,'Expired regular-refresh data requires one new observation');
  });
});
