import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hashOpaqueHostIdentifier} from '../core.mjs';
import {collectorFreshness} from '../freshness.mjs';

const HOSTS=['codex','claude'],PHASES=['starting','active','stopped'];
const EVENTS=['SessionStart','UserPromptSubmit','PostCompact','Stop','StopFailure','SessionEnd','Check'];
const DIGEST=/^[a-f0-9]{64}$/,COUNT=n=>Number.isSafeInteger(n)&&n>=0;
const STATES=['starting','capturing','healthy','idle','degraded','stopped'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=({host,session_id}={})=>{const key=HOSTS.includes(host)&&hashOpaqueHostIdentifier(session_id,host);return key?`${host}:${key}`:null;};
export const DEVELOPMENT_CONTEXT='SomesToken development check is required for this project at every new or resumed task. Select and read relevant skills and supporting references before implementation. Use optimization.mjs lifecycle status to obtain this task generation, then lifecycle skills --stage selected --generation N --evidence FILE; after applying them, record --stage applied with source, application and verification files. Run lifecycle check before completion. Old generations do not satisfy this check. File-backed self-attestation is not proof of skill effectiveness. Keep the task deliverable first; no routine usage report.';

function collection(value={}) {
 value=value&&typeof value==='object'?value:{};
 return {enabled:value.enabled===true,status:STATES.includes(value.status)?value.status:'unavailable',
  heartbeat_at:COUNT(value.heartbeat_at)?value.heartbeat_at:0,success_at:COUNT(value.success_at)?value.success_at:0,
  failed:value.failed===true,
  interval_seconds:Number.isSafeInteger(value.interval_seconds)&&value.interval_seconds>=15&&value.interval_seconds<=3600?value.interval_seconds:null,
  host_status:['exact','partial','unavailable','disabled'].includes(value.host_status)?value.host_status:'unknown'};
}
function collectionStatus(value,now) {
 if(!value.enabled)return 'not_configured';
 if(value.heartbeat_at>now||value.success_at>now)return 'clock_anomaly';
 if(!value.heartbeat_at)return 'unavailable';
 if(collectorFreshness({status:value.status,interval_seconds:value.interval_seconds,last_attempt_at:value.heartbeat_at},now).stale)return 'stale';
 if(['unavailable','disabled'].includes(value.host_status))return 'unavailable';
 if(value.failed||['degraded','stopped'].includes(value.status))return 'degraded';
 return value.success_at&&['healthy','idle','capturing'].includes(value.status)?'observed':'awaiting_capture';
}
export function normalizeLifecycleChecks(value) {
 const result={generation:COUNT(value?.generation)?value.generation:0,sessions:{}};
 for(const [key,row] of Object.entries(value?.sessions??{}).slice(-128)){
  if(!/^(codex|claude):[a-f0-9]{20}$/.test(key)||!row||!COUNT(row.generation)||row.generation<1
   ||!COUNT(row.started_at)||!COUNT(row.checked_at)||!PHASES.includes(row.phase))continue;
  const selected=(typeof row.selection_digest==='string'&&DIGEST.test(row.selection_digest))&&COUNT(row.skill_count)&&row.skill_count>0&&row.skill_count<=32;
  result.sessions[key]={generation:row.generation,started_at:row.started_at,checked_at:row.checked_at,phase:row.phase,
   development_required:row.development_required===true,collection:collection(row.collection),
   skill_count:selected?row.skill_count:0,selection_digest:selected?row.selection_digest:null,
   evidence_digest:selected&&(typeof row.evidence_digest==='string'&&DIGEST.test(row.evidence_digest))?row.evidence_digest:null};
  result.generation=Math.max(result.generation,row.generation);
 }
 return result;
}

/** A mandatory check record, never a claim that unflushed task usage is known. */
export function recordLifecycleEvent(state,input={},now=Date.now()) {
 const key=identity(input);if(!state||!key||!EVENTS.includes(input.event)||!COUNT(now))return {changed:false};
 const normalized=normalizeLifecycleChecks(state),old=normalized.sessions[key],awaitingPrompt=old?.phase==='starting';
 const opening=['SessionStart','UserPromptSubmit','PostCompact'].includes(input.event);
 const restart=!old||input.event==='PostCompact'||input.event==='SessionStart'&&(!input.duplicateStart||['resume','clear','compact'].includes(input.source))
  ||input.event==='UserPromptSubmit'&&old.phase!=='starting';
 if(!old&&!opening)return {changed:false};
 let row=old;
 if(restart){
  if(normalized.generation===Number.MAX_SAFE_INTEGER)return {changed:false};
  normalized.generation++;
  row={generation:normalized.generation,started_at:now,checked_at:now,phase:'starting',
   development_required:input.developmentRequired===true,skill_count:0,selection_digest:null,evidence_digest:null};
 }
 row.checked_at=now;
 if(input.event==='UserPromptSubmit')row.phase='active';
 if(['Stop','StopFailure','SessionEnd'].includes(input.event))row.phase='stopped';
 const monitor=input.monitor??{},validAt=value=>COUNT(value)?value:0;
 const quotaOnly=monitor.last_error_code==='quota_source_unavailable'&&validAt(monitor.last_success_at)>0;
 row.collection=collection({enabled:input.enabled,status:quotaOnly&&monitor.status==='degraded'?'healthy':monitor.status,
  interval_seconds:monitor.interval_seconds,host_status:monitor.host_status?.[input.host],
  heartbeat_at:collectorFreshness(monitor,now).observed_at,
  success_at:validAt(monitor.last_success_at),failed:Boolean(monitor.last_error_code)&&!quotaOnly});
 delete normalized.sessions[key];normalized.sessions[key]=row;
 Object.assign(state,normalizeLifecycleChecks(normalized));
 return {changed:true,restarted:restart,needs_context:row.development_required&&opening&&(restart||input.event==='UserPromptSubmit'&&awaitingPrompt)};
}

export function lifecycleCheck(state,input={},now=Date.now()) {
 const key=identity(input),row=key&&normalizeLifecycleChecks(state).sessions[key];
 if(!row||!COUNT(now))return {ok:false,status:'not_observed',ready_for_completion:false};
 const tracking=collectionStatus(row.collection,now);
 const skills=!row.development_required?'not_required':!row.selection_digest?'selection_required':!row.evidence_digest?'application_required':'evidence_recorded';
 const ready=tracking==='observed'&&['not_required','evidence_recorded'].includes(skills);
 return {ok:true,status:ready?'ready':'attention',generation:row.generation,phase:row.phase,
  checked_at:row.checked_at,collection_status:tracking,skills_status:skills,skill_count:row.skill_count,
  development_required:row.development_required,ready_for_completion:ready,
  application_basis:'file_backed_self_attestation',skill_effectiveness:'unverified',task_usage_verified:false};
}

export function recordLifecycleSkills(state,input={},now=Date.now()) {
 const key=identity(input),normalized=normalizeLifecycleChecks(state),row=key&&normalized.sessions[key];
 if(!row||input.generation!==row.generation)return {ok:false,error:'stale_lifecycle_generation'};
 if(row.phase==='stopped'||!row.development_required)return {ok:false,error:'development_check_not_active'};
 if(!['selected','applied'].includes(input.stage)||!COUNT(now)||now<row.started_at
  ||!(typeof input.selection_digest==='string'&&DIGEST.test(input.selection_digest))||!COUNT(input.skill_count)||input.skill_count<1||input.skill_count>32)
  return {ok:false,error:'invalid_skill_evidence'};
 if(input.stage==='applied'&&(!(typeof input.evidence_digest==='string'&&DIGEST.test(input.evidence_digest))||row.selection_digest!==input.selection_digest||row.skill_count!==input.skill_count))
  return {ok:false,error:'skill_selection_mismatch'};
 row.skill_count=input.skill_count;row.selection_digest=input.selection_digest;
 row.evidence_digest=input.stage==='applied'?input.evidence_digest:null;row.checked_at=now;
 Object.assign(state,normalized);return lifecycleCheck(state,input,now);
}

function readRegular(file,limit) {
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error('invalid_evidence_file');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>limit)throw Error('invalid_evidence_file');
  // Bound the read itself: a file can grow after fstat, including during a write.
  const bytes=Buffer.alloc(stat.size+1);let size=0,read;
  while(size<bytes.length&&(read=fs.readSync(fd,bytes,size,bytes.length-size,null)))size+=read;
  if(size!==stat.size||fs.fstatSync(fd).size!==stat.size)throw Error('invalid_evidence_file');
  return bytes.subarray(0,size);
 }
 finally{fs.closeSync(fd);}
}
/** Inspect local file evidence, retain hashes only. Contents are never context. */
export function readSkillEvidence(file,stage) {
 try{
  if(!['selected','applied'].includes(stage))throw Error('stage');
  const input=JSON.parse(readRegular(file,65536)),skills=input.skills;
  if(!Array.isArray(skills)||!skills.length||skills.length>32)throw Error('skills');
  const selected=[],applied=[],seen=new Set();
  for(const skill of skills){
   if(typeof skill?.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(skill.id)||seen.has(skill.id)
    ||!Array.isArray(skill.references)||!skill.references.length||skill.references.length>16)throw Error('skill');
   seen.add(skill.id);
   selected.push([skill.id,skill.references.map(file=>hash(readRegular(file,1024*1024))).sort()]);
   if(stage==='applied')applied.push([skill.id,hash(readRegular(skill.application,1024*1024)),hash(readRegular(skill.verification,1024*1024))]);
  }
  selected.sort((a,b)=>a[0].localeCompare(b[0]));applied.sort((a,b)=>a[0].localeCompare(b[0]));
  return {ok:true,proof:{selection_digest:hash(JSON.stringify(selected)),skill_count:skills.length,
   ...(stage==='applied'?{evidence_digest:hash(JSON.stringify(applied))}:{})}};
 }catch{return {ok:false,error:'invalid_skill_evidence'};}
}

export function lifecycleSummary(state,now=Date.now()) {
 const sessions=Object.values(normalizeLifecycleChecks(state).sessions),counts={observed:0,attention:0,required:0,evidence_recorded:0};
 for(const row of sessions){if(collectionStatus(row.collection,now)==='observed')counts.observed++;else counts.attention++;
  if(row.development_required){counts.required++;if(row.evidence_digest)counts.evidence_recorded++;}}
 return {schema_version:1,evaluated_at:now,measurement_basis:'retained_lifecycle_checks',session_count:sessions.length,retained_limit:128,collection_observed:counts.observed,
  collection_attention:counts.attention,development_required:counts.required,development_evidence_recorded:counts.evidence_recorded,
  development_pending:counts.required-counts.evidence_recorded,application_basis:'file_backed_self_attestation',skill_effectiveness:'unverified',task_usage_verified:false};
}

export function sanitizeLifecycleSummary(value) {
 const fields=['session_count','collection_observed','collection_attention','development_required','development_evidence_recorded','development_pending'];
 if(value?.schema_version!==1||!COUNT(value.evaluated_at)||!fields.every(key=>COUNT(value[key])&&value[key]<=128)
  ||value.collection_observed+value.collection_attention!==value.session_count
  ||value.development_evidence_recorded+value.development_pending!==value.development_required
  ||value.development_required>value.session_count)return null;
 return {schema_version:1,evaluated_at:value.evaluated_at,measurement_basis:'retained_lifecycle_checks',retained_limit:128,
  ...Object.fromEntries(fields.map(key=>[key,value[key]])),application_basis:'file_backed_self_attestation',skill_effectiveness:'unverified',task_usage_verified:false};
}
