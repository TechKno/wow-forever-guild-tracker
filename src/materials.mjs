import {LOCALE} from './config.mjs';
import {api,state} from './logic.mjs';
import {WebError,stamp} from './auth.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
export async function knownRecipes(env){
  const rows=await env.DB.prepare(`SELECT c.data FROM characters c JOIN verified_membership m ON m.character_id=c.id WHERE m.generation=(SELECT published FROM sync WHERE id=1)`).all();
  const map=new Map();
  for(const row of rows.results)for(const p of JSON.parse(row.data).professions||[])for(const recipe of p.recipes||[])map.set(recipe.id,recipe.name);
  return map;
}
export function normalizeRecipe(value){
  if(!Number.isSafeInteger(value.id))throw new WebError('Recipe identity was not returned',502);
  const name=typeof value.name==='string'?value.name:(value.name?.[LOCALE]||value.name?.en_GB||value.name?.en_US||'');
  const reagents=Array.isArray(value.reagents)?value.reagents.map(r=>({id:r.reagent?.id,name:typeof r.reagent?.name==='string'?r.reagent.name:(r.reagent?.name?.[LOCALE]||r.reagent?.name?.en_GB||r.reagent?.name?.en_US||''),quantity:r.quantity})):null;
  const verified=reagents!==null&&reagents.every(r=>Number.isSafeInteger(r.id)&&typeof r.name==='string'&&r.name&&Number.isSafeInteger(r.quantity)&&r.quantity>0);
  const q=value.crafted_quantity||{};
  const fixed=Number.isSafeInteger(q.value)&&q.value>0?q.value:null;
  const output={id:value.crafted_item?.id??null,name:typeof value.crafted_item?.name==='string'?value.crafted_item.name:'',
    value:fixed,minimum:fixed??(Number.isSafeInteger(q.minimum)&&q.minimum>0?q.minimum:null),maximum:fixed??(Number.isSafeInteger(q.maximum)&&q.maximum>0?q.maximum:null)};
  return {id:value.id,name,reagents:verified?reagents:[],verified,output,observed_at:stamp()};
}
export async function loadRecipe(env,id,known){
  const cached=await env.DB.prepare('SELECT data,expires FROM recipe_details WHERE id=?').bind(id).first();
  if(cached&&cached.expires>epoch())return JSON.parse(cached.data);
  const catalogue=known||await knownRecipes(env);if(!catalogue.has(id))throw new WebError('That recipe has not been observed in this guild',404);
  let detail;
  try{
    detail=normalizeRecipe(await api(env,`/data/wow/recipe/${id}`,'static'));if(detail.id!==id||!detail.verified)throw 0;
  }catch{
    const previous=cached?JSON.parse(cached.data):null;
    detail=previous?.verified?{...previous,stale:true,message:'Material refresh unavailable; showing previously verified requirements'}:{id,name:catalogue.get(id),verified:false,reagents:[],output:{},observed_at:null,message:'Blizzard did not return verified material requirements'};
  }
  await env.DB.prepare('INSERT OR REPLACE INTO recipe_details(id,data,expires) VALUES(?,?,?)')
    .bind(id,JSON.stringify(detail),epoch()+(detail.verified&&!detail.stale?172800:600)).run();
  return detail;
}
export async function hydrateOneRecipe(env){
  const paused=await state(env,'blizzard_cooldown');if(paused>epoch())return {processed:null,paused_until:paused};
  const known=await knownRecipes(env);
  const rows=await env.DB.prepare('SELECT id,expires FROM recipe_details').all();
  const current=new Map(rows.results.map(r=>[r.id,r.expires]));
  const missing=[...known.keys()].find(id=>!current.has(id)||current.get(id)<=epoch());
  if(missing!==undefined)await loadRecipe(env,missing,known);
  return {processed:missing??null,remaining:[...known.keys()].filter(id=>!current.has(id)||current.get(id)<=epoch()).length-(missing!==undefined?1:0),total:known.size};
}
export function buildMaterialPlan(root,crafts,catalogue,choices={},expand=true){
  if(!Number.isSafeInteger(crafts)||crafts<1||crafts>200)throw new WebError('Choose between 1 and 200 crafts');
  if(!root.verified)return {...root,crafts,status:'unavailable',direct:[],shopping_list:[],components:[],alternatives:[],warnings:['Material requirements have not been verified. A manual list is required.']};
  const direct=root.reagents.map(r=>({...r,quantity:r.quantity*crafts}));
  const producers=new Map();
  for(const recipe of catalogue){
    if(recipe.verified&&recipe.output?.id&&recipe.output.value>0){
      if(!producers.has(recipe.output.id))producers.set(recipe.output.id,[]);
      producers.get(recipe.output.id).push(recipe);
    }
  }
  const nodes=new Map(),colours=new Map(),stack=[],warnings=new Set(root.stale?[root.message||'Material requirements are from a previous observation.']:[]),alternatives=[];
  function discover(item,depth){
    if(colours.get(item.id)===1){
      const start=stack.indexOf(item.id);
      for(const id of stack.slice(start)){const n=nodes.get(id);n.recipe=null;n.reason='Cyclic recipe chain';}
      warnings.add('A cyclic component recipe was left as an item to provide.');return;
    }
    if(colours.get(item.id)===2)return;
    const options=(producers.get(item.id)||[]).sort((a,b)=>a.id-b.id);
    let recipe=null;
    if(expand&&depth<8&&nodes.size<100){
      if(Object.hasOwn(choices,String(item.id)))recipe=options.find(r=>r.id===Number(choices[item.id]))||null;
      else if(options.length===1)recipe=options[0];
      if(options.length)alternatives.push({item_id:item.id,item_name:item.name,selected:recipe?.id||0,options:options.map(r=>({id:r.id,name:r.name,yield:r.output.value}))});
      if(options.length>1&&!Object.hasOwn(choices,String(item.id)))warnings.add('Some components have alternative recipes. Choose one or provide the component as an item.');
    }
    if(depth>=8||nodes.size>=100){recipe=null;warnings.add('A complex component chain was left partly unexpanded.');}
    const node={id:item.id,name:item.name,recipe};nodes.set(item.id,node);colours.set(item.id,1);stack.push(item.id);
    if(recipe)for(const reagent of recipe.reagents){discover(reagent,depth+1);if(!node.recipe)break;}
    stack.pop();colours.set(item.id,2);
  }
  for(const item of direct)discover(item,0);
  const indegree=new Map([...nodes.keys()].map(id=>[id,0])),demand=new Map();
  for(const item of direct)demand.set(item.id,(demand.get(item.id)||0)+item.quantity);
  for(const node of nodes.values())if(node.recipe)for(const id of new Set(node.recipe.reagents.map(r=>r.id)))indegree.set(id,(indegree.get(id)||0)+1);
  const queue=[...indegree].filter(([,n])=>n===0).map(([id])=>id),shopping=[],components=[];
  for(let i=0;i<queue.length;i++){
    const id=queue[i],node=nodes.get(id),quantity=demand.get(id)||0;
    if(!Number.isSafeInteger(quantity)||quantity>10000000)throw new WebError('This material calculation is too large',422);
    if(node.recipe&&quantity>0){
      const count=Math.ceil(quantity/node.recipe.output.value);
      components.push({item_id:id,item_name:node.name,required:quantity,recipe_id:node.recipe.id,recipe_name:node.recipe.name,
        crafts:count,produced:count*node.recipe.output.value,spare:count*node.recipe.output.value-quantity});
      for(const r of node.recipe.reagents)demand.set(r.id,(demand.get(r.id)||0)+r.quantity*count);
    }else if(quantity>0)shopping.push({id,name:node.name,quantity});
    if(node.recipe)for(const child of new Set(node.recipe.reagents.map(r=>r.id))){indegree.set(child,indegree.get(child)-1);if(indegree.get(child)===0)queue.push(child);}
  }
  if(queue.length<nodes.size)throw new WebError('The component recipe chain could not be resolved safely',422);
  return {id:root.id,name:root.name,status:'verified',crafts,observed_at:root.observed_at,output:root.output,
    direct,components,shopping_list:shopping.sort((a,b)=>a.name.localeCompare(b.name)),alternatives,warnings:[...warnings],
    note:'Unexpanded components remain items to provide. This is not an inventory check or a complete catalog of every possible recipe.'};
}
export async function materialPlan(env,id,crafts=1,choices={},expand=true){
  if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).length>100||
    Object.entries(choices).some(([key,value])=>!/^\d{1,10}$/.test(key)||!Number.isSafeInteger(Number(value))||Number(value)<0||Number(value)>2147483647))
    throw new WebError('Invalid component recipe selection');
  const root=await loadRecipe(env,id);
  const known=await knownRecipes(env);
  const cached=await env.DB.prepare('SELECT id,data FROM recipe_details WHERE expires>?').bind(epoch()).all();
  const catalogue=cached.results.filter(r=>known.has(r.id)).map(r=>JSON.parse(r.data));
  return {...buildMaterialPlan(root,crafts,catalogue,choices,expand),catalogue:{available:catalogue.filter(r=>r.verified).length,checked:catalogue.length,total:known.size}};
}
