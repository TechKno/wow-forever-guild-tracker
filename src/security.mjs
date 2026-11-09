import {PUBLIC_ASSET_PATHS} from './config.mjs';
import {digest,WebError} from './auth.mjs';
const publicStatic=new Set(['/','/index.html','/welcome.html','/welcome.css','/welcome.js',...PUBLIC_ASSET_PATHS,'/privacy.html','/privacy.css','/favicon.ico','/robots.txt','/healthz']);

export async function enforceRate(env,name,key){
  const limiter=env[name];
  if(!limiter?.limit){
    if(env.SECURITY_LIMITS_REQUIRED==='true')throw new WebError('Request protection is temporarily unavailable; please try again shortly',503);
    return;
  }
  let result;try{result=await limiter.limit({key});}catch{throw new WebError('Request protection is temporarily unavailable; please try again shortly',503);}
  if(result?.success===false)throw new WebError('Too many requests; please try again in a minute',429);
  if(result?.success!==true)throw new WebError('Request protection is temporarily unavailable; please try again shortly',503);
}
export async function protectEntry(request,env){
  const path=new URL(request.url).pathname;
  const auth=request.method==='GET'&&['/auth/login','/auth/callback','/auth/discord/login','/auth/discord/install','/auth/discord/callback'].includes(path);
  const api=path==='/api'||path.startsWith('/api/');
  const privateResource=!path.startsWith('/auth/')&&!publicStatic.has(path);
  if(!auth&&!api&&!privateResource)return;
  const key=await digest('wv-request-ip|'+(request.headers.get('CF-Connecting-IP')||'unknown'));
  if(auth)await enforceRate(env,'AUTH_RATE',key);
  if(api||privateResource)await enforceRate(env,'API_RATE',key);
}
export async function protectMember(request,env,user){
  if(!['GET','HEAD'].includes(request.method))await enforceRate(env,'WRITE_RATE',user.id);
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&(/^\/api\/recipe\//.test(path)||/^\/api\/characters\/\d+\/(talents|armory)$/.test(path)||path==='/api/quests/compare'||['/api/admin/character-check','/api/admin/presence-capability'].includes(path)))await enforceRate(env,'LOOKUP_RATE',user.id);
}
