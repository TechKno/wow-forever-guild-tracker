import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {bodyJSON,readLimitedText,digest,random,ORIGIN} from '../src/auth.mjs';
import worker from '../src/worker.mjs';
import {ensureDeploymentIdentity} from '../src/config.mjs';

function endlessBody(chunkSize=4096){
  const progress={pulled:0,cancelled:false};
  const body=new ReadableStream({
    pull(controller){progress.pulled++;controller.enqueue(new Uint8Array(chunkSize).fill(65));if(progress.pulled===100)controller.close();},
    cancel(){progress.cancelled=true;}
  });
  return {body,progress};
}
const streamed=(body,headers={})=>new Request(ORIGIN+'/api/hall/profile',{method:'POST',duplex:'half',headers,body});

test('JSON size limit cancels an oversized stream without Content-Length before draining it',async()=>{
  const {body,progress}=endlessBody(),request=streamed(body);
  assert.equal(request.headers.get('Content-Length'),null);
  await assert.rejects(()=>bodyJSON(request),error=>error.status===413);
  assert.equal(progress.cancelled,true);assert(progress.pulled<10,'oversized stream should be cancelled near the bound');
});

test('a false small Content-Length cannot bypass the streamed byte limit',async()=>{
  const {body,progress}=endlessBody();
  await assert.rejects(()=>bodyJSON(streamed(body,{'Content-Length':'1'})),error=>error.status===413);
  assert.equal(progress.cancelled,true);assert(progress.pulled<10);
});

test('a declared oversized body is cancelled without being drained',async()=>{
  const {body,progress}=endlessBody();
  await assert.rejects(()=>bodyJSON(streamed(body,{'Content-Length':'9000'})),error=>error.status===413);
  assert.equal(progress.cancelled,true);assert(progress.pulled<3);
});

test('JSON limits account for UTF-8 bytes while accepting the exact byte boundary',async()=>{
  const overhead=JSON.stringify({v:''}).length,value='a'.repeat(8192-overhead);
  assert.deepEqual(await bodyJSON(streamed(JSON.stringify({v:value}))),{v:value});
  await assert.rejects(()=>bodyJSON(streamed(JSON.stringify({v:value+'a'}))),error=>error.status===413);
  const unicode=JSON.stringify({v:'é'.repeat(4093)});
  assert(unicode.length<8192);assert(new TextEncoder().encode(unicode).byteLength>8192);
  await assert.rejects(()=>bodyJSON(streamed(unicode)),error=>error.status===413);
});

test('bounded text reading preserves UTF-8 characters split across stream chunks',async()=>{
  const bytes=new TextEncoder().encode('🙂x'),body=new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,2));controller.enqueue(bytes.slice(2));controller.close();}});
  assert.equal(await readLimitedText(streamed(body),5),'🙂x');
  await assert.rejects(()=>readLimitedText(streamed('🙂x'),4,'Small form limit'),error=>error.status===413&&error.message==='Small form limit');
});

function database(){
  const raw=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const writes=[];
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){writes.push(this.sql);return raw.prepare(this.sql).run(...this.params);}
  }
  return {writes,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}

test('oversized administrator refresh is cancelled with 413 before any database mutation',async()=>{
  const DB=database(),userId='bounded-admin',token=random(),csrf=random(),now=new Date().toISOString(),epoch=Math.floor(Date.now()/1000);
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare('INSERT INTO membership(generation,slug,character_id,data) VALUES(?,?,?,?)').bind('current','bounded-character',99,JSON.stringify({id:99,name:'Bounded Character',slug:'bounded-character',level:20})).run();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(userId,'bounded-fixture',99,'verified',epoch,now,now).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(99,userId,now).run();
  await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await digest(token),userId,csrf,epoch+3600).run();
  await ensureDeploymentIdentity({DB});
  DB.writes.length=0;
  const {body,progress}=endlessBody(600),request=new Request(ORIGIN+'/api/admin/refresh',{method:'POST',duplex:'half',headers:{Cookie:'__Host-wv_session='+token,Origin:ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body});
  const response=await worker.fetch(request,{DB,ADMIN_USER_IDS:userId});
  assert.equal(response.status,413);assert.equal((await response.json()).error,'Refresh request is too large');
  assert.equal(progress.cancelled,true);assert(progress.pulled<10);assert.deepEqual(DB.writes,[]);
});
