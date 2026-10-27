/**
 * SomesToken v0.4 optimization state contracts.
 *
 * This module is deliberately content-free.  It accepts only fixed enums,
 * bounded identifiers and numeric counters; arbitrary notes and descriptions
 * are never part of the public or persisted schema.
 */

import { normalizeActivePolicies } from './active-policy.mjs';
import {normalizeLifecycleChecks} from './lifecycle-checks.mjs';
import { normalizeHandoff } from '../handoff/state.mjs';
import {normalizeOutputAccounting} from './output-accounting.mjs';
import { isSensitiveRuntimeValue, isHashedIdentity } from '../core.mjs';

import { compareRuns } from './pairing.mjs';
import { measureReduction } from './reductions.mjs';
import { RECOMMENDATION_CATALOG } from '../efficiency/recommendations.mjs';

export const OPTIMIZATION_SCHEMA_VERSION = 1;
export const MAX_OPTIMIZATION_ITEMS = 128;
export const MAX_EXPERIMENT_RUNS = 32;
export const MAX_PAIRS = 128;
export const MAX_POLICY_DECISIONS = 128;
export const MAX_CALIBRATION_FEEDBACK = 128;
export const MAX_GATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EXPERIMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const GATE_IDS = Object.freeze([
  'codex_hook_trust',
  'codex_desktop_receipt',
  'claude_marketplace_reload',
  'claude_live_acceptance',
  'official_account_quota',
  'host_ui_rendering',
  'plugin_data_bridge',
  'ponytail_bridge',
]);
export const GATE_STATUSES = Object.freeze(['open', 'satisfied', 'unavailable', 'deferred', 'expired', 'superseded']);
export const GATE_SOURCES = Object.freeze(['acceptance', 'cli', 'host', 'manual', 'configuration', 'unknown']);

export const WORKLOAD_CLASSES = Object.freeze(['light', 'medium', 'heavy', 'maintenance', 'research', 'acceptance', 'custom_safe_id', 'unknown']);
export const EXPERIMENT_SERVICE_TIERS = Object.freeze(['fast', 'standard', 'ultrafast', 'other_observed', 'unavailable']);
export const COMPARISON_AXES = Object.freeze([
  'router', 'agent_policy', 'subagent_limit', 'fanout_limit', 'retry_policy', 'model', 'effort',
  'cache_strategy', 'session_strategy', 'manual_gate_handling', 'context_policy', 'ponytail_mode', 'efficiency_policy_version', 'other_safe_enum',
]);
// Historical other_safe_enum records remain readable, but cannot establish a comparison.
export const SUPPORTED_COMPARISON_AXES = Object.freeze(COMPARISON_AXES.filter(axis => axis !== 'other_safe_enum'));
export const POLICY_CONTEXT_VERSION = 2;
export const POLICY_ENUMS = Object.freeze({
  retry_policy: Object.freeze(['no_retry', 'new_hypothesis', 'bounded']),
  cache_strategy: Object.freeze(['unchanged', 'stable_prefix']),
  session_strategy: Object.freeze(['reuse', 'fresh_per_work_unit']),
  manual_gate_handling: Object.freeze(['wait', 'defer']),
  context_policy: Object.freeze(['targeted', 'full']),
  ponytail_mode: Object.freeze(['off', 'lite', 'full', 'ultra', 'review']),
});
export const POLICY_CONTEXT_FIELDS = Object.freeze(['policy_context_version', 'efficiency_policy_version', 'subagent_limit', 'fanout_limit', ...Object.keys(POLICY_ENUMS)]);

export function normalizePolicyContext(source = {}) {
  return {
    // Preserve legacy version identity; missing controls never become off/zero.
    policy_context_version: [1,POLICY_CONTEXT_VERSION].includes(source.policy_context_version) ? source.policy_context_version : null,
    efficiency_policy_version: Number.isSafeInteger(source.efficiency_policy_version) && source.efficiency_policy_version >= 0 && source.efficiency_policy_version <= 1_000_000 ? source.efficiency_policy_version : null,
    ...Object.fromEntries(['subagent_limit', 'fanout_limit'].map(field => [field,
      Number.isSafeInteger(source[field]) && source[field] >= 0 && source[field] <= 64 ? source[field] : null])),
    ...Object.fromEntries(Object.entries(POLICY_ENUMS).map(([field, values]) => [field, values.includes(source[field]) ? source[field] : null])),
  };
}

export const VARIANTS = Object.freeze(['baseline', 'treatment', 'control']);
export const OUTCOMES = Object.freeze(['pass', 'fail', 'partial', 'unknown', 'cancelled']);
export const VERIFICATIONS = Object.freeze(['deterministic_checks_passed', 'manual_accepted', 'host_accepted', 'unknown']);
export const EXPERIMENT_STATES = Object.freeze(['active', 'closed', 'cancelled', 'interrupted', 'expired']);
export const OPTIMIZATION_STATUSES = Object.freeze([
  'not_applied', 'experiment_started', 'applied', 'measured_positive', 'measured_neutral',
  'measured_negative', 'incomparable', 'outcome_regressed',
]);
export const OUTCOME_RELATIONS = Object.freeze(['outcome_equivalent', 'outcome_incomparable', 'outcome_regressed', 'outcome_unknown']);
export const INCOMPARABILITY_REASONS = Object.freeze([
  'policy_context_missing', 'unsupported_comparison_axis',
  'different_host', 'different_workload', 'different_axis', 'multiple_controlled_differences',
  'comparison_context_missing', 'work_unit_evidence_missing', 'work_unit_mismatch', 'work_unit_not_prospective', 'overlapping_usage', 'source_totals_inconsistent',
  'run_not_closed', 'axis_not_changed', 'uncontrolled_difference', 'router_context_unknown',
  'different_schema', 'different_verification', 'outcome_not_equivalent', 'token_quality_not_exact',
  'provider_usage_unavailable', 'pricing_profile_changed', 'missing_pair', 'stale_experiment',
  'different_model', 'different_effort', 'different_agent_policy', 'different_source_type', 'different_service_tier',
]);
export const SHADOW_DECISIONS = Object.freeze([
  'would_do_nothing', 'would_warn', 'would_recommend_pause', 'would_recommend_stop_goal',
  'would_request_user_action', 'would_suppress_duplicate', 'insufficient_evidence',
]);
export const CALIBRATION_FEEDBACK = Object.freeze(['useful', 'not_useful', 'too_early', 'too_late', 'false_positive', 'unknown']);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const SAFE_KEY = /^[A-Za-z0-9._:+|-]{1,160}$/;
const SAFE_VERSION = /^[A-Za-z0-9._:+-]{1,40}$/;
const SAFE_HOSTS = new Set(['codex', 'claude']);
const MAX_COUNTER = 1_000_000;
const EXPERIMENT_COLLECTION_EVIDENCE = new Set(['complete', 'incomplete', 'unknown']);

function collectionEvidence(value, fallback = 'unknown') {
  return EXPERIMENT_COLLECTION_EVIDENCE.has(value) ? value : fallback;
}

function markExperimentCollectionIncomplete(state) {
  state.experiment_collection_evidence = 'incomplete';
}

function normalizePilotEpoch(value, host) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const revision = Number.isSafeInteger(value.revision) && value.revision > 0 ? Math.min(value.revision, MAX_COUNTER) : null;
  const epochId = safeOptimizationId(value.epoch_id);
  if (!revision || !epochId || value.host !== host || epochId !== `${host}-pilot-${revision}`) return null;
  return {
    epoch_id: epochId,
    host,
    revision,
    status: 'active',
    evidence: collectionEvidence(value.evidence),
    started_at: safeAt(value.started_at, null),
  };
}

function pilotRevisionFromId(value, host) {
  if (typeof value !== 'string') return null;
  const match = new RegExp(`^${host}-pilot-([1-9][0-9]{0,6})$`).exec(value);
  const revision = match ? Number(match[1]) : null;
  return Number.isSafeInteger(revision) && revision <= MAX_COUNTER ? revision : null;
}

function normalizePilotRevisions(value, epochsValue) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const epochs = epochsValue && typeof epochsValue === 'object' && !Array.isArray(epochsValue) ? epochsValue : {};
  return Object.fromEntries([...SAFE_HOSTS].map((host) => {
    let revision = Object.hasOwn(source, host)
      ? (Number.isSafeInteger(source[host]) && source[host] >= 0 && source[host] <= MAX_COUNTER ? source[host] : null)
      : 0;
    if (Object.hasOwn(epochs, host)) {
      const observed = pilotRevisionFromId(epochs[host]?.epoch_id, host);
      if (observed !== null) revision = revision === null ? observed : Math.max(revision, observed);
      else if (!normalizePilotEpoch(epochs[host], host)) revision = null;
    }
    return [host, revision];
  }));
}

function observePilotRevision(state, record) {
  const host = record?.host;
  if (!SAFE_HOSTS.has(host)) return;
  const observed = pilotRevisionFromId(record?.pilot_epoch, host);
  if (observed === null) return;
  const current = state.experiment_pilot_revisions?.[host];
  if (current === null && state.experiment_collection_evidence === 'incomplete') return;
  state.experiment_pilot_revisions[host] = current === null ? observed : Math.max(current ?? 0, observed);
}

function normalizePilotEpochs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries([...SAFE_HOSTS].flatMap((host) => {
    const epoch = normalizePilotEpoch(source[host], host);
    return epoch ? [[host, epoch]] : [];
  }));
}

function markExperimentLoss(state, record) {
  markExperimentCollectionIncomplete(state);
  const host = record?.host;
  const suppliedEpoch = record?.pilot_epoch;
  const epochRevision = SAFE_HOSTS.has(host) ? pilotRevisionFromId(suppliedEpoch, host) : null;
  if (SAFE_HOSTS.has(host) && (suppliedEpoch === null || suppliedEpoch === undefined)) return;
  if (epochRevision !== null) {
    const current = state.experiment_pilot_epochs?.[host];
    if (current?.epoch_id === suppliedEpoch) current.evidence = 'incomplete';
    return;
  }
  for (const epoch of Object.values(state.experiment_pilot_epochs ?? {})) epoch.evidence = 'incomplete';
}

function hasInvalidPilotEpochBinding(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, 'pilot_epoch')) return false;
  if (record.pilot_epoch === null || record.pilot_epoch === undefined) return false;
  return !SAFE_HOSTS.has(record.host) || pilotRevisionFromId(record.pilot_epoch, record.host) === null;
}

export function safeOptimizationId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..') && !isSensitiveRuntimeValue(value) ? value : null;
}

function safeText(value, fallback = 'unknown') {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..') && !isSensitiveRuntimeValue(value) ? value : fallback;
}

function safeInt(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : fallback;
}

function safeCount(value) {
  const number = safeInt(value, null);
  return number === null ? 0 : Math.min(number, MAX_COUNTER);
}

function safeAt(value, fallback = null) {
  return safeInt(value, fallback);
}

export function safeHost(value) {
  return SAFE_HOSTS.has(value) ? value : 'unknown';
}

export function normalizeGateId(value) {
  return GATE_IDS.includes(value) ? value : null;
}

export function normalizeGateRecord(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const gateId = normalizeGateId(source.gate_id ?? fallback.gate_id);
  if (!gateId) return null;
  return {
    gate_id: gateId,
    host: safeHost(source.host ?? fallback.host),
    status: GATE_STATUSES.includes(source.status) ? source.status : 'open',
    source: GATE_SOURCES.includes(source.source) ? source.source : 'unknown',
    opened_at: safeAt(source.opened_at, safeAt(fallback.opened_at, null)),
    updated_at: safeAt(source.updated_at, safeAt(fallback.updated_at, null)),
    evidence_revision: safeCount(source.evidence_revision),
    requires: source.requires === 'user_or_host' || source.requires === 'host' || source.requires === 'user' ? source.requires : 'user_or_host',
    blocking_scope: source.blocking_scope === 'session' || source.blocking_scope === 'experiment' ? source.blocking_scope : 'release',
    expires_at: source.expires_at === null ? null : safeAt(source.expires_at, null),
  };
}

export function normalizeExperimentRun(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = safeOptimizationId(source.run_id ?? source.receipt_id);
  if (!id) return null;
  const output = {
    ...normalizePolicyContext(source),
    run_id: id,
    task_key: isHashedIdentity(source.task_key) ? source.task_key : null,
    root_key: isHashedIdentity(source.root_key) ? source.root_key : null,
    work_unit_id: safeOptimizationId(source.work_unit_id),
    acceptance_fingerprint: typeof source.acceptance_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(source.acceptance_fingerprint) ? source.acceptance_fingerprint : null,
    workload_subtype: safeText(source.workload_subtype),
    coverage_status: ['exact','partial','unavailable'].includes(source.coverage_status) ? source.coverage_status : 'unavailable',
    work_started_at: safeAt(source.work_started_at,null),
    evidence_basis: ['manual_recorded','host_verified'].includes(source.evidence_basis) ? source.evidence_basis : 'unknown',
    rework_count: safeInt(source.rework_count,null),
    main_tokens: safeInt(source.main_tokens,null),
    subagent_tokens: safeInt(source.subagent_tokens,null),
    host: safeHost(source.host),
    router_state: ['enabled', 'disabled'].includes(source.router_state) ? source.router_state : 'unknown',
    router_version: safeText(source.router_version),
    variant: VARIANTS.includes(source.variant) ? source.variant : 'control',
    workload_class: WORKLOAD_CLASSES.includes(source.workload_class) ? source.workload_class : 'unknown',
    outcome: OUTCOMES.includes(source.outcome) ? source.outcome : 'unknown',
    verification: VERIFICATIONS.includes(source.verification) ? source.verification : 'unknown',
    state: EXPERIMENT_STATES.includes(source.state) ? source.state : 'closed',
    started_at: safeAt(source.started_at, null),
    closed_at: safeAt(source.closed_at, null),
    token_quality: ['exact', 'partial', 'unavailable'].includes(source.token_quality) ? source.token_quality : 'unavailable',
    source_type: safeText(source.source_type),
    schema_version: typeof source.schema_version === 'string' && SAFE_VERSION.test(source.schema_version) && !isSensitiveRuntimeValue(source.schema_version) ? source.schema_version : 'unknown',
    usage_schema_version: typeof source.usage_schema_version === 'string' && SAFE_VERSION.test(source.usage_schema_version) && !isSensitiveRuntimeValue(source.usage_schema_version) ? source.usage_schema_version : 'unknown',
    adapter_version: typeof source.adapter_version === 'string' && SAFE_VERSION.test(source.adapter_version) && !isSensitiveRuntimeValue(source.adapter_version) ? source.adapter_version : 'unknown',
    model: safeText(source.model),
    effort: safeText(source.effort),
    agent_policy: safeText(source.agent_policy),
    pricing_profile: safeText(source.pricing_profile),
    service_tier: EXPERIMENT_SERVICE_TIERS.includes(source.service_tier) ? source.service_tier : 'unavailable',
    recovery_ambiguous: source.recovery_ambiguous === true,
    receipt_evidence_complete: source.receipt_evidence_complete !== false && Array.isArray(source.receipt_ids) && source.receipt_ids.length > 0 && source.receipt_ids.length <= 8 && source.receipt_ids.every(id=>safeOptimizationId(id)) && new Set(source.receipt_ids).size===source.receipt_ids.length,
    receipt_ids: Array.isArray(source.receipt_ids) ? source.receipt_ids.map(safeOptimizationId).filter(Boolean).slice(0, 8) : [],
  };
  for (const field of ['total_tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens', 'calculated_provider_usage', 'duration_ms', 'source_count', 'retry_rate', 'fanout', 'compactions']) {
    if (typeof source[field] === 'number' && Number.isFinite(source[field]) && source[field] >= 0) output[field] = source[field];
  }
  const counters = ['total_tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens'];
  const supplied = field => source[field] !== undefined && source[field] !== null;
  // Preserve a rejected counter across repeated normalization; dropped invalid
  // fields must not turn a tainted cached record back into exact evidence.
  output.token_components_consistent = source.token_components_consistent !== false
    && counters.every(field => !supplied(field) || (Number.isSafeInteger(source[field]) && source[field] >= 0))
    && (!(supplied('input_tokens') && supplied('output_tokens') && supplied('total_tokens'))
      || source.input_tokens + source.output_tokens === source.total_tokens)
    && (!(supplied('cached_input_tokens') && supplied('input_tokens')) || source.cached_input_tokens <= source.input_tokens)
    && (!(supplied('reasoning_output_tokens') && supplied('output_tokens')) || source.reasoning_output_tokens <= source.output_tokens);
  return output;
}

export function normalizeReduction(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Cached statuses and percentages are not evidence. Recompute from bounded,
  // sanitized runs under the current comparison contract, including old records.
  return measureReduction({
    pair_id: source.pair_id,
    baseline: source.sample_evidence?.baseline,
    treatment: source.sample_evidence?.treatment,
    comparison_axis: source.comparison_axis,
  });
}

export function normalizeExperiment(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const experimentId = safeOptimizationId(source.experiment_id ?? source.id ?? fallback.experiment_id);
  if (!experimentId || !SAFE_HOSTS.has(source.host)) return null;
  const rawRuns = Array.isArray(source.runs) ? source.runs : [];
  const retainedRawRuns = rawRuns.slice(-MAX_EXPERIMENT_RUNS);
  const normalizedRuns = retainedRawRuns.map(normalizeExperimentRun).filter(Boolean);
  const historyDropped = !Array.isArray(source.runs)
    || rawRuns.length > MAX_EXPERIMENT_RUNS
    || normalizedRuns.length !== retainedRawRuns.length
    || (Number.isSafeInteger(source.run_count) && source.run_count > rawRuns.length);
  const attemptEvidenceComplete = source.attempt_evidence_complete === false || historyDropped
    ? false : source.attempt_evidence_complete === true ? true : null;
  const output = {
    experiment_id: experimentId,
    experiment_schema_version: OPTIMIZATION_SCHEMA_VERSION,
    pilot_epoch: pilotRevisionFromId(source.pilot_epoch, source.host) === null ? null : source.pilot_epoch,
    host: source.host,
    workload_class: WORKLOAD_CLASSES.includes(source.workload_class) ? source.workload_class : 'unknown',
    comparison_axis: COMPARISON_AXES.includes(source.comparison_axis) ? source.comparison_axis : 'other_safe_enum',
    recommendation_id: safeOptimizationId(source.recommendation_id) && Object.hasOwn(RECOMMENDATION_CATALOG, source.recommendation_id)
      ? source.recommendation_id
      : undefined,
    recommendation_status: OPTIMIZATION_STATUSES.includes(source.recommendation_status)
      ? source.recommendation_status
      : (safeOptimizationId(source.recommendation_id) ? 'not_applied' : 'not_applied'),
    state: EXPERIMENT_STATES.includes(source.state) ? source.state : 'active',
    started_at: safeAt(source.started_at, null),
    closed_at: safeAt(source.closed_at, null),
    run_count: safeCount(source.run_count),
    attempt_evidence_complete: attemptEvidenceComplete,
    runs: normalizedRuns,
  };
  return output;
}

export function normalizePair(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const baseline = normalizeExperimentRun(source.baseline);
  const treatment = normalizeExperimentRun(source.treatment);
  if (!baseline || !treatment) return null;
  return {
    pair_id: safeOptimizationId(source.pair_id) ?? `${baseline.run_id}:${treatment.run_id}`,
    experiment_id: safeOptimizationId(source.experiment_id) ?? 'unknown',
    ...compareRuns(baseline, treatment, { comparison_axis: source.comparison_axis }),
  };
}

export function normalizeShadowDecision(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const capabilityQuality = ['documented', 'fixture_verified', 'observed', 'live_verified', 'insufficient_evidence'].includes(source.capability_quality)
    ? source.capability_quality
    : 'insufficient_evidence';
  return {
    decision_id: safeOptimizationId(source.decision_id) ?? 'unknown',
    host: safeHost(source.host),
    decision: SHADOW_DECISIONS.includes(source.decision) ? source.decision : 'insufficient_evidence',
    policy_version: typeof source.policy_version === 'string' && SAFE_VERSION.test(source.policy_version) && !isSensitiveRuntimeValue(source.policy_version) ? source.policy_version : '1',
    quality: ['exact', 'partial', 'unavailable'].includes(source.quality) ? source.quality : 'unavailable',
    capability_quality: capabilityQuality,
    reason_codes: Array.isArray(source.reason_codes) ? [...new Set(source.reason_codes.filter((reason) => typeof reason === 'string' && SAFE_ID.test(reason) && !isSensitiveRuntimeValue(reason)))].slice(0, 8) : [],
    created_at: safeAt(source.created_at, null),
    suppressed_duplicate: source.suppressed_duplicate === true,
  };
}

export function normalizeCalibrationFeedback(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    feedback_id: safeOptimizationId(source.feedback_id) ?? 'unknown',
    decision_id: safeOptimizationId(source.decision_id) ?? 'unknown',
    feedback: CALIBRATION_FEEDBACK.includes(source.feedback) ? source.feedback : 'unknown',
    created_at: safeAt(source.created_at, null),
  };
}

export function createOptimizationState() {
  return {
    schema_version: OPTIMIZATION_SCHEMA_VERSION,
    experiment_collection_evidence: 'complete',
    experiment_pilot_epochs: {},
    experiment_pilot_revisions: { codex: 0, claude: 0 },
    active_policies: normalizeActivePolicies(null),
    lifecycle_checks: normalizeLifecycleChecks(null),
    handoff: normalizeHandoff(null),
    output_compaction: normalizeOutputAccounting(null),
    manual_gates: {},
    goal_hygiene: {},
    experiments: {},
    pairs: [],
    reductions: [],
    shadow_policy: [],
    calibration: [],
    counters: {},
  };
}

export function recoverOptimizationState(value) {
  const output = createOptimizationState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    output.experiment_collection_evidence = 'unknown';
    return output;
  }
  output.experiment_collection_evidence = collectionEvidence(value.experiment_collection_evidence);
  output.experiment_pilot_revisions = normalizePilotRevisions(value.experiment_pilot_revisions, value.experiment_pilot_epochs);
  output.experiment_pilot_epochs = normalizePilotEpochs(value.experiment_pilot_epochs);
  output.active_policies = normalizeActivePolicies(value.active_policies);
  output.lifecycle_checks = normalizeLifecycleChecks(value.lifecycle_checks);
  output.handoff = normalizeHandoff(value.handoff);
  output.output_compaction = normalizeOutputAccounting(value.output_compaction);
  for (const [key, record] of Object.entries(value.manual_gates ?? {}).slice(-MAX_OPTIMIZATION_ITEMS)) {
    const normalized = normalizeGateRecord(record, { gate_id: key });
    if (normalized) output.manual_gates[`${normalized.host}:${normalized.gate_id}`] = normalized;
  }
  for (const [key, record] of Object.entries(value.goal_hygiene ?? {}).slice(-MAX_OPTIMIZATION_ITEMS)) {
    if (!SAFE_KEY.test(key) || isSensitiveRuntimeValue(key) || !record || typeof record !== 'object') continue;
    output.goal_hygiene[key] = {
      gate_id: normalizeGateId(record.gate_id) ?? 'codex_hook_trust',
      continuation_count: safeCount(record.continuation_count),
      last_evidence_revision: safeCount(record.last_evidence_revision),
      structural_progress: safeCount(record.structural_progress),
      warnings: safeCount(record.warnings),
      updated_at: safeAt(record.updated_at, null),
    };
  }
  const sourceExperiments = value.experiments && typeof value.experiments === 'object' && !Array.isArray(value.experiments)
    ? value.experiments : {};
  const experimentEntries = Object.entries(sourceExperiments);
  if (!Object.hasOwn(value, 'experiments') && (value.experiment_collection_evidence === 'complete' || Object.keys(output.experiment_pilot_epochs).length > 0)) {
    markExperimentLoss(output, null);
  } else if (value.experiments !== undefined && sourceExperiments !== value.experiments) markExperimentLoss(output, null);
  if (experimentEntries.length > MAX_OPTIMIZATION_ITEMS) {
    for (const [, record] of experimentEntries.slice(0, -MAX_OPTIMIZATION_ITEMS)) markExperimentLoss(output, record);
  }
  for (const [key, record] of experimentEntries.slice(-MAX_OPTIMIZATION_ITEMS)) {
    if (hasInvalidPilotEpochBinding(record)) markExperimentLoss(output, record);
    observePilotRevision(output, record);
    const normalized = normalizeExperiment(record, { experiment_id: key });
    if (!normalized) {
      markExperimentLoss(output, record);
      continue;
    }
    const normalizedKey = `${normalized.host}:${normalized.experiment_id}`;
    if (Object.hasOwn(output.experiments, normalizedKey)) {
      markExperimentLoss(output, record);
      markExperimentLoss(output, output.experiments[normalizedKey]);
    }
    output.experiments[normalizedKey] = normalized;
  }
  output.pairs = Array.isArray(value.pairs) ? value.pairs.map(normalizePair).filter(Boolean).slice(-MAX_PAIRS) : [];
  output.reductions = Array.isArray(value.reductions) ? value.reductions.map(normalizeReduction).filter(Boolean).slice(-MAX_PAIRS) : [];
  output.shadow_policy = Array.isArray(value.shadow_policy) ? value.shadow_policy.map(normalizeShadowDecision).slice(-MAX_POLICY_DECISIONS) : [];
  output.calibration = Array.isArray(value.calibration) ? value.calibration.map(normalizeCalibrationFeedback).slice(-MAX_CALIBRATION_FEEDBACK) : [];
  for (const [key, count] of Object.entries(value.counters ?? {}).slice(0, 64)) if (/^[a-z0-9_]{1,80}$/.test(key) && !isSensitiveRuntimeValue(key) && Number.isSafeInteger(count) && count >= 0) output.counters[key] = Math.min(count, MAX_COUNTER);
  return trimOptimizationState(output);
}

export function trimOptimizationState(state) {
  if (!state || typeof state !== 'object') return state;
  const now = Date.now();
  state.experiment_collection_evidence = collectionEvidence(state.experiment_collection_evidence);
  state.experiment_pilot_revisions = normalizePilotRevisions(state.experiment_pilot_revisions, state.experiment_pilot_epochs);
  state.experiment_pilot_epochs = normalizePilotEpochs(state.experiment_pilot_epochs);
  state.active_policies = normalizeActivePolicies(state.active_policies);
  state.lifecycle_checks = normalizeLifecycleChecks(state.lifecycle_checks);
  state.handoff = normalizeHandoff(state.handoff);
  state.output_compaction = normalizeOutputAccounting(state.output_compaction);
  state.manual_gates = Object.fromEntries(Object.entries(state.manual_gates ?? {}).slice(-MAX_OPTIMIZATION_ITEMS));
  for (const [key, value] of Object.entries(state.manual_gates)) {
    const gate = normalizeGateRecord(value);
    if (!gate) {
      delete state.manual_gates[key];
      continue;
    }
    const stale = (gate.expires_at !== null && gate.expires_at <= now)
      || (gate.status === 'open' && gate.opened_at !== null && now - gate.opened_at > MAX_GATE_AGE_MS);
    state.manual_gates[key] = stale && ['open', 'deferred'].includes(gate.status)
      ? { ...gate, status: 'expired', updated_at: now }
      : gate;
  }
  state.goal_hygiene = Object.fromEntries(Object.entries(state.goal_hygiene ?? {}).slice(-MAX_OPTIMIZATION_ITEMS));
  const sourceExperiments = state.experiments && typeof state.experiments === 'object' && !Array.isArray(state.experiments)
    ? state.experiments : {};
  const experimentEntries = Object.entries(sourceExperiments);
  if (sourceExperiments !== state.experiments) markExperimentLoss(state, null);
  if (experimentEntries.length > MAX_OPTIMIZATION_ITEMS) {
    for (const [, record] of experimentEntries.slice(0, -MAX_OPTIMIZATION_ITEMS)) markExperimentLoss(state, record);
  }
  state.experiments = Object.fromEntries(experimentEntries.slice(-MAX_OPTIMIZATION_ITEMS));
  for (const [key, value] of Object.entries(state.experiments)) {
    if (hasInvalidPilotEpochBinding(value)) markExperimentLoss(state, value);
    observePilotRevision(state, value);
    const experiment = normalizeExperiment(value);
    if (!experiment) {
      delete state.experiments[key];
      markExperimentLoss(state, value);
      continue;
    }
    if (experiment.state === 'active' && experiment.started_at !== null && now - experiment.started_at > MAX_EXPERIMENT_AGE_MS) {
      experiment.state = 'expired';
      experiment.closed_at = now;
      experiment.runs = experiment.runs.map((run) => run.state === 'active' ? { ...run, state: 'expired', closed_at: now } : run);
    }
    state.experiments[key] = normalizeExperiment(experiment);
  }
  state.pairs = Array.isArray(state.pairs) ? state.pairs.slice(-MAX_PAIRS) : [];
  state.reductions = Array.isArray(state.reductions) ? state.reductions.slice(-MAX_PAIRS) : [];
  state.shadow_policy = Array.isArray(state.shadow_policy) ? state.shadow_policy.slice(-MAX_POLICY_DECISIONS) : [];
  state.calibration = Array.isArray(state.calibration) ? state.calibration.slice(-MAX_CALIBRATION_FEEDBACK) : [];
  return state;
}

export function optimizationBounds() {
  return {
    max_items: MAX_OPTIMIZATION_ITEMS,
    max_experiment_runs: MAX_EXPERIMENT_RUNS,
    max_pairs: MAX_PAIRS,
    max_policy_decisions: MAX_POLICY_DECISIONS,
    max_calibration_feedback: MAX_CALIBRATION_FEEDBACK,
    max_gate_age_ms: MAX_GATE_AGE_MS,
    max_experiment_age_ms: MAX_EXPERIMENT_AGE_MS,
  };
}
