import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {flushDiscord} from '../src/discord.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
const APP='111111111111111111',GUILD='222222222222222222',CHANNEL='333333333333333333';
const IDS={a:'444444444444444444',b:'555555555555555555',c:'666666666666666666'};
const recipe={id:100,name:'Fine Widget',verified:true,output:{id:500,value:1},reagents:[{id:2,name:'Copper Bar',quantity:3}]};
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
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),now=new Date().toISOString();await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(const [id,name]of [[101,'Alice Longsurname'],[102,'Bob Craftsurname'],[103,'Charlie Example']]){
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',name.toLowerCase().replaceAll(' ','-'),id,JSON.stringify({id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:'Mage',class_id:8,level:20})).run();
    await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(id,JSON.stringify({professions_status:'verified',professions_at:now,professions:[{name:'Engineering',recipes:[{id:100,name:'Fine Widget'}]}]}),now).run();
  }
  await DB.prepare('INSERT INTO recipe_details VALUES(?,?,?)').bind(recipe.id,JSON.stringify(recipe),epoch()+86400).run();
  const env={DB,DISCORD_CLIENT_ID:APP,DISCORD_GUILD_ID:GUILD,DISCORD_CRAFT_REQUESTS_CHANNEL_ID:CHANNEL,DISCORD_CLIENT_SECRET:'fixture-secret',DISCORD_BOT_TOKEN:'fixture-bot-token'};
  async function user(id,char){
    const token=random(),csrf=random();await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind(id,'subject-'+id,char,epoch(),now,now).run();
    await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(char,id,now).run();
    await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,epoch()+3600).run();
    return {id,char,request(path,body){return new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-wv_session='+token,Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});}};
  }
  const a=await user('requester',101),b=await user('crafter',102),c=await user('other',103);env.ADMIN_USER_IDS=a.id;
  return {DB,env,a,b,c};
}
async function link(f,user,did,requester=false,crafter=false){await f.DB.prepare('INSERT INTO discord_links VALUES(?,?,?,?,?)').bind(user.id,did,requester?1:0,crafter?1:0,new Date().toISOString()).run();}
async function create(f,targets=[],extra={}){
  const response=await worker.fetch(f.a.request('/api/hall/requests',{kind:'craft',character_id:101,recipe_id:100,quantity:2,target_character_ids:targets,...extra}),f.env);assert.equal(response.status,200,await response.text());
  return f.DB.prepare('SELECT * FROM requests ORDER BY rowid DESC LIMIT 1').first();
}
async function jobs(f,kind){return (await f.DB.prepare('SELECT * FROM discord_outbox'+(kind?' WHERE kind=?':'')+' ORDER BY created_at,id').bind(...(kind?[kind]:[])).all()).results;}
async function due(f){await f.DB.prepare("UPDATE discord_outbox SET next_at=0,lease_until=0 WHERE status='pending'").run();await f.DB.prepare("DELETE FROM state WHERE key='discord_pause'").run();}
async function withDiscord(run){
  const original=globalThis.fetch,state={calls:[],unexpected:[],dmMessages:[],channelMessages:[],deleted:[],messages:new Map(),dmChannels:new Map(),dmFailure:null,channelOverride:null};let sequence=0;
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(input),method=options.method||'GET',body=options.body===undefined?undefined:JSON.parse(options.body),path=url.pathname.replace('/api/v10','');state.calls.push({path,method,body});
    assert.equal(url.origin,'https://discord.com');assert.equal(options.headers.Authorization,'Bot fixture-bot-token');assert.equal(options.redirect,'manual');
    if(path==='/users/@me/channels'&&method==='POST'){
      const failure=typeof state.dmFailure==='function'?state.dmFailure(body.recipient_id):state.dmFailure;
      if(failure instanceof Error)throw failure;if(failure)return Response.json({retry_after:125},{status:failure});
      const id=String(700000000000000000n+BigInt(++sequence));state.dmChannels.set(id,body.recipient_id);return Response.json({id});
    }
    if(path==='/applications/@me')return Response.json({id:APP,name:'Fixture Bot'});
    if(path==='/users/@me')return Response.json({id:APP,bot:true});
    if(path===`/guilds/${GUILD}`)return Response.json({id:GUILD,owner_id:APP,roles:[{id:GUILD,permissions:'8'}]});
    if(path===`/guilds/${GUILD}/roles`)return Response.json([{id:GUILD,permissions:'8'}]);
    if(path===`/guilds/${GUILD}/members/${APP}`)return Response.json({user:{id:APP,bot:true},roles:[]});
    if(path===`/channels/${CHANNEL}`&&method==='GET')return Response.json(state.channelOverride||{id:CHANNEL,guild_id:GUILD,type:0,permission_overwrites:[]});
    const messages=path.match(/^\/channels\/(\d+)\/messages$/);
    if(messages){
      const channel=messages[1];
      if(state.dmChannels.has(channel)&&method==='POST'){state.dmMessages.push({recipient:state.dmChannels.get(channel),...body});return Response.json({id:String(800000000000000000n+BigInt(++sequence))});}
      if(channel===CHANNEL){
        if(method==='GET')return Response.json([...state.messages.values()]);
        if(method==='POST'){const message={...body,id:String(900000000000000000n+BigInt(++sequence)),channel_id:CHANNEL,author:{id:APP}};state.channelMessages.push(message);state.messages.set(message.id,message);return Response.json(message);}
      }
    }
    const exact=path.match(new RegExp(`^/channels/${CHANNEL}/messages/(\\d+)$`));
    if(exact){
      const message=state.messages.get(exact[1]);if(!message)return Response.json({message:'Unknown Message'},{status:404});
      if(method==='GET')return Response.json(message);
      if(method==='PATCH'){const next={...message,...body};state.messages.set(message.id,next);return Response.json(next);}
      if(method==='DELETE'){state.deleted.push(message.id);state.messages.delete(message.id);return new Response(null,{status:204});}
    }
    if(path.startsWith(`/channels/${CHANNEL}/messages/`)&&path.includes('/reactions/'))return method==='GET'?Response.json([]):new Response(null,{status:204});
    state.unexpected.push(method+' '+path);throw Error('Unexpected Discord fixture request: '+method+' '+path);
  };
  try{const result=await run(state);assert.deepEqual(state.unexpected,[]);return result;}finally{globalThis.fetch=original;}
}
async function flush(f,count=2){for(let n=0;n<count;n++)await flushDiscord(f.env);}
const crafterJobs=async f=>(await jobs(f,'dm')).filter(job=>JSON.parse(job.payload).preference==='crafter');
async function cancel(f,row,action='cancel'){
  const response=await worker.fetch(f.a.request('/api/hall/requests/'+row.id,{action}),f.env);assert.equal(response.status,200,await response.text());
}

test('an open request with no selected crafter queues one public craft announcement and no crafter DMs',async()=>{
  const f=await fixture();await link(f,f.b,IDS.b,false,true);
  const row=await create(f),queued=await jobs(f,'craft_post');assert.equal(queued.length,1);assert.equal(queued[0].reference_id,row.id);assert.equal((await crafterJobs(f)).length,0);
  await withDiscord(async state=>{
    await flush(f);assert.equal(state.channelMessages.length,1);assert.equal(state.dmMessages.length,0);
    const message=state.channelMessages[0];assert(message.content.includes('Fine Widget'));assert(message.content.includes('Alice Longsurname'));assert(message.content.includes('Tracker craft request: '+row.id));assert.deepEqual(message.allowed_mentions,{parse:[]});assert(message.enforce_nonce);
    await flush(f);assert.equal(state.channelMessages.length,1,'A repeated flush must not publish duplicate craft requests');
  });
});

test('selected eligible crafters get their targeted DMs and full requester character name without a channel announcement',async()=>{
  const f=await fixture();await link(f,f.b,IDS.b,false,true);await link(f,f.c,IDS.c,false,true);
  await create(f,[102,103]);assert.equal((await jobs(f,'craft_post')).length,0);assert.equal((await crafterJobs(f)).length,2);
  await withDiscord(async state=>{
    await flush(f);assert.equal(state.channelMessages.length,0);assert.deepEqual(state.dmMessages.map(message=>message.recipient).sort(),[IDS.b,IDS.c].sort());
    for(const message of state.dmMessages){assert(message.content.includes('Alice Longsurname'));assert(message.content.includes('Fine Widget'));assert.deepEqual(message.allowed_mentions,{parse:[]});assert(message.enforce_nonce);}
  });
});

test('a selected crafter without DM consent falls back to one channel announcement while other targets keep their DMs',async()=>{
  const f=await fixture();await link(f,f.b,IDS.b,false,false);await link(f,f.c,IDS.c,false,true);
  await create(f,[102,103]);assert.equal((await jobs(f,'craft_post')).length,1);assert.equal((await crafterJobs(f)).length,1);
  await withDiscord(async state=>{await flush(f);assert.equal(state.channelMessages.length,1);assert.deepEqual(state.dmMessages.map(message=>message.recipient),[IDS.c]);});
});

test('permanent crafter DM refusal queues one fallback and terminates the original DM instead of retrying forever',async()=>{
  for(const status of [403,404]){
    const f=await fixture();await link(f,f.b,IDS.b,false,true);const row=await create(f,[102]);
    await withDiscord(async state=>{
      state.dmFailure=status;await flush(f);const job=(await crafterJobs(f))[0];assert(['failed','fell_back','fallback'].includes(job.status));assert.equal(job.attempts,1);
      assert.equal((await jobs(f,'craft_post')).length,1);await due(f);await flush(f);assert.equal(state.channelMessages.length,1);
      assert.equal(state.calls.filter(call=>call.path==='/users/@me/channels').length,1);assert.equal(state.channelMessages[0].content.includes(row.id),true);
    });
  }
});

test('transient crafter DM network and server errors retry before falling back once on exhaustion',async()=>{
  for(const failure of [new Error('Fixture network failure'),503]){
    const f=await fixture();await link(f,f.b,IDS.b,false,true);await create(f,[102]);
    await withDiscord(async state=>{
      state.dmFailure=failure;await flush(f,1);let job=(await crafterJobs(f))[0];assert.equal(job.status,'pending');assert.equal(job.attempts,1);assert(job.next_at>epoch());assert.equal((await jobs(f,'craft_post')).length,0);
      for(let attempt=2;attempt<=5;attempt++){await due(f);await flush(f,1);job=(await crafterJobs(f))[0];if(attempt<5){assert.equal(job.status,'pending');assert.equal((await jobs(f,'craft_post')).length,0);}}
      assert(['failed','fell_back','fallback'].includes(job.status));assert.equal(job.attempts,5);assert.equal((await jobs(f,'craft_post')).length,1);
      await due(f);await flush(f);assert.equal(state.channelMessages.length,1);assert.equal(state.calls.filter(call=>call.path==='/users/@me/channels').length,5);
    });
  }
});

test('a Discord 429 waits for the requested pause without immediately falling back to a channel',async()=>{
  const f=await fixture();await link(f,f.b,IDS.b,false,true);await create(f,[102]);
  await withDiscord(async state=>{
    state.dmFailure=429;await flush(f);const job=(await crafterJobs(f))[0];assert.equal(job.status,'pending');assert(job.next_at>=epoch()+123);assert.equal((await jobs(f,'craft_post')).length,0);assert.equal(state.calls.length,1);
    state.dmFailure=null;await due(f);await flush(f);assert.equal(state.dmMessages.length,1);assert.equal(state.channelMessages.length,0);assert.equal((await jobs(f,'craft_post')).length,0);
  });
});

test('requester receipt opt-out and delivery failure cannot trigger a crafter channel fallback',async()=>{
  for(const requesterOptIn of [false,true]){
    const f=await fixture();await link(f,f.a,IDS.a,requesterOptIn,false);await link(f,f.b,IDS.b,false,true);await create(f,[102]);
    await withDiscord(async state=>{
      state.dmFailure=recipient=>recipient===IDS.a?403:null;await flush(f,3);assert.equal(state.channelMessages.length,0);assert.equal((await jobs(f,'craft_post')).length,0);assert.deepEqual(state.dmMessages.map(message=>message.recipient),[IDS.b]);
      assert.equal(state.calls.filter(call=>call.path==='/users/@me/channels'&&call.body.recipient_id===IDS.a).length,requesterOptIn?1:0);
    });
  }
});

test('a changed Discord mapping never reroutes a queued DM, while its active request may use channel fallback',async()=>{
  const f=await fixture();await link(f,f.b,IDS.b,false,true);await create(f,[102]);
  await f.DB.prepare('UPDATE discord_links SET discord_id=? WHERE user_id=?').bind(IDS.c,f.b.id).run();
  await withDiscord(async state=>{
    await flush(f,3);assert.equal(state.calls.filter(call=>call.path==='/users/@me/channels').length,0);assert.equal(state.channelMessages.length,1);assert.equal((await jobs(f,'craft_post')).length,1);
  });
});

test('closing before delivery atomically suppresses queued crafter DMs and craft announcements',async()=>{
  for(const action of ['cancel','complete']){
    const f=await fixture();await link(f,f.b,IDS.b,false,true);const row=await create(f,[102]);await cancel(f,row,action);
    assert.equal((await jobs(f,'craft_cleanup')).length,1);
    await withDiscord(async state=>{await flush(f,3);assert.equal(state.dmMessages.length,0);assert.equal(state.channelMessages.length,0);assert.equal((await f.DB.prepare('SELECT status FROM requests WHERE id=?').bind(row.id).first()).status,action==='cancel'?'cancelled':'complete');});
  }
});

test('a cleanup queue failure rolls back closing the request and its associated notification changes',async()=>{
  const f=await fixture();await link(f,f.b,IDS.b,false,true);const row=await create(f,[102]),before=await jobs(f);
  f.DB.raw.exec("CREATE TRIGGER reject_craft_cleanup BEFORE INSERT ON discord_outbox WHEN NEW.kind='craft_cleanup' BEGIN SELECT RAISE(ABORT,'Fixture cleanup failure'); END");
  const response=await worker.fetch(f.a.request('/api/hall/requests/'+row.id,{action:'cancel'}),f.env);assert.equal(response.status,503);
  assert.equal((await f.DB.prepare('SELECT status FROM requests WHERE id=?').bind(row.id).first()).status,'open');assert.deepEqual(await jobs(f),before);
});

test('closing an announced request deletes only its owned Discord announcement and cleanup is idempotent',async()=>{
  const f=await fixture(),row=await create(f);
  await withDiscord(async state=>{
    await flush(f);assert.equal(state.channelMessages.length,1);const message=state.channelMessages[0];await cancel(f,row);await flush(f,3);
    assert.deepEqual(state.deleted,[message.id]);assert.equal(state.messages.size,0);await flush(f);assert.equal(state.deleted.length,1);
  });
});

test('craft channel configuration is admin-only and requires a text channel in the configured guild',async()=>{
  const f=await fixture();delete f.env.DISCORD_CRAFT_REQUESTS_CHANNEL_ID;
  const path='/api/admin/discord',body={client_id:APP,guild_id:GUILD,craft_requests_channel_id:CHANNEL};
  await withDiscord(async state=>{
    const before=state.calls.length;assert.equal((await worker.fetch(new Request(ORIGIN+path),f.env)).status,401);assert.equal((await worker.fetch(f.b.request(path),f.env)).status,403);assert.equal((await worker.fetch(f.b.request(path,{...body,is_admin:true}),f.env)).status,403);assert.equal(state.calls.length,before);
    for(const channel of [{id:CHANNEL,guild_id:'999999999999999999',type:0},{id:CHANNEL,guild_id:GUILD,type:2}]){
      state.channelOverride=channel;const response=await worker.fetch(f.a.request(path,body),f.env);assert.equal(response.status,400);assert.equal(await f.DB.prepare("SELECT value FROM state WHERE key='discord_config'").first(),null);
    }
    state.channelOverride=null;const response=await worker.fetch(f.a.request(path,body),f.env);assert.equal(response.status,200);const view=await response.json();assert.equal(view.craft_requests_channel_id,CHANNEL);
    const denied=await worker.fetch(new Request(ORIGIN+'/api/status'),f.env);assert.equal(denied.status,401);
    const memberResponse=await worker.fetch(f.b.request('/api/status'),f.env);assert.equal(memberResponse.status,200);const memberStatus=await memberResponse.text();assert(!memberStatus.includes(CHANNEL));assert(!memberStatus.includes('fixture-secret'));assert(!memberStatus.includes('fixture-bot-token'));
  });
});
