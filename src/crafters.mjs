import {currentUser,requireMember,WebError} from './auth.mjs';
import {activeManualMappings,notificationCrafters} from './admin-mappings.mjs';
import {discordReady} from './discord.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
export async function recipeCrafters(env,id){
  const rows=await env.DB.prepare(`SELECT m.character_id,m.data roster,c.data details,u.id user_id,u.main_character_id,u.ownership_status,u.ownership_checked,d.crafter_dm,d.user_id discord_linked
    FROM verified_membership m LEFT JOIN characters c ON c.id=m.character_id LEFT JOIN character_links l ON l.character_id=m.character_id
    LEFT JOIN users u ON u.id=l.user_id LEFT JOIN discord_links d ON d.user_id=u.id WHERE m.generation=(SELECT published FROM sync WHERE id=1) ORDER BY m.slug`).all();
  const configured=await discordReady(env),result=[],manual=new Map((await activeManualMappings(env)).map(r=>[r.character_id,r])),dmCandidates=await notificationCrafters(env,id);
  for(const row of rows.results){
    const char=JSON.parse(row.roster),data=row.details?JSON.parse(row.details):{};
    if(!(data.professions||[]).some(p=>(p.recipes||[]).some(r=>r.id===id)))continue;
    const verified=data.professions_status==='verified',owned=row.ownership_status==='verified'&&row.ownership_checked>epoch()-86400;
    result.push({character_id:char.id,name:char.name,class:char.class,verified,observed_at:data.professions_at||null,
      association:manual.has(char.id)?'admin':owned?'member':'unmatched',dm_available:Boolean(configured&&verified&&dmCandidates.some(r=>r.character_id===char.id)),
      dm_note:!verified?'Previous recipe observation; refresh needed':!configured?'Discord bot not configured':manual.has(char.id)?'Administrator mapping · '+(dmCandidates.some(r=>r.character_id===char.id)?'crafting DMs enabled':'DM consent not enabled or personally opted out'):!owned?'Account ownership needs Battle.net verification':!row.discord_linked?'Discord account not linked':!row.crafter_dm?'Crafter has not opted in to DMs':'Discord linked and crafter DMs enabled'});
  }
  return result;
}
export async function crafterView(request,env,id){requireMember(await currentUser(request,env));if(!Number.isSafeInteger(id)||id<1)throw new WebError('Choose a known recipe');return {crafters:await recipeCrafters(env,id),note:'Choose up to 10 recipe owners. Only selected, opted-in crafters receive DMs. No selection leaves an open board request without crafter DMs.'};}
export async function chosenCrafters(env,id,value){
  if(!Array.isArray(value)||value.length>10||value.some(v=>!Number.isSafeInteger(Number(v))||Number(v)<1))throw new WebError('Choose up to 10 crafters');
  const selected=[...new Set(value.map(Number))];if(!selected.length)return [];
  if(!id)throw new WebError('Choose a known recipe before selecting crafters');
  const available=await recipeCrafters(env,id);
  if(selected.some(cid=>!available.some(c=>c.character_id===cid&&c.verified)))throw new WebError('A selected character does not have a currently verified recipe observation. Refresh the choices before posting.');
  return selected;
}
