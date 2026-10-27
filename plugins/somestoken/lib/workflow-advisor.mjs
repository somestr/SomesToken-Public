import {safeModel} from './core.mjs';
import { MODEL_FAMILIES, modelFamily, ROUTING_EFFORTS } from './routing.mjs';
import { profileModelId } from './profiles.mjs';
import { findComparablePairs } from './optimization/pairing.mjs';
import { BENEFIT_STATUSES, COST_COMPONENTS, measureReduction, summarizeReductions } from './optimization/reductions.mjs';
import { EXPERIMENT_SERVICE_TIERS, normalizeExperiment, WORKLOAD_CLASSES } from './optimization/schema.mjs';
import { normalizeFastModeMetadata } from './fast-mode.mjs';
import { compareComparableBaseline } from './efficiency/metrics.mjs';

export const WORKFLOW_ADVISOR_SCHEMA_VERSION = 4;
export const WORKFLOW_ADVISOR_LEGACY_SCHEMA_VERSION = 3;
export const WORKFLOW_CONTEXT_SCHEMA_VERSION = 1;
export const WORKFLOW_CONSUMPTION_SCHEMA_VERSION = 1;
export const WORKFLOW_ADVISOR_DEFAULTS = Object.freeze({
  minimum_elapsed_ms: 30 * 60 * 1000,
  minimum_comparable_receipts: 10,
  cooldown_ms: 24 * 60 * 60 * 1000,
  max_receipts: 100,
});

const HOSTS = new Set(['codex', 'claude']);
const STATUS = new Set(['exact', 'partial', 'unavailable']);
const PRESSURE = new Set(['low', 'watch', 'high', 'unavailable']);
const DECISION_SCOPES = new Set(['active_session', 'comparable_workload_cohort']);
const WORKLOAD_CLASS_SET = new Set(WORKLOAD_CLASSES);
const WORKFLOW_SERVICE_TIERS = new Set(EXPERIMENT_SERVICE_TIERS);
const COMPARABLE_WORKFLOW_SERVICE_TIERS = new Set(['fast', 'standard', 'ultrafast']);
const CONSUMPTION_PRESSURES = new Set(['typical', 'elevated', 'unavailable']);
const EFFORTS = new Set(ROUTING_EFFORTS);
const TELEMETRY_STATES = new Set(['received', 'pending_post_turn', 'unavailable']);
const EVIDENCE_TELEMETRY_STATES = new Set([...TELEMETRY_STATES, 'not_reported']);
const SERVICE_TIER_CONTEXTS = new Set(['observed', 'partial', 'unavailable']);
const COMPARISON_QUALITIES = new Set(['exact', 'insufficient_evidence', 'unavailable']);
const EFFORT_RANK = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 });
const MODEL_FAMILY_SET = new Set(MODEL_FAMILIES);
const WORKFLOWS = new Set(['light_bounded', 'balanced_review', 'deep_reasoning']);
const REASONS = new Set([
  'minimum_comparable_receipts_not_met',
  'minimum_elapsed_not_met',
  'profile_unknown',
  'current_receipt_not_exact',
  'structural_metrics_unavailable',
  'structural_metrics_partial',
  'structural_metrics_insufficient',
  'telemetry_reconciliation_pending',
  'telemetry_reconciliation_unavailable',
  'capability_evidence_unavailable',
  'legacy_workflow_advisor_schema',
  'host_workflow_model_unavailable',
  'low_structural_pressure',
  'watch_structural_pressure',
  'high_structural_pressure',
  'current_profile_already_matches_candidate',
  'workflow_context_unknown',
  'workflow_context_config_mismatch',
  'workflow_cohort_insufficient',
  'workflow_cohort_schema_mismatch',
  'workflow_cohort_tier_mismatch',
  'workflow_service_tier_noncomparable',
  'workflow_consumption_baseline_insufficient',
  'workflow_consumption_current_not_exact',
  'workflow_consumption_total_unavailable',
]);
const RECOMMENDATION_ID = 'workflow_model_candidate';
const MAX_RECOMMENDATIONS = 3;
const MAX_REASON_CODES = 8;
const MAX_COUNT = 100;
const MAX_ELAPSED_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_EXACT_STRUCTURAL_SIGNALS = 3;
const MAX_EXPERIMENTS = 32;
const PRESSURE_SIGNALS = Object.freeze([
  ['structured_failure_rate', 0.2],
  ['retry_after_failure_rate', 0.25],
  ['pending_source_rate', 0.2],
  ['subagent_respawn_rate', 0.25],
  ['compactions_per_100k_tokens', 2],
]);
const EXPERIMENT_PROGRESS_STATES = new Set([
  'unavailable', 'not_started', 'baseline_active', 'ready_for_treatment',
  'treatment_active', 'measured', 'incomparable',
]);
const EXPERIMENT_NEXT_ACTIONS = new Set([
  'collect_more_evidence', 'start_baseline', 'close_baseline',
  'start_treatment', 'close_treatment', 'review_result',
]);
const EXPERIMENT_PROGRESS_REASONS = new Set([
  'experiment_axis_mismatch', 'experiment_profile_mismatch',
  'baseline_not_exact', 'treatment_not_exact', 'experiment_pair_incomparable',
  'experiment_context_mismatch', 'mixed_comparison_context',
]);
const EXPERIMENT_BENEFIT_REASONS = new Set([
  'comparison_not_eligible', 'tokens_not_reduced', 'rework_measurement_unavailable',
  'rework_increased', 'elapsed_measurement_unavailable', 'elapsed_work_increased',
  'mixed_comparison_context',
  ...COST_COMPONENTS.flatMap(field => [`${field}_increased`, `${field}_measurement_unavailable`]),
]);

function safeHost(value) {
  return HOSTS.has(value) ? value : 'unknown';
}

function safeCount(value, maximum = MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : null;
}

function safeElapsed(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_ELAPSED_MS) : null;
}

function safeProfile(receipt) {
  const family = modelFamily(receipt?.metadata?.model);
  const effort = EFFORTS.has(receipt?.metadata?.reasoning_effort)
    ? receipt.metadata.reasoning_effort
    : 'unknown';
  return { model_family: family, reasoning_effort: effort };
}

function profileKnown(profile) {
  return MODEL_FAMILY_SET.has(profile?.model_family)
    && EFFORTS.has(profile?.reasoning_effort);
}

function normalizedConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const positive = (entry, fallback, maximum) => Number.isSafeInteger(entry) && entry > 0
    ? Math.min(entry, maximum)
    : fallback;
  return {
    minimum_elapsed_ms: positive(source.minimum_elapsed_ms, WORKFLOW_ADVISOR_DEFAULTS.minimum_elapsed_ms, MAX_ELAPSED_MS),
    minimum_comparable_receipts: positive(source.minimum_comparable_receipts, WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts, MAX_COUNT),
    cooldown_ms: positive(source.cooldown_ms, WORKFLOW_ADVISOR_DEFAULTS.cooldown_ms, MAX_ELAPSED_MS),
    max_receipts: positive(source.max_receipts, WORKFLOW_ADVISOR_DEFAULTS.max_receipts, MAX_COUNT),
    workload_class: WORKLOAD_CLASS_SET.has(source.workload_class) ? source.workload_class : 'unknown',
  };
}

function workflowServiceTier(value) {
  if (WORKFLOW_SERVICE_TIERS.has(value)) return value;
  const observed = normalizeFastModeMetadata({ service_tier: value })?.service_tier;
  if (observed === 'fast' || observed === 'priority') return 'fast';
  if (observed === 'default') return 'standard';
  if (observed === 'ultrafast') return 'ultrafast';
  if (observed !== undefined) return 'other_observed';
  return 'unavailable';
}

/**
 * Keep the receipt-level workflow label deliberately smaller than host
 * metadata. It is a fixed cohort selector, not a task description or a
 * reconstruction of the prompt that created the turn.
 */
export function normalizeWorkflowContext(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    workflow_context_schema_version: WORKFLOW_CONTEXT_SCHEMA_VERSION,
    workload_class: WORKLOAD_CLASS_SET.has(source.workload_class) ? source.workload_class : 'unknown',
    main_service_tier: workflowServiceTier(source.main_service_tier),
  };
}

/** Build receipt context from only normalized config and structured tier metadata. */
export function workflowContextForReceipt(receipt = {}, config = {}) {
  const settings = normalizedConfig(config);
  return normalizeWorkflowContext({
    workflow_context_schema_version: WORKFLOW_CONTEXT_SCHEMA_VERSION,
    workload_class: settings.workload_class,
    main_service_tier: receipt?.metadata?.service_tier,
  });
}

function selectedWindow(receipts, maxReceipts) {
  if (!Array.isArray(receipts)) return [];
  const safe = receipts.filter((entry) => entry && typeof entry === 'object');
  const latest = latestReceipt(safe);
  if (!latest || typeof latest.session !== 'string' || latest.session.length === 0) return recentReceipts(safe, maxReceipts);
  return recentReceipts(safe.filter((entry) => entry.session === latest.session), maxReceipts);
}

function safeSchemaVersion(value) {
  if (Number.isSafeInteger(value) && value >= 1 && value <= 100) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9._:+-]{1,40}$/.test(value) ? value : 'unknown';
}

function cohortModel(receipt) {
  const model = receipt?.metadata?.model;
  return typeof model === 'string' && /^[A-Za-z0-9._:+-]{1,80}$/.test(model) ? model : 'unknown';
}

function cohortEffort(receipt) {
  return EFFORTS.has(receipt?.metadata?.reasoning_effort)
    ? receipt.metadata.reasoning_effort
    : 'unknown';
}

function workflowCohortIdentity(receipt, host) {
  if (receipt?.status !== 'exact' || safeHost(host) === 'unknown') return null;
  const context = normalizeWorkflowContext(receipt?.workflow_context);
  const model = cohortModel(receipt);
  const effort = cohortEffort(receipt);
  const receiptSchema = safeSchemaVersion(receipt?.schema_version);
  const usageSchema = safeSchemaVersion(receipt?.usage_layers?.usage_schema_version);
  if (context.workload_class === 'unknown'
    || !COMPARABLE_WORKFLOW_SERVICE_TIERS.has(context.main_service_tier)
    || model === 'unknown'
    || receiptSchema === 'unknown'
    || usageSchema === 'unknown') return null;
  return {
    host: safeHost(host),
    workload_class: context.workload_class,
    main_service_tier: context.main_service_tier,
    model,
    reasoning_effort: effort,
    receipt_schema_version: receiptSchema,
    usage_schema_version: usageSchema,
  };
}

function sameWorkflowCohort(left, right) {
  return Boolean(left && right
    && left.host === right.host
    && left.workload_class === right.workload_class
    && left.main_service_tier === right.main_service_tier
    && left.model === right.model
    && left.reasoning_effort === right.reasoning_effort
    && left.receipt_schema_version === right.receipt_schema_version
    && left.usage_schema_version === right.usage_schema_version);
}

function workflowCohortKey(receipt, host) {
  const identity = workflowCohortIdentity(receipt, host);
  if (!identity) return null;
  return [
    identity.host,
    identity.workload_class,
    identity.model,
    identity.reasoning_effort,
    identity.receipt_schema_version,
    identity.usage_schema_version,
    identity.main_service_tier,
    'main',
  ].join('|');
}

function safeTokenTotal(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function workflowConsumptionContext({ latest, history, host, cohort, minimumSamples }) {
  const baseline = compareComparableBaseline(latest, history, {
    minimum_samples: minimumSamples,
    key_for: (entry) => workflowCohortKey(entry, host),
  });
  const currentStatus = STATUS.has(latest?.status) ? latest.status : 'unavailable';
  const currentTokens = safeTokenTotal(latest?.total_tokens);
  const exact = baseline.quality === 'exact';
  const reasons = [];
  if (currentStatus !== 'exact') reasons.push('workflow_consumption_current_not_exact');
  if (currentTokens === null) reasons.push('workflow_consumption_total_unavailable');
  if (!exact) reasons.push('workflow_consumption_baseline_insufficient');
  return {
    workflow_consumption_schema_version: WORKFLOW_CONSUMPTION_SCHEMA_VERSION,
    quality: exact ? 'exact' : currentStatus === 'unavailable' || currentTokens === null ? 'unavailable' : 'partial',
    decision_scope: cohort.decision_scope,
    workload_class: cohort.workload_class,
    main_service_tier: cohort.main_service_tier,
    sample_count: safeCount(baseline.sample_count),
    minimum_samples: safeCount(baseline.minimum_samples) || WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts,
    current_tokens: currentTokens,
    median_tokens: exact ? safeTokenTotal(baseline.median) : null,
    mad_tokens: exact ? safeTokenTotal(baseline.mad) : null,
    p90_tokens: exact ? safeTokenTotal(baseline.p90) : null,
    delta_from_median: exact && Number.isSafeInteger(baseline.delta_from_median) ? baseline.delta_from_median : null,
    pressure: exact ? (currentTokens > baseline.p90 ? 'elevated' : 'typical') : 'unavailable',
    reason_codes: [...new Set(reasons)].slice(0, MAX_REASON_CODES),
  };
}

function emptyWorkflowConsumptionContext(overrides = {}) {
  const decisionScope = DECISION_SCOPES.has(overrides.decision_scope) ? overrides.decision_scope : 'active_session';
  const workloadClass = WORKLOAD_CLASS_SET.has(overrides.workload_class) ? overrides.workload_class : 'unknown';
  const serviceTier = WORKFLOW_SERVICE_TIERS.has(overrides.main_service_tier) ? overrides.main_service_tier : 'unavailable';
  return {
    workflow_consumption_schema_version: WORKFLOW_CONSUMPTION_SCHEMA_VERSION,
    quality: 'unavailable',
    decision_scope: decisionScope,
    workload_class: workloadClass,
    main_service_tier: serviceTier,
    sample_count: 0,
    minimum_samples: WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts,
    current_tokens: null,
    median_tokens: null,
    mad_tokens: null,
    p90_tokens: null,
    delta_from_median: null,
    pressure: 'unavailable',
    reason_codes: Array.isArray(overrides.reason_codes)
      ? [...new Set(overrides.reason_codes.filter((entry) => REASONS.has(entry)))].slice(0, MAX_REASON_CODES)
      : [],
  };
}

function cleanConsumptionContext(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = emptyWorkflowConsumptionContext(fallback);
  const decisionScope = DECISION_SCOPES.has(source.decision_scope) ? source.decision_scope : defaults.decision_scope;
  const workloadClass = WORKLOAD_CLASS_SET.has(source.workload_class) ? source.workload_class : defaults.workload_class;
  const serviceTier = WORKFLOW_SERVICE_TIERS.has(source.main_service_tier) ? source.main_service_tier : defaults.main_service_tier;
  const requestedQuality = STATUS.has(source.quality) ? source.quality : 'unavailable';
  const sampleCount = safeCount(source.sample_count);
  const minimumSamples = safeCount(source.minimum_samples) || defaults.minimum_samples;
  const currentTokens = safeTokenTotal(source.current_tokens);
  const median = safeTokenTotal(source.median_tokens);
  const mad = safeTokenTotal(source.mad_tokens);
  const p90 = safeTokenTotal(source.p90_tokens);
  const delta = Number.isSafeInteger(source.delta_from_median) ? source.delta_from_median : null;
  const exact = requestedQuality === 'exact'
    && sampleCount >= minimumSamples
    && currentTokens !== null
    && median !== null
    && mad !== null
    && p90 !== null
    && delta !== null;
  const quality = exact ? 'exact' : requestedQuality === 'partial' && currentTokens !== null ? 'partial' : 'unavailable';
  return {
    workflow_consumption_schema_version: WORKFLOW_CONSUMPTION_SCHEMA_VERSION,
    quality,
    decision_scope: decisionScope,
    workload_class: workloadClass,
    main_service_tier: serviceTier,
    sample_count: sampleCount,
    minimum_samples: minimumSamples,
    current_tokens: currentTokens,
    median_tokens: exact ? median : null,
    mad_tokens: exact ? mad : null,
    p90_tokens: exact ? p90 : null,
    delta_from_median: exact ? delta : null,
    pressure: exact && CONSUMPTION_PRESSURES.has(source.pressure) && source.pressure !== 'unavailable'
      ? source.pressure
      : 'unavailable',
    reason_codes: Array.isArray(source.reason_codes)
      ? [...new Set(source.reason_codes.filter((entry) => REASONS.has(entry)))].slice(0, MAX_REASON_CODES)
      : [],
  };
}

/**
 * Select the bounded receipt set behind one workflow decision. The initial
 * scope intentionally preserves the existing active-session boundary; later
 * cohort extensions build on this one selection authority.
 */
export function selectWorkflowCohort(input = {}) {
  const config = normalizedConfig(input.config);
  const all = Array.isArray(input.receipts) ? input.receipts.filter((entry) => entry && typeof entry === 'object') : [];
  const latest = latestReceipt(all);
  const active = selectedWindow(all, config.max_receipts);
  const context = normalizeWorkflowContext(latest?.workflow_context);
  const identity = workflowCohortIdentity(latest, input.host);
  const configured = config.workload_class;
  const activeResult = (reasonCodes = []) => ({
    receipts: active,
    latest: latestReceipt(active),
    decision_scope: 'active_session',
    workload_class: context.workload_class,
    main_service_tier: context.main_service_tier,
    reason_codes: [...new Set(reasonCodes)].slice(0, MAX_REASON_CODES),
  });
  if (configured === 'unknown' || context.workload_class === 'unknown') {
    return activeResult(['workflow_context_unknown']);
  }
  if (configured !== context.workload_class || !identity) {
    return activeResult(['workflow_cohort_insufficient']);
  }

  const reasons = [];
  const exact = all.filter((entry) => entry.status === 'exact');
  const matching = exact.filter((entry) => sameWorkflowCohort(workflowCohortIdentity(entry, input.host), identity));
  const sameProfile = exact.filter((entry) => {
    const candidate = workflowCohortIdentity(entry, input.host);
    return candidate
      && candidate.host === identity.host
      && candidate.workload_class === identity.workload_class
      && candidate.model === identity.model
      && candidate.reasoning_effort === identity.reasoning_effort;
  });
  if (sameProfile.some((entry) => {
    const candidate = workflowCohortIdentity(entry, input.host);
    return candidate
      && (candidate.receipt_schema_version !== identity.receipt_schema_version
        || candidate.usage_schema_version !== identity.usage_schema_version);
  })) reasons.push('workflow_cohort_schema_mismatch');
  if (sameProfile.some((entry) => workflowCohortIdentity(entry, input.host)?.main_service_tier !== identity.main_service_tier)) {
    reasons.push('workflow_cohort_tier_mismatch');
  }
  if (!matching.length) reasons.push('workflow_cohort_insufficient');
  const receipts = recentReceipts(matching, config.max_receipts);
  return {
    receipts,
    latest: latestReceipt(receipts),
    decision_scope: 'comparable_workload_cohort',
    workload_class: identity.workload_class,
    main_service_tier: identity.main_service_tier,
    reason_codes: [...new Set(reasons)].slice(0, MAX_REASON_CODES),
  };
}

function latestReceipt(receipts) {
  let latest = null;
  let latestAt = -1;
  for (const entry of Array.isArray(receipts) ? receipts : []) {
    const createdAt = safeTimestamp(entry?.created_at);
    if (createdAt !== null && createdAt >= latestAt) {
      latest = entry;
      latestAt = createdAt;
    }
  }
  return latest ?? (Array.isArray(receipts) ? receipts.at(-1) : null);
}

function recentReceipts(receipts, maxReceipts) {
  if (!Array.isArray(receipts)) return [];
  const limit = Number.isSafeInteger(maxReceipts) && maxReceipts > 0 ? maxReceipts : receipts.length;
  if (receipts.length <= limit) return receipts;
  const annotated = receipts.map((entry, index) => ({
    entry,
    index,
    createdAt: safeTimestamp(entry?.created_at),
  }));
  // Missing timestamps do not establish chronology. Preserve insertion order
  // in that case instead of inventing a date-based window.
  if (annotated.some((item) => item.createdAt === null)) return receipts.slice(-limit);
  return annotated
    .sort((left, right) => left.createdAt - right.createdAt || left.index - right.index)
    .slice(-limit)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.entry);
}

function metricSignal(metrics, key, threshold) {
  const metric = metrics?.[key];
  const value = metric?.value;
  return {
    key,
    threshold,
    value: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null,
    quality: STATUS.has(metric?.quality) ? metric.quality : 'unavailable',
  };
}

function pressureFor(metrics) {
  const signals = PRESSURE_SIGNALS.map(([key, threshold]) => metricSignal(metrics, key, threshold));
  const exact = signals.filter((entry) => entry.value !== null && entry.quality === 'exact');
  const partial = signals.filter((entry) => entry.value !== null && entry.quality === 'partial');
  const evidenceCounts = {
    exact_structural_signals: exact.length,
    ...(partial.length ? { partial_structural_signals: partial.length } : {}),
  };
  if (exact.length < MIN_EXACT_STRUCTURAL_SIGNALS) {
    const reason = partial.length
      ? 'structural_metrics_partial'
      : exact.length
        ? 'structural_metrics_insufficient'
        : 'structural_metrics_unavailable';
    return {
      pressure: 'unavailable',
      quality: partial.length || exact.length ? 'partial' : 'unavailable',
      reason_codes: [reason],
      evidence_counts: evidenceCounts,
    };
  }
  const elevated = exact.filter((entry) => entry.value >= entry.threshold);
  if (elevated.length >= 2) return {
    pressure: 'high', quality: 'exact', reason_codes: ['high_structural_pressure'], evidence_counts: { ...evidenceCounts, high_signals: elevated.length },
  };
  if (elevated.length === 1) return {
    pressure: 'watch', quality: 'exact', reason_codes: ['watch_structural_pressure'], evidence_counts: { ...evidenceCounts, watch_signals: 1 },
  };
  return { pressure: 'low', quality: 'exact', reason_codes: ['low_structural_pressure'], evidence_counts: { ...evidenceCounts, low_signals: exact.length } };
}

function telemetryState(value) {
  if (value === undefined) return 'not_reported';
  return TELEMETRY_STATES.has(value) ? value : 'unavailable';
}

function capabilityEvidence(value) {
  return value === 'observed' || value === 'live_verified' ? value : 'unavailable';
}

function fastModeEvidence(value) {
  const coverage = value?.coverage;
  // `known_tier_sources` is retained for older snapshots and represents only
  // Fast/Standard-comparable data. Any structured tier, including ultrafast,
  // is still valid service-tier context for an advisory receipt.
  const observedTierSources = safeCount(value?.observed_tier_sources ?? value?.known_tier_sources);
  const comparisonQuality = COMPARISON_QUALITIES.has(value?.comparison_status)
    ? value.comparison_status
    : 'unavailable';
  const serviceTierContext = observedTierSources > 0 && coverage === 'effective_service_tier_observed'
    ? 'observed'
    : observedTierSources > 0 && coverage === 'partial_effective_service_tier'
      ? 'partial'
      : 'unavailable';
  return { service_tier_context: serviceTierContext, comparison_quality: comparisonQuality };
}

function workflowEvidence(currentStatus, telemetry, pressureResult, fastMode) {
  const receiptQuality = STATUS.has(currentStatus) ? currentStatus : 'unavailable';
  const telemetryValue = telemetryState(telemetry);
  const metricsQuality = STATUS.has(pressureResult?.quality) ? pressureResult.quality : 'unavailable';
  const tier = fastModeEvidence(fastMode);
  const reasonCodes = [];
  if (receiptQuality !== 'exact') reasonCodes.push('current_receipt_not_exact');
  if (telemetryValue === 'pending_post_turn') reasonCodes.push('telemetry_reconciliation_pending');
  if (telemetryValue === 'unavailable') reasonCodes.push('telemetry_reconciliation_unavailable');
  if (metricsQuality !== 'exact') reasonCodes.push(...(pressureResult?.reason_codes ?? []));
  return {
    receipt_quality: receiptQuality,
    telemetry_state: telemetryValue,
    structural_metrics_quality: metricsQuality,
    ...tier,
    reason_codes: [...new Set(reasonCodes)].slice(0, MAX_REASON_CODES),
    ready: receiptQuality === 'exact'
      && (telemetryValue === 'received' || telemetryValue === 'not_reported')
      && metricsQuality === 'exact',
  };
}

function cleanEvidence(value) {
  return {
    receipt_quality: STATUS.has(value?.receipt_quality) ? value.receipt_quality : 'unavailable',
    telemetry_state: EVIDENCE_TELEMETRY_STATES.has(value?.telemetry_state) ? value.telemetry_state : 'not_reported',
    structural_metrics_quality: STATUS.has(value?.structural_metrics_quality) ? value.structural_metrics_quality : 'unavailable',
    service_tier_context: SERVICE_TIER_CONTEXTS.has(value?.service_tier_context) ? value.service_tier_context : 'unavailable',
    comparison_quality: COMPARISON_QUALITIES.has(value?.comparison_quality) ? value.comparison_quality : 'unavailable',
  };
}

function fixedModelId(family) {
  const id = profileModelId(family);
  return id === 'unknown' ? null : id;
}

function exactComparableTokens(receipts) {
  let total = 0;
  let seen = false;
  for (const entry of Array.isArray(receipts) ? receipts : []) {
    if (entry?.status !== 'exact' || !Number.isSafeInteger(entry.total_tokens) || entry.total_tokens < 0) continue;
    seen = true;
    total = total > Number.MAX_SAFE_INTEGER - entry.total_tokens
      ? Number.MAX_SAFE_INTEGER
      : total + entry.total_tokens;
  }
  return seen ? total : null;
}

function sameProfile(profile, target) {
  return profile?.model_family === target?.model_family
    && profile?.reasoning_effort === target?.reasoning_effort;
}

function workflowFor(target, pressure) {
  if (pressure === 'high') return 'deep_reasoning';
  if (target.model_family === 'luna') return 'light_bounded';
  return 'balanced_review';
}

function target(model_family, reasoning_effort, pressure, comparison_axis) {
  return { model_family, reasoning_effort, workflow: workflowFor({ model_family, reasoning_effort }, pressure), comparison_axis };
}

function targetFor(profile, pressure) {
  const rank = EFFORT_RANK[profile?.reasoning_effort];
  if (rank === undefined) return null;
  if (pressure === 'high') {
    if (rank < EFFORT_RANK.max) return target(profile.model_family, 'max', pressure, 'effort');
    // Keep the established Luna/Terra escalation policy. Astra has no
    // catalog evidence for a Sol superiority claim, so it stays pinned to
    // its known model when it is already at Max.
    if (profile.reasoning_effort === 'max' && ['luna', 'terra'].includes(profile.model_family)) {
      return target('sol', 'max', pressure, 'model');
    }
    return null;
  }
  if (pressure === 'watch') {
    if (rank > EFFORT_RANK.medium) return target(profile.model_family, 'medium', pressure, 'effort');
    if (profile.model_family === 'luna' && profile.reasoning_effort === 'medium') return target('terra', 'medium', pressure, 'model');
    return null;
  }
  if (rank > EFFORT_RANK.medium) return target(profile.model_family, 'medium', pressure, 'effort');
  if (profile.reasoning_effort === 'medium' && profile.model_family === 'sol') return target('terra', 'medium', pressure, 'model');
  if (profile.reasoning_effort === 'medium' && profile.model_family === 'terra') return target('luna', 'medium', pressure, 'model');
  return null;
}

function recommendationCopy(family, effort) {
  const label = `${family[0].toUpperCase()}${family.slice(1)} ${effort}`;
  return `${label} may fit this observed workflow; review before changing the host profile.`;
}

function candidate(input, profile, pressureResult, sampleCount, affectedTokens) {
  const target = targetFor(profile, pressureResult.pressure);
  if (!target) return null;
  return {
    id: RECOMMENDATION_ID,
    status: 'candidate',
    host: input.host,
    model_family: target.model_family,
    model_id: fixedModelId(target.model_family),
    reasoning_effort: target.reasoning_effort,
    workflow: target.workflow,
    comparison_axis: target.comparison_axis,
    baseline_profile: { model_family: profile.model_family, reasoning_effort: profile.reasoning_effort },
    candidate_profile: { model_family: target.model_family, reasoning_effort: target.reasoning_effort },
    experiment_template: {
      availability: 'manual',
      comparison_axis: target.comparison_axis,
      required_verification: 'deterministic_checks_passed',
    },
    confidence: input.current_status === 'exact' && sampleCount >= 10 ? 'medium' : 'low',
    capability_evidence: capabilityEvidence(input.capability_evidence),
    reason_codes: pressureResult.reason_codes.slice(0, MAX_REASON_CODES),
    evidence_counts: { comparable_receipts: sampleCount, ...pressureResult.evidence_counts },
    affected_usage_quality: input.current_status === 'exact' ? 'exact' : 'partial',
    ...(Number.isSafeInteger(affectedTokens) && affectedTokens >= 0 ? { affected_tokens: affectedTokens } : {}),
    potential_savings: 'unmeasured',
    advisory_action: 'review_only',
    application_status: 'host_required',
    host_action: 'apply_profile_if_supported',
    monitoring_action: 'continue_current_task',
    copy: recommendationCopy(target.model_family, target.reasoning_effort),
  };
}

function decisionKey(host, recommendation, pressure, evidence) {
  const baseline = recommendation?.baseline_profile;
  const candidateProfile = recommendation?.candidate_profile;
  const axis = recommendation?.comparison_axis === 'model' || recommendation?.comparison_axis === 'effort'
    ? recommendation.comparison_axis
    : 'unavailable';
  const tier = SERVICE_TIER_CONTEXTS.has(evidence?.service_tier_context)
    ? evidence.service_tier_context
    : 'unavailable';
  const safeFamily = (value) => MODEL_FAMILY_SET.has(value) ? value : 'unknown';
  const safeEffort = (value) => EFFORTS.has(value) ? value : 'unknown';
  const safePressure = PRESSURE.has(pressure) && pressure !== 'unavailable' ? pressure : 'unavailable';
  return [
    safeHost(host),
    safeFamily(baseline?.model_family),
    safeEffort(baseline?.reasoning_effort),
    safeFamily(candidateProfile?.model_family),
    safeEffort(candidateProfile?.reasoning_effort),
    safePressure,
    axis,
    tier,
  ].join('|');
}

function cleanRecommendation(value) {
  if (!value || typeof value !== 'object' || value.id !== RECOMMENDATION_ID) return null;
  const family = MODEL_FAMILY_SET.has(value.model_family) ? value.model_family : null;
  const effort = EFFORTS.has(value.reasoning_effort) ? value.reasoning_effort : null;
  const workflow = WORKFLOWS.has(value.workflow) ? value.workflow : null;
  const comparisonAxis = value.comparison_axis === 'model' || value.comparison_axis === 'effort' ? value.comparison_axis : null;
  const baselineFamily = MODEL_FAMILY_SET.has(value.baseline_profile?.model_family) ? value.baseline_profile.model_family : null;
  const baselineEffort = EFFORTS.has(value.baseline_profile?.reasoning_effort) ? value.baseline_profile.reasoning_effort : null;
  const candidateFamily = MODEL_FAMILY_SET.has(value.candidate_profile?.model_family) ? value.candidate_profile.model_family : null;
  const candidateEffort = EFFORTS.has(value.candidate_profile?.reasoning_effort) ? value.candidate_profile.reasoning_effort : null;
  const evidence = capabilityEvidence(value.capability_evidence);
  if (value.status !== 'candidate' || !family || !effort || !workflow || !comparisonAxis || !baselineFamily || !baselineEffort || !candidateFamily || !candidateEffort || evidence === 'unavailable') return null;
  const baseline = { model_family: baselineFamily, reasoning_effort: baselineEffort };
  const candidateProfile = { model_family: candidateFamily, reasoning_effort: candidateEffort };
  if (sameProfile(baseline, candidateProfile)) return null;
  if (family !== candidateFamily || effort !== candidateEffort) return null;
  if (comparisonAxis === 'model' && baseline.reasoning_effort !== candidateProfile.reasoning_effort) return null;
  if (comparisonAxis === 'effort' && baseline.model_family !== candidateProfile.model_family) return null;
  return {
    id: RECOMMENDATION_ID,
    status: 'candidate',
    host: safeHost(value.host),
    model_family: family,
    model_id: fixedModelId(family),
    reasoning_effort: effort,
    workflow,
    comparison_axis: comparisonAxis,
    baseline_profile: baseline,
    candidate_profile: candidateProfile,
    experiment_template: {
      availability: 'manual',
      comparison_axis: comparisonAxis,
      required_verification: 'deterministic_checks_passed',
    },
    confidence: ['low', 'medium', 'high'].includes(value.confidence) ? value.confidence : 'low',
    capability_evidence: evidence,
    reason_codes: Array.isArray(value.reason_codes) ? [...new Set(value.reason_codes.filter((entry) => REASONS.has(entry)))].slice(0, MAX_REASON_CODES) : [],
    evidence_counts: Object.fromEntries(Object.entries(value.evidence_counts ?? {}).slice(0, 8).filter(([key, count]) => /^[a-z0-9_]{1,64}$/.test(key) && safeModel(key) && Number.isSafeInteger(count) && count >= 0).map(([key, count]) => [key, Math.min(count, MAX_COUNT)])),
    affected_usage_quality: STATUS.has(value.affected_usage_quality) ? value.affected_usage_quality : 'unavailable',
    ...(Number.isSafeInteger(value.affected_tokens) && value.affected_tokens >= 0
      ? { affected_tokens: Math.min(value.affected_tokens, Number.MAX_SAFE_INTEGER) }
      : {}),
    potential_savings: 'unmeasured',
    advisory_action: 'review_only',
    application_status: 'host_required',
    host_action: 'apply_profile_if_supported',
    monitoring_action: 'continue_current_task',
    copy: recommendationCopy(family, effort),
  };
}

function eligibleWorkflowCandidate({ host, status, currentProfile, pressure, evidence, sampleCount, minimumComparable, elapsed, minimumElapsed, recommendations, reasons }) {
  const evidenceReady = evidence.receipt_quality === 'exact'
    && (evidence.telemetry_state === 'received' || evidence.telemetry_state === 'not_reported')
    && evidence.structural_metrics_quality === 'exact';
  if (host !== 'codex' || status !== 'exact' || !profileKnown(currentProfile)
    || !evidenceReady || pressure === 'unavailable' || sampleCount < minimumComparable
    || elapsed === null || elapsed < minimumElapsed) return false;
  const target = targetFor(currentProfile, pressure);
  if (!target) return recommendations.length === 0 && reasons.includes('current_profile_already_matches_candidate');
  const recommendation = recommendations[0];
  return recommendations.length === 1
    && recommendation?.host === host
    && sameProfile(recommendation.baseline_profile, currentProfile)
    && sameProfile(recommendation.candidate_profile, target);
}

function emptyExperimentProgress() {
  return {
    status: 'unavailable',
    next_action: 'collect_more_evidence',
    matching_experiment_count: 0,
    baseline_runs: 0,
    treatment_runs: 0,
    measurement_status: 'measurement_unavailable',
    valid_pairs: 0,
    median_token_reduction_percent: null,
    median_calculated_provider_usage_reduction_percent: null,
    benefit_status: 'unavailable',
    benefit_reason_codes: [],
    reason_codes: [],
    potential_savings: 'unmeasured',
  };
}

function safeMeasuredPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -10_000 && value <= 10_000
    ? Math.round(value * 1_000_000) / 1_000_000
    : null;
}

function experimentProgress(status, nextAction, counts = {}, reasonCodes = []) {
  const measurementStatus = ['measurement_unavailable', 'single_pair_measured_observation', 'two_pair_measured_observations', 'measured_paired_trend'].includes(counts.measurement_status)
    ? counts.measurement_status
    : 'measurement_unavailable';
  return {
    status: EXPERIMENT_PROGRESS_STATES.has(status) ? status : 'unavailable',
    next_action: EXPERIMENT_NEXT_ACTIONS.has(nextAction) ? nextAction : 'collect_more_evidence',
    matching_experiment_count: safeCount(counts.matching_experiment_count, MAX_EXPERIMENTS),
    baseline_runs: safeCount(counts.baseline_runs, MAX_EXPERIMENTS),
    treatment_runs: safeCount(counts.treatment_runs, MAX_EXPERIMENTS),
    measurement_status: measurementStatus,
    valid_pairs: safeCount(counts.valid_pairs, MAX_EXPERIMENTS),
    median_token_reduction_percent: safeMeasuredPercent(counts.median_token_reduction_percent),
    median_calculated_provider_usage_reduction_percent: safeMeasuredPercent(counts.median_calculated_provider_usage_reduction_percent),
    benefit_status: BENEFIT_STATUSES.includes(counts.benefit_status) ? counts.benefit_status : 'unavailable',
    benefit_reason_codes: Array.isArray(counts.benefit_reason_codes)
      ? [...new Set(counts.benefit_reason_codes.filter((entry) => EXPERIMENT_BENEFIT_REASONS.has(entry)))].slice(0, MAX_REASON_CODES)
      : [],
    reason_codes: Array.isArray(reasonCodes)
      ? [...new Set(reasonCodes.filter((entry) => EXPERIMENT_PROGRESS_REASONS.has(entry)))].slice(0, MAX_REASON_CODES)
      : [],
    potential_savings: 'unmeasured',
  };
}

function profileMatches(run, profile) {
  return modelFamily(run?.model) === profile?.model_family
    && run?.effort === profile?.reasoning_effort;
}

function latestExperimentRun(runs) {
  let latest = null;
  let latestAt = -1;
  for (const run of Array.isArray(runs) ? runs : []) {
    const timestamp = safeTimestamp(run?.closed_at) ?? safeTimestamp(run?.started_at) ?? -1;
    if (timestamp >= latestAt) {
      latest = run;
      latestAt = timestamp;
    }
  }
  return latest ?? (Array.isArray(runs) ? runs.at(-1) ?? null : null);
}

function latestExperiment(experiments) {
  let latest = null;
  let latestAt = -1;
  for (const experiment of Array.isArray(experiments) ? experiments : []) {
    const run = latestExperimentRun(experiment?.runs);
    const timestamp = safeTimestamp(experiment?.closed_at)
      ?? safeTimestamp(experiment?.started_at)
      ?? safeTimestamp(run?.closed_at)
      ?? safeTimestamp(run?.started_at)
      ?? -1;
    if (timestamp >= latestAt) {
      latest = experiment;
      latestAt = timestamp;
    }
  }
  return latest ?? (Array.isArray(experiments) ? experiments.at(-1) ?? null : null);
}

function exactClosedRun(run) {
  return run?.state === 'closed'
    && run?.outcome === 'pass'
    && run?.verification === 'deterministic_checks_passed'
    && run?.token_quality === 'exact';
}

function hasComparableWorkflowContext(value) {
  return WORKLOAD_CLASS_SET.has(value?.workload_class)
    && value.workload_class !== 'unknown'
    && COMPARABLE_WORKFLOW_SERVICE_TIERS.has(value?.main_service_tier);
}

function experimentMatchesWorkflowCohort(experiment, cohort) {
  if (!hasComparableWorkflowContext(cohort)) return false;
  if (experiment?.workload_class !== cohort.workload_class) return false;
  const baselineRuns = Array.isArray(experiment?.runs)
    ? experiment.runs.filter((run) => run?.variant === 'baseline')
    : [];
  // The baseline anchors the observed workflow. Treatment context still goes
  // through the existing one-axis pair validator, which can report a precise
  // mismatch instead of hiding it as a generic cohort failure.
  return baselineRuns.length > 0
    && baselineRuns.every((run) => run.workload_class === cohort.workload_class
      && run.service_tier === cohort.main_service_tier);
}

function cleanExperimentProgress(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Compact reports carry lifecycle observations, but no runs with which to
  // revalidate a measured claim under the current comparison contract.
  const measuredClaim = source.status === 'measured' || source.next_action === 'review_result'
    || (typeof source.measurement_status === 'string' && source.measurement_status !== 'measurement_unavailable')
    || safeCount(source.valid_pairs) > 0
    || safeMeasuredPercent(source.median_token_reduction_percent) !== null
    || safeMeasuredPercent(source.median_calculated_provider_usage_reduction_percent) !== null;
  return experimentProgress(
    source.status === 'measured' ? 'incomparable' : source.status,
    source.status === 'measured' || source.next_action === 'review_result' ? 'collect_more_evidence' : source.next_action,
    { ...source, measurement_status: 'measurement_unavailable', valid_pairs: 0,
      median_token_reduction_percent: null, median_calculated_provider_usage_reduction_percent: null,
      benefit_status: 'unavailable', benefit_reason_codes: [] },
    [...(Array.isArray(source.reason_codes) ? source.reason_codes : []),
      ...(measuredClaim ? ['experiment_pair_incomparable'] : [])],
  );
}

function workflowExperimentProgress(recommendationValue, experiments, cohort) {
  const recommendation = cleanRecommendation(recommendationValue);
  if (!recommendation) return emptyExperimentProgress();
  const linked = (Array.isArray(experiments) ? experiments : [])
    .slice(-MAX_EXPERIMENTS)
    .map((entry) => normalizeExperiment(entry))
    .filter(Boolean)
    .filter((entry) => entry.host === recommendation.host && entry.recommendation_id === RECOMMENDATION_ID);
  if (!linked.length) return experimentProgress('not_started', 'start_baseline');

  const axisMatches = linked.filter((entry) => entry.comparison_axis === recommendation.comparison_axis);
  if (!axisMatches.length) {
    return experimentProgress('incomparable', 'collect_more_evidence', {}, ['experiment_axis_mismatch']);
  }

  const contextMatches = axisMatches.filter((entry) => experimentMatchesWorkflowCohort(entry, cohort));
  if (!contextMatches.length) {
    return experimentProgress('incomparable', 'collect_more_evidence', {}, ['experiment_context_mismatch']);
  }

  const profileMatchesRecommendation = contextMatches.filter((entry) => entry.runs
    .filter((run) => run.variant === 'baseline' || run.variant === 'treatment')
    .every((run) => run.variant === 'baseline'
      ? profileMatches(run, recommendation.baseline_profile)
      : profileMatches(run, recommendation.candidate_profile)));
  if (!profileMatchesRecommendation.length) {
    return experimentProgress('incomparable', 'collect_more_evidence', {}, ['experiment_profile_mismatch']);
  }

  const selected = latestExperiment(profileMatchesRecommendation);
  const baselineRuns = selected?.runs?.filter((run) => run.variant === 'baseline') ?? [];
  const treatmentRuns = selected?.runs?.filter((run) => run.variant === 'treatment') ?? [];
  const allRuns = profileMatchesRecommendation.flatMap((entry) => entry.runs ?? []);
  const matchingPairs = profileMatchesRecommendation
    .flatMap((entry) => findComparablePairs(entry.runs, {
      comparison_axis: recommendation.comparison_axis,
      experiment_id: entry.experiment_id,
    }))
    .slice(0, MAX_EXPERIMENTS);
  const measurement = summarizeReductions(matchingPairs.map(measureReduction));
  const counts = {
    matching_experiment_count: profileMatchesRecommendation.length,
    baseline_runs: allRuns.filter((run) => run.variant === 'baseline').length,
    treatment_runs: allRuns.filter((run) => run.variant === 'treatment').length,
    measurement_status: measurement.status,
    valid_pairs: measurement.valid_pairs,
    median_token_reduction_percent: measurement.median_token_reduction_percent,
    median_calculated_provider_usage_reduction_percent: measurement.median_calculated_provider_usage_reduction_percent,
    benefit_status: measurement.benefit_status,
    benefit_reason_codes: measurement.benefit_reason_codes,
  };
  const baseline = latestExperimentRun(baselineRuns);
  if (!baseline) return experimentProgress('not_started', 'start_baseline', counts);
  if (baseline.state === 'active') return experimentProgress('baseline_active', 'close_baseline', counts);
  if (!exactClosedRun(baseline)) {
    return experimentProgress('incomparable', 'collect_more_evidence', counts, ['baseline_not_exact']);
  }

  const treatment = latestExperimentRun(treatmentRuns);
  if (!treatment) return experimentProgress('ready_for_treatment', 'start_treatment', counts);
  if (treatment.state === 'active') return experimentProgress('treatment_active', 'close_treatment', counts);
  if (!exactClosedRun(treatment)) {
    return experimentProgress('incomparable', 'collect_more_evidence', counts, ['treatment_not_exact']);
  }

  if (measurement.valid_pairs > 0 && [
    'single_pair_measured_observation', 'two_pair_measured_observations', 'measured_paired_trend',
  ].includes(measurement.status)) {
    return experimentProgress('measured', 'review_result', counts);
  }
  return experimentProgress('incomparable', 'collect_more_evidence', counts,
    measurement.reason_codes?.length ? measurement.reason_codes : ['experiment_pair_incomparable']);
}

export function workflowAdvisorAnalytics(input = {}) {
  const config = normalizedConfig(input.config);
  const host = safeHost(input.host);
  const cohort = selectWorkflowCohort({ host, receipts: input.receipts, config });
  const selected = cohort.receipts;
  if (!selected.length) {
    return {
      workflow_advisor_schema_version: WORKFLOW_ADVISOR_SCHEMA_VERSION,
      status: 'unavailable',
      eligibility: 'unavailable',
      host,
      sample_count: 0,
      minimum_comparable_receipts: config.minimum_comparable_receipts,
      elapsed_ms: null,
      minimum_elapsed_ms: config.minimum_elapsed_ms,
      current_profile: { model_family: 'unknown', reasoning_effort: 'unknown' },
      pressure: 'unavailable',
      decision_scope: cohort.decision_scope,
      evidence: cleanEvidence(),
      reason_codes: [],
      evidence_counts: {},
      next_eligible: { remaining_receipts: config.minimum_comparable_receipts, remaining_ms: config.minimum_elapsed_ms },
      recommendations: [],
      experiment_progress: emptyExperimentProgress(),
      consumption_context: workflowConsumptionContext({
        latest: null,
        history: [],
        host,
        cohort,
        minimumSamples: config.minimum_comparable_receipts,
      }),
    };
  }

  const latest = latestReceipt(selected);
  const currentProfile = safeProfile(latest);
  const currentStatus = STATUS.has(latest?.status) ? latest.status : 'unavailable';
  const timestamps = selected.map((entry) => safeTimestamp(entry.created_at)).filter((entry) => entry !== null);
  const firstCreatedAt = timestamps.length ? Math.min(...timestamps) : null;
  const now = safeTimestamp(input.now) ?? Date.now();
  const elapsed = firstCreatedAt === null ? null : Math.max(0, Math.min(MAX_ELAPSED_MS, now - firstCreatedAt));
  const comparable = profileKnown(currentProfile)
    ? selected.filter((entry) => {
      const profile = safeProfile(entry);
      return entry.status === 'exact'
        && profile.model_family === currentProfile.model_family
        && profile.reasoning_effort === currentProfile.reasoning_effort;
    })
    : [];
  const sampleCount = comparable.length;
  const affectedTokens = exactComparableTokens(comparable);
  const pressureResult = pressureFor(input.metrics);
  const currentTelemetry = Object.hasOwn(input, 'current_telemetry_state')
    ? input.current_telemetry_state
    : latest?.telemetry_reconciliation?.state;
  const evidence = workflowEvidence(currentStatus, currentTelemetry, pressureResult, input.fast_mode_context);
  const capability = capabilityEvidence(input.capability_evidence);
  const nonComparableServiceTier = cohort.main_service_tier === 'other_observed';
  const configuredWorkloadMismatch = config.workload_class !== 'unknown'
    && cohort.workload_class !== config.workload_class;
  const reasons = [];
  if (sampleCount < config.minimum_comparable_receipts) reasons.push('minimum_comparable_receipts_not_met');
  if (elapsed === null || elapsed < config.minimum_elapsed_ms) reasons.push('minimum_elapsed_not_met');
  if (!profileKnown(currentProfile)) reasons.push('profile_unknown');
  if (capability === 'unavailable') reasons.push('capability_evidence_unavailable');
  if (nonComparableServiceTier) reasons.push('workflow_service_tier_noncomparable');
  if (configuredWorkloadMismatch) reasons.push('workflow_context_config_mismatch');
  reasons.push(...cohort.reason_codes, ...evidence.reason_codes);
  if (host !== 'codex') reasons.push('host_workflow_model_unavailable');

  const eligible = host === 'codex'
    && profileKnown(currentProfile)
    && evidence.ready
    && sampleCount >= config.minimum_comparable_receipts
    && elapsed !== null
    && elapsed >= config.minimum_elapsed_ms
    && pressureResult.pressure !== 'unavailable'
    && capability !== 'unavailable'
    && !nonComparableServiceTier
    && !configuredWorkloadMismatch;
  if (eligible) reasons.push(...pressureResult.reason_codes);
  const target = eligible ? targetFor(currentProfile, pressureResult.pressure) : null;
  if (eligible && target === null) reasons.push('current_profile_already_matches_candidate');
  const recommendation = eligible && target
    ? candidate({ host, current_status: currentStatus, capability_evidence: capability }, currentProfile, pressureResult, sampleCount, affectedTokens)
    : null;
  const experimentProgress = workflowExperimentProgress(recommendation, input.experiments, cohort);
  const consumptionContext = workflowConsumptionContext({
    latest,
    history: selected.filter((entry) => entry !== latest),
    host,
    cohort,
    minimumSamples: config.minimum_comparable_receipts,
  });
  const groupKey = recommendation
    ? decisionKey(host, recommendation, pressureResult.pressure, evidence)
    : `${host}|${currentProfile.model_family}|${currentProfile.reasoning_effort}|unavailable|unavailable|${pressureResult.pressure}|unavailable|${evidence.service_tier_context}`;
  return {
    workflow_advisor_schema_version: WORKFLOW_ADVISOR_SCHEMA_VERSION,
    status: eligible ? 'exact' : 'partial',
    eligibility: eligible ? 'eligible' : 'insufficient_evidence',
    host,
    sample_count: sampleCount,
    minimum_comparable_receipts: config.minimum_comparable_receipts,
    elapsed_ms: elapsed,
    minimum_elapsed_ms: config.minimum_elapsed_ms,
    current_profile: currentProfile,
    pressure: pressureResult.pressure,
    decision_scope: cohort.decision_scope,
    evidence: cleanEvidence(evidence),
    reason_codes: [...new Set(reasons)].slice(0, MAX_REASON_CODES),
    evidence_counts: { ...pressureResult.evidence_counts },
    next_eligible: {
      remaining_receipts: Math.max(0, config.minimum_comparable_receipts - sampleCount),
      remaining_ms: elapsed === null ? config.minimum_elapsed_ms : Math.max(0, config.minimum_elapsed_ms - elapsed),
    },
    group_key: groupKey,
    cooldown_ms: config.cooldown_ms,
    recommendations: recommendation ? [recommendation] : [],
    experiment_progress: experimentProgress,
    consumption_context: consumptionContext,
  };
}

export function workflowAdvisorNotice(analytics, history = [], now = Date.now()) {
  if (!analytics
    || analytics.workflow_advisor_schema_version !== WORKFLOW_ADVISOR_SCHEMA_VERSION
    || analytics.status !== 'exact'
    || analytics.eligibility !== 'eligible'
    || !Array.isArray(analytics.recommendations)
    || !analytics.recommendations.length) return null;
  const evidence = cleanEvidence(analytics.evidence);
  if (evidence.receipt_quality !== 'exact'
    || evidence.telemetry_state !== 'received'
    || evidence.structural_metrics_quality !== 'exact') return null;
  const recommendation = cleanRecommendation(analytics.recommendations[0]);
  if (!recommendation) return null;
  const current = safeTimestamp(now);
  if (current === null) return null;
  const expectedGroupKey = decisionKey(analytics.host, recommendation, analytics.pressure, evidence);
  if (analytics.group_key !== expectedGroupKey) return null;
  const groupKey = expectedGroupKey;
  const cooldown = Number.isSafeInteger(analytics.cooldown_ms) && analytics.cooldown_ms > 0
    ? Math.min(analytics.cooldown_ms, MAX_ELAPSED_MS)
    : WORKFLOW_ADVISOR_DEFAULTS.cooldown_ms;
  const recent = (Array.isArray(history) ? history : []).some((entry) => entry?.recommendation_id === recommendation.id
    && entry?.group_key === groupKey
    && safeTimestamp(entry?.emitted_at) !== null
    && current >= entry.emitted_at
    && current - entry.emitted_at < cooldown);
  if (recent) return null;
  const text = `SomesToken workflow advisor · ${recommendation.copy} · evidence=${safeCount(analytics.sample_count)} comparable turns · review-only · savings unmeasured`;
  return {
    text,
    record: {
      recommendation_id: recommendation.id,
      group_key: groupKey,
      host: safeHost(analytics.host),
      emitted_at: current,
    },
  };
}

function legacyWorkflowAdvisor(value) {
  return {
    workflow_advisor_schema_version: WORKFLOW_ADVISOR_SCHEMA_VERSION,
    status: 'partial',
    eligibility: 'insufficient_evidence',
    host: safeHost(value?.host),
    sample_count: 0,
    minimum_comparable_receipts: WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts,
    elapsed_ms: null,
    minimum_elapsed_ms: WORKFLOW_ADVISOR_DEFAULTS.minimum_elapsed_ms,
    current_profile: { model_family: 'unknown', reasoning_effort: 'unknown' },
    pressure: 'unavailable',
    decision_scope: 'active_session',
    evidence: cleanEvidence(),
    reason_codes: ['legacy_workflow_advisor_schema'],
    evidence_counts: {},
    next_eligible: {
      remaining_receipts: WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts,
      remaining_ms: WORKFLOW_ADVISOR_DEFAULTS.minimum_elapsed_ms,
    },
    recommendations: [],
    experiment_progress: emptyExperimentProgress(),
    consumption_context: emptyWorkflowConsumptionContext({
      decision_scope: 'active_session',
      reason_codes: ['legacy_workflow_advisor_schema'],
    }),
  };
}

export function normalizeWorkflowAdvisor(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (![WORKFLOW_ADVISOR_SCHEMA_VERSION, WORKFLOW_ADVISOR_LEGACY_SCHEMA_VERSION].includes(value.workflow_advisor_schema_version)) {
    return legacyWorkflowAdvisor(value);
  }
  const host = safeHost(value.host);
  const status = STATUS.has(value.status) ? value.status : 'unavailable';
  const current = value.current_profile && typeof value.current_profile === 'object' ? value.current_profile : {};
  const currentProfile = {
    model_family: MODEL_FAMILY_SET.has(current.model_family) ? current.model_family : 'unknown',
    reasoning_effort: EFFORTS.has(current.reasoning_effort) ? current.reasoning_effort : 'unknown',
  };
  const recommendations = Array.isArray(value.recommendations)
    ? value.recommendations.slice(0, MAX_RECOMMENDATIONS).map(cleanRecommendation).filter(Boolean)
    : [];
  const evidence = cleanEvidence(value.evidence);
  const decisionScope = DECISION_SCOPES.has(value.decision_scope) ? value.decision_scope : 'active_session';
  const consumptionContext = cleanConsumptionContext(value.consumption_context, { decision_scope: decisionScope });
  const suppliedReasons = Array.isArray(value.reason_codes)
    ? value.reason_codes.filter((entry) => REASONS.has(entry))
    : [];
  const comparableScopeInvalid = decisionScope === 'comparable_workload_cohort'
    && !hasComparableWorkflowContext(consumptionContext);
  const nonComparableServiceTier = consumptionContext.main_service_tier === 'other_observed';
  const reasons = [...new Set([
    ...(comparableScopeInvalid ? ['workflow_cohort_insufficient'] : []),
    ...(nonComparableServiceTier ? ['workflow_service_tier_noncomparable'] : []),
    ...suppliedReasons,
  ])].slice(0, MAX_REASON_CODES);
  const pressure = PRESSURE.has(value.pressure) ? value.pressure : 'unavailable';
  const sampleCount = safeCount(value.sample_count);
  const minimumComparable = safeCount(value.minimum_comparable_receipts) || WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts;
  const elapsed = safeElapsed(value.elapsed_ms);
  const minimumElapsed = safeElapsed(value.minimum_elapsed_ms) ?? WORKFLOW_ADVISOR_DEFAULTS.minimum_elapsed_ms;
  const eligible = !comparableScopeInvalid && !nonComparableServiceTier && value.eligibility === 'eligible' && eligibleWorkflowCandidate({
    host, status, currentProfile, pressure, evidence, sampleCount, minimumComparable, elapsed, minimumElapsed, recommendations, reasons,
  });
  const eligibility = eligible
    ? 'eligible'
    : value.eligibility === 'unavailable'
      ? 'unavailable'
      : 'insufficient_evidence';
  const safeRecommendations = eligibility === 'eligible' ? recommendations : [];
  const groupKey = safeRecommendations.length && value.group_key === decisionKey(host, safeRecommendations[0], pressure, evidence)
    ? value.group_key
    : undefined;
  const output = {
    workflow_advisor_schema_version: WORKFLOW_ADVISOR_SCHEMA_VERSION,
    status: eligibility === 'eligible' ? 'exact' : status === 'unavailable' ? 'unavailable' : 'partial',
    eligibility,
    host,
    sample_count: sampleCount,
    minimum_comparable_receipts: minimumComparable,
    elapsed_ms: elapsed,
    minimum_elapsed_ms: minimumElapsed,
    current_profile: currentProfile,
    pressure,
    decision_scope: decisionScope,
    evidence,
    reason_codes: reasons,
    evidence_counts: Object.fromEntries(Object.entries(value.evidence_counts ?? {}).slice(0, 8).filter(([key, count]) => /^[a-z0-9_]{1,64}$/.test(key) && safeModel(key) && Number.isSafeInteger(count) && count >= 0).map(([key, count]) => [key, Math.min(count, MAX_COUNT)])),
    next_eligible: {
      remaining_receipts: safeCount(value.next_eligible?.remaining_receipts),
      remaining_ms: safeElapsed(value.next_eligible?.remaining_ms),
    },
    recommendations: safeRecommendations,
    experiment_progress: Array.isArray(options?.experiments)
      ? workflowExperimentProgress(safeRecommendations[0], options.experiments, consumptionContext)
      : cleanExperimentProgress(value.experiment_progress),
    consumption_context: consumptionContext,
  };
  if (groupKey) output.group_key = groupKey;
  if (Number.isSafeInteger(value.cooldown_ms) && value.cooldown_ms > 0) output.cooldown_ms = Math.min(value.cooldown_ms, MAX_ELAPSED_MS);
  return output;
}
