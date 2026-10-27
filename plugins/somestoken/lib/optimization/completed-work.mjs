import {createHash} from 'node:crypto';
import {sumUsage,isValidUsage,isHashedIdentity} from '../core.mjs';
import {estimateAutoReviewCredits} from '../usage/credits.mjs';

const LABEL=/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const HOSTS=new Set(['codex','claude']);
const ROLES=new Set(['main','subagent']);
const count=n=>Number.isSafeInteger(n)&&n>=0;
const reasoningStatus=(rows,host)=>host==='claude'||rows.some(r=>r.reasoning_usage_status==='unmeasured')?'unmeasured':'observed';

function observedUsage(rows,host) {
  const usage=sumUsage(rows.map(r=>r.usage));
  if(reasoningStatus(rows,host)==='unmeasured')usage.reasoning_output_tokens=null;
  return usage;
}

function stableSerialize(value) {
  if(Array.isArray(value))return `[${value.map(stableSerialize).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableSerialize(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function recordFingerprint(r) {
  return stableSerialize({...r,host:r.host??'codex'});
}

function roundedSharePercent(numerator,denominator) {
  if(!count(numerator)||!count(denominator)||denominator<1)return null;
  return Math.round((numerator/denominator)*100000)/1000;
}

function contribution(rows,host,totalTokens,newInputTokens) {
  const usage=observedUsage(rows,host);
  const newInput=usage.input_tokens-usage.cached_input_tokens;
  return {
    response_count:rows.length,
    reasoning_usage_status:reasoningStatus(rows,host),
    usage,
    new_input_tokens:newInput,
    observed_total_token_share_percent:roundedSharePercent(usage.total_tokens,totalTokens),
    observed_new_input_share_percent:roundedSharePercent(newInput,newInputTokens),
    unknown_model_response_count:rows.filter(r=>r.model==='unknown').length,
    unknown_effort_response_count:rows.filter(r=>r.effort==='unknown').length,
  };
}

function agentContributions(rows,host,usage) {
  const main=rows.filter(r=>r.role==='main');
  const review=rows.filter(r=>r.role==='subagent'&&host==='codex'&&r.model==='codex-auto-review');
  const other=rows.filter(r=>r.role==='subagent'&&!(host==='codex'&&r.model==='codex-auto-review'));
  const totalTokens=usage.consistent===true&&count(usage.total_tokens)&&usage.total_tokens>0?usage.total_tokens:null;
  const newInput=usage.consistent===true
    &&count(usage.input_tokens)&&count(usage.cached_input_tokens)
    &&usage.input_tokens>=usage.cached_input_tokens
    &&count(usage.input_tokens-usage.cached_input_tokens)
    &&usage.input_tokens-usage.cached_input_tokens>0
    ?usage.input_tokens-usage.cached_input_tokens:null;
  const hostReview=contribution(review,host,totalTokens,newInput);
  return {
    main:contribution(main,host,totalTokens,newInput),
    host_review:{...hostReview,
      ...(review.length?{estimated_auto_review_credits:estimateAutoReviewCredits(hostReview.usage)}:{})},
    other_subagent:contribution(other,host,totalTokens,newInput),
  };
}

function unboundInvalidCounts(value) {
  const source=value?.unbound_invalid_response_count_by_host;
  if(!source||typeof source!=='object'||Array.isArray(source))return null;
  return {codex:count(source.codex)?source.codex:null,claude:count(source.claude)?source.claude:null,unknown:count(source.unknown)?source.unknown:null};
}

/** The full observation of one completed request group. */
function completedObservation(state,group,rows,tasks,unboundInvalidByHost) {
  const first=rows[0],host=group.host,task=tasks.get(`${host}:${first.task_key}`);
  const gaps=Array.isArray(task?.coverage_gaps)?task.coverage_gaps.filter(g=>typeof g==='string'&&/^[a-z0-9_:-]{1,128}$/.test(g)):[];
  let exact=!unboundInvalidByHost[host]&&!unboundInvalidByHost.unknown&&!group.duplicateRisk&&task?.coverage_status==='exact'&&Array.isArray(task.coverage_gaps)&&!task.coverage_gaps.length
    &&rows.every(r=>r.quality==='exact'&&r.validation_status!=='historical_unverified'&&r.record_basis!=='legacy_counter_event');
  const last=rows.every(r=>count(r.completed_at)&&r.completed_at>=r.observed_at&&r.completed_at<=state.observed_at)
    ?rows.reduce((latest,r)=>Math.max(latest,r.completed_at),0):null;
  const profiles=new Map();
  for(const r of rows){const key=JSON.stringify([r.role,r.model,r.effort,r.service_tier]);const p=profiles.get(key)??[];p.push(r);profiles.set(key,p);}
  const profileRows=[...profiles.values()].map(p=>({role:p[0].role,model:p[0].model,effort:p[0].effort,service_tier:p[0].service_tier,
    response_count:p.length,reasoning_usage_status:reasoningStatus(p,host),usage:observedUsage(p,host)})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const usage=observedUsage(rows,host);
  const mainUsage=observedUsage(rows.filter(r=>r.role==='main'),host),childUsage=observedUsage(rows.filter(r=>r.role==='subagent'),host);
  exact&&=usage.consistent&&mainUsage.consistent&&childUsage.consistent&&profileRows.every(p=>p.usage.consistent);
  const digest=createHash('sha256').update(JSON.stringify({host,task:first.task_key,root:first.root_key,
    records:rows.map(r=>r.record_key).sort(),profiles:profileRows,last,exact,gaps})).digest('hex');
  return {record_kind:'passive_completed_work_observation',host,task_key:first.task_key,root_key:first.root_key,
    observed_at:state.observed_at,completed_at_ms:last,source_digest:digest,response_count:rows.length,
    main_response_count:rows.filter(r=>r.role==='main').length,subagent_response_count:rows.filter(r=>r.role==='subagent').length,
    profiles:profileRows.slice(0,64),omitted_profiles:Math.max(0,profileRows.length-64),usage,total_tokens:usage.total_tokens,new_input_tokens:usage.input_tokens-usage.cached_input_tokens,
    reasoning_usage_status:reasoningStatus(rows,host),
    main_usage:mainUsage,subagent_usage:childUsage,
    agent_contributions:agentContributions(rows,host,usage),agent_contributions_basis:'observed_roles_and_model_labels',
    completion_status:'recorded_complete',coverage_status:exact?'exact':'partial',coverage_gaps:gaps,
    usage_basis:exact?'observed_request_group':'observed_lower_bound',is_final:false,
    acceptance_status:'unverified',all_attempt_cost_status:'unavailable',comparison_eligible:false,net_token_savings_percent:null};
}

/** Retrospective observations only. Host completion cannot establish acceptance,
 * equivalent work, full retry cost, or eligibility for prospective experiments. */
export function completedWorkObservations(state,{perTask=10,limit=1000}={}) {
  if(!count(state?.observed_at)||!Array.isArray(state?.records)||!Array.isArray(state?.tasks)
    ||!Number.isInteger(perTask)||perTask<1||perTask>20||!Number.isInteger(limit)||limit<1||limit>1000)return null;
  // The collector calls this with every retained response: keep per-row work
  // allocation-free (no helper object or composite key string per row).
  const valid=r=>{
    const host=r?.host??'codex';
    return HOSTS.has(host)&&['record_key','task_key','source_key','turn_key'].every(k=>isHashedIdentity(r?.[k]))
      &&ROLES.has(r.role)&&['model','effort','service_tier'].every(k=>typeof r?.[k]==='string'&&LABEL.test(r[k]))
      &&count(r.observed_at)&&r.observed_at<=state.observed_at&&isValidUsage(r.usage,{reasoningObserved:host!=='claude'})
      &&typeof r.completed==='boolean';
  };
  // Rows are tracked by position so a repeated object still counts as a repeat.
  const records=state.records,groups=[],groupIndex={codex:new Map(),claude:new Map()},identities={codex:new Map(),claude:new Map()};
  const duplicates=new Map(),tasks=new Map(state.tasks.map(t=>[`${t.host??'codex'}:${t.task_key}`,t]));
  const unboundInvalidByHost={codex:0,claude:0,unknown:0};
  const groupOf=r=>{const host=r?.host??'codex';return HOSTS.has(host)&&isHashedIdentity(r?.task_key)&&isHashedIdentity(r?.root_key)?groupIndex[host].get(r.task_key)?.get(r.root_key):undefined;};
  let invalid=0,unfinished=0,unbound=0,incomplete=0;
  for(let index=0;index<records.length;index++) {
    const r=records[index],host=r?.host??'codex',hostBound=HOSTS.has(host);
    const rootBound=isHashedIdentity(r?.root_key),bindable=hostBound&&isHashedIdentity(r?.task_key)&&rootBound;
    if(r?.completed===false)unfinished++;
    if(!rootBound)unbound++;
    if(!valid(r)){invalid++;if(!bindable)unboundInvalidByHost[hostBound?host:'unknown']++;}
    if(bindable) {
      let roots=groupIndex[host].get(r.task_key);
      if(!roots)groupIndex[host].set(r.task_key,roots=new Map());
      let group=roots.get(r.root_key);
      if(!group){group={host,task_key:r.task_key,root_key:r.root_key,rows:[],rejected:false,duplicateRisk:false};roots.set(r.root_key,group);groups.push(group);}
      group.rows.push(index);
    }
    if(hostBound&&isHashedIdentity(r?.record_key)) {
      const prior=identities[host].get(r.record_key);
      if(prior===undefined)identities[host].set(r.record_key,index);
      else {const list=duplicates.get(prior)??[prior];list.push(index);duplicates.set(prior,list);}
    }
  }
  identities.codex.clear();identities.claude.clear();

  // Resolve identity collisions after binding all rows. A conflicting duplicate
  // must invalidate every bound group it touched, regardless of input order.
  const conflicting=new Set(),exactDuplicates=new Set();
  for(const entries of duplicates.values()) {
    const conflict=new Set(entries.map(index=>recordFingerprint(records[index]))).size>1;
    for(const [position,index] of entries.entries()) {
      const r=records[index];
      if(position>0&&valid(r))invalid++;
      if(conflict)conflicting.add(index);
      else if(position>0)exactDuplicates.add(index);
      const group=groupOf(r);
      if(group) {
        if(conflict)group.rejected=true;
        else if(position>0)group.duplicateRisk=true;
      }
    }
  }
  duplicates.clear();

  const candidates=[],hostCounts={codex:0,claude:0},rejectedCounts={codex:0,claude:0};
  for(const group of groups) {
    const rows=group.rows.filter(index=>valid(records[index])&&!exactDuplicates.has(index)).map(index=>records[index]);
    const hasInvalid=group.rows.some(index=>!valid(records[index])||conflicting.has(index));
    const hasUnfinished=group.rows.some(index=>records[index]?.completed===false);
    const hasUnknownCompletion=group.rows.some(index=>typeof records[index]?.completed!=='boolean');
    const hasMain=rows.some(r=>r.role==='main');
    const allCompleted=rows.every(r=>r.completed===true)&&!hasUnfinished&&!hasUnknownCompletion;
    group.rejected=group.rejected||hasInvalid;
    if(group.rejected)rejectedCounts[group.host]++;
    if(!allCompleted||!hasMain)incomplete++;
    if(group.rejected||!allCompleted||!hasMain)continue;
    // Only the ordering fields stay live for every group; the full observation
    // is built for the groups that survive the per-task and global limits.
    const observation=completedObservation(state,group,rows,tasks,unboundInvalidByHost);
    candidates.push({host:group.host,task_key:group.task_key,completed_at_ms:observation.completed_at_ms,source_digest:observation.source_digest,group,rows});
    hostCounts[group.host]++;
  }
  candidates.sort((a,b)=>(b.completed_at_ms??0)-(a.completed_at_ms??0)||a.source_digest.localeCompare(b.source_digest));
  const counts=new Map(),observations=[];
  for(const row of candidates){const key=`${row.host}:${row.task_key}`,n=counts.get(key)??0;
    if(n>=perTask||observations.length>=limit)continue;counts.set(key,n+1);observations.push(completedObservation(state,row.group,row.rows,tasks,unboundInvalidByHost));}
  return {schema_version:1,observed_at:state.observed_at,measurement_basis:'retained_completed_request_groups',
    per_task_limit:perTask,global_limit:limit,order:'latest_completed_at_desc',latest_per_task:true,
    nonrepresentative_tail:candidates.length>observations.length,
    total_completed_groups:candidates.length,completed_groups_by_host:hostCounts,returned_groups:observations.length,
    omitted_groups:candidates.length-observations.length,truncated:candidates.length>observations.length,
    invalid_response_count:invalid,unfinished_response_count:unfinished,unbound_response_count:unbound,incomplete_group_count:incomplete,
    unbound_invalid_response_count:unboundInvalidByHost.codex+unboundInvalidByHost.claude+unboundInvalidByHost.unknown,
    unbound_invalid_response_count_by_host:unboundInvalidByHost,
    rejected_group_count:rejectedCounts.codex+rejectedCounts.claude,rejected_groups_by_host:rejectedCounts,
    observations};
}

/**
 * completedWorkObservations for rows already unique by record_key, fed one
 * task at a time: `count` every retained row first, then `addTask` each task's
 * rows with its summary, then `result`. Output equals the whole-state form.
 */
export function completedWorkBuilder(observedAt,{perTask=10,limit=1000}={}) {
  const state={observed_at:observedAt};
  const valid=r=>{
    const host=r?.host??'codex';
    return HOSTS.has(host)&&['record_key','task_key','source_key','turn_key'].every(k=>isHashedIdentity(r?.[k]))
      &&ROLES.has(r.role)&&['model','effort','service_tier'].every(k=>typeof r?.[k]==='string'&&LABEL.test(r[k]))
      &&count(r.observed_at)&&r.observed_at<=state.observed_at&&isValidUsage(r.usage,{reasoningObserved:host!=='claude'})
      &&typeof r.completed==='boolean';
  };
  const unboundInvalidByHost={codex:0,claude:0,unknown:0},hostCounts={codex:0,claude:0},rejectedCounts={codex:0,claude:0};
  let invalid=0,unfinished=0,unbound=0,incomplete=0,total=0;
  const kept=[],order=(a,b)=>(b.completed_at_ms??0)-(a.completed_at_ms??0)||a.source_digest.localeCompare(b.source_digest);
  return {
    count(rows) {
      for(const r of rows){
        const host=r?.host??'codex',hostBound=HOSTS.has(host),rootBound=isHashedIdentity(r?.root_key);
        if(r?.completed===false)unfinished++;
        if(!rootBound)unbound++;
        if(!valid(r)){invalid++;if(!(hostBound&&isHashedIdentity(r?.task_key)&&rootBound))unboundInvalidByHost[hostBound?host:'unknown']++;}
      }
    },
    addTask(rows,task) {
      const groups=new Map(),tasks=new Map(task?[[`${task.host??'codex'}:${task.task_key}`,task]]:[]);
      for(const r of rows){
        const host=r?.host??'codex';
        if(!(HOSTS.has(host)&&isHashedIdentity(r?.task_key)&&isHashedIdentity(r?.root_key)))continue;
        const key=`${host}:${r.task_key}:${r.root_key}`,group=groups.get(key)??{host,task_key:r.task_key,root_key:r.root_key,rows:[]};
        group.rows.push(r);groups.set(key,group);
      }
      const candidates=[];
      for(const group of groups.values()){
        const members=group.rows.filter(valid),hasInvalid=members.length<group.rows.length;
        const hasUnfinished=group.rows.some(r=>r?.completed===false),hasUnknownCompletion=group.rows.some(r=>typeof r?.completed!=='boolean');
        const hasMain=members.some(r=>r.role==='main'),allCompleted=members.every(r=>r.completed===true)&&!hasUnfinished&&!hasUnknownCompletion;
        if(hasInvalid)rejectedCounts[group.host]++;
        if(!allCompleted||!hasMain)incomplete++;
        if(hasInvalid||!allCompleted||!hasMain)continue;
        candidates.push(completedObservation(state,{...group,duplicateRisk:false},members,tasks,unboundInvalidByHost));
        hostCounts[group.host]++;total++;
      }
      // Only a task's first perTask observations can survive the final selection.
      kept.push(...candidates.sort(order).slice(0,perTask));
    },
    result() {
      kept.sort(order);
      const counts=new Map(),observations=[];
      for(const row of kept){const key=`${row.host}:${row.task_key}`,n=counts.get(key)??0;
        if(n>=perTask||observations.length>=limit)continue;counts.set(key,n+1);observations.push(row);}
      return {schema_version:1,observed_at:state.observed_at,measurement_basis:'retained_completed_request_groups',
        per_task_limit:perTask,global_limit:limit,order:'latest_completed_at_desc',latest_per_task:true,
        nonrepresentative_tail:total>observations.length,
        total_completed_groups:total,completed_groups_by_host:hostCounts,returned_groups:observations.length,
        omitted_groups:total-observations.length,truncated:total>observations.length,
        invalid_response_count:invalid,unfinished_response_count:unfinished,unbound_response_count:unbound,incomplete_group_count:incomplete,
        unbound_invalid_response_count:unboundInvalidByHost.codex+unboundInvalidByHost.claude+unboundInvalidByHost.unknown,
        unbound_invalid_response_count_by_host:unboundInvalidByHost,
        rejected_group_count:rejectedCounts.codex+rejectedCounts.claude,rejected_groups_by_host:rejectedCounts,
        observations};
    },
  };
}

export function completedWorkSummary(value,{host='all'}={}) {
  const valid=value?.schema_version===1&&Array.isArray(value?.observations)&&['all','codex','claude'].includes(host);
  const rows=valid?value.observations.filter(r=>r&&['codex','claude'].includes(r.host)&&(host==='all'||r.host===host)):[];
  const total=valid?(host==='all'?value.total_completed_groups:value.completed_groups_by_host?.[host]):null;
  const rejected=valid?(host==='all'?value.rejected_group_count:value.rejected_groups_by_host?.[host]):null;
  const unboundCounts=valid?unboundInvalidCounts(value):null;
  const unboundInvalid=valid?(host==='all'?value.unbound_invalid_response_count
    :unboundCounts&&[unboundCounts[host],unboundCounts.unknown].every(count)?unboundCounts[host]+unboundCounts.unknown:null):null;
  return {status:valid?'observational':'unavailable',measurement_basis:'retained_completed_request_groups',
    observed_at:valid&&count(value.observed_at)?value.observed_at:null,
    per_task_limit:valid&&count(value.per_task_limit)?value.per_task_limit:null,
    global_limit:valid&&count(value.global_limit)?value.global_limit:null,
    order:valid&&value.order==='latest_completed_at_desc'?value.order:null,
    latest_per_task:valid&&typeof value.latest_per_task==='boolean'?value.latest_per_task:null,
    nonrepresentative_tail:valid&&typeof value.nonrepresentative_tail==='boolean'?value.nonrepresentative_tail:null,
    total_completed_groups:count(total)?total:null,returned_groups:valid?rows.length:null,
    omitted_groups:count(total)?Math.max(0,total-rows.length):null,
    rejected_group_count:count(rejected)?rejected:null,
    unbound_invalid_response_count:count(unboundInvalid)?unboundInvalid:null,
    unbound_invalid_response_count_by_host:unboundCounts,
    partial_groups:valid?rows.filter(r=>r.coverage_status!=='exact').length:null,
    comparison_eligible_groups:valid?0:null,net_token_savings_percent:null,
    reason_codes:['acceptance_not_verified','all_attempt_cost_unavailable','prospective_controls_required']};
}
