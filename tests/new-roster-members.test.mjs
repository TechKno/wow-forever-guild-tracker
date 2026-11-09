import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {tick,GUILD} from '../src/logic.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
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
  return {prepare:sql=>new Statement(sql),async batch(statements){
    raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}
  }};
}

test('a 15-to-17 roster publishes new level-one members independently of unavailable character profiles',async()=>{
  const DB=database(),at=new Date(Date.now()-20*60000).toISOString(),token=random(),csrf=random();
  const existing=Array.from({length:15},(_,index)=>({id:50100+index,name:'Original'+index,surname:'Fixture',slug:'original'+index+'-fixture',level:20,playable_class:{id:8},playable_race:{id:1}}));
  const arrivals=[
    {id:50200,name:'Rook',surname:'Testlight',slug:'rook-testlight',level:1,playable_class:{id:8},playable_race:{id:1}},
    {id:50201,name:'Sable',surname:'Testlight',slug:'sable-testlight',level:1,playable_class:{id:5},playable_race:{id:1}}
  ];
  const roster=[...existing,...arrivals];
  await DB.prepare("UPDATE sync SET phase='roster',published='previous',roster_at=?,updated=?,status='ready',next_at=0,total=15 WHERE id=1").bind(at,at).run();
  for(const member of existing)await DB.prepare('INSERT INTO membership(generation,slug,character_id,data) VALUES(?,?,?,?)')
    .bind('previous',member.slug,member.id,JSON.stringify({...member,name:member.name+' '+member.surname,class:'Mage',roster_observed:at})).run();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('roster-reader','synthetic-roster-subject',existing[0].id,'verified',epoch(),at,at).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(existing[0].id,'roster-reader',at).run();
  await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await digest(token),'roster-reader',csrf,epoch()+3600).run();
  const env={DB,BLIZZARD_CLIENT_ID:'new-roster-fixture-'+random(),BLIZZARD_CLIENT_SECRET:'fixture-secret'};
  async function visible(){
    const response=await worker.fetch(new Request(ORIGIN+'/api/members',{headers:{Cookie:'__Host-wv_session='+token}}),env);
    assert.equal(response.status,200);return response.json();
  }
  async function publicCount(){const response=await worker.fetch(new Request(ORIGIN+'/api/public'),env);assert.equal(response.status,200);return (await response.json()).member_count;}
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(input)=>{
    const path=new URL(input).pathname;calls.push(path);
    if(path==='/token')return Response.json({access_token:'synthetic-roster-token',expires_in:3600});
    if(path==='/data/wow/ruleset/3')return Response.json({id:3,name:'Roleplay'});
    if(path==='/data/wow/guild/example-guild')return Response.json({id:18,name:GUILD,ruleset:{id:3}});
    if(path==='/data/wow/guild/example-guild/roster')return Response.json({guild:{id:18},members:roster.map(character=>({character,rank:1}))});
    if(path.startsWith('/profile/wow/character/'))return Response.json({error:'Synthetic unpublished profile'},{status:404});
    throw Error('Unexpected provider request '+path);
  };
  try{
    // Fetching and partially staging a larger response must not expose an incomplete roster.
    for(let step=0;step<2;step++){
      await tick(env);const published=await visible();
      assert.equal(published.generation,'previous');assert.equal(published.members.length,15);assert.equal(await publicCount(),15);
      assert(!published.members.some(member=>arrivals.some(arrival=>arrival.id===member.id)));
    }
    await tick(env);
    let published=await visible();
    assert.notEqual(published.generation,'previous');assert.equal(published.members.length,17);assert.equal(await publicCount(),17);
    for(const arrival of arrivals){
      const observed=published.members.find(member=>member.id===arrival.id);
      assert(observed);assert.equal(observed.name,arrival.name+' '+arrival.surname);assert.equal(observed.level,1);
      assert.equal(observed.level_source,'roster');
    }
    // Drive the two new profile jobs, retaining their explicit404 result rather than hiding either member.
    await DB.prepare('UPDATE character_refresh SET next_at=? WHERE character_id<?').bind(epoch()+3600,arrivals[0].id).run();
    await tick(env);await tick(env);
    published=await visible();
    assert.equal(published.members.length,17);assert.equal(await publicCount(),17);
    for(const arrival of arrivals){
      const observed=published.members.find(member=>member.id===arrival.id);
      assert.equal(observed.level,1);assert.equal(observed.profile_status,'unavailable');assert.equal(observed.profile_availability,'not_published');
      assert(calls.includes('/profile/wow/character/'+arrival.slug));
      assert(!calls.includes('/profile/wow/character/'+arrival.slug+'/professions'));
    }
    const joined=await DB.prepare("SELECT character_id FROM activity WHERE kind='joined' ORDER BY character_id").all();
    assert.deepEqual(joined.results.map(row=>row.character_id),arrivals.map(member=>member.id));
    assert.equal((await DB.prepare("SELECT COUNT(*) count FROM activity WHERE kind='left'").first()).count,0);
  }finally{globalThis.fetch=originalFetch;}
});
