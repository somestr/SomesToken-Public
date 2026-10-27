#!/usr/bin/env node
import {phaseFields} from '../lib/capture-timings.mjs';
import {registerTaskForecastProfile,setProjectForecastProfile,forecastTaskKey,DECLARED_WORK_KEYS} from '../lib/task-profiles.mjs';
import {Worker} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {completedWorkObservations} from '../lib/optimization/completed-work.mjs';
import {acquireMonitorLock} from '../lib/monitor-lock.mjs';
import {configuredClaudeWorkspaceRoot,configuredClaudeProjectRoot} from '../lib/claude-workspace.mjs';
import {configuredCodexLedgerRoot,canReuseCodexWorkspace} from '../lib/codex-ledger.mjs';
import {workspaceDirectory,readWorkspaceFile,readWorkspaceSnapshot,writeWorkspaceFile,updateWorkspace,publicWorkspace,refreshWorkspaceQuotas,responseLimitsFor,withResponseBudget} from '../lib/workspace-usage.mjs';
import {createCodexAppServerTransport} from '../lib/limit-recovery/transport.mjs';
import {monitorInputs} from '../lib/monitor-inputs.mjs';
import {maintainWorkspaceStorage} from '../lib/workspace-store.mjs';

// macOS gets its name from the managed executable. Setting process.title there
// loads ApplicationServices/LaunchServices into this otherwise headless reader.
if(process.platform!=='darwin')process.title='SomesToken';
const args=process.argv.slice(2),directory=workspaceDirectory();
const value=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const root=configuredCodexLedgerRoot(process.env);
const interval=Number(value('interval')??30),timeZone=value('timezone')??Intl.DateTimeFormat().resolvedOptions().timeZone;
if(args.includes('--help')) {console.log('SomesToken monitor --once | --watch | --scheduled [--interval=30] [--timezone=Europe/Dublin] [--no-quota]\nInterval is in seconds (15..3600). Profile options record metadata only; they do not run models or change host settings.\nTask identity: --task-id=<host-session-id> can replace --task=<key>.\nProject work defaults: --project=<absolute-path> --host=<host> and the five work controls (no model/effort/tier); applied on the next natural start.\n--scheduled: check for changed sources, collect if needed and exit; suitable for an OS scheduler.\nTask profile: --task=<key> --host=codex|claude --model=<id> --effort=<effort> --workload=inspect|fix|refactor|migration|test --service-tier=default|standard|fast|priority|flex|batch|ultrafast --context-band=small|medium|large --scope-band=narrow|medium|broad --verification-band=light|standard|extensive --planned-subagent-policy=none|bounded|parallel');process.exit(0);}
if(!directory || (!root && !configuredClaudeWorkspaceRoot(process.env)))throw new Error('Enable a Codex ledger or Claude workspace feed first. Next: use --help for supported options.');
if(args.some(a=>!/^--(?:once|watch|scheduled|no-quota|interval=\d+|timezone=.+|task=[a-f0-9]{20}|task-id=[A-Za-z0-9][A-Za-z0-9._:-]{0,159}|project=.+|host=(?:codex|claude)|model=[A-Za-z0-9._+-]{1,80}|effort=[a-z]{1,80}|workload=(?:inspect|fix|refactor|migration|test)|service-tier=(?:default|standard|fast|priority|flex|batch|ultrafast)|context-band=(?:small|medium|large)|scope-band=(?:narrow|medium|broad)|verification-band=(?:light|standard|extensive)|planned-subagent-policy=(?:none|bounded|parallel))$/.test(a)))throw new Error('Invalid monitor arguments · Next: use --help for supported options.');
const optionNames=args.map(arg=>arg.slice(2).split('=',1)[0]);
if(new Set(optionNames).size!==optionNames.length||['once','watch','scheduled'].filter(name=>optionNames.includes(name)).length>1)throw new Error('Invalid monitor arguments · Next: use --help for supported options.');
const profileOptions=new Set(['task','task-id','project','host','model','effort','workload','service-tier','context-band','scope-band','verification-band','planned-subagent-policy']);
const collectorOptions=new Set(['once','watch','scheduled','no-quota','interval','timezone']);
const registering=['task','task-id','project'].filter(name=>value(name));
if(registering.length>1)throw new Error('Invalid monitor arguments · Next: use --help for supported options.');
if(registering.length?optionNames.some(name=>collectorOptions.has(name)):optionNames.some(name=>profileOptions.has(name)))throw new Error('Invalid monitor arguments · Next: use --help for supported options.');
if(!Number.isSafeInteger(interval)||interval<15||interval>3600)throw new Error('Invalid monitor bounds · Next: use --help for supported options.');
if(registering.length) {
  const features=Object.fromEntries(['host','model','effort','workload','service_tier','context_band','scope_band','verification_band','planned_subagent_policy']
    .map(key=>[key,value(key.replaceAll('_','-'))]));
  if(value('project')) {
    if(['model','effort','service_tier'].some(key=>features[key])||!features.host||DECLARED_WORK_KEYS.some(key=>!features[key]))throw new Error('Project profile requires explicit work controls and host · Next: use --help for supported options.');
    setProjectForecastProfile(directory,{...features,cwd:value('project')});
  } else {
    if(Object.values(features).some(v=>!v))throw new Error('Task profile requires all forecast controls · Next: use --help for supported options.');
    registerTaskForecastProfile(directory,value('task')??forecastTaskKey(features.host,value('task-id')),features);
  }
  console.log('SomesToken task profile saved.');process.exit(0);
}

if(!args.includes('--once')&&!args.includes('--watch')&&!args.includes('--scheduled'))throw new Error('Choose --once, --watch or --scheduled · Next: use --help for supported options.');
let releaseLock;
try{releaseLock=acquireMonitorLock(directory);}
catch(error){console.error(error.message==='monitor_already_running'?'SomesToken monitor · already running · Next: use the existing collector.':'SomesToken monitor · lock unavailable · Next: check collector diagnostics.');process.exit(2);}
const codexManifest=new URL('../.codex-plugin/plugin.json',import.meta.url);
const collectorVersion=JSON.parse(fs.readFileSync(fs.existsSync(codexManifest)?codexManifest:new URL('../.claude-plugin/plugin.json',import.meta.url),'utf8')).version;
const previousHealth=readWorkspaceFile(directory,'monitor.json');
const storageMaintenance=maintainWorkspaceStorage(directory);
const scheduled=args.includes('--scheduled');
const probe=()=>monitorInputs({codexRoot:root,claudeRoot:configuredClaudeWorkspaceRoot(process.env),projectRoot:configuredClaudeProjectRoot(process.env),directory});
const inputBefore=scheduled?probe():null;
const captureConfiguration=JSON.stringify([collectorVersion,timeZone,!args.includes('--no-quota'),interval]);
const unchanged=scheduled&&inputBefore?.snapshot&&[null,'quota_source_unavailable'].includes(previousHealth?.last_error_code)
  &&previousHealth?.capture_configuration===captureConfiguration
  &&JSON.stringify(previousHealth?.source_signature)===JSON.stringify(inputBefore);
const checked=previousHealth?.quota_checked_at;
const quotaDue=!args.includes('--no-quota')&&(!Number.isSafeInteger(checked)||checked<=0||checked>Date.now()||Date.now()-checked>=60000);
// A usage capture that costs more than a tenth of the interval spaces the next
// one to ten times its duration. The wait, one scheduler interval and the next
// capture stay under 110 s, so the snapshot never leaves its 120 s freshness
// window. Quota still refreshes; the changed sources stay pending (their
// signature is not advanced) until the deferred capture runs.
const usageCapture=previousHealth?.last_usage_capture,duration=usageCapture?.duration_ms;
const spacing=Number.isSafeInteger(duration)&&duration>0?Math.min(duration*10,110000-interval*1000-duration):0;
const deferred=scheduled&&!unchanged&&Boolean(inputBefore?.snapshot)&&spacing/1000>interval
  &&[null,'quota_source_unavailable'].includes(previousHealth?.last_error_code)&&previousHealth?.capture_configuration===captureConfiguration
  &&Number.isSafeInteger(usageCapture.started_at)&&usageCapture.started_at<=Date.now()&&Date.now()-usageCapture.started_at<spacing;
const quotaOnly=(unchanged||deferred)&&quotaDue;
if((unchanged||deferred)&&!quotaDue){
  try{
    writeWorkspaceFile(directory,'monitor.json',{...previousHealth,storage_maintenance:storageMaintenance,pid:process.pid,mode:'scheduled',status:previousHealth.last_error_code?'degraded':'idle',stop_reason:deferred?'capture_deferred':'sources_unchanged',last_checked_at:Date.now()});
  }finally{releaseLock();}
  process.exit(previousHealth.last_error_code?1:0);
}
let health={pid:process.pid,mode:scheduled?'scheduled':args.includes('--once')?'once':'background',started_at:Date.now(),interval_seconds:interval,
  storage_maintenance:storageMaintenance,
  status:'starting',last_attempt_at:null,last_success_at:Number.isSafeInteger(previousHealth?.last_success_at)&&previousHealth.last_success_at>0?previousHealth.last_success_at:null,
  last_snapshot_at:previousHealth?.last_snapshot_at??null,coverage_status:'unavailable',consecutive_failures:0,last_error_code:null,capture_duration_ms:null,collector_version:collectorVersion,
  last_finished_capture:previousHealth?.last_finished_capture??null,
  last_usage_capture:previousHealth?.last_usage_capture??null,
  host_status:previousHealth?.host_status??null,quota_checked_at:previousHealth?.quota_checked_at??null,
  source_reuse_available:previousHealth?.source_reuse_available??false,non_record_bytes:previousHealth?.non_record_bytes??null,forecast_training:previousHealth?.forecast_training??null,
  quota_status:args.includes('--no-quota')?'disabled':'unknown',quota_error_cause:null,stop_reason:null};
const quotaErrorCauses=new Map([['request_timeout','timeout'],['transport_error','spawn'],['protocol_error','protocol'],
  ['transport_eof','eof'],['transport_write_failed','write'],['transport_closed','closed']]);
let transport=null,timer=null,worker=null,stopping=false,inFlight=null,stopPromise=null;
function saveHealth(){writeWorkspaceFile(directory,'monitor.json',health);}
async function scanWorkspace(){
  // A scheduled capture has no resident parser or structured-clone copy of
  // the complete scan. The OS reclaims the entire process when it finishes.
  if(scheduled){
    const {readUnifiedWorkspaceLedger}=await import('../lib/workspace-worker.mjs');
    // A health hint skips the second full JSON traversal. The ledger still
    // validates parser revision, ancestry, source signatures and row digests.
    let reusable=previousHealth?.collector_version===collectorVersion&&previousHealth?.source_reuse_available===true;
    if(!reusable){let preview=readWorkspaceFile(directory,'workspace.json',{includeRecords:false});reusable=canReuseCodexWorkspace(preview);preview=null;}
    // Bootstrap captures have no reusable rows. Delay their full prior-state
    // load until parsing finishes, keeping both histories out of the parser peak.
    if(reusable)state??=readWorkspaceSnapshot(directory);
    return readUnifiedWorkspaceLedger(root,configuredClaudeWorkspaceRoot(process.env),{projectRoot:configuredClaudeProjectRoot(process.env),cache:false,previous:state});
  }
  if(!worker){
    worker=new Worker(new URL('../lib/workspace-worker.mjs',import.meta.url));
    const active=worker;
    // Keep an error listener even between requests; the next capture recreates
    // a worker that exited while idle instead of waiting on a dead thread.
    active.on('error',()=>{if(worker===active)worker=null;});
    active.on('exit',()=>{if(worker===active)worker=null;});
  }
  return new Promise((resolve,reject)=>{
    const active=worker;
    const cleanup=()=>{active.off('message',message);active.off('error',error);active.off('exit',exited);};
    const message=result=>{cleanup();result.error?reject(new Error('workspace_scan_failed')):resolve(result.scan);};
    const error=()=>{cleanup();reject(new Error('workspace_worker_exited'));};
    const exited=()=>error();
    active.once('message',message);active.once('error',error);active.once('exit',exited);
    try{active.postMessage(root);}catch{error();}
  });
}
let state=scheduled?null:readWorkspaceSnapshot(directory);
async function performCapture() {
  const started=Date.now();
  const cpuStarted=process.cpuUsage();
  const overhead={...phaseFields(),measurement_basis:'local_process_resources',scan_ms:null,codex_scan_ms:null,claude_scan_ms:null,quota_ms:null,update_ms:null,write_ms:null,quota_bytes_written:0,
    cpu_user_micros:null,cpu_system_micros:null,rss_bytes:null,snapshot_bytes:null,token_savings:null,quota_savings:null};
  health.last_attempt_at=started;health.status='capturing';saveHealth();
  try {
    let phase=performance.now();
    let quotas=[],quotaFailure=null,quotaWriteFailure=null;
    health.quota_error_cause=null;
    if(!args.includes('--no-quota')) {
      health.quota_checked_at=Date.now();
      try {
        transport??=createCodexAppServerTransport({args:['app-server'],timeoutMs:10000});
        const inventory=await transport.readQuotaInventory();
        for(const group of inventory.snapshots)for(const name of ['primary','secondary']) {
          const w=group[name];if(!w)continue;
        quotas.push({...w,provider:'codex',precision_percent:null,account_id:inventory.account_key,plan_id:inventory.plan_id,
            identity_basis:inventory.identity_basis,limit_id:group.limit_id,quota_group:group.limit_id,window_id:name,
            snapshot_at_ms:group.snapshot_at*1000,resets_at_ms:w.resets_at*1000,
            quality:group.quality,scope:'account'});
        }
      }catch(error) {
        quotaFailure='quota_source_unavailable';
        health.quota_error_cause=quotaErrorCauses.get(error?.code)??'unknown';
        try{await transport?.close();}catch{/* Preserve the classified source error. */}
        transport=null;
      }
    }
    overhead.quota_ms=Math.round(performance.now()-phase);
    if(stopping)return;
    // The short-lived quota helper exits before history is loaded, so its
    // memory does not overlap the collector's large-data phase.
    if(scheduled){try{await transport?.close();}catch{/* Transport owns cleanup. */}transport=null;}
    health.quota_status=quotaFailure??(args.includes('--no-quota')?'disabled':'available');
    // Persist valid quota before the workspace can fail, without opening it.
    if(!quotaFailure&&!args.includes('--no-quota')){
      const old=readWorkspaceFile(directory,'quota.json');
      const base=old?.schema_version===1&&old.base_observed_at===health.last_snapshot_at?old:
        {schema_version:1,base_observed_at:health.last_snapshot_at,includes_base:false};
      const next=refreshWorkspaceQuotas(base,quotas);
      phase=performance.now();
      try{overhead.quota_bytes_written=writeWorkspaceFile(directory,'quota.json',next).bytes_written;}
      catch(error){quotaWriteFailure=error;}
      finally{overhead.write_ms=Math.round(performance.now()-phase);}
    }
    phase=performance.now();
    // A scheduled capture builds the snapshot one task at a time; anything it
    // cannot reproduce exactly falls back to the in-memory path below.
    let streamed=null;
    // Rows may use only the room the other snapshot fields left last time.
    const responseLimits=responseLimitsFor(health.non_record_bytes);
    if(scheduled&&!quotaOnly){
      // Loaded only here, like the scheduled scan, so --once/--watch never load it.
      const {captureWorkspaceStreaming}=await import('../lib/workspace-stream.mjs');
      streamed=captureWorkspaceStreaming(directory,{codexRoot:root,claudeRoot:configuredClaudeWorkspaceRoot(process.env),projectRoot:configuredClaudeProjectRoot(process.env),
        timeZone,quotas,profiles:readWorkspaceFile(directory,'task-profiles.json')??{},quotaAvailability:quotaFailure??(args.includes('--no-quota')?'disabled':'available'),responseLimits});
      if(streamed.fatal)throw new Error(streamed.reason);
      overhead.streaming=streamed.ok?'used':`fallback:${streamed.reason}`;
      if(streamed.ok)Object.assign(overhead,{prior_reads:streamed.prior_reads,claude_confirmed_sources:streamed.claude_confirmed_sources,claude_confirmed_rows:streamed.claude_confirmed_rows});
      if(!streamed.ok)streamed=null;
    }
    const scan=quotaOnly?null:streamed?.scan??await scanWorkspace();
    Object.assign(overhead,phaseFields({...streamed?.timings,...scan?.scan_timings}));
    overhead.scan_ms=quotaOnly?0:streamed?streamed.timings.scan_ms:Math.round(performance.now()-phase);
    for(const key of ['codex_scan_ms','claude_scan_ms'])overhead[key]=scan?.scan_timings?.[key]??null;
    if(stopping)return;
    if(scan?.status==='unavailable')throw new Error('workspace_source_unavailable');
    phase=performance.now();
    if(quotaOnly){
      health.coverage_status=previousHealth?.coverage_status??'unavailable';
      overhead.snapshot_bytes=fs.statSync(path.join(directory,'workspace.json')).size;
    }else{
      let next;
      if(streamed){
        next=streamed.next;overhead.update_ms=streamed.timings.update_ms;phase=performance.now();
        overhead.snapshot_bytes=streamed.bytes_written;health.non_record_bytes=streamed.bytes_written-streamed.record_bytes;state=next;
      }else{
        state??=readWorkspaceSnapshot(directory);
        const now=Date.now(),profiles=readWorkspaceFile(directory,'task-profiles.json')??{};
        let updateMs=0,writeMs=0;
        const result=withResponseBudget(limits=>{
          phase=performance.now();
          const snapshot=updateWorkspace(state,scan,{now,timeZone,quotas,profiles,consumeScan:scheduled,responseLimits:limits});
          snapshot.completed_work=completedWorkObservations(snapshot);
          snapshot.quota_availability=health.quota_status;
          updateMs+=performance.now()-phase;phase=performance.now();
          try{return {next:snapshot,written:writeWorkspaceFile(directory,'workspace.json',snapshot)};}
          finally{writeMs+=performance.now()-phase;}
        },responseLimits);
        next=result.next;
        overhead.update_ms=Math.round(updateMs);
        overhead.write_ms=(overhead.write_ms??0)+Math.round(writeMs);
        const written=result.written;
        overhead.snapshot_bytes=written.bytes_written;health.non_record_bytes=written.bytes_written-written.record_bytes;state=next;
      }
      health.last_snapshot_at=next.observed_at;
      if(!quotaFailure&&!args.includes('--no-quota')){
        phase=performance.now();
        try{overhead.quota_bytes_written+=writeWorkspaceFile(directory,'quota.json',{
          schema_version:1,base_observed_at:next.observed_at,includes_base:true,
          quota_history:next.quota_history,quota_coverage_gaps:next.quota_coverage_gaps}).bytes_written;}
        catch(error){quotaWriteFailure=error;}
        finally{overhead.write_ms=(overhead.write_ms??0)+Math.round(performance.now()-phase);}
      }

      health.coverage_status=scan.status;
      health.host_status=scan.host_status??{codex:root?scan.status:'disabled',claude:configuredClaudeWorkspaceRoot(process.env)?scan.status:'disabled'};
      health.last_success_at=Date.now();
      health.last_usage_capture={started_at:started,duration_ms:health.last_success_at-started};
      health.source_reuse_available=canReuseCodexWorkspace(next);
      health.forecast_training={source_snapshot_at:next.observed_at,samples:next.samples.slice(-1000)};
    }
    if(quotaFailure)throw new Error(quotaFailure);
    if(quotaWriteFailure)throw quotaWriteFailure;
    health.consecutive_failures=0;health.last_error_code=null;health.status='healthy';
  }catch(error) {
    if(!stopping){
      health.consecutive_failures++;
      health.last_error_code=error.message==='store-bound'?'workspace_store_bound':['workspace_scan_failed','workspace_worker_exited','workspace_source_unavailable','quota_source_unavailable'].includes(error.message)
        ?error.message:'workspace_capture_failed';
      health.status='degraded';
    }
  }finally{
    const cpu=process.cpuUsage(cpuStarted);
    overhead.cpu_user_micros=cpu.user;overhead.cpu_system_micros=cpu.system;overhead.rss_bytes=process.memoryUsage().rss;
    overhead.peak_rss_bytes=process.resourceUsage().maxRSS*1024;
    health.overhead=overhead;health.capture_duration_ms=Date.now()-started;
    health.last_finished_capture={started_at:started,finished_at:Date.now(),collector_version:collectorVersion,status:health.status,overhead};
    saveHealth();
  }
}
function capture() {
  if(stopping)return Promise.resolve();
  if(!inFlight)inFlight=performCapture().finally(()=>{inFlight=null;});
  return inFlight;
}
function stop(reason='completed') {
  if(stopPromise)return stopPromise;
  stopping=true;clearInterval(timer);
  stopPromise=(async()=>{
    // Terminating the worker rejects its pending scan; performCapture already
    // owns that rejection, and is awaited before final health and lock release.
    try {
      await Promise.allSettled([worker?.terminate(),transport?.close()]);
      await inFlight;
      if(scheduled&&reason==='completed'){
        const after=probe();
        health.source_signature=deferred?previousHealth.source_signature??null:inputBefore&&after?.inputs===inputBefore.inputs?after:null;
        health.capture_configuration=captureConfiguration;
        health.last_checked_at=Date.now();
        health.status=health.consecutive_failures?'degraded':'idle';health.stop_reason=deferred?'capture_deferred':'scheduled_complete';
      }else{health.status='stopped';health.stop_reason=reason;}
      saveHealth();
    }finally{releaseLock();}
  })();
  return stopPromise;
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  stop(signal.toLowerCase()).then(()=>process.exit(0),()=>process.exit(1));
});
try {
  saveHealth();
  if(args.includes('--once')||scheduled) {
    await capture();
    if(!stopping){if(!scheduled)console.log(JSON.stringify(publicWorkspace(state)));if(health.consecutive_failures)process.exitCode=1;}
    await stop();
  }else {
    console.log('SomesToken background usage collection started.');
    await capture();
    if(!stopping)timer=setInterval(()=>{capture().catch(()=>{stop('health_write_failed').catch(()=>{});});},interval*1000);
  }
}catch {
  console.error('SomesToken monitor · capture failed · Next: check collector diagnostics.');process.exitCode=1;
  await stop('capture_failed');
}
