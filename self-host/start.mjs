import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import worker from '../src/worker.mjs';
import {CONFIG} from '../src/config.mjs';
import {openDatabase} from './database.mjs';
import {createRuntime,loadRuntimeSecrets} from './runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),dataDirectory=resolve(process.env.DATA_DIR||resolve(root,'data'));
let runtime,DB;
try{
  DB=openDatabase(resolve(dataDirectory,'guild.sqlite'),resolve(root,'migrations'));
  runtime=createRuntime({worker,DB,publicDirectory:resolve(root,'public'),origins:[CONFIG.site.origin,...CONFIG.site.additionalOrigins],
    secrets:loadRuntimeSecrets(process.env,dataDirectory),trustedProxyAddresses:(process.env.TRUSTED_PROXY_ADDRESSES||'').split(',').map(value=>value.trim()).filter(Boolean)});
  const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid server port');
  runtime.server.listen(port,process.env.HOST||'0.0.0.0',()=>{console.log('Guild tracker is ready.');runtime.scheduler.start();});
  runtime.server.on('error',()=>{console.error('Server could not start.');DB.close();process.exitCode=1;});
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;stopping=true;
    const deadline=setTimeout(()=>process.exit(1),80000);deadline.unref();
    await Promise.all([new Promise(resolveClose=>runtime.server.close(resolveClose)),runtime.scheduler.stop()]);
    DB.close();clearTimeout(deadline);
  };
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch{console.error('Self-hosting startup failed. Check configuration, credential-file access and the data directory.');try{DB?.close();}catch{}process.exitCode=1;}
