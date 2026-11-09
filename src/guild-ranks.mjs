import {currentUser,requireMember,requireAdmin,requireWrite,bodyJSON,WebError} from './auth.mjs';
export const SUGGESTED_RANKS=['Guildmaster','Officer','Veteran','Member','Initiate','Reserve','Recruit','Newcomer','Guest','Visitor'];
const defaults=()=>Object.fromEntries(SUGGESTED_RANKS.map((name,rank)=>[String(rank),name]));
export function validateRankLabels(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw new WebError('Check the guild rank names');
  const result={};
  for(const [rank,name]of Object.entries(value)){
    if(!/^(0|[1-9]\d?)$/.test(rank)||typeof name!=='string'||!name.trim()||name.trim().length>40||/[\u0000-\u001f\u007f]/.test(name))throw new WebError('Use a rank from 0 to 99 and a name of 1 to 40 characters');
    result[rank]=name.trim();
  }
  return result;
}
export async function guildRanks(request,env){
  const user=await currentUser(request,env);requireMember(user);
  if(request.method==='POST'){
    requireAdmin(user);requireWrite(request,user);
    const body=await bodyJSON(request),labels=validateRankLabels(body.labels);
    await env.DB.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('guild_rank_labels',?)").bind(JSON.stringify(labels)).run();
  }
  const row=await env.DB.prepare("SELECT value FROM state WHERE key='guild_rank_labels'").first();
  let custom={};try{if(row)custom=validateRankLabels(JSON.parse(row.value));}catch{}
  const labels={...defaults(),...custom};
  const rows=await env.DB.prepare("SELECT json_extract(data,'$.rank') rank,COUNT(*) count FROM verified_membership WHERE generation=(SELECT published FROM sync WHERE id=1) GROUP BY json_extract(data,'$.rank') ORDER BY rank").all();
  const ranks=rows.results.map(({rank,count})=>({rank:Number.isSafeInteger(rank)&&rank>=0&&rank<=99?rank:null,name:Number.isSafeInteger(rank)&&rank>=0&&rank<=99?labels[String(rank)]||'Rank '+rank:'Rank not returned',count}));
  return {labels,ranks,source:Object.keys(custom).length?'custom':'suggested',note:'Names are guild labels. Order follows the returned in-game rank. Labels do not grant website permissions.'};
}
