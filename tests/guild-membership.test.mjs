import {ensureDeploymentIdentity} from '../src/config.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {candidateFromAccount,validateProfileMember,profileMemberStatement,membershipRevision,PROFILE_MEMBERSHIP_TTL} from '../src/guild-membership.mjs';
const epoch=()=>Math.floor(Date.now()/1000),guild={id:42,name:'Example Guild',ruleset:'EU Roleplay'};
const candidate=()=>candidateFromAccount({id:101,name:'Test',surname:'Adventurer'});
const profile=(overrides={})=>({id:101,name:'Test',surname:'Adventurer',slug:'test-adventurer',ruleset:{id:3},guild:{id:42,name:'Example Guild'},level:12,character_class:{id:11,name:'Druid'},race:{name:'Night Elf'},...overrides});
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{constructor(sql,params=[]){this.sql=sql;this.params=params;}bind(...params){return new Statement(this.sql,params);}async first(){return raw.prepare(this.sql).get(...this.params)||null;}async all(){return {results:raw.prepare(this.sql).all(...this.params)};}async run(){return raw.prepare(this.sql).run(...this.params);}}
  return {raw,prepare:sql=>new Statement(sql)};
}
async function fixture(){
  const DB=database(),env={DB},at=new Date().toISOString();await ensureDeploymentIdentity(env);
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify(guild)).run();
  await DB.prepare("INSERT INTO users(id,subject_hash,ownership_status,ownership_checked,created_at,updated_at) VALUES('owner','subject','verified',?,?,?)").bind(epoch(),at,at).run();
  await DB.prepare("INSERT INTO character_links(character_id,user_id,verified_at) VALUES(101,'owner',?)").bind(at).run();
  const member=validateProfileMember(profile(),candidate(),guild);
  await profileMemberStatement(env,'owner',member).run();
  return {DB,env,member};
}
async function visible(f){return (await f.DB.prepare("SELECT character_id,slug,data FROM verified_membership WHERE generation='current' ORDER BY character_id").all()).results;}

test('a roster departure defeats both existing proof visibility and a late sign-in proof upsert',async()=>{
  const f=await fixture(),late=profileMemberStatement(f.env,'owner',f.member);assert.equal((await visible(f)).length,1);
  await f.DB.prepare('INSERT INTO membership_departures(character_id,slug,observed_at) VALUES(?,?,?)').bind(f.member.id,f.member.slug,new Date().toISOString()).run();
  assert.equal((await visible(f)).length,0);await f.DB.prepare('DELETE FROM profile_members').run();await late.run();
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
});

test('account candidates use only safe structured ownership fields, never arbitrary provider hrefs',()=>{
  assert.deepEqual(candidateFromAccount({id:101,name:'Test',surname:'Adventurer',slug:'../../wrong',key:{href:'https://attacker.example/'}}),candidate());
  for(const bad of [{id:101,name:'Test'},{id:'101',name:'Test',surname:'Adventurer'},{id:0,name:'Test',surname:'Adventurer'},{id:101,name:'../../Test',surname:'Adventurer'},{id:101,name:'Test',surname:'Dr?x=y'},{id:101,key:{href:'https://eu.api.blizzard.com/profile/wow/character/test-adventurer'}}])assert.equal(candidateFromAccount(bad),null);
  assert.equal(candidateFromAccount({id:202,name:'Élan',surname:'Dr'}).slug,'élan-dr');
});

test('a profile proof requires exact account identity, guild identity and EU Roleplay ruleset',()=>{
  const now=Date.now(),member=validateProfileMember(profile(),candidate(),guild,now);
  assert.equal(member.name,'Test Adventurer');assert.equal(member.rank,null);assert.equal(member.roster_observed,null);assert.equal(member.membership_source,'character_profile');
  assert.equal(member.guild_id,42);assert.equal(member.ruleset_id,3);assert.equal(member.class,'Druid');assert.equal(member.race,'Night Elf');
  assert.equal(Date.parse(member.membership_expires_at)-Date.parse(member.membership_verified_at),PROFILE_MEMBERSHIP_TTL*1000);
  for(const bad of [profile({id:102}),profile({id:'101'}),profile({surname:'Someoneelse'}),profile({slug:'wrong-adventurer'}),profile({ruleset:{id:1}}),profile({ruleset:{id:'3'}}),profile({guild:undefined}),profile({guild:{id:99,name:'Example Guild'}}),profile({guild:{id:42,name:'Another Guild'}})])assert.throws(()=>validateProfileMember(bad,candidate(),guild));
  for(const known of [{...guild,id:null},{...guild,name:'Another Guild'},{...guild,ruleset:'EU PvP'}])assert.throws(()=>validateProfileMember(profile(),candidate(),known));
});

test('localized profile names are accepted without inferring class, rank or unavailable levels',()=>{
  const member=validateProfileMember(profile({guild:{id:42,name:{en_GB:'Example Guild'}},character_class:undefined,race:undefined,level:undefined}),candidate(),guild);
  assert.equal(member.class,'Unknown');assert.equal(member.class_id,null);assert.equal(member.race,'Unknown');assert.equal(member.level,null);assert.equal(member.rank,null);
});

test('a fresh owned profile member is included without altering the physical Blizzard roster',async()=>{
  const f=await fixture();assert.equal((await visible(f)).length,1);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM membership').first()).count,0);
  const proof=await f.DB.prepare('SELECT * FROM profile_members WHERE character_id=101').first();assert.equal(proof.user_id,'owner');assert.equal(proof.next_at-proof.checked_at,900);assert.equal(proof.expires-proof.checked_at,3600);
  await f.DB.prepare("UPDATE sync SET published='next' WHERE id=1").run();
  assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM verified_membership WHERE generation='next'").first()).count,1);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM verified_membership WHERE generation='current'").first()).count,0);
});

test('expired, stale-account, unverified and conflicting-owner proofs fail closed without cleanup',async()=>{
  const f=await fixture();
  for(const sql of ["UPDATE profile_members SET checked_at=unixepoch()-3601,expires=unixepoch()-1", "UPDATE users SET ownership_checked=unixepoch()-86401", "UPDATE users SET ownership_status='admin_mapped'", "UPDATE profile_members SET user_id='other'"]){
    f.DB.raw.exec('SAVEPOINT case_check');
    if(sql.includes("user_id='other'"))await f.DB.prepare("INSERT INTO users(id,subject_hash,ownership_status,ownership_checked,created_at,updated_at) VALUES('other','subject2','verified',?,'now','now')").bind(epoch()).run();
    f.DB.raw.exec(sql);assert.equal((await visible(f)).length,0,sql);assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM profile_members').first()).count,1);
    f.DB.raw.exec('ROLLBACK TO case_check');f.DB.raw.exec('RELEASE case_check');
  }
  assert.equal((await visible(f)).length,1);
});

test('an unexpected configured guild or tampered proof identity cannot create visible supplemental membership',async()=>{
  const f=await fixture();
  for(const sql of ["UPDATE state SET value=json_set(value,'$.id',99) WHERE key='guild'", "UPDATE state SET value=json_set(value,'$.name','Another Guild') WHERE key='guild'", "UPDATE state SET value=json_set(value,'$.ruleset','EU PvP') WHERE key='guild'", "UPDATE profile_members SET data=json_set(data,'$.id',999)", "UPDATE profile_members SET data=json_set(data,'$.guild_id',99)", "UPDATE profile_members SET data=json_set(data,'$.membership_source','manual')"]){
    f.DB.raw.exec('SAVEPOINT case_check');f.DB.raw.exec(sql);assert.equal((await visible(f)).length,0,sql);f.DB.raw.exec('ROLLBACK TO case_check');f.DB.raw.exec('RELEASE case_check');
  }
});

test('the current primary roster takes precedence by ID and slug without deleting an independent proof',async()=>{
  const f=await fixture(),raw={id:101,slug:'test-adventurer',name:'Test Adventurer',rank:4};
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',raw.slug,raw.id,JSON.stringify(raw)).run();
  assert.equal((await visible(f)).length,1);assert.equal(JSON.parse((await visible(f))[0].data).rank,4);
  await f.DB.prepare("DELETE FROM membership WHERE generation='current'").run();
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',raw.slug,999,JSON.stringify({...raw,id:999})).run();
  assert.equal((await visible(f)).length,1);assert.equal((await visible(f))[0].character_id,999);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM profile_members').first()).count,1);
});

test('the visible membership revision changes for supplemental addition, proof update, revocation and expiry',async()=>{
  const f=await fixture(),first=await membershipRevision(f.env);assert.match(first,/^current~/);assert.equal(await membershipRevision(f.env),first);
  await f.DB.prepare("UPDATE profile_members SET data=json_set(data,'$.level',13)").run();const updated=await membershipRevision(f.env);assert.notEqual(updated,first);
  await f.DB.prepare("UPDATE users SET ownership_status='unavailable'").run();assert.equal(await membershipRevision(f.env),'current');
  await f.DB.prepare("UPDATE users SET ownership_status='verified'").run();assert.equal(await membershipRevision(f.env),updated);
  await f.DB.prepare('UPDATE profile_members SET checked_at=unixepoch()-3601,expires=unixepoch()-1').run();assert.equal(await membershipRevision(f.env),'current');
  await f.DB.prepare('UPDATE sync SET published=NULL WHERE id=1').run();assert.equal(await membershipRevision(f.env),null);
});

test('a newly proven reused name replaces only older identity evidence and cannot resurrect the former owner',async()=>{
  const f=await fixture(),original=await f.DB.prepare('SELECT * FROM profile_members WHERE character_id=101').first(),newChecked=(original.checked_at+1)*1000;
  for(const [id,char]of [['new-owner',102],['conflict-owner',103]]){
    await f.DB.prepare("INSERT INTO users(id,subject_hash,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,'verified',?,'now','now')").bind(id,'subject-'+id,epoch()).run();
    await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(char,id,new Date().toISOString()).run();
  }
  const replacement=validateProfileMember(profile({id:102}),candidateFromAccount({id:102,name:'Test',surname:'Adventurer'}),guild,newChecked);
  await profileMemberStatement(f.env,'new-owner',replacement).run();
  assert.equal(await f.DB.prepare('SELECT * FROM profile_members WHERE character_id=101').first(),null);
  assert.deepEqual((await visible(f)).map(r=>r.character_id),[102]);
  // An older response and a same-second ambiguous identity must not overwrite it.
  await assert.rejects(profileMemberStatement(f.env,'owner',f.member).run(),/conflicting identity/);
  const sameSecond=validateProfileMember(profile({id:103}),candidateFromAccount({id:103,name:'Test',surname:'Adventurer'}),guild,newChecked);
  await assert.rejects(profileMemberStatement(f.env,'conflict-owner',sameSecond).run(),/conflicting identity/);
  assert.deepEqual((await visible(f)).map(r=>r.character_id),[102]);
  await f.DB.prepare("UPDATE users SET ownership_status='unavailable' WHERE id='new-owner'").run();
  assert.deepEqual(await visible(f),[],'Older proof cannot reappear after the new identity loses verification');
});
