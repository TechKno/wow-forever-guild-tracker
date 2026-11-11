const key=p=>`${p.id??p.name}|${p.tier||''}`;
const ids=p=>new Set((p.recipes||[]).map(r=>r.id));
const stableList=values=>[...new Set(values.map(value=>JSON.stringify(value)))].sort().map(value=>JSON.parse(value));
const professionValue=p=>({id:p.id??null,name:p.name??'',kind:p.kind??'',tier:p.tier??'',skill:p.skill??null,max_skill:p.max_skill??null,
  recipe_status:p.recipe_status??'unknown',recipes:stableList((p.recipes||[]).map(r=>({id:r.id??null,name:r.name??''})))});
const professionValues=values=>stableList(values.map(professionValue));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const emptyObservation=()=>({levelKnown:false,level:null,professionsKnown:false,professions:[]});
function previousObservation(data){
  const value=emptyObservation();
  if(data?.profile&&Object.hasOwn(data.profile,'level')&&(data.profile_at||data.profile_status==='verified')){value.levelKnown=true;value.level=data.profile.level??null;}
  if(Array.isArray(data?.professions)&&(data.professions_at||data.professions_status==='verified')){value.professionsKnown=true;value.professions=professionValues(data.professions);}
  return value;
}
const professionName=p=>p.tier&&p.tier!==p.name?`${p.name} (${p.tier})`:p.name||'Profession';
function observationChanges(before,after){
  const changes=[];
  if(after.levelKnown&&(!before.levelKnown||before.level!==after.level))changes.push(before.levelKnown?`Level: ${before.level??'not returned'} → ${after.level??'not returned'}`:`Level first observed: ${after.level??'not returned'}`);
  if(!after.professionsKnown||before.professionsKnown&&equal(before.professions,after.professions))return changes;
  if(!before.professionsKnown){
    if(!after.professions.length)changes.push('Professions first observed: none returned');
    else for(const profession of after.professions)changes.push(`${professionName(profession)} first observed: ${profession.skill??'?'} / ${profession.max_skill??'?'}${profession.recipe_status==='observed'?` · ${profession.recipes.length} known recipes`:''}`);
    return changes;
  }
  const professionChangeStart=changes.length,previous=new Map(before.professions.map(p=>[key(p),p])),current=new Map(after.professions.map(p=>[key(p),p]));
  for(const [id,profession]of current){
    const prior=previous.get(id),name=professionName(profession);
    if(!prior){changes.push(`${name} added: ${profession.skill??'?'} / ${profession.max_skill??'?'}`);continue;}
    if(prior.skill!==profession.skill)changes.push(`${name}: ${prior.skill??'?'} → ${profession.skill??'?'}${profession.max_skill!=null?` / ${profession.max_skill}`:''}`);
    else if(prior.max_skill!==profession.max_skill)changes.push(`${name} maximum skill: ${prior.max_skill??'?'} → ${profession.max_skill??'?'}`);
    if(prior.recipe_status!==profession.recipe_status)changes.push(`${name}: recipe coverage ${profession.recipe_status==='observed'?`now observed (${profession.recipes.length} known recipes)`:'no longer returned'}`);
    else if(profession.recipe_status==='observed'&&!equal(prior.recipes,profession.recipes)){
      const known=new Set(prior.recipes.map(r=>r.id??r.name)),next=new Set(profession.recipes.map(r=>r.id??r.name));
      const added=profession.recipes.filter(r=>!known.has(r.id??r.name)).length,removed=prior.recipes.filter(r=>!next.has(r.id??r.name)).length;
      if(added)changes.push(`${name}: ${added} new ${added===1?'recipe':'recipes'} observed`);
      if(removed)changes.push(`${name}: ${removed} ${removed===1?'recipe':'recipes'} no longer returned`);
      if(!added&&!removed)changes.push(`${name}: known recipe details changed`);
    }
    if(prior.name!==profession.name||prior.kind!==profession.kind)changes.push(`${name}: profession details changed`);
  }
  for(const [id,profession]of previous)if(!current.has(id))changes.push(`${professionName(profession)} no longer returned`);
  // Preserve an unusual provider/schema change even if its exact distinction is
  // not one of the familiar skill or recipe differences above.
  if(changes.length===professionChangeStart)changes.push('Profession observations changed');
  return changes;
}
function applySnapshot(before,snapshot){
  const after={...before};
  // Legacy null components mean this endpoint was not checked, never proof of
  // lost professions or level. An explicit empty profession array is observed.
  if(snapshot.level!=null||snapshot.profile_observed_at){after.levelKnown=true;after.level=snapshot.level??null;}
  if(Array.isArray(snapshot.professions)){after.professionsKnown=true;after.professions=professionValues(snapshot.professions);}
  return after;
}
const recipeIdentity=recipe=>recipe.id??recipe.name;
const recipeName=recipe=>recipe.name||(recipe.id!=null?`Recipe #${recipe.id}`:'Unnamed recipe');
function granularObservationEvents(before,after){
  const events=[],add=(kind,title,detail='',extra={})=>events.push({kind,title,...(detail?{detail}:{}),...extra});
  if(!before.levelKnown&&!before.professionsKnown){
    const detail=[after.levelKnown?`Level ${after.level??'not returned'}`:'',after.professionsKnown?(after.professions.length?after.professions.map(p=>`${professionName(p)} ${p.skill??'?'} / ${p.max_skill??'?'}`).join(' · '):'No professions returned'):''].filter(Boolean).join(' · ');
    if(detail)add('baseline','Recorded baseline',detail,{baseline:true});
    return events;
  }
  if(after.levelKnown&&(!before.levelKnown||before.level!==after.level))add('level',before.levelKnown?`Level: ${before.level??'not returned'} → ${after.level??'not returned'}`:`Level first observed: ${after.level??'not returned'}`);
  if(!after.professionsKnown||before.professionsKnown&&equal(before.professions,after.professions))return events;
  if(!before.professionsKnown){
    add('coverage','Profession data first observed',after.professions.length?after.professions.map(p=>`${professionName(p)} ${p.skill??'?'} / ${p.max_skill??'?'}`).join(' · '):'No professions returned');
    return events;
  }
  const previous=new Map(before.professions.map(p=>[key(p),p])),current=new Map(after.professions.map(p=>[key(p),p])),start=events.length;
  const recipeEvent=(profession,recipe,change)=>{
    const title=change==='added'?'New recipe observed':change==='removed'?'Recipe no longer returned':'Recipe first observed';
    add('recipe',`${title}: ${recipeName(recipe)}`,professionName(profession),{profession:profession.name,recipe_id:recipe.id??null,recipe_name:recipe.name||null,change});
  };
  for(const [id,profession]of current){
    const prior=previous.get(id),name=professionName(profession);
    if(!prior){
      add('profession',`${name} first observed`,`${profession.skill??'?'} / ${profession.max_skill??'?'}`);
      if(profession.recipe_status==='observed')for(const recipe of profession.recipes)recipeEvent(profession,recipe,'first_observed');
      continue;
    }
    if(prior.skill!==profession.skill)add('skill',`${name}: ${prior.skill??'?'} → ${profession.skill??'?'}${profession.max_skill!=null?` / ${profession.max_skill}`:''}`);
    else if(prior.max_skill!==profession.max_skill)add('skill',`${name} maximum skill: ${prior.max_skill??'?'} → ${profession.max_skill??'?'}`);
    if(prior.recipe_status!==profession.recipe_status){
      add('coverage',`${name}: recipe coverage ${profession.recipe_status==='observed'?'now observed':'no longer returned'}`);
      if(profession.recipe_status==='observed')for(const recipe of profession.recipes)recipeEvent(profession,recipe,'first_observed');
    }else if(profession.recipe_status==='observed'&&!equal(prior.recipes,profession.recipes)){
      const known=new Map(prior.recipes.map(r=>[recipeIdentity(r),r])),next=new Map(profession.recipes.map(r=>[recipeIdentity(r),r]));
      for(const [recipeId,recipe]of next){
        if(!known.has(recipeId))recipeEvent(profession,recipe,'added');
        else if(!equal(known.get(recipeId),recipe))add('recipe',`${name}: recipe details changed`,`${recipeName(known.get(recipeId))} → ${recipeName(recipe)}`,{profession:profession.name,recipe_id:recipe.id??null,recipe_name:recipe.name||null,change:'details'});
      }
      for(const [recipeId,recipe]of known)if(!next.has(recipeId))recipeEvent(profession,recipe,'removed');
    }
    if(prior.name!==profession.name||prior.kind!==profession.kind)add('profession',`${name}: profession details changed`);
  }
  for(const [id,profession]of previous)if(!current.has(id)){
    add('profession',`${professionName(profession)} no longer returned`);
    if(profession.recipe_status==='observed')for(const recipe of profession.recipes)recipeEvent(profession,recipe,'removed');
  }
  if(events.length===start)add('profession','Profession observations changed');
  return events;
}
function legacyRecordedEvents(snapshot){
  // Version-one snapshots retained the actual delta text, but not the identity
  // of each added recipe. Preserve that evidence without guessing which names
  // in the resulting complete recipe list were newly acquired.
  if(snapshot.baseline)return [{kind:'baseline',title:'Recorded baseline',detail:snapshot.changes.join(' · '),baseline:true}];
  return snapshot.changes.map(title=>({kind:/^Level/.test(title)?'level':/recipes?/.test(title)?'recipe':/ → /.test(title)?'skill':/coverage/.test(title)?'coverage':'profession',title,
    ...(/\d+ new .*recipes? observed|\d+ recipes? no longer returned/.test(title)?{detail:'This older observation retained the recipe count, not the individual recipe names.'}:{})}));
}
function retainedEvents(snapshot){
  return snapshot.observation_events_schema===1&&Array.isArray(snapshot.observation_events)&&snapshot.observation_events.length&&snapshot.observation_events.every(event=>event&&['level','skill','recipe','profession','coverage','baseline'].includes(event.kind)&&typeof event.title==='string'&&(event.detail===undefined||typeof event.detail==='string'))?snapshot.observation_events:null;
}
export function progressStatements(env,member,old,data,options={}){
  const fresh=key=>data[key+'_status']==='verified';
  const profileFresh=fresh('profile'),professionsFresh=fresh('professions');
  const suppliedLevel=Number.isSafeInteger(options.levelAfter)&&options.levelAfter>0;
  if(!profileFresh&&!professionsFresh&&!suppliedLevel)return [];
  const at=options.observedAt||new Date().toISOString(),statements=[];
  const before=previousObservation(old),after={...before};
  if(Number.isSafeInteger(options.levelBefore)&&options.levelBefore>0){before.levelKnown=true;before.level=options.levelBefore;after.levelKnown=true;after.level=options.levelBefore;}
  if(profileFresh&&data.profile&&Object.hasOwn(data.profile,'level')){after.levelKnown=true;after.level=data.profile.level??null;}
  if(suppliedLevel){after.levelKnown=true;after.level=options.levelAfter;}
  if(professionsFresh&&Array.isArray(data.professions)){after.professionsKnown=true;after.professions=professionValues(data.professions);}
  const add=(kind,title,detail='')=>statements.push(env.DB.prepare('INSERT INTO activity(id,character_id,kind,title,detail,observed_at) VALUES(?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),member.id,kind,title,detail,at));
  if((profileFresh||suppliedLevel)&&before.levelKnown&&Number.isFinite(before.level)&&after.level>before.level)
    add('level',`${member.name} reached level ${after.level}`,`Previously observed at level ${before.level}${options.levelSource==='roster'?' · Blizzard guild roster':''}`);
  if(professionsFresh&&old?.professions_at){
    const previous=new Map((old.professions||[]).map(p=>[key(p),p]));
    for(const p of data.professions||[]){
      const before=previous.get(key(p));if(!before)continue;
      if(Number.isFinite(before.skill)&&Number.isFinite(p.skill)&&p.skill>before.skill)add('skill',`${member.name} improved ${p.name}`,`${before.skill} → ${p.skill}${p.max_skill?' / '+p.max_skill:''}`);
      if(before.recipe_status==='observed'&&p.recipe_status==='observed'){
        const known=ids(before),added=(p.recipes||[]).filter(r=>!known.has(r.id));
        if(added.length)add('recipe',`${added.length} new ${p.name} ${added.length===1?'recipe':'recipes'} observed for ${member.name}`,added.slice(0,8).map(r=>r.name).join(', '));
      }
    }
  }
  if(statements.length>18)statements.length=18;
  const changes=observationChanges(before,after);
  if(changes.length){
    const levelChanged=after.levelKnown&&(!before.levelKnown||before.level!==after.level),professionsChanged=after.professionsKnown&&(!before.professionsKnown||!equal(before.professions,after.professions));
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO snapshots(character_id,observed_at,data) VALUES(?,?,?)')
      .bind(member.id,at,JSON.stringify({level:levelChanged?after.level:null,profile_observed_at:levelChanged&&options.levelSource!=='roster'?data.profile_at||at:null,
        ...(levelChanged?{level_source:options.levelSource||'profile',level_observed_at:options.levelObservedAt||data.profile_at||at}:{}),
        professions:professionsChanged?data.professions:null,professions_observed_at:professionsChanged?data.professions_at||at:null,
        change_schema:1,changes,baseline:!before.levelKnown&&!before.professionsKnown,
        observation_events_schema:1,observation_events:granularObservationEvents(before,after)})));
  }
  // Keep each invocation small even if a returning character has several changed skills.
  return statements.slice(0,20);
}
export async function recordProgress(env,member,old,data){
  const statements=progressStatements(env,member,old,data);
  if(statements.length)await env.DB.batch(statements);
}
export async function historyView(env,characterId){
  const id=Number(characterId)||0;
  const activity=await env.DB.prepare(`SELECT * FROM activity WHERE (?=0 OR character_id=?) ORDER BY observed_at DESC LIMIT 100`).bind(id,id).all();
  const scanLimit=2000,snapshots=id?await env.DB.prepare('SELECT observed_at,data FROM snapshots WHERE character_id=? ORDER BY observed_at DESC LIMIT 2001').bind(id).all():{results:[]};
  const truncated=snapshots.results.length>scanLimit,rows=snapshots.results.slice(0,scanLimit).reverse(),changed=[],observations=[];
  let previous=emptyObservation();
  for(const row of rows){
    let snapshot;try{snapshot=JSON.parse(row.data);}catch{continue;}
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))continue;
    const next=applySnapshot(previous,snapshot),changes=observationChanges(previous,next),baseline=!previous.levelKnown&&!previous.professionsKnown;
    const recorded=snapshot.change_schema===1&&Array.isArray(snapshot.changes)&&snapshot.changes.length&&snapshot.changes.every(value=>typeof value==='string'),storedEvents=retainedEvents(snapshot);
    if(changes.length||recorded||storedEvents){
      changed.push({...snapshot,observed_at:row.observed_at,changes:recorded?snapshot.changes:changes,baseline:recorded?Boolean(snapshot.baseline):baseline});
      const incompleteComparison=(snapshot.level!=null||snapshot.profile_observed_at)&&!previous.levelKnown||Array.isArray(snapshot.professions)&&!previous.professionsKnown;
      const events=storedEvents||(recorded&&(incompleteComparison||!changes.length)?legacyRecordedEvents(snapshot):granularObservationEvents(previous,next));
      for(const [index,event]of events.entries())observations.push({...event,id:`${row.observed_at}:${index}`,observed_at:row.observed_at});
    }
    previous=next;
  }
  return {activity:activity.results,snapshots:changed.slice(-40).reverse(),observations:observations.slice(-100).reverse(),observations_limit:100,observations_has_more:truncated||observations.length>100,
    observations_scanned:rows.length,history_scan_limit:scanLimit,history_truncated:truncated,history_has_more:truncated||changed.length>40,
    note:'Each observed level, skill or individual recipe change has its own dated entry; identical polls are hidden. An initial observation is a baseline. Timestamps show when data was observed, not the exact in-game action time. Existing milestones remain available separately.'+(observations.length>100?' The latest 100 individual observation entries are shown.':'')+(truncated?' This view compares the latest 2,000 saved observations; older context was not scanned and its oldest baseline may be partial.':'')};
}
export async function maintain(env){
  const today=new Date().toISOString().slice(0,10);
  const last=await env.DB.prepare("SELECT value FROM state WHERE key='maintenance_day'").first();if(last?.value===today)return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM discord_event_reactions WHERE event_id IN (SELECT id FROM events WHERE datetime(starts_at,'+'||duration_minutes||' minutes')<datetime('now','-30 days'))"),
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(Math.floor(Date.now()/1000)),
    env.DB.prepare('DELETE FROM discord_states WHERE expires<?').bind(Math.floor(Date.now()/1000)),
    env.DB.prepare("DELETE FROM discord_outbox WHERE status<>'pending' AND created_at<?").bind(new Date(Date.now()-30*86400000).toISOString()),
    env.DB.prepare('DELETE FROM api_cache WHERE expires<?').bind(Math.floor(Date.now()/1000)-86400),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires<?').bind(Math.floor(Date.now()/1000)),
    env.DB.prepare('DELETE FROM snapshots WHERE observed_at<?').bind(new Date(Date.now()-90*86400000).toISOString()),
    env.DB.prepare('DELETE FROM activity WHERE observed_at<?').bind(new Date(Date.now()-365*86400000).toISOString()),
    env.DB.prepare("DELETE FROM site_daily_traffic WHERE day<date('now','-89 days')"),
    env.DB.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('maintenance_day',?)").bind(today)
  ]);
}
