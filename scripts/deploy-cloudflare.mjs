import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../src/config.mjs';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
if(!config.d1_databases?.[0]?.database_id||config.d1_databases[0].database_id==='00000000-0000-0000-0000-000000000000')throw Error('Configure your own D1 database before deployment.');
if(new URL(CONFIG.site.origin).hostname.endsWith('.example.com')||new URL(CONFIG.site.origin).hostname==='example.com')throw Error('Set your real HTTPS site origin in guild.config.json before deployment.');
const cli=new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url);
async function run(args){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(cli),...args],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true'}});
  child.stdout.resume();child.stderr.resume();child.on('error',()=>reject(Error('Cloudflare command could not start')));child.on('close',code=>code===0?resolve():reject(Error('Cloudflare command failed; raw output was suppressed to protect configuration values.')));
});}
await run(['d1','migrations','apply',config.d1_databases[0].database_name,'--remote']);
await run(['deploy','--keep-vars']);
console.log('Published '+CONFIG.site.origin);
