// Content-free adapter for the documented Codex App Server contract.  This
// module deliberately returns only fixed enums and bounded numeric fields so
// App Server payloads can never become SomesToken state or diagnostics.

import { safeModel } from '../core.mjs';

export const RATE_LIMIT_REACHED_TYPES = Object.freeze([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

const RATE_LIMIT_TYPE_SET = new Set(RATE_LIMIT_REACHED_TYPES);
const GOAL_STATES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const THREAD_STATES = new Set(['idle', 'notLoaded', 'systemError', 'active']);
const MAX_EPOCH = 9_007_199_254_740_991;
const REQUIRED_METHODS = Object.freeze([
  ['account_rate_limits_read', 'account/rateLimits/read'],
  ['account_rate_limits_updated', 'account/rateLimits/updated'],
  ['thread_goal_get', 'thread/goal/get'],
  ['thread_resume', 'thread/resume'],
  ['turn_start', 'turn/start'],
  ['usage_limit_exceeded', 'usageLimitExceeded'],
  ['thread_goal_updated', 'thread/goal/updated'],
  ['thread_goal_cleared', 'thread/goal/cleared'],
  ['thread_archived', 'thread/archived'],
  ['thread_deleted', 'thread/deleted'],
  ['thread_closed', 'thread/closed'],
  ['thread_status_changed', 'thread/status/changed'],
  ['turn_started', 'turn/started'],
  ['thread_started', 'thread/started'],
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH ? value : null;
}

function nowValue(value) {
  const parsed = safeInteger(value);
  return parsed === null ? Math.floor(Date.now() / 1000) : parsed;
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function window(value) {
  const source = object(value);
  const used = percent(source.usedPercent ?? source.used_percent);
  if (used === null) return null;
  const duration = source.windowDurationMins ?? source.window_duration_mins;
  const resets = source.resetsAt ?? source.resets_at;
  const output = {
    used_percent: used,
    remaining_percent: Math.max(0, 100 - used),
  };
  if (duration !== null && duration !== undefined) {
    const parsed = safeInteger(duration);
    if (parsed !== null && parsed > 0) output.window_duration_mins = parsed;
  }
  if (resets !== null && resets !== undefined) {
    const parsed = safeInteger(resets);
    if (parsed !== null) output.resets_at = parsed;
  }
  return output;
}

function sourceSnapshot(value) {
  const root = object(value);
  if (root.rateLimitsByLimitId && typeof root.rateLimitsByLimitId === 'object' && !Array.isArray(root.rateLimitsByLimitId)) {
    const buckets = root.rateLimitsByLimitId;
    return object(buckets.codex ?? buckets.primary ?? Object.values(buckets)[0]);
  }
  return object(root.rateLimits ?? root.rate_limits ?? root);
}

function normalizeSnapshotCore(value, options = {}, qualityOverride = undefined) {
  const source = sourceSnapshot(value);
  const primary = window(source.primary);
  const secondary = window(source.secondary);
  const snapshotAt = nowValue(options.now ?? options.snapshot_at);
  const reached = RATE_LIMIT_TYPE_SET.has(source.rateLimitReachedType ?? source.rate_limit_reached_type)
    ? (source.rateLimitReachedType ?? source.rate_limit_reached_type)
    : null;
  if (!primary) {
    return {
      quality: 'unavailable',
      source: 'codex_app_server',
      scope: 'account',
      reason_codes: ['rate_limit_snapshot_missing'],
    };
  }
  const output = {
    quality: qualityOverride ?? 'exact',
    source: 'codex_app_server',
    scope: 'account',
    limit_id: safeModel(source.limitId) ?? 'codex',
    primary,
    ...(secondary ? { secondary } : {}),
    ...(reached ? { rate_limit_reached_type: reached } : {}),
    snapshot_at: snapshotAt,
  };
  return output;
}

export function normalizeRateLimitSnapshot(value, options = {}) {
  return normalizeSnapshotCore(value, options);
}

// Dashboard observations keep every independently identified account bucket.
// An explicitly supplied map is authoritative, including an empty/invalid map;
// falling back could otherwise display an unrelated legacy quota as current.
export function normalizeRateLimitSnapshots(value, options = {}) {
  const root = object(value);
  const hasMap = Object.hasOwn(root, 'rateLimitsByLimitId');
  const legacy = object(root.rateLimits ?? root.rate_limits ?? root);
  const entries = hasMap
    ? Object.entries(object(root.rateLimitsByLimitId))
    : [[legacy.limitId ?? 'codex', legacy]];
  const snapshotAt = nowValue(options.now ?? options.snapshot_at);
  const snapshots = [];
  for (const [limitId, raw] of entries) {
    if (!safeModel(limitId)) continue;
    const source = object(raw);
    const primary = window(source.primary);
    const secondary = window(source.secondary);
    if (!primary && !secondary) continue;
    const reached = source.rateLimitReachedType ?? source.rate_limit_reached_type;
    snapshots.push({
      quality: 'exact',
      source: 'codex_app_server',
      scope: 'account',
      limit_id: limitId,
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(RATE_LIMIT_TYPE_SET.has(reached) ? { rate_limit_reached_type: reached } : {}),
      snapshot_at: snapshotAt,
    });
  }
  return snapshots;
}

function mergeWindow(previous, incoming) {
  const source = object(incoming);
  const output = window(previous) ?? {};
  const used = percent(source.usedPercent ?? source.used_percent);
  if (used !== null) {
    output.used_percent = used;
    output.remaining_percent = Math.max(0, 100 - used);
  }
  const duration = safeInteger(source.windowDurationMins ?? source.window_duration_mins);
  if (duration !== null && duration > 0) output.window_duration_mins = duration;
  const resets = safeInteger(source.resetsAt ?? source.resets_at);
  if (resets !== null) output.resets_at = resets;
  return Object.keys(output).length && output.used_percent !== undefined ? output : null;
}

export function normalizeRateLimitUpdate(value, previous, options = {}) {
  const prior = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null;
  const incoming = sourceSnapshot(value);
  if (!prior?.primary && !window(incoming.primary)) {
    return normalizeSnapshotCore(value, options, 'partial');
  }
  const primary = mergeWindow(prior?.primary, incoming.primary);
  const secondary = mergeWindow(prior?.secondary, incoming.secondary);
  if (!primary) {
    return {
      quality: 'unavailable',
      source: 'codex_app_server',
      scope: 'account',
      reason_codes: ['rate_limit_snapshot_missing'],
    };
  }
  const incomingReached = incoming.rateLimitReachedType ?? incoming.rate_limit_reached_type;
  const reached = RATE_LIMIT_TYPE_SET.has(incomingReached)
    ? incomingReached
    : RATE_LIMIT_TYPE_SET.has(prior?.rate_limit_reached_type) ? prior.rate_limit_reached_type : null;
  return {
    quality: 'partial',
    source: 'codex_app_server',
    scope: 'account',
    limit_id: safeModel(incoming.limitId) ?? safeModel(prior?.limit_id) ?? 'codex',
    primary,
    ...(secondary ? { secondary } : {}),
    ...(reached ? { rate_limit_reached_type: reached } : {}),
    snapshot_at: nowValue(options.now ?? options.snapshot_at),
  };
}

function errorInfo(value) {
  const root = object(value);
  const turn = object(root.turn);
  const error = object(turn.error ?? root.error);
  const info = error.codexErrorInfo ?? error.codex_error_info;
  return { failed: turn.status === 'failed' || root.status === 'failed', info };
}

export function normalizeTurnLimitFailure(value) {
  const { failed, info } = errorInfo(value);
  return {
    failed: failed && info === 'usageLimitExceeded',
    category: failed && info === 'usageLimitExceeded' ? 'usage_limit_exceeded' : 'other',
  };
}

export function normalizeGoalState(value) {
  const goal = object(value).goal;
  const status = goal && typeof goal === 'object' && !Array.isArray(goal) ? goal.status : null;
  if (!GOAL_STATES.has(status)) return { state: 'unavailable' };
  return { state: status === 'usageLimited' ? 'usage_limited' : status === 'budgetLimited' ? 'budget_limited' : status };
}

export function normalizeThreadRuntimeState(value) {
  const outer = object(value);
  // `thread/read` and `thread/resume` return a Thread envelope, while
  // `thread/status/changed` sends the status at the notification root. Both
  // are official shapes; normalize them through the same fixed projection.
  const root = object(outer.thread) && Object.keys(object(outer.thread)).length > 0 ? object(outer.thread) : outer;
  const status = object(root.status);
  const type = typeof root.status === 'string' ? root.status : status.type;
  if (!THREAD_STATES.has(type)) return { state: 'unavailable', waiting_on_approval: false };
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  const waitingOnUserInput = type === 'active' && flags.includes('waitingOnUserInput');
  return {
    state: type === 'notLoaded' ? 'not_loaded' : type === 'systemError' ? 'system_error' : type,
    waiting_on_approval: type === 'active' && flags.includes('waitingOnApproval'),
    ...(waitingOnUserInput ? { waiting_on_user_input: true } : {}),
  };
}

export function codexAppServerCapabilities(schema) {
  let text;
  try {
    text = typeof schema === 'string' ? schema : JSON.stringify(schema ?? '');
  } catch {
    text = '';
  }
  return Object.fromEntries(REQUIRED_METHODS.map(([key, method]) => [key, text.includes(method)]));
}

export function codexAppServerCompatible(schema) {
  return Object.values(codexAppServerCapabilities(schema)).every((value) => value === true);
}
