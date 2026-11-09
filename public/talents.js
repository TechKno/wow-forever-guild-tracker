(() => {
  'use strict';
  const hosts=new WeakMap(),choices=new Map(),cache=new Map();
  let serial=0;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not yet observed';
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const identifier=value=>value==null?'':String(value);
  const rankLabel=node=>`Rank ${count(node.rank)??'?'}${count(node.max_rank)!==null?' / '+node.max_rank:''}`;
  const keyFor=member=>`${member.id}:${member.talents_at||''}:${member.talents_status||''}`;
  function remember(state){
    choices.delete(state.id);choices.set(state.id,{tree:state.tree,node:state.node});
    while(choices.size>64)choices.delete(choices.keys().next().value);
  }
  function safeTrees(payload){return Array.isArray(payload?.trees)?payload.trees.filter(tree=>tree&&typeof tree==='object').map(tree=>({...tree,nodes:Array.isArray(tree.nodes)?tree.nodes.filter(node=>node&&typeof node==='object'):[]})):[];}
  function selectedTree(state){
    const trees=safeTrees(state.payload);
    const chosen=trees.findIndex(tree=>identifier(tree.id)===state.tree),allocated=trees.findIndex(tree=>count(tree.points)>0);
    return {trees,index:chosen>=0?chosen:Math.max(0,allocated)};
  }
  function validLayout(tree){
    if(!tree.layout_available||!tree.nodes.length)return false;
    const positions=new Set();
    return tree.nodes.every(node=>{
      if(!Number.isSafeInteger(node.row)||node.row<0||node.row>20||!Number.isSafeInteger(node.column)||node.column<0||node.column>10)return false;
      const position=node.row+':'+node.column;if(positions.has(position))return false;positions.add(position);return true;
    });
  }
  function details(node){
    if(!node)return '<p class="talent-instruction">Choose a talent to read its returned spell details.</p>';
    const rank=count(node.rank),descriptionRank=count(node.description_rank);
    const preview=descriptionRank!==null&&(rank===null||rank===0||descriptionRank!==rank);
    return `<h4>${escape(node.name||'Unnamed talent')}</h4><p class="talent-detail-rank">${escape(rankLabel(node))}</p>${descriptionRank!==null?`<p class="talent-description-source">${preview?'Preview of rank ':'Description for rank '}${descriptionRank}</p>`:''}<p class="talent-description">${escape(node.description||'Blizzard did not return a description for this talent.')}</p>`;
  }
  function draw(state,{focusTree=false}={}){
    const host=state.host,payload=state.payload;
    if(!payload){
      const summary=Array.isArray(state.member.talents)?state.member.talents:[];
      host.innerHTML=`<section class="talent-folio" aria-label="Character talents"><div class="talent-heading"><h3>Talent trees</h3><span class="talent-seal" aria-hidden="true">✦</span></div>${summary.length?`<ul class="talent-summary">${summary.map(tree=>`<li><span>${escape(tree.name||'Unnamed tree')}</span><strong>${count(tree.points)??'?'} points</strong></li>`).join('')}</ul>`:''}<p class="talent-loading" role="status">${state.error?'Talent details could not be loaded. Saved tree totals remain above.':'Opening the character’s talent folio…'}</p>${state.error?'<button type="button" class="talent-retry" data-talent-retry>Try again</button>':''}</section>`;
      return;
    }
    const {trees,index}=selectedTree(state),tree=trees[index];
    if(tree){state.tree=identifier(tree.id);if(!tree.nodes.some(node=>identifier(node.id)===state.node))state.node=identifier(tree.nodes.find(node=>count(node.rank)>0)?.id);remember(state);}
    const node=tree?.nodes.find(node=>identifier(node.id)===state.node),layout=tree&&validLayout(tree);
    const columns=layout?Math.max(...tree.nodes.map(item=>item.column))+1:0;
    const status=payload.status==='stale'?'Previous observation':payload.status==='verified'?'Observed talents':'Talents unavailable';
    host.innerHTML=`<section class="talent-folio" aria-label="Character talents"><div class="talent-heading"><div><h3>Talent trees</h3><p class="talent-observed">${status} · ${escape(time(payload.observed_at))}</p></div><span class="talent-seal" aria-hidden="true">✦</span></div>${payload.note?`<p class="talent-notice">${escape(payload.note)}</p>`:''}${payload.checked_at&&payload.checked_at!==payload.observed_at?`<p class="talent-checked">Last attempt: ${escape(time(payload.checked_at))}</p>`:''}${trees.length?`<div class="talent-tabs" role="tablist" aria-label="Talent trees">${trees.map((item,i)=>`<button type="button" role="tab" id="${state.prefix}-tab-${i}" aria-controls="${state.prefix}-panel" aria-selected="${i===index}" tabindex="${i===index?'0':'-1'}" data-talent-tree="${i}"><span>${escape(item.name||'Unnamed tree')}</span><small>${count(item.points)??'?'} points</small></button>`).join('')}</div><div class="talent-panel" id="${state.prefix}-panel" role="tabpanel" aria-labelledby="${state.prefix}-tab-${index}" tabindex="0">${tree.note?`<p class="talent-notice">${escape(tree.note)}</p>`:''}${!layout?'<p class="talent-layout-note">Talent list · a complete matching tree layout is unavailable.</p>':''}<div class="talent-body"><div class="talent-scroll"><div class="talent-nodes ${layout?'talent-grid talent-columns-'+columns:'talent-list'}" role="group" aria-label="${escape(tree.name||'Talent tree')} talents">${tree.nodes.map((item,i)=>`<button type="button" class="talent-node${count(item.rank)>0?' is-learned':''}${identifier(item.id)===state.node?' is-selected':''}${layout?` talent-row-${item.row} talent-column-${item.column}`:''}" data-talent-node="${i}" aria-pressed="${identifier(item.id)===state.node}" aria-controls="${state.prefix}-details"><span class="talent-node-mark" aria-hidden="true">${count(item.rank)>0?'✦':'◇'}</span><span class="talent-node-name">${escape(item.name||'Unnamed talent')}</span><span class="talent-node-rank">${escape(rankLabel(item))}</span></button>`).join('')||'<p class="talent-empty">No individual talents were returned for this tree.</p>'}</div></div><aside class="talent-details" id="${state.prefix}-details" aria-live="polite" aria-atomic="true">${details(node)}</aside></div></div>`:'<p class="talent-empty">No talent trees are available for this character yet.</p>'}<p class="talent-footnote">A saved character build, as returned by Blizzard. ${tree?.layout_observed_at?'Tree layout checked '+escape(time(tree.layout_observed_at))+'. ':''}Builds are Blizzard snapshots and may lag behind the game.</p>${payload.status!=='verified'?'<button type="button" class="talent-retry" data-talent-retry>Try again</button>':''}</section>`;
    if(focusTree)host.querySelector(`[data-talent-tree="${index}"]`)?.focus();
  }
  function bind(host){
    let state=hosts.get(host);if(state)return state;
    state={host,prefix:'talents-'+(++serial),seq:0};hosts.set(host,state);
    host.addEventListener('click',event=>{
      const current=hosts.get(host),tab=event.target.closest?.('[data-talent-tree]'),button=event.target.closest?.('[data-talent-node]');
      if(event.target.closest?.('[data-talent-retry]')){render(current.member,host,true);return;}
      if(!current.payload)return;
      const {trees,index}=selectedTree(current);
      if(tab){const next=Number(tab.dataset.talentTree);if(!Number.isSafeInteger(next)||!trees[next])return;current.tree=identifier(trees[next].id);current.node='';remember(current);draw(current,{focusTree:true});}
      else if(button){
        const next=Number(button.dataset.talentNode),node=trees[index]?.nodes[next];if(!Number.isSafeInteger(next)||!node)return;
        current.node=identifier(node.id);remember(current);
        for(const control of host.querySelectorAll('[data-talent-node]')){const selected=control===button;control.setAttribute('aria-pressed',String(selected));control.classList.toggle('is-selected',selected);}
        host.querySelector('.talent-details').innerHTML=details(node);
        button.focus({preventScroll:true});
      }
    });
    host.addEventListener('keydown',event=>{
      const tab=event.target.closest?.('[data-talent-tree]');if(!tab)return;
      const current=hosts.get(host),{trees,index}=selectedTree(current);if(!trees.length)return;
      const direction=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
      const next=direction?(index+direction+trees.length)%trees.length:event.key==='Home'?0:event.key==='End'?trees.length-1:null;
      if(next===null)return;event.preventDefault();current.tree=identifier(trees[next].id);current.node='';remember(current);draw(current,{focusTree:true});
    });
    return state;
  }
  async function request(member,force){
    const key=keyFor(member),existing=cache.get(key);
    if(!force&&existing&&existing.expires>Date.now())return existing.payload||existing.promise;
    const entry={expires:Date.now()+60000,promise:null,payload:null};
    entry.promise=(async()=>{
      const response=await fetch('/api/characters/'+encodeURIComponent(member.id)+'/talents',{cache:'no-store'});
      const payload=await response.json();
      if(window.GuildAccess?.check(response,payload))throw new Error('Sign in to reopen the guildhall');
      if(!response.ok)throw new Error('Talent details are temporarily unavailable');
      if(Number(payload.character_id)!==Number(member.id)||!Array.isArray(payload.trees))throw new Error('Talent character identity did not match');
      entry.payload=payload;entry.expires=Date.now()+(payload.status==='verified'?300000:60000);return payload;
    })();
    cache.delete(key);cache.set(key,entry);while(cache.size>64)cache.delete(cache.keys().next().value);
    try{return await entry.promise;}catch(error){if(cache.get(key)===entry)cache.delete(key);throw error;}
  }
  async function render(member,host,force=false){
    if(!host||!member||!Number.isSafeInteger(Number(member.id))||Number(member.id)<=0)return;
    const state=bind(host),id=identifier(member.id),previous=choices.get(id),sequence=++state.seq;
    const same=state.id===id;state.id=id;state.member=member;state.error=false;
    if(!same){state.tree=previous?.tree||'';state.node=previous?.node||'';state.payload=null;}
    const existing=cache.get(keyFor(member));
    if(!force&&existing?.payload&&existing.expires>Date.now()){state.payload=existing.payload;draw(state);return;}
    if(!same)draw(state);
    try{
      const payload=await request(member,force);
      if(state.seq!==sequence||host.isConnected===false)return;
      state.payload=payload;draw(state);
    }catch{
      if(state.seq!==sequence||host.isConnected===false)return;
      state.error=true;
      if(state.payload){state.payload={...state.payload,status:'stale',note:'The latest talent request failed. Showing the previous observation.'};}
      draw(state);
    }
  }
  window.GuildTalents={render};
})();
