import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {CONFIG,validateConfig,providerURL,deploymentIdentity,ensureDeploymentIdentity} from '../src/config.mjs';
import {validateRoster} from '../src/logic.mjs';
import {candidateFromAccount,validateProfileMember,profileMemberStatement} from '../src/guild-membership.mjs';
const copy=()=>structuredClone(CONFIG);
function alternative(){const value=copy();value.guild={name:'Stormwind Artisans',slug:'stormwind-artisans',region:'us',locale:'en_US',ruleset:{id:2,name:'PvP'}};value.site.origin='https://artisans.example.org';value.site.additionalOrigins=['https://old-artisans.example.org'];return validateConfig(value);}
function database(){
  const raw=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  class Statement{constructor(sql,params=[]){this.sql=sql;this.params=params;}bind(...params){return new Statement(this.sql,params);}async first(){return raw.prepare(this.sql).get(...this.params)||null;}async run(){return raw.prepare(this.sql).run(...this.params);}}
  return {raw,prepare:sql=>new Statement(sql)};
}
test('another guild, region and ruleset drive API URLs and exact roster/profile membership validation',()=>{
  const config=alternative(),guild={id:501,name:config.guild.name,ruleset:{id:2}},character={id:71,name:'Example',surname:'Adventurer',slug:'example-adventurer'};
  assert.equal(providerURL('/profile/user/wow','profile',config),'https://us.api.blizzard.com/profile/user/wow?namespace=profile-forever-us&locale=en_US');
  const roster={guild:{id:501},members:[{character,rank:1}]};
  assert.equal(validateRoster({id:2,name:'PvP'},guild,roster,config)[0].id,71);
  assert.throws(()=>validateRoster({id:2,name:'PvP'},guild,roster));
  const candidate=candidateFromAccount(character),profile={...character,ruleset:{id:2},guild:{id:501,name:config.guild.name},level:12};
  assert.equal(validateProfileMember(profile,candidate,{id:501,name:config.guild.name,ruleset:'US PvP'},Date.now(),config).ruleset_id,2);
  assert.throws(()=>validateProfileMember({...profile,guild:{id:99,name:config.guild.name}},candidate,{id:501,name:config.guild.name,ruleset:'US PvP'},Date.now(),config));
  assert.throws(()=>validateProfileMember(profile,candidate,{id:501,name:config.guild.name,ruleset:'EU PvP'},Date.now(),config));
});
test('configuration rejects secret fields, remote artwork, origin injection and unbounded refresh intervals',()=>{
  const invalid=[
    value=>value.client_secret='do-not-store-secrets-here',value=>value.guild.region='xx',value=>value.guild.slug='../../another-guild',
    value=>value.guild.ruleset.id='3',value=>value.site.origin='https://member:password@example.org',value=>value.site.origin='http://example.org',
    value=>value.site.origin='https://example.org/callback',value=>value.site.additionalOrigins=['https://example.org/?next=elsewhere'],
    value=>value.site.logo='https://remote.example/image.svg',value=>value.site.hero='/assets/../private.txt',
    value=>value.site.theme.accent='red;display:none',value=>value.refresh.activeSeconds=0,value=>value.refresh.rosterSeconds=1,
    value=>value.refresh.inactiveSeconds=value.refresh.activeSeconds-1
  ];
  for(const mutate of invalid){const value=copy();mutate(value);assert.throws(()=>validateConfig(value));}
  for(const path of ['https://evil.example/profile/user/wow','//evil.example/profile/user/wow','/profile/user/wow?namespace=evil','/profile/../data\\evil'])assert.throws(()=>providerURL(path));
  const value=copy();value.site.additionalOrigins=['https://old.example.org/','https://old.example.org'];
  assert.deepEqual(validateConfig(value).site.additionalOrigins,['https://old.example.org']);
});
test('database guild bindings are initialized atomically and cannot be reused for another configured guild',async()=>{
  const DB=database(),env={DB},other=alternative();
  await ensureDeploymentIdentity(env,other);await ensureDeploymentIdentity(env,other);
  assert.deepEqual(JSON.parse((await DB.prepare("SELECT value FROM state WHERE key='deployment_identity'").first()).value),deploymentIdentity(other));
  await assert.rejects(ensureDeploymentIdentity(env),/another guild/);
  const existing=database();await existing.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify({id:501,name:other.guild.name,ruleset:'US PvP'})).run();
  await assert.rejects(ensureDeploymentIdentity({DB:existing}),/another guild/);
  assert.equal(await existing.prepare("SELECT value FROM state WHERE key='deployment_identity'").first(),null);
});
test('configured non-default rulesets remain protected by the SQL membership view and exact guild identity',async()=>{
  const config=alternative(),DB=database(),env={DB},at=new Date().toISOString();await ensureDeploymentIdentity(env,config);
  await DB.prepare("UPDATE sync SET published='current' WHERE id=1").run();
  await DB.prepare("INSERT INTO state(key,value) VALUES('guild',?)").bind(JSON.stringify({id:501,name:config.guild.name,ruleset:'US PvP'})).run();
  await DB.prepare("INSERT INTO users(id,subject_hash,ownership_status,ownership_checked,created_at,updated_at) VALUES('owner','synthetic','verified',unixepoch(),?,?)").bind(at,at).run();
  await DB.prepare("INSERT INTO character_links(character_id,user_id,verified_at) VALUES(71,'owner',?)").bind(at).run();
  const candidate=candidateFromAccount({id:71,name:'Example',surname:'Adventurer'}),guild={id:501,name:config.guild.name,ruleset:'US PvP'};
  const proof=validateProfileMember({...candidate,ruleset:{id:2},guild:{id:501,name:config.guild.name},level:12},candidate,guild,Date.now(),config);
  await profileMemberStatement(env,'owner',proof,config).run();
  assert.equal((await DB.prepare('SELECT COUNT(*) count FROM verified_membership').first()).count,1);
  await DB.prepare("UPDATE state SET value=json_set(value,'$.name','Another Guild') WHERE key='guild'").run();
  assert.equal((await DB.prepare('SELECT COUNT(*) count FROM verified_membership').first()).count,0);
});
