import raw from '../guild.config.json' with {type:'json'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function section(value,keys,path){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('Invalid configuration section: '+path);return value;}
function text(value,path,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw Error('Invalid configuration text: '+path);return value.trim();}
function origin(value){const v=text(value,'site origin',500);let url;try{url=new URL(v);}catch{throw Error('Invalid site origin');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Site origins must be HTTPS origins without paths or credentials');return url.origin;}
function asset(value){const v=text(value,'asset path',240);if(!/^\/assets\/[A-Za-z0-9_./-]+\.(svg|png|webp|jpe?g)$/i.test(v)||v.includes('..')||v.includes('//'))throw Error('Brand images must be local files in /assets/');return v;}
function integer(value,min,max,path){if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid configuration interval or identifier: '+path);return value;}
function freeze(value){if(object(value)||Array.isArray(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function validateConfig(value){
  section(value,['guild','site','discord','refresh'],'root');
  const guild=section(value.guild,['name','slug','region','locale','ruleset'],'guild'),site=section(value.site,['origin','additionalOrigins','title','tagline','description','motto','logo','hero','theme'],'site');
  const ruleset=section(guild.ruleset,['id','name'],'guild.ruleset'),theme=section(site.theme,['accent','background'],'site.theme'),discord=section(value.discord,['botName'],'discord'),refresh=section(value.refresh,['rosterSeconds','activeSeconds','inactiveSeconds'],'refresh');
  const region=text(guild.region,'region',2).toLowerCase();if(!['eu','us'].includes(region))throw Error('Supported Forever API regions are eu and us; only EU Roleplay has live verification');
  const locale=text(guild.locale,'locale',5);if(!/^[a-z]{2}_[A-Z]{2}$/.test(locale))throw Error('Locale must use a form such as en_GB');
  const slug=text(guild.slug,'guild.slug',160);if(!/^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u.test(slug)||slug!==slug.toLowerCase())throw Error('Guild slug must be a lowercase hyphen-separated identifier');
  if(!Array.isArray(site.additionalOrigins)||site.additionalOrigins.length>8)throw Error('Use at most eight additional site origins');
  const canonical=origin(site.origin),additional=[...new Set(site.additionalOrigins.map(origin))].filter(item=>item!==canonical);
  for(const color of [theme.accent,theme.background])if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))throw Error('Theme colours must be six-digit hex values');
  const active=integer(refresh.activeSeconds,60,86400,'activeSeconds');
  return freeze({guild:{name:text(guild.name,'guild.name',100),slug,region,locale,ruleset:{id:integer(ruleset.id,1,1000,'ruleset.id'),name:text(ruleset.name,'ruleset.name',80)}},site:{origin:canonical,additionalOrigins:additional,title:text(site.title,'site.title',100),tagline:text(site.tagline,'site.tagline',240),description:text(site.description,'site.description',2000),motto:text(site.motto,'site.motto',240),logo:asset(site.logo),hero:asset(site.hero),theme:{accent:theme.accent,background:theme.background}},discord:{botName:text(discord.botName,'discord.botName',80)},refresh:{rosterSeconds:integer(refresh.rosterSeconds,60,86400,'rosterSeconds'),activeSeconds:active,inactiveSeconds:integer(refresh.inactiveSeconds,active,604800,'inactiveSeconds')}});
}
export const CONFIG=validateConfig(raw);
export const GUILD=CONFIG.guild.name,SLUG=CONFIG.guild.slug,REGION=CONFIG.guild.region,LOCALE=CONFIG.guild.locale,RULESET_ID=CONFIG.guild.ruleset.id,RULESET_NAME=CONFIG.guild.ruleset.name;
export const RULESET_LABEL=REGION.toUpperCase()+' '+RULESET_NAME,API_ORIGIN='https://'+REGION+'.api.blizzard.com';
export const ORIGIN=CONFIG.site.origin,LEGACY_ORIGIN=CONFIG.site.additionalOrigins[0]||ORIGIN,CALLBACK=ORIGIN+'/auth/callback';
export const SITE_ORIGINS=new Set([ORIGIN,...CONFIG.site.additionalOrigins]);
export const isSiteOrigin=value=>SITE_ORIGINS.has(value);
export const PUBLIC_ASSET_PATHS=new Set(['/brand.css',CONFIG.site.logo,CONFIG.site.hero]);
export function providerURL(path,namespace='profile',settings=CONFIG){
  const config=settings===CONFIG?CONFIG:validateConfig(settings);
  if(typeof path!=='string'||!/^\/(data|profile)\//.test(path)||path.startsWith('//')||/[?#\\\u0000-\u001f]/.test(path)||!['profile','dynamic','static'].includes(namespace))throw Error('Invalid Blizzard API path or namespace');
  const url=new URL(path,'https://'+config.guild.region+'.api.blizzard.com');
  if(url.origin!=='https://'+config.guild.region+'.api.blizzard.com')throw Error('Invalid Blizzard API host');
  url.searchParams.set('namespace',namespace+'-forever-'+config.guild.region);url.searchParams.set('locale',config.guild.locale);return url.href;
}
export function deploymentIdentity(settings=CONFIG){const c=settings===CONFIG?CONFIG:validateConfig(settings);return {name:c.guild.name,slug:c.guild.slug,region:c.guild.region,ruleset_id:c.guild.ruleset.id,ruleset:c.guild.region.toUpperCase()+' '+c.guild.ruleset.name};}
const initialized=new WeakMap();
export async function ensureDeploymentIdentity(env,settings=CONFIG){
  const identity=deploymentIdentity(settings),serialized=JSON.stringify(identity);
  const DB=env.DB;if(!DB?.prepare)throw Error('Database binding is required');
  if(initialized.has(DB)){const cached=initialized.get(DB);if(cached.serialized!==serialized)throw Error('This database belongs to another guild configuration; use a new database');return cached.ready;}
  const ready=(async()=>{const current=await DB.prepare("SELECT value FROM state WHERE key='deployment_identity'").first();
    if(current){if(current.value!==serialized)throw Error('This database belongs to another guild configuration; use a new database');return;}
    const source=await DB.prepare("SELECT value FROM state WHERE key='guild'").first();
    if(source){let known;try{known=JSON.parse(source.value);}catch{throw Error('Stored guild identity is invalid');}if(known.name!==identity.name||known.ruleset!==identity.ruleset)throw Error('Stored roster belongs to another guild; use a new database');}
    await DB.prepare("INSERT OR IGNORE INTO state(key,value) VALUES('deployment_identity',?)").bind(serialized).run();
    const saved=await DB.prepare("SELECT value FROM state WHERE key='deployment_identity'").first();if(saved?.value!==serialized)throw Error('Database guild configuration changed');
  })();initialized.set(DB,{serialized,ready});try{return await ready;}catch(error){initialized.delete(DB);throw error;}
}
