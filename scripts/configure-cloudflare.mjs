import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CONFIG} from '../src/config.mjs';
const args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
const worker=option('--worker'),database=option('--database'),databaseId=option('--database-id'),domain=option('--domain');
if(!/^[a-z][a-z0-9-]{0,62}$/.test(worker||'')||!/^[a-zA-Z0-9_-]{1,64}$/.test(database||'')||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(databaseId||'')||/^0+$/.test((databaseId||'').replaceAll('-','')))throw Error('Supply --worker, --database and the new D1 --database-id. Names and UUID must be valid.');
if(domain&&domain!==new URL(CONFIG.site.origin).hostname)throw Error('--domain must match the configured canonical site hostname.');
if(existsSync('wrangler.jsonc')&&!args.includes('--force')){
  const existing=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  if(existing.d1_databases?.[0]?.database_id!=='00000000-0000-0000-0000-000000000000')throw Error('A deployment configuration already exists. Review it before using --force.');
}
const config=JSON.parse(readFileSync('wrangler.example.jsonc','utf8'));
config.name=worker;config.d1_databases[0]={...config.d1_databases[0],database_name:database,database_id:databaseId};
const base=Number.parseInt(createHash('sha256').update(worker).digest('hex').slice(0,10),16);
config.ratelimits.forEach((binding,index)=>binding.namespace_id=String(base+index));
if(domain)config.routes=[{pattern:domain,custom_domain:true}];
writeFileSync('wrangler.jsonc',JSON.stringify(config,null,2)+'\n');
console.log('Local Cloudflare deployment configuration saved. It is excluded from Git.');
