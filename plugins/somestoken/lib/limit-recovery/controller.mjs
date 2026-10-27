import {
  normalizeGoalState,
  normalizeRateLimitSnapshot,
  normalizeThreadRuntimeState,
} from '../hosts/codex-app-server.mjs';
import {
  createLimitRecoveryState,
  transitionLimitRecovery,
  trimLimitRecoveryState,
} from './state.mjs';

const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 30_000;
const RESET_SETTLEMENT_MS = 15 * 60 * 1000;
const FIXED_MODES = new Set(['disabled', 'host_native_observe', 'managed_companion']);
const CANCELLATION_REASONS = new Set([
  'user_activity', 'goal_updated', 'goal_cleared', 'thread_archived',
  'thread_deleted', 'thread_closed', 'turn_started', 'ownership_changed',
  'approval_required', 'thread_not_idle', 'session_closed', 'controller_conflict',
]);

function nowSeconds(value) {
  const raw = typeof value === 'function' ? value() : value;
  if (Number.isSafeInteger(raw) && raw >= 0) return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  return Math.floor(Date.now() / 1000);
}

function safeConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = FIXED_MODES.has(source.mode) ? source.mode : 'disabled';
  const maxWait = Number.isSafeInteger(source.max_wait_ms) && source.max_wait_ms >= 1 && source.max_wait_ms <= MAX_WAIT_MS
    ? source.max_wait_ms : 6 * 60 * 60 * 1000;
  const grace = Number.isSafeInteger(source.reset_grace_ms) && source.reset_grace_ms >= 0 && source.reset_grace_ms <= 5 * 60 * 1000
    ? source.reset_grace_ms : DEFAULT_GRACE_MS;
  return { mode, max_wait_ms: maxWait, reset_grace_ms: grace, max_resume_attempts: 1, require_active_goal: true };
}

function result(state, ok, outcome) {
  return { ok, outcome, state, reason_codes: [...(state.reason_codes ?? [])] };
}

function callObserver(onState, state) {
  if (typeof onState !== 'function') return;
  try { onState(state); } catch { /* observers are report-only */ }
}

function errorReason(error) {
  if (error?.code === 'uncertain_mutation') return 'uncertain_resume';
  if (error?.code === 'request_timeout') return 'transport_timeout';
  if (error?.code === 'auth_lost') return 'auth_lost';
  return 'protocol_mismatch';
}

function primarySnapshot(raw, now) {
  const normalized = normalizeRateLimitSnapshot(raw, { now });
  if (normalized.quality === 'unavailable') return normalized;
  const primary = normalized.primary ?? {};
  return {
    normalized,
    used_percent: primary.used_percent,
    resets_at: primary.resets_at,
    reached: normalized.rate_limit_reached_type !== undefined || primary.used_percent >= 100,
  };
}

function resetCleared(snapshot) {
  return snapshot && snapshot.reached === false && typeof snapshot.used_percent === 'number' && snapshot.used_percent < 100;
}

function fixedCancellationReason(value) {
  return CANCELLATION_REASONS.has(value) ? value : null;
}

async function cancellationReason(options) {
  if (typeof options?.getCancellationReason === 'function') {
    try {
      const reason = fixedCancellationReason(await options.getCancellationReason());
      if (reason) return reason;
    } catch {
      return 'controller_conflict';
    }
  }
  if (options?.user_activity === true || options?.signal?.aborted) return 'user_activity';
  if (typeof options?.isUserActive !== 'function') return null;
  try {
    return (await options.isUserActive()) === true ? 'user_activity' : null;
  } catch {
    return 'controller_conflict';
  }
}

async function checkpoint(state, event, now, options) {
  const next = transitionLimitRecovery(state, event, now);
  if (typeof options.persistState !== 'function') {
    callObserver(options.onState, next);
    return { ok: true, state: next };
  }
  let persisted;
  try {
    persisted = await options.persistState(next);
  } catch {
    persisted = { ok: false };
  }
  if (persisted?.ok === true) {
    callObserver(options.onState, next);
    return { ok: true, state: next };
  }
  // A state-store CAS loser (for example SessionEnd) owns the terminal state.
  // Never write over it and never issue the pending host mutation.
  const current = persisted?.state && typeof persisted.state === 'object'
    ? trimLimitRecoveryState(persisted.state, now)
    : transitionLimitRecovery(next, { type: 'cancel', reason: 'controller_conflict' }, now);
  callObserver(options.onState, current);
  return { ok: false, state: current, canceled: persisted?.canceled === true || current.state === 'canceled' };
}

function waitForEvidence(channel, args) {
  if (typeof channel !== 'function') return Promise.resolve({ timeout: true });
  return channel(args);
}

/**
 * In-memory, content-free event latches for one controller process. The
 * channel deliberately accepts only already-sanitized transport projections.
 */
export function createLimitRecoveryEventChannel() {
  let usageLimitObserved = false;
  let cancellation = null;
  let lastClear = null;
  let ownTurnStartRequested = false;
  const usageWaiters = new Set();
  const clearListeners = new Set();

  const settleUsage = () => {
    for (const resolve of usageWaiters) resolve({ category: 'usage_limit_exceeded' });
    usageWaiters.clear();
  };
  const setCancellation = (reason) => {
    const fixed = fixedCancellationReason(reason);
    if (!fixed || cancellation) return;
    cancellation = fixed;
    for (const resolve of usageWaiters) resolve({ canceled: true, reason: fixed });
    usageWaiters.clear();
  };
  const observe = (notification) => {
    const event = notification && typeof notification === 'object' ? notification : {};
    if (event.method === 'turn/completed' && event.target === true && event.category === 'usage_limit_exceeded' && event.failed === true) {
      usageLimitObserved = true;
      settleUsage();
      return;
    }
    if (event.method === 'account/rateLimits/updated') {
      const normalized = event.normalized;
      if (typeof normalized?.used_percent === 'number' && normalized.used_percent < 100) {
        lastClear = normalized;
        for (const listener of clearListeners) listener(normalized);
      }
      return;
    }
    if (event.target !== true) return;
    if (event.method === 'thread/goal/updated') setCancellation('goal_updated');
    else if (event.method === 'thread/goal/cleared') setCancellation('goal_cleared');
    else if (event.method === 'thread/archived') setCancellation('thread_archived');
    else if (event.method === 'thread/deleted') setCancellation('thread_deleted');
    else if (event.method === 'thread/closed') setCancellation('thread_closed');
    else if (event.method === 'turn/started' && !ownTurnStartRequested) setCancellation('turn_started');
    else if (event.method === 'thread/status/changed') {
      setCancellation(event.waiting_on_approval === true ? 'approval_required' : 'thread_not_idle');
    }
  };
  return {
    observe,
    markOwnTurnStart: () => { ownTurnStartRequested = true; },
    cancellationReason: () => cancellation,
    waitForUsageLimit: ({ signal } = {}) => new Promise((resolve, reject) => {
      if (cancellation) { resolve({ canceled: true, reason: cancellation }); return; }
      if (usageLimitObserved) { resolve({ category: 'usage_limit_exceeded' }); return; }
      const onAbort = () => {
        usageWaiters.delete(onUsage);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      const onUsage = (value) => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      usageWaiters.add(onUsage);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    }),
    onClear: (listener) => {
      if (typeof listener !== 'function') return () => {};
      clearListeners.add(listener);
      if (lastClear) listener(lastClear);
      return () => clearListeners.delete(listener);
    },
  };
}

/**
 * Run one bounded recovery attempt. The caller owns timers, persistence and
 * the App Server process. This module never starts a scheduler or parses host
 * content; a missing ownership proof is terminal before the first transport
 * request.
 */
export async function runLimitRecoveryController(options = {}) {
  const config = safeConfig(options.config);
  const explicitOptIn = options.explicit_opt_in === true;
  const transport = options.transport;
  const threadId = typeof options.thread_id === 'string' && options.thread_id.length > 0 ? options.thread_id : null;
  let now = nowSeconds(options.now);
  let state = createLimitRecoveryState();

  let updated = await checkpoint(state, {
    type: 'arm',
    mode: config.mode,
    explicit_opt_in: explicitOptIn,
    ownership_verified: options.ownership_verified === true,
    thread_id: threadId,
    operation_id: options.operation_id,
    expires_at: now + Math.ceil(config.max_wait_ms / 1000),
  }, now, options);
  state = updated.state;
  if (!updated.ok || state.state !== 'armed') {
    return result(state, false, state.reason_codes.includes('ownership_unavailable') ? 'ownership_unavailable' : state.state === 'disabled' ? 'disabled' : 'unavailable');
  }
  if (!transport || typeof transport.readRateLimits !== 'function') {
    updated = await checkpoint(state, { type: 'cancel', reason: 'controller_conflict' }, now, options);
    return result(updated.state, false, 'unavailable');
  }

  let initial;
  try {
    initial = primarySnapshot(await transport.readRateLimits(), now);
  } catch (error) {
    updated = await checkpoint(state, { type: 'resume_failed', uncertain: false, reason: errorReason(error) }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  if (!initial.normalized || initial.normalized.quality === 'unavailable') {
    updated = await checkpoint(state, { type: 'cancel', reason: 'snapshot_missing' }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  if (!initial.reached) {
    updated = await checkpoint(state, { type: 'cancel', reason: 'limit_not_observed' }, now, options);
    return result(updated.state, false, 'limit_not_observed');
  }
  if (!Number.isSafeInteger(initial.resets_at) || initial.resets_at <= now) {
    updated = await checkpoint(state, { type: 'unavailable', reason: 'reset_time_missing' }, now, options);
    return result(updated.state, false, 'unavailable');
  }

  const evidence = await waitForEvidence(options.waitForUsageLimit, { signal: options.signal, deadline: state.expires_at });
  const canceledDuringEvidence = fixedCancellationReason(evidence?.reason) ?? await cancellationReason(options);
  if (canceledDuringEvidence) {
    updated = await checkpoint(state, { type: 'cancel', reason: canceledDuringEvidence }, now, options);
    return result(updated.state, false, 'canceled');
  }
  if (evidence?.category !== 'usage_limit_exceeded') {
    updated = await checkpoint(state, { type: 'unavailable', reason: 'limit_not_observed' }, now, options);
    return result(updated.state, false, 'limit_not_observed');
  }

  const graceSeconds = Math.ceil(config.reset_grace_ms / 1000);
  const limitDeadline = Math.min(
    state.expires_at ?? now,
    initial.resets_at + graceSeconds + Math.ceil(RESET_SETTLEMENT_MS / 1000),
  );
  updated = await checkpoint(state, {
    type: 'usage_limit_exceeded',
    limit_id: initial.normalized.limit_id,
    rate_limit_reached_type: initial.normalized.rate_limit_reached_type,
    used_percent: initial.used_percent,
    window_duration_mins: initial.normalized.primary?.window_duration_mins,
    resets_at: initial.resets_at,
    snapshot_at: initial.normalized.snapshot_at,
    expires_at: limitDeadline,
  }, now, options);
  state = updated.state;
  if (!updated.ok || state.state !== 'waiting_for_reset') return result(state, false, updated.canceled ? 'canceled' : 'unavailable');

  const beforeWait = await cancellationReason(options);
  if (beforeWait) {
    updated = await checkpoint(state, { type: 'cancel', reason: beforeWait }, now, options);
    return result(updated.state, false, 'canceled');
  }
  if (typeof options.waitForReset !== 'function') return result(state, false, 'waiting_for_reset');
  let waited;
  try {
    waited = await options.waitForReset({
      resets_at: initial.resets_at,
      reset_grace_ms: config.reset_grace_ms,
      deadline: state.expires_at,
      signal: options.signal,
    });
  } catch (error) {
    const reason = await cancellationReason(options) ?? (error?.name === 'AbortError' ? 'user_activity' : 'transport_timeout');
    updated = await checkpoint(state, { type: 'cancel', reason }, now, options);
    return result(updated.state, false, 'canceled');
  }
  now = nowSeconds(waited?.now ?? options.now);
  if (waited === false || waited?.timeout === true || now > (state.expires_at ?? now)) {
    updated = await checkpoint(state, { type: 'expire' }, now, options);
    return result(updated.state, false, 'expired');
  }
  const afterWait = await cancellationReason(options);
  if (afterWait) {
    updated = await checkpoint(state, { type: 'cancel', reason: afterWait }, now, options);
    return result(updated.state, false, 'canceled');
  }

  let cleared;
  try {
    cleared = primarySnapshot(await transport.readRateLimits(), now);
  } catch (error) {
    updated = await checkpoint(state, { type: 'cancel', reason: errorReason(error) }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  if (!cleared.normalized || cleared.normalized.quality === 'unavailable') {
    updated = await checkpoint(state, { type: 'cancel', reason: 'snapshot_missing' }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  updated = await checkpoint(state, { type: 'reset_observed', cleared: resetCleared(cleared) }, now, options);
  state = updated.state;
  if (!updated.ok || state.state !== 'reset_observed') return result(state, false, state.state === 'waiting_for_reset' ? 'waiting_for_reset' : 'canceled');

  if (typeof transport.readGoal !== 'function' || typeof transport.readThread !== 'function') {
    updated = await checkpoint(state, { type: 'cancel', reason: 'protocol_mismatch' }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  const readRuntime = async () => {
    const [goalRaw, threadRaw] = await Promise.all([transport.readGoal(threadId), transport.readThread(threadId)]);
    return { goal: normalizeGoalState(goalRaw), thread: normalizeThreadRuntimeState(threadRaw) };
  };
  let runtime;
  try { runtime = await readRuntime(); } catch (error) {
    updated = await checkpoint(state, { type: 'cancel', reason: errorReason(error) }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  const validRuntime = runtime.goal.state === 'active'
    && ['idle', 'not_loaded'].includes(runtime.thread.state)
    && runtime.thread.waiting_on_approval !== true
    && runtime.thread.waiting_on_user_input !== true;
  if (!validRuntime) {
    updated = await checkpoint(state, {
      type: 'revalidate',
      goal_state: runtime.goal.state,
      thread_state: runtime.thread.state,
      waiting_on_approval: runtime.thread.waiting_on_approval === true || runtime.thread.waiting_on_user_input === true,
    }, now, options);
    return result(updated.state, false, 'canceled');
  }
  updated = await checkpoint(state, { type: 'revalidate', goal_state: 'active', thread_state: runtime.thread.state }, now, options);
  state = updated.state;
  if (!updated.ok || state.state !== 'revalidating') return result(state, false, 'canceled');

  if (typeof transport.resumeThread !== 'function' || typeof transport.startTurn !== 'function') {
    updated = await checkpoint(state, { type: 'resume_failed', uncertain: false }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  // This durable checkpoint is intentionally before both host mutations. A
  // crash or CAS loss after it makes the operation terminal, never retryable.
  updated = await checkpoint(state, { type: 'resume_requested' }, now, options);
  state = updated.state;
  if (!updated.ok || state.state !== 'resume_requested') return result(state, false, updated.canceled ? 'canceled' : 'unavailable');
  const beforeResume = await cancellationReason(options);
  if (beforeResume) {
    updated = await checkpoint(state, { type: 'cancel', reason: beforeResume }, now, options);
    return result(updated.state, false, 'canceled');
  }
  try {
    await transport.resumeThread(threadId);
    runtime = await readRuntime();
  } catch (error) {
    updated = await checkpoint(state, { type: 'resume_failed', uncertain: error?.code === 'uncertain_mutation', reason: errorReason(error) }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  if (runtime.goal.state !== 'active' || !['idle', 'not_loaded'].includes(runtime.thread.state)
    || runtime.thread.waiting_on_approval === true || runtime.thread.waiting_on_user_input === true) {
    updated = await checkpoint(state, { type: 'cancel', reason: runtime.goal.state !== 'active' ? 'goal_not_active' : 'thread_not_idle' }, now, options);
    return result(updated.state, false, 'canceled');
  }
  const beforeStart = await cancellationReason(options);
  if (beforeStart) {
    updated = await checkpoint(state, { type: 'cancel', reason: beforeStart }, now, options);
    return result(updated.state, false, 'canceled');
  }
  try {
    try { options.markOwnTurnStart?.(); } catch { /* marker cannot grant mutation */ }
    await transport.startTurn(threadId);
  } catch (error) {
    updated = await checkpoint(state, { type: 'resume_failed', uncertain: error?.code === 'uncertain_mutation', reason: errorReason(error) }, now, options);
    return result(updated.state, false, 'unavailable');
  }
  updated = await checkpoint(state, { type: 'resume_succeeded' }, now, options);
  return result(updated.state, updated.ok && updated.state.state === 'resumed', updated.ok ? 'resumed' : 'unavailable');
}
