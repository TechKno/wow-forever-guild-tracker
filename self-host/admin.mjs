import {openSync,writeFileSync,closeSync,fchmodSync,lstatSync,constants} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './database.mjs';

export function pinAdministrator(DB,slug,directory){
  if(typeof slug!=='string'||slug.length>120||!/^\p{L}[\p{L}\p{M}\d-]+$/u.test(slug))throw Error('Choose an exact verified character slug');
  const rows=DB.raw.prepare(`SELECT DISTINCT u.id FROM users u JOIN character_links l ON l.user_id=u.id
    JOIN verified_membership m ON m.character_id=l.character_id AND m.generation=(SELECT published FROM sync WHERE id=1)
    WHERE m.slug=? AND u.ownership_status='verified' AND u.ownership_checked>unixepoch()-86400 AND u.ownership_checked<=unixepoch()+60`).all(slug);
  if(rows.length!==1||!/^\w[\w-]{0,79}$/.test(rows[0].id))throw Error('Exactly one currently verified owner must sign in first');
  const target=resolve(directory,'admin-user-ids');
  try{if(!lstatSync(target).isFile()||lstatSync(target).isSymbolicLink())throw Error('Invalid administrator file');}catch(error){if(error.code!=='ENOENT')throw error;}
  const descriptor=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|(constants.O_NOFOLLOW||0),0o600);
  try{fchmodSync(descriptor,0o600);writeFileSync(descriptor,rows[0].id+'\n');}finally{closeSync(descriptor);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let DB;
  try{
    const root=fileURLToPath(new URL('../',import.meta.url)),directory=resolve(process.env.DATA_DIR||resolve(root,'data'));
    if(process.argv.length!==4||process.argv[2]!=='--character')throw Error('Use --character exact-character-slug');
    DB=openDatabase(resolve(directory,'guild.sqlite'),resolve(root,'migrations'));
    pinAdministrator(DB,process.argv[3],directory);
    console.log('Administrator pinned to the verified owner. Restart the app to apply it.');
  }catch{console.error('Administrator setup failed. Sign in with the character owner first, then supply the exact current character slug. No account identifier was printed.');process.exitCode=1;}
  finally{DB?.close();}
}
