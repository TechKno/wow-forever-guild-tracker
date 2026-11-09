import {LOCALE} from './config.mjs';
const MAX_TREES=100,MAX_NODES=1000,MAX_RANKS=100;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function positive(value,field){
  if(!Number.isSafeInteger(value)||value<=0)throw Error(`Invalid ${field}`);
  return value;
}
function list(value,field,maximum){
  if(!Array.isArray(value)||value.length>maximum)throw Error(`Invalid ${field}`);
  return value;
}
function text(value,maximum=240){
  if(value===undefined||value===null)return null;
  if(object(value))value=value[LOCALE]??value.en_GB??value.en_US??Object.values(value).find(v=>typeof v==='string');
  if(typeof value!=='string')throw Error('Invalid talent text');
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,maximum)||null;
}
function named(value,fallback){return text(value)||fallback;}
function tooltip(value){
  if(value!==undefined&&!object(value))throw Error('Invalid spell tooltip');
  const spell=value?.spell;
  if(spell!==undefined&&!object(spell))throw Error('Invalid talent spell');
  return {description:text(value?.description,8000),spell_id:spell?.id===undefined?null:positive(spell.id,'spell ID')};
}
function selectedNode(value){
  if(!object(value)||!object(value.talent))throw Error('Invalid selected talent');
  const id=positive(value.talent.id,'talent ID'),rank=positive(value.talent_rank,'talent rank');
  if(rank>MAX_RANKS)throw Error('Invalid talent rank');
  return {id,name:named(value.talent.name,`Talent #${id}`),rank,...tooltip(value.spell_tooltip),description_rank:rank};
}

export function normalizeTalentBuild(payload,characterId){
  positive(characterId,'character ID');
  if(!object(payload)||payload.character?.id!==characterId)throw Error('Talent character identity did not match');
  const groups=list(payload.specialization_groups,'talent groups',MAX_TREES);
  if(groups.some(group=>!object(group)||typeof group.is_active!=='boolean'))throw Error('Invalid active talent group');
  const active=groups.filter(group=>group.is_active);
  if(active.length>1)throw Error('Multiple active talent groups were returned');
  if(!active.length||active[0].specializations===undefined)return {selection_known:false,trees:[]};
  const seenTrees=new Set(),seenTalents=new Set();
  const trees=list(active[0].specializations,'specializations',MAX_TREES).map(spec=>{
    if(!object(spec)||!object(spec.specialization))throw Error('Invalid talent specialization');
    const id=positive(spec.specialization.id,'specialization ID');
    if(seenTrees.has(id))throw Error('Duplicate talent specialization');seenTrees.add(id);
    if(!Number.isSafeInteger(spec.spent_points)||spec.spent_points<0)throw Error('Invalid spent talent points');
    const selection_known=spec.talents!==undefined;
    const nodes=selection_known?list(spec.talents,'selected talents',MAX_NODES).map(value=>{
      const node=selectedNode(value);
      if(seenTalents.has(node.id))throw Error('Duplicate selected talent');seenTalents.add(node.id);
      return node;
    }):[];
    return {id,name:named(spec.specialization_name??spec.specialization.name,`Tree #${id}`),points:spec.spent_points,nodes,selection_known};
  });
  return {selection_known:trees.every(tree=>tree.selection_known),trees};
}

function coordinate(value){return Number.isSafeInteger(value)&&value>=0&&value<=1000?value:null;}
export function normalizeTalentLayout(payload,classId,specId){
  positive(classId,'class ID');positive(specId,'specialization ID');
  if(!object(payload)||payload.playable_class?.id!==classId||payload.playable_specialization?.id!==specId)throw Error('Talent tree class or specialization did not match');
  positive(payload.id,'talent tree ID');
  const rawNodes=list(payload.spec_talent_nodes,'static talent nodes',MAX_NODES),seenNodes=new Set(),byTalent=new Map(),nodeTalents=new Map();
  let complete=rawNodes.length>0;
  for(const raw of rawNodes){
    if(!object(raw))throw Error('Invalid static talent node');
    const nodeId=positive(raw.id,'talent node ID');
    if(seenNodes.has(nodeId))throw Error('Duplicate static talent node');seenNodes.add(nodeId);
    const row=coordinate(raw.display_row),column=coordinate(raw.display_col);
    if(row===null||column===null)complete=false;
    const ranks=list(raw.ranks,'static talent ranks',MAX_RANKS),nodeIds=new Set(),rankIds=new Set();
    if(!ranks.length)throw Error('Static talent ranks were absent');
    for(const value of ranks){
      if(!object(value))throw Error('Invalid static talent rank');
      const rank=positive(value.rank,'static talent rank');if(rank>MAX_RANKS)throw Error('Invalid static talent rank');
      const choices=value.tooltip!==undefined?[value.tooltip]:list(value.choice_of_tooltips,'talent choices',MAX_NODES);
      if(!choices.length)throw Error('Static talent tooltip was absent');
      for(const choice of choices){
        if(!object(choice)||!object(choice.talent))throw Error('Invalid static talent tooltip');
        const id=positive(choice.talent.id,'static talent ID'),rankKey=id+':'+rank;
        if(rankIds.has(rankKey))throw Error('Duplicate static talent rank');rankIds.add(rankKey);
        let node=byTalent.get(id);
        if(node&&node.node_id!==nodeId)throw Error('Talent appeared in multiple static nodes');
        if(!node){
          node={id,name:named(choice.talent.name,`Talent #${id}`),node_id:nodeId,row,column,max_rank:0,ranks:[],locked_by:[]};
          byTalent.set(id,node);
        }
        node.ranks.push({rank,name:named(choice.talent.name,node.name),...tooltip(choice.spell_tooltip)});
        node.max_rank=Math.max(node.max_rank,rank);nodeIds.add(id);
      }
    }
    if(nodeIds.size>1)complete=false;
    nodeTalents.set(nodeId,[...nodeIds]);
    if(raw.locked_by!==undefined){
      const locked=list(raw.locked_by,'talent prerequisites',MAX_NODES).map(id=>positive(id,'prerequisite node ID'));
      for(const id of nodeIds)byTalent.get(id).locked_by=locked;
    }
  }
  const values=[...byTalent.values()],rows=values.map(n=>n.row).filter(v=>v!==null),columns=values.map(n=>n.column).filter(v=>v!==null);
  const minRow=rows.length?Math.min(...rows):0,minColumn=columns.length?Math.min(...columns):0,positions=new Set();
  const nodes=values.map(({node_id,locked_by,...node})=>{
    node.row=node.row===null?null:node.row-minRow;node.column=node.column===null?null:node.column-minColumn;
    const position=node.row+':'+node.column;if(positions.has(position))complete=false;positions.add(position);
    node.ranks.sort((a,b)=>a.rank-b.rank);
    const preview=node.ranks[0];
    return {...node,rank:null,description:preview.description,description_rank:preview.rank,spell_id:preview.spell_id,
      prerequisite_ids:[...new Set(locked_by.flatMap(id=>nodeTalents.get(id)||[]))]};
  });
  return {id:specId,name:named(payload.name??payload.playable_specialization.name,`Tree #${specId}`),nodes,layout_available:complete,layout_observed_at:null,
    note:complete?null:'The complete talent layout was not returned; the available talents are shown as a list.'};
}

function fallbackNode(node){return {...node,max_rank:null,row:null,column:null,prerequisite_ids:[]};}
export function mergeTalentTrees(build,layouts){
  if(!object(build)||typeof build.selection_known!=='boolean'||!Array.isArray(build.trees)||!Array.isArray(layouts))throw Error('Invalid normalized talent data');
  const selected=new Map(build.trees.map(tree=>[tree.id,tree])),seen=new Set();
  const result=layouts.map(layout=>{
    if(seen.has(layout.id))throw Error('Duplicate talent layout');seen.add(layout.id);
    const tree=selected.get(layout.id),known=build.selection_known===true&&tree?.selection_known!==false,chosen=new Map((tree?.nodes||[]).map(node=>[node.id,node]));
    let available=layout.layout_available===true,note=layout.note||null;
    const nodes=layout.nodes.map(node=>{
      const pick=chosen.get(node.id);chosen.delete(node.id);
      const rank=pick?pick.rank:known?0:null,rankTooltip=pick?node.ranks.find(value=>value.rank===rank):node.ranks[0];
      let max=node.max_rank;
      if(pick&&pick.rank>max){max=null;available=false;note='The selected rank is newer than the available layout. The observed selection is shown as a list.';}
      return {id:node.id,name:pick?.name||node.name,rank,max_rank:max,
        description:pick?.description??rankTooltip?.description??null,
        description_rank:pick?.description?pick.description_rank:rankTooltip?.rank??null,
        row:node.row,column:node.column,spell_id:pick?.spell_id??rankTooltip?.spell_id??null,
        prerequisite_ids:[...(node.prerequisite_ids||[])]};
    });
    if(chosen.size){
      available=false;note='Some selected talents were not present in the available layout. The observed talents are shown as a list.';
      nodes.push(...[...chosen.values()].map(fallbackNode));
    }
    if(!known)note=note||'The active talent selection was not fully returned. Unobserved ranks are unknown.';
    return {id:layout.id,name:tree?.name||layout.name,points:tree?.points??(known?0:null),nodes,selection_known:known,
      layout_available:available,layout_observed_at:layout.layout_observed_at||null,note};
  });
  for(const tree of build.trees)if(!seen.has(tree.id))result.push({...tree,nodes:tree.nodes.map(fallbackNode),layout_available:false,layout_observed_at:null,
    note:'The full talent layout is unavailable. Only the observed selection is shown.'});
  return result;
}
