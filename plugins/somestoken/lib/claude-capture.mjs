// Claude transcript parsing: the rows a transcript yields and the label of the
// collector that parsed them. The capture revision covers this module and what
// it imports, so a release that changes only registration, recovery or feed
// storage reuses sources captured before.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {StringDecoder} from 'node:string_decoder';
import { hashOpaqueHostIdentifier, moduleRevision, safeModel } from './core.mjs';
import { normalizeClaudeUsage, claudeCacheSemantics } from './hosts/claude-code.mjs';

export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
// No transcript over 2 GiB is read. Below it, `maxBytes` bounds the bytes one
// capture parses; a verified checkpoint prefix is only checked again.
export const TRANSCRIPT_CEILING_BYTES = 2 * 1024 * 1024 * 1024;
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
export const hash = (value, kind) => hashOpaqueHostIdentifier(value, `workspace:claude:${kind}`);
const label = value => typeof value === 'string' && LABEL.test(value) && safeModel(value.replaceAll('+','.')) ? value : 'unknown';

// The package version records which collector captured a source.
export const CAPTURE_REVISION = '+capture.' + moduleRevision(import.meta.url).slice(0,12);
let version = 'unknown';
for (const manifest of ['../.claude-plugin/plugin.json','../.codex-plugin/plugin.json']) {
  try {
    const candidate = label(JSON.parse(fs.readFileSync(new URL(manifest,import.meta.url),'utf8')).version + CAPTURE_REVISION);
    if (candidate !== 'unknown') { version = candidate; break; }
  } catch { /* Try the other supported host package manifest. */ }
}

export function* transcriptLines(file,onIncomplete,maxBytes=MAX_TRANSCRIPT_BYTES,start=0,checkpoint=null) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>TRANSCRIPT_CEILING_BYTES)throw Error('source_bound');
    // One descriptor fixes the snapshot and verifies its saved prefix. Later
    // appends belong to the next capture, including an unfinished last line.
    let bytes=checkpoint ? checkpoint.open(fd,stat) : start;
    if(stat.size-bytes>maxBytes)throw Error('source_bound');
    const buffer=Buffer.allocUnsafe(64*1024),decoder=new StringDecoder('utf8');
    let pending='';
    while(bytes<stat.size){
      const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-bytes),bytes);
      if(!count)throw Error('short_snapshot');
      const chunk=buffer.subarray(0,count),newline=chunk.lastIndexOf(10);
      if(checkpoint?.digest){
        if(newline>=0){
          checkpoint.digest.update(chunk.subarray(0,newline+1));
          checkpoint.size=bytes+newline+1;checkpoint.complete_digest=checkpoint.digest.copy();
          checkpoint.digest.update(chunk.subarray(newline+1));
        }else checkpoint.digest.update(chunk);
      }
      bytes+=count;pending+=decoder.write(chunk);
      let begin=0,end;
      while((end=pending.indexOf('\n',begin))>=0){yield pending.slice(begin,end);begin=end+1;}
      pending=pending.slice(begin);
    }
    pending+=decoder.end();
    if(pending)onIncomplete();
    if(checkpoint)checkpoint.final_stat=fs.fstatSync(fd);
  }finally{fs.closeSync(fd);}
}

export function safeDirectory(root) {
  // Reject symlinks in every existing path component, including ancestors.
  let current = path.parse(root).root;
  for (const component of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,component);
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) return false; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  return true;
}

export function transcriptSignature(file,derived=false,strictSession=false) {
  if(typeof file!=='string'||!path.isAbsolute(file)||!safeDirectory(path.dirname(file)))throw Error('unsafe_transcript');
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe_transcript');
  return crypto.createHash('sha256').update(JSON.stringify([file,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,derived,strictSession,CAPTURE_REVISION])).digest('hex');
}


// Reuse the validated numeric feed; the checkpoint carries no transcript text or rows.
function recordsDigest(records) {
  const digest=crypto.createHash('sha256');
  for(const {captured_at,collector_version,capture_origin,completed,completed_at,...numeric} of records)digest.update(JSON.stringify(numeric)+'\n');
  return digest.digest('hex');
}
// A checkpoint's prefix check is CRC32 where Node has it (owner decision
// 2026-10-27): it catches accidental rewrites, not a hostile same-user writer,
// who could append usage lines anyway.
function prefixCheck(value=0) {
  if(typeof zlib.crc32!=='function')return crypto.createHash('sha256');
  return {update(bytes){value=zlib.crc32(bytes,value);return this;},copy:()=>prefixCheck(value),digest:()=>value.toString(16).padStart(8,'0')};
}
function prefixDigest(fd,size) {
  const digest=prefixCheck(),buffer=Buffer.allocUnsafe(64*1024);
  for(let offset=0;offset<size;){
    const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,size-offset),offset);
    if(!n)throw Error('short_prefix');digest.update(buffer.subarray(0,n));offset+=n;
  }
  return digest;
}

export function captureSource(input, eventName, transcript, agentId, observedAt, requireChildIdentity = false, requireSessionIdentity = false, maxBytes = MAX_TRANSCRIPT_BYTES, resume = null) {
  if (agentId != null && typeof agentId !== 'string') return null;
  const taskKey = hash(input.session_id,'task');
  const mainSource = hash(input.session_id,'source');
  const sourceKey = agentId ? hash(`${input.session_id}:${agentId}`,'source') : mainSource;
  if (!taskKey || !sourceKey) return null;
  const gaps = new Set(), records = new Map();
  if (agentId) gaps.add('child_root_unavailable');
  let turn = null;
  if(resume){resume.next=null;resume.start=0;resume.size=0;}
  const source = { host:'claude',task_key:taskKey,source_key:sourceKey,parent_source:agentId ? mainSource : null,
    role:agentId ? 'subagent':'main',collector_version:version,captured_at:observedAt,
    capture_origin:eventName === null ? 'registered_refresh':'hook',
    reasoning_usage_status:'unmeasured',...claudeCacheSemantics() };
  try {
    if (typeof transcript !== 'string' || !path.isAbsolute(transcript)) throw new Error('transcript_unavailable');
    if (!safeDirectory(path.dirname(transcript))) throw new Error('transcript_unavailable');
    const signature=transcriptSignature(transcript,requireChildIdentity,requireSessionIdentity);
    const saved=resume?.previous,seed=resume?.source;
    const snapshot={open(fd,stat){
      snapshot.stat=stat;let start=0,digest=null;
      try{
        if(saved&&seed&&stat.size>=saved.size&&stat.dev===saved.dev&&stat.ino===saved.ino
          &&saved.derived===requireChildIdentity&&saved.strictSession===requireSessionIdentity
          &&seed.captured_at===saved.captured_at&&(seed.source_signature??null)===saved.signature
          &&seed.source_key===sourceKey&&seed.task_key===taskKey
          &&JSON.stringify(seed.coverage_gaps)===JSON.stringify(saved.gaps)
          &&recordsDigest(seed.records)===saved.records_digest){
          digest=prefixDigest(fd,saved.size);
          if(digest.copy().digest('hex')===saved.digest){
            start=saved.size;turn=saved.turn;
            for(const gap of saved.gaps)if(!['incomplete_transcript_tail','source_changed_during_read','usage_unavailable','child_usage_unavailable'].includes(gap))gaps.add(gap);
            for(const record of seed.records)records.set(record.record_key,{...record,completed:false,completed_at:null,
              collector_version:version,captured_at:observedAt,capture_origin:source.capture_origin});
          }else digest=null;
        }
      }catch{/* A missing, damaged or changed prefix uses the full parser. */}
      if(resume){resume.start=start;resume.size=stat.size;snapshot.digest=digest??prefixCheck();snapshot.size=start;snapshot.complete_digest=snapshot.digest.copy();}
      return start;
    }};
    for (const line of transcriptLines(transcript,()=>gaps.add('incomplete_transcript_tail'),maxBytes,0,snapshot)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { gaps.add('invalid_transcript_record'); continue; }
      if ((requireSessionIdentity && event.type === 'assistant' && event.message?.usage && event.sessionId !== input.session_id) || (event.sessionId && event.sessionId !== input.session_id) || (agentId && event.agentId && event.agentId !== agentId) || (requireChildIdentity && event.type === 'assistant' && event.message?.usage && (event.agentId !== agentId || event.sessionId !== input.session_id))) { gaps.add('source_identity_mismatch'); continue; }
      if (event.type === 'user' && !event.toolUseResult && !event.message?.content?.some?.(item => item?.type === 'tool_result')) {
        turn = hash(event.turn_id ?? event.prompt_id ?? event.uuid,'turn') ?? null;
      }
      if (event.type !== 'assistant' || !event.message?.usage) continue;
      if (event.isApiErrorMessage === true || event.isSynthetic === true || event.message.model === '<synthetic>') continue;
      const responseId = event.message.id ?? event.uuid;
      const responseKey = hash(typeof responseId==='string' && responseId ? `${sourceKey}:${responseId}` : undefined,'response');
      if (!responseKey) { gaps.add('response_identity_unavailable'); continue; }
      const usage = normalizeClaudeUsage(event.message.usage);
      if (usage.quality === 'unavailable') { gaps.add('invalid_response_usage'); continue; }
      const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : event.timestamp;
      if (!Number.isSafeInteger(at) || at <= 0 || !Number.isFinite(new Date(at).getTime())) { gaps.add('response_timestamp_unavailable'); continue; }
      const explicitTurn = hash(event.turn_id ?? event.prompt_id,'turn');
      const turnKey = explicitTurn ?? turn ?? hash(responseKey,'turn');
      const record = { host:'claude',record_key:responseKey,task_key:taskKey,source_key:sourceKey,
        parent_source:source.parent_source,turn_key:turnKey,root_key:agentId ? null : turnKey,role:source.role,
        model:label(event.message.model),effort:label(event.message.effort?.level ?? event.message.effort ?? event.effort?.level ?? event.effort),
        service_tier:'unknown',requested_service_tier:'unknown',observed_at:at,
        completed:false,completed_at:null,duration_ms:null,quality:'exact',
        usage:{input_tokens:usage.input_tokens,cached_input_tokens:usage.cached_input_tokens,
          output_tokens:usage.output_tokens,reasoning_output_tokens:0,total_tokens:usage.total_tokens,
          cache_write_input_tokens:usage.cache_write_input_tokens,consistent:true},
        reasoning_usage_status:'unmeasured',collector_version:version,captured_at:observedAt,capture_origin:source.capture_origin,
        ...claudeCacheSemantics() };
      const previous = records.get(responseKey);
      if (previous && JSON.stringify({...previous,observed_at:0}) !== JSON.stringify({...record,observed_at:0})) {
        // Streaming duplicate messages may have increasing counters. Conflicting
        // versions are partial evidence, never silently added together.
        gaps.add('response_conflict');
      }
      if (previous) record.observed_at = Math.min(previous.observed_at,record.observed_at);
      records.set(responseKey,record);
    }
    if(signature===transcriptSignature(transcript,requireChildIdentity,requireSessionIdentity))source.source_signature=signature;
    else gaps.add('source_changed_during_read');
    if(!records.size)gaps.add(agentId ? 'child_usage_unavailable':'usage_unavailable');
    // Capture time, rows, published gaps and signature bind the exact feed seed;
    // the descriptor identity and complete-prefix check bind its transcript bytes.
    const stat=snapshot.stat,final=snapshot.final_stat;
    if(resume&&snapshot.size>0&&final?.size>=stat.size)try{
      const current=fs.lstatSync(transcript);
      if(current.dev===stat.dev&&current.ino===stat.ino&&current.size>=stat.size)resume.next={size:snapshot.size,dev:stat.dev,ino:stat.ino,
        mtime_ms:stat.mtimeMs,digest:snapshot.complete_digest.digest('hex'),signature:source.source_signature??null,
        captured_at:observedAt,derived:requireChildIdentity,strictSession:requireSessionIdentity,
        turn,gaps:[...gaps],records_digest:recordsDigest(records.values())};
    }catch{/* Optional checkpoint state never prevents ordinary capture. */}
    const closing = eventName === 'SubagentStop' && agentId;
    for (const record of records.values()) {
      if (closing || (eventName === 'Stop' && input.turn_id && record.turn_key === hash(input.turn_id,'turn'))) {
        record.completed = true; record.completed_at = observedAt;
      }
    }
  } catch (error) { gaps.add(error.message === 'source_bound' ? 'transcript_bound' : 'transcript_unavailable'); }
  if (!records.size) gaps.add(agentId ? 'child_usage_unavailable' : 'usage_unavailable');
  return {...source,coverage_status:gaps.size ? 'partial':'exact',coverage_gaps:[...gaps],records:[...records.values()]};
}

export { version };
