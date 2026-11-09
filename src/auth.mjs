import {mergeMember,GUILD} from './logic.mjs';
import {candidateFromAccount,validateProfileMember,profileMemberStatement} from './guild-membership.mjs';
import {profileJoinedStatement} from './roster-progress.mjs';
import {ORIGIN,LEGACY_ORIGIN,CALLBACK,isSiteOrigin,RULESET_LABEL,providerURL,ensureDeploymentIdentity} from './config.mjs';
export {ORIGIN,LEGACY_ORIGIN,CALLBACK,isSiteOrigin};
const encoder=new TextEncoder();
const epoch=()=>Math.floor(Date.now()/1000);
export const stamp=()=>new Date().toISOString();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value){return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
export class WebError extends Error{constructor(message,status=400){super(message);this.status=status;}}
export function cookie(request,name){
  const part=(request.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='));
  return part?part.slice(name.length+1):'';
}
const setCookie=(name,value,seconds)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
function redirect(location,cookies=[]){
  const headers=new Headers({'Location':location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
  for(const item of cookies)headers.append('Set-Cookie',item);
  return new Response(null,{status:303,headers});
}
async function providerJSON(url,options={}){
  const {timeoutMs=20000,...fetchOptions}=options;
  let response;
  try{response=await fetch(url,{...fetchOptions,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});}catch{throw new WebError('Battle.net could not be reached',502);}
  if(!response.ok){await response.body?.cancel();throw new WebError('Battle.net did not return the requested account data',502);}
  const text=await response.text();
  if(text.length>2000000)throw new WebError('Battle.net returned too much account data',502);
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}
  catch{throw new WebError('Battle.net account response was not recognised',502);}
}
export async function linkedCharacters(env,userId){
  const result=await env.DB.prepare(`SELECT m.data,c.data details,l.show_as_alt FROM character_links l JOIN verified_membership m ON m.character_id=l.character_id
    JOIN sync s ON m.generation=s.published LEFT JOIN characters c ON c.id=m.character_id WHERE s.id=1 AND l.user_id=? ORDER BY m.slug`).bind(userId).all();
  return result.results.map(row=>{const roster=JSON.parse(row.data),view=mergeMember(roster,row.details?JSON.parse(row.details):{});return {...roster,level:view.level,level_source:view.level_source,level_observed_at:view.level_observed_at,show_as_alt:Boolean(row.show_as_alt)};});
}
export async function currentUser(request,env){
  const raw=cookie(request,'__Host-wv_session');
  if(!/^[A-Za-z0-9_-]{43}$/.test(raw))return null;
  const row=await env.DB.prepare(`SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?`)
    .bind(await digest(raw),epoch()).first();
  if(!row)return null;
  await ensureDeploymentIdentity(env);
  const characters=await linkedCharacters(env,row.id);
  const verified=row.ownership_status==='verified'&&row.ownership_checked>epoch()-86400&&characters.length>0;
  return {...row,characters,verified,is_admin:(env.ADMIN_USER_IDS||'').split(',').map(v=>v.trim()).filter(Boolean).includes(row.id)};
}
export function requireAdmin(user){if(!user)throw new WebError('Sign in first',401);if(!user.is_admin)throw new WebError('Administrator access is required',403);}
export function requireMember(user){if(!user)throw new WebError('Sign in with Battle.net to use the guild hall',401);if(!user.verified)throw new WebError('Battle.net has not verified a current '+GUILD+' character for this account',403);}
export function requireWrite(request,user){
  if(!user)throw new WebError('Sign in first',401);
  const origin=new URL(request.url).origin;
  if(!isSiteOrigin(origin)||request.headers.get('Origin')!==origin||request.headers.get('X-CSRF-Token')!==user.csrf)throw new WebError('Refresh the page before saving',403);
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new WebError('Expected a JSON request',415);
}
export async function readLimitedText(request,limit=8192,message='That entry is too long'){
  if(Number(request.headers.get('Content-Length'))>limit){
    await request.body?.cancel().catch(()=>{});throw new WebError(message,413);
  }
  if(!request.body)return '';
  const reader=request.body.getReader(),decoder=new TextDecoder();let size=0,text='';
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel().catch(()=>{});throw new WebError(message,413);}
      text+=decoder.decode(value,{stream:true});
    }
    return text+decoder.decode();
  }finally{reader.releaseLock();}
}
export async function bodyJSON(request){
  const text=await readLimitedText(request);
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw new WebError('Invalid form data');}
}
export function ownCharacter(user,id){
  const char=user.characters.find(c=>c.id===Number(id));
  if(!char)throw new WebError('Choose one of your verified guild characters',403);
  return char;
}
export async function authRoute(request,env){
  await ensureDeploymentIdentity(env);
  const url=new URL(request.url);
  if(url.pathname==='/auth/login'&&request.method==='GET'){
    if(!env.BLIZZARD_CLIENT_ID||!env.BLIZZARD_CLIENT_SECRET)throw new WebError('Battle.net sign-in is not configured',503);
    if(!isSiteOrigin(url.origin))throw new WebError('Use the live guild dashboard to sign in',400);
    const state=random(),binding=random(),verifier=random();
    await env.DB.prepare('INSERT INTO oauth_states(state_hash,binding_hash,verifier,expires,origin) VALUES(?,?,?,?,?)')
      .bind(await digest(state),await digest(binding),verifier,epoch()+600,url.origin).run();
    const target=new URL('https://oauth.battle.net/authorize');
    target.search=new URLSearchParams({response_type:'code',client_id:env.BLIZZARD_CLIENT_ID,redirect_uri:url.origin+'/auth/callback',
      scope:'openid wow.profile',state,code_challenge:await digest(verifier),code_challenge_method:'S256'}).toString();
    return redirect(target.toString(),[setCookie('__Host-wv_login',binding,600)]);
  }
  if(url.pathname==='/auth/callback'&&request.method==='GET'){
    const fail=code=>redirect('/?signin='+code,[setCookie('__Host-wv_login','',0)]);
    if(!isSiteOrigin(url.origin))return fail('invalid_state');
    const rawState=url.searchParams.get('state')||'',binding=cookie(request,'__Host-wv_login');
    if(!/^[A-Za-z0-9_-]{43}$/.test(rawState)||!/^[A-Za-z0-9_-]{43}$/.test(binding))return fail('invalid_state');
    const pending=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? AND binding_hash=? AND expires>? AND COALESCE(origin,?)=? RETURNING *')
      .bind(await digest(rawState),await digest(binding),epoch(),LEGACY_ORIGIN,url.origin).first();
    if(!pending)return fail('expired');
    if(url.searchParams.has('error'))return fail('cancelled');
    const code=url.searchParams.get('code');if(!code||code.length>2048)return fail('invalid_code');
    try{
      const tokens=await providerJSON('https://oauth.battle.net/token',{method:'POST',headers:{
        Authorization:'Basic '+btoa(env.BLIZZARD_CLIENT_ID+':'+env.BLIZZARD_CLIENT_SECRET),'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:(pending.origin||LEGACY_ORIGIN)+'/auth/callback',code_verifier:pending.verifier}).toString()});
      if(typeof tokens.access_token!=='string')return fail('provider');
      const info=await providerJSON('https://oauth.battle.net/userinfo',{headers:{Authorization:'Bearer '+tokens.access_token}});
      const subject=String(info.sub??info.id??'');if(!/^\d{1,24}$/.test(subject))return fail('provider');
      if(info.sub!==undefined&&info.id!==undefined&&String(info.sub)!==String(info.id))return fail('provider');
      const subjectHash=await digest('https://oauth.battle.net|'+subject),created=stamp();
      await env.DB.prepare(`INSERT INTO users(id,subject_hash,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(subject_hash) DO UPDATE SET updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(),subjectHash,created,created).run();
      const user=await env.DB.prepare('SELECT * FROM users WHERE subject_hash=?').bind(subjectHash).first();
      let ownershipCommitted=false;
      try{
        const account=await providerJSON(providerURL('/profile/user/wow'),
          {headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json'}});
        if(!Array.isArray(account.wow_accounts)||account.wow_accounts.some(a=>!Array.isArray(a.characters)))throw new WebError('Account character list is not recognised');
        const accountCharacters=account.wow_accounts.flatMap(a=>a.characters);
        const ids=[...new Set(accountCharacters.map(c=>c?.id).filter(id=>Number.isSafeInteger(id)&&id>0))];
        const roster=await env.DB.prepare('SELECT DISTINCT m.character_id FROM membership m JOIN sync s ON m.generation=s.published WHERE s.id=1').all();
        const guildIds=new Set(roster.results.map(c=>c.character_id));
        const owned=ids.filter(id=>guildIds.has(id));
        const proofs=[];
        const scanKey='ownership_scan:'+user.id;
        let scanNext=null;
        const guildRow=await env.DB.prepare("SELECT value FROM state WHERE key='guild'").first();
        let knownGuild;try{knownGuild=guildRow?JSON.parse(guildRow.value):null;}catch{knownGuild=null;}
        if(Number.isSafeInteger(knownGuild?.id)&&knownGuild.id>0&&knownGuild.name===GUILD&&knownGuild.ruleset===RULESET_LABEL){
          const candidates=new Map(),conflicts=new Set();
          for(const character of accountCharacters){
            const candidate=candidateFromAccount(character);if(!candidate||guildIds.has(candidate.id))continue;
            if(candidates.has(candidate.id)&&candidates.get(candidate.id).slug!==candidate.slug)conflicts.add(candidate.id);
            else candidates.set(candidate.id,candidate);
          }
          const unknown=[...candidates.values()].filter(c=>!conflicts.has(c.id));
          if(unknown.length){
            const saved=await env.DB.prepare('SELECT value FROM state WHERE key=?').bind(scanKey).first();
            const prior=Number(saved?.value),offset=Number.isSafeInteger(prior)&&prior>=0?prior%unknown.length:0;
            const selected=Array.from({length:Math.min(8,unknown.length)},(_,index)=>unknown[(offset+index)%unknown.length]);
            scanNext=(offset+selected.length)%unknown.length;
            // No provider href or member-entered character is trusted for discovery.
            // Every candidate came from this sign-in's authenticated account summary.
            for(let index=0;index<selected.length;index+=2){
              const checked=await Promise.all(selected.slice(index,index+2).map(async candidate=>{
                try{
                  const profile=await providerJSON(providerURL('/profile/wow/character/'+encodeURIComponent(candidate.slug)),
                    {headers:{Authorization:'Bearer '+tokens.access_token,Accept:'application/json','Cache-Control':'no-cache',Pragma:'no-cache'},timeoutMs:10000});
                  return validateProfileMember(profile,candidate,knownGuild);
                }catch{return null;}
              }));
              for(const proof of checked)if(proof){proofs.push(proof);owned.push(proof.id);}
            }
          }
        }
        if(owned.length>23)throw new WebError('More than 23 guild characters require review');
        const previous=await env.DB.prepare('SELECT character_id,show_as_alt FROM character_links WHERE user_id=?').bind(user.id).all();
        const preferences=new Map(previous.results.map(r=>[r.character_id,r.show_as_alt]));
        const statements=[env.DB.prepare('DELETE FROM profile_members WHERE user_id=?').bind(user.id),env.DB.prepare('DELETE FROM character_links WHERE user_id=?').bind(user.id)];
        for(const id of owned)statements.push(env.DB.prepare(`INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET user_id=excluded.user_id,verified_at=excluded.verified_at,show_as_alt=excluded.show_as_alt`).bind(id,user.id,created,preferences.get(id)??1));
        for(const proof of proofs)statements.push(profileMemberStatement(env,user.id,proof));
        if(proofs.length)statements.push(env.DB.prepare('INSERT OR IGNORE INTO character_refresh(character_id,next_at) SELECT character_id,0 FROM profile_members WHERE user_id=?').bind(user.id));
        if(scanNext!==null)statements.push(env.DB.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)').bind(scanKey,String(scanNext)));
        statements.push(env.DB.prepare('UPDATE users SET ownership_status=\'verified\',ownership_checked=?,updated_at=? WHERE id=?').bind(epoch(),created,user.id));
        if(!owned.includes(user.main_character_id)&&owned.length)statements.push(env.DB.prepare('UPDATE users SET main_character_id=? WHERE id=?').bind(owned[0],user.id));
        if(proofs.length)statements.push(profileJoinedStatement(env,user.id));
        // Proof, ownership and character links become visible in one atomic commit.
        await env.DB.batch(statements);
        ownershipCommitted=true;
      }catch{/* Identity may still sign in, but guild access fails closed until ownership is verified. */}
      if(!ownershipCommitted)await env.DB.prepare('UPDATE users SET ownership_status=\'unavailable\',ownership_checked=?,updated_at=? WHERE id=?').bind(epoch(),created,user.id).run();
      const session=random(),csrf=random(),old=cookie(request,'__Host-wv_session');
      if(old)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(old)).run();
      await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await digest(session),user.id,csrf,epoch()+86400).run();
      // Only a random session cookie leaves the server. Provider tokens are discarded.
      return redirect('/guild#overview',[setCookie('__Host-wv_session',session,86400),setCookie('__Host-wv_login','',0)]);
    }catch{return fail('provider');}
  }
  if(url.pathname==='/auth/logout'&&request.method==='POST'){
    const user=await currentUser(request,env);requireWrite(request,user);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.token_hash).run();
    return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':setCookie('__Host-wv_session','',0)}});
  }
  return null;
}
