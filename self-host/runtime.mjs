import {createServer} from 'node:http';
import {isIP} from 'node:net';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,relative,sep,join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const secretNames=['BLIZZARD_CLIENT_ID','BLIZZARD_CLIENT_SECRET','DISCORD_BOT_TOKEN','DISCORD_CLIENT_SECRET','ADMIN_USER_IDS'];
const publicNames=['DISCORD_CLIENT_ID','DISCORD_GUILD_ID','DISCORD_EVENTS_CHANNEL_ID','DISCORD_CRAFT_REQUESTS_CHANNEL_ID'];
export function loadRuntimeSecrets(settings,dataDirectory){
  const result={};
  for(const name of secretNames){
    const direct=settings[name]?.trim()||'',file=settings[name+'_FILE']?.trim()||(name==='ADMIN_USER_IDS'?join(dataDirectory,'admin-user-ids'):'');
    if(direct&&settings[name+'_FILE'])throw Error('Choose a credential value or its file, not both.');
    if(direct){if(direct.length>65536)throw Error('A credential exceeds the supported size');result[name]=direct;continue;}
    if(file){
      try{const stat=lstatSync(file);if(!stat.isFile()||stat.size>65536)throw Error('Invalid credential file');result[name]=readFileSync(file,'utf8').trim();}
      catch(error){if(name==='ADMIN_USER_IDS'&&!settings.ADMIN_USER_IDS_FILE&&error.code==='ENOENT'){result[name]='';continue;}throw Error('A configured credential file could not be read; no value was printed.');}
    }
  }
  for(const name of publicNames)if(settings[name])result[name]=String(settings[name]).trim();
  return result;
}

export function createLimiter(limit,{periodMs=60000,maxKeys=5000,now=Date.now}={}){
  const keys=new Map();
  return {async limit({key}){
    if(typeof key!=='string'||!key||key.length>256)return {success:false};
    const time=now(),existing=keys.get(key);
    if(existing&&existing.expires>time){existing.count++;return {success:existing.count<=limit};}
    for(const [id,value]of keys)if(value.expires<=time)keys.delete(id);
    if(keys.size>=maxKeys)return {success:false};
    keys.set(key,{count:1,expires:time+periodMs});return {success:true};
  }};
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
export function createAssets(directory){
  const root=realpathSync(directory);
  return {async fetch(request){
    if(!['GET','HEAD'].includes(request.method))return new Response('Read-only assets',{status:405});
    let path;
    try{path=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Not found',{status:404});}
    if(path==='/'||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>part.startsWith('.'))||path.includes(':'))return new Response('Not found',{status:404});
    const target=resolve(root,'.'+path),within=relative(root,target);
    if(!within||within.startsWith('..'+sep)||within==='..'||resolve(target)===root)return new Response('Not found',{status:404});
    try{
      let current=root;
      for(const part of within.split(sep)){current=join(current,part);if(lstatSync(current).isSymbolicLink())return new Response('Not found',{status:404});}
      const resolved=realpathSync(target),inside=relative(root,resolved),stat=lstatSync(resolved);
      if(inside.startsWith('..'+sep)||inside==='..'||!stat.isFile()||stat.size>10000000)return new Response('Not found',{status:404});
      const extension=resolved.slice(resolved.lastIndexOf('.')).toLowerCase(),headers={'Content-Type':mime[extension]||'application/octet-stream','Content-Length':String(stat.size)};
      return new Response(request.method==='HEAD'?null:readFileSync(resolved),{headers});
    }catch{return new Response('Not found',{status:404});}
  }};
}

const peerIP=value=>String(value||'').replace(/^::ffff:/,'');
export function requestClientIP(request,trustedProxies){
  const peer=peerIP(request.socket.remoteAddress),forwarded=request.headers['x-guild-client-ip'];
  return trustedProxies.has(peer)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:peer||'unknown';
}
function readBody(request,limit){
  return new Promise((resolveBody,reject)=>{
    const length=Number(request.headers['content-length']);
    if(Number.isFinite(length)&&length>limit){request.pause();reject(Object.assign(Error('Request too large'),{status:413}));return;}
    const parts=[];let size=0;
    const clean=()=>{request.off('data',data);request.off('end',end);request.off('error',error);request.off('aborted',aborted);};
    const data=chunk=>{size+=chunk.length;if(size>limit){clean();request.pause();reject(Object.assign(Error('Request too large'),{status:413}));}else parts.push(chunk);};
    const end=()=>{clean();resolveBody(size?Buffer.concat(parts,size):undefined);};
    const error=()=>{clean();reject(Error('Request could not be read'));};
    const aborted=()=>{clean();reject(Error('Request was interrupted'));};
    request.on('data',data);request.once('end',end);request.once('error',error);request.once('aborted',aborted);
  });
}
export function createScheduledRunner(worker,env,{onError=()=>{}}={}){
  let current=null,timer;
  async function run(){
    if(current)return {skipped:true};
    current=(async()=>{
      const pending=[],context={waitUntil(value){const task=Promise.resolve(value);task.catch(()=>{});pending.push(task);}};
      await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},env,context);
      await Promise.all(pending);return {skipped:false};
    })();
    try{return await current;}finally{current=null;}
  }
  return {run,start(){if(timer)return;timer=setInterval(()=>run().catch(()=>onError('Scheduled refresh failed.')),60000);timer.unref();run().catch(()=>onError('Scheduled refresh failed.'));},async stop(){clearInterval(timer);timer=null;await current?.catch(()=>{});}};
}
export function createRuntime({worker,DB,publicDirectory,origins,secrets={},trustedProxyAddresses=[]}){
  const known=new Map(origins.map(origin=>{const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Self-hosting requires exact HTTPS origins');return [url.host.toLowerCase(),url.origin];}));
  const trustedProxies=new Set(trustedProxyAddresses.map(peerIP));
  if([...trustedProxies].some(value=>!isIP(value)))throw Error('Trusted proxies must be explicit IP addresses');
  const env={...secrets,DB,ASSETS:createAssets(publicDirectory),SECURITY_LIMITS_REQUIRED:'true',AUTH_RATE:createLimiter(10),API_RATE:createLimiter(180),WRITE_RATE:createLimiter(20),LOOKUP_RATE:createLimiter(30)};
  const server=createServer({maxHeaderSize:16384},async(request,response)=>{
    request.on('error',()=>{});
    try{
      const origin=known.get(String(request.headers.host||'').toLowerCase());
      if(!origin||typeof request.url!=='string'||!request.url.startsWith('/')||request.url.startsWith('//')){response.writeHead(400,{'Content-Type':'text/plain','Connection':'close'});response.end('Invalid request');return;}
      const body=await readBody(request,65536),headers=new Headers();
      for(const [name,value]of Object.entries(request.headers)){
        if(value===undefined||['host','connection','transfer-encoding','cf-connecting-ip','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-guild-client-ip'].includes(name))continue;
        if(Array.isArray(value))for(const item of value)headers.append(name,item);else headers.set(name,value);
      }
      headers.set('CF-Connecting-IP',requestClientIP(request,trustedProxies));
      const context={waitUntil(value){Promise.resolve(value).catch(()=>{});}},method=request.method||'GET';
      const input=new Request(origin+request.url,{method,headers,...(!['GET','HEAD'].includes(method)&&body?{body}:{} )});
      const result=await worker.fetch(input,env,context);
      response.statusCode=result.status;
      for(const [name,value]of result.headers)if(!['set-cookie','connection','transfer-encoding'].includes(name))response.setHeader(name,value);
      const cookies=result.headers.getSetCookie();if(cookies.length)response.setHeader('Set-Cookie',cookies);
      if(method==='HEAD'||!result.body){response.end();return;}
      await pipeline(Readable.fromWeb(result.body),response);
    }catch(error){
      if(!response.headersSent){response.writeHead(error.status===413?413:500,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Connection':'close'});response.end(error.status===413?'Request too large':'Request could not be completed');}
      else response.destroy();
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  return {env,server,scheduler:createScheduledRunner(worker,env,{onError:message=>console.error(message)})};
}
