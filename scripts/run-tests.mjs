import {readdirSync,existsSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
if(!existsSync('wrangler.jsonc'))copyFileSync('wrangler.example.jsonc','wrangler.jsonc');
const files=readdirSync('tests').filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
process.exit(result.status??1);
