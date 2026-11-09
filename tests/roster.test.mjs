import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(0,app.lastIndexOf('load();setInterval('));
const character=(id,name,level)=>({id,name,level,slug:name.toLowerCase().replaceAll(' ','-'),class:'Mage',class_id:8,race:'Human',rank:1});
function roster(fixture){
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{id,value:'',hidden:false,innerHTML:'',textContent:'',classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){}});return elements.get(id);};
  element('sort').value='level';
  element('role-filter').value=fixture.role||'';element('class-filter').value=fixture.class||'';element('roster-search').value=fixture.search||'';
  const context=vm.createContext({fixture,document:{getElementById:element,querySelector:()=>element('dialog-close'),querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},location:{hash:''},history:{replaceState(){}}});
  vm.runInContext(source,context);
  vm.runInContext("members=fixture.members;rosterLinks=fixture.links||[];groupedRoster=fixture.grouped!==false;status={sync:{published:'current'}};for(const id of fixture.expanded||[])expandedPlayers.add('player:'+id);renderRoster();renderCompositions();",context);
  const html=element('roster-body').innerHTML;
  return {names:[...html.matchAll(/class="member-name"[^>]*>([^<]+)<\/button>/g)].map(match=>match[1]),note:element('grouping-note').textContent,html,count:element('roster-count').textContent,empty:element('roster-empty').innerHTML,details:vm.runInContext('refreshDetails(fixture.members[0])',context),professionComposition:element('profession-composition').innerHTML,professionCoverage:element('profession-composition-note').textContent};
}

test('role filters include primary and additional preferences, work with search/class, and exclude undeclared roles',()=>{
  const members=[
    {...character(1,'Tank Main',20),class:'Warrior',preferred_roles:['Tank','Damage'],primary_role:'Tank'},
    {...character(2,'Healer Main',18),class:'Priest',preferred_roles:['Healer','Damage'],primary_role:'Healer'},
    {...character(3,'Damage Main',15),preferred_roles:['Damage'],primary_role:'Damage'},
    {...character(4,'Unknown Priest',12),class:'Priest'}
  ];
  assert.deepEqual(roster({members,grouped:false,role:'Damage'}).names,['Tank Main','Healer Main','Damage Main']);
  assert.deepEqual(roster({members,grouped:false,role:'Healer'}).names,['Healer Main']);
  assert.deepEqual(roster({members,grouped:false,role:'Damage',class:'Priest',search:'healer'}).names,['Healer Main']);
  const empty=roster({members,grouped:false,role:'Tank',class:'Priest'});
  assert.deepEqual(empty.names,[]);assert.match(empty.count,/0 of 4 characters match Tank/);assert.match(empty.empty,/another name, class or role/);
  assert.equal(roster({members,grouped:false}).names.length,4);
});

test('a role-matching alt expands under its main without showing unrelated alts or mixing criteria across characters',()=>{
  const members=[
    {...character(1,'Tank Main',20),class:'Warrior',preferred_roles:['Tank'],primary_role:'Tank'},
    {...character(2,'Flexible Alt',12),class:'Druid',preferred_roles:['Damage','Healer'],primary_role:'Damage'},
    {...character(3,'Other Alt',15),preferred_roles:['Damage'],primary_role:'Damage'},
    {...character(4,'Separate Healer',18),class:'Priest',preferred_roles:['Healer'],primary_role:'Healer'}
  ],links=members.slice(0,3).map(m=>({character_id:m.id,user_id:'owner',main_character_id:1}));
  const result=roster({members,links,role:'Healer'});
  assert.deepEqual(result.names,['Tank Main','Flexible Alt','Separate Healer']);
  assert.match(result.html,/matching alt below/);assert.match(result.html,/aria-expanded="true"/);
  assert.match(result.count,/2 of 4 characters match Healer/);
  assert.match(result.note,/Includes primary and additional Healer choices/);
  assert.deepEqual(roster({members,links,role:'Healer',class:'Warrior'}).names,[]);
  assert.deepEqual(roster({members,links,role:'Tank'}).names,['Tank Main']);
});

test('profession composition counts characters once per skill, includes secondary and previous observations, and identifies missing data',()=>{
  const members=[
    {...character(1,'Main',20),professions_at:'2026-11-09T07:00:00Z',professions_status:'verified',professions:[{name:'Mining',kind:'Primary'},{name:'Mining',kind:'Primary',tier:'Another tier'},{name:'Cooking',kind:'Secondary'}]},
    {...character(2,'Alt',12),professions_at:'2026-11-08T07:00:00Z',professions_status:'stale',professions:[{name:'Mining',kind:'Primary'}]},
    {...character(3,'Unavailable',5),professions_status:'unavailable',professions:[]}
  ];
  const result=roster({members,links:[{character_id:1,user_id:'owner',main_character_id:1},{character_id:2,user_id:'owner',main_character_id:1}]});
  assert.match(result.professionComposition,/Mining: 2 characters/);
  assert.match(result.professionComposition,/Cooking: 1 character/);
  assert.match(result.professionComposition,/value="2" max="3"/);
  assert.match(result.professionCoverage,/2 of 3 character profiles/);
  assert.match(result.professionCoverage,/Previous observations included/);
  assert.match(result.professionCoverage,/Unavailable profiles may have additional professions/);
  const missing=roster({members:[members[2]]});
  assert.match(missing.professionComposition,/appears as character profiles are imported/);
  assert.doesNotMatch(missing.professionComposition,/<progress/);
  const empty=roster({members:[{...members[0],professions:[]}]});
  assert.match(empty.professionComposition,/No professions were returned/);
  assert.doesNotMatch(empty.professionComposition,/Mining/);
});

test('highest-level groups sort by their displayed main rather than a higher-level alt',()=>{
  const members=[character(1,'Main Sixteen',16),character(2,'Alt Twenty Five',25),character(3,'Main Seventeen',17)];
  const links=[{character_id:1,user_id:'first',main_character_id:1},{character_id:2,user_id:'first',main_character_id:1},{character_id:3,user_id:'second',main_character_id:3}];
  const result=roster({members,links});
  assert.deepEqual(result.names,['Main Seventeen','Main Sixteen']);
  assert(result.note.includes('Groups sort by shown main level; alts stay under their main.'));
});

test('ungrouped highest-level sorting is numeric with unknown levels last and names breaking ties',()=>{
  const members=[character(1,'Nine',9),character(2,'Zulu Twenty','20'),character(3,'Missing',null),character(4,'Alpha Twenty',20),character(5,'Unavailable',undefined)];
  assert.deepEqual(roster({members,grouped:false}).names,['Alpha Twenty','Zulu Twenty','Nine','Missing','Unavailable']);
});

test('expanded alts sort numerically under their chosen main without becoming its group heading',()=>{
  const members=[character(1,'Chosen Main',16),character(2,'Alt Nine',9),character(3,'Alt Unknown',null),character(4,'Alt Twenty Five',25),character(5,'Other Main',17)];
  const links=members.filter(m=>m.id!==5).map(m=>({character_id:m.id,user_id:'first',main_character_id:1}));
  assert.deepEqual(roster({members,links,expanded:['first']}).names,['Other Main','Chosen Main','Alt Twenty Five','Alt Nine','Alt Unknown']);
});

test('profile-verified characters show their evidence source, proof times and unknown guild rank',()=>{
  const member={...character(1,'New Guildcharacter',10),rank:null,membership_source:'character_profile',membership_verified_at:new Date().toISOString(),membership_expires_at:new Date(Date.now()+3600000).toISOString(),level_source:'character_profile'};
  const result=roster({members:[member],grouped:false});
  assert.match(result.html,/Verified through character profile/);assert.match(result.html,/<td>Unknown<\/td>/);assert.doesNotMatch(result.html,/Rank null|Rank undefined/);
  assert.match(result.details,/Membership last verified/);assert.match(result.details,/Membership proof expires/);assert.match(result.details,/Level source<\/span><span>Character profile/);
  const ordinary=roster({members:[character(2,'Roster Character',15)],grouped:false});assert.doesNotMatch(ordinary.html,/Verified through character profile/);
});

test('expired or missing fallback proofs are not displayed as currently verified',()=>{
  for(const expiry of [new Date(Date.now()-1000).toISOString(),null,'invalid']){
    const result=roster({members:[{...character(1,'Former Proof',10),membership_source:'character_profile',membership_expires_at:expiry}],grouped:false});
    assert.doesNotMatch(result.html,/Verified through character profile/);assert.match(result.html,/Character-profile verification (?:expired|unavailable)/);
  }
});
