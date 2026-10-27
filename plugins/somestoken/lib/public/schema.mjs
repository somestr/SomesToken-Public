import { normalizeWorkflowAdvisor, workflowAdvisorAnalytics } from '../workflow-advisor.mjs';
import { isTelemetryOutcome } from '../telemetry-outcomes.mjs';
import { SOMESTOKEN_VERSION } from '../version.mjs';
import { isSensitiveRuntimeValue, normalizeReceiptTaskBinding } from '../core.mjs';
import {sanitizeLifecycleSummary} from '../optimization/lifecycle-checks.mjs';
import {compactOutputCompactionSummary} from '../optimization/output-accounting.mjs';

export const PUBLIC_SCHEMA_VERSION = 8;
export const PUBLIC_HEALTH_KEYS = Object.freeze([
  'token_events_seen', 'malformed_events', 'partial_receipts', 'unavailable_receipts',
  'unresolved_sources', 'usage_snapshots_seen', 'usage_snapshots_rejected',
  'credit_calculations', 'credit_calculation_partial', 'credit_calculation_unavailable',
  'capability_misses', 'missing_required_fields', 'clock_anomalies', 'state_recoveries',
  'efficiency_events_seen', 'efficiency_events_dropped', 'efficiency_warnings',
  'duplicate_events', 'counter_resets', 'retention_drops', 'lock_timeouts',
  'public_snapshots_written', 'public_snapshot_write_failures',
  'public_snapshot_read_failures', 'public_snapshot_schema_mismatches',
  'public_snapshot_recoveries', 'public_snapshots_expired', 'public_sessions_closed',
  'public_sessions_closed_partial', 'public_sessions_closed_with_pending',
  'late_events_after_close', 'bridge_ready_events', 'bridge_stale_events',
  'bridge_permission_errors', 'mcp_public_reads', 'mcp_public_read_failures',
  'statusline_reads', 'statusline_stale_reads', 'statusline_install_attempts',
  'statusline_install_failures', 'evidence_bundles_created', 'evidence_bundle_failures',
  'policy_sessions_eligible', 'policy_sessions_triggered', 'policy_feedback_seen',
  'policy_certifications', 'policy_rejections', 'workflow_recommendations_generated', 'workflow_recommendations_suppressed',
  'limit_recovery_armed', 'limit_recovery_limit_observed', 'limit_recovery_resumed',
  'limit_recovery_canceled', 'limit_recovery_unavailable', 'limit_recovery_protocol_errors',
  'limit_recovery_state_drops',
]);
const LEGACY_PUBLIC_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, PUBLIC_SCHEMA_VERSION]);

export const PUBLIC_SNAPSHOT_STATES = Object.freeze([
  'active', 'closing', 'closed_exact', 'closed_partial',
  'closed_with_pending_sources', 'interrupted', 'expired', 'stale',
  'recovered', 'unavailable',
]);

export const PUBLIC_QUALITY = Object.freeze(['exact', 'partial', 'unavailable']);
export const PUBLIC_BRIDGE_STATUSES = Object.freeze([
  'bridge_ready', 'bridge_stale', 'bridge_unavailable', 'bridge_schema_mismatch',
  'bridge_permission_error', 'bridge_write_failed', 'bridge_read_failed',
  'bridge_artifact_mismatch',
]);

const TELEMETRY_STATES = new Set(['received', 'pending_post_turn', 'unavailable']);
const TELEMETRY_SOURCES = new Set(['transcript', 'structured_hook', 'none']);

const HOSTS = new Set(['codex', 'claude', 'unknown']);
// The public bridge carries protocol identifiers and versions, never display
// text. Keep the final reader boundary at the same strict grammar.
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_HASH = /^[a-f0-9]{64}$/i;
const MAX_REASON_CODES = 8;
const MAX_RECOMMENDATIONS = 3;
const MAX_CURRENT_BYTES = 64 * 1024;
const MAX_CLOSED_SESSIONS = 20;
const MAX_STATUSLINE_BYTES = 256;
const MAX_EVIDENCE_BUNDLES = 5;

const SESSION_KEYS = new Set(['public_ref', 'closure', 'source_count', 'resolved_source_count', 'pending_source_count']);
const TELEMETRY_KEYS = new Set(['state', 'source', 'attempts', 'outcome']);
const RECEIPT_COUNT_KEYS = ['expected_sources', 'resolved_sources', 'unavailable_sources', 'overflow_sources'];
const LATEST_RECEIPT_KEYS = new Set(['status', 'telemetry_reconciliation', 'created_at', 'usage', 'sources', 'task_binding', ...RECEIPT_COUNT_KEYS]);
const AGGREGATE_KEYS = new Set(['scope', 'receipt_count', ...RECEIPT_COUNT_KEYS]);
const USAGE_KEYS = new Set(['quality', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'cache_write_input_tokens', 'consistent']);
const EFFICIENCY_KEYS = new Set(['classification', 'reason_codes']);
const PLAN_KEYS = new Set([
  'comparison_mode', 'quota_quality', 'measurement_basis', 'quota_source', 'quota_scope', 'quota_window',
  'used_percent', 'remaining_percent', 'resets_at',
]);
const CAPABILITY_KEYS = new Set(['observed', 'live_verified', 'unavailable', 'fixture_verified', 'missing_required_fields']);
const BRIDGE_KEYS = new Set(['status', 'source', 'is_stale', 'snapshot_sequence', 'updated_at', 'stale_after']);
const RECOMMENDATION_KEYS = new Set(['recommendation_id', 'status', 'confidence', 'reason_codes', 'potential_savings']);
const RATE_LIMIT_REACHED_TYPES = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);
const HEALTH_KEYS = new Set(PUBLIC_HEALTH_KEYS);

function safeInteger(value, nullable = true) {
  if (value === null && nullable) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value * 1000) / 1000
    : undefined;
}
function safeText(value, fallback = null) {
  if (value === null && fallback === null) return null;
  if (typeof value !== 'string' || !SAFE_TEXT.test(value.trim())) return fallback;
  const text = value.trim();
  if (text.startsWith('/') || text.includes('\\') || text.includes('..') || isSensitiveRuntimeValue(text)) return fallback;
  return text;
}

function safeId(value, fallback = null) {
  if (value === null && fallback === null) return null;
  if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) return fallback;
  const text = value.trim();
  if (text.startsWith('/') || text.includes('\\') || text.includes('..') || isSensitiveRuntimeValue(text)) return fallback;
  return text;
}

function safeHash(value, fallback = null) {
  if (value === null && fallback === null) return null;
  return typeof value === 'string' && SAFE_HASH.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedReasonCodes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REASON_CODES) return null;
  const output = [...new Set(value.filter((entry) => typeof entry === 'string' && /^[a-z0-9_]{1,80}$/.test(entry) && !isSensitiveRuntimeValue(entry)))];
  return output.length === value.length ? output : null;
}

function normalizeSession(value = {}) {
  if (!exactKeys(value, SESSION_KEYS)) return null;
  const closure = typeof value.closure === 'string' && /^[a-z_]{1,48}$/.test(value.closure) && !isSensitiveRuntimeValue(value.closure) ? value.closure : 'open';
  const counts = {};
  for (const key of ['source_count', 'resolved_source_count', 'pending_source_count']) {
    const parsed = safeInteger(value[key]);
    if (parsed === undefined) return null;
    counts[key] = parsed;
  }
  return {
    public_ref: safeId(value.public_ref, null),
    closure,
    ...counts,
  };
}

function normalizeTelemetry(value = {}) {
  if (!exactKeys(value, TELEMETRY_KEYS)) return null;
  const state = TELEMETRY_STATES.has(value.state) ? value.state : null;
  const source = TELEMETRY_SOURCES.has(value.source) ? value.source : null;
  const attempts = safeInteger(value.attempts, false);
  if (!state || !source || attempts === undefined) return null;
  const outcome = value.outcome === undefined
    ? undefined
    : isTelemetryOutcome(value.outcome) ? value.outcome : null;
  if (outcome === null) return null;
  return { state, source, attempts: Math.min(attempts, 100), ...(outcome ? { outcome } : {}) };
}

function normalizeLatestReceipt(value) {
  if (value === undefined || value === null) return null;
  if (!exactKeys(value, LATEST_RECEIPT_KEYS)) return null;
  const status = PUBLIC_QUALITY.includes(value.status) ? value.status : null;
  const telemetry_reconciliation = normalizeTelemetry(value.telemetry_reconciliation);
  if (!status || !telemetry_reconciliation) return null;
  const output = { status, telemetry_reconciliation };
  if (value.task_binding !== undefined) {
    output.task_binding = normalizeReceiptTaskBinding(value.task_binding);
    if (!output.task_binding) return null;
  }
  if (value.usage !== undefined) {
    output.usage = normalizeUsage(value.usage);
    if (!output.usage || output.usage.quality !== status) return null;
    for (const key of RECEIPT_COUNT_KEYS) {
      output[key] = safeInteger(value[key]);
      if (output[key] === undefined) return null;
    }
  }
  if (value.sources !== undefined) {
    if (!exactKeys(value.sources, new Set(['main', 'subagents']))
      || !Array.isArray(value.sources.subagents) || value.sources.subagents.length > 32) return null;
    const main = normalizeUsage(value.sources.main);
    const subagents = value.sources.subagents.map(normalizeUsage);
    if (!main || subagents.some((source) => !source)) return null;
    output.sources = { main, subagents };
  }
  if (value.created_at !== undefined) {
    const createdAt = safeInteger(value.created_at, false);
    if (createdAt === undefined) return null;
    output.created_at = createdAt;
  }
  return output;
}

function normalizeAggregate(value) {
  if (value === undefined || value === null) return null;
  if (!exactKeys(value, AGGREGATE_KEYS) || value.scope !== 'recent_receipts') return null;
  const output = { scope: value.scope };
  for (const key of ['receipt_count', ...RECEIPT_COUNT_KEYS]) {
    output[key] = safeInteger(value[key], false);
    if (output[key] === undefined) return null;
  }
  return output.receipt_count <= 100 ? output : null;
}

function normalizeUsage(value = {}) {
  if (!exactKeys(value, USAGE_KEYS)) return null;
  const quality = PUBLIC_QUALITY.includes(value.quality) ? value.quality : null;
  if (!quality) return null;
  const usage = { quality };
  if (value.consistent !== undefined) {
    if (typeof value.consistent !== 'boolean') return null;
    usage.consistent = value.consistent;
  }
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'cache_write_input_tokens']) {
    // cache-write is an optional observed component in the compact contract.
    // Older snapshots omitted it; preserve those snapshots with an explicit
    // null instead of turning an unknown value into zero.
    if (key === 'cache_write_input_tokens' && value[key] === undefined) {
      usage[key] = null;
      continue;
    }
    const parsed = safeInteger(value[key]);
    if (parsed === undefined) return null;
    usage[key] = parsed;
  }
  return usage;
}

function normalizeEfficiency(value = {}) {
  if (!exactKeys(value, EFFICIENCY_KEYS)) return null;
  const classification = typeof value.classification === 'string' && /^[a-z_]{1,48}$/.test(value.classification) && !isSensitiveRuntimeValue(value.classification) ? value.classification : null;
  const reason_codes = boundedReasonCodes(value.reason_codes);
  if (!classification || reason_codes === null) return null;
  return { classification, reason_codes };
}

function normalizePlan(value = {}) {
  if (!exactKeys(value, PLAN_KEYS)) return null;
  const output = {
    comparison_mode: typeof value.comparison_mode === 'string' && /^[a-z_]{1,48}$/.test(value.comparison_mode) && !isSensitiveRuntimeValue(value.comparison_mode) ? value.comparison_mode : null,
    quota_quality: PUBLIC_QUALITY.includes(value.quota_quality) ? value.quota_quality : null,
  };
  if (!output.comparison_mode || !output.quota_quality) return null;
  if (value.measurement_basis !== undefined) {
    if (!['units', 'host_percent', 'unavailable'].includes(value.measurement_basis)) return null;
    output.measurement_basis = value.measurement_basis;
  }
  for (const key of ['quota_source', 'quota_scope', 'quota_window']) {
    if (value[key] === undefined) continue;
    const parsed = safeText(value[key], null);
    if (parsed === null) return null;
    output[key] = parsed;
  }
  for (const key of ['used_percent', 'remaining_percent']) {
    if (value[key] === undefined) continue;
    const parsed = safePercent(value[key]);
    if (parsed === undefined) return null;
    output[key] = parsed;
  }
  if (value.resets_at !== undefined) {
    const parsed = safeInteger(value.resets_at);
    if (parsed === undefined) return null;
    output.resets_at = parsed;
  }
  return output;
}

function normalizeCapabilities(value = {}) {
  if (!exactKeys(value, CAPABILITY_KEYS)) return null;
  const output = {};
  for (const key of CAPABILITY_KEYS) {
    if (value[key] === undefined) continue;
    const parsed = safeInteger(value[key]);
    if (parsed === undefined) return null;
    output[key] = parsed;
  }
  return output;
}

function normalizeRecommendations(value = []) {
  if (!Array.isArray(value) || value.length > MAX_RECOMMENDATIONS) return null;
  const output = Array.from(value, (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, RECOMMENDATION_KEYS)) return null;
    const recommendation_id = typeof entry.recommendation_id === 'string' && /^[a-z0-9_]{1,80}$/.test(entry.recommendation_id) && !isSensitiveRuntimeValue(entry.recommendation_id) ? entry.recommendation_id : null;
    const status = typeof entry.status === 'string' && /^[a-z_]{1,48}$/.test(entry.status) && !isSensitiveRuntimeValue(entry.status) ? entry.status : null;
    const confidence = typeof entry.confidence === 'string' && /^[a-z_]{1,24}$/.test(entry.confidence) && !isSensitiveRuntimeValue(entry.confidence) ? entry.confidence : null;
    const reason_codes = boundedReasonCodes(entry.reason_codes);
    if (!recommendation_id || !status || !confidence || reason_codes === null || entry.potential_savings !== 'unmeasured') return null;
    return { recommendation_id, status, confidence, reason_codes, potential_savings: 'unmeasured' };
  });
  return output.every(Boolean) ? output : null;
}

function normalizeLimitRecovery(value) {
  if (value === undefined || value === null) {
    return {
      status: 'unavailable', mode: 'disabled', state: 'unavailable', controller: 'none',
      limit: { source: null, scope: null, limit_id: null, rate_limit_reached_type: null, used_percent: null, remaining_percent: null, resets_at: null, window_duration_mins: null },
      recovery: { goal_state: null, thread_state: null, waiting_on_approval: false, resume_attempts: 0, expires_at: null },
      reason_codes: [],
    };
  }
  // Nested host state is sanitized by projection rather than echoed. Unknown
  // fields are intentionally ignored so poisoned objective/path/identifier
  // fields cannot invalidate or cross the public bridge.
  if (!value.limit || typeof value.limit !== 'object' || Array.isArray(value.limit)
    || !value.recovery || typeof value.recovery !== 'object' || Array.isArray(value.recovery)) return null;
  const status = PUBLIC_QUALITY.includes(value.status) ? value.status : null;
  const mode = ['disabled', 'host_native_observe', 'managed_companion'].includes(value.mode) ? value.mode : null;
  const state = typeof value.state === 'string' && /^[a-z_]{1,48}$/.test(value.state) && !isSensitiveRuntimeValue(value.state) ? value.state : null;
  const controller = ['none', 'host', 'somestoken'].includes(value.controller) ? value.controller : null;
  const reasonCodes = boundedReasonCodes(value.reason_codes);
  if (!status || !mode || !state || !controller || reasonCodes === null) return null;
  const safeEnumText = (entry) => typeof entry === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:_-]{0,119}$/.test(entry) && !isSensitiveRuntimeValue(entry) ? entry : undefined;
  const safeNullableText = (entry) => entry === null ? null : safeEnumText(entry);
  const limit = {
      source: value.limit.source === null ? null : safeEnumText(value.limit.source),
      scope: value.limit.scope === null ? null : safeEnumText(value.limit.scope),
      limit_id: value.limit.limit_id === null ? null : safeEnumText(value.limit.limit_id),
      ...(value.limit.rate_limit_reached_type === null || value.limit.rate_limit_reached_type === undefined
        ? { rate_limit_reached_type: null }
        : RATE_LIMIT_REACHED_TYPES.has(value.limit.rate_limit_reached_type)
          ? { rate_limit_reached_type: value.limit.rate_limit_reached_type }
          : { rate_limit_reached_type: undefined }),
      used_percent: value.limit.used_percent === null ? null : (typeof value.limit.used_percent === 'number' && Number.isFinite(value.limit.used_percent) && value.limit.used_percent >= 0 && value.limit.used_percent <= 100 ? value.limit.used_percent : undefined),
    remaining_percent: value.limit.remaining_percent === null ? null : (typeof value.limit.remaining_percent === 'number' && Number.isFinite(value.limit.remaining_percent) && value.limit.remaining_percent >= 0 && value.limit.remaining_percent <= 100 ? value.limit.remaining_percent : undefined),
    resets_at: value.limit.resets_at === null ? null : safeInteger(value.limit.resets_at),
    window_duration_mins: value.limit.window_duration_mins === null ? null : safeInteger(value.limit.window_duration_mins),
  };
  if (Object.values(limit).some((entry) => entry === undefined)) return null;
  const recovery = {
    goal_state: safeNullableText(value.recovery.goal_state),
    thread_state: safeNullableText(value.recovery.thread_state),
    waiting_on_approval: value.recovery.waiting_on_approval === true,
    resume_attempts: safeInteger(value.recovery.resume_attempts, false),
    expires_at: value.recovery.expires_at === null ? null : safeInteger(value.recovery.expires_at),
  };
  if (recovery.resume_attempts === undefined || Object.values(recovery).some((entry) => entry === undefined)) return null;
  return { status, mode, state, controller, limit, recovery: { ...recovery, resume_attempts: Math.min(1, recovery.resume_attempts) }, reason_codes: reasonCodes };
}

function normalizeHealth(value = {}) {
  if (!exactKeys(value, HEALTH_KEYS)) return null;
  const output = {};
  for (const [key, count] of Object.entries(value)) {
    const parsed = safeInteger(count, false);
    if (parsed === undefined) return null;
    output[key] = parsed;
  }
  return output;
}

function normalizeBridge(value = {}) {
  if (!exactKeys(value, BRIDGE_KEYS)) return null;
  const status = PUBLIC_BRIDGE_STATUSES.includes(value.status) ? value.status : null;
  const source = typeof value.source === 'string' && /^[a-z_]{1,48}$/.test(value.source) && !isSensitiveRuntimeValue(value.source) ? value.source : null;
  if (!status || !source) return null;
  const output = { status, source };
  for (const key of ['is_stale']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') return null;
    output[key] = value[key];
  }
  for (const key of ['snapshot_sequence', 'updated_at', 'stale_after']) if (value[key] !== undefined) {
    const parsed = safeInteger(value[key], false);
    if (parsed === undefined) return null;
    output[key] = parsed;
  }
  return output;
}

const TOP_LEVEL_KEYS = new Set([
  'lifecycle_checks', 'output_compaction',
  'public_schema_version', 'plugin_version', 'host', 'host_version', 'artifact_sha256',
  'snapshot_sequence', 'snapshot_state', 'updated_at', 'stale_after', 'session', 'usage',
  'latest_receipt', 'efficiency', 'plan', 'capabilities', 'recommendations', 'workflow_advisor', 'health', 'bridge', 'reason_codes',
  'limit_recovery', 'aggregate',
]);

function normalizedWorkflow(value) {
  return normalizeWorkflowAdvisor(value) ?? workflowAdvisorAnalytics({ receipts: [] });
}

export function createPublicSnapshot(input = {}) {
  const host = HOSTS.has(input.host) ? input.host : 'unknown';
  const sequence = safeInteger(input.snapshot_sequence, false) ?? 0;
  const updated = safeInteger(input.updated_at, false) ?? Date.now();
  const snapshot = {
    public_schema_version: PUBLIC_SCHEMA_VERSION,
    plugin_version: safeText(input.plugin_version, SOMESTOKEN_VERSION),
    host,
    host_version: safeText(input.host_version, 'unknown'),
    artifact_sha256: safeHash(input.artifact_sha256),
    snapshot_sequence: sequence,
    snapshot_state: PUBLIC_SNAPSHOT_STATES.includes(input.snapshot_state) ? input.snapshot_state : 'unavailable',
    updated_at: updated,
    stale_after: safeInteger(input.stale_after, false) ?? updated + (10 * 60 * 1000),
    session: normalizeSession(input.session ?? { public_ref: `${host}-${sequence.toString(36)}`, closure: 'open', source_count: 0, resolved_source_count: 0, pending_source_count: 0 }),
    usage: normalizeUsage(input.usage ?? { quality: 'unavailable', input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, total_tokens: null }),
    latest_receipt: normalizeLatestReceipt(input.latest_receipt),
    aggregate: normalizeAggregate(input.aggregate),
    efficiency: normalizeEfficiency(input.efficiency ?? { classification: 'insufficient_evidence', reason_codes: [] }),
    plan: normalizePlan(input.plan ?? { comparison_mode: 'unavailable', quota_quality: 'unavailable' }),
    capabilities: normalizeCapabilities(input.capabilities ?? {}),
    recommendations: normalizeRecommendations(input.recommendations ?? []),
    workflow_advisor: normalizedWorkflow(input.workflow_advisor),
    health: normalizeHealth(input.health ?? {}),
    bridge: normalizeBridge(input.bridge ?? { status: 'bridge_unavailable', source: 'unavailable' }),
    reason_codes: boundedReasonCodes(input.reason_codes ?? []),
    limit_recovery: normalizeLimitRecovery(input.limit_recovery),
    lifecycle_checks:sanitizeLifecycleSummary(input.lifecycle_checks),
    output_compaction:compactOutputCompactionSummary(input.output_compaction),
  };
  return normalizePublicSnapshot(snapshot) ?? {
    public_schema_version: PUBLIC_SCHEMA_VERSION,
    plugin_version: SOMESTOKEN_VERSION,
    host: 'unknown',
    host_version: 'unknown',
    artifact_sha256: null,
    snapshot_sequence: 0,
    snapshot_state: 'unavailable',
    updated_at: updated,
    stale_after: updated,
    session: { public_ref: 'unknown-0', closure: 'unavailable', source_count: 0, resolved_source_count: 0, pending_source_count: 0 },
    usage: { quality: 'unavailable', input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, total_tokens: null },
    latest_receipt: null,
    aggregate: null,
    efficiency: { classification: 'insufficient_evidence', reason_codes: [] },
    plan: { comparison_mode: 'unavailable', quota_quality: 'unavailable' },
    capabilities: {},
    recommendations: [],
    workflow_advisor: workflowAdvisorAnalytics({ receipts: [] }),
    health: {},
    bridge: { status: 'bridge_unavailable', source: 'unavailable' },
    reason_codes: [],
    limit_recovery: normalizeLimitRecovery(null),
  };
}

export function normalizePublicSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, TOP_LEVEL_KEYS)) return null;
  if (!LEGACY_PUBLIC_SCHEMA_VERSIONS.has(value.public_schema_version)) return null;
  if (!HOSTS.has(value.host) || !PUBLIC_SNAPSHOT_STATES.includes(value.snapshot_state)) return null;
  if (typeof value.plugin_version !== 'string' || !SAFE_TEXT.test(value.plugin_version) || isSensitiveRuntimeValue(value.plugin_version)) return null;
  if (typeof value.host_version !== 'string' || !SAFE_TEXT.test(value.host_version) || isSensitiveRuntimeValue(value.host_version)) return null;
  if (value.artifact_sha256 !== null && (typeof value.artifact_sha256 !== 'string' || !SAFE_HASH.test(value.artifact_sha256))) return null;
  for (const key of ['snapshot_sequence', 'updated_at', 'stale_after']) if (safeInteger(value[key], false) === undefined) return null;
  const session = normalizeSession(value.session);
  const usage = normalizeUsage(value.usage);
  const latestReceipt = normalizeLatestReceipt(value.latest_receipt);
  const aggregate = normalizeAggregate(value.aggregate);
  if (value.aggregate !== undefined && value.aggregate !== null && aggregate === null) return null;
  if (value.latest_receipt !== undefined && value.latest_receipt !== null && latestReceipt === null) return null;
  const efficiency = normalizeEfficiency(value.efficiency);
  const plan = normalizePlan(value.plan);
  const capabilities = normalizeCapabilities(value.capabilities);
  const recommendations = normalizeRecommendations(value.recommendations);
  const workflowAdvisor = normalizedWorkflow(value.workflow_advisor);
  const health = normalizeHealth(value.health);
  const bridge = normalizeBridge(value.bridge);
  const reason_codes = boundedReasonCodes(value.reason_codes);
  const limitRecovery = normalizeLimitRecovery(value.limit_recovery);
  if (!session || !usage || !efficiency || !plan || !capabilities || !recommendations || !workflowAdvisor || !health || !bridge || reason_codes === null || !limitRecovery) return null;
  return {
    public_schema_version: PUBLIC_SCHEMA_VERSION,
    plugin_version: value.plugin_version,
    host: value.host,
    host_version: value.host_version,
    artifact_sha256: value.artifact_sha256,
    snapshot_sequence: value.snapshot_sequence,
    snapshot_state: value.snapshot_state,
    updated_at: value.updated_at,
    stale_after: value.stale_after,
    session,
    usage,
    latest_receipt: latestReceipt,
    aggregate,
    efficiency,
    plan,
    capabilities,
    recommendations,
    workflow_advisor: workflowAdvisor,
    health,
    bridge,
    reason_codes,
    limit_recovery: limitRecovery,
    lifecycle_checks:sanitizeLifecycleSummary(value.lifecycle_checks),
    output_compaction:compactOutputCompactionSummary(value.output_compaction),
  };
}

function normalizedSnapshotStatus(snapshot, now) {
  if (snapshot.snapshot_state !== 'active') return snapshot.snapshot_state;
  return now > snapshot.stale_after ? 'stale' : snapshot.snapshot_state;
}

export function publicSnapshotStatus(value, now = Date.now()) {
  const snapshot = normalizePublicSnapshot(value);
  return snapshot ? normalizedSnapshotStatus(snapshot, now) : 'unavailable';
}

export function validatePublicSnapshot(value, now = Date.now()) {
  const snapshot = normalizePublicSnapshot(value);
  if (!snapshot) return { valid: false, status: 'unavailable', errors: ['invalid_public_snapshot'], snapshot: null };
  return { valid: true, status: normalizedSnapshotStatus(snapshot, now), errors: [], snapshot };
}

export function publicSnapshotBounds() {
  return {
    max_current_bytes: MAX_CURRENT_BYTES,
    max_closed_sessions: MAX_CLOSED_SESSIONS,
    max_recommendations: MAX_RECOMMENDATIONS,
    max_reason_codes: MAX_REASON_CODES,
    max_statusline_bytes: MAX_STATUSLINE_BYTES,
    max_evidence_bundles: MAX_EVIDENCE_BUNDLES,
  };
}
