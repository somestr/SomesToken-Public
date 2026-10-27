import { MAX_PAIRS, POLICY_CONTEXT_FIELDS, safeOptimizationId, normalizePair, normalizeExperimentRun } from './schema.mjs';

export const REDUCTION_SCHEMA_VERSION = 3;
export const BENEFIT_STATUSES = Object.freeze(['unavailable', 'not_improved', 'tradeoff_review_required',
  'insufficient_outcome_evidence', 'supported_token_reduction']);
export const COST_COMPONENTS = Object.freeze(['new_input_tokens', 'output_tokens', 'cache_write_input_tokens']);

function exactNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function round(value) {
  const rounded = typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
  return Number.isFinite(rounded) ? rounded : null;
}

function delta(baseline, treatment) {
  const a = exactNumber(baseline);
  const b = exactNumber(treatment);
  return a === null || b === null ? null : round(b - a);
}

function reduction(baseline, treatment) {
  const a = exactNumber(baseline);
  const b = exactNumber(treatment);
  if (a === null || b === null || a <= 0) return { value: null, percent: null };
  return { value: round(a - b), percent: round(((a - b) / a) * 100) };
}

const COMPONENTS = ['total_tokens', 'input_tokens', 'new_input_tokens', 'cached_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens', 'main_tokens', 'subagent_tokens'];
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function tokenComponent(run, field) {
  if (field === 'reasoning_output_tokens' && run.host === 'claude') return null;
  if (field === 'new_input_tokens') {
    const input = counter(run.input_tokens), cached = counter(run.cached_input_tokens);
    return input !== null && cached !== null && cached <= input ? input - cached : null;
  }
  return counter(run[field]);
}
function elapsed(run) {
  const start = counter(run.work_started_at), end = counter(run.closed_at);
  return start !== null && end !== null && end >= start ? end - start : null;
}
function componentMetrics(baseline, treatment, valid) {
  return Object.fromEntries(COMPONENTS.map(field => {
    const a = tokenComponent(baseline, field), b = tokenComponent(treatment, field);
    const reduced = valid ? reduction(a, b) : {value:null,percent:null};
    return [field, {baseline:a,treatment:b,delta:delta(a,b),reduction:reduced.value,reduction_percent:reduced.percent}];
  }));
}
function benefitAssessment(baseline, treatment, valid) {
  if (!valid) return {benefit_status:'unavailable',benefit_reason_codes:['comparison_not_eligible']};
  const reasons = [];
  if (counter(baseline.rework_count) === null || counter(treatment.rework_count) === null) reasons.push('rework_measurement_unavailable');
  else if (treatment.rework_count > baseline.rework_count) reasons.push('rework_increased');
  const before = elapsed(baseline), after = elapsed(treatment);
  if (before === null || after === null) reasons.push('elapsed_measurement_unavailable');
  // Elapsed work includes host/tool/user waiting. Flag material tradeoffs, not
  // sub-second timestamp noise; this is never an active-model speed estimate.
  else if (after - before > Math.max(1000, before * 0.05)) reasons.push('elapsed_work_increased');
  // Cached input can fall enough to hide a rise in fresh input or output.
  // Preserve the total-token observation, but surface the component tradeoff.
  for (const field of COST_COMPONENTS) {
    const prior=tokenComponent(baseline,field),current=tokenComponent(treatment,field);
    if(prior===null||current===null)reasons.push(`${field}_measurement_unavailable`);
    else if(current>prior)reasons.push(`${field}_increased`);
  }
  const improved = baseline.total_tokens > treatment.total_tokens;
  return {benefit_status:reasons.some(reason => reason.endsWith('_increased')) ? 'tradeoff_review_required'
    : reasons.length ? 'insufficient_outcome_evidence' : improved ? 'supported_token_reduction' : 'not_improved',
    benefit_reason_codes:[...reasons,...(improved?[]:['tokens_not_reduced'])]};
}

/**
 * A reduction is a measured claim only for an exact, comparable, outcome-
 * equivalent pair.  All other inputs retain a delta observation but never
 * use optimization/reduction language.
 */
export function measureReduction(pairValue) {
  const pair = normalizePair(pairValue);
  if (!pair) return { reduction_schema_version: REDUCTION_SCHEMA_VERSION, pair_id: safeOptimizationId(pairValue?.pair_id) ?? 'unknown', comparison_axis: 'other_safe_enum', status: 'measurement_unavailable', evidence: 'measurement unavailable', outcome_relation: 'outcome_unknown', reasons: ['missing_pair'], sample_evidence: { baseline: null, treatment: null }, potential_savings: 'unmeasured' };
  const baseline = pair.baseline;
  const treatment = pair.treatment;
  const valid = pair.comparable && pair.outcome_relation === 'outcome_equivalent'
    && baseline.token_quality === 'exact' && treatment.token_quality === 'exact'
    && baseline.recovery_ambiguous !== true && treatment.recovery_ambiguous !== true;
  const tokenDelta = delta(baseline.total_tokens, treatment.total_tokens);
  const pricingKnown = baseline.pricing_profile !== 'unknown' && treatment.pricing_profile !== 'unknown';
  const providerDelta = pricingKnown ? delta(baseline.calculated_provider_usage, treatment.calculated_provider_usage) : null;
  const output = {
    reduction_schema_version: REDUCTION_SCHEMA_VERSION,
    pair_id: pair.pair_id,
    comparison_axis: pair.comparison_axis,
    sample_evidence: { baseline: sampleEvidence(baseline), treatment: sampleEvidence(treatment) },
    status: valid ? 'measured' : 'measurement_unavailable',
    evidence: valid ? 'single-pair measured observation' : 'measurement unavailable',
    outcome_relation: pair.outcome_relation,
    comparison_unit: 'accepted_work_unit',
    component_metrics: componentMetrics(baseline, treatment, valid),
    ...benefitAssessment(baseline, treatment, valid),
    token_delta: tokenDelta,
    calculated_provider_usage_delta: providerDelta,
    input_delta: delta(baseline.input_tokens, treatment.input_tokens),
    cached_input_delta: delta(baseline.cached_input_tokens, treatment.cached_input_tokens),
    output_delta: delta(baseline.output_tokens, treatment.output_tokens),
    reasoning_output_delta: delta(tokenComponent(baseline,'reasoning_output_tokens'), tokenComponent(treatment,'reasoning_output_tokens')),
    rework_delta: delta(baseline.rework_count,treatment.rework_count),
    duration_delta: delta(elapsed(baseline), elapsed(treatment)),
    duration_basis: 'work_started_to_closed_elapsed',
    source_count_delta: delta(baseline.source_count, treatment.source_count),
    retry_rate_delta: delta(baseline.retry_rate, treatment.retry_rate),
    fanout_delta: delta(baseline.fanout, treatment.fanout),
    compaction_delta: delta(baseline.compactions, treatment.compactions),
    reasons: pair.reasons,
  };
  if (valid) {
    const tokens = reduction(baseline.total_tokens, treatment.total_tokens);
    const credits = pricingKnown ? reduction(baseline.calculated_provider_usage, treatment.calculated_provider_usage) : { value: null, percent: null };
    output.token_reduction = tokens.value;
    output.token_reduction_percent = tokens.percent;
    output.calculated_provider_usage_reduction = credits.value;
    output.calculated_provider_usage_reduction_percent = credits.percent;
  } else if (pair.outcome_relation === 'outcome_regressed') {
    output.status = 'outcome_regressed';
    output.evidence = 'not an optimization';
  } else if (tokenDelta !== null) {
    output.evidence = 'usage delta observed; optimization not established';
  }
  output.potential_savings = 'unmeasured';
  return output;
}

function sampleEvidence(run) {
  return normalizeExperimentRun(run) ?? {};
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
}

function identities(side) {
  return new Set([
    ...(side.run_id ? [`run:${side.run_id}`] : []),
    ...(side.receipt_ids ?? []).map((id) => `receipt:${id}`),
    ...[side.task_key, side.root_key].filter(Boolean).map((id) => `task:${id}`),
  ]);
}

const AGGREGATE_CONTEXT_FIELDS = [
  'host', 'workload_class', 'workload_subtype', 'acceptance_fingerprint', 'evidence_basis', 'verification',
  'model', 'effort', 'agent_policy', 'source_type', 'router_state', 'router_version',
  'schema_version', 'usage_schema_version', 'adapter_version', 'pricing_profile', 'service_tier',
];

function comparisonContext(entry) {
  return JSON.stringify({
    comparison_axis: entry.comparison_axis,
    ...Object.fromEntries(['baseline', 'treatment'].map(side => [side,
      Object.fromEntries([...AGGREGATE_CONTEXT_FIELDS, ...POLICY_CONTEXT_FIELDS].map(field => [field, entry.sample_evidence[side][field]]))])),
  });
}

export function summarizeReductions(measurements) {
  const input = Array.isArray(measurements) ? measurements : [];
  const observed = input.slice(0, MAX_PAIRS).filter((entry) => entry?.status === 'measured');
  const reasons = new Map();
  const reject = (reason, count = 1) => reasons.set(reason, (reasons.get(reason) ?? 0) + count);
  const candidates = observed.map((entry) => {
    const baseline = sampleEvidence(entry.sample_evidence?.baseline);
    const treatment = sampleEvidence(entry.sample_evidence?.treatment);
    const checked = measureReduction({ pair_id: entry.pair_id, baseline, treatment, comparison_axis: entry.comparison_axis });
    const left = identities(baseline);
    const right = identities(treatment);
    const complete = [baseline, treatment].every((side) => side.run_id && side.task_key && side.root_key && side.receipt_ids.length && side.host !== 'unknown');
    const reused = [...left].some((id) => right.has(id));
    const metrics = Object.fromEntries([
      'token_reduction_percent', 'calculated_provider_usage_reduction_percent', 'token_delta',
      'calculated_provider_usage_delta', 'token_reduction', 'calculated_provider_usage_reduction',
      'input_delta', 'cached_input_delta', 'output_delta', 'reasoning_output_delta', 'duration_delta',
      'source_count_delta', 'retry_rate_delta', 'fanout_delta', 'compaction_delta',
    ].map((field) => [field, typeof entry[field] === 'number' && Number.isFinite(entry[field]) ? entry[field] : null]));
    return { entry: checked, signature: JSON.stringify({baseline, treatment, metrics}),
      identities: new Set([...left, ...right, ...(safeOptimizationId(entry.pair_id) ? [`pair:${entry.pair_id}`] : [])]),
      reason: !complete ? 'missing_sample_identity' : reused ? 'reused_sample_identity' : checked.status !== 'measured' ? (checked.reasons[0] ?? 'comparison_context_missing') : null };
  });
  // Reject all observations that reuse evidence with a different measurement,
  // rather than choosing a winner based on input order.
  const owners = new Map();
  for (const candidate of candidates) {
    for (const id of candidate.identities) {
      if (!owners.has(id)) owners.set(id, new Set());
      owners.get(id).add(candidate.signature);
    }
  }
  const seen = new Set();
  const valid = [];
  for (const candidate of candidates) {
    const reason = input.length > MAX_PAIRS ? 'sample_limit_exceeded'
      : [...candidate.identities].some((id) => owners.get(id).size > 1) ? 'conflicting_sample_identity'
      : candidate.reason ?? (seen.has(candidate.signature) ? 'duplicate_pair' : null);
    if (reason) { reject(reason); continue; }
    seen.add(candidate.signature);
    valid.push(candidate.entry);
  }
  const mixed = new Set(valid.map(comparisonContext)).size > 1;
  const tokenPercent = mixed ? null : median(valid.map((entry) => entry.token_reduction_percent));
  const providerPercent = mixed ? null : median(valid.map((entry) => entry.calculated_provider_usage_reduction_percent));
  const count = valid.length;
  const benefit = mixed || !count ? 'unavailable'
    : valid.some(entry => entry.benefit_status === 'tradeoff_review_required') ? 'tradeoff_review_required'
      : valid.some(entry => entry.benefit_status === 'insufficient_outcome_evidence') ? 'insufficient_outcome_evidence'
        : !(tokenPercent > 0) ? 'not_improved' : 'supported_token_reduction';
  return {
    reduction_schema_version: REDUCTION_SCHEMA_VERSION,
    observed_pairs: observed.length,
    valid_pairs: count,
    independent_pairs: count,
    rejected_pairs: observed.length - count,
    rejection_reasons: [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({reason, count})),
    reason_codes: mixed ? ['mixed_comparison_context'] : [],
    status: mixed ? 'measurement_unavailable' : count >= 3 ? 'measured_paired_trend' : count === 2 ? 'two_pair_measured_observations' : count === 1 ? 'single_pair_measured_observation' : 'measurement_unavailable',
    evidence: mixed ? 'measurement unavailable' : count >= 3 ? 'measured paired trend' : count === 2 ? 'two-pair measured observations' : count === 1 ? 'single-pair measured observation' : 'measurement unavailable',
    median_token_reduction_percent: tokenPercent === null ? null : round(tokenPercent),
    median_calculated_provider_usage_reduction_percent: providerPercent === null ? null : round(providerPercent),
    comparison_unit: 'accepted_work_unit',
    benefit_status: benefit,
    benefit_reason_codes: mixed ? ['mixed_comparison_context'] : [...new Set(valid.flatMap(entry => entry.benefit_reason_codes))],
    component_summary: Object.fromEntries(COMPONENTS.map(field => {
      const values = mixed ? [] : valid.map(entry => entry.component_metrics[field].reduction_percent).filter(Number.isFinite);
      return [field, {sample_count:values.length,median_reduction_percent:median(values)}];
    })),
    potential_savings: 'unmeasured',
  };
}
