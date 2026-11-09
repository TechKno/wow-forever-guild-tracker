import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/talents.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/talents.css',import.meta.url),'utf8');
const member=(id=1,at='2026-11-08T17:00:00.000Z')=>({id,talents_at:at,talents_status:'verified',talents:[{name:'Arcane',points:4}]});
const tree=(id,name,nodes,overrides={})=>({id,name,points:4,layout_available:true,layout_observed_at:'2026-11-08T17:00:00.000Z',nodes,...overrides});
const node=(id,name,overrides={})=>({id,name,rank:2,max_rank:5,description:'Reduces the cost by 2%.',description_rank:2,row:0,column:0,prerequisite_ids:[],...overrides});
const payload=(id=1,overrides={})=>({character_id:id,status:'verified',observed_at:'2026-11-08T17:00:00.000Z',checked_at:'2026-11-08T17:00:00.000Z',note:null,
  trees:[tree(100,'Arcane',[node(1,'Arcane Focus',{row:1,column:0}),node(2,'Arcane Subtlety',{row:0,column:1,rank:0,description_rank:1})]),
    tree(200,'Frost',[node(3,'Ice Shards',{description:'Increases frost damage.',row:0,column:0})])],...overrides});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

function page(handler){
  const document={activeElement:null},calls=[];
  const context=vm.createContext({window:{},Date,console,fetch:async(path,options)=>{calls.push({path,options});return handler(path,options);}});
  vm.runInContext(source,context);
  function host(){
    const listeners=new Map(),element={isConnected:true,nodes:[],_html:'',
      get innerHTML(){return this._html;},
      set innerHTML(value){
        this._html=value;this.nodes=[...value.matchAll(/<button\b([^>]+)>/g)].map(match=>{
          const attrs=Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(attr=>[attr[1],attr[2]??'']));
          const button={attrs,dataset:{},focus(){document.activeElement=this;},getAttribute(name){return attrs[name]??null;},setAttribute(name,value){attrs[name]=value;},classList:{toggle(){}},
            closest(selector){return selector==='[data-talent-tree]'&&Object.hasOwn(attrs,'data-talent-tree')||selector==='[data-talent-node]'&&Object.hasOwn(attrs,'data-talent-node')||selector==='[data-talent-retry]'&&Object.hasOwn(attrs,'data-talent-retry')?this:null;}};
          for(const [name,text]of Object.entries(attrs))if(name.startsWith('data-'))button.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=text;
          return button;
        });
      },
      addEventListener(type,listener){const list=listeners.get(type)||[];list.push(listener);listeners.set(type,list);},
      querySelector(selector){
        if(selector==='.talent-details'){const parent=this;return {get innerHTML(){return parent._html.match(/<aside\b[^>]*class="talent-details"[^>]*>([\s\S]*?)<\/aside>/)?.[1]||'';},set innerHTML(value){parent._html=parent._html.replace(/(<aside\b[^>]*class="talent-details"[^>]*>)[\s\S]*?(<\/aside>)/,(_all,opening,closing)=>opening+value+closing);}};}
        const match=selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);return match?this.nodes.find(button=>Object.hasOwn(button.attrs,match[1])&&(match[2]===undefined||button.attrs[match[1]]===match[2])):null;
      },
      querySelectorAll(selector){return selector==='[data-talent-node]'?this.nodes.filter(button=>Object.hasOwn(button.attrs,'data-talent-node')):[];},
      emit(type,target,key){const event={type,target,key,prevented:false,preventDefault(){this.prevented=true;}};for(const listener of listeners.get(type)||[])listener(event);return event;},
      click(selector){return this.emit('click',this.querySelector(selector));},
      key(selector,key){return this.emit('keydown',this.querySelector(selector),key);}};
    return element;
  }
  return {calls,document,host,render:context.window.GuildTalents.render};
}

test('talent tabs have accessible relationships and keyboard navigation selects and focuses a tree',async()=>{
  const p=page(()=>Response.json(payload())),host=p.host();await p.render(member(),host);
  assert.match(host.innerHTML,/role="tablist" aria-label="Talent trees"/);
  const first=host.querySelector('[data-talent-tree="0"]');
  assert.equal(first.getAttribute('role'),'tab');assert.equal(first.getAttribute('aria-selected'),'true');assert.equal(first.getAttribute('tabindex'),'0');
  assert.match(host.innerHTML,new RegExp('role="tabpanel" aria-labelledby="'+first.getAttribute('id')+'"'));
  assert.ok(host.innerHTML.includes('id="'+first.getAttribute('aria-controls')+'"'));
  assert.equal(host.key('[data-talent-tree="0"]','ArrowRight').prevented,true);
  assert.equal(p.document.activeElement.dataset.talentTree,'1');
  assert.equal(host.querySelector('[data-talent-tree="1"]').getAttribute('aria-selected'),'true');
  host.key('[data-talent-tree="1"]','ArrowRight');assert.equal(p.document.activeElement.dataset.talentTree,'0');
  host.key('[data-talent-tree="0"]','End');assert.equal(p.document.activeElement.dataset.talentTree,'1');
  host.key('[data-talent-tree="1"]','Home');assert.equal(p.document.activeElement.dataset.talentTree,'0');
  host.key('[data-talent-tree="0"]','ArrowLeft');assert.equal(p.document.activeElement.dataset.talentTree,'1');
});

test('ranked nodes use returned coordinates and reveal the matching learned-rank description',async()=>{
  const p=page(()=>Response.json(payload())),host=p.host();await p.render(member(),host);
  assert.match(host.innerHTML,/talent-row-1 talent-column-0/);assert.match(host.innerHTML,/talent-row-0 talent-column-1/);
  assert.match(host.innerHTML,/talent-columns-2/);assert.doesNotMatch(host.innerHTML,/\sstyle=/i);
  assert.match(css,/\.talent-row-1\{grid-row:2\}/);assert.match(css,/\.talent-column-1\{grid-column:2\}/);
  const button=host.querySelector('[data-talent-node="0"]');
  host.click('[data-talent-node="0"]');
  assert.equal(host.querySelector('[data-talent-node="0"]'),button,'Reading details must retain the existing grid and its scroll position');
  assert.equal(host.querySelector('[data-talent-node="0"]').getAttribute('aria-pressed'),'true');
  assert.equal(p.document.activeElement.dataset.talentNode,'0');
  assert.match(host.innerHTML,/<h4>Arcane Focus<\/h4>/);assert.match(host.innerHTML,/Description for rank 2/);
  assert.match(host.innerHTML,/Reduces the cost by 2%\./);assert.match(host.innerHTML,/aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(host.innerHTML,/<svg|<line|<path|<img/);
});

test('the initial view opens the first allocated tree and learned node while retaining a later user choice',async()=>{
  const response=payload(1,{trees:[tree(100,'Balance',[node(1,'Starlight Wrath',{rank:0})],{points:0}),
    tree(200,'Feral',[node(2,'Unlearned talent',{rank:0}),node(3,'Ferocity',{rank:4,description_rank:4,row:1})],{points:7})]});
  const p=page(()=>Response.json(response)),first=p.host();await p.render(member(),first);
  assert.equal(first.querySelector('[data-talent-tree="1"]').getAttribute('aria-selected'),'true');
  assert.equal(first.querySelector('[data-talent-node="1"]').getAttribute('aria-pressed'),'true');
  assert.match(first.innerHTML,/<h4>Ferocity<\/h4>/);assert.match(first.innerHTML,/Description for rank 4/);
  first.click('[data-talent-tree="0"]');
  const second=p.host();await p.render(member(),second);
  assert.equal(second.querySelector('[data-talent-tree="0"]').getAttribute('aria-selected'),'true');
  assert.doesNotMatch(second.innerHTML,/\sstyle=/i);
});

test('unknown ranks remain unknown and missing positions produce a list rather than an invented tree',async()=>{
  const response=payload(1,{trees:[tree(1,'Feral',[node(1,'Ferocity',{rank:null,description_rank:1,row:null,column:null}),node(2,'Feral Instinct',{rank:0,description_rank:1,row:null,column:null})],{layout_available:false})]});
  const p=page(()=>Response.json(response)),host=p.host();await p.render(member(),host);
  assert.match(host.innerHTML,/a complete matching tree layout is unavailable/);assert.match(host.innerHTML,/talent-list/);
  assert.match(host.innerHTML,/Rank \? \/ 5/);assert.match(host.innerHTML,/Rank 0 \/ 5/);assert.doesNotMatch(host.innerHTML,/grid-row:/);
  host.click('[data-talent-node="0"]');assert.match(host.innerHTML,/Preview of rank 1/);
  assert.match(host.innerHTML,/<p class="talent-detail-rank">Rank \? \/ 5<\/p>/);
  host.click('[data-talent-node="1"]');assert.match(host.innerHTML,/<p class="talent-detail-rank">Rank 0 \/ 5<\/p>/);
});

test('a redraw preserves the selected tree and talent without repeating a cached request',async()=>{
  const p=page(()=>Response.json(payload())),first=p.host();await p.render(member(),first);
  first.click('[data-talent-tree="1"]');first.click('[data-talent-node="0"]');
  const second=p.host();await p.render(member(),second);
  assert.equal(p.calls.length,1);assert.equal(second.querySelector('[data-talent-tree="1"]').getAttribute('aria-selected'),'true');
  assert.match(second.innerHTML,/<h4>Ice Shards<\/h4>/);assert.equal(second.querySelector('[data-talent-node="0"]').getAttribute('aria-pressed'),'true');
  await p.render(member(1,'2026-11-08T17:15:00.000Z'),second);
  assert.equal(p.calls.length,2);assert.match(second.innerHTML,/<h4>Ice Shards<\/h4>/);
  assert.equal(p.calls[0].path,'/api/characters/1/talents');assert.equal(p.calls[0].options.cache,'no-store');
});

test('a delayed response cannot replace a different character or update a dismissed host',async()=>{
  const waiting=deferred(),p=page(path=>path==='/api/characters/1/talents'?waiting.promise:Response.json(payload(2,{trees:[tree(2,'Restoration',[node(4,'Healing Focus')])]}))),host=p.host();
  const first=p.render(member(1),host);await p.render(member(2),host);
  assert.match(host.innerHTML,/Restoration/);waiting.resolve(Response.json(payload(1)));await first;
  assert.match(host.innerHTML,/Restoration/);assert.doesNotMatch(host.innerHTML,/Arcane Focus/);
  const late=deferred(),other=page(()=>late.promise),closed=other.host(),pending=other.render(member(),closed);
  closed.isConnected=false;const before=closed.innerHTML;late.resolve(Response.json(payload()));await pending;
  assert.equal(closed.innerHTML,before);assert.equal(closed.open,undefined);
});

test('request failures retain saved totals, keep secret error text out of the UI and allow retry',async()=>{
  let attempts=0;const p=page(()=>++attempts===1?new Response('private-upstream-token',{status:500}):Response.json(payload())),host=p.host();
  await p.render(member(),host);assert.match(host.innerHTML,/Arcane/);assert.match(host.innerHTML,/4 points/);
  assert.match(host.innerHTML,/Talent details could not be loaded/);assert.doesNotMatch(host.innerHTML,/private-upstream-token/);
  host.click('[data-talent-retry]');await tick();
  assert.equal(attempts,2);assert.match(host.innerHTML,/Observed talents/);assert.doesNotMatch(host.innerHTML,/could not be loaded/);
});

test('a stale response and a subsequent failed retry keep the observation time and learned nodes',async()=>{
  let attempts=0;const response=payload(1,{status:'stale',observed_at:'2026-11-08T10:00:00.000Z',checked_at:'2026-11-08T17:00:00.000Z',note:'Showing an earlier build.'});
  const p=page(()=>++attempts===1?Response.json(response):Promise.reject(new Error('network unavailable'))),host=p.host();await p.render(member(),host);
  host.click('[data-talent-node="0"]');assert.match(host.innerHTML,/Previous observation/);assert.match(host.innerHTML,/Last attempt:/);
  const observation=host.innerHTML.match(/Previous observation · ([^<]+)/)[1];
  host.click('[data-talent-retry]');await tick();
  assert.ok(host.innerHTML.includes('Previous observation · '+observation));assert.match(host.innerHTML,/Showing the previous observation/);
  assert.match(host.innerHTML,/<h4>Arcane Focus<\/h4>/);
});

test('all returned names, descriptions and notes are escaped and mismatched characters are rejected',async()=>{
  const unsafe='<img src=x onerror=alert(1)>',response=payload(1,{note:unsafe,trees:[tree(100,unsafe,[node(1,unsafe,{description:'</aside><script>secret()</script>'})],{note:unsafe})]});
  const p=page(()=>Response.json(response)),host=p.host();await p.render(member(),host);host.click('[data-talent-node="0"]');
  assert.doesNotMatch(host.innerHTML,/<img|<script>/);assert.match(host.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(host.innerHTML,/&lt;\/aside&gt;&lt;script&gt;secret\(\)&lt;\/script&gt;/);
  const wrong=page(()=>Response.json(payload(999))),other=wrong.host();await wrong.render(member(),other);
  assert.match(other.innerHTML,/could not be loaded/);assert.doesNotMatch(other.innerHTML,/Arcane Focus/);
});
