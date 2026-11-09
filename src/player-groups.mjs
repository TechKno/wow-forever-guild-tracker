// Rows must already be provider-verified current characters, ordered by roster slug.
// A departed saved main gets the first current character as a display fallback; no choices are written.
export function effectivePlayerMains(rows=[]){
  const players=new Map(),result=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    if(typeof row?.user_id!=='string'||!row.user_id||!Number.isSafeInteger(row.character_id)||row.character_id<1)continue;
    if(!players.has(row.user_id))players.set(row.user_id,{stored:row.main_character_id,characters:[]});
    players.get(row.user_id).characters.push(row.character_id);
  }
  for(const [user,player]of players)result.set(user,player.characters.includes(player.stored)?player.stored:player.characters[0]);
  return result;
}

// These groups describe roster presentation only. They do not establish ownership or bot authority.
export function rosterDisplayGroups(people=[]){
  const groups=[],used=new Set();
  for(const person of Array.isArray(people)?people:[]){
    if(typeof person?.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(person.key))continue;
    const characters=(Array.isArray(person.characters)?person.characters:[]).filter(character=>{
      if(!Number.isSafeInteger(character?.id)||character.id<1||used.has(character.id))return false;
      const included=character.association==='admin'||character.association==='provider'&&(character.is_main===true||character.is_alt===true);
      if(included)used.add(character.id);return included;
    });
    if(!characters.length)continue;
    const main=characters.find(character=>character.is_main===true)||characters.find(character=>character.event_default===true)||characters[0];
    groups.push({key:person.key,display_name:typeof person.display_name==='string'?person.display_name:'Guild member',discord_linked:Boolean(person.discord_linked),
      identity_source:['provider','admin','mixed','unlinked'].includes(person.identity_source)?person.identity_source:'unlinked',
      main_character_id:main.id,character_ids:characters.map(character=>character.id)});
  }
  return groups;
}
