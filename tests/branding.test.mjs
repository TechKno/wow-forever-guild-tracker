import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import vm from 'node:vm';
import {buildBranding} from '../scripts/build-branding.mjs';

const settings=JSON.parse(await readFile(new URL('../guild.config.json',import.meta.url),'utf8'));
async function withOutput(run){
  const prefix=join(tmpdir(),'guild-branding-'),folder=await mkdtemp(prefix);
  try{return await run(folder);}finally{if(!resolve(folder).startsWith(resolve(prefix)))throw Error('Unexpected temporary output path');await rm(folder,{recursive:true,force:true});}
}
const files=async directory=>Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name=>[name,await readFile(join(directory,name),'utf8')])));
test('branding rebuilds deterministically from templates after switching to another guild and back',()=>withOutput(async outputDir=>{
  await buildBranding(settings,{outputDir});const original=await files(outputDir);
  const alternate=structuredClone(settings);alternate.guild.name='Dawnward Company';alternate.guild.slug='dawnward-company';alternate.guild.region='us';alternate.guild.locale='en_US';alternate.guild.ruleset={id:2,name:'PvP'};
  Object.assign(alternate.site,{origin:'https://dawnward.example',title:'Dawnward Ledger',tagline:'Find your next adventure.',description:'Adventurers of the Dawnward Company.',motto:'Together at dawn.',theme:{accent:'#327a68',background:'#faf9ee'}});alternate.discord.botName='The Herald';
  await buildBranding(alternate,{outputDir});const changed=await files(outputDir),joined=Object.values(changed).join('\n');
  for(const value of ['Dawnward Company','Dawnward Ledger','Together at dawn.','The Herald','US PvP','https://dawnward.example'])assert(joined.includes(value),'Missing configured branding '+value);
  for(const value of [settings.guild.name,settings.discord.botName,new URL(settings.site.origin).hostname])assert(!joined.includes(value),'Old branding remained: '+value);
  assert(changed['brand.css'].includes('--brand-accent:#327a68'));
  assert(changed['welcome.html'].includes('href="/assets/guild-logo.svg"'));
  assert(changed['privacy.html'].includes('Dawnward Company, US PvP'));
  for(const [guildName,expected]of [[alternate.guild.name,'7'],[settings.guild.name,'—']]){
    const elements=new Map(['public-member-count','public-roster-status','eligibility-notice'].map(id=>[id,{textContent:'',hidden:true}]));
    const context=vm.createContext({window:{location:{hash:'',search:'',replace(){}}},document:{getElementById:id=>elements.get(id)},URLSearchParams,Date,
      fetch:async()=>Response.json({guild_name:guildName,region:'US',ruleset:'PvP',member_count:7,roster_observed_at:'2026-11-09T12:00:00Z'})});
    vm.runInContext(changed['welcome.js'],context);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(elements.get('public-member-count').textContent,expected,'The public page must verify the configured guild, region and ruleset');
  }
  await buildBranding(settings,{outputDir});assert.deepEqual(await files(outputDir),original);
}));

test('branding escapes markup and JavaScript while emitting only public allowlisted settings',()=>withOutput(async outputDir=>{
  const alternate=structuredClone(settings);alternate.guild.name='A & B <Guild> "Friends"';alternate.site.title='Ledger </title><script>bad()</script>';
  alternate.site.tagline='A "quoted" welcome & company';alternate.site.description='Description <img src=x onerror=bad()>';
  alternate.site.motto='Together <always>';alternate.discord.botName='Herald </script> & friends';
  const prior=process.env.BLIZZARD_CLIENT_SECRET;process.env.BLIZZARD_CLIENT_SECRET='sentinel-private-provider-credential';
  try{await buildBranding(alternate,{outputDir});}finally{prior===undefined?delete process.env.BLIZZARD_CLIENT_SECRET:process.env.BLIZZARD_CLIENT_SECRET=prior;}
  const output=await files(outputDir),html=output['welcome.html'];
  assert(html.includes('A &amp; B &lt;Guild&gt; &quot;Friends&quot;'));
  assert(!html.includes('<script>bad()'));assert(!html.includes('<img src=x onerror='));
  for(const filename of ['app.js','hall.js','welcome.js','adventures.js'])assert.doesNotThrow(()=>new vm.Script(output[filename]));
  const prefix=output['app.js'].slice(0,output['app.js'].indexOf('const $='));
  const context=vm.createContext({});vm.runInContext(prefix,context);
  assert.equal(vm.runInContext('SITE_BRAND.guildName',context),alternate.guild.name);
  assert.equal(vm.runInContext('SITE_BRAND.botName',context),alternate.discord.botName);
  const joined=Object.values(output).join('\n');
  for(const privateValue of ['sentinel-private-provider-credential','ADMIN_USER_IDS','BLIZZARD_CLIENT_SECRET','DISCORD_BOT_TOKEN']){
    // Setup guidance in the private administrator page may name a secret, but
    // the generated public branding object and landing/privacy pages never do.
    const publicBrand=prefix+output['welcome.js']+output['welcome.html']+output['privacy.html']+output['brand.css'];
    assert(!publicBrand.includes(privateValue));
  }
  assert(!joined.includes('sentinel-private-provider-credential'));
  const unsafe=structuredClone(settings);unsafe.site.theme.accent='red; background:url(https://evil.example)';
  await assert.rejects(buildBranding(unsafe,{outputDir}),/Theme colours/);
  const forbidden=structuredClone(settings);forbidden.BLIZZARD_CLIENT_SECRET='should-not-be-accepted';
  await assert.rejects(buildBranding(forbidden,{outputDir}),/Invalid configuration section/);
}));
