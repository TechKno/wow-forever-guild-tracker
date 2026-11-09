import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {startDemoServer} from '../scripts/preview-demo.mjs';
function get(url,{path='/',method='GET',host}={}){return new Promise((resolve,reject)=>{const base=new URL(url),req=request({hostname:base.hostname,port:base.port,path,method,headers:host?{Host:host}:{}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body}));});req.on('error',reject);req.end();});}
async function preview(run){const {server,url}=await startDemoServer({port:0});try{return await run({server,url});}finally{await new Promise(resolve=>server.close(resolve));}}
test('the screenshot preview binds only loopback, labels fictional pages and serves populated read-only fixture data',()=>preview(async({server,url})=>{
  assert.equal(server.address().address,'127.0.0.1');
  const page=await get(url,{path:'/guild'});assert.equal(page.status,200);assert.match(page.body,/Demo data · Fictional characters and activity · Read-only preview/);assert.match(page.body,/\/demo.css/);
  const roster=JSON.parse((await get(url,{path:'/api/members'})).body);assert(roster.members.length>=8);assert.equal(roster.demo,true);
  assert(roster.members.every(member=>member.preferred_roles.includes(member.primary_role)));
  const me=JSON.parse((await get(url,{path:'/api/me'})).body);assert.equal(me.user_id,'demo-tamsin');assert.equal(me.is_admin,false);
  const hall=JSON.parse((await get(url,{path:'/api/hall'})).body);assert(hall.events.length);assert(hall.requests.some(request=>request.materials?.components?.length));assert(hall.people.some(person=>person.display_name==='moss.and.moon'));
  const denied=await get(url,{path:'/api/hall/roles',method:'POST'});assert.equal(denied.status,400);assert.match(denied.body,/read-only/);
  assert.deepEqual(JSON.parse((await get(url,{path:'/api/members'})).body),roster,'A rejected write must not alter demo data');
  const login=await get(url,{path:'/auth/login'});assert.equal(login.status,200);assert.match(login.body,/No Battle.net or Discord account is connected/);assert.equal(login.headers.location,undefined);
}));
test('the screenshot server blocks project files, traversal, remote-host rebinding and custom bind addresses',async()=>{
  await assert.rejects(startDemoServer({host:'0.0.0.0',port:0}),/always binds/);
  await preview(async({url})=>{
    for(const path of ['/guild.config.json','/src/auth.mjs','/.env','/../.env','/assets/%2e%2e/%2e%2e/guild.config.json','/assets/..%2f..%2fpackage.json','//evil.example/path'])assert.notEqual((await get(url,{path})).status,200,path);
    assert.equal((await get(url,{path:'/api/me',host:'evil.example'})).status,403);
    const staticFile=await get(url,{path:'/assets/guild-logo.svg'});assert.equal(staticFile.status,200);assert.match(staticFile.headers['content-type'],/image\/svg\+xml/);
  });
});
test('demo requests do not read provider credentials or invoke provider fetches',async()=>{
  const originalFetch=globalThis.fetch,prior=process.env.BLIZZARD_CLIENT_SECRET;
  globalThis.fetch=()=>{throw Error('Provider fetches must never run in the screenshot preview');};process.env.BLIZZARD_CLIENT_SECRET='sentinel-demo-private';
  try{await preview(async({url})=>{for(const path of ['/api/status','/api/me','/api/hall','/api/history?character=105','/api/recipe/1001','/api/crafters/1001','/api/characters/105/talents']){const response=await get(url,{path});assert.equal(response.status,200,path);assert(!response.body.includes('sentinel-demo-private'));assert.equal(JSON.parse(response.body).demo,true);}});}
  finally{globalThis.fetch=originalFetch;prior===undefined?delete process.env.BLIZZARD_CLIENT_SECRET:process.env.BLIZZARD_CLIENT_SECRET=prior;}
});
