import { hashOpaqueHostIdentifier, safeOpaqueHostIdentifier } from '../core.mjs';
import { createCapabilityRegistry, recoverCapabilityRegistry } from './capabilities.mjs';
import { normalizeRecommendation } from './recommendations.mjs';
import { recoverAcceptanceWindows } from './acceptance.mjs';
import { EVENT_TYPES } from './schema.mjs';
import { MODEL_FAMILIES, ROUTING_EFFORTS } from '../routing.mjs';

export const ADVISOR_SCHEMA_VERSION = 1;
export const CLOSURE_STATES = Object.freeze([
  'closed_exact',
  'closed_partial',
  'closed_with_pending_sources',
  'interrupted',
  'expired',
  'recovered',
]);

const HOSTS = new Set(['codex', 'claude']);
// Session bookkeeping accepts the same sanitized structural event surface as
// the normalizer. Keeping one authority prevents a valid hook event from
// bypassing closed-session and retention guards because a local allowlist
// drifted behind the host adapter.
const EVENTS = EVENT_TYPES;
const HASH = /^[a-f0-9]{20}$/;
const MODEL_FAMILY_PATTERN = MODEL_FAMILIES.join('|');
const ROUTING_EFFORT_PATTERN = ROUTING_EFFORTS.join('|');
const WORKFLOW_HISTORY_KEY = new RegExp(`^(codex|claude)\\|(${MODEL_FAMILY_PATTERN})\\|(${ROUTING_EFFORT_PATTERN})\\|(${MODEL_FAMILY_PATTERN})\\|(${ROUTING_EFFORT_PATTERN})\\|(low|watch|high)\\|(model|effort)\\|(observed|partial|unavailable)$`);
const MAX_SESSIONS = 128;
const MAX_EVENT_TYPES = 32;
const MAX_RECOMMENDATIONS = 64;
const MAX_WORKFLOW_HISTORY = 32;
const MAX_BASELINES = 64;
const MAX_COUNTER = 1_000_000;
const EARLY_SESSION_END_WINDOW_MS = 60_000;
const EARLY_REOPEN_SOURCES = new Set(['resume', 'clear']);
export const ADVISOR_TTLS = Object.freeze({
  session_ms: 24 * 60 * 60 * 1000,
  acceptance_ms: 6 * 60 * 60 * 1000,
  baseline_ms: 30 * 24 * 60 * 60 * 1000,
  recommendation_ms: 30 * 24 * 60 * 60 * 1000,
});

function number(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeHost(value) {
  return HOSTS.has(value) ? value : 'unknown';
}

function safeEvent(value) {
  return EVENTS.has(value) ? value : null;
}

function safeEarlyReopenSource(value) {
  return EARLY_REOPEN_SOURCES.has(value) ? value : null;
}

function normalizeWorkflowHistoryEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.recommendation_id !== 'workflow_model_candidate') return null;
  if (value.host !== 'codex' && value.host !== 'claude') return null;
  if (typeof value.group_key !== 'string' || !WORKFLOW_HISTORY_KEY.test(value.group_key)) return null;
  if (!value.group_key.startsWith(`${value.host}|`)) return null;
  if (!Number.isSafeInteger(value.emitted_at) || value.emitted_at < 0) return null;
  return {
    recommendation_id: value.recommendation_id,
    group_key: value.group_key,
    host: value.host,
    emitted_at: value.emitted_at,
  };
}

export function sessionKey(value, host = 'unknown') {
  if (!safeOpaqueHostIdentifier(value)) return null;
  const namespace = safeHost(host);
  return hashOpaqueHostIdentifier(value, namespace) ?? null;
}

function increment(map, key, amount = 1) {
  if (!key) return;
  map[key] = Math.min(MAX_COUNTER, (map[key] ?? 0) + amount);
}

export function createAdvisorState() {
  return {
    advisor_schema_version: ADVISOR_SCHEMA_VERSION,
    sessions: {},
    capabilities: createCapabilityRegistry(),
    acceptance_windows: [],
    baselines: {},
    recommendation_history: [],
    workflow_history: [],
    counters: {},
  };
}

function sessionRecord(host, key, now) {
  return {
    session_id: key,
    host: safeHost(host),
    generation: 0,
    opened_at: number(now) ?? Date.now(),
    last_event_at: number(now) ?? Date.now(),
    event_counts: {},
    closure_state: 'interrupted',
    closed_at: null,
    pending_sources: null,
    late_events: 0,
    summary: null,
    pending_prior_session_end_generation: null,
    pending_prior_session_end_at: null,
    pending_prior_session_end_source: null,
  };
}

function boundedSession(state, key, host, now) {
  state.sessions ??= {};
  state.sessions[key] ??= sessionRecord(host, key, now);
  const record = state.sessions[key];
  if (record.host === 'unknown' && HOSTS.has(host)) record.host = host;
  return record;
}

function recordSessionEventForKey(state, key, input = {}) {
  if (!state || typeof state !== 'object') return null;
  const event = safeEvent(input.event_type ?? input.hook_event_name);
  if (!key || !event) return null;
  const now = number(input.timestamp) ?? Date.now();
  const record = boundedSession(state, key, input.host, now);
  const startSource = safeEarlyReopenSource(input.session_start_source);
  if (event === 'SessionStart' && record.closed_at !== null) {
    // Command hooks can arrive out of order. A Start with a trustworthy
    // timestamp older than the recorded closure belongs to the completed
    // generation, not to a host restart. Do not reopen a source boundary from
    // that delayed event. Untimestamped Starts retain the existing restart
    // behavior because their ordering cannot be proven safely.
    if (Number.isSafeInteger(record.closed_at) && now < record.closed_at) {
      record.late_events = Math.min(MAX_COUNTER, (record.late_events ?? 0) + 1);
      increment(state.counters, 'late_events_after_close');
      return { ...record, late_session_start_ignored: true };
    }
    // A host may reuse a stable session id after a process restart or plugin
    // reload. Reopen the bounded record as a new generation so subsequent
    // turns are accepted without allowing pending state from the closed
    // generation to attach to them.
    record.generation = Math.min(MAX_COUNTER, (number(record.generation) ?? 0) + 1);
    record.opened_at = now;
    record.last_event_at = now;
    record.event_counts = { SessionStart: 1 };
    record.closure_state = 'recovered';
    record.closed_at = null;
    record.pending_sources = null;
    record.late_events = 0;
    record.summary = null;
    record.pending_prior_session_end_generation = null;
    record.pending_prior_session_end_at = null;
    record.pending_prior_session_end_source = null;
    increment(state.counters, 'session_resumes');
    increment(state.counters, 'session_events_seen');
    trimAdvisorState(state);
    return { ...record, event_counts: { ...record.event_counts } };
  }
  // Claude documents SessionStart for `resume` and `clear`. Command hooks for
  // lifecycle boundaries can reach this shared lock out of order, so an old
  // SessionEnd may arrive after the new SessionStart. Advance only on these
  // explicit Claude boundaries; do not infer a restart from ordinary events
  // or from compaction, which remains one continuous session.
  if (event === 'SessionStart'
    && record.closed_at === null
    && safeHost(input.host) === 'claude'
    && startSource) {
    const priorMarkerAge = now - record.pending_prior_session_end_at;
    if (record.pending_prior_session_end_source === startSource
      && Number.isSafeInteger(record.pending_prior_session_end_generation)
      && Number.isSafeInteger(record.pending_prior_session_end_at)
      // A clock rollback cannot prove another lifecycle boundary. Coalesce a
      // same-source start conservatively rather than advancing generation and
      // risking a fresh turn's accounting. Forward ordering remains bounded.
      && priorMarkerAge <= EARLY_SESSION_END_WINDOW_MS) {
      record.last_event_at = Math.max(record.last_event_at ?? now, now);
      record.event_counts ??= {};
      increment(record.event_counts, event);
      increment(state.counters, 'session_events_seen');
      trimAdvisorState(state);
      return {
        ...record,
        event_counts: { ...record.event_counts },
        duplicate_session_start: true,
        prior_generation: record.pending_prior_session_end_generation,
        ...(priorMarkerAge < 0 ? { clock_anomaly: true } : {}),
      };
    }
    const priorGeneration = Math.min(MAX_COUNTER, number(record.generation) ?? 0);
    record.generation = Math.min(MAX_COUNTER, priorGeneration + 1);
    record.opened_at = now;
    record.last_event_at = now;
    record.event_counts = { SessionStart: 1 };
    record.closure_state = 'recovered';
    record.closed_at = null;
    record.pending_sources = null;
    record.late_events = 0;
    record.summary = null;
    record.pending_prior_session_end_generation = priorGeneration;
    record.pending_prior_session_end_at = now;
    record.pending_prior_session_end_source = startSource;
    increment(state.counters, 'session_resumes');
    increment(state.counters, 'session_events_seen');
    trimAdvisorState(state);
    return {
      ...record,
      event_counts: { ...record.event_counts },
      session_start_before_end: true,
      prior_generation: priorGeneration,
    };
  }
  if (event === 'SessionEnd'
    && Number.isSafeInteger(record.pending_prior_session_end_generation)
    && Number.isSafeInteger(record.pending_prior_session_end_at)) {
    const age = now - record.pending_prior_session_end_at;
    // An end timestamp before the protected SessionStart is necessarily
    // chronologically ambiguous. Treat it as the old end rather than closing
    // the new generation; this is conservative and remains report-only.
    if (age <= EARLY_SESSION_END_WINDOW_MS) {
      const priorGeneration = record.pending_prior_session_end_generation;
      record.pending_prior_session_end_generation = null;
      record.pending_prior_session_end_at = null;
      record.pending_prior_session_end_source = null;
      increment(state.counters, 'session_events_seen');
      increment(state.counters, 'stale_session_end_ignored');
      trimAdvisorState(state);
      return {
        ...record,
        event_counts: { ...record.event_counts },
        ignored_prior_session_end: true,
        prior_generation: priorGeneration,
        ...(age < 0 ? { clock_anomaly: true } : {}),
      };
    }
    record.pending_prior_session_end_generation = null;
    record.pending_prior_session_end_at = null;
    record.pending_prior_session_end_source = null;
  }
  if (record.closed_at !== null && event !== 'SessionEnd') {
    record.late_events = Math.min(MAX_COUNTER, (record.late_events ?? 0) + 1);
    increment(state.counters, 'late_events_after_close');
    return { ...record };
  }
  record.last_event_at = Math.max(record.last_event_at ?? now, now);
  record.event_counts ??= {};
  increment(record.event_counts, event);
  if (event === 'SessionStart' && record.closure_state === 'interrupted') record.closure_state = 'recovered';
  increment(state.counters, 'session_events_seen');
  trimAdvisorState(state);
  return { ...record };
}

export function recordSessionEvent(state, input = {}) {
  const key = sessionKey(input.session_id ?? input.session, input.host);
  return recordSessionEventForKey(state, key, input);
}

/**
 * Replay a previously normalized hook event without re-hashing its session
 * boundary. The caller must provide only a SomesToken-generated opaque hash;
 * accepting raw input here would weaken the replay privacy boundary.
 */
export function recordSanitizedSessionEvent(state, input = {}) {
  const key = typeof input.session_hash === 'string' && HASH.test(input.session_hash)
    ? input.session_hash
    : null;
  return recordSessionEventForKey(state, key, input);
}

export function closeSession(state, input = {}) {
  if (!state || typeof state !== 'object') return null;
  const key = sessionKey(input.session_id ?? input.session, input.host);
  if (!key) return null;
  const now = number(input.now ?? input.timestamp) ?? Date.now();
  const record = boundedSession(state, key, input.host, now);
  if (record.closed_at !== null) return { ...record, event_counts: { ...(record.event_counts ?? {}) } };
  const pending = number(input.pending_sources) ?? (input.pending_sources === true ? 1 : 0);
  const quality = input.receipt_quality === 'unavailable' || input.receipt_quality === 'partial' ? input.receipt_quality : 'exact';
  record.pending_sources = pending;
  record.closed_at = now;
  record.last_event_at = Math.max(record.last_event_at ?? now, now);
  record.closure_state = pending > 0
    ? 'closed_with_pending_sources'
    : quality === 'partial' || quality === 'unavailable' ? 'closed_partial' : 'closed_exact';
  record.pending_prior_session_end_generation = null;
  record.pending_prior_session_end_at = null;
  record.pending_prior_session_end_source = null;
  record.summary = {
    receipt_count: number(input.receipt_count) ?? 0,
    exact_receipts: number(input.exact_receipts) ?? 0,
    partial_receipts: number(input.partial_receipts) ?? 0,
    unavailable_receipts: number(input.unavailable_receipts) ?? 0,
  };
  increment(state.counters, 'session_end_events');
  increment(state.counters, 'session_reconciliations');
  trimAdvisorState(state);
  return { ...record, event_counts: { ...(record.event_counts ?? {}) }, summary: { ...record.summary } };
}

export function expireSessions(state, now = Date.now(), ttlMs = 24 * 60 * 60 * 1000) {
  if (!state || typeof state !== 'object') return 0;
  const age = Number.isSafeInteger(ttlMs) && ttlMs >= 0 ? ttlMs : 24 * 60 * 60 * 1000;
  let count = 0;
  for (const record of Object.values(state.sessions ?? {})) {
    if (!record || record.closed_at !== null || !Number.isSafeInteger(record.last_event_at)) continue;
    if (Number.isSafeInteger(now) && now - record.last_event_at >= age) {
      record.closure_state = 'expired';
      record.closed_at = now;
      count += 1;
    }
  }
  if (count) increment(state.counters, 'sessions_expired', count);
  return count;
}

/** Expire stale advisor material without changing accounting truth. */
export function expireAdvisorState(state, now = Date.now(), options = {}) {
  if (!state || typeof state !== 'object' || !Number.isSafeInteger(now) || now < 0) {
    return { sessions: 0, acceptance: 0, baselines: 0, recommendations: 0, workflow_recommendations: 0, dropped: 0 };
  }
  const ttl = (name, fallback) => Number.isSafeInteger(options[name]) && options[name] >= 0 ? options[name] : fallback;
  const sessions = expireSessions(state, now, ttl('session_ttl_ms', ADVISOR_TTLS.session_ms));
  let acceptance = 0;
  for (const window of Array.isArray(state.acceptance_windows) ? state.acceptance_windows : []) {
    if (!window || window.state !== 'open' || !Number.isSafeInteger(window.started_at)) continue;
    if (now - window.started_at >= ttl('acceptance_ttl_ms', ADVISOR_TTLS.acceptance_ms)) {
      window.state = 'expired';
      window.ended_at = now;
      acceptance += 1;
    }
  }
  let baselines = 0;
  const baselineTtl = ttl('baseline_ttl_ms', ADVISOR_TTLS.baseline_ms);
  state.baselines = Object.fromEntries(Object.entries(state.baselines ?? {}).filter(([, value]) => {
    const keep = !value || !Number.isSafeInteger(value.updated_at) || now - value.updated_at < baselineTtl;
    if (!keep) baselines += 1;
    return keep;
  }));
  let recommendations = 0;
  const recommendationTtl = ttl('recommendation_ttl_ms', ADVISOR_TTLS.recommendation_ms);
  state.recommendation_history = (Array.isArray(state.recommendation_history) ? state.recommendation_history : []).filter((value) => {
    const keep = !value || !Number.isSafeInteger(value.recorded_at) || now - value.recorded_at < recommendationTtl;
    if (!keep) recommendations += 1;
    return keep;
  });
  let workflowRecommendations = 0;
  const workflowTtl = recommendationTtl;
  state.workflow_history = (Array.isArray(state.workflow_history) ? state.workflow_history : []).filter((value) => {
    const keep = !value || !Number.isSafeInteger(value.emitted_at) || now - value.emitted_at < workflowTtl;
    if (!keep) workflowRecommendations += 1;
    return keep;
  });
  const dropped = sessions + acceptance + baselines + recommendations + workflowRecommendations;
  if (dropped) increment(state.counters, 'advisor_retention_drops', dropped);
  trimAdvisorState(state);
  return { sessions, acceptance, baselines, recommendations, workflow_recommendations: workflowRecommendations, dropped };
}

export function trimAdvisorState(state) {
  if (!state || typeof state !== 'object') return state;
  const sessions = Object.entries(state.sessions ?? {})
    .filter(([key, value]) => HASH.test(key) && value && typeof value === 'object')
    .sort((a, b) => (b[1].last_event_at ?? 0) - (a[1].last_event_at ?? 0))
    .slice(0, MAX_SESSIONS)
    // Keep the most recent sessions, stored oldest first: readers take the last
    // entry as the current session and recovery keeps the last MAX_SESSIONS.
    .reverse();
  state.sessions = Object.fromEntries(sessions.map(([key, value]) => {
    value.event_counts = Object.fromEntries(Object.entries(value.event_counts ?? {}).filter(([name]) => EVENTS.has(name)).slice(-MAX_EVENT_TYPES));
    return [key, value];
  }));
  if (state.capabilities && typeof state.capabilities === 'object' && state.capabilities.records && typeof state.capabilities.records === 'object') {
    state.capabilities.records = Object.fromEntries(Object.entries(state.capabilities.records).slice(-MAX_SESSIONS));
  } else {
    state.capabilities = createCapabilityRegistry();
  }
  state.baselines = Object.fromEntries(Object.entries(state.baselines ?? {}).slice(-MAX_BASELINES));
  state.acceptance_windows = Array.isArray(state.acceptance_windows) ? state.acceptance_windows.slice(-MAX_SESSIONS) : [];
  state.recommendation_history = Array.isArray(state.recommendation_history) ? state.recommendation_history.slice(-MAX_RECOMMENDATIONS) : [];
  state.workflow_history = Array.isArray(state.workflow_history)
    ? state.workflow_history.map(normalizeWorkflowHistoryEntry).filter(Boolean).slice(-MAX_WORKFLOW_HISTORY)
    : [];
  return state;
}

export function recoverAdvisorState(value) {
  const output = createAdvisorState();
  output.capabilities = recoverCapabilityRegistry(value?.capabilities);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  const sessions = value.sessions && typeof value.sessions === 'object' ? value.sessions : {};
  for (const [key, raw] of Object.entries(sessions).slice(-MAX_SESSIONS)) {
    if (!HASH.test(key) || !raw || typeof raw !== 'object') continue;
    const state = {
      ...sessionRecord(raw.host, key, raw.opened_at),
      generation: Math.min(MAX_COUNTER, number(raw.generation) ?? 0),
      opened_at: number(raw.opened_at) ?? Date.now(),
      last_event_at: number(raw.last_event_at) ?? Date.now(),
      closure_state: CLOSURE_STATES.includes(raw.closure_state) ? raw.closure_state : 'recovered',
      closed_at: raw.closed_at === null ? null : number(raw.closed_at),
      pending_sources: raw.pending_sources === null ? null : number(raw.pending_sources),
      late_events: Math.min(MAX_COUNTER, number(raw.late_events) ?? 0),
      pending_prior_session_end_generation: null,
      pending_prior_session_end_at: null,
      pending_prior_session_end_source: null,
      event_counts: {},
      summary: null,
    };
    for (const [event, count] of Object.entries(raw.event_counts && typeof raw.event_counts === 'object' ? raw.event_counts : {}).slice(-MAX_EVENT_TYPES)) {
      if (safeEvent(event) && number(count) !== null) state.event_counts[event] = Math.min(MAX_COUNTER, count);
    }
    if (raw.summary && typeof raw.summary === 'object') state.summary = {
      receipt_count: number(raw.summary.receipt_count) ?? 0,
      exact_receipts: number(raw.summary.exact_receipts) ?? 0,
      partial_receipts: number(raw.summary.partial_receipts) ?? 0,
      unavailable_receipts: number(raw.summary.unavailable_receipts) ?? 0,
    };
    if (Number.isSafeInteger(raw.pending_prior_session_end_generation)
      && raw.pending_prior_session_end_generation >= 0
      && raw.pending_prior_session_end_generation < state.generation
      && Number.isSafeInteger(raw.pending_prior_session_end_at)
      && raw.pending_prior_session_end_at >= 0) {
      state.pending_prior_session_end_generation = raw.pending_prior_session_end_generation;
      state.pending_prior_session_end_at = raw.pending_prior_session_end_at;
      state.pending_prior_session_end_source = safeEarlyReopenSource(raw.pending_prior_session_end_source);
    }
    output.sessions[key] = state;
  }
  output.counters = {};
  for (const [key, count] of Object.entries(value.counters && typeof value.counters === 'object' ? value.counters : {}).slice(0, 64)) {
    if (/^[a-z0-9_]{1,80}$/.test(key) && number(count) !== null) output.counters[key] = Math.min(MAX_COUNTER, count);
  }
  output.acceptance_windows = recoverAcceptanceWindows(value.acceptance_windows);
  output.recommendation_history = Array.isArray(value.recommendation_history)
    ? value.recommendation_history.slice(-MAX_RECOMMENDATIONS).map((entry) => {
      const normalized = normalizeRecommendation(entry);
      return normalized
        ? { ...normalized, ...(Number.isSafeInteger(entry?.recorded_at) && entry.recorded_at >= 0 ? { recorded_at: entry.recorded_at } : {}) }
        : null;
    }).filter(Boolean)
    : [];
  output.workflow_history = Array.isArray(value.workflow_history)
    ? value.workflow_history.map(normalizeWorkflowHistoryEntry).filter(Boolean).slice(-MAX_WORKFLOW_HISTORY)
    : [];
  output.baselines = {};
  for (const [key, raw] of Object.entries(value.baselines && typeof value.baselines === 'object' ? value.baselines : {}).slice(-MAX_BASELINES)) {
    if (!/^[A-Za-z0-9._:+|-]{1,160}$/.test(key) || !raw || typeof raw !== 'object') continue;
    output.baselines[key] = {
      quality: raw.quality === 'exact' ? 'exact' : 'insufficient_data',
      sample_count: number(raw.sample_count) ?? 0,
      median: Number.isSafeInteger(raw.median) && raw.median >= 0 ? raw.median : null,
      mad: Number.isSafeInteger(raw.mad) && raw.mad >= 0 ? raw.mad : null,
      updated_at: number(raw.updated_at) ?? Date.now(),
    };
  }
  trimAdvisorState(output);
  return output;
}
