import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {armoryView,armoryMedia,armoryIcon,allowedItemIcon,normalizeEquipment,normalizeStatistics,normalizeMedia,allowedArmoryImage} from '../src/armory.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';

const epoch=()=>Math.floor(Date.now()/1000),id=71,media='https://render.worldofwarcraft.com/forever-eu/character/1/71-main.png';
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  return {raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
async function fixture(){
  const DB=database(),now=new Date().toISOString(),token=random();
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','example-character',id,JSON.stringify({id,name:'Example Character',slug:'example-character',level:20})).run();
  await DB.prepare('INSERT INTO users(id,subject_hash,main_character_id,ownership_status,ownership_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind('armory-owner','armory-subject',id,'verified',epoch(),now,now).run();
  await DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(id,'armory-owner',now).run();
  await DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),'armory-owner','fixture-csrf',epoch()+3600).run();
  return {DB,env:{DB,BLIZZARD_CLIENT_ID:'armory-fixture-'+random(),BLIZZARD_CLIENT_SECRET:'fixture-client-secret'},request:()=>new Request(ORIGIN+'/api/characters/71/armory',{headers:{Cookie:'__Host-wv_session='+token}})};
}
const equipment=()=>({character:{id},equipped_items:[{item:{id:10},slot:{type:'MAIN_HAND',name:'Main hand'},name:'Copper Practice Sword',quality:{type:'UNCOMMON',name:'Uncommon'},level:{value:18},item_subclass:{name:'Sword'},inventory_type:{name:'One-hand'},stats:[{type:{name:'Strength'},value:2,display:{display_string:'+2 Strength'}}],enchantments:[{enchantment_id:2,display_string:'+1 Weapon damage'}],weapon:{damage:{display_string:'5 - 9 Damage'},attack_speed:2.1},requirements:{level:{value:10}}}]});
const statistics=()=>({character:{id},health:450,power:300,power_type:{name:'Mana'},strength:{base:18,effective:20},stamina:{effective:24},melee_crit:{value:7.5},private_diagnostic:'fixture-secret-do-not-return'});
const artwork=()=>({character:{id},assets:[{key:'main-raw',value:media}]});
function provider(overrides={}){
  const calls=[];
  return {calls,fetch:async(input,options)=>{
    const url=new URL(input);calls.push({url,options});
    if(url.pathname==='/token')return Response.json({access_token:'fixture-armory-token',expires_in:3600});
    const suffix=url.pathname.split('/').at(-1),override=overrides[suffix];
    if(override!==undefined){const value=typeof override==='function'?await override(url,options):override;return value instanceof Response?value:Response.json(value);}
    if(url.hostname==='render.worldofwarcraft.com')return new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}});
    const data=suffix==='equipment'?equipment():suffix==='statistics'?statistics():suffix==='character-media'?artwork():null;
    assert(data,'Unexpected provider path '+url.pathname);return Response.json(data,{headers:{'Last-Modified':'Mon, 09 Nov 2026 08:00:00 GMT'}});
  }};
}
async function withProvider(mock,run){const original=globalThis.fetch;globalThis.fetch=mock.fetch;try{return await run();}finally{globalThis.fetch=original;}}
const view=f=>armoryView(f.request(),f.env,id),expire=f=>f.DB.prepare("UPDATE api_cache SET expires=0 WHERE key LIKE 'armory:%'").run();

test('item icons are limited to observed equipped items, use static media identity and stay private',async()=>{
  const f=await fixture(),href='https://render.worldofwarcraft.com/forever-eu/icons/56/134590.jpg',mock=provider({'10':{id:10,assets:[{key:'icon',value:href}]}});
  await withProvider(mock,async()=>{
    await view(f);let before=mock.calls.length;
    await assert.rejects(armoryIcon(f.request(),f.env,id,999),error=>error.status===404);assert.equal(mock.calls.length,before);
    let response=await armoryIcon(f.request(),f.env,id,10);assert.equal(response.status,200);assert.equal(response.headers.get('Vary'),'Cookie');assert.equal(response.headers.get('Cache-Control'),'private, no-store');
    const lookup=mock.calls.find(call=>call.url.pathname==='/data/wow/media/item/10');assert.equal(lookup.url.searchParams.get('namespace'),'static-forever-eu');
    before=mock.calls.filter(call=>call.url.pathname==='/data/wow/media/item/10').length;response=await armoryIcon(f.request(),f.env,id,10);assert.equal(response.status,200);assert.equal(mock.calls.filter(call=>call.url.pathname==='/data/wow/media/item/10').length,before);
    await f.DB.prepare('DELETE FROM membership').run();before=mock.calls.length;await assert.rejects(armoryIcon(f.request(),f.env,id,10),error=>error.status===403);assert.equal(mock.calls.length,before);
  });
});
test('item icon references cannot choose external hosts, arbitrary CDN paths, active formats or credentials',()=>{
  assert(allowedItemIcon('https://render.worldofwarcraft.com/forever/icons/56/inv_sword_01.jpg'));
  assert(allowedItemIcon('https://render.worldofwarcraft.com/forever-eu/icons/56/134590.jpg'));
  assert.equal(allowedItemIcon('https://render.worldofwarcraft.com/arbitrary/icons/56/134590.jpg'),null);
  for(const value of ['https://evil.example/forever/icons/56/x.jpg','https://user:pass@render.worldofwarcraft.com/forever/icons/56/x.jpg','https://render.worldofwarcraft.com/forever/icons/56/x.svg','https://render.worldofwarcraft.com/forever/character/x.jpg','https://render.worldofwarcraft.com/forever/icons/56/x.jpg?redirect=https://evil.example'])assert.equal(allowedItemIcon(value),null);
});

test('missing regional item icons use only the identical shared Blizzard file without credentials',async()=>{
  for(const status of [403,404]){
    const f=await fixture(),href='https://render.worldofwarcraft.com/forever-eu/icons/56/132724.jpg';
    const mock=provider({'10':{id:10,assets:[{key:'icon',value:href}]},'132724.jpg':url=>url.pathname.startsWith('/forever-eu/')?new Response('Missing',{status}):new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}})});
    await withProvider(mock,async()=>{
      await view(f);const response=await armoryIcon(f.request(),f.env,id,10);assert.equal(response.status,200);
      const images=mock.calls.filter(call=>call.url.hostname==='render.worldofwarcraft.com');
      assert.deepEqual(images.map(call=>call.url.href),[href,'https://render.worldofwarcraft.com/us/icons/56/132724.jpg']);
      for(const call of images){assert.equal(call.options.redirect,'manual');assert(!new Headers(call.options.headers).has('Authorization'));assert(!new Headers(call.options.headers).has('Cookie'));}
    });
  }
});

test('item icon rate limits and character artwork failures never try another CDN path',async()=>{
  const f=await fixture(),href='https://render.worldofwarcraft.com/forever-eu/icons/56/132724.jpg';
  const mock=provider({'10':{id:10,assets:[{key:'icon',value:href}]},'132724.jpg':()=>new Response('Pause',{status:429}),'71-main.png':()=>new Response('Missing',{status:403})});
  await withProvider(mock,async()=>{
    await view(f);await assert.rejects(armoryIcon(f.request(),f.env,id,10),error=>error.status===502);
    await assert.rejects(armoryMedia(f.request(),f.env,id,'main-raw'),error=>error.status===502);
    assert.deepEqual(mock.calls.filter(call=>call.url.hostname==='render.worldofwarcraft.com').map(call=>call.url.href),[href,media]);
  });
});

test('armory access requires verified current guild membership before touching provider or cached artwork',async()=>{
  const f=await fixture(),mock=provider();
  await withProvider(mock,async()=>{
    await assert.rejects(armoryView(new Request(ORIGIN+'/api/characters/71/armory'),f.env,id),error=>error.status===401);
    for(const target of [0,-1,999,Number.MAX_SAFE_INTEGER+1])await assert.rejects(armoryView(f.request(),f.env,target),error=>error.status===404);
    assert.equal(mock.calls.length,0);
    await view(f);const before=mock.calls.length;
    await f.DB.prepare("DELETE FROM membership WHERE generation='current'").run();
    await assert.rejects(view(f),error=>error.status===403);await assert.rejects(armoryMedia(f.request(),f.env,id,'main-raw'),error=>error.status===403);
    assert.equal(mock.calls.length,before);
  });
});

test('equipment and statistics retain only returned known fields and do not invent absent slots, enchants or zero statistics',()=>{
  const gear=normalizeEquipment(equipment(),id);assert.equal(gear.items.length,1);assert.equal(gear.items[0].slot,'MAIN_HAND');assert.equal(gear.items[0].name,'Copper Practice Sword');assert.equal(gear.items[0].enchantments[0].name,'+1 Weapon damage');
  const noEnchants=equipment();delete noEnchants.equipped_items[0].enchantments;
  assert.equal(normalizeEquipment(noEnchants,id).items[0].enchantments_status,'unknown');
  const stats=normalizeStatistics(statistics(),id);assert.equal(stats.values.find(value=>value.id==='strength').value,20);assert(!stats.values.some(value=>value.id==='haste'||value.id==='agility'));assert(!JSON.stringify(stats).includes('private_diagnostic'));
  assert.throws(()=>normalizeEquipment({...equipment(),character:{id:72}},id));assert.throws(()=>normalizeStatistics({...statistics(),character:{id:72}},id));
  assert.throws(()=>normalizeEquipment({character:{id}},id));assert.throws(()=>normalizeStatistics({character:{id}},id));
  const duplicate=equipment();duplicate.equipped_items.push(duplicate.equipped_items[0]);assert.throws(()=>normalizeEquipment(duplicate,id));
});

test('armory sections cache independently and expose private relative media URLs without credentials or upstream references',async()=>{
  const f=await fixture(),mock=provider();
  await withProvider(mock,async()=>{
    const first=await view(f),count=mock.calls.length,again=await view(f);assert.deepEqual(again,first);assert.equal(mock.calls.length,count);assert.equal(count,4);
    assert.equal(first.sections.equipment.status,'verified');assert.equal(first.sections.statistics.data.values.find(value=>value.id==='health').value,450);
    assert.equal(first.sections.media.data.assets[0].url,'/api/characters/71/armory/media/main-raw');
    assert(first.sections.equipment.observed_at);assert.equal(first.sections.equipment.source_updated_at,'2026-11-09T08:00:00.000Z');
    const json=JSON.stringify(first);for(const secret of ['fixture-client-secret','fixture-armory-token','fixture-secret-do-not-return','render.worldofwarcraft.com'])assert(!json.includes(secret));
    for(const call of mock.calls.filter(call=>call.url.hostname==='eu.api.blizzard.com')){assert.equal(call.url.searchParams.get('namespace'),'profile-forever-eu');assert.equal(call.options.redirect,'manual');assert.equal(call.options.cache,'no-store');}
  });
});

test('malformed newer equipment preserves its original observation and backs off without erasing known items',async()=>{
  const f=await fixture();let broken=false;
  const mock=provider({equipment:()=>broken?{character:{id:72},equipped_items:[]}:equipment()});
  await withProvider(mock,async()=>{
    const first=await view(f);broken=true;await expire(f);const second=await view(f),count=mock.calls.length;
    assert.equal(second.sections.equipment.status,'stale');assert.deepEqual(second.sections.equipment.data,first.sections.equipment.data);assert.equal(second.sections.equipment.observed_at,first.sections.equipment.observed_at);
    assert.match(second.sections.equipment.note,/previous observation is retained/);await view(f);assert.equal(mock.calls.length,count);
    assert.equal(second.sections.statistics.status,'verified');
  });
});

test('unpublished armory sections back off for one hour and never become empty equipment or zero statistics',async()=>{
  const f=await fixture(),missing=()=>Response.json({error:'not published'},{status:404}),mock=provider({equipment:missing,statistics:missing,'character-media':missing});
  await withProvider(mock,async()=>{
    const first=await view(f),count=mock.calls.length;await view(f);assert.equal(mock.calls.length,count);
    for(const section of Object.values(first.sections)){assert.equal(section.status,'unavailable');assert.equal(section.data,null);assert.equal(section.observed_at,null);assert(Date.parse(section.retry_at)>=Date.now()+3590000);}
  });
});

test('a provider429 pauses remaining armory sections and other characters without extending the global cooldown',async()=>{
  const f=await fixture(),mock=provider({equipment:()=>Response.json({error:'slow down'},{status:429,headers:{'Retry-After':'120'}})});
  await withProvider(mock,async()=>{
    const first=await view(f);assert.equal(mock.calls.filter(call=>call.url.hostname==='eu.api.blizzard.com').length,1);
    const pause=(await f.DB.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").first()).value;
    assert.equal(first.sections.statistics.status,'unavailable');await view(f);assert.equal(mock.calls.length,2);assert.equal((await f.DB.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").first()).value,pause);
  });
});

test('media references cannot select arbitrary hosts, credentials, paths, query arguments or active image formats',()=>{
  for(const url of ['http://render.worldofwarcraft.com/forever-eu/character/71.png','https://evil.example/forever-eu/character/71.png','https://render.worldofwarcraft.com.evil.example/forever-eu/character/71.png','https://render.worldofwarcraft.com/forever-us/character/71.png','https://render.worldofwarcraft.com/forever-eu/character/71.svg','https://render.worldofwarcraft.com/forever-eu/character/71.png?token=private','https://user:pass@render.worldofwarcraft.com/forever-eu/character/71.png','https://render.worldofwarcraft.com:444/forever-eu/character/71.png'])assert.equal(allowedArmoryImage(url),null,url);
  assert.equal(allowedArmoryImage(media),media);assert.throws(()=>normalizeMedia({character:{id:72},assets:[{key:'main-raw',value:media}]},id));
  assert.throws(()=>normalizeMedia({character:{id},assets:[{key:'main-raw',value:'https://evil.example/picture.png'}]},id));
});

test('private artwork fetches only a previously verified CDN asset, strips authorization and validates the actual image bytes',async()=>{
  const f=await fixture(),mock=provider();
  await withProvider(mock,async()=>{
    await view(f);const response=await armoryMedia(f.request(),f.env,id,'main-raw');assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.arrayBuffer()).byteLength,8);
    const call=mock.calls.find(call=>call.url.hostname==='render.worldofwarcraft.com');assert(call);assert.equal(call.options.redirect,'manual');assert(!new Headers(call.options.headers).has('Authorization'));assert(!new Headers(call.options.headers).has('Cookie'));
    const before=mock.calls.length;await assert.rejects(armoryMedia(f.request(),f.env,id,'https://evil.example'),error=>error.status===404);assert.equal(mock.calls.length,before);
  });
  for(const [type,body]of [['image/svg+xml','<svg/>'],['image/png','<script>bad</script>']]){
    const malicious=provider({'71-main.png':()=>new Response(body,{headers:{'Content-Type':type}})});
    await withProvider(malicious,()=>assert.rejects(armoryMedia(f.request(),f.env,id,'main-raw'),error=>error.status===502));
  }
});

test('departures during a provider lookup revoke the response even when the original session remains a member through an alt',async()=>{
  const f=await fixture();await f.DB.prepare('INSERT INTO membership VALUES(?,?,?,?)').bind('current','second-character',72,JSON.stringify({id:72,name:'Second Character',slug:'second-character',level:20})).run();
  await f.DB.prepare('INSERT INTO character_links(character_id,user_id,verified_at) VALUES(?,?,?)').bind(72,'armory-owner',new Date().toISOString()).run();
  let removed=false;
  const mock=provider({equipment:async()=>{if(!removed){removed=true;await f.DB.prepare('DELETE FROM membership WHERE character_id=71').run();}return equipment();}});
  await withProvider(mock,()=>assert.rejects(view(f),error=>error.status===404));
});
