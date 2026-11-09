import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/account.js',import.meta.url),'utf8');
const clean=value=>JSON.parse(JSON.stringify(value));
const character=(id,extra={})=>({id,name:'Fictional '+id,class:'Priest',level:20,show_as_alt:id===2,preferred_roles:['Healer','Damage'],primary_role:'Healer',...extra});
const session=extra=>({signed_in:true,verified:true,user_id:'account-a',csrf:'csrf-a',display_name:'Fictional Main',ownership_checked_at:'2026-11-09T08:00:00Z',account_updated_at:'2026-11-09T08:00:00Z',main_character_id:1,characters:[character(1),character(2)],discord:{configured:true,linked:true,requester_dm:true,crafter_dm:false},...extra});
function fixture(initial=session()){
 const events=[],calls=[],listeners=new Map(),rootListeners=new Map(),feedback={hidden:true,textContent:'',classList:{toggle(){}}};
 const state={session:clean(initial),response:null,failure:false,readFailure:false,delay:null,readOverride:null,writeRevision:'2026-11-09T08:10:00Z'};
 const root={innerHTML:'',addEventListener(type,fn){rootListeners.set(type,fn);},querySelector(selector){return selector==='[data-account-feedback]'?feedback:null;}};
 const window={addEventListener(type,fn){listeners.set(type,fn);},dispatchEvent(event){events.push(clean(event));},GuildAccess:{check(response,result){return response.status===401||result.access_required===true;}},GuildHall:{load(options){calls.push({hall:true,options:options?clean(options):null});}},GuildCharacter:{open(id){calls.push({open:id});}}};
 const context=vm.createContext({window,document:{getElementById(id){return id==='account-content'?root:null;}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},async fetch(path,options){calls.push({path,options:options?clean(options):null});if(state.delay)await state.delay;if(state.failure||!options&&state.readFailure)throw Error('sensitive-provider-detail');if(options){const response=state.response||{ok:true,status:200,result:{account_updated_at:state.writeRevision}};if(response.ok){const body=JSON.parse(options.body);if(path==='/api/hall/main'){state.session.main_character_id=body.character_id;state.session.account_updated_at=response.result.account_updated_at;state.session.characters=state.session.characters.map(char=>({...char,show_as_alt:body.alt_ids.includes(char.id)}));state.session.player_links=state.session.characters.filter(char=>char.id===body.character_id||char.show_as_alt).map(char=>({character_id:char.id,user_id:state.session.user_id,main_character_id:body.character_id}));}if(path==='/api/hall/roles')state.session.characters=state.session.characters.map(char=>char.id===body.character_id?{...char,...body}:char);if(path==='/api/hall/discord')state.session.discord=body.unlink?{configured:true,linked:false}:{...state.session.discord,...body};}return {...response,json:async()=>response.result};}return {ok:true,status:200,json:async()=>clean(state.readOverride||state.session)};}});
 vm.runInContext(source,context);window.GuildAccount.render(initial);
 return {api:window.GuildAccount,state,root,feedback,calls,events,window,emit(type,detail){return listeners.get(type)?.({detail});},async submit(form){await rootListeners.get('submit')({preventDefault(){},target:{closest(){return form;}}});await new Promise(resolve=>setImmediate(resolve));},change(form){rootListeners.get('change')({target:{closest(){return form;}}});},async click(button){await rootListeners.get('click')({target:{closest(){return button;}}});await new Promise(resolve=>setImmediate(resolve));}};
}
function form(kind,{id=1,main=1,alts=[2],ids=[1,2,999],selected=['Healer','Damage'],primary='Healer',requester=true,crafter=false}={}){
 const inputs=kind==='role'?['Tank','Healer','Damage'].flatMap(value=>[{name:'preferred_role',value,checked:selected.includes(value),disabled:false},{name:'primary_role',value,checked:value===primary,disabled:!selected.includes(value)}]):kind==='main'?ids.map(value=>({name:'alt_id',value:String(value),checked:alts.includes(value),disabled:false})):[];
 for(const input of inputs.filter(input=>input.name==='alt_id')){input.mainNote={hidden:Number(input.value)!==1};input.closest=()=>({querySelector(){return input.mainNote;}});}
 const note={textContent:''},button={disabled:false};
 const result={dataset:{accountForm:kind,characterId:String(id)},elements:{character_id:{value:String(main)},requester_dm:{checked:requester},crafter_dm:{checked:crafter}},note,inputs,
   querySelector(selector){return selector==='[data-account-role-feedback]'?note:null;},
   querySelectorAll(selector){if(selector==='button,input,select')return [button,...inputs];if(selector==='input')return inputs;const name=selector.match(/name="([^"]+)"/)?.[1];return inputs.filter(input=>(!name||input.name===name)&&(!selector.endsWith(':checked')||input.checked));}};
 Object.defineProperty(result.elements,'primary_role',{get:()=>({value:inputs.find(input=>input.name==='primary_role'&&input.checked)?.value||''})});return result;
}
const writes=p=>p.calls.filter(call=>call.options?.method==='POST');

test('account view shows only its supplied owned characters and safe connection state without rendering account IDs or CSRF',()=>{
 const p=fixture(session({characters:[character(1,{name:'<script>private</script>'})],display_name:'<img src=x onerror=bad()>',user_id:'private-account-id',csrf:'private-csrf',discord:{configured:true,linked:true,discord_id:'private-discord-id',requester_dm:true}}));
 assert.match(p.root.innerHTML,/&lt;script&gt;private&lt;\/script&gt;/);assert.doesNotMatch(p.root.innerHTML,/<script>|<img src=x|private-account-id|private-csrf|private-discord-id|Fictional 2/);
 assert.match(p.root.innerHTML,/Battle.net verified/);assert.match(p.root.innerHTML,/Discord connected/);assert.match(p.root.innerHTML,/Recheck Battle.net access/);assert.match(p.root.innerHTML,/Last ownership check/);
 assert.match(p.root.innerHTML,/WoW data follows the guild&#39;s scheduled refresh|WoW data follows the guild's scheduled refresh/);
});

test('main and alt saves submit only current owned character IDs with the session CSRF token',async()=>{
 const p=fixture(),f=form('main',{main:2,alts:[1,2,999]});p.change(f);await p.submit(f);
 assert.equal(writes(p)[0].path,'/api/hall/main');assert.deepEqual(JSON.parse(writes(p)[0].options.body),{character_id:2,alt_ids:[1]});assert.equal(writes(p)[0].options.headers['X-CSRF-Token'],'csrf-a');
 assert.equal(writes(p)[0].options.headers['Content-Type'],'application/json');assert.match(p.feedback.textContent,/main and alt choices were saved/);
 await p.submit(form('main',{main:999}));assert.equal(writes(p).length,1);assert.match(p.feedback.textContent,/current guild characters/);
});

test('multiple preferred roles save with one selected primary and publish the saved character change',async()=>{
 const p=fixture(),f=form('role',{selected:['Tank','Healer','Damage'],primary:'Healer'});p.change(f);await p.submit(f);
 assert.equal(writes(p)[0].path,'/api/hall/roles');assert.deepEqual(JSON.parse(writes(p)[0].options.body),{character_id:1,preferred_roles:['Tank','Healer','Damage'],primary_role:'Healer'});
 assert.equal(p.events.find(event=>event.type==='guild-role-saved').detail.primary_role,'Healer');
 const missing=form('role',{selected:['Tank','Damage'],primary:'Healer'});p.change(missing);await p.submit(missing);assert.equal(writes(p).length,1);assert.match(p.feedback.textContent,/Choose one selected role as primary/);
 assert(missing.inputs.filter(input=>input.name==='primary_role'&&input.value==='Healer').every(input=>input.disabled&&!input.checked));
 await p.submit(form('role',{id:999}));assert.equal(writes(p).length,1);
});

test('clearing role choices remains a draft until Save and submits an explicit empty selection',async()=>{
 const p=fixture(),f=form('role'),button={dataset:{accountAction:'clear-roles'},closest(){return f;}};await p.click(button);assert.equal(writes(p).length,0);assert(f.inputs.every(input=>!input.checked));
 await p.submit(f);assert.deepEqual(JSON.parse(writes(p)[0].options.body),{character_id:1,preferred_roles:[],primary_role:null});
});

test('Discord preferences and supported unlink use only the current account mutation route',async()=>{
 const p=fixture();await p.submit(form('discord',{requester:false,crafter:true}));assert.equal(writes(p)[0].path,'/api/hall/discord');assert.deepEqual(JSON.parse(writes(p)[0].options.body),{requester_dm:false,crafter_dm:true});
 const panel=form('discord'),button={dataset:{accountAction:'unlink-discord'},closest(selector){return selector==='.account-panel'?panel:null;}};await p.click(button);assert.deepEqual(JSON.parse(writes(p)[1].options.body),{unlink:true});assert.match(p.feedback.textContent,/Queued direct messages will be skipped/);
});

test('failed saves preserve editable drafts and never expose provider error details',async()=>{
 const p=fixture(),f=form('role',{selected:['Tank','Damage'],primary:'Tank'});p.change(f);p.state.failure=true;await p.submit(f);
 assert.match(p.feedback.textContent,/could not be saved/);assert.doesNotMatch(p.feedback.textContent,/sensitive-provider-detail/);assert(f.inputs.filter(input=>input.name==='preferred_role').every(input=>!input.disabled));
 p.api.render(session());assert.match(p.root.innerHTML,/value="Tank" checked/);assert.match(p.root.innerHTML,/name="primary_role" value="Tank"[^>]* checked/);
});

test('membership loss clears all private account content and a late save cannot publish into another account',async()=>{
 const p=fixture(),f=form('role',{selected:['Tank'],primary:'Tank'});let release;p.state.delay=new Promise(resolve=>release=resolve);p.change(f);const saving=p.submit(f);p.emit('guild-member',{verified:false});assert.doesNotMatch(p.root.innerHTML,/Fictional Main|Fictional 1|account-role-form|Discord connected/);assert.match(p.root.innerHTML,/Sign in with Battle.net/);release();await saving;assert.equal(p.events.filter(event=>event.type==='guild-role-saved').length,0);
 p.state.delay=null;p.api.render(session({user_id:'account-b',csrf:'csrf-b',display_name:'Different Owner',characters:[character(3)]}));assert.match(p.root.innerHTML,/Different Owner/);assert.doesNotMatch(p.root.innerHTML,/Fictional 1|name="primary_role" value="Tank"[^>]* checked/);
 p.emit('guild-access-reset');assert.doesNotMatch(p.root.innerHTML,/Different Owner/);
});

test('account refreshes cannot restore private characters after membership has been revoked',async()=>{
 const p=fixture();let release;p.state.delay=new Promise(resolve=>release=resolve);const loading=p.api.load();p.emit('guild-member',{verified:false});release();await loading;assert.match(p.root.innerHTML,/Sign in with Battle.net/);assert.doesNotMatch(p.root.innerHTML,/Fictional 1/);
});

test('unlinked Discord has a supported connect action while unconfigured Discord has no broken action',()=>{
 const p=fixture(session({discord:{configured:true,linked:false}}));assert.match(p.root.innerHTML,/href="\/auth\/discord\/login"/);assert.doesNotMatch(p.root.innerHTML,/account-discord-form|Unlink Discord/);
 p.api.render(session({discord:{configured:false,linked:false}}));assert.match(p.root.innerHTML,/awaiting administrator setup/);assert.doesNotMatch(p.root.innerHTML,/href="\/auth\/discord\/login"/);
});

test('switching main preserves the former main as an unsaved alt and keeps explicitly separate characters separate',async()=>{
 const p=fixture(session({characters:[character(1),character(2),character(3,{show_as_alt:false})]})),f=form('main',{main:2,alts:[2],ids:[1,2,3]});p.change(f);
 assert.equal(f.inputs.find(input=>input.value==='1').checked,true,'The former main belongs to the same group until explicitly unchecked');assert.equal(f.inputs.find(input=>input.value==='2').checked,false);assert.equal(f.inputs.find(input=>input.value==='2').disabled,true);assert.equal(f.inputs.find(input=>input.value==='3').checked,false);assert.equal(writes(p).length,0,'Changing the draft must not persist it');assert.equal(f.inputs.find(input=>input.value==='1').mainNote.hidden,true);assert.equal(f.inputs.find(input=>input.value==='2').mainNote.hidden,false);
 p.api.render(session({characters:[character(1),character(2),character(3,{show_as_alt:false})]}));assert.match(p.root.innerHTML,/<option value="2" selected/);assert.match(p.root.innerHTML,/name="alt_id" value="1" checked/);
 await p.submit(f);assert.deepEqual(JSON.parse(writes(p)[0].options.body),{character_id:2,alt_ids:[1]});assert.match(p.root.innerHTML,/<option value="2" selected/);assert(p.events.some(event=>event.type==='guild-account-saved'&&event.detail.account_updated_at==='2026-11-09T08:10:00Z'));assert(p.events.some(event=>event.type==='guild-players'&&event.detail.every(link=>link.main_character_id===2)));
});

test('a delayed older account render cannot replace a successfully saved main and alt selection',async()=>{
 const p=fixture(),old=clean(p.state.session),f=form('main',{main:2,alts:[1,2]});p.change(f);await p.submit(f);assert.match(p.root.innerHTML,/<option value="2" selected/);
 p.api.render(old);assert.match(p.root.innerHTML,/<option value="2" selected/);assert.doesNotMatch(p.root.innerHTML,/<option value="1" selected/);
 const missingRevision={...old};delete missingRevision.account_updated_at;p.api.render(missingRevision);assert.match(p.root.innerHTML,/<option value="2" selected/);
 p.api.render({...old,account_updated_at:'2026-11-09T08:20:00Z'});assert.match(p.root.innerHTML,/<option value="1" selected/,'A genuinely newer server revision is allowed to change the selection');
});

test('a successful main save queues shared refresh even when its following account reload fails and keeps choices recoverable',async()=>{
 const p=fixture(),f=form('main',{main:2,alts:[1,2]});p.change(f);p.state.readFailure=true;await p.submit(f);
 assert.equal(writes(p).length,1);assert(p.events.some(event=>event.type==='guild-account-saved'&&event.detail.user_id==='account-a'));assert.match(p.feedback.textContent,/saved.*could not be refreshed/i);assert.doesNotMatch(p.feedback.textContent,/sensitive-provider-detail/);
 p.api.render({...p.state.session});assert.match(p.root.innerHTML,/<option value="2" selected/);assert.match(p.root.innerHTML,/name="alt_id" value="1" checked/);
});
