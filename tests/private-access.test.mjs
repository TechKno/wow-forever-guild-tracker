import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

const epoch=()=>Math.floor(Date.now()/1000),PRIVATE='PRIVATE LEDGER: Secret Guildcharacter · Engineering · Fine Widget',WELCOME='PUBLIC WELCOME';
function database(){
  const raw=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url),queries=[];
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL(name,directory),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){queries.push(this.sql);return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){queries.push(this.sql);return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){queries.push(this.sql);return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,queries,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),at='2026-11-08T12:34:56.000Z',assets=[];
  await DB.prepare("UPDATE sync SET published='current',roster_at=?,status='partial',message='Private diagnostic',total=999 WHERE id=1").bind(at).run();
  for(const [id,name,generation]of [[101,'Secret Guildcharacter','current'],[102,'Another Character','current'],[103,'Former Character','previous'],[104,'Stale Ownership','current'],[105,'Admin Mapped Character','current']]){
    const member={id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:'Mage',class_id:8,level:20};
    await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind(generation,member.slug,id,JSON.stringify(member)).run();
    await DB.prepare('INSERT INTO characters VALUES(?,?,?)').bind(id,JSON.stringify({profile:{level:20},professions:[{name:'Engineering',recipes:[{id:100,name:'Fine Widget'}]}]}),at).run();
  }
  const env={DB,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;assets.push({path,method:request.method});const text=path==='/welcome.html'?WELCOME:path==='/privacy.html'?'PUBLIC PRIVACY':path.startsWith('/welcome.')||['/assets/guild-banner.svg','/assets/guild-logo.svg','/privacy.css'].includes(path)?'PUBLIC ASSET':PRIVATE;return new Response(text,{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html','Cache-Control':'public,max-age=86400'}});}}};
  async function user(id,char,{checked=epoch(),status='verified',expires=epoch()+3600}={}){
    const token=random(),csrf=random();await DB.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').bind(id,'subject-'+id,char,status,checked,at,at).run();
    if(char)await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(char,id,at).run();
    await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),id,csrf,expires).run();
    return {id,token,csrf,request(path,options={}){return new Request(ORIGIN+path,{...options,headers:{Cookie:'__Host-wv_session='+token,...options.headers}});}};
  }
  const member=await user('member',101),admin=await user('admin',102),stale=await user('stale',104,{checked:epoch()-86410}),nonmember=await user('nonmember',null),former=await user('former',103),expired=await user('expired',null,{expires:epoch()-1}),mapped=await user('mapped',105,{status:'admin_mapped'});
  env.ADMIN_USER_IDS='admin,nonmember';DB.queries.length=0;
  return {env,DB,assets,at,member,admin,stale,nonmember,former,expired,mapped};
}
const anonymous=(path,options={})=>new Request(ORIGIN+path,options);
function privateHeaders(response){assert.match(response.headers.get('Cache-Control')||'',/no-store/);assert.match(response.headers.get('Vary')||'',/(?:^|,)\s*Cookie\s*(?:,|$)/i);}
async function withoutNetwork(run){const original=globalThis.fetch,calls=[];globalThis.fetch=async(...args)=>{calls.push(args);throw Error('Unauthorised requests must not reach a provider');};try{await run(calls);assert.equal(calls.length,0);}finally{globalThis.fetch=original;}}

test('the public landing paths always serve the welcome page without inspecting sessions or returning the private app',async()=>{
  const f=await fixture();
  for(const path of ['/','/index.html','/welcome.html'])for(const request of [anonymous(path),f.member.request(path),f.nonmember.request(path)]){
    const before=f.DB.queries.length,response=await worker.fetch(request,f.env);assert.equal(response.status,200);assert.equal(await response.text(),WELCOME);assert.equal(f.assets.at(-1).path,'/welcome.html');assert.equal(f.DB.queries.length,before);
  }
});

test('the only public guild summary is a minimal count of the published roster, not the sync total or character data',async()=>{
  const f=await fixture();await withoutNetwork(async()=>{
    const response=await worker.fetch(anonymous('/api/public'),f.env),data=await response.json();assert.equal(response.status,200);
    assert.deepEqual(data,{guild_name:'Example Guild',region:'EU',ruleset:'Roleplay',game:'World of Warcraft Forever',member_count:4,roster_member_count:4,profile_verified_count:0,roster_observed_at:f.at});
    assert(!JSON.stringify(data).includes('Secret'));assert(!JSON.stringify(data).includes('diagnostic'));
    await f.DB.prepare('UPDATE sync SET published=NULL').run();const missing=await(await worker.fetch(anonymous('/api/public'),f.env)).json();assert.equal(missing.member_count,null);assert.equal(missing.roster_observed_at,null);
    await f.DB.prepare("UPDATE sync SET published='empty'").run();assert.equal((await(await worker.fetch(anonymous('/api/public'),f.env)).json()).member_count,0);
  });
});

test('public summary and health checks are read-only, and HEAD returns headers without a response body',async()=>{
  const f=await fixture();for(const path of ['/api/public','/healthz']){
    const before=f.DB.queries.length,post=await worker.fetch(anonymous(path,{method:'POST'}),f.env);assert.equal(post.status,405);assert.equal(f.DB.queries.length,before);
    const head=await worker.fetch(anonymous(path,{method:'HEAD'}),f.env);assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  assert.deepEqual(await(await worker.fetch(anonymous('/healthz'),f.env)).json(),{status:'ok'});
});

test('every private API fails anonymously before database queries, hydration, provider fetches or asset fallback',async()=>{
  const f=await fixture(),paths=['/api','/api/me','/api/status','/api/members','/api/history?character=101','/api/recipe/100','/api/characters/101/talents','/api/crafters/100','/api/hall','/api/quests/areas','/api/evidence','/api/admin/status','/api/admin/discord','/api/admin/character-mappings','/api/admin/character-check?character=Secret','/api/admin/presence-capability','/api/admin/discord/channels','/api/public/','/api/unknown'];
  await withoutNetwork(async()=>{
    for(const path of paths)for(const method of ['GET','HEAD','POST']){
      const before=f.DB.queries.length,response=await worker.fetch(anonymous(path,{method}),f.env);assert.equal(response.status,401,path+' '+method);privateHeaders(response);assert.equal(f.DB.queries.length,before,path+' must not run endpoint queries');
      const text=await response.text();assert(!text.includes('Secret'));assert(!text.includes('Fine Widget'));if(method==='HEAD')assert.equal(text,'');else assert.equal(JSON.parse(text).access_required,true);
    }
    assert.equal(f.assets.length,0);
  });
});

test('expired sessions, stale ownership, former guild members and manual mappings do not bypass membership checks',async()=>{
  const f=await fixture();await withoutNetwork(async()=>{
    for(const [user,status]of [[f.expired,401],[f.stale,403],[f.nonmember,403],[f.former,403],[f.mapped,403]])for(const path of ['/api/me','/api/members','/api/recipe/100','/api/characters/101/talents','/api/admin/status']){
      const response=await worker.fetch(user.request(path),f.env);assert.equal(response.status,status,user.id+' '+path);privateHeaders(response);const data=await response.json();assert.equal(data.access_required,true);assert(!JSON.stringify(data).includes('Secret'));
    }
  });
});

test('verified members retain private data access while ordinary admin denials do not signal lost membership',async()=>{
  const f=await fixture();for(const path of ['/api/me','/api/status','/api/members','/api/history?character=101']){
    const response=await worker.fetch(f.member.request(path),f.env);assert.equal(response.status,200,path);privateHeaders(response);
  }
  const denied=await worker.fetch(f.member.request('/api/admin/status'),f.env);assert.equal(denied.status,403);assert(!('access_required' in await denied.json()));
  assert.equal((await worker.fetch(f.admin.request('/api/admin/status'),f.env)).status,200);
  const badWrite=await worker.fetch(f.member.request('/api/hall/profile',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':'wrong'},body:JSON.stringify({character_id:101,title:'Test'})}),f.env);assert.equal(badWrite.status,403);assert(!('access_required' in await badWrite.json()));
});

test('membership revoked after sign-in immediately blocks private APIs, private HTML and assets even for a pinned admin',async()=>{
  const f=await fixture();assert.equal((await worker.fetch(f.admin.request('/api/members'),f.env)).status,200);
  await f.DB.prepare('DELETE FROM membership WHERE character_id=102').run();
  const response=await worker.fetch(f.admin.request('/api/members'),f.env);assert.equal(response.status,403);assert.equal((await response.json()).access_required,true);
  const page=await worker.fetch(f.admin.request('/guild'),f.env);assert.equal(page.status,303);assert.equal(page.headers.get('Location'),'/?access=unverified');
  assert.equal((await worker.fetch(f.admin.request('/app.js'),f.env)).status,403);assert.equal(f.assets.length,0);
});

test('private app aliases redirect anonymous users to Battle.net and signed nonmembers to the public welcome without a loop',async()=>{
  const f=await fixture();for(const path of ['/guild','/guild/','/guild.html']){
    for(const request of [anonymous(path),f.expired.request(path)]){const response=await worker.fetch(request,f.env);assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/auth/login');privateHeaders(response);assert.equal(await response.text(),'');}
    const denied=await worker.fetch(f.nonmember.request(path),f.env);assert.equal(denied.status,303);assert.equal(denied.headers.get('Location'),'/?access=unverified');
    const returned=await worker.fetch(f.nonmember.request(denied.headers.get('Location')),f.env);assert.equal(returned.status,200);assert.equal(await returned.text(),WELCOME);
    const member=await worker.fetch(f.member.request(path),f.env);assert.equal(member.status,200);assert.equal(await member.text(),PRIVATE);assert.equal(f.assets.at(-1).path,'/index.html');privateHeaders(member);assert.match(member.headers.get('Cache-Control'),/private/);
  }
});

test('direct private assets and unknown HTML cannot bypass the gate even if an asset binding falls back to the private app',async()=>{
  const f=await fixture(),assetPaths=['/app.js','/hall.js','/adventures.js','/talents.js','/style.css','/talents.css','/assets/other.png','/index.html/','/unknown'];
  for(const path of assetPaths){const response=await worker.fetch(anonymous(path,{headers:{Accept:'text/html'}}),f.env);assert.equal(response.status,401,path);assert.equal(response.headers.get('Location'),null);const data=await response.json();assert.equal(data.access_required,true);assert(!JSON.stringify(data).includes(PRIVATE));}
  for(const path of ['/unknown.html','/INDEX.HTML','/guild%2findex.html']){
    const response=await worker.fetch(anonymous(path,{headers:{Accept:'text/html'}}),f.env);assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/auth/login');
  }
  assert.equal(f.assets.length,0);
  for(const path of ['/app.js','/unknown.html']){const response=await worker.fetch(f.member.request(path),f.env);assert.equal(response.status,200);assert.equal(await response.text(),PRIVATE);privateHeaders(response);assert.match(response.headers.get('Cache-Control'),/private/);}
});

test('only the exact public asset allowlist bypasses authentication',async()=>{
  const f=await fixture();for(const path of ['/welcome.css','/welcome.js','/assets/guild-banner.svg','/assets/guild-logo.svg','/privacy.html','/privacy.css']){
    const before=f.DB.queries.length,response=await worker.fetch(anonymous(path),f.env);assert.equal(response.status,200);assert(!String(await response.text()).includes(PRIVATE));assert.equal(f.DB.queries.length,before);assert.equal(f.assets.at(-1).path,path);
  }
  for(const path of ['/privacy.html/','/welcome.css.map','/assets/guild-banner.svg/'])assert.notEqual((await worker.fetch(anonymous(path),f.env)).status,200);
  for(const path of ['/favicon.ico','/robots.txt']){const response=await worker.fetch(anonymous(path),f.env);assert.equal(response.status,404);assert.equal(response.headers.get('Location'),null);assert.equal(response.headers.get('Set-Cookie'),null);}
});

test('HEAD preserves private authorization and cache policy while suppressing all response bodies',async()=>{
  const f=await fixture();for(const path of ['/api/me','/api/members','/guild','/app.js']){
    const denied=await worker.fetch(anonymous(path,{method:'HEAD'}),f.env);assert.equal(denied.status,path==='/guild'?303:401);assert.equal(await denied.text(),'');privateHeaders(denied);
    const allowed=await worker.fetch(f.member.request(path,{method:'HEAD'}),f.env);assert.equal(allowed.status,200);assert.equal(await allowed.text(),'');privateHeaders(allowed);
  }
});

test('Battle.net login stays public, Discord keeps its gate and the operator bootstrap endpoint is unavailable',async()=>{
  const f=await fixture();f.env.BLIZZARD_CLIENT_ID='fixture-client';f.env.BLIZZARD_CLIENT_SECRET='fixture-secret';
  await withoutNetwork(async()=>{
    const login=await worker.fetch(anonymous('/auth/login'),f.env);assert.equal(login.status,303);assert.equal(new URL(login.headers.get('Location')).hostname,'oauth.battle.net');
    assert.equal((await worker.fetch(anonymous('/auth/discord/login'),f.env)).status,401);
    for(const method of ['GET','POST'])for(const authorization of ['', 'Bearer fixture-operator-token'])assert.equal((await worker.fetch(anonymous('/internal/bootstrap',{method,headers:{Authorization:authorization}}),f.env)).status,404);
  });
});

test('Wrangler routes every asset through the Worker and disables implicit HTML redirects and SPA fallback',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')),schema=JSON.parse(readFileSync(new URL('../node_modules/wrangler/config-schema.json',import.meta.url),'utf8'));
  assert.equal(config.assets.run_worker_first,true);assert.equal(config.assets.html_handling,'none');assert.equal(config.assets.not_found_handling,'none');
  assert(schema.definitions.Assets.properties.run_worker_first.anyOf.some(type=>type.type==='boolean'));assert(schema.definitions.Assets.properties.html_handling.enum.includes('none'));
});
