import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../public/welcome.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../public/welcome.js',import.meta.url),'utf8');
const settings=JSON.parse(readFileSync(new URL('../guild.config.json',import.meta.url),'utf8'));
const aggregate=(overrides={})=>({guild_name:'Example Guild',region:'EU',ruleset:'Roleplay',game:'World of Warcraft Forever',member_count:15,roster_observed_at:'2026-11-08T17:00:00Z',...overrides});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function page({hash='',search='',response=()=>Response.json(aggregate())}={}){
  const elements=new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match=>[match[1],{textContent:match[1]==='public-member-count'?'—':'',hidden:/\bhidden\b/.test(match[0])}]));
  const redirects=[],calls=[],context=vm.createContext({window:{location:{hash,search,replace:path=>redirects.push(path)}},
    document:{getElementById(id){assert(elements.has(id),'The landing page must provide control '+id);return elements.get(id);}},URLSearchParams,Date,
    fetch:async(path,options)=>{calls.push({path,options});return response();}});
  vm.runInContext(source,context);
  return {elements,redirects,calls,element:id=>elements.get(id)};
}

test('the landing page loads only public aggregate data and labels the count as characters including alts',async()=>{
  const p=page();await tick();
  assert.equal(p.element('public-member-count').textContent,'15');assert.match(p.element('public-roster-status').textContent,/^Roster checked /);
  assert.equal(p.calls.length,1);assert.equal(p.calls[0].path,'/api/public');assert.equal(p.calls[0].options.credentials,'omit');
  assert.match(html,/>Guild characters</);assert.match(html,/Verified guild characters,/);assert.match(html,/including mains and alts/);
  assert.deepEqual(p.redirects,[],'Visiting the public root must not automatically enter the private guildhall');
});

test('zero is an observed count while null or invalid counts remain unavailable',async()=>{
  const zero=page({response:()=>Response.json(aggregate({member_count:0}))});await tick();assert.equal(zero.element('public-member-count').textContent,'0');
  for(const member_count of [null,-1,1.5,'15','<script>unsafe()</script>']){
    const p=page({response:()=>Response.json(aggregate({member_count}))});await tick();
    assert.equal(p.element('public-member-count').textContent,'—');assert.equal(p.element('public-roster-status').textContent,'Guild count is currently unavailable.');
  }
});

test('public totals explicitly distinguish profile-verified characters from the guild roster',async()=>{
  const p=page({response:()=>Response.json(aggregate({member_count:17,roster_member_count:15,profile_verified_count:2}))});await tick();
  assert.equal(p.element('public-member-count').textContent,'17');assert.match(p.element('public-roster-status').textContent,/^15 from roster · 2 verified through character profiles · Roster checked /);
  const zero=page({response:()=>Response.json(aggregate({roster_member_count:15,profile_verified_count:0}))});await tick();assert.match(zero.element('public-roster-status').textContent,/^Roster checked /);
  for(const profile_verified_count of [999,'2',-1,'<script>bad()</script>']){
    const invalid=page({response:()=>Response.json(aggregate({roster_member_count:15,profile_verified_count}))});await tick();
    assert.equal(invalid.element('public-member-count').textContent,'15');assert.doesNotMatch(invalid.element('public-roster-status').textContent,/999|<script>|verified through character/);
  }
});

test('unavailable or unexpected public responses never expose supplied errors or private fields',async()=>{
  for(const response of [()=>Promise.reject(new Error('private-session-token')),()=>new Response('private-provider-secret',{status:500}),
    ()=>Response.json(aggregate({guild_name:'A different guild',member_count:999,characters:[{name:'Private character'}]})),
    ()=>Response.json({error:'private-session-token'})]){
    const p=page({response});await tick();
    assert.equal(p.element('public-member-count').textContent,'—');
    assert.equal(p.element('public-roster-status').textContent,'Guild count is currently unavailable.');
    assert.doesNotMatch([...p.elements.values()].map(element=>element.textContent).join(' '),/private|Private character|999/);
  }
});

test('a count without a valid observation time is shown without inventing freshness',async()=>{
  for(const roster_observed_at of [null,'not-a-date']){
    const p=page({response:()=>Response.json(aggregate({roster_observed_at}))});await tick();
    assert.equal(p.element('public-member-count').textContent,'15');
    assert.equal(p.element('public-roster-status').textContent,'Guild count available · roster check time unavailable');
  }
});

test('every supported old dashboard fragment goes through the private guildhall entry',()=>{
  for(const route of ['overview','roster','hall','crafting','events','members','recipes','professions','history','adventures','status','wishlists']){
    const p=page({hash:'#'+route});assert.deepEqual(p.redirects,['/guild#'+route]);assert.equal(p.calls.length,0);
  }
});

test('public anchors and unknown fragments do not redirect or become arbitrary destinations',async()=>{
  for(const hash of ['','#about','#main','#https://foreign.example','#roster/../../private','#roster?redirect=https://foreign.example','#ROSTER']){
    const p=page({hash});await tick();assert.deepEqual(p.redirects,[]);assert.equal(p.calls.length,1);
  }
});

test('the unverified-account notice is generic and offers a static Battle.net retry',async()=>{
  const p=page({search:'?access=unverified&display_name=private-user-name'});await tick();
  assert.equal(p.element('eligibility-notice').hidden,false);assert.deepEqual(p.redirects,[]);
  assert.match(html,/href="\/auth\/login">Try Battle.net again/);assert.doesNotMatch(html,/private-user-name/);
  for(const search of ['', '?access=other']){const normal=page({search});await tick();assert.equal(normal.element('eligibility-notice').hidden,true);}
});

test('landing metadata, local assets and guildhall links remain compatible with the self-only CSP',()=>{
  assert(html.includes('<link rel="canonical" href="'+settings.site.origin+'/">'));
  assert(html.includes('<meta property="og:url" content="'+settings.site.origin+'/">'));
  assert(html.includes('<img class="welcome-art" src="'+settings.site.hero+'" width="1600" height="800"'));
  assert(html.includes('<link rel="icon" type="image/svg+xml" href="'+settings.site.logo+'">'));
  assert.match(html,/<link rel="stylesheet" href="\/welcome\.css">/);assert.match(html,/<script src="\/welcome\.js" defer><\/script>/);
  assert.doesNotMatch(html,/\sstyle=|<style\b|\sonclick=|https:\/\/fonts\./i);
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){assert.match(match[1],/\bsrc="\//);assert.equal(match[2].trim(),'');}
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length);
  const entries=[...html.matchAll(/<a\b[^>]*href="([^\"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter(match=>/Enter the guildhall|Member sign in/.test(match[2]));
  assert.equal(entries.length,3);for(const entry of entries)assert.equal(entry[1],'/guild');
  assert.match(html,/href="\/privacy\.html"/);
});
