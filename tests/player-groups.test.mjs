import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rosterDisplayGroups,effectivePlayerMains} from '../src/player-groups.mjs';

const KEY='a'.repeat(43),OTHER='b'.repeat(43);
const provider=(id,extra={})=>({id,association:'provider',is_main:false,is_alt:false,...extra});
const manual=(id,extra={})=>({id,association:'admin',is_main:false,is_alt:false,...extra});
const person=(characters,extra={})=>({key:KEY,display_name:'Discord Display',discord_linked:true,identity_source:'mixed',characters,...extra});

test('effective player mains retain a current saved main even when it is not the first slug-ordered character',()=>{
  const rows=[{user_id:'a',character_id:102,main_character_id:103},{user_id:'a',character_id:103,main_character_id:103}],before=structuredClone(rows);
  assert.deepEqual([...effectivePlayerMains(rows)],[['a',103]]);assert.deepEqual(rows,before);
});

test('a departed saved main falls back to the first current provider character regardless of its unchecked alt preference',()=>{
  const rows=[{user_id:'a',character_id:102,main_character_id:101,show_as_alt:0},{user_id:'a',character_id:103,main_character_id:101,show_as_alt:1},{user_id:'b',character_id:202,main_character_id:201,show_as_alt:1}];
  assert.deepEqual([...effectivePlayerMains(rows)],[['a',102],['b',202]]);assert.deepEqual([...effectivePlayerMains([{user_id:'a',character_id:9,main_character_id:null}])],[['a',9]]);
});

test('effective main selection does not invent characters or interpret Discord mapping participant fields as provider ownership',()=>{
  assert.deepEqual([...effectivePlayerMains([{participant_user_id:'manual',character_id:301,main_character_id:301},{user_id:'bad',character_id:'2'},{user_id:'bad',character_id:-1}])],[]);assert.deepEqual([...effectivePlayerMains(null)],[]);
});

test('roster groups combine a provider chosen main, selected alts and exact manual-only mappings while keeping unchecked provider characters separate',()=>{
  const input=[person([provider(1,{is_main:true}),provider(2,{is_alt:true}),provider(3),manual(4)])],before=structuredClone(input);
  assert.deepEqual(rosterDisplayGroups(input),[{key:KEY,display_name:'Discord Display',discord_linked:true,identity_source:'mixed',main_character_id:1,character_ids:[1,2,4]}]);
  assert.deepEqual(input,before,'The complete people directory must retain every owned character and its original proof labels');
});

test('manual-only display groups use the administrator preferred character without inventing a provider main',()=>{
  const group=rosterDisplayGroups([person([manual(4),manual(5,{event_default:true})],{identity_source:'admin'})])[0];
  assert.equal(group.main_character_id,5);assert.deepEqual(group.character_ids,[4,5]);assert.equal(group.identity_source,'admin');
});

test('a provider chosen main takes precedence over a manual event default and level or guild rank never changes the roster choice',()=>{
  const group=rosterDisplayGroups([person([manual(4,{event_default:true,rank:0,level:60}),provider(1,{is_main:true,rank:8,level:10}),provider(2,{is_alt:true,rank:1,level:40})])])[0];
  assert.equal(group.main_character_id,1);
});

test('unlinked verified accounts can group selected alts without requiring a Discord identity',()=>{
  const group=rosterDisplayGroups([person([provider(1,{is_main:true}),provider(2,{is_alt:true})],{discord_linked:false,identity_source:'unlinked',display_name:'Chosen Main'})])[0];
  assert.equal(group.discord_linked,false);assert.equal(group.display_name,'Chosen Main');assert.deepEqual(group.character_ids,[1,2]);
});

test('display groups contain only opaque presentation identity and character IDs, never ownership or notification authority',()=>{
  const input=[person([provider(1,{is_main:true,user_id:'private-account',discord_id:'111111111111111111'}),manual(2,{crafter_dm:true,participant_user_id:'private-participant'})],{discord_id:'111111111111111111',user_id:'private-account',crafter_dm:true})],group=rosterDisplayGroups(input)[0];
  assert.deepEqual(Object.keys(group).sort(),['character_ids','discord_linked','display_name','identity_source','key','main_character_id'].sort());assert(!JSON.stringify(group).includes('private-'));assert(!JSON.stringify(group).includes('111111111111111111'));
});

test('invalid and duplicate character identities cannot create duplicate roster rows or raw-ID group keys',()=>{
  const result=rosterDisplayGroups([person([provider(1,{is_main:true}),provider(1,{is_alt:true}),manual(-1),manual('2')]),person([manual(1),manual(3)],{key:OTHER}),person([manual(4)],{key:'111111111111111111'})]);
  assert.deepEqual(result.map(group=>group.character_ids),[[1],[3]]);assert.deepEqual(rosterDisplayGroups([person([provider(1)])]),[]);assert.deepEqual(rosterDisplayGroups(null),[]);
});
