import {
  METADATA_CONFIDENCE,
  METADATA_SOURCES,
  METADATA_STATUSES,
  safeReceiptMetadataSummary,
  safeModel,
  isSensitiveRuntimeValue,
  sanitizeMetadata,
  sumUsage,
  isValidUsage,
  USAGE_KEYS,
} from './core.mjs';
import { normalizeSavings } from './savings.mjs';
import { normalizeUsageLayers, USAGE_CORE_SCHEMA_VERSION, COVERAGE } from './usage/schema.mjs';
import { ERROR_CATEGORIES, EVENT_TYPES, normalizeEfficiencyResult } from './efficiency/schema.mjs';
import { buildPlanComparisons, COMPARISON_SCHEMA_VERSION } from './usage/comparison.mjs';
import { resolvePolicyProfile } from './usage/policy-profiles.mjs';
import { getPlanProfile } from './usage/plans.mjs';
import { codexCapabilities, codexCacheSemantics } from './hosts/codex.mjs';
import { RATE_LIMIT_REACHED_TYPES } from './hosts/codex-app-server.mjs';
import { claudeCapabilities, claudeCacheSemantics } from './hosts/claude-code.mjs';
import { listCapabilities } from './efficiency/capabilities.mjs';
import { buildProvenance, auditReasonCodeWiring } from './efficiency/provenance.mjs';
import { calculateStructuralMetrics, compareComparableBaseline } from './efficiency/metrics.mjs';
import { generateRecommendations, RECOMMENDATION_CATALOG } from './efficiency/recommendations.mjs';
import { workflowAdvisorAnalytics, normalizeWorkflowAdvisor, selectWorkflowCohort } from './workflow-advisor.mjs';
import { summarizeGates } from './optimization/gates.mjs';
import { listExperiments, recommendationStatusForExperiment } from './optimization/experiments.mjs';
import { findComparablePairs } from './optimization/pairing.mjs';
import { measureReduction, summarizeReductions } from './optimization/reductions.mjs';
import { shadowPolicySummary } from './optimization/shadow-policy.mjs';
import { calibrationReport } from './optimization/calibration.mjs';
import { normalizeCalibrationFeedback, normalizeExperimentRun, normalizePair, normalizeReduction, normalizeShadowDecision } from './optimization/schema.mjs';
import { fastModeAnalytics } from './fast-mode.mjs';
import {lifecycleSummary,sanitizeLifecycleSummary} from './optimization/lifecycle-checks.mjs';
import {outputCompactionSummary,sanitizeOutputCompactionSummary} from './optimization/output-accounting.mjs';
import { isTelemetryOutcome } from './telemetry-outcomes.mjs';

export const REPORT_SCHEMA_VERSION = 9;
export const ADVISOR_REPORT_SCHEMA_VERSION = 1;
export const HEALTH_KEYS = Object.freeze([
  'token_events_seen',
  'malformed_events',
  'duplicate_hooks',
  'duplicate_events',
  'counter_resets',
  'partial_receipts',
  'unavailable_receipts',
  'unresolved_sources',
  'lock_timeouts',
  'state_recoveries',
  'retention_drops',
  'efficiency_retention_drops',
  'receipt_retention_drops',
  'state_retention_drops',
  'efficiency_events_seen',
  'efficiency_events_dropped',
  'efficiency_warnings',
  'efficiency_watch_receipts',
  'likely_loop_receipts',
  'runaway_risk_receipts',
  'intentional_recurring_receipts',
  'usage_snapshots_seen',
  'usage_snapshots_rejected',
  'quota_snapshots_seen',
  'quota_snapshots_stale',
  'quota_scope_unknown',
  'credit_calculations',
  'credit_calculation_partial',
  'credit_calculation_unavailable',
  'rate_profile_misses',
  'policy_profile_expired',
  'plan_comparisons',
  'plan_comparisons_incomparable',
  'plan_comparisons_not_configured',
  'usage_threshold_warnings',
  'clock_anomalies',
  'capability_misses',
  'capabilities_declared',
  'capabilities_observed',
  'capabilities_live_verified',
  'capability_version_mismatches',
  'missing_required_fields',
  'acceptance_windows_started',
  'acceptance_windows_completed',
  'acceptance_windows_interrupted',
  'session_end_events',
  'session_reconciliations',
  'late_events_after_close',
  'session_start_before_end',
  'stale_session_end_ignored',
  'recommendations_generated',
  'recommendations_suppressed',
  'baseline_groups_created',
  'baseline_samples_rejected',
  'comparison_incomparable',
  'cache_semantics_unavailable',
  'statusline_spike_unavailable',
  'snapshotless_identity_fallbacks',
  'snapshotless_identity_collisions_prevented',
  'manual_gates_opened',
  'manual_gates_satisfied',
  'manual_gate_continuations',
  'goal_hygiene_warnings',
  'experiments_started',
  'experiments_closed',
  'experiments_interrupted',
  'experiment_pairs_valid',
  'experiment_pairs_incomparable',
  'outcome_regressions',
  'measured_reduction_pairs',
  'shadow_decisions',
  'shadow_duplicate_suppressions',
  'calibration_feedback_seen',
  'state_migrations',
  'experiment_retention_drops',
  'public_snapshots_written',
  'public_snapshot_write_failures',
  'public_snapshot_read_failures',
  'public_snapshot_schema_mismatches',
  'public_snapshot_recoveries',
  'public_snapshots_expired',
  'public_sessions_closed',
  'public_sessions_closed_partial',
  'public_sessions_closed_with_pending',
  'bridge_ready_events',
  'bridge_stale_events',
  'bridge_permission_errors',
  'mcp_public_reads',
  'mcp_public_read_failures',
  'statusline_reads',
  'statusline_stale_reads',
  'statusline_install_attempts',
  'statusline_install_failures',
  'evidence_bundles_created',
  'evidence_bundle_failures',
  'policy_sessions_eligible',
  'policy_sessions_triggered',
  'policy_feedback_seen',
  'policy_certifications',
  'policy_rejections',
  'workflow_recommendations_generated',
  'workflow_recommendations_suppressed',
  'limit_recovery_armed',
  'limit_recovery_limit_observed',
  'limit_recovery_resumed',
  'limit_recovery_canceled',
  'limit_recovery_unavailable',
  'limit_recovery_protocol_errors',
  'limit_recovery_state_drops',
]);

const MAX_REPORT_ITEMS = 100;
const MAX_AGENTS_PER_TURN = 32;
const MAX_HEALTH_COUNTER = 1_000_000;
const SAFE_PROTOCOL_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const RECEIPT_STATUSES = new Set(['exact', 'partial', 'unavailable']);
const SAFE_RECEIPT_REASONS = new Set(['stop_failure']);
const TELEMETRY_STATES = new Set(['received', 'pending_post_turn', 'unavailable']);
const TELEMETRY_SOURCES = new Set(['transcript', 'structured_hook', 'none']);
const DEFAULT_TELEMETRY_RECONCILIATION = Object.freeze({ state: 'unavailable', source: 'none', attempts: 0 });
const OPTIONAL_USAGE_KEYS = new Set(['cache_write_input_tokens']);
const PONYTAIL_STATUSES = new Set(['confirmed-marker', 'off-confirmed', 'configured-default', 'unknown']);
const PONYTAIL_MODES = new Set(['off', 'lite', 'full', 'ultra', 'review']);

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeProtocolText(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return SAFE_PROTOCOL_TEXT.test(normalized) && safeModel(normalized) ? normalized : undefined;
}

function staticPlanDisplayName(id, provider = null) {
  const plan = (provider === 'codex' || provider === 'claude' ? getPlanProfile(provider, id) : null)
    ?? getPlanProfile('codex', id)
    ?? getPlanProfile('claude', id);
  return plan?.display_name ?? 'Unknown';
}

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of USAGE_KEYS) {
    if (OPTIONAL_USAGE_KEYS.has(key) && (value[key] === undefined || value[key] === null)) {
      // Cache-write is not part of the required token receipt. Preserve an
      // omitted legacy/public value as unknown instead of rejecting all other
      // observed counters or converting it to zero.
      usage[key] = null;
      continue;
    }
    const number = safeInteger(value[key]);
    if (number === null) return null;
    usage[key] = number;
  }
  if (!isValidUsage({ ...usage, consistent: true })) usage.consistent = false;
  else if (typeof value.consistent === 'boolean') usage.consistent = value.consistent;
  return usage;
}

function safeUsageLayers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized = normalizeUsageLayers(value);
  return normalized?.usage_schema_version === USAGE_CORE_SCHEMA_VERSION ? normalized : undefined;
}

function safeEfficiency(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return normalizeEfficiencyResult(value);
}

function safeTelemetryReconciliation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = TELEMETRY_STATES.has(value.state) ? value.state : 'unavailable';
  const source = TELEMETRY_SOURCES.has(value.source) ? value.source : 'none';
  const attempts = safeInteger(value.attempts);
  const outcome = isTelemetryOutcome(value.outcome) ? value.outcome : undefined;
  return {
    state,
    source,
    attempts: attempts === null ? 0 : Math.min(attempts, MAX_REPORT_ITEMS),
    ...(outcome ? { outcome } : {}),
  };
}

function safePlanComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const current = value.comparison_schema_version === COMPARISON_SCHEMA_VERSION;
  const mode = current && ['host_quota', 'manual_capacity', 'relative_only', 'unavailable'].includes(value.comparison_mode) ? value.comparison_mode : 'unavailable';
  const quality = current && ['exact', 'partial', 'unavailable'].includes(value.quality) ? value.quality : 'unavailable';
  const output = { comparison_schema_version: COMPARISON_SCHEMA_VERSION, comparison_mode: mode, quality, coverage: safeProtocolText(value.coverage) ?? 'unavailable' };
  if (Array.isArray(value.reason_codes)) output.reason_codes = [...new Set(value.reason_codes.filter((entry) => typeof entry === 'string' && /^[a-z0-9_]{1,80}$/.test(entry) && safeModel(entry)))].slice(0, 16);
  if (!current) output.reason_codes = ['legacy_plan_comparison', ...(output.reason_codes ?? []).filter(code => code !== 'legacy_plan_comparison')].slice(0, 16);
  if (value.selected_plan && typeof value.selected_plan === 'object') {
    const id = typeof value.selected_plan.id === 'string' && /^[a-z0-9_]{1,80}$/.test(value.selected_plan.id) && safeModel(value.selected_plan.id) ? value.selected_plan.id : 'unknown';
    output.selected_plan = { id, display_name: staticPlanDisplayName(id) };
  }
  if (value.current_plan && typeof value.current_plan === 'object') {
    output.current_plan = {
      id: typeof value.current_plan.id === 'string' && /^[a-z0-9_]{1,80}$/.test(value.current_plan.id) && safeModel(value.current_plan.id) ? value.current_plan.id : 'unknown',
      used_percent: current && typeof value.current_plan.used_percent === 'number' && Number.isFinite(value.current_plan.used_percent) ? value.current_plan.used_percent : null,
      remaining_percent: current && typeof value.current_plan.remaining_percent === 'number' && Number.isFinite(value.current_plan.remaining_percent) ? value.current_plan.remaining_percent : null,
    };
  }
  if (Array.isArray(value.alternative_plan_comparisons)) {
    output.alternative_plan_comparisons = value.alternative_plan_comparisons.slice(0, 8).map((entry) => {
      const id = typeof entry?.id === 'string' && /^[a-z0-9_]{1,80}$/.test(entry.id) && safeModel(entry.id) ? entry.id : 'unknown';
      return {
        id,
        display_name: staticPlanDisplayName(id),
        standard_multiplier: typeof entry?.standard_multiplier === 'number' && Number.isFinite(entry.standard_multiplier) ? entry.standard_multiplier : null,
        used_percent: current && typeof entry?.used_percent === 'number' && Number.isFinite(entry.used_percent) ? entry.used_percent : null,
        remaining_percent: current && typeof entry?.remaining_percent === 'number' && Number.isFinite(entry.remaining_percent) ? entry.remaining_percent : null,
        relative_pressure: current && typeof entry?.relative_pressure === 'number' && Number.isFinite(entry.relative_pressure) ? entry.relative_pressure : null,
      };
    });
  }
  return output;
}

function safeMetadata(value) {
  return sanitizeMetadata(value) ?? undefined;
}

function safePonytail(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const status = value.status === 'explicit-command-requested' || value.status === 'not-detected'
    ? 'unknown'
    : PONYTAIL_STATUSES.has(value.status) ? value.status : 'unknown';
  const output = { status };
  if (status !== 'unknown' && PONYTAIL_MODES.has(value.mode)) output.mode = value.mode;
  const coverage = safeInteger(value.coverage_count);
  if (coverage !== null) output.coverage_count = Math.min(coverage, 1000);
  if (status === 'unknown') output.reason = 'no supported cross-plugin signal';
  return output;
}

function safeCount(value, maximum = MAX_REPORT_ITEMS) {
  const number = safeInteger(value);
  return number === null ? 0 : Math.min(number, maximum);
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeAdvisorCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
}

function safeAdvisorNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : null;
}

function selectedReceipts(receipts, options = {}) {
  if (!Array.isArray(receipts)) return [];
  const requested = safeInteger(options.last);
  const count = requested === null ? MAX_REPORT_ITEMS : Math.min(MAX_REPORT_ITEMS, Math.max(1, requested));
  return receipts.filter((entry) => entry && typeof entry === 'object').slice(-count);
}

function sourceValue(receipt, key) {
  return safeCount(receipt?.[key], MAX_REPORT_ITEMS + 1);
}

function publicIdentity(entry) {
  const metadata = safeMetadata(entry?.metadata);
  if (!metadata) return { metadata_status: 'unknown', metadata_confidence: 'low' };
  const output = {
    metadata_status: metadata.status ?? 'unknown',
    metadata_confidence: metadata.confidence ?? 'low',
  };
  if (metadata.source) output.metadata_source = metadata.source;
  if (metadata.model) output.model = metadata.model;
  if (metadata.reasoning_effort) output.reasoning_effort = metadata.reasoning_effort;
  if (metadata.requested_service_tier) output.requested_service_tier = metadata.requested_service_tier;
  if (metadata.service_tier) output.service_tier = metadata.service_tier;
  return output;
}

function publicSource(entry, kind) {
  const valid = kind === 'main' ? entry?.valid === true : entry?.status === 'completed';
  // A child Stop can win the lock race against its Start. Its bounded numeric
  // candidate stays internal until the lifecycle link proves its source; it
  // must not become public partial or attributed usage meanwhile.
  const usage = valid ? safeUsage(entry?.usage) : null;
  const status = !usage ? 'unavailable' : entry?.ambiguous === true ? 'partial' : valid ? 'exact' : 'partial';
  return {
    status,
    ...publicIdentity(entry),
    usage,
  };
}

/**
 * Return a bounded, identity-safe per-turn breakdown. Agent hashes and turn ids
 * are deliberately omitted; subagents are exposed only by stable ordinal.
 */
export function publicTurnBreakdown(state, receipt) {
  const turn = state && typeof state === 'object' && state.turns && typeof state.turns === 'object'
    ? state.turns[receipt?.turn_id]
    : null;
  if (!turn || typeof turn !== 'object') {
    return {
      report_schema_version: REPORT_SCHEMA_VERSION,
      status: 'unavailable',
      main: { status: 'unavailable', metadata_status: 'unknown', metadata_confidence: 'low', usage: null },
      subagents: [],
      totals: { main_usage: null, subagent_usage: null, combined_usage: null, main_tokens: null, subagent_tokens: null, total_tokens: null },
      usage_layers: undefined,
      telemetry_reconciliation: safeTelemetryReconciliation(receipt?.telemetry_reconciliation) ?? DEFAULT_TELEMETRY_RECONCILIATION,
      plan_comparison: undefined,
      efficiency: undefined,
    };
  }
  const main = publicSource(turn.main, 'main');
  const subagents = Object.values(turn.subagents && typeof turn.subagents === 'object' ? turn.subagents : {})
    .slice(0, MAX_AGENTS_PER_TURN)
    .map((entry, index) => ({ index: index + 1, ...publicSource(entry, 'subagent') }));
  const mainUsage = main.usage;
  const subagentUsages = subagents.map((entry) => entry.usage).filter(Boolean);
  const subagentUsage = subagentUsages.length ? sumUsage(subagentUsages) : null;
  const combinedUsage = mainUsage || subagentUsage ? sumUsage([mainUsage, subagentUsage].filter(Boolean)) : null;
  const allExact = main.status === 'exact' && subagents.every((entry) => entry.status === 'exact');
  const status = main.status === 'unavailable'
    ? 'unavailable'
    : receipt?.status === 'exact' && allExact && combinedUsage?.consistent !== false ? 'exact' : 'partial';
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    status,
    main,
    subagents,
    totals: {
      main_usage: mainUsage,
      subagent_usage: subagentUsage,
      combined_usage: combinedUsage,
      main_tokens: mainUsage?.total_tokens ?? null,
      subagent_tokens: subagentUsage?.total_tokens ?? null,
      total_tokens: combinedUsage?.total_tokens ?? null,
    },
    usage_layers: safeUsageLayers(receipt?.usage_layers),
    telemetry_reconciliation: safeTelemetryReconciliation(receipt?.telemetry_reconciliation) ?? DEFAULT_TELEMETRY_RECONCILIATION,
    plan_comparison: safePlanComparison(receipt?.plan_comparison),
    efficiency: safeEfficiency(receipt?.efficiency),
  };
}

function usageConsistency(value) {
  if (value?.consistent === false) return 'inconsistent';
  if (value?.consistent === true) return 'exact';
  return 'unknown';
}

export function accountingSignalForTurn(receipt, breakdown) {
  const receiptUsage = safeUsage(receipt);
  const receiptConsistency = usageConsistency(receiptUsage);
  const sources = [
    breakdown?.main,
    ...(Array.isArray(breakdown?.subagents) ? breakdown.subagents : []),
  ];
  const sourceInconsistent = sources.some((source) => usageConsistency(source?.usage) === 'inconsistent');
  const layerObserved = breakdown?.usage_layers?.observed;
  const layerInconsistent = Number.isSafeInteger(layerObserved?.input_tokens)
    && Number.isSafeInteger(layerObserved?.cached_input_tokens)
    && layerObserved.cached_input_tokens > layerObserved.input_tokens;
  const receiptTotal = receiptUsage?.total_tokens ?? null;
  const breakdownTotal = safeInteger(breakdown?.totals?.combined_usage?.total_tokens);
  return {
    source_total_mismatch: receiptTotal !== null && breakdownTotal !== null && receiptTotal !== breakdownTotal,
    usage_consistency: sourceInconsistent || receiptConsistency === 'inconsistent' || layerInconsistent
      ? 'inconsistent'
      : receiptConsistency,
  };
}

export function publicReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  const usage = receipt.status === 'unavailable' ? null : safeUsage(receipt);
  const output = {};
  for (const key of USAGE_KEYS) {
    if (usage) output[key] = usage[key];
  }
  if (RECEIPT_STATUSES.has(receipt.status)) output.status = receipt.status === 'exact' && usage?.consistent === false ? 'partial' : receipt.status;
  for (const key of ['agents', 'expected_sources', 'resolved_sources', 'unavailable_sources', 'overflow_sources']) {
    if (receipt[key] !== undefined) output[key] = sourceValue(receipt, key);
  }
  if (RECEIPT_STATUSES.has(receipt.accounting_status)) output.accounting_status = receipt.accounting_status === 'exact' && usage?.consistent === false ? 'partial' : receipt.accounting_status;
  if (METADATA_STATUSES.has(receipt.metadata_status)) output.metadata_status = receipt.metadata_status;
  if (METADATA_CONFIDENCE.has(receipt.metadata_confidence)) output.metadata_confidence = receipt.metadata_confidence;
  const metadataSource = METADATA_SOURCES.has(receipt.metadata_source) ? receipt.metadata_source : undefined;
  const metadataSummary = safeReceiptMetadataSummary(receipt.metadata_summary);
  const metadata = safeMetadata(receipt.metadata);
  const ponytail = safePonytail(receipt.ponytail);
  const usageLayers = safeUsageLayers(receipt.usage_layers);
  const efficiency = safeEfficiency(receipt.efficiency);
  const planComparison = safePlanComparison(receipt.plan_comparison);
  const telemetry = safeTelemetryReconciliation(receipt.telemetry_reconciliation);
  if (metadataSource) output.metadata_source = metadataSource;
  if (metadataSummary) output.metadata_summary = metadataSummary;
  if (metadata) output.metadata = metadata;
  if (ponytail) output.ponytail = ponytail;
  if (usageLayers) output.usage_layers = usageLayers;
  output.telemetry_reconciliation = telemetry ?? DEFAULT_TELEMETRY_RECONCILIATION;
  if (COVERAGE.includes(receipt.usage_coverage)) output.usage_coverage = receipt.usage_coverage;
  if (planComparison) output.plan_comparison = planComparison;
  if (efficiency) output.efficiency = efficiency;
  if (SAFE_RECEIPT_REASONS.has(receipt.reason)) output.reason = receipt.reason;
  if (ERROR_CATEGORIES.has(receipt.stop_failure_category)) output.stop_failure_category = receipt.stop_failure_category;
  if (receipt.subscription_usage === 'unavailable') output.subscription_usage = 'unavailable';
  if (receipt.account_quota === 'unavailable') output.account_quota = 'unavailable';
  output.savings = normalizeSavings(receipt.savings);
  const createdAt = safeInteger(receipt.created_at);
  if (createdAt !== null) output.created_at = createdAt;
  return output;
}

function aggregateSourceCounts(entries) {
  return entries.reduce((out, receipt) => {
    out.expected_sources += sourceValue(receipt, 'expected_sources');
    out.resolved_sources += sourceValue(receipt, 'resolved_sources');
    out.unavailable_sources += sourceValue(receipt, 'unavailable_sources');
    out.overflow_sources += sourceValue(receipt, 'overflow_sources');
    return out;
  }, { expected_sources: 0, resolved_sources: 0, unavailable_sources: 0, overflow_sources: 0 });
}

export function summarizeReceipts(receipts, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const valid = selected.map((receipt) => ({ receipt, usage: safeUsage(receipt) })).filter((entry) => entry.usage);
  const usage = valid.length ? sumUsage(valid.map((entry) => entry.usage)) : null;
  const counts = {
    exact_receipts: selected.filter((entry) => entry.status === 'exact').length,
    partial_receipts: selected.filter((entry) => entry.status === 'partial').length,
    unavailable_receipts: selected.filter((entry) => entry.status === 'unavailable' || !safeUsage(entry)).length,
  };
  const sources = aggregateSourceCounts(selected);
  const hasPartial = counts.partial_receipts > 0
    || counts.unavailable_receipts > 0
    || sources.unavailable_sources > 0
    || sources.overflow_sources > 0
    || usage?.consistent === false
    || valid.some(({ receipt }) => receipt.status !== 'exact');
  const status = !valid.length ? 'unavailable' : hasPartial ? 'partial' : 'exact';
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    status,
    turns: selected.length,
    ...counts,
    ...sources,
    ...(usage ? Object.fromEntries(USAGE_KEYS.map((key) => [key, usage[key]])) : Object.fromEntries(USAGE_KEYS.map((key) => [key, null]))),
  };
}

function turnEntries(state, receipts, options) {
  const turns = state && typeof state === 'object' && state.turns && typeof state.turns === 'object' ? state.turns : {};
  return selectedReceipts(receipts, options).map((receipt) => ({ receipt, turn: turns[receipt.turn_id] ?? null }));
}

export function summarizeTurnBreakdowns(state, receipts, options = {}) {
  const entries = turnEntries(state, receipts, options);
  const mainUsages = [];
  const subagentUsages = [];
  const profiles = { main: [], subagents: [] };
  let mainTurns = 0;
  let subagentSources = 0;
  let complete = entries.length > 0;
  for (const [{ receipt, turn }, turnIndex] of entries.map((entry, index) => [entry, index])) {
    const main = safeUsage(turn?.main?.usage);
    profiles.main.push({ turn: turnIndex + 1, ...publicSource(turn?.main, 'main') });
    if (turn?.main?.valid === true && main) {
      mainUsages.push(main);
      mainTurns += 1;
    } else {
      complete = false;
    }
    const subagents = turn?.subagents && typeof turn.subagents === 'object' ? Object.values(turn.subagents) : [];
    let turnHasSubagentUsage = false;
    for (const [subagentIndex, subagent] of subagents.entries()) {
      const usage = safeUsage(subagent?.usage);
      profiles.subagents.push({ turn: turnIndex + 1, index: subagentIndex + 1, ...publicSource(subagent, 'subagent') });
      if (subagent?.status === 'completed' && usage) {
        subagentUsages.push(usage);
        turnHasSubagentUsage = true;
        subagentSources += 1;
      } else {
        complete = false;
      }
    }
    const receiptUsage = safeUsage(receipt);
    const combined = sumUsage([main, ...subagents.map((subagent) => safeUsage(subagent?.usage)).filter(Boolean)]);
    if (receiptUsage && combined.total_tokens !== receiptUsage.total_tokens) complete = false;
    if (combined.consistent === false) complete = false;
    if (receipt.status !== 'exact') complete = false;
    if (subagentSources === 0 && turnHasSubagentUsage) complete = false;
  }
  const mainTokens = mainUsages.length ? sumUsage(mainUsages) : null;
  const subagentTokens = subagentUsages.length ? sumUsage(subagentUsages) : null;
  const totalTokens = mainTokens || subagentTokens ? sumUsage([mainTokens, subagentTokens].filter(Boolean)) : null;
  const aggregateInconsistent = [mainTokens, subagentTokens, totalTokens].some((usage) => usage?.consistent === false);
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    status: !entries.length ? 'unavailable' : complete && !aggregateInconsistent ? 'exact' : 'partial',
    turns: entries.length,
    main_turns: mainTurns,
    subagent_sources: subagentSources,
    main_tokens: mainTokens,
    subagent_tokens: subagentTokens,
    total_tokens: totalTokens?.total_tokens ?? null,
    profiles,
  };
}

export const USAGE_SCHEMA_VERSION = 1;

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function profileBucket(entry) {
  const model = entry?.model ?? 'unknown';
  const reasoning = entry?.reasoning_effort ?? 'unknown';
  return {
    model,
    reasoning_effort: reasoning,
    sources: 0,
    turns: 0,
    total_tokens: 0,
    exact_sources: 0,
    partial_sources: 0,
    unavailable_sources: 0,
  };
}

function addProfile(profiles, entry, usage) {
  const model = entry?.model ?? 'unknown';
  const reasoning = entry?.reasoning_effort ?? 'unknown';
  const key = `${model}\u0000${reasoning}`;
  let profile = profiles.get(key);
  if (!profile) {
    profile = profileBucket(entry);
    profiles.set(key, profile);
  }
  profile.sources += 1;
  profile.turns += 1;
  if (usage) profile.total_tokens = profile.total_tokens > Number.MAX_SAFE_INTEGER - usage.total_tokens
    ? Number.MAX_SAFE_INTEGER
    : profile.total_tokens + usage.total_tokens;
  if (entry?.status === 'exact') profile.exact_sources += 1;
  else if (entry?.status === 'partial') profile.partial_sources += 1;
  else profile.unavailable_sources += 1;
  return { ...profile };
}

function cleanProfiles(profiles) {
  return [...profiles.values()].slice(0, MAX_REPORT_ITEMS);
}

/**
 * Return bounded historical usage analytics from sanitized receipts and turn
 * state. No transcript fields, identifiers, paths, or event content are
 * included. Receipt totals remain the aggregate; source totals are reported
 * separately so partial attribution is visible rather than silently guessed.
 */
export function usageAnalytics(state, receipts, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const mainProfiles = new Map();
  const subagentProfiles = new Map();
  const trend = [];
  const receiptUsages = [];
  const mainUsages = [];
  const subagentUsages = [];
  let knownReceiptTurns = 0;
  let mainTurns = 0;
  let subagentSources = 0;
  let subagentExpectedSources = 0;
  let modelObservedTurns = 0;
  let reasoningObservedTurns = 0;
  let subagentModelObservedSources = 0;
  let subagentReasoningObservedSources = 0;
  let complete = selected.length > 0;

  for (const [index, receipt] of selected.entries()) {
    const breakdown = publicTurnBreakdown(state, receipt);
    const main = breakdown.main;
    const subagents = Array.isArray(breakdown.subagents) ? breakdown.subagents : [];
    const receiptUsage = safeUsage(receipt);
    const sourceUsage = breakdown.totals.combined_usage;
    subagentExpectedSources = Math.max(
      subagentExpectedSources,
      subagents.length,
      Math.max(0, sourceValue(receipt, 'expected_sources') - 1),
    );

    if (receiptUsage) {
      receiptUsages.push(receiptUsage);
      knownReceiptTurns += 1;
    }
    if (main.model) modelObservedTurns += 1;
    if (main.reasoning_effort) reasoningObservedTurns += 1;
    if (main.usage) addProfile(mainProfiles, main, main.usage, index);
    if (main.usage) {
      mainUsages.push(main.usage);
      mainTurns += 1;
    }
    for (const subagent of subagents) {
      if (subagent.model) subagentModelObservedSources += 1;
      if (subagent.reasoning_effort) subagentReasoningObservedSources += 1;
      if (subagent.usage) {
        subagentUsages.push(subagent.usage);
        subagentSources += 1;
      }
      addProfile(subagentProfiles, subagent, subagent.usage, index);
    }

    const sourceTotal = sourceUsage?.total_tokens ?? null;
    const accounting = accountingSignalForTurn(receipt, breakdown);
    if (breakdown.status !== 'exact' || !receiptUsage || sourceTotal === null
      || accounting.source_total_mismatch || accounting.usage_consistency === 'inconsistent') complete = false;
    const createdAt = safeInteger(receipt.created_at);
    trend.push({
      turn: index + 1,
      ...(createdAt === null ? {} : { created_at: createdAt }),
      status: RECEIPT_STATUSES.has(receipt.status) ? receipt.status : 'unavailable',
      model: main.model ?? 'unknown',
      reasoning_effort: main.reasoning_effort ?? 'unknown',
      main_tokens: main.usage?.total_tokens ?? null,
      subagent_tokens: breakdown.totals.subagent_tokens ?? null,
      total_tokens: receiptUsage?.total_tokens ?? sourceTotal,
      subagent_sources: subagents.length,
    });
  }

  const receiptTotals = receiptUsages.length ? sumUsage(receiptUsages) : null;
  const mainTotals = mainUsages.length ? sumUsage(mainUsages) : null;
  const subagentTotals = subagentUsages.length ? sumUsage(subagentUsages) : null;
  const attributedTotals = mainTotals || subagentTotals ? sumUsage([mainTotals, subagentTotals].filter(Boolean)) : null;
  const aggregateInconsistent = [receiptTotals, mainTotals, subagentTotals, attributedTotals]
    .some((usage) => usage?.consistent === false);
  const totalKnown = Boolean(receiptTotals);
  const mainKnown = Boolean(mainTotals);
  const subagentKnown = Boolean(subagentTotals);
  const totalTokens = receiptTotals?.total_tokens ?? null;
  const mainTokens = mainTotals?.total_tokens ?? null;
  const subagentTokens = subagentTotals?.total_tokens ?? null;
  const attributedTokens = attributedTotals?.total_tokens ?? null;
  const unattributedTokens = !aggregateInconsistent && totalKnown && attributedTokens !== null && totalTokens >= attributedTokens
    ? totalTokens - attributedTokens : null;
  const status = !selected.length ? 'unavailable' : complete && !aggregateInconsistent ? 'exact' : 'partial';
  return {
    usage_schema_version: USAGE_SCHEMA_VERSION,
    report_schema_version: REPORT_SCHEMA_VERSION,
    status,
    turns: selected.length,
    totals: {
      main_tokens: mainKnown ? mainTokens : null,
      subagent_tokens: subagentKnown ? subagentTokens : subagentExpectedSources > 0 ? null : 0,
      attributed_tokens: attributedTokens,
      total_tokens: totalKnown ? totalTokens : null,
      unattributed_tokens: unattributedTokens,
    },
    averages: {
      total_tokens_per_selected_turn: !aggregateInconsistent && totalKnown && knownReceiptTurns === selected.length ? ratio(totalTokens, selected.length) : null,
      total_tokens_per_observed_receipt: !aggregateInconsistent && totalKnown ? ratio(totalTokens, knownReceiptTurns) : null,
      main_tokens_per_observed_turn: !aggregateInconsistent && mainKnown ? ratio(mainTokens, mainTurns) : null,
      subagent_tokens_per_observed_source: !aggregateInconsistent && subagentKnown ? ratio(subagentTokens, subagentSources) : null,
    },
    shares: {
      main_tokens: !aggregateInconsistent && totalKnown && mainKnown ? ratio(mainTokens, totalTokens) : null,
      subagent_tokens: !aggregateInconsistent && totalKnown && subagentKnown ? ratio(subagentTokens, totalTokens) : null,
    },
    metadata: {
      model_observed_turns: modelObservedTurns,
      reasoning_observed_turns: reasoningObservedTurns,
      model_coverage: selected.length ? ratio(modelObservedTurns, selected.length) : null,
      reasoning_coverage: selected.length ? ratio(reasoningObservedTurns, selected.length) : null,
      subagent_model_observed_sources: subagentModelObservedSources,
      subagent_reasoning_observed_sources: subagentReasoningObservedSources,
    },
    profiles: {
      main: cleanProfiles(mainProfiles),
      subagents: cleanProfiles(subagentProfiles),
    },
    trend,
    quality: qualitySummary(selected, state?.health ?? null, {
      last: selected.length || 1,
      state,
    }),
  };
}

const EFFICIENCY_RANK = Object.freeze({ insufficient_evidence: 0, normal: 1, intentional_recurring_activity: 2, watch: 3, likely_loop: 4, runaway_risk: 5 });

function selectedPlan(state) {
  const plan = state?.usage?.selected_plan;
  if (!plan || typeof plan !== 'object') return { provider: 'unknown', id: 'unknown', display_name: 'Unknown', standard_multiplier: null, effective_multiplier: null, promotion_status: 'unknown' };
  const provider = plan.provider === 'codex' || plan.provider === 'claude' ? plan.provider : 'unknown';
  const id = typeof plan.id === 'string' && /^[a-z0-9_]{1,80}$/.test(plan.id) ? plan.id : 'unknown';
  const policy = resolvePolicyProfile(id, new Date().toISOString());
  return {
    provider,
    id,
    display_name: staticPlanDisplayName(id, provider),
    standard_multiplier: policy.provider === provider ? policy.standard_multiplier : null,
    effective_multiplier: policy.provider === provider ? policy.effective_multiplier : null,
    promotion_status: policy.provider === provider ? policy.promotion_status : 'unknown',
  };
}

function safeQuotaTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const iso = new Date(value).toISOString();
  return iso === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')) ? iso : null;
}

function latestQuota(state) {
  const entries = Array.isArray(state?.usage?.quota_snapshots) ? state.usage.quota_snapshots : [];
  const quota = entries.at(-1);
  if (!quota || typeof quota !== 'object') return null;
  return {
    quota_source: safeProtocolText(quota.quota_source) ?? 'unknown',
    quota_scope: safeProtocolText(quota.quota_scope) ?? 'unknown',
    quota_quality: ['exact', 'partial', 'unavailable'].includes(quota.quality) ? quota.quality : 'unavailable',
    measurement_basis: quota.measurement_basis === 'units' || quota.measurement_basis === 'host_percent'
      ? quota.measurement_basis
      : 'unavailable',
    quota_window: safeProtocolText(quota.window_type) ?? 'unavailable',
    window_started_at: safeQuotaTimestamp(quota.window_started_at),
    window_ends_at: safeQuotaTimestamp(quota.window_ends_at),
    used_units: typeof quota.used_units === 'number' && Number.isFinite(quota.used_units) ? quota.used_units : null,
    limit_units: typeof quota.limit_units === 'number' && Number.isFinite(quota.limit_units) ? quota.limit_units : null,
    remaining_units: typeof quota.remaining_units === 'number' && Number.isFinite(quota.remaining_units) ? quota.remaining_units : null,
    used_percent: typeof quota.used_percent === 'number' && Number.isFinite(quota.used_percent) ? quota.used_percent : null,
    remaining_percent: typeof quota.remaining_percent === 'number' && Number.isFinite(quota.remaining_percent) ? quota.remaining_percent : null,
    resets_at: safeQuotaTimestamp(quota.resets_at),
  };
}

function observedHost(entries) {
  const hosts = new Set((Array.isArray(entries) ? entries : [])
    .map((entry) => entry?.host)
    .filter((host) => host === 'codex' || host === 'claude'));
  if (hosts.size === 1) return [...hosts][0];
  return hosts.size > 1 ? 'unknown' : null;
}

function hostFromState(state) {
  return observedHost(state?.usage?.snapshots) ?? 'unknown';
}

function advisorHost(state, events) {
  return observedHost(events) ?? hostFromState(state);
}

function publicCapabilities(host) {
  const capabilities = host === 'codex'
    ? codexCapabilities()
    : host === 'claude'
      ? claudeCapabilities()
      : null;
  if (!capabilities) return { host: 'unknown', status: 'unavailable' };
  return {
    host: capabilities.host,
    hook_events: [...capabilities.hook_events],
    fixture_evidence: capabilities.fixture_evidence,
    live_evidence: capabilities.live_evidence,
    structured_lifecycle: capabilities.structured_lifecycle,
    token_snapshots: capabilities.token_snapshots,
    ...(capabilities.quota_snapshot !== undefined ? { quota_snapshot: capabilities.quota_snapshot } : {}),
    ...(capabilities.subscription_quota_snapshot !== undefined ? { subscription_quota_snapshot: capabilities.subscription_quota_snapshot } : {}),
    ...(capabilities.api_cost_fields !== undefined ? { api_cost_fields: capabilities.api_cost_fields } : {}),
    reset_timestamps: capabilities.reset_timestamps,
    shared_pool_scope: capabilities.shared_pool_scope,
  };
}

function receiptLayers(receipt) {
  const layers = safeUsageLayers(receipt?.usage_layers);
  if (!layers || layers.observed?.quality === 'unavailable') return null;
  return layers;
}

function mergeObservedLayers(layers) {
  if (!layers.length) return {
    quality: 'unavailable',
    input_tokens: null,
    cached_input_tokens: null,
    uncached_input_tokens: null,
    uncached_input_basis: 'unavailable',
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null,
  };
  const combined = sumUsage(layers.map((layer) => layer.observed));
  const uncached = sumUsage(layers.map((layer) => ({
    input_tokens: layer.observed.uncached_input_tokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: layer.observed.uncached_input_tokens,
    cache_write_input_tokens: 0,
    consistent: true,
  })));
  const { consistent: combinedConsistent, ...totals } = combined;
  const exactComposition = layers.every((layer) => (
    layer.observed.quality === 'exact'
    && layer.observed.uncached_input_basis === 'aggregate_derived'
  )) && combinedConsistent !== false && uncached.consistent !== false;
  return {
    ...totals,
    uncached_input_tokens: uncached.total_tokens,
    uncached_input_basis: exactComposition ? 'aggregate_derived' : 'receipt_lower_bound',
    quality: exactComposition ? 'exact' : 'partial',
  };
}

function roundedSum(values) {
  const value = Math.round(values.reduce((a, b) => a + b, 0) * 1_000_000) / 1_000_000;
  return Number.isFinite(value) ? value : null;
}

function mergeCalculatedLayers(layers) {
  const codex = layers.map((layer) => layer.calculated?.calculated_codex_credits).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const api = layers.map((layer) => layer.calculated?.calculated_api_cost).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const partial = layers.some((layer) => ['partial'].includes(layer.calculated?.calculation_quality ?? layer.calculated?.quality));
  const codexTotal = roundedSum(codex), apiTotal = roundedSum(api);
  const quality = codexTotal === null || apiTotal === null || !layers.length || layers.every((layer) => (layer.calculated?.calculation_quality ?? layer.calculated?.quality) === 'unavailable')
    ? 'unavailable' : partial ? 'partial' : 'exact';
  return {
    ...(codex.length && codexTotal !== null ? { calculated_codex_credits: codexTotal } : {}),
    ...(api.length && apiTotal !== null ? { calculated_api_cost: apiTotal } : {}),
    quality,
    ...(layers.find((layer) => layer.calculated?.rate_profile_id)?.calculated?.rate_profile_id ? { rate_profile_id: layers.find((layer) => layer.calculated.rate_profile_id).calculated.rate_profile_id } : {}),
  };
}

/** Public, bounded four-layer usage report. */
export function planAwareUsage(state, receipts, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const layers = selected.map(receiptLayers).filter(Boolean);
  const observed = mergeObservedLayers(layers);
  const calculated = mergeCalculatedLayers(layers);
  const host = hostFromState(state);
  const configuredPlan = selectedPlan(state);
  const plan = host !== 'unknown' && configuredPlan.provider !== 'unknown' && configuredPlan.provider !== host
    ? { provider: 'unknown', id: 'unknown', display_name: 'Unknown', standard_multiplier: null, effective_multiplier: null, promotion_status: 'unknown' }
    : configuredPlan;
  const quota = latestQuota(state);
  const latest = selected.map((entry) => safePlanComparison(entry.plan_comparison)).filter((entry) => entry?.alternative_plan_comparisons?.length).at(-1);
  const comparison = latest ?? buildPlanComparisons({
    provider: plan.provider,
    observed_units: observed.total_tokens,
    unit: 'tokens',
    selected_plan: plan.id,
    comparison_mode: quota?.measurement_basis === 'host_percent' ? 'unavailable' : 'relative_only',
    quota,
  });
  const efficiency = efficiencyAnalytics(state, selected, { last: selected.length || 1 });
  const coverages = [...new Set(layers.map((layer) => layer.coverage).filter(Boolean))];
  const coverage = coverages.length === 1 ? coverages[0] : coverages.length > 1 ? 'shared_pool_partial' : 'unavailable';
  const coverageQuality = coverage === 'unavailable'
    ? 'unavailable'
    : layers.some((layer) => layer.observed?.quality === 'partial') ? 'partial' : 'exact';
  return {
    public_schema_version: 2,
    detector_version: '1',
    usage_schema_version: 2,
    provider: plan.provider,
    host,
    host_version: 'unknown',
    capabilities: publicCapabilities(host),
    token_quality: !selected.length
      ? 'unavailable'
      : observed.quality === 'partial' || observed.quality === 'unavailable' || selected.some((entry) => entry.status !== 'exact')
        ? 'partial'
        : 'exact',
    observed_tokens: observed,
    calculated_usage: calculated,
    calculation_quality: calculated.quality,
    rate_profile: calculated.rate_profile_id ?? 'unavailable',
    selected_plan: plan,
    standard_multiplier: plan.standard_multiplier,
    effective_multiplier: plan.effective_multiplier,
    promotion_status: plan.promotion_status,
    quota_source: quota?.quota_source ?? 'unavailable',
    quota_scope: quota?.quota_scope ?? 'unavailable',
    quota_quality: quota?.quota_quality ?? 'unavailable',
    measurement_basis: quota?.measurement_basis ?? 'unavailable',
    quota_window: quota?.quota_window ?? 'unavailable',
    window_started_at: quota?.window_started_at ?? null,
    window_ends_at: quota?.window_ends_at ?? null,
    used_units: quota?.used_units ?? null,
    limit_units: quota?.limit_units ?? null,
    remaining_units: quota?.remaining_units ?? null,
    used_percent: quota?.used_percent ?? null,
    remaining_percent: quota?.remaining_percent ?? null,
    resets_at: quota?.resets_at ?? null,
    comparison_mode: comparison.comparison_mode ?? 'unavailable',
    alternative_plan_comparisons: comparison.alternative_plan_comparisons ?? [],
    coverage,
    coverage_quality: coverageQuality,
    coverage_description: coverage === 'somestoken_observed'
      ? 'Local SomesToken hooks only; other shared-pool activity is not included.'
      : coverage === 'shared_pool_unknown'
        ? 'Host does not expose complete shared-pool account usage.'
        : 'Account quota coverage unavailable.',
    classification: efficiency.classification,
    reason_codes: efficiency.reason_codes,
    evidence_counts: efficiency.evidence_counts,
    flagged_turn_count: efficiency.flagged_turn_count,
    affected_exact_tokens: efficiency.affected_exact_tokens,
    affected_partial_lower_bound_tokens: efficiency.affected_partial_lower_bound_tokens,
    affected_calculated_credits: efficiency.affected_calculated_credits,
    unavailable_affected_receipts: efficiency.unavailable_affected_receipts,
    warning_count: safeCount(state?.health?.efficiency_warnings),
    threshold_warning_count: safeCount(state?.health?.usage_threshold_warnings),
    dropped_event_count: safeCount(state?.health?.efficiency_events_dropped),
    retention_drop_count: safeCount(state?.health?.retention_drops),
    configuration_source: 'default',
  };
}

export const LIMIT_RECOVERY_REPORT_SCHEMA_VERSION = 1;

function safeLimitRecoveryText(value) {
  return typeof value === 'string' && /^[a-z0-9_:-]{1,80}$/.test(value) && safeModel(value) ? value : null;
}

/** Return only the bounded, public portion of the optional recovery state. */
export function limitRecoveryAnalytics(state) {
  const recovery = state?.limit_recovery;
  const base = {
    limit_recovery_report_schema_version: LIMIT_RECOVERY_REPORT_SCHEMA_VERSION,
    status: 'unavailable',
    mode: 'disabled',
    state: 'unavailable',
    controller: 'none',
    limit: { source: null, scope: null, limit_id: null, rate_limit_reached_type: null, used_percent: null, remaining_percent: null, resets_at: null, window_duration_mins: null },
    recovery: { goal_state: null, thread_state: null, waiting_on_approval: false, resume_attempts: 0, expires_at: null },
    reason_codes: [],
  };
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return base;
  const currentState = safeLimitRecoveryText(recovery.state) ?? 'unavailable';
  const mode = ['disabled', 'host_native_observe', 'managed_companion'].includes(recovery.mode) ? recovery.mode : 'disabled';
  const status = currentState === 'resumed' ? 'exact' : ['armed', 'limit_observed', 'waiting_for_reset', 'reset_observed', 'revalidating', 'resume_requested'].includes(currentState) ? 'partial' : 'unavailable';
  const reasonCodes = Array.isArray(recovery.reason_codes)
    ? [...new Set(recovery.reason_codes.filter((entry) => typeof entry === 'string' && /^[a-z0-9_]{1,80}$/.test(entry) && safeModel(entry)))].slice(0, 8)
    : [];
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const decimal = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  return {
    ...base,
    status,
    mode,
    state: currentState,
    controller: recovery.controller_ownership === 'somestoken' || recovery.controller_ownership === 'host' ? recovery.controller_ownership : 'none',
    limit: {
      source: recovery.limit_source === 'codex_app_server' ? recovery.limit_source : null,
      scope: recovery.limit_source === 'codex_app_server' ? 'account' : null,
      limit_id: safeLimitRecoveryText(recovery.limit_id),
      ...(RATE_LIMIT_REACHED_TYPES.includes(recovery.rate_limit_reached_type)
        ? { rate_limit_reached_type: recovery.rate_limit_reached_type }
        : {}),
      used_percent: decimal(recovery.used_percent),
      remaining_percent: decimal(recovery.used_percent) === null ? null : Math.max(0, 100 - decimal(recovery.used_percent)),
      resets_at: number(recovery.resets_at),
      window_duration_mins: number(recovery.window_duration_mins),
    },
    recovery: {
      goal_state: safeLimitRecoveryText(recovery.goal_state),
      thread_state: safeLimitRecoveryText(recovery.thread_state),
      waiting_on_approval: recovery.waiting_on_approval === true,
      resume_attempts: Math.min(1, number(recovery.resume_attempts) ?? 0),
      expires_at: number(recovery.expires_at),
    },
    reason_codes: reasonCodes,
  };
}

/** Aggregate structural findings without causal savings claims. */
export function efficiencyAnalytics(state, receipts, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const results = selected.map((entry) => safeEfficiency(entry.efficiency)).filter(Boolean);
  if (!results.length) return {
    public_schema_version: 1,
    classification: 'insufficient_evidence',
    reason_codes: [],
    evidence_counts: {},
    flagged_turn_count: 0,
    affected_exact_tokens: 0,
    affected_partial_lower_bound_tokens: 0,
    affected_calculated_credits: 0,
    unavailable_affected_receipts: selected.length,
    avoidable_usage: 'unmeasured',
  };
  const classification = results.reduce((current, entry) => EFFICIENCY_RANK[entry.classification] > EFFICIENCY_RANK[current] ? entry.classification : current, 'normal');
  const reasonCodes = [...new Set(results.flatMap((entry) => entry.reason_codes ?? []))].slice(0, 32);
  const evidenceCounts = {};
  for (const entry of results) for (const [reason, count] of Object.entries(entry.evidence_counts ?? {})) evidenceCounts[reason] = Math.min(MAX_REPORT_ITEMS * 100, (evidenceCounts[reason] ?? 0) + safeCount(count));
  const flagged = results.filter((entry) => ['watch', 'likely_loop', 'runaway_risk'].includes(entry.classification));
  return {
    public_schema_version: 1,
    classification,
    reason_codes: reasonCodes,
    evidence_counts: evidenceCounts,
    flagged_turn_count: flagged.length,
    affected_exact_tokens: flagged.reduce((sum, entry) => sum + safeCount(entry.affected_exact_tokens), 0),
    affected_partial_lower_bound_tokens: flagged.reduce((sum, entry) => sum + safeCount(entry.affected_partial_lower_bound_tokens), 0),
    affected_calculated_credits: roundedSum(flagged.map((entry) => typeof entry.affected_calculated_credits === 'number' ? entry.affected_calculated_credits : 0)),
    unavailable_affected_receipts: selected.length - results.length,
    avoidable_usage: 'unmeasured',
  };
}

function advisorEvents(state, selected) {
  const sessionSet = new Set(selected.map((entry) => entry?.session).filter(Boolean));
  // Structural event history is only comparable inside a proven receipt
  // session. An unscoped legacy/malformed event must not become evidence for
  // every selected session merely because it has no session field.
  if (!sessionSet.size) return [];
  const scopes = state?.efficiency?.scopes && typeof state.efficiency.scopes === 'object' ? Object.values(state.efficiency.scopes) : [];
  const events = scopes.flatMap((entries) => Array.isArray(entries) ? entries : []).filter((entry) => {
    return typeof entry?.session === 'string' && sessionSet.has(entry.session);
  });
  return events.slice(-256);
}

function publicAdvisorSession(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    host: record.host === 'codex' || record.host === 'claude' ? record.host : 'unknown',
    closure_state: ['closed_exact', 'closed_partial', 'closed_with_pending_sources', 'interrupted', 'expired', 'recovered'].includes(record.closure_state) ? record.closure_state : 'recovered',
    opened_at: safeTimestamp(record.opened_at),
    closed_at: safeTimestamp(record.closed_at),
    pending_sources: safeTimestamp(record.pending_sources),
    late_events: record.late_events === null
      ? null
      : safeAdvisorCount(record.late_events),
    event_counts: Object.fromEntries(Object.entries(record.event_counts ?? {}).slice(0, 24).filter(([key, value]) => EVENT_TYPES.has(key) && Number.isSafeInteger(value) && value >= 0)),
    summary: record.summary && typeof record.summary === 'object' ? {
      receipt_count: safeCount(record.summary.receipt_count),
      exact_receipts: safeCount(record.summary.exact_receipts),
      partial_receipts: safeCount(record.summary.partial_receipts),
      unavailable_receipts: safeCount(record.summary.unavailable_receipts),
    } : null,
  };
}

/** Public, bounded Capability-Proven Efficiency Advisor report. */
export function advisorReport(state, receipts, options = {}) {
  if (state?.advisor_report && typeof state.advisor_report === 'object') {
    const experiments = optimizationReport(state).experiments;
    return publicAdvisorReport(state.advisor_report, { experiments: experiments.length ? experiments : undefined });
  }
  const requested = selectedReceipts(receipts, options);
  const requestedEvents = advisorEvents(state, requested);
  const requestedHost = advisorHost(state, requestedEvents);
  const workflowCohort = selectWorkflowCohort({
    host: requestedHost,
    receipts: requested,
    config: state?.usage?.config?.workflow_advisor,
  });
  const selected = workflowCohort.receipts;
  const events = advisorEvents(state, selected);
  const capabilityRecords = listCapabilities(state?.advisor?.capabilities).slice(0, 64);
  const observedCapabilities = capabilityRecords.filter((entry) => entry.support === 'observed' || entry.support === 'live_verified').length;
  const liveCapabilities = capabilityRecords.filter((entry) => entry.support === 'live_verified').length;
  const capabilityQuality = liveCapabilities > 0 ? 'live_verified' : observedCapabilities > 0 ? 'observed' : capabilityRecords.length ? 'fixture_verified' : 'unavailable';
  const findings = selected.map((entry) => safeEfficiency(entry?.efficiency)).filter(Boolean);
  const observedEvents = [...new Set(events.map((entry) => entry.event_type).filter(Boolean))].slice(0, 24);
  const host = advisorHost(state, events) === 'unknown' ? requestedHost : advisorHost(state, events);
  const provenanceEntries = findings.flatMap((entry) => entry.provenance?.entries ?? []).slice(0, 32);
  const provenance = provenanceEntries.length
    ? { provenance_schema_version: 1, evidence_quality: findings.some((entry) => entry.provenance?.evidence_quality === 'live_verified') ? 'live_verified' : capabilityQuality, entries: provenanceEntries }
    : buildProvenance([...new Set(findings.flatMap((entry) => entry.reason_codes ?? []))], { host, observed_events: observedEvents, capabilities: Object.fromEntries(capabilityRecords.map((entry) => [`${entry.host}.${entry.event}`, entry.support])) });
  const latest = workflowCohort.latest;
  const current = latest ? {
    host,
    model: latest.metadata?.model ?? 'unknown',
    effort: latest.metadata?.reasoning_effort ?? 'unknown',
    source_type: 'main',
    schema_version: latest.schema_version ?? 2,
    usage_schema_version: latest.usage_layers?.usage_schema_version ?? 1,
    total_tokens: latest.total_tokens,
    status: latest.status,
  } : null;
  const history = selected.filter((entry) => entry !== latest).map((entry) => ({
    host,
    model: entry?.metadata?.model ?? 'unknown',
    effort: entry?.metadata?.reasoning_effort ?? 'unknown',
    source_type: 'main',
    schema_version: entry?.schema_version ?? 2,
    usage_schema_version: entry?.usage_layers?.usage_schema_version ?? 1,
    total_tokens: entry?.total_tokens,
    status: entry?.status,
  }));
  const baseline = current ? compareComparableBaseline(current, history, { minimum_samples: state?.usage?.config?.efficiency?.minimum_baseline_receipts ?? 10 }) : { baseline_schema_version: 1, quality: 'insufficient_data', sample_count: 0, minimum_samples: 10, median: null, mad: null, p50: null, p90: null, p95: null, current_tokens: null, delta_from_median: null };
  const structuralMetrics = calculateStructuralMetrics({
    receipts: selected,
    events,
    capability_coverage: { observed: observedCapabilities, total: capabilityRecords.length, quality: capabilityQuality === 'fixture_verified' ? 'partial' : capabilityQuality },
    coverage: selected.some((entry) => entry?.status === 'partial') ? 'partial' : selected.length ? 'somestoken_observed' : 'unavailable',
    warning_count: state?.health?.efficiency_warnings,
    host,
    cache_observed: latest?.usage_layers?.observed,
    cache_semantics: host === 'claude' ? claudeCacheSemantics() : host === 'codex' ? codexCacheSemantics() : null,
  });
  const fastMode = fastModeAnalytics(state, selected, { last: selected.length || 1 });
  const experiments = state?.optimization?.experiments && typeof state.optimization.experiments === 'object' ? Object.values(state.optimization.experiments) : [];
  const workflowAdvisor = workflowAdvisorAnalytics({
    host,
    receipts: selected,
    capability_evidence: capabilityQuality,
    experiments,
    metrics: structuralMetrics,
    fast_mode_context: {
      coverage: fastMode.coverage,
      comparison_status: fastMode.comparison?.status,
      observed_tier_sources: fastMode.observed_tier_sources,
      known_tier_sources: fastMode.known_tier_sources,
    },
    now: options.now,
    config: state?.usage?.config?.workflow_advisor,
  });
  const recommendations = generateRecommendations({
    host,
    scope: 'session',
    findings,
    metrics: structuralMetrics,
    baseline,
    provenance,
    affected_exact_tokens: findings.reduce((sum, entry) => sum + safeCount(entry?.affected_exact_tokens), 0),
    affected_partial_lower_bound_tokens: findings.reduce((sum, entry) => sum + safeCount(entry?.affected_partial_lower_bound_tokens), 0),
  });
  const sessionRecords = Object.values(state?.advisor?.sessions ?? {}).slice(-128).map(publicAdvisorSession).filter(Boolean);
  const sessionSummary = sessionRecords.at(-1) ?? null;
  return publicAdvisorReport({
    advisor_schema_version: ADVISOR_REPORT_SCHEMA_VERSION,
    status: !selected.length ? 'unavailable' : selected.some((entry) => entry?.status !== 'exact') ? 'partial' : 'exact',
    host,
    host_version: state?.advisor?.capabilities?.host_versions?.[host] ?? 'unknown',
    provenance,
    reason_code_wiring: auditReasonCodeWiring({ host, fixture_verified: true }),
    capabilities: {
      capability_schema_version: state?.advisor?.capabilities?.capability_schema_version ?? 1,
      support: capabilityQuality,
      documented_count: capabilityRecords.filter((entry) => entry.documented).length,
      fixture_verified_count: capabilityRecords.filter((entry) => entry.fixture_verified).length,
      observed_count: observedCapabilities,
      live_verified_count: liveCapabilities,
      records: capabilityRecords,
    },
    session_summary: sessionSummary,
    sessions: sessionRecords,
    structural_metrics: structuralMetrics,
    baseline_comparison: baseline,
    workflow_advisor: workflowAdvisor,
    recommendations,
    recommendation_count: recommendations.length,
    acceptance: Array.isArray(state?.advisor?.acceptance_windows) ? state.advisor.acceptance_windows.slice(-16) : [],
    reason_codes: [...new Set(findings.flatMap((entry) => entry.reason_codes ?? []))].slice(0, 32),
    evidence_counts: Object.fromEntries(findings.flatMap((entry) => Object.entries(entry.evidence_counts ?? [])).reduce((map, [key, value]) => map.set(key, Math.min(MAX_REPORT_ITEMS * 100, (map.get(key) ?? 0) + safeCount(value))), new Map())),
  }, { ...options, experiments });
}

function publicOptimizationRun(run) {
  return normalizeExperimentRun(run);
}

function safeOptimizationText(value) {
  return safeProtocolText(value);
}

function sanitizeShadowSummary(value) {
  if (Array.isArray(value)) return shadowPolicySummary(value.map(normalizeShadowDecision));
  const source = value && typeof value === 'object' ? value : {};
  const decisions = safeCount(source.decisions);
  const allowed = ['would_do_nothing', 'would_warn', 'would_recommend_pause', 'would_recommend_stop_goal', 'would_request_user_action', 'would_suppress_duplicate', 'insufficient_evidence'];
  const byDecision = Object.fromEntries(allowed.map((decision) => [decision, safeCount(source.by_decision?.[decision])]));
  const rate = (entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry <= 1 ? entry : null;
  return {
    policy_version: safeOptimizationText(source.policy_version) ?? '1',
    mode: 'shadow',
    decisions,
    shadow_warn_rate: rate(source.shadow_warn_rate),
    shadow_pause_rate: rate(source.shadow_pause_rate),
    shadow_stop_goal_rate: rate(source.shadow_stop_goal_rate),
    duplicate_suppression_rate: rate(source.duplicate_suppression_rate),
    by_decision: byDecision,
  };
}

function sanitizeCalibrationSummary(value) {
  if (Array.isArray(value)) return calibrationReport(value.map(normalizeCalibrationFeedback));
  const source = value && typeof value === 'object' ? value : {};
  return {
    calibration_schema_version: 1,
    feedback_seen: safeCount(source.feedback_seen),
    user_accepted_recommendation: safeCount(source.user_accepted_recommendation),
    user_rejected_recommendation: safeCount(source.user_rejected_recommendation),
    false_positive_marked: safeCount(source.false_positive_marked),
    too_early: safeCount(source.too_early),
    too_late: safeCount(source.too_late),
    unknown: safeCount(source.unknown),
    thresholds_changed_automatically: false,
  };
}

/** Public v0.4 optimization report. It never exposes raw experiment input. */
export function optimizationReport(state) {
  if (state?.optimization_report && typeof state.optimization_report === 'object') return sanitizeOptimizationSnapshot(state.optimization_report);
  const optimization = state?.optimization && typeof state.optimization === 'object' ? state.optimization : null;
  if (!optimization) return {
    optimization_schema_version: 1,
    status: 'unavailable',
    manual_gates: { gates: [], open_count: 0, satisfied_count: 0 },
    experiments: [], pairs: [], reductions: [], reduction_summary: summarizeReductions([]),
    shadow_policy: shadowPolicySummary([]), shadow_decisions: [], calibration: calibrationReport([]), goal_hygiene: [],
  };
  const gates = summarizeGates(optimization.manual_gates);
  const lifecycle=lifecycleSummary(optimization.lifecycle_checks);
  const outputCompaction=outputCompactionSummary(optimization.output_compaction);
  const experiments = listExperiments(optimization.experiments).map((experiment) => ({
    experiment_id: experiment.experiment_id,
    host: experiment.host,
    workload_class: experiment.workload_class,
    comparison_axis: experiment.comparison_axis,
    recommendation_id: experiment.recommendation_id,
    state: experiment.state,
    started_at: experiment.started_at,
    closed_at: experiment.closed_at,
    run_count: experiment.run_count,
    recommendation_status: ['not_applied', 'experiment_started', 'applied', 'measured_positive', 'measured_neutral', 'measured_negative', 'incomparable', 'outcome_regressed'].includes(experiment.recommendation_status) ? experiment.recommendation_status : 'not_applied',
    runs: experiment.runs.map(publicOptimizationRun).filter(Boolean),
  }));
  const pairs = [];
  const reductions = [];
  const measurementsByExperiment = new Map();
  for (const experiment of experiments) {
    const result = findComparablePairs(experiment.runs, { comparison_axis: experiment.comparison_axis, experiment_id: experiment.experiment_id });
    for (const pair of result) {
      const publicPair = {
        pair_id: pair.pair_id,
        experiment_id: experiment.experiment_id,
        comparable: pair.comparable,
        reasons: pair.reasons,
        outcome_relation: pair.outcome_relation,
      };
      pairs.push(publicPair);
      const measurement = measureReduction(pair);
      reductions.push(measurement);
      const existing = measurementsByExperiment.get(experiment.experiment_id) ?? [];
      existing.push(measurement);
      measurementsByExperiment.set(experiment.experiment_id, existing);
    }
  }
  for (const experiment of experiments) {
    experiment.recommendation_status = recommendationStatusForExperiment(experiment, measurementsByExperiment.get(experiment.experiment_id) ?? []);
  }
  const reductionSummary = summarizeReductions(reductions);
  const shadow = shadowPolicySummary(optimization.shadow_policy);
  const shadowDecisions = (Array.isArray(optimization.shadow_policy) ? optimization.shadow_policy : [])
    .map(normalizeShadowDecision).slice(-128);
  const calibration = calibrationReport(optimization.calibration);
  const goalHygiene = Object.entries(optimization.goal_hygiene ?? {}).slice(-128).map(([key, value]) => ({
      key: safeOptimizationText(key) ?? 'unknown',
    gate_id: typeof value?.gate_id === 'string' && /^[a-z0-9_]{1,80}$/.test(value.gate_id) ? value.gate_id : 'unknown',
    continuation_count: safeCount(value?.continuation_count),
    last_evidence_revision: safeCount(value?.last_evidence_revision),
    structural_progress: safeCount(value?.structural_progress),
    warnings: safeCount(value?.warnings),
    updated_at: safeTimestamp(value?.updated_at),
  }));
  return {
    optimization_schema_version: 1,
    status: experiments.length || gates.gates.length || goalHygiene.length || shadow.decisions || lifecycle.session_count || outputCompaction.groups.length ? 'partial' : 'unavailable',
    lifecycle_checks:lifecycle,
    output_compaction:outputCompaction,
    manual_gates: gates,
    goal_hygiene: goalHygiene,
    experiments,
    pairs: pairs.slice(-128),
    reductions: reductions.slice(-128),
    reduction_summary: reductionSummary,
    shadow_policy: shadow,
    shadow_decisions: shadowDecisions,
    calibration,
    counters: Object.fromEntries(Object.entries(optimization.counters ?? {}).slice(0, 64).filter(([key, value]) => /^[a-z0-9_]{1,80}$/.test(key) && Number.isSafeInteger(value) && value >= 0)),
  };
}

function sanitizeOptimizationSnapshot(value) {
  const source = value && typeof value === 'object' ? value : {};
  const safeList = (value, limit = 128) => Array.isArray(value) ? value.slice(-limit).filter((entry) => entry && typeof entry === 'object') : [];
  const experiments = safeList(source.experiments).map((entry, index) => [String(index), entry]);
  const derived = optimizationReport({ optimization: { experiments: Object.fromEntries(experiments) } });
  const reductions = experiments.length ? derived.reductions : safeList(source.reductions).map(normalizeReduction);
  const gates = source.manual_gates && typeof source.manual_gates === 'object' ? source.manual_gates : { gates: [], open_count: 0, satisfied_count: 0 };
  return {
    optimization_schema_version: 1,
    status: ['exact', 'partial', 'unavailable'].includes(source.status) ? source.status : 'partial',
    lifecycle_checks:sanitizeLifecycleSummary(source.lifecycle_checks),
    output_compaction:sanitizeOutputCompactionSummary(source.output_compaction),
    manual_gates: {
      schema_version: 1,
      gates: safeList(gates.gates, 8).map((entry) => ({
        gate_id: typeof entry.gate_id === 'string' && /^[a-z0-9_]{1,80}$/.test(entry.gate_id) ? entry.gate_id : 'unknown',
        host: entry.host === 'codex' || entry.host === 'claude' ? entry.host : 'unknown',
        status: ['open', 'satisfied', 'unavailable', 'deferred', 'expired', 'superseded'].includes(entry.status) ? entry.status : 'unavailable',
        source: ['acceptance', 'cli', 'host', 'manual', 'configuration', 'unknown'].includes(entry.source) ? entry.source : 'unknown',
        evidence_revision: safeCount(entry.evidence_revision),
        requires: ['user_or_host', 'host', 'user'].includes(entry.requires) ? entry.requires : 'user_or_host',
        blocking_scope: ['release', 'session', 'experiment'].includes(entry.blocking_scope) ? entry.blocking_scope : 'release',
        updated_at: safeTimestamp(entry.updated_at),
      })),
      open_count: safeCount(gates.open_count),
      satisfied_count: safeCount(gates.satisfied_count),
    },
    goal_hygiene: safeList(source.goal_hygiene).map((entry) => ({
      key: safeOptimizationText(entry.key) ?? 'unknown',
      gate_id: typeof entry.gate_id === 'string' && /^[a-z0-9_]{1,80}$/.test(entry.gate_id) ? entry.gate_id : 'unknown',
      continuation_count: safeCount(entry.continuation_count),
      last_evidence_revision: safeCount(entry.last_evidence_revision),
      structural_progress: safeCount(entry.structural_progress),
      warnings: safeCount(entry.warnings),
      updated_at: safeTimestamp(entry.updated_at),
    })),
    experiments: derived.experiments,
    pairs: experiments.length ? derived.pairs : safeList(source.pairs).map(normalizePair).filter(Boolean).map((pair) => ({
      pair_id: pair.pair_id,
      experiment_id: pair.experiment_id,
      comparable: pair.comparable,
      reasons: pair.reasons,
      outcome_relation: pair.outcome_relation,
    })),
    reductions,
    reduction_summary: summarizeReductions(reductions),
    shadow_policy: sanitizeShadowSummary(source.shadow_policy),
    shadow_decisions: safeList(source.shadow_decisions).map(normalizeShadowDecision),
    calibration: sanitizeCalibrationSummary(source.calibration),
    counters: Object.fromEntries(Object.entries(source.counters ?? {}).slice(0, 64).filter(([key, count]) => /^[a-z0-9_]{1,80}$/.test(key) && Number.isSafeInteger(count) && count >= 0)),
  };
}

function publicMetric(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const quality = ['exact', 'partial', 'unavailable'].includes(value.quality) ? value.quality : 'unavailable';
  const safeNumber = (entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : null;
  return {
    value: safeNumber(value.value),
    numerator: safeNumber(value.numerator),
    denominator: safeNumber(value.denominator),
    quality,
    coverage: safeProtocolText(value.coverage) ?? 'unavailable',
    ...(safeProtocolText(value.cache_read_semantics) ? { cache_read_semantics: safeProtocolText(value.cache_read_semantics) } : {}),
  };
}

function publicProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const quality = ['documented', 'fixture_verified', 'observed', 'live_verified', 'insufficient_evidence'].includes(value.evidence_quality) ? value.evidence_quality : 'insufficient_evidence';
  const entries = Array.isArray(value.entries) ? value.entries.slice(0, 32).map((entry) => {
    if (!entry || typeof entry !== 'object' || !/^[a-z0-9_]{1,80}$/.test(entry.reason_code ?? '') || !safeModel(entry.reason_code)) return null;
    return {
      reason_code: entry.reason_code,
      host: entry.host === 'codex' || entry.host === 'claude' ? entry.host : 'unknown',
      required_events: Array.isArray(entry.required_events) ? [...new Set(entry.required_events.filter((item) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9]{1,40}$/.test(item)))].slice(0, 8) : [],
      required_safe_fields: Array.isArray(entry.required_safe_fields) ? [...new Set(entry.required_safe_fields.filter((item) => /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(item) && safeModel(item)))].slice(0, 8) : [],
      observed_events: Array.isArray(entry.observed_events) ? [...new Set(entry.observed_events.filter((item) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9]{1,40}$/.test(item)))].slice(0, 8) : [],
      support: ['documented', 'fixture_verified', 'observed', 'live_verified', 'unavailable', 'version_incompatible', 'missing_required_fields'].includes(entry.support) ? entry.support : 'unavailable',
      evidence_scope: safeProtocolText(entry.evidence_scope) ?? 'unavailable',
      recommendation_ids: Array.isArray(entry.recommendation_ids) ? [...new Set(entry.recommendation_ids.filter((item) => /^[a-z0-9_]{1,80}$/.test(item) && safeModel(item)))].slice(0, 8) : [],
    };
  }).filter(Boolean) : [];
  return { provenance_schema_version: 1, evidence_quality: quality, entries };
}

/** Validate an advisor report crossing the public bridge without retaining unknown fields. */
export function publicAdvisorReport(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {
    advisor_schema_version: ADVISOR_REPORT_SCHEMA_VERSION,
    status: 'unavailable',
    host: 'unknown',
    provenance: { provenance_schema_version: 1, evidence_quality: 'insufficient_evidence', entries: [] },
    reason_code_wiring: [],
    capabilities: { capability_schema_version: 1, support: 'unavailable', documented_count: 0, fixture_verified_count: 0, observed_count: 0, live_verified_count: 0, records: [] },
    sessions: [], structural_metrics: {}, baseline_comparison: { quality: 'insufficient_data', sample_count: 0 }, workflow_advisor: workflowAdvisorAnalytics({ receipts: [] }), recommendations: [], recommendation_count: 0, acceptance: [], reason_codes: [], evidence_counts: {},
  };
  const status = ['exact', 'partial', 'unavailable'].includes(value.status) ? value.status : 'unavailable';
  const host = value.host === 'codex' || value.host === 'claude' ? value.host : 'unknown';
  const records = Array.isArray(value.capabilities?.records) ? value.capabilities.records.slice(0, 64).map((entry) => {
    if (!entry || typeof entry !== 'object' || (entry.host !== 'codex' && entry.host !== 'claude') || typeof entry.event !== 'string') return null;
    const event = /^[A-Za-z][A-Za-z0-9]{1,40}$/.test(entry.event) ? entry.event : 'Unknown';
    return {
      capability_id: typeof entry.capability_id === 'string' && /^[a-z0-9_.-]{1,100}$/.test(entry.capability_id) && !isSensitiveRuntimeValue(entry.capability_id) ? entry.capability_id : `${entry.host}.${event.toLowerCase()}`,
      host: entry.host,
      host_version: safeProtocolText(entry.host_version) ?? 'unknown',
      adapter_version: safeAdvisorCount(entry.adapter_version) || 1,
      event,
      required_fields: Array.isArray(entry.required_fields) ? [...new Set(entry.required_fields.filter((item) => safeModel(item) && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(item)))].slice(0, 8) : [],
      documented: entry.documented === true,
      fixture_verified: entry.fixture_verified === true,
      observed_this_session: entry.observed_this_session === true,
      live_verified_at: safeTimestamp(entry.live_verified_at),
      support: ['documented', 'fixture_verified', 'observed', 'live_verified', 'unavailable', 'version_incompatible', 'missing_required_fields'].includes(entry.support) ? entry.support : 'unavailable',
      reason_codes: Array.isArray(entry.reason_codes) ? [...new Set(entry.reason_codes.filter((item) => safeModel(item) && /^[a-z0-9_]{1,80}$/.test(item)))].slice(0, 8) : [],
    };
  }).filter(Boolean) : [];
  const metrics = {};
  for (const [key, metricValue] of Object.entries(value.structural_metrics ?? {}).slice(0, 32)) if (/^[a-z0-9_]{1,80}$/.test(key) && safeModel(key)) metrics[key] = publicMetric(metricValue);
  const baseline = value.baseline_comparison && typeof value.baseline_comparison === 'object' ? {
    baseline_schema_version: Number.isSafeInteger(value.baseline_comparison.baseline_schema_version) ? value.baseline_comparison.baseline_schema_version : 1,
    quality: ['exact', 'insufficient_data', 'unavailable'].includes(value.baseline_comparison.quality) ? value.baseline_comparison.quality : 'insufficient_data',
    sample_count: safeAdvisorCount(value.baseline_comparison.sample_count),
    minimum_samples: safeAdvisorCount(value.baseline_comparison.minimum_samples),
    median: safeAdvisorNumber(value.baseline_comparison.median),
    mad: safeAdvisorNumber(value.baseline_comparison.mad),
    p50: safeAdvisorNumber(value.baseline_comparison.p50),
    p90: safeAdvisorNumber(value.baseline_comparison.p90),
    p95: safeAdvisorNumber(value.baseline_comparison.p95),
    current_tokens: safeAdvisorNumber(value.baseline_comparison.current_tokens),
    delta_from_median: typeof value.baseline_comparison.delta_from_median === 'number' && Number.isFinite(value.baseline_comparison.delta_from_median) ? value.baseline_comparison.delta_from_median : null,
  } : { quality: 'insufficient_data', sample_count: 0 };
  const recommendations = Array.isArray(value.recommendations) ? value.recommendations.slice(0, 3).map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null;
    const id = typeof entry.id === 'string' && Object.hasOwn(RECOMMENDATION_CATALOG, entry.id)
      ? entry.id
      : 'collect_more_evidence';
    return {
      id,
      status: entry.status === 'candidate' ? 'candidate' : 'suppressed',
      host: entry.host === 'codex' || entry.host === 'claude' ? entry.host : 'unknown',
      scope: entry.scope === 'turn' ? 'turn' : 'session',
      confidence: ['low', 'medium', 'high'].includes(entry.confidence) ? entry.confidence : 'low',
      reason_codes: Array.isArray(entry.reason_codes) ? [...new Set(entry.reason_codes.filter((item) => safeModel(item) && /^[a-z0-9_]{1,80}$/.test(item)))].slice(0, 8) : [],
      evidence_counts: Object.fromEntries(Object.entries(entry.evidence_counts ?? {}).slice(0, 8).filter(([key, count]) => /^[a-z0-9_]{1,80}$/.test(key) && safeModel(key) && Number.isSafeInteger(count) && count >= 0)),
      capability_evidence: ['documented', 'fixture_verified', 'observed', 'live_verified', 'insufficient_evidence'].includes(entry.capability_evidence) ? entry.capability_evidence : 'insufficient_evidence',
      affected_usage_quality: ['exact', 'partial', 'unavailable'].includes(entry.affected_usage_quality) ? entry.affected_usage_quality : 'unavailable',
      ...(Number.isSafeInteger(entry.affected_tokens) && entry.affected_tokens >= 0 ? { affected_tokens: Math.min(entry.affected_tokens, Number.MAX_SAFE_INTEGER) } : {}),
      potential_savings: 'unmeasured',
      copy: RECOMMENDATION_CATALOG[id].copy,
    };
  }).filter(Boolean) : [];
  const provenance = publicProvenance(value.provenance) ?? { provenance_schema_version: 1, evidence_quality: 'insufficient_evidence', entries: [] };
  const workflowAdvisor = normalizeWorkflowAdvisor(value.workflow_advisor, options) ?? workflowAdvisorAnalytics({ receipts: [] });
  const reasonCodeWiring = Array.isArray(value.reason_code_wiring) ? value.reason_code_wiring.slice(0, 32).map((entry) => ({
    reason_code: typeof entry?.reason_code === 'string' && /^[a-z0-9_]{1,80}$/.test(entry.reason_code) && safeModel(entry.reason_code) ? entry.reason_code : 'unknown',
    host_applicability: Array.isArray(entry?.host_applicability) ? entry.host_applicability.filter((item) => item === 'codex' || item === 'claude') : [],
    required_events: Array.isArray(entry?.required_events) ? entry.required_events.filter((item) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9]{1,40}$/.test(item)).slice(0, 8) : [],
    required_safe_fields: Array.isArray(entry?.required_safe_fields) ? entry.required_safe_fields.filter((item) => safeModel(item) && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(item)).slice(0, 8) : [],
    minimum_event_count: safeAdvisorCount(entry?.minimum_event_count),
    signal_strength: ['weak', 'strong'].includes(entry?.signal_strength) ? entry.signal_strength : 'weak',
    classification_contribution: safeProtocolText(entry?.classification_contribution) ?? 'insufficient_evidence',
    supported_fallback: safeProtocolText(entry?.supported_fallback) ?? 'insufficient_evidence',
    capability: safeProtocolText(entry?.capability) ?? 'unavailable',
    recommendation_ids: Array.isArray(entry?.recommendation_ids) ? entry.recommendation_ids.filter((item) => safeModel(item) && /^[a-z0-9_]{1,80}$/.test(item)).slice(0, 8) : [],
  })) : [];
  return {
    advisor_schema_version: ADVISOR_REPORT_SCHEMA_VERSION,
    status,
    host,
    host_version: safeProtocolText(value.host_version) ?? 'unknown',
    provenance,
    reason_code_wiring: reasonCodeWiring,
    capabilities: {
      capability_schema_version: Number.isSafeInteger(value.capabilities?.capability_schema_version) ? value.capabilities.capability_schema_version : 1,
      support: ['documented', 'fixture_verified', 'observed', 'live_verified', 'unavailable'].includes(value.capabilities?.support) ? value.capabilities.support : 'unavailable',
      documented_count: safeCount(value.capabilities?.documented_count),
      fixture_verified_count: safeCount(value.capabilities?.fixture_verified_count),
      observed_count: safeCount(value.capabilities?.observed_count),
      live_verified_count: safeCount(value.capabilities?.live_verified_count),
      records,
    },
    session_summary: publicAdvisorSession(value.session_summary),
    sessions: Array.isArray(value.sessions) ? value.sessions.slice(-128).map(publicAdvisorSession).filter(Boolean) : [],
    structural_metrics: metrics,
    baseline_comparison: baseline,
    workflow_advisor: workflowAdvisor,
    recommendations,
    recommendation_count: recommendations.length,
    acceptance: Array.isArray(value.acceptance) ? value.acceptance.slice(-16).filter((entry) => entry && typeof entry === 'object').map((entry) => ({
      window_id: typeof entry.window_id === 'string' && /^[a-f0-9]{20}$/.test(entry.window_id) ? entry.window_id : undefined,
      host: entry.host === 'codex' || entry.host === 'claude' ? entry.host : 'unknown',
      scenario: safeProtocolText(entry.scenario) ?? 'manual',
      state: ['open', 'completed', 'interrupted', 'expired'].includes(entry.state) ? entry.state : 'interrupted',
      started_at: safeTimestamp(entry.started_at) ?? null,
      ended_at: entry.ended_at === null ? null : safeTimestamp(entry.ended_at),
      event_counts: Object.fromEntries(Object.entries(entry.event_counts ?? {}).slice(0, 32).filter(([key, count]) => EVENT_TYPES.has(key) && Number.isSafeInteger(count) && count >= 0)),
      observed_events: Array.isArray(entry.observed_events) ? [...new Set(entry.observed_events.filter((item) => EVENT_TYPES.has(item)))].slice(0, 32) : [],
    })) : [],
    reason_codes: Array.isArray(value.reason_codes) ? [...new Set(value.reason_codes.filter((item) => safeModel(item) && /^[a-z0-9_]{1,80}$/.test(item)))].slice(0, 32) : [],
    evidence_counts: Object.fromEntries(Object.entries(value.evidence_counts ?? {}).slice(0, 32).filter(([key, count]) => /^[a-z0-9_]{1,80}$/.test(key) && safeModel(key) && Number.isSafeInteger(count) && count >= 0)),
  };
}

const DEGRADED_HEALTH_KEYS = new Set([
  'malformed_events',
  'duplicate_hooks',
  'duplicate_events',
  'counter_resets',
  'partial_receipts',
  'unavailable_receipts',
  'unresolved_sources',
  'lock_timeouts',
  'state_recoveries',
  'retention_drops',
  'efficiency_retention_drops',
  'receipt_retention_drops',
  'state_retention_drops',
  'late_events_after_close',
  'public_snapshot_write_failures',
  'public_snapshot_read_failures',
  'public_snapshot_schema_mismatches',
  'mcp_public_read_failures',
  'statusline_stale_reads',
  'evidence_bundle_failures',
  'policy_rejections',
  'limit_recovery_unavailable',
  'limit_recovery_protocol_errors',
  'limit_recovery_state_drops',
]);

export function healthSummary(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    return {
      report_schema_version: REPORT_SCHEMA_VERSION,
      status: 'unavailable',
      degraded_reasons: [],
      ...Object.fromEntries(HEALTH_KEYS.map((key) => [key, null])),
    };
  }
  const counters = Object.fromEntries(HEALTH_KEYS.map((key) => [key, safeCount(health[key], MAX_HEALTH_COUNTER)]));
  const degradedReasons = HEALTH_KEYS.filter((key) => DEGRADED_HEALTH_KEYS.has(key) && counters[key] > 0);
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    status: degradedReasons.length ? 'degraded' : 'healthy',
    degraded_reasons: degradedReasons,
    ...counters,
  };
}

export const QUALITY_SCHEMA_VERSION = 1;
const QUALITY_DEGRADED_REASONS = Object.freeze([
  'receipt_partial',
  'receipt_unavailable',
  'source_coverage',
  'source_total_mismatch',
  'usage_inconsistent',
  'source_overflow',
  'malformed_events',
  'duplicate_hooks',
  'duplicate_events',
  'counter_resets',
  'health_partial_receipts',
  'health_unavailable_receipts',
  'unresolved_sources',
  'lock_timeouts',
  'state_recoveries',
  'retention_drops',
  'health_unavailable',
]);

function qualityRate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const bounded = Math.max(0, Math.min(1, numerator / denominator));
  return Math.round(bounded * 10000) / 10000;
}

function qualityHealthCounter(health, key) {
  return health && typeof health === 'object' && !Array.isArray(health)
    ? safeCount(health[key], MAX_HEALTH_COUNTER)
    : 0;
}

function qualityIntegrity(selected, state, options = {}) {
  let sourceTotalMismatches = state
    ? 0
    : safeCount(options.source_total_mismatches, MAX_REPORT_ITEMS);
  let usageConsistent = 0;
  let usageInconsistent = 0;
  let usageUnknown = 0;
  for (const receipt of selected) {
    const usage = safeUsage(receipt);
    if (!usage || !RECEIPT_STATUSES.has(receipt.status) || receipt.status === 'unavailable') continue;
    const breakdown = state ? publicTurnBreakdown(state, receipt) : null;
    const signal = accountingSignalForTurn(receipt, breakdown);
    if (state && signal.source_total_mismatch) sourceTotalMismatches = Math.min(MAX_REPORT_ITEMS, sourceTotalMismatches + 1);
    if (signal.usage_consistency === 'exact') usageConsistent = Math.min(MAX_REPORT_ITEMS, usageConsistent + 1);
    else if (signal.usage_consistency === 'inconsistent') usageInconsistent = Math.min(MAX_REPORT_ITEMS, usageInconsistent + 1);
    else usageUnknown = Math.min(MAX_REPORT_ITEMS, usageUnknown + 1);
  }
  return {
    source_total_mismatches: sourceTotalMismatches,
    usage_consistent: usageConsistent,
    usage_inconsistent: usageInconsistent,
    usage_consistency_unknown: usageUnknown,
  };
}

export function qualitySummary(receipts, health, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const integrity = qualityIntegrity(selected, options.state, options);
  const sourceTotalMismatches = integrity.source_total_mismatches;
  const receiptCounts = {
    exact_receipts: 0,
    partial_receipts: 0,
    unavailable_receipts: 0,
  };
  for (const receipt of selected) {
    const usable = safeUsage(receipt);
    if (receipt.status === 'exact' && usable) receiptCounts.exact_receipts += 1;
    else if (receipt.status === 'partial' && usable) receiptCounts.partial_receipts += 1;
    else receiptCounts.unavailable_receipts += 1;
  }

  const sources = aggregateSourceCounts(selected);
  const counters = Object.fromEntries(HEALTH_KEYS.map((key) => [key, qualityHealthCounter(health, key)]));
  const healthAvailable = Boolean(health && typeof health === 'object' && !Array.isArray(health));
  const sourceInconsistent = sources.unavailable_sources > 0
    || (sources.expected_sources > 0
      ? sources.resolved_sources < sources.expected_sources || sources.resolved_sources > sources.expected_sources
      : sources.resolved_sources > 0);
  const eventDenominator = counters.token_events_seen + counters.malformed_events;
  // A counter at the cap stops counting, so a ratio built on it would freeze.
  const saturatedCounters = HEALTH_KEYS.filter((key) => counters[key] >= MAX_HEALTH_COUNTER);
  const eventsSaturated = saturatedCounters.includes('token_events_seen') || saturatedCounters.includes('malformed_events');
  const reasonFlags = {
    receipt_partial: receiptCounts.partial_receipts > 0,
    receipt_unavailable: receiptCounts.unavailable_receipts > 0,
    source_coverage: sourceInconsistent,
    source_total_mismatch: sourceTotalMismatches > 0,
    usage_inconsistent: integrity.usage_inconsistent > 0,
    source_overflow: sources.overflow_sources > 0,
    malformed_events: counters.malformed_events > 0,
    duplicate_hooks: counters.duplicate_hooks > 0,
    duplicate_events: counters.duplicate_events > 0,
    counter_resets: counters.counter_resets > 0,
    health_partial_receipts: counters.partial_receipts > 0,
    health_unavailable_receipts: counters.unavailable_receipts > 0,
    unresolved_sources: counters.unresolved_sources > 0,
    lock_timeouts: counters.lock_timeouts > 0,
    state_recoveries: counters.state_recoveries > 0,
    retention_drops: counters.receipt_retention_drops > 0
      || counters.state_retention_drops > 0
      || (counters.retention_drops > 0
        && counters.efficiency_retention_drops === 0
        && counters.receipt_retention_drops === 0
        && counters.state_retention_drops === 0),
    health_unavailable: selected.length > 0 && !healthAvailable,
  };
  const degradedReasons = QUALITY_DEGRADED_REASONS.filter((reason) => reasonFlags[reason]);
  const status = selected.length === 0
    ? degradedReasons.length ? 'degraded' : 'unavailable'
    : degradedReasons.length ? 'degraded' : 'healthy';

  return {
    quality_schema_version: QUALITY_SCHEMA_VERSION,
    report_schema_version: REPORT_SCHEMA_VERSION,
    status,
    turns: selected.length,
    ...receiptCounts,
    exact_rate: qualityRate(receiptCounts.exact_receipts, selected.length),
    source_expected: sources.expected_sources,
    source_resolved: sources.resolved_sources,
    source_unavailable: sources.unavailable_sources,
    source_overflow: sources.overflow_sources,
    source_coverage: qualityRate(sources.resolved_sources, sources.expected_sources),
    source_total_mismatches: sourceTotalMismatches,
    usage_consistency_checked: integrity.usage_consistent + integrity.usage_inconsistent,
    usage_consistent: integrity.usage_consistent,
    usage_inconsistent: integrity.usage_inconsistent,
    usage_consistency_unknown: integrity.usage_consistency_unknown,
    usage_consistency_rate: qualityRate(integrity.usage_consistent, integrity.usage_consistent + integrity.usage_inconsistent),
    token_events_seen: counters.token_events_seen,
    malformed_events: counters.malformed_events,
    token_event_validity: eventsSaturated ? null : qualityRate(counters.token_events_seen, eventDenominator),
    duplicate_hooks: counters.duplicate_hooks,
    duplicate_events: counters.duplicate_events,
    counter_resets: counters.counter_resets,
    health_partial_receipts: counters.partial_receipts,
    health_unavailable_receipts: counters.unavailable_receipts,
    unresolved_sources: counters.unresolved_sources,
    lock_timeouts: counters.lock_timeouts,
    state_recoveries: counters.state_recoveries,
    retention_drops: counters.retention_drops,
    efficiency_retention_drops: counters.efficiency_retention_drops,
    receipt_retention_drops: counters.receipt_retention_drops,
    state_retention_drops: counters.state_retention_drops,
    saturated_counters: saturatedCounters,
    degraded_reasons: degradedReasons,
  };
}
