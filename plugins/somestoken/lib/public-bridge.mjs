import { sumUsage } from './core.mjs';
import { publicAdvisorReport } from './reporting.mjs';
import { normalizeWorkflowAdvisor, workflowAdvisorAnalytics } from './workflow-advisor.mjs';
import { writePublicSnapshot } from './public/write.mjs';
import { normalizePublicSnapshot } from './public/schema.mjs';
import { normalizeUsageLayers } from './usage/schema.mjs';
import { isTelemetryOutcome } from './telemetry-outcomes.mjs';
import { recoverLegacyClaudeCacheReadUsage } from './hosts/claude-code.mjs';

const MAX_BRIDGE_SUBAGENTS = 32;
const RECEIPT_STATUSES = new Set(['exact', 'partial', 'unavailable']);

function sourceMetadata(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return {
    status: source.metadata_status,
    confidence: source.metadata_confidence,
    source: source.metadata_source,
    model: source.model,
    reasoning_effort: source.reasoning_effort,
  };
}

function internalSource(source, kind) {
  const status = RECEIPT_STATUSES.has(source?.status) ? source.status : 'unavailable';
  const usable = status !== 'unavailable' && source?.usage && typeof source.usage === 'object';
  return {
    ...(kind === 'main'
      ? { valid: usable, ambiguous: status === 'partial' }
      : { status: usable ? 'completed' : 'pending', ambiguous: status === 'partial' }),
    ...(usable ? { usage: source.usage } : {}),
    metadata: sourceMetadata(source),
  };
}

function internalTurn(breakdown) {
  const subagents = Array.isArray(breakdown?.subagents)
    ? breakdown.subagents.slice(0, MAX_BRIDGE_SUBAGENTS)
    : [];
  return {
    main: internalSource(breakdown?.main, 'main'),
    subagents: Object.fromEntries(subagents.map((source, index) => [String(index), internalSource(source, 'subagent')])),
  };
}

export function writePublicBridge(env, state) {
  // Hooks write host data only. Codex 0.164 hashes the installed plugin folder
  // for hook trust, so any file written there stops every SomesToken hook.
  return writePublicSnapshot(env, state).ok;
}

const PUBLIC_SESSION_CLOSURES = new Set([
  'closed_exact', 'closed_partial', 'closed_with_pending_sources', 'interrupted', 'expired', 'recovered',
]);
const PUBLIC_TELEMETRY_STATES = new Set(['received', 'pending_post_turn', 'unavailable']);
const PUBLIC_TELEMETRY_SOURCES = new Set(['transcript', 'structured_hook', 'none']);

function publicSnapshotTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = PUBLIC_TELEMETRY_STATES.has(value.state) ? value.state : null;
  const source = PUBLIC_TELEMETRY_SOURCES.has(value.source) ? value.source : null;
  const attempts = Number.isSafeInteger(value.attempts) && value.attempts >= 0 ? Math.min(value.attempts, 100) : null;
  const outcome = isTelemetryOutcome(value.outcome) ? value.outcome : undefined;
  return state && source && attempts !== null
    ? { state, source, attempts, ...(outcome ? { outcome } : {}) }
    : null;
}

function publicSnapshotCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function publicSnapshotIso(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const milliseconds = value > 1e12 ? value : value * 1000;
  return milliseconds <= 8_640_000_000_000_000 ? new Date(milliseconds).toISOString() : null;
}

function advisorFromPublicSnapshot(snapshot, quality) {
  const host = snapshot.host === 'codex' || snapshot.host === 'claude' ? snapshot.host : 'unknown';
  const exactLatest = snapshot.latest_receipt?.status === 'exact'
    && snapshot.latest_receipt?.usage?.quality === 'exact';
  const counts = snapshot.capabilities && typeof snapshot.capabilities === 'object' ? snapshot.capabilities : {};
  const observed = publicSnapshotCount(counts.observed);
  const liveVerified = publicSnapshotCount(counts.live_verified);
  const fixtureVerified = publicSnapshotCount(counts.fixture_verified);
  const unavailable = publicSnapshotCount(counts.unavailable);
  const missingRequiredFields = publicSnapshotCount(counts.missing_required_fields);
  const support = liveVerified > 0
    ? 'live_verified'
    : observed > 0
      ? 'observed'
      : fixtureVerified > 0
        ? 'fixture_verified'
        : 'unavailable';
  const publicClosure = snapshot.session && typeof snapshot.session === 'object'
    && PUBLIC_SESSION_CLOSURES.has(snapshot.session.closure)
    ? snapshot.session.closure
    : null;
  const session = publicClosure ? {
    host,
    closure_state: publicClosure,
    // The compact bridge intentionally does not carry lifecycle timestamps.
    // Null keeps that limitation explicit instead of fabricating a time.
    opened_at: null,
    closed_at: null,
    pending_sources: publicSnapshotCount(snapshot.session.pending_source_count),
    // A compact snapshot has only aggregate health, not a per-session count.
    late_events: null,
    event_counts: {},
    summary: null,
  } : null;
  const recommendations = exactLatest && Array.isArray(snapshot.recommendations)
    ? snapshot.recommendations.slice(0, 3).map((entry) => ({
      id: entry?.recommendation_id,
      status: entry?.status,
      host,
      scope: 'session',
      confidence: entry?.confidence,
      reason_codes: entry?.reason_codes,
      evidence_counts: {},
      capability_evidence: support === 'unavailable' ? 'insufficient_evidence' : support,
      affected_usage_quality: quality,
      potential_savings: 'unmeasured',
      })) : [];
  const workflowAdvisor = (exactLatest && snapshot.workflow_advisor?.host === host
    ? normalizeWorkflowAdvisor(snapshot.workflow_advisor) : null) ?? workflowAdvisorAnalytics({ host, receipts: [] });
  return publicAdvisorReport({
    advisor_schema_version: 1,
    status: quality,
    host,
    host_version: typeof snapshot.host_version === 'string' ? snapshot.host_version : 'unknown',
    provenance: {
      provenance_schema_version: 1,
      evidence_quality: support === 'unavailable' ? 'insufficient_evidence' : support,
      entries: [],
    },
    reason_code_wiring: [],
    capabilities: {
      capability_schema_version: 1,
      support,
      // The public contract carries aggregate counts, never detailed records.
      documented_count: observed > Number.MAX_SAFE_INTEGER - unavailable
        ? Number.MAX_SAFE_INTEGER
        : observed + unavailable,
      fixture_verified_count: fixtureVerified,
      observed_count: observed,
      live_verified_count: liveVerified,
      records: [],
      ...(missingRequiredFields > 0 ? { missing_required_fields: missingRequiredFields } : {}),
    },
    session_summary: session,
    sessions: session ? [session] : [],
    structural_metrics: {},
    baseline_comparison: { quality: 'insufficient_data', sample_count: 0 },
    workflow_advisor: workflowAdvisor,
    recommendations,
    acceptance: [],
    reason_codes: [
      ...(Array.isArray(snapshot.reason_codes) ? snapshot.reason_codes : []),
      ...(snapshot.efficiency && typeof snapshot.efficiency === 'object' && Array.isArray(snapshot.efficiency.reason_codes)
        ? snapshot.efficiency.reason_codes
        : []),
    ],
    evidence_counts: {},
  });
}

function publicUsageProjection(usage, host, comparisonMode) {
  const sourceQuality = RECEIPT_STATUSES.has(usage.quality) ? usage.quality : 'unavailable';
  const numericUsage = sourceQuality === 'unavailable' ? {} : Object.fromEntries(
    ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'cache_write_input_tokens']
      .filter((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
      .map((key) => [key, usage[key]]),
  );
  if (sourceQuality !== 'unavailable' && usage.cache_write_input_tokens === null) {
    // Public snapshots without this optional component remain usable. Keep
    // the component explicitly unknown instead of treating it as zero.
    numericUsage.cache_write_input_tokens = null;
  }
  // A legacy public Claude snapshot can preserve only the old raw-input plus
  // cache-read tuple. Upgrade it only when its arithmetic proves that shape;
  // the projection is deliberately partial because the old field contract is
  // not an exact current-host receipt. The on-disk snapshot remains unchanged.
  const legacyClaudeUsage = host === 'claude' && sourceQuality !== 'unavailable'
    ? recoverLegacyClaudeCacheReadUsage(numericUsage)
    : null;
  if (legacyClaudeUsage) {
    numericUsage.input_tokens = legacyClaudeUsage.input_tokens;
    numericUsage.cached_input_tokens = legacyClaudeUsage.cached_input_tokens;
    numericUsage.output_tokens = legacyClaudeUsage.output_tokens;
    numericUsage.total_tokens = legacyClaudeUsage.total_tokens;
  }
  const quality = sourceQuality !== 'unavailable'
    && (legacyClaudeUsage || usage.consistent === false || sumUsage([numericUsage]).consistent === false)
    ? 'partial' : sourceQuality;
  const observedInput = numericUsage.input_tokens;
  const observedCachedInput = numericUsage.cached_input_tokens;
  const hasObservedComposition = Number.isSafeInteger(observedInput)
    && Number.isSafeInteger(observedCachedInput);
  const observedQuality = quality === 'exact' && numericUsage.cache_write_input_tokens === null
    ? 'partial'
    : quality;
  const usageLayers = quality === 'unavailable' ? undefined : {
    usage_schema_version: 2,
    observed: {
      ...numericUsage,
      uncached_input_tokens: hasObservedComposition
        ? Math.max(0, observedInput - observedCachedInput)
        : null,
      uncached_input_basis: hasObservedComposition && observedCachedInput <= observedInput && quality === 'exact'
        ? 'aggregate_derived'
        : 'receipt_lower_bound',
      quality: observedQuality,
      coverage: 'somestoken_observed',
    },
    calculated: { quality: 'unavailable' },
    coverage: 'somestoken_observed',
    comparison_mode: typeof comparisonMode === 'string'
      ? comparisonMode
      : 'unavailable',
  };
  const normalizedLayers = usageLayers ? normalizeUsageLayers(usageLayers) : undefined;
  return { quality, numericUsage, usageLayers: normalizedLayers };
}

export function stateFromPublicSnapshot(snapshot) {
  snapshot = normalizePublicSnapshot(snapshot);
  if (!snapshot) return null;
  const latestReceipt = snapshot.latest_receipt && typeof snapshot.latest_receipt === 'object'
    ? snapshot.latest_receipt : null;
  // A compact public snapshot can represent an active session before the
  // first receipt exists. It is not evidence of an unavailable turn: creating
  // a placeholder receipt here made public-only reports claim `turns: 1` with
  // null token fields. Preserve the explicit no-receipt state instead.
  const hasReceipt = latestReceipt?.usage !== undefined;
  const latestTelemetry = publicSnapshotTelemetry(latestReceipt?.telemetry_reconciliation)
    ?? { state: 'unavailable', source: 'none', attempts: 0 };
  const sequence = Number.isSafeInteger(snapshot.snapshot_sequence) ? snapshot.snapshot_sequence : 0;
  const turnId = sequence.toString(16).padStart(20, '0').slice(-20);
  const plan = snapshot.plan && typeof snapshot.plan === 'object' ? snapshot.plan : {};
  const publicQuota = plan.measurement_basis === 'host_percent'
    && plan.quota_source === 'codex_app_server'
    && (snapshot.host === 'codex' || snapshot.host === 'unknown')
    ? {
      quota_schema_version: 2,
      quality: plan.quota_quality,
      coverage: 'host_account_window',
      provider: 'codex',
      quota_source: 'codex_app_server',
      quota_scope: plan.quota_scope === 'workspace' ? 'workspace' : 'account',
      measurement_basis: 'host_percent',
      window_type: typeof plan.quota_window === 'string' ? plan.quota_window : 'host_defined',
      ...(typeof plan.used_percent === 'number' ? { used_percent: plan.used_percent } : {}),
      ...(typeof plan.remaining_percent === 'number' ? { remaining_percent: plan.remaining_percent } : {}),
      ...(publicSnapshotIso(plan.resets_at) ? { resets_at: publicSnapshotIso(plan.resets_at) } : {}),
      ...(publicSnapshotIso(snapshot.updated_at) ? { snapshot_at: publicSnapshotIso(snapshot.updated_at) } : {}),
    }
    : null;
  const { quality, numericUsage, usageLayers } = publicUsageProjection(latestReceipt?.usage ?? {}, snapshot.host, plan.comparison_mode);
  const aggregateUsage = publicUsageProjection(snapshot.usage, snapshot.host, plan.comparison_mode);
  const receipt = hasReceipt ? {
    turn_id: turnId,
    ...(latestReceipt.task_binding ? { task_binding: latestReceipt.task_binding } : {}),
    status: quality,
    accounting_status: quality,
    ...numericUsage,
    ...Object.fromEntries(['expected_sources', 'resolved_sources', 'unavailable_sources', 'overflow_sources']
      .filter((key) => Number.isSafeInteger(latestReceipt[key])).map((key) => [key, latestReceipt[key]])),
    telemetry_reconciliation: latestTelemetry,
    // Publication time is not receipt time. A heartbeat can refresh an
    // undated historical receipt without proving when that turn completed.
    created_at: Number.isSafeInteger(latestReceipt?.created_at) && latestReceipt.created_at >= 0
      ? latestReceipt.created_at : null,
    usage_layers: usageLayers,
  } : null;
  const advisorReportSnapshot = advisorFromPublicSnapshot(snapshot, aggregateUsage.quality);
  return {
    hook_version:snapshot.plugin_version,
    receipts: receipt ? [receipt] : [],
    turns: receipt && latestReceipt.sources ? { [turnId]: internalTurn({
      main: { status: latestReceipt.sources.main.quality, usage: latestReceipt.sources.main },
      subagents: latestReceipt.sources.subagents.map((usage) => ({ status: usage.quality, usage })),
    }) } : {},
    public_aggregate: {
      scope: snapshot.aggregate?.scope ?? 'legacy_aggregate',
      receipt_count: snapshot.aggregate?.receipt_count ?? null,
      usage: aggregateUsage.usageLayers?.observed ?? { quality: 'unavailable' },
      quality: aggregateUsage.usageLayers?.observed.quality ?? aggregateUsage.quality,
      counts: snapshot.aggregate,
      latest_available: hasReceipt,
    },
    health: snapshot.health && typeof snapshot.health === 'object' ? snapshot.health : {},
    usage: {
      selected_plan: {
        provider: snapshot.host === 'codex' || snapshot.host === 'claude' ? snapshot.host : 'unknown',
        id: 'unknown',
      },
      snapshots: [], quota_snapshots: publicQuota ? [publicQuota] : [],
    },
    advisor: { sessions: {}, capabilities: { records: {}, host_versions: {} }, acceptance_windows: [], baselines: {}, recommendation_history: [], counters: {} },
    advisor_report: advisorReportSnapshot,
    optimization_report:snapshot.lifecycle_checks||snapshot.output_compaction?{
      status:snapshot.lifecycle_checks?.session_count||snapshot.output_compaction?.groups.length?'partial':'unavailable',
      lifecycle_checks:snapshot.lifecycle_checks,output_compaction:snapshot.output_compaction,
    }:undefined,
    efficiency: { scopes: {}, warnings: [], last_results: {}, counters: {} },
    public_bridge: { snapshot_sequence: sequence, snapshot_state: snapshot.snapshot_state },
    limit_recovery: snapshot.limit_recovery && typeof snapshot.limit_recovery === 'object' ? { ...snapshot.limit_recovery } : undefined,
  };
}
