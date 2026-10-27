import { unlinkOwnedFile } from './host-paths.mjs';
import {startPhase,finishPhase,measurePhase} from './capture-timings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {safeModel,isHashedIdentity} from './core.mjs';
import { claudeCacheSemantics } from './hosts/claude-code.mjs';
import { MAX_TRANSCRIPT_BYTES, TRANSCRIPT_CEILING_BYTES, LABEL, hash, CAPTURE_REVISION, version, safeDirectory, transcriptLines, transcriptSignature, captureSource } from './claude-capture.mjs';
import {acquireStoreLock} from './monitor-lock.mjs';

const MAX_SOURCES = 20000;
// A hook parses at most 64 MiB past a verified checkpoint, so it stays well inside
// its 10 s timeout under load (a full 489 MiB parse took 9.7 s live on 2026-10-27).
// The registered refresh runs in the background and may parse a whole transcript
// up to TRANSCRIPT_CEILING_BYTES, so a source a hook leaves (no checkpoint after a
// new capture revision or with more than six large sources, or a longer tail) is
// captured by the next collector pass. Feed files stay bound by MAX_TRANSCRIPT_BYTES.
const TRANSCRIPT_READ_BYTES = 64 * 1024 * 1024;
const MAX_COMPLETIONS = 20000;
const MAX_FEED_BYTES=64*1024*1024;
const CAPTURE_NAME=/^[a-f0-9]{20}-\d+-[a-f0-9]+\.json$/;

const EVENTS = new Set(['SessionStart','UserPromptSubmit','PostToolUse','PostToolUseFailure','SubagentStart','SubagentStop','Stop','StopFailure','SessionEnd','MessageDisplay']);
let lastCaptureAt = 0;
export function configuredClaudeWorkspaceRoot(env = {}) {
  const root = env.SOMESTOKEN_CLAUDE_WORKSPACE_ROOT;
  if (typeof root === 'string' && path.isAbsolute(root)) return root;
  const home = env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME,'.codex') : null);
  if (!home || !path.isAbsolute(home)) return null;
  try {
    const directory = path.join(home,'somestoken');
    if (!safeDirectory(directory)) return null;
    const config = JSON.parse(readRegular(path.join(directory,'ledger-config.json'),2048));
    return config.enabled === true && typeof config.claude_workspace_root === 'string'
      && path.isAbsolute(config.claude_workspace_root) ? config.claude_workspace_root : null;
  } catch { return null; }
}
export function configuredClaudeProjectRoot(env = process.env) {
  const explicit = env.SOMESTOKEN_CLAUDE_PROJECT_ROOT;
  if (typeof explicit === 'string' && path.isAbsolute(explicit)) return safeDirectory(explicit) ? explicit : null;
  const home = env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME,'.codex') : null);
  if (!home || !path.isAbsolute(home)) return null;
  try {
    const directory = path.join(home,'somestoken');
    if (!safeDirectory(directory)) return null;
    const config = JSON.parse(readRegular(path.join(directory,'ledger-config.json'),2048));
    const root = config.claude_project_root;
    return config.enabled === true && typeof root === 'string' && path.isAbsolute(root) && safeDirectory(root) ? root : null;
  } catch { return null; }
}

/** Records or revokes the explicit opt-in for Claude capture; an existing Codex ledger consent is kept. */
export function configureClaudeFeed(enabled, env = process.env) {
  const home = env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME,'.codex') : null);
  const claude = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? path.join(env.HOME,'.claude') : null);
  if (!home || !path.isAbsolute(home) || enabled && (!claude || !path.isAbsolute(claude))) throw new Error('missing-operator-home');
  const directory = path.join(home,'somestoken'), target = path.join(directory,'ledger-config.json');
  if (!safeDirectory(directory)) throw new Error('unsafe-config');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  let sessionRoot = null;
  try {
    const existing = JSON.parse(readRegular(target,2048));
    if (existing.enabled === true && typeof existing.session_root === 'string' && path.isAbsolute(existing.session_root)) sessionRoot = existing.session_root;
  } catch {}
  const temporary = target+'.tmp-'+crypto.randomBytes(8).toString('hex');
  let fd, owned;
  try {
    fd = fs.openSync(temporary,'wx',0o600); owned = fs.fstatSync(fd);
    fs.writeFileSync(fd,JSON.stringify({enabled:enabled||sessionRoot!==null,...(sessionRoot?{session_root:sessionRoot}:{}),
      ...(enabled?{claude_workspace_root:path.join(directory,'claude-feed'),claude_project_root:path.join(claude,'projects')}:{})})+'\n');
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary,target);
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } finally { unlinkOwnedFile(temporary,owned); } }
}

function readRegular(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('source_bound');
    const buffer=Buffer.allocUnsafe(stat.size+1);let used=0,count;
    while(used<buffer.length&&(count=fs.readSync(fd,buffer,used,buffer.length-used,null)))used+=count;
    if(used>stat.size)throw Error('source_bound');
    return buffer.subarray(0,used).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function completionFingerprint(record) {
  return crypto.createHash('sha256').update(JSON.stringify({
    record_key:record.record_key,task_key:record.task_key,source_key:record.source_key,
    turn_key:record.turn_key,root_key:record.root_key,model:record.model,effort:record.effort,
    observed_at:record.observed_at,usage:record.usage,
  })).digest('hex');
}
function preserveCompletionEvidence(root,source) {
  let evidence = {};
  const names = fs.readdirSync(root).filter(name=>name.startsWith(`${source.source_key}-`) && /^[a-f0-9]{20}-\d+-[a-f0-9]+\.json$/.test(name)).sort().reverse().slice(0,2);
  for (const name of names) {
    try {
      const previous = JSON.parse(readRegular(path.join(root,name),MAX_TRANSCRIPT_BYTES));
      if (!validSource(previous) || previous.source_key !== source.source_key) continue;
      evidence = {...previous.completion_evidence};
      if (previous.coverage_gaps.includes('completion_evidence_limit')) {
        source.coverage_gaps.push('completion_evidence_limit'); source.coverage_status='partial';
      }
      // Upgrade an existing numeric feed without changing its observation time.
      for (const record of previous.records) if (record.completed && !evidence[record.record_key]) {
        evidence[record.record_key] = {fingerprint:completionFingerprint(record),completed_at:record.completed_at};
      }
      break;
    } catch { /* Invalid prior evidence cannot authorize completion. */ }
  }
  for (const record of source.records) {
    const fingerprint = completionFingerprint(record), prior = evidence[record.record_key];
    if (record.completed) {
      if (prior?.fingerprint === fingerprint) record.completed_at = Math.min(record.completed_at,prior.completed_at);
      evidence[record.record_key] = {fingerprint,completed_at:record.completed_at};
    }
    else if (prior?.fingerprint === fingerprint) {
      record.completed = true; record.completed_at = prior.completed_at;
    } else if (prior) delete evidence[record.record_key];
  }
  const entries = Object.entries(evidence).sort((a,b)=>b[1].completed_at-a[1].completed_at);
  if (entries.length > MAX_COMPLETIONS) {
    source.coverage_gaps.push('completion_evidence_limit');source.coverage_status='partial';
  }
  source.completion_evidence = Object.fromEntries(entries.slice(0,MAX_COMPLETIONS));
}

// Private authorization registry: bounded per-source files contain only host-supplied
// paths and identity metadata. Never exported by the numeric feed reader.
const REGISTRY = '.authorized-sources';
const SAFE_AGENT = /^[A-Za-z0-9_-]{1,128}$/;
function descriptors(input,eventName) {
  if (input.agent_id != null && typeof input.agent_id !== 'string') return [];
  const main = input.transcript_path;
  const childEvent = ['SubagentStart','SubagentStop'].includes(eventName);
  if (!input.agent_id) return [{transcript:main,agentId:null}];
  let child = input.agent_transcript_path;
  let derived = false;
  if (!child && typeof main === 'string' && path.basename(main) === `agent-${input.agent_id}.jsonl` && path.basename(path.dirname(main)) === 'subagents' && SAFE_AGENT.test(input.agent_id)) {
    child = main; derived = true;
  }
  const mainIsChild = child === main;
  if (!child && childEvent && typeof main === 'string' && path.isAbsolute(main) && main.endsWith('.jsonl') && SAFE_AGENT.test(input.agent_id)) {
    child = path.join(path.dirname(main),path.basename(main,'.jsonl'),'subagents',`agent-${input.agent_id}.jsonl`); derived = true;
  }
  return [...(childEvent && !mainIsChild ? [{transcript:main,agentId:null}]:[]),{transcript:child,agentId:input.agent_id,derived}];
}
function atomicJson(directory,name,value,onlyAbsent = false,serialized=null) {
  const temporary = path.join(directory,`.${name}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd,owned;
  try {
    fd=fs.openSync(temporary,'wx',0o600);owned=fs.fstatSync(fd);
    fs.writeFileSync(fd,serialized??JSON.stringify(value));
    fs.closeSync(fd);fd=undefined;
    if (onlyAbsent) {
      try { fs.linkSync(temporary,path.join(directory,name)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else fs.renameSync(temporary,path.join(directory,name));
  }
  finally { try { if(fd!==undefined)fs.closeSync(fd); } finally { try { unlinkOwnedFile(temporary,owned); } catch { /* renamed */ } } }
}
function registerSource(root,input,descriptor,onlyAbsent = false) {
  if (typeof descriptor.transcript !== 'string' || !path.isAbsolute(descriptor.transcript) || descriptor.transcript.length > 4096 || typeof input.session_id !== 'string' || input.session_id.length > 512 || (descriptor.agentId && (typeof descriptor.agentId !== 'string' || descriptor.agentId.length > 512))) return;
  const directory = path.join(root,REGISTRY);
  if (!safeDirectory(directory)) throw new Error('unsafe_registry');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const key = hash(descriptor.agentId ? `${input.session_id}:${descriptor.agentId}` : input.session_id,'source');
  if (!key) return;
  const name = `${key}.json`;
  if (!fs.existsSync(path.join(directory,name)) && fs.readdirSync(directory).length >= MAX_SOURCES) throw new Error('registry_bound');
  atomicJson(directory,name,{session_id:input.session_id,transcript:descriptor.transcript,agentId:descriptor.agentId ?? null,derived:descriptor.derived === true,strictSession:descriptor.strictSession === true},onlyAbsent);
  return name;
}
function feedFiles(root) {
  const names=fs.readdirSync(root).filter(name=>CAPTURE_NAME.test(name)||/^\.[a-f0-9]{20}-\d+-[a-f0-9]+\.json\.[a-f0-9]{16}\.tmp$/.test(name));
  if(names.length>MAX_SOURCES*2)throw Error('claude_feed_storage_bound');
  return names.sort().reverse().map(name=>({name,stat:fs.lstatSync(path.join(root,name))}));
}
// onlyKey: after a publish only that source can have a superseded capture.
function pruneFeed(root,onlyKey=null) {
  const latest=new Map();let bytes=0,lastKey=null;
  const files=feedFiles(root),counts=new Map();
  for(const {name} of files)if(CAPTURE_NAME.test(name))counts.set(name.slice(0,20),(counts.get(name.slice(0,20))??0)+1);
  for(const {name,stat} of files){
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('unsafe_feed');
    const file=path.join(root,name);bytes+=stat.size;
    if(name.endsWith('.tmp')){if(Date.now()-stat.mtimeMs>86400000){fs.unlinkSync(file);bytes-=stat.size;}continue;}
    const key=name.slice(0,20);
    if(counts.get(key)<2||(onlyKey&&key!==onlyKey))continue;
    if(key!==lastKey){latest.clear();lastKey=key;}
    try{
      const source=JSON.parse(readRegular(file,MAX_TRANSCRIPT_BYTES));if(!validSource(source)||source.source_key!==key)continue;
      const newer=latest.get(key);
      if(!newer){latest.set(key,{records:new Map(source.records.map(r=>[r.record_key,r])),evidence:source.completion_evidence??{}});continue;}
      // An unavailable/newly truncated capture cannot authorize erasing old
      // unique records or explicit completion evidence.
      if(source.records.every(r=>newer.records.has(r.record_key)&&(!r.completed||newer.records.get(r.record_key).completed))
        &&Object.entries(source.completion_evidence??{}).every(([id,e])=>newer.evidence[id]?.fingerprint===e.fingerprint)){
        fs.unlinkSync(file);bytes-=stat.size;
      }
    }catch{/* Invalid or unique evidence is kept, and counts against the cap. */}
  }
  return bytes;
}
// A frozen capture can never be refreshed: its source has no registration, or
// Claude deleted its transcript. A full budget evicts frozen sources, oldest
// capture first, down to the low-water mark, instead of refusing every live
// source; their snapshot rows stay as historical_unverified, as for any source
// no longer observed. Live captures are never evicted.
const FEED_LOW_WATER_BYTES=48*1024*1024;
function evictFrozenCaptures(root,incoming) {
  const sources=new Map(),registry=path.join(root,REGISTRY);let total=0;
  for(const {name,stat} of feedFiles(root)){
    total+=stat.size;
    if(!CAPTURE_NAME.test(name))continue;
    const entry=sources.get(name.slice(0,20))??{files:[],latest:0};
    entry.files.push({name,stat});entry.latest=Math.max(entry.latest,Number(name.split('-')[1]));sources.set(name.slice(0,20),entry);
  }
  const frozen=[...sources].filter(([key])=>{
    try{return !registeredPathExists(readRegistration(registry,`${key}.json`).transcript);}
    catch(error){return error.code==='ENOENT';}
  }).sort((a,b)=>a[1].latest-b[1].latest);
  for(const [,{files}] of frozen){
    if(total+incoming<=FEED_LOW_WATER_BYTES)break;
    for(const {name,stat} of files){
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('unsafe_feed');
      fs.unlinkSync(path.join(root,name));total-=stat.size;
    }
  }
  return total;
}
// A refused publish leaves no new capture or checkpoint, so every later event
// would parse the whole transcript again only to be refused. Retry it at most
// every 10 minutes.
const REFUSED_MEMO='.feed-refused.json',REFUSED_RETRY_MS=10*60_000,REFUSED_SOURCES=64;
function refusedSources(root) {
  try{
    const memo=JSON.parse(readRegular(path.join(root,REFUSED_MEMO),16*1024));
    return memo?.schema_version===1&&memo.sources&&typeof memo.sources==='object'&&!Array.isArray(memo.sources)?memo.sources:{};
  }catch{return {};}
}
function refusedRecently(sources,key,now) {
  const at=Object.hasOwn(sources,key)?sources[key]:null;
  return Number.isSafeInteger(at)&&at<=now&&now-at<REFUSED_RETRY_MS;
}
function noteRefused(root,key,at) {
  const sources=refusedSources(root);
  if(at===null&&!Object.hasOwn(sources,key))return;
  if(at===null)delete sources[key];else sources[key]=at;
  const kept=Object.entries(sources).filter(([k,v])=>isHashedIdentity(k)&&Number.isSafeInteger(v)&&v>0).sort((a,b)=>b[1]-a[1]).slice(0,REFUSED_SOURCES);
  atomicJson(root,REFUSED_MEMO,{schema_version:1,sources:Object.fromEntries(kept)});
}
function publishSource(root,source,resume=null) {
  const release=acquireStoreLock(root,'feed.lock');
  try{
    preserveCompletionEvidence(root,source);
    const serialized=JSON.stringify({schema_version:1,...source}),bytes=Buffer.byteLength(serialized);
    // Other sources were pruned when they were published; prune them all only when full.
    if(bytes>MAX_TRANSCRIPT_BYTES||pruneFeed(root,source.source_key)+bytes>MAX_FEED_BYTES&&pruneFeed(root)+bytes>MAX_FEED_BYTES
      &&evictFrozenCaptures(root,bytes)+bytes>MAX_FEED_BYTES){
      try{noteRefused(root,source.source_key,Date.now());}catch{/* The back-off is optional. */}
      throw Error('claude_feed_storage_bound');
    }
    const filename = `${source.source_key}-${source.captured_at}-${process.hrtime.bigint().toString(16).padStart(16,'0')}${crypto.randomBytes(6).toString('hex')}.json`;
    atomicJson(root,filename,null,false,serialized);
    pruneFeed(root,source.source_key);
    try{noteRefused(root,source.source_key,null);}catch{/* The back-off is optional. */}
    try{writeResume(root,source.source_key,resume?.next);}catch{/* Optional state; parsing stays authoritative. */}
    try{writeResumeCounts(root,source,resume);}catch{/* Optional counts never prevent capture. */}
  }finally{release();}
}
function captureTime() { lastCaptureAt = Math.max(Date.now(),lastCaptureAt+1); return lastCaptureAt; }
// Tool events come with every tool call, so they capture a source at most
// every 30 s; completion events and the registered refresh capture every time.
const TOOL_EVENTS = new Set(['PostToolUse','PostToolUseFailure']);
const TOOL_CAPTURE_INTERVAL_MS = 30_000;
function recentlyCaptured(names,input,descriptor,now) {
  const key = hash(descriptor.agentId ? `${input.session_id}:${descriptor.agentId}` : input.session_id,'source');
  return Boolean(key) && names.some(name=>name.startsWith(`${key}-`) && CAPTURE_NAME.test(name) && now-Number(name.split('-')[1])<TOOL_CAPTURE_INTERVAL_MS);
}

// Enumerate only the documented child directory of an already authorized main.
// A filename identifies a candidate; matching transcript identities authorize usage.
function discoverRegisteredChildren(root,entry) {
  const registered=[];
  if (entry.agentId || !entry.transcript.endsWith('.jsonl')) return registered;
  const directory = path.join(path.dirname(entry.transcript),path.basename(entry.transcript,'.jsonl'),'subagents');
  if (!safeDirectory(directory)) return registered;
  let handle;
  try {
    handle = fs.opendirSync(directory);
    let count = 0, candidate;
    while ((candidate = handle.readSync())) {
      if (++count > MAX_SOURCES) throw new Error('registry_bound');
      if (!candidate.isFile()) continue;
      const match = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/.exec(candidate.name);
      if (!match) continue;
      const name=registerSource(root,entry,{transcript:path.join(directory,candidate.name),agentId:match[1],derived:true},true);
      if(name)registered.push(name);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (handle) handle.closeSync(); }
  return registered;
}

function registeredPathExists(file) {
  try { return safeDirectory(path.dirname(file)) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(); }
  catch { return false; }
}

function catalogCandidate(file,budget) {
  if (!safeDirectory(path.dirname(file))) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
  budget.bytes += stat.size;
  if (budget.bytes > MAX_TRANSCRIPT_BYTES) throw new Error('recovery_bound');
  let incomplete=false;
  let identity = null;
  const sessions = new Set(), agents = new Set();
  for (const line of transcriptLines(file,()=>{incomplete=true;})) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.sessionId) sessions.add(event.sessionId);
    if (event.agentId) agents.add(event.agentId);
    if (event.type !== 'assistant' || !event.message?.usage) continue;
    if (typeof event.sessionId !== 'string') return null;
    const current = {sessionId:event.sessionId,agentId:typeof event.agentId === 'string' ? event.agentId:null};
    if (identity && (identity.sessionId !== current.sessionId || identity.agentId !== current.agentId)) return null;
    identity = current;
  }
  if (incomplete || !identity || [...sessions].some(value=>value !== identity.sessionId)
    || [...agents].some(value=>value !== identity.agentId) || identity.agentId === null && agents.size) return null;
  return {file,...identity};
}

const recoveryIdentity = (sessionId,agentId) => JSON.stringify([sessionId,agentId]);

function recoveryCatalog(states,projectRoot,timings) {
  if (!projectRoot) return null;
  if (!path.isAbsolute(projectRoot) || !safeDirectory(projectRoot)) throw new Error('unsafe_recovery_root');
  if(timings)timings.claude_catalog_walks++;
  const budget = {entries:0,bytes:0,directories:0}, catalog = new Map(), scanned = new Set();
  // Claude names a transcript after its session (<session>.jsonl) or child agent
  // (agent-<id>.jsonl). Only files that can belong to a stale source, or to the
  // stale parent of a stale child, are parsed; parsing then proves their identity.
  // A stale child whose parent is still where it was registered is looked for in
  // that parent's own child directory, without parsing the parent.
  const parents = new Map(states.filter(({entry})=>entry.agentId === null).map(state=>[state.entry.session_id,state]));
  const wanted = new Set();
  for (const {entry,stale} of states) {
    if (!stale) continue;
    if (entry.agentId !== null) wanted.add(`agent-${entry.agentId}.jsonl`);
    if (entry.agentId === null || parents.get(entry.session_id)?.stale !== false) wanted.add(`${entry.session_id}.jsonl`);
  }
  const scan = (directory,includeDirectories = false) => {
    if (scanned.has(directory)) return [];
    if (++budget.directories > MAX_SOURCES || !safeDirectory(directory)) throw new Error('recovery_bound');
    scanned.add(directory);
    const children = [];
    let handle;
    try {
      handle = fs.opendirSync(directory);
      let candidate;
      while ((candidate = handle.readSync())) {
        if (++budget.entries > MAX_SOURCES) throw new Error('recovery_bound');
        const file = path.join(directory,candidate.name);
        if (includeDirectories && candidate.isDirectory()) children.push(file);
        if(timings&&candidate.isFile())timings.claude_catalog_files++;
        if (!candidate.isFile() || !wanted.has(candidate.name)) continue;
        const item = catalogCandidate(file,budget);
        if (item) {
          const key = recoveryIdentity(item.sessionId,item.agentId), matches = catalog.get(key) ?? [];
          matches.push(item.file); catalog.set(key,matches);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { if (handle) handle.closeSync(); }
    return children;
  };
  const projectDirectories = scan(projectRoot,true);
  for (const directory of projectDirectories) scan(directory);
  const staleChildSessions = new Set(states.filter(({entry,stale})=>stale && entry.agentId !== null).map(({entry})=>entry.session_id));
  for (const {entry,stale} of states) {
    if (entry.agentId !== null || !staleChildSessions.has(entry.session_id)) continue;
    const matches = stale ? catalog.get(recoveryIdentity(entry.session_id,null)) ?? [] : [entry.transcript];
    if (matches.length !== 1) continue;
    scan(path.join(path.dirname(matches[0]),path.basename(matches[0],'.jsonl'),'subagents'));
  }
  return catalog;
}

// Claude deletes old transcripts, which never come back, while a renamed project
// moves them. The same stale set is searched for at most hourly; between
// searches the last outcome stands, including an incomplete refresh.
const RECOVERY_RETRY_MS = 60 * 60_000, RECOVERY_MEMO = '.stale-recovery.json';
const staleKey = (projectRoot,names) => crypto.createHash('sha256').update(JSON.stringify([projectRoot ?? null,[...names].sort()])).digest('hex');
function recoverStaleRegistrations(directory,entries,projectRoot,timings) {
  const states = entries.map(registered=>({registered,entry:registered.entry,stale:!registeredPathExists(registered.entry.transcript)}));
  const stale = states.filter(({stale})=>stale).map(({registered})=>registered.name);
  if(timings)timings.claude_stale_registrations=stale.length;
  // Without an opted-in project root there is nothing to search.
  if (!stale.length || !projectRoot) return;
  const root = path.dirname(directory), now = Date.now();
  let memo = null;
  try { memo = JSON.parse(readRegular(path.join(root,RECOVERY_MEMO),4096)); } catch { /* No earlier search. */ }
  if (memo?.schema_version === 1 && memo.key === staleKey(projectRoot,stale) && Number.isSafeInteger(memo.attempted_at) && memo.attempted_at <= now && now - memo.attempted_at < RECOVERY_RETRY_MS) {
    if (memo.failed === true) throw new Error('stale_recovery_pending');
    return;
  }
  let remaining = stale, failed = true;
  try {
    const catalog = measurePhase(timings,'claude_catalog_walk',()=>recoveryCatalog(states,projectRoot,timings));
    if (catalog) {
      const replacements = [];
      for (const state of states) {
        if (!state.stale) continue;
        const matches = catalog.get(recoveryIdentity(state.entry.session_id,state.entry.agentId)) ?? [];
        if (matches.length === 1) replacements.push({registered:state.registered,file:matches[0]});
      }
      for (const {registered,file} of replacements) {
        registered.entry = {...registered.entry,transcript:file,strictSession:true};
        atomicJson(directory,registered.name,registered.entry);
      }
      const replaced = new Set(replacements.map(({registered})=>registered.name));
      remaining = stale.filter(name=>!replaced.has(name));
    }
    failed = false;
  } finally {
    try { atomicJson(root,RECOVERY_MEMO,{schema_version:1,key:staleKey(projectRoot,remaining),attempted_at:now,failed}); }
    catch { /* The next capture searches again. */ }
  }
}

// Upgrade only identities already proven by the numeric feed. Enumerating the
// explicit project root does not authorize importing any other task.
function migrateLegacySources(root,projectRoot) {
  const gaps = new Set();
  if (!projectRoot) return gaps;
  if (!path.isAbsolute(projectRoot) || !safeDirectory(projectRoot)) return new Set(['claude_source_migration_unavailable']);
  const registry = path.join(root,REGISTRY);
  // Existing registrations, even invalid ones, belong to refresh validation.
  // Avoid parsing every numeric feed just to rediscover that none need migration:
  // only a main feed without a registration can migrate, so read just those feeds.
  try{
    const known=new Set(fs.readdirSync(registry));
    if(fs.readdirSync(root).filter(name=>CAPTURE_NAME.test(name)&&!known.has(name.slice(0,20)+'.json'))
      .every(name=>JSON.parse(readRegular(path.join(root,name),MAX_TRANSCRIPT_BYTES)).role!=='main'))return gaps;
  }catch{/* The original migration path classifies missing/incomplete evidence. */}
  const tasks = new Set(readClaudeWorkspaceFeed(root).sources.filter(source=> {
    if (source.role !== 'main') return false;
    // Existing entries belong to refresh validation, including malformed entries.
    // Migration must never override authorization or report catalog ambiguity for them.
    try { fs.lstatSync(path.join(registry,`${source.source_key}.json`)); return false; }
    catch (error) { return error.code === 'ENOENT'; }
  }).map(source=>source.task_key));
  if (!tasks.size) return gaps;
  const candidates = new Map(), directories = [projectRoot];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jsonl$/i;
  let visited = 0;
  try {
    for (const directory of directories) {
      if (!safeDirectory(directory)) throw new Error('unsafe_migration_directory');
      const handle = fs.opendirSync(directory);
      try {
        let entry;
        while ((entry = handle.readSync())) {
          if (++visited > MAX_SOURCES) throw new Error('migration_bound');
          const file = path.join(directory,entry.name);
          if (directory === projectRoot && entry.isDirectory()) { directories.push(file); continue; }
          if (!entry.isFile() || !uuid.test(entry.name)) continue;
          const sessionId = entry.name.slice(0,-6), taskKey = hash(sessionId,'task');
          if (!tasks.has(taskKey)) continue;
          const values = candidates.get(taskKey) ?? [];
          values.push({sessionId,file}); candidates.set(taskKey,values);
        }
      } finally { handle.closeSync(); }
    }
  } catch (error) {
    // An incomplete inventory cannot prove a candidate is unique.
    gaps.add(error.message === 'migration_bound' ? 'claude_source_migration_bound':'claude_source_migration_unavailable');
    return gaps;
  }
  for (const values of candidates.values()) {
    if (values.length !== 1) { gaps.add('claude_source_migration_ambiguous'); continue; }
    const {sessionId,file} = values[0];
    try { registerSource(root,{session_id:sessionId},{transcript:file,agentId:null,strictSession:true},true); }
    catch { gaps.add('claude_source_migration_unavailable'); }
  }
  return gaps;
}

function readRegistration(directory,name) {
  const entry=JSON.parse(readRegular(path.join(directory,name),8192));
  if(Object.keys(entry).some(key=>!['session_id','transcript','agentId','derived','strictSession'].includes(key)) || typeof entry.session_id!=='string' || entry.session_id.length>512 || typeof entry.transcript!=='string' || !path.isAbsolute(entry.transcript) || entry.transcript.length>4096 || !(entry.agentId===null || typeof entry.agentId==='string'&&entry.agentId.length<=512) || typeof entry.derived!=='boolean' || !(entry.strictSession===undefined || typeof entry.strictSession==='boolean'))throw new Error('invalid_registry');
  const key=hash(entry.agentId?`${entry.session_id}:${entry.agentId}`:entry.session_id,'source');
  if(name!==`${key}.json`)throw new Error('invalid_registry');
  return entry;
}

// Private paths for the local metadata probe, never returned by a report.
export function registeredClaudeSourceInputs(root) {
  if(!safeDirectory(root))throw new Error('unsafe_registry');
  const directory=path.join(root,REGISTRY);
  if(!safeDirectory(directory))throw new Error('unsafe_registry');
  let names;
  try{names=fs.readdirSync(directory).filter(name=>/^[a-f0-9]{20}\.json$/.test(name));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(names.length>MAX_SOURCES)throw new Error('registry_bound');
  return names.sort().map(name=>readRegistration(directory,name).transcript);
}

// Claude deletes old transcripts for good. A child registration whose transcript
// is gone, that the completed project search did not find, and that is over a
// day old (a move in progress keeps it) is dropped; its numeric feed captures
// stay. Main registrations stay: a main feed without one is what
// migrateLegacySources searches the project root for on every refresh.
const DEAD_REGISTRATION_MS = 24 * 60 * 60_000;
function deadRegistrations(directory,registered) {
  const before = Date.now() - DEAD_REGISTRATION_MS;
  return registered.filter(({name,entry}) => {
    if (!entry.agentId || registeredPathExists(entry.transcript)) return false;
    try { const stat = fs.lstatSync(path.join(directory,name)); return stat.isFile() && stat.mtimeMs < before; } catch { return false; }
  }).map(({name}) => name);
}

/** Refresh only previously authorized sources. This is not a lifecycle event. */
function reusableSource(root,entry,latestFiles,resume) {
  const key=hash(entry.agentId?`${entry.session_id}:${entry.agentId}`:entry.session_id,'source');
  const name=latestFiles.get(key);
  if(!name)return null;
  try{
    const source=JSON.parse(readRegular(path.join(root,name),MAX_TRANSCRIPT_BYTES));
    if(!validSource(source)||source.source_key!==key||source.collector_version!==version&&!source.collector_version.endsWith(CAPTURE_REVISION)||source.task_key!==hash(entry.session_id,'task'))return null;
    if(resume)resume.source=source;
    try{
      if(source.source_signature!==transcriptSignature(entry.transcript,entry.derived,entry.strictSession===true))return null;
    }catch(error){
      // Check absence again on every poll. Preserve unavailable evidence; a
      // newly created/recovered file must go through the normal parser.
      if(error.code!=='ENOENT'||source.source_signature!==undefined||source.records.length
        ||!source.coverage_gaps.includes('transcript_unavailable'))return null;
    }
    // Stable input produces the same partial result too. Keep its gaps rather
    // than parsing and publishing identical conflicts on every capture.
    // Keep the published seed intact for the hook's checkpoint binding.
    const at=captureTime();
    return {...source,captured_at:at,capture_origin:'registered_refresh',
      records:source.records.map(record=>({...record,captured_at:at,capture_origin:'registered_refresh'}))};
  }catch{return null;}
}

const RESUME_FILE='.claude-resume.json',RESUME_FILES=6,RESUME_BYTES=64*1024;
const RESUME_PRIORITY_BYTES=1024*1024;
const RESUME_COUNTS_FILE='.claude-resume-counts.json';
function writeResumeCounts(root,source,resume) {
  // Only published row-backed captures count; bound/empty captures and skipped tool events do not.
  if(!source.records.length||source.coverage_gaps.includes('transcript_bound')||!resume?.size)return;
  const fields=['resumed','full_large','full_small','skipped_bytes','parsed_bytes'],origins=['hook','registered_refresh'];
  const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
  const numeric=value=>Number.isSafeInteger(value)&&value>=0;
  let counts;
  try {
    counts=JSON.parse(readRegular(path.join(root,RESUME_COUNTS_FILE),4096));
    if(!only(counts,['since',...origins])||!numeric(counts.since)||counts.since===0
      ||!origins.every(origin=>only(counts[origin],fields)&&fields.every(key=>numeric(counts[origin][key]))))throw Error('invalid_counts');
  }catch{
    const empty=()=>({resumed:0,full_large:0,full_small:0,skipped_bytes:0,parsed_bytes:0});
    counts={since:source.captured_at,hook:empty(),registered_refresh:empty()};
  }
  const origin=counts[source.capture_origin];
  if(!origin||!numeric(resume.start)||!numeric(resume.size)||resume.start>resume.size)return;
  if(resume.start>0)origin.resumed++;
  else if(resume.size>=RESUME_PRIORITY_BYTES)origin.full_large++;
  else origin.full_small++;
  origin.skipped_bytes+=resume.start;origin.parsed_bytes+=resume.size-resume.start;
  if(!fields.every(key=>numeric(origin[key])))throw Error('counter_bound');
  atomicJson(root,RESUME_COUNTS_FILE,counts);
}
function readResume(root) {
  try {
    const saved=JSON.parse(readRegular(path.join(root,RESUME_FILE),RESUME_BYTES));
    const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
    if(!only(saved,['schema_version','revision','files'])||saved.schema_version!==2||saved.revision!==CAPTURE_REVISION
      ||!Array.isArray(saved.files)||saved.files.length>RESUME_FILES)throw Error('invalid_resume');
    for(const entry of saved.files)if(!only(entry,['key','size','dev','ino','mtime_ms','digest','signature','captured_at','derived','strictSession','turn','gaps','records_digest'])
      ||JSON.stringify(entry).length>4096||!isHashedIdentity(entry.key)||!(entry.turn===null||isHashedIdentity(entry.turn))
      ||!['size','dev','ino'].every(key=>Number.isSafeInteger(entry[key])&&entry[key]>=0)||entry.size>TRANSCRIPT_CEILING_BYTES
      ||!Number.isFinite(entry.mtime_ms)||entry.mtime_ms<=0||!Number.isSafeInteger(entry.captured_at)||entry.captured_at<=0
      ||typeof entry.derived!=='boolean'||typeof entry.strictSession!=='boolean'||!(entry.signature===null||typeof entry.signature==='string'&&/^[a-f0-9]{64}$/.test(entry.signature))
      ||typeof entry.digest!=='string'||!/^(?:[a-f0-9]{8}|[a-f0-9]{64})$/.test(entry.digest)||typeof entry.records_digest!=='string'||!/^[a-f0-9]{64}$/.test(entry.records_digest)
      ||!Array.isArray(entry.gaps)||entry.gaps.length>GAP_CODES.size||entry.gaps.some(gap=>!GAP_CODES.has(gap)))throw Error('invalid_resume');
    return saved;
  }catch{return {schema_version:2,revision:CAPTURE_REVISION,files:[]};}
}


function writeResume(root,key,checkpoint) {
  const saved=readResume(root),checkpoints=new Map(saved.files.map(entry=>[entry.key,entry]));
  if(checkpoint)checkpoints.set(key,{key,...checkpoint});else checkpoints.delete(key);
  const directory=path.join(root,REGISTRY);
  // ponytail: prioritize >=1 MiB by recency; small prefixes fill spare slots, more than six large sources parse fully.
  const files=[...checkpoints.values()].filter(entry=>{try{const stat=fs.lstatSync(path.join(directory,entry.key+'.json'));return stat.isFile()&&!stat.isSymbolicLink();}catch{return false;}}).sort((a,b)=>(b.size>=RESUME_PRIORITY_BYTES)-(a.size>=RESUME_PRIORITY_BYTES)||b.mtime_ms-a.mtime_ms||b.size-a.size).slice(0,RESUME_FILES);
  const next={schema_version:2,revision:CAPTURE_REVISION,files};
  if(JSON.stringify(next)!==JSON.stringify(saved))atomicJson(root,RESUME_FILE,next);
}

export function refreshRegisteredClaudeSources(root, {projectRoot,reuse=false,timings} = {}) {
  const refreshStarted=startPhase();
  if(timings)Object.assign(timings,{claude_registrations:0,claude_stale_registrations:0,claude_catalog_walks:0,claude_catalog_files:0,claude_dead_registrations_pruned:0,claude_sources_reused:0,claude_sources_captured:0});
  if (!root || !safeDirectory(root) || !safeDirectory(path.join(root,REGISTRY))) {finishPhase(timings,'claude_refresh_other',refreshStarted);return {status:'unavailable',source_count:0};}
  const directory = path.join(root,REGISTRY);
  const migrationGaps = measurePhase(timings,'claude_legacy_migration',()=>migrateLegacySources(root,projectRoot));
  const savedResume=readResume(root),checkpoints=new Map(savedResume.files.map(entry=>[entry.key,entry]));
  let count = 0, failed = migrationGaps.size > 0;
  const reusedSources=[],storageGaps=new Set(),pruned=new Set();
  try {
    const registryStarted=startPhase();
    const latestFiles=new Map();
    if(reuse)for(const name of fs.readdirSync(root).filter(name=>CAPTURE_NAME.test(name)).sort())latestFiles.set(name.slice(0,20),name);
    const names = fs.readdirSync(directory).filter(name=>/^[a-f0-9]{20}\.json$/.test(name));
    if (names.length > MAX_SOURCES) failed = true;
    const pending = names.sort().slice(0,MAX_SOURCES), seen = new Set(pending);
    const registered = [];
    for (const name of pending) {
      try {
        const entry = readRegistration(directory,name);
        registered.push({name,entry});
      } catch { failed = true; }
    }
    finishPhase(timings,'claude_registry',registryStarted);
    if(timings)timings.claude_registrations=registered.length;
    let searched = Boolean(projectRoot);const recoveryStarted=startPhase();
    try { recoverStaleRegistrations(directory,registered,projectRoot,timings); }
    catch { failed = true; searched = false; }
    finally {finishPhase(timings,'claude_stale_recovery',recoveryStarted,['claude_catalog_walk']);}
    if(searched)measurePhase(timings,'claude_dead_prune',()=>{for (const name of deadRegistrations(directory,registered)) { fs.rmSync(path.join(directory,name),{force:true}); pruned.add(name); }});
    if(timings)timings.claude_dead_registrations_pruned=pruned.size;
    const registeredByName=new Map(registered.map(item=>[item.name,item])),refused=refusedSources(root);
    for (const name of pending) {
      if (pruned.has(name)) continue;
      try {
        const recovered = registeredByName.get(name);
        const entry = recovered ? recovered.entry : measurePhase(timings,'claude_registry',()=>readRegistration(directory,name));
        if (!entry.agentId) {
          let children=[];
          try { children=discoverRegisteredChildren(root,entry); } catch { failed = true; }
          for (const childName of children) {
            if (seen.has(childName)) continue;
            if (pending.length >= MAX_SOURCES) { failed = true; break; }
            seen.add(childName); pending.push(childName);
          }
        }
        const key=name.slice(0,20),resume={previous:reuse?checkpoints.get(key):null,source:null,next:null};
        const cached=reuse?measurePhase(timings,'claude_reuse',()=>reusableSource(root,entry,latestFiles,resume)):null;
        if(cached){reusedSources.push(cached);count++;if(timings)timings.claude_sources_reused++;continue;}
        if(refusedRecently(refused,key,Date.now())){failed=true;storageGaps.add('claude_feed_storage_bound');continue;}
        const source = measurePhase(timings,'claude_capture',()=>captureSource(entry,null,entry.transcript,entry.agentId,captureTime(),entry.derived,entry.strictSession,TRANSCRIPT_CEILING_BYTES,resume));
        if (source) { measurePhase(timings,'claude_publish',()=>publishSource(root,source,resume)); count++;if(timings)timings.claude_sources_captured++; }
      } catch(error) { failed = true;if(error.message==='claude_feed_storage_bound')storageGaps.add(error.message); }
    }
  } catch (error) { if (error.code !== 'ENOENT') failed = true; }
  finishPhase(timings,'claude_refresh_other',refreshStarted,['claude_legacy_migration','claude_registry','claude_stale_recovery','claude_catalog_walk','claude_dead_prune','claude_reuse','claude_capture','claude_publish']);
  return {status:failed ? 'partial':'refreshed',source_count:count,pruned_sources:pruned.size,reused_sources:reusedSources,coverage_gaps:[...migrationGaps,...storageGaps,...(failed ? ['claude_source_refresh_incomplete']:[])]};
}

/** Numeric-only capture from host-authorized hook paths, explicitly opted in. */
export function captureClaudeWorkspaceHook(input = {}, eventName, env = {}, {maxTranscriptBytes = TRANSCRIPT_READ_BYTES} = {}) {
  const root = configuredClaudeWorkspaceRoot(env);
  if (!root || env.SOMESTOKEN_RUNTIME !== 'claude' || !EVENTS.has(eventName)) return {status:'disabled'};
  if (!safeDirectory(root)) return {status:'unavailable',reason:'unsafe_capture_root'};
  const observedAt = captureTime();
  let count = 0;
  try {
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const names=fs.readdirSync(root),latestFiles=new Map();
    for(const name of names.filter(name=>CAPTURE_NAME.test(name)).sort())latestFiles.set(name.slice(0,20),name);
    const checkpoints=new Map(readResume(root).files.map(entry=>[entry.key,entry])),refused=refusedSources(root);
    for (const descriptor of descriptors(input,eventName)) {
      registerSource(root,input,descriptor);
      if (TOOL_EVENTS.has(eventName) && recentlyCaptured(names,input,descriptor,observedAt)) continue;
      const key=hash(descriptor.agentId?`${input.session_id}:${descriptor.agentId}`:input.session_id,'source');
      if (refusedRecently(refused,key,Date.now())) continue;
      const resume={previous:checkpoints.get(key),source:null,next:null};
      reusableSource(root,{...descriptor,session_id:input.session_id},latestFiles,resume);
      const source = captureSource(input,eventName,descriptor.transcript,descriptor.agentId,observedAt,descriptor.derived,false,maxTranscriptBytes,resume);
      // An empty bound capture would become the newest and hide the rows already
      // captured; the registered refresh reads this source instead.
      if (source?.coverage_gaps.includes('transcript_bound')) continue;
      if (source) { publishSource(root,source,resume); count++; }
    }
    return {status:'captured',collector_version:version,captured_at:observedAt,source_count:count};
  } catch(error) { return {status:'unavailable',reason:error.message==='claude_feed_storage_bound'?error.message:'capture_write_failed'}; }
}

const SOURCE_KEYS = new Set('schema_version source_signature completion_evidence capture_origin host task_key source_key parent_source role collector_version captured_at reasoning_usage_status cache_read_semantics cache_write_semantics input_includes_cache_read input_excludes_cache_read denominator_supported coverage_status coverage_gaps records'.split(' '));
const RECORD_KEYS = new Set('capture_origin host record_key task_key source_key parent_source turn_key root_key role model effort service_tier requested_service_tier observed_at completed completed_at duration_ms quality usage reasoning_usage_status collector_version captured_at cache_read_semantics cache_write_semantics input_includes_cache_read input_excludes_cache_read denominator_supported'.split(' '));
const USAGE_KEYS = new Set('input_tokens cached_input_tokens output_tokens reasoning_output_tokens total_tokens cache_write_input_tokens consistent'.split(' '));
const GAP_CODES = new Set(['child_root_unavailable','completion_evidence_limit','incomplete_transcript_tail','invalid_transcript_record','source_identity_mismatch','response_identity_unavailable','invalid_response_usage','response_timestamp_unavailable','response_conflict','transcript_bound','transcript_unavailable','child_usage_unavailable','usage_unavailable']);
GAP_CODES.add('source_changed_during_read');
function validSource(source) {
  const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.has(key));
  const base = value => value.host === 'claude' && isHashedIdentity(value.task_key ?? '') && isHashedIdentity(value.source_key ?? '')
    && (value.parent_source === null || isHashedIdentity(value.parent_source ?? ''))
    && ['main','subagent'].includes(value.role) && (value.capture_origin === undefined || ['hook','registered_refresh'].includes(value.capture_origin)) && typeof value.collector_version==='string' && LABEL.test(value.collector_version) && safeModel(value.collector_version.replaceAll('+','.'))
    && Number.isSafeInteger(value.captured_at) && value.captured_at > 0
    && value.reasoning_usage_status === 'unmeasured'
    && Object.entries(claudeCacheSemantics()).every(([key,expected])=>value[key] === expected);
  const completionEvidence = source?.completion_evidence;
  const validCompletions = completionEvidence === undefined || (completionEvidence && typeof completionEvidence === 'object'
    && !Array.isArray(completionEvidence) && Object.keys(completionEvidence).length <= MAX_COMPLETIONS
    && Object.entries(completionEvidence).every(([key,value])=>isHashedIdentity(key) && only(value,new Set(['fingerprint','completed_at']))
      && typeof value.fingerprint==='string' && /^[a-f0-9]{64}$/.test(value.fingerprint) && Number.isSafeInteger(value.completed_at) && value.completed_at>0));
  return only(source,SOURCE_KEYS) && source.schema_version === 1 && base(source) && validCompletions
    && (source.source_signature===undefined||typeof source.source_signature==='string'&&/^[a-f0-9]{64}$/.test(source.source_signature))
    && ['exact','partial'].includes(source.coverage_status)
    && Array.isArray(source.coverage_gaps) && source.coverage_gaps.every(gap=>GAP_CODES.has(gap))
    && Array.isArray(source.records) && source.records.every(record => only(record,RECORD_KEYS) && base(record)
      && record.task_key === source.task_key && record.source_key === source.source_key
      && ['record_key','turn_key'].every(key=>isHashedIdentity(record[key] ?? ''))
      && (record.root_key === null && record.role === 'subagent' || isHashedIdentity(record.root_key ?? ''))
      && ['model','effort','service_tier','requested_service_tier'].every(key=>typeof record[key]==='string' && LABEL.test(record[key]) && safeModel(record[key].replaceAll('+','.')))
      && Number.isSafeInteger(record.observed_at) && record.observed_at > 0
      && typeof record.completed === 'boolean'
      && (record.completed_at === null || Number.isSafeInteger(record.completed_at))
      && record.duration_ms === null && record.quality === 'exact'
      && only(record.usage,USAGE_KEYS) && record.usage.consistent === true
      && [...USAGE_KEYS].filter(key=>!['consistent','cache_write_input_tokens'].includes(key)).every(key=>Number.isSafeInteger(record.usage[key]) && record.usage[key]>=0)
      && (record.usage.cache_write_input_tokens === null || (Number.isSafeInteger(record.usage.cache_write_input_tokens) && record.usage.cache_write_input_tokens>=0))
      && record.usage.reasoning_output_tokens === 0
      && record.usage.input_tokens + record.usage.output_tokens === record.usage.total_tokens
      && record.usage.cached_input_tokens <= record.usage.input_tokens);
}

export function readClaudeWorkspaceFeed(root,{revalidatedSources=[],timings}={}) {
  if(timings)timings.claude_feed_files_read=0;
  const gaps = new Set(), latest = new Map();
  if (!root || !safeDirectory(root)) return {status:'unavailable',records:[],tasks:[],sources:[],coverage_gaps:['claude_capture_unavailable'],global_coverage_gaps:['claude_capture_unavailable'],record_inventory_complete:false,host:'claude'};
  try {
    for(const source of revalidatedSources)if(validSource(source))latest.set(source.source_key,source);
    const names = fs.readdirSync(root).filter(name => /^[a-f0-9]{20}-\d+-[a-f0-9]+\.json$/.test(name));
    if (names.length > MAX_SOURCES * 2) gaps.add('claude_source_limit');
    let bytes=0;
    for (const name of names.sort().reverse().slice(0,MAX_SOURCES * 2)) {
      if(latest.has(name.slice(0,20)))continue;
      try {
        bytes+=fs.lstatSync(path.join(root,name)).size;
        if(bytes>MAX_FEED_BYTES){gaps.add('claude_feed_storage_bound');break;}
        if(timings)timings.claude_feed_files_read++;
        const source = JSON.parse(readRegular(path.join(root,name),MAX_TRANSCRIPT_BYTES));
        if (!validSource(source) || !name.startsWith(`${source.source_key}-`)) throw new Error('invalid');
        const previous = latest.get(source.source_key);
        if (!previous || previous.captured_at <= source.captured_at) latest.set(source.source_key,source);
      } catch { gaps.add('invalid_claude_capture'); }
    }
  } catch { gaps.add('claude_capture_unavailable'); }
  if (!latest.size) gaps.add('awaiting_claude_hook');
  const globalGaps = [...gaps];
  const sources = [...latest.values()];
  for (const source of sources) for (const gap of source.coverage_gaps ?? []) gaps.add(gap);
  const tasksByKey = new Map();
  for (const source of sources) {
    const task = tasksByKey.get(source.task_key) ?? {host:'claude',task_key:source.task_key,label:`Task ${source.task_key.slice(0,8)}`,source_keys:[],coverage_gaps:[]};
    task.source_keys.push(source.source_key);
    task.coverage_gaps = [...new Set([...task.coverage_gaps,...source.coverage_gaps,...globalGaps])];
    task.coverage_status = task.coverage_gaps.length ? 'partial':'exact';
    tasksByKey.set(task.task_key,task);
  }
  const tasks = [...tasksByKey.values()];
  return {status:!sources.length ? 'unavailable':gaps.size ? 'partial':'exact',records:sources.flatMap(s=>s.records),tasks,
    sources:sources.map(({records,completion_evidence,source_signature,...source})=>source),coverage_gaps:[...gaps],global_coverage_gaps:globalGaps,
    record_inventory_complete:false,host:'claude',observed_at:Date.now(),
    scanned_files:sources.length,capture_scope:'authorized_claude_hook_transcripts',current_response_unflushed:'unavailable'};
}
