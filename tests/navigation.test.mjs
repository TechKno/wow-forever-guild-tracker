import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const hall=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8');
const adventures=readFileSync(new URL('../public/adventures.js',import.meta.url),'utf8');
const bootstrap=app.lastIndexOf('load();setInterval(');
assert(bootstrap>=0,'App bootstrap boundary must be available to the navigation fixture');
const source=app.slice(0,bootstrap);
const attributes=text=>Object.fromEntries([...text.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)].map(match=>[match[1],match[2]??'']));
const dataKey=name=>name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());

function classes(value=''){
  const values=new Set(value.split(/\s+/).filter(Boolean));
  return {add(...items){items.forEach(item=>values.add(item));},remove(...items){items.forEach(item=>values.delete(item));},contains:item=>values.has(item),
    toggle(item,enabled){const active=enabled??!values.has(item);if(active)values.add(item);else values.delete(item);return active;}};
}
function page({hash='',admin=false,withHall=true,width=1280}={}){
  const elements=new Map(),nodes=[],windowListeners=new Map(),documentListeners=new Map(),selected=[],failures=new Map(),calls={hall:0,history:0,adventures:0,admin:0,fetch:[]};
  const make=(id='',attrs={})=>{
    const listeners=new Map(),node={id,value:'',hidden:Object.hasOwn(attrs,'hidden'),disabled:false,innerHTML:'',textContent:'',dataset:{},style:{},options:[],checked:false,
      classList:classes(attrs.class),attributes:{...attrs},children:[],firstChild:{textContent:''},
      addEventListener(type,handler){const list=listeners.get(type)||[];list.push(handler);listeners.set(type,list);},
      setAttribute(name,value){this.attributes[name]=String(value);},getAttribute(name){return this.attributes[name]??null;},removeAttribute(name){delete this.attributes[name];},
      remove(){this.removed=true;},focus(){document.activeElement=this;},scrollIntoView(){},showModal(){this.open=true;},close(){this.open=false;},before(){},append(){},appendChild(){},
      querySelector(selector){if(this.id==='guild-navigation'&&selector==='a,button')return nodes.find(node=>node.classList.contains('nav'));return element(this.id+':'+selector);},
      querySelectorAll(selector){if(this.id==='guild-navigation'&&selector==='a[href],button:not([disabled]):not([hidden])')return nodes.filter(node=>node.classList.contains('nav')&&!node.hidden&&!node.disabled);return [];},
      getClientRects(){return this.hidden?[]:[{width:1,height:1}];},reset(){for(const control of Object.values(this.elements))control.value='';},contains(other){return this===other;},
      dispatchEvent(event){for(const handler of listeners.get(event.type)||[])handler(event);return true;}};
    for(const [name,value]of Object.entries(attrs))if(name.startsWith('data-'))node.dataset[dataKey(name)]=value;
    node.parentElement={firstChild:{textContent:''}};
    node.elements=new Proxy({}, {get(target,key){if(typeof key==='symbol')return target[key];return target[key]??(target[key]=element(id+':field:'+key));}});
    return node;
  };
  const element=id=>{if(!elements.has(id))elements.set(id,make(id));return elements.get(id);};
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
    const attrs=attributes(match[2]);
    if(!attrs.id&&!attrs.class&&!Object.keys(attrs).some(name=>name.startsWith('data-')))continue;
    const node=attrs.id?element(attrs.id):make('node-'+nodes.length);
    Object.assign(node.attributes,attrs);node.hidden=Object.hasOwn(attrs,'hidden');node.classList=classes(attrs.class);
    for(const [name,value]of Object.entries(attrs))if(name.startsWith('data-'))node.dataset[dataKey(name)]=value;
    nodes.push(node);
  }
  const matching=selector=>{
    if(selector==='.hall-tabs [data-hall]')return matching('[data-hall]');
    if(selector.startsWith('.'))return nodes.filter(node=>node.classList.contains(selector.slice(1)));
    const data=selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
    if(data)return nodes.filter(node=>Object.hasOwn(node.attributes,data[1])&&(data[2]===undefined||node.attributes[data[1]]===data[2]));
    if(selector.startsWith('#'))return [element(selector.slice(1))];
    return [];
  };
  const listen=(map,type,handler)=>{const list=map.get(type)||[];list.push(handler);map.set(type,list);};
  const location={hash,pathname:'/guild',search:'',replace(value){calls.redirect=value;calls.clearedBeforeRedirect=document.body.textContent==='';}};
  const history={replaceState(_state,_unused,url){location.hash=String(url).includes('#')?'#'+String(url).split('#')[1]:'';},pushState(_state,_unused,url){this.replaceState(_state,_unused,url);}};
  const document={hidden:false,body:make('body'),documentElement:make('html'),getElementById:element,
    querySelector:selector=>matching(selector)[0]||element(selector),querySelectorAll:matching,
    createElement:tag=>make('created-'+tag+'-'+elements.size),addEventListener:(type,handler)=>listen(documentListeners,type,handler)};
  const window={location,innerWidth:width,addEventListener:(type,handler)=>listen(windowListeners,type,handler),dispatchEvent(event){for(const handler of windowListeners.get(event.type)||[])handler(event);return true;},scrollTo(){},matchMedia:()=>({matches:false,addEventListener(){}})};
  let hallPane='craft';
  const hallApi={isAdmin:()=>admin,pane:()=>hallPane,select(pane){hallPane=pane;selected.push(pane);for(const panel of matching('.hall-pane'))panel.hidden=panel.id!=='hall-'+pane;},load(){calls.hall++;},history(){calls.history++;}};
  if(withHall)window.GuildHall=hallApi;
  window.GuildAdventures={load(){calls.adventures++;},admin(){calls.admin++;}};
  class CustomEvent{constructor(type,options={}){this.type=type;this.detail=options.detail;}}
  const context=vm.createContext({document,window,location,history,CustomEvent,URL,URLSearchParams,Blob,Response,Date,console,
    setTimeout,clearTimeout,setInterval(){},clearInterval(){},requestAnimationFrame:fn=>fn(),
    matchMedia:window.matchMedia,localStorage:{getItem(){return null;},setItem(){}},
    fetch:async path=>{
      calls.fetch.push(path);
      if(failures.has(path)){const failure=failures.get(path);return Response.json(failure.data,{status:failure.status});}
      if(path==='/api/me')return Response.json({signed_in:true,verified:true,is_admin:admin,display_name:'Fixture Member',characters:[{id:1,name:'Fixture Member'}],player_links:[],csrf:'fixture-csrf',discord:{}});
      if(path==='/api/hall')return Response.json({events:[],requests:[],directory:[],popular:[]});
      if(path==='/api/evidence')return Response.json({endpoints:[]});
      if(path==='/api/admin/status')return Response.json({sync:{},refresh:{},limits:[]});
      if(path==='/api/history')return Response.json({activity:[],snapshots:[]});
      return Response.json({sync:{published:null},refresh:{},members:[],next:null});
    }});
  vm.runInContext(source,context);
  return {context,window,document,location,elements,element,nodes,selected,calls,hallApi,
    deny(path,status,data){failures.set(path,{status,data});},
    emit(type,detail){window.dispatchEvent(new CustomEvent(type,{detail}));},
    key(key,{shiftKey=false}={}){const event={type:'keydown',key,shiftKey,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};for(const handler of documentListeners.get('keydown')||[])handler(event);return event;},
    open(route,pane){return window.GuildRoute.open(route,pane);},
    active(){return matching('.nav').filter(node=>node.classList.contains('active'));},
    visiblePanels(){return matching('.tab-panel').filter(node=>!node.hidden).map(node=>node.id);},
    loadActualHall(){vm.runInContext(hall,context);}};
}

test('the private dashboard opens the overview with one selected navigation item',()=>{
  const p=page();
  assert.equal(p.window.GuildRoute.current(),'overview');
  assert.deepEqual(p.visiblePanels(),['overview']);
  assert.equal(p.active().length,1);
  assert.equal(p.active()[0].dataset.tab,'overview');
});

test('a cold Events deep link survives Hall loading after the main router',async()=>{
  const p=page({hash:'#events',withHall:false});
  assert.equal(p.window.GuildRoute.current(),'events');
  assert.equal(p.window.GuildRoute.pane(),'events');
  assert.deepEqual(p.visiblePanels(),['hall']);
  p.loadActualHall();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.element('hall-events').hidden,false);
  assert.equal(p.element('hall-craft').hidden,true);
  assert.equal(p.active().length,1);
});

test('initializing Hall does not steal the selected private roster route',async()=>{
  const p=page({hash:'#roster',withHall:false});p.loadActualHall();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.window.GuildRoute.current(),'roster');
  assert.deepEqual(p.visiblePanels(),['roster']);
  assert.equal(p.active().length,1);
});

test('direct guild routes select the requested pane and one main navigation item',()=>{
  const p=page();
  for(const [route,pane]of [['events','events'],['crafting','craft'],['wishlists','learn'],['members','people']]){
    p.open(route);
    assert.equal(p.window.GuildRoute.current(),route);
    assert.equal(p.window.GuildRoute.pane(),pane);
    assert.equal(p.selected.at(-1),pane);
    assert.deepEqual(p.visiblePanels(),['hall']);
    assert.equal(p.active().length,1,route+' must not activate every Hall navigation button');
    assert.equal(p.location.hash,'#'+route);
  }
});

test('reopening the same Hall pane does not reset its selection or form values',()=>{
  const p=page();p.open('events');
  const count=p.selected.length;p.element('event-form').elements.title.value='Unsaved event draft';
  p.open('events');
  assert.equal(p.selected.length,count);
  assert.equal(p.element('event-form').elements.title.value,'Unsaved event draft');
});

test('an event draft survives navigating away and back through the actual Hall controller',async()=>{
  const p=page({hash:'#events',withHall:false});p.loadActualHall();
  await new Promise(resolve=>setImmediate(resolve));
  p.element('event-form').elements.title.value='Keep this unsubmitted draft';
  p.open('crafting');p.open('events');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.element('event-form').elements.title.value,'Keep this unsubmitted draft');
  assert.equal(p.element('hall-events').hidden,false);
});

test('legacy Hall navigation retains the chosen pane and supports an explicit pane',()=>{
  const p=page();p.open('hall');
  assert.equal(p.window.GuildRoute.pane(),'craft');
  assert.deepEqual(p.visiblePanels(),['hall']);
  p.open('events');p.open('hall');
  assert.equal(p.window.GuildRoute.pane(),'events');
  p.open('hall','people');assert.equal(p.window.GuildRoute.pane(),'people');
  assert.equal(p.active().length,1);
});

test('the admin route remains inaccessible without the administrator session',()=>{
  const p=page({admin:false});p.open('roster');p.open('status');
  assert.equal(p.window.GuildRoute.current(),'roster');
  assert.equal(p.element('status').hidden,true);
  assert.equal(p.calls.admin,0);
  assert(!p.calls.fetch.some(path=>path.startsWith('/api/admin/')));
});

test('an administrator can open connection controls through the guarded route',async()=>{
  const p=page({admin:true});p.open('status');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.window.GuildRoute.current(),'status');
  assert.deepEqual(p.visiblePanels(),['status']);
  assert.equal(p.calls.admin,1);
  assert(p.calls.fetch.includes('/api/admin/status'));
});

test('a closed mobile menu is inert while the selected page remains interactive',()=>{
  const p=page({width:390});
  assert.equal(p.element('guild-navigation').inert,true);
  assert.equal(p.element('guild-navigation').getAttribute('aria-hidden'),'true');
  assert.equal(p.element('content').inert,false);
  assert.equal(p.element('navigation-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(p.element('navigation-backdrop').hidden,true);
});

test('opening and escaping the mobile menu moves focus and restores page interaction',()=>{
  const p=page({width:390}),toggle=p.element('navigation-toggle');
  toggle.dispatchEvent({type:'click'});
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(p.element('guild-navigation').inert,false);
  assert.equal(p.element('guild-navigation').getAttribute('aria-hidden'),null);
  assert.equal(p.element('content').inert,true);
  assert.equal(p.element('navigation-backdrop').hidden,false);
  assert.equal(p.document.body.style.overflow,'hidden');
  assert(p.document.activeElement.classList.contains('nav'));
  assert.equal(p.key('Escape').defaultPrevented,true);
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(p.element('guild-navigation').inert,true);
  assert.equal(p.element('content').inert,false);
  assert.equal(p.element('navigation-backdrop').hidden,true);
  assert.equal(p.document.body.style.overflow,'');
  assert.equal(p.document.activeElement,toggle);
});

test('selecting a mobile navigation item closes the drawer and focuses the new page heading',()=>{
  const p=page({width:390});p.element('navigation-toggle').dispatchEvent({type:'click'});
  const events=p.nodes.find(node=>node.classList.contains('nav')&&node.dataset.tab==='hall'&&node.dataset.pane==='events');
  assert(events,'Events must have a direct navigation control');
  events.dispatchEvent({type:'click'});
  assert.equal(p.window.GuildRoute.current(),'events');
  assert.equal(p.location.hash,'#events');
  assert.equal(p.element('navigation-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(p.element('guild-navigation').inert,true);
  assert.equal(p.element('content').inert,false);
  assert.equal(p.document.activeElement,p.element('page-title'));
  assert.equal(p.element('page-title').getAttribute('tabindex'),'-1');
});

test('Tab and Shift-Tab stay within an open mobile navigation drawer',()=>{
  const p=page({width:390});p.element('navigation-toggle').dispatchEvent({type:'click'});
  const controls=p.element('guild-navigation').querySelectorAll('a[href],button:not([disabled]):not([hidden])');
  assert(controls.length>1);
  controls.at(-1).focus();assert.equal(p.key('Tab').defaultPrevented,true);
  assert.equal(p.document.activeElement,controls[0]);
  controls[0].focus();assert.equal(p.key('Tab',{shiftKey:true}).defaultPrevented,true);
  assert.equal(p.document.activeElement,controls.at(-1));
});

test('resizing to desktop restores normal sidebar interaction after the mobile drawer closes',()=>{
  const p=page({width:390});
  assert.equal(p.element('guild-navigation').inert,true);
  p.window.innerWidth=1280;p.emit('resize');
  assert.equal(p.element('guild-navigation').inert,false);
  assert.equal(p.element('guild-navigation').getAttribute('aria-hidden'),null);
  assert.equal(p.element('content').inert,false);
});

test('signing out immediately clears member-only overview events and crafting details',()=>{
  const p=page();
  p.emit('guild-member',{verified:true,is_admin:false,characters:[]});
  p.emit('guild-hall-data',{
    events:[{id:'private-event',title:'Private event sentinel',kind:'Dungeon',status:'open',starts_at:new Date(Date.now()+3600000).toISOString(),duration_minutes:120,capacity:5,signups:[]}],
    requests:[{id:'private-request',item_name:'Private craft sentinel',kind:'craft',status:'open',quantity:1,character_name:'Example Character',created_at:new Date().toISOString()}]
  });
  const privateCards=()=>['overview-events','overview-crafts'].map(id=>p.element(id).innerHTML).join(' ');
  assert(privateCards().includes('Private event sentinel'));
  assert(privateCards().includes('Private craft sentinel'));
  p.emit('guild-member',{verified:false,is_admin:false,characters:[]});
  assert(!privateCards().includes('Private event sentinel'));
  assert(!privateCards().includes('Private craft sentinel'));
});

test('signing out through the Hall clears the dashboard and returns to the welcome page without refetching member data',async()=>{
  const p=page({withHall:false});p.loadActualHall();await new Promise(resolve=>setImmediate(resolve));
  const before=p.calls.fetch.filter(path=>path==='/api/me').length;p.document.body.textContent='Private dashboard sentinel';
  p.element('sign-out').dispatchEvent({type:'click'});await new Promise(resolve=>setImmediate(resolve));
  assert(p.calls.fetch.includes('/auth/logout'));assert.equal(p.calls.fetch.filter(path=>path==='/api/me').length,before);
  assert.equal(p.document.body.textContent,'');assert.equal(p.calls.redirect,'/');assert.equal(p.calls.clearedBeforeRedirect,true);
});

for(const [status,data]of [[401,{error:'Session expired'}],[403,{error:'Guild membership is no longer verified',access_required:true}]])test('a '+status+' membership denial clears the private dashboard before returning to welcome',async()=>{
  const p=page();p.document.body.textContent='Private roster sentinel';p.deny('/api/status',status,data);
  await assert.rejects(vm.runInContext('fetchJSON("/api/status")',p.context),/Sign in to reopen/);
  assert.equal(p.document.body.textContent,'');assert.equal(p.calls.redirect,'/');assert.equal(p.calls.clearedBeforeRedirect,true);
  assert(!p.calls.fetch.some(path=>path.startsWith('/api/members')));
});

test('an administrator-only permission refusal preserves an otherwise valid member dashboard',async()=>{
  const p=page();p.document.body.textContent='Private roster sentinel';p.deny('/api/admin/status',403,{error:'Administrator access is required'});
  await assert.rejects(vm.runInContext('fetchJSON("/api/admin/status")',p.context),/Administrator access/);
  assert.equal(p.document.body.textContent,'Private roster sentinel');assert.equal(p.calls.redirect,undefined);
});

test('a cleared Hall data notification removes cached private overview cards',()=>{
  const p=page();p.emit('guild-member',{verified:true,is_admin:false,characters:[]});
  p.emit('guild-hall-data',{events:[{id:'private-event',title:'Clear this private event',kind:'Dungeon',status:'open',starts_at:new Date(Date.now()+3600000).toISOString(),duration_minutes:120,capacity:5,signups:[]}],requests:[]});
  assert(p.element('overview-events').innerHTML.includes('Clear this private event'));
  p.emit('guild-hall-data',null);
  assert(!p.element('overview-events').innerHTML.includes('Clear this private event'));
});

test('the redesigned markup retains unique control IDs and all existing form anchors',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'DOM IDs must remain unique');
  const required=['content','overview','roster','professions','recipes','status','hall','adventures','history','data-nav',
    'roster-body','roster-search','class-filter','sort','group-roster','grouping-note','member-dialog','member-content',
    'stat-members','stat-members-note','stat-classes','stat-professions','stat-professions-note','stat-recipes',
    'last-refresh','refresh-timing','profession-freshness','notice','connection','updated','refresh-wow','refresh-wow-feedback',
    'sign-in','sign-out','hall-gate','hall-gate-message','hall-member','hall-feedback','hall-welcome',
    'hall-craft','hall-learn','hall-events','hall-people','craft-form','craft-list','craft-status','crafter-picker','craft-crafters',
    'learn-form','learn-list','event-form','event-list','member-directory','main-form','main-character','alt-options','rp-form','rp-character',
    'discord-link','discord-member-status','discord-event-note','discord-preferences','discord-unlink','known-recipes',
    'history-character','activity-list','snapshot-list','quest-form','quest-gate','quest-member','quest-area','quest-characters','quest-shared-only','quest-result',
    'discord-config-form','discord-check','discord-verification','character-mappings-panel','character-mapping-form','character-mappings-list'];
  for(const id of required)assert(ids.includes(id),'Missing control anchor '+id);
  const dynamicIds=new Set(['craft-materials','expand-components','manual-material-label','popular-list']);
  const referenced=[...[app,hall,adventures].join('\n').matchAll(/(?:\$|el)\('([^']+)'\)/g)].map(match=>match[1]);
  for(const id of new Set(referenced))assert(ids.includes(id)||dynamicIds.has(id),'Missing script-referenced control '+id);
  const forms={
    'craft-form':['character_id','item_name','quantity','materials','notes'],
    'learn-form':['character_id','item_name','notes'],
    'event-form':['character_id','title','kind','capacity','starts_at','duration_minutes','location','description'],
    'main-form':['character_id'],'rp-form':['character_id','title','biography','looking_for'],
    'discord-preferences':['requester_dm','crafter_dm'],
    'character-mapping-form':['character_id','discord_id','preferred','crafter_dm']
  };
  for(const [id,names]of Object.entries(forms)){
    const form=html.match(new RegExp('<form\\b[^>]*\\bid="'+id+'"[^>]*>([\\s\\S]*?)<\\/form>'));
    assert(form,'Missing form '+id);
    const fields=new Set([...form[1].matchAll(/\bname="([^"]+)"/g)].map(match=>match[1]));
    for(const name of names)assert(fields.has(name),id+' must retain field '+name);
    assert(/<button\b[^>]*type="submit"/.test(form[1]),id+' must retain its submit control');
  }
});
