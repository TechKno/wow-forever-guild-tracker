import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const hall=readFileSync(new URL('../public/hall.js',import.meta.url),'utf8');
const adventures=readFileSync(new URL('../public/adventures.js',import.meta.url),'utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const messageURL='https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333';
const craft=(overrides={})=>({id:1,kind:'craft',status:'open',item_name:'Linen Bag',character_name:'Avery Example',quantity:1,created_at:'2026-11-08T17:00:00Z',
  recipe_id:42,materials_preference:'provided',targets:[],discord_channel_status:'posted',discord_message_url:messageURL,...overrides});
function cards(){
  const start=hall.indexOf('function craftDiscordStatus('),end=hall.indexOf('function renderRequests(');
  assert(start>=0&&end>start,'Craft card rendering must remain available to the behavior fixture');
  const context=vm.createContext({esc:escape,date:value=>value,materialLabels:{provided:'Requester can provide materials'},materialHTML:()=>'',matching:()=>''});
  vm.runInContext(hall.slice(start,end),context);
  return context.requestCard;
}

test('a posted recipe request links to its Discord post and explains who can confirm delivery',()=>{
  const html=cards()(craft({discord_channel_note:'A selected crafter cannot receive a DM.'}));
  assert.ok(html.includes('href="'+messageURL+'"'));
  assert.match(html,/Open Discord craft request/);assert.match(html,/React ✅ after delivery/);
  assert.match(html,/The requester or a guild crafter who knows this recipe can confirm completion/);
  assert.match(html,/removed after completion or cancellation/);assert.match(html,/A selected crafter cannot receive a DM/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g,''),/\d{15,22}/,'Discord identifiers must not become member-facing labels');
});

test('manual item requests reserve Discord completion reactions for the requester',()=>{
  for(const recipe_id of [null,undefined,0,'not-a-recipe']){
    const html=cards()(craft({recipe_id}));
    assert.match(html,/Only the requester can confirm this manual item request with a Discord reaction/);
    assert.doesNotMatch(html,/guild crafter who knows this recipe/);
  }
});

test('queued and failed channel posts remain distinct from successful delivery',()=>{
  const render=cards(),pending=render(craft({discord_channel_status:'pending',discord_channel_note:'Waiting for the next delivery batch.'}));
  assert.match(pending,/Discord craft channel post is queued/);assert.match(pending,/Waiting for the next delivery batch/);
  assert.doesNotMatch(pending,/Open Discord craft request|React ✅/);
  const failed=render(craft({discord_channel_status:'failed',discord_channel_note:'The configured channel is unavailable.'}));
  assert.match(failed,/could not be sent/);assert.match(failed,/still on the guild workbench/);
  assert.doesNotMatch(failed,/Open Discord craft request|React ✅/);
});

test('completed and cancelled craft cards stop linking to the Discord post',()=>{
  for(const status of ['completed','cancelled']){
    const html=cards()(craft({status,discord_channel_note:'Earlier delivery note.'}));
    assert.doesNotMatch(html,/Open Discord craft request|React ✅|Earlier delivery note/);
    assert.ok(!html.includes(messageURL));
  }
  const wishlist=cards()(craft({kind:'learn'}));assert.doesNotMatch(wishlist,/Open Discord craft request|React ✅/);
});

test('craft message links accept only the expected Discord message URL format',()=>{
  const render=cards();
  for(const discord_message_url of ['javascript:alert(1)','https://discord.com.evil.example/channels/1/2/3','https://evil.example/channels/111111111111111111/222222222222222222/333333333333333333',messageURL+'" onclick="alert(1)']){
    const html=render(craft({discord_message_url}));
    assert.doesNotMatch(html,/href=|onclick=/);assert.match(html,/Posted in the Discord craft requests channel/);
  }
});

test('Discord fallback notes and request content are escaped',()=>{
  const html=cards()(craft({item_name:'<img src=x onerror=alert(1)>',discord_channel_note:'<script>private()</script>',notes:'<b>Notes</b>'}));
  assert.doesNotMatch(html,/<img|<script>|<b>/);assert.match(html,/&lt;script&gt;private\(\)&lt;\/script&gt;/);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/&lt;b&gt;Notes&lt;\/b&gt;/);
});

test('administrator connection checks show separate events and crafting reaction permissions',()=>{
  const start=adventures.indexOf('function showDiscordVerification('),end=adventures.indexOf("$('discord-check').addEventListener");
  assert(start>=0&&end>start,'Discord verification renderer must remain available to the behavior fixture');
  const output={},context=vm.createContext({esc:escape,$:()=>output});vm.runInContext(adventures.slice(start,end),context);
  context.showDiscordVerification({installed:true,server_name:'Guild',event_channel:{channel_name:'events',can_post:true,can_react:true},
    craft_channel:{channel_name:'craft<requests>',can_post:true,can_react:false,missing:['Add Reactions']}});
  assert.match(output.innerHTML,/Events · #events/);assert.match(output.innerHTML,/Craft requests · #craft&lt;requests&gt;/);
  assert.match(output.innerHTML,/Role reactions: Ready/);assert.match(output.innerHTML,/Completion reactions: Not ready/);
  assert.match(output.innerHTML,/Needs: Add Reactions/);
});
