import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {galleryRoute,normalizeGalleryJPEG,GALLERY_LIMITS} from '../src/gallery.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

const jpeg='/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCEAnAv/9k=';
const bytes=()=>new Uint8Array(Buffer.from(jpeg,'base64')),epoch=()=>Math.floor(Date.now()/1000),photo=()=>({title:'A guild adventure',caption:'An evening at the inn.',image_base64:jpeg,thumbnail_base64:jpeg});
function database(){
  const raw=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  let hook=null;
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params.map(value=>value instanceof ArrayBuffer?new Uint8Array(value):value));}
    async before(){if(hook)await hook(this.sql);}
    async first(){await this.before();return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){await this.before();return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){await this.before();return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),hook:value=>{hook=value;}};
}
async function fixture(){
  const DB=database(),at=new Date().toISOString(),actors={};DB.raw.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  for(const [name,id]of [['owner',71],['other',72],['admin',73]]){
    const token=random(),userId=name+'-user';
    DB.raw.prepare('INSERT INTO membership VALUES(?,?,?,?)').run('current',name+'-character',id,JSON.stringify({id,name:name+' Character',slug:name+'-character',level:20}));
    DB.raw.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId,name+'-subject',id,'verified',epoch(),at,at);
    DB.raw.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').run(id,userId,at);
    DB.raw.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await digest(token),userId,name+'-csrf',epoch()+3600);actors[name]={token,userId,id};
  }
  const env={DB,ADMIN_USER_IDS:'admin-user'};
  const request=(path='/api/gallery',method='GET',body=null,actor='owner',extra={})=>new Request(ORIGIN+path,{method,headers:{Cookie:'__Host-wv_session='+actors[actor].token,...(method==='POST'?{Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':actor+'-csrf'}:{}),...extra},...(body!==null?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  return {DB,env,actors,request,call:(...args)=>galleryRoute(request(...args),env)};
}
function seed(f,{id=crypto.randomUUID(),author='owner-user',at='2020-01-01T08:00:00.000Z',removed=null,size=bytes().length*2}={}){
  f.DB.raw.prepare('INSERT INTO gallery_photos VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,author,'Fictional member','A screenshot','Fictional caption',at,2,2,bytes(),bytes(),size,removed);return id;
}

test('gallery requires current verified membership for lists, uploads and every image route',async()=>{
  const f=await fixture(),id=seed(f);
  for(const path of ['/api/gallery','/api/gallery/'+id+'/image','/api/gallery/'+id+'/thumbnail'])await assert.rejects(galleryRoute(new Request(ORIGIN+path),f.env),error=>error.status===401);
  f.DB.raw.prepare('DELETE FROM membership WHERE character_id=71').run();
  for(const args of [[],['/api/gallery','POST',photo()],['/api/gallery/'+id+'/image']])await assert.rejects(f.call(...args),error=>error.status===403);
  assert.equal(f.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,1);
});

test('gallery uploads validate the JPEG, remove metadata and return only safe member-facing details',async()=>{
  const f=await fixture(),payload=photo(),raw=bytes(),secret=Buffer.from('GPS fixture-location filename-original.jpg'),segment=Buffer.concat([Buffer.from([255,225,0,secret.length+2]),secret]);
  payload.image_base64=Buffer.concat([raw.subarray(0,2),segment,raw.subarray(2)]).toString('base64');
  f.env.DISCORD_GUILD_ID='123456789012345678';
  f.DB.raw.prepare('INSERT INTO discord_links VALUES(?,?,?,?,?)').run('owner-user','123456789012345679',0,0,new Date().toISOString());
  f.DB.raw.prepare('INSERT INTO discord_profiles(guild_id,discord_id,nickname) VALUES(?,?,?)').run(f.env.DISCORD_GUILD_ID,'123456789012345679','Friendly Crafter');
  const result=await f.call('/api/gallery','POST',payload);assert(result.ok);assert.equal(result.item.author_name,'Friendly Crafter');assert.equal(result.item.width,2);assert.equal(result.item.height,2);assert(result.item.can_manage);
  assert.equal(result.item.image_url,'/api/gallery/'+result.item.id+'/image');
  const row=f.DB.raw.prepare('SELECT * FROM gallery_photos WHERE id=?').get(result.item.id);assert(!Buffer.from(row.image).includes(secret));assert.deepEqual(row.image,bytes());
  const json=JSON.stringify(result);for(const hidden of ['owner-user','123456789012345679','image_base64','GPS fixture-location'])assert(!json.includes(hidden));
});

test('the image validator rejects active formats, invalid markers, missing endings and oversized dimensions',()=>{
  assert.equal(normalizeGalleryJPEG(bytes(),750000,1600).width,2);
  for(const input of [new TextEncoder().encode('<svg/>'),bytes().slice(0,-2),new Uint8Array([...bytes(),0]),new Uint8Array([255,216,255,225,255,255,...bytes()])])assert.throws(()=>normalizeGalleryJPEG(input,750000,1600));
  const oversized=bytes(),start=oversized.findIndex((value,index)=>value===255&&oversized[index+1]===192);oversized[start+5]=6;oversized[start+6]=65;
  assert.throws(()=>normalizeGalleryJPEG(oversized,750000,1600));assert.throws(()=>normalizeGalleryJPEG(bytes(),100,1600));
});

test('uploads are bounded, CSRF-protected and reject malformed forms before publishing',async()=>{
  const f=await fixture();
  for(const extra of [{'X-CSRF-Token':'wrong'},{Origin:'https://evil.example'},{'Content-Type':'image/jpeg'}])await assert.rejects(f.call('/api/gallery','POST',photo(),'owner',extra),error=>[403,415].includes(error.status));
  for(const body of [[],{...photo(),title:''},{...photo(),title:'x'.repeat(81)},{...photo(),caption:'x'.repeat(501)},{...photo(),image_base64:'https://evil.example/picture.jpg'},{...photo(),thumbnail_base64:Buffer.from('<svg/>').toString('base64')}])await assert.rejects(f.call('/api/gallery','POST',body),error=>error.status===400);
  await assert.rejects(f.call('/api/gallery','POST','{}','owner',{'Content-Length':'1500001'}),error=>error.status===413);
  assert.equal(f.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,0);
});

test('gallery pagination is stable with tied timestamps and removed images are not in active results',async()=>{
  const f=await fixture(),ids=[];for(let i=0;i<25;i++)ids.push(seed(f));seed(f,{removed:new Date().toISOString()});
  const first=await f.call(),second=await f.call('/api/gallery?cursor='+first.next);assert.equal(first.items.length,20);assert.equal(second.items.length,5);assert.equal(second.next,null);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,25);assert(!first.items.some(item=>item.removed));assert(first.can_upload);
  await assert.rejects(f.call('/api/gallery?cursor=invalid'),error=>error.status===400);
  const removed=await f.call('/api/gallery?removed=1');assert.equal(removed.items.length,1);assert(removed.items[0].removed);
});

test('members can manage only their own screenshots and admins can moderate and restore any',async()=>{
  const f=await fixture(),id=seed(f),other=seed(f,{author:'other-user'});
  await assert.rejects(f.call('/api/gallery/'+other+'/remove','POST',{}),error=>error.status===404);
  await f.call('/api/gallery/'+id+'/remove','POST',{});assert.equal((await f.call()).items.length,1);
  for(const type of ['image','thumbnail'])await assert.rejects(f.call('/api/gallery/'+id+'/'+type),error=>error.status===404);
  assert.equal((await f.call('/api/gallery?removed=1','GET',null,'other')).items.length,0);
  assert.equal((await f.call('/api/gallery?removed=1','GET',null,'admin')).items.length,1);
  await f.call('/api/gallery/'+id+'/restore','POST',{},'admin');assert.equal((await f.call()).items.length,2);
  const others=await f.call('/api/gallery','GET',null,'other');assert.equal(others.items.find(item=>item.id===id).can_manage,false);
  const mine=await f.call('/api/gallery?mine=1');assert.deepEqual(mine.items.map(item=>item.id),[id]);
});

test('stored screenshots support D1 arrays and retain private image delivery headers',async()=>{
  const f=await fixture(),id=seed(f),prepare=f.DB.prepare;f.DB.prepare=sql=>{
    const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...params)=>{const bound=bind(...params),first=bound.first.bind(bound);bound.first=async()=>{const row=await first();if(row?.bytes)row.bytes=Array.from(row.bytes);return row;};return bound;};return statement;
  };
  const response=await f.call('/api/gallery/'+id+'/image');assert(response instanceof Response);assert.equal(response.headers.get('Content-Type'),'image/jpeg');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('Vary'),'Cookie');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes());
});

test('membership revocation during upload or image loading fails closed',async()=>{
  const f=await fixture();let revoked=false;
  f.DB.hook(sql=>{if(!revoked&&sql.startsWith('INSERT INTO gallery_photos')){revoked=true;f.DB.raw.prepare('DELETE FROM membership WHERE character_id=71').run();}});
  await assert.rejects(f.call('/api/gallery','POST',photo()),error=>error.status===403);assert.equal(f.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,0);
  const g=await fixture(),id=seed(g);let deleted=false;g.DB.hook(sql=>{if(!deleted&&sql.startsWith('SELECT image bytes')){deleted=true;g.DB.raw.prepare('DELETE FROM membership WHERE character_id=71').run();}});
  await assert.rejects(g.call('/api/gallery/'+id+'/image'),error=>error.status===403);
});

test('daily and gallery quotas include removed records and cannot be bypassed with a stale client',async()=>{
  const f=await fixture(),today=new Date().toISOString();for(let i=0;i<10;i++)seed(f,{at:today,removed:i%2?today:null});
  assert.equal((await f.call()).can_upload,false);await assert.rejects(f.call('/api/gallery','POST',photo()),error=>error.status===429&&/10 screenshots/.test(error.message));assert.equal(f.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,10);
  const g=await fixture();for(let i=0;i<GALLERY_LIMITS.max_photos;i++)seed(g,{author:'other-user',removed:i%2?today:null});
  await assert.rejects(g.call('/api/gallery','POST',photo()),error=>error.status===429&&/storage limit/.test(error.message));assert.equal(g.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,200);
  const h=await fixture();for(let i=0;i<125;i++)seed(h,{author:'other-user',size:800000});
  await assert.rejects(h.call('/api/gallery','POST',photo()),error=>error.status===429);assert.equal(h.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,125);
});

test('concurrent uploads compete atomically for the last available gallery place',async()=>{
  const f=await fixture();for(let i=0;i<199;i++)seed(f,{author:'other-user'});
  const results=await Promise.allSettled([f.call('/api/gallery','POST',photo()),f.call('/api/gallery','POST',photo())]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.status===429).length,1);
  assert.equal(f.DB.raw.prepare('SELECT COUNT(*) total FROM gallery_photos').get().total,200);
});
