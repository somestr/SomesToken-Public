import {performance} from 'node:perf_hooks';
const PHASES=["prior_pass_1","prior_pass_2","prior_pass_3","prior_pass_4","snapshot_build","snapshot_write","codex_scan","claude_legacy_migration","claude_registry","claude_stale_recovery","claude_catalog_walk","claude_dead_prune","claude_reuse","claude_capture","claude_publish","claude_refresh_other","claude_feed_read","claude_confirmation"];
const COUNTS=["claude_registrations","claude_stale_registrations","claude_catalog_walks","claude_catalog_files","claude_dead_registrations_pruned","claude_sources_reused","claude_sources_captured","claude_feed_files_read"];
export function startPhase(){return {wall:performance.now(),cpu:process.cpuUsage()};}
export function finishPhase(timings,name,started,exclude=[]){
  if(!timings)return;
  const wall=performance.now()-started.wall,cpu=process.cpuUsage(started.cpu);
  timings[name+'_ms']=(timings[name+'_ms']??0)+Math.max(0,wall-exclude.reduce((sum,key)=>sum+(timings[key+'_ms']??0),0));
  timings[name+'_cpu_micros']=(timings[name+'_cpu_micros']??0)+Math.max(0,cpu.user+cpu.system-exclude.reduce((sum,key)=>sum+(timings[key+'_cpu_micros']??0),0));
}
export function measurePhase(timings,name,run){
  if(!timings)return run();
  const started=startPhase();try{return run();}finally{finishPhase(timings,name,started);}
}
// Sum repeated calls before rounding; per-source rounding would inflate the partition.
export function phaseFields(timings={}){
  const fields=[...PHASES.flatMap(name=>[name+'_ms',name+'_cpu_micros']),...COUNTS];
  return Object.fromEntries(fields.map(key=>[key,timings[key]==null?null:Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.round(timings[key])))]));
}
