import {api,label} from './logic.mjs';
import {currentUser,requireMember,WebError} from './auth.mjs';
const now=()=>Math.floor(Date.now()/1000);
const refs=value=>Array.isArray(value)&&value.every(q=>Number.isSafeInteger(q?.id)&&q.id>0)?value.map(q=>({id:q.id,name:label(q)||label(q.title)||`Quest #${q.id}`})):null;
export async function cachedAPI(env,path,ns='profile',ttl=600){
  const key=ns+':'+path,row=await env.DB.prepare('SELECT data FROM api_cache WHERE key=? AND expires>?').bind(key,now()).first();
  if(row)return JSON.parse(row.data);
  let result;try{result={status:'observed',data:await api(env,path,ns),observed_at:new Date().toISOString()};}
  catch{result={status:'unavailable',observed_at:new Date().toISOString(),note:'Blizzard did not return this data. No empty list or completion is assumed.'};}
  await env.DB.prepare('INSERT OR REPLACE INTO api_cache VALUES(?,?,?)').bind(key,JSON.stringify(result),now()+(result.status==='observed'?ttl:600)).run();return result;
}
export async function characterQuests(env,char){
  const base='/profile/wow/character/'+encodeURIComponent(char.slug)+'/quests';
  const [active,completed]=await Promise.all([cachedAPI(env,base),cachedAPI(env,base+'/completed')]);
  const activeList=refs(active.data?.in_progress),completedList=refs(completed.data?.quests);
  return {id:char.id,name:char.name,active:activeList,completed:completedList,active_at:activeList!==null?active.observed_at:null,completed_at:completedList!==null?completed.observed_at:null,checked_at:[active.observed_at,completed.observed_at].sort().at(-1),
    note:'API observations can lag behind the game. Current area, quest sharing, prerequisites and live online status are not verified.'};
}
export async function questAreas(env){
  const value=await cachedAPI(env,'/data/wow/quest/area/index','static',86400);
  return {status:value.status,areas:refs(value.data?.areas)||[],observed_at:value.observed_at};
}
export function compareQuests(quests,characters){
  return quests.map(q=>({...q,characters:characters.map(c=>({id:c.id,name:c.name,state:c.active?.some(x=>x.id===q.id)?'in_progress':c.completed?.some(x=>x.id===q.id)?'completed':c.active===null||c.completed===null?'unknown':'not_observed'}))}));
}
export async function questView(request,env){
  requireMember(await currentUser(request,env));const url=new URL(request.url);
  if(url.pathname==='/api/quests/areas')return questAreas(env);
  if(url.pathname!=='/api/quests/compare')throw new WebError('Quest endpoint not found',404);
  const area=Number(url.searchParams.get('area')),ids=[...new Set((url.searchParams.get('characters')||'').split(',').map(Number))];
  if(!Number.isSafeInteger(area)||area<1||ids.length<1||ids.length>5||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw new WebError('Choose an area and up to five guild characters');
  const roster=await env.DB.prepare('SELECT data FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1)').all();
  const chars=ids.map(id=>roster.results.map(r=>JSON.parse(r.data)).find(c=>c.id===id));if(chars.some(c=>!c))throw new WebError('Choose current guild characters');
  const areas=await questAreas(env);
  if(areas.status!=='observed')throw new WebError('The quest area list is unavailable; please try again later',503);
  if(!areas.areas.some(entry=>entry.id===area))throw new WebError('Choose an area returned by Blizzard');
  const value=await cachedAPI(env,'/data/wow/quest/area/'+area,'static',86400),quests=refs(value.data?.quests);
  const characters=[];for(const char of chars)characters.push(await characterQuests(env,char));
  return {area:label(value.data?.area)||`Area #${area}`,status:quests?'observed':'unavailable',observed_at:value.observed_at,
    characters:characters.map(({active,completed,...c})=>({...c,active_count:active?.length??null,completed_count:completed?.length??null})),
    quests:compareQuests(quests||[],characters),note:'Not observed means absent from returned active/completed lists, not definitely missing or shareable. Level, faction, race, class and prerequisite eligibility are unverified. Select the area manually; the API does not establish where members are now.'};
}
export async function questProbe(env){
  const row=await env.DB.prepare("SELECT data FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1) AND slug='avery-brightforge'").first();
  const char=row?JSON.parse(row.data):null;
  return {areas:await questAreas(env),character:char?await characterQuests(env,char):null};
}
