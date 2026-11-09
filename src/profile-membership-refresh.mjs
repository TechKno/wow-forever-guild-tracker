import {apiObservation,state} from './logic.mjs';
import {validateProfileMember,profileMemberRefreshStatement,profileMemberDeleteStatement} from './guild-membership.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
const changed=result=>Number(result?.meta?.changes??result?.changes??0)>0;

// Select the proof table directly: expired proofs cannot appear in the access view.
export async function recheckOneProfileMember(env){
  const now=epoch(),row=await env.DB.prepare(`SELECT f.*,u.ownership_status,u.ownership_checked,l.user_id linked_owner
    FROM profile_members f LEFT JOIN users u ON u.id=f.user_id LEFT JOIN character_links l ON l.character_id=f.character_id
    WHERE f.next_at<=? ORDER BY f.next_at,f.character_id LIMIT 1`).bind(now).first();
  if(!row)return null;
  const revoke=async()=>changed(await profileMemberDeleteStatement(env,row).run());
  const saved=JSON.parse(row.data),name=saved.name;
  if(row.linked_owner!==row.user_id||row.ownership_status!=='verified'||row.ownership_checked<=now-86400||row.ownership_checked>now+60){const removed=await revoke();return {member:name,result:removed?'membership_unverified':'membership_changed'};}
  if(await env.DB.prepare('SELECT character_id FROM membership WHERE generation=(SELECT published FROM sync WHERE id=1) AND character_id=?').bind(row.character_id).first()){
    const removed=await revoke();return {member:name,result:removed?'membership_in_roster':'membership_changed'};
  }
  try{
    const {data:profile}=await apiObservation(env,'/profile/wow/character/'+encodeURIComponent(row.slug));
    let member;
    try{const [first,surname]=row.slug.split('-');member=validateProfileMember(profile,{id:row.character_id,slug:row.slug,name:first,surname},await state(env,'guild'));}
    catch{const removed=await revoke();return {member:name,result:removed?'membership_unverified':'membership_changed'};}
    if(!changed(await profileMemberRefreshStatement(env,row,member).run()))return {member:name,result:'membership_changed'};
    await env.DB.prepare('INSERT OR IGNORE INTO character_refresh(character_id,next_at) VALUES(?,0)').bind(row.character_id).run();
    return {member:member.name,result:'membership_refreshed'};
  }catch(error){
    // A failure never extends the previous proof. The view drops it at its deadline.
    await env.DB.prepare('UPDATE profile_members SET next_at=?,last_error=? WHERE character_id=? AND user_id=? AND checked_at=? AND data=?')
      .bind(now+Math.max(300,error.retryAfter||0),'Profile membership could not be rechecked',row.character_id,row.user_id,row.checked_at,row.data).run();
    return {member:name,result:'membership_check_unavailable'};
  }
}
