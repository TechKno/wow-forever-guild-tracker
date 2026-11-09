import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {validateProfileMember,candidateFromAccount,profileMemberStatement,membershipRevision} from '../src/guild-membership.mjs';
import {recheckOneProfileMember} from '../src/profile-membership-refresh.mjs';
import {tick} from '../src/logic.mjs';
import {currentUser,ORIGIN,random,digest} from '../src/auth.mjs';
import worker from '../src/worker.mjs';

const epoch=()=>Math.floor(Date.now()/1000),guild={id:42,name:'Example Guild',ruleset:'EU Roleplay'};
const account={id:101,name:'New',surname:'Adventurer'};
const profile=(overrides={})=>({id:101,name:'New',surname:'Adventurer',slug:'new-adventurer',ruleset:{id:3},guild:{id:42,name:'Example Guild'},level:12,character_class:{id:8,name:'Mage'},race:{name:'Human'},...overrides});
function database(){
  const raw=new DatabaseSync(':memory:'),DB={raw,afterMembersRead:null};
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){const results=raw.prepare(this.sql).all(...this.params);if(DB.afterMembersRead&&this.sql.startsWith('SELECT m.data roster,c.data details FROM verified_membership m LEFT JOIN characters')){const hook=DB.afterMembersRead;DB.afterMembersRead=null;await hook();}return {results};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  DB.prepare=sql=>new Statement(sql);
  DB.batch=async statements=>{raw.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}};
  return DB;
}
async function fixture({proofAgo=1800}={}){
  const DB=database(),now=new Date().toISOString(),env={DB,BLIZZARD_CLIENT_ID:'profile-proof-'+crypto.randomUUID(),BLIZZARD_CLIENT_SECRET:'synthetic-secret',ASSETS:{async fetch(){return new Response('PRIVATE GUILDHALL');}}};
  await DB.prepare("UPDATE sync SET published='current',generation='current',next_at=?,roster_at=?,updated=? WHERE id=1").bind(epoch()+3600,now,now).run();
  await DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify(guild)).run();
  const rawMember={id:201,name:'Roster Anchor',slug:'roster-anchor',class:'Mage',class_id:8,race:'Human',level:15,rank:1,roster_observed:now};
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',rawMember.slug,rawMember.id,JSON.stringify(rawMember)).run();
  async function user(id,characterId){
    const token=random();await DB.prepare("INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,'verified',?,?,?)").bind(id,'subject-'+id,characterId,epoch(),now,now).run();
    if(characterId)await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(characterId,id,now).run();
    await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,random(),epoch()+7200).run();
    return {id,request(path){return new Request(ORIGIN+path,{headers:{Cookie:'__Host-wv_session='+token}});}};
  }
  const owner=await user('fallback-owner',101),reader=await user('roster-reader',201);
  const member=validateProfileMember(profile(),candidateFromAccount(account),guild,Date.now()-proofAgo*1000);
  await profileMemberStatement(env,owner.id,member).run();
  await DB.prepare('UPDATE profile_members SET next_at=0').run();
  return {DB,env,owner,reader,rawMember,user,member,proof:()=>DB.prepare('SELECT * FROM profile_members WHERE character_id=101').first()};
}
async function withProvider(f,options,run){
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/token')return Response.json({access_token:'synthetic-token',expires_in:3600});
    if(path==='/profile/wow/character/new-adventurer'){
      await options.beforeProfile?.();
      if(options.networkError)throw Error('Synthetic network failure');
      return options.status?Response.json({error:'unavailable'},{status:options.status}):Response.json(options.profile||profile());
    }
    if(options.allowAnchor&&path==='/profile/wow/character/roster-anchor')return Response.json({id:201,name:'Roster',surname:'Anchor',ruleset:{id:3},level:16});
    if(options.allowAnchor&&['/profile/wow/character/roster-anchor/professions','/profile/wow/character/roster-anchor/specializations'].includes(path))return Response.json({error:'not published'},{status:404});
    throw Error('Unexpected provider request '+path);
  };
  try{return await run(calls);}finally{globalThis.fetch=original;}
}
const expire=f=>f.DB.prepare('UPDATE profile_members SET checked_at=unixepoch()-3601,expires=unixepoch()-1').run();

test('periodic revalidation renews a fresh owned proof and schedules profile enrichment',async()=>{
  const f=await fixture(),before=await f.proof();
  await withProvider(f,{},async calls=>{
    assert.equal((await recheckOneProfileMember(f.env)).result,'membership_refreshed');
    assert.equal(calls.filter(p=>p==='/profile/wow/character/new-adventurer').length,1);
  });
  const after=await f.proof();assert(after.checked_at>before.checked_at);assert(after.expires>before.expires);assert.equal(after.expires-after.checked_at,3600);assert.equal(after.next_at-after.checked_at,900);assert.equal(after.last_error,null);
  assert(await f.DB.prepare('SELECT character_id FROM character_refresh WHERE character_id=101').first());
  assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,true);
});

test('a validated nonmember, wrong ruleset or changed character identity immediately revokes fallback access',async()=>{
  for(const response of [profile({guild:undefined}),profile({guild:{id:99,name:'Another Guild'}}),profile({ruleset:{id:1}}),profile({id:999})]){
    const f=await fixture();assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,true);
    await withProvider(f,{profile:response},async()=>assert.equal((await recheckOneProfileMember(f.env)).result,'membership_unverified'));
    assert.equal(await f.proof(),null);assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,false);
    const denied=await worker.fetch(f.owner.request('/api/members'),f.env);assert.equal(denied.status,403);assert.equal((await denied.json()).access_required,true);
  }
});

test('404 and network failures retain the original fixed expiry without extending proof or account ownership',async()=>{
  for(const options of [{status:404},{networkError:true}]){
    const f=await fixture(),before=await f.proof(),userBefore=await f.DB.prepare('SELECT ownership_checked FROM users WHERE id=?').bind(f.owner.id).first();
    await withProvider(f,options,async()=>assert.equal((await recheckOneProfileMember(f.env)).result,'membership_check_unavailable'));
    const after=await f.proof();assert.equal(after.expires,before.expires);assert.equal(after.checked_at,before.checked_at);assert.equal(after.data,before.data);assert(after.next_at>=epoch()+299);
    assert.equal((await f.DB.prepare('SELECT ownership_checked FROM users WHERE id=?').bind(f.owner.id).first()).ownership_checked,userBefore.ownership_checked);
    await expire(f);assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,false);
  }
});

test('expired proofs recover through direct proof-table scanning while account ownership remains verified',async()=>{
  const f=await fixture({proofAgo:3700});assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,false);
  await withProvider(f,{},async()=>assert.equal((await recheckOneProfileMember(f.env)).result,'membership_refreshed'));
  assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,true);
});

test('stale account ownership and conflicting links cannot renew a proof or reach Blizzard',async()=>{
  for(const mutate of [async f=>f.DB.prepare('UPDATE users SET ownership_checked=? WHERE id=?').bind(epoch()-86401,f.owner.id).run(),async f=>f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=101').bind(f.reader.id).run()]){
    const f=await fixture();await mutate(f);
    await withProvider(f,{},async calls=>{assert.equal((await recheckOneProfileMember(f.env)).result,'membership_unverified');assert.deepEqual(calls,[]);});
    assert.equal(await f.proof(),null);assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,false);
  }
});

test('primary roster catch-up removes the supplemental proof while preserving ordinary membership and access',async()=>{
  const f=await fixture();await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','new-adventurer',101,JSON.stringify({id:101,name:'New Adventurer',slug:'new-adventurer',level:12,rank:3})).run();
  await withProvider(f,{},async calls=>{assert.equal((await recheckOneProfileMember(f.env)).result,'membership_in_roster');assert.deepEqual(calls,[]);});
  assert.equal(await f.proof(),null);assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,true);
  assert.equal((await membershipRevision(f.env)),'current');
});

test('raw roster publication preserves the fallback proof, refresh queue and verified view without a false departure',async()=>{
  const f=await fixture();await f.DB.prepare('INSERT INTO character_refresh(character_id,next_at) VALUES(101,?)').bind(epoch()+900).run();
  await f.DB.prepare("INSERT INTO state(key,value) VALUES('staging',?)").bind(JSON.stringify({members:[f.rawMember],guild,generation:'next',fetched_at:new Date().toISOString()})).run();
  await f.DB.prepare("UPDATE sync SET phase='stage',generation='next',cursor=0,total=1,next_at=0 WHERE id=1").run();
  await withProvider(f,{},async()=>tick(f.env));
  assert.equal((await f.DB.prepare('SELECT published FROM sync WHERE id=1').first()).published,'next');
  assert(await f.proof());assert(await f.DB.prepare('SELECT character_id FROM character_refresh WHERE character_id=101').first());
  assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM verified_membership WHERE generation='next'").first()).count,2);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM membership WHERE generation='next' AND character_id=101").first()).count,0);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) count FROM activity WHERE character_id=101 AND kind='left'").first()).count,0);
});

test('due fallback proofs cannot starve an ordinary character job on consecutive cron invocations',async()=>{
  const f=await fixture(),before=await f.proof();
  await f.DB.prepare("INSERT INTO state(key,value) VALUES('profile_membership_last_check',?)").bind(String(epoch()-60)).run();
  await f.DB.prepare('INSERT INTO character_refresh(character_id,next_at) VALUES(101,?)').bind(epoch()+900).run();
  await f.DB.prepare('INSERT INTO character_refresh(character_id,next_at) VALUES(201,0)').run();
  await withProvider(f,{allowAnchor:true},async calls=>{
    const result=await tick(f.env);assert.equal(result.member,'Roster Anchor');
    assert(calls.includes('/profile/wow/character/roster-anchor'));
    assert(!calls.includes('/profile/wow/character/new-adventurer'),'This cron must leave the still-due proof for its next turn');
  });
  const after=await f.proof();assert.equal(after.next_at,0);assert.equal(after.expires,before.expires);
  const details=JSON.parse((await f.DB.prepare('SELECT data FROM characters WHERE id=201').first()).data);
  assert.equal(details.profile.level,16);assert.equal(details.profile_status,'verified');
});

test('an older periodic response cannot overwrite or revoke a proof belonging to a newly verified owner',async()=>{
  for(const returned of [profile(),profile({guild:undefined})]){
    const f=await fixture(),newOwner=await f.user('new-owner',null);let newest;
    await withProvider(f,{profile:returned,beforeProfile:async()=>{
      await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=101').bind(newOwner.id).run();
      const member=validateProfileMember(profile({level:13}),candidateFromAccount(account),guild);
      await profileMemberStatement(f.env,newOwner.id,member).run();newest=await f.proof();
    }},async()=>assert.equal((await recheckOneProfileMember(f.env)).result,'membership_changed'));
    assert.equal((await f.proof()).user_id,newOwner.id);assert.equal((await f.proof()).data,newest.data);
    assert.equal((await currentUser(newOwner.request('/guild'),f.env)).verified,true);assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,false);
  }
});

test('the exact proof snapshot protects newer same-owner sign-in data even within the same checked-at second',async()=>{
  const f=await fixture({proofAgo:0}),before=await f.proof();let newest;
  await withProvider(f,{beforeProfile:async()=>{const member=validateProfileMember(profile({level:13}),candidateFromAccount(account),guild,before.checked_at*1000);await profileMemberStatement(f.env,f.owner.id,member).run();newest=await f.proof();}},async()=>assert.equal((await recheckOneProfileMember(f.env)).result,'membership_changed'));
  assert.equal((await f.proof()).checked_at,before.checked_at);assert.equal((await f.proof()).data,newest.data);assert.equal(JSON.parse((await f.proof()).data).level,13);
});

test('losing the ownership link during a pending profile request cannot resurrect access',async()=>{
  const f=await fixture(),before=await f.proof();
  await withProvider(f,{beforeProfile:async()=>f.DB.prepare('DELETE FROM character_links WHERE character_id=101').run()},async()=>assert.equal((await recheckOneProfileMember(f.env)).result,'membership_changed'));
  assert.equal((await f.proof()).expires,before.expires);assert.equal((await currentUser(f.owner.request('/guild'),f.env)).verified,false);
});

test('an in-flight normal profile job cannot revoke a newer sign-in proof',async()=>{
  const f=await fixture({proofAgo:0}),newOwner=await f.user('new-owner',null);let newest;
  await f.DB.prepare('UPDATE profile_members SET next_at=?').bind(epoch()+600).run();
  await f.DB.prepare('INSERT INTO character_refresh(character_id,next_at) VALUES(101,0)').run();
  await withProvider(f,{profile:profile({guild:undefined}),beforeProfile:async()=>{
    await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=101').bind(newOwner.id).run();
    await profileMemberStatement(f.env,newOwner.id,validateProfileMember(profile({level:13}),candidateFromAccount(account),guild)).run();
    newest=await f.proof();
  }},async()=>tick(f.env));
  assert(await f.proof(),'The old response must not remove the newer sign-in proof');
  assert.equal((await f.proof()).user_id,newOwner.id);assert.equal((await f.proof()).data,newest.data);
  assert.equal((await currentUser(newOwner.request('/guild'),f.env)).verified,true);
});

test('member pagination detects a supplemental expiry between pages and the public count separates proof sources',async()=>{
  const f=await fixture();
  for(let i=0;i<24;i++)await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','roster-'+String(i).padStart(3,'0'),202+i,JSON.stringify({id:202+i,name:'Roster '+i,slug:'roster-'+String(i).padStart(3,'0')})).run();
  const status=await(await worker.fetch(f.reader.request('/api/status'),f.env)).json(),revision=status.sync.membership_revision;
  const first=await(await worker.fetch(f.reader.request('/api/members?generation=current&revision='+encodeURIComponent(revision)),f.env)).json();assert.equal(first.members.length,25);assert.equal(first.next,25);assert.equal(first.revision,revision);
  const publicCount=await(await worker.fetch(new Request(ORIGIN+'/api/public'),f.env)).json();assert.equal(publicCount.member_count,26);assert.equal(publicCount.roster_member_count,25);assert.equal(publicCount.profile_verified_count,1);assert(!JSON.stringify(publicCount).includes('Adventurer'));
  await expire(f);const next=await worker.fetch(f.reader.request('/api/members?generation=current&cursor=25&revision='+encodeURIComponent(revision)),f.env);assert.equal(next.status,409);
  const expiredCount=await(await worker.fetch(new Request(ORIGIN+'/api/public'),f.env)).json();assert.equal(expiredCount.member_count,25);assert.equal(expiredCount.profile_verified_count,0);
});

test('a supplemental expiry during a page read returns conflict instead of releasing a mixed snapshot',async()=>{
  const f=await fixture(),revision=await membershipRevision(f.env);f.DB.afterMembersRead=()=>expire(f);
  const r=await worker.fetch(f.reader.request('/api/members?generation=current&revision='+encodeURIComponent(revision)),f.env);
  assert.equal(r.status,409);const value=await r.json();assert(!Object.hasOwn(value,'members'));
});
