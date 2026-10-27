import { compareRuns } from './pairing.mjs';
import { COST_COMPONENTS, tokenComponent } from './reductions.mjs';
import {
  MAX_EXPERIMENT_RUNS,
  MAX_OPTIMIZATION_ITEMS,
  POLICY_CONTEXT_FIELDS,
  normalizeExperiment,
} from './schema.mjs';

export const PILOT_SCHEMA_VERSION = 2;
export const PILOT_REQUIRED_INDEPENDENT_PAIRS = 20;
export const PILOT_TARGET_MINIMUM_PERCENT = 10;
export const PILOT_TARGET_MAXIMUM_PERCENT = 30;

const BOOTSTRAP_SAMPLES = 1_000;
const ACCEPTED_VERIFICATIONS = new Set(['deterministic_checks_passed', 'manual_accepted', 'host_accepted']);
const ATTEMPT_CONTEXT_FIELDS = [
  'host', 'workload_class', 'workload_subtype', 'acceptance_fingerprint', 'work_unit_id', 'task_key', 'root_key',
  'evidence_basis', 'model', 'effort', 'agent_policy', 'source_type', 'router_state', 'router_version',
  'schema_version', 'usage_schema_version', 'adapter_version', 'pricing_profile', 'service_tier',
  ...POLICY_CONTEXT_FIELDS,
];
const COHORT_SIDE_FIELDS = [
  'model', 'effort', 'agent_policy', 'source_type', 'router_state', 'router_version',
  'schema_version', 'usage_schema_version', 'adapter_version', 'pricing_profile', 'service_tier',
  ...POLICY_CONTEXT_FIELDS,
];

export function beginEfficiencyPilotEpoch(optimization, input = {}) {
  if (!optimization || typeof optimization !== 'object' || Array.isArray(optimization)) return { ok: false, error: 'invalid_optimization_state' };
  const host = input.host === 'codex' || input.host === 'claude' ? input.host : null;
  if (!host) return { ok: false, error: 'invalid_host' };
  if (input.replace !== undefined && input.replace !== true && input.replace !== false) return { ok: false, error: 'invalid_replace' };
  optimization.experiment_pilot_epochs ??= {};
  optimization.experiment_pilot_revisions ??= { codex: 0, claude: 0 };
  const current = optimization.experiment_pilot_epochs[host];
  if (current && input.replace !== true) return { ok: true, duplicate: true, epoch: {
    epoch_id: current.epoch_id,
    host,
    revision: current.revision,
    status: 'active',
    evidence: ['complete', 'incomplete', 'unknown'].includes(current.evidence) ? current.evidence : 'unknown',
    started_at: Number.isSafeInteger(current.started_at) && current.started_at >= 0 ? current.started_at : null,
  } };
  const priorRevision = optimization.experiment_pilot_revisions[host];
  if (priorRevision === null) return { ok: false, error: 'pilot_epoch_generation_unavailable' };
  const revision = Math.max(Number.isSafeInteger(priorRevision) ? priorRevision : 0,
    Number.isSafeInteger(current?.revision) ? current.revision : 0) + 1;
  if (revision > 1_000_000) return { ok: false, error: 'pilot_epoch_limit' };
  const startedAt = Number.isSafeInteger(input.started_at) && input.started_at >= 0 ? input.started_at : Date.now();
  const epoch = {
    epoch_id: `${host}-pilot-${revision}`,
    host,
    revision,
    status: 'active',
    evidence: 'complete',
    started_at: startedAt,
  };
  optimization.experiment_pilot_epochs[host] = epoch;
  optimization.experiment_pilot_revisions[host] = revision;
  return { ok: true, duplicate: false, epoch: { ...epoch } };
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function percent(numerator, denominator) {
  return denominator > 0 ? round((numerator / denominator) * 100) : null;
}

function sameContext(a, b) {
  return ATTEMPT_CONTEXT_FIELDS.every((field) => a[field] === b[field]);
}

function prospectiveElapsed(run) {
  return Number.isSafeInteger(run.started_at) && Number.isSafeInteger(run.work_started_at) && Number.isSafeInteger(run.closed_at)
    && run.started_at <= run.work_started_at && run.work_started_at < run.closed_at
    ? run.closed_at - run.work_started_at : null;
}

function validAttempt(run, accepted) {
  return sameContext(run, accepted)
    && (run.state === 'closed' || run.state === 'cancelled')
    && run.coverage_status === 'exact'
    && run.token_quality === 'exact'
    && run.recovery_ambiguous !== true
    && run.receipt_evidence_complete === true
    && Number.isSafeInteger(run.total_tokens) && run.total_tokens >= 0
    && Number.isSafeInteger(run.main_tokens) && Number.isSafeInteger(run.subagent_tokens)
    && run.main_tokens >= 0 && run.subagent_tokens >= 0
    && run.main_tokens + run.subagent_tokens === run.total_tokens
    && run.token_components_consistent !== false
    && Number.isSafeInteger(run.rework_count) && run.rework_count >= 0
    && prospectiveElapsed(run) !== null;
}

function attemptChain(attemptsValue) {
  const attempts = [...attemptsValue].sort((a, b) => a.run_id.localeCompare(b.run_id));
  const acceptedAttempts = attempts.filter((run) => run.outcome === 'pass' && ACCEPTED_VERIFICATIONS.has(run.verification));
  if (!attempts.length || attempts.length > MAX_EXPERIMENT_RUNS || acceptedAttempts.length > 1) return null;
  if (!acceptedAttempts.length && attempts.some((run) => run.outcome === 'pass')) return null;
  const representative = acceptedAttempts[0] ?? [...attempts].sort((a, b) => (a.closed_at - b.closed_at) || a.run_id.localeCompare(b.run_id)).at(-1);
  if (attempts.some((run) => !validAttempt(run, representative))) return null;
  const receiptIds = attempts.flatMap((run) => run.receipt_ids);
  if (new Set(receiptIds).size !== receiptIds.length) return null;
  return {
    attempts,
    representative,
    accepted_work: acceptedAttempts.length,
    tokens: attempts.reduce((sum, run) => sum + run.total_tokens, 0),
    rework: attempts.reduce((sum, run) => sum + run.rework_count, 0),
    duration: attempts.reduce((sum, run) => sum + prospectiveElapsed(run), 0),
  };
}

function workGroups(experiment, variant) {
  const roots = new Map();
  const runs = experiment.runs.filter((entry) => entry.variant === variant);
  let invalid = runs.some((run) => !run.root_key);
  for (const run of runs) {
    if (!run.root_key) continue;
    if (!roots.has(run.root_key)) roots.set(run.root_key, []);
    roots.get(run.root_key).push(run);
  }
  const groups = [];
  for (const attempts of roots.values()) {
    const group = attemptChain(attempts);
    if (group) groups.push(group);
    else invalid = true;
  }
  return { groups, invalid, run_count: runs.length };
}

function eligibleGroupComparison(baseline, treatment, comparisonAxis) {
  const compared = compareRuns(baseline.representative, treatment.representative, { comparison_axis: comparisonAxis });
  if (baseline.accepted_work && treatment.accepted_work) return compared.comparable ? compared : null;
  const permitted = new Set(['different_verification', 'outcome_not_equivalent']);
  if (baseline.representative.state === 'cancelled' || treatment.representative.state === 'cancelled') permitted.add('run_not_closed');
  return compared.reasons.every((reason) => permitted.has(reason)) ? compared : null;
}

function runIdentities(runs) {
  return new Set(runs.flatMap((run) => [
    `run:${run.run_id}`,
    `work:${run.task_key}`,
    `work:${run.root_key}`,
    ...run.receipt_ids.map((id) => `receipt:${id}`),
  ]));
}

function pairIdentities(candidate) {
  return new Set([...runIdentities(candidate.baseline.attempts), ...runIdentities(candidate.treatment.attempts)]);
}

function crossArmOverlap(candidate) {
  const baseline = runIdentities(candidate.baseline.attempts);
  const treatment = runIdentities(candidate.treatment.attempts);
  return [...baseline].some((identity) => treatment.has(identity));
}

function candidateSignature(candidate) {
  return JSON.stringify({
    comparison_axis: candidate.comparison_axis,
    baseline: candidate.baseline.attempts,
    treatment: candidate.treatment.attempts,
  });
}

function cohortContext(candidate) {
  const baseline = candidate.baseline.representative;
  const treatment = candidate.treatment.representative;
  return {
    comparison_axis: candidate.comparison_axis,
    host: baseline.host,
    workload_class: baseline.workload_class,
    workload_subtype: baseline.workload_subtype,
    evidence_basis: baseline.evidence_basis,
    baseline: Object.fromEntries(COHORT_SIDE_FIELDS.map((field) => [field, baseline[field]])),
    treatment: Object.fromEntries(COHORT_SIDE_FIELDS.map((field) => [field, treatment[field]])),
  };
}

function armSummary(candidates, side) {
  const attempts = candidates.flatMap((candidate) => candidate[side].attempts);
  const acceptedWork = candidates.reduce((sum, candidate) => sum + candidate[side].accepted_work, 0);
  const totalTokens = candidates.reduce((sum, candidate) => sum + candidate[side].tokens, 0);
  return {
    attempts: attempts.length,
    accepted_work: acceptedWork,
    failed_attempts: attempts.filter((run) => run.outcome === 'fail').length,
    cancelled_attempts: attempts.filter((run) => run.outcome === 'cancelled').length,
    success_rate_percent: percent(acceptedWork, attempts.length),
    total_tokens: totalTokens,
    cost_per_accepted_work: acceptedWork ? round(totalTokens / acceptedWork) : null,
  };
}

function reductionForCandidates(candidates) {
  const baselineAccepted = candidates.reduce((sum, candidate) => sum + candidate.baseline.accepted_work, 0);
  const treatmentAccepted = candidates.reduce((sum, candidate) => sum + candidate.treatment.accepted_work, 0);
  if (!baselineAccepted || !treatmentAccepted) return null;
  const baseline = candidates.reduce((sum, candidate) => sum + candidate.baseline.tokens, 0) / baselineAccepted;
  const treatment = candidates.reduce((sum, candidate) => sum + candidate.treatment.tokens, 0) / treatmentAccepted;
  return baseline > 0 ? percent(baseline - treatment, baseline) : null;
}

function bootstrapInterval(candidates) {
  if (candidates.length < PILOT_REQUIRED_INDEPENDENT_PAIRS) return null;
  let seed = 0x5f3759df;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let mixed = seed;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
  const samples = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    let baseline = 0;
    let treatment = 0;
    let baselineAccepted = 0;
    let treatmentAccepted = 0;
    for (let draw = 0; draw < candidates.length; draw += 1) {
      const candidate = candidates[Math.floor(random() * candidates.length)];
      baseline += candidate.baseline.tokens;
      treatment += candidate.treatment.tokens;
      baselineAccepted += candidate.baseline.accepted_work;
      treatmentAccepted += candidate.treatment.accepted_work;
    }
    if (baseline > 0 && baselineAccepted > 0 && treatmentAccepted > 0) {
      const baselineCost = baseline / baselineAccepted;
      const treatmentCost = treatment / treatmentAccepted;
      samples.push(((baselineCost - treatmentCost) / baselineCost) * 100);
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return {
    low: round(samples[Math.floor((samples.length - 1) * 0.025)]),
    high: round(samples[Math.ceil((samples.length - 1) * 0.975)]),
    method: 'paired_bootstrap',
  };
}

function targetStatus(reduction, interval, guards, count) {
  if (count < PILOT_REQUIRED_INDEPENDENT_PAIRS || reduction === null || !interval) return 'unmeasured';
  if (Object.values(guards).some(status => status !== 'passed')) return 'uncertain';
  if (interval.high < PILOT_TARGET_MINIMUM_PERCENT) return 'below_target';
  if (interval.low > PILOT_TARGET_MAXIMUM_PERCENT) return 'above_target';
  if (interval.low >= PILOT_TARGET_MINIMUM_PERCENT && interval.high <= PILOT_TARGET_MAXIMUM_PERCENT) return 'within_target';
  return 'uncertain';
}

function buildCohort(context, candidates) {
  const baseline = armSummary(candidates, 'baseline');
  const treatment = armSummary(candidates, 'treatment');
  const reduction = reductionForCandidates(candidates);
  const interval = bootstrapInterval(candidates);
  const baselineRework = candidates.reduce((sum, candidate) => sum + candidate.baseline.rework, 0);
  const treatmentRework = candidates.reduce((sum, candidate) => sum + candidate.treatment.rework, 0);
  const baselineDuration = candidates.reduce((sum, candidate) => sum + candidate.baseline.duration, 0);
  const treatmentDuration = candidates.reduce((sum, candidate) => sum + candidate.treatment.duration, 0);
  const guards = {
    quality: treatment.accepted_work / candidates.length >= baseline.accepted_work / candidates.length ? 'passed' : 'regressed',
    rework: treatmentRework <= baselineRework ? 'passed' : 'regressed',
    elapsed_work: treatmentDuration - baselineDuration <= Math.max(1000, baselineDuration * 0.05) ? 'passed' : 'regressed',
  };
  const reasonCodes = [];
  if (baseline.total_tokens === 0) reasonCodes.push('zero_baseline_cost');
  if (guards.quality === 'regressed') reasonCodes.push('success_rate_decreased');
  if (guards.rework === 'regressed') reasonCodes.push('rework_increased');
  if (guards.elapsed_work === 'regressed') reasonCodes.push('elapsed_work_increased');
  // Count every attempt, including failed/cancelled work, over the same
  // accepted-work denominator as total tokens. Missing is never zero.
  const componentMetrics = Object.fromEntries(COST_COMPONENTS.map(field => {
    const values = ['baseline', 'treatment'].map((side, index) => {
      const counts = candidates.flatMap(candidate => candidate[side].attempts).map(run => tokenComponent(run, field));
      const accepted = index === 0 ? baseline.accepted_work : treatment.accepted_work;
      const total = counts.every(value => value !== null) ? counts.reduce((sum, value) => sum + value, 0) : null;
      return accepted && Number.isSafeInteger(total) ? total / accepted : null;
    });
    const [before, after] = values;
    guards[field] = before === null || after === null ? 'unavailable' : after > before ? 'regressed' : 'passed';
    if (guards[field] === 'unavailable') reasonCodes.push(`${field}_measurement_unavailable`);
    else if (guards[field] === 'regressed') reasonCodes.push(`${field}_increased`);
    return [field, { baseline: round(before), treatment: round(after),
      reduction_percent: before === null || after === null ? null : percent(before - after, before) }];
  }));
  return {
    context,
    eligible_independent_pairs: candidates.length,
    milestone: {
      required_independent_pairs: PILOT_REQUIRED_INDEPENDENT_PAIRS,
      status: candidates.length >= PILOT_REQUIRED_INDEPENDENT_PAIRS ? 'met' : 'collecting',
    },
    baseline,
    treatment,
    observed_token_reduction_percent: reduction,
    uncertainty_interval_95_percent: interval,
    guards,
    component_basis: 'all_attempts_per_accepted_work',
    component_metrics: componentMetrics,
    target_band: {
      minimum_percent: PILOT_TARGET_MINIMUM_PERCENT,
      maximum_percent: PILOT_TARGET_MAXIMUM_PERCENT,
      status: targetStatus(reduction, interval, guards, candidates.length),
    },
    reason_codes: reasonCodes,
  };
}

/**
 * Read-only assessment of prospective baseline/treatment experiments.
 * It never creates work, infers quota effects, or pools unlike cohorts.
 */
export function assessEfficiencyPilot(experiments, options = {}) {
  const allSource = Array.isArray(experiments)
    ? experiments
    : experiments && typeof experiments === 'object' ? Object.values(experiments) : [];
  const reasonCodes = new Set();
  const requestedEpoch = options?.pilot_epoch;
  const epochId = typeof requestedEpoch?.epoch_id === 'string' ? requestedEpoch.epoch_id : null;
  const epochValid = requestedEpoch === undefined || (epochId
    && (requestedEpoch.host === 'codex' || requestedEpoch.host === 'claude')
    && (options.host === undefined || requestedEpoch.host === options.host)
    && Number.isSafeInteger(requestedEpoch.revision) && requestedEpoch.revision > 0
    && epochId === `${requestedEpoch.host}-pilot-${requestedEpoch.revision}`);
  if (!epochValid) reasonCodes.add('invalid_pilot_epoch');
  const source = epochId && epochValid ? allSource.filter((value) => value?.pilot_epoch === epochId) : allSource;
  const proposedCollectionEvidence = requestedEpoch?.evidence ?? options?.collection_evidence
    ?? (Array.isArray(experiments) ? 'complete' : 'unknown');
  const collectionEvidence = ['complete', 'incomplete', 'unknown'].includes(proposedCollectionEvidence)
    ? proposedCollectionEvidence : 'unknown';
  const collectionIncomplete = collectionEvidence !== 'complete' || !epochValid;
  if (collectionIncomplete) reasonCodes.add(collectionEvidence === 'incomplete'
    ? 'experiment_collection_incomplete' : 'experiment_collection_unproven');
  const requestedHost = options?.host;
  const validHost = requestedHost === undefined || requestedHost === 'codex' || requestedHost === 'claude';
  if (!validHost) reasonCodes.add('invalid_host');
  if (!source.length) reasonCodes.add('missing_pair');
  if (source.length > MAX_OPTIMIZATION_ITEMS) reasonCodes.add('sample_limit_exceeded');
  const normalized = [];
  let normalizationLoss = false;
  if (validHost) for (const value of source.slice(0, MAX_OPTIMIZATION_ITEMS)) {
    if (requestedHost !== undefined && value?.host !== requestedHost) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      reasonCodes.add('invalid_experiment_record');
      normalizationLoss = true;
      continue;
    }
    if (!Array.isArray(value.runs)) {
      reasonCodes.add('invalid_run_record');
      normalizationLoss = true;
      continue;
    }
    if (value.runs.length > MAX_EXPERIMENT_RUNS) {
      reasonCodes.add('raw_run_limit_exceeded');
      normalizationLoss = true;
      continue;
    }
    const experiment = normalizeExperiment(value);
    if (!experiment) {
      reasonCodes.add('invalid_experiment_record');
      normalizationLoss = true;
      continue;
    }
    if (experiment.runs.length !== value.runs.length) {
      reasonCodes.add('invalid_run_record');
      normalizationLoss = true;
      continue;
    }
    if (experiment.attempt_evidence_complete !== true) {
      reasonCodes.add(experiment.attempt_evidence_complete === false ? 'incomplete_run_history' : 'attempt_evidence_unproven');
      normalizationLoss = true;
      continue;
    }
    if (experiment.runs.some((run) => run.host !== experiment.host)) {
      reasonCodes.add('host_context_mismatch');
      normalizationLoss = true;
      continue;
    }
    normalized.push(experiment);
  }
  const rawCandidates = [];
  let unallocatedAttemptCost = false;

  for (const experiment of normalized) {
    const baselineResult = workGroups(experiment, 'baseline');
    const treatmentResult = workGroups(experiment, 'treatment');
    const baselines = baselineResult.groups;
    const treatments = treatmentResult.groups;
    const usedTreatments = new Set();
    let matched = 0;
    for (const baseline of baselines) {
      const treatmentIndex = treatments.findIndex((treatment, index) => !usedTreatments.has(index)
        && treatment.representative.acceptance_fingerprint === baseline.representative.acceptance_fingerprint
        && treatment.representative.workload_subtype === baseline.representative.workload_subtype
        && eligibleGroupComparison(baseline, treatment, experiment.comparison_axis));
      if (treatmentIndex < 0) continue;
      const treatment = treatments[treatmentIndex];
      usedTreatments.add(treatmentIndex);
      matched += 1;
      const candidate = {
        comparison_axis: experiment.comparison_axis,
        baseline,
        treatment,
      };
      if (crossArmOverlap(candidate)) {
        reasonCodes.add('overlapping_usage');
        reasonCodes.add('unallocated_attempt_cost');
        unallocatedAttemptCost = true;
        continue;
      }
      rawCandidates.push(candidate);
    }
    if (!matched || matched !== baselines.length || matched !== treatments.length) reasonCodes.add('missing_pair');
    if ((baselineResult.run_count || treatmentResult.run_count)
      && (baselineResult.invalid || treatmentResult.invalid || matched !== baselines.length || matched !== treatments.length)) {
      reasonCodes.add('unallocated_attempt_cost');
      unallocatedAttemptCost = true;
    }
  }

  const unique = new Map();
  let duplicatePairs = 0;
  for (const candidate of rawCandidates) {
    const signature = candidateSignature(candidate);
    if (unique.has(signature)) duplicatePairs += 1;
    else unique.set(signature, candidate);
  }
  const candidates = [...unique.entries()].map(([signature, candidate]) => ({
    ...candidate,
    signature,
    identities: pairIdentities(candidate),
  }));
  const identityOwners = new Map();
  for (const candidate of candidates) {
    for (const identity of candidate.identities) {
      if (!identityOwners.has(identity)) identityOwners.set(identity, new Set());
      identityOwners.get(identity).add(candidate.signature);
    }
  }
  const independent = candidates.filter((candidate) => {
    const overlap = [...candidate.identities].some((identity) => identityOwners.get(identity).size > 1);
    if (overlap) {
      reasonCodes.add('overlapping_usage');
      reasonCodes.add('unallocated_attempt_cost');
      unallocatedAttemptCost = true;
    }
    return !overlap;
  });

  if (source.length > MAX_OPTIMIZATION_ITEMS || collectionIncomplete || normalizationLoss || unallocatedAttemptCost) independent.length = 0;
  const cohortMap = new Map();
  for (const candidate of independent) {
    const context = cohortContext(candidate);
    const key = JSON.stringify(context);
    if (!cohortMap.has(key)) cohortMap.set(key, { context, candidates: [] });
    cohortMap.get(key).candidates.push(candidate);
  }
  const cohorts = [...cohortMap.values()]
    .map(({ context, candidates: cohortCandidates }) => buildCohort(context, cohortCandidates))
    .sort((a, b) => JSON.stringify(a.context).localeCompare(JSON.stringify(b.context)));
  const eligiblePairs = cohorts.reduce((sum, cohort) => sum + cohort.eligible_independent_pairs, 0);
  const allMilestonesMet = cohorts.length > 0 && cohorts.every((cohort) => cohort.milestone.status === 'met');
  const uncertain = cohorts.some((cohort) => cohort.target_band.status === 'uncertain');
  const status = !eligiblePairs ? 'ineligible' : !allMilestonesMet ? 'collecting' : uncertain ? 'uncertain' : 'measured';
  const single = cohorts.length === 1 ? cohorts[0] : null;
  const epoch = epochId && epochValid ? {
    status: 'active',
    host: requestedEpoch.host,
    revision: requestedEpoch.revision,
    evidence: collectionEvidence,
    experiment_count: normalized.length,
  } : { status: 'none', host: requestedHost ?? 'unknown', revision: null, evidence: collectionEvidence, experiment_count: normalized.length };

  return {
    pilot_schema_version: PILOT_SCHEMA_VERSION,
    status,
    required_independent_pairs: PILOT_REQUIRED_INDEPENDENT_PAIRS,
    eligible_independent_pairs: eligiblePairs,
    duplicate_pairs: duplicatePairs,
    rejected_pairs: candidates.length - independent.length + (rawCandidates.length - unique.size),
    pooled_status: cohorts.length > 1 ? 'not_pooled_mixed_cohorts' : cohorts.length === 1 ? 'single_cohort' : 'unavailable',
    observed_token_reduction_percent: single?.observed_token_reduction_percent ?? null,
    target_band: single?.target_band ?? {
      minimum_percent: PILOT_TARGET_MINIMUM_PERCENT,
      maximum_percent: PILOT_TARGET_MAXIMUM_PERCENT,
      status: 'unmeasured',
    },
    epoch,
    cohorts,
    reason_codes: [...reasonCodes].sort(),
    causal_savings: 'not_established',
    quota_attribution: 'not_established',
    model_calls: 0,
  };
}
