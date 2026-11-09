(()=>{
  'use strict';
  const definitions=[
    {key:'character',label:'Character',selectors:['.character-armory','.character-role-summary'],empty:'Character details have not been returned.'},
    {key:'talents',label:'Talents',selectors:['.character-talents'],empty:'Talent data has not been returned for this character.'},
    {key:'professions',label:'Professions',selectors:['.character-professions'],empty:'Profession data has not been returned for this character.'},
    {key:'details',label:'Details',selectors:['.character-freshness','.character-data-status'],empty:'Refresh and source details have not been returned.'}
  ];
  const states=new WeakMap(),active=new Set();let nextID=0;
  function select(state,key,focus=false){
    if(!definitions.some(tab=>tab.key===key))return;
    state.selected=key;
    for(const tab of definitions){const selected=tab.key===key,button=state.buttons.get(tab.key),panel=state.panels.get(tab.key);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('active',selected);panel.hidden=!selected;}
    if(focus){const button=state.buttons.get(key);button.focus();button.scrollIntoView?.({block:'nearest',inline:'nearest'});}
  }
  function mount(content,member){
    const id=Number(member?.id);if(!content||!Number.isSafeInteger(id)||id<1)return;
    const previous=states.get(content),same=previous?.id===id,selected=same?previous.selected:'character';
    const scrolls=new Map(same?[...previous.panels].map(([key,panel])=>[key,panel.scrollTop||0]):[]);
    const blocks=new Map(definitions.map(tab=>[tab.key,tab.selectors.flatMap(selector=>[...content.querySelectorAll(selector)])]));
    previous?.wrapper.removeEventListener('click',previous.onClick);previous?.wrapper.removeEventListener('keydown',previous.onKey);
    content.querySelector('[data-character-card-tabs]')?.remove();
    const wrapper=document.createElement('div');wrapper.className='character-card-tabs';wrapper.setAttribute('data-character-card-tabs','');
    const tablist=document.createElement('div');tablist.className='character-card-tablist';tablist.setAttribute('role','tablist');tablist.setAttribute('aria-label','Character sections');
    const panels=document.createElement('div');panels.className='character-card-panels';
    const state={id,selected,wrapper,buttons:new Map(),panels:new Map()},prefix='character-card-'+(++nextID);
    for(const tab of definitions){
      const button=document.createElement('button');button.type='button';button.id=prefix+'-tab-'+tab.key;button.className='character-card-tab';button.textContent=tab.label;button.setAttribute('role','tab');button.setAttribute('data-character-tab',tab.key);button.setAttribute('aria-controls',prefix+'-panel-'+tab.key);
      const panel=document.createElement('section');panel.id=prefix+'-panel-'+tab.key;panel.className='character-card-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);panel.tabIndex=0;
      const nodes=blocks.get(tab.key);if(nodes.length)for(const node of nodes)panel.appendChild(node);else {const empty=document.createElement('p');empty.className='subtle character-card-empty';empty.textContent=tab.empty;panel.appendChild(empty);}
      state.buttons.set(tab.key,button);state.panels.set(tab.key,panel);tablist.appendChild(button);panels.appendChild(panel);
    }
    wrapper.appendChild(tablist);wrapper.appendChild(panels);
    const header=[...content.children].find(node=>node.tagName==='P');content.insertBefore(wrapper,header?header.nextSibling:null);
    state.onClick=event=>{const target=event.target.closest?.('[data-character-tab]');if(target&&wrapper.contains(target))select(state,target.getAttribute('data-character-tab'));};
    state.onKey=event=>{const target=event.target.closest?.('[data-character-tab]');if(!target||!wrapper.contains(target))return;const index=definitions.findIndex(tab=>tab.key===target.getAttribute('data-character-tab'));let next=index;if(event.key==='ArrowRight')next=(index+1)%definitions.length;else if(event.key==='ArrowLeft')next=(index+definitions.length-1)%definitions.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=definitions.length-1;else return;event.preventDefault();select(state,definitions[next].key,true);};
    wrapper.addEventListener('click',state.onClick);wrapper.addEventListener('keydown',state.onKey);states.set(content,state);active.add(content);select(state,selected);
    for(const [key,scroll]of scrolls)state.panels.get(key).scrollTop=scroll;
  }
  function reset(content){
    const targets=content?[content]:[...active];
    for(const target of targets){const state=states.get(target);if(state){state.wrapper.removeEventListener('click',state.onClick);state.wrapper.removeEventListener('keydown',state.onKey);select(state,'character');states.delete(target);}active.delete(target);}
  }
  window.GuildCharacterCard={mount,reset};
  window.addEventListener('guild-access-reset',()=>reset());
})();
