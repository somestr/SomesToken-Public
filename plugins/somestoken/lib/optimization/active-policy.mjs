import path from 'node:path';
import fs,{realpathSync} from 'node:fs';
import {hashId, hashOpaqueHostIdentifier,isHashedIdentity} from '../core.mjs';
import {DEVELOPMENT_CONTEXT} from './lifecycle-checks.mjs';

export const ACTIVE_POLICY_VERSION = 12;
const MAX_ITEMS = 128;
const HOSTS = ['codex','claude'];
const MODES = ['observe','balanced'];
const SCOPES = ['task','project','repository','host'];
// A delivery records the selection it came from; derive the pattern from SCOPES so a
// new scope cannot be dropped on reload (that re-sent the policy on every prompt).
const SELECTION_KEY = new RegExp(`^(codex|claude):(host:all|(?:${SCOPES.filter(scope=>scope!=='host').join('|')}):[a-f0-9]{20})$`);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const POLICY_CONTEXT = 'SomesToken balanced efficiency policy: reuse project code, standard APIs and supplied context; only necessary dependencies. Fix shared causes; preserve safeguards. Batch independent prep; read relevant ranges/diffs/returned contracts before edits; use documented tool formats. Focus edits; on rejection inspect what applied and repair only affected parts without resending unchanged code. Combine successful edits with known checks; never check failed edits. No speculative rewrites or duplicate commentary code. Use compact Node/native summaries; retain failures/original detail. Wait up to 10 seconds for short checks; long work async. Reuse checks only with code, inputs, configuration, tools and environment unchanged; complete required tests/final gates. Prepare runtimes/access before measuring; retry with new evidence. Keep scope/model/effort/permissions; no session reset or token-target stop. Delegate only authorized work; count setup/main/child/rework. For behaviour-preserving code changes use the somestoken-code skill (change start, edit, change finish); no other optimization skill required. Telemetry only when asked. Compare accepted work, uncached input, output and elapsed time; fewer tokens do not establish quota savings.';
const DISABLED_CONTEXT = 'SomesToken balanced efficiency policy is disabled for this scope. Continue the user\'s chosen workflow and required tests; background measurement stays enabled. Do not add routine usage reports.';

function projectKey(cwd) {
  if(typeof cwd !== 'string'||cwd.length>4096||cwd.includes('\0')||!path.isAbsolute(cwd))return null;
  try{return hashId(`efficiency-project:${realpathSync(cwd)}`);}catch{return null;}
}
// Git worktrees share their common metadata directory. Read bounded local
// pointers without executing repository commands or loading instructions.
function repositoryKey(cwd) {
  if(typeof cwd!=='string'||cwd.length>4096||cwd.includes('\0')||!path.isAbsolute(cwd))return null;
  const pointer=file=>{
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{
      const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>4096)throw Error('invalid_git_pointer');
      const bytes=Buffer.alloc(4097),size=fs.readSync(fd,bytes,0,bytes.length,0);
      if(size!==stat.size||fs.fstatSync(fd).size!==stat.size)throw Error('invalid_git_pointer');
      const text=bytes.subarray(0,size).toString('utf8').replace(/\r?\n$/,'');
      if(!text||/[\r\n\0]/.test(text))throw Error('invalid_git_pointer');return text;
    }finally{fs.closeSync(fd);}
  };
  try{
    let directory=realpathSync(cwd);
    for(let depth=0;depth<64;depth++){
      const file=path.join(directory,'.git');let entry;
      try{entry=fs.lstatSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(entry){
        let metadata=file;
        if(entry.isFile()){
          const value=pointer(file);if(!value.startsWith('gitdir: '))return null;
          metadata=path.resolve(directory,value.slice(8));
        }else if(!entry.isDirectory())return null;
        let common=metadata;
        try{common=path.resolve(metadata,pointer(path.join(metadata,'commondir')));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(!fs.statSync(common).isDirectory())return null;
        return hashId(`efficiency-repository:${realpathSync(common)}`);
      }
      const parent=path.dirname(directory);if(parent===directory)return null;directory=parent;
    }
  }catch{/* Unavailable Git metadata is not a matching repository. */}
  return null;
}
const recordKey = record => `${record.host}:${record.scope}:${record.scope_key}`;
function selection(value) {
  if (!value || !HOSTS.includes(value.host) || !SCOPES.includes(value.scope) || !MODES.includes(value.mode)
    || !integer(value.revision) || value.revision < 1 || !integer(value.selected_at)
    || (value.scope === 'host' ? value.scope_key !== 'all' : !isHashedIdentity(value.scope_key))) return null;
  return {host:value.host,scope:value.scope,scope_key:value.scope_key,mode:value.mode,revision:value.revision,selected_at:value.selected_at,
    ...(value.development_required===true?{development_required:true}:{})};
}

export function normalizeActivePolicies(value) {
  const result={generation:integer(value?.generation)?value.generation:0,selections:{},deliveries:{}};
  for (const record of Object.values(value?.selections ?? {}).slice(-MAX_ITEMS)) {
    const normalized=selection(record);
    if(normalized){
      result.selections[recordKey(normalized)]=normalized;
      result.generation=Math.max(result.generation,normalized.revision);
    }
  }
  for (const [key,record] of Object.entries(value?.deliveries ?? {}).slice(-MAX_ITEMS)) {
    if (!/^(codex|claude):[a-f0-9]{20}$/.test(key) || !record || !MODES.includes(record.mode)
      || !integer(record.revision) || !integer(record.emitted_at) || !integer(record.emission_count)
      || !(record.selection_key === 'none' || typeof record.selection_key==='string'&&SELECTION_KEY.test(record.selection_key))) continue;
    const deliveryHost=key.split(':',1)[0],selectionHost=record.selection_key.split(':',1)[0];
    if(record.selection_key!=='none'&&deliveryHost!==selectionHost)continue;
    result.deliveries[key]={selection_key:record.selection_key,revision:record.revision,mode:record.mode,
      policy_version:integer(record.policy_version)?record.policy_version:0,
      emitted_at:record.emitted_at,emission_count:Math.min(record.emission_count,1_000_000)};
    result.generation=Math.max(result.generation,record.revision);
  }
  return result;
}

export function policySelector({host,scope,task_id,cwd}={}) {
  if (!HOSTS.includes(host) || !SCOPES.includes(scope)) return null;
  const scope_key=scope==='host'?'all':scope==='task'?hashOpaqueHostIdentifier(task_id,host):scope==='repository'?repositoryKey(cwd):projectKey(cwd);
  return scope_key?{host,scope,scope_key}:null;
}

export function activePolicyStatus(state, selector) {
  if(!selector)return {ok:false,error:'invalid_policy_scope'};
  const policies=normalizeActivePolicies(state);
  const key=recordKey(selector), record=policies.selections[key];
  if(!record)return {ok:true,status:'not_selected',policy:null};
  const emitted=Object.values(policies.deliveries).filter(row=>row.selection_key===key&&row.revision===record.revision&&row.mode===record.mode&&row.policy_version===ACTIVE_POLICY_VERSION);
  return {ok:true,status:'selected',policy:{host:record.host,scope:record.scope,mode:record.mode,revision:record.revision,
    selected_at:record.selected_at,policy_version:ACTIVE_POLICY_VERSION,
    development_required:record.development_required===true,
    delivery_status:emitted.length?'hook_emitted':'awaiting_hook',emitted_sessions:emitted.length,
    application_status:'unverified',savings_status:'unmeasured',target_percent:{minimum:10,maximum:30}}};
}

export function selectActivePolicy(state, selector, mode, at=Date.now(),{developmentRequired}={}) {
  if(!selector || !MODES.includes(mode) || !integer(at))return {ok:false,error:'invalid_policy_selection'};
  const normalized=normalizeActivePolicies(state),key=recordKey(selector),prior=normalized.selections[key];
  if(developmentRequired!==undefined&&typeof developmentRequired!=='boolean')return {ok:false,error:'invalid_development_requirement'};
  const required=developmentRequired??(prior?.development_required===true);
  if(prior?.mode===mode&&(prior.development_required===true)===required)return {...activePolicyStatus(normalized,selector),changed:false};
  if(normalized.generation===Number.MAX_SAFE_INTEGER)return {ok:false,error:'policy_revision_exhausted'};
  normalized.generation+=1;
  normalized.selections[key]={...selector,mode,revision:normalized.generation,selected_at:at,...(required?{development_required:true}:{})};
  Object.assign(state,normalizeActivePolicies(normalized));
  return {...activePolicyStatus(state,selector),changed:true};
}

export function activeTaskPolicy(state,{host,session_id,cwd}={}) {
  const session=hashOpaqueHostIdentifier(session_id,host);if(!HOSTS.includes(host)||!session)return null;
  const normalized=normalizeActivePolicies(state),project=projectKey(cwd);
  const repository=Object.values(normalized.selections).some(row=>row.host===host&&row.scope==='repository')?repositoryKey(cwd):null;
  return normalized.selections[`${host}:task:${session}`]
    ??(project?normalized.selections[`${host}:project:${project}`]:null)
    ??(repository?normalized.selections[`${host}:repository:${repository}`]:null)
    ??normalized.selections[`${host}:host:all`]??null;
}

/** Emits fixed context only; emission is neither host acknowledgement nor measured savings. */
export function activePolicyHookContext(state, {host,session_id,cwd,event,source}={},at=Date.now()) {
  if(!HOSTS.includes(host)||!['SessionStart','UserPromptSubmit'].includes(event)||!integer(at))return null;
  const session=hashOpaqueHostIdentifier(session_id,host);
  if(!session)return null;
  const normalized=normalizeActivePolicies(state),deliveryKey=`${host}:${session}`,prior=normalized.deliveries[deliveryKey];
  const selected=activeTaskPolicy(normalized,{host,session_id,cwd});
  const mode=selected?.mode??'observe',key=selected?recordKey(selected):'none',revision=selected?.revision??0;
  const reload=event==='SessionStart'&&['resume','clear','compact'].includes(source);
  if(mode==='observe'&&prior?.mode!=='balanced')return null;
  if(!reload&&prior?.selection_key===key&&prior.revision===revision&&prior.mode===mode&&prior.policy_version===ACTIVE_POLICY_VERSION)return null;
  // Reinsert into insertion order so retention keeps the most recent sessions.
  delete normalized.deliveries[deliveryKey];
  normalized.deliveries[deliveryKey]={selection_key:key,revision,mode,policy_version:ACTIVE_POLICY_VERSION,emitted_at:at,emission_count:Math.min((prior?.emission_count??0)+1,1_000_000)};
  Object.assign(state,normalizeActivePolicies(normalized));
  return {hookEventName:event,additionalContext:mode==='balanced'?POLICY_CONTEXT:DISABLED_CONTEXT};
}

export function isFixedPolicyContext(output) {
  return output && ['SessionStart','UserPromptSubmit'].includes(output.hookEventName)
    && [POLICY_CONTEXT,DISABLED_CONTEXT,DEVELOPMENT_CONTEXT,
      POLICY_CONTEXT+'\n'+DEVELOPMENT_CONTEXT,DISABLED_CONTEXT+'\n'+DEVELOPMENT_CONTEXT].includes(output.additionalContext);
}
