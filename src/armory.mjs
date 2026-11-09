import {apiObservation,APIError,label,state} from './logic.mjs';
import {currentUser,requireMember,WebError} from './auth.mjs';

import {CONFIG} from './config.mjs';
const REGION=CONFIG.guild.region;
const epoch=()=>Math.floor(Date.now()/1000),stamp=()=>new Date().toISOString();
const positive=value=>Number.isSafeInteger(value)&&value>0;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const text=(value,max=250)=>label(value).slice(0,max);
const slots=new Set(['HEAD','NECK','SHOULDER','BACK','CHEST','SHIRT','TABARD','WRIST','HANDS','WAIST','LEGS','FEET','FINGER_1','FINGER_2','TRINKET_1','TRINKET_2','MAIN_HAND','OFF_HAND','RANGED']);
const quality=new Set(['POOR','COMMON','UNCOMMON','RARE','EPIC','LEGENDARY','ARTIFACT','HEIRLOOM']);
function identity(payload,characterId){
  if(payload?.character?.id!==characterId)throw Error('Character identity did not match');
}
export function normalizeEquipment(payload,characterId){
  identity(payload,characterId);
  if(!Array.isArray(payload.equipped_items)||payload.equipped_items.length>30)throw Error('Equipment coverage was not returned');
  const seen=new Set();
  const items=payload.equipped_items.map(item=>{
    const slot=item?.slot?.type,id=item?.item?.id;
    if(!slots.has(slot)||seen.has(slot)||!positive(id))throw Error('Equipment slots or item identity did not match');
    seen.add(slot);
    const enchants=Array.isArray(item.enchantments)?item.enchantments:null;
    if(enchants?.length>20)throw Error('Equipment enchantment list was oversized');
    const stats=Array.isArray(item.stats)?item.stats.slice(0,30).map(stat=>({name:text(stat.type),value:number(stat.value),display:text(stat.display?.display_string)})).filter(stat=>stat.name||stat.display):[];
    return {slot,slot_name:text(item.slot)||slot.replaceAll('_',' '),id,name:text(item.name||item.item.name)||`Item #${id}`,
      quality:quality.has(item.quality?.type)?item.quality.type:null,quality_name:text(item.quality),
      item_level:number(item.level?.value),item_class:text(item.item_class),item_subclass:text(item.item_subclass),
      inventory_type:text(item.inventory_type),binding:text(item.binding),stats,
      enchantments_status:enchants?'observed':'unknown',enchantments:enchants?enchants.map(enchant=>({name:text(enchant.display_string||enchant.enchantment?.name||enchant.enchantment),id:positive(enchant.enchantment_id)?enchant.enchantment_id:null})).filter(enchant=>enchant.name):[],
      weapon_damage:text(item.weapon?.damage?.display_string),weapon_speed:number(item.weapon?.attack_speed),
      durability:text(item.durability?.display_string),required_level:number(item.requirements?.level?.value)};
  });
  return {items,equipped_item_level:number(payload.equipped_item_level),average_item_level:number(payload.average_item_level),coverage:'returned_items'};
}
const metric=(id,name,unit,paths)=>({id,name,unit,paths});
const metrics=[metric('health','Health','',['health']),metric('power','Power','',['power','power.value']),
  ...['strength','agility','intellect','stamina'].map(name=>metric(name,name[0].toUpperCase()+name.slice(1),'',[name+'.effective',name+'.value',name])),
  metric('armor','Armor','',['armor.effective','armor.value','armor']),metric('attack_power','Attack power','',['attack_power.value','attack_power']),
  metric('spell_power','Spell power','',['spell_power.value','spell_power']),metric('melee_crit','Melee critical strike','%',['melee_crit.value']),
  metric('ranged_crit','Ranged critical strike','%',['ranged_crit.value']),metric('spell_crit','Spell critical strike','%',['spell_crit.value']),
  metric('dodge','Dodge','%',['dodge.value']),metric('parry','Parry','%',['parry.value']),metric('block','Block','%',['block.value'])];
export function normalizeStatistics(payload,characterId){
  identity(payload,characterId);
  const read=path=>path.split('.').reduce((value,key)=>value?.[key],payload);
  const values=metrics.flatMap(metric=>{
    const value=metric.paths.map(read).find(value=>number(value)!==null);
    if(value===undefined)return [];
    return [{id:metric.id,name:metric.id==='power'?text(payload.power_type)||'Power':metric.name,value,unit:metric.unit}];
  });
  if(!values.length)throw Error('Character statistics were not returned');
  return {values};
}
export function allowedArmoryImage(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='render.worldofwarcraft.com'||url.port||url.username||url.password||url.search||url.hash)return null;
    if(!new RegExp('^/forever-'+REGION+'/character/[A-Za-z0-9/_-]+\\.(?:jpg|jpeg|png|webp)$','i').test(url.pathname))return null;
    return url.href;
  }catch{return null;}
}
export function normalizeMedia(payload,characterId){
  identity(payload,characterId);
  if(!Array.isArray(payload.assets)||payload.assets.length>12)throw Error('Character artwork was not returned');
  const assets=[],seen=new Set();
  for(const asset of payload.assets){
    if(!['avatar','inset','main','main-raw'].includes(asset?.key)||seen.has(asset.key))continue;
    const href=allowedArmoryImage(asset.value);if(!href)continue;
    seen.add(asset.key);assets.push({key:asset.key,href});
  }
  if(!assets.length)throw Error('No supported character artwork was returned');
  return {assets};
}
const inflight=new WeakMap();
async function resource(env,characterId,section,path,normalize,namespace='profile'){
  const key=`armory:${characterId}:${section}`,row=await env.DB.prepare('SELECT data,expires FROM api_cache WHERE key=?').bind(key).first();
  let prior;try{prior=row?JSON.parse(row.data):null;}catch{prior=null;}
  const saved=prior?.schema===1?prior:null;
  if(saved&&row.expires>epoch())return saved;
  const cooldown=await state(env,'blizzard_cooldown');
  if(cooldown>epoch())return {...(saved||{data:null,observed_at:null,checked_at:null}),status:saved?.data?'stale':'unavailable',note:'Blizzard requested a pause. Saved observations are retained.',retry_at:new Date(cooldown*1000).toISOString()};
  let pending=inflight.get(env.DB);if(!pending){pending=new Map();inflight.set(env.DB,pending);}
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    const at=stamp();let result,delay;
    try{
      const observation=await apiObservation(env,path,namespace),data=await normalize(observation.data,characterId);
      const modified=Date.parse(observation.metadata?.last_modified||'');
      delay=900;result={schema:1,status:'verified',data,observed_at:at,checked_at:at,source_updated_at:Number.isFinite(modified)?new Date(modified).toISOString():null,note:''};
    }catch(error){
      delay=error instanceof APIError?Math.max(error.status===404?3600:300,error.retryAfter||0):300;
      result={schema:1,status:saved?.data?'stale':'unavailable',data:saved?.data||null,observed_at:saved?.observed_at||null,checked_at:at,source_updated_at:saved?.source_updated_at||null,
        note:error instanceof APIError&&error.status===404?'Blizzard has not published this section.':'The latest section could not be verified. Any previous observation is retained.'};
    }
    result.retry_at=new Date((epoch()+delay)*1000).toISOString();
    await env.DB.prepare('INSERT OR REPLACE INTO api_cache(key,data,expires) VALUES(?,?,?)').bind(key,JSON.stringify(result),epoch()+delay).run();return result;
  })();
  pending.set(key,task);try{return await task;}finally{pending.delete(key);}
}
async function memberFor(request,env,id){
  requireMember(await currentUser(request,env));
  if(!positive(id))throw new WebError('Current guild character not found',404);
  const row=await env.DB.prepare('SELECT data FROM verified_membership WHERE character_id=? AND generation=(SELECT published FROM sync WHERE id=1)').bind(id).first();
  if(!row)throw new WebError('Current guild character not found',404);
  let member;try{member=JSON.parse(row.data);}catch{throw new WebError('Current guild character not found',404);}
  if(member.id!==id||typeof member.slug!=='string'||!/^[\p{L}\p{M}]+-[\p{L}\p{M}]+$/u.test(member.slug))throw new WebError('Current guild character not found',404);
  return member;
}
export async function armoryView(request,env,characterId){
  const member=await memberFor(request,env,characterId),base='/profile/wow/character/'+encodeURIComponent(member.slug),sections={};
  // Serial requests let a provider429 pause the remaining sections immediately.
  for(const [name,suffix,normalize]of [['equipment','equipment',normalizeEquipment],['statistics','statistics',normalizeStatistics],['media','character-media',normalizeMedia]]){
    sections[name]=await resource(env,characterId,name,base+'/'+suffix,normalize);
  }
  // Membership can change while the provider request is in flight.
  await memberFor(request,env,characterId);
  if(sections.equipment.data)sections.equipment={...sections.equipment,data:{...sections.equipment.data,items:sections.equipment.data.items.map(item=>({...item,icon_url:`/api/characters/${characterId}/armory/item/${item.id}/icon`}))}};
  if(sections.media.data)sections.media={...sections.media,data:{assets:sections.media.data.assets.map(asset=>({key:asset.key,url:`/api/characters/${characterId}/armory/media/${asset.key}`}))}};
  return {character_id:characterId,sections,note:'Blizzard snapshots can lag behind the game. Only returned equipment, statistics and artwork are shown. An omitted slot or enchantment field is unknown, not proof that an item or enchant is missing.'};
}
export async function armoryMedia(request,env,characterId,key){
  await memberFor(request,env,characterId);
  if(!['avatar','inset','main','main-raw'].includes(key))throw new WebError('Character artwork not found',404);
  const row=await env.DB.prepare('SELECT data FROM api_cache WHERE key=?').bind(`armory:${characterId}:media`).first();
  let cached;try{cached=JSON.parse(row?.data||'null');}catch{cached=null;}
  const asset=cached?.schema===1&&cached.data?.assets?.find(asset=>asset.key===key),href=allowedArmoryImage(asset?.href);
  if(!href)throw new WebError('Character artwork not found',404);
  return imageResponse(request,env,characterId,href);
}
export function allowedItemIcon(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='render.worldofwarcraft.com'||url.username||url.password||url.port||url.search||url.hash)return null;
    return /^\/(?:forever(?:-(?:eu|us|kr|tw))?|us)\/icons\/\d{1,3}\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(url.pathname)?url.href:null;
  }catch{return null;}
}
export async function armoryIcon(request,env,characterId,itemId){
  await memberFor(request,env,characterId);
  if(!positive(itemId))throw new WebError('Item artwork not found',404);
  const equipment=await env.DB.prepare('SELECT data FROM api_cache WHERE key=?').bind(`armory:${characterId}:equipment`).first();
  let saved;try{saved=JSON.parse(equipment?.data||'null');}catch{}
  if(saved?.schema!==1||!saved.data?.items?.some(item=>item.id===itemId))throw new WebError('Item artwork not found',404);
  const icon=await resource(env,characterId,'item-icon:'+itemId,'/data/wow/media/item/'+itemId,payload=>{
    const href=allowedItemIcon(payload?.assets?.find(asset=>asset.key==='icon')?.value);
    if(payload?.id!==itemId||!href)throw Error('Item artwork identity did not match');return {href};
  },'static');
  const href=allowedItemIcon(icon.data?.href);if(!href)throw new WebError('Item artwork is unavailable',404);
  // Some verified Forever icon references are absent from the regional CDN.
  // Only try the identical file in Blizzard's shared icon store, never artwork.
  const shared=allowedItemIcon(href.replace(/\/forever(?:-(?:eu|us|kr|tw))?\/icons\//i,'/us/icons/'));
  return imageResponse(request,env,characterId,href,shared!==href?shared:null);
}
async function imageResponse(request,env,characterId,href,fallbackHref=null){
  const read=href=>fetch(href,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{Accept:'image/png,image/jpeg,image/webp'}});
  let response;try{
    response=await read(href);
    if(fallbackHref&&[403,404].includes(response.status)){
      await response.body?.cancel();response=await read(fallbackHref);
    }
  }catch{throw new WebError('Character artwork is temporarily unavailable',502);}
  const type=response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if(!response.ok||!['image/png','image/jpeg','image/webp'].includes(type)||Number(response.headers.get('Content-Length'))>4000000){await response.body?.cancel();throw new WebError('Character artwork is temporarily unavailable',502);}
  const reader=response.body?.getReader();if(!reader)throw new WebError('Character artwork is temporarily unavailable',502);
  const chunks=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4000000){await reader.cancel();throw new WebError('Character artwork is too large',502);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const valid=type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:type==='image/png'?bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value):bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if(!valid)throw new WebError('Character artwork could not be verified',502);
  await memberFor(request,env,characterId);
  return new Response(bytes,{headers:{'Content-Type':type,'Content-Length':String(length),'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
}
