import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTalentBuild,normalizeTalentLayout,mergeTalentTrees} from '../src/talent-data.mjs';

const CHARACTER=15660733;
function selected(id=134399,rank=4,name='Ferocity'){
  return {talent:{id,name},talent_rank:rank,spell_tooltip:{spell:{id:16934,name},description:`Observed rank ${rank} description`,cast_time:'Passive'}};
}
function buildPayload(talents=[selected()],points=4){return {character:{id:CHARACTER},specialization_groups:[{is_active:true,specializations:[{specialization:{id:134,name:'Feral Combat'},specialization_name:'Feral Combat',spent_points:points,talents}]}]};}
function staticNode(id=104938,talentId=134399,name='Ferocity',row=1,column=8,max=5){
  return {id,display_row:row,display_col:column,ranks:Array.from({length:max},(_,index)=>({rank:index+1,tooltip:{talent:{id:talentId,name},spell_tooltip:{spell:{id:16934,name},description:`Static rank ${index+1} description`,power_cost:null}}}))};
}
function layoutPayload(){
  return {id:1089,name:'Feral Combat',playable_class:{id:11},playable_specialization:{id:134},spec_talent_nodes:[
    staticNode(),staticNode(104939,134400,'Furor',1,9),staticNode(104943,134404,'Feral Swiftness',3,7,2)
  ]};
}
function layout(){return normalizeTalentLayout(layoutPayload(),11,134);}

test('a selected build retains the observed talent identity, rank and localized description rather than the static maximum rank',()=>{
  const payload=buildPayload();payload.specialization_groups[0].specializations[0].talents[0].spell_tooltip.description={en_GB:'Observed four-point effect',en_US:'Other locale'};
  const original=structuredClone(payload),build=normalizeTalentBuild(payload,CHARACTER);
  assert.equal(build.selection_known,true);assert.equal(build.trees[0].id,134);assert.equal(build.trees[0].points,4);
  assert.deepEqual(build.trees[0].nodes[0],{id:134399,name:'Ferocity',rank:4,description:'Observed four-point effect',spell_id:16934,description_rank:4});
  assert.deepEqual(payload,original);
});

test('absent active groups and omitted specialization or talent lists remain unknown, while explicit empty lists establish an empty selection',()=>{
  for(const groups of [[],[{is_active:false}],[{is_active:true}]])assert.deepEqual(normalizeTalentBuild({character:{id:CHARACTER},specialization_groups:groups},CHARACTER),{selection_known:false,trees:[]});
  assert.deepEqual(normalizeTalentBuild({character:{id:CHARACTER},specialization_groups:[{is_active:true,specializations:[]}]},CHARACTER),{selection_known:true,trees:[]});
  const missing=buildPayload();delete missing.specialization_groups[0].specializations[0].talents;
  const unknown=normalizeTalentBuild(missing,CHARACTER);assert.equal(unknown.selection_known,false);assert.equal(unknown.trees[0].selection_known,false);assert.deepEqual(unknown.trees[0].nodes,[]);assert.equal(unknown.trees[0].points,4);
  const empty=normalizeTalentBuild(buildPayload([],0),CHARACTER);assert.equal(empty.selection_known,true);assert.equal(empty.trees[0].selection_known,true);assert.equal(empty.trees[0].points,0);
});

test('wrong character identity, ambiguous active builds and malformed or duplicate selected talents are rejected',()=>{
  assert.throws(()=>normalizeTalentBuild(buildPayload(),CHARACTER+1),/identity/i);
  const ambiguous=buildPayload();ambiguous.specialization_groups.push(structuredClone(ambiguous.specialization_groups[0]));assert.throws(()=>normalizeTalentBuild(ambiguous,CHARACTER),/multiple active/i);
  for(const talent of [selected(0),selected(134399,0),selected('134399'),{talent:{id:134399},talent_rank:1.5}])assert.throws(()=>normalizeTalentBuild(buildPayload([talent]),CHARACTER));
  assert.throws(()=>normalizeTalentBuild(buildPayload([selected(),selected()]),CHARACTER),/duplicate/i);
  const duplicate=buildPayload();duplicate.specialization_groups[0].specializations.push(structuredClone(duplicate.specialization_groups[0].specializations[0]));assert.throws(()=>normalizeTalentBuild(duplicate,CHARACTER),/duplicate/i);
});

test('descriptions are bounded plain text and optional missing descriptions do not invent spell details',()=>{
  const payload=buildPayload();payload.specialization_groups[0].specializations[0].talents[0].spell_tooltip.description='\u0000'+ 'x'.repeat(9000);
  const node=normalizeTalentBuild(payload,CHARACTER).trees[0].nodes[0];assert.equal(node.description.length,8000);assert(!node.description.includes('\u0000'));
  delete payload.specialization_groups[0].specializations[0].talents[0].spell_tooltip;
  const absent=normalizeTalentBuild(payload,CHARACTER).trees[0].nodes[0];assert.equal(absent.description,null);assert.equal(absent.spell_id,null);assert.equal(absent.rank,4);
});

test('static layout uses tooltip talent IDs and observed coordinates, retaining gaps when offsets are removed',()=>{
  const payload=layoutPayload(),original=structuredClone(payload),tree=normalizeTalentLayout(payload,11,134);
  assert.equal(tree.id,134);assert.equal(tree.layout_available,true);assert.equal(tree.layout_observed_at,null);
  assert.deepEqual(tree.nodes.map(node=>[node.id,node.row,node.column,node.max_rank]),[[134399,0,1,5],[134400,0,2,5],[134404,2,0,2]]);
  assert(!tree.nodes.some(node=>node.id===104938));assert.equal(tree.nodes[0].ranks.find(rank=>rank.rank===4).description,'Static rank 4 description');
  assert(tree.nodes.every(node=>node.prerequisite_ids.length===0));assert.deepEqual(payload,original);
});

test('static layout rejects wrong class or specialization and duplicate rank or node identities',()=>{
  assert.throws(()=>normalizeTalentLayout(layoutPayload(),8,134),/did not match/i);assert.throws(()=>normalizeTalentLayout(layoutPayload(),11,574),/did not match/i);
  const rank=layoutPayload();rank.spec_talent_nodes[0].ranks.push(structuredClone(rank.spec_talent_nodes[0].ranks[0]));assert.throws(()=>normalizeTalentLayout(rank,11,134),/duplicate/i);
  const node=layoutPayload();node.spec_talent_nodes.push(structuredClone(node.spec_talent_nodes[0]));assert.throws(()=>normalizeTalentLayout(node,11,134),/duplicate/i);
});

test('incomplete coordinates preserve observed talents while marking the full layout unavailable',()=>{
  const payload=layoutPayload();delete payload.spec_talent_nodes[1].display_col;
  const tree=normalizeTalentLayout(payload,11,134);assert.equal(tree.layout_available,false);assert.equal(tree.nodes.find(node=>node.id===134400).column,null);
  assert.equal(tree.nodes.length,3);assert.match(tree.note,/list/i);
});

test('merging a complete selection marks unselected nodes zero and keeps the selected rank-specific tooltip',()=>{
  const build=normalizeTalentBuild(buildPayload(),CHARACTER),tree=layout(),at='2026-11-08T18:00:00.000Z';tree.layout_observed_at=at;
  const original=structuredClone({build,tree}),merged=mergeTalentTrees(build,[tree])[0];
  assert.equal(merged.layout_available,true);assert.equal(merged.points,4);assert.equal(merged.layout_observed_at,at);
  assert.equal(merged.nodes.find(node=>node.id===134399).rank,4);assert.equal(merged.nodes.find(node=>node.id===134399).max_rank,5);
  assert.equal(merged.nodes.find(node=>node.id===134399).description,'Observed rank 4 description');assert.equal(merged.nodes.find(node=>node.id===134399).description_rank,4);
  const unselected=merged.nodes.find(node=>node.id===134400);assert.equal(unselected.rank,0);assert.equal(unselected.description_rank,1);assert.equal(unselected.description,'Static rank 1 description');
  assert.equal(merged.nodes[0].ranks,undefined);assert.deepEqual({build,tree},original);
});

test('missing selection never turns unobserved talent ranks or other trees into zero points',()=>{
  const missing=buildPayload();delete missing.specialization_groups[0].specializations[0].talents;
  const build=normalizeTalentBuild(missing,CHARACTER),other={...layout(),id:574,name:'Balance'},trees=mergeTalentTrees(build,[layout(),other]);
  assert(trees.flatMap(tree=>tree.nodes).every(node=>node.rank===null));assert.equal(trees[0].points,4);assert.equal(trees[1].points,null);
  const empty=normalizeTalentBuild({character:{id:CHARACTER},specialization_groups:[{is_active:true,specializations:[]}]},CHARACTER);
  assert(mergeTalentTrees(empty,[layout(),other]).every(tree=>tree.points===0&&tree.nodes.every(node=>node.rank===0)));
  const partial=normalizeTalentBuild(buildPayload(),CHARACTER);partial.selection_known=false;
  const incomplete=mergeTalentTrees(partial,[layout()])[0];assert.equal(incomplete.nodes.find(node=>node.id===134399).rank,4);
  assert(incomplete.nodes.filter(node=>node.id!==134399).every(node=>node.rank===null));
});

test('all class layouts survive merging and selected talents absent from a layout remain visible without invented coordinates',()=>{
  const build=normalizeTalentBuild(buildPayload([selected(),selected(134402,1,'Brutal Impact')],5),CHARACTER),other={...layout(),id:574,name:'Balance'};
  const trees=mergeTalentTrees(build,[layout(),other]);assert.equal(trees.length,2);assert.equal(trees[1].points,0);
  const tree=trees[0],missing=tree.nodes.find(node=>node.id===134402);assert.equal(tree.layout_available,false);assert.match(tree.note,/not present/i);
  assert.equal(missing.rank,1);assert.equal(missing.max_rank,null);assert.equal(missing.row,null);assert.equal(missing.column,null);
  const onlySelected=mergeTalentTrees(build,[])[0];assert.equal(onlySelected.nodes.length,2);assert.equal(onlySelected.layout_available,false);assert.equal(onlySelected.layout_observed_at,null);
});

test('a selected rank above the cached static maximum remains observed and disables the obsolete layout',()=>{
  const build=normalizeTalentBuild(buildPayload([selected(134399,6)],6),CHARACTER),tree=mergeTalentTrees(build,[layout()])[0],node=tree.nodes.find(node=>node.id===134399);
  assert.equal(node.rank,6);assert.equal(node.max_rank,null);assert.equal(node.description,'Observed rank 6 description');assert.equal(node.description_rank,6);assert.equal(tree.layout_available,false);assert.match(tree.note,/newer/i);
});

test('an exact selected rank can use a static description only when the observed tooltip text was absent',()=>{
  const payload=buildPayload();delete payload.specialization_groups[0].specializations[0].talents[0].spell_tooltip;
  const node=mergeTalentTrees(normalizeTalentBuild(payload,CHARACTER),[layout()])[0].nodes.find(node=>node.id===134399);
  assert.equal(node.rank,4);assert.equal(node.description_rank,4);assert.equal(node.description,'Static rank 4 description');
});
