import {deploymentIdentity} from '../src/config.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {credentialSaveStatement,decryptAccountCredential} from '../src/account-credentials.mjs';
import {refreshOneAccount,accountSyncView} from '../src/account-refresh.mjs';
import {authRoute,currentUser,ORIGIN,random,digest} from '../src/auth.mjs';
import {memberDirectory} from '../src/discord-people.mjs';
import {rosterDisplayGroups} from '../src/player-groups.mjs';

const epoch=()=>Math.floor(Date.now()/1000),TOKEN='synthetic-private-user-token',REFRESH='synthetic-refresh-token-never-retained';
function database(){
  const raw=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url),queries=[];
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(name,directory),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){queries.push(this.sql);return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){queries.push(this.sql);return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){queries.push(this.sql);return raw.prepare(this.sql).run(...this.params);}
  }
  const DB={raw,queries,beforeBatch:null,failBatchAt:null,prepare:sql=>new Statement(sql),async batch(statements){if(DB.beforeBatch){const change=DB.beforeBatch;DB.beforeBatch=null;await change();}raw.exec('BEGIN');try{const results=[];for(let n=0;n<statements.length;n++){if(DB.failBatchAt===n)throw Error('Synthetic transaction failure');results.push(await statements[n].run());}raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};return DB;
}
const character=id=>({id,name:'Fixture',surname:'Character'+String.fromCharCode(65+id-101)});
const account=ids=>({wow_accounts:[{id:1,characters:ids.filter((_,n)=>n%2===0).map(character)},{id:2,characters:ids.filter((_,n)=>n%2===1).map(character)}]});
async function fixture({save=true,queued=true}={}){
  const DB=database(),created=new Date().toISOString(),old=new Date(Date.now()-60000).toISOString(),user={id:'owner-a',subject_hash:'synthetic-owner-hash',main_character_id:101,ownership_status:'verified',ownership_checked:epoch()-60,updated_at:old};
  const env={DB,BLIZZARD_CLIENT_ID:'synthetic-account-client',BLIZZARD_CLIENT_SECRET:'synthetic-client-secret'},token=random(),csrf=random();
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();await DB.prepare("INSERT INTO state VALUES('guild',?)").bind(JSON.stringify({id:18,name:'Example Guild',ruleset:'EU Roleplay'})).run();
  await DB.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').bind(user.id,user.subject_hash,user.main_character_id,user.ownership_status,user.ownership_checked,old,user.updated_at).run();
  for(const id of [101,102,103,104]){const c=character(id);await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',(c.name+'-'+c.surname).toLowerCase(),id,JSON.stringify({...c,name:c.name+' '+c.surname,slug:(c.name+'-'+c.surname).toLowerCase(),class:'Mage',level:10})).run();}
  for(const id of [101,102])await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?)').bind(id,user.id,old,0).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),user.id,csrf,epoch()+7200).run();
  if(save){const statement=await credentialSaveStatement(env,user,{access_token:TOKEN,expires_in:3600,refresh_token:REFRESH},created);assert(statement);await statement.run();if(queued)await DB.prepare("UPDATE account_refresh SET next_at=0,requested_revision='roster-arrival-one'").run();}
  await DB.prepare("INSERT INTO state VALUES('deployment_identity',?)").bind(JSON.stringify(deploymentIdentity())).run();
  DB.queries.length=0;return {DB,env,user,created,old,token,csrf};
}
const grant=f=>f.DB.prepare('SELECT * FROM account_refresh WHERE user_id=?').bind(f.user.id).first();
const owners=f=>f.DB.raw.prepare('SELECT * FROM character_links ORDER BY character_id').all();
const ownership=f=>({users:f.DB.raw.prepare('SELECT * FROM users ORDER BY id').all(),links:owners(f),profiles:f.DB.raw.prepare('SELECT * FROM profile_members ORDER BY character_id').all()});
async function withProvider(f,run){
  const original=globalThis.fetch,state={calls:[],response:account([101,102,103,104]),status:200,headers:{},error:null,delay:null,profiles:new Map()};
  globalThis.fetch=async(input,options)=>{
    const url=new URL(input);state.calls.push(url.pathname);assert.equal(url.origin,'https://eu.api.blizzard.com');assert.equal(url.searchParams.get('namespace'),'profile-forever-eu');assert.equal(url.searchParams.get('locale'),'en_GB');assert.equal(options.headers.Authorization,'Bearer '+TOKEN);assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
    state.onCall?.();if(state.delay)await state.delay;if(state.error)throw state.error;
    if(url.pathname==='/profile/user/wow')return Response.json(state.response,{status:state.status,headers:state.headers});
    if(url.pathname.startsWith('/profile/wow/character/')){const value=state.profiles.get(decodeURIComponent(url.pathname.split('/').at(-1)));return Response.json(value||{error:'Not found'},{status:value?200:404});}
    assert.fail('Unexpected provider endpoint');
  };
  try{return await run(state);}finally{globalThis.fetch=original;}
}
async function due(f){await f.DB.prepare('UPDATE account_refresh SET next_at=0,lease_until=0,lease_token=NULL').run();}
function noSecrets(f,result){
  const rows=f.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().flatMap(({name})=>f.DB.raw.prepare('SELECT * FROM '+name).all()),text=JSON.stringify({rows,result});
  assert(!text.includes(TOKEN));assert(!text.includes(REFRESH));assert(!text.includes(f.env.BLIZZARD_CLIENT_SECRET));assert.equal(f.DB.raw.prepare('SELECT COUNT(*) n FROM account_refresh_guards').get().n,0);
}

test('identity recovery only records details for the matching account and does not count a new sign-in',async()=>{
  const id='123456789012345678901234';
  for(const [matches,knownId] of [[true,null],[true,id],[false,null]]){
    const f=await fixture({save:false});
    f.user.subject_hash=await digest('https://oauth.battle.net|'+(matches?id:'987654321'));
    await f.DB.prepare('UPDATE users SET subject_hash=? WHERE id=?').bind(f.user.subject_hash,f.user.id).run();
    const grant=await credentialSaveStatement(f.env,f.user,{access_token:TOKEN,expires_in:3600},f.created);
    await grant.run();
    await f.DB.prepare('INSERT INTO site_battlenet_identities(user_id,account_id,recovery_pending) VALUES(?,?,1)').bind(f.user.id,knownId).run();
    const original=globalThis.fetch;
    globalThis.fetch=async(url,options)=>{
      assert.equal(String(url),'https://oauth.battle.net/userinfo');
      assert.equal(options.headers.Authorization,'Bearer '+TOKEN);
      return Response.json({sub:id,battletag:'Demo#1234'});
    };
    try{
      await refreshOneAccount(f.env);
      const identity=await f.DB.prepare('SELECT account_id,battle_tag,recovery_pending FROM site_battlenet_identities WHERE user_id=?').bind(f.user.id).first();
      assert.equal(identity.account_id,matches?id:null);
      assert.equal(identity.battle_tag,matches?'Demo#1234':null);
      assert.equal(identity.recovery_pending,0);
      assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM site_sign_in_history').first()).count,0);
    }finally{globalThis.fetch=original;f.DB.raw.close();}
  }
});

test('saved user authorization is randomized authenticated ciphertext bound to owner, subject, client, origin context and expiry',async()=>{
  const f=await fixture(),first=await grant(f);assert.equal(await decryptAccountCredential(f.env,f.user,first),TOKEN);noSecrets(f,{});
  const second=await credentialSaveStatement(f.env,f.user,{access_token:TOKEN,expires_in:3600,refresh_token:REFRESH},f.created);await second.run();assert.notEqual((await grant(f)).encrypted_credential,first.encrypted_credential);
  for(const [env,user,row]of [[f.env,{...f.user,id:'someone-else'},first],[f.env,{...f.user,subject_hash:'other-subject'},first],[{...f.env,BLIZZARD_CLIENT_ID:'other-client'},f.user,first],[{...f.env,BLIZZARD_CLIENT_SECRET:'rotated-secret'},f.user,first],[f.env,f.user,{...first,expires_at:first.expires_at+1}],[f.env,f.user,{...first,encrypted_credential:'{"v":1,"iv":"bad","body":"bad"}'}]])await assert.rejects(decryptAccountCredential(env,user,row),/authorization is unavailable/);
});

test('credential lifetime uses provider expiry with sixty-second skew and a twenty-four-hour cap, and malformed grants are never retained',async()=>{
  const f=await fixture({save:false}),issued=Math.floor(Date.parse(f.created)/1000);
  for(const [expires_in,lifetime]of [[3600,3540],[172800,86400]]){const statement=await credentialSaveStatement(f.env,f.user,{access_token:TOKEN,expires_in},f.created);await statement.run();assert.equal((await grant(f)).expires_at,issued+lifetime);}
  const before=await grant(f);for(const expires_in of [undefined,null,0,-1,NaN,Infinity,'3600',30])assert.equal(await credentialSaveStatement(f.env,f.user,{access_token:TOKEN,expires_in},f.created),null);
  assert.equal(await credentialSaveStatement(f.env,f.user,{access_token:'',expires_in:3600},f.created),null);assert.equal(await credentialSaveStatement(f.env,f.user,{access_token:'x'.repeat(9000),expires_in:3600},f.created),null);assert.deepEqual(await grant(f),before);
});

test('one automatic account check discovers third and fourth roster characters from all licenses and leaves one main with three alts',async()=>{
  const f=await fixture();await f.DB.prepare('UPDATE character_links SET show_as_alt=1 WHERE character_id=102').run();
  await withProvider(f,async state=>{
    const result=await refreshOneAccount(f.env);assert.deepEqual(result,{processed:true,status:'active',owned_count:4});assert.deepEqual(state.calls,['/profile/user/wow']);assert.deepEqual(owners(f).map(row=>row.character_id),[101,102,103,104]);
    const people=await memberDirectory(f.env,{id:f.user.id}),person=people.find(person=>person.characters.some(character=>character.id===101));assert.equal(person.characters.length,4);assert.equal(person.characters.filter(character=>character.is_main).length,1);assert.equal(person.characters.filter(character=>character.is_alt).length,3);assert.deepEqual(rosterDisplayGroups([person])[0].character_ids,[101,102,103,104]);
    assert.equal(f.DB.raw.prepare('SELECT COUNT(*) n FROM admin_discord_mappings').get().n,0);assert.equal(f.DB.raw.prepare('SELECT main_character_id FROM users WHERE id=?').get(f.user.id).main_character_id,101);
    const saved=await grant(f);assert(saved.checked_at>f.old);assert(saved.next_at>=epoch()+898);assert.equal(saved.lease_token,null);await refreshOneAccount(f.env);assert.equal(state.calls.length,1);noSecrets(f,result);
  });
});
test('automatic checks run only for a newly requested unmatched-roster revision and never poll an already checked account routinely',async()=>{
  const f=await fixture({queued:false});
  await withProvider(f,async state=>{
    assert.deepEqual(await refreshOneAccount(f.env),{processed:false});assert.equal(state.calls.length,0);assert.equal((await accountSyncView(f.env,f.user)).next_check_at,null);
    await f.DB.prepare("UPDATE account_refresh SET requested_revision='new-arrival',next_at=0").run();assert.equal((await refreshOneAccount(f.env)).status,'active');assert.equal((await grant(f)).checked_revision,'new-arrival');
    await due(f);assert.deepEqual(await refreshOneAccount(f.env),{processed:false});assert.equal(state.calls.length,1);
    await f.DB.prepare("UPDATE account_refresh SET requested_revision='another-new-arrival',next_at=0").run();assert.equal((await refreshOneAccount(f.env)).status,'active');assert.equal(state.calls.length,2);
  });
});

test('automatic synchronization preserves explicit separate-character choices and bounds profile discovery to two authenticated candidates',async()=>{
  const f=await fixture(),extras=[105,106,107].map(character);
  await withProvider(f,async state=>{
    state.response={wow_accounts:[{characters:[character(101),character(102),...extras]}]};
    for(const c of extras)state.profiles.set((c.name+'-'+c.surname).toLowerCase(),{...c,ruleset:{id:3},guild:{id:18,name:'Example Guild'},character_class:{id:8,name:'Mage'},level:12});
    const result=await refreshOneAccount(f.env);assert.equal(result.status,'active');assert.equal(state.calls.filter(path=>path.startsWith('/profile/wow/character/')).length,2);assert.equal(owners(f).find(row=>row.character_id===102).show_as_alt,0);assert(!owners(f).some(row=>row.character_id===107));assert.equal(f.DB.raw.prepare('SELECT COUNT(*) n FROM profile_members').get().n,2);assert(f.DB.queries.length<30,'A bounded check should use a fixed small database budget');noSecrets(f,result);
  });
});

test('malformed, network and server failures retain all ownership state and original check time without extending verification',async()=>{
  for(const failure of ['malformed','network',500]){
    const f=await fixture(),before=ownership(f),checked=(await grant(f)).checked_at;
    await withProvider(f,async state=>{
      if(failure==='malformed')state.response={wow_accounts:'not-an-account-list'};else if(failure==='network')state.error=Error('Sensitive upstream '+TOKEN);else state.status=failure;
      const result=await refreshOneAccount(f.env);assert.equal(result.status,'unavailable');assert.deepEqual(ownership(f),before);const row=await grant(f);assert.equal(row.checked_at,checked);assert.equal(row.status,'unavailable');assert(row.encrypted_credential);assert(row.next_at>=epoch()+298);noSecrets(f,result);
    });
  }
});

test('revoked or forbidden provider authorization is discarded without changing or extending existing ownership',async()=>{
  for(const status of [401,403]){
    const f=await fixture(),before=ownership(f);
    await withProvider(f,async state=>{state.status=status;const result=await refreshOneAccount(f.env);assert.equal(result.status,'reconnect_required');assert.equal((await grant(f)).encrypted_credential,null);assert.deepEqual(owners(f),before.links);const user=f.DB.raw.prepare('SELECT * FROM users WHERE id=?').get(f.user.id);assert.equal(user.ownership_checked,before.users[0].ownership_checked);assert.equal(user.ownership_status,'unavailable');assert.equal(user.updated_at,before.users[0].updated_at);assert.equal((await currentUser(new Request(ORIGIN+'/api/me',{headers:{Cookie:'__Host-wv_session='+f.token}}),f.env)).verified,false);await refreshOneAccount(f.env);assert.equal(state.calls.length,1);noSecrets(f,result);});
  }
});

test('a provider 429 preserves credentials and ownership and pauses subsequent checks globally until retry time',async()=>{
  const f=await fixture(),before=ownership(f);
  await withProvider(f,async state=>{
    state.status=429;state.headers={'Retry-After':'125'};const result=await refreshOneAccount(f.env);assert.equal(result.status,'unavailable');assert.deepEqual(ownership(f),before);assert((await grant(f)).encrypted_credential);assert((await grant(f)).next_at>=epoch()+123);
    const pause=JSON.parse(f.DB.raw.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").get().value);assert(pause>=epoch()+123);assert.deepEqual(await refreshOneAccount(f.env),{processed:false,status:'paused'});assert.equal(state.calls.length,1);noSecrets(f,result);
  });
});

test('expired, sessionless and undecryptable credentials never cause a provider request',async()=>{
  for(const [reason,change]of [['expired',async f=>f.DB.prepare('UPDATE account_refresh SET expires_at=?').bind(epoch()-1).run()],['sessionless',async f=>f.DB.prepare('DELETE FROM sessions').run()],['decrypt',async f=>{f.env.BLIZZARD_CLIENT_SECRET='rotated-secret';}]]){
    const f=await fixture(),before=ownership(f);await change(f);
    await withProvider(f,async state=>{await refreshOneAccount(f.env);assert.equal(state.calls.length,0);assert.equal((await grant(f)).encrypted_credential,null);if(reason==='decrypt'){assert.deepEqual(owners(f),before.links);assert.equal(f.DB.raw.prepare('SELECT ownership_status FROM users WHERE id=?').get(f.user.id).ownership_status,'unavailable');assert.equal(f.DB.raw.prepare('SELECT ownership_checked FROM users WHERE id=?').get(f.user.id).ownership_checked,before.users[0].ownership_checked);}else assert.deepEqual(ownership(f),before);noSecrets(f,{});});
  }
});

test('the transactional guard rejects logout, replaced grants and concurrent main/alt edits without undoing newer state',async()=>{
  for(const reason of ['logout','replacement','preferences','session-expired','lease-superseded','new-arrival']){
    const f=await fixture(),before=ownership(f);let replacement;
    f.DB.beforeBatch=async()=>{
      if(reason==='logout')await f.DB.prepare('DELETE FROM account_refresh WHERE user_id=?').bind(f.user.id).run();
      if(reason==='replacement'){const save=await credentialSaveStatement(f.env,f.user,{access_token:'new-private-token',expires_in:3600},new Date().toISOString());await save.run();replacement=(await grant(f)).encrypted_credential;}
      if(reason==='preferences'){await f.DB.prepare('UPDATE users SET main_character_id=104,updated_at=? WHERE id=?').bind(new Date(Date.now()+1).toISOString(),f.user.id).run();await f.DB.prepare('UPDATE character_links SET show_as_alt=1 WHERE character_id=102').run();}
      if(reason==='session-expired')await f.DB.prepare('UPDATE sessions SET expires=?').bind(epoch()-1).run();
      if(reason==='lease-superseded')await f.DB.prepare('UPDATE account_refresh SET lease_token=?').bind('new-lease').run();
      if(reason==='new-arrival')await f.DB.prepare("UPDATE account_refresh SET requested_revision='newer-arrival'").run();
    };
    await withProvider(f,async()=>{
      const result=await refreshOneAccount(f.env);assert.equal(result.status,'superseded');assert.deepEqual(owners(f).map(row=>row.character_id),[101,102]);assert.equal(f.DB.raw.prepare('SELECT ownership_checked FROM users WHERE id=?').get(f.user.id).ownership_checked,before.users[0].ownership_checked);
      if(reason==='preferences'){assert.equal(f.DB.raw.prepare('SELECT main_character_id FROM users WHERE id=?').get(f.user.id).main_character_id,104);assert.equal(owners(f).find(row=>row.character_id===102).show_as_alt,1);}else assert.deepEqual(ownership(f),before);
      if(reason==='logout')assert.equal(await grant(f),null);if(reason==='replacement')assert.equal((await grant(f)).encrypted_credential,replacement);noSecrets(f,result);
    });
  }
});
test('a permanent failure from a replaced token cannot revoke the fresh login or clear its newer credential',async()=>{
  const f=await fixture();let replacement;
  f.DB.beforeBatch=async()=>{const save=await credentialSaveStatement(f.env,f.user,{access_token:'new-login-token',expires_in:3600},new Date().toISOString());await save.run();replacement=(await grant(f)).encrypted_credential;};
  await withProvider(f,async state=>{state.status=401;const result=await refreshOneAccount(f.env);assert.equal(result.status,'superseded');assert.equal((await grant(f)).encrypted_credential,replacement);assert.equal(f.DB.raw.prepare('SELECT ownership_status FROM users WHERE id=?').get(f.user.id).ownership_status,'verified');noSecrets(f,result);});
});

test('a database failure after the guard rolls back all ownership mutations and leaves no guard credential behind',async()=>{
  const f=await fixture(),before=ownership(f);f.DB.failBatchAt=3;
  await withProvider(f,async()=>{const result=await refreshOneAccount(f.env);assert.equal(result.status,'unavailable');assert.deepEqual(ownership(f),before);assert((await grant(f)).encrypted_credential);noSecrets(f,result);});
});

test('a lease prevents concurrent refreshes of the same grant while the account provider is pending',async()=>{
  const f=await fixture();let release,observed;const delay=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{observed=resolve;});
  await withProvider(f,async state=>{state.delay=delay;state.onCall=observed;const first=refreshOneAccount(f.env);await started;try{assert.equal(state.calls.length,1);assert.deepEqual(await refreshOneAccount(f.env),{processed:false});}finally{release();}assert.equal((await first).status,'active');assert.equal(state.calls.length,1);});
});

test('account sync view exposes only safe metadata and falls back to the previous verified ownership check for reconnects',async()=>{
  const f=await fixture();let view=await accountSyncView(f.env,f.user);assert.deepEqual(Object.keys(view).sort(),['status','checked_at','next_check_at','expires_at'].sort());assert.equal(view.status,'active');
  await f.DB.prepare("INSERT INTO state VALUES('blizzard_cooldown',?)").bind(String(epoch()+1200)).run();view=await accountSyncView(f.env,f.user);assert.equal(view.status,'paused');assert(Date.parse(view.next_check_at)>=Date.now()+1190000);
  await f.DB.prepare('DELETE FROM account_refresh').run();view=await accountSyncView(f.env,f.user);assert.equal(view.status,'reconnect_required');assert.equal(view.checked_at,new Date(f.user.ownership_checked*1000).toISOString());assert.equal(view.next_check_at,null);assert.equal(view.expires_at,null);noSecrets(f,view);
});

test('the actual logout route deletes its saved automatic-check credential as well as the authenticated session',async()=>{
  const f=await fixture(),response=await authRoute(new Request(ORIGIN+'/auth/logout',{method:'POST',headers:{Cookie:'__Host-wv_session='+f.token,Origin:ORIGIN,'X-CSRF-Token':f.csrf,'Content-Type':'application/json'},body:'{}'}),f.env);
  assert.equal(response.status,200);assert.equal(await grant(f),null);assert.equal(f.DB.raw.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);noSecrets(f,await response.json());
});
