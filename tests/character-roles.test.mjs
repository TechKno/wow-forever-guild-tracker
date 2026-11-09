import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {digest,random,ORIGIN} from '../src/auth.mjs';
import {saveRolePreferences} from '../src/character-roles.mjs';
const epoch=()=>Math.floor(Date.now()/1000),path='/api/hall/roles';
async function fixture(){
  const raw=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  const DB={raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}},env={DB};
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(const id of [101,102,103])await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','character-'+id,id,JSON.stringify({id,name:'Character '+id,slug:'character-'+id,class:'Druid',level:20})).run();
  async function account(id,characters){
    const token=random(),csrf=random(),now=new Date().toISOString();
    await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',?,?,?)").bind(id,'subject-'+id,characters[0],epoch(),now,now).run();
    for(const char of characters)await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(char,id,now).run();
    await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,epoch()+3600).run();
    return {id,token,csrf,request(url,body,options={}){return new Request(ORIGIN+url,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-wv_session='+token,Origin:options.origin??ORIGIN,'Content-Type':'application/json','X-CSRF-Token':options.csrf??csrf},body:body===undefined?undefined:JSON.stringify(body)});}};
  }
  return {DB,env,a:await account('a',[101,103]),b:await account('b',[102])};
}
const payload=(character_id=101,preferred_roles=['Healer','Damage'],primary_role='Healer')=>({character_id,preferred_roles,primary_role});
async function fetchJSON(f,account,url,body){const response=await worker.fetch(account.request(url,body),f.env);assert.equal(response.status,200);return response.json();}

test('multiple preferred roles with one primary persist, can be edited, and can be cleared for each owned character',async()=>{
  const f=await fixture();
  const saved=await fetchJSON(f,f.a,path,payload());
  assert.equal(saved.character_id,101);assert.deepEqual(saved.preferred_roles,['Healer','Damage']);assert.equal(saved.primary_role,'Healer');assert(!Number.isNaN(Date.parse(saved.role_preferences_updated_at)));
  await fetchJSON(f,f.a,path,payload(103,['Tank','Healer','Damage'],'Tank'));
  let me=await fetchJSON(f,f.a,'/api/me');assert.equal(me.characters.find(c=>c.id===101).primary_role,'Healer');assert.equal(me.characters.find(c=>c.id===103).primary_role,'Tank');
  const edited=await fetchJSON(f,f.a,path,payload(101,['Tank','Damage'],'Damage'));assert.equal(edited.primary_role,'Damage');assert.deepEqual(edited.preferred_roles,['Tank','Damage']);
  me=await fetchJSON(f,f.a,'/api/me');assert.equal(me.characters.find(c=>c.id===101).primary_role,'Damage');
  await fetchJSON(f,f.a,path,payload(101,[],null));
  me=await fetchJSON(f,f.a,'/api/me');assert.deepEqual(me.characters.find(c=>c.id===101).preferred_roles,[]);assert.equal(me.characters.find(c=>c.id===101).primary_role,null);assert.equal(me.characters.find(c=>c.id===103).primary_role,'Tank');
});

test('invalid roles, duplicate selections and missing or unselected primary roles cannot alter a saved preference',async()=>{
  const f=await fixture();await fetchJSON(f,f.a,path,payload());
  for(const body of [payload(101,['Healer'],null),payload(101,['Healer'],'Tank'),payload(101,[],'Damage'),payload(101,['Social'],'Social'),payload(101,['Damage','Damage'],'Damage'),payload(101,'Damage','Damage'),payload(101,['Tank','Healer','Damage','Tank'],'Tank'),{character_id:101,preferred_roles:['Tank']},payload(101,null,null)]){
    const response=await worker.fetch(f.a.request(path,body),f.env);assert.equal(response.status,400);
  }
  assert.equal((await f.DB.prepare('SELECT primary_role FROM character_role_preferences WHERE character_id=101').first()).primary_role,'Healer');
});

test('preferences are member-only, owner-only and protected against cross-origin and CSRF writes',async()=>{
  const f=await fixture();
  assert.equal((await worker.fetch(new Request(ORIGIN+path,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(payload())}),f.env)).status,401);
  for(const request of [f.b.request(path,payload()),f.a.request(path,payload(),{origin:'https://attacker.example'}),f.a.request(path,payload(),{csrf:'wrong'})])assert.equal((await worker.fetch(request,f.env)).status,403);
  await f.DB.prepare('DELETE FROM membership WHERE character_id IN (101,103)').run();
  assert.equal((await worker.fetch(f.a.request(path,payload()),f.env)).status,403);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_role_preferences').first()).n,0);
});

test('current declarations appear in member, hall and grouped people responses without inferring undeclared roles',async()=>{
  const f=await fixture();await fetchJSON(f,f.a,path,payload());
  const members=(await fetchJSON(f,f.b,'/api/members')).members;
  assert.deepEqual(members.find(c=>c.id===101).preferred_roles,['Healer','Damage']);assert.equal(members.find(c=>c.id===101).primary_role,'Healer');
  assert.deepEqual(members.find(c=>c.id===102).preferred_roles,[]);assert.equal(members.find(c=>c.id===102).primary_role,null);
  const hall=await fetchJSON(f,f.b,'/api/hall');assert.equal(hall.directory.find(c=>c.id===101).primary_role,'Healer');assert.equal(hall.people.flatMap(person=>person.characters).find(c=>c.id===101).primary_role,'Healer');
  assert.equal((await worker.fetch(new Request(ORIGIN+'/api/members'),f.env)).status,401);
});

test('ownership transfers and expired ownership hide old declarations, and the next owner starts with empty preferences',async()=>{
  const f=await fixture();await fetchJSON(f,f.a,path,payload());
  await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=101').bind(f.b.id).run();
  let member=(await fetchJSON(f,f.b,'/api/members')).members.find(c=>c.id===101);assert.deepEqual(member.preferred_roles,[]);assert.equal(member.primary_role,null);
  assert.equal((await worker.fetch(f.a.request(path,payload()),f.env)).status,403);
  await fetchJSON(f,f.b,path,payload(101,['Damage'],'Damage'));
  assert.equal((await fetchJSON(f,f.b,'/api/me')).characters.find(c=>c.id===101).primary_role,'Damage');
  await f.DB.prepare('UPDATE users SET ownership_checked=? WHERE id=?').bind(epoch()-86401,f.b.id).run();
  member=(await fetchJSON(f,f.a,'/api/members')).members.find(c=>c.id===101);assert.deepEqual(member.preferred_roles,[]);assert.equal(member.primary_role,null);
  assert.equal((await worker.fetch(f.b.request(path,payload()),f.env)).status,403);
});

test('an ownership or membership change between authorization and save cannot commit a stale declaration',async()=>{
  for(const change of ['link','membership','ownership']){
    const f=await fixture(),snapshot={id:f.a.id,ownership_checked:epoch(),characters:[{id:101}]};
    if(change==='link')await f.DB.prepare('UPDATE character_links SET user_id=? WHERE character_id=101').bind(f.b.id).run();
    if(change==='membership')await f.DB.prepare('DELETE FROM membership WHERE character_id=101').run();
    if(change==='ownership')await f.DB.prepare("UPDATE users SET ownership_status='unavailable' WHERE id=?").bind(f.a.id).run();
    await assert.rejects(saveRolePreferences(f.env,snapshot,payload()),error=>error.status===403);
    assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM character_role_preferences').first()).n,0);
  }
});
