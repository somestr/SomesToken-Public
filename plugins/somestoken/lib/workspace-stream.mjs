// Scheduled capture without holding the response history in memory. The prior
// snapshot is streamed to summarize each Codex source for reuse, the scan
// parses only changed sources, and the next snapshot is built one task at a
// time. `{ok:false}` means "use the in-memory path"; `fatal` means the capture
// itself failed and must not be retried in memory.
import {measurePhase} from './capture-timings.mjs';
import {streamWorkspaceRecords,expandRecord,readWorkspaceFile,writeWorkspaceFile} from './workspace-store.mjs';
import {readUnifiedWorkspaceLedger} from './workspace-worker.mjs';
import {sourceDigestAccumulator} from './codex-ledger.mjs';
import {writeWorkspaceStreaming,priorWorkspaceFacts,claudeSourceSummaries,withQuotaSidecar,retainedParseSummaries} from './workspace-usage.mjs';

export function captureWorkspaceStreaming(directory,{codexRoot,claudeRoot,projectRoot,now,timeZone,quotas=[],profiles={},quotaAvailability,responseLimits}={}) {
  try {
    const timings={},sources=new Map(),facts=priorWorkspaceFacts(timeZone),claudeSources=claudeSourceSummaries();
    // Prior task summaries are reduced to the fields the update reads as they
    // are decoded; the prior completed-work view is not read at all.
    const prior=measurePhase(timings,'prior_pass_1',()=>streamWorkspaceRecords(directory,raw=>{
      const row=expandRecord(raw);facts.add(row);claudeSources.add(row);if(row.host!=='codex')return;
      let summary=sources.get(row.source_key);if(!summary)sources.set(row.source_key,summary=sourceDigestAccumulator());summary.add(row);
    },{skipKeys:new Set(['completed_work']),mapItem:(key,t)=>key==='tasks'?{task_key:t?.task_key,host:t?.host,coverage_gaps:t?.coverage_gaps,forecast_revisions:t?.forecast_revisions}:t}));
    // A first capture or an older, uncompacted snapshot takes the in-memory path.
    if(!prior)return {ok:false,reason:'prior_unavailable'};
    if(prior.count&&!prior.compact)return {ok:false,reason:'prior_not_compact'};
    // Quota samples that quota-only runs added since that snapshot, as the in-memory path reads them.
    const previous=withQuotaSidecar(directory,prior.meta);
    const priorSources=new Map([...sources].map(([key,summary])=>[key,summary.summary()]));sources.clear();
    // Sources the response bound trimmed are compared by the rows the last capture kept.
    const trimmedSources=retainedParseSummaries(previous.codex_source_index,priorSources);
    const scanStarted=performance.now();
    const resume={previous:readWorkspaceFile(directory,'codex-resume.json'),next:null,headers:readWorkspaceFile(directory,'codex-headers.json'),nextHeaders:null};
    const scan=readUnifiedWorkspaceLedger(codexRoot,claudeRoot,{projectRoot,cache:false,previous,priorSources,priorClaudeSources:claudeSources.summary(),resume});
    const scanMs=Math.round(performance.now()-scanStarted);
    // Checkpoints are verified against each file before use; a missing one costs a full parse.
    if(resume.next)try{writeWorkspaceFile(directory,'codex-resume.json',resume.next);}catch{/* the next capture parses in full */}
    // Header facts apply only to an identical file stamp; a missing file costs header reads.
    if(resume.nextHeaders)try{writeWorkspaceFile(directory,'codex-headers.json',resume.nextHeaders);}catch{/* the next capture reads headers */}
    if(scan?.status==='unavailable')return {ok:false,fatal:true,reason:'workspace_source_unavailable',scan};
    const updateStarted=performance.now();let priorReads=1;
    const result=writeWorkspaceStreaming(directory,{previous,priorFacts:facts.facts,scan,trimmedSources,now:now??Date.now(),timeZone,quotas,profiles,quotaAvailability,responseLimits,timings,
      priorPass:onRow=>{priorReads++;const again=streamWorkspaceRecords(directory,onRow,{recordsOnly:true,rawRecords:true});return again&&again.count===prior.count&&again.compact===prior.compact?again:null;}});
    const confirmed=Array.isArray(scan.claude_confirmations)?scan.claude_confirmations:[];
    return {...result,scan,prior_reads:priorReads,claude_confirmed_sources:confirmed.length,claude_confirmed_rows:confirmed.reduce((sum,c)=>sum+c.record_count,0),
      timings:{...timings,scan_ms:scanMs,update_ms:Math.round(performance.now()-updateStarted)}};
  } catch (error) {
    return {ok:false,reason:typeof error?.message==='string'?error.message.slice(0,80):'streaming_failed'};
  }
}
