import {deploymentIdentity} from '../src/config.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {authRoute,currentUser,requireMember,ORIGIN,LEGACY_ORIGIN} from '../src/auth.mjs';
import worker from '../src/worker.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){DB.queries++;return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){DB.queries++;return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){DB.queries++;return raw.prepare(this.sql).run(...this.params);}
  }
  const DB={raw,queries:0,failBatchAt:null,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(let i=0;i<statements.length;i++){if(DB.failBatchAt===i)throw Error('Synthetic atomic-write failure');results.push(await statements[i].run());}raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
  return DB;
}
const candidate={id:91,name:'New',surname:'Adventurer',slug:'new-adventurer'};
const guild={id:18,name:'Example Guild',ruleset:'EU Roleplay'};
const profile={...candidate,level:12,ruleset:{id:3},guild:{id:18,name:'Example Guild',slug:'example-guild'},character_class:{id:8,name:'Mage'},race:{id:1,name:'Human'}};
async function fixture(){
  const DB=database();await DB.prepare("UPDATE sync SET published='current',roster_at=? WHERE id=1").bind(new Date().toISOString()).run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','existing-character',71,JSON.stringify({id:71,name:'Existing Character',slug:'existing-character',level:20})).run();
  await DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify(guild)).run();
  await DB.prepare("INSERT INTO state(key,value) VALUES('deployment_identity',?)").bind(JSON.stringify(deploymentIdentity())).run();
  return {DB,env:{DB,BLIZZARD_CLIENT_ID:'fixture-client',BLIZZARD_CLIENT_SECRET:'fixture-client-secret'}};
}
async function signIn(f,{characters=[candidate],profiles=new Map([[candidate.slug,profile]]),accountStatus=200,account=null,origin=ORIGIN,query='',calls=[]}={}){
  const original=globalThis.fetch;let active=0,maxActive=0;
  globalThis.fetch=async(url,options={})=>{
    const target=new URL(url);calls.push({url:target.href,options});
    if(target.hostname==='oauth.battle.net'&&target.pathname==='/token')return Response.json({access_token:'fixture-user-token-do-not-store'});
    if(target.hostname==='oauth.battle.net'&&target.pathname==='/userinfo')return Response.json({sub:'777',id:777});
    if(target.hostname==='eu.api.blizzard.com'&&target.pathname==='/profile/user/wow')return Response.json(account??{wow_accounts:[{characters}]},{status:accountStatus});
    if(target.hostname==='eu.api.blizzard.com'&&target.pathname.startsWith('/profile/wow/character/')){
      active++;maxActive=Math.max(maxActive,active);
      try{
        await new Promise(resolve=>setTimeout(resolve,2));
        const value=profiles.get(decodeURIComponent(target.pathname.split('/').at(-1)));
        if(value instanceof Error)throw value;
        if(!value)return Response.json({error:'not published'},{status:404});
        return Response.json(value);
      }finally{active--;}
    }
    throw Error('Unexpected provider destination');
  };
  try{
    const start=await authRoute(new Request(origin+'/auth/login'),f.env),target=new URL(start.headers.get('Location'));
    const binding=start.headers.get('Set-Cookie').split(';')[0];
    const response=await authRoute(new Request(origin+'/auth/callback?state='+target.searchParams.get('state')+'&code=fixture-code'+query,{headers:{Cookie:binding}}),f.env);
    const raw=response.headers.get('Set-Cookie')?.match(/__Host-wv_session=([A-Za-z0-9_-]{43})/)?.[1];
    assert(raw,'Normal Battle.net identity should receive a session; guild access is checked separately');
    const request=(path='/guild')=>new Request(origin+path,{headers:{Cookie:'__Host-wv_session='+raw}});
    return {response,request,user:await currentUser(request(),f.env),calls,maxActive};
  }finally{globalThis.fetch=original;}
}

test('a roster-missing account-owned character gets access only after exact individual guild proof on both sites',async()=>{
  for(const origin of [ORIGIN,LEGACY_ORIGIN]){
    const f=await fixture(),result=await signIn(f,{origin});
    assert.equal(result.response.headers.get('Location'),'/guild#overview');assert.equal(result.user.verified,true);assert.equal(result.user.is_admin,false);
    assert.equal(result.user.characters.length,1);assert.equal(result.user.characters[0].id,91);assert.equal(result.user.characters[0].membership_source,'character_profile');
    assert.doesNotThrow(()=>requireMember(result.user));
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM membership WHERE character_id=91').first()).n,0,'Fallback must never manufacture a primary Blizzard roster row');
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members WHERE character_id=91').first()).n,1);
    assert.equal((await worker.fetch(result.request('/api/members'),f.env)).status,200);
    const userRow=await f.DB.prepare('SELECT * FROM users WHERE id=?').bind(result.user.id).first();
    assert.equal(userRow.main_character_id,91);assert.equal(userRow.ownership_status,'verified');
    const fields=['users','sessions','character_links','profile_members','state'].flatMap(table=>f.DB.raw.prepare('SELECT * FROM '+table).all());
    assert(!JSON.stringify(fields).includes('fixture-user-token-do-not-store'));assert(!JSON.stringify(fields).includes('fixture-client-secret'));
  }
});

test('wrong guild IDs, same-name impostors, wrong rulesets, missing guilds and mismatched character identity deny access',async()=>{
  const invalid=[
    {...profile,guild:{...profile.guild,id:19}},
    {...profile,guild:{...profile.guild,name:'Another Guild'}},
    {...profile,ruleset:{id:1}},
    {...profile,guild:undefined},
    {...profile,id:92},
    {...profile,slug:'different-character'},
    {...profile,name:'Different',surname:'Character',slug:undefined}
  ];
  for(const value of invalid){
    const f=await fixture(),result=await signIn(f,{profiles:new Map([[candidate.slug,value]])});
    assert.equal(result.user.verified,false);assert.equal(result.user.characters.length,0);
    assert.throws(()=>requireMember(result.user),error=>error.status===403);
    assert.equal((await worker.fetch(result.request('/api/members'),f.env)).status,403);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
  }
});

test('unpublished profiles and provider failures cannot admit a roster-missing account',async()=>{
  for(const value of [null,new Error('Synthetic provider failure')]){
    const f=await fixture(),result=await signIn(f,{profiles:new Map([[candidate.slug,value]])});
    assert.equal(result.user.verified,false);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
  }
});

test('account ownership is essential: profile-like callback parameters or provider hrefs do not discover arbitrary characters',async()=>{
  const f=await fixture(),result=await signIn(f,{characters:[{id:999,key:{href:'https://evil.example/profile/wow/character/new-adventurer'}}],query:'&character=new-adventurer&id=91'});
  assert.equal(result.user.verified,false);
  assert.equal(result.calls.filter(c=>new URL(c.url).pathname.startsWith('/profile/wow/character/')).length,0);
  assert(result.calls.every(c=>['oauth.battle.net','eu.api.blizzard.com'].includes(new URL(c.url).hostname)));
  const g=await fixture(),valid=await signIn(g,{characters:[{...candidate,key:{href:'https://evil.example/steal'}}]});
  assert.equal(valid.user.verified,true);assert(valid.calls.every(c=>new URL(c.url).hostname!=='evil.example'));
  assert(valid.calls.some(c=>c.url==='https://eu.api.blizzard.com/profile/wow/character/new-adventurer?namespace=profile-forever-eu&locale=en_GB'));
});

test('invalid or unavailable account summaries fail closed despite a usable individual profile',async()=>{
  for(const options of [{accountStatus:503},{account:{wow_accounts:[{characters:null}]}},{account:{wow_accounts:[]}}]){
    const f=await fixture(),result=await signIn(f,options);assert.equal(result.user.verified,false);
    assert.equal(result.calls.filter(c=>new URL(c.url).pathname.startsWith('/profile/wow/character/')).length,0);
  }
});

test('fallback requires a trusted previously verified guild identity, not merely a guild name in a character profile',async()=>{
  for(const value of [null,{...guild,id:19},{...guild,ruleset:'EU Normal'},{...guild,name:'Another Guild'}]){
    const f=await fixture();await f.DB.prepare("DELETE FROM state WHERE key='guild'").run();
    if(value)await f.DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify(value)).run();
    const result=await signIn(f);assert.equal(result.user.verified,false);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
  }
});

test('fallback expiration or ownership/link revocation blocks an already signed-in account immediately',async()=>{
  for(const revoke of ['expiry','ownership','link']){
    const f=await fixture(),result=await signIn(f);assert.equal(result.user.verified,true);
    if(revoke==='expiry')await f.DB.prepare('UPDATE profile_members SET checked_at=?,expires=? WHERE character_id=91').bind(epoch()-7200,epoch()-3600).run();
    if(revoke==='ownership')await f.DB.prepare('UPDATE users SET ownership_checked=? WHERE id=?').bind(epoch()-86410,result.user.id).run();
    if(revoke==='link')await f.DB.prepare('DELETE FROM character_links WHERE character_id=91').run();
    assert.equal((await currentUser(result.request(),f.env)).verified,false);
    assert.equal((await worker.fetch(result.request('/api/members'),f.env)).status,403);
  }
});

test('a later failed profile check at sign-in cannot extend a previous fallback proof',async()=>{
  const f=await fixture(),first=await signIn(f);assert.equal(first.user.verified,true);
  const old=await f.DB.prepare('SELECT expires FROM profile_members WHERE character_id=91').first();assert(old.expires>epoch());
  const second=await signIn(f,{profiles:new Map()});assert.equal(second.user.verified,false);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members WHERE character_id=91').first()).n,0);
  assert.equal((await currentUser(first.request(),f.env)).verified,false);
});

test('proof and character-link writes are atomic and a failed batch cannot grant access',async()=>{
  const f=await fixture();f.DB.failBatchAt=3;
  const result=await signIn(f);assert.equal(result.user.verified,false);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_links').first()).n,0);
  assert.equal((await f.DB.prepare('SELECT ownership_status FROM users WHERE id=?').bind(result.user.id).first()).ownership_status,'unavailable');
});

test('primary roster members keep their access without needing a profile fallback',async()=>{
  const f=await fixture(),result=await signIn(f,{characters:[{id:71}],profiles:new Map()});
  assert.equal(result.user.verified,true);assert.equal(result.user.characters[0].id,71);
  assert.equal(result.calls.filter(c=>new URL(c.url).pathname.startsWith('/profile/wow/character/')).length,0);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
});

test('discovery is bounded to eight profiles with two concurrent checks and rotates through accounts with many characters',async()=>{
  const f=await fixture(),characters=Array.from({length:10},(_,i)=>({id:91+i,name:'Candidate',surname:'Number'+String.fromCharCode(97+i),slug:'candidate-number'+String.fromCharCode(97+i)}));
  const profiles=new Map(characters.map((c,i)=>[c.slug,{...profile,...c,guild:i===8?profile.guild:{id:19,name:'Other Guild'}}]));
  const first=await signIn(f,{characters,profiles});assert.equal(first.user.verified,false);
  assert.equal(first.calls.filter(c=>new URL(c.url).pathname.startsWith('/profile/wow/character/')).length,8);assert(first.maxActive<=2);
  const second=await signIn(f,{characters,profiles});assert.equal(second.user.verified,true);assert.equal(second.user.characters[0].id,99);
  assert.equal(second.calls.filter(c=>new URL(c.url).pathname.startsWith('/profile/wow/character/')).length,8);assert(second.maxActive<=2);
});

test('conflicting account names for the same unknown identity do not select a profile by guesswork',async()=>{
  const f=await fixture(),result=await signIn(f,{characters:[candidate,{...candidate,name:'Other',surname:'Person',slug:'other-person'}]});
  assert.equal(result.user.verified,false);assert.equal(result.calls.filter(c=>new URL(c.url).pathname.startsWith('/profile/wow/character/')).length,0);
});

test('the existing23-character bound with eight fallback proofs stays within the free database invocation budget',async()=>{
  const f=await fixture(),known=Array.from({length:15},(_,i)=>({id:71+i}));
  for(const c of known.slice(1))await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','existing-'+c.id,c.id,JSON.stringify({id:c.id,name:'Existing Member'})).run();
  const newcomers=Array.from({length:8},(_,i)=>({id:91+i,name:'Newcomer',surname:'Number'+String.fromCharCode(97+i)}));
  const profiles=new Map(newcomers.map(c=>[('newcomer-'+c.surname).toLowerCase(),{...profile,...c,slug:('newcomer-'+c.surname).toLowerCase()}]));
  f.DB.queries=0;
  const result=await signIn(f,{characters:[...known,...newcomers],profiles});
  assert.equal(result.user.verified,true);assert.equal(result.user.characters.length,23);assert(f.DB.queries<=50,'OAuth and ownership commit should fit the free50-query invocation budget');
});
