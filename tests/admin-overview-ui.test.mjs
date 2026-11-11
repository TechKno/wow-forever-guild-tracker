import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/admin-overview.js',import.meta.url),'utf8'),clone=value=>JSON.parse(JSON.stringify(value));
const defaults=['Guildmaster','Officer','Veteran','Member','Initiate','Reserve','Recruit','Newcomer','Guest','Visitor'];
const auth=(extra={})=>({verified:true,is_admin:true,user_id:'private-admin-id',csrf:'private-session-csrf',...extra});
function fixture(){
 const handlers=new Map(),events=new Map(),calls=[],published=[],feedback={hidden:true,textContent:'',classList:{toggle(){}}};
 const host={innerHTML:'',querySelector(){return feedback;},addEventListener(type,fn){handlers.set(type,fn);}};
 const state={delay:null,failure:false,status:200,ranksFailure:false,
  overview:{checked_at:'2026-11-09T10:00:00Z',health:{scheduler:{status:'healthy',last_completed_at:'2026-11-09T09:59:00Z'},blizzard:{status:'limited',last_success_at:'2026-11-09T09:58:00Z'},roster:{status:'published',observed_at:'2026-11-09T09:55:00Z'},discord:{status:'configured',pending:2,failed:0},backups:{note:'Backup availability is managed by your host.'}},counts:{characters:16,current_member_accounts:8,discord_linked_accounts:6,members_without_discord:2,site_accounts:9,unclaimed_characters:4},refresh:{due:3,waiting:13,unpublished:2,stale:1,next_at:'2026-11-09T10:01:00Z'},attention:[{severity:'warning',title:'A useful test issue',count:2}],imports:[{observed_at:'2026-11-09T09:55:00Z',completed_at:'2026-11-09T09:57:00Z',member_count:16,joined:2,left:1,level_changes:3,rank_changes:4,duration_ms:120000,baseline:false}],import_history_note:'Only completed imports are shown.'},
  ranks:{labels:Object.fromEntries(defaults.map((label,index)=>[String(index),label])),ranks:[{rank:0,name:'Guildmaster',count:1},{rank:3,name:'Member',count:8}],source:'suggested'}};
 const window={addEventListener(type,fn){events.set(type,fn);},dispatchEvent(event){published.push(clone(event));},GuildAccess:{check(response,result){return response.status===401||result.access_required===true;}}};
 const context=vm.createContext({window,document:{getElementById(id){return id==='admin-content'?host:null;}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},async fetch(path,options){calls.push({path,options:options?clone(options):null});if(state.delay)await state.delay;if(state.failure||state.ranksFailure&&path==='/api/guild/ranks')throw Error('private-provider-token');const result=options?{message:'private-response-detail'}:path==='/api/admin/overview'?clone(state.overview):clone(state.ranks);return {ok:state.status===200,status:state.status,json:async()=>result};}});
 vm.runInContext(source,context);
 return {api:window.GuildAdminOverview,state,host,feedback,calls,published,emit(detail){events.get('guild-member')({detail});},reset(){events.get('guild-access-reset')();},submit(form){return handlers.get('submit')({preventDefault(){},target:{closest(){return form;}}});},input(form){handlers.get('input')({target:{closest(){return form;}}});},click(action){handlers.get('click')({target:{closest(){return {dataset:{adminAction:action}};}}});}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function ranksForm(changes={}){const controls=Object.fromEntries(defaults.map((value,index)=>['rank_'+index,{value:changes[index]??value,disabled:false}]));return {elements:controls,querySelectorAll(){return Object.values(controls);}};}

test('admin overview does not request private data before a verified admin event with session CSRF',async()=>{
 const p=fixture();await p.api.load();assert.equal(p.calls.length,0);assert.match(p.host.innerHTML,/verified guild administrator/);
 for(const detail of [auth({is_admin:false}),auth({verified:false}),auth({csrf:''}),auth({user_id:''})]){p.emit(detail);await p.api.load();assert.equal(p.calls.length,0);}
 p.emit(auth());await tick();assert.equal(p.calls.length,2);assert(p.calls.some(call=>call.path==='/api/admin/overview'));assert.match(p.host.innerHTML,/Roster sync history/);assert.doesNotMatch(p.host.innerHTML,/private-admin-id|private-session-csrf/);
});

test('summary distinguishes characters and accounts and shows completed import diffs, queue and honest backup state',async()=>{
 const p=fixture();p.emit(auth());await p.api.load();
 for(const label of ['Current characters','Verified member accounts','Linked Discord accounts','Accounts without Discord','Unpublished profiles','Initial baseline','A useful test issue']){
  if(label==='Initial baseline')assert.doesNotMatch(p.host.innerHTML,/Initial baseline/);else assert.match(p.host.innerHTML,new RegExp(label));
 }
 assert.match(p.host.innerHTML,/<td>16<\/td><td>2<\/td><td>1<\/td><td>3<\/td><td>4<\/td><td>2m 0s<\/td>/);assert.match(p.host.innerHTML,/Backup availability is managed by your host/);assert.doesNotMatch(p.host.innerHTML,/Backups verified|Backups healthy/);
});

test('the accounts section renders names alongside exact IDs and sign-in history',async()=>{
 const p=fixture(),last='2026-11-09T09:30:00.000Z';p.emit(auth());
 p.state.overview.accounts=[
   {name:'Test & Main',characters:['Test & Main','Test Alt'],signed_in:true,battle_net_id:'123456789012345678901234',battle_tag:'Demo#1234',discord_ids:[{id:'123456789012345678',source:'linked',display_name:'Example <Discord>'}],last_sign_in_at:last,recent_sign_ins:[last,'2026-11-08T09:30:00.000Z']},
   {name:'Roster only',characters:['Roster only'],signed_in:false,battle_net_id:null,discord_ids:[],last_sign_in_at:null,recent_sign_ins:[]}
 ];
 await p.api.load('accounts');
 for(const value of ['Test &amp; Main','Test Alt','Demo#1234</div><code>123456789012345678901234','Example &lt;Discord&gt;</div><code>123456789012345678','Recent sign-ins','No linked sign-in','datetime="'+last+'"'])assert(p.host.innerHTML.includes(value),value);
 assert.doesNotMatch(p.host.innerHTML,/Roster sync history/);
});

test('rank-name edits save ten labels through the admin endpoint with CSRF and publish a display-only change',async()=>{
 const p=fixture();p.emit(auth());await p.api.load();const form=ranksForm({0:'Guild Leader',3:'Adventurer'});p.input(form);await p.submit(form);
 const write=p.calls.find(call=>call.options?.method==='POST');assert.equal(write.path,'/api/admin/ranks');assert.equal(write.options.headers['X-CSRF-Token'],'private-session-csrf');assert.equal(write.options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(write.options.body).labels,{'0':'Guild Leader','1':'Officer','2':'Veteran','3':'Adventurer','4':'Initiate','5':'Reserve','6':'Recruit','7':'Newcomer','8':'Guest','9':'Visitor'});
 assert.match(p.feedback.textContent,/do not change anyone’s permissions/);assert.equal(p.published[0].type,'guild-ranks-saved');assert.equal(p.published[0].detail.labels[3],'Adventurer');
});

test('suggested names remain unsaved until submitted and invalid edits never reach the server',async()=>{
 const p=fixture();p.emit(auth());await p.api.load();p.state.ranks.labels[3]='Custom';p.click('suggested-ranks');assert.equal(p.calls.filter(call=>call.options).length,0);assert.match(p.feedback.textContent,/Save to use them/);assert.match(p.host.innerHTML,/name="rank_3" value="Member"/);
 await p.submit(ranksForm({0:' '}));await p.submit(ranksForm({0:'x'.repeat(41)}));assert.equal(p.calls.filter(call=>call.options).length,0);assert.match(p.feedback.textContent,/1 to 40 characters/);
});

test('untrusted fields are escaped and an empty import list is presented without fabricating earlier history',async()=>{
 const p=fixture();p.state.overview.attention=[{title:'<img src=x onerror=bad()>',severity:'<script>'}];p.state.overview.imports=[];p.state.overview.import_history_note='<script>history</script>';p.state.ranks.labels[0]='"><script>rank</script>';p.emit(auth());await p.api.load();
 assert.doesNotMatch(p.host.innerHTML,/<img src=x|<script>/);assert.match(p.host.innerHTML,/&lt;img src=x/);assert.match(p.host.innerHTML,/&lt;script&gt;history/);assert.match(p.host.innerHTML,/Earlier history is not reconstructed/);assert.match(p.host.innerHTML,/&quot;&gt;&lt;script&gt;rank/);
});

test('losing administrator membership clears cached data and rejects delayed overview responses',async()=>{
 const p=fixture();p.emit(auth());await p.api.load();let release;p.state.delay=new Promise(resolve=>release=resolve);const pending=p.api.load();p.emit(auth({is_admin:false}));assert.doesNotMatch(p.host.innerHTML,/Roster sync history|Current characters|A useful test issue/);release();await pending;assert.doesNotMatch(p.host.innerHTML,/Roster sync history/);assert.match(p.host.innerHTML,/verified guild administrator/);
});

test('a late rank save cannot publish a success event or restore data after administrator access is revoked',async()=>{
 const p=fixture();p.emit(auth());await p.api.load();let release;p.state.delay=new Promise(resolve=>release=resolve);const pending=p.submit(ranksForm({3:'Changed'}));p.reset();release();await pending;assert.equal(p.published.length,0);assert.doesNotMatch(p.host.innerHTML,/Changed|Guild rank names/);
});

test('server 403 clears the private view while network errors retain edits and show no provider details',async()=>{
 const p=fixture();p.emit(auth());await p.api.load();p.state.failure=true;const form=ranksForm({3:'Draft Adventurer'});p.input(form);await p.submit(form);assert.match(p.feedback.textContent,/could not be saved/);assert.doesNotMatch(p.feedback.textContent,/private-provider-token/);assert(Object.values(form.elements).every(control=>!control.disabled));
 p.state.failure=false;p.state.status=403;await p.api.load();assert.doesNotMatch(p.host.innerHTML,/Draft Adventurer|Roster sync history|Current characters/);
});

test('rank endpoint failure does not hide successfully refreshed health information',async()=>{
 const p=fixture();p.state.ranksFailure=true;p.emit(auth());await p.api.load();assert.match(p.host.innerHTML,/Roster sync history/);assert.match(p.host.innerHTML,/Rank settings could not be loaded/);assert.match(p.feedback.textContent,/Guild health was refreshed/);assert.doesNotMatch(p.feedback.textContent,/private-provider-token/);
});
