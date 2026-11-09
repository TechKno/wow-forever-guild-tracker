import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function fixture(){
  const listeners=new Map(),host={innerHTML:''},feedback={hidden:true,textContent:''};
  const window={addEventListener(name,callback){listeners.set(name,callback);}},document={getElementById:id=>id==='hierarchy-content'?host:feedback,addEventListener(){}};
  const context=vm.createContext({window,document,fetch:async()=>({ok:true,status:200,json:async()=>({labels:{0:'Guildmaster',2:'Veteran',10:'Rank Ten'}})})});
  vm.runInContext(readFileSync(new URL('../public/hierarchy.js',import.meta.url),'utf8'),context);
  return {window,host,emit:(name,detail)=>listeners.get(name)?.({detail})};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('hierarchy sorts numeric guild ranks, groups Discord-linked alts under their highest rank and omits departed characters',async()=>{
  const f=fixture(),members=[{id:1,name:'Leader Example',rank:0,level:20,class:'Mage'},{id:2,name:'Lower Alt',rank:10,level:12,class:'Priest'},{id:3,name:'Veteran Example',rank:2,level:18,class:'Warrior'},{id:4,name:'Unknown Example',rank:null,level:1}];
  f.window.GuildHierarchy.update(members);assert.equal(f.host.innerHTML,'');f.emit('guild-member',{verified:true});await settle();
  f.emit('guild-hall-data',{people:[{display_name:'Fictional Discord',discord_linked:true,characters:[{id:1},{id:2}]}]});
  const html=f.host.innerHTML;assert(html.indexOf('Guildmaster')<html.indexOf('Veteran'));assert(html.indexOf('Veteran')<html.indexOf('Rank not returned'));assert.equal((html.match(/data-hierarchy-character="2"/g)||[]).length,0);assert(html.includes('Fictional Discord'));assert(html.includes('data-hierarchy-character="1"'));
  f.window.GuildHierarchy.update(members.filter(member=>member.id!==2));assert(!f.host.innerHTML.includes('Lower Alt'),'Stale directory data must not retain a departed alt');
  f.emit('guild-member',{verified:false});assert.equal(f.host.innerHTML,'');
});

test('one representative per player uses highest guild rank first, then highest level within that rank',async()=>{
  const f=fixture();f.window.GuildHierarchy.update([{id:1,name:'Lower Level Officer',rank:1,level:10},{id:2,name:'Higher Level Officer',rank:1,level:20},{id:3,name:'High Level Member',rank:3,level:30}]);f.emit('guild-member',{verified:true});await settle();
  f.emit('guild-hall-data',{people:[{display_name:'Test Discord',discord_linked:true,characters:[{id:1,is_main:true},{id:2},{id:3}]}]});
  assert(f.host.innerHTML.includes('data-hierarchy-character="2"'));assert(!f.host.innerHTML.includes('data-hierarchy-character="1"'));assert(!f.host.innerHTML.includes('data-hierarchy-character="3"'));assert.equal((f.host.innerHTML.match(/hierarchy-person-heading/g)||[]).length,1);
});
test('hierarchy escapes display names and rank labels and does not render Discord or account identifiers',async()=>{
  const f=fixture();f.window.GuildHierarchy.update([{id:1,name:'<img src=x onerror=bad()>',rank:0,level:3}]);f.emit('guild-member',{verified:true});await settle();
  f.emit('guild-hall-data',{people:[{key:'private-account-key',discord_id:'123456789012345678',display_name:'<script>bad()</script>',discord_linked:true,characters:[{id:1}]}]});
  assert(f.host.innerHTML.includes('&lt;script&gt;'));assert(!f.host.innerHTML.includes('<script>'));assert(!f.host.innerHTML.includes('private-account-key'));assert(!f.host.innerHTML.includes('123456789012345678'));
});
