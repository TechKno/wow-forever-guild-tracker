import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,readdirSync,copyFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {execFile} from 'node:child_process';
import {openDatabase} from '../self-host/database.mjs';
import {createAssets,createLimiter,requestClientIP,createScheduledRunner,createRuntime,loadRuntimeSecrets} from '../self-host/runtime.mjs';
import {pinAdministrator} from '../self-host/admin.mjs';
import worker from '../src/worker.mjs';
import {CONFIG} from '../src/config.mjs';
import {digest,random} from '../src/auth.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),migrations=join(root,'migrations');
const cleanupTasks=new WeakMap();
const cleanup=(t,fn)=>cleanupTasks.get(t).push(fn);
function temporary(t){const directory=mkdtempSync(join(tmpdir(),'guild-selfhost-'));cleanupTasks.set(t,[]);t.after(async()=>{for(const task of cleanupTasks.get(t).reverse())await task();if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('guild-selfhost-'))throw Error('Unsafe test cleanup path');rmSync(directory,{recursive:true,force:true});});return directory;}

test('native storage applies migrations once, persists data and rolls back a failed D1 batch',async t=>{
  const directory=temporary(t),filename=join(directory,'guild.sqlite');let DB=openDatabase(filename,migrations);
  cleanup(t,()=>DB.close());
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM __guild_migrations').first()).n,readdirSync(migrations).filter(name=>name.endsWith('.sql')).length);
  await DB.prepare('INSERT INTO state VALUES(?,?)').bind('persistent','value').run();
  DB.raw.exec('CREATE TABLE binary_fixture(value BLOB)');
  await DB.prepare('INSERT INTO binary_fixture(value) VALUES(?)').bind(new Uint8Array([1,2,3,255]).buffer).run();
  assert.deepEqual(Array.from((await DB.prepare('SELECT value FROM binary_fixture').first()).value),[1,2,3,255]);
  await assert.rejects(DB.batch([DB.prepare('INSERT INTO state VALUES(?,?)').bind('rollback','value'),DB.prepare('INSERT INTO missing_table VALUES(1)')]));
  assert.equal(await DB.prepare("SELECT * FROM state WHERE key='rollback'").first(),null);
  DB.close();DB=openDatabase(filename,migrations);
  assert.equal(await DB.prepare("SELECT value FROM state WHERE key='persistent'").first('value'),'value');DB.close();
});

test('changed applied migrations fail closed instead of silently rewriting the database',t=>{
  const directory=temporary(t),copies=join(directory,'migrations');mkdirSync(copies);
  for(const name of readdirSync(migrations))copyFileSync(join(migrations,name),join(copies,name));
  const filename=join(directory,'guild.sqlite'),DB=openDatabase(filename,copies);DB.close();
  const first=readdirSync(copies).sort()[0];writeFileSync(join(copies,first),readFileSync(join(copies,first),'utf8')+'\n-- changed');
  assert.throws(()=>openDatabase(filename,copies),/applied migration changed/);
});

test('asset binding rejects hidden files, decoded traversal and links outside its root',async t=>{
  const directory=temporary(t),assets=join(directory,'public'),outside=join(directory,'outside');mkdirSync(assets);mkdirSync(outside);
  writeFileSync(join(assets,'index.html'),'safe page');writeFileSync(join(assets,'.env'),'private sentinel');writeFileSync(join(outside,'private.txt'),'private sentinel');
  const binding=createAssets(assets);
  assert.equal(await (await binding.fetch(new Request(CONFIG.site.origin+'/index.html'))).text(),'safe page');
  for(const path of ['/.env','/%2eenv','/%2f..%2foutside/private.txt','/missing.html','/C:/private.txt'])assert.equal((await binding.fetch(new Request(CONFIG.site.origin+path))).status,404);
  try{symlinkSync(outside,join(assets,'linked'),process.platform==='win32'?'junction':'dir');assert.equal((await binding.fetch(new Request(CONFIG.site.origin+'/linked/private.txt'))).status,404);}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;t.diagnostic('This host cannot create symlinks; that platform-specific assertion was unavailable.');}
});

test('self-hosted limiters stay bounded and forwarding headers cannot bypass the trusted-hop rule',async()=>{
  let time=0;const limiter=createLimiter(2,{periodMs:100,maxKeys:2,now:()=>time});
  assert.equal((await limiter.limit({key:'first'})).success,true);assert.equal((await limiter.limit({key:'first'})).success,true);assert.equal((await limiter.limit({key:'first'})).success,false);
  await limiter.limit({key:'second'});assert.equal((await limiter.limit({key:'third'})).success,false);
  time=101;assert.equal((await limiter.limit({key:'third'})).success,true);
  const input={socket:{remoteAddress:'::ffff:203.0.113.10'},headers:{'cf-connecting-ip':'192.0.2.1','x-guild-client-ip':'192.0.2.2','x-forwarded-for':'192.0.2.3'}};
  assert.equal(requestClientIP(input,new Set(['172.30.0.2'])),'203.0.113.10');
  input.socket.remoteAddress='172.30.0.2';assert.equal(requestClientIP(input,new Set(['172.30.0.2'])),'192.0.2.2');
  input.headers['x-guild-client-ip']='untrusted text';assert.equal(requestClientIP(input,new Set(['172.30.0.2'])),'172.30.0.2');
});

test('the scheduled runner awaits background work and prevents overlapping refreshes',async()=>{
  let finish,calls=0;const blocked=new Promise(resolveTask=>finish=resolveTask),fake={scheduled(_event,_env,context){calls++;context.waitUntil(blocked);}};
  const runner=createScheduledRunner(fake,{}),first=runner.run();assert.deepEqual(await runner.run(),{skipped:true});assert.equal(calls,1);
  finish();assert.deepEqual(await first,{skipped:false});assert.deepEqual(await runner.run(),{skipped:false});assert.equal(calls,2);await runner.stop();
  const failures=[],failing=createScheduledRunner({scheduled(){throw Error('private error sentinel');}},{},{onError:value=>failures.push(value)});failing.start();await new Promise(resolveTask=>setImmediate(resolveTask));await failing.stop();assert.deepEqual(failures,['Scheduled refresh failed.']);
});

test('runtime credentials read private files and administrator provisioning still requires a current verified owner',async t=>{
  const directory=temporary(t),credential=join(directory,'credential');writeFileSync(credential,'fixture credential\n');
  assert.equal(loadRuntimeSecrets({BLIZZARD_CLIENT_SECRET_FILE:credential},directory).BLIZZARD_CLIENT_SECRET,'fixture credential');
  assert.throws(()=>loadRuntimeSecrets({BLIZZARD_CLIENT_SECRET:'fixture',BLIZZARD_CLIENT_SECRET_FILE:credential},directory));
  const DB=openDatabase(join(directory,'guild.sqlite'),migrations);cleanup(t,()=>DB.close());
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now=new Date().toISOString();
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',unixepoch(),?,?)").bind(id,'fixture-subject',101,now,now).run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','alex-example',101,JSON.stringify({id:101,name:'Alex Example'})).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(101,id,now).run();
  pinAdministrator(DB,'alex-example',directory);assert.equal(readFileSync(join(directory,'admin-user-ids'),'utf8').trim(),id);
  assert.equal(loadRuntimeSecrets({},directory).ADMIN_USER_IDS,id);
  await DB.prepare("UPDATE users SET ownership_checked=unixepoch()-86401 WHERE id=?").bind(id).run();
  assert.throws(()=>pinAdministrator(DB,'alex-example',directory));
});

test('native HTTP hosting preserves Worker membership/CSRF protections and enforces host/body boundaries',async t=>{
  const directory=temporary(t),DB=openDatabase(join(directory,'guild.sqlite'),migrations),runtime=createRuntime({worker,DB,publicDirectory:join(root,'public'),origins:[CONFIG.site.origin,...CONFIG.site.additionalOrigins],secrets:{BLIZZARD_CLIENT_ID:'fixture-client',BLIZZARD_CLIENT_SECRET:'fixture-secret'}});
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  cleanup(t,async()=>{runtime.server.closeAllConnections();await new Promise(resolveClose=>runtime.server.close(resolveClose));await runtime.scheduler.stop();DB.close();});
  const base='http://127.0.0.1:'+runtime.server.address().port,host=new URL(CONFIG.site.origin).host;
  const request=(path,options={})=>new Promise((resolveResponse,reject)=>{
    const input=httpRequest(base+path,{method:options.method||'GET',headers:{Host:host,...options.headers}},result=>{
      const body=[],headers=new Headers();for(let index=0;index<result.rawHeaders.length;index+=2)headers.append(result.rawHeaders[index],result.rawHeaders[index+1]);
      result.on('data',chunk=>body.push(chunk));result.on('error',reject);result.on('end',()=>resolveResponse(new Response(Buffer.concat(body),{status:result.statusCode,headers})));
    });input.on('error',reject);input.end(options.body);
  });
  assert.equal((await request('/healthz')).status,200);
  await new Promise((resolveCheck,reject)=>execFile(process.execPath,[join(root,'self-host','healthcheck.mjs')],{env:{...process.env,PORT:String(runtime.server.address().port)},timeout:6000},error=>error?reject(error):resolveCheck()));
  assert.equal((await request('/api/public')).status,200);
  assert.equal((await request('/api/members')).status,401);
  assert.equal((await request('/app.js')).status,401);
  assert.equal((await request('/guild')).status,303);
  assert.equal((await request('/healthz',{headers:{Host:'attacker.example','X-Forwarded-Host':host}})).status,400);
  assert.equal((await request('/healthz',{headers:{'X-Forwarded-Host':'attacker.example','CF-Connecting-IP':'192.0.2.9'}})).status,200);
  assert.equal((await request('/api/hall/roles',{method:'POST',body:'x'.repeat(65537)})).status,413);
  assert.equal((await request('/api/gallery',{method:'POST',body:'x'.repeat(65537)})).status,401,'Gallery-sized bodies reach the membership gate');
  assert.equal((await request('/api/gallery',{method:'POST',body:'x'.repeat(1500001)})).status,413);
  const login=await request('/auth/login');assert.equal(login.status,303);assert(login.headers.getSetCookie().length>0);assert.equal(new URL(login.headers.get('location')).searchParams.get('redirect_uri'),CONFIG.site.origin+'/auth/callback');
  const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token=random(),csrf='fixture-csrf',now=new Date().toISOString();
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare("INSERT INTO users VALUES(?,?,?,'verified',unixepoch(),?,?)").bind(id,'http-fixture-subject',101,now,now).run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','alex-example',101,JSON.stringify({id:101,name:'Alex Example',slug:'alex-example',class:'Druid',level:20})).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(101,id,now).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,unixepoch()+3600)').bind(await digest(token),id,csrf).run();
  const cookie='__Host-wv_session='+token,payload=JSON.stringify({character_id:101,preferred_roles:['Healer','Damage'],primary_role:'Healer'});
  assert.equal((await request('/api/members',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await request('/api/hall/roles',{method:'POST',headers:{Cookie:cookie,Origin:CONFIG.site.origin,'Content-Type':'application/json'},body:payload})).status,403);
  assert.equal((await request('/api/hall/roles',{method:'POST',headers:{Cookie:cookie,Origin:CONFIG.site.origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:payload})).status,200);
  assert.equal((await DB.prepare('SELECT primary_role FROM character_role_preferences WHERE character_id=101').first()).primary_role,'Healer');
});
