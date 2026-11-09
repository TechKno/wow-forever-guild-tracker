import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8');
const OLD='2026-11-09T10:00:00.000Z',NEW='2026-11-09T10:01:00.000Z',LATEST='2026-11-09T10:02:00.000Z';
const clean=value=>JSON.parse(JSON.stringify(value));
const session=(revision=OLD,main=1)=>({signed_in:true,verified:true,user_id:'fixture-owner',csrf:'fixture-csrf',account_updated_at:revision,main_character_id:main,display_name:'Character '+main,characters:[{id:1,name:'Character 1',show_as_alt:main!==1},{id:2,name:'Character 2',show_as_alt:main!==2}],player_links:[{character_id:1,user_id:'fixture-owner',main_character_id:main},{character_id:2,user_id:'fixture-owner',main_character_id:main}],discord:{}});
const hallData=marker=>({marker,events:[],requests:[],directory:[],people:[]});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle(){for(let n=0;n<3;n++)await new Promise(resolve=>setImmediate(resolve));}
function page(){
  const events=[],calls=[],listeners=new Map(),elements=new Map(),accepted=[],rendered=[],feedback=[],replies={me:[],hall:[]};
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',innerHTML:'',classList:{toggle(){}},querySelector(){return {textContent:''};}});return elements.get(id);};
  const window={GuildAccount:{render(value){accepted.push(clean(value));}},addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(handler);},dispatchEvent(event){events.push({type:event.type,detail:clean(event.detail)});for(const handler of listeners.get(event.type)||[])handler(event);}};
  const context=vm.createContext({me:session(),hall:null,busy:false,roleDrafts:new Map(),profileDrafts:new Map(),window,el,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},renderDiscord(){},fillOwned(){},renderRequests(){},renderDirectory(){rendered.push(clean(context.hall));},fillProfile(){},eventCard(){return '';},feedback(message){feedback.push(message);},async fetchJSON(path){calls.push(path);assert(calls.length<30,'A refresh event must not create an infinite request loop');const queue=path==='/api/me'?replies.me:replies.hall;assert(queue.length,'Unexpected '+path+' request');return clean(await queue.shift());}});
  const start=source.indexOf('  let accountRefreshVersion='),end=source.indexOf('  function renderDiscord(){',start),loadStart=source.indexOf('  function loadHall(options='),loadEnd=source.indexOf('  function recipeInput(){',loadStart);
  assert(start>=0&&end>start&&loadStart>=0&&loadEnd>loadStart);vm.runInContext(source.slice(start,end)+'\n'+source.slice(loadStart,loadEnd),context);
  vm.runInContext("window.addEventListener('guild-account-saved',accountSaved);",context);
  return {context,calls,events,accepted,rendered,feedback,replies,window,load:options=>context.loadHall(options),refresh:()=>context.refreshMe(),save(revision=NEW,user_id='fixture-owner'){window.dispatchEvent(new context.CustomEvent('guild-account-saved',{detail:{user_id,account_updated_at:revision}}));},players:()=>events.filter(event=>event.type==='guild-players'),halls:()=>events.filter(event=>event.type==='guild-hall-data')};
}

test('saving while an old account refresh is pending prevents stale player links and queues one fresh Hall load',async()=>{
  const p=page(),old=deferred();p.replies.me.push(old.promise,session(NEW,2));p.replies.hall.push(hallData('fresh'));
  const pending=p.load();assert.deepEqual(p.calls,['/api/me']);p.save();old.resolve(session());await pending;await settle();
  assert.deepEqual(p.calls,['/api/me','/api/me','/api/hall']);assert.deepEqual(p.players().map(event=>event.detail[0].main_character_id),[2]);assert.deepEqual(p.accepted.map(value=>value.account_updated_at),[NEW]);assert.deepEqual(p.halls().map(event=>event.detail.marker),['fresh']);
});

test('a Hall payload started before the main save cannot overwrite the new directory or dispatch stale Hall groups',async()=>{
  const p=page(),oldHall=deferred();p.replies.me.push(session(),session(NEW,2));p.replies.hall.push(oldHall.promise,hallData('fresh directory'));
  const pending=p.load();await settle();assert.deepEqual(p.calls,['/api/me','/api/hall']);p.save();oldHall.resolve(hallData('obsolete directory'));await pending;await settle();
  assert.deepEqual(p.rendered.map(value=>value.marker),['fresh directory']);assert.deepEqual(p.halls().map(event=>event.detail.marker),['fresh directory']);assert.equal(p.context.me.main_character_id,2);
});

test('several saves during one busy request coalesce while retaining the newest account revision floor',async()=>{
  const p=page(),old=deferred();p.replies.me.push(old.promise,session(LATEST,2));p.replies.hall.push(hallData('latest'));
  const pending=p.load();p.save(NEW);p.save(LATEST);old.resolve(session());await pending;await settle();
  assert.deepEqual(p.calls,['/api/me','/api/me','/api/hall']);assert.deepEqual(p.accepted.map(value=>value.account_updated_at),[LATEST]);
  p.replies.me.push(session(NEW,1));assert.equal(await p.refresh(),false);assert.equal(p.context.me.main_character_id,2);assert.equal(p.players().length,1);
});

test('out-of-order account responses cannot replace a newer accepted account revision',async()=>{
  const p=page(),old=deferred();p.replies.me.push(old.promise,session(NEW,2));const first=p.refresh(),second=p.refresh();assert.equal(await second,true);old.resolve(session());assert.equal(await first,false);
  assert.equal(p.context.me.main_character_id,2);assert.deepEqual(p.players().map(event=>event.detail[0].main_character_id),[2]);
  p.replies.me.push(session());assert.equal(await p.refresh(),false);assert.equal(p.context.me.account_updated_at,NEW);
});

test('ordinary reentrant hierarchy loads share the running request and never queue an endless refresh loop',async()=>{
  const p=page();p.replies.me.push(session());p.replies.hall.push(hallData('one pass'));
  p.window.addEventListener('guild-member',()=>p.load());await p.load();await settle();assert.deepEqual(p.calls,['/api/me','/api/hall']);assert.equal(p.halls().length,1);assert.equal(p.feedback.length,0);
});

test('explicit save refreshes queue safely while ordinary busy loads do not invalidate the running response',async()=>{
  const p=page(),old=deferred();p.replies.me.push(old.promise,session(NEW,2));p.replies.hall.push(hallData('explicit save'));
  const first=p.load();p.load();p.load({queue:true});old.resolve(session());await first;await settle();assert.deepEqual(p.calls,['/api/me','/api/me','/api/hall']);assert.equal(p.context.me.main_character_id,2);
});

test('an obsolete failed request cannot display an error over the successful post-save refresh',async()=>{
  const p=page(),old=deferred();p.replies.me.push(old.promise,session(NEW,2));p.replies.hall.push(hallData('after error'));
  const pending=p.load();p.save();old.reject(Error('Obsolete response failure'));await pending;await settle();assert.deepEqual(p.feedback,[]);assert.deepEqual(p.halls().map(event=>event.detail.marker),['after error']);
});

test('a save event from another account cannot change the active account or cause a request',async()=>{
  const p=page();p.save(NEW,'different-owner');await settle();assert.deepEqual(p.calls,[]);assert.equal(p.context.me.main_character_id,1);
});
