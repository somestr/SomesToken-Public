import {
  healthSummary,
  publicAdvisorReport,
  advisorReport,
  efficiencyAnalytics,
  planAwareUsage,
  publicReceipt,
  publicTurnBreakdown,
  summarizeReceipts,
  limitRecoveryAnalytics,
} from '../reporting.mjs';
import { SOMESTOKEN_VERSION } from '../version.mjs';
import { createReceiptTaskBinding } from '../core.mjs';
import { createPublicSnapshot, PUBLIC_HEALTH_KEYS } from './schema.mjs';
import {lifecycleSummary} from '../optimization/lifecycle-checks.mjs';
import {outputCompactionSummary} from '../optimization/output-accounting.mjs';

const SAFE_HASH = /^[a-f0-9]{64}$/i;
const PUBLIC_HEALTH_KEY_SET = new Set(PUBLIC_HEALTH_KEYS);

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compactUsage(usage, quality) {
  return Object.fromEntries([
    ['quality', quality],
    ...(typeof usage?.consistent === 'boolean' ? [['consistent', usage.consistent]] : []),
    ...['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'cache_write_input_tokens']
      .map((key) => [key, quality === 'unavailable' ? null : safeInteger(usage?.[key])]),
  ]);
}

function safePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value * 1000) / 1000
    : null;
}

function safeEpochSeconds(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value > 1e12 ? Math.floor(value / 1000) : value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed / 1000) : null;
}

function latestSession(advisor) {
  const sessions = Array.isArray(advisor?.sessions) ? advisor.sessions : [];
  return sessions.at(-1) ?? null;
}

function sessionCounts(receipts, session) {
  const selected = session?.session_id
    ? receipts.filter((entry) => entry?.session === session.session_id)
    : receipts.slice(-100);
  const expected = selected.reduce((sum, entry) => sum + (safeInteger(entry?.expected_sources) ?? 1), 0);
  const resolved = selected.reduce((sum, entry) => sum + (safeInteger(entry?.resolved_sources) ?? 0), 0);
  const pending = selected.reduce((sum, entry) => sum + (safeInteger(entry?.unavailable_sources) ?? 0), 0);
  return { source_count: expected, resolved_source_count: resolved, pending_source_count: pending };
}

function snapshotState(session, usage) {
  const closure = session?.closure_state;
  if (closure && (/^closed_/.test(closure) || closure === 'expired')) return closure;
  if (usage?.status === 'unavailable') return 'unavailable';
  return 'active';
}

function safeArtifactHash(env) {
  const value = env?.SOMESTOKEN_ARTIFACT_SHA256;
  return typeof value === 'string' && SAFE_HASH.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** Build the compact public contract from already-sanitized report functions. */
export function buildPublicSnapshot(state, env = {}, options = {}) {
  const receipts = Array.isArray(state?.receipts) ? state.receipts : [];
  const selected = receipts.slice(-Math.min(100, Math.max(1, options.last ?? 100)));
  const usage = planAwareUsage(state, selected, { last: selected.length || 1 });
  const allSelectedUnavailable = selected.length > 0 && selected.every((entry) => entry?.status === 'unavailable');
  const advisor = publicAdvisorReport(advisorReport(state, selected, { last: selected.length || 1 }));
  const efficiency = efficiencyAnalytics(state, selected, { last: selected.length || 1 });
  const health = healthSummary(state?.health ?? null);
  const session = latestSession(advisor);
  const counts = sessionCounts(selected, session);
  const sequence = safeInteger(options.snapshot_sequence) ?? safeInteger(state?.public_bridge?.snapshot_sequence) ?? 0;
  const updatedAt = safeInteger(options.updated_at) ?? Date.now();
  const closure = session?.closure_state ?? 'open';
  const runtimeHost = env?.SOMESTOKEN_RUNTIME === 'codex' || env?.SOMESTOKEN_RUNTIME === 'claude'
    ? env.SOMESTOKEN_RUNTIME
    : 'unknown';
  const host = runtimeHost !== 'unknown'
    ? runtimeHost
    : usage.host === 'codex' || usage.host === 'claude' ? usage.host : advisor.host === 'codex' || advisor.host === 'claude' ? advisor.host : 'unknown';
  const observed = usage.observed_tokens ?? {};
  const selectedPlan = usage.selected_plan?.id ?? 'unknown';
  const planQuality = usage.quota_quality ?? 'unavailable';
  const capabilities = advisor.capabilities ?? {};
  const recommendations = (advisor.recommendations ?? []).slice(0, 3).map((entry) => ({
    recommendation_id: entry.id,
    status: entry.status,
    confidence: entry.confidence,
    reason_codes: entry.reason_codes ?? [],
    potential_savings: 'unmeasured',
  }));
  const limitRecovery = limitRecoveryAnalytics(state);
  const latestReceipt = selected.at(-1) ? publicReceipt(selected.at(-1)) : null;
  const taskBinding = createReceiptTaskBinding(selected.at(-1)?.session);
  const latestTelemetry = latestReceipt?.telemetry_reconciliation;
  const summary = summarizeReceipts(selected, { last: selected.length || 1 });
  const breakdown = latestReceipt ? publicTurnBreakdown(state, selected.at(-1)) : null;
  const snapshot = createPublicSnapshot({
    plugin_version: options.plugin_version ?? env.SOMESTOKEN_VERSION ?? SOMESTOKEN_VERSION,
    host,
    host_version: usage.host_version ?? advisor.host_version ?? 'unknown',
    artifact_sha256: safeArtifactHash(env),
    snapshot_sequence: sequence,
    snapshot_state: snapshotState(session, usage),
    updated_at: updatedAt,
    stale_after: updatedAt + (10 * 60 * 1000),
    session: {
      public_ref: session?.session_id ?? `${host}-${sequence.toString(36)}`,
      closure: closure === 'open' || closure === 'interrupted' || closure === 'recovered' ? 'open' : closure,
      ...counts,
    },
    usage: {
      quality: allSelectedUnavailable ? 'unavailable' : usage.token_quality ?? 'unavailable',
      input_tokens: safeInteger(observed.input_tokens),
      cached_input_tokens: safeInteger(observed.cached_input_tokens),
      output_tokens: safeInteger(observed.output_tokens),
      reasoning_output_tokens: safeInteger(observed.reasoning_output_tokens),
      total_tokens: safeInteger(observed.total_tokens),
      cache_write_input_tokens: safeInteger(observed.cache_write_input_tokens),
    },
    latest_receipt: latestReceipt ? {
      ...(taskBinding ? { task_binding: taskBinding } : {}),
      status: latestReceipt.status ?? 'unavailable',
      usage: compactUsage(latestReceipt, latestReceipt.status ?? 'unavailable'),
      ...Object.fromEntries(['expected_sources', 'resolved_sources', 'unavailable_sources', 'overflow_sources']
        .map((key) => [key, safeInteger(latestReceipt[key])])),
      sources: {
        main: compactUsage(breakdown.main.usage, breakdown.main.status),
        subagents: breakdown.subagents.map((source) => compactUsage(source.usage, source.status)),
      },
      telemetry_reconciliation: latestTelemetry ?? { state: 'unavailable', source: 'none', attempts: 0 },
      ...(safeInteger(latestReceipt.created_at) !== null ? { created_at: latestReceipt.created_at } : {}),
    } : null,
    aggregate: {
      scope: 'recent_receipts', receipt_count: selected.length,
      ...Object.fromEntries(['expected_sources', 'resolved_sources', 'unavailable_sources', 'overflow_sources'].map((key) => [key, summary[key]])),
    },
    efficiency: {
      classification: efficiency.classification ?? 'insufficient_evidence',
      reason_codes: efficiency.reason_codes ?? [],
    },
    plan: {
      comparison_mode: usage.comparison_mode ?? 'unavailable',
      quota_quality: planQuality,
      ...(usage.measurement_basis && usage.measurement_basis !== 'unavailable' ? { measurement_basis: usage.measurement_basis } : {}),
      ...(typeof usage.quota_source === 'string' && usage.quota_source !== 'unavailable' ? { quota_source: usage.quota_source } : {}),
      ...(typeof usage.quota_scope === 'string' && usage.quota_scope !== 'unavailable' ? { quota_scope: usage.quota_scope } : {}),
      ...(typeof usage.quota_window === 'string' && usage.quota_window !== 'unavailable' ? { quota_window: usage.quota_window } : {}),
      ...(safePercent(usage.used_percent) !== null ? { used_percent: safePercent(usage.used_percent) } : {}),
      ...(safePercent(usage.remaining_percent) !== null ? { remaining_percent: safePercent(usage.remaining_percent) } : {}),
      ...(safeEpochSeconds(usage.resets_at) !== null ? { resets_at: safeEpochSeconds(usage.resets_at) } : {}),
    },
    capabilities: {
      observed: capabilities.observed_count ?? 0,
      live_verified: capabilities.live_verified_count ?? 0,
      fixture_verified: capabilities.fixture_verified_count ?? 0,
      unavailable: Math.max(0, (capabilities.documented_count ?? 0) - (capabilities.observed_count ?? 0)),
    },
    recommendations,
    workflow_advisor: advisor.workflow_advisor,
    health: Object.fromEntries(Object.entries(health).filter(([key]) => PUBLIC_HEALTH_KEY_SET.has(key) && Number.isSafeInteger(health[key]))),
    bridge: {
      status: 'bridge_ready',
      source: 'plugin_data',
      is_stale: false,
      snapshot_sequence: sequence,
      updated_at: updatedAt,
      stale_after: updatedAt + (10 * 60 * 1000),
    },
    reason_codes: [...new Set([...(efficiency.reason_codes ?? []), ...(usage.reason_codes ?? [])])].slice(0, 8),
    limit_recovery: limitRecovery,
    lifecycle_checks:lifecycleSummary(state?.optimization?.lifecycle_checks,updatedAt),
    output_compaction:outputCompactionSummary(state?.optimization?.output_compaction),
  });
  // Never expose the selected plan or report internals in the compact schema.
  void selectedPlan;
  return snapshot;
}
