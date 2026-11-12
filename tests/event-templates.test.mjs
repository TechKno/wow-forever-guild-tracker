import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {eventTemplateCatalogue,eventTemplateSettings,eventTemplateGuidance,eventGuideLines,validateEventRoleLimits} from '../src/event-templates.mjs';
import {mutateHall,hallView} from '../src/community.mjs';
import {reactionRoles,eventAnnouncement} from '../src/event-posts.mjs';
import {signupStatement} from '../src/events.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

const template={id:'fixture-raid',name:'Synthetic Raid',kind:'Raid',capacity:20,role_limits:{Tank:2,Healer:5,Damage:13},minimum_level:null,recommended_level:{min:60,max:60},location:'A fictional meeting point',duration_minutes:180,status:'announced',capacity_status:'verified',minimum_level_status:'unverified',recommended_level_status:'verified',role_status:'suggested',notes:'Fixture guidance only.',sources:[{title:'Fixture source',url:'https://example.com/guide'}]};
const catalogue=()=>({schema_version:1,checked_at:'2026-11-09T00:00:00.000Z',game:'WoW Forever',templates:[structuredClone(template)]});
const epoch=()=>Math.floor(Date.now()/1000);
function database(){
  const raw=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  class Statement{constructor(sql,params=[]){this.sql=sql;this.params=params;}bind(...params){return new Statement(this.sql,params);}async first(){return raw.prepare(this.sql).get(...this.params)||null;}async all(){return {results:raw.prepare(this.sql).all(...this.params)};}async run(){return raw.prepare(this.sql).run(...this.params);}}
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),at=new Date().toISOString(),users=[];DB.raw.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(let index=0;index<3;index++){
    const id=101+index,uid='fixture-user-'+index,token=random(),csrf=random();
    DB.raw.prepare('INSERT INTO membership VALUES(?,?,?,?)').run('current','fixture-'+['one','two','three'][index],id,JSON.stringify({id,name:'Fictional Character '+index,slug:'fixture-'+['one','two','three'][index],class:'Mage',level:20}));
    DB.raw.prepare('INSERT INTO users VALUES(?,?,?,\'verified\',?,?,?)').run(uid,'fixture-subject-'+index,id,epoch(),at,at);
    DB.raw.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').run(id,uid,at);
    DB.raw.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await digest(token),uid,csrf,epoch()+3600);
    users.push({id:uid,character:id,request(path='/api/hall/events',body){return new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-wv_session='+token,Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});}});
  }
  return {DB,env:{DB},users};
}
const body=(character_id,extra={})=>({character_id,title:'A fictional raid',kind:'Raid',starts_at:new Date(Date.now()+86400000).toISOString(),capacity:40,role_limits:{Tank:2,Healer:8,Damage:30},...extra});

test('catalogue retains source confidence and differentiates announced content from available runs',()=>{
  const published=eventTemplateCatalogue(catalogue());assert.equal(published.templates.length,1);assert.equal(published.templates[0].status,'announced');assert.equal(published.templates[0].minimum_level,null);assert.equal(published.templates[0].minimum_level_status,'unverified');assert.equal(published.templates[0].role_status,'suggested');
  const invalid=catalogue();invalid.templates.push(invalid.templates[0]);assert.throws(()=>eventTemplateCatalogue(invalid));
  const unsafe=catalogue();unsafe.templates[0].sources.push({title:'Bad source',url:'javascript:alert(1)'});assert.equal(eventTemplateCatalogue(unsafe).templates[0].sources.length,1);
  const dungeons=eventTemplateCatalogue().templates.filter(row=>row.kind==='Dungeon');
  assert.equal(dungeons.length,35);
  assert.equal(dungeons.filter(row=>row.capacity_status==='verified'&&row.capacity===5).length,9);
  assert.equal(dungeons.filter(row=>row.capacity_status==='group_finder'&&row.recommended_level_status==='group_finder').length,26);
  const upper=eventTemplateSettings({template_id:'upper-blackrock-spire'});
  assert.equal(upper.capacity,10);
  assert.deepEqual(upper.role_limits,{Tank:2,Healer:2,Damage:6});
  assert.deepEqual(upper.template_guidance.recommended_level,{min:59,max:60});
  assert.equal(upper.template_guidance.minimum_level,null);
  assert(eventGuideLines({template_guidance:upper.template_guidance}).some(line=>line.includes('59–60 · Forever Group Finder')));
  const lower=dungeons.find(row=>row.id==='lower-blackrock-spire');
  assert.equal(lower.capacity,5);
  assert.deepEqual(lower.recommended_level,{min:55,max:60});
});

test('role allocations accept zeroes and require whole appropriate roles adding up to total capacity',()=>{
  assert.deepEqual(validateEventRoleLimits({Tank:0,Healer:1,Damage:4},5,'Dungeon'),{Tank:0,Healer:1,Damage:4});
  for(const roles of [{Tank:1,Healer:1,Damage:2},{Tank:1.5,Healer:0.5,Damage:3},{Tank:-1,Healer:1,Damage:5},{Tank:1,Healer:1,Damage:3,Social:0},{Tank:true,Healer:1,Damage:3},null])assert.throws(()=>validateEventRoleLimits(roles,5,'Raid'));
});

test('selection trusts the server catalogue and preserves template defaults while allowing explicit balanced role edits',()=>{
  const selected=eventTemplateSettings({template_id:'fixture-raid',capacity:20,role_limits:{Tank:3,Healer:4,Damage:13},minimum_level:null,recommended_level:{min:60,max:60},minimum_level_status:'verified',status:'available'},catalogue());
  assert.equal(selected.kind,'Raid');assert.equal(selected.template_guidance.status,'announced');assert.equal(selected.template_guidance.minimum_level_status,'unverified');assert.equal(selected.template_guidance.recommended_level_status,'verified');assert.deepEqual(selected.role_limits,{Tank:3,Healer:4,Damage:13});assert.equal(selected.template_guidance.level_guide_source,'catalogue');
  for(const bad of [{template_id:'missing'},{template_id:'fixture-raid',kind:'Dungeon'},{template_id:'fixture-raid',capacity:40},{template_id:'fixture-raid',role_limits:null},{kind:'Raid',capacity:41}])assert.throws(()=>eventTemplateSettings(bad,catalogue()));
  const changed=eventTemplateSettings({template_id:'fixture-raid',capacity:10,role_limits:{Tank:2,Healer:2,Damage:6}},catalogue());assert.equal(changed.template_guidance.capacity,10);assert.deepEqual(changed.template_guidance.role_limits,{Tank:2,Healer:2,Damage:6});assert.equal(changed.template_guidance.capacity_status,'unverified');
});

test('host level overrides are explicitly guidance and never inherit a verified source claim',()=>{
  const settings=eventTemplateSettings({template_id:'fixture-raid',minimum_level:50,recommended_level:{min:55,max:60},minimum_level_status:'verified'},catalogue());
  assert.equal(settings.template_guidance.minimum_level_status,'guide');assert.equal(settings.template_guidance.recommended_level_status,'guide');assert.equal(settings.template_guidance.level_guide_source,'member');
  const custom=eventTemplateSettings({kind:'Raid',capacity:20,title:'Custom raid',minimum_level:40,recommended_level:{min:45,max:55}},catalogue());assert.equal(custom.template_id,null);assert.equal(custom.template_guidance.level_guide_source,'member');
  for(const guide of [{minimum_level:-1},{minimum_level:101},{recommended_level:{min:50,max:40}},{recommended_level:{min:50,max:null}}])assert.throws(()=>eventTemplateSettings({kind:'Raid',...guide},catalogue()));
  const classic=catalogue();classic.templates[0].recommended_level_status='guide';const onlyMinimum=eventTemplateSettings({template_id:'fixture-raid',minimum_level:50},classic).template_guidance;
  assert.equal(onlyMinimum.minimum_level_source,'member');assert.equal(onlyMinimum.recommended_level_source,'catalogue');assert(eventGuideLines({template_guidance:onlyMinimum}).some(line=>line.includes('recommended guide')));
});

test('legacy custom events retain their previous default party roles and no invented level guide',()=>{
  const dungeon=eventTemplateSettings({kind:'Dungeon',capacity:5},catalogue());assert.deepEqual(dungeon.role_limits,{Tank:1,Healer:1,Damage:3});assert.equal(dungeon.template_guidance,null);
  assert.equal(eventTemplateSettings({kind:'Dungeon',capacity:1},catalogue()).role_limits,null);assert.equal(eventTemplateGuidance({template_json:'bad-json'}),null);
});

test('raid creation stores balanced role quotas and a host guide without blocking a lower-level verified signup',async()=>{
  const f=await fixture(),host=f.users[0],guest=f.users[1];
  await mutateHall(host.request('/api/hall/events',body(host.character,{minimum_level:50,recommended_level:{min:55,max:60}})),f.env);
  const saved=await f.DB.prepare('SELECT * FROM events').first();assert.equal(saved.kind,'Raid');assert.equal(saved.capacity,40);assert.deepEqual(JSON.parse(saved.role_limits_json),{Tank:2,Healer:8,Damage:30});assert.equal(saved.template_id,null);assert.equal(JSON.parse(saved.template_json).minimum_level_status,'guide');
  await mutateHall(guest.request('/api/hall/events/'+saved.id,{action:'join',character_id:guest.character,role:'Damage'}),f.env);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,1);
  const hall=await hallView(host.request('/api/hall'),f.env);assert.equal(hall.events[0].template_guidance.level_guide_source,'member');assert.equal(hall.events[0].template_guidance.minimum_level,50);assert(!Object.hasOwn(hall.events[0],'template_json'));
});

test('catalogue selections snapshot their level evidence and queue the normal raid Discord work only after explicit creation',async()=>{
  const selected=eventTemplateCatalogue().templates.find(template=>template.kind==='Raid');assert(selected,'The supported catalogue includes raid suggestions');
  const f=await fixture(),host=f.users[0];Object.assign(f.env,{DISCORD_CLIENT_ID:'111111111111111111',DISCORD_GUILD_ID:'222222222222222222',DISCORD_EVENTS_CHANNEL_ID:'333333333333333333',DISCORD_CLIENT_SECRET:'fixture-secret',DISCORD_BOT_TOKEN:'fixture-token'});
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM events').first()).n,0);
  await mutateHall(host.request('/api/hall/events',body(host.character,{template_id:selected.id,kind:selected.kind,capacity:selected.capacity,role_limits:selected.role_limits})),f.env);
  const saved=await f.DB.prepare('SELECT * FROM events').first();assert.equal(saved.template_id,selected.id);assert.deepEqual(eventTemplateGuidance(saved).recommended_level,selected.recommended_level);
  const kinds=(await f.DB.prepare('SELECT kind FROM discord_outbox ORDER BY kind').all()).results.map(row=>row.kind);assert.deepEqual(kinds,['event','event_post']);
});

test('raid role limits are enforced atomically for website and Discord signup statements',async()=>{
  const f=await fixture(),host=f.users[0];await mutateHall(host.request('/api/hall/events',body(host.character,{capacity:3,role_limits:{Tank:1,Healer:1,Damage:1}})),f.env);const saved=await f.DB.prepare('SELECT * FROM events').first();
  await signupStatement(f.env,saved,f.users[0].id,f.users[0].character,'Tank').run();
  const denied=await signupStatement(f.env,saved,f.users[1].id,f.users[1].character,'Tank','','discord').run();assert.equal(Number(denied.changes??denied.meta?.changes??0),0);
  await signupStatement(f.env,saved,f.users[1].id,f.users[1].character,'Healer').run();await signupStatement(f.env,saved,f.users[2].id,f.users[2].character,'Damage').run();assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM event_signups').first()).n,3);
});

test('raid announcements use combat reactions, exact role quotas and qualified level guidance',()=>{
  const settings=eventTemplateSettings({template_id:'fixture-raid'},catalogue()),event={id:'11111111-1111-4111-8111-111111111111',title:'Fixture raid',kind:'Raid',capacity:20,starts_at:new Date(Date.now()+3600000).toISOString(),status:'open',duration_minutes:180,role_limits_json:JSON.stringify(settings.role_limits),template_json:JSON.stringify(settings.template_guidance)};
  assert.deepEqual(reactionRoles(event).map(value=>value.role),['Tank','Healer','Damage']);
  const announcement=eventAnnouncement(event,[]);assert.match(announcement,/Tank: 0\/2/);assert.match(announcement,/Healer: 0\/5/);assert.match(announcement,/Damage: 0\/13/);assert.match(announcement,/Minimum entry level has not been verified/);assert.match(announcement,/Recommended levels 60–60/);assert.match(announcement,/Announced content/);assert(announcement.length<=2000);assert.equal(announcement.trimEnd().split('\n').at(-1),'Tracker event: '+event.id);
  assert.equal(eventGuideLines({}).length,0);
});
