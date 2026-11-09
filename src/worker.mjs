import {refreshOneAccount} from './account-refresh.mjs';
import {discoverRosterAccounts} from './account-discovery.mjs';
import {CONFIG,REGION,RULESET_NAME,RULESET_LABEL,PUBLIC_ASSET_PATHS,ensureDeploymentIdentity} from './config.mjs';
import {GUILD,SLUG,tick,state,api,refreshView,queueRefresh,mergeMember,probeCharacter,APIError} from './logic.mjs';
import {authRoute,WebError,currentUser,requireMember,requireAdmin,requireWrite,readLimitedText,isSiteOrigin} from './auth.mjs';
import {sessionView,hallView,mutateHall} from './community.mjs';
import {historyView,maintain} from './progress.mjs';
import {materialPlan,hydrateOneRecipe} from './materials.mjs';
import {questView,questProbe} from './quests.mjs';
import {discordAuth,discordAdmin,discordPreferences,flushDiscord,discordConfig,discordAPI} from './discord.mjs';
import {crafterView} from './crafters.mjs';
import {pollOneEventPost,queueEventCleanups} from './event-posts.mjs';
import {mappingRoute} from './admin-mappings.mjs';
import {refreshOneDiscordProfile} from './discord-people.mjs';
import {talentView} from './talents.mjs';
import {queueCraftCleanups,pollOneCraftPost} from './craft-posts.mjs';
import {protectEntry,protectMember} from './security.mjs';
import {membershipRevision} from './guild-membership.mjs';
import {currentRolePreferences,withRolePreferences} from './character-roles.mjs';
import {adminOverview} from './admin-overview.mjs';
import {guildRanks} from './guild-ranks.mjs';
import {eventTemplateCatalogue} from './event-templates.mjs';
import {galleryRoute} from './gallery.mjs';
import {armoryView,armoryMedia,armoryIcon} from './armory.mjs';
const securityHeaders={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security':'max-age=31536000',
  'X-Frame-Options':'DENY',
  'Cross-Origin-Opener-Policy':'same-origin'
};
function json(value,status=200,privateResponse=true) { return new Response(JSON.stringify(value),{status,headers:{...securityHeaders,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(status===429?{'Retry-After':'60'}:{}),...(privateResponse?{'Vary':'Cookie'}:{})}}); }
const welcomePaths=new Set(['/','/index.html','/welcome.html']);
const publicAssets=new Set(['/welcome.css','/welcome.js','/privacy.html','/privacy.css',...PUBLIC_ASSET_PATHS]);
const guildPaths=new Set(['/guild','/guild/','/guild.html']);
function privateRedirect(location){return new Response(null,{status:303,headers:{...securityHeaders,Location:location,'Cache-Control':'private, no-store','Vary':'Cookie'}});}
async function assetResponse(request,env,path,privateResponse){
  const target=new URL(request.url);target.pathname=path;
  const response=await env.ASSETS.fetch(new Request(target,request)),headers=new Headers(response.headers);
  for(const [key,value]of Object.entries(securityHeaders))headers.set(key,value);
  headers.set('Cache-Control',privateResponse?'private, no-store':'no-store');
  if(privateResponse){const vary=headers.get('Vary');headers.set('Vary',vary&&!vary.split(',').some(v=>v.trim().toLowerCase()==='cookie')?vary+', Cookie':vary||'Cookie');}
  return new Response(response.body,{status:response.status,headers});
}
async function handleRequest(request,env) {
    const url=new URL(request.url);
    try {
      if(url.protocol==='http:'){const target=new URL(url);target.protocol='https:';if(isSiteOrigin(target.origin))return new Response(null,{status:308,headers:{...securityHeaders,Location:target.href,'Cache-Control':'no-store'}});}
      await protectEntry(request,env);
      if(url.pathname.startsWith('/auth/')){
        const response=url.pathname.startsWith('/auth/discord/')?await discordAuth(request,env):await authRoute(request,env);
        if(!response)return json({error:'Not found'},404);
        const headers=new Headers(response.headers);
        for(const [key,value]of Object.entries(securityHeaders))headers.set(key,value);
        return new Response(response.body,{status:response.status,headers});
      }
      if(welcomePaths.has(url.pathname)||publicAssets.has(url.pathname)){
        if(!['GET','HEAD'].includes(request.method))return json({error:'Read-only page'},405,false);
        return assetResponse(request,env,welcomePaths.has(url.pathname)?'/welcome.html':url.pathname,false);
      }
      if(url.pathname==='/internal/bootstrap')return json({error:'Not found'},404,false);
      if(['/favicon.ico','/robots.txt'].includes(url.pathname))return json({error:'Not found'},404,false);
      if(url.pathname==='/api/public'){
        if(!['GET','HEAD'].includes(request.method))return json({error:'Read-only guild information'},405,false);
        await ensureDeploymentIdentity(env);
        const row=await env.DB.prepare('SELECT published,roster_at,(SELECT COUNT(*) FROM verified_membership WHERE generation=sync.published) member_count,(SELECT COUNT(*) FROM membership WHERE generation=sync.published) roster_count FROM sync WHERE id=1').first();
        return json({guild_name:GUILD,region:REGION.toUpperCase(),ruleset:RULESET_NAME,game:'World of Warcraft Forever',member_count:row?.published?row.member_count:null,roster_member_count:row?.published?row.roster_count:null,profile_verified_count:row?.published?row.member_count-row.roster_count:null,roster_observed_at:row?.published?row.roster_at:null},200,false);
      }
      if(url.pathname==='/healthz'){
        if(!['GET','HEAD'].includes(request.method))return json({error:'Read-only health check'},405,false);
        await env.DB.prepare('SELECT id FROM sync WHERE id=1').first();return json({status:'ok'},200,false);
      }
      if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
        try{const user=await currentUser(request,env);requireMember(user);await protectMember(request,env,user);}
        catch(error){if(error instanceof WebError&&[401,403].includes(error.status))return json({error:error.message,access_required:true},error.status);throw error;}
      }
      if(url.pathname==='/api/event-templates'&&request.method==='GET')return json(eventTemplateCatalogue());
      if(url.pathname==='/api/gallery'||url.pathname.startsWith('/api/gallery/')){
        const result=await galleryRoute(request,env);
        if(!(result instanceof Response))return json(result);
        const headers=new Headers(result.headers);for(const [key,value]of Object.entries(securityHeaders))headers.set(key,value);
        headers.set('Cache-Control','private, no-store');headers.set('Vary','Cookie');
        return new Response(result.body,{status:result.status,headers});
      }
      if(url.pathname==='/api/admin/character-mappings'&&['GET','POST'].includes(request.method))return json(await mappingRoute(request,env));
      if(url.pathname==='/api/admin/overview'&&request.method==='GET')return json(await adminOverview(request,env));
      if(url.pathname==='/api/guild/ranks'&&request.method==='GET'||url.pathname==='/api/admin/ranks'&&request.method==='POST')return json(await guildRanks(request,env));
      const armoryMatch=url.pathname.match(/^\/api\/characters\/(\d+)\/armory$/);
      if(armoryMatch&&request.method==='GET')return json(await armoryView(request,env,Number(armoryMatch[1])));
      const mediaMatch=url.pathname.match(/^\/api\/characters\/(\d+)\/armory\/media\/([a-z-]+)$/);
      const iconMatch=url.pathname.match(/^\/api\/characters\/(\d+)\/armory\/item\/(\d+)\/icon$/);
      if((mediaMatch||iconMatch)&&request.method==='GET'){
        const response=mediaMatch?await armoryMedia(request,env,Number(mediaMatch[1]),mediaMatch[2]):await armoryIcon(request,env,Number(iconMatch[1]),Number(iconMatch[2])),headers=new Headers(response.headers);
        for(const [key,value]of Object.entries(securityHeaders))headers.set(key,value);
        headers.set('Cache-Control','private, no-store');headers.set('Vary','Cookie');
        return new Response(response.body,{status:response.status,headers});
      }
      const talentMatch=url.pathname.match(/^\/api\/characters\/(\d+)\/talents$/);
      if(talentMatch&&request.method==='GET'){const result=await talentView(env,Number(talentMatch[1]));return json(result||{error:'Current guild character not found'},result?200:404);}
      if(url.pathname==='/api/admin/refresh'&&request.method==='POST'){
        const user=await currentUser(request,env);requireAdmin(user);requireWrite(request,user);
        const body=await readLimitedText(request,1000,'Refresh request is too large');
        let data;try{data=JSON.parse(body);if(!data||typeof data!=='object'||Array.isArray(data))throw 0;}catch{throw new WebError('Invalid refresh request');}
        try{return json(await queueRefresh(env,data));}catch(error){if(error instanceof APIError&&error.status===400)throw new WebError(error.message);throw error;}
      }
      if(url.pathname==='/api/admin/discord/channels'&&request.method==='GET'){
        requireAdmin(await currentUser(request,env));const config=await discordConfig(env),channels=await discordAPI(env,'/guilds/'+config.guild_id+'/channels');
        return json({channels:channels.map(c=>({id:c.id,name:c.name,type:c.type,fields:Object.keys(c).sort()}))});
      }
      if(url.pathname==='/api/admin/discord'&&['GET','POST'].includes(request.method))return json(await discordAdmin(request,env));
      if(url.pathname==='/api/hall/discord'&&request.method==='POST')return json(await discordPreferences(request,env));
      if(url.pathname.startsWith('/api/hall/')&&request.method==='POST')return json(await mutateHall(request,env));
      if(request.method!=='GET' && request.method!=='HEAD') return json({error:'Read-only dashboard'},405);
      if(url.pathname.startsWith('/api/quests/'))return json(await questView(request,env));
      if(url.pathname==='/api/me')return json(await sessionView(request,env));
      if(url.pathname==='/api/admin/character-check'){
        requireAdmin(await currentUser(request,env));const result=await probeCharacter(env,url.searchParams.get('character')||'');
        if(!result)throw new WebError('Choose a current guild character',404);return json(result);
      }
      if(url.pathname==='/api/hall')return json(await hallView(request,env));
      if(url.pathname==='/api/history')return json(await historyView(env,url.searchParams.get('character')));
      const crafterMatch=url.pathname.match(/^\/api\/crafters\/(\d{1,10})$/);if(crafterMatch)return json(await crafterView(request,env,Number(crafterMatch[1])));
      if(url.pathname==='/api/admin/presence-capability'){
        const user=await currentUser(request,env);requireAdmin(user);const roster=await api(env,`/data/wow/guild/${SLUG}/roster`),guild=await api(env,`/data/wow/guild/${SLUG}`);
        const keys=[...new Set((roster.members||[]).flatMap(m=>[...Object.keys(m),...Object.keys(m.character||{}).map(k=>'character.'+k)]))].sort();
        const character=user.characters[0],profile=character?await api(env,`/profile/wow/character/${encodeURIComponent(character.slug)}`):{};
        const fields={roster:keys,guild:Object.keys(guild).sort(),character_profile:Object.keys(profile).sort()};
        return json({checked_at:new Date().toISOString(),member_count:roster.members?.length??null,fields,presence_fields:Object.entries(fields).flatMap(([group,list])=>list.filter(k=>/online|presence|logged_in/i.test(k)).map(k=>group+'.'+k)),discord_fields:Object.entries(fields).flatMap(([group,list])=>list.filter(k=>/discord|connection|social/i.test(k)).map(k=>group+'.'+k)),note:'A matching name alone does not verify live in-game semantics. No online/offline inference is made from timestamps.'});
      }
      const recipeMatch=url.pathname.match(/^\/api\/recipe\/(\d{1,10})$/);
      if(recipeMatch){
        let choices={};
        try{choices=JSON.parse(url.searchParams.get('choices')||'{}');}catch{throw new WebError('Invalid component recipe selection');}
        if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).length>100)throw new WebError('Invalid component recipe selection');
        return json(await materialPlan(env,Number(recipeMatch[1]),Number(url.searchParams.get('crafts')||1),choices,url.searchParams.get('expand')!=='0'));
      }
      if(url.pathname==='/api/status'||url.pathname==='/api/admin/status') {
        const admin=url.pathname==='/api/admin/status';if(admin)requireAdmin(await currentUser(request,env));
        const sync=await env.DB.prepare('SELECT phase,cursor,published,status,message,updated,roster_at,completed_at,next_at,total,errors FROM sync WHERE id=1').first();
        sync.membership_revision=await membershipRevision(env);
        const guild=await state(env,'guild')||{name:GUILD,ruleset:RULESET_LABEL};
        const refresh=await refreshView(env);
        if(!admin)return json({guild,sync:{published:sync.published,membership_revision:sync.membership_revision,status:sync.status,updated:sync.updated,roster_at:sync.roster_at,total:sync.total},refresh});
        return json({guild,sync,refresh,scheduler:await state(env,'scheduler'),configured:Boolean(env.BLIZZARD_CLIENT_ID&&env.BLIZZARD_CLIENT_SECRET),
          limits:['Forever endpoints are community documented and may change.',
            'The roster is what Blizzard returned; completeness is not independently verified.',
            'Missing recipe lists mean unknown coverage. Only known_recipes entries establish a crafter.',
            'Talent points are shown as returned. Combat roles are not inferred.'],
          refresh_policy:'Roster checks every '+CONFIG.refresh.rosterSeconds+' seconds; one due character check per minute. Recent or unknown activity gets a full detail check every '+CONFIG.refresh.activeSeconds+' seconds; older activity every '+CONFIG.refresh.inactiveSeconds+' seconds. Activity or level changes trigger earlier checks. Manual refresh requests include professions, recipes and talents. Larger guilds take longer. Blizzard snapshots can lag behind the game, often until after logout.'});
      }
      if(url.pathname==='/api/members') {
        const cursor=Math.max(0,Number.parseInt(url.searchParams.get('cursor')||'0',10)||0);
        const sync=await env.DB.prepare('SELECT published FROM sync WHERE id=1').first();
        const wanted=url.searchParams.get('generation');
        if(wanted && wanted!==sync.published) return json({error:'Roster changed; reload the dashboard'},409);
        const revision=await membershipRevision(env),wantedRevision=url.searchParams.get('revision');
        if(wantedRevision&&wantedRevision!==revision)return json({error:'Verified guild membership changed; reload the dashboard'},409);
        const rows=await env.DB.prepare('SELECT m.data roster,c.data details FROM verified_membership m LEFT JOIN characters c ON c.id=m.character_id WHERE m.generation=? ORDER BY m.slug LIMIT 25 OFFSET ?')
          .bind(sync.published||'',cursor).all();
        const rolePreferences=await currentRolePreferences(env);
        const members=rows.results.map(r=>{
          const roster=JSON.parse(r.roster),details=r.details?JSON.parse(r.details):{};
          return withRolePreferences(mergeMember(roster,details),rolePreferences);
        });
        if(await membershipRevision(env)!==revision)return json({error:'Verified guild membership changed; reload the dashboard'},409);
        return json({generation:sync.published,revision,members,next:members.length===25?cursor+25:null});
      }
      if(url.pathname==='/api/evidence') {
        requireAdmin(await currentUser(request,env));
        const data=await env.DB.prepare('SELECT * FROM evidence ORDER BY attempted DESC LIMIT 150').all();
        return json({endpoints:data.results});
      }
      if(url.pathname.startsWith('/api/')) return json({error:'Not found'},404);
      const destination=request.headers.get('Sec-Fetch-Dest'),html=(guildPaths.has(url.pathname)||/\.html$/i.test(url.pathname))&&(!destination||destination==='document'||destination==='iframe'),user=await currentUser(request,env);
      if(html&&!user)return privateRedirect('/auth/login');
      if(html&&!user.verified)return privateRedirect('/?access=unverified');
      try{requireMember(user);}catch(error){if(error instanceof WebError&&[401,403].includes(error.status))return json({error:error.message,access_required:true},error.status);throw error;}
      return assetResponse(request,env,guildPaths.has(url.pathname)?'/index.html':url.pathname,true);
    } catch(error) { return json({error:error instanceof WebError?error.message:'The dashboard is temporarily unavailable; please try again shortly'},error instanceof WebError?error.status:503); }
}
export default {
  async fetch(request,env){
    const routed=request.method==='HEAD'&&!new URL(request.url).pathname.startsWith('/auth/')?new Request(request,{method:'GET'}):request;
    const response=await handleRequest(routed,env);
    if(request.method!=='HEAD')return response;
    await response.body?.cancel();return new Response(null,{status:response.status,headers:response.headers});
  },
  async scheduled(controller,env,ctx) {
    ctx.waitUntil((async()=>{
      await ensureDeploymentIdentity(env);
      await tick(env);
      await discoverRosterAccounts(env);
      await refreshOneAccount(env);
      const job=await env.DB.prepare('SELECT phase,next_at FROM sync WHERE id=1').first();
      if(job.phase==='roster'&&job.next_at>Math.floor(Date.now()/1000))await hydrateOneRecipe(env);
      await maintain(env);
      await queueEventCleanups(env);
      await queueCraftCleanups(env);
      await flushDiscord(env);
      await pollOneEventPost(env);
      await pollOneCraftPost(env);
      await refreshOneDiscordProfile(env);
      await env.DB.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)')
        .bind('scheduler',JSON.stringify({last_completed:new Date().toISOString(),cron:controller.cron})).run();
    })());
  }
};
