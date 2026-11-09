import {ORIGIN} from './auth.mjs';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true}),PURPOSE='wv-account-refresh-v1',MAX_TOKEN_BYTES=8192;
const epoch=()=>Math.floor(Date.now()/1000);
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
function decode(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw invalid();
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
}
function invalid(){const error=new Error('Saved Battle.net authorization is unavailable');error.name='AccountCredentialError';return error;}
function identity(user){return typeof user?.id==='string'&&user.id.length>0&&user.id.length<=128&&typeof user.subject_hash==='string'&&user.subject_hash.length>0&&user.subject_hash.length<=256;}
function aad(env,user,expires){return encoder.encode(JSON.stringify([PURPOSE,ORIGIN,env.BLIZZARD_CLIENT_ID,user.id,user.subject_hash,expires]));}
async function key(env){
  if(typeof env.BLIZZARD_CLIENT_SECRET!=='string'||!env.BLIZZARD_CLIENT_SECRET||typeof env.BLIZZARD_CLIENT_ID!=='string'||!env.BLIZZARD_CLIENT_ID)throw invalid();
  const material=await crypto.subtle.importKey('raw',encoder.encode(env.BLIZZARD_CLIENT_SECRET),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(PURPOSE+'|'+env.BLIZZARD_CLIENT_ID),info:encoder.encode(PURPOSE+'|'+ORIGIN)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function credentialSaveStatement(env,user,tokens,createdAt){
  const issued=typeof createdAt==='string'?Date.parse(createdAt):NaN,ttl=tokens?.expires_in,token=tokens?.access_token;
  if(!identity(user)||!Number.isFinite(issued)||typeof ttl!=='number'||!Number.isFinite(ttl)||ttl<=0||typeof token!=='string'||!token||encoder.encode(token).length>MAX_TOKEN_BYTES)return null;
  const issuedSeconds=Math.floor(issued/1000),expires=issuedSeconds+Math.min(Math.floor(ttl)-60,86400);
  if(expires<=epoch()||issuedSeconds>epoch()+60)return null;
  const iv=crypto.getRandomValues(new Uint8Array(12));
  let body;try{body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(env,user,expires),tagLength:128},await key(env),encoder.encode(token));}catch{return null;}
  const encrypted=JSON.stringify({v:1,iv:encode(iv),body:encode(new Uint8Array(body))});
  return env.DB.prepare(`INSERT INTO account_refresh(user_id,encrypted_credential,expires_at,next_at,status,checked_at,last_error,lease_token,lease_until,requested_revision,checked_revision)
    VALUES(?,?,?,?,'active',?,NULL,NULL,0,NULL,NULL) ON CONFLICT(user_id) DO UPDATE SET encrypted_credential=excluded.encrypted_credential,
    expires_at=excluded.expires_at,next_at=excluded.next_at,status='active',checked_at=excluded.checked_at,last_error=NULL,lease_token=NULL,lease_until=0,requested_revision=NULL,checked_revision=NULL`)
    .bind(user.id,encrypted,expires,Math.min(issuedSeconds+900,expires),new Date(issued).toISOString());
}
export async function decryptAccountCredential(env,user,row){
  try{
    if(!identity(user)||row.user_id!==user.id||!Number.isSafeInteger(row.expires_at)||row.expires_at<=epoch()||typeof row.encrypted_credential!=='string'||row.encrypted_credential.length>12000)throw invalid();
    const saved=JSON.parse(row.encrypted_credential);if(saved.v!==1)throw invalid();
    const iv=decode(saved.iv),body=decode(saved.body);if(iv.length!==12||body.length<17||body.length>MAX_TOKEN_BYTES+16)throw invalid();
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(env,user,row.expires_at),tagLength:128},await key(env),body),token=decoder.decode(plain);
    if(!token||plain.byteLength>MAX_TOKEN_BYTES)throw invalid();return token;
  }catch{throw invalid();}
}
const iso=value=>Number.isSafeInteger(value)&&value>0?new Date(value*1000).toISOString():null;
export async function accountSyncView(env,user){
  const row=await env.DB.prepare('SELECT expires_at,next_at,status,checked_at,requested_revision,checked_revision,encrypted_credential IS NOT NULL credential_present FROM account_refresh WHERE user_id=?').bind(user.id).first();
  const fallback=iso(user.ownership_checked),checked=typeof row?.checked_at==='string'&&Number.isFinite(Date.parse(row.checked_at))?row.checked_at:fallback;
  const active=Boolean(row?.credential_present&&row.expires_at>epoch()),pause=await env.DB.prepare("SELECT value FROM state WHERE key='blizzard_cooldown'").first();let until=0;try{const value=JSON.parse(pause?.value||'0');if(Number.isSafeInteger(value))until=value;}catch{}
  const pending=Boolean(row?.requested_revision&&row.requested_revision!==row.checked_revision),status=!active?'reconnect_required':pending&&until>epoch()?'paused':pending&&row.status==='unavailable'?'unavailable':'active';
  return {status,checked_at:checked,next_check_at:active&&pending?iso(Math.max(row.next_at,until>epoch()?until:0)):null,expires_at:iso(row?.expires_at)};
}
