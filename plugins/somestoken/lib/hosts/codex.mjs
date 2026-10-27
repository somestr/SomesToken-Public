import { hashOpaqueHostIdentifier } from '../core.mjs';
import { normalizeObservedUsage } from '../usage/schema.mjs';
import { ERROR_CATEGORIES, normalizeEfficiencyEvent } from '../efficiency/schema.mjs';

export const CODEX_HOOK_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
]);
const EVENT_TYPES = new Set(CODEX_HOOK_EVENTS);
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_STATUS = new Set(['started', 'completed', 'stopped', 'failure', 'pending', 'idle', 'success', 'unavailable']);

function text(value) {
  if (typeof value !== 'string' || !SAFE_TEXT.test(value.trim())) return undefined;
  const normalized = value.trim();
  return normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('..') ? undefined : normalized;
}

function identifier(value, kind = 'id') {
  return hashOpaqueHostIdentifier(value, kind === 'session' ? 'codex' : `codex:${kind}`);
}

export function normalizeCodexHook(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const eventType = source.hook_event_name ?? source.event_type;
  if (!EVENT_TYPES.has(eventType)) return null;
  const output = {
    host: 'codex',
    event_type: eventType,
    ...(identifier(source.session_id, 'session') ? { session: identifier(source.session_id, 'session') } : {}),
    ...(identifier(source.session_id, 'session-scope') ? { scope_id: identifier(source.session_id, 'session-scope') } : {}),
    ...(identifier(source.turn_id, 'turn') ? { turn_id: identifier(source.turn_id, 'turn') } : {}),
    ...(identifier(source.turn_id, 'turn') ? { source_id: identifier(source.turn_id, 'turn') } : {}),
    ...(identifier(source.agent_id, 'agent') ? { agent_id: identifier(source.agent_id, 'agent') } : {}),
    ...(identifier(source.tool_use_id ?? source.toolUseId, 'tool-use') ? { tool_use_id: identifier(source.tool_use_id ?? source.toolUseId, 'tool-use') } : {}),
    ...(identifier(source.task_id ?? source.taskId ?? source.source_id, 'task') ? { source_id: identifier(source.task_id ?? source.taskId ?? source.source_id, 'task') } : {}),
  };
  for (const key of ['agent_type', 'tool_name']) {
    const safe = text(source[key]);
    if (safe) output[key] = safe;
  }
  if (source.stop_hook_active === true || source.stop_hook_active === false) output.stop_hook_active = source.stop_hook_active;
  if (source.structural_progress === true || source.structural_progress === false) output.structural_progress = source.structural_progress;
  if (SAFE_STATUS.has(source.status)) output.status = source.status;
  if (source.background === true || (source.background_tasks && Array.isArray(source.background_tasks) && source.background_tasks.length)) output.background = true;
  if (source.scheduled === true || (source.session_crons && Array.isArray(source.session_crons) && source.session_crons.length)) output.scheduled = true;
  if (source.recurring === true) output.recurring = true;
  if (source.trigger === 'manual' || source.trigger === 'auto') output.trigger = source.trigger;
  if (ERROR_CATEGORIES.has(source.error)) output.error_category = source.error;
  for (const key of ['count', 'pending_age_ms', 'unresolved_source_count', 'child_count']) {
    if (Number.isSafeInteger(source[key]) && source[key] >= 0) output[key] = source[key];
  }
  if (typeof source.usage_pressure_percent === 'number' && Number.isFinite(source.usage_pressure_percent) && source.usage_pressure_percent >= 0) output.usage_pressure_percent = source.usage_pressure_percent;
  if (source.usage_outlier === true || source.usage_outlier === false) output.usage_outlier = source.usage_outlier;
  if (Number.isSafeInteger(source.timestamp) && source.timestamp >= 0) output.timestamp = source.timestamp;
  return normalizeEfficiencyEvent(output);
}

export function normalizeCodexUsage(value) {
  return normalizeObservedUsage(value, {
    quality: value?.quality,
    coverage: value?.coverage ?? 'turn_only',
  });
}

export function codexCapabilities() {
  return {
    host: 'codex',
    hook_events: [...CODEX_HOOK_EVENTS],
    fixture_evidence: 'pass',
    live_evidence: 'pending',
    structured_lifecycle: true,
    token_snapshots: true,
    quota_snapshot: false,
    subscription_usage: false,
    reset_timestamps: false,
    shared_pool_scope: 'unknown',
    cache_semantics: codexCacheSemantics(),
  };
}

export function codexCacheSemantics() {
  return {
    cache_read_semantics: 'cached_input_subset_of_input',
    cache_write_semantics: 'observed_not_priced',
    input_includes_cache_read: true,
    input_excludes_cache_read: false,
    denominator_supported: true,
  };
}
