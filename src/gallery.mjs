import {currentUser,requireMember,requireWrite,readLimitedText,WebError} from './auth.mjs';

export const GALLERY_LIMITS={max_photos:200,max_bytes:100000000,max_daily_uploads:10,max_image_bytes:750000,max_thumbnail_bytes:60000,max_dimension:1600,max_thumbnail_dimension:400};
const epoch=()=>Math.floor(Date.now()/1000),stamp=()=>new Date().toISOString();
const validId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const cleanName=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80):'';
const membershipSQL=`EXISTS(SELECT 1 FROM sessions gs JOIN users gu ON gu.id=gs.user_id JOIN character_links gl ON gl.user_id=gu.id
  JOIN verified_membership gm ON gm.character_id=gl.character_id AND gm.generation=(SELECT published FROM sync WHERE id=1)
  WHERE gs.token_hash=? AND gs.user_id=? AND gs.expires>? AND gu.ownership_status='verified' AND gu.ownership_checked>?)`;
const membershipParams=user=>[user.token_hash,user.id,epoch(),epoch()-86400];
async function member(request,env,expected=null){const user=await currentUser(request,env);requireMember(user);if(expected&&user.id!==expected.id)throw new WebError('Refresh the page before using the gallery',403);return user;}

// JPEGs are re-encoded by the upload form. Validate bounded frames and remove
// all application/comment segments so uploaded EXIF, GPS and filenames stay out.
export function normalizeGalleryJPEG(input,maxBytes,maxDimension){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input),parts=[];
  const invalid=()=>{throw new WebError('Choose a valid JPEG screenshot using the gallery upload form');};
  if(bytes.length<20||bytes.length>maxBytes||bytes[0]!==255||bytes[1]!==216)invalid();
  parts.push(bytes.subarray(0,2));let offset=2,width=0,height=0,components=0,sawScan=false,ended=false,markers=0;
  while(offset<bytes.length){
    if(++markers>2000||bytes[offset]!==255)invalid();
    const start=offset++;while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];
    if(marker===217){if(!sawScan||!width||offset!==bytes.length)invalid();parts.push(new Uint8Array([255,217]));ended=true;break;}
    if(marker===216||marker===0||marker===1||marker>=208&&marker<=215||offset+2>bytes.length)invalid();
    const length=bytes[offset]*256+bytes[offset+1],end=offset+length;
    if(length<2||end>bytes.length)invalid();
    if(marker===192||marker===194){
      if(width||length<8||bytes[offset+2]!==8)invalid();
      height=bytes[offset+3]*256+bytes[offset+4];width=bytes[offset+5]*256+bytes[offset+6];components=bytes[offset+7];
      if(!width||!height||width>maxDimension||height>maxDimension||![1,3].includes(components)||length!==8+3*components)invalid();
    }else if(marker===218){
      const count=bytes[offset+2];if(!width||count<1||count>components||length!==6+2*count)invalid();sawScan=true;
    }else if(![196,219,221].includes(marker)&&!(marker>=224&&marker<=239)&&marker!==254)invalid();
    if(!(marker>=224&&marker<=239)&&marker!==254)parts.push(bytes.subarray(start,end));
    offset=end;
    if(marker===218){
      const scanStart=offset;
      while(offset<bytes.length){
        if(bytes[offset]!==255){offset++;continue;}
        const next=bytes[offset+1];
        if(next===0||next>=208&&next<=215){offset+=2;continue;}
        break;
      }
      if(offset>=bytes.length)invalid();parts.push(bytes.subarray(scanStart,offset));
    }
  }
  if(!ended)invalid();
  const size=parts.reduce((total,part)=>total+part.length,0),result=new Uint8Array(size);let index=0;
  for(const part of parts){result.set(part,index);index+=part.length;}
  return {bytes:result,width,height};
}
function decode(value,limit){
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(limit/3)*4||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new WebError('Choose an image using the gallery upload form');
  let decoded;try{decoded=atob(value);}catch{throw new WebError('The screenshot could not be read');}
  if(decoded.length>limit)throw new WebError('That screenshot is too large',413);
  return Uint8Array.from(decoded,char=>char.charCodeAt(0));
}
function entry(row,user){return {id:row.id,title:row.title,caption:row.caption,author_name:row.author_name,created_at:row.created_at,width:row.width,height:row.height,
  image_url:`/api/gallery/${row.id}/image`,thumbnail_url:`/api/gallery/${row.id}/thumbnail`,can_manage:row.author_id===user.id||user.is_admin,removed:Boolean(row.removed_at)};}
async function authorName(env,user){
  let guild=env.DISCORD_GUILD_ID||'';
  if(!guild){const saved=await env.DB.prepare("SELECT value FROM state WHERE key='discord_config'").first();try{guild=JSON.parse(saved?.value||'{}').guild_id||'';}catch{}}
  const profile=guild?await env.DB.prepare(`SELECT p.nickname,p.global_name,p.username FROM discord_links l JOIN discord_profiles p ON p.discord_id=l.discord_id AND p.guild_id=? WHERE l.user_id=?`).bind(guild,user.id).first():null;
  return cleanName(profile?.nickname)||cleanName(profile?.global_name)||cleanName(profile?.username)||cleanName(user.characters.find(character=>character.id===user.main_character_id)?.name)||cleanName(user.characters[0]?.name)||'Guild member';
}
async function usage(env,user){return await env.DB.prepare(`SELECT COUNT(*) photos,COALESCE(SUM(byte_size),0) bytes,
  COALESCE(SUM(CASE WHEN author_id=? AND created_at>=? THEN 1 ELSE 0 END),0) daily FROM gallery_photos`).bind(user.id,stamp().slice(0,10)+'T00:00:00.000Z').first();}
async function list(request,env,user,url){
  const mine=url.searchParams.get('mine')==='1',removed=url.searchParams.get('removed')==='1',cursor=url.searchParams.get('cursor');
  if(cursor&&!validId(cursor))throw new WebError('Reload the gallery to continue');
  const conditions=[removed?'removed_at IS NOT NULL':'removed_at IS NULL'],params=[];
  if(mine||removed&&!user.is_admin){conditions.push('author_id=?');params.push(user.id);}
  const filter=conditions.join(' AND ');let boundary=null;
  if(cursor){boundary=await env.DB.prepare(`SELECT id,created_at FROM gallery_photos WHERE id=? AND ${filter}`).bind(cursor,...params).first();if(!boundary)throw new WebError('The gallery changed. Reload to continue',409);}
  const rows=await env.DB.prepare(`SELECT id,author_id,author_name,title,caption,created_at,width,height,removed_at FROM gallery_photos WHERE ${filter}${boundary?' AND (created_at<? OR (created_at=? AND id<?))':''} ORDER BY created_at DESC,id DESC LIMIT 21`)
    .bind(...params,...(boundary?[boundary.created_at,boundary.created_at,boundary.id]:[])).all();
  const used=await usage(env,user);await member(request,env,user);
  return {items:rows.results.slice(0,20).map(row=>entry(row,user)),next:rows.results.length>20?rows.results[19].id:null,limits:{...GALLERY_LIMITS},can_upload:used.photos<GALLERY_LIMITS.max_photos&&used.bytes<GALLERY_LIMITS.max_bytes&&used.daily<GALLERY_LIMITS.max_daily_uploads};
}
async function upload(request,env,user){
  requireWrite(request,user);const raw=await readLimitedText(request,1500000,'The screenshot upload is too large');let body;
  try{body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw 0;}catch{throw new WebError('The screenshot upload was not recognised');}
  if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>80||/[\u0000-\u001f\u007f]/.test(body.title)||typeof body.caption!=='string'||body.caption.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.caption))throw new WebError('Use a title of 1–80 characters and a caption of up to 500 characters');
  const image=normalizeGalleryJPEG(decode(body.image_base64,GALLERY_LIMITS.max_image_bytes),GALLERY_LIMITS.max_image_bytes,GALLERY_LIMITS.max_dimension),thumbnail=normalizeGalleryJPEG(decode(body.thumbnail_base64,GALLERY_LIMITS.max_thumbnail_bytes),GALLERY_LIMITS.max_thumbnail_bytes,GALLERY_LIMITS.max_thumbnail_dimension);
  const name=await authorName(env,user);user=await member(request,env,user);requireWrite(request,user);
  const id=crypto.randomUUID(),at=stamp(),size=image.bytes.length+thumbnail.bytes.length;
  const inserted=await env.DB.prepare(`INSERT INTO gallery_photos(id,author_id,author_name,title,caption,created_at,width,height,image,thumbnail,byte_size)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${membershipSQL}
    AND (SELECT COUNT(*) FROM gallery_photos)<? AND (SELECT COALESCE(SUM(byte_size),0) FROM gallery_photos)+?<=?
    AND (SELECT COUNT(*) FROM gallery_photos WHERE author_id=? AND created_at>=?)<? RETURNING id`)
    .bind(id,user.id,name,body.title.trim(),body.caption.trim(),at,image.width,image.height,image.bytes.buffer,thumbnail.bytes.buffer,size,...membershipParams(user),GALLERY_LIMITS.max_photos,size,GALLERY_LIMITS.max_bytes,user.id,at.slice(0,10)+'T00:00:00.000Z',GALLERY_LIMITS.max_daily_uploads).first();
  if(!inserted){await member(request,env,user);const used=await usage(env,user);throw new WebError(used.daily>=GALLERY_LIMITS.max_daily_uploads?'You can share up to 10 screenshots each day. Try again tomorrow.':'The gallery has reached its storage limit. Ask the administrator for help.',429);}
  await member(request,env,user);
  return {ok:true,item:entry({id,author_id:user.id,author_name:name,title:body.title.trim(),caption:body.caption.trim(),created_at:at,width:image.width,height:image.height,removed_at:null},user)};
}
async function change(request,env,user,id,removed){
  requireWrite(request,user);await readLimitedText(request,1000,'The gallery request is too large');user=await member(request,env,user);requireWrite(request,user);
  const changed=await env.DB.prepare(`UPDATE gallery_photos SET removed_at=? WHERE id=? AND (author_id=? OR ?=1) AND ${membershipSQL} RETURNING id`)
    .bind(removed?stamp():null,id,user.id,user.is_admin?1:0,...membershipParams(user)).first();
  if(!changed){await member(request,env,user);throw new WebError('Screenshot not found or you cannot manage it',404);}
  await member(request,env,user);return {ok:true,id,removed};
}
async function image(request,env,user,id,thumbnail){
  const row=await env.DB.prepare(`SELECT ${thumbnail?'thumbnail':'image'} bytes FROM gallery_photos WHERE id=? AND removed_at IS NULL`).bind(id).first();
  if(!row)throw new WebError('Screenshot not found',404);
  const bytes=row.bytes instanceof Uint8Array?row.bytes:new Uint8Array(row.bytes);
  if(!bytes.length||bytes.length>(thumbnail?GALLERY_LIMITS.max_thumbnail_bytes:GALLERY_LIMITS.max_image_bytes))throw new WebError('Screenshot is unavailable',404);
  await member(request,env,user);
  if(!await env.DB.prepare('SELECT id FROM gallery_photos WHERE id=? AND removed_at IS NULL').bind(id).first())throw new WebError('Screenshot not found',404);
  return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length),'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff','Content-Disposition':'inline; filename="guild-screenshot.jpg"'}});
}
export async function galleryRoute(request,env){
  const url=new URL(request.url),user=await member(request,env);
  if(url.pathname==='/api/gallery'){
    if(request.method==='GET')return list(request,env,user,url);
    if(request.method==='POST')return upload(request,env,user);
    throw new WebError('Gallery method not allowed',405);
  }
  const match=url.pathname.match(/^\/api\/gallery\/([^/]+)\/(image|thumbnail|remove|restore)$/);
  if(!match||!validId(match[1]))throw new WebError('Screenshot not found',404);
  if(['image','thumbnail'].includes(match[2])){
    if(request.method!=='GET')throw new WebError('Gallery method not allowed',405);
    return image(request,env,user,match[1],match[2]==='thumbnail');
  }
  if(request.method!=='POST')throw new WebError('Gallery method not allowed',405);
  return change(request,env,user,match[1],match[2]==='remove');
}
