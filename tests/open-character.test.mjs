import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const boundary=app.lastIndexOf('load();setInterval(');
assert(boundary>=0,'The app bootstrap must remain outside the test fixture');

const character=(overrides={})=>({id:1,slug:'rowan',name:'Rowan',class:'Mage',class_id:8,race:'Gnome',level:11,rank:1,
  profile_status:'verified',profile_at:'2026-11-08T15:00:00.000Z',profile_checked_at:'2026-11-08T15:00:00.000Z',
  professions_status:'verified',professions_at:'2026-11-08T10:00:00.000Z',talents_status:'verified',talents:[],
  professions:[{name:'Tailoring',kind:'Primary',skill:25,max_skill:75,recipe_status:'observed',recipes:[{id:1,name:'Linen Bag'}]}],...overrides});

function page(initialMembers=[character()]){
  const elements=new Map(),windowListeners=new Map();
  let document;
  const element=id=>{
    if(elements.has(id))return elements.get(id);
    const listeners=new Map(),classes=new Set();
    const node={id,value:'',hidden:false,disabled:false,innerHTML:'',textContent:'',dataset:{},style:{},scrollTop:0,open:false,shown:0,
      classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),toggle(value,enabled){const active=enabled??!classes.has(value);if(active)classes.add(value);else classes.delete(value);return active;}},
      addEventListener(type,handler){const handlers=listeners.get(type)||[];handlers.push(handler);listeners.set(type,handlers);},
      dispatchEvent(event){for(const handler of listeners.get(event.type)||[])handler(event);},
      setAttribute(){},removeAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},contains(other){return other===this;},
      focus(){document.activeElement=this;},showModal(){this.open=true;this.shown++;},close(){this.open=false;this.dispatchEvent({type:'close'});}};
    elements.set(id,node);return node;
  };
  const close=element('dialog-close');
  document={hidden:false,body:element('body'),activeElement:close,getElementById:element,
    querySelector:selector=>selector==='.dialog-close'?close:element(selector),querySelectorAll:()=>[],addEventListener(){}};
  element('sort').value='name';element('status').hidden=true;
  const location={hash:'#roster'};
  const window={innerWidth:1280,scrollTo(){},addEventListener(type,handler){const handlers=windowListeners.get(type)||[];handlers.push(handler);windowListeners.set(type,handlers);},
    dispatchEvent(event){for(const handler of windowListeners.get(event.type)||[])handler(event);}};
  class CustomEvent{constructor(type,{detail}={}){this.type=type;this.detail=detail;}}
  let list=initialMembers,revision=1;
  const state=()=>({configured:true,sync:{updated:revision,published:'generation-one',status:'ready',roster_at:'2026-11-08T16:00:00.000Z'},
    refresh:{last_success_at:'2026-11-08T17:00:00.000Z',roster_at:'2026-11-08T16:00:00.000Z'}});
  const context=vm.createContext({document,window,location,CustomEvent,Date,URL,URLSearchParams,Response,Blob,console,setTimeout,clearTimeout,
    history:{replaceState(_state,_title,value){location.hash=value;}},
    fetch:async path=>{
      if(path==='/api/status')return Response.json(state());
      if(path.startsWith('/api/members?'))return Response.json({members:list,next:null,generation:'generation-one'});
      throw new Error('Unexpected fixture request: '+path);
    }});
  vm.runInContext(app.slice(0,boundary),context);
  return {context,document,element,close,run:code=>vm.runInContext(code,context),load:()=>vm.runInContext('load()',context),
    update(next){list=next;revision++;},route:view=>window.GuildRoute.open(view)};
}

test('a successful background check updates the open character without reopening it or losing its position',async()=>{
  const p=page();await p.load();p.run('openMember("rowan")');
  const dialog=p.element('member-dialog'),content=p.element('member-content');
  assert.match(content.innerHTML,/Level 11/);assert.match(content.innerHTML,/Linen Bag/);
  dialog.scrollTop=240;content.scrollTop=60;p.close.focus();
  p.update([character({level:12,profile_checked_at:'2026-11-08T17:00:00.000Z',professions_at:'2026-11-08T16:30:00.000Z',
    professions:[{name:'Tailoring',kind:'Primary',recipe_status:'observed',recipes:[{id:2,name:'Woolen Bag'}]}]})]);
  await p.load();
  assert.match(content.innerHTML,/Level 12/);assert.match(content.innerHTML,/Woolen Bag/);assert.doesNotMatch(content.innerHTML,/Linen Bag/);
  assert.equal(dialog.open,true);assert.equal(dialog.shown,1);assert.equal(dialog.scrollTop,240);assert.equal(content.scrollTop,60);
  assert.equal(p.document.activeElement,p.close);
});

test('background updates never reopen a dismissed character and the next opening uses current data',async()=>{
  const p=page();await p.load();p.run('openMember("rowan")');
  p.close.dispatchEvent({type:'click'});
  p.update([character({level:12})]);await p.load();
  assert.equal(p.element('member-dialog').open,false);assert.equal(p.element('member-dialog').shown,1);
  p.run('openMember("rowan")');assert.match(p.element('member-content').innerHTML,/Level 12/);
  // Escape/native dialog dismissal also clears the selected character.
  p.element('member-dialog').close();p.update([character({level:13})]);await p.load();
  assert.equal(p.element('member-dialog').open,false);assert.equal(p.element('member-dialog').shown,2);
});

test('an open character removed from the latest roster stops displaying the previous record',async()=>{
  const p=page();await p.load();p.run('openMember("rowan")');
  p.element('member-dialog').scrollTop=120;p.update([]);await p.load();
  assert.match(p.element('member-content').innerHTML,/No current guild record/);
  assert.doesNotMatch(p.element('member-content').innerHTML,/Level 11/);
  assert.equal(p.element('member-dialog').open,true);assert.equal(p.element('member-dialog').scrollTop,120);
});

test('visible data age follows the selected page and keeps recipe observations separate from newer checks',async()=>{
  const p=page([character(),character({id:2,slug:'avery',name:'Avery',professions_at:'2026-11-08T11:00:00.000Z'})]);
  await p.load();
  assert.match(p.element('last-refresh').textContent,/^Last successful Blizzard check:/);
  const roster=p.element('visible-data-age').textContent;
  assert.match(roster,/^Roster checked:/);
  for(const view of ['recipes','professions','crafting','wishlists']){
    p.route(view);const text=p.element('visible-data-age').textContent;
    assert.match(text,/^Recipe observations:/);assert.match(text,/2 \/ 2 characters/);
    assert.ok(text.includes(p.run('date("2026-11-08T10:00:00.000Z")')));
    assert.ok(text.includes(p.run('date("2026-11-08T11:00:00.000Z")')));
    assert.ok(!text.includes(p.run('date("2026-11-08T17:00:00.000Z")')));
  }
  for(const view of ['roster','members','overview']){p.route(view);assert.equal(p.element('visible-data-age').textContent,roster);}
});

test('unpublished profiles explain availability and retain successful recipe times after a failed attempt',async()=>{
  const oldRecipeTime='2026-11-08T10:00:00.000Z',checked='2026-11-08T17:00:00.000Z',source='2026-11-08T09:00:00.000Z';
  const p=page([character({level:9,profile_status:'unavailable',profile_availability:'not_published',profile_checked_at:checked,
    profile_source_updated_at:source,profile_note:'Blizzard has not published this profile <yet>.',professions_status:'stale',
    professions_at:oldRecipeTime,professions_checked_at:checked})]);
  await p.load();
  assert.match(p.element('roster-body').innerHTML,/class="badge unavailable">Not published/);
  p.run('openMember("rowan")');const content=p.element('member-content').innerHTML;
  assert.match(content,/Profile last checked/);assert.match(content,/Previous successful profile check/);
  assert.match(content,/Recipes last successfully checked/);assert.match(content,/Not published by Blizzard/);
  assert.match(content,/Blizzard profile timestamp/);assert.match(content,/profile &lt;yet&gt;/);
  assert.ok(content.includes(p.run('date("'+checked+'")')));assert.ok(content.includes(p.run('date("'+source+'")')));
  p.route('recipes');assert.ok(p.element('visible-data-age').textContent.includes(p.run('date("'+oldRecipeTime+'")')));
  assert.ok(!p.element('visible-data-age').textContent.includes(p.run('date("'+checked+'")')));
});

test('temporary profile failures are labelled as delayed checks rather than missing publication',async()=>{
  const p=page([character({profile_status:'stale',profile_availability:'temporary_error',profile_note:'The last Blizzard request timed out.'})]);
  await p.load();assert.match(p.element('roster-body').innerHTML,/Refresh delayed/);
  p.run('openMember("rowan")');assert.match(p.element('member-content').innerHTML,/Temporarily unavailable/);
  assert.match(p.element('member-content').innerHTML,/The last Blizzard request timed out\./);
});

test('an account character selected before the roster finishes loading opens once its current membership is available',async()=>{const p=page();await p.run('openCharacterById(1)');assert.equal(p.element('member-dialog').open,true);assert.match(p.element('member-content').innerHTML,/Level 11/);assert.doesNotMatch(p.element('member-content').innerHTML,/Opening character/);});
