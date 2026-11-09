import {CONFIG} from '../src/config.mjs';
import {request} from 'node:http';
await new Promise(resolveCheck=>{
  const check=request({hostname:'127.0.0.1',port:Number(process.env.PORT||8080),path:'/healthz',headers:{Host:new URL(CONFIG.site.origin).host}},response=>{response.resume();if(response.statusCode!==200)process.exitCode=1;response.on('end',resolveCheck);response.on('error',()=>{process.exitCode=1;resolveCheck();});});
  check.setTimeout(4000,()=>check.destroy());check.on('error',()=>{process.exitCode=1;resolveCheck();});check.end();
});
