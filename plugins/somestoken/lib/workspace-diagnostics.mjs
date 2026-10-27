import {workspaceFreshness,collectorFreshness} from './freshness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isHashedIdentity} from './core.mjs';
import {completedWorkSummary} from './optimization/completed-work.mjs';

const STATES=['starting','capturing','healthy','degraded','stopped','idle'];
const ERRORS=['workspace_scan_failed','workspace_worker_exited','workspace_source_unavailable','quota_source_unavailable','workspace_capture_failed','workspace_store_bound'];
const STOP_REASONS=['completed','sigterm','sigint','health_write_failed','capture_failed','sources_unchanged','scheduled_complete','capture_deferred'];
const timestamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const choice=(value,values,fallback=null)=>values.includes(value)?value:fallback;
const version=value=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value)?value:null;

export function installedPackageVersion(root,host) {
  if(typeof root!=='string'||!path.isAbsolute(root)||!['codex','claude'].includes(host))return null;
  let fd;
  try {
    fd=fs.openSync(path.join(root,host==='codex'?'.codex-plugin':'.claude-plugin','plugin.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>16384)return null;
    const buffer=Buffer.allocUnsafe(stat.size+1);let used=0,count;
    while(used<buffer.length&&(count=fs.readSync(fd,buffer,used,buffer.length-used,null)))used+=count;
    if(used>stat.size)throw Error('version-bound');
    return version(JSON.parse(buffer.subarray(0,used).toString('utf8')).version);
  }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}

/** Labels do not prove byte identity or loaded code. Build suffixes identify
 * packaging, not API drift. Only the host can reload an existing MCP process. */
export function runtimeCompatibility({reporter,installed,collector,hook}={}) {
  const versions={reporter_version:version(reporter),installed_version:version(installed),
    collector_version:version(collector),hook_version:version(hook)};
  const base=value=>value?.split('+')[0],target=versions.installed_version,reason_codes=[];
  for(const [key,value] of Object.entries(versions)) {
    if(!value)reason_codes.push(key.replace('_version','')+'_version_unobserved');
    else if(target&&base(value)!==base(target))reason_codes.push((key==='reporter_version'?'loaded_reporter':key.replace('_version',''))+'_version_mismatch');
  }
  const mismatch=reason_codes.some(code=>code.endsWith('_mismatch'));
  return {...versions,status:mismatch?'reload_required':reason_codes.length?'observation_incomplete':'versions_match',
    activation_verified:false,installed_artifact_identity:'unverified',reload_owner:'host',automatic_reload_supported:false,
    next_action:mismatch?'refresh_plugin_with_host_supported_controls':reason_codes.length?'await_version_observations':'none',reason_codes};
}

function collectorOverhead(value) {
  const fields=['scan_ms','codex_scan_ms','claude_scan_ms','quota_ms','update_ms','write_ms','cpu_user_micros','cpu_system_micros','rss_bytes','peak_rss_bytes','snapshot_bytes','quota_bytes_written'];
  const result=Object.fromEntries(fields.map(key=>[key,count(value?.[key])]));
  const limit=64*1024*1024,bytes=result.snapshot_bytes;
  return {...result,measurement_basis:'local_process_resources',storage_limit_bytes:limit,
    storage_headroom_bytes:bytes===null?null:Math.max(0,limit-bytes),
    storage_status:bytes===null?'unavailable':bytes>=limit?'at_limit':bytes>=limit*0.9?'near_limit':'within_limit',
    token_savings:null,quota_savings:null};
}

/** Read-only, identity-free diagnostics. Collector state is shared service
 * evidence; task coverage is filtered to the explicitly requested host. */
export function workspaceDiagnostics({workspace,monitor,enabled=false,host='codex',now=Date.now()}={}) {
  host=choice(host,['codex','claude','all'],'codex');
  if(!enabled){workspace=null;monitor=null;}
  const valid=object(workspace)&&workspace.schema_version===1&&Array.isArray(workspace.tasks);
  const snapshotAt=valid?timestamp(workspace.observed_at):null;
  const freshness=workspaceFreshness(snapshotAt,now);
  const tasks=valid?workspace.tasks.filter(t=>object(t)&&isHashedIdentity(t.task_key)
    &&['codex','claude'].includes(t.host??'codex')&&(host==='all'||(t.host??'codex')===host)):[];
  const gapsValid=valid&&(!Object.hasOwn(workspace,'coverage_gaps')||Array.isArray(workspace.coverage_gaps)
    &&workspace.coverage_gaps.every(g=>typeof g==='string'&&g.length<=128&&/^[a-z0-9_:-]+$/.test(g)));
  const hostCoverageValid=valid&&(!Object.hasOwn(workspace,'host_coverage_status')||object(workspace.host_coverage_status)
    &&Object.entries(workspace.host_coverage_status).every(([h,s])=>['codex','claude'].includes(h)&&['exact','partial','unavailable','disabled'].includes(s)));
  const overallExact=gapsValid&&workspace.status==='exact'&&!(workspace.coverage_gaps?.length);
  const hostCoverage=valid&&object(workspace.host_coverage_status)?workspace.host_coverage_status:{};
  const inventoryExact=gapsValid&&hostCoverageValid&&(host==='all'?overallExact&&['codex','claude'].every(h=>
    hostCoverage[h]===undefined||['exact','disabled'].includes(hostCoverage[h])):
    Object.hasOwn(hostCoverage,host)?hostCoverage[host]==='exact':overallExact);
  const coverage=!tasks.length?'unavailable':inventoryExact&&tasks.every(t=>t.coverage_status==='exact')?'exact':'partial';
  const health=object(monitor)?monitor:{};
  const attempt=timestamp(health.last_attempt_at),success=timestamp(health.last_success_at);
  const capture=timestamp(health.last_snapshot_at);
  const checked=health.mode==='scheduled'?timestamp(health.last_checked_at):null;
  const heartbeat=collectorFreshness(health,now);
  const finished=health.last_finished_capture,finishedAt=timestamp(finished?.finished_at),startedAt=timestamp(finished?.started_at);
  const collector={
    scope:'workspace_service',status:choice(health.status,STATES,'unavailable'),
    last_attempt_at:attempt,last_attempt_age_ms:workspaceFreshness(attempt,now).age_ms,
    last_success_at:success,last_success_age_ms:workspaceFreshness(success,now).age_ms,
    last_checked_at:checked,
    heartbeat_freshness:heartbeat.status,
    interval_seconds:Number.isSafeInteger(health.interval_seconds)&&health.interval_seconds>=15&&health.interval_seconds<=3600?health.interval_seconds:null,
    consecutive_failures:count(health.consecutive_failures),
    last_error_code:choice(health.last_error_code,ERRORS),
    quota_status:health.quota_status==='quota_source_unavailable'?'unavailable':choice(health.quota_status,['available','disabled','unknown'],'unavailable'),
    version:version(health.collector_version),stop_reason:choice(health.stop_reason,STOP_REASONS),
    overhead:collectorOverhead(health.overhead),
    last_finished_capture:startedAt&&finishedAt>=startedAt&&finishedAt<=now?{
      scope:'finished_capture',started_at:startedAt,finished_at:finishedAt,collector_version:version(finished.collector_version),
      status:choice(finished.status,STATES,'unavailable'),overhead:collectorOverhead(finished.overhead)}:null,
    storage_maintenance:{reclaimed_bytes:count(health.storage_maintenance?.reclaimed_bytes),
      removed_temporary_files:count(health.storage_maintenance?.removed_temporary_files),
      errors:(Array.isArray(health.storage_maintenance?.errors)?health.storage_maintenance.errors:[])
        .filter(code=>['unsafe_service_log','service_log_maintenance_failed','storage_maintenance_failed'].includes(code)).slice(0,3)},
  };
  let status='collecting',reason='fresh_workspace_snapshot',action='view_tasks';
  if(!enabled){status='not_configured';reason='workspace_not_configured';action='configure_workspace_if_needed';}
  else if(freshness.status==='clock_anomaly'||heartbeat.status==='clock_anomaly'){
    status='attention';reason='clock_anomaly';action='check_system_clock';
  }else if(!valid){
    const starting=!heartbeat.stale&&['starting','capturing'].includes(collector.status);
    status=starting?'waiting_for_data':'unavailable';reason=starting?'capture_in_progress':'workspace_snapshot_unavailable';
    action=starting?'await_capture':collector.status==='unavailable'||collector.status==='stopped'?'start_collector':'check_collector';
  }else if(collector.status==='stopped'){
    status='attention';reason='collector_stopped';action='start_collector';
  }else if(collector.status==='idle'&&checked!==null&&!heartbeat.stale){
    status='idle';reason=collector.stop_reason==='scheduled_complete'?'scheduled_capture_complete':collector.stop_reason==='capture_deferred'?'capture_deferred':'sources_unchanged';
    action=reason==='capture_deferred'?'await_capture':'await_source_activity';
  }else if(heartbeat.stale||collector.status==='unavailable'){
    status='attention';reason=freshness.stale?'workspace_snapshot_not_fresh':'collector_health_not_fresh';action='check_collector';
  }else if(collector.status==='degraded'){
    status='attention';reason=collector.last_error_code??'collector_degraded';
    action=reason==='quota_source_unavailable'?'check_quota_connection':'check_collector';
  }else if(freshness.stale){
    const waiting=capture===snapshotAt&&collector.interval_seconds>120;
    status=waiting?'waiting_for_data':'attention';reason=waiting?'awaiting_next_capture':'workspace_snapshot_not_fresh';action=waiting?'await_capture':'check_collector';
  }else if(!inventoryExact){
    status='attention';reason='partial_source_coverage';action='review_coverage';
  }else if(!tasks.length){
    status='waiting_for_data';reason='no_host_tasks_observed';action='complete_normal_turn';
  }else if(coverage!=='exact'){
    status='attention';reason='partial_source_coverage';action='review_coverage';
  }
  const observations=valid?workspace.completed_work:null;
  const matched=Boolean(observations&&snapshotAt!==null&&timestamp(observations.observed_at)===snapshotAt);
  const completed={...completedWorkSummary(matched?observations:null,{host}),
    source_snapshot_matched:observations?matched:null,snapshot_freshness:freshness.status};
  if(observations&&!matched)completed.reason_codes.push('derived_snapshot_mismatch');
  return {
    schema_version:1,enabled:Boolean(enabled),host,status,
    snapshot_at:snapshotAt,snapshot_age_ms:freshness.age_ms,snapshot_freshness:freshness.status,
    task_count:valid?tasks.length:null,coverage_status:coverage,collector,
    completed_work:completed,
    process_liveness:'not_checked',reason_codes:[reason],next_action:action,
  };
}
