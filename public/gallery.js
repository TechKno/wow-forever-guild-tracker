(()=>{
  'use strict';
  const host=document.getElementById('gallery-content');if(!host)return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=value=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Date unavailable';};
  const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
  const safeImage=(item,kind)=>safeId(item?.id)&&item[kind+'_url']===`/api/gallery/${item.id}/${kind}`?item[kind+'_url']:null;
  let auth=null,generation=0,sequence=0,fileSequence=0,wanted=false,mode='all',items=[],next=null,loading=false,busy=false,preparing=false,loaded=false,canUpload=true,notice='',noticeError=false,pendingRemoval=null;
  let draft={title:'',caption:'',image:null,filename:''};
  const accountStill=(epoch,account)=>Boolean(auth&&generation===epoch&&auth.user_id===account);
  function closeLightbox(){const dialog=host.querySelector('[data-gallery-lightbox]');if(dialog?.open)dialog.close();}
  function gate(){host.innerHTML='<div class="panel gallery-gate"><span class="eyebrow gold">MEMORIES FOR THE COMPANY</span><h3>The guild gallery</h3><p>Sign in with a current guild character to see and share guild screenshots.</p><a class="button primary" href="/auth/login">Sign in with Battle.net</a></div>';}
  function reset(){closeLightbox();auth=null;generation++;sequence++;fileSequence++;wanted=false;mode='all';items=[];next=null;loading=false;busy=false;preparing=false;loaded=false;pendingRemoval=null;notice='';noticeError=false;canUpload=true;draft={title:'',caption:'',image:null,filename:''};gate();}
  function feedback(message,error=false){notice=message;noticeError=error;const node=host.querySelector('[data-gallery-feedback]');if(node){node.hidden=!message;node.textContent=message;node.classList.toggle('gallery-error',error);}}
  function card(item){
    const image=safeImage(item,'image'),thumb=safeImage(item,'thumbnail');if(!image||!thumb)return '';
    const removed=item.removed===true,manage=item.can_manage===true;
    return `<article class="gallery-card${removed?' gallery-card-removed':''}">${removed?'<div class="gallery-removed-image" aria-hidden="true">◇<span>Removed from gallery</span></div>':`<button class="gallery-photo-open" type="button" data-gallery-action="open" data-gallery-id="${item.id}" aria-label="View ${esc(item.title||'guild screenshot')}"><img src="${esc(thumb)}" alt="${esc(item.title||'Guild screenshot')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span>View screenshot <span aria-hidden="true">↗</span></span></button>`}<div class="gallery-card-copy"><h3>${esc(item.title||'Guild memory')}</h3>${item.caption?`<p class="gallery-caption">${esc(item.caption)}</p>`:''}<p class="gallery-attribution">Shared by ${esc(item.author_name||'Guild member')}<time datetime="${esc(item.created_at||'')}">${esc(time(item.created_at))}</time></p>${manage?`<div class="gallery-manage">${removed?`<button class="text-button" type="button" data-gallery-action="restore" data-gallery-id="${item.id}" ${busy?'disabled':''}>Restore photo</button>`:pendingRemoval===item.id?`<p>Remove this photo from the gallery? You can restore it later.</p><div><button class="button secondary" type="button" data-gallery-action="confirm-remove" data-gallery-id="${item.id}" ${busy?'disabled':''}>Remove photo</button><button class="text-button" type="button" data-gallery-action="cancel-remove" ${busy?'disabled':''}>Keep photo</button></div>`:`<button class="text-button" type="button" data-gallery-action="remove" data-gallery-id="${item.id}" ${busy?'disabled':''}>Remove from gallery</button>`}</div>`:''}</div></article>`;
  }
  function render(){
    if(!auth){gate();return;}
    closeLightbox();
    const active=mode==='all'?'All photos':mode==='mine'?'My uploads':'Removed';
    host.innerHTML=`<div class="gallery-intro panel"><div><span class="eyebrow gold">A PICTURE WORTH A THOUSAND MISSPELLINGS</span><h3>Our shared adventures</h3><p>Victories, misadventures and the moments in between. Screenshots here are visible to signed-in guild members.</p></div><span class="gallery-intro-mark" aria-hidden="true">✦</span></div><p class="gallery-feedback${noticeError?' gallery-error':''}" data-gallery-feedback role="status" aria-live="polite" ${notice?'':'hidden'}>${esc(notice)}</p><div class="gallery-layout"><div class="gallery-browse"><div class="gallery-toolbar"><div class="gallery-filters" role="group" aria-label="Gallery view">${[['all','All photos'],['mine','My uploads'],['removed','Removed']].map(([key,label])=>`<button type="button" data-gallery-action="filter" data-gallery-mode="${key}" aria-pressed="${mode===key}" ${busy?'disabled':''}>${label}</button>`).join('')}</div><button class="button secondary gallery-compose" data-gallery-action="compose" type="button">Share a screenshot</button><button class="text-button" data-gallery-action="refresh" type="button" ${loading||busy?'disabled':''}>Refresh gallery</button></div><p class="gallery-view-note subtle">${mode==='removed'?(auth.is_admin?'Removed photos are hidden from the gallery. You can restore your own photos or moderate the guild’s uploads.':'Your removed photos stay private and can be restored here.'):'Share the adventure. Please only upload screenshots you have permission to share.'}</p><div class="gallery-grid" aria-label="${active}" aria-busy="${loading}">${items.map(card).join('')}</div>${!items.length?`<div class="gallery-empty panel"><span aria-hidden="true">${loading?'✦':'◇'}</span><h3>${loading?'Opening the memory book…':mode==='removed'?'Nothing tucked away':mode==='mine'?'Your first memory awaits':'A fresh page in our story'}</h3><p>${loading?'Loading the guild’s shared screenshots.':mode==='removed'?'Photos you remove will appear here so they can be restored.':mode==='mine'?'Share a screenshot and it will appear here.':'Share the first screenshot from a guild adventure.'}</p></div>`:''}${next?`<button class="button secondary gallery-load-more" type="button" data-gallery-action="more" ${loading||busy?'disabled':''}>${loading?'Loading more…':'Load more photos'}</button>`:''}</div><aside class="panel gallery-upload"><span class="eyebrow gold">ADD TO THE MEMORY BOOK</span><h3>Share a screenshot</h3>${canUpload?`<form data-gallery-form><label for="gallery-title">Give it a title</label><input id="gallery-title" name="title" type="text" maxlength="80" value="${esc(draft.title)}" required placeholder="A very well-planned adventure" ${busy?'disabled':''}><label for="gallery-caption">Tell the tale <span class="subtle">(optional)</span></label><textarea id="gallery-caption" name="caption" maxlength="500" rows="4" placeholder="Who was there? What went wonderfully wrong?" ${busy?'disabled':''}>${esc(draft.caption)}</textarea><label class="gallery-file-label" for="gallery-file"><span>Choose a screenshot</span><small>JPG, PNG or WebP · up to 12 MB</small></label><input id="gallery-file" name="photo" type="file" accept="image/jpeg,image/png,image/webp" ${busy?'disabled':''}>${preparing?'<p class="gallery-preparing" role="status">Preparing your screenshot…</p>':draft.image?`<figure class="gallery-upload-preview"><img src="data:image/jpeg;base64,${draft.image.thumbnail_base64}" alt="Preview of the screenshot you selected"><figcaption>${esc(draft.filename)}</figcaption></figure>`:'<p class="subtle gallery-file-note">Screenshots are resized before sharing. Location and camera details are removed.</p>'}<button class="button primary" type="submit" ${busy||preparing||!draft.image?'disabled':''}>${busy?'Sharing…':'Share with the guild'}</button><p class="subtle gallery-upload-note">Check chat, character names and anything private in the image before sharing.</p></form>`:'<p>Sharing is temporarily unavailable. You can still enjoy the guild’s photos.</p>'}</aside></div><dialog class="gallery-lightbox" data-gallery-lightbox aria-labelledby="gallery-lightbox-title"><button class="gallery-lightbox-close" type="button" data-gallery-action="close" aria-label="Close screenshot">×</button><div data-gallery-lightbox-content></div></dialog>`;
    const dialog=host.querySelector('[data-gallery-lightbox]');dialog?.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  }
  async function request(path,options){
    const response=await fetch(path,options),result=await response.json();
    if(window.GuildAccess?.check(response,result)||response.status===401||result?.access_required===true){reset();throw Error('access');}
    if(!response.ok)throw Error(response.status===429?'limited':response.status===413?'large':response.status===409?'full':'request');
    return result;
  }
  async function load(more=false){
    wanted=true;if(!auth){gate();return;}if(loading||more&&!next)return;
    const epoch=generation,account=auth.user_id,version=++sequence,cursor=more?next:null;
    loading=true;if(!more)pendingRemoval=null;render();
    const query=[];if(mode==='mine')query.push('mine=1');if(mode==='removed')query.push('removed=1');if(cursor)query.push('cursor='+encodeURIComponent(cursor));
    try{
      const result=await request('/api/gallery'+(query.length?'?'+query.join('&'):''));
      if(!accountStill(epoch,account)||version!==sequence)return;
      const received=Array.isArray(result.items)?result.items.slice(0,20).filter(item=>safeImage(item,'image')&&safeImage(item,'thumbnail')):[];
      const seen=new Set(more?items.map(item=>item.id):[]);items=more?[...items,...received.filter(item=>!seen.has(item.id))]:received;
      next=safeId(result.next)?result.next:null;canUpload=result.can_upload!==false;loaded=true;loading=false;render();
    }catch{if(!accountStill(epoch,account)||version!==sequence)return;loading=false;render();feedback('The gallery could not be refreshed. Please try again shortly.',true);}
  }
  function dimensions(bytes){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),has=(start,values)=>values.every((value,index)=>bytes[start+index]===value);
    if(bytes.length>=24&&has(0,[137,80,78,71,13,10,26,10])&&has(12,[73,72,68,82]))return {width:view.getUint32(16),height:view.getUint32(20)};
    if(bytes.length>=30&&has(0,[82,73,70,70])&&has(8,[87,69,66,80])){
      if(has(12,[86,80,56,88]))return {width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)};
      if(has(12,[86,80,56,32])&&has(23,[157,1,42]))return {width:view.getUint16(26,true)&16383,height:view.getUint16(28,true)&16383};
      if(has(12,[86,80,56,76])&&bytes[20]===47)return {width:1+((bytes[21]|bytes[22]<<8)&16383),height:1+((bytes[22]>>6|bytes[23]<<2|bytes[24]<<10)&16383)};
    }
    if(bytes.length>4&&has(0,[255,216])){
      let offset=2;while(offset+4<=bytes.length){if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;if(offset+2>bytes.length)break;const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return {width:view.getUint16(offset+5),height:view.getUint16(offset+3)};offset+=length;}
    }
    throw Error('format');
  }
  function encoded(canvas,quality){const value=canvas.toDataURL('image/jpeg',quality);if(!value.startsWith('data:image/jpeg;base64,'))throw Error('encode');const base64=value.slice(23);return {base64,bytes:Math.floor(base64.length*3/4)-(base64.endsWith('==')?2:base64.endsWith('=')?1:0)};}
  function resized(image,maxSide,maxBytes){
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');if(!context)throw Error('canvas');
    let side=maxSide;
    for(let attempt=0;attempt<5;attempt++){
      const ratio=Math.min(1,side/image.width,side/image.height);canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));
      context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      for(const quality of [.9,.8,.7,.6]){const value=encoded(canvas,quality);if(value.bytes<=maxBytes)return value.base64;}
      side=Math.floor(side*.8);
    }
    throw Error('large');
  }
  async function prepare(file){
    if(!auth||busy||!file)return;
    const epoch=generation,account=auth.user_id,version=++fileSequence;draft.image=null;draft.filename='';preparing=true;feedback('');render();
    let bitmap;
    try{
      if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('format');if(file.size>12000000||file.size<24)throw Error('large');
      const bytes=new Uint8Array(await file.arrayBuffer()),size=dimensions(bytes);
      if(!size.width||!size.height||size.width>8192||size.height>8192||size.width*size.height>20000000)throw Error('dimensions');
      bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
      if(!bitmap.width||!bitmap.height||bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>20000000)throw Error('dimensions');
      const image={image_base64:resized(bitmap,1600,750000),thumbnail_base64:resized(bitmap,400,60000)};
      if(!accountStill(epoch,account)||version!==fileSequence)return;
      draft.image=image;draft.filename=String(file.name||'Selected screenshot').slice(0,200);preparing=false;render();feedback('Screenshot ready. Add a title, check the preview, then share it with the guild.');
    }catch(error){if(!accountStill(epoch,account)||version!==fileSequence)return;preparing=false;render();feedback(error.message==='dimensions'?'Choose a screenshot no larger than 20 megapixels or 8,192 pixels on either side.':error.message==='large'?'Choose a JPG, PNG or WebP screenshot under 12 MB.':'That image could not be prepared. Please choose a JPG, PNG or WebP screenshot.',true);}
    finally{bitmap?.close?.();}
  }
  async function share(form){
    if(!auth||busy||preparing||!draft.image)return;
    draft.title=String(form.elements.title.value||'').trim();draft.caption=String(form.elements.caption.value||'').trim();
    if(!draft.title||draft.title.length>80||draft.caption.length>500){feedback('Add a title of up to 80 characters and a caption of up to 500 characters.',true);return;}
    const epoch=generation,account=auth.user_id,csrf=auth.csrf,body={title:draft.title,caption:draft.caption,...draft.image};busy=true;render();
    try{
      await request('/api/gallery',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
      if(!accountStill(epoch,account)||csrf!==auth.csrf)return;
      busy=false;sequence++;loading=false;draft={title:'',caption:'',image:null,filename:''};mode='all';feedback('Your screenshot has joined the guild’s memory book.');await load();
    }catch(error){if(!accountStill(epoch,account))return;busy=false;render();feedback(error.message==='limited'?'You have shared several photos recently. Please wait before sharing another.':error.message==='full'?'The gallery is full for now. Your draft is still here; ask the administrator for help.':'Your screenshot could not be shared. Your title and prepared image are still here; try again shortly.',true);}
  }
  async function moderate(id,action){
    if(!auth||busy||!safeId(id)||!items.some(item=>item.id===id&&item.can_manage===true))return;
    const epoch=generation,account=auth.user_id,csrf=auth.csrf;busy=true;render();
    try{await request(`/api/gallery/${id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});if(!accountStill(epoch,account)||csrf!==auth.csrf)return;busy=false;sequence++;loading=false;pendingRemoval=null;feedback(action==='restore'?'Photo restored to the gallery.':'Photo removed from the gallery. You can restore it from Removed.');await load();}
    catch{if(!accountStill(epoch,account))return;busy=false;render();feedback('That photo could not be changed. Refresh the gallery and try again.',true);}
  }
  function open(id){
    const item=items.find(item=>item.id===id&&!item.removed),image=safeImage(item,'image');if(!item||!image)return;
    const dialog=host.querySelector('[data-gallery-lightbox]'),content=host.querySelector('[data-gallery-lightbox-content]');if(!dialog||!content)return;
    content.innerHTML=`<img class="gallery-lightbox-image" src="${esc(image)}" alt="${esc(item.title||'Guild screenshot')}" referrerpolicy="no-referrer"><div class="gallery-lightbox-copy"><h3 id="gallery-lightbox-title">${esc(item.title||'Guild memory')}</h3>${item.caption?`<p>${esc(item.caption)}</p>`:''}<p class="gallery-attribution">Shared by ${esc(item.author_name||'Guild member')} · ${esc(time(item.created_at))}</p></div>`;
    dialog.showModal();
  }
  host.addEventListener('input',event=>{if(!event.target.closest?.('[data-gallery-form]')||!auth)return;if(event.target.name==='title')draft.title=event.target.value;if(event.target.name==='caption')draft.caption=event.target.value;});
  host.addEventListener('change',event=>{if(event.target.name==='photo'&&event.target.closest?.('[data-gallery-form]'))prepare(event.target.files?.[0]);});
  host.addEventListener('submit',event=>{const form=event.target.closest?.('[data-gallery-form]');if(!form)return;event.preventDefault();share(form);});
  host.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-gallery-action]');if(!button||!auth)return;
    const action=button.dataset.galleryAction,id=button.dataset.galleryId;
    if(action==='close'){closeLightbox();return;}if(action==='open'){open(id);return;}if(busy)return;
    if(action==='compose'){const title=host.querySelector('#gallery-title');title?.focus();title?.scrollIntoView?.({block:'center',behavior:'auto'});return;}
    if(action==='filter'&&['all','mine','removed'].includes(button.dataset.galleryMode)){mode=button.dataset.galleryMode;notice='';sequence++;loading=false;items=[];next=null;loaded=false;load();}
    if(action==='refresh')load();if(action==='more')load(true);
    if(action==='remove'&&items.some(item=>item.id===id&&item.can_manage===true)){pendingRemoval=id;render();}
    if(action==='cancel-remove'){pendingRemoval=null;render();}
    if(action==='confirm-remove')moderate(id,'remove');if(action==='restore')moderate(id,'restore');
  });
  window.addEventListener('guild-member',event=>{
    const value=event.detail||{};if(!value.verified||typeof value.user_id!=='string'||!value.user_id||typeof value.csrf!=='string'||!value.csrf){reset();return;}
    const requested=wanted,changed=auth?.user_id!==value.user_id||auth?.csrf!==value.csrf||auth?.is_admin!==Boolean(value.is_admin);
    if(changed){const previous=auth?.user_id;reset();if(previous===value.user_id)wanted=requested;}
    auth={user_id:value.user_id,csrf:value.csrf,is_admin:Boolean(value.is_admin)};
    if(requested&&!loaded||document.getElementById('gallery')?.hidden===false&&changed){wanted=true;load();}else if(!loaded)render();
  });
  window.addEventListener('guild-access-reset',reset);
  window.GuildGallery={load,reset};gate();
})();
