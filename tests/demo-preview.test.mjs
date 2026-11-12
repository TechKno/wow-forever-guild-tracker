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
  const me=JSON.parse((await get(url,{path:'/api/me'})).body);assert.equal(me.user_id,'demo-tamsin');assert.equal(me.is_admin,true);assert.equal(me.demo,true);assert.equal(me.csrf,'demo-read-only');assert.equal(me.characters.length,4);assert.equal(me.characters.filter(c=>c.show_as_alt).length,3);assert.equal(me.discord.linked,true);
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
  try{await preview(async({url})=>{for(const path of ['/api/status','/api/me','/api/hall','/api/history?character=105','/api/recipe/1001','/api/crafters/1001','/api/characters/105/talents','/api/characters/105/armory','/api/admin/overview','/api/guild/ranks','/api/admin/status','/api/evidence','/api/admin/discord','/api/admin/character-mappings']){const response=await get(url,{path});assert.equal(response.status,200,path);assert(!response.body.includes('sentinel-demo-private'));assert.equal(JSON.parse(response.body).demo,true);}});}
  finally{globalThis.fetch=originalFetch;prior===undefined?delete process.env.BLIZZARD_CLIENT_SECRET:process.env.BLIZZARD_CLIENT_SECRET=prior;}
});
test('the expanded interface preview serves fictional armory, administrator history and rank fixtures while every write remains disabled',()=>preview(async({url})=>{
  const admin=JSON.parse((await get(url,{path:'/api/admin/overview'})).body),roster=JSON.parse((await get(url,{path:'/api/members'})).body);assert.equal(admin.counts.characters,roster.members.length);assert(admin.imports.some(row=>row.left>0));assert(admin.imports.some(row=>row.joined>0));assert.match(admin.import_history_note,/Fictional/);
  const ranks=JSON.parse((await get(url,{path:'/api/guild/ranks'})).body);assert.equal(ranks.labels[0],'Guildmaster');assert.equal(ranks.ranks.length,10);
  const armory=JSON.parse((await get(url,{path:'/api/characters/105/armory'})).body);assert.equal(armory.character_id,105);assert(armory.sections.equipment.data.items.length>=4);assert(armory.sections.statistics.data.values.length>=4);assert.match(armory.note,/fictional/);
  const media=await get(url,{path:armory.sections.media.data.assets[0].url});assert.equal(media.status,200);assert.match(media.headers['content-type'],/image\/svg\+xml/);assert.match(media.body,/FICTIONAL DEMO PORTRAIT/);assert.doesNotMatch(media.body,/<script|(?:href|src)=["']https?:/);
  for(const path of ['/api/characters/999/armory','/api/characters/999/armory/media/main'])assert.equal((await get(url,{path})).status,404);
  for(const path of ['/api/admin/ranks','/api/admin/refresh','/api/hall/main','/api/hall/discord']){const result=await get(url,{path,method:'POST'});assert.equal(result.status,400);assert.match(result.body,/read-only/);}
  for(const path of ['/account.js','/admin-overview.js','/armory.js','/hierarchy.js','/gallery.js'])assert.equal((await get(url,{path})).status,200);
}));

test('gallery previews use clearly fictional illustrations and reject uploads or moderation',()=>preview(async({url})=>{
  const gallery=JSON.parse((await get(url,{path:'/api/gallery'})).body);assert.equal(gallery.demo,true);assert.equal(gallery.items.length,3);
  const image=await get(url,{path:gallery.items[0].thumbnail_url});assert.equal(image.status,200);assert.match(image.body,/FICTIONAL GALLERY PREVIEW/);assert.doesNotMatch(image.body,/<script|(?:href|src)=["']https?:/);
  assert.deepEqual(JSON.parse((await get(url,{path:'/api/gallery?removed=1'})).body).items,[]);
  for(const path of ['/api/gallery',`/api/gallery/${gallery.items[0].id}/remove`])assert.equal((await get(url,{path,method:'POST'})).status,400);
}));

test('the instance guide preview uses the sourced catalogue without creating events',()=>preview(async({url})=>{
  const guide=JSON.parse((await get(url,{path:'/api/event-templates'})).body);assert.equal(guide.templates.length,38);assert.equal(guide.templates.filter(row=>row.kind==='Dungeon').length,35);assert.equal(guide.templates.filter(row=>row.kind==='Raid'&&row.status==='announced').length,3);
  assert(guide.templates.every(row=>row.minimum_level===null&&row.sources.length));
  assert.equal((await get(url,{path:'/api/event-templates',method:'POST'})).status,400);
  assert.deepEqual(JSON.parse((await get(url,{path:'/api/hall'})).body).events.map(row=>row.id),['demo-ended','demo-deadmines','demo-cancelled']);
}));
