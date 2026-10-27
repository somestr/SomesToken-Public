import { unlinkOwnedFile } from './host-paths.mjs';
import { zstdChunks } from './zstd-stream.mjs';
export const localGapCodes=new Set(['conflicting_thread_metadata','unreconciled_turn_usage','invalid_turn_usage','invalid_usage_record','source_identity_mismatch','malformed_usage_line','oversized_usage_line']);
for(const code of ['legacy_counter_observations','legacy_context_unavailable','legacy_counter_discontinuity','invalid_legacy_usage','legacy_response_bound','legacy_root_unavailable','inherited_history_boundary_unavailable','inherited_history_boundary_conflict','compressed_source_unreadable'])localGapCodes.add(code);
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createCodexLedgerReader, hashOpaqueHostIdentifier, moduleRevision, safeOpaqueHostIdentifier, sumUsage } from './core.mjs';

// This stable operator configuration survives cachebuster installs. Merely
// locating a config file never authorizes reading host session history.
function configurationDirectory(env) {
  const home=env.CODEX_HOME ?? (!env.PLUGIN_DATA && env.HOME ? path.join(env.HOME,'.codex') : null);
  return typeof home==='string' && path.isAbsolute(home) ? path.join(home,'somestoken') : null;
}
function readConfiguration(directory) {
  if(!directory || fs.lstatSync(directory).isSymbolicLink()) throw new Error('unsafe-config');
  const file=path.join(directory,'ledger-config.json');
  const fd=openRegular(file);
  try {
    const stat=fs.fstatSync(fd);if(stat.size>2048) throw new Error('config-bound');
    const buffer=Buffer.allocUnsafe(stat.size+1);let used=0,count;
    while(used<buffer.length&&(count=fs.readSync(fd,buffer,used,buffer.length-used,null)))used+=count;
    if(used>stat.size)throw Error('config-bound');
    return JSON.parse(buffer.subarray(0,used).toString('utf8'));
  } finally {fs.closeSync(fd);}
}
export function configuredCodexLedgerRoot(env={}, pluginRoot=null) {
  if(env.SOMESTOKEN_CODEX_SESSION_ROOT) return env.SOMESTOKEN_CODEX_SESSION_ROOT;
  const stable=configurationDirectory(env);
  for(const directory of [stable,pluginRoot ? path.join(pluginRoot,'.somestoken-public') : null]) {
    if(!directory) continue;
    try {
      const config=readConfiguration(directory);
      return config.enabled===true && typeof config.session_root==='string' && path.isAbsolute(config.session_root)
        ? config.session_root : null;
    } catch(error) {
      // An existing invalid config must not silently inherit older consent.
      if(error.code!=='ENOENT') return null;
    }
  }
  return null;
}
export function configureCodexLedger(root,env=process.env) {
  const directory=configurationDirectory(env);
  if(!directory) throw new Error('missing-operator-home');
  if(root!==null && (!path.isAbsolute(root) || !fs.statSync(root).isDirectory())) throw new Error('invalid-session-root');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.lstatSync(directory).isSymbolicLink()) throw new Error('unsafe-config');
  let claudeRoot=null,claudeProjectRoot=null;try{const existing=readConfiguration(directory);if(existing.enabled===true&&typeof existing.claude_workspace_root==='string'&&path.isAbsolute(existing.claude_workspace_root))claudeRoot=existing.claude_workspace_root;if(existing.enabled===true&&typeof existing.claude_project_root==='string'&&path.isAbsolute(existing.claude_project_root))claudeProjectRoot=existing.claude_project_root;}catch(error){if(error.code!=='ENOENT')throw error;}
  const target=path.join(directory,'ledger-config.json');
  const temporary=target+'.tmp-'+crypto.randomBytes(8).toString('hex');
  let fd,owned;
  try {
    fd=fs.openSync(temporary,'wx',0o600);owned=fs.fstatSync(fd);
    fs.writeFileSync(fd,JSON.stringify({enabled:root!==null||claudeRoot!==null,...(root===null?{}:{session_root:fs.realpathSync(root)}),...(claudeRoot?{claude_workspace_root:claudeRoot}:{}),...(claudeProjectRoot?{claude_project_root:claudeProjectRoot}:{})})+'\n');
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,target);
  } finally {try{if(fd!==undefined)fs.closeSync(fd);}finally{unlinkOwnedFile(temporary,owned);}}
}

// Explicit operator opt-in only. The caller cannot supply a path or task ID
// through MCP arguments. No files, prompts, credentials or identifiers leave
// this reader; it never writes host transcripts or SomesToken receipt state.
const MAX_FILES = 20000;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_READ_BYTES = 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PREFIX_CONTEXTS = 4096;
// Codex compresses older rollouts to .jsonl.zst. Node reads zstd from 22.15
// and 23.8 (experimental); without it a compressed rollout is a gap.
// A compressed rollout is inflated whole up to MAX_INFLATED_BYTES; a larger
// one streams through zstd-stream.mjs.
const COMPRESSED = '.jsonl.zst';
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
// Workspace retention keeps 90 days (workspace-usage.mjs). A compressed
// rollout last written before that holds only rows the store would drop.
const COMPRESSED_HORIZON_MS = 92 * 24 * 60 * 60 * 1000;
const hash = (id, kind) => hashOpaqueHostIdentifier(id, `ledger:${kind}`);
function openRegular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('not-regular'); return fd; }
  catch (error) { fs.closeSync(fd); throw error; }
}
function readInto(fd,b,from,to) {
  while(from<to){const n=fs.readSync(fd,b,from,to-from,from);if(!n)throw new Error('short-read');from+=n;}
  return to;
}
// While both exist the plain copy is read: the compressed one may be incomplete.
function rolloutFile(item,file,names,budget) {
  if(!item.isFile())return false;
  if(item.name.endsWith('.jsonl'))return true;
  if(!item.name.endsWith(COMPRESSED)||names.has(item.name.slice(0,-4))
    ||fs.lstatSync(file,{throwIfNoEntry:false})?.mtimeMs<Date.now()-COMPRESSED_HORIZON_MS)return false;
  if(typeof zlib.zstdDecompressSync==='function')return true;
  budget.incomplete=true;budget.gaps.add('compressed_source_unsupported');return false;
}
// Over the remaining capture budget: an ordinary byte bound, retried by the
// next capture. Undecodable: a local gap that a reused source keeps until its
// file changes. Over MAX_INFLATED_BYTES: 'stream'.
function inflate(fd,stat,budget) {
  const limit=Math.min(MAX_INFLATED_BYTES,budget.remaining);
  if(stat.size<=limit) {
    const input=Buffer.allocUnsafe(stat.size);readInto(fd,input,0,stat.size);
    try {return zlib.zstdDecompressSync(input,{maxOutputLength:limit});}
    catch(error) {if(error?.code!=='ERR_BUFFER_TOO_LARGE'){budget.incomplete=true;budget.gaps.add('compressed_source_unreadable');return false;}}
  }
  if(limit<MAX_INFLATED_BYTES)throw new Error('byte-bound');
  return 'stream';
}
// Streams a compressed rollout only until its first line ends or the header
// bound is reached; leaving the loop cancels the worker.
function streamedHeader(file,fd) {
  const parts=[];let size=0;
  for(const chunk of zstdChunks(file,fs.fstatSync(fd))) {
    parts.push(Buffer.from(chunk));size+=chunk.length;
    if(chunk.includes(10)||size>=MAX_HEADER_BYTES)break;
  }
  return Buffer.concat(parts);
}
function header(file,scratch=null) {
  const fd = openRegular(file);
  try {
    const b = scratch??Buffer.allocUnsafe(MAX_HEADER_BYTES);
    let n=0, end=-1, text=b;
    if(file.endsWith(COMPRESSED)) {
      // Only the first line: decompress a growing prefix, the way the zlib
      // documentation inspects the beginning of a compressed file. A few KiB
      // can inflate to many MiB; a prefix past 16 MiB streams instead.
      const size=fs.fstatSync(fd).size;
      for(let read=0,want=16*1024;end<0&&read<Math.min(size,b.length);want*=2) {
        read=readInto(fd,b,read,Math.min(want,size,b.length));
        try {text=zlib.zstdDecompressSync(b.subarray(0,read),{finishFlush:zlib.constants.ZSTD_e_flush,maxOutputLength:64*MAX_HEADER_BYTES});}
        catch(error) {if(error?.code!=='ERR_BUFFER_TOO_LARGE')throw error;text=streamedHeader(file,fd);read=size;}
        end=text.subarray(0,MAX_HEADER_BYTES).indexOf(10);
      }
      n=end+1;
    } else while(n<b.length && end<0) {
      const read=fs.readSync(fd,b,n,Math.min(4096,b.length-n),n);
      if(!read) break;
      end=b.subarray(0,n+read).indexOf(10); n+=read;
    }
    if (end < 0) throw new Error('header-bound');
    const e = JSON.parse(text.subarray(0,end).toString('utf8'));
    if (e.type !== 'session_meta' || !safeOpaqueHostIdentifier(e.payload?.id)) throw new Error('metadata');
    const topParentRaw=e.payload.parent_thread_id;
    const nestedParentRaw=e.payload.source?.subagent?.thread_spawn?.parent_thread_id;
    const topParent=safeOpaqueHostIdentifier(topParentRaw),nestedParent=safeOpaqueHostIdentifier(nestedParentRaw);
    const declaredParent=topParentRaw!=null||nestedParentRaw!=null;
    const ancestryConflicted=(topParentRaw!=null&&!topParent)||(nestedParentRaw!=null&&!nestedParent)
      ||Boolean(topParent&&nestedParent&&topParent!==nestedParent);
    return { bytes:n, id:e.payload.id,parent:ancestryConflicted?null:topParent??nestedParent,
      declaredParent,ancestryConflicted,
      session:safeOpaqueHostIdentifier(e.payload.session_id),
      historyStart:e.payload.subagent_history_start_ordinal==null?null:e.payload.history_mode==='paginated'&&Number.isSafeInteger(e.payload.subagent_history_start_ordinal)&&e.payload.subagent_history_start_ordinal>=0?e.payload.subagent_history_start_ordinal:'invalid',
      historyBase:e.payload.history_base==null?0:Number.isSafeInteger(e.payload.history_base.end_ordinal_exclusive)&&e.payload.history_base.end_ordinal_exclusive>=0?e.payload.history_base.end_ordinal_exclusive:null };
  } finally { fs.closeSync(fd); }
}
function relevant(prefix) {
  return /"type"\s*:\s*"(?:session_meta|turn_context|token_usage_record)"/.test(prefix)
    || (/"type"\s*:\s*"event_msg"/.test(prefix) && /"type"\s*:\s*"(?:task_complete|token_count|thread_settings_applied)"/.test(prefix));
}
// Detects bytes that change while one capture reads them, and verifies a
// checkpoint's prefix (owner decision 2026-10-27). CRC32 is ~4x cheaper than
// SHA-256 on multi-gigabyte rollouts; it guards against an accidental or
// concurrent rewrite, not a hostile writer (who could append usage lines anyway).
function changeCheck() {
  if(typeof zlib.crc32!=='function'){const hash=crypto.createHash('sha256');return {update:bytes=>hash.update(bytes),result:()=>hash.copy().digest('hex')};}
  let value=0;return {update:bytes=>{value=zlib.crc32(bytes,value);},result:()=>value};
}
// `checkpoint` keeps the prefix's check value so a later read can resume after it.
function streamLedger(file, budget, reader = createCodexLedgerReader(), source = null, previous = null, scratch = null, checkpoint = false) {
  const fd = openRegular(file);
  let pending = [], pendingBytes=0, skipped = false, rejected = false, incremental = false, chunks = null;
  let parsedBytes=0, lastByte=null;
  const boundedHistory=source?.historyStart!=null;
  let ownHistory=!boundedHistory,boundaryFailed=false,nextOrdinal=source?.historyBase??null,lastOrdinal=null;
  let prefixContexts=new Map(),foreignPrefix=false;
  const rejectBoundary=()=>{boundaryFailed=true;rejected=true;reader.resetContext(source?.id,source?.session);budget.incomplete=true;budget.gaps.add('inherited_history_boundary_unavailable');};
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > budget.remaining) throw new Error('byte-bound');
    // A compressed rollout never grows: its inflated bytes are parsed as one
    // chunk, or as streamed chunks, without a checkpoint.
    const compressed=file.endsWith(COMPRESSED),inflated=compressed?inflate(fd,stat,budget):null;
    if(inflated===false)return {reader,incremental,parsedBytes,cache:null};
    chunks=inflated==='stream'?zstdChunks(file,stat):null;
    const whole=Buffer.isBuffer(inflated)?inflated:null,size=whole?.length??stat.size;
    let b = whole??scratch??Buffer.allocUnsafe(1024 * 1024);
    const strong=!compressed&&(checkpoint||Boolean(previous));
    let position=0, check=changeCheck();
    // Reuse only numeric parser state. Every byte of its prefix is re-read and
    // checked; size/mtime growth alone never authorizes skipping a rewritten prefix.
    if(strong && previous && stat.dev===previous.dev && stat.ino===previous.ino && stat.size>previous.size) {
      while(position<previous.size) {
        const n=fs.readSync(fd,b,0,Math.min(b.length,previous.size-position),position);
        if(!n)throw new Error('short-read');
        check.update(b.subarray(0,n));position+=n;budget.remaining-=n;
      }
      if(check.result()===previous.digest) {
        reader=previous.reader;incremental=true;
        ownHistory=previous.ownHistory;nextOrdinal=previous.nextOrdinal;lastOrdinal=previous.lastOrdinal;
        prefixContexts=new Map(previous.prefixContexts);foreignPrefix=previous.foreignPrefix;
      } else {position=0;check=changeCheck();}
    }
    if(!incremental)reader.resetContext(source?.id,source?.session);
    function acceptLine(line) {
      if(!line.length||line.every(byte=>byte===32||byte===9||byte===13))return;
      const relevantLine=relevant(line.subarray(0,256).toString('utf8'));
      const checkingPrefix=boundedHistory&&!ownHistory&&!boundaryFailed;
      if(!relevantLine&&!checkingPrefix)return;
      const structured=/"type"\s*:\s*"token_usage_record"/.test(line.subarray(0,256).toString('utf8'));
      if(line.length>MAX_LINE_BYTES){if(checkingPrefix)rejectBoundary();if(structured)reader.rejectStructuredSource();budget.incomplete=true;budget.gaps.add('oversized_usage_line');return;}
      try {
        const event=JSON.parse(line.toString('utf8'));
        if(boundedHistory) {
          const ordinal=event.ordinal;
          if(checkingPrefix) {
            if(!Number.isSafeInteger(source.historyStart)||!Number.isSafeInteger(nextOrdinal)||!Number.isSafeInteger(ordinal)||ordinal!==nextOrdinal)rejectBoundary();
            else {
              lastOrdinal=ordinal;nextOrdinal=ordinal+1;
              if(ordinal<source.historyStart) {
                // Projection history is not a billing authority. A counter
                // with this child's own identity survives a conflicting
                // projection boundary. Its turn's context describes it only
                // while the prefix holds no other thread's counter: guardian
                // reviews declare the start after their own turns, while a
                // real projection carries the parent's counters first.
                if(event.type==='turn_context'&&!foreignPrefix&&typeof event.payload?.turn_id==='string'&&prefixContexts.size<MAX_PREFIX_CONTEXTS)prefixContexts.set(event.payload.turn_id,event);
                else if(event.type==='token_usage_record') {
                  if(event.payload?.thread_id===source.id&&(!source.session||event.payload?.session_id===source.session)) {
                    budget.incomplete=true;budget.gaps.add('inherited_history_boundary_conflict');
                    const context=foreignPrefix?null:prefixContexts.get(event.payload.turn_id);
                    if(context)reader.accept(context);
                    reader.accept(event);
                  }else{foreignPrefix=true;prefixContexts.clear();}
                }
                return;
              }
              ownHistory=true;reader.resetContext(source.id,source.session);rejected=false;
            }
          } else if(!boundaryFailed) {
            if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal<=lastOrdinal)rejectBoundary();
            else lastOrdinal=ordinal;
          }
          if(boundaryFailed&&event.type!=='token_usage_record')return;
        }
        if(!relevantLine)return;
        if(event.type==='session_meta' && source) {
          if(event.payload?.id!==source.id || (source.session && event.payload?.session_id!==source.session)) {
            reader.resetContext(source.id,source.session);
            rejected=true;budget.incomplete=true;budget.gaps.add('source_identity_mismatch');return;
          }
          rejected=false;
        }
        // A fork may contain parent history. Its context cannot authorize child
        // metadata, but a matching structured record independently proves its
        // own counters. It never restores trust to later contextual events.
        if(event.type==='token_usage_record' && source) {
          if(event.payload?.thread_id!==source.id || (source.session && event.payload?.session_id!==source.session)) {
            reader.rejectStructuredSource();
            budget.incomplete=true;budget.gaps.add('source_identity_mismatch');return;
          }
          reader.accept(event);return;
        }
        if(!rejected)reader.accept(event);
      }catch{if(checkingPrefix)rejectBoundary();if(structured)reader.rejectStructuredSource();budget.incomplete=true;budget.gaps.add('malformed_usage_line');}
    }
    for (;;) {
      let n;
      if(chunks){
        const next=chunks.next();if(next.done)break;
        b=next.value;n=b.length;if(!n)continue;
        if(n>budget.remaining)throw new Error('byte-bound');
      }else{
        if(position>=size)break;
        if(budget.remaining<=0)throw new Error('byte-bound');
        n=whole?size:fs.readSync(fd,b,0,Math.min(b.length,stat.size-position,budget.remaining),position);
        if (!n) throw new Error('short-read');
      }
      check.update(b.subarray(0,n));lastByte=b[n-1];
      position+=n;budget.remaining-=n;parsedBytes+=n;
      let start=0, end;
      while ((end=b.indexOf(10,start))>=0&&end<n) {
        if(skipped)skipped=false;
        else if(pendingBytes){
          acceptLine(Buffer.concat([...pending,b.subarray(start,end)],pendingBytes+end-start));
          pending=[];pendingBytes=0;
        }else acceptLine(b.subarray(start,end));
        start=end+1;
      }
      if(!skipped&&start<n){pending.push(Buffer.from(b.subarray(start,n)));pendingBytes+=n-start;}
      // A long line acceptLine would ignore by its first 256 bytes is skipped
      // now instead of being buffered to its end (up to MAX_LINE_BYTES).
      if(!skipped&&pendingBytes>=256&&!(boundedHistory&&!ownHistory&&!boundaryFailed)&&!relevant(Buffer.concat(pending,256).toString('utf8'))){
        pending=[];pendingBytes=0;skipped=true;
      }
      if(pendingBytes>MAX_LINE_BYTES){
        if(boundedHistory&&!ownHistory&&!boundaryFailed)rejectBoundary();
        const prefix=Buffer.concat(pending,Math.min(pendingBytes,256)).toString('utf8');
        if(relevant(prefix)){if(/"type"\s*:\s*"token_usage_record"/.test(prefix))reader.rejectStructuredSource();budget.incomplete=true;budget.gaps.add('oversized_usage_line');}
        pending=[];pendingBytes=0;skipped=true;
      }
    }
    // Unterminated records can be observed, but their parser state is never
    // reused: a later append may complete or change that same line.
    if(pendingBytes&&!skipped)acceptLine(Buffer.concat(pending,pendingBytes));
    const captured=check.result();
    const after=fs.fstatSync(fd);
    let stable=true;
    if(after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs) {
      stable=!compressed && after.size>=stat.size && budget.remaining>=stat.size;
      if(stable){
        const again=changeCheck();let offset=0;
        while(offset<stat.size){
          const n=fs.readSync(fd,b,0,Math.min(b.length,stat.size-offset),offset);
          if(!n){stable=false;break;}
          again.update(b.subarray(0,n));offset+=n;budget.remaining-=n;
        }
        stable=stable&&again.result()===captured;
      }
      if(!stable){budget.incomplete=true;budget.gaps.add('source_changed_during_read');}
    }
    return {reader,incremental,parsedBytes,
      cache:strong&&stable&&!rejected&&lastByte===10&&!skipped?{reader,size:stat.size,dev:stat.dev,ino:stat.ino,digest:captured,ownHistory,nextOrdinal,lastOrdinal,prefixContexts:[...prefixContexts],foreignPrefix}:null};
  } finally {chunks?.return();fs.closeSync(fd);}
}

export function readCodexTaskLedger(root, taskSession, options = {}) {
  const unavailable = (reason) => ({ status:'unavailable', scope:'current_task_completed_turns',
    history_coverage:'bounded_host_ledger', current_turn_usage:'unavailable',
    current_turn:{status:'unavailable',main_usage:null,subagent_usage:null,is_final:false,availability_reason:reason},
    usage_source:'codex_structured_ledger', availability_reason:reason, turns:0,
    receipts:[], total_tokens:null, subagent_tokens:null, models:[], savings:{status:'unmeasured'} });
  if (typeof root!=='string' || !path.isAbsolute(root) || !/^[a-f0-9]{20}$/.test(taskSession ?? '')) return unavailable('ledger_not_configured_or_missing_task_metadata');
  const budget={ remaining:MAX_READ_BYTES, incomplete:false, gaps:new Set() };
  const files=[];
  let entries=0;
  function visit(dir, depth=0) {
    if (depth>3) { budget.incomplete=true;budget.gaps.add('directory_depth_bound'); return; }
    const items=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)),names=new Set(items.map(item=>item.name));
    for(const item of items) {
      if (++entries>MAX_FILES) {budget.incomplete=true;budget.gaps.add('directory_entry_bound');return;}
      if(item.isSymbolicLink()) {budget.incomplete=true;budget.gaps.add('symlink_excluded');continue;}
      const file=path.join(dir,item.name);
      if(item.isDirectory()) visit(file,depth+1);
      else if(rolloutFile(item,file,names,budget)) files.push(file);
    }
  }
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return unavailable('ledger_root_unsafe');
    visit(root);
  } catch {return unavailable('ledger_root_unreadable');}
  const index=new Map(),fileHeaders=new Map();
  let headerBytes=0;
  for(const file of files) {
    try {
      if (headerBytes>128*1024*1024) {budget.incomplete=true;budget.gaps.add('header_byte_bound');break;}
      const meta=header(file);fileHeaders.set(file,meta);headerBytes+=meta.bytes;
      if(index.has(meta.id)) {
        const prior=index.get(meta.id);
        if(prior.session!==meta.session) {budget.incomplete=true;budget.gaps.add('conflicting_thread_metadata');}
        else if(prior.parent!==meta.parent||prior.ancestryConflicted||meta.ancestryConflicted) {prior.parent=null;prior.declaredParent ||= meta.declaredParent;prior.ancestryConflicted=true;prior.files.push(file);budget.incomplete=true;budget.gaps.add('conflicting_thread_metadata');}
        else prior.files.push(file);
        continue;
      }
      if(meta.ancestryConflicted){budget.incomplete=true;budget.gaps.add('conflicting_thread_metadata');}
      index.set(meta.id,{...meta,files:[file]});
    } catch {budget.incomplete=true;budget.gaps.add('unreadable_session_header');}
  }
  const target=[...index.values()].find(m=>hashOpaqueHostIdentifier(m.id,'codex')===taskSession);
  if(!target) return unavailable('task_not_found_in_configured_ledger');
  const belongs=(m)=> {
    const seen=new Set();
    while(m && !seen.has(m.id)) {
      if(m.id===target.id) return true;
      seen.add(m.id); m=index.get(m.parent);
    }
    return false;
  };
  const sources=[...index.values()].filter(belongs);
  const parsed=[];
  const reader=createCodexLedgerReader({legacy:true});
  for(const source of sources) {
    try {
      for(const file of source.files) streamLedger(file,budget,reader,fileHeaders.get(file));
    } catch {budget.incomplete=true;budget.gaps.add('source_read_bound_or_error');}
  }
  const ledger=reader.finish();
  for(const gap of ledger.coverage_gaps??[]){budget.incomplete=true;budget.gaps.add(gap);}
  if(ledger.invalid) {budget.incomplete=true;budget.gaps.add('invalid_usage_record');}
  const threadIndex=new Map(sources.map(source=>[hash(source.id,'thread'),source]));
  for(const t of ledger.turns) {
    const source=threadIndex.get(t.thread);
    if(!source || (source.session && t.session!==hash(source.session,'session'))) {
      budget.incomplete=true;budget.gaps.add('source_identity_mismatch'); t.status='unavailable';t.usage=null;
    }
  }
  for(const source of sources) {
    const turns=ledger.turns.filter(t=>t.thread===hash(source.id,'thread'));
    if(!turns.length) {budget.incomplete=true;budget.gaps.add('source_missing_structured_usage');}
    parsed.push({main:source.id===target.id,turns});
  }
  const main=parsed.find(p=>p.main);
  if(!main) return unavailable('task_ledger_unreadable');
  // Only host-supplied per-call turn identity can select a live turn. Never
  // infer it from the latest file, date or an unrelated active source.
  const matches=main.turns.filter(t=>t.turn===options.taskTurn && !t.completed);
  const active=matches.length===1 ? matches[0] : null;
  let currentTurn={status:'unavailable',is_final:false,main_usage:null,subagent_usage:null,
    availability_reason:!options.taskTurn?'missing_host_turn_metadata':'no_matching_active_usage'};
  if(active?.usage && active.status!=='unavailable') {
    const uniqueRoot=!main.turns.some(t=>t!==active && t.root===active.root);
    const children=uniqueRoot && active.root ? parsed.filter(p=>!p.main).flatMap(p=>p.turns).filter(t=>t.root===active.root) : [];
    const knownChildren=children.filter(t=>t.usage && t.status!=='unavailable');
    const liveSources=[active,...knownChildren];
    currentTurn={status:'partial',is_final:false,scope:'current_turn_observed_records',
      availability_reason:'matched_active_ledger_records',
      main_usage:active.usage,subagent_usage:knownChildren.length?sumUsage(knownChildren.map(t=>t.usage)):null,
      observed_usage:sumUsage(liveSources.map(t=>t.usage)),
      models:liveSources.flatMap(t=>t.models.map(m=>({...m,role:t===active?'main':'subagent'}))),
      last_token_event_at:liveSources.reduce((latest,t)=>t.timeline.reduce((n,r)=>Math.max(n,r.observed_at),latest),0),
      observed_at:Date.now(),includes_unflushed_usage:false,
      coverage_gaps:[...budget.gaps,...(!uniqueRoot?['shared_root_subagent_attribution_unavailable']:[]),
        ...(knownChildren.length!==children.length?['incomplete_subagent_usage']:[])],
      counter_reconciliation:liveSources.every(t=>t.status==='exact')?'exact':'partial'};
  }
  const live={current_turn_usage:currentTurn.status,current_turn:currentTurn};
  const last=Math.min(100,Math.max(1,options.last ?? 100));
  const selected=main.turns.filter(t=>t.completed).sort((a,b)=>a.created_at-b.created_at).slice(-last);
  if(!selected.length) return {...unavailable('no_completed_ledger_turns'),...live,
    completed_history_status:'unavailable',status:currentTurn.status};
  const models=new Map();
  const details=[];
  let remainingDetails=options.fullDetails===true ? 100000 : 2000;
  let omittedResponses=0;
  const sourceNumbers=new Map(sources.map((source,index)=>[hash(source.id,'thread'),index+1]));
  // A host root turn may span several resumed main turns. Group by that
  // authority and attach each child source turn once, never once per main turn.
  const groupingKey=t=>t.root?`root:${t.root}`:`unlinked:${t.thread}:${t.turn}`;
  const roots=[...new Set(selected.map(groupingKey))];
  const selectedSet=new Set(selected);
  const receipts=roots.map(groupKey=> {
    const mains=selected.filter(t=>groupingKey(t)===groupKey),rootTurn=mains[0].root;
    const rootWindowComplete=Boolean(rootTurn)&&main.turns.filter(t=>t.root===rootTurn).every(t=>selectedSet.has(t));
    const children=rootWindowComplete ? parsed.filter(p=>!p.main).flatMap(p=>p.turns).filter(c=>c.root===rootTurn) : [];
    const all=[...mains,...children];
    const resolved=all.filter(s=>s.usage && s.completed && s.status==='exact');
    for(const source of all) for(const m of source.models) {
      if(!source.usage || !source.completed) continue;
      const role=mains.includes(source)?'main':'subagent';
      const key=`${role}:${m.model}:${m.reasoning_effort}`;
      const bucket=models.get(key) ?? {role,model:m.model,reasoning_effort:m.reasoning_effort,usage:[]};
      bucket.usage.push(m.usage);models.set(key,bucket);
    }
    for(const source of all) {
      const timeline=source.timeline.slice(0,remainingDetails);
      remainingDetails-=timeline.length;
      omittedResponses+=source.timeline.length-timeline.length;
      const sourceMeta=threadIndex.get(source.thread);
      details.push({source:sourceNumbers.get(source.thread),parent_source:sourceNumbers.get(hash(sourceMeta?.parent,'thread')) ?? null,role:mains.includes(source)?'main':'subagent',
        root_group:roots.indexOf(groupKey)+1,status:source.status,completed:source.completed,
        created_at:source.created_at,duration_ms:source.duration_ms,usage:source.usage,
        response_count:source.response_count,models:source.models,
        timeline,timeline_complete:timeline.length===source.timeline.length});
    }
    const known=all.filter(s=>s.usage && s.completed);
    const status=budget.incomplete || !rootWindowComplete || resolved.length!==all.length ? 'partial' : 'exact';
    const combined=sumUsage(known.map(s=>s.usage));
    return {status:combined.consistent?status:'partial',created_at:Math.max(...mains.map(t=>t.created_at)),
      main_turns:mains.length,root_window_complete:rootWindowComplete,
      expected_sources:all.length,resolved_sources:resolved.length,
      main_usage:sumUsage(mains.filter(t=>t.usage).map(t=>t.usage)),
      subagent_usage:children.some(c=>c.usage && c.completed)?sumUsage(children.filter(c=>c.usage && c.completed).map(c=>c.usage)):null,
      ...combined, duration_ms:mains.length===1?mains[0].duration_ms:null,
      models_complete:resolved.length===all.length && all.every(t=>t.models.every(m=>m.model!=='unknown')),
      usage_source:all.some(t=>t.record_basis==='legacy_counter_event')?'codex_legacy_counters':'codex_structured_ledger'};
  }).sort((a,b)=>a.created_at-b.created_at);
  const total=sumUsage(receipts);
  const historyStatus=total.consistent && receipts.every(r=>r.status==='exact')?'exact':'partial';
  return { status:currentTurn.status==='partial'?'partial':historyStatus,completed_history_status:historyStatus,
    scope:'current_task_completed_turns',history_coverage:'bounded_host_ledger',...live,
    usage_source:receipts.some(r=>r.usage_source==='codex_legacy_counters')?'codex_legacy_counters':'codex_structured_ledger',availability_reason:budget.incomplete?'bounded_or_incomplete_scan':'matched_completed_ledger_turns',
    details, omitted_responses:omittedResponses, details_complete:omittedResponses===0, detail_scope:'selected_root_groups', metadata_basis:'host_turn_context_at_response',
    turns:selected.length,receipt_grouping:selected.some(t=>!t.root)?'root_turn_or_unlinked_turn':'root_turn',receipts,...total,
    coverage_gaps:[...budget.gaps], source_threads:sources.length, scanned_files:files.length, scanned_header_bytes:headerBytes,
    subagent_tokens:receipts.some(r=>r.subagent_usage)?sumUsage(receipts.map(r=>r.subagent_usage).filter(Boolean)).total_tokens:null,
    models:[...models.values()].map(m=>({...m,usage:sumUsage(m.usage)})),
    latest_completed_at:receipts.at(-1).created_at, observed_at:Date.now(),
    savings:{status:'unmeasured'} };
}


/** Read-only workspace inventory. Numeric response records are internal to the
 * local monitor; raw host identifiers and content never enter its output. */
const workspaceFileCache=new Map();
const workspaceHeaderCache=new Map();
const sourceStamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
const REUSABLE_GAPS=new Set(['legacy_counter_observations','legacy_root_unavailable','legacy_context_unavailable',
  'legacy_counter_discontinuity','invalid_legacy_usage','inherited_history_boundary_conflict','inherited_history_boundary_unavailable','unreconciled_turn_usage',
  'compressed_source_unreadable']);
// A scheduled capture runs in a fresh process. `resume` carries checkpoints of
// the files the previous capture parsed, so a grown rollout is rehashed but
// parsed only past its checkpoint. Only the most recently changed files get one:
// each costs a CRC32 pass over its prefix and its numeric state, gzipped: a long
// thread's state outgrows the entry bound raw (13 MB for a 2.8 GB rollout, 2.3 MB gzipped).
const RESUME_FILES=6,RESUME_ENTRY_BYTES=10*1024*1024;
// Paths are not opaque identifiers; the key is a digest, never the path.
const resumeKey=file=>crypto.createHash('sha256').update('workspace:resume:'+file).digest('hex').slice(0,20);
function savedCheckpoints(saved,revision) {
  const entries=new Map();
  if(saved?.schema_version!==1||saved.revision!==revision||!Array.isArray(saved.files))return entries;
  for(const e of saved.files.slice(0,RESUME_FILES))
    // CRC32, or SHA-256 hex where Node lacks zlib.crc32.
    if(/^[a-f0-9]{20}$/.test(e?.key??'')&&[e.size,e.dev,e.ino].every(Number.isSafeInteger)&&(Number.isSafeInteger(e.digest)&&e.digest>=0&&e.digest<=0xffffffff||/^[a-f0-9]{64}$/.test(e.digest??''))
      &&typeof e.ownHistory==='boolean'&&typeof e.foreignPrefix==='boolean'&&[e.nextOrdinal,e.lastOrdinal].every(v=>v===null||Number.isSafeInteger(v))
      &&Array.isArray(e.streamGaps)&&e.streamGaps.every(g=>typeof g==='string')&&typeof e.reader==='string')entries.set(e.key,e);
  return entries;
}
// Header facts keep hashed identities only, so a saved copy (`resume.headers`,
// keyed by file stamp) never holds a raw thread or session id. A file parsed
// in this pass rereads its raw header.
const headerFacts=m=>({bytes:m.bytes,id:hashOpaqueHostIdentifier(m.id,'workspace:source'),thread:hash(m.id,'thread'),task:hashOpaqueHostIdentifier(m.id,'workspace:task'),
  parent:m.parent?hashOpaqueHostIdentifier(m.parent,'workspace:source'):null,session:m.session?hashOpaqueHostIdentifier(m.session,'workspace:session'):null,
  declaredParent:m.declaredParent,ancestryConflicted:m.ancestryConflicted,historyStart:m.historyStart,historyBase:m.historyBase});
function savedHeaderFacts(saved,revision) {
  const facts=new Map(),hashed=value=>/^[a-f0-9]{20}$/.test(value??'');
  if(saved?.schema_version!==1||saved.revision!==revision||!Array.isArray(saved.files)||saved.files.length>MAX_FILES)return facts;
  for(const [stamp,m]of saved.files.filter(Array.isArray))
    if(typeof stamp==='string'&&stamp.length<=128&&m&&['id','thread','task'].every(key=>hashed(m[key]))&&[m.parent,m.session].every(v=>v===null||hashed(v))
      &&Number.isSafeInteger(m.bytes)&&m.bytes>0&&m.bytes<=MAX_HEADER_BYTES&&typeof m.declaredParent==='boolean'&&typeof m.ancestryConflicted==='boolean'
      &&(m.historyStart===null||m.historyStart==='invalid'||Number.isSafeInteger(m.historyStart)&&m.historyStart>=0)&&(m.historyBase===null||Number.isSafeInteger(m.historyBase)&&m.historyBase>=0))
      facts.set(stamp,{bytes:m.bytes,id:m.id,thread:m.thread,task:m.task,parent:m.parent,session:m.session,declaredParent:m.declaredParent,
        ancestryConflicted:m.ancestryConflicted,historyStart:m.historyStart,historyBase:m.historyBase});
  return facts;
}
let parserRevision;
function workspaceParserRevision() {
  return parserRevision??=moduleRevision(import.meta.url);
}
export function canReuseCodexWorkspace(previous) {
  const index=previous?.codex_source_index,sources=index?.sources;
  return previous?.schema_version===1&&index?.revision===workspaceParserRevision()&&/^[a-f0-9]{64}$/.test(index.topology??'')
    &&Array.isArray(sources)&&sources.length>0&&sources.length<=MAX_FILES&&sources.every(s=>s&&typeof s==='object'
      &&/^[a-f0-9]{20}$/.test(s.source_key??'')&&/^[a-f0-9]{64}$/.test(s.signature??'')&&/^[a-f0-9]{64}$/.test(s.digest??'')&&/^[a-f0-9]{64}$/.test(s.ancestry??'')
      &&Number.isSafeInteger(s.record_count)&&s.record_count>=0&&s.record_count<=100000
      &&Array.isArray(s.coverage_gaps)&&s.coverage_gaps.length<=REUSABLE_GAPS.size&&s.coverage_gaps.every(g=>REUSABLE_GAPS.has(g)))
    &&new Set(sources.map(s=>s.source_key)).size===sources.length;
}
// A source's numeric digest is the XOR of its rows' hashes, so it can be built
// while rows stream past in any order. Only rows its files still produce count:
// retained history the source no longer yields stays unverified whether the
// source is reparsed or reused, so it must not make an unchanged source unreusable.
export function sourceDigestAccumulator() {
  const digest=Buffer.alloc(32);let count=0,first=null,last=null,legacy=false;
  return {
    add(r) {
      if(r.validation_status==='historical_unverified')return;
      count++;first=Math.min(first??r.observed_at,r.observed_at);last=Math.max(last??r.observed_at,r.observed_at);
      if(r.record_basis==='legacy_counter_event')legacy=true;
      const row=crypto.createHash('sha256').update(JSON.stringify([r.record_key,r.task_key,r.source_key,r.parent_source??null,r.turn_key,r.root_key??(r.record_basis==='legacy_counter_event'?null:r.turn_key),
        r.role,r.model,r.effort,r.service_tier??'unknown',r.requested_service_tier??'unknown',r.observed_at,r.completed===true,r.completed_at??null,r.duration_ms??null,
        r.quality==='exact'?'exact':'partial',r.record_basis??'structured_response',
        ...['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','cache_write_input_tokens','total_tokens','consistent'].map(k=>r.usage?.[k]??null)])).digest();
      for(let index=0;index<32;index++)digest[index]^=row[index];
    },
    summary:()=>({count,digest:digest.toString('hex'),first,last,legacy}),
  };
}
function numericSourceDigest(rows) {
  const accumulator=sourceDigestAccumulator();for(const r of rows)accumulator.add(r);return accumulator.summary().digest;
}
function sourceSignature(source) {
  return crypto.createHash('sha256').update(JSON.stringify(source.files.map(file=>{
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('unsafe-source');
    return [file,sourceStamp(stat)];
  }))).digest('hex');
}
function sourceAncestries(index,root) {
  const fingerprints=new Map(),hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Only a source and its ancestors affect its task assignment. New unrelated
  // tasks must not invalidate every numeric checkpoint in the workspace.
  for(const source of index.values()) {
    const chain=[],seen=new Set();let current=source;
    while(current&&!fingerprints.has(current.id)&&!seen.has(current.id)) {
      chain.push(current);seen.add(current.id);current=index.get(current.parent);
    }
    let parent=current?(fingerprints.get(current.id)??null):hash([root]);
    for(let i=chain.length-1;i>=0;i--) {
      const s=chain[i];
      parent=parent===null?null:hash([parent,s.id,s.session,s.parent,s.declaredParent,s.conflicted,s.ancestryConflicted,s.historyStart,s.historyBase]);
      fingerprints.set(s.id,parent);
    }
  }
  return fingerprints;
}
/**
 * `priorSources` (source_key -> accumulator summary of the previous snapshot's
 * rows) lets a streaming caller reuse sources without holding their rows: the
 * result then lists `reused_sources` instead of repeating their records.
 */
export function readCodexWorkspaceLedger(root,{cache=true,previous=null,priorSources=null,resume=null}={}) {
  const started=Date.now(),cpuStarted=process.cpuUsage();let cacheHits=0,headerCacheHits=0,incrementalFiles=0,parsedBytes=0;
  const gaps=new Set(), files=[];
  const budget={remaining:8*MAX_READ_BYTES,incomplete:false,gaps};
  let entries=0;
  const empty=reason=>({status:'unavailable',records:[],tasks:[],record_inventory_complete:false,coverage_gaps:[reason],global_coverage_gaps:[reason],observed_at:Date.now()});
  if(typeof root!=='string' || !path.isAbsolute(root)) return empty('ledger_not_configured');
  function visit(directory,depth=0) {
    if(depth>3) {gaps.add('directory_depth_bound');return;}
    const items=fs.readdirSync(directory,{withFileTypes:true}),names=new Set(items.map(item=>item.name));
    for(const item of items) {
      if(++entries>MAX_FILES) {gaps.add('directory_entry_bound');return;}
      if(item.isSymbolicLink()) {gaps.add('symlink_excluded');continue;}
      const file=path.join(directory,item.name);
      if(item.isDirectory()) visit(file,depth+1);
      else if(rolloutFile(item,file,names,budget)) files.push(file);
    }
  }
  try {if(fs.lstatSync(root).isSymbolicLink())return empty('ledger_root_unsafe');visit(root);}
  catch{return empty('ledger_root_unreadable');}
  const index=new Map(),fileHeaders=new Map(),rawHeaders=new Map(),revision=workspaceParserRevision();let headerBytes=0;
  const savedFacts=resume?savedHeaderFacts(resume.headers,revision):new Map(),facts=[];
  const headerBuffer=Buffer.allocUnsafe(MAX_HEADER_BYTES),readBuffer=Buffer.allocUnsafe(1024*1024);
  for(const file of files.sort()) {
    try {
      if(headerBytes>128*1024*1024) {gaps.add('header_byte_bound');break;}
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unsafe-header');
      const stamp=sourceStamp(stat),cached=cache?workspaceHeaderCache.get(file):null;
      let meta=cached?.stamp===stamp?cached.meta:savedFacts.get(stamp);
      if(meta)headerCacheHits++;
      else {
        const raw=header(file,headerBuffer);headerBytes+=raw.bytes;
        if(sourceStamp(fs.lstatSync(file))!==stamp)throw new Error('header-changed');
        meta=headerFacts(raw);rawHeaders.set(file,raw);
        // Cache parsed structural metadata only, never the header text. ctime,
        // inode and device invalidate replacements even with a restored mtime.
        if(workspaceHeaderCache.size>=1024)workspaceHeaderCache.delete(workspaceHeaderCache.keys().next().value);
        if(cache)workspaceHeaderCache.set(file,{stamp,meta});
      }
      facts.push([stamp,meta]);
      fileHeaders.set(file,meta);
      const prior=index.get(meta.id);
      if(prior) {
        if(prior.session!==meta.session) {prior.conflicted=true;gaps.add('conflicting_thread_metadata');}
        else if(prior.parent!==meta.parent||prior.ancestryConflicted||meta.ancestryConflicted) {prior.parent=null;prior.declaredParent ||= meta.declaredParent;prior.ancestryConflicted=true;prior.files.push(file);gaps.add('conflicting_thread_metadata');}
        else prior.files.push(file);
      } else {if(meta.ancestryConflicted)gaps.add('conflicting_thread_metadata');index.set(meta.id,{...meta,files:[file]});}
    }catch{workspaceHeaderCache.delete(file);gaps.add('unreadable_session_header');}
  }
  // Rewritten only when a header was read or a saved fact went unused.
  if(resume)resume.nextHeaders=rawHeaders.size||facts.length!==savedFacts.size?{schema_version:1,revision,files:facts}:null;
  const rawHeader=(file,meta)=>{
    let raw=rawHeaders.get(file);
    // The read size grows with a short file, so only the identities and history fields must agree.
    if(!raw){raw=header(file,headerBuffer);headerBytes+=raw.bytes;if(JSON.stringify({...headerFacts(raw),bytes:0})!==JSON.stringify({...meta,bytes:0}))throw new Error('header-changed');}
    return raw;
  };
  const ledgers=[];
  // Cache only numeric parsed records in this process. Unchanged transcript
  // files are not reread on every refresh; recently changed tasks go first.
  const ordered=[];
  for(const source of index.values())for(const file of source.files) {
    try {ordered.push({source,file,meta:fileHeaders.get(file),stat:fs.statSync(file)});}
    catch {gaps.add('source_read_bound_or_error');workspaceFileCache.delete(file);}
  }
  ordered.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
  const topology=crypto.createHash('sha256').update(JSON.stringify([root,...[...index.values()].map(s=>
    [s.id,s.session,s.parent,s.declaredParent,s.conflicted,s.ancestryConflicted,s.historyStart,s.historyBase])])).digest('hex');
  const priorIndex=previous?.codex_source_index;
  const savedSources=priorIndex?.sources;
  const checkpointValid=canReuseCodexWorkspace(previous),sourceAncestry=sourceAncestries(index,root);
  const candidates=new Map(checkpointValid?savedSources.map(s=>[s.source_key,s]):[]);
  const priorRows=new Map(),reused=new Map(),sourceSignatures=new Map(),aggregated=priorSources instanceof Map;
  if(candidates.size&&!aggregated)for(const r of Array.isArray(previous?.records)?previous.records:[])if(r?.host==='codex'&&candidates.has(r.source_key)&&r.validation_status!=='historical_unverified'){
    if(!priorRows.has(r.source_key))priorRows.set(r.source_key,[]);priorRows.get(r.source_key).push(r);
  }
  const emptySource=sourceDigestAccumulator().summary();
  for(const source of index.values())try{
    const key=source.id,signature=sourceSignature(source);
    sourceSignatures.set(key,signature);
    const saved=candidates.get(key),rows=aggregated?null:priorRows.get(key)??[];
    const summary=aggregated?priorSources.get(key)??emptySource:null;
    if(!source.conflicted&&saved?.signature===signature&&saved.ancestry===sourceAncestry.get(source.id)
      &&saved.record_count===(aggregated?summary.count:rows.length)&&saved.digest===(aggregated?summary.digest:numericSourceDigest(rows))){
      reused.set(key,aggregated?{summary}:{rows});source.coverage_gaps=[...saved.coverage_gaps];for(const gap of saved.coverage_gaps)gaps.add(gap);
    }
  }catch{/* The ordinary reader reports unreadable sources. */}
  let reusedFiles=0,checkpointSlots=resume?RESUME_FILES:0;
  const saved=resume?savedCheckpoints(resume.previous,revision):new Map(),checkpoints=[],parsedKeys=new Set();
  for(const {source,file,meta,stat} of ordered) {
    if(source.conflicted)continue;
    if(reused.has(source.id)){reusedFiles++;continue;}
    const stamp=sourceStamp(stat);
    const cached=cache?workspaceFileCache.get(file):null;
    if(cached?.stamp===stamp) {cacheHits++;source.coverage_gaps=[...(source.coverage_gaps??[]),...cached.gaps];ledgers.push(cached.ledger);for(const gap of cached.gaps)gaps.add(gap);continue;}
    const key=resume?resumeKey(file):null;let prior=cached;
    if(!prior?.cache&&saved.has(key))try{
      const e=saved.get(key),state=JSON.parse(zlib.gunzipSync(Buffer.from(e.reader,'base64'),{maxOutputLength:MAX_INFLATED_BYTES}));
      const restored=createCodexLedgerReader({legacy:true,state});restored.finish({details:false});
      prior={cache:{...e,reader:restored,prefixContexts:[]},streamGaps:e.streamGaps};
    }catch{/* A damaged checkpoint means a full parse. */}
    let checkpoint=cache;if(resume&&checkpointSlots>0){checkpointSlots--;checkpoint=true;}
    try {
      let reader=createCodexLedgerReader({legacy:true});const fileGaps=new Set();
      let captured;
      const fileBudget={remaining:budget.remaining,incomplete:false,gaps:fileGaps};
      try {captured=streamLedger(file,fileBudget,reader,rawHeader(file,meta),prior?.cache,readBuffer,checkpoint);reader=captured.reader;parsedBytes+=captured.parsedBytes;incrementalFiles+=Number(captured.incremental);if(captured.incremental)for(const gap of prior.streamGaps??[])fileGaps.add(gap);}
      finally {budget.remaining=fileBudget.remaining;for(const gap of fileGaps)gaps.add(gap);}
      const streamGaps=[...fileGaps];
      const ledger=reader.finish({details:false});if(ledger.invalid)fileGaps.add('invalid_usage_record');
      for(const gap of ledger.coverage_gaps??[]){fileGaps.add(gap);gaps.add(gap);}
      source.coverage_gaps=[...(source.coverage_gaps??[]),...fileGaps];
      if(workspaceFileCache.size>=MAX_FILES)workspaceFileCache.clear();
      if(cache)workspaceFileCache.set(file,{stamp,ledger,cache:captured.cache,streamGaps,gaps:[...fileGaps]});ledgers.push(ledger);
      const c=captured.cache;
      if(resume){
        parsedKeys.add(key);
        // An unfinished inherited-history prefix holds whole turn_context events: never saved.
        if(c&&!c.prefixContexts.length){
          const entry={key,size:c.size,dev:c.dev,ino:c.ino,digest:c.digest,ownHistory:c.ownHistory,nextOrdinal:c.nextOrdinal,lastOrdinal:c.lastOrdinal,
            foreignPrefix:c.foreignPrefix,streamGaps,reader:zlib.gzipSync(JSON.stringify(c.reader.snapshot()),{level:1}).toString('base64')};
          if(JSON.stringify(entry).length<=RESUME_ENTRY_BYTES)checkpoints.push(entry);
        }
      }
    }catch{gaps.add('source_read_bound_or_error');source.coverage_gaps=[...(source.coverage_gaps??[]),'source_read_bound_or_error'];}
  }
  if(resume){
    // A checkpoint of a file not parsed this time stays valid for its next growth.
    const rank=new Map(ordered.map(({file},index)=>[resumeKey(file),index]));
    const kept=[...checkpoints,...[...saved.values()].filter(e=>rank.has(e.key)&&!parsedKeys.has(e.key))];
    resume.next={schema_version:1,revision,files:kept.sort((a,b)=>rank.get(a.key)-rank.get(b.key)).slice(0,RESUME_FILES)};
  }
  // Response identities are reconciled across source files, including reused
  // ones. A collision needs the original turn-level evidence: reparse once
  // instead of silently accepting a previously exact cached row.
  // A streaming caller checks reused identities while it merges the prior rows.
  if(reused.size&&!aggregated){
    const identities=new Set();let conflict=false;
    for(const {rows} of reused.values())for(const row of rows){if(identities.has(row.record_key))conflict=true;identities.add(row.record_key);}
    for(const ledger of ledgers)for(const turn of ledger.turns)for(const row of turn.response_records)if(identities.has(row.response_key))conflict=true;
    if(conflict)return readCodexWorkspaceLedger(root,{cache:false});
  }
  const groups=new Map(),responses=new Map(),completions=new Map();let invalid=false;
  const structuredTurns=new Set(ledgers.flatMap(l=>l.structured_turns??[]));
  const invalidStructuredThreads=new Set(ledgers.flatMap(l=>l.invalid_structured_threads??[]));
  for(const ledger of ledgers) {
    for(const completion of ledger.completions??[]) {
      const key=completion.thread+':'+completion.turn;
      if(!completions.has(key)||completion.at>=completions.get(key).at)completions.set(key,completion);
    }
    if(ledger.invalid)invalid=true;
    for(const t of ledger.turns) {
      if(t.record_basis==='legacy_counter_event'&&(structuredTurns.has(t.thread+':'+t.turn)||invalidStructuredThreads.has(t.thread)))continue;
      const key=t.thread+':'+t.turn,g=groups.get(key)??{...t,response_records:[],bad:false};
      if(t.created_at>=g.created_at){g.usage=t.usage;g.created_at=t.created_at;g.duration_ms=t.duration_ms;}
      g.completed ||= t.completed;
      if(t.status==='unavailable')g.bad=true;
      groups.set(key,g);
      for(const r of t.response_records) {
        const signature=crypto.createHash('sha256').update(JSON.stringify({thread:t.thread,turn:t.turn,root:t.root,usage:r.usage})).digest('hex');
        const prior=responses.get(r.response_key);
        if(prior) {if(prior.signature!==signature){g.bad=true;groups.get(prior.group).bad=true;invalid=true;}continue;}
        responses.set(r.response_key,{signature,group:key});g.response_records.push(r);
      }
    }
  }
  const ledger={turns:[...groups.values()].map(g=>{
    const completion=completions.get(g.thread+':'+g.turn);
    if(completion){g.completed=true;g.created_at=completion.at;g.duration_ms=completion.duration_ms;}
    const summed=sumUsage(g.response_records.map(r=>r.usage));
    const reconciled=g.usage&&Object.keys(summed).every(k=>summed[k]===g.usage[k]);
    return {...g,status:g.bad?'unavailable':g.record_basis==='legacy_counter_event'?'partial':reconciled?'exact':'partial'};
  })};
  if(invalid)gaps.add('invalid_usage_record');
  const byHash=new Map([...index.values()].map(m=>[m.thread,m]));
  const records=[],tasks=new Map();

  const ancestry=new Map();
  const resolveAncestry=source=>{
    if(ancestry.has(source.id))return ancestry.get(source.id);
    let ancestor=source;const seen=new Set();
    while(ancestor?.parent&&!seen.has(ancestor.id)&&!ancestor.ancestryConflicted&&!ancestor.conflicted){
      seen.add(ancestor.id);ancestor=index.get(ancestor.parent);
    }
    const unresolved=!ancestor||seen.has(ancestor.id)||source.ancestryConflicted||source.conflicted||ancestor.ancestryConflicted||ancestor.conflicted;
    const result=unresolved?{resolved:false,ancestor:source}:{resolved:true,ancestor};
    ancestry.set(source.id,result);return result;
  };
  for(const source of index.values()){
    const resolution=resolveAncestry(source),root=resolution.ancestor;
    const key=root.task;
    if(!tasks.has(key))tasks.set(key,{task_key:key,label:'Task '+key.slice(0,8),...(resolution.resolved?{}:{coverage_gaps:['unresolved_task_ancestry']})});
    if(!resolution.resolved)gaps.add('unresolved_task_ancestry');
  }
  for(const turn of ledger.turns) {
    const source=byHash.get(turn.thread);
    if(!source||source.conflicted){gaps.add('unresolved_task_ancestry');continue;}
    const resolution=resolveAncestry(source),ancestor=resolution.ancestor;
    if(!resolution.resolved)gaps.add('unresolved_task_ancestry');
    const taskKey=ancestor.task;
    const sourceKey=source.id;
    const task=tasks.get(taskKey) ?? {task_key:taskKey,label:'Task '+taskKey.slice(0,8),source_count:0};
    tasks.set(taskKey,task);
    task.coverage_gaps=[...(task.coverage_gaps??[]),...(source.coverage_gaps??[])];
    if(turn.status==='partial'){
      gaps.add('unreconciled_turn_usage');task.coverage_gaps.push('unreconciled_turn_usage');
      source.coverage_gaps=[...new Set([...(source.coverage_gaps??[]),'unreconciled_turn_usage'])];
    }
    if(!turn.usage || turn.status==='unavailable') {source.invalidUsage=true;gaps.add('invalid_turn_usage');task.coverage_gaps.push('invalid_turn_usage');continue;}
    for(const r of turn.response_records) records.push({
      host:'codex',record_key:r.response_key,task_key:taskKey,source_key:sourceKey,
      parent_source:source.parent,
      turn_key:turn.turn,root_key:turn.root,role:resolution.resolved&&source.id===ancestor.id?'main':source.declaredParent?'subagent':'main',
      model:r.model,effort:r.reasoning_effort,service_tier:r.service_tier,
      requested_service_tier:r.requested_service_tier,observed_at:r.observed_at,
      completed:turn.completed,completed_at:turn.completed?turn.created_at:null,
      duration_ms:turn.duration_ms,quality:turn.status,record_basis:turn.record_basis,usage:r.usage});
  }
  for(const source of index.values()){
    const key=source.id,reuse=reused.get(key);
    if(!reuse)continue;
    try{if(sourceSignature(source)!==sourceSignatures.get(key))throw Error('source-changed');for(const row of reuse.rows??[])records.push(row);}
    catch{reused.delete(key);gaps.add('source_changed_during_read');}
  }
  const observedSources=new Set(records.map(r=>r.source_key));
  const observedLegacySources=new Set(records.filter(r=>r.record_basis==='legacy_counter_event').map(r=>r.source_key));
  const reusedSummary=key=>reused.get(key)?.summary;
  for(const [key,{summary}] of reused)if(summary?.count){observedSources.add(key);if(summary.legacy)observedLegacySources.add(key);}
  if(!observedLegacySources.size){gaps.delete('legacy_counter_observations');gaps.delete('legacy_root_unavailable');}
  for(const source of index.values()){
    if(source.conflicted)continue;
    const resolution=resolveAncestry(source),ancestor=resolution.ancestor;
    const key=ancestor.task;
    const task=tasks.get(key)??{task_key:key,label:'Task '+key.slice(0,8)};
    const sourceKey=source.id;
    task.host='codex';task.source_keys=[...(task.source_keys??[]),sourceKey];
    task.coverage_gaps=[...(task.coverage_gaps??[]),...(source.coverage_gaps??[])];
    if(source.conflicted||source.ancestryConflicted)task.coverage_gaps.push('conflicting_thread_metadata');
    if(!resolution.resolved)task.coverage_gaps.push('unresolved_task_ancestry');
    if(source.parent&&!observedSources.has(sourceKey))task.coverage_gaps.push('child_usage_unavailable');
    task.coverage_gaps=[...new Set(task.coverage_gaps)];task.coverage_status=task.coverage_gaps.length?'partial':'exact';
    tasks.set(key,task);
  }
  for(const task of tasks.values())if(!(task.source_keys??[]).some(k=>observedLegacySources.has(k)))task.coverage_gaps=(task.coverage_gaps??[]).filter(g=>g!=='legacy_counter_observations'&&g!=='legacy_root_unavailable');
  for(const task of tasks.values())task.coverage_status=task.coverage_gaps.length?'partial':'exact';
  const legacyReplacements=[];
  for(const key of structuredTurns){const [thread,turn]=key.split(':');const source=byHash.get(thread);if(source)legacyReplacements.push({source_key:source.id,turn_key:turn});}
  for(const thread of invalidStructuredThreads){const source=byHash.get(thread);if(source)legacyReplacements.push({source_key:source.id,turn_key:null});}
  const globalGaps=[...gaps].filter(g=>!localGapCodes.has(g));
  const sourceRows=new Map();
  for(const row of records){if(!sourceRows.has(row.source_key))sourceRows.set(row.source_key,[]);sourceRows.get(row.source_key).push(row);}
  for(const source of index.values()) {
    const sourceKey=source.id;
    const sourceGaps=[...new Set(source.coverage_gaps??[])];if(!sourceGaps.length)continue;
    const task=tasks.get(resolveAncestry(source).ancestor.task);
    if(!task)continue;
    let first=reusedSummary(sourceKey)?.first??null,last=reusedSummary(sourceKey)?.last??null;
    for(const row of sourceRows.get(sourceKey)??[]){first=Math.min(first??row.observed_at,row.observed_at);last=Math.max(last??row.observed_at,row.observed_at);}
    // These dates bound retained numeric observations, not the unknown missing
    // history. Source warnings never become a claim that later turns are exact.
    (task.source_coverage??=[]).push({source_key:sourceKey,coverage_scope:'retained_source_history',
      coverage_gaps:sourceGaps,first_observed_at:first,last_observed_at:last});
  }
  const sourceIndex=[];
  for(const source of index.values()){
    const key=source.id,rows=sourceRows.get(key)??[];
    if(source.conflicted||source.ancestryConflicted||!sourceAncestry.get(source.id)||source.invalidUsage||source.coverage_gaps?.some(g=>!REUSABLE_GAPS.has(g)))continue;
    try{
      const signature=sourceSignature(source);if(signature!==sourceSignatures.get(key))continue;
      const summary=reusedSummary(key);
      sourceIndex.push({source_key:key,signature,ancestry:sourceAncestry.get(source.id),record_count:summary?summary.count:rows.length,digest:summary?summary.digest:numericSourceDigest(rows),
        coverage_gaps:[...new Set(source.coverage_gaps??[])]});
    }catch{/* An unvalidated source never authorizes reuse. */}
  }
  return {status:gaps.size||[...tasks.values()].some(t=>t.coverage_gaps?.length)?'partial':'exact',records,tasks:[...tasks.values()],legacy_replacements:legacyReplacements,
    ...(aggregated?{reused_sources:[...reused.keys()]}:{}),
    codex_source_index:{revision,topology,sources:sourceIndex},
    observed_at:Date.now(),coverage_gaps:[...new Set([...gaps,...[...tasks.values()].flatMap(t=>t.coverage_gaps??[])])],global_coverage_gaps:globalGaps,record_inventory_complete:globalGaps.length===0,scanned_files:files.length,
    metrics:{capture_duration_ms:Date.now()-started,cpu_user_micros:process.cpuUsage(cpuStarted).user,cpu_system_micros:process.cpuUsage(cpuStarted).system,rss_bytes:process.memoryUsage().rss,changed_files:ordered.length-cacheHits-reusedFiles,reused_sources:reused.size,header_bytes:headerBytes,header_cache_hits:headerCacheHits,bytes_read_for_usage:8*MAX_READ_BYTES-budget.remaining,cache_hits:cacheHits,incremental_files:incrementalFiles,bytes_parsed_for_usage:parsedBytes,source_files:ordered.length},
    capture_scope:'configured_local_codex_session_root',current_response_unflushed:'unavailable'};
}
