import { hashId, hashOpaqueHostIdentifier, safeModel, isHashedIdentity } from '../core.mjs';
import { RATE_LIMIT_REACHED_TYPES } from '../hosts/codex-app-server.mjs';

export const LIMIT_RECOVERY_SCHEMA_VERSION = 2;
export const LIMIT_RECOVERY_MODES = Object.freeze(['disabled', 'host_native_observe', 'managed_companion']);
export const LIMIT_RECOVERY_STATES = Object.freeze([
  'disabled', 'armed', 'limit_observed', 'waiting_for_reset', 'reset_observed',
  'revalidating', 'resume_requested', 'resumed', 'canceled', 'expired',
  'unavailable', 'interrupted',
]);

const MODE_SET = new Set(LIMIT_RECOVERY_MODES);
const STATE_SET = new Set(LIMIT_RECOVERY_STATES);
const TERMINAL = new Set(['disabled', 'resumed', 'canceled', 'expired', 'unavailable', 'interrupted']);
const REASONS = new Set([
  'not_armed', 'invalid_arm', 'reset_time_missing', 'reset_not_elapsed',
  'limit_not_cleared', 'limit_not_observed', 'snapshot_missing', 'goal_not_active', 'thread_not_idle', 'approval_required',
  'user_activity', 'controller_conflict', 'session_closed', 'resume_already_attempted',
  'process_restarted', 'deadline_exceeded', 'protocol_mismatch', 'uncertain_resume',
  'transport_timeout', 'auth_lost', 'invalid_state', 'unknown_event',
  'ownership_unavailable', 'goal_updated', 'goal_cleared', 'thread_archived',
  'thread_deleted', 'thread_closed', 'turn_started', 'ownership_changed',
]);
const MAX_COUNTER = 1_000_000;
const MAX_HISTORY = 32;
const MAX_TERMINAL_SUMMARIES = 32;
const MAX_REASONS = 8;
const TERMINAL_TTL_SECONDS = 30 * 24 * 60 * 60;
const RATE_LIMIT_TYPE_SET = new Set(RATE_LIMIT_REACHED_TYPES);

function safeNow(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Math.floor(Date.now() / 1000);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_COUNTER) : 0;
}

function safePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function safeText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) && safeModel(value) ? value : null;
}

function safeThreadRef(value) {
  if (isHashedIdentity(value)) return value;
  return hashOpaqueHostIdentifier(value, 'codex:limit-recovery') ?? null;
}

function safeOperation(value, threadRef, now) {
  if (isHashedIdentity(value)) return value;
  return hashId(`codex:limit-recovery:${threadRef ?? 'none'}:${now}`);
}

function reasons(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((entry) => REASONS.has(entry)))].slice(0, MAX_REASONS);
}

function baseState() {
  return {
    limit_recovery_schema_version: LIMIT_RECOVERY_SCHEMA_VERSION,
    mode: 'disabled',
    state: 'disabled',
    controller_ownership: 'none',
    thread_ref: null,
    operation_id: null,
    operation_generation: 0,
    limit_source: null,
    limit_id: null,
    rate_limit_reached_type: null,
    used_percent: null,
    window_duration_mins: null,
    resets_at: null,
    snapshot_at: null,
    goal_state: null,
    thread_state: null,
    waiting_on_approval: false,
    resume_attempts: 0,
    expires_at: null,
    reason_codes: [],
    history: [],
    terminal_summaries: [],
    counters: { unknown_events: 0 },
    updated_at: 0,
  };
}

function addReason(state, reason) {
  if (REASONS.has(reason)) state.reason_codes = reasons([...state.reason_codes, reason]);
}

function addHistory(state, event, now) {
  state.history = [...(Array.isArray(state.history) ? state.history : []), {
    state: state.state,
    event: safeText(event) ?? 'unknown',
    updated_at: now,
  }].slice(-MAX_HISTORY);
}

function trimTerminalSummaries(value, now) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const entry of value) {
    if (!isHashedIdentity(entry?.operation_id)) continue;
    const updatedAt = Number.isSafeInteger(entry?.updated_at) && entry.updated_at >= 0 ? entry.updated_at : null;
    if (updatedAt === null || now - updatedAt > TERMINAL_TTL_SECONDS) continue;
    if (!TERMINAL.has(entry?.state) || entry.state === 'disabled') continue;
    const generation = safeCount(entry?.operation_generation);
    if (output.some((current) => current.operation_id === entry.operation_id && current.operation_generation === generation)) continue;
    output.push({
      operation_id: entry.operation_id,
      operation_generation: generation,
      state: entry.state,
      updated_at: updatedAt,
      resume_attempts: Math.min(1, safeCount(entry.resume_attempts)),
      reason_codes: reasons(entry.reason_codes),
    });
  }
  return output.slice(-MAX_TERMINAL_SUMMARIES);
}

function recordTerminalSummary(state, now) {
  if (!TERMINAL.has(state.state) || state.state === 'disabled' || !isHashedIdentity(state.operation_id)) return;
  const summaries = trimTerminalSummaries(state.terminal_summaries, now);
  if (!summaries.some((entry) => entry.operation_id === state.operation_id && entry.operation_generation === state.operation_generation)) {
    summaries.push({
      operation_id: state.operation_id,
      operation_generation: safeCount(state.operation_generation),
      state: state.state,
      updated_at: now,
      resume_attempts: Math.min(1, safeCount(state.resume_attempts)),
      reason_codes: reasons(state.reason_codes),
    });
  }
  state.terminal_summaries = summaries.slice(-MAX_TERMINAL_SUMMARIES);
}

function resetForArm(event, now, previous) {
  const threadRef = safeThreadRef(event.thread_ref ?? event.thread_id);
  if (event.mode !== 'managed_companion' || event.explicit_opt_in !== true || event.ownership_verified !== true || !threadRef) {
    const invalid = baseState();
    invalid.updated_at = now;
    invalid.state = event.mode === 'host_native_observe' ? 'disabled' : 'unavailable';
    invalid.mode = MODE_SET.has(event.mode) ? event.mode : 'disabled';
    invalid.controller_ownership = event.mode === 'host_native_observe' ? 'host' : 'none';
    addReason(invalid, event.ownership_verified === false ? 'ownership_unavailable' : 'invalid_arm');
    addHistory(invalid, 'arm_rejected', now);
    return invalid;
  }
  const state = baseState();
  state.terminal_summaries = trimTerminalSummaries(previous?.terminal_summaries, now);
  state.mode = 'managed_companion';
  state.state = 'armed';
  state.controller_ownership = 'somestoken';
  state.thread_ref = threadRef;
  state.operation_id = safeOperation(event.operation_id, threadRef, now);
  state.operation_generation = Math.min(MAX_COUNTER, safeCount(previous?.operation_generation) + 1);
  state.expires_at = Number.isSafeInteger(event.expires_at) && event.expires_at > now ? event.expires_at : null;
  state.updated_at = now;
  addHistory(state, 'armed', now);
  return state;
}

function limitEvent(state, event, now) {
  if (TERMINAL.has(state.state) || state.state === 'disabled') {
    addReason(state, 'not_armed');
    state.state = 'unavailable';
    return;
  }
  const reset = Number.isSafeInteger(event.resets_at) && event.resets_at > now ? event.resets_at : null;
  if (!reset) {
    state.state = 'unavailable';
    addReason(state, 'reset_time_missing');
    return;
  }
  state.state = 'waiting_for_reset';
  state.limit_source = 'codex_app_server';
  state.limit_id = safeText(event.limit_id) ?? 'codex';
  state.rate_limit_reached_type = RATE_LIMIT_TYPE_SET.has(event.rate_limit_reached_type)
    ? event.rate_limit_reached_type
    : null;
  state.used_percent = safePercent(event.used_percent);
  state.window_duration_mins = Number.isSafeInteger(event.window_duration_mins) && event.window_duration_mins > 0
    ? Math.min(event.window_duration_mins, MAX_COUNTER) : null;
  state.resets_at = reset;
  state.snapshot_at = Number.isSafeInteger(event.snapshot_at) && event.snapshot_at >= 0 ? event.snapshot_at : now;
  if (Number.isSafeInteger(event.expires_at) && event.expires_at > now) {
    state.expires_at = state.expires_at === null ? event.expires_at : Math.min(state.expires_at, event.expires_at);
  }
}

export function createLimitRecoveryState() {
  return baseState();
}

export function transitionLimitRecovery(value, event = {}, nowInput) {
  const state = trimLimitRecoveryState(value, nowInput);
  const now = safeNow(nowInput);
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const type = typeof input.type === 'string' ? input.type : '';
  if (type === 'arm') return resetForArm(input, now, state);
  // Final outcomes and their summaries stay fixed until an explicit rearm.
  // Disabled still rejects unarmed usage events, but has nothing to cancel.
  if (TERMINAL.has(state.state) && (state.state !== 'disabled' || type === 'cancel' || type === 'session_end')) return state;
  state.updated_at = now;
  if (state.expires_at !== null && now > state.expires_at && !TERMINAL.has(state.state)) {
    state.state = 'expired';
    addReason(state, 'deadline_exceeded');
    addHistory(state, 'expired', now);
    recordTerminalSummary(state, now);
    return trimLimitRecoveryState(state, now);
  }
  if (type === 'usage_limit_exceeded' || type === 'limit_observed') limitEvent(state, input, now);
  else if (type === 'reset_observed') {
    if (state.state !== 'waiting_for_reset') addReason(state, 'not_armed');
    else if (input.cleared !== true) addReason(state, 'limit_not_cleared');
    else if (!Number.isSafeInteger(state.resets_at) || now < state.resets_at) addReason(state, 'reset_not_elapsed');
    else state.state = 'reset_observed';
  } else if (type === 'revalidate') {
    if (state.state !== 'reset_observed') addReason(state, 'not_armed');
    else if (input.goal_state !== 'active') { state.state = 'canceled'; addReason(state, 'goal_not_active'); }
    else if (!['idle', 'not_loaded'].includes(input.thread_state) || input.waiting_on_approval === true) { state.state = 'canceled'; addReason(state, input.waiting_on_approval ? 'approval_required' : 'thread_not_idle'); }
    else { state.goal_state = 'active'; state.thread_state = input.thread_state; state.waiting_on_approval = input.waiting_on_approval === true; state.state = 'revalidating'; }
  } else if (type === 'resume_requested') {
    if (state.resume_attempts > 0 || state.state === 'resumed') addReason(state, 'resume_already_attempted');
    else if (state.state !== 'revalidating') addReason(state, 'not_armed');
    else { state.resume_attempts = 1; state.state = 'resume_requested'; }
  } else if (type === 'resume_succeeded') {
    if (state.state === 'resume_requested') state.state = 'resumed';
  } else if (type === 'resume_failed') {
    state.state = 'unavailable';
    addReason(state, input.uncertain === true ? 'uncertain_resume' : 'protocol_mismatch');
  } else if (type === 'unavailable') {
    state.state = 'unavailable';
    addReason(state, safeText(input.reason) ?? 'protocol_mismatch');
  } else if (type === 'cancel' || type === 'session_end') {
    state.state = 'canceled';
    addReason(state, type === 'session_end' ? 'session_closed' : safeText(input.reason) ?? 'controller_conflict');
  } else if (type === 'expire') {
    state.state = 'expired';
    addReason(state, 'deadline_exceeded');
  } else if (type === 'interrupt') {
    state.state = 'interrupted';
    addReason(state, 'process_restarted');
  } else {
    state.counters.unknown_events = Math.min(MAX_COUNTER, safeCount(state.counters.unknown_events) + 1);
    addReason(state, 'unknown_event');
  }
  addHistory(state, type || 'unknown', now);
  recordTerminalSummary(state, now);
  return trimLimitRecoveryState(state, now);
}

export function recoverLimitRecoveryState(value, nowInput, options = {}) {
  const now = safeNow(nowInput);
  const normalized = trimLimitRecoveryState(value, now);
  if (!value || typeof value !== 'object' || ![1, LIMIT_RECOVERY_SCHEMA_VERSION].includes(value.limit_recovery_schema_version)) {
    const output = baseState();
    output.state = 'unavailable';
    addReason(output, 'invalid_state');
    output.updated_at = now;
    return output;
  }
  if (options?.preserve_active !== true && !TERMINAL.has(normalized.state) && normalized.state !== 'disabled') {
    normalized.state = 'interrupted';
    addReason(normalized, 'process_restarted');
    normalized.updated_at = now;
    addHistory(normalized, 'process_restarted', now);
  }
  return normalized;
}

export function trimLimitRecoveryState(value, nowInput) {
  const now = safeNow(nowInput);
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = baseState();
  state.mode = MODE_SET.has(source.mode) ? source.mode : 'disabled';
  state.state = STATE_SET.has(source.state) ? source.state : 'unavailable';
  state.controller_ownership = source.controller_ownership === 'somestoken' || source.controller_ownership === 'host' ? source.controller_ownership : 'none';
  state.thread_ref = isHashedIdentity(source.thread_ref) ? source.thread_ref : null;
  state.operation_id = isHashedIdentity(source.operation_id) ? source.operation_id : null;
  state.operation_generation = safeCount(source.operation_generation);
  state.limit_source = source.limit_source === 'codex_app_server' ? source.limit_source : null;
  state.limit_id = safeText(source.limit_id);
  state.rate_limit_reached_type = RATE_LIMIT_TYPE_SET.has(source.rate_limit_reached_type)
    ? source.rate_limit_reached_type
    : null;
  state.used_percent = safePercent(source.used_percent);
  state.window_duration_mins = Number.isSafeInteger(source.window_duration_mins) && source.window_duration_mins > 0 ? Math.min(source.window_duration_mins, MAX_COUNTER) : null;
  for (const key of ['resets_at', 'snapshot_at', 'expires_at', 'updated_at']) {
    state[key] = Number.isSafeInteger(source[key]) && source[key] >= 0 ? Math.min(source[key], Number.MAX_SAFE_INTEGER) : key === 'updated_at' ? now : null;
  }
  state.goal_state = safeText(source.goal_state);
  state.thread_state = safeText(source.thread_state);
  state.waiting_on_approval = source.waiting_on_approval === true;
  state.resume_attempts = Math.min(1, safeCount(source.resume_attempts));
  state.reason_codes = reasons(source.reason_codes);
  state.history = Array.isArray(source.history) ? source.history.slice(-MAX_HISTORY).map((entry) => ({
    state: STATE_SET.has(entry?.state) ? entry.state : 'unavailable',
    event: safeText(entry?.event) ?? 'unknown',
    updated_at: Number.isSafeInteger(entry?.updated_at) && entry.updated_at >= 0 ? entry.updated_at : now,
  })) : [];
  state.terminal_summaries = trimTerminalSummaries(source.terminal_summaries, now);
  state.counters = { unknown_events: safeCount(source.counters?.unknown_events) };
  return state;
}

export const LIMIT_RECOVERY_REASON_CODES = Object.freeze([...REASONS]);
export const LIMIT_RECOVERY_RETENTION = Object.freeze({
  max_terminal_summaries: MAX_TERMINAL_SUMMARIES,
  terminal_ttl_seconds: TERMINAL_TTL_SECONDS,
});
