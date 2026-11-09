import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {mutateHall,sessionView,hallView} from '../src/community.mjs';
import {ORIGIN,random,digest} from '../src/auth.mjs';
const epoch=()=>Math.floor(Date.now()/1000);
async function fixture(){
 const raw=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let beforeBatch=()=>{};
 class Statement{constructor(sql,params=[]){this.sql=sql;this.params=params;}bind(...params){return new Statement(this.sql,params);}async first(){return raw.prepare(this.sql).get(...this.params)||null;}async all(){return {results:raw.prepare(this.sql).all(...this.params)};}async run(){return raw.prepare(this.sql).run(...this.params);}}
 const DB={raw,prepare:sql=>new Statement(sql),async batch(statements){beforeBatch();raw.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}}};
 raw.exec("UPDATE sync SET published='current' WHERE id=1");const at=new Date().toISOString(),token=random(),csrf=random();
 for(const [uid,main]of [['owner',101],['other',201]])raw.prepare('INSERT INTO users VALUES(?,?,?,\'verified\',?,?,?)').run(uid,'fixture-'+uid,main,epoch(),at,at);
 for(const [id,uid,name,alt]of [[101,'owner','Alpha Main',0],[102,'owner','Beta Alt',1],[103,'owner','Separate Character',0],[201,'other','Foreign Character',0]]){raw.prepare('INSERT INTO membership VALUES(?,?,?,?)').run('current',name.toLowerCase().replaceAll(' ','-'),id,JSON.stringify({id,name,slug:name.toLowerCase().replaceAll(' ','-'),class:'Mage',level:20}));raw.prepare('INSERT INTO character_links(character_id,user_id,verified_at,show_as_alt) VALUES(?,?,?,?)').run(id,uid,at,alt);}
 raw.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(await digest(token),'owner',csrf,epoch()+3600);
 const request=(body,path='/api/hall/main')=>new Request(ORIGIN+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{Cookie:'__Host-wv_session='+token,Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrf}});
 return {raw,env:{DB},request,hook(fn){beforeBatch=fn;}};
}
test('main and alt saves publish a canonical revision and keep explicitly separate characters separate',async()=>{
 const f=await fixture(),result=await mutateHall(f.request({character_id:102,alt_ids:[101]}),f.env),session=await sessionView(f.request(null,'/api/me'),f.env);
 assert.equal(session.main_character_id,102);assert.equal(session.account_updated_at,result.account_updated_at);assert.deepEqual(session.player_links.filter(row=>row.user_id==='owner').map(row=>[row.character_id,row.main_character_id]),[[101,102],[102,102]]);
 assert.deepEqual(f.raw.prepare('SELECT character_id,show_as_alt FROM character_links WHERE user_id=? ORDER BY character_id').all('owner').map(row=>[row.character_id,row.show_as_alt]),[[101,1],[102,0],[103,0]]);
 const hall=await hallView(f.request(null,'/api/hall'),f.env),group=hall.display_groups.find(row=>row.character_ids.includes(102));assert.deepEqual(group.character_ids,[102,101]);assert.equal(group.main_character_id,102);assert(!group.character_ids.includes(103));
});
test('foreign characters cannot become a main or selected alt',async()=>{
 const f=await fixture();for(const body of [{character_id:201,alt_ids:[101]},{character_id:101,alt_ids:[201]}])await assert.rejects(mutateHall(f.request(body),f.env),error=>[400,403].includes(error.status));
 assert.equal(f.raw.prepare('SELECT main_character_id FROM users WHERE id=?').get('owner').main_character_id,101);
});
test('ownership changes before the atomic save reject the main and preserve existing alt preferences',async()=>{
 const f=await fixture();f.hook(()=>{f.raw.prepare('UPDATE character_links SET user_id=? WHERE character_id=102').run('other');});
 await assert.rejects(mutateHall(f.request({character_id:102,alt_ids:[101]}),f.env),error=>error.status===403);
 assert.equal(f.raw.prepare('SELECT main_character_id FROM users WHERE id=?').get('owner').main_character_id,101);assert.equal(f.raw.prepare('SELECT show_as_alt FROM character_links WHERE character_id=101').get().show_as_alt,0);
});
test('a departed main has the same current fallback in account, roster links and member directory',async()=>{
 const f=await fixture();f.raw.prepare('DELETE FROM membership WHERE character_id=101').run();f.raw.prepare('UPDATE character_links SET show_as_alt=1 WHERE character_id=103').run();f.raw.prepare('UPDATE character_links SET show_as_alt=0 WHERE character_id=102').run();
 const session=await sessionView(f.request(null,'/api/me'),f.env),hall=await hallView(f.request(null,'/api/hall'),f.env);
 assert.equal(session.main_character_id,102);assert.deepEqual(session.player_links.filter(row=>row.user_id==='owner').map(row=>[row.character_id,row.main_character_id]),[[102,102],[103,102]]);
 const person=hall.people.find(row=>row.characters.some(character=>character.id===102));assert(person.characters.find(character=>character.id===102).is_main);assert.equal(hall.display_groups.find(row=>row.character_ids.includes(102)).main_character_id,102);
 assert.equal(f.raw.prepare('SELECT main_character_id FROM users WHERE id=?').get('owner').main_character_id,101,'display fallback does not rewrite the saved choice');
});
