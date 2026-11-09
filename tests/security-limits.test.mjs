import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {enforceRate,protectEntry,protectMember} from '../src/security.mjs';
import {ORIGIN,LEGACY_ORIGIN} from '../src/auth.mjs';

const deny={async limit(){return {success:false};}};
const noDB={prepare(){throw Error('Rate-limited requests must not access the database');}};
test('sign-in throttles before creating OAuth state or making provider calls',async()=>{
  for(const site of [ORIGIN,LEGACY_ORIGIN]){
    const r=await worker.fetch(new Request(site+'/auth/login'),{AUTH_RATE:deny,DB:noDB});
    assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');assert.equal(r.headers.get('Set-Cookie'),null);assert.equal(r.headers.get('Location'),null);
    assert(!('access_required' in await r.json()));
  }
});
test('anonymous API abuse throttles before session and published-roster queries',async()=>{
  for(const path of ['/api/members','/api/public','/api/recipe/2330','/app.js','/guild','/made-up-private-path']){
    const r=await worker.fetch(new Request(ORIGIN+path,{headers:{Cookie:'__Host-wv_session='+'x'.repeat(43)}}),{API_RATE:deny,DB:noDB});
    assert.equal(r.status,429);assert.match(r.headers.get('Cache-Control'),/no-store/);
  }
});
test('production fails closed if a required rate limiter is absent or fails',async()=>{
  for(const AUTH_RATE of [undefined,{async limit(){throw Error('outage');}},{async limit(){return {};}}]){
    const r=await worker.fetch(new Request(ORIGIN+'/auth/login'),{SECURITY_LIMITS_REQUIRED:'true',AUTH_RATE,DB:noDB});assert.equal(r.status,503);assert.equal(r.headers.get('Set-Cookie'),null);
  }
  await assert.rejects(enforceRate({SECURITY_LIMITS_REQUIRED:'true'},'WRITE_RATE','member'),e=>e.status===503);
});
test('IP protection keys are hashed and shared across the two approved hosts',async()=>{
  const keys=[],env={AUTH_RATE:{async limit(input){keys.push(input.key);return {success:true};}}};
  for(const site of [ORIGIN,LEGACY_ORIGIN])await protectEntry(new Request(site+'/auth/login',{headers:{'CF-Connecting-IP':'192.0.2.44'}}),env);
  assert.equal(keys[0],keys[1]);assert.match(keys[0],/^[A-Za-z0-9_-]{43}$/);assert(!keys[0].includes('192.0.2.44'));
  await protectEntry(new Request(ORIGIN+'/auth/login',{headers:{'CF-Connecting-IP':'192.0.2.45'}}),env);assert.notEqual(keys[0],keys[2]);
});
test('member writes and provider lookups use account identity rather than session or character',async()=>{
  const writes=[],lookups=[],env={WRITE_RATE:{async limit(v){writes.push(v.key);return {success:true};}},LOOKUP_RATE:{async limit(v){lookups.push(v.key);return {success:true};}}};
  for(const token_hash of ['first-session','new-session']){
    const user={id:'same-account',token_hash};
    await protectMember(new Request(ORIGIN+'/api/hall/request',{method:'POST'}),env,user);
    await protectMember(new Request(ORIGIN+'/api/recipe/2330'),env,user);
  }
  await protectMember(new Request(ORIGIN+'/api/members'),env,{id:'same-account'});
  assert.deepEqual(writes,['same-account','same-account']);assert.deepEqual(lookups,['same-account','same-account']);
  await assert.rejects(protectMember(new Request(ORIGIN+'/api/hall/request',{method:'POST'}),{WRITE_RATE:deny},{id:'member'}),e=>e.status===429);
  await assert.rejects(protectMember(new Request(ORIGIN+'/api/quests/compare?area=1&character=1'),{LOOKUP_RATE:deny},{id:'member'}),e=>e.status===429);
});
test('the public introduction and assets remain available without spending API/sign-in quotas',async()=>{
  const env={AUTH_RATE:deny,API_RATE:deny,DB:noDB,ASSETS:{async fetch(){return new Response('welcome');}}};
  const r=await worker.fetch(new Request(ORIGIN+'/'),env);assert.equal(r.status,200);assert.equal(await r.text(),'welcome');
  assert.equal(r.headers.get('Strict-Transport-Security'),'max-age=31536000');assert.equal(r.headers.get('X-Frame-Options'),'DENY');assert.equal(r.headers.get('Cross-Origin-Opener-Policy'),'same-origin');
});
test('the deployed configuration requires distinct bounded production rate-limit bindings',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.vars.SECURITY_LIMITS_REQUIRED,'true');assert.equal(config.ratelimits.length,4);assert.equal(new Set(config.ratelimits.map(v=>v.namespace_id)).size,4);
  assert.equal(config.preview_urls,false);
  assert.deepEqual(Object.fromEntries(config.ratelimits.map(v=>[v.name,v.simple])),{AUTH_RATE:{limit:10,period:60},API_RATE:{limit:180,period:60},WRITE_RATE:{limit:20,period:60},LOOKUP_RATE:{limit:30,period:60}});
});
test('both approved sites upgrade HTTP before reading or accepting private data',async()=>{
  for(const site of [ORIGIN,LEGACY_ORIGIN]){
    const path='/api/hall/request?example=value',r=await worker.fetch(new Request(site.replace('https:','http:')+path,{method:'POST',body:'{}'}),{DB:noDB});
    assert.equal(r.status,308);assert.equal(r.headers.get('Location'),site+path);assert.equal(r.headers.get('Set-Cookie'),null);assert.equal(await r.text(),'');
  }
});
