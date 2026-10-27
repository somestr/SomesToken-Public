import { unlinkOwnedFile } from './host-paths.mjs';
import {startPhase,finishPhase,measurePhase} from './capture-timings.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {workspaceFreshness,collectorMaxAge} from './freshness.mjs';
export {workspaceFreshness} from './freshness.mjs';
import { sumUsage, USAGE_KEYS, isValidUsage, safeModel, isSensitiveRuntimeValue, isHashedIdentity } from './core.mjs';
export {readWorkspaceFile,writeWorkspaceFile} from './workspace-store.mjs';
import {readWorkspaceFile,workspaceSnapshotSignature,reusableWorkspaceRecord,compactRecord,expandRecord,canonicalRecord,STORE_BOUND,RECORD_DEFAULTS_VERSION,workspaceStoreBound} from './workspace-store.mjs';
import {completedWorkBuilder} from './optimization/completed-work.mjs';
import {sourceDigestAccumulator,localGapCodes} from './codex-ledger.mjs';
import { FORECAST_FEATURE_KEYS, normalizeForecastFeatures, forecastTaskUsage, forecastQuotaWindows, compactQuotaHistory, evaluateForecasts } from './usage/forecast.mjs';
import { quoteModelUsage } from './usage/model-costs.mjs';
import {estimateAutoReviewCredits,AUTO_REVIEW_ESTIMATE_LABEL} from './usage/credits.mjs';
import {publicClaudeStatus} from './hosts/claude-statusline.mjs';
import {recentActivity,learnQuotaRates,taskQuotaRates,taskQuotaForecast,RATE_PRICE_REVISION,ACTIVITY_WINDOW_MS,pricingProfileCostShares} from './usage/task-rates.mjs';


const LABEL=/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const validLabel=value=>typeof value==='string'&&LABEL.test(value)&&Boolean(safeModel(value.replaceAll('+','.')));
const DAY=86400000;
export function workspaceDirectory(env=process.env) {
  const root=env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME,'.codex') : null);
  return root && path.isAbsolute(root) ? path.join(root,'somestoken') : null;
}
function validRecord(r) {
  return r && ['record_key','task_key','source_key','turn_key'].every(k=>isHashedIdentity(r[k]??''))
    && ['main','subagent'].includes(r.role) && validLabel(r.model??'') && validLabel(r.effort??'')
    && Number.isSafeInteger(r.observed_at) && r.observed_at>0
    && isValidUsage(r.usage,{reasoningObserved:r.host!=='claude'});
}
function cleanRecord(r) {
  return {host:r.host==='claude'?'claude':'codex',validation_status:r.validation_status==='historical_unverified'?'historical_unverified':'observed',reasoning_usage_status:r.host==='claude'?'unmeasured':'observed',record_key:r.record_key,task_key:r.task_key,source_key:r.source_key,turn_key:r.turn_key,root_key:isHashedIdentity(r.root_key??'')?r.root_key:r.record_basis==='legacy_counter_event'?null:r.turn_key,
    parent_source:isHashedIdentity(r.parent_source??'')?r.parent_source:null,role:r.role,model:r.model,effort:r.effort,
    service_tier:validLabel(r.service_tier??'')?r.service_tier:'unknown',
    requested_service_tier:validLabel(r.requested_service_tier??'')?r.requested_service_tier:'unknown',
    observed_at:r.observed_at,capture_origin:['hook','registered_refresh'].includes(r.capture_origin)?r.capture_origin:null,captured_at:Number.isSafeInteger(r.captured_at)?r.captured_at:null,collector_version:validLabel(r.collector_version??'')?r.collector_version:null,completed:r.completed===true,
    completed_at:Number.isSafeInteger(r.completed_at)?r.completed_at:null,
    duration_ms:Number.isSafeInteger(r.duration_ms)&&r.duration_ms>=0?r.duration_ms:null,
    record_basis:r.record_basis==='legacy_counter_event'?'legacy_counter_event':'structured_response',
    quality:r.quality==='exact'&&r.record_basis!=='legacy_counter_event'?'exact':'partial',usage:Object.fromEntries([...USAGE_KEYS,'consistent'].map(k=>[k,r.usage[k]]))};
}
function bucket(records) {
  if(!records.length)return {response_count:0,usage:null,new_input_tokens:null,calculated_dollar_equivalent:null,cost_quality:'unavailable',unpriced_responses:0,cost_basis:'api_token_dollar_equivalent_not_billed_or_quota'};
  const usage=sumUsage(records.map(r=>r.usage));
  let priced=0,cost=0,exact=true,legacy=0,claude=false,review;
  for(const r of records){
    if(r.record_basis==='legacy_counter_event')legacy++;
    if(r.host!=='claude'&&r.model==='codex-auto-review')(review??=[]).push(r.usage);
    if(r.host==='claude'){claude=true;exact=false;continue;}
    const quote=quoteModelUsage({...r.usage,quality:r.quality},{model:r.model,service_tier:r.service_tier,at:r.observed_at,single_request:true});
    if(Number.isFinite(quote.calculated_dollar_equivalent)){priced++;cost+=quote.calculated_dollar_equivalent;}
    if(quote.calculation_quality!=='exact')exact=false;
  }
  return {response_count:records.length,legacy_observation_count:legacy,usage,reasoning_usage_status:claude?'unmeasured':'observed',
    new_input_tokens:Math.max(0,usage.input_tokens-usage.cached_input_tokens),
    calculated_dollar_equivalent:priced?cost:null,
    cost_quality:priced===records.length&&exact?'exact':priced?'partial':'unavailable',
    unpriced_responses:records.length-priced,cost_basis:'api_token_dollar_equivalent_not_billed_or_quota',
    ...(review?{estimated_auto_review_credits:estimateAutoReviewCredits(sumUsage(review))}:{})};
}
function grouped(records,keys,valueFor=(r,key)=>r[key]) {
  const groups=new Map();for(const r of records){const key=JSON.stringify(keys.map(k=>valueFor(r,k)));const g=groups.get(key)??[];g.push(r);groups.set(key,g);}
  return [...groups.values()].map(g=>({...Object.fromEntries(keys.map(k=>[k,valueFor(g[0],k)])),...bucket(g)}));
}
function staleRateCapture(rows,host,now,stale=false) {
  if(stale||host!=='claude')return stale;
  const sources=new Map();
  for(const r of rows)if(isHashedIdentity(r.source_key??''))sources.set(r.source_key,
    Number.isSafeInteger(r.captured_at)?Math.max(sources.get(r.source_key)??0,r.captured_at):sources.get(r.source_key)??0);
  return !sources.size||[...sources.values()].some(captured=>!captured||captured>now||now-captured>120000);
}
function withRecentRates(rows,keys,options,calibration,host) {
  const recent=new Map(),all=new Map(),identity=r=>JSON.stringify(keys.map(k=>r[k]));
  for(const r of rows){
    const key=identity(r),group=all.get(key)??[];group.push(r);all.set(key,group);
    if(r.observed_at<=options.now-ACTIVITY_WINDOW_MS)continue;
    const active=recent.get(key)??[];active.push(r);recent.set(key,active);
  }
  return [...all.values()].map(group=>{
    const g={...Object.fromEntries(keys.map(key=>[key,group[0][key]])),...bucket(group)};
    const key=identity(g),groupOptions={...options,stale:staleRateCapture(group,host,options.now,options.stale)};
    const recent_activity=recentActivity(recent.get(key)??[],groupOptions);
    return {...g,recent_activity,quota_rate_estimates:taskQuotaRates(recent_activity,calibration,{host})};
  });
}
const TRANSITION_WINDOW=50;
const TRANSITION_LIMIT=200;
const TRANSITION_AGGREGATE_BLOCK=256;
const CHANGE_METRICS=['total_tokens','new_input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','cache_write_input_tokens'];
function emptyObservationStats() {
  return {response_count:0,completed_response_count:0,partial_response_count:0,unmeasured_reasoning_count:0,unknown_cache_write_count:0,
    first_observed_at:null,last_observed_at:null,usage:Object.fromEntries(USAGE_KEYS.map(key=>[key,0n]))};
}
function observationStats(row) {
  const stats=emptyObservationStats();stats.response_count=1;stats.completed_response_count=row.completed?1:0;
  stats.partial_response_count=row.quality==='exact'&&row.validation_status!=='historical_unverified'?0:1;
  stats.unmeasured_reasoning_count=row.reasoning_usage_status==='unmeasured'?1:0;
  stats.unknown_cache_write_count=Number.isSafeInteger(row.usage.cache_write_input_tokens)?0:1;
  stats.first_observed_at=row.observed_at;stats.last_observed_at=row.observed_at;
  for(const key of USAGE_KEYS)stats.usage[key]=BigInt(row.usage[key]??0);
  return stats;
}
function mergeObservationStats(target,source,multiplier=1) {
  target.response_count+=source.response_count*multiplier;target.completed_response_count+=source.completed_response_count*multiplier;
  target.partial_response_count+=source.partial_response_count*multiplier;target.unmeasured_reasoning_count+=source.unmeasured_reasoning_count*multiplier;
  target.unknown_cache_write_count+=source.unknown_cache_write_count*multiplier;
  for(const key of USAGE_KEYS)target.usage[key]+=source.usage[key]*BigInt(multiplier);
  if(multiplier>0&&source.response_count){target.first_observed_at=target.first_observed_at===null?source.first_observed_at:Math.min(target.first_observed_at,source.first_observed_at);target.last_observed_at=target.last_observed_at===null?source.last_observed_at:Math.max(target.last_observed_at,source.last_observed_at);}
  return target;
}
function summaryFromStats(stats,{firstObservedAt=stats.first_observed_at,lastObservedAt=stats.last_observed_at}={}) {
  if(!stats.response_count)return {response_count:0,completed_response_count:0,unfinished_response_count:0,first_observed_at:null,last_observed_at:null,coverage_status:'unavailable',is_final:false,usage:null,new_input_tokens:null};
  const usage={};let safe=true;
  for(const key of USAGE_KEYS){safe=safe&&stats.usage[key]>=0n&&stats.usage[key]<=BigInt(Number.MAX_SAFE_INTEGER);usage[key]=stats.usage[key]>BigInt(Number.MAX_SAFE_INTEGER)?Number.MAX_SAFE_INTEGER:Number(stats.usage[key]);}
  if(stats.unknown_cache_write_count)usage.cache_write_input_tokens=null;
  usage.consistent=safe&&stats.usage.total_tokens===stats.usage.input_tokens+stats.usage.output_tokens;
  const exact=usage.consistent===true&&!stats.partial_response_count;
  return {response_count:stats.response_count,completed_response_count:stats.completed_response_count,unfinished_response_count:stats.response_count-stats.completed_response_count,
    first_observed_at:firstObservedAt,last_observed_at:lastObservedAt,coverage_status:exact?'exact':'partial',
    reasoning_usage_status:stats.unmeasured_reasoning_count?'unmeasured':'observed',is_final:exact&&stats.completed_response_count===stats.response_count,usage,
    new_input_tokens:usage.input_tokens-usage.cached_input_tokens};
}
function observationRangeIndex(rows,metrics) {
  const blocks=[];
  for(let start=0;start<rows.length;start+=TRANSITION_AGGREGATE_BLOCK){const stats=emptyObservationStats();for(let index=start;index<Math.min(rows.length,start+TRANSITION_AGGREGATE_BLOCK);index++)mergeObservationStats(stats,observationStats(rows[index]));blocks.push(stats);}
  const lowerBound=(timestamp,after=false)=>{let low=0,high=rows.length;while(low<high){const middle=(low+high)>>1;if(rows[middle].observed_at<timestamp||after&&rows[middle].observed_at===timestamp)low=middle+1;else high=middle;}return low;};
  const queryIndexes=(start,end)=>{
    const result=emptyObservationStats();let index=start;
    while(index<end&&index%TRANSITION_AGGREGATE_BLOCK){mergeObservationStats(result,observationStats(rows[index++]));metrics.descendant_range_rows_examined++;}
    while(index+TRANSITION_AGGREGATE_BLOCK<=end){mergeObservationStats(result,blocks[index/TRANSITION_AGGREGATE_BLOCK]);metrics.descendant_aggregate_blocks_read++;index+=TRANSITION_AGGREGATE_BLOCK;}
    while(index<end){mergeObservationStats(result,observationStats(rows[index++]));metrics.descendant_range_rows_examined++;}
    return result;
  };
  return {rows,lowerBound,query:(start,end)=>queryIndexes(lowerBound(start),lowerBound(end,true)),count:(start,end)=>Math.max(0,lowerBound(end,true)-lowerBound(start))};
}
function metricTotal(summary,metric) {
  if(!summary?.response_count)return null;
  if(summary.usage?.consistent!==true)return null;
  if(metric==='new_input_tokens')return summary.new_input_tokens;
  if(metric==='reasoning_output_tokens'&&summary.reasoning_usage_status==='unmeasured')return null;
  return summary.usage?.[metric]??null;
}
function percentageChanges(before,after,beforeDenominator,afterDenominator) {
  return Object.fromEntries(CHANGE_METRICS.map(metric=>{
    const beforeTotal=metricTotal(before,metric),afterTotal=metricTotal(after,metric);
    const baseline=beforeTotal==null||!beforeDenominator?null:beforeTotal/beforeDenominator;
    const observed=afterTotal==null||!afterDenominator?null:afterTotal/afterDenominator;
    return [metric,baseline>0&&Number.isFinite(observed)?(observed-baseline)/baseline*100:null];
  }));
}
function transitionHistory(records,segments) {
  const parents=new Map(),ambiguous=new Set();
  for(const row of records)if(row.role==='subagent'){
    if(!isHashedIdentity(row.parent_source??'')){ambiguous.add(row.source_key);continue;}
    if(parents.has(row.source_key)&&parents.get(row.source_key)!==row.parent_source)ambiguous.add(row.source_key);
    else parents.set(row.source_key,row.parent_source);
  }
  const ancestryRoots=new Map();
  const ancestryRoot=source=>{
    if(ancestryRoots.has(source))return ancestryRoots.get(source);
    const path=[],seen=new Set();let current=source,root=null;
    while(isHashedIdentity(current??'')){
      if(ancestryRoots.has(current)){root=ancestryRoots.get(current);break;}
      if(seen.has(current)||ambiguous.has(current)){root=null;break;}
      seen.add(current);path.push(current);
      if(!parents.has(current)){root=current;break;}current=parents.get(current);
    }
    for(const member of path)ancestryRoots.set(member,root);return root;
  };
  const bySource=new Map();for(const segment of segments){const source=segment.rows[0].source_key,list=bySource.get(source)??[];list.push(segment);bySource.set(source,list);}
  const candidates=[];
  for(const sourceSegments of bySource.values())if(sourceSegments[0]?.rows[0].role==='main')for(let index=1;index<sourceSegments.length;index++)candidates.push({
    previous:sourceSegments[index-1],next:sourceSegments[index],boundary_at:sourceSegments[index].rows[0].observed_at,source_key:sourceSegments[index].rows[0].source_key});
  candidates.sort((a,b)=>a.boundary_at-b.boundary_at||a.source_key.localeCompare(b.source_key));
  const selected=candidates.slice(-TRANSITION_LIMIT);
  const descendantIndex=records.filter(row=>row.role==='subagent').sort((a,b)=>a.observed_at-b.observed_at||a.record_key.localeCompare(b.record_key));
  const scanMetrics={descendant_range_rows_examined:0,descendant_aggregate_blocks_read:0};
  const descendants=observationRangeIndex(descendantIndex,scanMetrics),selectedRoots=new Set(selected.map(candidate=>candidate.source_key));
  const rootRows=new Map();
  for(const row of descendantIndex){const root=ancestryRoot(row.source_key);if(!selectedRoots.has(root))continue;const rows=rootRows.get(root)??[];rows.push(row);rootRows.set(root,rows);}
  const rootIndexes=new Map([...rootRows].map(([root,rows])=>[root,observationRangeIndex(rows,scanMetrics)]));
  const comparisons=[],overlaps=[],mainEvidenceOwners=new Map();
  const statsForRows=rows=>{const stats=emptyObservationStats();for(const row of rows)mergeObservationStats(stats,observationStats(row));return stats;};
  const rangeCount=(index,start,end)=>start>end?0:index.count(start,end);
  for(const {previous,next} of selected){
      const sampleSize=Math.min(TRANSITION_WINDOW,previous.rows.length,next.rows.length);
      const beforeRows=previous.rows.slice(-sampleSize),afterRows=next.rows.slice(0,sampleSize);
      if(!beforeRows.length||!afterRows.length)continue;
      const spanStart=beforeRows[0].observed_at,beforeEnd=beforeRows.at(-1).observed_at,afterStart=afterRows[0].observed_at,spanEnd=afterRows.at(-1).observed_at;
      const rootIndex=rootIndexes.get(beforeRows[0].source_key),hasOrderedBoundary=beforeEnd<afterStart;
      const spanStats=descendants.query(spanStart,spanEnd);
      const beforeChildStats=rootIndex&&hasOrderedBoundary?rootIndex.query(spanStart,beforeEnd):emptyObservationStats();
      const afterChildStats=rootIndex&&hasOrderedBoundary?rootIndex.query(afterStart,spanEnd):emptyObservationStats();
      const unassignableStats=mergeObservationStats(mergeObservationStats(mergeObservationStats(emptyObservationStats(),spanStats),beforeChildStats,-1),afterChildStats,-1);
      const unassignableCount=(start,end)=>rangeCount(descendants,start,end)-(rootIndex&&hasOrderedBoundary?(rangeCount(rootIndex,Math.max(start,spanStart),Math.min(end,beforeEnd))+rangeCount(rootIndex,Math.max(start,afterStart),Math.min(end,spanEnd))):0);
      let unassignableFirst=null,unassignableLast=null;
      if(unassignableStats.response_count){
        let low=descendants.lowerBound(spanStart),high=descendants.lowerBound(spanEnd,true)-1;
        while(low<high){const middle=(low+high)>>1;if(unassignableCount(spanStart,descendantIndex[middle].observed_at)>0)high=middle;else low=middle+1;}unassignableFirst=descendantIndex[low].observed_at;
        low=descendants.lowerBound(spanStart);high=descendants.lowerBound(spanEnd,true)-1;
        while(low<high){const middle=(low+high+1)>>1;if(unassignableCount(descendantIndex[middle].observed_at,spanEnd)>0)low=middle;else high=middle-1;}unassignableLast=descendantIndex[low].observed_at;
      }
      const beforeMainStats=statsForRows(beforeRows),afterMainStats=statsForRows(afterRows);
      const beforeMain=summaryFromStats(beforeMainStats),afterMain=summaryFromStats(afterMainStats),beforeChild=summaryFromStats(beforeChildStats),afterChild=summaryFromStats(afterChildStats);
      const beforeCombined=summaryFromStats(mergeObservationStats(mergeObservationStats(emptyObservationStats(),beforeMainStats),beforeChildStats));
      const afterCombined=summaryFromStats(mergeObservationStats(mergeObservationStats(emptyObservationStats(),afterMainStats),afterChildStats));
      const changedFields=Object.keys(next.profile).filter(field=>previous.profile[field]!==next.profile[field]);
      const reasonCodes=[];
      const unknownProfile=['model','effort'].some(field=>previous.profile[field]==='unknown'||next.profile[field]==='unknown');
      if(unknownProfile)reasonCodes.push('unknown_profile_field');
      if(previous.profile.service_tier==='unknown'||next.profile.service_tier==='unknown')reasonCodes.push('unknown_service_tier');
      if(previous.profile.requested_service_tier==='unknown'||next.profile.requested_service_tier==='unknown')reasonCodes.push('unknown_requested_service_tier');
      if(beforeEnd>=afterStart)reasonCodes.push('ambiguous_transition_timestamp');
      if(unassignableStats.response_count)reasonCodes.push('unassignable_descendant_observations');
      const observedSummaries=[beforeMain,afterMain,beforeChild,afterChild].filter(summary=>summary.response_count);
      if(observedSummaries.some(summary=>summary.coverage_status!=='exact'))reasonCodes.push('partial_usage_coverage');
      if(observedSummaries.some(summary=>!summary.is_final))reasonCodes.push('unfinished_observed_responses');
      if([beforeCombined,afterCombined].some(summary=>summary.usage?.consistent!==true))reasonCodes.push('aggregate_usage_unavailable');
      if([beforeCombined,afterCombined].some(summary=>summary.reasoning_usage_status==='unmeasured'))reasonCodes.push('unmeasured_reasoning_usage');
      const exact=observedSummaries.every(summary=>summary.coverage_status==='exact'&&summary.is_final)&&!reasonCodes.length;
      const observedPercentChange=unknownProfile?null:{
        main_per_response:percentageChanges(beforeMain,afterMain,beforeMain.response_count,afterMain.response_count),
        descendant_per_response:percentageChanges(beforeChild,afterChild,beforeChild.response_count,afterChild.response_count),
        combined_per_main_response:percentageChanges(beforeCombined,afterCombined,beforeMain.response_count,afterMain.response_count),
      };
      const comparisonIndex=comparisons.length;overlaps.push(false);
      for(const row of [...beforeRows,...afterRows]){const owner=mainEvidenceOwners.get(row.record_key);if(owner!==undefined){overlaps[owner]=true;overlaps[comparisonIndex]=true;}else mainEvidenceOwners.set(row.record_key,comparisonIndex);}
      comparisons.push({source_key:beforeRows[0].source_key,observational_label:'observed_change_not_savings',aggregation:'individual_non_pooled_comparison',
        comparison_status:unknownProfile?'unavailable':exact?'exact':'partial',reason_codes:reasonCodes,changed_fields:changedFields,
        from:previous.profile,to:next.profile,window_limit:TRANSITION_WINDOW,
        boundary:{before_last_observed_at:beforeEnd,after_first_observed_at:afterStart,gap_ms:afterStart-beforeEnd},
        denominators:{main:'observed_main_responses',descendants:'observed_descendant_responses',combined:'selected_main_responses'},
        before:{started_at:spanStart,last_observed_at:beforeEnd,main:beforeMain,descendants:beforeChild,combined_usage:beforeCombined.usage},
        after:{started_at:afterStart,last_observed_at:spanEnd,main:afterMain,descendants:afterChild,combined_usage:afterCombined.usage},
        unassignable_descendants:summaryFromStats(unassignableStats,{firstObservedAt:unassignableFirst,lastObservedAt:unassignableLast}),comparison_span_descendant_response_count:spanStats.response_count,
        observed_percent_change:observedPercentChange,_descendant_span:[spanStart,spanEnd]});
  }
  let overlapRangeChecks=0;
  if(descendantIndex.length)for(let left=0;left<comparisons.length;left++)for(let right=left+1;right<comparisons.length;right++){
    const start=Math.max(comparisons[left]._descendant_span[0],comparisons[right]._descendant_span[0]),end=Math.min(comparisons[left]._descendant_span[1],comparisons[right]._descendant_span[1]);
    if(start>end)continue;overlapRangeChecks++;if(descendants.count(start,end)){overlaps[left]=true;overlaps[right]=true;}
  }
  mainEvidenceOwners.clear();
  for(let index=0;index<comparisons.length;index++){const comparison=comparisons[index];comparison.overlap_status=overlaps[index]?'overlapping_returned_comparison_evidence_non_independent':'no_overlap_within_returned_comparisons';comparison.overlap_scope='returned_transition_tail';delete comparison._descendant_span;}
  return {profile_transitions:comparisons,omitted_profile_transitions:Math.max(0,candidates.length-comparisons.length),
    profile_transition_basis:'retained_observed_response_metadata_by_actual_observation_window',
    transition_scan_metrics:{candidate_transition_count:candidates.length,materialized_transition_count:comparisons.length,descendant_index_size:descendantIndex.length,
      ...scanMetrics,overlap_range_checks:overlapRangeChecks,retained_evidence_key_count:0}};
}
// Segments describe consumed response metadata, not unobserved UI settings.
function profileHistory(records,{includeTransitions=false}={}) {
  const fields=['model','effort','service_tier','requested_service_tier'];
  const active=new Map(),segments=[];
  for(const row of [...records].sort((a,b)=>a.observed_at-b.observed_at||a.record_key.localeCompare(b.record_key))) {
    const previous=active.get(row.source_key);
    const changed=previous?fields.filter(key=>previous.profile[key]!==row[key]):[];
    if(previous&&!changed.length){previous.rows.push(row);continue;}
    const segment={profile:Object.fromEntries(fields.map(key=>[key,row[key]])),rows:[row],changed_fields:changed};
    active.set(row.source_key,segment);segments.push(segment);
  }
  const bySource=new Map();for(const segment of segments){const source=segment.rows[0].source_key,list=bySource.get(source)??[];list.push(segment);bySource.set(source,list);}
  const transitionCount=[...bySource.values()].filter(sourceSegments=>sourceSegments[0]?.rows[0].role==='main').reduce((total,sourceSegments)=>total+Math.max(0,sourceSegments.length-1),0);
  const result={profile_history:segments.slice(-2000).map(segment=>({
    source_key:segment.rows[0].source_key,parent_source:segment.rows[0].parent_source,role:segment.rows[0].role,
    ...segment.profile,started_at:segment.rows[0].observed_at,last_observed_at:segment.rows.at(-1).observed_at,
    changed_fields:segment.changed_fields,coverage_status:segment.rows.every(r=>r.quality==='exact'&&r.validation_status!=='historical_unverified')?'exact':'partial',
    completed_response_count:segment.rows.filter(row=>row.completed).length,unfinished_response_count:segment.rows.filter(row=>!row.completed).length,
    is_final:segment.rows.every(row=>row.completed&&row.quality==='exact'&&row.validation_status!=='historical_unverified'),
    ...bucket(segment.rows),
  })),omitted_profile_segments:Math.max(0,segments.length-2000),profile_history_basis:'retained_observed_response_metadata',
    profile_transition_count:transitionCount,omitted_profile_transitions:Math.max(0,transitionCount-TRANSITION_LIMIT)};
  return includeTransitions?{...result,...transitionHistory(records,segments)}:result;
}
const dateFormatters=new Map();
function day(timestamp,timeZone) {
  if(!dateFormatters.has(timeZone)){
    if(dateFormatters.size>=16)dateFormatters.clear();
    dateFormatters.set(timeZone,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}));
  }
  return dateFormatters.get(timeZone).format(new Date(timestamp));
}
function taskProfileRevisions(profile) {
  if(!profile||typeof profile!=='object'||Array.isArray(profile))return [];
  const values=Array.isArray(profile.profile_revisions)?profile.profile_revisions.slice(-50):[];
  if(Number.isSafeInteger(profile.created_at))values.push(profile);
  const revisions=new Map();
  for(const value of values){
    const features=normalizeForecastFeatures(value);
    if(Number.isSafeInteger(value.created_at)&&value.created_at>=0)revisions.set(value.created_at,features?{...features,created_at:value.created_at}:{created_at:value.created_at,invalid:true});
  }
  return [...revisions.values()].sort((a,b)=>a.created_at-b.created_at);
}
function requestGroupStart(group) {
  const mains=group.filter(row=>row.role==='main');
  if(!mains.length)return null;
  const starts=mains.map(row=>Number.isSafeInteger(row.completed_at)&&Number.isSafeInteger(row.duration_ms)&&row.duration_ms>=0
    ?row.completed_at-row.duration_ms:null);
  return starts.every(start=>Number.isSafeInteger(start)&&start>=0)&&mains.every((row,index)=>starts[index]<=row.observed_at)
    ?Math.min(...starts):null;
}
function taskProfileForGroup(profile,group) {
  const startedAt=requestGroupStart(group);if(startedAt===null)return null;
  const revisions=taskProfileRevisions(profile);
  const latest=revisions.filter(revision=>revision.created_at<startedAt).at(-1);
  if(!latest||latest.invalid)return null;
  const endedAt=group.reduce((end,row)=>Math.max(end,row.completed_at??startedAt),startedAt);
  // Work expanded or became unknown during execution is not an unchanged cohort.
  if(revisions.some(revision=>revision.created_at>=startedAt&&revision.created_at<=endedAt
    &&(revision.invalid||FORECAST_FEATURE_KEYS.some(key=>revision[key]!==latest[key]))))return null;
  return latest;
}
function observedGroupControls(group) {
  const mains=group.filter(row=>row.role==='main');
  const single=key=>{const values=new Set(mains.map(row=>row[key]));return values.size===1?[...values][0]:null;};
  return {host:single('host'),model:single('model'),effort:single('effort'),service_tier:single('service_tier')};
}
function forecastControlsConsistent(profile,group,original) {
  const controls=normalizeForecastFeatures(original);
  if(!controls)return false;
  // The retained prediction preserves the original declaration even when a
  // later profile has replaced it. Newly discovered contradictory history wins.
  const planned=taskProfileForGroup({profile_revisions:[original,...taskProfileRevisions(profile)]},group);
  const observed=observedGroupControls(group);
  return Boolean(planned)&&FORECAST_FEATURE_KEYS.every(key=>planned[key]===controls[key])
    &&['host','model','effort','service_tier'].every(key=>observed[key]===controls[key]);
}
// Per-task pieces of a capture. Each works on one task's retained rows, in
// retained order, so a snapshot can also be built one task at a time.
function rootsFor(rows){const roots=new Map();for(const r of rows){const group=roots.get(r.root_key)??[];group.push(r);roots.set(r.root_key,group);}return roots;}
// Codex duration is the task_complete event's measured turn duration, not
// elapsed time since the collector first saw a token. Missing start evidence
// cannot establish that a prediction preceded the work.
const startedAfter=(row,predictionAt)=>Number.isSafeInteger(row.completed_at)&&Number.isSafeInteger(row.duration_ms)&&row.duration_ms>=0
  &&row.completed_at-row.duration_ms>predictionAt&&row.completed_at-row.duration_ms<=row.observed_at;
// Only source-attributed Codex warnings can be ignored for another task.
// Unknown inventory/ancestry gaps still veto the host. Identity conflicts can
// hide usage belonging elsewhere even when the report keeps them task-local.
function validForecastCoverage(task_key,rows,{scan,globalGaps,taskMetadata}) {
  const host=rows[0]?.host??taskMetadata.get(task_key)?.host??'codex';
  const hostGaps=scan.host_coverage?.[host]??globalGaps;
  return !hostGaps.some(gap=>host!=='codex'||!localGapCodes.has(gap)||['source_identity_mismatch','conflicting_thread_metadata'].includes(gap))
    &&!(taskMetadata.get(task_key)?.coverage_gaps??[]).length
    &&![...taskMetadata.values()].some(task=>(task.host??'codex')===host&&task.coverage_gaps?.includes('source_identity_mismatch'));
}
function completedTaskSample(task_key,rows,{scan,globalGaps,taskMetadata,profiles}) {
    if(!validForecastCoverage(task_key,rows,{scan,globalGaps,taskMetadata})||rows.some(r=>r.validation_status==='historical_unverified'))return null;
    const roots=new Map();for(const r of rows){const g=roots.get(r.root_key)??[];g.push(r);roots.set(r.root_key,g);}
    const completed=[...roots.values()].filter(g=>g.length&&g.every(r=>r.completed&&r.quality==='exact')&&g.some(r=>r.role==='main'))
      .sort((a,b)=>Math.max(...b.map(r=>r.completed_at??0))-Math.max(...a.map(r=>r.completed_at??0)));
    const group=completed[0];if(!group)return null;
    const mains=group.filter(r=>r.role==='main'),models=new Set(mains.map(r=>r.model)),efforts=new Set(mains.map(r=>r.effort));
    const durations=new Map(mains.filter(r=>r.duration_ms!==null).map(r=>[r.turn_key,r.duration_ms]));
    const profile=taskProfileForGroup(profiles[task_key],group),observed=observedGroupControls(group);
    if(models.size!==1||efforts.size!==1||!durations.size||!profile
      ||['host','model','effort','service_tier'].some(key=>observed[key]!==profile[key]))return null;
    const cost=bucket(group);
    if(cost.usage?.consistent!==true)return null;
    return {task_key,...Object.fromEntries(FORECAST_FEATURE_KEYS.map(key=>[key,profile[key]])),
      calculated_dollar_equivalent:cost.calculated_dollar_equivalent,cost_quality:cost.cost_quality,price_revision:RATE_PRICE_REVISION,
      pricing_profile_cost_shares:pricingProfileCostShares(group),
      pricing_profiles:[...new Set(group.map(r=>[r.model,r.effort,r.service_tier,r.usage.input_tokens>272000?'long':'short'].join(':')))].sort(),
      status:'completed',quality:'exact',independent:true,training_unit:'completed_request_group',accounting_scope:'full_parent_and_children',
      completed_at_ms:Math.max(...group.map(r=>r.completed_at??0)),total_tokens:sumUsage(group.map(r=>r.usage)).total_tokens,
      duration_ms:[...durations.values()].reduce((a,b)=>a+b,0)};
}
function priorPredictionSnapshots(previous) {
  return new Map((Array.isArray(previous?.prediction_snapshots)?previous.prediction_snapshots:[]).slice(-1000).filter(p=>isHashedIdentity(p?.task_key??'')).map(p=>[p.task_key,{...p}]));
}
function addPredictionSnapshots(predictionSnapshots,evaluatedTasks,profiles) {
  for(const [task_key,profile] of Object.entries(profiles)) {
    if(!isHashedIdentity(task_key)||predictionSnapshots.has(task_key)||evaluatedTasks.has(task_key))continue;
    const p=profile?.frozen_prediction??profile;
    if(p?.prediction?.status!=='predicted'||p.prediction.prediction_unit!=='request_group'||!Number.isSafeInteger(p.created_at)||!Number.isSafeInteger(p.baseline_tokens)||p.baseline_tokens<0)continue;
    predictionSnapshots.set(task_key,{task_key,...Object.fromEntries(FORECAST_FEATURE_KEYS.filter(key=>validLabel(p[key]??'')).map(key=>[key,p[key]])),
      created_at:p.created_at,prediction:structuredClone(p.prediction),baseline_tokens:p.baseline_tokens});
  }
}
function taskEvaluation(task_key,rows,p,{scan,globalGaps,taskMetadata,profiles}) {

    const roots=rootsFor(rows);
    if(!p.root_key){
      const prospective=[...roots.entries()].filter(([,group])=>group.some(r=>r.role==='main')&&group.every(r=>r.observed_at>p.created_at))
        .sort((a,b)=>Math.min(...a[1].map(r=>r.observed_at))-Math.min(...b[1].map(r=>r.observed_at)));
      for(const [root,group] of prospective){
        if(!group.every(r=>r.completed&&Number.isSafeInteger(r.completed_at)&&Number.isSafeInteger(r.duration_ms)&&r.duration_ms>=0))break;
        if(group.every(r=>startedAfter(r,p.created_at))){p.root_key=root;break;}
      }
    }
    const group=roots.get(p.root_key);
    if(!group?.length||!validForecastCoverage(task_key,rows,{scan,globalGaps,taskMetadata})||!group.every(r=>r.completed&&r.quality==='exact'&&r.validation_status!=='historical_unverified'&&r.observed_at>p.created_at&&startedAfter(r,p.created_at))
      ||!group.some(r=>r.role==='main'))return null;
    const groupUsage=sumUsage(group.map(r=>r.usage));
    if(groupUsage.consistent!==true)return null;
    const controlsConsistent=forecastControlsConsistent(profiles[task_key],group,p);
    return {task_key,root_key:p.root_key,prediction_unit:'request_group',prediction_at_ms:p.created_at,completed_at_ms:Math.max(...group.map(r=>r.completed_at??0)),p50_tokens:p.prediction.p50?.total_tokens,p80_tokens:p.prediction.p80?.total_tokens,actual_tokens:groupUsage.total_tokens,baseline_tokens:p.baseline_tokens,forecast_controls_consistent:controlsConsistent};
}
function eligibleEvaluation(p,rows,predictionSnapshots,{scan,globalGaps,taskMetadata,profiles}) {

  const group=rootsFor(rows).get(p.root_key);
  if(!(p.prediction_unit==='request_group'&&group?.length&&validForecastCoverage(p.task_key,rows,{scan,globalGaps,taskMetadata})
      &&group.every(r=>r.completed&&r.quality==='exact'&&r.validation_status!=='historical_unverified'&&startedAfter(r,p.prediction_at_ms))
      &&sumUsage(group.map(r=>r.usage)).consistent===true
      &&sumUsage(group.map(r=>r.usage)).total_tokens===p.actual_tokens
      &&Math.max(...group.map(r=>r.completed_at??0))===p.completed_at_ms))return null;
    return p.forecast_controls_consistent===true&&!forecastControlsConsistent(profiles[p.task_key],group,predictionSnapshots.get(p.task_key))
      ?{...p,forecast_controls_consistent:false}:p;
}
// Report-only shape of a task's retained rows. The thresholds mark patterns that
// multiply per-call context (a long thread, a long autonomous turn, review agents);
// they are heuristics, not savings, and a signal never changes collection.
const SHAPE_MIN_RESPONSES=50,SHAPE_CONTEXT_TOKENS=100_000,SHAPE_SPAN_HOURS=72,SHAPE_TURN_RESPONSES=150,SHAPE_REVIEW_SHARE=10;
function taskShape(rows){
  const inputs=rows.map(r=>r.usage?.input_tokens).filter(Number.isSafeInteger).sort((a,b)=>a-b);
  const perTurn=new Map();for(const r of rows)perTurn.set(r.turn_key,(perTurn.get(r.turn_key)??0)+1);
  const times=rows.map(r=>r.observed_at).filter(Number.isSafeInteger);
  const total=inputs.reduce((sum,v)=>sum+v,0),review=rows.filter(r=>r.model==='codex-auto-review').reduce((sum,r)=>sum+(r.usage?.input_tokens??0),0);
  // A compaction shows as a response that sends under 60% of the previous
  // response's input in the same source (thread); rows arrive in time order.
  const lastInput=new Map(),before=[],after=[];
  for(const r of rows){
    const input=r.usage?.input_tokens;if(!Number.isSafeInteger(input))continue;
    const previous=lastInput.get(r.source_key);
    if(previous!==undefined&&input<previous*0.6){before.push(previous);after.push(input);}
    lastInput.set(r.source_key,input);
  }
  const median=values=>values.length?values.sort((a,b)=>a-b)[Math.floor(values.length/2)]:null;
  const shape={basis:'retained_rows',response_count:rows.length,
    median_input_tokens_per_response:inputs.length?inputs[Math.floor(inputs.length/2)]:null,
    active_span_hours:times.length?Math.round((Math.max(...times)-Math.min(...times))/360000)/10:null,
    max_responses_per_turn:perTurn.size?Math.max(...perTurn.values()):null,
    review_input_share_percent:total>0?Math.round(review/total*1000)/10:null,
    compaction_count:before.length,median_input_before_compaction:median(before),median_input_after_compaction:median(after)};
  const enough=rows.length>=SHAPE_MIN_RESPONSES;
  shape.signals=[
    enough&&shape.median_input_tokens_per_response>=SHAPE_CONTEXT_TOKENS&&'context_bloat',
    enough&&shape.active_span_hours>=SHAPE_SPAN_HOURS&&'long_lived_thread',
    shape.max_responses_per_turn>=SHAPE_TURN_RESPONSES&&'long_autonomous_turn',
    enough&&shape.review_input_share_percent>=SHAPE_REVIEW_SHARE&&'review_overhead'].filter(Boolean);
  return shape;
}

function taskSummary(task_key,rows,{now,scan,globalGaps,taskMetadata,profiles,hostObservations,rateStartedAt,quotaRates,samples,previousTasks,retentionBound}) {
  const previous={tasks:previousTasks};
    const taskUsage=bucket(rows);
    const latest=rows.at(-1),main=rows.filter(r=>r.role==='main');
    const currentMain=main.at(-1);
    const profile=profiles[task_key]??{};
    const host=rows[0]?.host??taskMetadata.get(task_key)?.host??'codex';
    const taskGaps=[...new Set([...(scan.host_coverage?.[rows[0]?.host??taskMetadata.get(task_key)?.host??'codex']??globalGaps),...(taskMetadata.get(task_key)?.coverage_gaps??[]),...(taskUsage.usage?.consistent===false?['inconsistent_usage_total']:[]),...(rows.some(r=>r.validation_status==='historical_unverified')?['historical_source_not_revalidated']:[]),...(rows.some(r=>r.quality!=='exact')?['partial_usage_record']:[]),...(retentionBound?['response_retention_bound']:[])])];
    if(!rows.length)return {task_key,host,label:'Task '+task_key.slice(0,8),status:'unavailable',coverage_status:'unavailable',coverage_gaps:taskGaps,
      host_observation:hostObservations.find(o=>o.task_key===task_key)??null,response_count:0,usage:null,first_observed_at:null,last_observed_at:null,stale:true,quota_percent:null,quota_attribution:'account_shared_unavailable'};
    const features={host,model:currentMain?.model??(validLabel(profile.model??'')?profile.model:'unknown'),
      effort:currentMain?.effort??(validLabel(profile.effort??'')?profile.effort:'unknown'),
      workload:validLabel(profile.workload??'')?profile.workload:'unknown',
      service_tier:currentMain?.service_tier??(validLabel(profile.service_tier??'')?profile.service_tier:'unknown'),
      context_band:validLabel(profile.context_band??'')?profile.context_band:'unknown',scope_band:validLabel(profile.scope_band??'')?profile.scope_band:'unknown',
      verification_band:validLabel(profile.verification_band??'')?profile.verification_band:'unknown',
      planned_subagent_policy:validLabel(profile.planned_subagent_policy??'')?profile.planned_subagent_policy:'unknown'};
    const forecast={...forecastTaskUsage(samples.filter(s=>s.task_key!==task_key),features,{at:now}),
      profile_status:normalizeForecastFeatures(profile)?'registered':'incomplete',
      profile_created_at:Number.isSafeInteger(profile.created_at)?profile.created_at:null};
    const earlier=(Array.isArray(previous?.tasks)?previous.tasks:[]).find(t=>t.task_key===task_key);
    const revisions=[...(Array.isArray(earlier?.forecast_revisions)?earlier.forecast_revisions:[])];
    const currentRoot=currentMain?.root_key??null;
    const currentSources=rows.filter(r=>r.root_key===currentRoot).map(r=>[r.source_key,r.model,r.effort,r.service_tier].join(':'));
    const signature=JSON.stringify({features,root_key:currentRoot,sources:[...new Set(currentSources)].sort()});
    if(revisions.at(-1)?.signature!==signature)revisions.push({signature,observed_at:now,features,prediction:forecast,basis:'first_observed_or_profile_change'});
    const turns=new Set(rows.map(r=>r.turn_key));
    const hostRatesStale=scan.host_status?.[host]==='unavailable'||scan.host_status?.[host]==='disabled';
    const rateOptions={now,startedAt:rateStartedAt,coverage:rows.length>0&&!taskGaps.length,stale:hostRatesStale};
    const activity=recentActivity(rows,{...rateOptions,stale:staleRateCapture(rows,host,now,hostRatesStale)});
    const sourceKeys=['source_key','parent_source','role','model','effort','service_tier'];
    const sources=withRecentRates(rows,sourceKeys,rateOptions,quotaRates.reports,host);
    return {task_key,host:rows[0]?.host??taskMetadata.get(task_key)?.host??'codex',label:'Task '+task_key.slice(0,8),status:rows.length?(taskGaps.length?'partial':'observed'):'unavailable',coverage_status:rows.length?(taskGaps.length?'partial':'exact'):'unavailable',coverage_gaps:taskGaps,
      host_observation:hostObservations.find(o=>o.task_key===task_key)??null,task_shape:taskShape(rows),
      source_coverage:(taskMetadata.get(task_key)?.source_coverage??[]).filter(s=>isHashedIdentity(s?.source_key??'')).map(s=>({
        source_key:s.source_key,coverage_scope:'retained_source_history',
        coverage_gaps:(Array.isArray(s.coverage_gaps)?s.coverage_gaps:[]).filter(g=>/^[a-z_]{1,80}$/.test(g)),
        first_observed_at:Number.isSafeInteger(s.first_observed_at)&&s.first_observed_at>0?s.first_observed_at:null,
        last_observed_at:Number.isSafeInteger(s.last_observed_at)&&s.last_observed_at>0?s.last_observed_at:null})),
      revalidated_usage:rows.some(r=>r.validation_status!=='historical_unverified')?sumUsage(rows.filter(r=>r.validation_status!=='historical_unverified').map(r=>r.usage)):null,
      ...taskUsage,current_model:currentMain?.model??null,current_effort:currentMain?.effort??null,main_usage:main.length?sumUsage(main.map(r=>r.usage)):null,
      subagent_usage:rows.some(r=>r.role==='subagent')?sumUsage(rows.filter(r=>r.role==='subagent').map(r=>r.usage)):null,
      models:withRecentRates(rows,['role','model','effort','service_tier'],rateOptions,quotaRates.reports,host),...profileHistory(rows),sources,turn_count:turns.size,
      recent_activity:activity,quota_rate_estimates:taskQuotaRates(activity,quotaRates.reports,{host}),
      quota_forecast:taskQuotaForecast(forecast,quotaRates.reports,{host,now}),
      pending_turns:new Set(rows.filter(r=>!r.completed).map(r=>r.turn_key)).size,
      first_observed_at:rows[0]?.observed_at??null,last_observed_at:latest?.observed_at??null,
      stale:latest?now-latest.observed_at>5*60000||Boolean(latest.host==='claude'&&(!latest.captured_at||now-latest.captured_at>120000)):true,
      last_capture_at:latest?.host==='claude'?Math.max(...rows.map(r=>r.captured_at??0)):null,
      completed_usage:rows.some(r=>r.completed)?sumUsage(rows.filter(r=>r.completed).map(r=>r.usage)):null,
      unfinished_observed_usage:rows.some(r=>!r.completed)?sumUsage(rows.filter(r=>!r.completed).map(r=>r.usage)):null,
      forecast,forecast_revisions:revisions.slice(-50),quota_percent:null,quota_attribution:'account_shared_unavailable'};
}

// The daily group of a response, as the saved daily rows key it.
const recordDayKeyOf=(r,localDay)=>JSON.stringify([localDay(r.observed_at),r.task_key,r.host==='claude'?'claude':'codex',r.role,r.model,r.effort,validLabel(r.service_tier??'')?r.service_tier:'unknown']);
// Day boundaries fall on whole minutes in every zone, so one cached minute
// gives the per-timestamp answer without keeping a timestamp map.
function minuteDay(timeZone) {
  let cachedMinute=null,cachedDay=null;
  return timestamp=>{const minute=Math.floor(timestamp/60000);if(minute!==cachedMinute){cachedDay=day(timestamp,timeZone);cachedMinute=minute;}return cachedDay;};
}
// Prior day rows the fresh groups do not fully cover keep their saved totals,
// corrected by retired legacy rows and by rows this capture re-observed.
// `rowsForDays(keys)` returns the capture's rows for just those day groups.
const dayKey=d=>JSON.stringify([d.date,d.task_key,d.host??'codex',d.role,d.model,d.effort,d.service_tier]);
const priorDailyRows=(previous,timeZone,retainedDay)=>(Array.isArray(previous?.daily)&&previous.time_zone===timeZone?previous.daily:[]).filter(d=>d.date>=retainedDay);
function correctPriorDays(freshDays,{previous,timeZone,retainedDay,priorGroups,retiredGroups,priorByKey,scan,globalGaps,taskMetadata,unverifiedTasks,rowsForDays}) {
  const priorDays=new Map(priorDailyRows(previous,timeZone,retainedDay).map(d=>[dayKey(d),d]));
  const freshByDay=new Map(freshDays.map(d=>[dayKey(d),d]));
  const pending=[];
  for(const [key,old] of priorDays){
    const fresh=freshByDay.get(key),retired=retiredGroups.get(key)??[];
    if(!fresh&&retired.length>=old.response_count&&retired.length===priorGroups.get(key))continue;
    const fullyObserved=scan.record_inventory_complete===true&&(old.host??'codex')==='codex'&&!globalGaps.length&&!(taskMetadata.get(old.task_key)?.coverage_gaps??[]).length&&!unverifiedTasks.has(old.task_key);
    if(fresh&&((priorGroups.get(key)??0)>=old.response_count||fullyObserved))continue;
    pending.push([key,old]);
  }
  const newByDay=pending.length?rowsForDays(new Set(pending.map(([key])=>key))):new Map();
  for(const [key,old] of pending){
    const retired=retiredGroups.get(key)??[];
    const usage={...old.usage};let added=0;const seen=new Set();let last=old.last_observed_at??previous?.observed_at??0;
    const replacedTurns=new Set(retired.map(r=>r.source_key+':'+r.turn_key));
    for(const r of retired)for(const k of USAGE_KEYS)usage[k]=usage[k]==null||r.usage[k]==null?null:usage[k]-r.usage[k];
    for(const r of newByDay.get(key)??[]){
      if(seen.has(r.record_key))continue;seen.add(r.record_key);
      const prior=priorByKey.get(r.record_key);
      if(prior){for(const k of USAGE_KEYS)usage[k]=usage[k]==null||r.usage[k]==null||prior.usage[k]==null?null:usage[k]+r.usage[k]-prior.usage[k];}
      else if(r.observed_at>last||replacedTurns.has(r.source_key+':'+r.turn_key)){for(const k of USAGE_KEYS)usage[k]=usage[k]==null||r.usage[k]==null?null:usage[k]+r.usage[k];added++;}
    }
    const latest=Math.max(last,...(newByDay.get(key)??[]).map(r=>r.observed_at));
    usage.consistent=USAGE_KEYS.every(k=>k==='cache_write_input_tokens'&&usage[k]==null||Number.isSafeInteger(usage[k])&&usage[k]>=0)&&usage.total_tokens===usage.input_tokens+usage.output_tokens;
    freshByDay.set(key,{...old,usage:usage.consistent?usage:null,response_count:old.response_count-retired.length+added,legacy_observation_count:Math.max(0,(old.legacy_observation_count??0)-retired.length),last_observed_at:latest,new_input_tokens:usage.input_tokens-usage.cached_input_tokens,calculated_dollar_equivalent:null,cost_quality:'unavailable',coverage_status:'partial',coverage_gaps:['daily_detail_not_revalidated'],
      ...(old.host!=='claude'&&old.model==='codex-auto-review'?{estimated_auto_review_credits:estimateAutoReviewCredits(usage)}:{})});
  }
  return [...freshByDay.values()];
}

// A partial poll cannot prove that previously quarantined usage was repaired.
function quarantineInvalidTasks(previous,scan,invalidUsageTasks) {
  for(const task of Array.isArray(previous?.tasks)?previous.tasks:[]) {
    if(!isHashedIdentity(task?.task_key??'')||!Array.isArray(task.coverage_gaps)||!task.coverage_gaps.includes('invalid_usage_record'))continue;
    const host=task.host==='claude'?'claude':'codex';
    const inventoryComplete=host==='claude'?scan.host_inventory_complete?.claude===true:scan.record_inventory_complete===true;
    const exact=(scan.host_status?.[host]??scan.status)==='exact'
      &&!(scan.host_coverage?.[host]??scan.global_coverage_gaps??scan.coverage_gaps??[]).length;
    if(!inventoryComplete||!exact)invalidUsageTasks.set(task.task_key,host);
  }
}
function captureGlobals(previous,scan,invalidUsageTasks,gaps,{now,quotas}) {
  const taskMetadata=new Map((scan.tasks??[]).map(t=>[t.task_key,t]));
  for(const [taskKey,host] of invalidUsageTasks) {
    const metadata=taskMetadata.get(taskKey)??{task_key:taskKey,host};
    taskMetadata.set(taskKey,{...metadata,coverage_gaps:[...new Set([...(metadata.coverage_gaps??[]),'invalid_usage_record'])]});
  }
  const hostObservations=(Array.isArray(scan.host_observations)?scan.host_observations:[]).slice(0,128).map(r=>publicClaudeStatus(r,{now})).filter(Boolean);
  const globalGaps=scan.global_coverage_gaps??gaps;
  // Keep host inventory evidence separate: a failed Claude scan must not mark
  // Codex incomplete, and exact retained tasks cannot prove inventory coverage.
  const hostCoverageStatus=Object.fromEntries(['codex','claude'].filter(host=>
    Object.hasOwn(scan.host_status??{},host)||Array.isArray(scan.host_coverage?.[host])
  ).map(host=>{
    const status=scan.host_status?.[host]??scan.status;
    const hostGaps=scan.host_coverage?.[host]??globalGaps;
    return [host,['unavailable','disabled'].includes(status)?status:
      status==='exact'&&!hostGaps.length?'exact':'partial'];
  }));
  const quotaRetention=compactQuotaHistory([...(Array.isArray(previous?.quota_history)?previous.quota_history:[]),...quotas],{at:now});
  const allQuotas=quotaRetention.records;
  const rateStartedAt=Number.isSafeInteger(previous?.rate_observation_started_at)&&now>=previous.observed_at&&now-previous.observed_at<=120000
    ?previous.rate_observation_started_at:now;
  return {taskMetadata,hostObservations,globalGaps,hostCoverageStatus,quotaRetention,allQuotas,rateStartedAt};
}
// Responses kept: at most 100,000 and at most 48 MiB of stored rows. The adaptive
// budget below leaves space for other fields; the total store bound still applies.
export const RESPONSE_LIMITS=Object.freeze({count:100000,bytes:STORE_BOUND-16*1024*1024});
// Rows get what the other snapshot fields leave of the store bound, as measured
// on the last snapshot written; an overflow retries with the current metadata size.
// ponytail: floor at half the fixed budget; beyond that the write reports store-bound as before.
const NON_RECORD_MARGIN=2*1024*1024;
export function responseLimitsFor(nonRecordBytes) {
  if(!Number.isSafeInteger(nonRecordBytes)||nonRecordBytes<0)return RESPONSE_LIMITS;
  const bytes=Math.max(RESPONSE_LIMITS.bytes/2,Math.min(RESPONSE_LIMITS.bytes,STORE_BOUND-nonRecordBytes-NON_RECORD_MARGIN));
  return bytes===RESPONSE_LIMITS.bytes?RESPONSE_LIMITS:{count:RESPONSE_LIMITS.count,bytes};
}
export function withResponseBudget(write,limits=RESPONSE_LIMITS) {
  for(;;)try{return write(limits);}catch(error){
    if(error?.message!=='store-bound'||!Number.isSafeInteger(error.non_record_bytes)||error.non_record_bytes<0)throw error;
    const fitted=responseLimitsFor(error.non_record_bytes);
    if(fitted.bytes>=limits.bytes)throw error;
    limits={count:limits.count,bytes:fitted.bytes};
  }
}
// Index of the first kept row in capture order, given each row's stored size.
function retainedFrom(length,sizeAt,{count,bytes}) {
  const floor=Math.max(0,length-count);let used=0;
  for(let index=length-1;index>=floor;index--){used+=sizeAt(index)+1;if(used>bytes)return index+1;}
  return floor;
}
// The Codex source index as the next capture compares it. Next to the parse
// summary the scan saved (record_count, digest), each source records the rows
// this snapshot keeps (retained_count, retained_digest) and its parse range and
// legacy flag, so a source the response bound trimmed can still be reused.
function retainedSourceIndex(scan,previous,reused=new Set()) {
  const kept=new Map(),add=(map,r)=>{let accumulator=map.get(r.source_key);if(!accumulator)map.set(r.source_key,accumulator=sourceDigestAccumulator());accumulator.add(r);};
  return {
    keep(rows){for(const r of rows)if(r.host!=='claude')add(kept,r);},
    result(){
      const index=scan.codex_source_index;
      if(!Array.isArray(index?.sources))return index;
      const parsed=new Map(),prior=new Map((Array.isArray(previous?.codex_source_index?.sources)?previous.codex_source_index.sources:[]).map(s=>[s?.source_key,s]));
      for(const r of Array.isArray(scan.records)?scan.records:[])if(r&&r.host!=='claude'&&!reused.has(r.source_key))add(parsed,r);
      const empty=sourceDigestAccumulator().summary();
      return {...index,sources:index.sources.map(s=>{
        const retained=kept.get(s.source_key)?.summary()??empty,carried=reused.has(s.source_key)?prior.get(s.source_key):null;
        // A reused source was not parsed now: its parse facts are the ones saved with it.
        const facts=carried&&retainedFacts(carried)?{first:carried.first_observed_at,last:carried.last_observed_at,legacy:carried.legacy}
          :parsed.get(s.source_key)?.summary()??(reused.has(s.source_key)?retained:empty);
        return {...s,retained_count:retained.count,retained_digest:retained.digest,first_observed_at:facts.first,last_observed_at:facts.last,legacy:facts.legacy};
      })};
    },
  };
}
const retainedFacts=s=>Number.isSafeInteger(s.retained_count)&&s.retained_count>=0&&s.retained_count<=s.record_count&&/^[a-f0-9]{64}$/.test(s.retained_digest??'')
  &&(s.first_observed_at===null||Number.isSafeInteger(s.first_observed_at))&&(s.last_observed_at===null||Number.isSafeInteger(s.last_observed_at))&&typeof s.legacy==='boolean';
/**
 * Prior-row summaries for the scan's reuse check. A source whose kept rows are
 * exactly the ones the last capture recorded is given its saved parse summary,
 * so the scan reuses it as if it had been parsed again. Returns the sources
 * whose parse yields more rows than the snapshot keeps.
 */
export function retainedParseSummaries(index,priorSources) {
  const trimmed=new Set(),empty=sourceDigestAccumulator().summary();
  for(const s of Array.isArray(index?.sources)?index.sources:[]){
    if(!s||typeof s!=='object'||!retainedFacts(s))continue;
    const kept=priorSources.get(s.source_key)??empty;
    if(kept.count!==s.retained_count||kept.digest!==s.retained_digest)continue;
    priorSources.set(s.source_key,{count:s.record_count,digest:s.digest,first:s.first_observed_at,last:s.last_observed_at,legacy:s.legacy});
    if(s.record_count>s.retained_count)trimmed.add(s.source_key);
  }
  return trimmed;
}
function workspaceSnapshot({now,timeZone,scan,codexSourceIndex=scan.codex_source_index,gaps,hostCoverageStatus,records,tasks,oldDays,freshDays,allQuotas,quotaRetention,samples,rateStartedAt,quotaRates,predictionSnapshots,evaluationPairs,eligibleEvaluations,responseLimits=RESPONSE_LIMITS}) {
  return {schema_version:1,status:gaps.length?'partial':scan.status,observed_at:now,time_zone:timeZone,
    ...(codexSourceIndex?{codex_source_index:codexSourceIndex}:{}),
    capture_scope:scan.capture_scope,coverage_gaps:[...new Set(gaps)],host_coverage_status:hostCoverageStatus,records,tasks,daily:[...oldDays,...freshDays],
    quota_history:allQuotas,quota_coverage_gaps:quotaRetention.coverage_gaps,quota_forecasts:forecastQuotaWindows(allQuotas,{at:now,max_age_ms:120000}),samples:samples.slice(-1000),
    rate_observation_started_at:rateStartedAt,quota_rate_state:quotaRates.state,quota_calibration:quotaRates.reports,
    prediction_snapshots:[...predictionSnapshots.values()].slice(-1000),evaluation_pairs:evaluationPairs.slice(-1000),calibration:evaluateForecasts(eligibleEvaluations),scan_metrics:scan.metrics??null,
    retention:{response_days:90,daily_days:365,max_responses:responseLimits.count,max_response_bytes:responseLimits.bytes},
    current_response_unflushed:'unavailable',monitoring:'request_time_local_records',
    limitations:['shared_account_quota_not_task_attributed','unflushed_tokens_not_observed','cloud_and_other_devices_not_in_local_ledger']};
}

export function updateWorkspace(previous,scan,{now=Date.now(),timeZone='UTC',quotas=[],profiles={},consumeScan=false,responseLimits=RESPONSE_LIMITS}={}) {
  // Confirmed Claude sources carry no rows; only the streaming writer restamps
  // their stored rows. Here they would read as missing and turn unverified.
  if(Array.isArray(scan?.claude_confirmations)&&scan.claude_confirmations.length)throw new Error('claude_confirmations_need_streaming_writer');
  // Upsert stable response identities so polling, resumes and completion never
  // bill the same response twice. Keep only structured numeric metadata.
  // Reuse pure projections only within this synchronous capture. Later polls
  // may mutate the same source objects or use another timezone.
  const dates=new Map();
  const localDay=timestamp=>{if(!dates.has(timestamp))dates.set(timestamp,day(timestamp,timeZone));return dates.get(timestamp);};
  const cutoff=now-90*DAY,records=new Map();
  const retainedDay=localDay(cutoff);
  const priorRecords=Array.isArray(previous?.records)?previous.records:[];
  const incomingRecords=Array.isArray(scan.records)?scan.records:[];
  // The scheduled collector owns its scan and discards it after this call.
  // Replace those rows as we normalize them so raw, previous and normalized
  // copies do not all stay live. Other callers keep the nonmutating API.
  const normalized=consumeScan&&incomingRecords!==priorRecords?new WeakSet():null;
  if(normalized){
    const prior=new Map();for(const row of priorRecords)if(validRecord(row))prior.set(row.record_key,row);
    const sameFields=(a,b)=>a&&Object.keys(a).length===Object.keys(b).length
      &&Object.keys(b).every(key=>Object.hasOwn(a,key)&&a[key]===b[key]);
    for(let index=0;index<incomingRecords.length;index++){
      const row=incomingRecords[index];if(!validRecord(row))continue;
      const old=prior.get(row.record_key);
      if(row===old&&reusableWorkspaceRecord(row)){normalized.add(row);continue;}
      const clean=cleanRecord(row);
      const identical=old&&Object.keys(old).length===Object.keys(clean).length
        &&Object.keys(clean).every(key=>Object.hasOwn(old,key)&&(key==='usage'?sameFields(old.usage,clean.usage):old[key]===clean[key]));
      incomingRecords[index]=identical?old:clean;normalized.add(incomingRecords[index]);
    }
  }
  const invalidUsageTasks=new Map();
  for(const source of [priorRecords,incomingRecords])for(const r of source)
    if(isHashedIdentity(r?.task_key??'')&&!isValidUsage(r?.usage,{reasoningObserved:r?.host!=='claude'}))invalidUsageTasks.set(r.task_key,r.host==='claude'?'claude':'codex');
  quarantineInvalidTasks(previous,scan,invalidUsageTasks);
  const replacements=new Set((Array.isArray(scan.legacy_replacements)?scan.legacy_replacements:[]).filter(r=>isHashedIdentity(r.source_key??'')&&(r.turn_key===null||isHashedIdentity(r.turn_key??''))).map(r=>r.source_key+':'+(r.turn_key??'*')));
  const retiredLegacy=r=>r.host!=='claude'&&r.record_basis==='legacy_counter_event'&&(replacements.has(r.source_key+':*')||replacements.has(r.source_key+':'+r.turn_key));
  // Upsert first, then normalize each retained identity once. Most poll records
  // already exist in priorRecords; cloning both versions wastes memory and CPU.
  // Dates far from the retention boundary need no per-record timezone format.
  for(const source of [priorRecords,incomingRecords])for(const r of source) {
    if(!validRecord(r)||retiredLegacy(r)||r.observed_at>now||r.observed_at<cutoff-2*DAY)continue;
    if(r.observed_at<cutoff+2*DAY&&localDay(r.observed_at)<retainedDay)continue;
    records.set(r.record_key,r);
  }
  for(const [key,r] of records)records.set(key,normalized?.has(r)?r:cleanRecord(r));
  const observedKeys=new Set();for(const r of incomingRecords)if(validRecord(r))observedKeys.add(r.record_key);
  for(const [key,r] of records)if((r.host==='claude'?typeof scan.host_inventory_complete?.claude==='boolean':typeof scan.record_inventory_complete==='boolean')&&!observedKeys.has(key))records.set(key,{...r,quality:'partial',validation_status:'historical_unverified'});
  observedKeys.clear();
  const ordered=[...records.values()].sort((a,b)=>a.observed_at-b.observed_at);
  records.clear();
  const retained=ordered.slice(retainedFrom(ordered.length,index=>Buffer.byteLength(JSON.stringify(compactRecord(ordered[index]))),responseLimits)),gaps=[...(scan.coverage_gaps??[])];
  if(ordered.length>retained.length)gaps.push('response_retention_bound');
  const {taskMetadata,hostObservations,globalGaps,hostCoverageStatus,quotaRetention,allQuotas,rateStartedAt}=captureGlobals(previous,scan,invalidUsageTasks,gaps,{now,quotas});
  const quotaRates=learnQuotaRates(previous?.quota_rate_state,retained,priorRecords,quotas,scan,{now});
  let samples=Array.isArray(previous?.samples)?previous.samples.slice(-1000):[];
  const byTask=new Map();for(const r of retained){const group=byTask.get(r.task_key)??[];group.push(r);byTask.set(r.task_key,group);}
  for(const t of taskMetadata.values())if(isHashedIdentity(t.task_key)&&!byTask.has(t.task_key))byTask.set(t.task_key,[]);
  const ctx={now,scan,globalGaps,taskMetadata,profiles,hostObservations,rateStartedAt,quotaRates,previousTasks:previous?.tasks,retentionBound:ordered.length>retained.length};
  // One completed request group per independent task/conversation. Never
  // train on the task currently being forecast or label an idle task finished.
  const oldSamples=samples;
  samples=oldSamples.filter(s=>!byTask.has(s.task_key));
  for(const [task_key,rows] of byTask){const sample=completedTaskSample(task_key,rows,ctx);if(sample)samples.push(sample);}
  // Preserve the original prospective snapshot and completed outcome. Mutable
  // profile revisions and source revalidation only affect current eligibility.
  const predictionSnapshots=priorPredictionSnapshots(previous,profiles);
  const evaluationPairs=Array.isArray(previous?.evaluation_pairs)?previous.evaluation_pairs.slice(-1000):[];
  const evaluatedTasks=new Set(evaluationPairs.map(p=>p.task_key));
  addPredictionSnapshots(predictionSnapshots,evaluatedTasks,profiles);
  for(const [task_key,rows] of byTask){
    if(evaluatedTasks.has(task_key))continue;
    const p=predictionSnapshots.get(task_key);if(!p)continue;
    const pair=taskEvaluation(task_key,rows,p,ctx);
    if(pair){evaluationPairs.push(pair);evaluatedTasks.add(task_key);}
  }
  const eligibleEvaluations=evaluationPairs.map(p=>eligibleEvaluation(p,byTask.get(p.task_key)??[],predictionSnapshots,ctx)).filter(Boolean);
  ctx.samples=samples;
  const tasks=[...byTask].map(([task_key,rows])=>taskSummary(task_key,rows,ctx)).sort((a,b)=>(b.last_observed_at??0)-(a.last_observed_at??0));
  let freshDays;try{freshDays=grouped(ordered,['date','task_key','host','role','model','effort','service_tier'],(r,key)=>key==='date'?localDay(r.observed_at):r[key]);}catch{throw new Error('invalid-timezone');}
  const recordDayKey=r=>recordDayKeyOf(r,localDay);
  const priorByKey=new Map();for(const r of priorRecords)if(validRecord(r))priorByKey.set(r.record_key,r);
  const priorGroups=new Map(),retiredGroups=new Map();for(const r of priorByKey.values()){const key=recordDayKey(r);priorGroups.set(key,(priorGroups.get(key)??0)+1);if(retiredLegacy(r)){const retired=retiredGroups.get(key)??[];retired.push(r);retiredGroups.set(key,retired);}}
  freshDays=correctPriorDays(freshDays,{previous,timeZone,retainedDay,priorGroups,retiredGroups,priorByKey,scan,globalGaps,taskMetadata,
    unverifiedTasks:new Set(ordered.filter(r=>r.validation_status==='historical_unverified').map(r=>r.task_key)),
    rowsForDays:keys=>{const newByDay=new Map();for(const r of incomingRecords){if(!validRecord(r))continue;const key=recordDayKey(r);if(!keys.has(key))continue;const g=newByDay.get(key)??[];g.push(r);newByDay.set(key,g);}return newByDay;}});
  const todayCutoff=localDay(cutoff);
  const oldDays=(previous?.time_zone===timeZone&&Array.isArray(previous?.daily)?previous.daily:[]).filter(d=>typeof d.date==='string'&&d.date<todayCutoff&&d.date>=localDay(now-365*DAY));
  const sourceIndex=retainedSourceIndex(scan,previous);sourceIndex.keep(retained);
  return workspaceSnapshot({now,timeZone,scan,codexSourceIndex:sourceIndex.result(),gaps,hostCoverageStatus,records:retained,tasks,oldDays,freshDays,allQuotas,quotaRetention,samples,rateStartedAt,quotaRates,predictionSnapshots,evaluationPairs,eligibleEvaluations,responseLimits});
}
const DAY_GROUP_KEYS=['date','task_key','host','role','model','effort','service_tier'];
function spoolWriter(fd) {
  const buffer=Buffer.allocUnsafe(256*1024);let used=0,position=0;
  const flush=()=>{let offset=0;while(offset<used){const written=fs.writeSync(fd,buffer,offset,used-offset);if(!written)throw new Error('short-write');offset+=written;}used=0;};
  return {
    write(text){
      const bytes=Buffer.byteLength(text);position+=bytes;
      if(bytes>buffer.length-used)flush();
      if(bytes>buffer.length){let offset=0;const data=Buffer.from(text);while(offset<data.length){const written=fs.writeSync(fd,data,offset,data.length-offset);if(!written)throw new Error('short-write');offset+=written;}return;}
      used+=buffer.write(text,used);
    },
    flush,get position(){return position;},
  };
}

// Everything a registered Claude refresh does not restamp, as the writer stores it.
function claudeRowDigest(r) {
  const {captured_at,capture_origin,...rest}=cleanRecord(r);
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest();
}
/**
 * Per-source summaries of Claude rows: the count and an order-independent
 * SHA-256 over every stored field except the refresh time and origin. Equal
 * summaries mean a refreshed source yields exactly the rows already stored.
 */
export function claudeSourceSummaries() {
  const rows=new Map(),broken=new Set();
  return {
    add(r) {
      if(r?.host!=='claude'||!isHashedIdentity(r.source_key??''))return;
      if(!r.usage||typeof r.usage!=='object'){broken.add(r.source_key);return;}
      let list=rows.get(r.source_key);if(!list)rows.set(r.source_key,list=[]);list.push(claudeRowDigest(r));
    },
    summary(){return new Map([...rows].filter(([key])=>!broken.has(key)).map(([key,list])=>[key,{count:list.length,
      digest:crypto.createHash('sha256').update(Buffer.concat(list.sort(Buffer.compare))).digest('hex')}]));},
  };
}
/** A stored Claude row as its unchanged, just refreshed source yields it: only the refresh time and origin differ. */
export function confirmedClaudeRow(r,confirmation) {
  return {...cleanRecord(r),captured_at:confirmation.captured_at,capture_origin:confirmation.capture_origin};
}

/**
 * Facts about the prior snapshot's rows that the streaming writer needs from
 * every row; the collector gathers them while it streams those rows once.
 */
export function priorWorkspaceFacts(timeZone) {
  const localDay=minuteDay(timeZone),priorGroups=new Map(),invalidUsageTasks=new Map();let canonical=true;
  return {
    add(r) {
      if(!canonicalRecord(r))canonical=false;
      if(isHashedIdentity(r?.task_key??'')&&!isValidUsage(r?.usage,{reasoningObserved:r?.host!=='claude'}))invalidUsageTasks.set(r.task_key,r.host==='claude'?'claude':'codex');
      if(validRecord(r)){const key=recordDayKeyOf(r,localDay);priorGroups.set(key,(priorGroups.get(key)??0)+1);}
    },
    get facts(){return {priorGroups,invalidUsageTasks,canonical};},
  };
}

/**
 * Bounded-memory form of updateWorkspace + completedWorkObservations +
 * writeWorkspaceFile for the scheduled collector. `priorPass(onRow)` streams
 * the prior snapshot's rows in file order and is called twice (three times
 * when a prior day needs re-observed rows). The merged history is spooled next
 * to the snapshot and read back one task at a time. Whenever it cannot
 * reproduce the in-memory result exactly it returns {ok:false,reason} before
 * replacing anything, and the caller takes the in-memory path instead.
 */
export function writeWorkspaceStreaming(directory,options={}) {
  const now=options.now??Date.now();
  return withResponseBudget(responseLimits=>writeWorkspaceStreamingOnce(directory,{...options,now,responseLimits}),options.responseLimits);
}
function writeWorkspaceStreamingOnce(directory,{previous,priorFacts,priorPass,scan,trimmedSources=new Set(),now=Date.now(),timeZone='UTC',quotas=[],profiles={},quotaAvailability,responseLimits=RESPONSE_LIMITS,timings}={}) {
  const buildStarted=startPhase();let pass=1;
  const readPrior=onRow=>measurePhase(timings,'prior_pass_'+(++pass),()=>priorPass(onRow));
  const fail=reason=>({ok:false,reason});
  const localDay=minuteDay(timeZone),cutoff=now-90*DAY,retainedDay=localDay(cutoff);
  const incoming=Array.isArray(scan.records)?scan.records:[];
  const reusedSources=new Set(Array.isArray(scan.reused_sources)?scan.reused_sources:[]);
  const confirmations=new Map((Array.isArray(scan.claude_confirmations)?scan.claude_confirmations:[])
    .filter(c=>isHashedIdentity(c?.source_key??'')&&Number.isSafeInteger(c.captured_at)&&['hook','registered_refresh'].includes(c.capture_origin)).map(c=>[c.source_key,c]));
  const incomingByKey=new Map();
  for(const row of incoming)if(validRecord(row)){if(incomingByKey.has(row.record_key))return fail('duplicate_incoming_identity');incomingByKey.set(row.record_key,row);}
  const replacements=new Set((Array.isArray(scan.legacy_replacements)?scan.legacy_replacements:[]).filter(r=>isHashedIdentity(r.source_key??'')&&(r.turn_key===null||isHashedIdentity(r.turn_key??''))).map(r=>r.source_key+':'+(r.turn_key??'*')));
  const retiredLegacy=r=>r.host!=='claude'&&r.record_basis==='legacy_counter_event'&&(replacements.has(r.source_key+':*')||replacements.has(r.source_key+':'+r.turn_key));
  const passes=r=>validRecord(r)&&!retiredLegacy(r)&&r.observed_at<=now&&r.observed_at>=cutoff-2*DAY&&!(r.observed_at<cutoff+2*DAY&&localDay(r.observed_at)<retainedDay);
  const recordDayKey=r=>recordDayKeyOf(r,localDay);
  // Prior-row facts arrive in prior order, so incoming rows extend them in the same order.
  if(!priorFacts?.canonical)return fail('invalid_prior_row');
  const {priorGroups,invalidUsageTasks}=priorFacts;
  const noteInvalid=r=>{if(isHashedIdentity(r?.task_key??'')&&!isValidUsage(r?.usage,{reasoningObserved:r?.host!=='claude'}))invalidUsageTasks.set(r.task_key,r.host==='claude'?'claude':'codex');};

  // First prior pass: positions of rescanned identities and retired legacy rows.
  // Other rows are only counted; their stored identity is read from the text.
  const priorMatch=new Map(),retiredGroups=new Map();
  let priorCount=0,failure=null;
  const first=readPrior(text=>{
    const position=priorCount++,at=text.indexOf('"record_key":"');
    if(at>=0&&!incomingByKey.has(text.slice(at+14,at+34))&&!text.includes('"record_basis":"legacy_counter_event"'))return;
    const r=expandRecord(JSON.parse(text));
    if(validRecord(r)&&retiredLegacy(r)){const key=recordDayKey(r),list=retiredGroups.get(key)??[];list.push(r);retiredGroups.set(key,list);}
    if(incomingByKey.has(r.record_key)){
      if(priorMatch.has(r.record_key))failure??='duplicate_prior_identity';
      if(r.host!=='claude'&&reusedSources.has(r.source_key)&&r.validation_status!=='historical_unverified')failure??='reused_identity_conflict';
      priorMatch.set(r.record_key,{position,passes:passes(r),row:r});
    }
  });
  if(!first)return fail('prior_unreadable');
  if(failure)return fail(failure);

  // Normalize the consumed scan exactly as updateWorkspace does.
  const sameFields=(a,b)=>a&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(key=>Object.hasOwn(a,key)&&a[key]===b[key]);
  const identical=(old,clean)=>Boolean(old)&&Object.keys(old).length===Object.keys(clean).length
    &&Object.keys(clean).every(key=>Object.hasOwn(old,key)&&(key==='usage'?sameFields(old.usage,clean.usage):old[key]===clean[key]));
  const normalizedIncoming=new Map();
  for(const [key,row] of incomingByKey){const match=priorMatch.get(key),old=match&&validRecord(match.row)?match.row:undefined,clean=cleanRecord(row);normalizedIncoming.set(key,identical(old,clean)?old:clean);}
  // Rescanned rows keep a prior row's place in insertion order; new ones follow all prior rows.
  const arrivals=[];let appended=0;
  for(const [key,row] of normalizedIncoming){
    if(!passes(row))continue;
    const match=priorMatch.get(key);
    arrivals.push({row,position:match?.passes?match.position:priorCount+appended++,before:match?.row});
  }
  arrivals.sort((a,b)=>a.row.observed_at-b.row.observed_at||a.position-b.position);
  const arrived=new Set(arrivals.map(a=>a.row.record_key));
  // Quota-rate learning only looks at rows after its oldest anchor or snapshot.
  let minBound=Infinity;
  if(quotas.length){
    for(const q of quotas)if(Number.isFinite(q?.snapshot_at_ms))minBound=Math.min(minBound,q.snapshot_at_ms);
    for(const w of Array.isArray(previous?.quota_rate_state?.windows)?previous.quota_rate_state.windows:[])
      for(const t of [w?.anchor?.snapshot_at_ms,w?.latest?.snapshot_at_ms,...(Array.isArray(w?.samples)?w.samples.map(sample=>sample?.start):[])])if(Number.isFinite(t))minBound=Math.min(minBound,t);
  }

  const spoolName=path.join(directory,`workspace.json.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const tempName=path.join(directory,`workspace.json.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let spoolFd,readFd,outFd,spoolOwned,outOwned,renamed=false;
  try {
    spoolFd=fs.openSync(spoolName,'wx',0o600);spoolOwned=fs.fstatSync(spoolFd);
    const spool=spoolWriter(spoolFd);
    const taskRows=new Map(),quotaRows=[],sizes=[];let emitted=0,canonical=true;
    const emit=(row,before,stored)=>{
      const text=(stored??JSON.stringify(compactRecord(row)))+'\n',offset=spool.position;
      spool.write(text);
      let list=taskRows.get(row.task_key);if(!list)taskRows.set(row.task_key,list=[]);
      list.push(offset,Buffer.byteLength(text)-1,emitted);sizes.push(Buffer.byteLength(text)-1);
      if(!canonicalRecord(row))canonical=false;
      if(row.observed_at>=minBound)quotaRows.push({index:emitted,row,before});
      emitted++;
    };
    // Second prior pass: merge prior and rescanned rows by (observed_at, insertion order).
    const markCodex=typeof scan.record_inventory_complete==='boolean',markClaude=typeof scan.host_inventory_complete?.claude==='boolean';
    // Prior days with fewer retained rows than their saved total are the ones
    // correctPriorDays can revisit; their reused rows are kept from this pass.
    const shortDays=new Set(priorDailyRows(previous,timeZone,retainedDay).filter(d=>(priorGroups.get(dayKey(d))??0)<d.response_count).map(dayKey)),shortRows=[];
    const reusedRow=r=>r.host!=='claude'&&reusedSources.has(r.source_key)&&r.validation_status!=='historical_unverified';
    // A confirmed Claude source's stored rows are what its refresh yields, restamped.
    const confirmedRow=r=>r.host==='claude'&&confirmations.has(r.source_key)&&validRecord(r)?confirmedClaudeRow(r,confirmations.get(r.source_key)):null;
    let next=0,priorIndex=0,lastObserved=-Infinity;
    const second=readPrior(text=>{
      const r=expandRecord(JSON.parse(text)),position=priorIndex++,confirmed=confirmedRow(r);
      if(shortDays.size&&(confirmed||reusedRow(r)&&validRecord(r))&&shortDays.has(recordDayKey(r)))shortRows.push([confirmed??r,r]);
      if(!passes(r)||arrived.has(r.record_key))return;
      if(r.observed_at<lastObserved)throw new Error('prior_order');
      lastObserved=r.observed_at;
      while(next<arrivals.length&&(arrivals[next].row.observed_at<r.observed_at||arrivals[next].row.observed_at===r.observed_at&&arrivals[next].position<position)){emit(arrivals[next].row,arrivals[next].before);next++;}
      let row;
      if(confirmed)row=confirmed;
      else if(reusedRow(r)){
        if(reusableWorkspaceRecord(r))row=r;else{const clean=cleanRecord(r);row=identical(r,clean)?r:clean;}
      }else if(incomingByKey.has(r.record_key))row=normalizedIncoming.get(r.record_key)===priorMatch.get(r.record_key)?.row?r:cleanRecord(r);
      else{
        row=cleanRecord(r);
        if(row.host==='claude'?markClaude:markCodex)row={...row,quality:'partial',validation_status:'historical_unverified'};
      }
      // An unchanged prior row is written back as the text it was read from.
      emit(row,r,row===r?text:undefined);
    });
    if(!second||priorIndex!==priorCount)return fail('prior_changed');
    while(next<arrivals.length){emit(arrivals[next].row,arrivals[next].before);next++;}
    spool.flush();fs.closeSync(spoolFd);spoolFd=undefined;
    if(!canonical)return fail('non_canonical_row');
    const drop=retainedFrom(emitted,index=>sizes[index],responseLimits);sizes.length=0;

    for(const r of incoming)noteInvalid(r);
    quarantineInvalidTasks(previous,scan,invalidUsageTasks);
    const gaps=[...(scan.coverage_gaps??[])];
    // A reused source whose parse yields rows beyond the bound keeps the history bounded, as its parse would.
    const trimmedHistory=[...trimmedSources].some(key=>reusedSources.has(key));
    if(drop||trimmedHistory)gaps.push('response_retention_bound');
    const {taskMetadata,hostObservations,globalGaps,hostCoverageStatus,quotaRetention,allQuotas,rateStartedAt}=captureGlobals(previous,scan,invalidUsageTasks,gaps,{now,quotas});
    const activity=quotaRows.filter(item=>item.index>=drop);
    const quotaRates=learnQuotaRates(previous?.quota_rate_state,activity.map(item=>item.row),activity.flatMap(item=>item.before?[item.before]:[]),quotas,scan,{now});
    quotaRows.length=0;

    // Tasks in first-retained order, then scan-only tasks, as byTask orders them.
    const firstRetained=[];
    for(const [task,list] of taskRows)for(let k=2;k<list.length;k+=3)if(list[k]>=drop){firstRetained.push([list[k],task]);break;}
    const order=firstRetained.sort((a,b)=>a[0]-b[0]).map(([,task])=>task),known=new Set(order);
    for(const t of taskMetadata.values())if(isHashedIdentity(t.task_key)&&!known.has(t.task_key)){order.push(t.task_key);known.add(t.task_key);}
    readFd=fs.openSync(spoolName,'r');
    // Rows next to each other in the spool are read together, in blocks of at
    // most 256 KiB, and each row is decoded straight from the block.
    const block=Buffer.allocUnsafe(256*1024);
    const readTask=task=>{
      const list=taskRows.get(task)??[],rows=[],indexes=[];
      for(let k=0;k<list.length;){
        let end=k+3;
        while(end<list.length&&list[end]===list[end-3]+list[end-2]+1&&list[end]+list[end+1]-list[k]<=block.length)end+=3;
        const start=list[k],length=list[end-3]+list[end-2]-start,buffer=length<=block.length?block:Buffer.allocUnsafe(length);
        fs.readSync(readFd,buffer,0,length,start);
        for(let j=k;j<end;j+=3){
          const offset=list[j]-start;
          rows.push(expandRecord(JSON.parse(buffer.toString('utf8',offset,offset+list[j+1]))));indexes.push(list[j+2]);
        }
        k=end;
      }
      return {all:rows,indexes,retained:drop?rows.filter((row,k)=>indexes[k]>=drop):rows};
    };

    const builder=completedWorkBuilder(now);
    const sourceIndex=retainedSourceIndex(scan,previous,reusedSources);
    const ctx={now,scan,globalGaps,taskMetadata,profiles,hostObservations,rateStartedAt,quotaRates,previousTasks:previous?.tasks,retentionBound:drop>0||trimmedHistory};
    let samples=(Array.isArray(previous?.samples)?previous.samples.slice(-1000):[]).filter(sample=>!known.has(sample.task_key));
    const predictionSnapshots=priorPredictionSnapshots(previous);
    const evaluationPairs=Array.isArray(previous?.evaluation_pairs)?previous.evaluation_pairs.slice(-1000):[];
    const evaluatedTasks=new Set(evaluationPairs.map(p=>p.task_key));
    addPredictionSnapshots(predictionSnapshots,evaluatedTasks,profiles);
    for(const task of order){
      const {retained:rows}=readTask(task);
      sourceIndex.keep(rows);
      builder.count(rows);
      const sample=completedTaskSample(task,rows,ctx);if(sample)samples.push(sample);
      if(evaluatedTasks.has(task))continue;
      const p=predictionSnapshots.get(task);if(!p)continue;
      const pair=taskEvaluation(task,rows,p,ctx);
      if(pair){evaluationPairs.push(pair);evaluatedTasks.add(task);}
    }
    ctx.samples=samples;
    const pairsByTask=new Map();
    evaluationPairs.forEach((pair,index)=>{const list=pairsByTask.get(pair.task_key)??[];list.push(index);pairsByTask.set(pair.task_key,list);});
    // Task summaries are kept as their JSON text; only the sort key stays numeric.
    const eligible=new Map(),tasks=[],dayGroups=[],unverifiedTasks=new Set();
    for(const task of order){
      const {all,indexes,retained:rows}=readTask(task);
      const summary=taskSummary(task,rows,ctx);tasks.push({last:summary.last_observed_at??0,text:JSON.stringify(summary)});
      for(const index of pairsByTask.get(task)??[])eligible.set(index,eligibleEvaluation(evaluationPairs[index],rows,predictionSnapshots,ctx));
      if(all.some(row=>row.validation_status==='historical_unverified'))unverifiedTasks.add(task);
      builder.addTask(rows,summary);
      const groups=new Map();
      all.forEach((row,k)=>{const key=JSON.stringify(DAY_GROUP_KEYS.map(field=>field==='date'?localDay(row.observed_at):row[field]));
        let group=groups.get(key);if(!group)groups.set(key,group={first:indexes[k],rows:[]});group.rows.push(row);});
      for(const group of groups.values())dayGroups.push({first:group.first,day:{...Object.fromEntries(DAY_GROUP_KEYS.map(field=>[field,field==='date'?localDay(group.rows[0].observed_at):group.rows[0][field]])),...bucket(group.rows)}});
    }
    fs.closeSync(readFd);readFd=undefined;
    tasks.sort((a,b)=>b.last-a.last);
    const eligibleEvaluations=evaluationPairs.map((pair,index)=>eligible.has(index)?eligible.get(index):eligibleEvaluation(pair,[],predictionSnapshots,ctx)).filter(Boolean);
    // A prior day group not fully covered needs this capture's rows for it,
    // including rows of reused sources, which only the prior snapshot holds.
    const priorLookup=new Map();
    let freshDays=correctPriorDays(dayGroups.sort((a,b)=>a.first-b.first).map(group=>group.day),{previous,timeZone,retainedDay,priorGroups,retiredGroups,
      priorByKey:{get:key=>priorLookup.get(key)},scan,globalGaps,taskMetadata,unverifiedTasks,
      rowsForDays:keys=>{
        const newByDay=new Map(),add=(row,prior)=>{const key=recordDayKey(row);if(!keys.has(key))return;const group=newByDay.get(key)??[];group.push(row);newByDay.set(key,group);if(prior)priorLookup.set(row.record_key,prior);};
        for(const [key,row] of normalizedIncoming){const match=priorMatch.get(key);add(row,match&&validRecord(match.row)?match.row:undefined);}
        if([...keys].every(key=>shortDays.has(key)))for(const [row,prior] of shortRows)add(row,prior);
        else if((reusedSources.size||confirmations.size)&&!readPrior(text=>{const r=expandRecord(JSON.parse(text)),confirmed=confirmedRow(r);
          if(confirmed)add(confirmed,r);else if(reusedRow(r)&&validRecord(r))add(r,r);}))throw new Error('prior_changed');
        return newByDay;
      }});
    const todayCutoff=localDay(cutoff);
    const oldDays=(previous?.time_zone===timeZone&&Array.isArray(previous?.daily)?previous.daily:[]).filter(d=>typeof d.date==='string'&&d.date<todayCutoff&&d.date>=localDay(now-365*DAY));
    const snapshot=workspaceSnapshot({now,timeZone,scan,codexSourceIndex:sourceIndex.result(),gaps,hostCoverageStatus,records:null,tasks,oldDays,freshDays,allQuotas,quotaRetention,samples,rateStartedAt,quotaRates,predictionSnapshots,evaluationPairs,eligibleEvaluations,responseLimits});
    snapshot.completed_work=builder.result();
    snapshot.quota_availability=quotaAvailability;

    finishPhase(timings,'snapshot_build',buildStarted,['prior_pass_2','prior_pass_3','prior_pass_4']);
    const writeStarted=startPhase();
    // Same bytes as writeWorkspaceFile: key order, compact rows, defaults marker.
    outFd=fs.openSync(tempName,'wx',0o600);outOwned=fs.fstatSync(outFd);
    const out=spoolWriter(outFd),retainedCount=emitted-drop,compact=retainedCount>0;
    const write=text=>{out.write(text);if(out.position>STORE_BOUND)throw workspaceStoreBound({...snapshot,tasks:tasks.map(task=>JSON.parse(task.text))},compact);};
    write('{');let firstKey=true,recordStart=0,recordBytes=0;
    for(const key of Object.keys(snapshot)){
      const field=snapshot[key];
      if(key!=='records'&&(field===undefined||typeof field==='function'||typeof field==='symbol'))continue;
      write((firstKey?'':',')+JSON.stringify(key)+':');firstKey=false;
      if(key==='tasks'){write('['+tasks.map(task=>task.text).join(',')+']');continue;}
      if(key!=='records'){write(JSON.stringify(field));continue;}
      recordStart=out.position;write('[');
      const source=fs.openSync(spoolName,'r');
      try{
        const buffer=Buffer.allocUnsafe(256*1024);let line=0,carry='',written=0;
        for(let count;(count=fs.readSync(source,buffer,0,buffer.length,null));){
          const parts=(carry+buffer.toString('utf8',0,count)).split('\n');carry=parts.pop();
          for(const part of parts){if(line++>=drop){write((written++?',':'')+part);}}
        }
        if(carry)throw new Error('spool_truncated');
        if(written!==retainedCount)throw new Error('spool_count');
      }finally{fs.closeSync(source);}
      write(']');recordBytes=out.position-recordStart;
    }
    if(compact)write(`,"record_defaults_version":${RECORD_DEFAULTS_VERSION}`);
    write('}');
    out.flush();fs.closeSync(outFd);outFd=undefined;
    fs.renameSync(tempName,directory?path.join(directory,'workspace.json'):tempName);renamed=true;
    finishPhase(timings,'snapshot_write',writeStarted);
    return {ok:true,bytes_written:out.position,record_bytes:recordBytes,next:{schema_version:1,observed_at:now,status:snapshot.status,codex_source_index:snapshot.codex_source_index,
      samples:snapshot.samples,quota_history:snapshot.quota_history,quota_coverage_gaps:snapshot.quota_coverage_gaps}};
  }finally{
    for(const fd of [spoolFd,readFd,outFd])if(fd!==undefined)try{fs.closeSync(fd);}catch{/* Already closed. */}
    try{unlinkOwnedFile(spoolName,spoolOwned);}catch{/* Never created or already removed. */}
    if(!renamed)try{unlinkOwnedFile(tempName,outOwned);}catch{/* Never created. */}
  }
}
const PUBLIC_KEYS=new Set(('task_shape median_input_tokens_per_response active_span_hours max_responses_per_turn review_input_share_percent compaction_count median_input_before_compaction median_input_after_compaction signals profile_history omitted_profile_segments profile_history_basis started_at changed_fields calibration prediction_unit p80_coverage mean_absolute_error baseline_mean_absolute_error rejected_count cross_epoch_samples quota_coverage_gaps scan_metrics cpu_user_micros cpu_system_micros rss_bytes changed_files header_bytes capture_duration_ms bytes_read_for_usage cache_hits source_files host capture_origin last_capture_at captured_at collector_version validation_status reasoning_usage_status coverage_status revalidated_usage current_model current_effort schema_version status observed_at stale time_zone tasks daily quota_windows quota_forecasts capture_scope coverage_gaps limitations responses detail_limit retention response_days daily_days max_responses task_key label response_count usage new_input_tokens calculated_dollar_equivalent cost_quality unpriced_responses cost_basis main_usage subagent_usage models sources turn_count pending_turns first_observed_at last_observed_at completed_usage unfinished_observed_usage forecast forecast_revisions quota_percent quota_attribution role model effort service_tier source_key parent_source turn_key root_key record_key requested_service_tier completed completed_at duration_ms quality date account_id plan_id limit_id quota_group window_id snapshot_at_ms resets_at_ms used_percent remaining_percent window_duration_mins scope identity_basis sample_count minimum_samples measurement_basis method quota_task_attribution cohort p50 p80 total_tokens input_tokens cached_input_tokens output_tokens reasoning_output_tokens cache_write_input_tokens consistent reason_codes features prediction basis percent_per_hour exhaustion_at_ms exhausts_before_reset scenario at latest_snapshot_at_ms forecast_at_ms resets_at_ms').split(' '));
for(const k of ('recent_activity quota_rate_estimates quota_forecast quota_calibration provider rate_window_ms rate_observation_interval_ms used_percent_change used_percent_rounding_uncertainty percent_per_hour_lower_bound percent_per_hour_upper_bound interval_started_at_ms interval_ended_at_ms coverage_scope current_response_unflushed price_revision pricing_profiles total_tokens_per_hour new_input_tokens_per_hour cached_input_tokens_per_hour output_tokens_per_hour cache_write_input_tokens_per_hour calculated_dollar_equivalent_per_hour estimated_quota_burn_pp_per_hour lower_quota_burn_pp_per_hour upper_quota_burn_pp_per_hour account_coverage per_api_dollar lower_per_api_dollar upper_per_api_dollar relative_fit_error bounds_basis estimated_quota_pp lower_quota_pp upper_quota_pp').split(' '))PUBLIC_KEYS.add(k);
for(const k of 'host_observation configured_model configured_effort host_version quota_observation_status source_freshness'.split(' '))PUBLIC_KEYS.add(k);
for(const key of ['pricing_profile_cost_shares','missing_features','profile_status','profile_created_at','precision_percent','precision_source','first_precision_percent','first_precision_source'])PUBLIC_KEYS.add(key);
for(const k of 'record_basis legacy_observation_count incremental_files bytes_parsed_for_usage reused_sources header_cache_hits source_coverage'.split(' '))PUBLIC_KEYS.add(k);
for(const k of 'profile_transitions profile_transition_count omitted_profile_transitions profile_transition_basis observational_label aggregation comparison_status from to window_limit boundary before after before_last_observed_at after_first_observed_at gap_ms denominators main descendants combined unassignable_descendants comparison_span_descendant_response_count observed_percent_change main_per_response descendant_per_response combined_per_main_response overlap_status overlap_scope completed_response_count unfinished_response_count is_final first_observed_at combined_usage transition_scan_metrics candidate_transition_count materialized_transition_count descendant_index_size descendant_range_rows_examined descendant_aggregate_blocks_read overlap_range_checks retained_evidence_key_count'.split(' '))PUBLIC_KEYS.add(k);
for(const k of 'context_band scope_band verification_band planned_subagent_policy max_response_bytes'.split(' '))PUBLIC_KEYS.add(k);
for(const k of 'estimated_auto_review_credits lower_credits upper_credits lower_model upper_model rate_profile_id'.split(' '))PUBLIC_KEYS.add(k);

// A saved healthy snapshot is not a live rate after collection has stopped.
function staleRates(value,suppress=false) {
  if(Array.isArray(value))return value.map(v=>staleRates(v,suppress));
  if(!value||typeof value!=='object')return value;
  const rate=value.measurement_basis==='recorded_activity_rate'||value.measurement_basis==='estimated'
    ||value.method==='constant_observed_rate_scenario';
  const output=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,staleRates(v,suppress||rate)]));
  if(suppress||rate) {
    if(rate){output.status='unavailable';output.reason_codes=['stale_activity_snapshot'];}
    for(const k of Object.keys(output))if(k.includes('per_hour')||k.includes('per_api_dollar')||k.endsWith('_quota_pp')||k==='exhaustion_at_ms'||k==='exhausts_before_reset')output[k]=null;
  }
  return output;
}
function project(value,depth=0) {
  if(depth>12)return undefined;
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(value===AUTO_REVIEW_ESTIMATE_LABEL)return value;
  if(typeof value==='string')return value.length<=120&&!isSensitiveRuntimeValue(value)&&/^[A-Za-z0-9_ .:+/\-]*(?:\[1m\])?$/i.test(value)?value:undefined;
  if(Array.isArray(value))return value.slice(0,20000).map(v=>project(v,depth+1)).filter(v=>v!==undefined);
  if(!value||typeof value!=='object')return undefined;
  return Object.fromEntries(Object.entries(value).filter(([k])=>PUBLIC_KEYS.has(k)).map(([k,v])=>[k,project(v,depth+1)]).filter(([,v])=>v!==undefined));
}
/** Overlay only quota history based on this exact usage generation. Older
 * sidecars cannot roll back a newer full capture. Missing sidecars are legacy.
 * Quota-only runs append here between usage captures, so every writer reads it. */
export function withQuotaSidecar(directory,state) {
 const quota=readWorkspaceFile(directory,'quota.json');
 if(quota?.schema_version===1&&quota.base_observed_at===state.observed_at&&Array.isArray(quota.quota_history)){
  const base=quota.includes_base===true?{...state,quota_history:[]}:state;
  return refreshWorkspaceQuotas(base,quota.quota_history);
 }
 return state;
}
export function readWorkspaceSnapshot(directory,options={}) {
 const signature=workspaceSnapshotSignature(directory);
 let state=readWorkspaceFile(directory,'workspace.json',options);
 if(!state)return null;
 delete state.source_validation; // Only this read can establish a metadata-bound lease.
 state=withQuotaSidecar(directory,state);
 const monitor=readWorkspaceFile(directory,'monitor.json');
 if(signature&&signature===workspaceSnapshotSignature(directory)&&signature===monitor?.source_signature?.snapshot
  &&monitor.mode==='scheduled'&&['idle','degraded'].includes(monitor.status)
  &&[null,'quota_source_unavailable'].includes(monitor.last_error_code??null)
  &&['sources_unchanged','scheduled_complete'].includes(monitor.stop_reason)
  &&monitor.last_snapshot_at===state.observed_at&&monitor.last_success_at>=state.observed_at
  &&monitor.last_checked_at>=monitor.last_success_at){
  // This lease verifies retained sources, not unflushed model work. It is
  // transient: a full capture must never persist an old validation lease.
  Object.defineProperty(state,'source_validation',{value:{checked_at:monitor.last_checked_at,interval_seconds:monitor.interval_seconds}});
 }
 return state;
}
function sourceFreshness(state,now) {
 const snapshot=workspaceFreshness(state.observed_at,now),lease=state.source_validation;
 if(!lease||['unavailable','clock_anomaly'].includes(snapshot.status))return snapshot;
 return workspaceFreshness(lease.checked_at,now,collectorMaxAge(lease));
}
/** Quota-only refresh does not redate usage or manufacture new training samples. */
export function refreshWorkspaceQuotas(state,quotas,now=Date.now()) {
 const retained=compactQuotaHistory([...(state.quota_history??[]),...quotas],{at:now});
 return {...state,quota_history:retained.records,quota_coverage_gaps:retained.coverage_gaps,
  quota_forecasts:forecastQuotaWindows(retained.records,{at:now,max_age_ms:120000})};
}
export function publicWorkspace(state,{taskKey,details=false,now=Date.now()}={}) {
  if(!state || state.schema_version!==1)return {status:'unavailable',tasks:[],daily:[],availability_reason:'monitor_not_started'};
  const freshness=sourceFreshness(state,now),stale=freshness.stale;
  const tasks=(Array.isArray(state.tasks)?state.tasks:[]).filter(t=>isHashedIdentity(t?.task_key??'')&&(!taskKey||t.task_key===taskKey));
  const hostTasks=tasks.map(t=>({...t,host_observation:t.host==='claude'?publicClaudeStatus(t.host_observation,{now}):null}));
  const output={schema_version:1,status:stale?'partial':['exact','partial','unavailable'].includes(state.status)?state.status:'unavailable',observed_at:state.observed_at,stale,source_freshness:freshness.status,time_zone:state.time_zone,
    tasks:hostTasks,daily:(Array.isArray(state.daily)?state.daily:[]).filter(d=>isHashedIdentity(d?.task_key??'')&&(!taskKey||d.task_key===taskKey)),
    quota_windows:(Array.isArray(state.quota_history)?state.quota_history:[]).slice(-20),quota_forecasts:state.quota_forecasts,
    calibration:state.calibration,quota_calibration:state.quota_calibration,quota_coverage_gaps:state.quota_coverage_gaps,scan_metrics:state.scan_metrics,capture_scope:state.capture_scope,coverage_gaps:state.coverage_gaps,limitations:state.limitations,
    ...(details?{responses:(Array.isArray(state.records)?state.records:[]).filter(validRecord).filter(r=>!taskKey||r.task_key===taskKey).slice(-2000),detail_limit:2000}:{}),
    retention:state.retention};
  return project(stale||workspaceFreshness(state.observed_at,now).stale?staleRates(output):output);
}

/** Explicit local audit identity, not an assertion about the calling MCP task. */
export function workspaceTaskReport(state,taskKey,{current=false,turnKey=null,now=Date.now()}={}) {
  if(!isHashedIdentity(taskKey??''))return {status:'unavailable',reason:'invalid_task_identity'};
  const snapshot=publicWorkspace(state,{taskKey,now});
  const task=snapshot.tasks?.[0];
  if(!task)return {status:'unavailable',reason:'task_not_observed',task_key:taskKey};
  let rows=(Array.isArray(state.records)?state.records:[]).filter(validRecord).filter(r=>r.task_key===taskKey).map(cleanRecord);
  let root=null,selectedTurn=null;
  if(turnKey&&!isHashedIdentity(turnKey))return {status:'unavailable',reason:'invalid_turn_identity',task_key:taskKey};
  if(turnKey){rows=rows.filter(r=>r.root_key===turnKey||r.turn_key===turnKey);if(!rows.length)return {status:'unavailable',reason:'requested_turn_not_observed',task_key:taskKey};root=rows.every(r=>r.root_key===rows[0].root_key)?rows[0].root_key:null;selectedTurn=turnKey;}
  else if(current){
    const main=rows.filter(r=>r.role==='main').sort((a,b)=>a.observed_at-b.observed_at).at(-1);
    root=main?.root_key??null;selectedTurn=main?.turn_key??null;
    rows=main?rows.filter(r=>root?r.root_key===root:r.source_key===main.source_key&&r.turn_key===selectedTurn):[];
  }
  const complete=rows.length>0&&rows.every(r=>r.completed);
  const captureAt=task.host==='claude'?Math.min(...rows.map(r=>r.captured_at??0)):null;
  const verified=Boolean(state.source_validation)&&!snapshot.stale;
  const stale=snapshot.stale||Boolean(!verified&&(current&&task.stale||task.host==='claude'&&(!captureAt||workspaceFreshness(captureAt,now).stale)));
  const scopedBaseStale=workspaceFreshness(state.observed_at,now).stale||snapshot.stale||Boolean(task.host!=='claude'&&current&&task.stale);
  const scopedRateOptions={now:state.observed_at,startedAt:state.rate_observation_started_at,
    coverage:task.coverage_status==='exact',stale:scopedBaseStale};
  const activity=recentActivity(rows,{...scopedRateOptions,
    stale:staleRateCapture(rows,task.host,state.observed_at,scopedBaseStale)});
  const scopedGroups=keys=>withRecentRates(rows,keys,scopedRateOptions,snapshot.quota_calibration??[],task.host);
  return {...((current||turnKey)?{...bucket(rows),...profileHistory(rows,{includeTransitions:true}),models:scopedGroups(['role','model','effort','service_tier']),
      recent_activity:activity,quota_rate_estimates:taskQuotaRates(activity,snapshot.quota_calibration??[],{host:task.host}),
      sources:scopedGroups(['source_key','parent_source','role','model','effort','service_tier'])}:{...task,...profileHistory(rows,{includeTransitions:true})}),
    status:rows.length?(!stale&&task.coverage_status==='exact'&&rows.every(r=>r.quality==='exact')?'exact':'partial'):'unavailable',
    identity_basis:'explicit_local_task_id',host:task.host,task_key:taskKey,scope:turnKey?(root?'explicit_request_group':'explicit_observed_turn'):current?(root?'latest_observed_request_group':'latest_observed_turn'):'retained_task_history',
    observed_at:snapshot.observed_at,stale,captured_at:captureAt,root_key:root,turn_key:selectedTurn,is_final:complete&&rows.every(r=>r.quality==='exact')&&task.coverage_status==='exact'&&!stale,host_observation:task.host_observation,
    current_response_unflushed:'unavailable',coverage_gaps:task.coverage_gaps??snapshot.coverage_gaps,
    quota_attribution:'account_shared_unavailable',quota_percent:null};
}
