import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),source=app.slice(0,app.lastIndexOf('load();setInterval('));
const character=(id,name)=>({id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:'Mage',class_id:8,level:10});
function page(respond){
  const elements=new Map(),calls=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{id,hidden:id==='status',value:'',disabled:false,textContent:'',innerHTML:'',classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){},removeAttribute(){}});return elements.get(id);};
  const context=vm.createContext({document:{hidden:false,getElementById:element,querySelector:()=>element('dialog-close'),querySelectorAll:()=>[],addEventListener(){}},window:{innerWidth:1280,addEventListener(){},dispatchEvent(){}},location:{hash:''},history:{replaceState(){}},CustomEvent:class{constructor(type){this.type=type;}},URL,Blob,Response,Date,setTimeout,clearTimeout,setInterval(){},fetch:async path=>{calls.push(path);return respond(path);}});
  vm.runInContext(source,context);
  return {calls,element,context,load:()=>vm.runInContext('load()',context),names:()=>vm.runInContext('members.map(m=>m.name).join("|")',context),revision:()=>vm.runInContext('status?.sync?.membership_revision',context)};
}

test('new and expired profile memberships reload even when the raw roster generation and timestamp stay unchanged',async()=>{
  let revision='same-roster:a',members=[character(1,'Roster Character')];
  const p=page(path=>path==='/api/status'?Response.json({sync:{published:'same-roster',updated:'same-time',membership_revision:revision,status:'ready'},refresh:{}}):Response.json({generation:'same-roster',revision,members,next:null}));
  await p.load();assert.equal(p.names(),'Roster Character');
  revision='same-roster:b';members=[...members,{...character(2,'Verified Addition'),membership_source:'character_profile',membership_expires_at:new Date(Date.now()+3600000).toISOString()}];
  await p.load();assert.equal(p.names(),'Roster Character|Verified Addition');assert.equal(p.revision(),revision);assert.match(p.element('roster-body').innerHTML,/Verified through character profile/);
  revision='same-roster:c';members=[members[0]];
  await p.load();assert.equal(p.names(),'Roster Character');assert.equal(p.revision(),revision);
  const pages=p.calls.filter(path=>path.startsWith('/api/members'));assert.equal(pages.length,3);
  assert.deepEqual(pages.map(path=>new URL(path,'https://guild.example').searchParams.get('revision')),['same-roster:a','same-roster:b','same-roster:c']);
});

test('mixed membership revisions never commit a partial paginated roster and the next check retries',async()=>{
  let revision='current:a',mixed=false;
  const p=page(path=>{
    if(path==='/api/status')return Response.json({sync:{published:'current',updated:'same-time',membership_revision:revision,status:'ready'},refresh:{}});
    const cursor=new URL(path,'https://guild.example').searchParams.get('cursor');
    return Response.json({generation:'current',revision:mixed&&cursor==='1'?'current:changed':revision,members:[character(cursor==='1'?2:1,cursor==='1'?'Second Character':'First Character')],next:mixed&&cursor==='0'?1:null});
  });
  await p.load();assert.equal(p.names(),'First Character');
  revision='current:b';mixed=true;await p.load();assert.equal(p.names(),'First Character');assert.equal(p.revision(),'current:a');assert.match(p.element('notice').textContent,/membership changed during loading/);
  mixed=false;await p.load();assert.equal(p.revision(),'current:b');
  assert.equal(p.calls.filter(path=>path.includes('revision=current%3Ab')).length,3,'Rejected revision must be retried rather than treated as committed');
});
