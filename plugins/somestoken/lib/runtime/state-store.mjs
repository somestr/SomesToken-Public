import { unlinkOwnedFile } from '../host-paths.mjs';
// Persisted runtime state: bounds, blank shapes, recovery from disk and
// load/save. Moved from lib/runtime.mjs unchanged; runtime.mjs re-exports
// recoverState so its interface stays the same.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, isValidUsage, hashId, PONYTAIL_UNKNOWN_REASON, METADATA_CONFIDENCE, METADATA_SOURCES, METADATA_STATUSES, safeModel, isSensitiveRuntimeValue, sanitizeMetadata, USAGE_KEYS } from '../core.mjs';
import { HEALTH_KEYS } from '../reporting.mjs';
import { normalizeSavings } from '../savings.mjs';
import { recoverLegacyClaudeCacheReadUsage } from '../hosts/claude-code.mjs';
import { COMPARISON_SCHEMA_VERSION } from '../usage/comparison.mjs';
import { getPlanProfile } from '../usage/plans.mjs';
import { normalizeUsageLayers, USAGE_CORE_SCHEMA_VERSION, COVERAGE } from '../usage/schema.mjs';
import { recoverSomesTokenConfig } from '../usage/config.mjs';
import { normalizeQuotaSnapshot } from '../usage/quota-snapshots.mjs';
import { ERROR_CATEGORIES, normalizeEfficiencyEvent, normalizeEfficiencyResult } from '../efficiency/schema.mjs';
import { createAdvisorState, recoverAdvisorState, trimAdvisorState } from '../efficiency/sessions.mjs';
import { createOptimizationState, recoverOptimizationState, trimOptimizationState } from '../optimization/schema.mjs';
import { normalizeWorkflowContext } from '../workflow-advisor.mjs';
import { isTelemetryOutcome } from '../telemetry-outcomes.mjs';
import { createLimitRecoveryState, recoverLimitRecoveryState, trimLimitRecoveryState } from '../limit-recovery/state.mjs';
import { MAX_THREADS, MAX_HEALTH_COUNTER, timestamp, stateFile } from './hot-path.mjs';

export const MAX_STATE_BYTES = 4 * 1024 * 1024;

export const MAX_STATE_RETAINED_BYTES = 1024 * 1024;

export const MAX_STATE_STRING_BYTES = 4096;

export const MAX_STATE_KEY_BYTES = 256;

export const MAX_STATE_DEPTH = 10;

export const MAX_STATE_ENTRIES = 512;

const MAX_STATE_NODES = 100_000;

export const MAX_TURNS = 100;

export const MAX_AGENTS_PER_TURN = 32;

// A final Claude MessageDisplay normally precedes Stop. Keep only a short,
// bounded numeric snapshot so a later Stop can use it when the host has not
// flushed the transcript yet. This is not a transcript cache and never holds
// message text, paths, or a display identifier.
const MAX_CLAUDE_FINAL_SNAPSHOTS = MAX_TURNS;

export const CLAUDE_FINAL_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
// Claude counters count each response once (beta 122). The per-line
// 'claude_full_v1' counters of earlier releases are rebased, never subtracted.
export const CLAUDE_ACCOUNTING_BASIS = 'claude_response_v1';

const USAGE_STATE_SCHEMA_VERSION = 1;

const EFFICIENCY_STATE_SCHEMA_VERSION = 1;

export const MAX_USAGE_SNAPSHOTS = 100;

export const MAX_QUOTA_SNAPSHOTS = 32;

export const MAX_SESSION_TOTALS = 128;

export const MAX_EFFICIENCY_SCOPES = 128;

export const MAX_EFFICIENCY_EVENTS = 64;

export const MAX_EFFICIENCY_WARNINGS = 100;

export const RECOVERED_STATE = Symbol('somestoken-state-recovered');

const SAFE_REASONS = new Set(['transcript-unavailable', 'unsupported-transcript', 'counter-reset', 'bounded-tail-without-baseline', 'identity-rebaseline', 'inconsistent-total', 'source-mismatch', 'stop_failure']);

const TELEMETRY_STATES = new Set(['received', 'pending_post_turn', 'unavailable']);

export const TELEMETRY_SOURCES = new Set(['transcript', 'structured_hook', 'none']);

export const SUBAGENT_USAGE_SOURCES = new Set(['transcript']);

const OPTIONAL_USAGE_KEYS = new Set(['cache_write_input_tokens']);

const QUOTA_PROVIDERS = new Set(['codex', 'claude']);

const QUOTA_WINDOW_TYPES = new Set(['turn', 'session', 'rolling_5h', 'daily', 'weekly', 'billing_cycle', 'host_defined']);

const QUOTA_SOURCES = new Set(['host', 'manual', 'shared_pool_partial', 'shared_pool_unknown', 'unknown']);

const QUOTA_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

const QUOTA_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function persistedQuotaText(key, value) {
  if (typeof value !== 'string') return undefined;
  if (key === 'provider') return QUOTA_PROVIDERS.has(value) ? value : undefined;
  if (key === 'window_type') return QUOTA_WINDOW_TYPES.has(value) ? value : undefined;
  if (key === 'quota_source') return QUOTA_SOURCES.has(value) ? value : undefined;
  if (key === 'unit') return QUOTA_IDENTIFIER.test(value) ? value : undefined;
  return QUOTA_TIMESTAMP.test(value) ? value : undefined;
}

function blankHealth() {
  return Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0]));
}

function persistedHealth(value) {
  const health = blankHealth();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return health;
  for (const key of HEALTH_KEYS) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) health[key] = Math.min(value[key], MAX_HEALTH_COUNTER);
  }
  return health;
}

export function incrementHealth(state, key, amount = 1) {
  if (!state || !HEALTH_KEYS.includes(key) || !Number.isSafeInteger(amount) || amount <= 0) return;
  state.health ??= blankHealth();
  state.health[key] = Math.min(MAX_HEALTH_COUNTER, state.health[key] + amount);
}

export function blankState() {
  return {
    schema_version: SCHEMA_VERSION,
    threads: {},
    scopes: {},
    agent_scopes: {},
    turns: {},
    receipts: [],
    claude_final_snapshots: {},
    usage: blankUsageState(),
    efficiency: blankEfficiencyState(),
    limit_recovery: createLimitRecoveryState(),
    optimization: createOptimizationState(),
    hot_events: { last_drained_epoch: 0 },
    identity_rebaseline: { pending_sessions: {}, fallback_pending: false },
    public_bridge: { snapshot_sequence: 0, last_published_at: 0, last_attempted_at: 0 },
    advisor: createAdvisorState(),
    health: blankHealth(),
    updated_at: Date.now(),
  };
}

export function blankUsageState() {
  return {
    schema_version: USAGE_STATE_SCHEMA_VERSION,
    snapshots: [],
    quota_snapshots: [],
    comparisons: [],
    selected_plan: { provider: 'unknown', id: 'unknown' },
    config: null,
    alerts_seen: {},
    session_totals: {},
    counters: {},
  };
}

export function blankEfficiencyState() {
  return {
    schema_version: EFFICIENCY_STATE_SCHEMA_VERSION,
    scopes: {},
    warnings: [],
    last_results: {},
    counters: {},
  };
}

export function persistedHotEventState(value) {
  return {
    last_drained_epoch: Number.isSafeInteger(value?.last_drained_epoch)
      && value.last_drained_epoch >= 0
      ? Math.min(value.last_drained_epoch, MAX_HEALTH_COUNTER)
      : 0,
  };
}

export function blankIdentityRebaseline() {
  return { pending_sessions: {}, fallback_pending: false };
}

function boundedIdentityRebaseline(value) {
  const output = blankIdentityRebaseline();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  output.fallback_pending = value.fallback_pending === true;
  const entries = Object.entries(value.pending_sessions ?? {}).filter(([key, entry]) => (
    /^[a-f0-9]{20}$/.test(key) && entry && typeof entry === 'object' && !Array.isArray(entry)
  )).slice(-MAX_THREADS);
  for (const [session, entry] of entries) {
    const sources = Object.fromEntries(Object.entries(entry.sources ?? {})
      .filter(([source, ready]) => /^[a-f0-9]{20}$/.test(source) && ready === true)
      .slice(-MAX_THREADS));
    output.pending_sessions[session] = { sources };
  }
  return output;
}

function migrationRebaselineFromAdvisor(advisor) {
  const output = blankIdentityRebaseline();
  const pending = Object.entries(advisor?.sessions ?? {}).filter(([session, entry]) => (
    /^[a-f0-9]{20}$/.test(session)
    && entry && typeof entry === 'object'
    && (entry.closed_at === null || entry.closed_at === undefined)
  )).slice(-MAX_THREADS);
  for (const [session] of pending) output.pending_sessions[session] = { sources: {} };
  output.fallback_pending = pending.length === 0;
  return output;
}

function recoveredBlankState() {
  const state = blankState();
  if (state.advisor?.capabilities?.records) state.advisor.capabilities.records = {};
  Object.defineProperty(state, RECOVERED_STATE, { value: true, enumerable: false, configurable: true });
  return state;
}

function mapOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedEntries(value, limit) {
  const map = mapOrEmpty(value);
  const entries = [];
  let count = 0;
  for (const key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    if (count >= limit) break;
    entries.push([key, map[key]]);
    count += 1;
  }
  return entries;
}

function stateWithinBounds(value) {
  const stack = [{ value, depth: 0 }];
  let retainedBytes = 0;
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    const entry = current.value;
    if (current.depth > MAX_STATE_DEPTH || nodes >= MAX_STATE_NODES) return false;
    nodes += 1;
    if (typeof entry === 'string') {
      const bytes = Buffer.byteLength(entry, 'utf8');
      if (bytes > MAX_STATE_STRING_BYTES || retainedBytes + bytes > MAX_STATE_RETAINED_BYTES) return false;
      retainedBytes += bytes;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry)) {
      if (entry.length > MAX_STATE_ENTRIES) return false;
      for (let index = 0; index < entry.length; index += 1) stack.push({ value: entry[index], depth: current.depth + 1 });
      continue;
    }
    const keys = Object.keys(entry);
    if (keys.length > MAX_STATE_ENTRIES) return false;
    for (const key of keys) {
      const keyBytes = Buffer.byteLength(key, 'utf8');
      if (keyBytes > MAX_STATE_KEY_BYTES || retainedBytes + keyBytes > MAX_STATE_RETAINED_BYTES) return false;
      retainedBytes += keyBytes;
      stack.push({ value: entry[key], depth: current.depth + 1 });
    }
  }
  return true;
}

export function persistedUsage(value, runtime = 'unknown') {
  if (!value || typeof value !== 'object') return null;
  const migrated = runtime === 'claude' ? recoverLegacyClaudeCacheReadUsage(value) : null;
  const source = migrated ? { ...value, ...migrated } : value;
  const usage = {};
  for (const key of USAGE_KEYS) {
    if (OPTIONAL_USAGE_KEYS.has(key) && (source[key] === undefined || source[key] === null)) {
      usage[key] = null;
      continue;
    }
    if (!Number.isSafeInteger(source[key]) || source[key] < 0) return null;
    usage[key] = source[key];
  }
  if (!isValidUsage({ ...usage, consistent: true }, { reasoningObserved: runtime !== 'claude' })) usage.consistent = false;
  else if (typeof source.consistent === 'boolean') usage.consistent = source.consistent;
  return usage;
}

function boundedClaudeFinalSnapshots(value, now = timestamp()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidates = [];
  for (const [turnId, entry] of boundedEntries(value, MAX_CLAUDE_FINAL_SNAPSHOTS)) {
    if (!/^[a-f0-9]{20}$/.test(turnId) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const session = typeof entry.session === 'string' && /^[a-f0-9]{20}$/.test(entry.session) ? entry.session : null;
    const sourceId = typeof entry.source_id === 'string' && /^[a-f0-9]{20}$/.test(entry.source_id) ? entry.source_id : null;
    const usage = persistedUsage(entry.usage, 'claude');
    const stagedAt = Number.isSafeInteger(entry.staged_at) && entry.staged_at >= 0 ? entry.staged_at : null;
    if (!session || !sourceId || !usage || stagedAt === null) continue;
    // A clock rollback must not erase a valid in-flight host event. Expiry is
    // only applied when the local clock has advanced past the bounded TTL.
    if (now >= stagedAt && now - stagedAt > CLAUDE_FINAL_SNAPSHOT_TTL_MS) continue;
    candidates.push([turnId, {
      session,
      source_id: sourceId,
      session_generation: persistedGeneration(entry.session_generation),
      ...(typeof entry.lifecycle_turn_id === 'string' && /^[a-f0-9]{20}$/.test(entry.lifecycle_turn_id)
        ? { lifecycle_turn_id: entry.lifecycle_turn_id } : {}),
      usage: tokenFields(usage),
      ...(entry.accounting_basis === CLAUDE_ACCOUNTING_BASIS ? { accounting_basis: entry.accounting_basis } : {}),
      compaction_count: Number.isSafeInteger(entry.compaction_count) && entry.compaction_count >= 0
        ? Math.min(entry.compaction_count, MAX_HEALTH_COUNTER) : 0,
      staged_at: stagedAt,
    }]);
  }
  return Object.fromEntries(candidates
    .sort((a, b) => b[1].staged_at - a[1].staged_at)
    .slice(0, MAX_CLAUDE_FINAL_SNAPSHOTS));
}

function persistedUsageLayers(value, runtime = 'unknown') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const migrated = runtime === 'claude' && value.observed && typeof value.observed === 'object' && !Array.isArray(value.observed)
    ? recoverLegacyClaudeCacheReadUsage(value.observed)
    : null;
  const source = migrated ? { ...value, observed: { ...value.observed, ...migrated } } : value;
  const normalized = normalizeUsageLayers(source);
  return normalized && normalized.usage_schema_version === USAGE_CORE_SCHEMA_VERSION ? normalized : undefined;
}

function legacyClaudeCacheReadTuple(value, runtime) {
  return runtime === 'claude' && Boolean(recoverLegacyClaudeCacheReadUsage(value));
}

function recoveredReceiptStatus(value, status, usage, runtime) {
  if (status === 'unavailable') return status;
  // A legacy Claude tuple proves the arithmetic but not the old field
  // semantics. Preserve the canonical counters while keeping its quality
  // partial rather than silently reclassifying it as exact.
  if (legacyClaudeCacheReadTuple(value, runtime) || usage?.consistent === false) return 'partial';
  return status;
}

function recoveredReceiptUsageLayers(value, usage, status, runtime) {
  const existing = persistedUsageLayers(value?.usage_layers, runtime);
  if (existing || !usage || status === 'unavailable' || !legacyClaudeCacheReadTuple(value, runtime)) return existing;
  // Old Claude receipts predate four-layer usage state. This is a bounded,
  // local observed-token migration only: no billing, quota, or cache
  // efficiency claim is reconstructed from the legacy record.
  return normalizeUsageLayers({
    observed: { ...tokenFields(usage), quality: 'partial', coverage: 'somestoken_observed' },
    calculated: { quality: 'unavailable', calculation_quality: 'unavailable' },
    coverage: 'somestoken_observed',
    comparison_mode: 'relative_only',
  });
}

function persistedEfficiency(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return normalizeEfficiencyResult(value);
}

function boundedCounterMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, amount] of Object.entries(value).slice(0, 64)) {
    if (/^[a-z0-9_]{1,80}$/.test(key) && !isSensitiveRuntimeValue(key) && Number.isSafeInteger(amount) && amount >= 0) output[key] = Math.min(MAX_HEALTH_COUNTER, amount);
  }
  return output;
}

export function boundedAlertMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, amount] of Object.entries(value).slice(-256)) {
    if (/^[A-Za-z0-9._:-]{1,160}$/.test(key) && !isSensitiveRuntimeValue(key) && Number.isSafeInteger(amount) && amount >= 0) output[key] = 1;
  }
  return output;
}

function recoverUsageState(value, runtime = 'unknown', options = {}) {
  const output = blankUsageState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  if (value.selected_plan && typeof value.selected_plan === 'object') {
    const provider = value.selected_plan.provider === 'codex' || value.selected_plan.provider === 'claude' ? value.selected_plan.provider : 'unknown';
    const id = typeof value.selected_plan.id === 'string' && /^[a-z0-9_]{1,80}$/.test(value.selected_plan.id) && !isSensitiveRuntimeValue(value.selected_plan.id) ? value.selected_plan.id : 'unknown';
    output.selected_plan = { provider, id };
  }
  // A null config means that the host has not supplied configuration. Do not
  // normalize it into the default config and overwrite an explicitly
  // recovered selected plan; only validate an actual configuration object.
  const configured = value.config && typeof value.config === 'object' && !Array.isArray(value.config)
    ? recoverSomesTokenConfig(value.config)
    : { ok: false };
  if (configured.ok) {
    output.config = configured.config;
    // A report reader without a declared host must preserve the already
    // host-scoped persisted selection. It cannot safely adopt a configured
    // Codex/Claude plan just because that config object is present.
    if ((runtime === 'codex' || runtime === 'claude') && configured.config.plan.provider === runtime) {
      output.selected_plan = { provider: configured.config.plan.provider, id: configured.config.plan.id };
    }
  }
  for (const entry of Array.isArray(value.snapshots) ? value.snapshots.slice(-MAX_USAGE_SNAPSHOTS) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const layers = persistedUsageLayers(entry.layers ?? entry.usage_layers, entry.host === 'claude' ? 'claude' : runtime);
    if (!layers) continue;
    output.snapshots.push({
      host: entry.host === 'codex' || entry.host === 'claude' ? entry.host : 'unknown',
      layers,
      window_type: ['turn', 'session', 'rolling_5h', 'daily', 'weekly', 'billing_cycle', 'host_defined'].includes(entry.window_type) ? entry.window_type : 'turn',
      source: typeof entry.source === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(entry.source) && !isSensitiveRuntimeValue(entry.source) ? entry.source : 'somestoken',
      ...(!options.dropTurnIds && typeof entry.turn_id === 'string' && /^[a-f0-9]{20}$/.test(entry.turn_id) ? { turn_id: entry.turn_id } : {}),
      ...(Number.isSafeInteger(entry.created_at) && entry.created_at >= 0 ? { created_at: entry.created_at } : {}),
    });
  }
  for (const entry of Array.isArray(value.quota_snapshots) ? value.quota_snapshots.slice(-MAX_QUOTA_SNAPSHOTS) : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const quality = entry.quality === 'exact' || entry.quality === 'partial' || entry.quality === 'unavailable' ? entry.quality : 'unavailable';
    const source = { ...entry };
    for (const key of ['snapshot_at', 'window_started_at', 'window_ends_at', 'resets_at']) {
      if (entry[key] !== undefined) source[key] = persistedQuotaText(key, entry[key]) ?? '';
    }
    // Revalidate saved arithmetic without aging the observation or inventing a
    // timestamp during recovery. Explicit prior stale evidence remains binding.
    const safe = normalizeQuotaSnapshot(source, { now: source.snapshot_at ?? '' });
    const retainedReasons = Array.isArray(entry.reason_codes) ? entry.reason_codes.filter(reason => [
      'invalid_percentage', 'quota_values_missing', 'inconsistent_quota_values', 'snapshot_time_missing',
      'window_missing', 'reset_time_invalid', 'stale_quota_snapshot', 'invalid_quota_values',
      'zero_denominator', 'unit_missing', 'window_start_invalid', 'window_end_invalid',
    ].includes(reason)) : [];
    const stale = entry.stale === true || safe.stale === true || retainedReasons.includes('stale_quota_snapshot');
    const reasons = [...new Set([...(stale ? ['stale_quota_snapshot'] : []), ...(safe.reason_codes ?? []), ...retainedReasons])].slice(0, 8);
    if (quality === 'unavailable') safe.quality = 'unavailable';
    else if (safe.quality === 'exact' && (quality === 'partial' || reasons.length)) safe.quality = 'partial';
    if (stale) safe.stale = true;
    if (reasons.length) safe.reason_codes = reasons;
    output.quota_snapshots.push(safe);
  }
  for (const entry of Array.isArray(value.comparisons) ? value.comparisons.slice(-MAX_USAGE_SNAPSHOTS) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const mode = ['host_quota', 'manual_capacity', 'relative_only', 'unavailable'].includes(entry.comparison_mode) ? entry.comparison_mode : 'unavailable';
    output.comparisons.push({ comparison_mode: mode, quality: entry.quality === 'exact' ? 'exact' : entry.quality === 'partial' ? 'partial' : 'unavailable' });
  }
  output.counters = boundedCounterMap(value.counters);
  output.alerts_seen = boundedAlertMap(value.alerts_seen);
  for (const [key, totals] of Object.entries(value.session_totals && typeof value.session_totals === 'object' ? value.session_totals : {}).slice(-MAX_SESSION_TOTALS)) {
    if (!/^[a-f0-9]{20}$/.test(key) || !totals || typeof totals !== 'object') continue;
    const safe = {};
    if (Number.isSafeInteger(totals.tokens) && totals.tokens >= 0) safe.tokens = totals.tokens;
    if (typeof totals.calculated_credits === 'number'
      && Number.isFinite(totals.calculated_credits)
      && totals.calculated_credits >= 0
      && totals.calculated_credits <= Number.MAX_SAFE_INTEGER) safe.calculated_credits = totals.calculated_credits;
    if (Number.isSafeInteger(totals.updated_at) && totals.updated_at >= 0) safe.updated_at = totals.updated_at;
    if (Object.keys(safe).length) output.session_totals[key] = safe;
  }
  return output;
}

function recoverEfficiencyState(value) {
  const output = blankEfficiencyState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, entries] of Object.entries(value.scopes && typeof value.scopes === 'object' ? value.scopes : {}).slice(-MAX_EFFICIENCY_SCOPES)) {
    if (!/^[a-f0-9]{20}$/.test(key) || !Array.isArray(entries)) continue;
    const safeEvents = entries.slice(-MAX_EFFICIENCY_EVENTS).map((entry) => normalizeEfficiencyEvent(entry)).filter(Boolean);
    if (safeEvents.length) output.scopes[key] = safeEvents;
  }
  for (const [key, result] of Object.entries(value.last_results && typeof value.last_results === 'object' ? value.last_results : {}).slice(-MAX_EFFICIENCY_SCOPES)) {
    if (!/^[a-f0-9]{20}$/.test(key)) continue;
    output.last_results[key] = persistedEfficiency(result);
  }
  for (const warning of Array.isArray(value.warnings) ? value.warnings.slice(-MAX_EFFICIENCY_WARNINGS) : []) {
    if (!warning || typeof warning !== 'object' || typeof warning.scope_id !== 'string' || !/^[a-f0-9]{20}$/.test(warning.scope_id)) continue;
    if (Number.isSafeInteger(warning.created_at) && warning.created_at >= 0) output.warnings.push({
      scope_id: warning.scope_id,
      ...(typeof warning.session === 'string' && /^[a-f0-9]{20}$/.test(warning.session) ? { session: warning.session } : {}),
      ...(Number.isSafeInteger(warning.session_generation) && warning.session_generation >= 0 ? { session_generation: persistedGeneration(warning.session_generation) } : {}),
      created_at: warning.created_at,
      classification: ['watch', 'likely_loop', 'runaway_risk'].includes(warning.classification) ? warning.classification : 'watch',
    });
  }
  output.counters = boundedCounterMap(value.counters);
  return output;
}

function sanitizePlanComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { comparison_mode: 'unavailable', quality: 'unavailable' };
  const current = value.comparison_schema_version === COMPARISON_SCHEMA_VERSION;
  const displayName = (id) => getPlanProfile('codex', id)?.display_name
    ?? getPlanProfile('claude', id)?.display_name
    ?? 'Unknown';
  const safePlanChoice = (plan) => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
    const id = typeof plan.id === 'string' && /^[a-z0-9_]{1,80}$/.test(plan.id) && safeModel(plan.id) ? plan.id : 'unknown';
    return { id, display_name: displayName(id) };
  };
  const output = {
    comparison_schema_version: COMPARISON_SCHEMA_VERSION,
    comparison_mode: current && ['host_quota', 'manual_capacity', 'relative_only', 'unavailable'].includes(value.comparison_mode) ? value.comparison_mode : 'unavailable',
    quality: current && (value.quality === 'exact' || value.quality === 'partial') ? value.quality : 'unavailable',
    coverage: typeof value.coverage === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value.coverage) && safeModel(value.coverage) ? value.coverage : 'unavailable',
  };
  if (Array.isArray(value.reason_codes)) output.reason_codes = [...new Set(value.reason_codes.filter((entry) => typeof entry === 'string' && /^[a-z0-9_]{1,80}$/.test(entry) && safeModel(entry)))].slice(0, 16);
  if (!current) output.reason_codes = ['legacy_plan_comparison', ...(output.reason_codes ?? []).filter(code => code !== 'legacy_plan_comparison')].slice(0, 16);
  if (value.selected_plan && typeof value.selected_plan === 'object') output.selected_plan = safePlanChoice(value.selected_plan);
  if (value.current_plan && typeof value.current_plan === 'object') output.current_plan = {
    ...safePlanChoice(value.current_plan),
    used_percent: current && typeof value.current_plan.used_percent === 'number' && Number.isFinite(value.current_plan.used_percent) ? value.current_plan.used_percent : null,
    remaining_percent: current && typeof value.current_plan.remaining_percent === 'number' && Number.isFinite(value.current_plan.remaining_percent) ? value.current_plan.remaining_percent : null,
  };
  if (Array.isArray(value.alternative_plan_comparisons)) {
    output.alternative_plan_comparisons = value.alternative_plan_comparisons.slice(0, 8).map((entry) => {
      const item = {
        id: typeof entry?.id === 'string' && /^[a-z0-9_]{1,80}$/.test(entry.id) && safeModel(entry.id) ? entry.id : 'unknown',
        standard_multiplier: typeof entry?.standard_multiplier === 'number' && Number.isFinite(entry.standard_multiplier) && entry.standard_multiplier >= 0 ? entry.standard_multiplier : null,
        used_percent: current && typeof entry?.used_percent === 'number' && Number.isFinite(entry.used_percent) ? entry.used_percent : null,
        remaining_percent: current && typeof entry?.remaining_percent === 'number' && Number.isFinite(entry.remaining_percent) ? entry.remaining_percent : null,
        relative_pressure: current && typeof entry?.relative_pressure === 'number' && Number.isFinite(entry.relative_pressure) ? entry.relative_pressure : null,
      };
      item.display_name = displayName(item.id);
      return item;
    });
  }
  return output;
}

function persistedTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : timestamp();
}

function persistedGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_HEALTH_COUNTER) : 0;
}

function persistedStatus(value) {
  return value === 'exact' || value === 'partial' || value === 'unavailable' ? value : 'unavailable';
}

function persistedTelemetryReconciliation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = TELEMETRY_STATES.has(value.state) ? value.state : 'unavailable';
  const source = TELEMETRY_SOURCES.has(value.source) ? value.source : 'none';
  const attempts = Number.isSafeInteger(value.attempts) && value.attempts >= 0
    ? Math.min(value.attempts, MAX_TURNS) : 0;
  const outcome = isTelemetryOutcome(value.outcome) ? value.outcome : undefined;
  return { state, source, attempts, ...(outcome ? { outcome } : {}) };
}

const SAFE_PONYTAIL_MODES = new Set(['off', 'lite', 'full', 'ultra', 'review']);

const SAFE_PONYTAIL_STATUS = new Set(['confirmed-marker', 'off-confirmed', 'configured-default', 'unknown']);

function persistedMetadata(value) {
  return sanitizeMetadata(value) ?? { status: 'unknown', confidence: 'low' };
}

function persistedMetadataFields(value) {
  const metadata = persistedMetadata(value?.metadata);
  const status = METADATA_STATUSES.has(value?.metadata_status) ? value.metadata_status : metadata.status;
  const confidence = METADATA_CONFIDENCE.has(value?.metadata_confidence) ? value.metadata_confidence : metadata.confidence;
  const source = METADATA_SOURCES.has(value?.metadata_source) ? value.metadata_source : metadata.source;
  return {
    metadata_status: status,
    metadata_confidence: confidence,
    ...(source ? { metadata_source: source } : {}),
  };
}

export function persistedPonytail(value) {
  if (!value || typeof value !== 'object') return { status: 'unknown', reason: PONYTAIL_UNKNOWN_REASON, coverage_count: 0 };
  const legacyStatus = value.status === 'not-detected' || value.status === 'explicit-command-requested'
    ? 'unknown' : value.status;
  const status = SAFE_PONYTAIL_STATUS.has(legacyStatus) ? legacyStatus : 'unknown';
  const output = { status, coverage_count: Number.isSafeInteger(value.coverage_count) && value.coverage_count >= 0 ? Math.min(value.coverage_count, 1000) : 0 };
  if (status !== 'unknown' && SAFE_PONYTAIL_MODES.has(value.mode)) output.mode = value.mode;
  if (status === 'unknown') output.reason = PONYTAIL_UNKNOWN_REASON;
  return output;
}

function sourceFields(receipt, agents = 1) {
  const expected = Number.isSafeInteger(receipt?.expected_sources) && receipt.expected_sources >= 0
    ? receipt.expected_sources : Number.isSafeInteger(agents) && agents > 0 ? agents : 1;
  const unavailable = Number.isSafeInteger(receipt?.unavailable_sources)
    ? Math.max(0, receipt.unavailable_sources)
    : Number.isSafeInteger(receipt?.unavailable) ? Math.max(0, receipt.unavailable) : 0;
  const resolved = Number.isSafeInteger(receipt?.resolved_sources)
    ? Math.max(0, receipt.resolved_sources)
    : Math.max(0, expected - unavailable);
  const overflow = Number.isSafeInteger(receipt?.overflow_sources) ? Math.max(0, receipt.overflow_sources) : 0;
  return {
    expected_sources: Math.min(expected, MAX_AGENTS_PER_TURN + 1),
    resolved_sources: Math.min(resolved, MAX_AGENTS_PER_TURN + 1),
    unavailable_sources: Math.min(unavailable, MAX_AGENTS_PER_TURN),
    overflow_sources: Math.min(overflow, MAX_AGENTS_PER_TURN),
    accounting_status: persistedStatus(receipt?.accounting_status ?? receipt?.status),
  };
}

export function recoverState(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2, SCHEMA_VERSION].includes(value.schema_version) || !stateWithinBounds(value)) return recoveredBlankState();
  const runtime = options?.runtime === 'claude' ? 'claude' : options?.runtime === 'codex' ? 'codex' : 'unknown';
  const state = blankState();
  const legacy = value.schema_version === 1;
  const pathDerivedIdentityState = value.schema_version < SCHEMA_VERSION;
  state.health = persistedHealth(legacy ? null : value.health);
  state.usage = recoverUsageState(value.usage, runtime, { dropTurnIds: pathDerivedIdentityState });
  state.efficiency = pathDerivedIdentityState ? blankEfficiencyState() : recoverEfficiencyState(value.efficiency);
  state.limit_recovery = value.limit_recovery === undefined
    ? createLimitRecoveryState()
    : recoverLimitRecoveryState(value.limit_recovery, undefined, {
      preserve_active: options.preserveLimitRecovery === true,
    });
  state.advisor = recoverAdvisorState(value.advisor);
  state.optimization = recoverOptimizationState(value.optimization);
  state.hot_events = persistedHotEventState(value.hot_events);
  state.identity_rebaseline = pathDerivedIdentityState
    ? migrationRebaselineFromAdvisor(state.advisor)
    : boundedIdentityRebaseline(value.identity_rebaseline);
  state.claude_final_snapshots = pathDerivedIdentityState
    ? {}
    : boundedClaudeFinalSnapshots(value.claude_final_snapshots);
  if (pathDerivedIdentityState) {
    const dropped = Math.min(MAX_HEALTH_COUNTER,
      Object.keys(value.threads ?? {}).length
      + Object.keys(value.turns ?? {}).length
      + Object.keys(value.scopes ?? {}).length
      + Object.keys(value.agent_scopes ?? {}).length
      + Object.keys(value.efficiency?.scopes ?? {}).length);
    incrementHealth(state, 'state_migrations');
    incrementHealth(state, 'state_retention_drops', dropped);
    incrementHealth(state, 'retention_drops', dropped);
  }
  const lastPublishedAt = Number.isSafeInteger(value.public_bridge?.last_published_at) && value.public_bridge.last_published_at >= 0
    ? value.public_bridge.last_published_at
    : 0;
  state.public_bridge = {
    snapshot_sequence: Number.isSafeInteger(value.public_bridge?.snapshot_sequence) && value.public_bridge.snapshot_sequence >= 0
      ? Math.min(value.public_bridge.snapshot_sequence, MAX_HEALTH_COUNTER)
      : 0,
    last_published_at: lastPublishedAt,
    // Older state has no failed-write boundary. Treat its successful publish
    // as the last attempt, so recovery does not add an immediate hot-path IO.
    last_attempted_at: Number.isSafeInteger(value.public_bridge?.last_attempted_at) && value.public_bridge.last_attempted_at >= 0
      ? value.public_bridge.last_attempted_at
      : lastPublishedAt,
  };
  const recoverReceiptUsage = (entry) => persistedUsage(legacy ? {
    ...entry,
    cached_input_tokens: entry?.cached_input_tokens ?? 0,
    reasoning_output_tokens: entry?.reasoning_output_tokens ?? 0,
    cache_write_input_tokens: entry?.cache_write_input_tokens ?? null,
  } : entry, runtime);
  const unsafeAgentFallbackTurns = new Set();
  if (!pathDerivedIdentityState) for (const [key, entry] of boundedEntries(value.threads, MAX_THREADS)) {
    const usage = persistedUsage(entry?.usage, runtime);
    if (!usage) continue;
    if (!/^(?:main|subagent):[a-f0-9]{20}$/.test(key)) continue;
    const sourceId = key.slice(key.indexOf(':') + 1);
    state.threads[key] = {
      schema_version: SCHEMA_VERSION,
      thread_id: key,
      source_id: sourceId,
      usage,
      metadata: persistedMetadata(entry.metadata),
      ponytail: persistedPonytail(entry.ponytail),
      ...(['claude_full_v1',CLAUDE_ACCOUNTING_BASIS,'structured_hook_v1'].includes(entry.accounting_basis) ? { accounting_basis:entry.accounting_basis } : {}),
      compaction_count: Number.isSafeInteger(entry.compaction_count) && entry.compaction_count >= 0 ? entry.compaction_count : 0,
      updated_at: persistedTime(entry.updated_at),
    };
  }
  let recoveredTurnIndex = 0;
  if (!pathDerivedIdentityState) for (const [key, entry] of boundedEntries(value.turns, MAX_TURNS)) {
    if (!entry || typeof entry !== 'object') continue;
    const safeTurnId = /^[a-f0-9]{20}$/.test(key) ? key : hashId(`recovered-turn:${recoveredTurnIndex}`);
    recoveredTurnIndex += 1;
    const turn = {
      turn_id: safeTurnId,
      main: null,
      subagents: {},
      overflow_count: Number.isSafeInteger(entry.overflow_count) && entry.overflow_count > 0
        ? Math.min(entry.overflow_count, MAX_AGENTS_PER_TURN)
        : 0,
      receipt: null,
      updated_at: persistedTime(entry.updated_at),
    };
    if (entry.main && typeof entry.main === 'object') {
      const usage = persistedUsage(entry.main.usage, runtime);
      const sourceId = typeof entry.main.source_id === 'string' && /^[a-f0-9]{20}$/.test(entry.main.source_id)
        ? entry.main.source_id
        : undefined;
      if (usage || sourceId) {
        turn.main = {
          valid: entry.main.valid === true,
          ambiguous: entry.main.ambiguous === true,
          reason: SAFE_REASONS.has(entry.main.reason) ? entry.main.reason : undefined,
          ...(usage ? { usage } : {}),
          ...(sourceId ? { source_id: sourceId } : {}),
          model: safeModel(entry.main.model),
          metadata: persistedMetadata(entry.main.metadata),
          metadata_status: persistedMetadata(entry.main.metadata).status,
          metadata_source: persistedMetadata(entry.main.metadata).source,
          ponytail: persistedPonytail(entry.main.ponytail),
        };
      }
    }
    let recoveredAgentIndex = 0;
    for (const [agentKey, agent] of boundedEntries(entry.subagents, MAX_AGENTS_PER_TURN)) {
      if (!agent || typeof agent !== 'object') continue;
      const agentPostToolUsage = agent.usage_source === 'agent_post_tool';
      if (agentPostToolUsage) unsafeAgentFallbackTurns.add(safeTurnId);
      const childTurn = typeof agent.child_turn === 'string' && /^[a-f0-9]{20}$/.test(agent.child_turn)
        ? agent.child_turn
        : undefined;
      const sourceId = typeof agent.source_id === 'string' && /^[a-f0-9]{20}$/.test(agent.source_id)
        ? agent.source_id
        : undefined;
      const safeAgent = {
        agent_id: /^[a-f0-9]{20}$/.test(agentKey) ? agentKey : hashId(`recovered-turn-agent:${recoveredTurnIndex}:${recoveredAgentIndex}`),
        status: agentPostToolUsage ? 'unavailable' : agent.status === 'completed' || agent.status === 'pending' ? agent.status : 'unavailable',
        ambiguous: agent.ambiguous === true,
        ...(childTurn ? { child_turn: childTurn } : {}),
        ...(sourceId ? { source_id: sourceId } : {}),
        ...(SAFE_REASONS.has(agent.reason) ? { reason: agent.reason } : {}),
        session_generation: persistedGeneration(agent.session_generation),
        updated_at: persistedTime(agent.updated_at),
      };
      recoveredAgentIndex += 1;
      const usage = agentPostToolUsage ? undefined : persistedUsage(agent.usage, runtime);
      if (usage) safeAgent.usage = usage;
      if (SUBAGENT_USAGE_SOURCES.has(agent.usage_source)) safeAgent.usage_source = agent.usage_source;
      safeAgent.metadata = persistedMetadata(agent.metadata);
      safeAgent.ponytail = persistedPonytail(agent.ponytail);
      turn.subagents[safeAgent.agent_id] = safeAgent;
    }
    if (entry.receipt && typeof entry.receipt === 'object' && !unsafeAgentFallbackTurns.has(safeTurnId)) {
      const receiptUsage = recoverReceiptUsage(entry.receipt);
      const recoveredStatus = persistedStatus(entry.receipt.status);
      const receiptStatus = recoveredReceiptStatus(entry.receipt, recoveredStatus, receiptUsage, runtime);
      const receiptUsageLayers = recoveredReceiptUsageLayers(entry.receipt, receiptUsage, receiptStatus, runtime);
      if (receiptUsage || recoveredStatus === 'unavailable') {
        turn.receipt = {
          schema_version: SCHEMA_VERSION,
          turn_id: safeTurnId,
          status: receiptStatus,
          ...(receiptUsage ? tokenFields(receiptUsage) : {}),
          agents: Number.isSafeInteger(entry.receipt.agents) && entry.receipt.agents > 0 ? Math.min(entry.receipt.agents, MAX_AGENTS_PER_TURN + 1) : 1,
          ...sourceFields(entry.receipt, entry.receipt.agents),
          ...(typeof entry.receipt.session === 'string' && /^[a-f0-9]{20}$/.test(entry.receipt.session) ? { session: entry.receipt.session } : {}),
          ...(Number.isSafeInteger(entry.receipt.session_generation) && entry.receipt.session_generation >= 0 ? { session_generation: persistedGeneration(entry.receipt.session_generation) } : {}),
          ...persistedMetadataFields(entry.receipt),
          ...(receiptUsageLayers ? { usage_layers: receiptUsageLayers } : {}),
          ...(COVERAGE.includes(entry.receipt.usage_coverage) ? { usage_coverage: entry.receipt.usage_coverage } : {}),
          ...(SAFE_REASONS.has(entry.receipt.reason) ? { reason: entry.receipt.reason } : {}),
          ...(ERROR_CATEGORIES.has(entry.receipt.stop_failure_category) ? { stop_failure_category: entry.receipt.stop_failure_category } : {}),
          ...(persistedTelemetryReconciliation(entry.receipt.telemetry_reconciliation)
            ? { telemetry_reconciliation: persistedTelemetryReconciliation(entry.receipt.telemetry_reconciliation) } : {}),
          ...(persistedEfficiency(entry.receipt.efficiency) ? { efficiency: persistedEfficiency(entry.receipt.efficiency) } : {}),
          ...(entry.receipt.subscription_usage === 'unavailable' ? { subscription_usage: 'unavailable' } : {}),
          ...(entry.receipt.account_quota === 'unavailable' ? { account_quota: 'unavailable' } : {}),
          ...(entry.receipt.plan_comparison && typeof entry.receipt.plan_comparison === 'object' ? { plan_comparison: sanitizePlanComparison(entry.receipt.plan_comparison) } : {}),
          savings: normalizeSavings(entry.receipt.savings),
          ponytail: persistedPonytail(entry.receipt.ponytail),
          created_at: persistedTime(entry.receipt.created_at),
        };
      }
    }
    state.turns[turn.turn_id] = turn;
  }
  let recoveredScopeIndex = 0;
  if (!pathDerivedIdentityState) for (const [key, entry] of boundedEntries(value.scopes, MAX_THREADS)) {
    if (!entry || typeof entry !== 'object') continue;
    const safeScopeId = /^[a-f0-9]{20}$/.test(key) ? key : hashId(`recovered-scope:${recoveredScopeIndex}`);
    recoveredScopeIndex += 1;
    const scope = {
      scope_id: safeScopeId,
      closed: entry.closed === true,
      generation: Number.isSafeInteger(entry.generation) && entry.generation >= 0 ? entry.generation : 0,
      ...(typeof entry.parent_turn === 'string' && /^[a-f0-9]{20}$/.test(entry.parent_turn) ? { parent_turn: entry.parent_turn } : {}),
      overflow_count: Number.isSafeInteger(entry.overflow_count) && entry.overflow_count > 0
        ? Math.min(entry.overflow_count, MAX_AGENTS_PER_TURN)
        : 0,
      active: {},
      completed: {},
      updated_at: persistedTime(entry.updated_at),
    };
    let recoveredScopeAgentIndex = 0;
    for (const [agentKey, agent] of boundedEntries(entry.active, MAX_AGENTS_PER_TURN)) {
      if (!agent || typeof agent !== 'object') continue;
      const safeAgentId = /^[a-f0-9]{20}$/.test(agentKey) ? agentKey : hashId(`recovered-scope-active:${recoveredScopeIndex}:${recoveredScopeAgentIndex}`);
      recoveredScopeAgentIndex += 1;
      const childTurn = typeof agent.child_turn === 'string' && /^[a-f0-9]{20}$/.test(agent.child_turn)
        ? agent.child_turn : undefined;
      if (!childTurn) continue;
      scope.active[safeAgentId] = {
        agent_id: safeAgentId,
        child_turn: childTurn,
        ...(typeof agent.child_source_id === 'string' && /^[a-f0-9]{20}$/.test(agent.child_source_id) ? { child_source_id: agent.child_source_id } : {}),
        generation: Number.isSafeInteger(agent.generation) && agent.generation >= 0 ? agent.generation : scope.generation,
        session_generation: persistedGeneration(agent.session_generation),
        ponytail: persistedPonytail(agent.ponytail),
        updated_at: persistedTime(agent.updated_at),
      };
    }
    for (const [agentKey, agent] of boundedEntries(entry.completed, MAX_AGENTS_PER_TURN)) {
      if (!agent || typeof agent !== 'object') continue;
      const agentPostToolUsage = agent.usage_source === 'agent_post_tool';
      const usage = agentPostToolUsage ? undefined : persistedUsage(agent.usage, runtime);
      const safeAgentId = /^[a-f0-9]{20}$/.test(agentKey) ? agentKey : hashId(`recovered-scope-completed:${recoveredScopeIndex}:${recoveredScopeAgentIndex}`);
      recoveredScopeAgentIndex += 1;
      const childTurn = typeof agent.child_turn === 'string' && /^[a-f0-9]{20}$/.test(agent.child_turn)
        ? agent.child_turn : undefined;
      if (!childTurn) continue;
      if (agentPostToolUsage) unsafeAgentFallbackTurns.add(childTurn);
      scope.completed[safeAgentId] = {
        agent_id: safeAgentId,
        child_turn: childTurn,
        ...(typeof agent.child_source_id === 'string' && /^[a-f0-9]{20}$/.test(agent.child_source_id) ? { child_source_id: agent.child_source_id } : {}),
        generation: Number.isSafeInteger(agent.generation) && agent.generation >= 0 ? agent.generation : scope.generation,
        session_generation: persistedGeneration(agent.session_generation),
        status: !agentPostToolUsage && agent.status === 'completed' ? 'completed' : 'unavailable',
        ambiguous: agent.ambiguous === true,
        ...(usage ? { usage: tokenFields(usage) } : {}),
        ...(SUBAGENT_USAGE_SOURCES.has(agent.usage_source) ? { usage_source: agent.usage_source } : {}),
        metadata: persistedMetadata(agent.metadata),
        ponytail: persistedPonytail(agent.ponytail),
        updated_at: persistedTime(agent.updated_at),
      };
    }
    state.scopes[safeScopeId] = scope;
  }
  let recoveredLinkIndex = 0;
  if (!pathDerivedIdentityState) for (const [agentKey, entry] of boundedEntries(value.agent_scopes, MAX_THREADS)) {
    if (!entry || typeof entry !== 'object') continue;
    const safeAgentId = /^[a-f0-9]{20}$/.test(agentKey) ? agentKey : hashId(`recovered-agent-link:${recoveredLinkIndex}`);
    recoveredLinkIndex += 1;
    const session = typeof entry.session === 'string' && /^[a-f0-9]{20}$/.test(entry.session) ? entry.session : undefined;
    const childTurn = typeof entry.child_turn === 'string' && /^[a-f0-9]{20}$/.test(entry.child_turn) ? entry.child_turn : undefined;
    if (!session || !childTurn) continue;
    state.agent_scopes[safeAgentId] = {
      agent_id: safeAgentId,
      session,
      ...(typeof entry.source_scope === 'string' && /^[a-f0-9]{20}$/.test(entry.source_scope) ? { source_scope: entry.source_scope } : {}),
      child_turn: childTurn,
      ...(typeof entry.child_source_id === 'string' && /^[a-f0-9]{20}$/.test(entry.child_source_id) ? { child_source_id: entry.child_source_id } : {}),
      ...(typeof entry.lifecycle_agent_id === 'string' && /^[a-f0-9]{20}$/.test(entry.lifecycle_agent_id) ? { lifecycle_agent_id: entry.lifecycle_agent_id } : {}),
      ...(typeof entry.lifecycle_turn_id === 'string' && /^[a-f0-9]{20}$/.test(entry.lifecycle_turn_id) ? { lifecycle_turn_id: entry.lifecycle_turn_id } : {}),
      generation: Number.isSafeInteger(entry.generation) && entry.generation >= 0 ? entry.generation : 0,
      session_generation: persistedGeneration(entry.session_generation),
      status: entry.status === 'completed' ? 'completed' : entry.status === 'pending' ? 'pending' : 'unavailable',
      open: entry.open === true,
      updated_at: persistedTime(entry.updated_at),
    };
  }
  if (Array.isArray(value.receipts)) {
    for (const [receiptIndex, entry] of value.receipts.slice(-MAX_TURNS).entries()) {
      if (!entry || typeof entry !== 'object') continue;
      // Schema v1/v2 turn hashes may have been derived from transcript
      // locations. Preserve the audited numeric receipt but mint a fixed
      // migration-local identifier instead of retaining an unverifiable old
      // hash of private content.
      const turnId = !pathDerivedIdentityState && typeof entry.turn_id === 'string' && /^[a-f0-9]{20}$/.test(entry.turn_id)
        ? entry.turn_id
        : hashId(`recovered-receipt:${receiptIndex}`);
      const unsafeAgentFallback = unsafeAgentFallbackTurns.has(turnId);
      const usage = unsafeAgentFallback ? undefined : recoverReceiptUsage(entry);
      const recoveredStatus = unsafeAgentFallback ? 'unavailable' : persistedStatus(entry.status);
      const receiptStatus = unsafeAgentFallback ? 'unavailable' : recoveredReceiptStatus(entry, recoveredStatus, usage, runtime);
      const receiptUsageLayers = unsafeAgentFallback ? undefined : recoveredReceiptUsageLayers(entry, usage, receiptStatus, runtime);
      if (!usage && recoveredStatus !== 'unavailable') continue;
      state.receipts.push({
        schema_version: SCHEMA_VERSION,
        turn_id: turnId,
        status: receiptStatus,
        ...(usage ? tokenFields(usage) : {}),
        agents: Number.isSafeInteger(entry.agents) && entry.agents > 0 ? Math.min(entry.agents, MAX_AGENTS_PER_TURN + 1) : 1,
        ...sourceFields(unsafeAgentFallback ? { ...entry, resolved_sources: 0, unavailable_sources: entry.agents } : entry, entry.agents),
        ...(typeof entry.session === 'string' && /^[a-f0-9]{20}$/.test(entry.session) ? { session: entry.session } : {}),
        ...(Number.isSafeInteger(entry.session_generation) && entry.session_generation >= 0 ? { session_generation: persistedGeneration(entry.session_generation) } : {}),
        ...persistedMetadataFields(entry),
        metadata: persistedMetadata(entry.metadata),
        ...(entry.workflow_context && typeof entry.workflow_context === 'object'
          ? { workflow_context: normalizeWorkflowContext(entry.workflow_context) }
          : {}),
        ...(receiptUsageLayers ? { usage_layers: receiptUsageLayers } : {}),
        ...(COVERAGE.includes(entry.usage_coverage) ? { usage_coverage: entry.usage_coverage } : {}),
        ...(SAFE_REASONS.has(entry.reason) ? { reason: entry.reason } : {}),
        ...(ERROR_CATEGORIES.has(entry.stop_failure_category) ? { stop_failure_category: entry.stop_failure_category } : {}),
        ...(persistedTelemetryReconciliation(entry.telemetry_reconciliation)
          ? { telemetry_reconciliation: persistedTelemetryReconciliation(entry.telemetry_reconciliation) } : {}),
        ...(persistedEfficiency(entry.efficiency) ? { efficiency: persistedEfficiency(entry.efficiency) } : {}),
        ...(entry.subscription_usage === 'unavailable' ? { subscription_usage: 'unavailable' } : {}),
        ...(entry.account_quota === 'unavailable' ? { account_quota: 'unavailable' } : {}),
        ...(entry.plan_comparison && typeof entry.plan_comparison === 'object' ? { plan_comparison: sanitizePlanComparison(entry.plan_comparison) } : {}),
        savings: normalizeSavings(entry.savings),
        ponytail: persistedPonytail(entry.ponytail),
        created_at: persistedTime(entry.created_at),
      });
    }
  }
  state.updated_at = persistedTime(value.updated_at);
  return state;
}

export function tokenFields(usage) {
  if (!usage) return {};
  const output = {};
  for (const key of USAGE_KEYS) {
    if (OPTIONAL_USAGE_KEYS.has(key) && (usage[key] === undefined || usage[key] === null)) {
      output[key] = null;
    } else if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) {
      output[key] = usage[key];
    }
  }
  if (typeof usage.consistent === 'boolean') output.consistent = usage.consistent;
  return output;
}

function prune(state) {
  const stagedSnapshotInput = state.claude_final_snapshots && typeof state.claude_final_snapshots === 'object'
    ? state.claude_final_snapshots : {};
  const stagedSnapshots = boundedClaudeFinalSnapshots(stagedSnapshotInput);
  const stagedSnapshotDrops = Math.max(0, Object.keys(stagedSnapshotInput).length - Object.keys(stagedSnapshots).length);
  const stateDrops = Math.max(0, Object.keys(state.threads).length - MAX_THREADS)
    + Math.max(0, Object.keys(state.turns).length - MAX_TURNS)
    + Math.max(0, Object.keys(state.scopes).length - MAX_THREADS)
    + Math.max(0, Object.keys(state.agent_scopes).length - MAX_THREADS);
  const receiptDrops = Math.max(0, state.receipts.length - MAX_TURNS);
  incrementHealth(state, 'state_retention_drops', stateDrops + stagedSnapshotDrops);
  incrementHealth(state, 'receipt_retention_drops', receiptDrops);
  incrementHealth(state, 'retention_drops', stateDrops + stagedSnapshotDrops + receiptDrops);
  const threadEntries = Object.entries(state.threads).sort((a, b) => (b[1]?.updated_at ?? 0) - (a[1]?.updated_at ?? 0));
  state.threads = Object.fromEntries(threadEntries.slice(0, MAX_THREADS));
  const turnEntries = Object.entries(state.turns).sort((a, b) => (b[1]?.updated_at ?? 0) - (a[1]?.updated_at ?? 0));
  state.turns = Object.fromEntries(turnEntries.slice(0, MAX_TURNS));
  const scopeEntries = Object.entries(state.scopes).sort((a, b) => (b[1]?.updated_at ?? 0) - (a[1]?.updated_at ?? 0));
  state.scopes = Object.fromEntries(scopeEntries.slice(0, MAX_THREADS));
  const agentEntries = Object.entries(state.agent_scopes).sort((a, b) => (b[1]?.updated_at ?? 0) - (a[1]?.updated_at ?? 0));
  state.agent_scopes = Object.fromEntries(agentEntries.slice(0, MAX_THREADS));
  state.receipts = state.receipts.slice(-MAX_TURNS);
  state.claude_final_snapshots = stagedSnapshots;
  state.usage ??= blankUsageState();
  state.usage.snapshots = Array.isArray(state.usage.snapshots) ? state.usage.snapshots.slice(-MAX_USAGE_SNAPSHOTS) : [];
  state.usage.quota_snapshots = Array.isArray(state.usage.quota_snapshots) ? state.usage.quota_snapshots.slice(-MAX_QUOTA_SNAPSHOTS) : [];
  state.usage.comparisons = Array.isArray(state.usage.comparisons) ? state.usage.comparisons.slice(-MAX_USAGE_SNAPSHOTS) : [];
  state.usage.alerts_seen = boundedAlertMap(state.usage.alerts_seen);
  state.usage.session_totals = state.usage.session_totals && typeof state.usage.session_totals === 'object'
    ? Object.fromEntries(Object.entries(state.usage.session_totals).slice(-MAX_SESSION_TOTALS)) : {};
  state.efficiency ??= blankEfficiencyState();
  state.efficiency.warnings = Array.isArray(state.efficiency.warnings) ? state.efficiency.warnings.slice(-MAX_EFFICIENCY_WARNINGS) : [];
  state.efficiency.last_results = state.efficiency.last_results && typeof state.efficiency.last_results === 'object' ? Object.fromEntries(Object.entries(state.efficiency.last_results).slice(-MAX_EFFICIENCY_SCOPES)) : {};
  state.efficiency.scopes = state.efficiency.scopes && typeof state.efficiency.scopes === 'object' ? Object.fromEntries(Object.entries(state.efficiency.scopes).slice(-MAX_EFFICIENCY_SCOPES).map(([key, events]) => [key, Array.isArray(events) ? events.slice(-MAX_EFFICIENCY_EVENTS) : []])) : {};
  state.limit_recovery = trimLimitRecoveryState(state.limit_recovery);
  state.hot_events = persistedHotEventState(state.hot_events);
  state.identity_rebaseline = boundedIdentityRebaseline(state.identity_rebaseline);
  state.advisor = state.advisor && typeof state.advisor === 'object' ? state.advisor : createAdvisorState();
  trimAdvisorState(state.advisor);
  state.optimization = state.optimization && typeof state.optimization === 'object' ? state.optimization : createOptimizationState();
  trimOptimizationState(state.optimization);
}

export function loadState(stateDir, runtime = 'unknown', options = {}) {
  const target = stateFile(stateDir);
  let fd;
  try {
    const link = fs.lstatSync(target);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error('state-file-invalid');
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    const size = stat.isFile() ? stat.size : null;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_STATE_BYTES) throw new Error('state-file-too-large');
    const buffer = Buffer.alloc(size);
    if (size > 0) fs.readSync(fd, buffer, 0, size, 0);
    const value = JSON.parse(buffer.toString('utf8'));
    if (!stateWithinBounds(value)) throw new Error('state-structure-limit');
    return recoverState(value, { runtime, preserveLimitRecovery: options.preserveLimitRecovery === true });
  } catch {
    const state = blankState();
    try {
      if (fs.existsSync(target)) Object.defineProperty(state, RECOVERED_STATE, { value: true, enumerable: false, configurable: true });
    } catch { /* fail open */ }
    return state;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
}

// Measure canonical in-memory state only, after field/count normalization.
// Arrays contribute values, not serialized numeric index keys, matching the
// persisted-state guard. This is separate from untrusted-input validation.
function retainedStateCost(value) {
  const pending=[value];
  let bytes=0,nodes=0;
  while(pending.length){
    const entry=pending.pop();nodes++;
    if(typeof entry==='string')bytes+=Buffer.byteLength(entry,'utf8');
    else if(entry&&typeof entry==='object')for(const [key,child] of Object.entries(entry)){
      if(!Array.isArray(entry))bytes+=Buffer.byteLength(key,'utf8');
      pending.push(child);
    }
  }
  return {bytes,nodes};
}

function reclaimEfficiencyStateBudget(state) {
  if(stateWithinBounds(state))return;
  const budget=retainedStateCost(state);
  const byteTarget=MAX_STATE_RETAINED_BYTES-16*1024,nodeTarget=MAX_STATE_NODES-1024;
  if(budget.bytes<=MAX_STATE_RETAINED_BYTES&&budget.nodes<MAX_STATE_NODES)return;
  // Preserve usage, receipts, identities and experimental costs. Only optional
  // structural detector detail competes for the remaining aggregate budget.
  const candidates=Object.entries(state.efficiency?.scopes??{}).flatMap(([scope,events])=>
    events.map((event,index)=>({scope,index,event,at:Number.isSafeInteger(event.timestamp)?event.timestamp:0})));
  candidates.sort((a,b)=>a.at-b.at||a.scope.localeCompare(b.scope)||a.index-b.index);
  const removed=new Map();let dropped=0;
  for(const candidate of candidates){
    if(budget.bytes<=byteTarget&&budget.nodes<=nodeTarget)break;
    if(!removed.has(candidate.scope)){
      removed.set(candidate.scope,new Set());
      // The cached detector conclusion no longer has its original retained
      // evidence window. A later event can compute a fresh bounded result.
      if(Object.hasOwn(state.efficiency.last_results??{},candidate.scope)){
        const cost=retainedStateCost(state.efficiency.last_results[candidate.scope]);
        budget.bytes-=cost.bytes+Buffer.byteLength(candidate.scope,'utf8');budget.nodes-=cost.nodes;
        delete state.efficiency.last_results[candidate.scope];
      }
    }
    const cost=retainedStateCost(candidate.event);
    budget.bytes-=cost.bytes;budget.nodes-=cost.nodes;
    removed.get(candidate.scope).add(candidate.index);dropped++;
  }
  for(const [scope,indices] of removed)state.efficiency.scopes[scope]=state.efficiency.scopes[scope].filter((_,index)=>!indices.has(index));
  incrementHealth(state,'efficiency_retention_drops',dropped);
  incrementHealth(state,'retention_drops',dropped);
}

export function saveState(stateDir, state, { durable = true } = {}) {
  if (state[RECOVERED_STATE]) {
    incrementHealth(state, 'state_recoveries');
    delete state[RECOVERED_STATE];
  }
  prune(state);
  state.updated_at = timestamp();
  reclaimEfficiencyStateBudget(state);
  if (!stateWithinBounds(state)) throw new Error('state-structure-limit');
  const target = stateFile(stateDir);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) throw new Error('state-file-too-large');
  let fd,owned;
  let committed = false;
  try {
    // The generated temp path must be exclusively created: a stale or
    // redirected collision must fail open rather than truncate another file.
    fd = fs.openSync(temp, 'wx', 0o600);
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, serialized, { encoding: 'utf8' });
    if (durable) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    committed = true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
    if (!committed) {
      try { unlinkOwnedFile(temp,owned); } catch { /* fail open */ }
    }
  }
}
