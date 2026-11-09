import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(0,app.lastIndexOf('load();setInterval('));
const key=id=>'wv:roster-view:v1:'+id;
const characters=[{id:1,name:'Alpha Main',slug:'alpha-main',level:10,rank:1,class:'Mage'},
  {id:2,name:'Zulu Alt',slug:'zulu-alt',level:30,rank:2,class:'Mage'},
  {id:3,name:'Beta Main',slug:'beta-main',level:20,rank:3,class:'Mage'}];
function page(storage=new Map(),options={}){
  const elements=new Map(),listeners=new Map(),windowListeners=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{id,value:id==='sort'?'name':'',hidden:false,innerHTML:'',textContent:'',
    classList:{toggle(){},add(){},remove(){}},setAttribute(){},addEventListener(type,handler){const k=id+':'+type;if(!listeners.has(k))listeners.set(k,[]);listeners.get(k).push(handler);}});return elements.get(id);};
  const context=vm.createContext({fixture:characters,document:{getElementById:element,querySelector:()=>element('dialog-close'),querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(type,handler){if(!windowListeners.has(type))windowListeners.set(type,[]);windowListeners.get(type).push(handler);}},location:{hash:''},history:{replaceState(){}},
    localStorage:{getItem(k){if(options.readBlocked)throw Error('Storage blocked');return storage.get(k)??null;},setItem(k,v){if(options.writeBlocked)throw Error('Storage full');storage.set(k,v);}}});
  vm.runInContext(source,context);
  vm.runInContext("members=fixture;rosterLinks=[{character_id:1,user_id:'linked-player',main_character_id:1},{character_id:2,user_id:'linked-player',main_character_id:1}];status={sync:{published:'current'}};renderRoster();",context);
  const emit=(id,verified=true)=>{for(const fn of windowListeners.get('guild-member')||[])fn({detail:{user_id:id,verified,is_admin:false}});};
  const fire=(id,type)=>{for(const fn of listeners.get(id+':'+type)||[])fn({});};
  return {context,storage,emit,display(groups){context.fixtureGroups=groups;vm.runInContext('rosterDisplayGroups=fixtureGroups;rosterLinks=[];renderRoster()',context);},search(value){element('roster-search').value=value;vm.runInContext('renderRoster()',context);},expand(key){context.fixtureKey=key;vm.runInContext('expandedPlayers.add(fixtureKey);renderRoster()',context);},html(){return element('roster-body').innerHTML;},sort(value,type='input'){element('sort').value=value;fire('sort',type);},group(){fire('group-roster','click');},
    redraw(){vm.runInContext('renderRoster()',context);},state(){return {sort:element('sort').value,grouped:vm.runInContext('groupedRoster',context)};},
    names(){return [...element('roster-body').innerHTML.matchAll(/class="member-name"[^>]*>([^<]+)<\/button>/g)].map(m=>m[1]);}};
}

test('a full reload restores the account sort and main/alt grouping, including the false grouping choice',()=>{
  const storage=new Map(),first=page(storage);first.emit('account-a');first.sort('level');first.group();
  assert.deepEqual(first.names(),['Zulu Alt','Beta Main','Alpha Main']);
  const reload=page(storage);reload.emit('account-a');
  assert.deepEqual(reload.state(),{sort:'level',grouped:false});assert.deepEqual(reload.names(),first.names());
  reload.group();reload.sort('rank','change');
  const next=page(storage);next.emit('account-a');assert.deepEqual(next.state(),{sort:'rank',grouped:true});assert.deepEqual(next.names(),['Alpha Main','Beta Main']);
});

test('canonical display groups combine mapped alts under one escaped Discord person and remain searchable',()=>{
  const p=page(),groupKey='A'.repeat(43);p.emit('account-a');p.display([{key:groupKey,display_name:'Guild Friend <unsafe>',discord_linked:true,main_character_id:1,character_ids:[1,2]}]);
  assert.deepEqual(p.names(),['Alpha Main','Beta Main']);assert.match(p.html(),/Guild Friend &lt;unsafe&gt;/);assert(!p.html().includes('Guild Friend <unsafe>'));
  p.search('Guild Friend');assert.deepEqual(p.names(),['Alpha Main','Zulu Alt']);
  p.search('');p.expand('person:'+groupKey);assert.deepEqual(p.names(),['Alpha Main','Zulu Alt','Beta Main']);p.redraw();assert.deepEqual(p.names(),['Alpha Main','Zulu Alt','Beta Main']);
  p.group();assert.deepEqual(p.names(),['Alpha Main','Beta Main','Zulu Alt'],'Ungrouped remains an explicit per-account view choice');
});
test('automatic redraws and repeated account refreshes preserve the selected view',()=>{
  const p=page();p.emit('account-a');p.sort('level');p.group();p.redraw();p.emit('account-a');p.redraw();
  assert.deepEqual(p.state(),{sort:'level',grouped:false});assert.deepEqual(p.names(),['Zulu Alt','Beta Main','Alpha Main']);
});
test('accounts on the same browser keep separate preferences through switches and sign-out',()=>{
  const storage=new Map(),p=page(storage);p.emit('account-a');p.sort('level');p.group();
  p.emit('account-b');assert.deepEqual(p.state(),{sort:'name',grouped:true});p.sort('rank');
  p.emit('account-a');assert.deepEqual(p.state(),{sort:'level',grouped:false});
  p.emit(null,false);assert.deepEqual(p.state(),{sort:'name',grouped:true});
  p.emit('account-b');assert.deepEqual(p.state(),{sort:'rank',grouped:true});
  assert.deepEqual(page(storage).state(),{sort:'name',grouped:true});
});
test('a choice made while the account request is pending is kept and saved when identity arrives',()=>{
  const storage=new Map([[key('account-a'),JSON.stringify({v:1,sort:'rank',grouped:true})]]),p=page(storage);
  p.sort('level');p.group();assert.equal(storage.get(key('account-a')),JSON.stringify({v:1,sort:'rank',grouped:true}));
  p.emit('account-a');assert.deepEqual(p.state(),{sort:'level',grouped:false});
  const reload=page(storage);reload.emit('account-a');assert.deepEqual(reload.state(),p.state());
});
test('invalid preference values, unsupported versions and unavailable storage do not break the roster',()=>{
  for(const raw of ['not JSON','null',JSON.stringify({v:99,sort:'level',grouped:false}),JSON.stringify({v:1,sort:'<script>',grouped:'false'}),'x'.repeat(300)]){
    const p=page(new Map([[key('account-a'),raw]]));p.emit('account-a');assert.deepEqual(p.state(),{sort:'name',grouped:true});
  }
  const p=page(new Map(),{readBlocked:true,writeBlocked:true});assert.doesNotThrow(()=>{p.emit('account-a');p.sort('level');p.group();p.redraw();});assert.deepEqual(p.state(),{sort:'level',grouped:false});
});
test('only validated display choices are stored; invalid or unverified identities cannot select a storage account',()=>{
  const storage=new Map(),p=page(storage);p.emit('../foreign-account');p.sort('level');assert.equal(storage.size,0);
  p.emit('unverified-account',false);p.group();assert.equal(storage.size,0);
  p.emit('account-a');p.sort('rank');
  assert.deepEqual([...storage.keys()],[key('account-a')]);assert.deepEqual(JSON.parse(storage.get(key('account-a'))),{v:1,sort:'rank',grouped:false});
  for(const secret of ['Alpha Main','linked-player','csrf','token','character_id'])assert(!storage.get(key('account-a')).includes(secret));
});
