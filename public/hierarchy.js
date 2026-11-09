(()=>{
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let roster=[],people=[],labels={},version=0,verified=false;
  const rank=value=>Number.isSafeInteger(value)&&value>=0&&value<=99?value:100;
  function groups(){
    const current=new Map(roster.map(member=>[Number(member.id),member])),used=new Set(),result=[];
    for(const person of people){
      const characters=(person.characters||[]).map(c=>current.get(Number(c.id))).filter(c=>c&&!used.has(c.id));
      if(!characters.length)continue;
      characters.forEach(c=>used.add(c.id));
      const main=person.characters?.find(character=>character.is_main)?.id;
      characters.sort((a,b)=>rank(a.rank)-rank(b.rank)||(Number(b.level)||0)-(Number(a.level)||0)||Number(b.id===main)-Number(a.id===main)||a.name.localeCompare(b.name));
      const representative=characters[0];
      result.push({name:person.discord_linked?person.display_name||representative.name:representative.name,linked:Boolean(person.discord_linked),characters:[representative],rank:rank(representative.rank)});
    }
    for(const member of roster)if(!used.has(member.id))result.push({name:member.name,linked:false,characters:[member],rank:rank(member.rank)});
    return result.sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name));
  }
  function render(){
    const host=document.getElementById('hierarchy-content');if(!host)return;
    if(!verified){host.innerHTML='';return;}
    const all=groups(),ranks=[...new Set(all.map(person=>person.rank))];
    host.innerHTML=all.length?ranks.map(number=>{const list=all.filter(person=>person.rank===number),name=number===100?'Rank not returned':labels[String(number)]||'Rank '+number;
      return `<section class="hierarchy-rank panel"><div class="hierarchy-heading"><span class="hierarchy-seal" aria-hidden="true">${number===0?'♛':number===100?'?':number}</span><div><span class="eyebrow gold">${number===100?'UNASSIGNED':'GUILD RANK '+number}</span><h3>${esc(name)}</h3></div><span class="hierarchy-count">${list.length} ${list.length===1?'member':'members'}</span></div><div class="hierarchy-people">${list.map(person=>`<article class="hierarchy-person"><div class="hierarchy-person-heading"><span class="hierarchy-initial" aria-hidden="true">${esc(person.name.slice(0,1))}</span><div><h4>${esc(person.name)}</h4><p>${person.linked?'Discord linked':person.characters.length>1?'Verified character group':'Guild character'}</p></div></div><ul>${person.characters.map(character=>`<li><button type="button" data-hierarchy-character="${Number(character.id)}">${esc(character.name)}</button><small>${esc(character.class||'Unknown class')} · Level ${esc(character.level??'?')}${rank(character.rank)!==number?' · '+esc(labels[String(character.rank)]||'Rank '+character.rank):''}</small></li>`).join('')}</ul></article>`).join('')}</div></section>`;}).join(''):'<div class="panel empty"><p>The hierarchy will appear after a verified guild roster is imported.</p></div>';
  }
  async function load(){
    if(!verified)return;const selected=++version;
    try{const response=await fetch('/api/guild/ranks',{cache:'no-store'}),result=await response.json();if(selected!==version||!verified)return;
      if(window.GuildAccess?.check(response,result))return;if(!response.ok)throw Error();labels=result.labels||{};render();
    }catch{if(selected===version&&verified){const note=document.getElementById('hierarchy-feedback');if(note){note.hidden=false;note.textContent='Rank labels could not be refreshed. The current roster order is still shown.';}render();}}
  }
  function reset(){version++;roster=[];people=[];labels={};verified=false;render();}
  window.GuildHierarchy={update(members){roster=Array.isArray(members)?members:[];render();},load,reset};
  window.addEventListener('guild-member',event=>{verified=Boolean(event.detail?.verified);if(!verified)reset();else load();});
  window.addEventListener('guild-hall-data',event=>{people=Array.isArray(event.detail?.people)?event.detail.people:[];render();});
  window.addEventListener('guild-ranks-saved',load);
  document.addEventListener('click',event=>{const button=event.target.closest?.('[data-hierarchy-character]');if(button)window.GuildCharacter?.open(Number(button.dataset.hierarchyCharacter));});
})();
