import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const directory of ['src','public','scripts','self-host'])for(const name of readdirSync(directory).filter(name=>/\.(mjs|js)$/.test(name))){
  const result=spawnSync(process.execPath,['--check',directory+'/'+name],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
console.log('JavaScript syntax checks passed.');
