import {readdirSync,readFileSync,lstatSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const excluded=new Set(['.git','node_modules','.wrangler','data','secrets','backups']);
function walk(directory='.'){
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    if(excluded.has(entry.name))return [];
    const path=(directory==='.'?'':directory+'/')+entry.name;
    if(entry.isSymbolicLink())throw Error('Publication must not contain symbolic links: '+path);
    return entry.isDirectory()?walk(path):[path];
  });
}
const tracked=existsSync('.git')?spawnSync('git',['ls-files','-z'],{encoding:'utf8'}):null;
const files=tracked?.status===0?tracked.stdout.split('\0').filter(Boolean):walk();
const blockedPath=path=>path.split('/').some(part=>['node_modules','.wrangler','secrets','data','backups'].includes(part))||(/(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|credentials[^/]*|wrangler\.jsonc)$/i.test(path)&&!path.endsWith('.example'))||/\.(?:sqlite(?:-[a-z]+)?|db|log|zip)$/i.test(path);
const patterns=[[/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,'private key'],[/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,'GitHub token'],[/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,'GitHub token'],[/\bAKIA[A-Z0-9]{16}\b/,'AWS access key'],[/\bmfa\.[A-Za-z0-9_-]{60,}\b/,'Discord credential'],[/\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,'token-shaped credential']];
const findings=[];
for(const path of files){
  if(blockedPath(path)){findings.push({path,reason:'private operational file'});continue;}
  if(!existsSync(path)||!lstatSync(path).isFile()){findings.push({path,reason:'unexpected file type'});continue;}
  if(/\.(png|webp|jpe?g)$/i.test(path))continue;
  const content=readFileSync(path,'utf8');
  for(const [pattern,reason]of patterns)if(pattern.test(content))findings.push({path,reason});
  if(/(?:BLIZZARD_CLIENT_SECRET|DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET)[ \t]*=[ \t]*\S+/m.test(content)&&/\.(?:env|vars|example)$/.test(path))findings.push({path,reason:'nonempty credential example'});
}
if(findings.length){console.error(JSON.stringify({publication:'blocked',findings},null,2));process.exit(1);}
console.log(JSON.stringify({publication:'checked',files:files.length,credentialPatterns:'passed',operationalFiles:'excluded'}));
