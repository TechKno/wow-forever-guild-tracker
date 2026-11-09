import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {craftTargetStatement,craftPostStatement,craftCleanupStatement,publishCraftPost,deleteCraftPost,queueCraftCleanups,pollOneCraftPost} from '../src/craft-posts.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
const GUILD='100000000000000001',APP='100000000000000002',CHANNEL='200000000000000001',OTHER='200000000000000002';
const did=n=>String(400000000000000000n+BigInt(n));
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
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const values=[];for(const s of statements)values.push(await s.run());raw.exec('COMMIT');return values;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),now=new Date().toISOString();await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(let n=1;n<=8;n++){
    const uid='u'+n,cid=100+n,name=n===1?'Recipient Exactname':'Crafter '+n;
    await DB.prepare("INSERT INTO users VALUES(?,?,?, ?,?,?,?)").bind(uid,'subject'+n,cid,n===5?'admin_mapped':'verified',n===4?epoch()-90000:epoch(),now,now).run();
    if(n!==5)await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(cid,uid,now).run();
    if(n!==5)await DB.prepare('INSERT INTO discord_links VALUES(?,?,0,0,?)').bind(uid,did(n),now).run();
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind(n===8?'previous':'current','character-'+n,cid,JSON.stringify({id:cid,name,slug:'character-'+n})).run();
    await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(cid,JSON.stringify({professions_status:'verified',professions:[{recipe_status:'observed',recipes:n===1||n===3?[]:[{id:100,name:'Potion'}]}]}),now).run();
  }
  await DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(105,did(5),'u5',1,0,'u1',now).run();
  await DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(107,did(7),'u5',0,0,'u1',now).run();
  await DB.prepare('INSERT INTO discord_crafter_optouts VALUES(?,?)').bind(did(5),now).run();
  const env={DB,DISCORD_CLIENT_ID:APP,DISCORD_GUILD_ID:GUILD,DISCORD_CRAFT_REQUESTS_CHANNEL_ID:CHANNEL,DISCORD_CLIENT_SECRET:'synthetic-secret',DISCORD_BOT_TOKEN:'synthetic-token'};
  const config={client_id:APP,guild_id:GUILD,craft_requests_channel_id:CHANNEL};
  async function add(id='request-one',recipe=100){
    await DB.prepare("INSERT INTO requests(id,kind,owner_id,character_id,recipe_id,item_name,quantity,status,created_at,updated_at,materials_json,recipient_name,recipient_mode) VALUES(?,'craft','u1',101,?,'Potion',2,'open',?,?,?,'Recipient Exactname','selected')").bind(id,recipe,now,now,JSON.stringify({status:'verified',shopping_list:[{name:'Ore',quantity:12}],components:[{item_name:'Metal Bar',required:8,crafts:4}]})).run();
    await craftTargetStatement(env,id,config).run();await craftPostStatement(env,id).run();return id;
  }
  const id=await add();return {DB,env,id,add};
}
function discord(f){
  const calls=[],messages=new Map();let next=300000000000000001n;
  const mock={calls,messages,people:[],failAccepted:false,onCreate:null,guild:GUILD,
    fetch:async(input,options={})=>{
      const url=new URL(input),path=url.pathname.replace('/api/v10',''),method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;calls.push({path,method,body,search:url.search});
      if(path==='/channels/'+CHANNEL)return Response.json({id:CHANNEL,guild_id:mock.guild,type:0,name:'craft-requests'});
      if(path==='/channels/'+CHANNEL+'/messages'&&method==='GET')return Response.json([...messages.values()].slice(-100).reverse());
      if(path==='/channels/'+CHANNEL+'/messages'&&method==='POST'){
        const message={id:String(next++),channel_id:CHANNEL,author:{id:APP,bot:true},content:body.content};messages.set(message.id,message);
        if(mock.onCreate)await mock.onCreate(message);
        if(mock.failAccepted){mock.failAccepted=false;throw Error('Discord accepted the create but its response was lost');}
        return Response.json(message);
      }
      const match=path.match(new RegExp('^/channels/'+CHANNEL+'/messages/(\\d+)(.*)$'));
      if(match){
        const message=messages.get(match[1]);if(!message)return Response.json({},{status:404});
        if(match[2].startsWith('/reactions/')&&method==='GET'){
          const after=url.searchParams.get('after'),offset=after?mock.people.findIndex(value=>value.id===after)+1:0;
          return Response.json(mock.people.slice(offset,offset+100));
        }
        if(match[2].startsWith('/reactions/')&&method==='PUT')return Response.json({});
        if(method==='GET')return Response.json(message);
        if(method==='PATCH'){message.content=body.content;return Response.json(message);}
        if(method==='DELETE'){messages.delete(match[1]);return Response.json({});}
      }
      throw Error('Unexpected mock Discord route: '+method+' '+path);
    }};
  return mock;
}
async function withDiscord(mock,run){const original=globalThis.fetch;globalThis.fetch=mock.fetch;try{return await run();}finally{globalThis.fetch=original;}}
async function status(f,id=f.id){return (await f.DB.prepare('SELECT status FROM requests WHERE id=?').bind(id).first()).status;}
async function resetPoll(f){await f.DB.prepare("DELETE FROM state WHERE key='craft_poll_minute'").run();await f.DB.prepare('UPDATE discord_craft_posts SET next_poll_at=0,lease_until=0').run();}
const person=n=>({id:did(n),username:'member'+n,bot:false});

test('one durable post names the exact recipient, snapshots material and component totals, and suppresses mentions',async()=>{
  const f=await fixture(),mock=discord(f);
  await craftPostStatement(f.env,f.id,'second-dm-failure').run();
  assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='craft_post'").first()).n,1);
  await f.DB.prepare("UPDATE membership SET data=json_set(data,'$.name','Renamed Character') WHERE character_id=101").run();
  await withDiscord(mock,async()=>{assert.equal(await publishCraftPost(f.env,f.id),'sent');assert.equal(await publishCraftPost(f.env,f.id),'sent');});
  const posts=mock.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.deepEqual(posts[0].body.allowed_mentions,{parse:[]});assert.equal(posts[0].body.enforce_nonce,true);
  assert.match(posts[0].body.content,/Send the completed item to: Recipient Exactname/);assert.match(posts[0].body.content,/12 × Ore/);assert.match(posts[0].body.content,/8 × Metal Bar \(4 component craft/);assert(posts[0].body.content.length<=2000);
  assert.match(posts[0].body.content,/Tracker craft request: request-one/);assert.equal(mock.calls.filter(c=>c.method==='PUT').length,1);
});

test('a lost create response is reconciled by bot identity and marker before retrying, so a request gets one message',async()=>{
  const f=await fixture(),mock=discord(f);mock.failAccepted=true;
  await withDiscord(mock,async()=>{
    await assert.rejects(publishCraftPost(f.env,f.id));
    const intent=await f.DB.prepare('SELECT * FROM discord_craft_posts').first();assert.equal(intent.message_id,null);assert(intent.create_attempted_at);
    assert.equal(await publishCraftPost(f.env,f.id),'sent');
  });
  assert.equal(mock.calls.filter(c=>c.method==='POST').length,1);assert.equal(mock.messages.size,1);
  assert(mock.calls.some(c=>c.path.endsWith('/messages')&&c.search==='?limit=100'));assert((await f.DB.prepare('SELECT message_id FROM discord_craft_posts').first()).message_id);
});

test('a closed request arriving during creation queues cleanup and never seeds reactions or recreates the announcement',async()=>{
  const f=await fixture(),mock=discord(f);
  mock.onCreate=async()=>{
    await f.DB.prepare("UPDATE requests SET status='cancelled' WHERE id=?").bind(f.id).run();
    await assert.rejects(deleteCraftPost(f.env,f.id),error=>error.status===409,'Cleanup must retain an in-flight create intent until its message ID can be saved');
  };
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);assert.equal(mock.calls.filter(c=>c.method==='PUT').length,0);await deleteCraftPost(f.env,f.id);assert.equal(await publishCraftPost(f.env,f.id),'skipped');});
  assert.equal(mock.messages.size,0);assert.equal(mock.calls.filter(c=>c.method==='POST').length,1);assert.equal((await f.DB.prepare("SELECT kind FROM discord_outbox WHERE id=?").bind('craft-cleanup:'+f.id).first()).kind,'craft_cleanup');
});

test('a closed request with a lost create response recovers and deletes only its exact accepted announcement',async()=>{
  const f=await fixture(),mock=discord(f);mock.failAccepted=true;
  mock.onCreate=async()=>{await f.DB.prepare("UPDATE requests SET status='complete'").run();};
  await withDiscord(mock,async()=>{
    await assert.rejects(publishCraftPost(f.env,f.id));assert.equal(mock.messages.size,1);
    assert.equal((await queueCraftCleanups(f.env)).queued,1);assert.equal(await deleteCraftPost(f.env,f.id),'sent');
    assert.equal(await publishCraftPost(f.env,f.id),'skipped');
  });
  assert.equal(mock.messages.size,0);assert.equal(mock.calls.filter(c=>c.method==='POST').length,1);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_craft_posts').first()).n,0);
});

test('cleanup never searches or deletes arbitrary messages when this request has no active post intent',async()=>{
  const f=await fixture(),mock=discord(f);await f.DB.prepare("UPDATE requests SET status='cancelled'").run();
  await withDiscord(mock,()=>deleteCraftPost(f.env,f.id));assert.equal(mock.calls.length,0);
});

for(const tamper of ['author','marker','server','destination'])test('post ownership validation prevents all mutations for a changed '+tamper,async()=>{
  const f=await fixture(),mock=discord(f);
  await withDiscord(mock,async()=>{
    await publishCraftPost(f.env,f.id);mock.calls.length=0;
    const message=[...mock.messages.values()][0];
    if(tamper==='author')message.author.id=did(99);if(tamper==='marker')message.content='Tracker craft request: another-request';if(tamper==='server')mock.guild=did(99);
    if(tamper==='destination')await f.DB.prepare('UPDATE discord_craft_posts SET channel_id=?').bind(OTHER).run();
    await f.DB.prepare('UPDATE discord_craft_posts SET reactions_initialized=0,last_hash=NULL').run();
    await assert.rejects(publishCraftPost(f.env,f.id),error=>error.status===409);
    await f.DB.prepare("UPDATE requests SET status='complete'").run();await assert.rejects(deleteCraftPost(f.env,f.id),error=>error.status===409);
  });
  assert(!mock.calls.some(c=>['PUT','PATCH','DELETE'].includes(c.method)));assert.equal(mock.messages.size,1);
});

for(const actor of [1,2,5])test('completion accepts '+(actor===1?'the linked requester without a recipe':actor===2?'any verified crafter, even if not selected':'a valid mapped crafter despite a DM opt-out'),async()=>{
  const f=await fixture(),mock=discord(f);mock.people=[person(actor)];
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);await resetPoll(f);await pollOneCraftPost(f.env);});
  assert.equal(await status(f),'complete');
  const row=await f.DB.prepare('SELECT change_id FROM requests').first();assert(row.change_id);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='craft_cleanup'").first()).n,1);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='dm' AND payload LIKE '%complete%'").first()).n,1);
});

test('unrelated users, stale ownership, conflicted mappings, former guild characters and bots cannot complete a request',async()=>{
  const f=await fixture(),mock=discord(f);mock.people=[person(3),person(4),person(7),person(8),person(99),{...person(6),bot:true}];
  await f.DB.prepare("DELETE FROM discord_links WHERE user_id='u7'").run();
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);});
  assert.equal(await status(f),'open');assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='craft_cleanup'").first()).n,0);
});

test('recipe capability can come from any verified current alt rather than only the Discord account main',async()=>{
  const f=await fixture(),mock=discord(f),now=new Date().toISOString();mock.people=[person(2)];
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions',json('[]')) WHERE id=102").run();
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','capable-alt',109,JSON.stringify({id:109,name:'Capable Alt'})).run();
  await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(109,?,?)').bind('u2',now).run();
  await f.DB.prepare('INSERT INTO characters VALUES(109,?,?)').bind(JSON.stringify({professions_status:'verified',professions:[{recipe_status:'observed',recipes:[{id:100}]}]}),now).run();
  await f.DB.prepare("UPDATE requests SET status='claimed',crafter_id='u3'").run();
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);});assert.equal(await status(f),'complete');
});

test('a cached recipe cannot authorize completion after its profession observation became stale',async()=>{
  const f=await fixture(),mock=discord(f);mock.people=[person(2)];
  await f.DB.prepare("UPDATE characters SET data=json_set(data,'$.professions_status','stale') WHERE id=102").run();
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);});assert.equal(await status(f),'open');
});

test('a manual item request cannot be completed by a crafter, but an exact valid mapping to its recipient can complete it',async()=>{
  const f=await fixture(),mock=discord(f);await f.DB.prepare('UPDATE requests SET recipe_id=NULL').run();mock.people=[person(2)];
  await withDiscord(mock,async()=>{
    await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);assert.equal(await status(f),'open');
    await f.DB.prepare("DELETE FROM discord_links WHERE user_id='u1'").run();
    await f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(101,did(9),'u1',0,0,'u1',new Date().toISOString()).run();
    mock.people=[person(9)];await resetPoll(f);await pollOneCraftPost(f.env);
  });assert.equal(await status(f),'complete');
});

test('an incomplete bounded reaction scan performs no completion even if an eligible crafter appeared on its first page',async()=>{
  const f=await fixture(),mock=discord(f);mock.people=Array.from({length:300},(_,i)=>person(i+2));
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);});
  assert.equal(await status(f),'open');assert.equal(mock.calls.filter(c=>c.method==='GET'&&c.path.includes('/reactions/')).length,3);assert((await f.DB.prepare('SELECT last_error FROM discord_craft_posts').first()).last_error);
});

test('polling completes a full second page before accepting an eligible reaction and handles only one post per minute',async()=>{
  const f=await fixture(),mock=discord(f);mock.people=Array.from({length:100},(_,i)=>person(i+100)).concat(person(250));await f.add('request-two');
  await f.DB.prepare("UPDATE discord_links SET discord_id=? WHERE user_id='u2'").bind(did(250)).run();
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await publishCraftPost(f.env,'request-two');await pollOneCraftPost(f.env);const count=mock.calls.length;await pollOneCraftPost(f.env);assert.equal(mock.calls.length,count);});
  assert.equal(await status(f),'complete');assert.equal(await status(f,'request-two'),'open');assert.equal(mock.calls.filter(c=>c.method==='GET'&&c.path.includes('/reactions/')).length,2);
});

test('completion and its durable cleanup/notification jobs roll back together if their batch fails',async()=>{
  const f=await fixture(),mock=discord(f);mock.people=[person(2)];const batch=f.DB.batch.bind(f.DB);let injected=false;
  f.DB.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.startsWith("UPDATE requests SET status='complete'"))){injected=true;return batch([...statements,f.DB.prepare('INSERT INTO missing_craft_test_table VALUES(1)')]);}return batch(statements);};
  await withDiscord(mock,async()=>{await publishCraftPost(f.env,f.id);await pollOneCraftPost(f.env);});
  assert(injected);assert.equal(await status(f),'open');assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind IN ('craft_cleanup','dm')").first()).n,0);
});

test('closed-post recovery queues one durable cleanup without clearing an existing retry backoff, and own 404 deletion is idempotent',async()=>{
  const f=await fixture(),mock=discord(f);
  await withDiscord(mock,async()=>{
    await publishCraftPost(f.env,f.id);await f.DB.prepare("UPDATE requests SET status='cancelled'").run();
    assert.equal((await queueCraftCleanups(f.env)).queued,1);
    const next=epoch()+500;await f.DB.prepare("UPDATE discord_outbox SET next_at=? WHERE kind='craft_cleanup'").bind(next).run();
    await craftCleanupStatement(f.env,f.id).run();assert.equal((await f.DB.prepare("SELECT next_at FROM discord_outbox WHERE kind='craft_cleanup'").first()).next_at,next);
    mock.messages.clear();assert.equal(await deleteCraftPost(f.env,f.id),'sent');assert.equal(await deleteCraftPost(f.env,f.id),'sent');
  });assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM discord_craft_posts').first()).n,0);
});

test('the existing global Discord pause blocks posting and polling without extending its deadline',async()=>{
  const f=await fixture(),mock=discord(f),until=epoch()+100;
  await f.DB.prepare("INSERT INTO state VALUES('discord_pause',?)").bind(JSON.stringify({until})).run();
  await withDiscord(mock,async()=>{await assert.rejects(publishCraftPost(f.env,f.id),error=>error.status===429);await pollOneCraftPost(f.env);});
  assert.equal(mock.calls.length,0);assert.equal(JSON.parse((await f.DB.prepare("SELECT value FROM state WHERE key='discord_pause'").first()).value).until,until);
});
