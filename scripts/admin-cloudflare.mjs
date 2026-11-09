import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const slug=process.argv[2];
if(typeof slug!=='string'||!/^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)+$/u.test(slug))throw Error('Supply the exact verified character slug: first-last');
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
async function run(args,input=''){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true'}});let output='';
  child.stdout.on('data',part=>output+=part);child.stderr.resume();child.on('error',()=>reject(Error('Cloudflare command could not start')));child.on('close',code=>code===0?resolve(output):reject(Error('Administrator configuration failed; private output was suppressed.')));child.stdin.end(input);
});}
const sql=`SELECT DISTINCT u.id FROM users u JOIN character_links l ON l.user_id=u.id JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1) WHERE u.ownership_status='verified' AND u.ownership_checked>unixepoch()-86400 AND u.ownership_checked<=unixepoch()+60 AND m.slug='${slug.normalize('NFC').toLowerCase()}' LIMIT 2`;
const raw=await run(['d1','execute',config.d1_databases[0].database_name,'--remote','--command',sql,'--json']);
const rows=JSON.parse(raw)[0]?.results;
if(!Array.isArray(rows)||rows.length!==1||typeof rows[0].id!=='string'||!/^[a-f0-9-]{36}$/.test(rows[0].id))throw Error('Expected exactly one fresh verified owner. That character must sign in successfully first.');
await run(['secret','bulk'],JSON.stringify({ADMIN_USER_IDS:rows[0].id}));
console.log('The verified character owner is now the sole administrator. Their private account identifier was not printed.');
