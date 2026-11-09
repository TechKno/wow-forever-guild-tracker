import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),hall=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8');
const source=hall.slice(hall.indexOf('  function observationCard('),hall.indexOf('  async function loadHistory('));
test('character observations render only changed values, retain an identified baseline and escape provider text',()=>{
  const context=vm.createContext({});
  vm.runInContext(app.slice(0,app.indexOf('let adminStatus='))+'\nconst esc=value=>escapeHTML(value);\n'+source,context);
  const snapshot={observed_at:'2026-11-09T09:00:00Z',level:18,professions:[{name:'Mining',skill:20,max_skill:75},{name:'Cooking',skill:21,max_skill:75}]};
  const changed=context.observationCard({...snapshot,changes:['Cooking: 20 → 21']});
  assert.match(changed,/Cooking: 20 → 21/);assert.doesNotMatch(changed,/Mining|Level 18/);
  assert.equal(context.observationCard({...snapshot,changes:[]}), '');
  const baseline=context.observationCard({...snapshot,baseline:true});
  assert.match(baseline,/Recorded baseline/);assert.match(baseline,/Level 18/);assert.match(baseline,/Mining: 20 \/ 75/);
  const escaped=context.observationCard({...snapshot,changes:['<img src=x onerror=alert(1)>']});
  assert.match(escaped,/&lt;img/);assert.doesNotMatch(escaped,/<img/);
});

test('the observation log renders separate dated entries for level changes and individual recipes, including later repeated changes',()=>{
  const context=vm.createContext({});
  vm.runInContext(app.slice(0,app.indexOf('let adminStatus='))+'\nconst esc=value=>escapeHTML(value);\n'+source,context);
  const observations=[
    {kind:'level',title:'Level increased to 18',detail:'Previously observed at level 17',observed_at:'2026-11-09T09:00:00Z'},
    {kind:'recipe',title:'New recipe observed: Copper Bar',detail:'Mining',observed_at:'2026-11-09T09:00:00Z'},
    {kind:'level',title:'Level increased to 18',detail:'Previously observed at level 17',observed_at:'2026-11-09T10:00:00Z'}
  ];
  const html=observations.map(context.observationCard).join('');
  assert.equal((html.match(/class="history-entry observation-event"/g)||[]).length,3);
  assert.equal((html.match(/Level increased to 18/g)||[]).length,2);
  assert.match(html,/New recipe observed: Copper Bar/);
  for(const entry of observations)assert(html.includes(vm.runInContext('date('+JSON.stringify(entry.observed_at)+')',context)));
  const escaped=context.observationCard({...observations[1],title:'New recipe: <img src=x>',detail:'<script>bad</script>'});
  assert.match(escaped,/&lt;img/);assert.match(escaped,/&lt;script&gt;/);assert.doesNotMatch(escaped,/<img|<script>/);
});
