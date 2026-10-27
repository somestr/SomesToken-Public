import {ACTIVE_POLICY_VERSION} from './active-policy.mjs';
import {compareRuns} from './pairing.mjs';
import {measureReduction} from './reductions.mjs';
import {accountQuotaChange} from '../usage/task-rates.mjs';
import {isDeepStrictEqual as same} from 'node:util';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const PLAN='codex_pro_20x';
const METRIC='relative_account_quota_reduction_per_equivalent_accepted_work';
// Quota readings count with the host's documented precision, or as whole
// percents bounded by ±1 pp each (owner decision 2026-09-29): an unchanged
// counter still proves nothing because the lower bound must stay above zero.
const precise=q=>finite(q?.precision_percent)&&q.precision_percent>=0&&q.precision_percent<=100
  &&(q.precision_source==='host_contract'||(q.precision_source==='whole_percent_observed'&&q.precision_percent===1&&Number.isInteger(q.used_percent)));
// A study may span weekly windows: consecutive trials either share the
// reading between them or the next one starts after the previous window reset.
const continues=(previous,next)=>same(previous,next)||(previous&&next&&previous.provider===next.provider&&previous.account_id===next.account_id
  &&previous.limit_id===next.limit_id&&next.resets_at_ms>previous.resets_at_ms&&next.snapshot_at_ms>=previous.resets_at_ms);
const base=()=>({status:'blocked',required_plan:PLAN,metric:METRIC,required_savings_percent:5,
  verified_savings_percent:null,publication_authorized:false,verification_basis:'reviewed_local_evidence',reason_codes:[]});

/** Predeclare a small A/A stage (SomesToken off) before held-out off/on pairs
 * (owner decision 2026-09-29: the arms are SomesToken off and SomesToken on). This
 * creates a protocol only: it cannot create tasks or change host settings. */
export function createEfficiencyStudyProtocol(input={}) {
  if(typeof input.plugin_version!=='string'||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.plugin_version)
    ||typeof input.source_tree!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.source_tree)||!hash(input.acceptance_fingerprint)
    ||!integer(input.registered_at)||!integer(input.order_seed)||input.order_seed>0xffffffff
    ||!hash(input.runtime_fingerprint)||typeof input.model!=='string'||!/^gpt-[A-Za-z0-9._-]{1,70}$/.test(input.model)
    ||!['standard','fast','ultrafast','other_observed'].includes(input.service_tier)
    ||!finite(input.max_account_quota_pp)||input.max_account_quota_pp<=0||input.max_account_quota_pp>2000
    ||!integer(input.max_elapsed_ms)||input.max_elapsed_ms<1||input.max_elapsed_ms>180*86400000)throw Error('invalid_study_protocol');
  const schedule=[];
  for(const phase of ['aa','ab'])for(let pair=0;pair<(phase==='aa'?2:10);pair++) {
    const efforts=(pair+input.order_seed)%2?['medium','high']:['high','medium'];
    for(const effort of efforts) {
      const modes=phase==='aa'?['off','off']:(pair+input.order_seed)%2?['on','off']:['off','on'];
      for(const mode of modes)schedule.push({trial_id:`${phase}-${effort}-${pair}-${schedule.length}`,phase,pair,effort,mode});
    }
  }
  return {schema_version:1,plugin_version:input.plugin_version,source_tree:input.source_tree,
    registered_at:input.registered_at,acceptance_fingerprint:input.acceptance_fingerprint,order_seed:input.order_seed,
    model:input.model,service_tier:input.service_tier,runtime_fingerprint:input.runtime_fingerprint,
    max_account_quota_pp:input.max_account_quota_pp,max_elapsed_ms:input.max_elapsed_ms,
    policy_version:ACTIVE_POLICY_VERSION,arms:'somestoken_off_on',collection:'host_collector',ponytail_mode:'off',metric:METRIC,
    aa_max_relative_difference:0.05,minimum_pairs_per_effort:10,max_model_runs:schedule.length,schedule};
}
function validProtocol(protocol) {
  try{return same(protocol,createEfficiencyStudyProtocol(protocol));}catch{return false;}
}

export function efficiencyStudyReadiness(protocol,input={}) {
  const reasons=[],q=input.quota,now=input.now??Date.now();
  if(!validProtocol(protocol))reasons.push('invalid_study_protocol');
  if(input.runtimes_ready!==true||input.acceptance_ready!==true)reasons.push('local_acceptance_not_ready');
  if(!q||!integer(now)||!integer(q.snapshot_at_ms)||now<q.snapshot_at_ms||now-q.snapshot_at_ms>120000
    ||!integer(q.resets_at_ms)||q.resets_at_ms<=now)reasons.push('fresh_quota_endpoint_missing');
  if(protocol?.registered_at>now||q?.snapshot_at_ms<=protocol?.registered_at)reasons.push('quota_interval_not_prospective');
  if(q?.used_percent===100)reasons.push('quota_window_exhausted');
  if(accountQuotaChange(q,q).reason_codes.includes('quota_endpoints_missing')||q?.provider!=='codex'||q?.plan_id!=='pro')reasons.push('quota_identity_unavailable');
  if(!precise(q))reasons.push('quota_precision_unavailable');
  if(input.account_coverage!=='provider_account_complete')reasons.push('account_attribution_unavailable');
  if(input.plan?.host_plan!=='pro'||input.plan?.owner_plan!==PLAN||input.plan?.basis!=='owner_declared')reasons.push('plan_provenance_missing');
  if(!integer(input.used_model_runs??0)||(input.used_model_runs??0)>=protocol?.max_model_runs
    ||!finite(input.spent_quota_pp??0)||(input.spent_quota_pp??0)<0||(input.spent_quota_pp??0)>=protocol?.max_account_quota_pp
    ||!integer(input.elapsed_ms??0)||(input.elapsed_ms??0)>=protocol?.max_elapsed_ms)reasons.push('study_budget_exhausted');
  if(protocol?.schedule?.[input.used_model_runs??0]?.phase==='ab'&&input.aa_passed!==true)reasons.push('aa_noise_check_required');
  return {status:reasons.length?'blocked':'ready',reason_codes:[...new Set(reasons)],
    eligible_next_model_runs:reasons.length?0:1,publication_authorized:false};
}

/** Validates a pinned, human-reviewed evidence document. Provider authenticity
 * and complete account coverage must be reviewed outside this pure arithmetic
 * function; a local token share or quiet device is never sufficient evidence. */
export function evaluateQuotaReleaseEvidence(evidence,options={}) {
  const result=base(),reasons=new Set();
  const reject=reason=>reasons.add(reason),p=evidence?.protocol,trials=evidence?.trials;
  if(!evidence)return {...result,reason_codes:['verified_account_quota_savings_missing']};
  if(options.reviewed!==true)reject('quota_evidence_review_missing');
  if(evidence.schema_version!==1||!validProtocol(p)||!Array.isArray(trials)||trials.length!==p?.schedule?.length)
    return {...result,reason_codes:[...reasons,'invalid_or_incomplete_study']};
  if(p.plugin_version!==options.plugin_version||p.source_tree!==options.source_tree)reject('quota_evidence_source_mismatch');
  if(evidence.plan?.host_plan!=='pro'||evidence.plan?.owner_plan!==PLAN||evidence.plan?.basis!=='owner_declared')reject('plan_provenance_missing');
  const now=options.now??Date.now(),last=trials.at(-1)?.after?.snapshot_at_ms;
  if(!integer(now)||!integer(last)||last>now||now-last>30*86400000)reject('quota_evidence_stale');
  const seen=new Set(),groups=new Map();let spent=0;
  for(let i=0;i<trials.length;i++) {
    const t=trials[i],slot=p.schedule[i],run=t?.run;
    if(!t||!run){reject('trial_missing');continue;}
    if(!Object.keys(slot).every(key=>t[key]===slot[key]))reject('study_order_changed');
    if(t.account_coverage!=='provider_account_complete'||t.all_attempts_included!==true)reject('account_attribution_unavailable');
    if(t.accepted_units!==1||run.acceptance_fingerprint!==p.acceptance_fingerprint||run.outcome!=='pass')reject('accepted_work_mismatch');
    if(run.host!=='codex'||run.effort!==slot.effort||run.ponytail_mode!=='off'||run.model!==p.model
      ||run.service_tier!==p.service_tier||t.runtime_fingerprint!==p.runtime_fingerprint
      ||run.efficiency_policy_version!==(slot.mode==='off'?0:p.policy_version)||run.somestoken_plugin!==slot.mode)reject('study_controls_changed');
    const change=accountQuotaChange(t.before,t.after);
    if(change.status!=='observed'||change.lower_change_pp===null||change.lower_change_pp<=0
      ||t.before?.provider!=='codex'||t.before?.plan_id!=='pro'
      ||!precise(t.before)||!precise(t.after))reject('quota_endpoints_unusable');
    if(!integer(run.started_at)||!integer(run.closed_at)||p.registered_at>=run.started_at
      ||t.before?.snapshot_at_ms!==run.started_at||t.after?.snapshot_at_ms<run.closed_at)reject('quota_interval_not_prospective');
    if(i&&!continues(trials[i-1]?.after,t.before))reject('study_account_timeline_discontinuous');
    for(const id of [...new Set([run.task_key,run.root_key]),...(Array.isArray(run.receipt_ids)?run.receipt_ids:[])]) {
      if(!id||seen.has(id))reject('overlapping_trial_evidence');seen.add(id);
    }
    spent+=change.observed_change_pp??0;
    const key=`${slot.phase}:${slot.effort}:${slot.pair}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({...t,change});
  }
  if(spent>p.max_account_quota_pp||last-trials[0]?.before?.snapshot_at_ms>p.max_elapsed_ms)reject('study_budget_exhausted');
  const strata=new Map(['high','medium'].map(effort=>[effort,{effort,pairs:0,before_lower:0,after_upper:0}]));
  for(const group of groups.values()) {
    if(group.length!==2){reject('pair_missing');continue;}
    const aa=group[0].phase==='aa';
    const before=aa?group[0]:group.find(t=>t.mode==='off'),after=aa?group[1]:group.find(t=>t.mode==='on');
    if(!before||!after){reject('control_group_missing');continue;}
    const pair=compareRuns(before.run,after.run,{comparison_axis:'efficiency_policy_version'});
    if(pair.reasons.some(reason=>!aa||reason!=='axis_not_changed'))reject('accepted_work_not_comparable');
    if(aa) {
      const a=before.change.observed_change_pp,b=after.change.observed_change_pp;
      if(!finite(a)||a<=0||!finite(b)||Math.abs(b-a)/a>p.aa_max_relative_difference)reject('aa_noise_check_failed');
    } else {
      const measurement=measureReduction({...pair,pair_id:before.trial_id+':'+after.trial_id});
      if(measurement.benefit_reason_codes?.some(reason=>reason.endsWith('_increased')||reason.endsWith('_unavailable')))reject('outcome_or_cost_guard_failed');
      const totals=strata.get(before.effort);
      if(!totals){reject('study_controls_changed');continue;}
      totals.pairs++;totals.before_lower+=before.change.lower_change_pp??0;totals.after_upper+=after.change.upper_change_pp??Infinity;
    }
  }
  result.strata=[...strata.values()].map(({effort,pairs,before_lower,after_upper})=>({effort,pairs,
    conservative_savings_percent:before_lower>0&&finite(after_upper)?100*(1-after_upper/before_lower):null}));
  if(result.strata.some(s=>s.pairs<p.minimum_pairs_per_effort||s.conservative_savings_percent===null||s.conservative_savings_percent<5))reject('minimum_quota_savings_not_verified');
  result.reason_codes=[...reasons];
  if(!reasons.size){result.status='eligible';result.verified_savings_percent=Math.min(...result.strata.map(s=>s.conservative_savings_percent));}
  return result;
}
