import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {authRoute,requireWrite,ORIGIN,LEGACY_ORIGIN,random,digest} from '../src/auth.mjs';
import {discordAuth,discordAdmin} from '../src/discord.mjs';

const origins=[...new Set([ORIGIN,LEGACY_ORIGIN])],epoch=()=>Math.floor(Date.now()/1000);
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),now=new Date().toISOString(),token=random(),csrf=random(),sessionHash=await digest(token),userId='site-admin';
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare('INSERT INTO membership(generation,slug,character_id,data) VALUES(?,?,?,?)').bind('current','example-character',71,JSON.stringify({id:71,name:'Example Character',slug:'example-character',class:'Mage',level:20})).run();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(userId,'site-origin-fixture',71,'verified',epoch(),now,now).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(71,userId,now).run();
  await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(sessionHash,userId,csrf,epoch()+3600).run();
  const env={DB,ADMIN_USER_IDS:userId,BLIZZARD_CLIENT_ID:'fixture-client',BLIZZARD_CLIENT_SECRET:'fixture-secret',DISCORD_CLIENT_ID:'123450000000000001',DISCORD_GUILD_ID:'123450000000000002',DISCORD_CLIENT_SECRET:'fixture-discord-secret',DISCORD_BOT_TOKEN:'fixture-bot'};
  return {DB,env,token,csrf,sessionHash,userId,request(origin,path,headers={}){return new Request(origin+path,{headers:{Cookie:'__Host-wv_session='+token,...headers}});}};
}
async function battleStart(f,origin,headers={}){
  const response=await authRoute(new Request(origin+'/auth/login',{headers}),f.env),target=new URL(response.headers.get('Location'));
  return {response,target,state:target.searchParams.get('state'),binding:response.headers.get('Set-Cookie').split(';')[0]};
}
const battleCallback=(origin,start)=>new Request(origin+'/auth/callback?state='+start.state+'&code=fixture-code',{headers:{Cookie:start.binding}});
async function withProvider(run){
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({url,options});
    if(path==='/token')return Response.json({access_token:'fixture-battle-token'});
    if(path==='/userinfo')return Response.json({sub:'777',id:777});
    if(path==='/profile/user/wow')return Response.json({wow_accounts:[{characters:[{id:71}]}]});
    if(path==='/api/v10/oauth2/token')return Response.json({access_token:'fixture-discord-token',guild:{id:'123450000000000002'}});
    if(path==='/api/v10/users/@me')return Response.json({id:'345678901234567890',username:'Fixture'});
    if(path==='/api/v10/guilds/123450000000000002')return Response.json({id:'123450000000000002'});
    throw new Error('Unexpected fixture provider path: '+path);
  };
  try{return await run(calls);}finally{globalThis.fetch=original;}
}

test('both approved sites accept only their own Origin header and valid CSRF for writes',()=>{
  assert.equal(ORIGIN,'https://guild.example.com');
  for(const origin of origins){
    const write=(headerOrigin=origin,csrf='valid',type='application/json')=>new Request(origin+'/api/hall/requests',{method:'POST',headers:{Origin:headerOrigin,'X-CSRF-Token':csrf,'Content-Type':type},body:'{}'});
    assert.doesNotThrow(()=>requireWrite(write(),{csrf:'valid'}));
    assert.throws(()=>requireWrite(write(origins.find(value=>value!==origin)||'https://unconfigured-alias.example'),{csrf:'valid'}),error=>error.status===403);
    assert.throws(()=>requireWrite(write(origin,'wrong'),{csrf:'valid'}),error=>error.status===403);
    assert.throws(()=>requireWrite(write('', 'valid'),{csrf:'valid'}),error=>error.status===403);
    assert.throws(()=>requireWrite(write(origin,'valid','text/plain'),{csrf:'valid'}),error=>error.status===415);
  }
  for(const origin of ['https://foreign.example','https://www.guild.example.com','http://guild.example.com','https://guild.example.com:8443','https://guild.example.com.evil.example']){
    const request=new Request(origin+'/api/hall/requests',{method:'POST',headers:{Origin:origin,'X-CSRF-Token':'valid','Content-Type':'application/json'},body:'{}'});
    assert.throws(()=>requireWrite(request,{csrf:'valid'}),error=>error.status===403);
  }
});

test('Battle.net authorization and token redemption pin the initiating origin on both sites',async()=>{
  for(const origin of origins){
    const f=await fixture(),start=await battleStart(f,origin,{'X-Forwarded-Host':'foreign.example',Host:'foreign.example'});
    assert.equal(start.target.searchParams.get('redirect_uri'),origin+'/auth/callback');
    assert.equal((await f.DB.prepare('SELECT origin FROM oauth_states WHERE state_hash=?').bind(await digest(start.state)).first()).origin,origin);
    await withProvider(async calls=>{
      const result=await authRoute(battleCallback(origin,start),f.env);
      assert.equal(result.headers.get('Location'),'/guild#overview');
      const token=calls.find(call=>new URL(call.url).pathname==='/token');
      assert.equal(new URLSearchParams(token.options.body).get('redirect_uri'),origin+'/auth/callback');
      const cookies=result.headers.get('Set-Cookie');assert.match(cookies,/__Host-wv_session=/);assert.match(cookies,/Secure; HttpOnly; SameSite=Lax/);assert.doesNotMatch(cookies,/Domain=/i);
      const replay=await authRoute(battleCallback(origin,start),f.env);assert.match(replay.headers.get('Location'),/signin=expired/);
    });
  }
});

test('Battle.net origin mixups and foreign callbacks cannot consume another site’s pending login',async()=>{
  const f=await fixture(),start=await battleStart(f,ORIGIN);
  await withProvider(async calls=>{
    for(const origin of ['https://unconfigured-alias.example','https://foreign.example']){
      const denied=await authRoute(battleCallback(origin,start),f.env);assert.match(denied.headers.get('Location'),/signin=(expired|invalid_state)/);
      assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM oauth_states').first()).n,1);assert.equal(calls.length,0);
    }
    assert.equal((await authRoute(battleCallback(ORIGIN,start),f.env)).headers.get('Location'),'/guild#overview');
  });
});

test('origin-less Battle.net states default only to the explicitly configured fallback origin',async()=>{
  const f=await fixture(),state=random(),binding=random(),start={state,binding:'__Host-wv_login='+binding};
  await f.DB.prepare('INSERT INTO oauth_states(state_hash,binding_hash,verifier,expires) VALUES(?,?,?,?)').bind(await digest(state),await digest(binding),random(),epoch()+600).run();
  await withProvider(async calls=>{
    assert.match((await authRoute(battleCallback('https://unconfigured-alias.example',start),f.env)).headers.get('Location'),/signin=(expired|invalid_state)/);assert.equal(calls.length,0);
    assert.equal((await authRoute(battleCallback(LEGACY_ORIGIN,start),f.env)).headers.get('Location'),'/guild#overview');
    assert.equal(new URLSearchParams(calls.find(call=>new URL(call.url).pathname==='/token').options.body).get('redirect_uri'),LEGACY_ORIGIN+'/auth/callback');
  });
});

test('foreign authorization origins are rejected before any OAuth state is created',async()=>{
  const f=await fixture();
  for(const origin of ['https://foreign.example','https://www.guild.example.com','http://guild.example.com']){
    await assert.rejects(()=>authRoute(new Request(origin+'/auth/login'),f.env),error=>error.status===400);
    for(const path of ['/auth/discord/login','/auth/discord/install'])await assert.rejects(()=>discordAuth(f.request(origin,path),f.env),error=>error.status===400);
  }
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM oauth_states').first()).n,0);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_states').first()).n,0);
});

test('Discord linking and installation authorize and redeem on each initiating origin',async()=>{
  for(const origin of origins)for(const purpose of ['login','install']){
    const f=await fixture(),response=await discordAuth(f.request(origin,'/auth/discord/'+purpose,{'X-Forwarded-Host':'foreign.example'}),f.env),target=new URL(response.headers.get('Location')),state=target.searchParams.get('state');
    assert.equal(target.searchParams.get('redirect_uri'),origin+'/auth/discord/callback');
    assert.equal(target.searchParams.get('scope'),purpose==='install'?'bot identify':'identify');
    assert.equal((await f.DB.prepare('SELECT origin FROM discord_states WHERE state_hash=?').bind(await digest(state)).first()).origin,origin);
    await withProvider(async calls=>{
      const result=await discordAuth(f.request(origin,'/auth/discord/callback?state='+state+'&code=fixture-code'),f.env);
      assert.match(result.headers.get('Location'),purpose==='install'?/discord=installed/:/discord=linked/);
      const redemption=calls.find(call=>new URL(call.url).pathname==='/api/v10/oauth2/token');
      assert.equal(new URLSearchParams(redemption.options.body).get('redirect_uri'),origin+'/auth/discord/callback');
    });
  }
});

test('Discord callbacks require both the originating site and the same signed-in session',async()=>{
  const f=await fixture(),response=await discordAuth(f.request(ORIGIN,'/auth/discord/login'),f.env),state=new URL(response.headers.get('Location')).searchParams.get('state'),path='/auth/discord/callback?state='+state+'&code=fixture-code';
  const otherToken=random();await f.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await digest(otherToken),f.userId,random(),epoch()+3600).run();
  await withProvider(async calls=>{
    for(const request of [f.request('https://unconfigured-alias.example',path),f.request('https://foreign.example',path),f.request(ORIGIN,path,{Cookie:'__Host-wv_session='+otherToken})]){
      const denied=await discordAuth(request,f.env);assert.match(denied.headers.get('Location'),/discord=failed/);
      assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_states').first()).n,1);assert.equal(calls.length,0);
    }
    assert.match((await discordAuth(f.request(ORIGIN,path),f.env)).headers.get('Location'),/discord=linked/);
    assert.match((await discordAuth(f.request(ORIGIN,path),f.env)).headers.get('Location'),/discord=failed/);
  });
});

test('origin-less Discord states redeem only at the configured fallback origin and bound session',async()=>{
  const f=await fixture(),state=random(),path='/auth/discord/callback?state='+state+'&code=fixture-code';
  await f.DB.prepare('INSERT INTO discord_states(state_hash,user_id,session_hash,expires,verifier,purpose) VALUES(?,?,?,?,?,?)').bind(await digest(state),f.userId,f.sessionHash,epoch()+600,random(),'link').run();
  await withProvider(async calls=>{
    assert.match((await discordAuth(f.request('https://unconfigured-alias.example',path),f.env)).headers.get('Location'),/discord=failed/);assert.equal(calls.length,0);
    assert.match((await discordAuth(f.request(LEGACY_ORIGIN,path),f.env)).headers.get('Location'),/discord=linked/);
    const redemption=calls.find(call=>new URL(call.url).pathname==='/api/v10/oauth2/token');
    assert.equal(new URLSearchParams(redemption.options.body).get('redirect_uri'),LEGACY_ORIGIN+'/auth/discord/callback');
  });
});

test('Discord administrator callback and invite links stay on the visited approved site',async()=>{
  const f=await fixture();
  for(const origin of origins){const details=await discordAdmin(f.request(origin,'/api/admin/discord',{'X-Forwarded-Host':'foreign.example'}),f.env);assert.equal(details.callback,origin+'/auth/discord/callback');assert.equal(details.invite_url,origin+'/auth/discord/install');}
  await assert.rejects(()=>discordAdmin(f.request('https://foreign.example','/api/admin/discord'),f.env),error=>error.status===400);
});

test('Discord installation requires current guild verification even for the pinned administrator',async()=>{
  for(const revoke of ['stale','removed','unverified']){
    const f=await fixture(),started=await discordAuth(f.request(ORIGIN,'/auth/discord/install'),f.env),state=new URL(started.headers.get('Location')).searchParams.get('state');
    if(revoke==='stale')await f.DB.prepare('UPDATE users SET ownership_checked=? WHERE id=?').bind(epoch()-86401,f.userId).run();
    if(revoke==='removed')await f.DB.prepare('DELETE FROM membership WHERE character_id=71').run();
    if(revoke==='unverified')await f.DB.prepare("UPDATE users SET ownership_status='unavailable' WHERE id=?").bind(f.userId).run();
    await withProvider(async calls=>{
      await assert.rejects(()=>discordAuth(f.request(ORIGIN,'/auth/discord/install'),f.env),error=>error.status===403);
      const callback=await discordAuth(f.request(ORIGIN,'/auth/discord/callback?state='+state+'&code=fixture-code'),f.env);
      assert.match(callback.headers.get('Location'),/discord=signin/);assert.equal(calls.length,0);
      assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_states').first()).n,1,'revocation is checked before consuming OAuth state');
    });
  }
});
