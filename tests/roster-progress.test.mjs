import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {tick,GUILD,SLUG} from '../src/logic.mjs';
import {historyView} from '../src/progress.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
const member={id:731,name:'Rook Testlight',slug:'rook-testlight',class:'Mage',class_id:8,race:'Human'};
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
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){
    raw.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.run());raw.exec('COMMIT');return rows;}catch(error){raw.exec('ROLLBACK');throw error;}
  }};
}
async function fixture({existing=true,profileStatus='unavailable'}={}){
  const DB=database(),at=new Date(Date.now()-30*60000).toISOString();
  if(existing){
    await DB.prepare("UPDATE sync SET phase='roster',published='previous',status='ready',roster_at=?,updated=?,next_at=?,total=1 WHERE id=1").bind(at,at,epoch()+900).run();
    await DB.prepare('INSERT INTO membership(generation,slug,character_id,data) VALUES(?,?,?,?)').bind('previous',member.slug,member.id,JSON.stringify({...member,level:4,roster_observed:at})).run();
    const data=profileStatus==='stale'?{profile:{level:4,class:'Mage',race:'Human'},profile_at:at,profile_status:'stale',profile_availability:'temporary_error'}:{profile_status:'unavailable',profile_availability:'not_published'};
    await DB.prepare('INSERT INTO characters(id,data,updated) VALUES(?,?,?)').bind(member.id,JSON.stringify(data),at).run();
    await DB.prepare('INSERT INTO character_refresh(character_id,next_at) VALUES(?,?)').bind(member.id,epoch()+3600).run();
  }
  return {DB,at,env:{DB,BLIZZARD_CLIENT_ID:'roster-progress-'+crypto.randomUUID(),BLIZZARD_CLIENT_SECRET:'fixture-secret'},rosterLevel:5,profileLevel:null,calls:[]};
}
async function withProvider(f,run){
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const path=new URL(input).pathname;f.calls.push(path);
    if(path==='/token')return Response.json({access_token:'fixture-roster-progress-token',expires_in:3600});
    if(path==='/data/wow/ruleset/3')return Response.json({id:3,name:'Roleplay'});
    if(path===`/data/wow/guild/${SLUG}`)return Response.json({id:18,name:GUILD,ruleset:{id:3}});
    if(path===`/data/wow/guild/${SLUG}/roster`)return Response.json({guild:{id:18},members:[{character:{id:member.id,name:'Rook',surname:'Testlight',slug:member.slug,level:f.rosterLevel,playable_class:{id:8},playable_race:{id:1}},rank:1},...(f.arrivals||[]).map(character=>({character,rank:2}))]});
    if(path===`/profile/wow/character/${member.slug}`){
      if(f.profileLevel===null)return Response.json({error:'Synthetic unpublished profile'},{status:404});
      return Response.json({id:member.id,ruleset:{id:3},level:f.profileLevel,character_class:{name:'Mage'},race:{name:'Human'}});
    }
    if(path===`/profile/wow/character/${member.slug}/professions`)return Response.json({character:{id:member.id},primaries:[],secondaries:[]});
    if(path===`/profile/wow/character/${member.slug}/specializations`)return Response.json({character:{id:member.id},specialization_groups:[]});
    if(path.startsWith('/profile/wow/character/'))return Response.json({error:'Synthetic unpublished profile'},{status:404});
    throw Error('Unexpected provider request '+path);
  };
  try{return await run();}finally{globalThis.fetch=original;f.DB.raw.close();}
}
async function publishRoster(f){await f.DB.prepare('UPDATE sync SET next_at=0 WHERE id=1').run();await tick(f.env);await tick(f.env);}
async function levelMilestones(f){return (await f.DB.prepare("SELECT * FROM activity WHERE character_id=? AND kind='level' ORDER BY observed_at").bind(member.id).all()).results;}

test('a low-level roster change records the observed level-up even while its character profile is unpublished',async()=>{
  const f=await fixture();
  await withProvider(f,async()=>{
    await publishRoster(f);
    const saved=await f.DB.prepare('SELECT data FROM characters WHERE id=?').bind(member.id).first();
    assert.equal(JSON.parse(saved.data).profile_status,'unavailable','Roster evidence must not claim that the character profile was published');
    const milestones=await levelMilestones(f);
    assert.equal(milestones.length,1);assert.equal(milestones[0].title,'Rook Testlight reached level 5');assert.match(milestones[0].detail,/4/);
    const history=await historyView(f.env,member.id);
    assert(history.observations.some(event=>event.kind==='level'&&event.title==='Level: 4 → 5'));
    assert(f.calls.includes(`/profile/wow/character/${member.slug}`));
    assert(!f.calls.some(path=>path.endsWith('/professions')||path.endsWith('/specializations')),'An unpublished profile must not trigger unavailable detail calls');
  });
});

test('repeated roster polls and a later matching character profile never duplicate the same level milestone',async()=>{
  const f=await fixture();
  await withProvider(f,async()=>{
    await publishRoster(f);await publishRoster(f);
    f.profileLevel=5;
    await f.DB.prepare('UPDATE character_refresh SET next_at=0 WHERE character_id=?').bind(member.id).run();
    await tick(f.env);
    assert.equal((await levelMilestones(f)).length,1);
    const history=await historyView(f.env,member.id),levels=history.observations.filter(event=>event.kind==='level');
    assert.equal(levels.length,1);assert.equal(levels[0].title,'Level: 4 → 5');
  });
});

test('a first roster observation records a baseline rather than inventing an earlier level-up',async()=>{
  const f=await fixture({existing:false});
  await withProvider(f,async()=>{
    await publishRoster(f);
    assert.equal((await levelMilestones(f)).length,0);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM activity WHERE kind='joined'").first()).count,0,'An initial import must not invent a join date for every existing member');
    const history=await historyView(f.env,member.id);
    assert(history.observations.some(event=>event.kind==='baseline'&&/Level 5/.test(event.detail)));
    assert(!history.observations.some(event=>event.kind==='level'),'The first returned level is not evidence of a level-up');
  });
});

test('new roster arrivals enter the chronicle only after a complete publication and never repeat on identical polls',async()=>{
  const f=await fixture();f.rosterLevel=4;
  f.arrivals=Array.from({length:13},(_,index)=>({id:800+index,name:'Arrival'+index,surname:'Testlight',slug:'arrival'+index+'-testlight',level:1,playable_class:{id:8},playable_race:{id:1}}));
  const joined=async()=>(await f.DB.prepare("SELECT character_id,title FROM activity WHERE kind='joined' ORDER BY character_id").all()).results;
  await withProvider(f,async()=>{
    await f.DB.prepare('UPDATE sync SET next_at=0 WHERE id=1').run();
    await tick(f.env);
    assert.deepEqual(await joined(),[],'Fetching a roster does not publish it');
    await tick(f.env);
    assert.equal((await f.DB.prepare('SELECT published FROM sync WHERE id=1').first()).published,'previous');
    assert.deepEqual(await joined(),[],'An incomplete staged roster must not announce arrivals');
    await tick(f.env);
    const first=await joined();assert.deepEqual(first.map(row=>row.character_id),f.arrivals.map(arrival=>arrival.id));
    assert(first.every(row=>row.title.includes('appeared in the guild roster')));
    await f.DB.prepare('UPDATE sync SET next_at=0 WHERE id=1').run();
    await tick(f.env);await tick(f.env);await tick(f.env);
    assert.deepEqual(await joined(),first,'The same roster in a later generation must not repeat join announcements');
  });
});

test('recovering a stale profile still logs its higher level against the last successful observation',async()=>{
  const f=await fixture({profileStatus:'stale'});f.profileLevel=5;
  await withProvider(f,async()=>{
    await f.DB.prepare('UPDATE character_refresh SET next_at=0 WHERE character_id=?').bind(member.id).run();
    await tick(f.env);
    const milestones=await levelMilestones(f);
    assert.equal(milestones.length,1);assert.equal(milestones[0].title,'Rook Testlight reached level 5');assert.match(milestones[0].detail,/4/);
    const history=await historyView(f.env,member.id);assert(history.observations.some(event=>event.kind==='level'&&event.title==='Level: 4 → 5'));
  });
});

test('a lagging lower roster cannot invent a level-up below an already observed higher character profile',async()=>{
  const f=await fixture({profileStatus:'stale'});
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.profile.level',10) WHERE id=?").bind(member.id).run();
  await withProvider(f,async()=>{
    await publishRoster(f);
    assert.equal((await levelMilestones(f)).length,0,'Roster4→5 is already superseded by a verified level10 observation');
    const history=await historyView(f.env,member.id);
    assert(!history.observations.some(event=>event.kind==='level'&&/→ 5$/.test(event.title)));
  });
});

test('a failed final publication rolls back joined and level events together with its snapshots and publication pointer',async()=>{
  const f=await fixture(),originalBatch=f.DB.batch.bind(f.DB);let failed=false;
  f.arrivals=[{id:800,name:'Sable',surname:'Testlight',slug:'sable-testlight',level:1,playable_class:{id:8},playable_race:{id:1}}];
  f.DB.batch=statements=>{
    if(!failed&&statements.some(statement=>/INSERT OR IGNORE INTO snapshots/.test(statement.sql))){
      failed=true;return originalBatch([...statements,f.DB.prepare('INSERT INTO missing_publication_test_table VALUES(1)')]);
    }
    return originalBatch(statements);
  };
  await withProvider(f,async()=>{
    await publishRoster(f);
    assert(failed,'A publication batch must include its level observations');
    assert.equal((await f.DB.prepare('SELECT published FROM sync WHERE id=1').first()).published,'previous');
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM activity').first()).count,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM snapshots').first()).count,0);
    await publishRoster(f);
    assert.notEqual((await f.DB.prepare('SELECT published FROM sync WHERE id=1').first()).published,'previous');
    assert.equal((await levelMilestones(f)).length,1);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM activity WHERE kind='joined' AND character_id=800").first()).count,1);
  });
});

test('a primary-roster arrival does not repeat an existing fallback join or a level already observed from its profile',async()=>{
  const f=await fixture();f.rosterLevel=4;
  f.arrivals=[{id:800,name:'Sable',surname:'Testlight',slug:'sable-testlight',level:5,playable_class:{id:8},playable_race:{id:1}}];
  await f.DB.prepare('INSERT INTO activity(id,character_id,kind,title,detail,observed_at) VALUES(?,?,?,?,?,?)')
    .bind('synthetic-profile-join',800,'joined','Sable Testlight was verified in the guild','Synthetic prior fallback evidence',f.at).run();
  await f.DB.prepare('INSERT INTO snapshots(character_id,observed_at,data) VALUES(?,?,?)')
    .bind(800,f.at,JSON.stringify({level:5,profile_observed_at:f.at,professions:null})).run();
  await withProvider(f,async()=>{
    await publishRoster(f);
    const joined=(await f.DB.prepare("SELECT id FROM activity WHERE character_id=800 AND kind='joined'").all()).results;
    assert.equal(joined.length,1);assert.equal(joined[0].id,'synthetic-profile-join');
    assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM activity WHERE character_id=800 AND kind='level'").first()).count,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM snapshots WHERE character_id=800').first()).count,1);
  });
});
