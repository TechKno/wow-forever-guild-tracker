import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {memberDirectory,cacheDiscordProfile,refreshOneDiscordProfile,discordDisplayName} from '../src/discord-people.mjs';
import {activeManualMappings,notificationCrafters,mappingView} from '../src/admin-mappings.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';
import worker from '../src/worker.mjs';
import {rosterDisplayGroups} from '../src/player-groups.mjs';
const GUILD='222222222222222222',A='333333333333333333',B='444444444444444444';
const epoch=()=>Math.floor(Date.now()/1000);
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const roleHelpers=app.slice(app.indexOf('const roleChoices='),app.indexOf('const profileState='));
function database(){
  const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
  for(const filename of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(filename,dir),'utf8'));
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
  const DB=database(),now=new Date().toISOString(),env={DB,DISCORD_CLIENT_ID:'999999999999999999',DISCORD_GUILD_ID:GUILD,DISCORD_BOT_TOKEN:'fixture-bot-token',DISCORD_CLIENT_SECRET:'fixture-client-secret'};
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(const [id,main,status]of [['u1',101,'verified'],['u2',201,'verified'],['manual',301,'admin_mapped'],['other',401,'verified']])await DB.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').bind(id,'subject-'+id,main,status,epoch(),now,now).run();
  for(const [id,name]of [[101,'Alice Main'],[102,'Alice Alt'],[201,'Bob Main'],[301,'Mapped Main'],[302,'Mapped Other'],[303,'Alice Mapped'],[401,'Other Character']]){
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current',name.toLowerCase().replaceAll(' ','-'),id,JSON.stringify({id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:'Mage',level:12,roster_observed:now})).run();
    await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(id,JSON.stringify({profile:{level:11},profile_status:'verified',profile_at:now}),now).run();
  }
  for(const [cid,uid,alt]of [[101,'u1',0],[102,'u1',1],[201,'u2',0],[401,'other',0]])await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?)').bind(cid,uid,now,alt).run();
  await DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?)').bind('u1',A,now).run();
  for(const [cid,did,uid,preferred]of [[301,B,'manual',1],[302,B,'manual',0],[303,A,'u1',0]])await DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(cid,did,uid,preferred,0,'u1',now).run();
  return {DB,env,user:{id:'u1'},now};
}
const guildMember=(id,nick='Server Nick')=>({nick,user:{id,username:'account_name',global_name:'Global Name'}});
async function staleMappingFixture(){
  const f=await fixture();await f.DB.prepare('DELETE FROM discord_links WHERE user_id=?').bind('u1').run();await f.DB.prepare('DELETE FROM admin_discord_mappings').run();
  for(const cid of [101,102,301,302])await f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(cid,B,'manual',cid===301?1:0,1,'u1',f.now).run();
  for(const cid of [101,102,301,302])await f.DB.prepare('UPDATE characters SET data=? WHERE id=?').bind(JSON.stringify({professions_status:'verified',professions:[{recipes:[{id:77,name:'Fixture Recipe'}]}]}),cid).run();
  await cacheDiscordProfile(f.env,B,guildMember(B,'Person With Several Alts'));return f;
}

test('Discord names use server nickname, global name, then username without inventing one',()=>{
  assert.equal(discordDisplayName({nickname:' Server ',global_name:'Global',username:'User'}),'Server');
  assert.equal(discordDisplayName({nickname:null,global_name:'Global',username:'User'}),'Global');
  assert.equal(discordDisplayName({global_name:'',username:'User'}),'User');assert.equal(discordDisplayName({}),null);
});
test('one exact Discord identity groups all verified and active manually assigned characters without exposing IDs',async()=>{
  const f=await fixture();await cacheDiscordProfile(f.env,A,guildMember(A,'Alice on Discord'));await cacheDiscordProfile(f.env,B,guildMember(B,'Mapped Person'));
  const people=await memberDirectory(f.env,f.user),alice=people.find(p=>p.display_name==='Alice on Discord'),mapped=people.find(p=>p.display_name==='Mapped Person');
  assert.deepEqual(alice.characters.map(c=>c.id),[101,102,303]);assert.equal(alice.identity_source,'mixed');assert(alice.own);
  assert.equal(alice.characters[0].association,'provider');assert.equal(alice.characters.find(c=>c.id===303).association,'admin');assert.equal(alice.characters[0].level,12);
  assert.deepEqual(mapped.characters.map(c=>c.id),[301,302]);assert.equal(mapped.identity_source,'admin');assert(mapped.characters.every(c=>c.association==='admin'&&!c.is_main));assert(mapped.characters[0].event_default);
  assert(!JSON.stringify(people).includes(A));assert(!JSON.stringify(people).includes(B));
});
test('a manual Discord assignment to a provider-owned character works before personal Discord authorisation',async()=>{
  const f=await fixture();await f.DB.prepare('DELETE FROM discord_links WHERE user_id=?').bind('u1').run();
  await f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(101,A,'u1',0,0,'u1',f.now).run();
  await cacheDiscordProfile(f.env,A,guildMember(A,'Assigned Discord'));
  const person=(await memberDirectory(f.env,f.user)).find(p=>p.display_name==='Assigned Discord');
  assert(person.characters.some(c=>c.id===101&&c.association==='provider'));assert.equal(person.identity_source,'admin');
});
test('directory-only account grouping includes unmapped verified characters without expanding manual DM or event authority',async()=>{
  const f=await fixture();await f.DB.prepare('DELETE FROM discord_links WHERE user_id=?').bind('u1').run();
  await f.DB.prepare('UPDATE character_links SET show_as_alt=0 WHERE character_id=102').run();
  await f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(101,A,'u1',1,1,'u1',f.now).run();
  for(const id of [101,102])await f.DB.prepare('UPDATE characters SET data=? WHERE id=?').bind(JSON.stringify({professions_status:'verified',professions:[{recipes:[{id:77,name:'Fixture Recipe'}]}]}),id).run();
  await cacheDiscordProfile(f.env,A,guildMember(A,'Assigned Person'));
  const person=(await memberDirectory(f.env,f.user)).find(p=>p.display_name==='Assigned Person');
  assert(person.characters.some(c=>c.id===102&&c.association==='provider'&&!c.is_alt&&!c.is_main));
  assert.equal(person.identity_source,'admin');assert(!(await activeManualMappings(f.env)).some(row=>row.character_id===102));
  assert.deepEqual((await notificationCrafters(f.env,77)).map(row=>row.character_id),[101]);
  assert.equal((await f.DB.prepare('SELECT user_id FROM character_links WHERE character_id=102').first()).user_id,'u1');
});
test('compatible old administrator assignments keep one main and three mixed characters together after provider sign-in without migrating authority',async()=>{
  const f=await staleMappingFixture(),mappings=(await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results,links=(await f.DB.prepare('SELECT * FROM character_links ORDER BY character_id').all()).results;
  assert.deepEqual((await activeManualMappings(f.env)).map(row=>row.character_id),[301,302]);assert.deepEqual((await notificationCrafters(f.env,77)).map(row=>row.character_id),[301,302]);
  const people=await memberDirectory(f.env,f.user),owner=people.find(person=>person.characters.some(character=>character.id===101));
  assert.equal(owner.display_name,'Person With Several Alts');assert.equal(owner.identity_source,'admin');assert.deepEqual(owner.characters.map(character=>character.id).sort((a,b)=>a-b),[101,102,301,302]);
  assert(owner.characters.find(character=>character.id===101).is_main);assert(owner.characters.find(character=>character.id===102).is_alt);
  assert(owner.characters.filter(character=>[101,102].includes(character.id)).every(character=>character.association==='provider'&&character.own));
  assert(owner.characters.filter(character=>[301,302].includes(character.id)).every(character=>character.association==='admin'&&!character.own&&!character.is_main&&!character.is_alt));
  assert.deepEqual(rosterDisplayGroups([owner])[0].character_ids.slice().sort((a,b)=>a-b),[101,102,301,302]);
  assert.deepEqual((await activeManualMappings(f.env)).map(row=>row.character_id),[301,302]);assert.deepEqual((await notificationCrafters(f.env,77)).map(row=>row.character_id),[301,302]);
  assert.deepEqual((await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results,mappings);assert.deepEqual((await f.DB.prepare('SELECT * FROM character_links ORDER BY character_id').all()).results,links);
  assert(!JSON.stringify(people).includes(B));
});
test('a verified account can show a main and three provider-owned alts with stale manual actors without limiting or replacing characters',async()=>{
  const f=await staleMappingFixture();for(const cid of [301,302])await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?)').bind(cid,'u1',f.now,1).run();
  const owner=(await memberDirectory(f.env,f.user)).find(person=>person.characters.some(character=>character.id===101));
  assert.equal(owner.characters.length,4);assert.equal(owner.characters.filter(character=>character.is_main).length,1);assert.equal(owner.characters.filter(character=>character.is_alt).length,3);assert(owner.characters.every(character=>character.association==='provider'&&character.own));
  assert.equal((await activeManualMappings(f.env)).length,0);assert.equal((await notificationCrafters(f.env,77)).length,0,'Presentation cannot restore authority for any stale mapping');
});
test('personal Discord authorisation keeps exact virtual-actor manual characters visible without granting them account ownership or notification authority',async()=>{
  const f=await staleMappingFixture();await f.DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?)').bind('u1',B,f.now).run();
  const before=(await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results,owner=(await memberDirectory(f.env,f.user)).find(person=>person.characters.some(character=>character.id===101));
  assert.deepEqual(owner.characters.map(character=>character.id).sort((a,b)=>a-b),[101,102,301,302]);assert.equal(owner.identity_source,'mixed');
  assert(owner.characters.filter(character=>[301,302].includes(character.id)).every(character=>character.association==='admin'&&!character.own&&!character.is_main&&!character.is_alt));
  assert.equal((await activeManualMappings(f.env)).length,0);assert.equal((await notificationCrafters(f.env,77)).length,0);assert.deepEqual((await f.DB.prepare('SELECT * FROM admin_discord_mappings ORDER BY character_id').all()).results,before);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) count FROM character_links WHERE user_id=?').bind('u1').first()).count,2);
});
test('an exact manual-only assignment can join a personally linked current provider account without a provider mapping on its main',async()=>{
  const f=await staleMappingFixture();await f.DB.prepare('DELETE FROM admin_discord_mappings WHERE character_id IN (101,102)').run();await f.DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?)').bind('u1',B,f.now).run();
  const owner=(await memberDirectory(f.env,f.user)).find(person=>person.characters.some(character=>character.id===101));assert.deepEqual(owner.characters.map(character=>character.id).sort((a,b)=>a-b),[101,102,301,302]);assert(owner.characters.filter(character=>[301,302].includes(character.id)).every(character=>!character.own&&character.association==='admin'));
  assert.equal((await activeManualMappings(f.env)).length,0);
});
test('display reconciliation rejects personal Discord, competing provider owners, ambiguous assignments and non-virtual actor conflicts',async()=>{
  const scenarios=[
    async f=>f.DB.prepare("UPDATE users SET ownership_status='verified' WHERE id='manual'").run(),
    async f=>f.DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?)').bind('u1',A,f.now).run(),
    async f=>f.DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?)').bind('u2',B,f.now).run(),
    async f=>f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(201,B,'manual',0,0,'u1',f.now).run(),
    async f=>f.DB.prepare('UPDATE admin_discord_mappings SET discord_id=? WHERE character_id=102').bind(A).run(),
    async f=>f.DB.prepare('INSERT INTO discord_links(user_id,discord_id,linked_at) VALUES(?,?,?)').bind('manual',A,f.now).run()
  ];
  for(const change of scenarios){
    const f=await staleMappingFixture();await change(f);const owner=(await memberDirectory(f.env,f.user)).find(person=>person.characters.some(character=>character.id===101));
    assert(!owner.characters.some(character=>[201,301,302].includes(character.id)),'A conflicting assignment must not absorb another account or manual-only characters');assert.equal(owner.characters.filter(character=>character.association==='provider').length,2);
  }
});
test('ambiguous administrator Discord accounts do not absorb an unmapped verified character',async()=>{
  const f=await fixture();await f.DB.prepare('DELETE FROM discord_links WHERE user_id=?').bind('u1').run();
  await f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(101,B,'u1',0,0,'u1',f.now).run();
  await cacheDiscordProfile(f.env,A,guildMember(A,'One Person'));await cacheDiscordProfile(f.env,B,guildMember(B,'Another Person'));
  const people=await memberDirectory(f.env,f.user),unmapped=people.find(p=>p.characters.some(c=>c.id===102));
  assert.equal(unmapped.discord_linked,false);assert(!people.filter(p=>p.discord_linked).some(p=>p.characters.some(c=>c.id===102)));
});
test('unlinked verified accounts retain their chosen main and unknown Discord names never fall back to raw IDs',async()=>{
  const f=await fixture(),people=await memberDirectory(f.env,f.user);
  assert(people.some(p=>p.display_name==='Bob Main'&&!p.discord_linked&&p.name_status==='unlinked'));
  assert(people.some(p=>p.display_name==='Discord member · name unavailable'&&p.discord_linked));assert(!JSON.stringify(people).includes(A));
});
test('a departed provider main falls back consistently without changing saved alt preferences or manual mapping authority',async()=>{
  const f=await fixture();await f.DB.prepare('DELETE FROM membership WHERE character_id=101').run();await f.DB.prepare('UPDATE character_links SET show_as_alt=0 WHERE character_id=102').run();
  await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','alice-selected',103,JSON.stringify({id:103,name:'Alice Selected',slug:'alice-selected',class:'Mage',level:12})).run();
  await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?)').bind(103,'u1',f.now,1).run();
  const before=(await activeManualMappings(f.env)).map(row=>({character_id:row.character_id,participant_user_id:row.participant_user_id,discord_id:row.discord_id}));
  const people=await memberDirectory(f.env,f.user),owner=people.find(person=>person.characters.some(character=>character.id===102)),fallback=owner.characters.find(character=>character.id===102),selected=owner.characters.find(character=>character.id===103);
  assert.equal(fallback.is_main,true);assert.equal(fallback.is_alt,false);assert.equal(fallback.association,'provider');assert.equal(selected.is_main,false);assert.equal(selected.is_alt,true);
  assert.deepEqual(rosterDisplayGroups([owner])[0].character_ids.slice().sort((a,b)=>a-b),[102,103,303]);assert.equal(rosterDisplayGroups([owner])[0].main_character_id,102);
  assert(people.flatMap(person=>person.characters).filter(character=>character.association==='admin').every(character=>!character.is_main&&!character.is_alt));
  assert.equal((await f.DB.prepare('SELECT main_character_id FROM users WHERE id=?').bind('u1').first()).main_character_id,101);assert.equal((await f.DB.prepare('SELECT show_as_alt FROM character_links WHERE character_id=102').first()).show_as_alt,0);
  assert.deepEqual((await activeManualMappings(f.env)).map(row=>({character_id:row.character_id,participant_user_id:row.participant_user_id,discord_id:row.discord_id})),before);
});
test('conflicting or former-guild administrator mappings do not add characters to a Discord person',async()=>{
  const f=await fixture();await f.DB.prepare('INSERT INTO admin_discord_mappings VALUES(?,?,?,?,?,?,?)').bind(401,A,'u1',0,0,'u1',f.now).run();
  await f.DB.prepare("DELETE FROM membership WHERE character_id=302").run();
  await cacheDiscordProfile(f.env,A,guildMember(A,'Alice Discord'));await cacheDiscordProfile(f.env,B,guildMember(B,'Mapped'));
  const people=await memberDirectory(f.env,f.user),alice=people.find(p=>p.display_name==='Alice Discord');
  assert(!alice.characters.some(c=>c.id===401));assert(!people.flatMap(p=>p.characters).some(c=>c.id===302));
});
test('provided fresh directory values are retained and a cache from another server is not used',async()=>{
  const f=await fixture();await cacheDiscordProfile({...f.env,DISCORD_GUILD_ID:'888888888888888888'},A,guildMember(A,'Wrong Server Nick'));
  const people=await memberDirectory(f.env,f.user,[{id:101,level:13,title:'New title'}]);
  const alice=people.find(p=>p.characters.some(c=>c.id===101));assert.equal(alice.characters.find(c=>c.id===101).level,13);assert(!people.some(p=>p.display_name==='Wrong Server Nick'));
});
test('OAuth name updates preserve an observed server nickname while guild nickname removal is observed explicitly',async()=>{
  const f=await fixture();await cacheDiscordProfile(f.env,A,guildMember(A,'Server Nick'));
  await cacheDiscordProfile(f.env,A,{id:A,username:'new_username',global_name:'New Global'});
  let person=(await memberDirectory(f.env,f.user)).find(p=>p.characters.some(c=>c.id===101));assert.equal(person.display_name,'Server Nick');
  await cacheDiscordProfile(f.env,A,{nick:null,user:{id:A,username:'new_username',global_name:'New Global'}});
  person=(await memberDirectory(f.env,f.user)).find(p=>p.characters.some(c=>c.id===101));assert.equal(person.display_name,'New Global');
  assert.equal(await cacheDiscordProfile(f.env,A,guildMember(B,'Wrong identity')),false);assert.equal(await cacheDiscordProfile(f.env,A,{id:A,username:'Bot',bot:true}),false);
});
test('the background name refresh fetches only one due exact member at a time and skips fresh names',async()=>{
  const f=await fixture(),original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push(new URL(url).pathname);assert.equal(options.headers.Authorization,'Bot fixture-bot-token');const id=new URL(url).pathname.split('/').at(-1);return Response.json(guildMember(id,'Observed '+calls.length));};
  try{await refreshOneDiscordProfile(f.env);assert.equal(calls.length,1);await refreshOneDiscordProfile(f.env);assert.equal(calls.length,2);assert.notEqual(calls[0],calls[1]);assert.equal((await refreshOneDiscordProfile(f.env)).processed,false);assert.equal(calls.length,2);}
  finally{globalThis.fetch=original;}
});
test('Discord name lookup failures retain prior names and respect the shared rate-limit pause',async()=>{
  const f=await fixture(),original=globalThis.fetch;await cacheDiscordProfile(f.env,A,guildMember(A,'Known Name'));await cacheDiscordProfile(f.env,B,guildMember(B,'Other Name'));
  await f.DB.prepare('UPDATE discord_profiles SET next_at=0 WHERE discord_id=?').bind(A).run();let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({retry_after:600},{status:429});};
  try{
    await refreshOneDiscordProfile(f.env);const person=(await memberDirectory(f.env,f.user)).find(p=>p.characters.some(c=>c.id===101));assert.equal(person.display_name,'Known Name');assert.equal(person.name_status,'stale');
    assert.equal((await refreshOneDiscordProfile(f.env)).paused,true);assert.equal(calls,1);
    const pause=JSON.parse((await f.DB.prepare("SELECT value FROM state WHERE key='discord_pause'").first()).value);assert(pause.until>=epoch()+599);
  }finally{globalThis.fetch=original;}
});
test('the directory renderer escapes Discord names and labels admin characters without granting provider ownership',()=>{
  const source=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8'),begin=source.indexOf('  function renderDirectory(){'),end=source.indexOf('  function fillProfile(){',begin),target={innerHTML:''};
  const hall={people:[{display_name:'<img src=x onerror=alert(1)>',discord_linked:true,name_status:'observed',identity_source:'admin',characters:[{name:'Mapped Character',class:'Mage',level:12,event_default:true,association:'admin'}]}]};
  const context=vm.createContext({hall,el:()=>target,esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
  vm.runInContext(roleHelpers,context);vm.runInContext(source.slice(begin,end)+'\nrenderDirectory();',context);
  assert(target.innerHTML.includes('&lt;img'));assert(!target.innerHTML.includes('<img'));assert(target.innerHTML.includes('Admin mapped'));assert(target.innerHTML.includes('Event default'));assert(!target.innerHTML.includes('Battle.net verified'));
});

test('directory character cards distinguish active and expired character-profile membership',()=>{
  const source=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8'),begin=source.indexOf('  function renderDirectory(){'),end=source.indexOf('  function fillProfile(){',begin);
  for(const [expiry,label]of [[new Date(Date.now()+3600000).toISOString(),'Verified through character profile'],[new Date(Date.now()-1000).toISOString(),'Character-profile verification expired']]){
    const target={innerHTML:''},hall={people:[{display_name:'Guild Member',characters:[{id:9,name:'Profile Character',class:'Mage',level:10,association:'provider',membership_source:'character_profile',membership_expires_at:expiry}]}]};
    const context=vm.createContext({hall,el:()=>target,esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
    vm.runInContext(roleHelpers,context);vm.runInContext(source.slice(begin,end)+'\nrenderDirectory();',context);assert(target.innerHTML.includes(label));
  }
});
test('administrator mapping names use only the configured guild cache without additional Discord lookups',async()=>{
  const f=await fixture(),original=globalThis.fetch;let calls=0;
  await cacheDiscordProfile(f.env,A,guildMember(A,'Guild Nickname'));
  await cacheDiscordProfile({...f.env,DISCORD_GUILD_ID:'888888888888888888'},A,guildMember(A,'Wrong Server Nickname'));
  await cacheDiscordProfile({...f.env,DISCORD_GUILD_ID:'888888888888888888'},B,guildMember(B,'Other Server Only'));
  globalThis.fetch=async()=>{calls++;throw Error('Names must use the cache');};
  try{
    let view=await mappingView(f.env),alice=view.mappings.find(row=>row.character_id===303),mapped=view.mappings.find(row=>row.character_id===301);
    assert.equal(alice.display_name,'Guild Nickname');assert.equal(alice.discord_id,A);assert.equal(alice.name_status,'observed');assert(alice.name_observed_at);
    assert.equal(mapped.display_name,'Discord member · name unavailable');assert.equal(mapped.name_status,'unavailable');
    await cacheDiscordProfile(f.env,A,{nick:null,user:{id:A,global_name:'Global Display Name',username:'account_name'}});
    view=await mappingView(f.env);assert.equal(view.mappings.find(row=>row.character_id===303).display_name,'Global Display Name');
    await cacheDiscordProfile(f.env,A,{nick:null,user:{id:A,global_name:null,username:'account_name'}});
    await f.DB.prepare('UPDATE discord_profiles SET next_at=0 WHERE guild_id=? AND discord_id=?').bind(GUILD,A).run();
    view=await mappingView(f.env);alice=view.mappings.find(row=>row.character_id===303);
    assert.equal(alice.display_name,'account_name');assert.equal(alice.name_status,'stale');assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});
test('cached mapping names and raw Discord IDs remain restricted to the administrator endpoint',async()=>{
  const f=await fixture(),token=random(),csrf=random();await cacheDiscordProfile(f.env,A,guildMember(A,'Private Mapping Name'));
  await f.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),'u1',csrf,epoch()+3600).run();
  const path=ORIGIN+'/api/admin/character-mappings',request=()=>new Request(path,{headers:{Cookie:'__Host-wv_session='+token}});
  for(const [req,status]of [[new Request(path),401],[request(),403]]){
    const response=await worker.fetch(req,f.env),text=await response.text();assert.equal(response.status,status);assert(!text.includes(A));assert(!text.includes('Private Mapping Name'));
  }
  f.env.ADMIN_USER_IDS='u1';const response=await worker.fetch(request(),f.env),view=await response.json();assert.equal(response.status,200);
  const row=view.mappings.find(mapping=>mapping.character_id===303);assert.equal(row.display_name,'Private Mapping Name');assert.equal(row.discord_id,A);
  const people=await memberDirectory(f.env,f.user);assert(!JSON.stringify(people).includes(A));assert(!JSON.stringify(people).includes(B));
});
test('the admin mapping renderer displays the escaped name before the secondary editable user ID',()=>{
  const source=readFileSync(new URL('../public/adventures.js',import.meta.url),'utf8'),begin=source.indexOf('  function renderCharacterMappings(){'),end=source.indexOf('  async function loadCharacterMappings(){',begin),target={innerHTML:''};
  const context=vm.createContext({characterMappings:[{character_id:303,name:'Character',display_name:'<img src=x onerror=alert(1)>',discord_id:A}],$:()=>target,esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
  vm.runInContext(source.slice(begin,end)+'\nrenderCharacterMappings();',context);
  assert(target.innerHTML.includes('DISCORD MEMBER'));assert(target.innerHTML.includes('<strong>&lt;img'));assert(!target.innerHTML.includes('<img'));assert(target.innerHTML.includes('<br><code>'+A+'</code>'));
  assert(target.innerHTML.indexOf('&lt;img')<target.innerHTML.indexOf(A));
});
