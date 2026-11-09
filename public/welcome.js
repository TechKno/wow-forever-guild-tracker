(() => {
  'use strict';
  const expected={"guildName":"Example Guild","region":"EU","ruleset":"Roleplay"};
  const routes=new Set(['overview','roster','hall','crafting','events','members','recipes','professions','history','adventures','status','wishlists']);
  const hash=window.location.hash;
  if(hash.startsWith('#')&&routes.has(hash.slice(1))){window.location.replace('/guild'+hash);return;}
  const $=id=>document.getElementById(id);
  const query=new URLSearchParams(window.location.search);
  if(query.get('access')==='unverified')$('eligibility-notice').hidden=false;
  else if(query.has('signin')){const notice=$('eligibility-notice');notice.hidden=false;notice.querySelector('strong').textContent='Battle.net sign-in did not finish.';notice.querySelector('p').textContent='Please try again. If Blizzard is temporarily unavailable, you can return a little later.';}
  async function loadRoster(){
    try{
      const response=await fetch('/api/public',{cache:'no-store',credentials:'omit'});
      if(!response.ok)throw new Error('Roster unavailable');
      const data=await response.json();
      if(data?.guild_name!==expected.guildName||data.region!==expected.region||data.ruleset!==expected.ruleset)throw new Error('Guild identity did not match');
      const validCount=Number.isSafeInteger(data.member_count)&&data.member_count>=0;
      $('public-member-count').textContent=validCount?data.member_count.toLocaleString():'—';
      const observed=typeof data.roster_observed_at==='string'&&Number.isFinite(Date.parse(data.roster_observed_at));
      const breakdown=validCount&&Number.isSafeInteger(data.roster_member_count)&&data.roster_member_count>=0&&Number.isSafeInteger(data.profile_verified_count)&&data.profile_verified_count>=0&&data.roster_member_count+data.profile_verified_count===data.member_count;
      const profileNote=breakdown&&data.profile_verified_count>0?data.roster_member_count.toLocaleString()+' from roster · '+data.profile_verified_count.toLocaleString()+' verified through character '+(data.profile_verified_count===1?'profile':'profiles')+' · ':'';
      $('public-roster-status').textContent=validCount?profileNote+(observed?'Roster checked '+new Date(data.roster_observed_at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Guild count available · roster check time unavailable'):'Guild count is currently unavailable.';
    }catch{
      $('public-member-count').textContent='—';
      $('public-roster-status').textContent='Guild count is currently unavailable.';
    }
  }
  loadRoster();
})();
