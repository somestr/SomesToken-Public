import {
  SUPPORTED_COMPARISON_AXES,
  POLICY_CONTEXT_FIELDS,
  POLICY_CONTEXT_VERSION,
  INCOMPARABILITY_REASONS,
  OUTCOME_RELATIONS,
  normalizeExperimentRun,
} from './schema.mjs';

export const PAIRING_SCHEMA_VERSION = 2;

function same(a, b) {
  return a === b;
}

function outcomeRelation(baseline, treatment) {
  if (!baseline || !treatment) return 'outcome_unknown';
  if (baseline.outcome === 'pass' && treatment.outcome === 'pass'
    && ['deterministic_checks_passed', 'manual_accepted', 'host_accepted'].includes(baseline.verification)
    && baseline.verification === treatment.verification) return 'outcome_equivalent';
  if (treatment.outcome === 'fail' || treatment.outcome === 'cancelled') return 'outcome_regressed';
  if (baseline.outcome === 'unknown' || treatment.outcome === 'unknown' || baseline.outcome === 'partial' || treatment.outcome === 'partial') return 'outcome_unknown';
  return 'outcome_incomparable';
}

function differenceCount(axis, baseline, treatment) {
  const controlled = axis === 'router' ? ['router_state'] : [axis];
  const dimensions = [
    'host', 'workload_class', 'model', 'effort', 'agent_policy', 'source_type', 'router_state', 'router_version',
    'schema_version', 'usage_schema_version', 'adapter_version', 'pricing_profile', 'service_tier',
    ...POLICY_CONTEXT_FIELDS,
  ];
  const differences = dimensions.filter((dimension) => !same(baseline?.[dimension], treatment?.[dimension]));
  const uncontrolled = differences.filter((dimension) => !controlled.includes(dimension));
  const controlledDifferences = controlled.filter((dimension) => !same(baseline?.[dimension], treatment?.[dimension]));
  return { differences, uncontrolled, controlledDifferences };
}

export function compareRuns(baselineValue, treatmentValue, options = {}) {
  const baseline = normalizeExperimentRun(baselineValue);
  const treatment = normalizeExperimentRun(treatmentValue);
  const axis = SUPPORTED_COMPARISON_AXES.includes(options.comparison_axis) ? options.comparison_axis : null;
  const reasons = [];
  if (!baseline || !treatment) reasons.push('missing_pair');
  if (baseline && treatment) {
    for(const run of [baseline,treatment]){
      if (run.policy_context_version !== POLICY_CONTEXT_VERSION || POLICY_CONTEXT_FIELDS.some(field => run[field] === null)) reasons.push('policy_context_missing');
      if (run.router_state === 'unknown' || run.router_version === 'unknown') reasons.push('router_context_unknown');
      if(['host','model','effort','agent_policy','source_type','schema_version','usage_schema_version','adapter_version'].some(key=>!run[key]||run[key]==='unknown')||run.service_tier==='unavailable')reasons.push('comparison_context_missing');
      if(!run.task_key||!run.root_key||!run.work_unit_id||!run.acceptance_fingerprint||run.workload_subtype==='unknown'||run.coverage_status!=='exact'||run.evidence_basis==='unknown'||!run.receipt_ids.length||!run.receipt_evidence_complete)reasons.push('work_unit_evidence_missing');
      if(run.started_at===null||run.work_started_at===null||run.closed_at===null||run.started_at>run.work_started_at||run.work_started_at>=run.closed_at)reasons.push('work_unit_not_prospective');
      if(run.main_tokens===null||run.subagent_tokens===null||run.main_tokens+run.subagent_tokens!==run.total_tokens||run.token_components_consistent===false)reasons.push('source_totals_inconsistent');
    }
    if(baseline.acceptance_fingerprint!==treatment.acceptance_fingerprint||baseline.workload_subtype!==treatment.workload_subtype||baseline.evidence_basis!==treatment.evidence_basis)reasons.push('work_unit_mismatch');
    if(baseline.host===treatment.host&&((baseline.run_id===treatment.run_id||[baseline.task_key,baseline.root_key].some(key=>key&&[treatment.task_key,treatment.root_key].includes(key)))||baseline.receipt_ids.some(id=>treatment.receipt_ids.includes(id))))reasons.push('overlapping_usage');
    if (baseline.state !== 'closed' || treatment.state !== 'closed') reasons.push('run_not_closed');
    if (baseline.host !== treatment.host) reasons.push('different_host');
    if (baseline.workload_class !== treatment.workload_class) reasons.push('different_workload');
    if (axis && (options.comparison_axis !== axis)) reasons.push('different_axis');
    if (!axis) reasons.push('unsupported_comparison_axis');
    if (baseline.schema_version !== treatment.schema_version || baseline.usage_schema_version !== treatment.usage_schema_version || baseline.adapter_version !== treatment.adapter_version) reasons.push('different_schema');
    if (baseline.recovery_ambiguous === true || treatment.recovery_ambiguous === true) reasons.push('stale_experiment');
    if (baseline.verification !== treatment.verification) reasons.push('different_verification');
    if (baseline.token_quality !== 'exact' || treatment.token_quality !== 'exact') reasons.push('token_quality_not_exact');
    if (baseline.pricing_profile !== treatment.pricing_profile) reasons.push('pricing_profile_changed');
    if (baseline.service_tier !== treatment.service_tier) reasons.push('different_service_tier');
    const differences = differenceCount(axis, baseline, treatment);
    if (!differences.controlledDifferences.length) reasons.push('axis_not_changed');
    if (differences.uncontrolled.length) reasons.push('uncontrolled_difference');
    if (differences.uncontrolled.includes('model')) reasons.push('different_model');
    if (differences.uncontrolled.includes('effort')) reasons.push('different_effort');
    if (differences.uncontrolled.includes('agent_policy')) reasons.push('different_agent_policy');
    if (differences.uncontrolled.includes('source_type')) reasons.push('different_source_type');
    if (differences.controlledDifferences.length > 1 || differences.uncontrolled.length > 1) reasons.push('multiple_controlled_differences');
  }
  const relation = outcomeRelation(baseline, treatment);
  if (relation !== 'outcome_equivalent') reasons.push(relation === 'outcome_regressed' ? 'outcome_not_equivalent' : 'outcome_not_equivalent');
  const uniqueReasons = [...new Set(reasons)].filter((reason) => INCOMPARABILITY_REASONS.includes(reason));
  return {
    pairing_schema_version: PAIRING_SCHEMA_VERSION,
    comparable: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    outcome_relation: OUTCOME_RELATIONS.includes(relation) ? relation : 'outcome_unknown',
    baseline,
    treatment,
    comparison_axis: axis ?? 'other_safe_enum',
  };
}

export function findComparablePairs(runs, options = {}) {
  const normalized = (Array.isArray(runs) ? runs : []).map(normalizeExperimentRun).filter(Boolean);
  const baselines = normalized.filter((run) => run.variant === 'baseline');
  const treatments = normalized.filter((run) => run.variant === 'treatment');
  const pairs = [];
  const used = new Set();
  const unmatched = [];
  function append(baseline, treatment, pair) {
    used.add(treatment.run_id);
    pairs.push({
      pair_id: `${baseline.run_id}:${treatment.run_id}`,
      experiment_id: options.experiment_id ?? 'unknown',
      ...pair,
    });
  }
  for (const baseline of baselines) {
    const candidates = treatments.filter((candidate) => !used.has(candidate.run_id) && candidate.workload_class === baseline.workload_class);
    let matched = false;
    for (const treatment of candidates) {
      const pair = compareRuns(baseline, treatment, options);
      if (!pair.comparable) continue;
      append(baseline, treatment, pair);
      matched = true;
      break;
    }
    if (!matched) unmatched.push(baseline);
  }
  // An invalid diagnostic must not reserve evidence needed by a valid pair.
  for (const baseline of unmatched) {
    const treatment = treatments.find((candidate) => !used.has(candidate.run_id) && candidate.workload_class === baseline.workload_class);
    if (!treatment) continue;
    append(baseline, treatment, compareRuns(baseline, treatment, options));
  }
  return pairs;
}
