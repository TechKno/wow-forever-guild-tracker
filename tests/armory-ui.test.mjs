import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/armory.js',import.meta.url),'utf8'),css=readFileSync(new URL('../public/armory.css',import.meta.url),'utf8');
const member=(id=71)=>({id,name:id===71?'Example Character':'Second Character'});
const section=(data,overrides={})=>({status:'verified',observed_at:'2026-11-09T08:00:00Z',checked_at:'2026-11-09T08:00:00Z',data,...overrides});
function payload(id=71){return {character_id:id,sections:{equipment:section({items:[{id:10,slot:'MAIN_HAND',slot_name:'Main hand',name:'Copper Practice Sword',quality:'UNCOMMON',item_level:18,item_subclass:'Sword',stats:[{name:'Strength',value:2,display:'+2 Strength'}],enchantments_status:'unknown',enchantments:[]}]}),statistics:section({values:[{id:'health',name:'Health',value:450,unit:''},{id:'melee_crit',name:'Critical strike',value:7.5,unit:'%'}]}),media:section({assets:[{key:'main-raw',url:`/api/characters/${id}/armory/media/main-raw`}]})},note:'Only returned fields are shown.'};}
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function page(handler){
  const calls=[],window={},context=vm.createContext({window,Date,fetch:async(path,options)=>{calls.push({path,options});return handler(path,options);}});vm.runInContext(source,context);
  function host(){
    const listeners=new Map(),image=()=>({hidden:false,listeners:new Map(),addEventListener(type,handler){this.listeners.set(type,handler);},emit(type){this.listeners.get(type)?.();}}),element={isConnected:true,_html:'',image:null,fallback:null,icons:[],openItems:[],
      get innerHTML(){return this._html;},set innerHTML(value){this._html=value;this.image=value.includes('data-armory-portrait')?image():null;this.fallback=value.includes('armory-image-fallback')?{hidden:true}:null;this.icons=[...value.matchAll(/<img[^>]*data-armory-icon[^>]*>/g)].map(()=>{const icon=image(),fallback={hidden:true};icon.parentElement={querySelector:()=>fallback};icon.fallback=fallback;return icon;});},
      querySelector(selector){return ['img','[data-armory-portrait]'].includes(selector)?this.image:selector==='.armory-image-fallback'?this.fallback:null;},
      querySelectorAll(selector){return selector==='[data-armory-icon]'?this.icons:selector==='.armory-item-details[open]'?this.openItems:[];},
      addEventListener(type,handler){const list=listeners.get(type)||[];list.push(handler);listeners.set(type,list);},
      retry(){const button={closest:selector=>selector==='[data-armory-retry]'?button:null};for(const handler of listeners.get('click')||[])handler({target:button});},
      key(key){const event={key,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};for(const handler of listeners.get('keydown')||[])handler(event);return event;}};
    return element;
  }
  return {calls,host,api:window.GuildArmory,window};
}

test('armory displays returned gear, relevant statistics and private character artwork with independent freshness',async()=>{
  const p=page(()=>Response.json(payload())),host=p.host();await p.api.mount(host,member());
  assert.match(host.innerHTML,/aria-label="Character armory"/);assert.match(host.innerHTML,/Copper Practice Sword/);assert.match(host.innerHTML,/Main hand/);assert.match(host.innerHTML,/Item level 18/);
  assert.match(host.innerHTML,/<details class="armory-item-details" name="armory-item-71">/);assert.match(host.innerHTML,/Enchantment data was not returned/);assert.match(host.innerHTML,/\+2 Strength/);
  assert.match(host.innerHTML,/<dt>Health<\/dt><dd>450<\/dd>/);assert.match(host.innerHTML,/7\.5%/);assert.match(host.innerHTML,/src="\/api\/characters\/71\/armory\/media\/main-raw"/);assert.match(host.innerHTML,/referrerpolicy="no-referrer"/);
  assert.doesNotMatch(host.innerHTML,/\sstyle=|missing enchants|Haste|Mastery/i);assert.equal(p.calls.length,1);assert.equal(p.calls[0].options.cache,'no-store');
});

test('missing sections remain unknown instead of empty gear slots, zero statistics or inferred enchant requirements',async()=>{
  const unknown=payload();for(const key of Object.keys(unknown.sections))unknown.sections[key]=section(null,{status:'unavailable',observed_at:null,note:'Blizzard has not published this section.'});
  const p=page(()=>Response.json(unknown)),host=p.host();await p.api.mount(host,member());
  assert.match(host.innerHTML,/No empty slots are inferred/);assert.match(host.innerHTML,/Missing values remain unknown/);assert.match(host.innerHTML,/not returned supported character artwork/);
  assert.doesNotMatch(host.innerHTML,/<dd>|Equipped item level|src=|head: empty|missing enchants/i);
});

test('all provider text is escaped and supplied images must match the selected character’s private media route',async()=>{
  const data=payload();data.sections.equipment.data.items[0].name='<img src=x onerror=alert(1)>';data.sections.equipment.data.items[0].quality='rare" onclick="alert(1)';
  data.sections.equipment.note='<script>secret</script>';data.sections.statistics.data.values[0].name='<svg onload=alert(1)>';data.sections.media.data.assets[0].url='https://evil.example/private.png';
  const p=page(()=>Response.json(data)),host=p.host();await p.api.mount(host,{...member(),name:'"><script>bad</script>'});
  assert.match(host.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(host.innerHTML,/&lt;script&gt;secret&lt;\/script&gt;/);assert.match(host.innerHTML,/quality-unknown/);
  assert.doesNotMatch(host.innerHTML,/<script|<svg|<img\b|onerror="|onclick="|https:\/\/evil/);
  const wrong=payload();wrong.sections.media.data.assets[0].url='/api/characters/72/armory/media/main-raw';
  const q=page(()=>Response.json(wrong)),other=q.host();await q.api.mount(other,member());assert.doesNotMatch(other.innerHTML,/<img/);
});

test('a delayed armory response cannot replace another character or repopulate a closed host',async()=>{
  const slow=deferred(),p=page(path=>path.includes('/71/')?slow.promise:Response.json(payload(72))),host=p.host();
  const first=p.api.mount(host,member()),second=p.api.mount(host,member(72));await second;slow.resolve(Response.json(payload()));await first;
  assert.match(host.innerHTML,/\/72\/armory\/media/);assert.doesNotMatch(host.innerHTML,/\/71\/armory\/media/);
  const delayed=deferred(),q=page(()=>delayed.promise),closed=q.host(),request=q.api.mount(closed,member());q.api.unmount(closed);delayed.resolve(Response.json(payload()));await request;assert.equal(closed.innerHTML,'');
});

test('access reset clears rendered data and cached or pending responses cannot restore the old member view',async()=>{
  const slow=deferred(),p=page(()=>slow.promise),host=p.host(),request=p.api.mount(host,member());p.api.reset();slow.resolve(Response.json(payload()));await request;assert.equal(host.innerHTML,'');
  const q=page(()=>Response.json(payload())),shown=q.host();await q.api.mount(shown,member());assert.match(shown.innerHTML,/Copper Practice Sword/);q.api.reset();assert.equal(shown.innerHTML,'');await q.api.mount(shown,member());assert.equal(q.calls.length,2);
});

test('reopening a character reuses a short browser cache and explicit retries are still subject to server policy',async()=>{
  const p=page(()=>Response.json(payload())),first=p.host(),second=p.host();await p.api.mount(first,member());await p.api.mount(second,member());assert.equal(p.calls.length,1);
  second.retry();await tick();assert.equal(p.calls.length,2);assert.match(second.innerHTML,/Copper Practice Sword/);
});

test('errors retain a previous rendered observation, never expose response errors and reject character mismatches',async()=>{
  let fail=false;const p=page(()=>fail?Response.json({error:'PRIVATE_TOKEN_DO_NOT_SHOW'},{status:503}):Response.json(payload())),host=p.host();await p.api.mount(host,member());fail=true;await p.api.mount(host,member(),true);
  assert.match(host.innerHTML,/latest request failed/);assert.match(host.innerHTML,/Copper Practice Sword/);assert.doesNotMatch(host.innerHTML,/PRIVATE_TOKEN/);
  const q=page(()=>Response.json(payload(72))),mismatch=q.host();await q.api.mount(mismatch,member());assert.match(mismatch.innerHTML,/armory could not be loaded/);assert.doesNotMatch(mismatch.innerHTML,/Copper Practice Sword|\/72\/armory\/media/);
});

test('artwork failures have an accessible fallback and mobile layout keeps equipment and stats within the folio',async()=>{
  const p=page(()=>Response.json(payload())),host=p.host();await p.api.mount(host,member());host.image.emit('error');assert.equal(host.image.hidden,true);assert.equal(host.fallback.hidden,false);
  assert.match(css,/@media\(max-width:650px\)/);assert.match(css,/grid-template-areas:'portrait portrait' 'left right' 'weapons weapons'/);assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);assert.match(css,/min-height:44px/);
});

test('classic equipment slots flank the artwork in order, weapons sit below, and absent slots are never fabricated',async()=>{
  const data=payload();data.sections.equipment.data.items=[
    {id:20,name:'Practice Gloves',slot:'HANDS',slot_name:'Hands'},
    {id:21,name:'Practice Chest',slot:'CHEST',slot_name:'Chest'},
    ...data.sections.equipment.data.items,
    {id:22,name:'Practice Shoulders',slot:'SHOULDER',slot_name:'Shoulder'}];
  const p=page(()=>Response.json(data)),host=p.host();await p.api.mount(host,member());
  assert.match(host.innerHTML,/armory-gear-left[\s\S]*Practice Shoulders[\s\S]*Practice Chest[\s\S]*armory-portrait[\s\S]*armory-gear-right[\s\S]*Practice Gloves[\s\S]*armory-gear-weapons[\s\S]*Copper Practice Sword/);
  assert.equal([...host.innerHTML.matchAll(/data-armory-slot=/g)].length,4);assert.doesNotMatch(host.innerHTML,/data-armory-slot="HEAD"|head: empty/i);
  assert.match(host.innerHTML,/summary aria-label="Equipment details for Practice Gloves"/);assert.match(css,/grid-template-areas:'left portrait right' 'weapons weapons weapons'/);assert.match(css,/\.armory-item-tooltip\{position:absolute/);
});

test('Escape closes an equipment detail overlay before the surrounding character dialog',async()=>{
  const p=page(()=>Response.json(payload())),host=p.host();await p.api.mount(host,member());let focused=false;
  const item={open:true,querySelector:()=>({focus(){focused=true;}})};host.openItems=[item];const event=host.key('Escape');
  assert.equal(item.open,false);assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(focused,true);
});

test('item icons use only exact current-character and item routes, with a non-script fallback when delivery fails',async()=>{
  const data=payload();data.sections.equipment.data.items[0].icon_url='/api/characters/71/armory/item/10/icon';
  const p=page(()=>Response.json(data)),host=p.host();await p.api.mount(host,member());assert.match(host.innerHTML,/src="\/api\/characters\/71\/armory\/item\/10\/icon"/);assert.equal(host.icons.length,1);host.icons[0].emit('error');assert.equal(host.icons[0].hidden,true);assert.equal(host.icons[0].fallback.hidden,false);
  for(const url of ['https://evil.example/item.png','/api/characters/72/armory/item/10/icon','/api/characters/71/armory/item/11/icon','/api/characters/71/armory/item/10/icon?token=bad']){
    const wrong=payload();wrong.sections.equipment.data.items[0].icon_url=url;const q=page(()=>Response.json(wrong)),rejected=q.host();await q.api.mount(rejected,member());assert.equal(rejected.icons.length,0);assert(!rejected.innerHTML.includes(url));
  }
});
