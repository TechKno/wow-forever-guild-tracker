import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {guildRanks,validateRankLabels} from '../src/guild-ranks.mjs';
import {random,digest,ORIGIN} from '../src/auth.mjs';
async function fixture(){
  const raw=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  class Statement{constructor(sql,values=[]){this.sql=sql;this.values=values;}bind(...v){return new Statement(this.sql,v);}async first(){return raw.prepare(this.sql).get(...this.values)||null;}async all(){return {results:raw.prepare(this.sql).all(...this.values)};}async run(){return raw.prepare(this.sql).run(...this.values);}}
  const DB={prepare:sql=>new Statement(sql)},env={DB,ADMIN_USER_IDS:'admin'},at=new Date().toISOString(),now=Math.floor(Date.now()/1000),sessions={};
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(const [index,id]of ['admin','member'].entries()){
    const cid=101+index,token=random(),csrf=random();
    await DB.prepare('INSERT INTO users(id,subject_hash,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id,'subject-'+id,'verified',now,at,at).run();
    await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(cid,id,at).run();
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','test-'+id,cid,JSON.stringify({id:cid,name:'Test '+id,slug:'test-'+id,rank:index?3:0,level:12})).run();
    await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,now+3600).run();sessions[id]={token,csrf};
  }
  const request=(id,labels,csrf=sessions[id]?.csrf)=>new Request(ORIGIN+(labels===undefined?'/api/guild/ranks':'/api/admin/ranks'),{method:labels===undefined?'GET':'POST',headers:{Cookie:sessions[id]?'__Host-wv_session='+sessions[id].token:'',Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrf||''},body:labels===undefined?undefined:JSON.stringify({labels})});
  return {DB,env,request};
}
test('guild members receive suggested rank names and current counts; labels can only be changed by the pinned administrator',async()=>{
  const f=await fixture();let data=await guildRanks(f.request('member'),f.env);assert.equal(data.labels[0],'Guildmaster');assert.equal(data.labels[3],'Member');assert.equal(data.source,'suggested');assert.deepEqual(data.ranks.map(r=>[r.rank,r.count]),[[0,1],[3,1]]);
  await assert.rejects(()=>guildRanks(f.request('member',{'0':'Keeper'}),f.env),error=>error.status===403);
  await assert.rejects(()=>guildRanks(f.request('admin',{'0':'Keeper'},'bad'),f.env),error=>error.status===403);
  data=await guildRanks(f.request('admin',{'0':'Keeper','3':'Adventurer'}),f.env);assert.equal(data.source,'custom');assert.equal((await guildRanks(f.request('member'),f.env)).ranks[0].name,'Keeper');
});
test('anonymous and departed accounts cannot read or edit rank configuration',async()=>{
  const f=await fixture();await assert.rejects(()=>guildRanks(f.request('anonymous'),f.env),error=>error.status===401);
  await f.DB.prepare('DELETE FROM membership WHERE character_id=102').run();await assert.rejects(()=>guildRanks(f.request('member'),f.env),error=>error.status===403);
});
test('rank labels remain bounded display names and cannot submit invalid rank indexes or change website access',()=>{
  for(const value of [null,[],{'-1':'Rank'},{'100':'Rank'},{'01':'Rank'},{'0':''},{'0':'a'.repeat(41)},{'0':'a\nb'}])assert.throws(()=>validateRankLabels(value));
  assert.deepEqual(validateRankLabels({'1':' Officer '}),{'1':'Officer'});
});
