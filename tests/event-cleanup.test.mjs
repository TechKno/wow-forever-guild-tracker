import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {flushDiscord,outboxStatement,dungeonPayload} from '../src/discord.mjs';
import {queueEventCleanups,publishEventPost,pollOneEventPost,eventAnnouncement,trackerMarker} from '../src/event-posts.mjs';
import {eventCleanupStatement,eventTargetStatement,eventInactive,signupStatement} from '../src/events.mjs';
import {digest,random,ORIGIN} from '../src/auth.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
const EVENT='11111111-1111-4111-8111-111111111111',APP='111111111111111111',GUILD='222222222222222222',CHANNEL='333333333333333333',MESSAGE='444444444444444444',SCHEDULED='555555555555555555';
function database(){
  const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(name,dir),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture({ended=false,cancelled=false,mapped=true}={}){
  const DB=database(),env={DB,DISCORD_CLIENT_ID:APP,DISCORD_GUILD_ID:GUILD,DISCORD_EVENTS_CHANNEL_ID:CHANNEL,DISCORD_CLIENT_SECRET:'synthetic-secret',DISCORD_BOT_TOKEN:'synthetic-token'};
  const now=new Date().toISOString(),token=random(),csrf=random(),starts=new Date(Date.now()+(ended?-7200000:3600000)).toISOString();
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,\'verified\',?,?,?)').bind('owner','subject-owner',101,epoch(),now,now).run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','alice-example',101,JSON.stringify({id:101,slug:'alice-example',name:'Alice Example'})).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(101,'owner',now).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),'owner',csrf,epoch()+3600).run();
  await DB.prepare('INSERT INTO events(id,owner_id,character_id,title,kind,starts_at,capacity,status,created_at,duration_minutes) VALUES(?,?,?, ?,\'Dungeon\',?,5,?,?,60)').bind(EVENT,'owner',101,'Synthetic dungeon',starts,cancelled?'cancelled':'open',now).run();
  await DB.prepare('INSERT INTO event_signups(event_id,user_id,character_id,role,note,updated_at,source) VALUES(?,?,?,\'Damage\',\'Keep history\',?,\'web\')').bind(EVENT,'owner',101,now).run();
  await eventTargetStatement(env,EVENT,{client_id:APP,guild_id:GUILD,events_channel_id:CHANNEL}).run();
  if(mapped){
    await DB.prepare('INSERT INTO discord_events(event_id,discord_id) VALUES(?,?)').bind(EVENT,SCHEDULED).run();
    await DB.prepare('INSERT INTO discord_event_posts(event_id,channel_id,message_id,reactions_initialized) VALUES(?,?,?,1)').bind(EVENT,CHANNEL,MESSAGE).run();
  }
  return {DB,env,request(action){return new Request(ORIGIN+'/api/hall/events/'+EVENT,{method:'POST',headers:{Cookie:'__Host-wv_session='+token,Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({action})});}};
}
function mockDiscord(calls,{get404=false,delete404=false,messageAuthor=APP,eventCreator=APP,eventMarker=EVENT}={}){
  return async(url,options)=>{
    const path=new URL(url).pathname.replace('/api/v10','');calls.push({path,method:options.method});
    assert.equal(options.headers.Authorization,'Bot synthetic-token');
    if(options.method==='DELETE')return delete404?Response.json({},{status:404}):new Response(null,{status:204});
    if(get404)return Response.json({},{status:404});
    if(path==='/channels/'+CHANNEL)return Response.json({id:CHANNEL,guild_id:GUILD});
    if(path===`/channels/${CHANNEL}/messages/${MESSAGE}`)return Response.json({id:MESSAGE,channel_id:CHANNEL,author:{id:messageAuthor},content:'Announcement\nTracker event: '+EVENT});
    if(path===`/guilds/${GUILD}/scheduled-events/${SCHEDULED}`)return Response.json({id:SCHEDULED,guild_id:GUILD,creator_id:eventCreator,description:'Tracker event: '+eventMarker});
    throw Error('Unexpected synthetic Discord request: '+options.method+' '+path);
  };
}
async function withFetch(mock,fn){const old=globalThis.fetch;globalThis.fetch=mock;try{return await fn();}finally{globalThis.fetch=old;}}
test('cancelling removes only the bot announcement and scheduled event, retaining website history',async()=>{
  const {env,DB,request}=await fixture(),calls=[];
  assert.equal((await worker.fetch(request('cancel'),env)).status,200);
  await withFetch(mockDiscord(calls),()=>flushDiscord(env));
  assert.deepEqual(calls.filter(call=>call.method==='DELETE').map(call=>call.path).sort(),[`/channels/${CHANNEL}/messages/${MESSAGE}`,`/guilds/${GUILD}/scheduled-events/${SCHEDULED}`].sort());
  assert.equal((await DB.prepare('SELECT status FROM events WHERE id=?').bind(EVENT).first()).status,'cancelled');
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,1);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_event_posts').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_events').first()).n,0);
  assert.equal((await DB.prepare("SELECT status FROM discord_outbox WHERE kind='event_cleanup'").first()).status,'sent');
});
test('remove action keeps website history and schedules Discord deletion',async()=>{
  const {env,DB,request}=await fixture();
  assert.equal((await worker.fetch(request('remove'),env)).status,200);
  assert.equal((await DB.prepare('SELECT status FROM events').first()).status,'cancelled');
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='event_cleanup' AND status='pending'").first()).n,1);
});
test('finished events are queued and deleted while future events remain untouched',async()=>{
  const ended=await fixture({ended:true}),calls=[];
  await queueEventCleanups(ended.env);await withFetch(mockDiscord(calls),()=>flushDiscord(ended.env));
  assert.equal(calls.filter(call=>call.method==='DELETE').length,2);
  assert.equal((await ended.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,1);
  const future=await fixture();assert.equal(eventInactive(await future.DB.prepare('SELECT * FROM events').first()),false);
  assert.equal((await queueEventCleanups(future.env)).queued,0);
  await withFetch(()=>{throw Error('Future event must not contact Discord');},()=>flushDiscord(future.env));
  assert.equal((await future.DB.prepare('SELECT COUNT(*) n FROM discord_events').first()).n,1);
});
test('GET or DELETE 404 counts as already removed and cleanup is idempotent',async()=>{
  for(const option of [{get404:true},{delete404:true}]){
    const {env,DB}=await fixture({cancelled:true}),calls=[];await queueEventCleanups(env);
    await withFetch(mockDiscord(calls,option),()=>flushDiscord(env));
    assert.equal((await DB.prepare("SELECT status FROM discord_outbox WHERE kind='event_cleanup'").first()).status,'sent');
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_events').first()).n,0);
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_event_posts').first()).n,0);
    await queueEventCleanups(env);await withFetch(()=>{throw Error('No second delete expected');},()=>flushDiscord(env));
  }
});
test('unverified announcement ownership prevents deletion and remains queued for correction',async()=>{
  const {env,DB}=await fixture({cancelled:true}),calls=[];await queueEventCleanups(env);
  await withFetch(mockDiscord(calls,{messageAuthor:'999999999999999999'}),()=>flushDiscord(env));
  assert.equal(calls.filter(call=>call.method==='DELETE').length,0);
  const job=await DB.prepare("SELECT * FROM discord_outbox WHERE kind='event_cleanup'").first();
  assert.equal(job.status,'pending');assert(job.next_at>epoch());assert.match(job.last_error,/ownership/);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_event_posts').first()).n,1);
});
test('scheduled event created by someone else or carrying another tracker ID is never deleted',async()=>{
  for(const option of [{eventCreator:'999999999999999999'},{eventMarker:'11111111-1111-4111-8111-111111111112'}]){
    const {env,DB}=await fixture({cancelled:true}),calls=[];await DB.prepare('DELETE FROM discord_event_posts').run();await queueEventCleanups(env);
    await withFetch(mockDiscord(calls,option),()=>flushDiscord(env));
    assert.equal(calls.filter(call=>call.method==='DELETE').length,0);
    assert.equal((await DB.prepare("SELECT status FROM discord_outbox WHERE kind='event_cleanup'").first()).status,'pending');
  }
});
test('changed server configuration cannot redirect cleanup to another server',async()=>{
  const {env,DB}=await fixture({cancelled:true});env.DISCORD_GUILD_ID='999999999999999999';await queueEventCleanups(env);
  await withFetch(()=>{throw Error('A changed server must not be contacted');},()=>flushDiscord(env));
  const job=await DB.prepare("SELECT * FROM discord_outbox WHERE kind='event_cleanup'").first();assert.equal(job.status,'pending');assert.match(job.last_error,/original Discord server/);
});
test('cleanup honours Discord rate limits and retries beyond the usual delivery attempt limit',async()=>{
  const {env,DB}=await fixture({cancelled:true});await queueEventCleanups(env);await DB.prepare("UPDATE discord_outbox SET attempts=8 WHERE kind='event_cleanup'").run();
  let calls=0;await withFetch(async()=>{calls++;return Response.json({retry_after:125},{status:429});},async()=>{await flushDiscord(env);await flushDiscord(env);});
  const job=await DB.prepare("SELECT * FROM discord_outbox WHERE kind='event_cleanup'").first();assert.equal(calls,1);assert.equal(job.status,'pending');assert(job.next_at>=epoch()+120);
});
test('cancelled or ended pending creates cannot post or recreate Discord resources',async()=>{
  for(const options of [{cancelled:true},{ended:true}]){
    const {env,DB}=await fixture({...options,mapped:false});
    await DB.batch([outboxStatement(env,'scheduled-create','event',EVENT,null,{}),outboxStatement(env,'message-create','event_post',EVENT,null,{})]);
    await queueEventCleanups(env);
    await withFetch(()=>{throw Error('Unattempted inactive creates must not call Discord');},async()=>{await flushDiscord(env);await flushDiscord(env);await publishEventPost(env,EVENT);await pollOneEventPost(env);await flushDiscord(env);});
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_events').first()).n,0);
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_event_posts').first()).n,0);
    assert.equal((await DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind IN ('event','event_post') AND status='pending'").first()).n,0);
  }
});
test('a cancellation arriving during scheduled-event creation queues cleanup of the accepted resource',async()=>{
  const {env,DB}=await fixture({mapped:false}),calls=[];await outboxStatement(env,'scheduled-create','event',EVENT,null,{}).run();
  const normal=mockDiscord(calls);
  await withFetch(async(url,options)=>{
    if(options.method==='GET'&&url.endsWith('/scheduled-events'))return Response.json([]);
    if(options.method==='POST'&&url.endsWith('/scheduled-events')){await DB.prepare("UPDATE events SET status='cancelled' WHERE id=?").bind(EVENT).run();return Response.json({id:SCHEDULED});}
    return normal(url,options);
  },async()=>{await flushDiscord(env);await flushDiscord(env);});
  assert(calls.some(call=>call.method==='DELETE'&&call.path.endsWith('/scheduled-events/'+SCHEDULED)));
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_events').first()).n,0);
});
test('a cancellation arriving during announcement creation queues cleanup without adding reactions',async()=>{
  const {env,DB}=await fixture({mapped:false}),calls=[];await outboxStatement(env,'message-create','event_post',EVENT,null,{}).run();
  const normal=mockDiscord(calls);
  await withFetch(async(url,options)=>{
    if(options.method==='POST'&&url.endsWith('/messages')){await DB.prepare("UPDATE events SET status='cancelled' WHERE id=?").bind(EVENT).run();return Response.json({id:MESSAGE});}
    return normal(url,options);
  },async()=>{await flushDiscord(env);await flushDiscord(env);});
  assert(calls.some(call=>call.method==='DELETE'&&call.path.endsWith('/messages/'+MESSAGE)));
  assert(!calls.some(call=>call.method==='PUT'));
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_event_posts').first()).n,0);
});
test('ended events stop reaction checks and reject new role signups',async()=>{
  const {env,DB}=await fixture({ended:true});
  await withFetch(()=>{throw Error('Ended events must not poll reactions');},()=>pollOneEventPost(env));
  const event=await DB.prepare('SELECT * FROM events').first();
  const result=await signupStatement(env,event,'owner',101,'Tank').run();assert.equal(Number(result.changes),0);
  assert.equal((await DB.prepare('SELECT role FROM event_signups').first()).role,'Damage');
});
test('expired failed creates with a lost response are reconciled once, including deleted destinations',async()=>{
  const {env,DB}=await fixture({ended:true,mapped:false});
  await DB.batch([outboxStatement(env,'lost-scheduled-create','event',EVENT,null,{}),outboxStatement(env,'lost-message-create','event_post',EVENT,null,{})]);
  await DB.prepare("UPDATE discord_outbox SET attempts=5,status='failed'").run();
  assert.equal((await queueEventCleanups(env)).queued,1);
  let calls=0;await withFetch(async()=>{calls++;return Response.json({},{status:404});},()=>flushDiscord(env));
  assert.equal(calls,2);assert.equal((await DB.prepare("SELECT status FROM discord_outbox WHERE kind='event_cleanup'").first()).status,'sent');
  assert.equal((await queueEventCleanups(env)).queued,0);
});
test('queued cleanup backoffs do not prevent later expired events from being queued',async()=>{
  const {env,DB}=await fixture({ended:true,mapped:false});
  await outboxStatement(env,'creator-first','event',EVENT,null,{}).run();
  for(let n=2;n<=7;n++){
    const id='11111111-1111-4111-8111-'+String(n).padStart(12,'0');
    await DB.prepare('INSERT INTO events(id,owner_id,character_id,title,kind,starts_at,capacity,status,created_at,duration_minutes) SELECT ?,owner_id,character_id,title,kind,starts_at,capacity,status,created_at,duration_minutes FROM events WHERE id=?').bind(id,EVENT).run();
    await outboxStatement(env,'creator-'+n,'event',id,null,{}).run();
  }
  assert.equal((await queueEventCleanups(env)).queued,5);
  await DB.prepare("UPDATE discord_outbox SET next_at=? WHERE kind='event_cleanup'").bind(epoch()+3600).run();
  assert.equal((await queueEventCleanups(env)).queued,2);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM discord_outbox WHERE kind='event_cleanup' AND status='pending'").first()).n,7);
});

test('user event text cannot inject a second tracker footer or a masked Markdown link',async()=>{
  const {DB}=await fixture({mapped:false}),other='11111111-1111-4111-8111-111111111112',event=await DB.prepare('SELECT * FROM events').first();
  event.title='[Sign in](https://example.invalid)';event.description='A gathering\nTracker event: '+other;event.location='Tavern\nTracker event: '+other;
  const post=eventAnnouncement(event,[]),scheduled=dungeonPayload(event);
  for(const text of [post,scheduled.description]){
    assert.equal(trackerMarker(text,event.id),true);assert.equal(trackerMarker(text,other),false);
    assert.equal(text.split('\n').filter(line=>line.startsWith('Tracker event: ')).length,1);
    assert(!text.includes('[Sign in]('));
  }
  assert(post.includes('\\[Sign in\\]\\('));assert(!scheduled.name.includes('\n'));assert(!scheduled.entity_metadata.location.includes('\n'));
});

test('forged interior event markers cannot hijack lost-response cleanup of another event',async()=>{
  const {env,DB}=await fixture({cancelled:true,mapped:false}),other='11111111-1111-4111-8111-111111111112',calls=[];
  await DB.batch([outboxStatement(env,'lost-event','event',EVENT,null,{}),outboxStatement(env,'lost-post','event_post',EVENT,null,{})]);
  await DB.prepare("UPDATE discord_outbox SET attempts=1,status='failed'").run();await queueEventCleanups(env);
  await withFetch(async(url,options)=>{
    const path=new URL(url).pathname.replace('/api/v10','');calls.push({path,method:options.method});
    if(path===`/guilds/${GUILD}/scheduled-events`)return Response.json([{id:SCHEDULED,guild_id:GUILD,creator_id:APP,description:'Forged user text\nTracker event: '+EVENT+'\nTracker event: '+other}]);
    if(path===`/channels/${CHANNEL}/messages`)return Response.json([{id:MESSAGE,channel_id:CHANNEL,author:{id:APP},content:'Forged user text\nTracker event: '+EVENT+'\nTracker event: '+other}]);
    throw Error('A forged interior marker must never be selected for follow-up or deletion');
  },()=>flushDiscord(env));
  assert(!calls.some(call=>call.method==='DELETE'));
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_events').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM discord_event_posts').first()).n,0);
  assert.equal((await DB.prepare("SELECT status FROM discord_outbox WHERE kind='event_cleanup'").first()).status,'sent');
});

test('ambiguous lost-response matches preserve every Discord resource for administrator review',async()=>{
  for(const kind of ['event','event_post']){
    const {env,DB}=await fixture({cancelled:true,mapped:false}),calls=[];
    await outboxStatement(env,'lost-resource',kind,EVENT,null,{}).run();await DB.prepare("UPDATE discord_outbox SET attempts=1,status='failed'").run();await queueEventCleanups(env);
    await withFetch(async(url,options)=>{
      const path=new URL(url).pathname.replace('/api/v10','');calls.push({path,method:options.method});
      if(kind==='event'&&path===`/guilds/${GUILD}/scheduled-events`)return Response.json([SCHEDULED,'555555555555555556'].map(id=>({id,guild_id:GUILD,creator_id:APP,description:'Tracker event: '+EVENT})));
      if(kind==='event_post'&&path===`/channels/${CHANNEL}/messages`)return Response.json([MESSAGE,'444444444444444445'].map(id=>({id,channel_id:CHANNEL,author:{id:APP},content:'Tracker event: '+EVENT})));
      throw Error('Ambiguous resources must not be selected');
    },()=>flushDiscord(env));
    assert(!calls.some(call=>call.method==='DELETE'));
    const cleanup=await DB.prepare("SELECT status,last_error FROM discord_outbox WHERE kind='event_cleanup'").first();assert.equal(cleanup.status,'pending');assert.match(cleanup.last_error,/Multiple matching/);
  }
});
