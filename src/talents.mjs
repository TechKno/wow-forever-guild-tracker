import {API_ORIGIN} from './config.mjs';
import {api,APIError,label,state} from './logic.mjs';
import {normalizeTalentBuild,normalizeTalentLayout,mergeTalentTrees} from './talent-data.mjs';
const epoch=()=>Math.floor(Date.now()/1000),stamp=()=>new Date().toISOString();
const list=value=>Array.isArray(value)?value:value&&typeof value==='object'?[value]:[];
function pathOf(ref){
  try{const url=new URL(ref?.key?.href);return url.protocol==='https:'&&url.origin===API_ORIGIN?url.pathname:null;}catch{return null;}
}
export function normalizeTalentIndex(payload){
  const classes=[],specs=[];
  for(const ref of list(payload?.class_talent_trees)){const match=pathOf(ref)?.match(/^\/data\/wow\/talent-tree\/(\d+)$/);if(match)classes.push({tree_id:Number(match[1]),name:label(ref.name)});}
  for(const ref of list(payload?.spec_talent_trees)){const match=pathOf(ref)?.match(/^\/data\/wow\/talent-tree\/(\d+)\/playable-specialization\/(\d+)$/);if(match)specs.push({tree_id:Number(match[1]),id:Number(match[2]),name:label(ref.name)});}
  if([...classes,...specs].some(ref=>!Number.isSafeInteger(ref.tree_id)||ref.tree_id<1||ref.id!==undefined&&(!Number.isSafeInteger(ref.id)||ref.id<1))||!classes.length||!specs.length||classes.length>50||specs.length>100)throw Error('Blizzard did not return a usable talent tree index');
  return {classes,specs};
}
async function resource(env,key,ttl,load){
  await env.DB.prepare('INSERT OR IGNORE INTO talent_cache(cache_key) VALUES(?)').bind(key).run();
  let row=await env.DB.prepare('SELECT * FROM talent_cache WHERE cache_key=?').bind(key).first();
  const view=r=>({data:r.data?JSON.parse(r.data):null,status:r.status,observed_at:r.observed_at,checked_at:r.attempted_at,note:r.error||'',next_at:r.next_at});
  if(row.next_at>epoch())return view(row);
  const paused=await state(env,'blizzard_cooldown');
  if(paused>epoch())return {...view(row),status:row.data?'stale':'unavailable',note:'Blizzard requested a pause. Saved talent observations are retained.',next_at:paused};
  const lease=await env.DB.prepare('UPDATE talent_cache SET lease_until=? WHERE cache_key=? AND lease_until<=? AND next_at<=? RETURNING cache_key').bind(epoch()+120,key,epoch(),epoch()).first();
  if(!lease)return {...view(row),note:row.error||'A talent check is already in progress.'};
  const at=stamp();
  try{
    const data=await load();
    await env.DB.prepare("UPDATE talent_cache SET data=?,observed_at=?,attempted_at=?,next_at=?,status='verified',error=NULL,lease_until=0 WHERE cache_key=?").bind(JSON.stringify(data),at,at,epoch()+ttl,key).run();
    return {data,status:'verified',observed_at:at,checked_at:at,note:'',next_at:epoch()+ttl};
  }catch(error){
    const wait=error instanceof APIError?Math.max(error.status===404?3600:300,error.retryAfter||0):300;
    const message=error instanceof APIError?error.message:'Blizzard talent data was incomplete; any previous observation is retained.';
    await env.DB.prepare('UPDATE talent_cache SET attempted_at=?,next_at=?,status=?,error=?,lease_until=0 WHERE cache_key=?').bind(at,epoch()+wait,row.data?'stale':'unavailable',message,key).run();
    return {...view(row),status:row.data?'stale':'unavailable',checked_at:at,note:message,next_at:epoch()+wait};
  }
}
export async function talentView(env,characterId){
  if(!Number.isSafeInteger(characterId)||characterId<1)return null;
  const row=await env.DB.prepare('SELECT m.data roster,c.data details FROM verified_membership m LEFT JOIN characters c ON c.id=m.character_id WHERE m.character_id=? AND m.generation=(SELECT published FROM sync WHERE id=1)').bind(characterId).first();
  if(!row)return null;
  const member=JSON.parse(row.roster),details=row.details?JSON.parse(row.details):{};
  let build;
  if(details.talent_build&&details.talents_status==='verified'&&Date.parse(details.talents_at)>Date.now()-900000){
    build={data:details.talent_build,status:'verified',observed_at:details.talents_at,checked_at:details.talents_at,note:''};
  }else build=await resource(env,'build:'+characterId,900,async()=>normalizeTalentBuild(await api(env,`/profile/wow/character/${encodeURIComponent(member.slug)}/specializations`),characterId));
  const index=await resource(env,'index',86400,async()=>normalizeTalentIndex(await api(env,'/data/wow/talent-tree/index','static')));
  const classTree=index.data?.classes.find(c=>c.name.toLowerCase()===String(member.class).toLowerCase()),layouts=[];
  const refs=index.data?.specs.filter(s=>s.tree_id===classTree?.tree_id).slice(0,3)||[];
  let layoutDelayed=index.status!=='verified';
  for(const ref of refs){
    const result=await resource(env,`layout:${member.class_id}:${ref.tree_id}:${ref.id}`,86400,async()=>{
      const payload=await api(env,`/data/wow/talent-tree/${ref.tree_id}/playable-specialization/${ref.id}`,'static');
      if(payload.id!==ref.tree_id)throw new APIError('Talent tree identity did not match; previous observation retained');
      return normalizeTalentLayout(payload,member.class_id,ref.id);
    });
    if(result.data)layouts.push({...result.data,layout_observed_at:result.observed_at});
    if(result.status!=='verified')layoutDelayed=true;
  }
  const trees=mergeTalentTrees(build.data||{selection_known:false,trees:[]},layouts);
  const notes=[];
  if(build.status!=='verified')notes.push(build.data?'Showing a previous talent build; the latest Blizzard check was unavailable.':'Blizzard has not returned this character’s selected talents. Tree previews do not establish their build.');
  else if(!build.data?.selection_known)notes.push('Blizzard did not expose an active talent allocation. Ranks remain unknown.');
  if(layoutDelayed||refs.length!==layouts.length)notes.push('Some tree layouts could not be refreshed; previously observed layouts or selected-talent lists are shown where available.');
  return {character_id:characterId,status:['verified','stale'].includes(build.status)?build.status:'unavailable',observed_at:build.observed_at||null,checked_at:build.checked_at||null,trees,note:notes.join(' '),retry_at:build.next_at?new Date(build.next_at*1000).toISOString():null};
}
