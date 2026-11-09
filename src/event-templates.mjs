import {WebError} from './auth.mjs';
import {EVENT_CATALOGUE} from './event-catalogue.mjs';

const kinds=['Dungeon','Raid','Roleplay','Other'],combat=['Tank','Healer','Damage'];
const enumValue=(value,allowed,fallback)=>allowed.includes(value)?value:fallback;
const clean=(value,max=1000)=>typeof value==='string'?value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
const idValue=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)?value:null;
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function integer(value,min,max,message){if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))throw new WebError(message);const number=Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw new WebError(message);return number;}
function level(value){return value===null||value===undefined||value===''?null:integer(value,1,100,'Use a level from 1 to 100 or leave it blank');}
function levelRange(value){
  if(value===null||value===undefined||value==='')return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WebError('Check the recommended level range');
  const min=level(value.min),max=level(value.max);if(min===null&&max===null)return null;
  if(min===null||max===null||min>max)throw new WebError('Enter both recommended levels, with the lower level first');return {min,max};
}
export function validateEventRoleLimits(value,capacity,kind){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WebError('Set a place count for each event role');
  const allowed=['Dungeon','Raid'].includes(kind)?combat:kind==='Roleplay'?['Roleplay','Social']:[...combat,'Roleplay','Social'],keys=Object.keys(value);
  if(!keys.length||keys.some(key=>!allowed.includes(key)))throw new WebError('Choose roles appropriate for this event');
  const result=Object.fromEntries(allowed.map(role=>[role,own(value,role)?integer(value[role],0,40,'Use whole role counts from 0 to 40'):0]));
  if(Object.values(result).reduce((sum,count)=>sum+count,0)!==capacity)throw new WebError('Role places must add up to the event capacity');
  return result;
}
function sources(value){
  if(!Array.isArray(value))return [];
  return value.slice(0,8).flatMap(source=>{
    let url;try{url=new URL(source?.url);if(url.protocol!=='https:'||url.username||url.password||url.port||url.href.length>2000)return [];}catch{return [];}
    const title=clean(source?.title,160);return title?[{title,url:url.href}]:[];
  });
}
function normalizedTemplate(value,{snapshot=false}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WebError('The event suggestion is unavailable',503);
  const id=idValue(value.id),name=clean(value.name,100),kind=value.kind;
  if((!snapshot&&!id)||!name||!kinds.includes(kind)||!snapshot&&!['Dungeon','Raid'].includes(kind))throw new WebError('The event suggestion is unavailable',503);
  const capacity=integer(value.capacity,1,40,'The suggested group size is unavailable'),minimum=level(value.minimum_level),recommended=levelRange(value.recommended_level);
  return {id,name,kind,capacity,role_limits:value.role_limits?validateEventRoleLimits(value.role_limits,capacity,kind):null,
    minimum_level:minimum,recommended_level:recommended,location:clean(value.location,100),duration_minutes:integer(value.duration_minutes??120,15,720,'The suggested duration is unavailable'),
    status:enumValue(value.status,['available','announced','unverified'],'unverified'),capacity_status:enumValue(value.capacity_status,['verified','unverified'],'unverified'),
    minimum_level_status:enumValue(value.minimum_level_status,snapshot?['verified','unverified','guide']:['verified','unverified'],'unverified'),
    recommended_level_status:enumValue(value.recommended_level_status,['verified','guide','unverified'],'unverified'),role_status:'suggested',notes:clean(value.notes,1500),sources:sources(value.sources),
    ...(snapshot?{level_guide_source:enumValue(value.level_guide_source,['catalogue','member'],'catalogue'),minimum_level_source:enumValue(value.minimum_level_source,['catalogue','member'],'catalogue'),recommended_level_source:enumValue(value.recommended_level_source,['catalogue','member'],'catalogue'),catalogue_checked_at:typeof value.catalogue_checked_at==='string'&&Number.isFinite(Date.parse(value.catalogue_checked_at))?value.catalogue_checked_at:null}: {})};
}
export function eventTemplateCatalogue(catalogue=EVENT_CATALOGUE){
  if(!catalogue||catalogue.schema_version!==1||!Array.isArray(catalogue.templates)||catalogue.templates.length>200)throw new WebError('Event suggestions are temporarily unavailable',503);
  const templates=catalogue.templates.map(value=>normalizedTemplate(value)),seen=new Set();
  for(const template of templates){if(seen.has(template.id))throw new WebError('Event suggestions are temporarily unavailable',503);seen.add(template.id);}
  return {schema_version:1,checked_at:typeof catalogue.checked_at==='string'&&Number.isFinite(Date.parse(catalogue.checked_at))?catalogue.checked_at:null,game:clean(catalogue.game,100)||'World of Warcraft Forever',templates,
    note:clean(catalogue.note,1500)||'Group sizes and level guidance describe suggested runs. Recommended roles are editable. Unverified Forever requirements are labelled; level guides do not block sign-ups.'};
}
export function eventTemplateSettings(body,catalogue=EVENT_CATALOGUE){
  const templateId=body.template_id===undefined||body.template_id===null||body.template_id===''?null:idValue(body.template_id);
  if(body.template_id&&templateId===null)throw new WebError('Choose a valid event suggestion');
  const published=eventTemplateCatalogue(catalogue),template=templateId?published.templates.find(value=>value.id===templateId):null;
  if(templateId&&!template)throw new WebError('That event suggestion changed. Refresh and choose it again');
  const kind=body.kind??template?.kind;
  if(!kinds.includes(kind)||template&&kind!==template.kind)throw new WebError('Choose an event type matching its suggestion');
  const capacity=integer(body.capacity??template?.capacity??(kind==='Raid'?40:5),1,40,'Enter an event capacity from 1 to 40');
  const requestedRoles=own(body,'role_limits')?body.role_limits:template?.role_limits??(kind==='Dungeon'&&capacity===5?{Tank:1,Healer:1,Damage:3}:null);
  const roleLimits=own(body,'role_limits')?validateEventRoleLimits(requestedRoles,capacity,kind):requestedRoles===null?null:validateEventRoleLimits(requestedRoles,capacity,kind);
  const hasMinimum=own(body,'minimum_level'),hasRecommended=own(body,'recommended_level');
  const minimum=hasMinimum?level(body.minimum_level):template?.minimum_level??null,recommended=hasRecommended?levelRange(body.recommended_level):template?.recommended_level??null;
  let guidance=template?{...template,level_guide_source:'catalogue',minimum_level_source:'catalogue',recommended_level_source:'catalogue',catalogue_checked_at:published.checked_at}:null;
  const minimumChanged=hasMinimum&&minimum!==(template?.minimum_level??null),recommendedChanged=hasRecommended&&JSON.stringify(recommended)!==JSON.stringify(template?.recommended_level??null);
  if(!guidance&&(minimum!==null||recommended!==null))guidance={id:null,name:clean(body.title,100)||'Member-planned event',kind,capacity,role_limits:roleLimits,minimum_level:null,recommended_level:null,location:clean(body.location,100),duration_minutes:120,status:'unverified',capacity_status:'unverified',minimum_level_status:'unverified',recommended_level_status:'unverified',role_status:'suggested',notes:'Level guidance entered by the event host; not a verified game-entry requirement.',sources:[],level_guide_source:'member',minimum_level_source:'member',recommended_level_source:'member',catalogue_checked_at:null};
  if(guidance){
    guidance={...guidance,capacity,role_limits:roleLimits,minimum_level:minimum,recommended_level:recommended};
    if(template&&capacity!==template.capacity)guidance.capacity_status='unverified';
    if(minimumChanged){guidance.minimum_level_status='guide';guidance.minimum_level_source='member';guidance.level_guide_source='member';}
    if(recommendedChanged){guidance.recommended_level_status='guide';guidance.recommended_level_source='member';guidance.level_guide_source='member';}
  }
  return {kind,capacity,role_limits:roleLimits,template_id:templateId,template_guidance:guidance};
}
export function eventTemplateGuidance(event){
  try{const raw=typeof event?.template_json==='string'?JSON.parse(event.template_json):event?.template_guidance;if(!raw)return null;return normalizedTemplate(raw,{snapshot:true});}catch{return null;}
}
export function eventGuideLines(event){
  const guide=eventTemplateGuidance(event);if(!guide)return [];
  const status=(value,minimum)=>value==='verified'?(minimum?'published entry requirement':'published level range'):value==='guide'?((minimum?guide.minimum_level_source:guide.recommended_level_source)==='member'?'host guide':'recommended guide'):'Forever requirement unverified';
  return [guide.status==='announced'?'Announced content · planning ahead; check availability before the run.':'',guide.minimum_level!==null?`Minimum level ${guide.minimum_level} · ${status(guide.minimum_level_status,true)}`:'Minimum entry level has not been verified.',
    guide.recommended_level?`Recommended levels ${guide.recommended_level.min}–${guide.recommended_level.max} · ${status(guide.recommended_level_status,false)}`:'',
    guide.notes?guide.notes.slice(0,220):''].filter(Boolean);
}
