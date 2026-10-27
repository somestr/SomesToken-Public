import {findComparablePairs} from './pairing.mjs';
import {measureReduction,summarizeReductions} from './reductions.mjs';
import {
  MAX_EXPERIMENT_RUNS,
  POLICY_CONTEXT_FIELDS,
  SUPPORTED_COMPARISON_AXES,
  normalizePolicyContext,
  OUTCOMES,
  VARIANTS,
  VERIFICATIONS,
  normalizeExperiment,
  normalizeExperimentRun,
  normalizeReduction,
  safeHost,
  safeOptimizationId,
} from './schema.mjs';
import { RECOMMENDATION_CATALOG } from '../efficiency/recommendations.mjs';

export function recommendationStatusForExperiment(experimentValue, measurements = []) {
  const experiment = normalizeExperiment(experimentValue);
  if (!experiment?.recommendation_id) return 'not_applied';
  const entries = Array.isArray(measurements) ? measurements.map(normalizeReduction) : [];
  if (entries.some((entry) => entry?.status === 'outcome_regressed' || entry?.outcome_relation === 'outcome_regressed')) return 'outcome_regressed';
  const summary = summarizeReductions(entries);
  if (summary.reason_codes.includes('mixed_comparison_context')) return 'incomparable';
  if (summary.valid_pairs) {
    const reduction = summary.median_token_reduction_percent;
    if (reduction === null) return 'incomparable';
    if (reduction > 0) return summary.benefit_status === 'supported_token_reduction' ? 'measured_positive' : 'applied';
    if (reduction < 0) return 'measured_negative';
    return 'measured_neutral';
  }
  if (experiment.state === 'active') return 'experiment_started';
  if (experiment.runs.some((run) => run.outcome === 'pass')) return 'applied';
  return 'incomparable';
}

function key(host, id) {
  return `${safeHost(host)}:${id}`;
}

function now(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function safeHostValue(value) {
  return value === 'codex' || value === 'claude' ? value : null;
}

function runId(id, variant, timestamp) {
  const suffix = Number.isSafeInteger(timestamp) ? timestamp.toString(36) : '0';
  return safeOptimizationId(`${id}-${variant}-${suffix}`) ?? safeOptimizationId(`${variant}-${suffix}`) ?? 'run';
}

const FROZEN_FIELDS = [
  'task_key', 'root_key', 'work_unit_id', 'acceptance_fingerprint', 'workload_subtype',
  'started_at', 'work_started_at', 'evidence_basis', 'host', 'workload_class', 'model', 'effort', 'agent_policy',
  'source_type', 'router_state', 'router_version', 'schema_version', 'usage_schema_version', 'adapter_version',
  'pricing_profile', 'service_tier', ...POLICY_CONTEXT_FIELDS,
];

export function startExperiment(state, input = {}) {
  const id = safeOptimizationId(input.experiment_id ?? input.id);
  const pilotEpoch = input.pilot_epoch === undefined ? null : safeOptimizationId(input.pilot_epoch);
  const host = safeHostValue(input.host);
  const variant = VARIANTS.includes(input.variant) ? input.variant : null;
  const recommendationId = safeOptimizationId(input.recommendation_id);
  if (!id) return { ok: false, error: 'invalid_experiment_id' };
  if (!host) return { ok: false, error: 'invalid_host' };
  if (!variant) return { ok: false, error: 'invalid_variant' };
  if (input.pilot_epoch !== undefined && (!pilotEpoch || !new RegExp(`^${host}-pilot-[1-9][0-9]{0,6}$`).test(pilotEpoch))) return { ok: false, error: 'invalid_pilot_epoch' };
  if (!SUPPORTED_COMPARISON_AXES.includes(input.comparison_axis)) return { ok: false, error: 'invalid_comparison_axis' };
  const policy = normalizePolicyContext(input);
  const invalidFields = POLICY_CONTEXT_FIELDS.filter(field => input[field] !== undefined && policy[field] === null);
  if (invalidFields.length) return { ok: false, error: 'invalid_policy_context', fields: invalidFields };
  if (input.recommendation_id !== undefined && (!recommendationId || !Object.hasOwn(RECOMMENDATION_CATALOG, recommendationId))) return { ok: false, error: 'invalid_recommendation_id' };
  const experimentKey = key(host, id);
  const existing = normalizeExperiment(state?.[experimentKey]);
  const timestamp = now(input.started_at);
  if (existing) {
    if (existing.pilot_epoch !== pilotEpoch && (existing.pilot_epoch !== null || pilotEpoch !== null)) return { ok: false, error: 'pilot_epoch_conflict' };
    const same = existing.workload_class === input.workload_class
      && existing.comparison_axis === input.comparison_axis
      && existing.recommendation_id === (safeOptimizationId(input.recommendation_id) ?? undefined);
    if (!same) return { ok: false, error: 'experiment_conflict' };
    const active=existing.runs.find(run=>run.variant===variant&&run.state==='active');
    if(active){const proposed=normalizeExperimentRun({...input,started_at:input.started_at === undefined ? active.started_at : input.started_at,work_started_at:input.work_started_at === undefined ? active.work_started_at : input.work_started_at,run_id:active.run_id});if(FROZEN_FIELDS.some(field=>proposed[field]!==active[field]))return {ok:false,error:'work_unit_conflict'};return {ok:true,duplicate:true,experiment:existing};}
    if (existing.runs.some((run) => run.variant !== variant && run.state === 'active')) return { ok: false, error: 'active_variant_exists' };
    existing.state = 'active';
    existing.recommendation_status = existing.recommendation_id ? 'experiment_started' : 'not_applied';
    const run = normalizeExperimentRun({ ...input, run_id: runId(id, variant, timestamp), started_at: timestamp, state: 'active' });
    existing.runs.push(run);
    existing.run_count = existing.runs.length;
    state[experimentKey] = normalizeExperiment(existing);
    return { ok: true, duplicate: false, created: false, experiment: state[experimentKey], run };
  }
  const experiment = normalizeExperiment({
    ...input,
    experiment_id: id,
    pilot_epoch: pilotEpoch,
    host,
    state: 'active',
    recommendation_status: safeOptimizationId(input.recommendation_id) ? 'experiment_started' : 'not_applied',
    started_at: timestamp,
    run_count: 1,
    attempt_evidence_complete: true,
    runs: [{ ...input, run_id: runId(id, variant, timestamp), variant, started_at: timestamp, state: 'active' }],
  });
  if (!experiment) return { ok: false, error: 'invalid_experiment_id' };
  state[experimentKey] = experiment;
  return { ok: true, duplicate: false, created: true, experiment, run: experiment.runs[0] };
}

export function beginExperimentWork(state,input={}) {
  const id=safeOptimizationId(input.experiment_id??input.id),host=safeHostValue(input.host);
  const experiment=id&&host?normalizeExperiment(state?.[key(host,id)]):null;
  const run=experiment?.runs.find(run=>run.state==='active');
  if(!run)return {ok:false,error:'no_active_run'};
  if(run.work_started_at!==null)return {ok:true,duplicate:true,run};
  const timestamp=now(input.work_started_at);
  if(timestamp<run.started_at)return {ok:false,error:'invalid_work_timing'};
  run.work_started_at=timestamp;state[key(host,id)]=normalizeExperiment(experiment);
  return {ok:true,run};
}

export function closeExperiment(state, input = {}) {
  const id = safeOptimizationId(input.experiment_id ?? input.id);
  const host = safeHostValue(input.host);
  if (!id || !host) return { ok: false, error: 'experiment_not_found' };
  const experimentKey = key(host, id);
  const experiment = normalizeExperiment(state?.[experimentKey]);
  if (!experiment) return { ok: false, error: 'experiment_not_found' };
  const active = [...experiment.runs].reverse().find((run) => run.state === 'active');
  if (!active) return { ok: false, error: 'no_active_run' };
  if (!OUTCOMES.includes(input.outcome)) return { ok: false, error: 'invalid_outcome' };
  if (!VERIFICATIONS.includes(input.verification)) return { ok: false, error: 'invalid_verification' };
  const numericObservations = ['total_tokens','input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens',
    'cache_write_input_tokens','main_tokens','subagent_tokens','rework_count','duration_ms','source_count','fanout','compactions',
    'calculated_provider_usage','retry_rate'];
  if (numericObservations.some(field => input[field] !== undefined
    && (!Number.isFinite(input[field]) || input[field] < 0
      || (!['calculated_provider_usage','retry_rate'].includes(field) && !Number.isSafeInteger(input[field]))))) {
    return {ok:false,error:'invalid_observation'};
  }
  const proposed = normalizeExperimentRun({...active,...Object.fromEntries(Object.entries(input).filter(([,value]) => value !== undefined))});
  if (proposed.token_components_consistent === false) return {ok:false,error:'invalid_usage_components'};
  const closedAt = now(input.closed_at);
  if(FROZEN_FIELDS.some(field=>input[field]!==undefined&&input[field]!==active[field]))return {ok:false,error:'work_unit_conflict'};
  if(closedAt<active.started_at||(active.work_started_at!==null&&closedAt<active.work_started_at))return {ok:false,error:'invalid_work_timing'};
  active.state = input.outcome === 'cancelled' ? 'cancelled' : 'closed';
  active.closed_at = closedAt;
  active.outcome = input.outcome;
  active.verification = input.verification;
  for (const field of ['token_quality', 'total_tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens', 'calculated_provider_usage', 'duration_ms', 'source_count', 'retry_rate', 'fanout', 'compactions', 'receipt_ids', 'coverage_status', 'main_tokens', 'subagent_tokens', 'rework_count']) {
    if (input[field] !== undefined) active[field] = input[field];
  }
  if(input.receipt_ids!==undefined)active.receipt_evidence_complete=normalizeExperimentRun({run_id:active.run_id,receipt_ids:input.receipt_ids}).receipt_evidence_complete;
  if(active.work_started_at!==null)active.duration_ms=closedAt-active.work_started_at;
  experiment.runs = experiment.runs.slice(-MAX_EXPERIMENT_RUNS);
  experiment.run_count = experiment.runs.length;
  if (input.close_experiment === true || experiment.runs.every((run) => run.state !== 'active')) experiment.state = input.outcome === 'cancelled' ? 'cancelled' : 'closed';
  experiment.closed_at = experiment.state === 'closed' || experiment.state === 'cancelled' ? closedAt : null;
  experiment.recommendation_status = experiment.recommendation_id
    ? (input.outcome === 'fail' ? 'outcome_regressed' : input.outcome === 'cancelled' ? 'incomparable' : input.outcome === 'pass' ? 'applied' : 'incomparable')
    : 'not_applied';
  state[experimentKey] = normalizeExperiment(experiment);
  return { ok: true, experiment: state[experimentKey], run: normalizeExperimentRun(active) };
}

export function cancelExperiment(state, input = {}) {
  return closeExperiment(state, { ...input, outcome: 'cancelled', verification: 'unknown' });
}

function currentExperimentStatus(experiment) {
  if (!experiment) return null;
  const measurements = findComparablePairs(experiment.runs, {
    comparison_axis: experiment.comparison_axis, experiment_id: experiment.experiment_id,
  }).map(measureReduction);
  return { ...experiment, recommendation_status: recommendationStatusForExperiment(experiment, measurements) };
}

export function listExperiments(state, host) {
  const values = Object.values(state ?? {}).map(normalizeExperiment).filter(Boolean).map(currentExperimentStatus);
  return values.filter((entry) => !host || entry.host === host).slice(-128);
}

export function experimentStatus(state, input = {}) {
  const id = safeOptimizationId(input.experiment_id ?? input.id);
  const host = safeHostValue(input.host);
  if (!id || !host) return { ok: false, error: 'experiment_not_found' };
  const experiment = normalizeExperiment(state?.[key(host, id)]);
  return experiment ? { ok: true, experiment: currentExperimentStatus(experiment) } : { ok: false, error: 'experiment_not_found' };
}

/** Read-only prospective pilot audit; never creates model work or evidence. */
export function pilotReadiness(state,host) {
  if(!state||typeof state!=='object')return {status:'data_unavailable',experiment_count:null,summary:summarizeReductions([]),blockers:['missing_pair'],causal_savings:'not_established',calibrated:false,model_calls:0};
  const experiments=listExperiments(state,host);
  const measurements=[];const blockers=new Set();
  for(const experiment of experiments){
    const pairs=findComparablePairs(experiment.runs,{comparison_axis:experiment.comparison_axis,experiment_id:experiment.experiment_id});
    if(!pairs.length)blockers.add('missing_pair');
    for(const pair of pairs){for(const reason of pair.reasons)blockers.add(reason);measurements.push(measureReduction(pair));}
  }
  const summary=summarizeReductions(measurements);
  return {status:summary.independent_pairs?'observations_available':'awaiting_prospective_samples',experiment_count:experiments.length,summary,blockers:[...blockers].sort(),causal_savings:'not_established',calibrated:false,model_calls:0};
}
