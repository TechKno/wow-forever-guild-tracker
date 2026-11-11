import {battleNetIdentity,prepareAccountSync,random} from './auth.mjs';
import {decryptAccountCredential} from './account-credentials.mjs';
export {accountSyncView} from './account-credentials.mjs';
import {state} from './logic.mjs';
const epoch=()=>Math.floor(Date.now()/1000),stamp=()=>new Date().toISOString();
const safeRetry=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(3600,Math.ceil(value)):0;

async function recoverBattleNetIdentity(env, now) {
  const pending = await env.DB.prepare(`UPDATE site_battlenet_identities SET recovery_pending=0
    WHERE user_id=(SELECT user_id FROM site_battlenet_identities WHERE recovery_pending=1 ORDER BY user_id LIMIT 1)
    RETURNING user_id`).first();
  if (!pending) return;
  const grant = await env.DB.prepare(`SELECT a.user_id,a.encrypted_credential,a.expires_at,u.subject_hash
    FROM account_refresh a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=? AND a.encrypted_credential IS NOT NULL AND a.expires_at>?
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=a.user_id AND s.expires>?)`)
    .bind(pending.user_id, now, now).first();
  if (!grant) return;
  try {
    const token = await decryptAccountCredential(env, {id:grant.user_id,subject_hash:grant.subject_hash}, grant);
    const {subject,subjectHash,battleTag} = await battleNetIdentity(token);
    if (subjectHash !== grant.subject_hash) return;
    await env.DB.prepare(`UPDATE site_battlenet_identities
      SET account_id=COALESCE(account_id,?),battle_tag=COALESCE(?,battle_tag)
      WHERE user_id=? AND (account_id IS NULL OR account_id=?) AND EXISTS(
        SELECT 1 FROM account_refresh a WHERE a.user_id=? AND a.encrypted_credential=? AND a.expires_at>unixepoch())`)
      .bind(subject, battleTag, grant.user_id, subject, grant.user_id, grant.encrypted_credential).run();
  } catch {
    // A later sign-in can supply the account details if the saved authorisation cannot.
  }
}
export async function refreshOneAccount(env){
  const now=epoch();
  await env.DB.prepare(`UPDATE account_refresh SET encrypted_credential=NULL,status=CASE WHEN expires_at<=? THEN 'expired' ELSE 'inactive' END,
    lease_token=NULL,lease_until=0,last_error=NULL WHERE encrypted_credential IS NOT NULL AND (expires_at<=?
      OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=account_refresh.user_id AND s.expires>?)
      OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=account_refresh.user_id AND u.ownership_status='verified'))`).bind(now,now,now).run();
  const pause=await state(env,'blizzard_cooldown');if(typeof pause==='number'&&pause>now)return {processed:false,status:'paused'};
  const lease=random(),row=await env.DB.prepare(`UPDATE account_refresh SET lease_token=?,lease_until=? WHERE user_id=(
    SELECT a.user_id FROM account_refresh a JOIN users u ON u.id=a.user_id WHERE a.encrypted_credential IS NOT NULL
      AND a.expires_at>? AND a.next_at<=? AND a.lease_until<=? AND u.ownership_status='verified'
      AND a.requested_revision IS NOT NULL AND a.requested_revision<>COALESCE(a.checked_revision,'')
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=a.user_id AND s.expires>?) ORDER BY a.next_at,a.user_id LIMIT 1
    ) AND lease_until<=? RETURNING *`).bind(lease,now+180,now,now,now,now,now).first();
  if(!row){await recoverBattleNetIdentity(env,now);return {processed:false};}
  const user=await env.DB.prepare('SELECT id,subject_hash,main_character_id,ownership_status,ownership_checked,updated_at FROM users WHERE id=?').bind(row.user_id).first();
  try{
    const token=await decryptAccountCredential(env,user,row),checked=stamp(),result=await prepareAccountSync(env,user,token,{maxProfiles:2,checkedAt:checked});
    await env.DB.batch([
      env.DB.prepare('INSERT INTO account_refresh_guards VALUES(?,?,?,?,?,?,?,?)').bind(lease,user.id,row.encrypted_credential,row.expires_at,user.subject_hash,user.updated_at,user.ownership_checked,row.requested_revision),
      ...result.statements,
      env.DB.prepare("UPDATE account_refresh SET status='active',checked_at=?,next_at=?,checked_revision=?,last_error=NULL,lease_token=NULL,lease_until=0 WHERE user_id=? AND encrypted_credential=? AND lease_token=?")
        .bind(checked,Math.min(epoch()+900,row.expires_at),row.requested_revision,user.id,row.encrypted_credential,lease),
      env.DB.prepare('DELETE FROM account_refresh_guards WHERE lease_token=?').bind(lease)
    ]);
    return {processed:true,status:'active',owned_count:result.ownedIds.length};
  }catch(error){
    const superseded=String(error?.message||'').includes('Account refresh is no longer current'),invalid=error?.name==='AccountCredentialError'||[401,403].includes(error?.providerStatus);
    if(invalid){
      const result=await env.DB.batch([
        env.DB.prepare(`UPDATE users SET ownership_status='unavailable' WHERE id=? AND subject_hash=? AND EXISTS(
          SELECT 1 FROM account_refresh a WHERE a.user_id=users.id AND a.encrypted_credential=? AND a.lease_token=?)`).bind(row.user_id,user?.subject_hash||'',row.encrypted_credential,lease),
        env.DB.prepare("UPDATE account_refresh SET encrypted_credential=NULL,status='reconnect_required',next_at=0,last_error='Battle.net authorization needs to be renewed',lease_token=NULL,lease_until=0 WHERE user_id=? AND encrypted_credential=? AND lease_token=?")
          .bind(row.user_id,row.encrypted_credential,lease)
      ]);
      return {processed:true,status:Number(result[1]?.meta?.changes??result[1]?.changes??0)>0?'reconnect_required':'superseded'};
    }
    const retry=error?.providerStatus===429?Math.max(60,safeRetry(error.retryAfter)||300):superseded?60:Math.max(300,safeRetry(error?.retryAfter));
    if(error?.providerStatus===429)await env.DB.prepare(`INSERT INTO state(key,value) VALUES('blizzard_cooldown',?)
      ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(state.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)`).bind(String(epoch()+retry)).run();
    const status=superseded?'active':'unavailable',note=superseded?null:'The account check could not complete; previous ownership observations are retained';
    await env.DB.prepare(`UPDATE account_refresh SET encrypted_credential=CASE WHEN ? THEN NULL ELSE encrypted_credential END,
      status=?,next_at=?,last_error=?,lease_token=NULL,lease_until=0 WHERE user_id=? AND encrypted_credential=? AND lease_token=?`)
      .bind(invalid?1:0,status,epoch()+retry,note,row.user_id,row.encrypted_credential,lease).run();
    return {processed:true,status:superseded?'superseded':'unavailable'};
  }
}
