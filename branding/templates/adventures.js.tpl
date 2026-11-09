(()=>{
  let member={verified:false,is_admin:false,characters:[]},areas=null,lastResult=null,characterMappings=[],mappingVersion=0,mappingBusy=false;
  const esc=escapeHTML;
  function setGate(){ $('quest-gate').hidden=member.verified;$('quest-member').hidden=!member.verified; }
  function choices(){const chosen=new Set([...document.querySelectorAll('#quest-characters input:checked')].map(i=>Number(i.value)));if(!chosen.size&&member.characters[0])chosen.add(member.characters[0].id);$('quest-characters').innerHTML=members.map(c=>`<label class="alt-choice"><input type="checkbox" value="${c.id}" ${chosen.has(c.id)?'checked':''}>${esc(c.name)}</label>`).join('');}
  async function load(){setGate();if(!member.verified)return;choices();if(areas)return;try{areas=await fetchJSON('/api/quests/areas');$('quest-area').innerHTML=areas.areas.length?'<option value="">Choose an area</option>'+areas.areas.sort((a,b)=>a.name.localeCompare(b.name)).map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join(''):'<option value="">Quest areas are unavailable</option>';}catch(error){$('quest-result').textContent=error.message;}}
  function render(){
    if(!lastResult)return;const r=lastResult,shared=$('quest-shared-only').checked,list=r.quests.filter(q=>!shared||q.characters.some(c=>c.state==='in_progress'));
    $('quest-note').hidden=false;$('quest-note').textContent=r.note;
    const labels={completed:'Completed',in_progress:'Active',not_observed:'Not in returned logs',unknown:'Unknown'};
    $('quest-result').innerHTML=`<h3>${esc(r.area)}</h3><p class="subtle">Area list observed ${esc(date(r.observed_at))}.</p>${r.characters.map(c=>`<p class="subtle">${esc(c.name)} · ${c.active_count??'?'} active / ${c.completed_count??'?'} completed · logs checked ${esc(date(c.checked_at))}</p>`).join('')}${r.status!=='observed'?'<p>Blizzard did not return an area quest list. No coverage is assumed.</p>':list.length?`<div class="table-wrap"><table><thead><tr><th>QUEST</th>${r.characters.map(c=>`<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${list.map(q=>`<tr><td>${esc(q.name)}<small class="quest-id">#${q.id}</small></td>${q.characters.map(c=>`<td><span class="quest-state ${c.state}">${labels[c.state]}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'<p>No quests match this view. Try showing all quests in this area.</p>'}`;
  }
  $('quest-form').addEventListener('submit',async e=>{e.preventDefault();const selected=[...document.querySelectorAll('#quest-characters input:checked')].map(i=>i.value),button=e.currentTarget.querySelector('button');if(!selected.length||selected.length>5){$('quest-result').textContent='Choose between one and five characters.';return;}button.disabled=true;$('quest-result').textContent='Comparing the returned quest logs…';try{lastResult=await fetchJSON('/api/quests/compare?'+new URLSearchParams({area:$('quest-area').value,characters:selected.join(',')}));render();}catch(error){$('quest-result').textContent=error.message;}finally{button.disabled=false;}});
  $('quest-shared-only').addEventListener('change',render);
  async function loadDiscordAdmin(){if(!member.is_admin)return;try{const d=await fetchJSON('/api/admin/discord');if(!member.is_admin)return;$('discord-config-form').elements.client_id.value=d.client_id;$('discord-config-form').elements.guild_id.value=d.guild_id;$('discord-config-form').elements.events_channel_id.value=d.events_channel_id||'';$('discord-config-form').elements.craft_requests_channel_id.value=d.craft_requests_channel_id||'';$('discord-admin-status').textContent=d.configured?'Bot credentials and server details are configured. Delivery results appear below.':`Awaiting setup · bot token ${d.bot_token_set?'set':'missing'} · client secret ${d.client_secret_set?'set':'missing'}`;$('discord-invite').hidden=!d.invite_url;if(d.invite_url)$('discord-invite').href=d.invite_url;$('discord-queue').textContent=d.queue.length?'Delivery queue: '+d.queue.map(q=>q.count+' '+q.status).join(' · '):'No Discord notifications queued yet.';}catch(error){$('discord-admin-status').textContent=error.message;}}
  function mappingFeedback(message,error=false){
    const notice=$('character-mappings-feedback');notice.hidden=!message;notice.textContent=message;notice.classList.toggle('ready',!error);notice.classList.toggle('mapping-error',error);
  }
  function resetMappingForm(){
    $('character-mapping-form').reset();$('character-mapping-form-title').textContent='Add or update a mapping';
  }
  function setMappingBusy(value){
    mappingBusy=value;const form=$('character-mapping-form');
    form.querySelectorAll('input,select,button').forEach(control=>control.disabled=value||!member.is_admin);
    form.querySelector('[type=submit]').disabled=value||!member.is_admin||form.elements.character_id.options.length<2;
    $('character-mappings-refresh').disabled=value||!member.is_admin;
    $('character-mappings-list').querySelectorAll('button').forEach(button=>button.disabled=value||!member.is_admin);
  }
  function clearCharacterMappings(){
    mappingVersion++;characterMappings=[];mappingBusy=false;$('character-mappings-panel').hidden=true;
    resetMappingForm();$('character-mapping-form').elements.character_id.innerHTML='<option value="">Choose a guild character</option>';
    $('character-mappings-list').innerHTML='';$('character-mappings-note').textContent='';mappingFeedback('');setMappingBusy(false);
  }
  function renderCharacterMappings(){
    $('character-mappings-list').innerHTML=characterMappings.length?`<div class="table-wrap"><table class="mapping-table"><caption>Administrator-created Discord character mappings</caption><thead><tr><th scope="col">GUILD CHARACTER</th><th scope="col">DISCORD MEMBER</th><th scope="col">DEFAULT FOR EVENTS</th><th scope="col">CRAFTING DMs</th><th scope="col">MANAGE</th></tr></thead><tbody>${characterMappings.map(row=>`<tr><td><strong>${esc(row.name||'Former guild character')}</strong><span class="mapping-source">Admin</span>${row.conflict?`<small class="mapping-conflict">${esc(typeof row.conflict==='string'?row.conflict:'Conflicts with a member-authorised identity.')}</small>`:''}</td><td><strong>${esc(row.display_name||'Discord member · name unavailable')}</strong><br><code>${esc(row.discord_id)}</code></td><td>${row.preferred?'Default':'Additional character'}</td><td>${row.crafter_dm?'Allowed by admin':'No admin opt-in'}</td><td><div class="mapping-row-actions"><button class="button" type="button" data-mapping-action="edit" data-mapping-character="${Number(row.character_id)}" aria-label="Edit mapping for ${esc(row.name||'character')}">Edit</button><button class="button secondary" type="button" data-mapping-action="remove" data-mapping-character="${Number(row.character_id)}" aria-label="Remove mapping for ${esc(row.name||'character')}">Remove</button></div></td></tr>`).join('')}</tbody></table></div>`:'<p class="subtle mapping-empty">No administrator mappings yet. Choose a guild character above to add one.</p>';
  }
  async function loadCharacterMappings(){
    if(!member.is_admin)return;const version=++mappingVersion;$('character-mappings-panel').hidden=false;$('character-mappings-note').textContent='Loading current character mappings…';
    try{
      const data=await fetchJSON('/api/admin/character-mappings');if(!member.is_admin||version!==mappingVersion)return;
      characterMappings=data.mappings||[];const select=$('character-mapping-form').elements.character_id,selected=select.value;
      select.innerHTML='<option value="">Choose a guild character</option>'+(data.characters||[]).slice().sort((a,b)=>a.name.localeCompare(b.name)).map(character=>`<option value="${Number(character.id)}">${esc(character.name)}</option>`).join('');
      if([...select.options].some(option=>option.value===selected))select.value=selected;
      $('character-mappings-note').textContent=data.note||'';renderCharacterMappings();setMappingBusy(mappingBusy);return true;
    }catch(error){if(member.is_admin&&version===mappingVersion){$('character-mappings-note').textContent='Current mappings could not be refreshed.';mappingFeedback(error.message,true);}return false;}
  }
  async function changeCharacterMapping(data){
    if(!member.is_admin||mappingBusy)return;const csrf=member.csrf;setMappingBusy(true);mappingFeedback('');
    try{
      const response=await fetch('/api/admin/character-mappings',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)}),result=await response.json();
      if(window.GuildAccess?.check(response,result))throw Error('Sign in to reopen the guildhall');
      if(!response.ok)throw Error(result.error||'The character mapping could not be saved.');
      if(!member.is_admin||member.csrf!==csrf)return;
      resetMappingForm();const refreshed=await loadCharacterMappings();if(member.is_admin&&member.csrf===csrf)mappingFeedback(refreshed?(result.message||(data.action==='remove'?'Character mapping removed.':'Character mapping saved.')):'The mapping change was saved, but the list could not be refreshed. Use Refresh mappings to try again.',!refreshed);
    }catch(error){if(member.is_admin&&member.csrf===csrf)mappingFeedback(error.message,true);}finally{if(member.csrf===csrf)setMappingBusy(false);}
  }
  $('character-mapping-form').addEventListener('submit',event=>{
    event.preventDefault();const form=event.currentTarget;
    changeCharacterMapping({action:'save',character_id:Number(form.elements.character_id.value),discord_id:form.elements.discord_id.value.trim(),preferred:form.elements.preferred.checked,crafter_dm:form.elements.crafter_dm.checked});
  });
  $('character-mapping-reset').addEventListener('click',()=>{resetMappingForm();mappingFeedback('');});
  $('character-mappings-refresh').addEventListener('click',()=>{mappingFeedback('');loadCharacterMappings();});
  $('character-mappings-list').addEventListener('click',event=>{
    const button=event.target.closest('[data-mapping-action]');if(!button||!member.is_admin||mappingBusy)return;
    const row=characterMappings.find(mapping=>Number(mapping.character_id)===Number(button.dataset.mappingCharacter));if(!row)return;
    if(button.dataset.mappingAction==='remove'){changeCharacterMapping({action:'remove',character_id:Number(row.character_id)});return;}
    const form=$('character-mapping-form');form.elements.character_id.value=String(row.character_id);form.elements.discord_id.value=row.discord_id;form.elements.preferred.checked=Boolean(row.preferred);form.elements.crafter_dm.checked=Boolean(row.crafter_dm);
    $('character-mapping-form-title').textContent='Edit mapping · '+(row.name||'character');
    mappingFeedback(form.elements.character_id.value?'Editing '+(row.name||'this character')+'. Save to apply your changes.':'This character is no longer in the current guild roster. Choose a current character or remove the old mapping.',!form.elements.character_id.value);
    form.elements.discord_id.focus();form.scrollIntoView({behavior:'smooth',block:'center'});
  });
  async function admin(){if(!member.is_admin){clearCharacterMappings();return;}await Promise.allSettled([loadDiscordAdmin(),loadCharacterMappings()]);}
  function showDiscordVerification(verification={}){
    const connection=verification.installed?`${verification.application_name||{{BOT_NAME_JSON}}} verified in ${verification.server_name||'the configured server'}.`:(verification.error||'Connection not verified.');
    const state=value=>value===true?'Ready':value===false?'Not ready':'Not verified';
    const channels=[[verification.event_channel,'Events','Role reactions'],[verification.craft_channel,'Craft requests','Completion reactions']];
    $('discord-verification').innerHTML=`<p>${esc(connection)}</p>${channels.map(([channel,title,reactions])=>channel?`<p><strong>${esc(title)}${channel.channel_name?' · #'+esc(channel.channel_name):''}</strong></p><ul><li class="${channel.can_post===true?'verification-ready':'verification-warning'}">Post announcements: ${state(channel.can_post)}</li><li class="${channel.can_react===true?'verification-ready':'verification-warning'}">${esc(reactions)}: ${state(channel.can_react)}</li></ul>${channel.missing?.length?`<p class="verification-warning">Needs: ${channel.missing.map(esc).join(', ')}.</p>`:''}`:'').join('')}`;
  }
  $('discord-check').addEventListener('click',async()=>{const button=$('discord-check');button.disabled=true;$('discord-verification').textContent='Checking the bot, events channel and craft requests channel permissions…';try{const response=await fetch('/api/admin/discord',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':member.csrf},body:JSON.stringify({check:true})}),d=await response.json();if(window.GuildAccess?.check(response,d))throw Error('Sign in to reopen the guildhall');if(!response.ok)throw Error(d.error||'The Discord connection could not be checked.');showDiscordVerification(d.verification);}catch(error){$('discord-verification').textContent=error.message;}finally{button.disabled=false;}});
  $('discord-config-form').addEventListener('submit',async e=>{e.preventDefault();if(!member.is_admin)return;const button=e.currentTarget.querySelector('[type=submit]');button.disabled=true;try{const response=await fetch('/api/admin/discord',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':member.csrf},body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))}),d=await response.json();if(window.GuildAccess?.check(response,d))throw Error('Sign in to reopen the guildhall');if(!response.ok)throw Error(d.error||'The bot details could not be saved.');await admin();$('discord-verification').textContent='Bot details saved. Check the connection to verify both Discord channels.';}catch(error){$('discord-admin-status').textContent=error.message;}finally{button.disabled=false;}});
  window.addEventListener('guild-member',event=>{member=event.detail;setGate();if(!member.is_admin)clearCharacterMappings();if(!member.verified){lastResult=null;$('quest-result').innerHTML='';}if(!$('adventures').hidden)load();if(member.is_admin&&!$('status').hidden)admin();});
  window.addEventListener('guild-data',()=>{if(!$('adventures').hidden)choices();});
  window.GuildAdventures={load,admin};
})();
