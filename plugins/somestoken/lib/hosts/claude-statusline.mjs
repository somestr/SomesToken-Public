import { isHostOwnedAbsolutePath, unlinkOwnedFile } from '../host-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {hashOpaqueHostIdentifier,safeModel,isHashedIdentity,humanLabel} from '../core.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LABEL=/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
// Claude aliases and full identifiers may carry the official context suffix.
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:+-]*(?:\[1m\])?$/i;
const MAX_STATUS_FILES=1024,MAX_RECOVERY_READ_FILES=2048,STATUS_RETENTION_MS=7*86400000;
function directorySafe(root) {
  if(typeof root!=='string'||!path.isAbsolute(root))return false;
  for(let p=root;;p=path.dirname(p)) {
    try{const stat=fs.lstatSync(p);if(!stat.isDirectory()||stat.isSymbolicLink())return false;}catch(e){if(e.code!=='ENOENT')return false;}
    if(path.dirname(p)===p)return true;
  }
}
function regularJson(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>8192)throw Error('status_bound');
    const buffer=Buffer.allocUnsafe(stat.size+1);let used=0,count;
    while(used<buffer.length&&(count=fs.readSync(fd,buffer,used,buffer.length-used,null)))used+=count;
    if(used>stat.size)throw Error('status_bound');
    return JSON.parse(buffer.subarray(0,used).toString('utf8'));
  }
  finally{fs.closeSync(fd);}
}

/** Official Claude status-line stdin. Context-window counters are deliberately
 * not treated as consumed tokens. Account identity is absent from this surface. */
export function normalizeClaudeStatus(input,{now=Date.now()}={}) {
  if(typeof input?.session_id!=='string'||!UUID.test(input.session_id)||!Number.isSafeInteger(now))return null;
  const task_key=hashOpaqueHostIdentifier(input.session_id,'workspace:claude:task');
  return statusFields(input,task_key,now);
}
function statusFields(input,task_key,now) {
  const quota_windows=[];
  for(const [window_id,window_duration_mins] of [['five_hour',300],['seven_day',10080]]) {
    const w=input.rate_limits?.[window_id];
    if(!w||typeof w.used_percentage!=='number'||!Number.isFinite(w.used_percentage)||w.used_percentage<0||w.used_percentage>100
      ||!Number.isSafeInteger(w.resets_at)||w.resets_at*1000<=now||!Number.isSafeInteger(w.resets_at*1000))continue;
    quota_windows.push({provider:'claude',window_id,window_duration_mins,used_percent:w.used_percentage,remaining_percent:100-w.used_percentage,
      resets_at_ms:w.resets_at*1000,snapshot_at_ms:now,scope:'account',identity_basis:'account_identity_unavailable',measurement_basis:'host_percent'});
  }
  return {host:'claude',task_key,source:'claude_statusline',observed_at:now,
    configured_model:typeof input.model?.id==='string'&&input.model.id.length<=80&&MODEL.test(input.model.id)&&safeModel(input.model.id.replace(/\[1m\]$/i,'').replaceAll('+','.'))?input.model.id:'unknown',
    configured_effort:['low','medium','high','xhigh','max'].includes(input.effort?.level)?input.effort.level:'unknown',
    host_version:typeof input.version==='string'&&LABEL.test(input.version)&&safeModel(input.version.replaceAll('+','.'))?input.version:'unknown',quota_windows,
    quota_attribution:'account_shared_unavailable',quota_observation_status:quota_windows.length?'observed':'unavailable',
    account_coverage:'account_identity_unavailable',source_freshness:'host_delivery_time_provider_refresh_unknown'};
}

export function captureClaudeStatus(input,root,{now=Date.now()}={}) {
  const record=normalizeClaudeStatus(input,{now});
  if(!record||!directorySafe(root))return {status:'unavailable'};
  const directory=path.join(root,'.statusline');
  if(!directorySafe(directory))return {status:'unavailable'};
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  let names=fs.readdirSync(directory);
  // Only this module's bounded numeric snapshots can be expired.
  for(const name of names)if(/^[a-f0-9]{20}\.json$/.test(name)) {
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    if(stat.isFile()&&!stat.isSymbolicLink()&&now-stat.mtimeMs>STATUS_RETENTION_MS)fs.unlinkSync(file);
  }
  names=fs.readdirSync(directory);
  const targetName=record.task_key+'.json';
  if(names.length>=MAX_STATUS_FILES&&!names.includes(targetName))return {status:'unavailable'};
  const target=path.join(directory,targetName),temp=path.join(directory,'.'+crypto.randomBytes(8).toString('hex')+'.tmp');
  let fd,owned;
  try{fd=fs.openSync(temp,'wx',0o600);owned=fs.fstatSync(fd);fs.writeFileSync(fd,JSON.stringify(record));fs.closeSync(fd);fd=undefined;fs.renameSync(temp,target);}
  finally{try{if(fd!==undefined)fs.closeSync(fd);}finally{try{unlinkOwnedFile(temp,owned);}catch{/* Already renamed. */}}}
  return {status:'captured',record};
}

export function readClaudeStatus(root,{now=Date.now()}={}) {
  if(!directorySafe(root))return [];
  const directory=path.join(root,'.statusline');if(!directorySafe(directory))return [];
  try {
    const names=[];
    for(const name of fs.readdirSync(directory))if(/^[a-f0-9]{20}\.json$/.test(name)){
      names.push(name);if(names.length>=MAX_RECOVERY_READ_FILES)break;
    }
    return names.flatMap(name=>{
      try {
        const r=regularJson(path.join(directory,name));
        if(name!==r.task_key+'.json')return [];
        const clean=publicClaudeStatus(r,{now});return clean?[clean]:[];
      }catch{return [];}
    }).sort((a,b)=>b.observed_at-a.observed_at).slice(0,128);
  }catch{return [];}
}

/** One task's own status-line record. Other sessions may belong to another account. */
export function readClaudeTaskStatus(root,sessionId,{now=Date.now()}={}) {
  if(typeof sessionId!=='string'||!UUID.test(sessionId)||!directorySafe(root))return null;
  const directory=path.join(root,'.statusline');if(!directorySafe(directory))return null;
  try{return publicClaudeStatus(regularJson(path.join(directory,hashOpaqueHostIdentifier(sessionId,'workspace:claude:task')+'.json')),{now});}
  catch{return null;}
}

export function publicClaudeStatus(r,{now=Date.now()}={}) {
  if(!isHashedIdentity(r?.task_key)||r.source!=='claude_statusline'||!Number.isSafeInteger(r.observed_at)
    ||r.observed_at>now||now-r.observed_at>7*86400000)return null;
  const input={model:{id:r.configured_model},effort:{level:r.configured_effort},version:r.host_version,rate_limits:{}};
  for(const q of (Array.isArray(r.quota_windows)?r.quota_windows:[]).slice(0,2))if(['five_hour','seven_day'].includes(q?.window_id))
    input.rate_limits[q.window_id]={used_percentage:q.used_percent,resets_at:q.resets_at_ms/1000};
  const clean=statusFields(input,r.task_key,r.observed_at);
  clean.quota_windows=clean.quota_windows.filter(q=>q.resets_at_ms>now);
  if(!clean.quota_windows.length)clean.quota_observation_status='unavailable';
  return {...clean,stale:now-r.observed_at>120000,
    quota_observation_status:now-r.observed_at>120000?'stale':clean.quota_observation_status};
}

/**
 * Bounded feasibility result for an optional Claude status-line companion.
 * Claude's status-line contract supplies session JSON but does not establish
 * access to SomesToken's plugin-data directory. We therefore never guess a
 * path, read a file, or edit settings here.
 */
export function statusLineFeasibility(env = {}) {
  const explicitSurface = typeof env.CLAUDE_STATUSLINE_SOMESTOKEN_SURFACE === 'string'
    ? env.CLAUDE_STATUSLINE_SOMESTOKEN_SURFACE
    : '';
  if (explicitSurface === 'plugin_data_v1') {
    return {
      status: 'candidate',
      reason_code: 'explicit_surface_requires_manual_enablement',
      source: 'explicit_environment',
      network: false,
      settings_changed: false,
    };
  }
  const declared = isHostOwnedAbsolutePath(env.CLAUDE_PLUGIN_DATA) ? 'declared_but_unverified' : 'unavailable';
  return {
    status: 'unavailable',
    reason_code: 'plugin_data_surface_unconfirmed',
    source: declared,
    network: false,
    settings_changed: false,
  };
}

const CACHE_TTL_MS={'5m':300000,'1h':3600000};
/** Claude Code's own prompt-cache state for the main conversation (status-line
 * `prompt_cache`, Claude Code 2.1.251+). Display only; never stored. The flag can
 * be one refresh old, so a warm claim needs an expiry that is still ahead of now
 * and within the reported TTL. Absent or malformed input makes no claim. */
export function claudeCacheSegment(input,{now=Date.now()}={}) {
  const c=input?.prompt_cache;
  if(typeof c?.warm!=='boolean')return null;
  if(c.caching_observed===false)return 'cache not observed';
  if(!c.warm)return 'cache cold';
  const left=c.expires_at*1000-now;
  if(!Number.isSafeInteger(c.expires_at)||!(left<=CACHE_TTL_MS[c.ttl]))return null;
  if(left<=0)return 'cache cold';
  return `cache warm (${left<60000?'<1':Math.floor(left/60000)}m left)`;
}

export function fitStatusLine(parts,{columns=256}={}) {
  const width=Number(columns),limit=Number.isSafeInteger(width)&&width>0?Math.min(width,256):256;
  const segments=[...parts],full=segments.join(' · ');if(full.length<=limit)return full;
  while(segments.length>1){segments.pop();const text=segments.join(' · ')+' · …';if(text.length<=limit)return text;}
  return limit===1?'…':segments[0].slice(0,limit-1)+'…';
}
export function formatStatusLine(snapshot,options={}) {
  const usage=snapshot?.usage?.total_tokens;
  const total=Number.isSafeInteger(usage)&&usage>=0?`${usage.toLocaleString('en-US')} tokens`:'usage unavailable';
  const parts=total==='usage unavailable'?['SomesToken',total,'next: check diagnostics']
    :['SomesToken',total,humanLabel(snapshot?.usage?.quality),`efficiency ${humanLabel(snapshot?.efficiency?.classification??'insufficient_evidence')}`];
  return fitStatusLine(parts,options);
}
