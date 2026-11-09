import {WebError,ownCharacter,stamp} from './auth.mjs';
export const CHARACTER_ROLES=['Tank','Healer','Damage'];

export function validateRolePreferences(body){
  const roles=body.preferred_roles,primary=body.primary_role;
  if(!Array.isArray(roles)||roles.length>3||roles.some(role=>!CHARACTER_ROLES.includes(role))||new Set(roles).size!==roles.length)
    throw new WebError('Choose Tank, Healer or Damage once each');
  if(roles.length?!CHARACTER_ROLES.includes(primary)||!roles.includes(primary):primary!==null)
    throw new WebError('Choose exactly one of your selected roles as primary, or clear all roles');
  return {preferred_roles:CHARACTER_ROLES.filter(role=>roles.includes(role)),primary_role:primary};
}

// A saved preference belongs to the account that declared it. Never inherit an
// earlier owner's choices or present a stale account as currently verified.
export async function currentRolePreferences(env){
  const rows=await env.DB.prepare(`SELECT r.character_id,r.tank,r.healer,r.damage,r.primary_role,r.updated_at
    FROM character_role_preferences r
    JOIN character_links l ON l.character_id=r.character_id AND l.user_id=r.user_id
    JOIN users u ON u.id=l.user_id
    JOIN verified_membership m ON m.character_id=r.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
    WHERE u.ownership_status='verified' AND u.ownership_checked>unixepoch()-86400 AND u.ownership_checked<=unixepoch()+60`).all();
  return new Map(rows.results.map(row=>[row.character_id,{
    preferred_roles:CHARACTER_ROLES.filter(role=>row[role.toLowerCase()]===1),
    primary_role:row.primary_role,role_preferences_updated_at:row.updated_at
  }]));
}
export function withRolePreferences(character,preferences){
  return {...character,...(preferences.get(character.id)||{preferred_roles:[],primary_role:null,role_preferences_updated_at:null})};
}
export async function saveRolePreferences(env,user,body){
  const char=ownCharacter(user,body.character_id),preferences=validateRolePreferences(body),at=stamp();
  const result=await env.DB.prepare(`INSERT INTO character_role_preferences(character_id,user_id,tank,healer,damage,primary_role,updated_at)
    SELECT l.character_id,l.user_id,?,?,?,?,? FROM character_links l
    JOIN users u ON u.id=l.user_id
    JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
    WHERE l.character_id=? AND l.user_id=? AND u.ownership_status='verified'
      AND u.ownership_checked=? AND u.ownership_checked>unixepoch()-86400 AND u.ownership_checked<=unixepoch()+60
    ON CONFLICT(character_id) DO UPDATE SET user_id=excluded.user_id,tank=excluded.tank,healer=excluded.healer,
      damage=excluded.damage,primary_role=excluded.primary_role,updated_at=excluded.updated_at`)
    .bind(...CHARACTER_ROLES.map(role=>preferences.preferred_roles.includes(role)?1:0),preferences.primary_role,at,char.id,user.id,user.ownership_checked).run();
  if(Number(result.meta?.changes??result.changes??0)!==1)throw new WebError('Character ownership changed; refresh the page before saving roles',403);
  return {message:preferences.preferred_roles.length?'Preferred roles saved; you can change them at any time':'Preferred roles cleared; you can set them again at any time',
    character_id:char.id,...preferences,role_preferences_updated_at:at};
}
