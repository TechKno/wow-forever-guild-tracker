import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {adminOverview,syncHistoryStatements} from '../src/admin-overview.mjs';
import {tick,GUILD,SLUG} from '../src/logic.mjs';
import {digest,random,ORIGIN,currentUser} from '../src/auth.mjs';

const epoch=()=>Math.floor(Date.now()/1000),stamp=()=>new Date().toISOString();
function database(){
  const raw=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(file,directory),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){
    raw.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}
  }};
}
const member=(id,name='Rook',level=4,rank=1)=>({id,name:name+' Testlight',slug:name.toLowerCase()+'-testlight',level,rank,class:'Mage',class_id:8,race:'Human',roster_observed:stamp()});
async function insertMember(DB,generation,value){await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind(generation,value.slug,value.id,JSON.stringify(value)).run();}
async function signedUser(DB,id,characterId,verified=true){
  const at=stamp(),token=random();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id,'private-subject-'+id,characterId,verified?'verified':'unavailable',epoch(),at,at).run();
  if(characterId)await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(characterId,id,at).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,'private-csrf-'+id,epoch()+3600).run();
  return new Request(ORIGIN+'/api/admin/overview',{headers:{Cookie:'__Host-wv_session='+token}});
}
async function fixture(){
  const DB=database();await DB.prepare("UPDATE sync SET published='current',status='partial',roster_at=?,completed_at=?,next_at=? WHERE id=1").bind(stamp(),stamp(),epoch()+900).run();
  await insertMember(DB,'current',member(101));await insertMember(DB,'current',member(102,'Sable'));await insertMember(DB,'current',member(103,'Willow'));
  const request=await signedUser(DB,'owner-fixture',101),ordinary=await signedUser(DB,'member-fixture',102);
  await DB.prepare('INSERT INTO character_links VALUES(?,?,?,?)').bind(103,'member-fixture',stamp(),1).run();
  await signedUser(DB,'nonmember-fixture',null,false);
  await DB.prepare('INSERT INTO discord_links VALUES(?,?,?,?,?)').bind('owner-fixture','123456789012345678',0,0,stamp()).run();
  const env={DB,ADMIN_USER_IDS:'owner-fixture',BLIZZARD_CLIENT_ID:'private-client-id',BLIZZARD_CLIENT_SECRET:'private-client-secret',DISCORD_BOT_TOKEN:'private-bot-token',DISCORD_CLIENT_SECRET:'private-discord-secret'};
  return {DB,env,request,ordinary};
}

test('the overview requires a current verified guild owner account, not only a session or admin identifier',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(adminOverview(new Request(ORIGIN+'/api/admin/overview'),f.env),error=>error.status===401);
    await assert.rejects(adminOverview(f.ordinary,f.env),error=>error.status===403);
    await f.DB.prepare("UPDATE users SET ownership_checked=0 WHERE id='owner-fixture'").run();
    await assert.rejects(adminOverview(f.request,f.env),error=>error.status===403);
  }finally{f.DB.raw.close();}
});

test('admin counts distinguish characters, site accounts and current guild accounts without exposing identities or credentials',async()=>{
  const f=await fixture();
  try{
    await f.DB.prepare("INSERT INTO state VALUES('scheduler',?)").bind(JSON.stringify({last_completed:stamp()})).run();
    await f.DB.prepare("INSERT INTO state VALUES('discord_config',?)").bind(JSON.stringify({client_id:'123456789012345678',guild_id:'123456789012345679'})).run();
    await f.DB.prepare('INSERT INTO character_refresh(character_id,next_at,failures) VALUES(?,?,?)').bind(101,0,0).run();
    await f.DB.prepare('INSERT INTO character_refresh(character_id,next_at,failures) VALUES(?,?,?)').bind(102,epoch()+3600,2).run();
    await f.DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(102,JSON.stringify({profile_status:'unavailable',profile_availability:'not_published',profile_error:'private-provider-error'}),stamp()).run();
    await f.DB.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?)').bind('/private-provider-route','profile-forever-eu',stamp(),stamp(),'unavailable','private-provider-error').run();
    const result=await adminOverview(f.request,f.env),encoded=JSON.stringify(result);
    assert.deepEqual(result.counts,{characters:3,roster_characters:3,profile_verified_characters:0,site_accounts:3,current_member_accounts:2,discord_linked_accounts:1,members_without_discord:1,unclaimed_characters:0});
    assert.equal(result.refresh.unpublished,1);assert.equal(result.refresh.failures,1);assert.equal(result.refresh.due,2);assert.equal(result.refresh.waiting,1);
    assert.equal(result.health.scheduler.status,'healthy');assert.equal(result.health.blizzard.status,'limited');assert.equal(result.health.backups.status,'managed_by_host');
    for(const secret of ['owner-fixture','member-fixture','private-client-id','private-client-secret','private-bot-token','private-discord-secret','private-csrf','private-subject','private-provider-route','private-provider-error','123456789012345678'])assert(!encoded.includes(secret),secret+' must stay private');
  }finally{f.DB.raw.close();}
});

async function withProvider(DB,roster,run){
  const original=globalThis.fetch,env={DB,BLIZZARD_CLIENT_ID:'import-history-'+random(),BLIZZARD_CLIENT_SECRET:'fixture-secret'};
  globalThis.fetch=async input=>{
    const path=new URL(input).pathname;
    if(path==='/token')return Response.json({access_token:'fixture-api-token',expires_in:3600});
    if(path==='/data/wow/ruleset/3')return Response.json({id:3,name:'Roleplay'});
    if(path===`/data/wow/guild/${SLUG}`)return Response.json({id:18,name:GUILD,ruleset:{id:3}});
    if(path===`/data/wow/guild/${SLUG}/roster`)return Response.json({guild:{id:18},members:roster.map(m=>({character:{id:m.id,name:m.name.split(' ')[0],surname:'Testlight',slug:m.slug,level:m.level,playable_class:{id:8},playable_race:{id:1}},rank:m.rank}))});
    if(path.startsWith('/profile/wow/character/'))return Response.json({error:'Synthetic unpublished profile'},{status:404});
    throw Error('Unexpected provider path');
  };
  try{await run(env);}finally{globalThis.fetch=original;DB.raw.close();}
}
async function publish(env,steps=2){await env.DB.prepare('UPDATE sync SET next_at=0 WHERE id=1').run();for(let n=0;n<steps;n++)await tick(env);}

test('a completed roster import records joins, departures, genuine level gains and rank changes once',async()=>{
  const DB=database();await DB.prepare("UPDATE sync SET published='previous',next_at=0 WHERE id=1").run();
  await insertMember(DB,'previous',member(101));await insertMember(DB,'previous',member(102,'Sable',9));
  const roster=[member(101,'Rook',5,2),member(103,'Willow',1,3)];
  await withProvider(DB,roster,async env=>{
    await publish(env);
    const row=await DB.prepare('SELECT * FROM roster_imports').first();
    assert(row);assert.equal(row.member_count,2);assert.equal(row.joined,1);assert.equal(row.departed,1);assert.equal(row.level_changes,1);assert.equal(row.rank_changes,1);assert.equal(row.baseline,0);assert(row.duration_ms>=0);
    assert.equal((await DB.prepare('SELECT character_id FROM membership_departures').first()).character_id,102);
    await publish(env);
    const rows=(await DB.prepare('SELECT * FROM roster_imports ORDER BY completed_at DESC').all()).results;
    assert.equal(rows.length,2);assert.equal(rows[0].joined,0);assert.equal(rows[0].departed,0);assert.equal(rows[0].level_changes,0);assert.equal(rows[0].rank_changes,0);
  });
});

test('initial imports are baselines and incomplete staging is not reported as a completed import',async()=>{
  const DB=database(),roster=Array.from({length:14},(_,n)=>member(101+n,'Fixture'+n,1,2));
  await withProvider(DB,roster,async env=>{
    await tick(env);await tick(env);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM roster_imports').first()).n,0);
    await tick(env);const row=await DB.prepare('SELECT * FROM roster_imports').first();
    assert.equal(row.baseline,1);assert.equal(row.member_count,14);assert.equal(row.joined,0);assert.equal(row.departed,0);assert.equal(row.level_changes,0);
  });
});

test('failed publication rolls back import summaries, departure markers and proof revocation along with the roster',async()=>{
  const DB=database();await DB.prepare("UPDATE sync SET published='previous',next_at=0 WHERE id=1").run();
  await insertMember(DB,'previous',member(101));await insertMember(DB,'previous',member(102,'Sable',9));
  await DB.prepare('INSERT INTO users(id,subject_hash,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind('departing-owner','subject-departing','verified',epoch(),stamp(),stamp()).run();
  await DB.prepare('INSERT INTO profile_members VALUES(?,?,?,?,?,?,?,?,?,?)').bind(102,'sable-testlight','departing-owner',18,3,JSON.stringify({...member(102,'Sable',9),guild_id:18,ruleset_id:3,membership_source:'character_profile'}),epoch(),epoch()+3600,epoch()+900,null).run();
  const originalBatch=DB.batch.bind(DB);let failed=false;
  DB.batch=statements=>{
    if(!failed&&statements.some(statement=>statement.sql.includes('INTO roster_imports'))){failed=true;return originalBatch([...statements,DB.prepare('INSERT INTO nonexistent_import_history_table VALUES(1)')]);}
    return originalBatch(statements);
  };
  await withProvider(DB,[member(101,'Rook',5,2)],async env=>{
    await publish(env);assert(failed);assert.equal((await DB.prepare('SELECT published FROM sync WHERE id=1').first()).published,'previous');
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM roster_imports').first()).n,0);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM membership_departures').first()).n,0);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,1);
    await publish(env);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM roster_imports').first()).n,1);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM membership_departures').first()).n,1);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM profile_members').first()).n,0);
  });
});

test('completed history remains bounded and a later returned roster clears its old departure marker',async()=>{
  const DB=database(),at=stamp();
  await DB.prepare("INSERT INTO membership_departures VALUES(101,'rook-testlight',?)").bind(at).run();
  await withProvider(DB,[member(101)],async env=>{
    await publish(env);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM membership_departures').first()).n,0);
    for(let n=0;n<105;n++){
      const generation='fixture-generation-'+n,completedAt=new Date(Date.now()+n*60000).toISOString();
      await DB.prepare("UPDATE sync SET phase='stage',generation=?,lease='fixture-owner' WHERE id=1").bind(generation).run();
      await insertMember(DB,generation,member(101));
      await DB.batch(syncHistoryStatements(env,{generation,previous:null,owner:'fixture-owner',observedAt:completedAt,startedAt:completedAt,completedAt}));
    }
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM roster_imports').first()).n,100);
  });
});

test('a returned departure revokes an old supplemental proof and last-character access while retaining historical attendance',async()=>{
  const f=await fixture(),at=stamp();
  await f.DB.prepare('INSERT INTO profile_members VALUES(?,?,?,?,?,?,?,?,?,?)').bind(101,'rook-testlight','owner-fixture',18,3,JSON.stringify({...member(101),guild_id:18,ruleset_id:3,membership_source:'character_profile'}),epoch(),epoch()+3600,epoch()+900,null).run();
  for(const [id,status,starts]of [['future','open',Date.now()+3600000],['past','open',Date.now()-86400000],['cancelled','cancelled',Date.now()+3600000]]){
    await f.DB.prepare('INSERT INTO events(id,owner_id,character_id,title,kind,starts_at,capacity,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(id,'member-fixture',102,'Synthetic event','Dungeon',new Date(starts).toISOString(),5,status,at).run();
    await f.DB.prepare('INSERT INTO event_signups(event_id,user_id,character_id,role,note,updated_at,source) VALUES(?,?,?,?,?,?,?)')
      .bind(id,'owner-fixture',101,'Damage','Synthetic signup',at,'web').run();
  }
  await f.DB.prepare('INSERT INTO discord_event_posts(event_id,channel_id,message_id,next_poll_at) VALUES(?,?,?,?)').bind('future','123456789012345678','123456789012345679',epoch()+3600).run();
  assert.equal((await currentUser(f.request,f.env)).verified,true);
  await withProvider(f.DB,[member(102,'Sable'),member(103,'Willow')],async env=>{
    await publish(env);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM profile_members WHERE character_id=101').first()).n,0);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM membership_departures WHERE character_id=101').first()).n,1);
    assert.equal((await currentUser(f.request,f.env)).verified,false,'A stale individual proof cannot preserve the departed account’s last guild character');
    assert.equal((await currentUser(f.ordinary,f.env)).verified,true,'Another member still owns current guild characters');
    const remaining=(await f.DB.prepare('SELECT event_id FROM event_signups ORDER BY event_id').all()).results.map(row=>row.event_id);
    assert.deepEqual(remaining,['cancelled','past'],'A departed character vacates future open events; historical/closed attendance is retained');
    assert((await f.DB.prepare("SELECT next_poll_at FROM discord_event_posts WHERE event_id='future'").first()).next_poll_at<=epoch());
  });
});

test('an account keeps its remaining guild alt and a later roster-confirmed return clears revocation and announces one rejoin',async()=>{
  const f=await fixture(),roster=[member(102,'Sable'),member(103,'Willow')];
  await f.DB.prepare("UPDATE character_links SET user_id='owner-fixture' WHERE character_id=103").run();
  await f.DB.prepare('INSERT INTO activity(id,character_id,kind,title,detail,observed_at) VALUES(?,?,?,?,?,?)')
    .bind('prior-guild-join',101,'joined','Rook Testlight appeared in the guild roster','Synthetic original join',new Date(Date.now()-3600000).toISOString()).run();
  await withProvider(f.DB,roster,async env=>{
    await publish(env);
    let user=await currentUser(f.request,f.env);assert.equal(user.verified,true);assert.deepEqual(user.characters.map(c=>c.id),[103]);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM membership_departures WHERE character_id=101').first()).n,1);
    roster.push(member(101));await publish(env);
    user=await currentUser(f.request,f.env);assert.equal(user.verified,true);assert.equal(user.characters.length,2);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM membership_departures WHERE character_id=101').first()).n,0);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM activity WHERE character_id=101 AND kind='joined'").first()).n,2);
    await publish(env);assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM activity WHERE character_id=101 AND kind='joined'").first()).n,2,'The same returned membership never duplicates its rejoin announcement');
  });
});
