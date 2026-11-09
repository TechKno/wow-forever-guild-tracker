import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/gallery.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/gallery.css',import.meta.url),'utf8');
const clean=value=>JSON.parse(JSON.stringify(value));
const id='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
const photo=(value=id,extra={})=>({id:value,title:'Fictional guild adventure',caption:'A screenshot worth keeping.',author_name:'Fictional Member',created_at:'2026-11-09T09:00:00Z',width:1200,height:800,image_url:`/api/gallery/${value}/image`,thumbnail_url:`/api/gallery/${value}/thumbnail`,can_manage:true,removed:false,...extra});
const member=extra=>({verified:true,user_id:'gallery-owner',csrf:'gallery-csrf',is_admin:false,...extra});
function png(width=1200,height=800){const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);const view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);return bytes;}
const imageFile=(extra={})=>({name:'Fictional screenshot.png',type:'image/png',size:24,arrayBuffer:async()=>png().buffer,...extra});
function fixture(){
  const calls=[],listeners=new Map(),rootListeners=new Map(),canvases=[],bitmapCalls=[];
  const feedback={hidden:true,textContent:'',classList:{toggle(){}}},dialog={open:false,close(){this.open=false;},showModal(){this.open=true;},addEventListener(){}},lightbox={innerHTML:''};
  const state={gallery:{items:[photo()],next:null,can_upload:true},delay:null,bitmapDelay:null,failure:false,response:null,pageHidden:true,bitmap:{width:1200,height:800,close(){this.closed=true;}}};
  const root={innerHTML:'',addEventListener(type,fn){rootListeners.set(type,fn);},querySelector(selector){return selector==='[data-gallery-feedback]'?feedback:selector==='[data-gallery-lightbox]'?dialog:selector==='[data-gallery-lightbox-content]'?lightbox:null;}};
  const window={addEventListener(type,fn){listeners.set(type,fn);},GuildAccess:{check(response,result){return response.status===401||result.access_required===true;}}};
  const context=vm.createContext({window,document:{getElementById(value){return value==='gallery-content'?root:value==='gallery'?{hidden:state.pageHidden}:null;},createElement(tag){assert.equal(tag,'canvas');const canvas={width:0,height:0,getContext(){return {fillRect(){},drawImage(){canvas.draws=(canvas.draws||0)+1;}};},toDataURL(type,quality){assert.equal(type,'image/jpeg');canvas.qualities=(canvas.qualities||[]).concat(quality);return 'data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');}};canvases.push(canvas);return canvas;}},async createImageBitmap(file,options){bitmapCalls.push({file,options});if(state.bitmapDelay)await state.bitmapDelay;return state.bitmap;},async fetch(path,options){calls.push({path,options:options?clean(options):null});if(state.delay)await state.delay;if(state.failure)throw Error('private-provider-failure');const response=state.response||{ok:true,status:200,result:options?{}:clean(state.gallery)};return {...response,json:async()=>clean(response.result)};}});
  vm.runInContext(source,context);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {api:window.GuildGallery,root,feedback,dialog,lightbox,state,calls,canvases,bitmapCalls,async emit(type,detail){listeners.get(type)?.({detail});await flush();},async click(action,extra={}){const button={dataset:{galleryAction:action,...extra}};rootListeners.get('click')({target:{closest(){return button;}}});await flush();},async choose(file){rootListeners.get('change')({target:{name:'photo',files:[file],closest(){return {};}}});await flush();},async input(name,value){rootListeners.get('input')({target:{name,value,closest(){return {};}}});await flush();},async submit(title='An adventure',caption='A tale'){const form={elements:{title:{value:title},caption:{value:caption}}};rootListeners.get('submit')({preventDefault(){},target:{closest(){return form;}}});await flush();},flush};
}
const writes=p=>p.calls.filter(call=>call.options?.method==='POST');

test('gallery waits for verified membership and never renders account identifiers or CSRF',async()=>{
  const p=fixture();await p.api.load();assert.equal(p.calls.length,0);assert.match(p.root.innerHTML,/Sign in with Battle.net/);
  await p.emit('guild-member',member({verified:false}));assert.equal(p.calls.length,0);
  await p.emit('guild-member',member());await p.api.load();assert.equal(p.calls.length,1);assert.match(p.root.innerHTML,/Fictional guild adventure/);assert.doesNotMatch(p.root.innerHTML,/gallery-owner|gallery-csrf/);
});

test('gallery escapes member content and accepts only exact private image references',async()=>{
  const p=fixture();p.state.gallery.items=[photo(id,{title:'<script>bad</script>',caption:'<img onerror=bad()>',author_name:'<svg onload=bad()>'}),photo(second,{image_url:'https://outside.example/private.jpg'})];await p.emit('guild-member',member());await p.api.load();
  assert.match(p.root.innerHTML,/&lt;script&gt;bad&lt;\/script&gt;/);assert.match(p.root.innerHTML,/&lt;img onerror=bad\(\)&gt;/);assert.doesNotMatch(p.root.innerHTML,/<script>|<svg|https:\/\/outside/);
  await p.click('open',{galleryId:id});assert.equal(p.dialog.open,true);assert.match(p.lightbox.innerHTML,new RegExp('/api/gallery/'+id+'/image'));assert.doesNotMatch(p.lightbox.innerHTML,/<script>/);
  await p.click('close');assert.equal(p.dialog.open,false);
});

test('private pagination uses the returned cursor, keeps unique cards and changes filters explicitly',async()=>{
  const p=fixture();p.state.gallery.next=second;await p.emit('guild-member',member());await p.api.load();p.state.gallery={items:[photo(),photo(second)],next:null,can_upload:true};await p.click('more');
  assert.equal(p.calls.at(-1).path,'/api/gallery?cursor='+second);assert.equal((p.root.innerHTML.match(/data-gallery-action="open"/g)||[]).length,2);
  await p.click('filter',{galleryMode:'mine'});assert.equal(p.calls.at(-1).path,'/api/gallery?mine=1');await p.click('filter',{galleryMode:'removed'});assert.equal(p.calls.at(-1).path,'/api/gallery?removed=1');
});

test('selecting a supported image normalizes full and thumbnail JPEGs but sharing requires the explicit submit action',async()=>{
  const p=fixture();await p.emit('guild-member',member());await p.api.load();await p.choose(imageFile());
  assert.equal(p.canvases.length,2);assert.equal(p.canvases[0].width,1200);assert.equal(p.canvases[1].width,400);assert(p.canvases.every(canvas=>canvas.draws===1));assert.equal(writes(p).length,0);assert.match(p.root.innerHTML,/data:image\/jpeg;base64,/);assert.equal(p.state.bitmap.closed,true);
  await p.submit('A fictional victory','A tale of teamwork');const call=writes(p)[0];assert.equal(call.path,'/api/gallery');assert.equal(call.options.headers['X-CSRF-Token'],'gallery-csrf');assert.equal(call.options.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(call.options.body),{title:'A fictional victory',caption:'A tale of teamwork',image_base64:'/9j/2Q==',thumbnail_base64:'/9j/2Q=='});assert.match(p.feedback.textContent,/joined the guild/);
});

test('unsupported, oversized and excessive-dimension input is rejected before decoding or writing',async()=>{
  const p=fixture();await p.emit('guild-member',member());
  for(const file of [imageFile({type:'image/svg+xml'}),imageFile({size:12000001}),imageFile({arrayBuffer:async()=>new TextEncoder().encode('<svg onload="bad()"></svg>').buffer}),imageFile({arrayBuffer:async()=>png(8193,200).buffer}),imageFile({arrayBuffer:async()=>png(5000,5000).buffer})])await p.choose(file);
  assert.equal(p.bitmapCalls.length,0);assert.equal(writes(p).length,0);assert.match(p.feedback.textContent,/20 megapixels/);assert.doesNotMatch(p.root.innerHTML,/data:image\/jpeg;base64,/);
});

test('failed sharing retains the title, caption and prepared image without exposing server details',async()=>{
  const p=fixture();await p.emit('guild-member',member());await p.api.load();await p.choose(imageFile());p.state.failure=true;await p.submit('Unsaved title','Unsaved caption');
  assert.match(p.root.innerHTML,/Unsaved title/);assert.match(p.root.innerHTML,/Unsaved caption/);assert.match(p.root.innerHTML,/data:image\/jpeg;base64,/);assert.match(p.feedback.textContent,/could not be shared/);assert.doesNotMatch(p.feedback.textContent,/private-provider-failure/);
});

test('removed cards never request private image bytes and moderation needs a manageable item plus explicit confirmation',async()=>{
  const p=fixture();await p.emit('guild-member',member());await p.api.load();await p.click('remove',{galleryId:id});assert.equal(writes(p).length,0);assert.match(p.root.innerHTML,/You can restore it later/);
  await p.click('cancel-remove');assert.equal(writes(p).length,0);await p.click('remove',{galleryId:id});await p.click('confirm-remove',{galleryId:id});assert.equal(writes(p)[0].path,'/api/gallery/'+id+'/remove');assert.equal(writes(p)[0].options.headers['X-CSRF-Token'],'gallery-csrf');
  p.state.gallery.items=[photo(id,{removed:true})];await p.click('filter',{galleryMode:'removed'});assert.match(p.root.innerHTML,/Restore photo/);assert.doesNotMatch(p.root.innerHTML,new RegExp('src="/api/gallery/'+id));await p.click('open',{galleryId:id});assert.equal(p.dialog.open,false);
  await p.click('restore',{galleryId:id});assert.equal(writes(p)[1].path,'/api/gallery/'+id+'/restore');
  p.state.gallery.items=[photo(id,{can_manage:false})];await p.api.load();await p.click('restore',{galleryId:id});assert.equal(writes(p).length,2);
});

test('membership loss clears private photos, prepared drafts and lightboxes and late requests cannot restore them',async()=>{
  const p=fixture();await p.emit('guild-member',member());await p.api.load();await p.choose(imageFile());await p.click('open',{galleryId:id});assert.equal(p.dialog.open,true);
  let release;p.state.delay=new Promise(resolve=>release=resolve);const loading=p.api.load();await p.emit('guild-member',{verified:false});assert.equal(p.dialog.open,false);assert.doesNotMatch(p.root.innerHTML,/Fictional|data:image|gallery-grid/);release();await loading;assert.match(p.root.innerHTML,/Sign in with Battle.net/);
  p.state.delay=null;await p.emit('guild-member',member({user_id:'another-owner',csrf:'another-csrf'}));assert.doesNotMatch(p.root.innerHTML,/data:image\/jpeg;base64,/);await p.emit('guild-access-reset');assert.doesNotMatch(p.root.innerHTML,/Fictional guild adventure/);
});

test('a delayed image conversion cannot repopulate a signed-out member draft',async()=>{
  const p=fixture();await p.emit('guild-member',member());let release;p.state.bitmapDelay=new Promise(resolve=>release=resolve);await p.choose(imageFile());await p.emit('guild-access-reset');release();await p.flush();assert.match(p.root.innerHTML,/Sign in with Battle.net/);assert.doesNotMatch(p.root.innerHTML,/data:image\/jpeg;base64,/);assert.equal(writes(p).length,0);
});

test('normal member updates do not start background gallery polling and failed refreshes retain known cards',async()=>{
  const p=fixture();await p.emit('guild-member',member());await p.api.load();const count=p.calls.length;await p.emit('guild-member',member());assert.equal(p.calls.length,count);p.state.failure=true;await p.api.load();assert.match(p.root.innerHTML,/Fictional guild adventure/);assert.match(p.feedback.textContent,/could not be refreshed/);
});

test('losing administrator permissions clears a previous removed-photo listing and reloads the owner view',async()=>{
  const p=fixture();p.state.gallery.items=[photo(id,{removed:true,title:'Other member removed photo'})];await p.emit('guild-member',member({is_admin:true}));await p.api.load();await p.click('filter',{galleryMode:'removed'});assert.match(p.root.innerHTML,/Other member removed photo/);
  let release;p.state.delay=new Promise(resolve=>release=resolve);await p.emit('guild-member',member({is_admin:false}));assert.doesNotMatch(p.root.innerHTML,/Other member removed photo|moderate the guild/);p.state.gallery.items=[];release();await p.flush();assert.doesNotMatch(p.root.innerHTML,/Other member removed photo/);
});

test('gallery phone layout and lightbox are bounded and unrelated Blizzard freshness is hidden',()=>{
  assert.match(css,/@media\(max-width:520px\)/);assert.match(css,/grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/max-width:calc\(100vw - 24px\)/);assert.match(css,/body\[data-view=gallery\] \.freshness-summary\{display:none\}/);assert.match(css,/prefers-reduced-motion/);assert.match(source,/<dialog class="gallery-lightbox"[^>]+aria-labelledby="gallery-lightbox-title"/);
});
