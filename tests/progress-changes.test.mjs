import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {progressStatements,recordProgress,historyView} from '../src/progress.mjs';
const member={id:71,name:'Example Character'},at='2026-11-09T07:00:00Z';
const skill=(name,id,value,recipes=[])=>({id,name,kind:'Primary',tier:name,skill:value,max_skill:75,recipe_status:'observed',recipes});
const mining=skill('Mining',186,20,[{id:1,name:'Copper Bar'},{id:2,name:'Tin Bar'}]),cooking=skill('Cooking',185,10,[{id:3,name:'Smallfish'}]);
const data=(level=18,professions=[mining,cooking])=>({profile_status:'verified',profile_at:at,profile:{level},professions_status:'verified',professions_at:at,professions});
function fixture(){
  const raw=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params);}
    async first(){return raw.prepare(this.sql).get(...this.params)||null;}
    async all(){return {results:raw.prepare(this.sql).all(...this.params)};}
    async run(){return raw.prepare(this.sql).run(...this.params);}
  }
  const DB={raw,prepare:sql=>new Statement(sql),async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
  return {DB};
}
const snapshotStatement=statements=>statements.find(statement=>statement.sql.includes('INTO snapshots'));
const snapshot=statements=>{const statement=snapshotStatement(statements);return statement?JSON.parse(statement.params[2]):null;};
async function seed(env,index,value){await env.DB.prepare('INSERT INTO snapshots VALUES(?,?,?)').bind(member.id,new Date(Date.UTC(2026,10,1,0,0,index)).toISOString(),JSON.stringify(value)).run();}

test('unchanged level and professions do not create snapshots for new times, errors, stale recovery or reordered arrays',()=>{
  const env=fixture(),before=data(),after={...data(),profile_at:'2026-11-09T08:00:00Z',professions_at:'2026-11-09T08:00:00Z',profile_error:'old failure',checked_at:'a newer check',
    professions:[{...cooking,observed_at:'now'},{...mining,recipes:[...mining.recipes].reverse(),last_error:'temporary'}]};
  assert.equal(snapshot(progressStatements(env,member,before,after)),null);
  assert.equal(snapshot(progressStatements(env,member,{...before,profile_status:'stale',professions_status:'stale'},after)),null);
});

test('a changed skill snapshot lists only that skill, and a profile-only change never re-dates cached professions',()=>{
  const env=fixture(),before=data(),after=data(18,[mining,{...cooking,skill:11}]);
  const changed=snapshot(progressStatements(env,member,before,after));
  assert.deepEqual(changed.changes,['Cooking: 10 → 11 / 75']);assert.equal(changed.level,null);assert.equal(changed.profile_observed_at,null);assert.equal(changed.baseline,false);
  const level=snapshot(progressStatements(env,member,before,{...before,profile:{level:19},profile_at:'2026-11-09T08:00:00Z',professions_status:'stale'}));
  assert.deepEqual(level.changes,['Level: 18 → 19']);assert.equal(level.professions,null);assert.equal(level.professions_observed_at,null);assert.equal(level.profile_observed_at,'2026-11-09T08:00:00Z');
});

test('same-count recipe swaps and observed-empty professions are real changes, while failed checks are not',()=>{
  const env=fixture(),before=data(),replacement={...mining,recipes:[{id:1,name:'Copper Bar'},{id:4,name:'Bronze Bar'}]};
  const changed=snapshot(progressStatements(env,member,before,data(18,[replacement,cooking])));
  assert.deepEqual(changed.changes,['Mining: 1 new recipe observed','Mining: 1 recipe no longer returned']);
  const empty=snapshot(progressStatements(env,member,before,data(18,[])));assert.deepEqual(empty.changes,['Cooking no longer returned','Mining no longer returned']);
  assert.equal(snapshot(progressStatements(env,member,before,{...data(18,[]),profile_status:'unavailable',professions_status:'stale'})),null);
  const baseline=snapshot(progressStatements(env,member,{},data(18,[])));assert.equal(baseline.baseline,true);assert.deepEqual(baseline.changes,['Level first observed: 18','Professions first observed: none returned']);
});

test('new changes keep their before/after labels even when their earlier comparison baseline was not retained as a snapshot',async()=>{
  const env=fixture();await recordProgress(env,member,data(),data(19,[mining,cooking]));
  const history=await historyView(env,71);assert.equal(history.snapshots.length,1);assert.deepEqual(history.snapshots[0].changes,['Level: 18 → 19']);assert.equal(history.snapshots[0].baseline,false);
});

test('legacy repeats and endpoint-only checks compact to one baseline and real changes without losing A to B to A',async()=>{
  const env=fixture(),full={level:18,professions:[mining,cooking]};
  await seed(env,0,full);
  await seed(env,1,{...full,profile_observed_at:'newer',professions:[cooking,{...mining,recipes:[...mining.recipes].reverse()}]});
  await seed(env,2,{level:18,profile_observed_at:'later',professions:null,professions_observed_at:null});
  await seed(env,3,{level:null,profile_observed_at:null,professions:[mining,cooking],professions_observed_at:'later'});
  await seed(env,4,{level:null,professions:[mining,{...cooking,skill:11}]});
  await seed(env,5,full);
  const history=await historyView(env,71);assert.equal(history.snapshots.length,3);assert.deepEqual(history.snapshots[0].changes,['Cooking: 11 → 10 / 75']);assert.deepEqual(history.snapshots[1].changes,['Cooking: 10 → 11 / 75']);
  assert.equal(history.snapshots[2].baseline,true);assert.equal(history.snapshots[2].observed_at,new Date(Date.UTC(2026,10,1)).toISOString());
  assert.equal(history.observations_scanned,6);assert.equal(history.history_truncated,false);
});

test('unknown recipe coverage becoming observed and explicit removal are retained without inventing lost data from null components',async()=>{
  const env=fixture();
  await seed(env,0,{level:18,professions:null});
  await seed(env,1,{level:null,professions:[{...mining,recipe_status:'not_exposed',recipes:[]}]});
  await seed(env,2,{level:null,professions:[mining]});
  await seed(env,3,{level:18,professions:null});
  await seed(env,4,{level:null,professions:[]});
  const history=await historyView(env,71);assert.equal(history.snapshots.length,4);
  assert.deepEqual(history.snapshots[0].changes,['Mining no longer returned']);assert.deepEqual(history.snapshots[1].changes,['Mining: recipe coverage now observed (2 known recipes)']);
  assert.equal(history.snapshots[2].baseline,false);assert.match(history.snapshots[2].changes[0],/Mining first observed/);
});

test('history scans past repeated recent rows to return changes, with an explicit bounded-context warning',async()=>{
  const env=fixture();
  for(let index=0;index<2005;index++)await seed(env,index,{level:index<100?18:19,professions:[mining]});
  const history=await historyView(env,71);assert.equal(history.observations_scanned,2000);assert.equal(history.history_scan_limit,2000);assert.equal(history.history_truncated,true);assert.equal(history.history_has_more,true);
  assert.equal(history.snapshots.length,2);assert.deepEqual(history.snapshots[0].changes,['Level: 18 → 19']);assert.equal(history.snapshots[1].baseline,true);assert.match(history.note,/older context was not scanned/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM snapshots').first()).n,2005,'Reading must not delete legacy rows');
});

test('one check produces separate dated level, skill and named recipe entries while identical later polls add nothing',async()=>{
  const env=fixture(),recipes=[...mining.recipes,{id:9,name:'Bronze Bar'},{id:10,name:'Silver Bar'}];
  await seed(env,0,{level:18,professions:[mining,cooking]});
  await seed(env,1,{level:19,professions:[{...mining,recipes},{...cooking,skill:11}]});
  await seed(env,2,{level:19,professions:[{...cooking,skill:11},{...mining,recipes:[...recipes].reverse()}]});
  const history=await historyView(env,71),when=new Date(Date.UTC(2026,10,1,0,0,1)).toISOString(),events=history.observations.filter(event=>event.observed_at===when);
  assert.equal(events.length,4);assert.equal(events.filter(event=>event.kind==='level').length,1);assert.equal(events.filter(event=>event.kind==='skill').length,1);
  assert.deepEqual(events.filter(event=>event.kind==='recipe').map(event=>event.recipe_name).sort(),['Bronze Bar','Silver Bar']);assert(events.every(event=>event.title&&event.id));assert.equal(new Set(events.map(event=>event.id)).size,4);
  assert.equal(history.observations.length,5);assert.equal(history.observations.at(-1).kind,'baseline');assert.equal(history.observations.at(-1).baseline,true);
  assert(!history.observations.some(event=>event.observed_at===new Date(Date.UTC(2026,10,1,0,0,2)).toISOString()));
});

test('genuine returns and repeated recipe gains keep each original dated occurrence instead of global uniqueness',async()=>{
  const env=fixture(),base={level:18,professions:[mining]},gained={level:19,professions:[{...mining,recipes:[...mining.recipes,{id:9,name:'Bronze Bar'}]}]};
  await seed(env,0,base);await seed(env,1,gained);await seed(env,2,base);await seed(env,3,gained);
  const history=await historyView(env,71),gains=history.observations.filter(event=>event.kind==='recipe'&&event.change==='added'),losses=history.observations.filter(event=>event.kind==='recipe'&&event.change==='removed');
  assert.equal(gains.length,2);assert.equal(losses.length,1);assert(gains.every(event=>event.recipe_name==='Bronze Bar'));assert.notEqual(gains[0].observed_at,gains[1].observed_at);assert.notEqual(gains[0].id,gains[1].id);
  assert.equal(history.observations.filter(event=>event.kind==='level').length,3);assert(history.observations.some(event=>event.title==='Level: 19 → 18'));
});

test('new snapshots retain individual named recipe evidence even without an earlier retained comparison row',async()=>{
  const env=fixture(),after=data(22,[{...mining,skill:21,recipes:[...mining.recipes,{id:9,name:'Bronze Bar'},{id:10,name:'Silver Bar'}]},cooking]);
  await recordProgress(env,member,data(),after);
  const history=await historyView(env,71);assert.equal(history.observations.length,4);assert.equal(history.observations.filter(event=>event.kind==='recipe').length,2);assert(history.observations.some(event=>event.recipe_name==='Bronze Bar'));assert(history.observations.some(event=>event.recipe_name==='Silver Bar'));
  assert(!history.observations.some(event=>event.baseline));assert.equal(history.activity.length,3,'Existing milestone feed remains intact, including its original grouped recipe milestone');
  assert.deepEqual(history.observations.filter(event=>event.kind==='level').map(event=>event.title),['Level: 18 → 22'],'Only observed endpoints are logged; missed intermediate levels must not be invented');
  assert(history.observations.every(event=>event.observed_at===history.snapshots[0].observed_at));
});

test('legacy delta evidence and activity records remain available without guessing missing recipe names',async()=>{
  const env=fixture(),when=new Date(Date.UTC(2026,10,1)).toISOString();
  await seed(env,0,{level:19,professions:[mining],change_schema:1,baseline:false,changes:['Level: 18 → 19','Mining: 2 new recipes observed']});
  await env.DB.prepare('INSERT INTO activity VALUES(?,?,?,?,?,?)').bind('legacy-milestone',71,'recipe','2 new Mining recipes observed for Example Character','Bronze Bar, Silver Bar',when).run();
  const history=await historyView(env,71);assert.equal(history.observations.length,2);assert(history.observations.some(event=>event.title==='Level: 18 → 19'));
  const legacyRecipe=history.observations.find(event=>event.kind==='recipe');assert.match(legacyRecipe.detail,/not the individual recipe names/);assert.equal(legacyRecipe.recipe_name,undefined);assert.equal(legacyRecipe.observed_at,when);assert.equal(history.activity[0].detail,'Bronze Bar, Silver Bar');assert.equal(history.activity[0].observed_at,when);
});

test('granular observation limits are explicit and do not discard or rewrite persisted evidence',async()=>{
  const env=fixture(),many=Array.from({length:130},(_,index)=>({id:1000+index,name:'Recipe '+index}));
  await seed(env,0,{level:18,professions:[{...mining,recipes:[]}]});await seed(env,1,{level:18,professions:[{...mining,recipes:many}]});
  const history=await historyView(env,71);assert.equal(history.observations.length,100);assert.equal(history.observations_limit,100);assert.equal(history.observations_has_more,true);assert.equal(history.history_truncated,false);assert.match(history.note,/latest 100 individual/);
  assert(history.observations.every(event=>event.kind==='recipe'));assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM snapshots').first()).n,2);
});
