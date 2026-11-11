import {credentialSaveStatement} from './account-credentials.mjs';
import {signInStatements} from './site-analytics.mjs';
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
export async function providerJSON(url,options={}){
  const {timeoutMs=20000,...fetchOptions}=options;
  let response;
  try{response=await fetch(url,{...fetchOptions,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});}catch{throw new WebError('Battle.net could not be reached',502);}
  if(!response.ok){await response.body?.cancel();const error=new WebError('Battle.net did not return the requested account data',502);error.providerStatus=response.status;const retry=Number(response.headers.get('Retry-After'));error.retryAfter=Number.isFinite(retry)&&retry>0?Math.min(3600,Math.ceil(retry)):0;throw error;}
  const text=await response.text();
  if(text.length>2000000)throw new WebError('Battle.net returned too much account data',502);
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}
  catch{throw new WebError('Battle.net account response was not recognised',502);}
}
export async function battleNetIdentity(accessToken) {
  const info = await providerJSON('https://oauth.battle.net/userinfo', {
    headers: {Authorization: 'Bearer '+accessToken}
  });
  const value = info.sub ?? info.id;
  const subject = String(value ?? '');
  if ((typeof value !== 'string' && !Number.isSafeInteger(value)) ||
      !/^\d{1,24}$/.test(subject) ||
      (info.sub !== undefined && info.id !== undefined && String(info.id) !== subject)) {
    throw new WebError('Battle.net did not return a valid account ID', 502);
  }
  const tag = typeof info.battletag === 'string' ? info.battletag.trim() : '';
  const battleTag = tag && tag.length <= 80 && !/\p{Cc}/u.test(tag) ? tag : null;
  return {subject, subjectHash: await digest('https://oauth.battle.net|'+subject), battleTag};
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
export function requireMember(user){if(!user)throw new WebError('Sign in with Battle.net to use the guild hall',401);if(!user.verified)throw new WebError(`Battle.net has not verified a current ${GUILD} character for this account`,403);}
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
export async function prepareAccountSync(env,user,accessToken,{maxProfiles=8,checkedAt=stamp()}={}){
  if(!Number.isSafeInteger(maxProfiles)||maxProfiles<0||maxProfiles>8||!Number.isFinite(Date.parse(checkedAt)))throw new WebError('Invalid account check');
  const created=checkedAt;
  const account=await providerJSON(providerURL('/profile/user/wow'),
    {headers:{Authorization:'Bearer '+accessToken,Accept:'application/json','Cache-Control':'no-cache',Pragma:'no-cache'}});
  if(!Array.isArray(account.wow_accounts)||account.wow_accounts.some(a=>!Array.isArray(a.characters)))throw new WebError('Account character list is not recognised');
  const accountCharacters=account.wow_accounts.flatMap(a=>a.characters);
  const ids=[...new Set(accountCharacters.map(c=>c?.id).filter(id=>Number.isSafeInteger(id)&&id>0))];
  if(ids.length>5000)throw new WebError('The account character list is too large');
  const roster=await env.DB.prepare('SELECT DISTINCT m.character_id,0 departed FROM membership m JOIN sync s ON m.generation=s.published WHERE s.id=1 UNION ALL SELECT character_id,1 departed FROM membership_departures').all();
  const guildIds=new Set(roster.results.filter(c=>!c.departed).map(c=>c.character_id));
  const departedIds=new Set(roster.results.filter(c=>c.departed).map(c=>c.character_id));
  const owned=ids.filter(id=>guildIds.has(id));
  const proofs=[],scannedIds=new Set();
  const scanKey='ownership_scan:'+user.id;
  let scanNext=null;
  const guildRow=await env.DB.prepare("SELECT value FROM state WHERE key='guild'").first();
  let knownGuild;try{knownGuild=guildRow?JSON.parse(guildRow.value):null;}catch{knownGuild=null;}
  if(Number.isSafeInteger(knownGuild?.id)&&knownGuild.id>0&&knownGuild.name===GUILD&&knownGuild.ruleset===RULESET_LABEL){
    const candidates=new Map(),conflicts=new Set();
    for(const character of accountCharacters){
      const candidate=candidateFromAccount(character);if(!candidate||guildIds.has(candidate.id)||departedIds.has(candidate.id))continue;
      if(candidates.has(candidate.id)&&candidates.get(candidate.id).slug!==candidate.slug)conflicts.add(candidate.id);
      else candidates.set(candidate.id,candidate);
    }
    const unknown=[...candidates.values()].filter(c=>!conflicts.has(c.id));
    if(unknown.length){
      const saved=await env.DB.prepare('SELECT value FROM state WHERE key=?').bind(scanKey).first();
      const prior=Number(saved?.value),offset=Number.isSafeInteger(prior)&&prior>=0?prior%unknown.length:0;
      const selected=Array.from({length:Math.min(maxProfiles,unknown.length)},(_,index)=>unknown[(offset+index)%unknown.length]);
      for(const candidate of selected)scannedIds.add(candidate.id);
      scanNext=(offset+selected.length)%unknown.length;
      // No provider href or member-entered character is trusted for discovery.
      // Every candidate came from this sign-in's authenticated account summary.
      for(let index=0;index<selected.length;index+=2){
        const checked=await Promise.all(selected.slice(index,index+2).map(async candidate=>{
          try{
            const profile=await providerJSON(providerURL('/profile/wow/character/'+encodeURIComponent(candidate.slug)),
              {headers:{Authorization:'Bearer '+accessToken,Accept:'application/json','Cache-Control':'no-cache',Pragma:'no-cache'},timeoutMs:10000});
            return validateProfileMember(profile,candidate,knownGuild);
          }catch{return null;}
        }));
        for(const proof of checked)if(proof){proofs.push(proof);owned.push(proof.id);}
      }
    }
  }
  const previous=await env.DB.prepare(`SELECT l.character_id,l.show_as_alt,f.guild_id,f.ruleset,f.checked_at,f.expires FROM character_links l
    LEFT JOIN profile_members f ON f.character_id=l.character_id AND f.user_id=l.user_id WHERE l.user_id=?`).bind(user.id).all();
  const returnedIds=new Set(ids),now=epoch();
  // A bounded discovery pass must not forget a different alt's still-valid
  // guild proof. Ownership must appear in this authenticated account reply;
  // checked candidates, expired proofs and departures cannot be retained.
  for(const prior of previous.results)if(returnedIds.has(prior.character_id)&&!guildIds.has(prior.character_id)&&!departedIds.has(prior.character_id)&&!scannedIds.has(prior.character_id)
    &&prior.guild_id===knownGuild?.id&&knownGuild?.name===GUILD&&knownGuild?.ruleset===RULESET_LABEL&&prior.ruleset===3
    &&prior.checked_at<=now&&prior.expires>now&&prior.expires-prior.checked_at===3600)owned.push(prior.character_id);
  if(owned.length>100)throw new WebError('More than 100 guild characters require review');
  const preferences=new Map(previous.results.map(r=>[r.character_id,r.show_as_alt]));
  const statements=[env.DB.prepare('DELETE FROM profile_members WHERE user_id=? AND character_id NOT IN (SELECT value FROM json_each(?))').bind(user.id,JSON.stringify(owned)),env.DB.prepare('DELETE FROM character_links WHERE user_id=?').bind(user.id)];
  const ownershipAt=Math.floor(Date.parse(created)/1000);
  statements.push(env.DB.prepare('DELETE FROM account_character_ownership WHERE user_id=?').bind(user.id));
  statements.push(env.DB.prepare(`INSERT INTO account_character_ownership(character_id,user_id,checked_at,expires_at)
    SELECT value,?,?,? FROM json_each(?) WHERE 1 ON CONFLICT(character_id) DO UPDATE SET user_id=excluded.user_id,checked_at=excluded.checked_at,expires_at=excluded.expires_at
    WHERE excluded.checked_at>account_character_ownership.checked_at OR (excluded.checked_at=account_character_ownership.checked_at AND excluded.user_id=account_character_ownership.user_id)`)
    .bind(user.id,ownershipAt,ownershipAt+86400,JSON.stringify(ids)));
  statements.push(env.DB.prepare(`INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.alt') FROM json_each(?) WHERE 1 ON CONFLICT(character_id) DO UPDATE SET user_id=excluded.user_id,verified_at=excluded.verified_at,show_as_alt=excluded.show_as_alt`).bind(user.id,created,JSON.stringify(owned.map(id=>({id,alt:preferences.get(id)??1})))));
  for(const proof of proofs)statements.push(profileMemberStatement(env,user.id,proof));
  if(proofs.length)statements.push(env.DB.prepare('INSERT OR IGNORE INTO character_refresh(character_id,next_at) SELECT character_id,0 FROM profile_members WHERE user_id=?').bind(user.id));
  if(scanNext!==null)statements.push(env.DB.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)').bind(scanKey,String(scanNext)));
  statements.push(env.DB.prepare('UPDATE users SET ownership_status=\'verified\',ownership_checked=?,updated_at=? WHERE id=?').bind(epoch(),created,user.id));
  if(!owned.includes(user.main_character_id)&&owned.length)statements.push(env.DB.prepare('UPDATE users SET main_character_id=? WHERE id=?').bind(owned[0],user.id));
  if(proofs.length)statements.push(profileJoinedStatement(env,user.id));
  // Proof, ownership and character links become visible in one atomic commit.
  return {statements,ownedIds:owned,accountCount:account.wow_accounts.length};
}
export async function authRoute(request,env){
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
      const {subject,subjectHash,battleTag}=await battleNetIdentity(tokens.access_token),created=stamp();
      await env.DB.prepare(`INSERT INTO users(id,subject_hash,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(subject_hash) DO UPDATE SET updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(),subjectHash,created,created).run();
      const user=await env.DB.prepare('SELECT * FROM users WHERE subject_hash=?').bind(subjectHash).first();
      let ownershipCommitted=false;
      try{
        await env.DB.prepare('DELETE FROM account_refresh WHERE user_id=?').bind(user.id).run();
        const sync=await prepareAccountSync(env,user,tokens.access_token,{checkedAt:created});
        const credential=sync.ownedIds.length?await credentialSaveStatement(env,user,tokens,created):null;
        const statements=[...sync.statements,...(credential?[credential]:[])];
        await env.DB.batch(statements);
        ownershipCommitted=true;
      }catch{/* Identity may still sign in, but guild access fails closed until ownership is verified. */}
      if(!ownershipCommitted)await env.DB.prepare('UPDATE users SET ownership_status=\'unavailable\',ownership_checked=?,updated_at=? WHERE id=?').bind(epoch(),created,user.id).run();
      const session=random(),csrf=random(),old=cookie(request,'__Host-wv_session');
      const signedInAt=epoch(),sessionWrites=[];
      if(old)sessionWrites.push(env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(old)));
      sessionWrites.push(env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').bind(await digest(session),user.id,csrf,signedInAt+86400));
      await env.DB.batch([...sessionWrites,...signInStatements(env,user.id,signedInAt,subject,battleTag)]);
      // Only a random session cookie leaves the server. A bounded encrypted user token supports account discovery.
      return redirect('/guild#overview',[setCookie('__Host-wv_session',session,86400),setCookie('__Host-wv_login','',0)]);
    }catch{return fail('provider');}
  }
  if(url.pathname==='/auth/logout'&&request.method==='POST'){
    const user=await currentUser(request,env);requireWrite(request,user);
    await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.token_hash),env.DB.prepare('DELETE FROM account_refresh WHERE user_id=?').bind(user.id),env.DB.prepare('DELETE FROM account_character_ownership WHERE user_id=?').bind(user.id)]);
    return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':setCookie('__Host-wv_session','',0)}});
  }
  return null;
}
