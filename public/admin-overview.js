(()=>{
  'use strict';
  const host=document.getElementById('admin-content');if(!host)return;
  const defaults=['Guildmaster','Officer','Veteran','Member','Initiate','Reserve','Recruit','Newcomer','Guest','Visitor'];
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const time=value=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not yet observed';};
  const states={healthy:'Running',delayed:'Delayed',unknown:'Not yet verified',not_configured:'Awaiting setup',paused:'Paused by provider',limited:'Limited coverage',observed:'Responding',importing:'Import in progress',published:'Roster published',waiting:'Awaiting import',configured:'Configured',needs_attention:'Needs attention'};
  let auth=null,generation=0,sequence=0,wanted=false,busy=false,overview=null,rankData=null,rankDraft=null;
  let section='overview', accountQuery='';
  function feedback(message,error=false){const node=host.querySelector('[data-admin-feedback]');if(node){node.hidden=false;node.textContent=message;node.classList.toggle('admin-overview-error',error);}}
  function gate(){host.innerHTML='<div class="panel admin-overview-panel"><h3>Administrator overview</h3><p>This page is available to the verified guild administrator.</p></div>';}
  function reset(){auth=null;generation++;sequence++;wanted=false;busy=false;overview=null;rankData=null;rankDraft=null;accountQuery='';gate();}
  function status(value){return states[value]||'Not yet verified';}
  function healthCard(title,value,detail){const tone=['healthy','observed','published','configured'].includes(value)?'good':['limited','delayed','needs_attention'].includes(value)?'attention':'neutral';return `<article class="panel admin-health-card"><span class="eyebrow gold">${title}</span><strong class="admin-health-state ${tone}"><span aria-hidden="true"></span>${esc(status(value))}</strong><p>${detail}</p></article>`;}
  function siteActivity(analytics){
    if(!analytics)return '';
    const periods=[analytics.today,analytics.last_7_days,analytics.last_30_days];
    const metrics=[
      ['Welcome page views','welcome_views'],
      ['Guild dashboard views','guild_views'],
      ['Website sign-ins','sign_ins'],
      ['Accounts that signed in','accounts_signed_in']
    ];
    const metricRows=metrics.map(([label,key])=>`<tr><th scope="row">${label}</th>${periods.map(period=>`<td>${count(period?.[key]).toLocaleString()}</td>`).join('')}</tr>`).join('');
    return `<div class="admin-site-activity">
      <article class="panel admin-overview-panel">
        <h3>Website analytics</h3>
        <table class="admin-site-table">
          <caption class="admin-screen-reader">Website traffic and sign-ins by period</caption>
          <thead><tr><th scope="col">Metric</th><th scope="col">Today</th><th scope="col">7 days</th><th scope="col">30 days</th></tr></thead>
          <tbody>${metricRows}</tbody>
        </table>
        <p class="subtle">Collecting since ${esc(time(analytics.started_at))}. Periods include today and use UTC dates. Views count full browser page loads, including reloads.</p>
      </article>
    </div>`;
  }
  function dateTime(value){
    return `<time datetime="${esc(value)}">${esc(time(value))}</time>`;
  }
  function accountRows(accounts){
    const query=accountQuery.trim().toLowerCase();
    const matching=accounts.filter(account=>{
      const terms=[account.name,...account.characters,account.battle_net_id,...account.discord_ids.map(link=>link.id)];
      return terms.some(term=>String(term??'').toLowerCase().includes(query));
    });
    if(!matching.length)return '<tr><td colspan="5" class="admin-accounts-empty">No matching accounts or characters.</td></tr>';
    return matching.map(account=>{
      const alts=account.characters.filter(name=>name!==account.name);
      const status=account.signed_in?'Signed in':'No linked sign-in';
      const history=account.recent_sign_ins.length>1
        ? `<details class="admin-signin-history"><summary>Recent sign-ins</summary><ul>${account.recent_sign_ins.map(value=>`<li>${dateTime(value)}</li>`).join('')}</ul></details>`
        : '';
      const last=account.last_sign_in_at?dateTime(account.last_sign_in_at):account.signed_in
        ? `Unavailable<small>Account created ${esc(time(account.account_created_at))}</small>`:'—';
      const battleNet=account.battle_net_id?`<code>${esc(account.battle_net_id)}</code>`:account.signed_in?'Awaiting Battle.net check':'—';
      const discord=account.discord_ids.map(link=>`<div><code>${esc(link.id)}</code><small>${link.source==='linked'?'Linked account':'Admin mapping'}</small></div>`).join('');
      return `<tr>
        <th scope="row">${esc(account.name)}${alts.length?`<small>${esc(alts.join(', '))}</small>`:''}</th>
        <td data-label="Battle.net sign-in"><span class="admin-signin-status ${account.signed_in?'signed-in':''}">${status}</span></td>
        <td data-label="Battle.net ID">${battleNet}</td>
        <td data-label="Discord ID">${discord||'—'}</td>
        <td data-label="Last sign-in">${last}${history}</td>
      </tr>`;
    }).join('');
  }
  function accountPanel(accounts){
    const signedIn=accounts.filter(account=>account.signed_in).length;
    return `<article class="panel admin-overview-panel admin-accounts">
      <div class="admin-accounts-heading">
        <div><h3>Accounts &amp; sign-ins</h3><p>${signedIn} signed in with Battle.net · ${accounts.length-signedIn} roster entries without a linked sign-in</p></div>
        <label class="admin-account-search">Find an account<input type="search" data-admin-account-search placeholder="Character name or ID" value="${esc(accountQuery)}"></label>
      </div>
      <div class="admin-accounts-scroll"><table class="admin-site-table admin-accounts-table">
        <thead><tr><th scope="col">Account / characters</th><th scope="col">Battle.net sign-in</th><th scope="col">Battle.net ID</th><th scope="col">Discord ID</th><th scope="col">Last sign-in</th></tr></thead>
        <tbody data-admin-account-rows>${accountRows(accounts)}</tbody>
      </table></div>
      <p class="subtle">Missing Battle.net IDs appear after the next verified account check. Sign-in history shows up to 10 recorded timestamps per account.</p>
    </article>`;
  }
  function rankForm(){
    if(!rankData)return '<article class="panel admin-overview-panel"><h3>Guild rank names</h3><p>Rank settings could not be loaded. Refresh the overview to try again.</p></article>';
    const labels=rankDraft||rankData.labels||{},ranks=Array.isArray(rankData.ranks)?rankData.ranks:[];
    return `<article class="panel admin-overview-panel admin-rank-panel"><span class="eyebrow gold">THE GUILD HIERARCHY</span><h3>Guild rank names</h3><p>${rankData.source==='custom'?'Your customised rank names are in use.':'These are suggested names. Blizzard returns rank numbers; choose the names your guild uses.'}</p><p class="subtle">Labels change how ranks are displayed. They do not grant website access or administrator permissions.</p><form data-admin-form="ranks"><div class="admin-rank-grid">${defaults.map((fallback,index)=>{const observed=ranks.find(rank=>rank.rank===index),label=typeof labels[String(index)]==='string'?labels[String(index)]:fallback;return `<label><span>Rank ${index}<small>${count(observed?.count)} ${count(observed?.count)===1?'character':'characters'}</small></span><input type="text" name="rank_${index}" value="${esc(label)}" maxlength="40" required autocomplete="off" ${busy?'disabled':''} aria-label="Name for guild rank ${index}"></label>`;}).join('')}</div><div class="admin-rank-actions"><button class="button primary" type="submit" ${busy?'disabled':''}>Save rank names</button><button class="text-button" type="button" data-admin-action="suggested-ranks" ${busy?'disabled':''}>Use suggested names</button></div></form></article>`;
  }
  function render(){
    if(!auth){gate();return;}if(!overview){host.innerHTML='<div class="panel admin-overview-panel"><h3>Administrator overview</h3><p role="status">Loading the latest guild health and import history…</p><p data-admin-feedback role="status" aria-live="polite" hidden></p><button class="button secondary" type="button" data-admin-action="refresh">Refresh overview</button></div>';return;}
    if(section==='accounts'){
      host.innerHTML=toolbar()+accountPanel(overview.accounts||[]);
      return;
    }
    const h=overview.health||{},counts=overview.counts||{},refresh=overview.refresh||{},attention=Array.isArray(overview.attention)?overview.attention.slice(0,20):[],imports=Array.isArray(overview.imports)?overview.imports.slice(0,20):[];
    host.innerHTML=`${toolbar()}<div class="admin-health-grid">${healthCard('BACKGROUND JOBS',h.scheduler?.status,'Last completed '+esc(time(h.scheduler?.last_completed_at)))}${healthCard('BLIZZARD API',h.blizzard?.status,'Last successful response '+esc(time(h.blizzard?.last_success_at)))}${healthCard('GUILD ROSTER',h.roster?.status,'Observed '+esc(time(h.roster?.observed_at)))}${healthCard('DISCORD BOT',h.discord?.status,`${count(h.discord?.pending)} queued · ${count(h.discord?.failed)} failed deliveries`)}</div><div class="admin-count-grid">${[['Current characters',counts.characters],['Verified member accounts',counts.current_member_accounts],['Linked Discord accounts',counts.discord_linked_accounts],['Accounts without Discord',counts.members_without_discord]].map(([label,value])=>`<article class="panel admin-count-card"><span>${label}</span><strong>${count(value)}</strong></article>`).join('')}</div>${siteActivity(overview.analytics)}<div class="admin-overview-columns"><article class="panel admin-overview-panel"><span class="eyebrow gold">WAITING ON YOU</span><h3>Needs attention</h3>${attention.length?`<ul class="admin-attention-list">${attention.map(item=>`<li class="${item.severity==='warning'?'attention':'info'}"><span aria-hidden="true"></span><div><strong>${esc(item.title)}</strong>${Number.isSafeInteger(item.count)?`<small>${count(item.count)} affected</small>`:''}</div></li>`).join('')}</ul>`:'<p class="admin-all-clear">No outstanding issues were reported by these checks.</p>'}</article><article class="panel admin-overview-panel"><span class="eyebrow gold">THE NEXT ROUND</span><h3>Refresh queue</h3><dl class="admin-queue-details"><dt>Due for a check</dt><dd>${count(refresh.due)}</dd><dt>Waiting for next check</dt><dd>${count(refresh.waiting)}</dd><dt>Unpublished profiles</dt><dd>${count(refresh.unpublished)}</dd><dt>Older details retained</dt><dd>${count(refresh.stale)}</dd><dt>Next scheduled character check</dt><dd>${esc(time(refresh.next_at))}</dd></dl><p class="subtle">A successful request can still return an older Blizzard snapshot. Unpublished profiles do not remove verified roster characters.</p><p class="subtle">${count(counts.unclaimed_characters)} characters have no current verified owner link. ${count(counts.site_accounts)} site accounts have signed in in total, including former members.</p></article></div><article class="panel admin-import-panel"><div class="admin-import-heading"><div><span class="eyebrow gold">EVERY IMPORT ACCOUNTED FOR</span><h3>Roster sync history</h3></div><span class="subtle">Completed imports</span></div>${imports.length?`<div class="admin-import-scroll"><table><caption class="admin-screen-reader">Completed roster imports and the changes they detected</caption><thead><tr><th scope="col">Roster observed</th><th scope="col">Published</th><th scope="col">Characters</th><th scope="col">Joined</th><th scope="col">Left</th><th scope="col">Levels</th><th scope="col">Ranks</th><th scope="col">Duration</th></tr></thead><tbody>${imports.map(row=>{const seconds=Math.max(0,Math.round(count(row.duration_ms)/1000));return `<tr><td>${esc(time(row.observed_at))}${row.baseline?'<small>Initial baseline</small>':''}</td><td>${esc(time(row.completed_at))}</td><td>${count(row.member_count)}</td><td>${count(row.joined)}</td><td>${count(row.left??row.departed)}</td><td>${count(row.level_changes)}</td><td>${count(row.rank_changes)}</td><td>${seconds>=60?Math.floor(seconds/60)+'m '+seconds%60+'s':seconds+'s'}</td></tr>`;}).join('')}</tbody></table></div>`:'<p class="admin-empty-imports">Completed imports will appear here after the next full roster publication. Earlier history is not reconstructed.</p>'}<p class="subtle admin-import-note">${esc(overview.import_history_note||'Times show when the tracker observed and published data.')}</p></article>${rankForm()}<p class="admin-backup-note subtle">${esc(h.backups?.note||'Backup availability is managed by the hosting platform; no restore check is performed here.')}</p>`;
  }
  function toolbar(){
    return `<div class="admin-overview-tools"><p class="subtle">Updated ${esc(time(overview.checked_at))}</p><button class="button secondary" type="button" data-admin-action="refresh" ${busy?'disabled':''}>Refresh</button></div><p data-admin-feedback role="status" aria-live="polite" class="admin-overview-feedback" hidden></p>`;
  }
  async function request(path,options){const response=await fetch(path,options),result=await response.json();if(window.GuildAccess?.check(response,result)||response.status===401||response.status===403){reset();throw Error('access');}if(!response.ok)throw Error('request');return result;}
  async function load(nextSection=section){
    const changed=section!==nextSection;
    section=nextSection;wanted=true;
    if(!auth){gate();return;}
    const version=++sequence,epoch=generation;
    if(!overview||changed)render();
    const results=await Promise.allSettled([request('/api/admin/overview'),request('/api/guild/ranks')]);
    if(!auth||epoch!==generation||version!==sequence)return;
    if(results[0].status==='rejected'){render();feedback('The overview could not be refreshed. Try again shortly.',true);return;}
    overview=results[0].value;
    rankData=results[1].status==='fulfilled'?results[1].value:null;
    render();
    if(section==='overview'&&results[1].status==='rejected')feedback('Guild health was refreshed, but rank settings could not be loaded.',true);
  }
  function readRanks(form){const labels={};for(let rank=0;rank<defaults.length;rank++)labels[String(rank)]=String(form.elements['rank_'+rank]?.value||'').trim();return labels;}
  host.addEventListener('input',event=>{
    if(!auth)return;
    if(event.target.matches?.('[data-admin-account-search]')){
      accountQuery=event.target.value;
      host.querySelector('[data-admin-account-rows]').innerHTML=accountRows(overview?.accounts||[]);
      return;
    }
    const form=event.target.closest('form[data-admin-form="ranks"]');if(form)rankDraft=readRanks(form);
  });
  host.addEventListener('submit',async event=>{const form=event.target.closest('form[data-admin-form="ranks"]');if(!form)return;event.preventDefault();if(!auth||busy)return;const labels=readRanks(form);rankDraft=labels;if(Object.values(labels).some(label=>!label||label.length>40)){feedback('Give each guild rank a name of 1 to 40 characters.',true);return;}const epoch=generation,account=auth.user_id,csrf=auth.csrf;busy=true;const controls=[...form.querySelectorAll('button,input')].map(control=>({control,disabled:control.disabled}));for(const {control}of controls)control.disabled=true;try{await request('/api/admin/ranks',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({labels})});if(!auth||epoch!==generation||account!==auth.user_id||csrf!==auth.csrf)return;rankDraft=null;busy=false;await load();if(auth&&epoch===generation){feedback('Guild rank names saved. These labels do not change anyone’s permissions.');window.dispatchEvent(new CustomEvent('guild-ranks-saved',{detail:{labels}}));}}catch{if(auth&&epoch===generation)feedback('Rank names could not be saved. Your edits are still here; try again after refreshing your account.',true);}finally{if(auth&&epoch===generation){busy=false;for(const {control,disabled}of controls)control.disabled=disabled;}}});
  host.addEventListener('click',event=>{const button=event.target.closest('[data-admin-action]');if(!button||!auth)return;if(button.dataset.adminAction==='refresh')load();if(button.dataset.adminAction==='suggested-ranks'&&!busy){rankDraft=Object.fromEntries(defaults.map((name,rank)=>[String(rank),name]));render();feedback('Suggested names are in the form. Save to use them.');}});
  window.addEventListener('guild-member',event=>{const value=event.detail||{},allowed=Boolean(value.verified&&value.is_admin&&typeof value.csrf==='string'&&value.csrf&&typeof value.user_id==='string'&&value.user_id);if(!allowed){reset();return;}const requested=wanted;if(!auth||auth.user_id!==value.user_id||auth.csrf!==value.csrf){generation++;sequence++;if(auth?.user_id!==value.user_id){overview=null;rankData=null;rankDraft=null;}busy=false;}auth={user_id:value.user_id,csrf:value.csrf};if(requested&&!overview)load();});
  window.addEventListener('guild-access-reset',reset);
  window.GuildAdminOverview={load,reset};gate();
})();
