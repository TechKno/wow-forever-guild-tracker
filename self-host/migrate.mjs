import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './database.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
try{const DB=openDatabase(resolve(process.env.DATA_DIR||resolve(root,'data'),'guild.sqlite'),resolve(root,'migrations'));DB.close();console.log('Database migrations completed.');}
catch{console.error('Migration failed. Check the data directory and matching migration files. No private database details were printed.');process.exitCode=1;}
