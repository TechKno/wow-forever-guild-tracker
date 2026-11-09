import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {rosterDisplayGroups} from '../src/player-groups.mjs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),app=source.slice(0,source.lastIndexOf('load();setInterval('));
const character=(id,name)=>({id,name,slug:name.toLowerCase().replaceAll(' ','-'),level:20+id,class:'Mage',class_id:8,race:'Human',rank:3});
const key='P'.repeat(43);
function roster({members,links,displayGroups,expanded=[]}){
 const elements=new Map(),listeners=new Map(),documentListeners=[],elementListeners=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{id,value:id==='sort'?'name':'',hidden:false,innerHTML:'',textContent:'',classList:{toggle(){},add(){},remove(){}},addEventListener(type,fn){elementListeners.set(id+':'+type,fn);},setAttribute(){}});return elements.get(id);};
 const context=vm.createContext({fixture:{members,links,displayGroups,expanded},document:{getElementById:element,querySelector:()=>element('dialog-close'),querySelectorAll:()=>[],addEventListener(type,fn){if(type==='click')documentListeners.push(fn);}},window:{addEventListener(type,fn){listeners.set(type,fn);}},location:{hash:''},history:{replaceState(){}}});vm.runInContext(app,context);
 vm.runInContext('members=fixture.members;rosterLinks=fixture.links;rosterDisplayGroups=fixture.displayGroups;groupedRoster=true;memberVerified=true;status={sync:{published:"current"}};for(const key of fixture.expanded)expandedPlayers.add(key);renderRoster();',context);
 return {html:()=>element('roster-body').innerHTML,names:()=>[...element('roster-body').innerHTML.matchAll(/class="member-name"[^>]*>([^<]+)<\/button>/g)].map(match=>match[1]),emitHall(data){listeners.get('guild-hall-data')({detail:data});},toggle(key){for(const fn of documentListeners)fn({target:{closest(selector){return selector==='[data-player]'?{dataset:{player:key}}:null;}}});},toggleGrouping(){elementListeners.get('group-roster:click')();},context};
}
const members=[character(1,'First Main'),character(2,'Second Alt'),character(3,'Third Alt'),character(4,'Fourth Alt'),character(5,'Separate Character')];

test('expanded verified account roster displays one main and all three alts without omissions',()=>{
 const p=roster({members,links:members.slice(0,4).map(member=>({character_id:member.id,user_id:'owner-a',main_character_id:1})),displayGroups:[],expanded:['player:owner-a']});
 assert.equal((p.html().match(/class="alt-roster-row"/g)||[]).length,3);assert.match(p.html(),/Main · 4 linked characters/);assert.deepEqual(p.names(),members.map(member=>member.name));
});

test('a mixed verified-account and administrator Discord group keeps one main plus three alts in the expanded roster',()=>{
 const people=[{key,display_name:'Fictional Discord Person',discord_linked:true,identity_source:'mixed',characters:[{id:1,association:'provider',is_main:true},{id:2,association:'provider',is_alt:true},{id:3,association:'admin',event_default:false},{id:4,association:'admin',event_default:false}]}],groups=rosterDisplayGroups(people);
 assert.deepEqual(groups[0].character_ids,[1,2,3,4]);
 const p=roster({members,links:members.slice(0,2).map(member=>({character_id:member.id,user_id:'owner-a',main_character_id:1})),displayGroups:groups,expanded:['person:'+key]});
 assert.equal((p.html().match(/class="alt-roster-row"/g)||[]).length,3);assert.match(p.html(),/Fictional Discord Person/);assert.match(p.html(),/Main · 4 linked characters/);assert.deepEqual(p.names(),members.map(member=>member.name));
});

const displayGroup=()=>({key,display_name:'Fictional Discord Person',discord_linked:true,main_character_id:1,character_ids:[1,2,3,4]});
const verifiedLinks=()=>members.slice(0,4).map(member=>({character_id:member.id,user_id:'owner-a',main_character_id:1}));
test('Discord grouping enrichment keeps all three previously expanded alts visible and labels their count',()=>{
 const p=roster({members,links:verifiedLinks(),displayGroups:[],expanded:['player:owner-a']});assert.deepEqual(p.names(),members.map(member=>member.name));
 p.emitHall({display_groups:[displayGroup()]});assert.deepEqual(p.names(),members.map(member=>member.name));assert.match(p.html(),/4 linked characters · 3 alts/);assert.match(p.html(),/data-player="person:/);assert.match(p.html(),/aria-expanded="true"/);
});

test('an intentional collapse survives Discord group removal and re-enrichment without reviving an obsolete expansion key',()=>{
 const p=roster({members,links:verifiedLinks(),displayGroups:[],expanded:['player:owner-a']});p.emitHall({display_groups:[displayGroup()]});p.toggle('person:'+key);assert.deepEqual(p.names(),['First Main','Separate Character']);
 p.emitHall({display_groups:[]});assert.deepEqual(p.names(),['First Main','Separate Character']);p.emitHall({display_groups:[displayGroup()]});assert.deepEqual(p.names(),['First Main','Separate Character']);assert.match(p.html(),/aria-expanded="false"/);
});

test('group enrichment respects grouping-off and keeps the prior expansion when grouping is restored',()=>{
 const p=roster({members,links:verifiedLinks(),displayGroups:[],expanded:['player:owner-a']});p.toggleGrouping();assert.equal((p.html().match(/class="alt-roster-row"/g)||[]).length,0);assert.deepEqual(p.names().slice().sort(),members.map(member=>member.name).sort());
 p.emitHall({display_groups:[displayGroup()]});assert.equal((p.html().match(/class="alt-roster-row"/g)||[]).length,0);assert.deepEqual(p.names().slice().sort(),members.map(member=>member.name).sort());p.toggleGrouping();assert.equal((p.html().match(/class="alt-roster-row"/g)||[]).length,3);assert.deepEqual(p.names(),members.map(member=>member.name));
});
