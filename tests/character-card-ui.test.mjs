import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/character-card.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div',classes=''){this.tagName=tag.toUpperCase();this.className=classes;this.children=[];this.parentNode=null;this.attributes={};this.handlers=new Map();this.hidden=false;this.scrollTop=0;this.textContent='';this.focused=false;this.classList={toggle:(name,on)=>{const values=new Set(this.className.split(' ').filter(Boolean));on?values.add(name):values.delete(name);this.className=[...values].join(' ');}};}
 get nextSibling(){if(!this.parentNode)return null;const list=this.parentNode.children;return list[list.indexOf(this)+1]||null;}
 setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key]??null;}
 appendChild(child){child.remove();child.parentNode=this;this.children.push(child);return child;}
 insertBefore(child,before){if(before===null)return this.appendChild(child);child.remove();const index=this.children.indexOf(before);assert(index>=0);child.parentNode=this;this.children.splice(index,0,child);return child;}
 remove(){if(this.parentNode){const list=this.parentNode.children;list.splice(list.indexOf(this),1);this.parentNode=null;}}
 matches(selector){if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));const attribute=selector.match(/^\[([^\]]+)\]$/);return attribute?Object.hasOwn(this.attributes,attribute[1]):false;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)||null;}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 addEventListener(type,fn){this.handlers.set(type,fn);}removeEventListener(type,fn){if(this.handlers.get(type)===fn)this.handlers.delete(type);}
 focus(){this.focused=true;}scrollIntoView(){this.scrolledIntoView=true;}
}
const classes=['character-armory','character-talents','character-role-summary','character-freshness','character-professions','character-data-status'];
function content(){const root=new Element();root.appendChild(new Element('div','eyebrow'));const title=new Element('h2','detail-title');title.textContent='Fictional Adventurer';root.appendChild(title);const intro=new Element('p');intro.textContent='Priest · Level 20';root.appendChild(intro);const blocks=Object.fromEntries(classes.map(name=>{const block=new Element('section',name);block.textContent=name;root.appendChild(block);return [name,block];}));return {root,title,intro,blocks};}
function fixture(){const events=new Map(),window={addEventListener(type,fn){events.set(type,fn);}},context=vm.createContext({window,document:{createElement:tag=>new Element(tag)}});vm.runInContext(source,context);return {api:window.GuildCharacterCard,events};}
function tabs(root){return root.querySelectorAll('[data-character-tab]');}
function panel(root,name){const button=tabs(root).find(tab=>tab.getAttribute('data-character-tab')===name),id=button.getAttribute('aria-controls');return root.querySelectorAll('[role]').find(node=>node.id===id);}
function activate(root,name){const wrapper=root.querySelector('[data-character-card-tabs]'),button=tabs(root).find(tab=>tab.getAttribute('data-character-tab')===name);wrapper.handlers.get('click')({target:button});return button;}
function keyboard(root,name,key){let prevented=false;const wrapper=root.querySelector('[data-character-card-tabs]'),button=tabs(root).find(tab=>tab.getAttribute('data-character-tab')===name);wrapper.handlers.get('keydown')({target:button,key,preventDefault(){prevented=true;}});return prevented;}

test('the character card moves existing live hosts into four labelled tabs while preserving its header',()=>{
 const p=fixture(),card=content();const marker=()=>{};card.blocks['character-armory'].addEventListener('click',marker);p.api.mount(card.root,{id:71});
 assert.equal(tabs(card.root).length,4);assert.equal(card.root.children[1],card.title);assert.equal(card.root.children[2],card.intro);assert.equal(card.root.children[3].getAttribute('data-character-card-tabs'),'');
 assert.deepEqual(panel(card.root,'character').children,[card.blocks['character-armory'],card.blocks['character-role-summary']]);assert.equal(panel(card.root,'talents').children[0],card.blocks['character-talents']);assert.equal(panel(card.root,'professions').children[0],card.blocks['character-professions']);assert.deepEqual(panel(card.root,'details').children,[card.blocks['character-freshness'],card.blocks['character-data-status']]);assert.equal(card.blocks['character-armory'].handlers.get('click'),marker);
 const buttons=tabs(card.root);assert.deepEqual(buttons.map(button=>button.textContent),['Character','Talents','Professions','Details']);for(const button of buttons){const target=panel(card.root,button.getAttribute('data-character-tab'));assert.equal(button.getAttribute('role'),'tab');assert.equal(target.getAttribute('role'),'tabpanel');assert.equal(target.getAttribute('aria-labelledby'),button.id);assert.equal(target.hidden,button.textContent!=='Character');assert.equal(button.tabIndex,button.textContent==='Character'?0:-1);}
});

test('click and Arrow/Home/End navigation select and focus the corresponding tab with wraparound',()=>{
 const p=fixture(),card=content();p.api.mount(card.root,{id:71});activate(card.root,'professions');assert.equal(panel(card.root,'professions').hidden,false);assert.equal(panel(card.root,'character').hidden,true);
 assert(keyboard(card.root,'professions','ArrowRight'));assert.equal(panel(card.root,'details').hidden,false);assert(tabs(card.root).find(tab=>tab.textContent==='Details').focused);
 keyboard(card.root,'details','ArrowRight');assert.equal(panel(card.root,'character').hidden,false);keyboard(card.root,'character','ArrowLeft');assert.equal(panel(card.root,'details').hidden,false);keyboard(card.root,'details','Home');assert.equal(panel(card.root,'character').hidden,false);keyboard(card.root,'character','End');assert.equal(panel(card.root,'details').hidden,false);assert.equal(keyboard(card.root,'details','Tab'),false);
});

test('same-character redraws preserve the selected tab and panel scroll but a different character starts at Character',()=>{
 const p=fixture(),card=content();p.api.mount(card.root,{id:71});activate(card.root,'talents');panel(card.root,'talents').scrollTop=135;
 const replacement=content();for(const node of [...card.root.children])node.remove();for(const node of [...replacement.root.children])card.root.appendChild(node);p.api.mount(card.root,{id:71});assert.equal(panel(card.root,'talents').hidden,false);assert.equal(panel(card.root,'talents').scrollTop,135);assert.equal(card.root.querySelectorAll('[data-character-card-tabs]').length,1);
 p.api.mount(card.root,{id:72});assert.equal(panel(card.root,'character').hidden,false);assert.equal(panel(card.root,'talents').hidden,true);assert.equal(panel(card.root,'talents').scrollTop,0);
});

test('closing or access-reset clears tab state so reopening selects Character without refetching or duplicating nodes',()=>{
 const p=fixture(),card=content();p.api.mount(card.root,{id:71});activate(card.root,'details');p.api.reset();assert.equal(panel(card.root,'character').hidden,false);p.api.mount(card.root,{id:71});assert.equal(panel(card.root,'character').hidden,false);assert.equal(card.root.querySelectorAll('.character-armory').length,1);activate(card.root,'professions');p.events.get('guild-access-reset')();p.api.mount(card.root,{id:71});assert.equal(panel(card.root,'character').hidden,false);
 assert.doesNotMatch(source,/\bfetch\s*\(/,'Tabs reuse the existing armory/talent hosts without issuing their own requests');
});

test('missing sections have explicit unavailable text instead of fabricated statistics and invalid characters do not mount',()=>{
 const p=fixture(),card=content();for(const block of Object.values(card.blocks))block.remove();p.api.mount(card.root,{id:71});assert.match(panel(card.root,'talents').children[0].textContent,/not been returned/);assert.match(panel(card.root,'professions').children[0].textContent,/not been returned/);assert.equal(panel(card.root,'character').hidden,false);
 for(const id of [0,-1,'invalid',1.5]){const empty=content();p.api.mount(empty.root,{id});assert.equal(empty.root.querySelector('[data-character-card-tabs]'),null);}
});

test('responsive tabs provide one bounded scroll region per selected panel and retain visible focus controls',()=>{
 const css=readFileSync(new URL('../public/character-card.css',import.meta.url),'utf8');assert.match(css,/character-card-panel\{[^}]*overflow:auto/);assert.match(css,/max-height:calc\(100dvh/);assert.match(css,/@media\(max-width:760px\)/);assert.match(css,/character-card-tab:focus-visible/);assert.match(css,/character-card-tablist\{[^}]*overflow-x:auto/);
});
