import {startPhase,finishPhase,measurePhase} from './capture-timings.mjs';
import {parentPort} from 'node:worker_threads';
import {readCodexWorkspaceLedger} from './codex-ledger.mjs';
import {configuredClaudeWorkspaceRoot,configuredClaudeProjectRoot,readClaudeWorkspaceFeed,refreshRegisteredClaudeSources} from './claude-workspace.mjs';
import {readClaudeStatus} from './hosts/claude-statusline.mjs';
import {claudeSourceSummaries} from './workspace-usage.mjs';

// A refreshed Claude source whose rows equal the stored ones (all but the refresh
// time and origin) is passed on as one confirmation instead of its rows. Needs
// the stored per-source summaries; without them every row is passed on.
function confirmClaudeSources(claude,reused,priorClaudeSources) {
  const confirmations=[],candidates=new Map((reused??[]).map(source=>[source.source_key,source]));
  if(!priorClaudeSources?.size||!candidates.size)return confirmations;
  const rows=new Map(),summaries=claudeSourceSummaries();
  for(const r of claude.records){if(!candidates.has(r.source_key))continue;const list=rows.get(r.source_key)??[];list.push(r);rows.set(r.source_key,list);summaries.add(r);}
  const current=summaries.summary();
  for(const [key,list] of rows){
    const source=candidates.get(key),prior=priorClaudeSources.get(key),now=current.get(key);
    // Only rows the refresh restamped as one capture: a feed file read instead keeps its own times.
    if(!prior||!now||prior.count!==now.count||prior.digest!==now.digest)continue;
    if(!list.every(r=>r.captured_at===source.captured_at&&r.capture_origin===source.capture_origin))continue;
    confirmations.push({source_key:key,captured_at:source.captured_at,capture_origin:source.capture_origin,record_count:list.length});
  }
  const confirmed=new Set(confirmations.map(c=>c.source_key));
  if(confirmed.size)claude.records=claude.records.filter(r=>!confirmed.has(r.source_key));
  return confirmations;
}

export function readUnifiedWorkspaceLedger(codexRoot,claudeRoot=configuredClaudeWorkspaceRoot(process.env),{projectRoot=null,cache=true,previous=null,priorSources=null,priorClaudeSources=null,resume=null}={}) {
  const timings={},started=performance.now(),codexStarted=startPhase();
  const codex = codexRoot ? readCodexWorkspaceLedger(codexRoot,{cache,previous,priorSources,resume}) : null;
  if(codexRoot)finishPhase(timings,'codex_scan',codexStarted);
  const codexFinished=performance.now();
  const refreshed=claudeRoot?refreshRegisteredClaudeSources(claudeRoot,{projectRoot,reuse:true,timings}):null;
  const claude = claudeRoot ? measurePhase(timings,'claude_feed_read',()=>readClaudeWorkspaceFeed(claudeRoot,{revalidatedSources:refreshed?.reused_sources,timings})) : null;
  const claude_confirmations=claude?measurePhase(timings,'claude_confirmation',()=>confirmClaudeSources(claude,refreshed?.reused_sources,priorClaudeSources)):[];
  const scan_timings={...timings,codex_scan_ms:codexRoot?Math.round(codexFinished-started):null,
    claude_scan_ms:claudeRoot?Math.round(performance.now()-codexFinished):null};
  if(claude&&refreshed?.coverage_gaps?.length){
    claude.status='partial';
    claude.coverage_gaps=[...new Set([...claude.coverage_gaps,...refreshed.coverage_gaps])];
    claude.global_coverage_gaps=[...new Set([...claude.global_coverage_gaps,...refreshed.coverage_gaps])];
  }
  const scans = [codex,claude].filter(Boolean);
  const host_observations=claudeRoot?readClaudeStatus(claudeRoot):[];
  const host_coverage = {codex:codex?.global_coverage_gaps ?? [],claude:claude?.global_coverage_gaps ?? []};
  const host_inventory_complete = {codex:codex?.record_inventory_complete === true,claude:false};
  const host_status = {codex:codex?.status ?? 'disabled',claude:claude?.status ?? 'disabled'};
  const allUnavailable = (!scans.length || scans.every(scan=>scan.status==='unavailable'))&&!host_observations.some(o=>!o.stale);
  return {
    ...(codex ?? {}),
    status:allUnavailable ? 'unavailable':scans.some(scan=>scan.status!=='exact') ? 'partial':'exact',
    records:scans.flatMap(scan=>scan.records ?? []),tasks:[...scans.flatMap(scan=>scan.tasks ?? []),
      ...host_observations.filter(o=>!scans.some(s=>(s.tasks??[]).some(t=>t.task_key===o.task_key))).map(o=>({task_key:o.task_key,host:'claude',coverage_gaps:[]}))],host_observations,
    sources:scans.flatMap(scan=>scan.sources ?? []),host_coverage,host_inventory_complete,host_status,scan_timings,
    observed_at:Date.now(),coverage_gaps:[...new Set(scans.flatMap(scan=>scan.coverage_gaps ?? []))],
    // Codex inventory is authoritative only for Codex records. Claude observes
    // natural hooks and cannot prove inventory completeness between those hooks.
    record_inventory_complete:codex?.record_inventory_complete === true,
    global_coverage_gaps:[...new Set(scans.flatMap(scan=>scan.global_coverage_gaps ?? []))],
    scanned_files:scans.reduce((sum,scan)=>sum+(scan.scanned_files ?? 0),0),
    capture_scope:codex && claude ? 'configured_codex_and_authorized_claude_hooks':codex?.capture_scope ?? claude?.capture_scope ?? 'unavailable',
    current_response_unflushed:'unavailable',
    claude_confirmations,
  };
}

parentPort?.on('message',root=>{
  try{parentPort.postMessage({scan:readUnifiedWorkspaceLedger(root,configuredClaudeWorkspaceRoot(process.env),{projectRoot:configuredClaudeProjectRoot(process.env)})});}
  catch{parentPort.postMessage({error:'workspace_scan_failed'});}
});
