import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {ORIGIN,random,digest} from '../src/auth.mjs';
import {questView} from '../src/quests.mjs';

const epoch=()=>Math.floor(Date.now()/1000),INDEX='static:/data/wow/quest/area/index';
async function fixture(){
  const raw=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(name,directory),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  const DB={prepare:sql=>new Statement(sql)},env={DB,BLIZZARD_CLIENT_ID:'quest-security-'+random(),BLIZZARD_CLIENT_SECRET:'fixture-secret'};
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  const now=new Date().toISOString(),token=random();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','example-character',71,JSON.stringify({id:71,name:'Example Character',slug:'example-character'})).run();
  await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind('quest-member','quest-subject',71,epoch(),now,now).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(71,'quest-member',now).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),'quest-member',random(),epoch()+3600).run();
  return {DB,env,request:path=>new Request(ORIGIN+path,{headers:{Cookie:'__Host-wv_session='+token}})};
}
async function cached(f,key,data,status='observed'){
  await f.DB.prepare('INSERT INTO api_cache VALUES(?,?,?)').bind(key,JSON.stringify({status,data,observed_at:new Date().toISOString()}),epoch()+600).run();
}
async function withProvider(fetch,run){const original=globalThis.fetch;globalThis.fetch=fetch;try{return await run();}finally{globalThis.fetch=original;}}
const compare=(f,area,characters='71')=>questView(f.request('/api/quests/compare?area='+area+'&characters='+characters),f.env);

test('unobserved area IDs cannot make upstream requests or create arbitrary cache rows',async()=>{
  const f=await fixture();await cached(f,INDEX,{areas:[{id:12,name:'Observed Area'}]});
  let calls=0;
  await withProvider(async()=>{calls++;throw Error('Unknown areas must not be fetched');},async()=>{
    for(const area of [1,13,999999,Number.MAX_SAFE_INTEGER])await assert.rejects(()=>compare(f,area),error=>error.status===400&&/returned by Blizzard/.test(error.message));
  });
  assert.equal(calls,0);assert.deepEqual((await f.DB.prepare('SELECT key FROM api_cache').all()).results.map(row=>row.key),[INDEX]);
});

test('unavailable area index fails closed without fetching a guessed area or character quests',async()=>{
  const f=await fixture();await cached(f,INDEX,undefined,'unavailable');let calls=0;
  await withProvider(async()=>{calls++;throw Error('Unavailable index must stop comparisons');},()=>assert.rejects(()=>compare(f,12),error=>error.status===503));
  assert.equal(calls,0);assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM api_cache').first()).count,1);
});

test('empty or malformed observed index never authorises arbitrary area IDs',async()=>{
  for(const areas of [[],[{id:'12',name:'Wrong type'}],null]){
    const f=await fixture();await cached(f,INDEX,{areas});
    await withProvider(async()=>{assert.fail('Invalid area index must not authorise a lookup');},()=>assert.rejects(()=>compare(f,12),error=>error.status===400));
    assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM api_cache').first()).count,1);
  }
});

test('only the area index is fetched when a requested area is not in its observed list',async()=>{
  const f=await fixture(),calls=[];
  await withProvider(async input=>{
    const url=new URL(input);calls.push(url.pathname);
    if(url.hostname==='oauth.battle.net')return Response.json({access_token:'fixture-quest-token',expires_in:3600});
    assert.equal(url.origin,'https://eu.api.blizzard.com');assert.equal(url.pathname,'/data/wow/quest/area/index');
    return Response.json({areas:[{id:12,name:'Observed Area'}]});
  },()=>assert.rejects(()=>compare(f,99),error=>error.status===400));
  assert.deepEqual(calls,['/token','/data/wow/quest/area/index']);
  assert.deepEqual((await f.DB.prepare('SELECT key FROM api_cache').all()).results.map(row=>row.key),[INDEX]);
});

test('observed areas retain normal active/completed quest comparison',async()=>{
  const f=await fixture();
  await cached(f,INDEX,{areas:[{id:12,name:'Observed Area'}]});
  await cached(f,'static:/data/wow/quest/area/12',{area:{id:12,name:'Observed Area'},quests:[{id:1,name:'Active Quest'},{id:2,name:'Finished Quest'},{id:3,name:'Not Observed'}]});
  await cached(f,'profile:/profile/wow/character/example-character/quests',{in_progress:[{id:1,name:'Active Quest'}]});
  await cached(f,'profile:/profile/wow/character/example-character/quests/completed',{quests:[{id:2,name:'Finished Quest'}]});
  await withProvider(async()=>{assert.fail('Fresh cached comparison must not contact Blizzard');},async()=>{
    const value=await compare(f,12);assert.equal(value.status,'observed');assert.equal(value.area,'Observed Area');
    assert.deepEqual(value.quests.map(q=>q.characters[0].state),['in_progress','completed','not_observed']);
  });
});

test('unknown quest endpoints and non-guild characters are rejected before the area index lookup',async()=>{
  const f=await fixture();
  await withProvider(async()=>{assert.fail('Invalid route or character must not contact Blizzard');},async()=>{
    await assert.rejects(()=>questView(f.request('/api/quests/unknown?area=12&characters=71'),f.env),error=>error.status===404);
    await assert.rejects(()=>compare(f,12,'999'),error=>error.status===400);
  });
  assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM api_cache').first()).count,0);
});
