import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const hall=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8');
const appSource=app.slice(0,app.lastIndexOf('load();setInterval('));
const roleSource=app.slice(app.indexOf("const roleChoices="),app.indexOf('const profileState='));
const character=(id,extra={})=>({id,name:'Character '+id,slug:'character-'+id,class:'Priest',level:20,rank:1,...extra});
function roster(characters){
  const elements=new Map(),listeners=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{id,value:id==='sort'?'name':'',hidden:false,open:false,innerHTML:'',textContent:'',classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){}});return elements.get(id);};
  const context=vm.createContext({fixture:characters,document:{getElementById:element,querySelector:()=>element('dialog-close'),querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(type,fn){listeners.set(type,fn);}},location:{hash:''},history:{replaceState(){}}});
  vm.runInContext(appSource,context);
  vm.runInContext("members=fixture;status={sync:{published:'current'}};renderRoster();renderCompositions();",context);
  return {context,element,emit(detail){listeners.get('guild-role-saved')({detail});},roles(){return element('role-composition').innerHTML;}};
}

test('role composition counts only declared primary roles, includes zero roles, and does not infer from class or talents',()=>{
  const p=roster([
    character(1,{preferred_roles:['Damage','Healer'],primary_role:'Damage'}),
    character(2,{class:'Druid',preferred_roles:['Tank','Healer','Damage'],primary_role:'Healer'}),
    character(3,{talents:[{name:'Restoration',points:31}]}),
    character(4,{class:'Mage',preferred_roles:['Healer'],primary_role:'Healer'})
  ]);
  assert.match(p.roles(),/<span>Healer<\/span><span>2<\/span>/);
  assert.match(p.roles(),/<span>Damage<\/span><span>1<\/span>/);
  assert.match(p.roles(),/<span>Tank<\/span><span>0<\/span>/);
  assert.match(p.element('role-composition-note').textContent,/3 of 4 characters/);
  assert.match(p.element('role-composition-note').textContent,/primary choices only/);
  assert.match(p.element('role-composition-note').textContent,/include alts/);
  assert.match(p.element('roster-body').innerHTML,/Damage · primary/);
  assert.match(p.element('roster-body').innerHTML,/Healer · additional/);
  assert.match(p.element('roster-body').innerHTML,/Roles not set/);
});

test('saved role changes and clearing immediately replace the previous roster role counts',()=>{
  const p=roster([character(1,{preferred_roles:['Healer','Damage'],primary_role:'Healer'}),character(2)]);
  p.emit({character_id:1,preferred_roles:['Tank','Damage'],primary_role:'Tank',role_preferences_updated_at:'2026-11-09T08:00:00Z'});
  assert.match(p.roles(),/<span>Tank<\/span><span>1<\/span>/);
  assert.match(p.roles(),/<span>Healer<\/span><span>0<\/span>/);
  assert.doesNotMatch(p.element('roster-body').innerHTML,/Healer · primary/);
  p.emit({character_id:1,preferred_roles:[],primary_role:null,role_preferences_updated_at:null});
  assert.match(p.roles(),/<span>Tank<\/span><span>0<\/span>/);
  assert.match(p.element('role-composition-note').textContent,/0 of 2 characters/);
  assert.doesNotMatch(p.element('roster-body').innerHTML,/· primary/);
});

test('unknown, repeated or inconsistent role fields cannot render arbitrary markup or invent a primary role',()=>{
  const context=vm.createContext({});vm.runInContext(roleSource,context);
  const value={preferred_roles:['Damage','Healer','Healer','<img src=x onerror=alert(1)>'],primary_role:'Healer'};
  const badges=context.roleBadges(value);
  assert.match(badges,/Healer · primary/);assert.match(badges,/Damage · additional/);
  assert.equal((badges.match(/Healer/g)||[]).length,1);assert.doesNotMatch(badges,/<img|onerror/);
  for(const item of [{class:'Priest'},{preferred_roles:['Damage'],primary_role:'Healer'},{preferred_roles:'Healer',primary_role:'Healer'},{preferred_roles:['<script>'],primary_role:'<script>'}]){
    assert.match(context.roleBadges(item),/Roles not set/);
    assert.deepEqual(JSON.parse(JSON.stringify(context.rolePreference(item))),{preferred_roles:[],primary_role:null});
  }
});

const clean=value=>JSON.parse(JSON.stringify(value));
function editor(){
  const elements=new Map(),listeners=new Map(),events=[],sends=[],calls={loads:0,renders:0},state={failure:null,delay:null};
  let controls=[];
  const node=id=>{
    const value={id,value:'',disabled:false,textContent:'',hidden:false,classList:{toggle(){}},elements:{},
      addEventListener(type,handler){listeners.set(id+':'+type,handler);},
      querySelector(selector){return selector.includes('submit')?element('role-submit'):element(id+':'+selector);},
      querySelectorAll(selector){const name=selector.match(/name="([^"]+)"/)?.[1];return controls.filter(control=>control.name===name&&(!selector.endsWith(':checked')||control.checked));}};
    let html='';Object.defineProperty(value,'innerHTML',{get:()=>html,set:text=>{html=text;if(id==='role-options')controls=[...text.matchAll(/<input\b([^>]*)>/g)].map(match=>{
      const attrs=Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(attr=>[attr[1],attr[2]??'']));
      return {name:attrs.name,value:attrs.value,checked:Object.hasOwn(attrs,'checked'),disabled:Object.hasOwn(attrs,'disabled'),required:Object.hasOwn(attrs,'required')};
    });}});return value;
  };
  const element=id=>{if(!elements.has(id))elements.set(id,node(id));return elements.get(id);};
  const form=element('role-form');form.elements.character_id=element('role-character');
  Object.defineProperty(form.elements,'primary_role',{get:()=>({value:controls.find(control=>control.name==='primary_role'&&control.checked)?.value||''})});
  const me={user_id:'owner-a',csrf:'session-a',verified:true,signed_in:true,characters:[character(1,{preferred_roles:['Healer'],primary_role:'Healer'}),character(2,{preferred_roles:['Damage'],primary_role:'Damage'})]};
  const context=vm.createContext({me,hall:{directory:clean(me.characters),people:[{characters:clean(me.characters)}]},el:element,roleDrafts:new Map(),profileDrafts:new Map(),rolesSaving:false,
    window:{dispatchEvent(event){events.push(clean(event));}},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    async send(path,body){sends.push({path,body:clean(body)});if(state.delay)await state.delay;if(state.failure)throw Error(state.failure);return {...body,message:'Saved. You can change roles any time.',role_preferences_updated_at:'2026-11-09T08:00:00Z'};},
    async loadHall(){calls.loads++;},renderDirectory(){calls.renders++;},renderDiscord(){},fillOwned(){context.fillRoles();},
    async fetchJSON(){return clean(state.account||context.me);}});
  vm.runInContext(roleSource,context);
  const start=hall.indexOf('  function readRoleChoices('),end=hall.indexOf('  function renderAltChoices(',start);
  assert(start>=0&&end>start,'Role editor behavior must remain available to the fixture');
  vm.runInContext(hall.slice(start,end),context);
  const refreshStart=hall.indexOf('  let accountRefreshVersion='),refreshEnd=hall.indexOf('  function renderDiscord(){',refreshStart);
  vm.runInContext(hall.slice(refreshStart,refreshEnd),context);
  const clearLine=hall.split('\n').find(line=>line.includes("el('clear-roles').addEventListener('click',"));
  assert(clearLine,'The editor must provide an explicit clear choice');vm.runInContext(clearLine,context);
  element('role-character').value='1';context.fillRoles();
  return {context,element,events,sends,calls,state,controls:()=>controls,
    value:()=>clean(context.readRoleChoices()),draft:id=>clean(context.roleDrafts.get(String(id))),
    select(id){element('role-character').value=String(id);context.fillRoles();},
    choose(roles,primary){for(const input of controls)input.checked=input.name==='preferred_role'?roles.includes(input.value):input.value===primary;context.keepRoleDraft();},
    clear(){listeners.get('clear-roles:click')();},
    async refresh(account){state.account=account;await context.refreshMe();},
    save(){return context.saveRoles({preventDefault(){},currentTarget:form});}};
}

test('role edits stay separate per character, survive same-account refreshes, and require a new primary when the old primary is removed',async()=>{
  const p=editor();p.choose(['Tank','Healer','Damage'],'Healer');
  p.select(2);assert.deepEqual(p.value(),{preferred_roles:['Damage'],primary_role:'Damage'});
  p.choose(['Tank','Damage'],'Tank');p.select(1);
  assert.deepEqual(p.value(),{preferred_roles:['Tank','Healer','Damage'],primary_role:'Healer'});
  await p.refresh(clean(p.context.me));
  assert.deepEqual(p.value(),{preferred_roles:['Tank','Healer','Damage'],primary_role:'Healer'});
  p.choose(['Damage'], 'Healer');
  assert.deepEqual(p.value(),{preferred_roles:['Damage'],primary_role:null});
  const radios=p.controls().filter(control=>control.name==='primary_role');
  assert.equal(radios.find(input=>input.value==='Healer').disabled,true);
  assert.equal(radios.find(input=>input.value==='Damage').required,true);
  assert(radios.every(input=>!input.checked));
  assert.match(p.element('role-feedback').textContent,/Choose one selected role as primary/);
});

test('saving several roles publishes one primary and the same character can change its saved preference later',async()=>{
  const p=editor();p.choose(['Healer','Damage'],'Healer');await p.save();
  assert.deepEqual(p.sends[0],{path:'/api/hall/roles',body:{character_id:1,preferred_roles:['Healer','Damage'],primary_role:'Healer'}});
  assert.equal(p.context.roleDrafts.has('1'),false);
  assert.equal(p.context.me.characters[0].primary_role,'Healer');
  assert.deepEqual(clean(p.context.hall.people[0].characters[0].preferred_roles),['Healer','Damage']);
  assert.equal(p.events.find(event=>event.type==='guild-role-saved').detail.primary_role,'Healer');
  p.choose(['Tank','Damage'],'Damage');await p.save();
  assert.equal(p.sends.length,2);assert.equal(p.context.me.characters[0].primary_role,'Damage');
  assert.equal(p.context.hall.directory[0].primary_role,'Damage');
  assert.equal(p.events.filter(event=>event.type==='guild-role-saved').at(-1).detail.primary_role,'Damage');
  assert.equal(p.element('role-character').disabled,false);
});

test('clearing choices is a local edit until Save and sends an explicit empty selection',async()=>{
  const p=editor();p.clear();
  assert.equal(p.sends.length,0);assert.equal(p.context.me.characters[0].primary_role,'Healer');
  assert.deepEqual(p.value(),{preferred_roles:[],primary_role:null});
  p.select(2);p.select(1);assert.deepEqual(p.value(),{preferred_roles:[],primary_role:null});
  await p.save();assert.deepEqual(p.sends[0].body,{character_id:1,preferred_roles:[],primary_role:null});
  assert.equal(p.context.me.characters[0].primary_role,null);
  assert.deepEqual(clean(p.context.me.characters[0].preferred_roles),[]);
});

test('an incomplete selection cannot save and a server failure keeps editable choices for retry',async()=>{
  const p=editor();p.choose(['Damage'],null);await p.save();assert.equal(p.sends.length,0);
  p.choose(['Tank','Damage'],'Tank');p.state.failure='Please sign in again';await p.save();
  assert.match(p.element('role-feedback').textContent,/Please sign in again/);
  assert.deepEqual(p.draft(1),{preferred_roles:['Tank','Damage'],primary_role:'Tank'});
  assert.equal(p.events.filter(event=>event.type==='guild-role-saved').length,0);
  assert.equal(p.element('role-submit').disabled,false);assert.equal(p.element('role-character').disabled,false);
  p.state.failure=null;await p.save();assert.equal(p.context.me.characters[0].primary_role,'Tank');
});

test('account changes clear role drafts and an old account save response cannot publish into the new account',async()=>{
  const p=editor();p.choose(['Damage'],'Damage');
  let finish;p.state.delay=new Promise(resolve=>{finish=resolve;});const pending=p.save();
  await p.refresh({user_id:'owner-b',csrf:'session-b',verified:true,signed_in:true,characters:[character(3)]});
  assert.equal(p.context.roleDrafts.size,0);finish();await pending;
  assert.equal(p.context.me.characters[0].id,3);assert.equal(p.context.me.characters[0].primary_role,undefined);
  assert.equal(p.events.filter(event=>event.type==='guild-role-saved').length,0);
  assert.equal(p.element('role-character').disabled,false,'An old account response must not leave the current editor locked');
  p.select(3);assert.equal(p.element('role-submit').disabled,false);
  await p.refresh({signed_in:false,verified:false,characters:[]});assert.equal(p.context.roleDrafts.size,0);
});
