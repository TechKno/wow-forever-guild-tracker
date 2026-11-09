import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {probeCharacter} from '../src/logic.mjs';
import {ORIGIN,currentUser,random,digest} from '../src/auth.mjs';

const epoch=()=>Math.floor(Date.now()/1000),guild={id:18,name:'Example Guild',ruleset:'EU Roleplay'};
const newcomer={id:91,name:'New',surname:'Visitor',slug:'new-visitor',level:12,ruleset:{id:3},guild:{id:18,name:'Example Guild',slug:'example-guild'},character_class:{id:8,name:'Mage'},race:{id:1,name:'Human'}};
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),userId='probe-admin',now=new Date().toISOString(),token=random(),csrf=random();
  await DB.prepare("UPDATE sync SET published='current',roster_at=? WHERE id=1").bind(now).run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','existing-character',71,JSON.stringify({id:71,name:'Existing Character',slug:'existing-character',level:20,roster_observed:now})).run();
  await DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify(guild)).run();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(userId,'probe-subject',71,'verified',epoch(),now,now).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(71,userId,now).run();
  await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await digest(token),userId,csrf,epoch()+3600).run();
  const env={DB,BLIZZARD_CLIENT_ID:'probe-fixture-'+crypto.randomUUID(),BLIZZARD_CLIENT_SECRET:'fixture-secret',ADMIN_USER_IDS:userId};
  return {DB,env,userId,request:path=>new Request(ORIGIN+path,{headers:{Cookie:'__Host-wv_session='+token}})};
}
async function withProvider(profile,run){
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=new URL(url);calls.push({url:target.href,options});
    if(target.href==='https://oauth.battle.net/token')return Response.json({access_token:'fixture-app-token',expires_in:3600});
    if(target.hostname==='eu.api.blizzard.com'&&target.pathname.startsWith('/profile/wow/character/')){
      if(profile===null)return Response.json({error:'not published'},{status:404});
      return Response.json(profile,{headers:{'Last-Modified':'Sun, 08 Nov 2026 20:00:00 GMT'}});
    }
    if(target.hostname==='eu.api.blizzard.com'&&target.pathname==='/data/wow/guild/example-guild/roster')return Response.json({guild:{id:18},members:[{character:{id:71,level:20}}]});
    throw Error('Unexpected diagnostic destination');
  };
  try{return await run(calls);}finally{globalThis.fetch=original;}
}
function authoritySnapshot(DB){
  return Object.fromEntries(['users','sessions','character_links','profile_members','membership'].map(table=>[table,DB.raw.prepare('SELECT * FROM '+table).all()]));
}

test('unknown structured character probes use only the fixed EU profile endpoint and report guild proof without registering a member',async()=>{
  const f=await fixture(),before=authoritySnapshot(f.DB);
  await withProvider({...newcomer,key:{href:'https://evil.example/ownership'}},async calls=>{
    const result=await probeCharacter(f.env,'New-Visitor');
    assert.equal(result.character.id,91);assert.equal(result.character.slug,'new-visitor');assert.equal(result.blizzard.profile.guild_verified,true);
    assert.equal(result.blizzard.profile.guild_id,18);assert.equal(result.blizzard.profile.ruleset_id,3);assert.equal(result.saved,null);
    assert.equal(result.ownership_verified,false);assert.equal(result.persisted,false);assert.match(result.note,/does not add a member or verify account ownership/i);
    assert.deepEqual(calls.map(c=>new URL(c.url).hostname),['oauth.battle.net','eu.api.blizzard.com']);
    assert.equal(calls[1].url,'https://eu.api.blizzard.com/profile/wow/character/new-visitor?namespace=profile-forever-eu&locale=en_GB');
    assert.equal(calls[1].options.redirect,'manual');assert.equal(calls[1].options.cache,'no-store');
  });
  assert.deepEqual(authoritySnapshot(f.DB),before);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM verified_membership WHERE character_id=91').first()).n,0);
  const user=await currentUser(f.request('/guild'),f.env);assert.equal(user.characters.length,1);assert.equal(user.characters[0].id,71);
});

test('profile diagnostics distinguish a wrong guild, wrong ruleset and mismatched slug without treating them as membership or ownership',async()=>{
  const variants=[{...newcomer,guild:{id:19,name:guild.name}},{...newcomer,guild:{id:18,name:'Another Guild'}},{...newcomer,ruleset:{id:1}},{...newcomer,guild:undefined},{...newcomer,name:'Other',surname:'Visitor',slug:'other-visitor'}];
  for(const profile of variants){
    const f=await fixture(),before=authoritySnapshot(f.DB);
    await withProvider(profile,async()=>{
      const result=await probeCharacter(f.env,'new-visitor');assert.equal(result.blizzard.profile.status,'observed');assert.equal(result.blizzard.profile.guild_verified,false);assert.equal(result.ownership_verified,false);assert.equal(result.persisted,false);
    });
    assert.deepEqual(authoritySnapshot(f.DB),before);
  }
});

test('an unpublished unknown profile reports404 and never writes fallback or ownership data',async()=>{
  const f=await fixture(),before=authoritySnapshot(f.DB);
  await withProvider(null,async()=>{
    const result=await probeCharacter(f.env,'new-visitor');assert.equal(result.blizzard.profile.status,'unavailable');assert.equal(result.blizzard.profile.http_status,404);assert.equal(result.ownership_verified,false);assert.equal(result.persisted,false);
  });
  assert.deepEqual(authoritySnapshot(f.DB),before);
});

test('invalid unknown slugs return before any provider request and cannot use URL/path syntax',async()=>{
  const f=await fixture(),before=authoritySnapshot(f.DB);
  await withProvider(newcomer,async calls=>{
    for(const value of ['unknown','new-visitor/../other','https://evil.example/new-visitor','new-visitor?token=stolen','new--visitor','../visitor','new-visitor-extra','new-123','a'.repeat(41)+'-visitor'])assert.equal(await probeCharacter(f.env,value),null,value);
    assert.equal(calls.length,0);
  });
  assert.deepEqual(authoritySnapshot(f.DB),before);
});

test('the Worker requires a current verified member, sole-admin permission and lookup allowance before running a profile discovery probe',async()=>{
  const path='/api/admin/character-check?character=new-visitor',f=await fixture();
  await withProvider(newcomer,async calls=>{
    assert.equal((await worker.fetch(new Request(ORIGIN+path),f.env)).status,401);
    f.env.ADMIN_USER_IDS='another-admin';assert.equal((await worker.fetch(f.request(path),f.env)).status,403);
    f.env.ADMIN_USER_IDS=f.userId;
    await f.DB.prepare("UPDATE users SET ownership_status='unavailable' WHERE id=?").bind(f.userId).run();assert.equal((await worker.fetch(f.request(path),f.env)).status,403);
    await f.DB.prepare("UPDATE users SET ownership_status='verified' WHERE id=?").bind(f.userId).run();
    f.env.LOOKUP_RATE={async limit(){return {success:false};}};
    const denied=await worker.fetch(f.request(path),f.env);assert.equal(denied.status,429);assert.equal(denied.headers.get('Retry-After'),'60');
    assert.equal(calls.length,0);
    f.env.LOOKUP_RATE={async limit(){return {success:true};}};
    const before=authoritySnapshot(f.DB),response=await worker.fetch(f.request(path),f.env),result=await response.json();
    assert.equal(response.status,200);assert.equal(result.blizzard.profile.guild_verified,true);assert.equal(result.ownership_verified,false);
    assert.deepEqual(authoritySnapshot(f.DB),before);
  });
});

test('existing current-character diagnostics retain roster/profile comparisons instead of entering the unknown-character discovery branch',async()=>{
  const f=await fixture();
  await withProvider({...newcomer,id:71,name:'Existing',surname:'Character',slug:'existing-character',level:21},async calls=>{
    const result=await probeCharacter(f.env,'existing-character');
    assert.equal(result.saved.level,20);assert.equal(result.blizzard.roster.level,20);assert.equal(result.blizzard.profile.level,21);
    assert.equal(result.blizzard.roster.status,'observed');assert.equal(result.blizzard.profile.status,'observed');
    assert(calls.some(c=>new URL(c.url).pathname.endsWith('/roster')));assert(calls.some(c=>new URL(c.url).pathname==='/profile/wow/character/existing-character'));
  });
});
