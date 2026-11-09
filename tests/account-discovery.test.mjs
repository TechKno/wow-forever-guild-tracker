import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {discoverRosterAccounts} from '../src/account-discovery.mjs';
import {credentialSaveStatement} from '../src/account-credentials.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
async function fixture(){
  const raw=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  class Statement{constructor(sql,params=[]){this.sql=sql;this.params=params;}bind(...params){return new Statement(this.sql,params);}async first(){return raw.prepare(this.sql).get(...this.params)||null;}async all(){return {results:raw.prepare(this.sql).all(...this.params)};}async run(){return raw.prepare(this.sql).run(...this.params);}}
  const DB={raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
  const now=epoch(),at=new Date().toISOString(),user={id:'owner',subject_hash:'fixture-account',main_character_id:201,ownership_checked:now},env={DB,BLIZZARD_CLIENT_ID:'fixture-client',BLIZZARD_CLIENT_SECRET:'fixture-private'};
  await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind(user.id,user.subject_hash,201,now,at,at).run();
  await DB.prepare("INSERT INTO sessions VALUES('fixture-session','owner','fixture-csrf',?)").bind(now+3600).run();
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  const add=async id=>DB.prepare("INSERT INTO membership VALUES('current',?,?,?)").bind('fictional-'+id,id,JSON.stringify({id,name:'Fictional Character '+id,slug:'fictional-'+id,rank:2})).run();
  for(const id of [201,202]){await add(id);await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?)').bind(id,user.id,at,id===202?0:1).run();}
  for(const id of [201,202,203,204])await DB.prepare('INSERT INTO account_character_ownership VALUES(?,?,?,?)').bind(id,user.id,now,now+86400).run();
  await (await credentialSaveStatement(env,user,{access_token:'fixture-user-access',expires_in:3600},at)).run();
  return {DB,env,add,now,user};
}
test('a guild arrival already in the private authenticated ownership index groups without a provider request',async()=>{
  const f=await fixture();await discoverRosterAccounts(f.env);await f.add(203);await f.add(204);
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('Known ownership must not cause a provider lookup');};
  try{assert.deepEqual(await discoverRosterAccounts(f.env),{linked:2,queued:0});}finally{globalThis.fetch=original;}
  const links=(await f.DB.prepare('SELECT character_id,user_id,show_as_alt FROM character_links ORDER BY character_id').all()).results;
  assert.deepEqual(links.map(x=>[x.character_id,x.user_id,x.show_as_alt]),[[201,'owner',1],[202,'owner',0],[203,'owner',1],[204,'owner',1]]);
  assert.equal((await f.DB.prepare("SELECT main_character_id,ownership_checked FROM users WHERE id='owner'").first()).main_character_id,201);
  assert.equal((await f.DB.prepare("SELECT ownership_checked FROM users WHERE id='owner'").first()).ownership_checked,f.now,'Matching the index cannot invent a newer ownership observation');
  assert.deepEqual(await discoverRosterAccounts(f.env),{linked:0,queued:0});
});
test('only a newly unmatched roster arrival queues known authorised accounts; stable unmatched entries do not repoll them',async()=>{
  const f=await fixture();await discoverRosterAccounts(f.env);await f.add(900);
  assert.deepEqual(await discoverRosterAccounts(f.env),{linked:0,queued:1});
  const request=await f.DB.prepare("SELECT requested_revision,next_at FROM account_refresh WHERE user_id='owner'").first();assert(request.requested_revision);assert(request.next_at<=epoch());
  await f.DB.prepare("UPDATE account_refresh SET checked_revision=requested_revision,next_at=unixepoch()+900").run();
  assert.deepEqual(await discoverRosterAccounts(f.env),{linked:0,queued:0});
  assert.equal((await f.DB.prepare("SELECT requested_revision FROM account_refresh WHERE user_id='owner'").first()).requested_revision,request.requested_revision);
  await f.add(901);assert.equal((await discoverRosterAccounts(f.env)).queued,1);
  assert.notEqual((await f.DB.prepare("SELECT requested_revision FROM account_refresh WHERE user_id='owner'").first()).requested_revision,request.requested_revision);
});
test('expired, stale, unavailable or departed ownership evidence cannot group a newly observed character',async()=>{
  for(const reason of ['expired','stale','unavailable','departed']){
    const f=await fixture();await discoverRosterAccounts(f.env);await f.add(203);
    if(reason==='expired')await f.DB.prepare('UPDATE account_character_ownership SET expires_at=unixepoch()-1 WHERE character_id=203').run();
    if(reason==='stale')await f.DB.prepare("UPDATE users SET ownership_checked=unixepoch()-86401 WHERE id='owner'").run();
    if(reason==='unavailable')await f.DB.prepare("UPDATE users SET ownership_status='unavailable' WHERE id='owner'").run();
    if(reason==='departed')await f.DB.prepare("INSERT INTO membership_departures VALUES(203,'fictional-203','now')").run();
    assert.equal((await discoverRosterAccounts(f.env)).linked,0,reason);
    assert.equal(await f.DB.prepare('SELECT user_id FROM character_links WHERE character_id=203').first(),null,reason);
  }
});
test('an older cached owner cannot replace a newer verified association',async()=>{
  const f=await fixture(),at=new Date().toISOString();await f.add(203);
  await f.DB.prepare("INSERT INTO users VALUES('other','other-fixture',203,'verified',?,?,?)").bind(f.now,at,at).run();
  await f.DB.prepare("INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(203,'other',?,0)").bind(new Date((f.now+1)*1000).toISOString()).run();
  assert.equal((await discoverRosterAccounts(f.env)).linked,0);
  assert.equal((await f.DB.prepare('SELECT user_id FROM character_links WHERE character_id=203').first()).user_id,'other');
});
