import { hashOpaqueHostIdentifier } from '../core.mjs';
import { normalizeObservedUsage } from '../usage/schema.mjs';
import { ERROR_CATEGORIES, normalizeEfficiencyEvent } from '../efficiency/schema.mjs';

const EVENT_TYPES = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'TeammateIdle', 'PreCompact', 'PostCompact', 'Notification', 'MessageDisplay',
]);
const AUTH_MODES = new Set(['subscription', 'api', 'bedrock', 'vertex']);
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_STATUS = new Set(['started', 'completed', 'stopped', 'failure', 'pending', 'idle', 'success', 'unavailable']);

function text(value) {
  if (typeof value !== 'string' || !SAFE_TEXT.test(value.trim())) return undefined;
  const normalized = value.trim();
  return normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('..') ? undefined : normalized;
}

function identifier(value, kind = 'id') {
  return hashOpaqueHostIdentifier(value, kind === 'session' ? 'claude' : `claude:${kind}`);
}

function agentStructuredValue(source, key, camelKey) {
  const nested = [source.tool_response, source.agent_output, source.agent]
    .find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? {};
  return source[key] ?? source[camelKey] ?? nested[key] ?? nested[camelKey];
}

function isAgentPostToolUse(source, eventType) {
  return eventType === 'PostToolUse' && source?.tool_name === 'Agent';
}

export function detectClaudeAuthMode(input = {}, env = {}) {
  const declared = input?.authentication_mode ?? input?.auth_mode;
  if (AUTH_MODES.has(declared)) return declared;
  if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0) return 'api';
  if (env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 'true') return 'bedrock';
  if (env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_VERTEX === 'true') return 'vertex';
  return 'unknown';
}

export function normalizeClaudeHook(input = {}, env = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const eventType = source.hook_event_name ?? source.event_type;
  if (!EVENT_TYPES.has(eventType)) return null;
  const output = {
    host: 'claude',
    event_type: eventType,
    ...(identifier(source.session_id, 'session') ? { session: identifier(source.session_id, 'session') } : {}),
    ...(identifier(source.session_id, 'session-scope') ? { scope_id: identifier(source.session_id, 'session-scope') } : {}),
    ...(identifier(source.turn_id, 'turn') ? { turn_id: identifier(source.turn_id, 'turn') } : {}),
    ...(identifier(source.agent_id, 'agent') ? { agent_id: identifier(source.agent_id, 'agent') } : {}),
    ...(identifier(source.tool_use_id ?? source.toolUseId, 'tool-use') ? { tool_use_id: identifier(source.tool_use_id ?? source.toolUseId, 'tool-use') } : {}),
    ...(identifier(source.task_id ?? source.taskId ?? source.source_id, 'task') ? { source_id: identifier(source.task_id ?? source.taskId ?? source.source_id, 'task') } : {}),
  };
  for (const key of ['agent_type', 'tool_name']) {
    const safe = text(source[key]);
    if (safe) output[key] = safe;
  }
  if (source.stop_hook_active === true || source.stop_hook_active === false) output.stop_hook_active = source.stop_hook_active;
  if (source.final === true || source.final === false) output.final = source.final;
  if (source.structural_progress === true || source.structural_progress === false) output.structural_progress = source.structural_progress;
  if (source.background === true || (Array.isArray(source.background_tasks) && source.background_tasks.length)) output.background = true;
  if (Array.isArray(source.session_crons) && source.session_crons.length) {
    output.scheduled = true;
    output.recurring = true;
  }
  if (source.scheduled === true) output.scheduled = true;
  if (source.recurring === true) output.recurring = true;
  if (SAFE_STATUS.has(source.status)) output.status = source.status;
  if (source.trigger === 'manual' || source.trigger === 'auto') output.trigger = source.trigger;
  const errorCategory = source.error_category ?? source.error;
  if (ERROR_CATEGORIES.has(errorCategory)) output.error_category = errorCategory;
  else if (eventType === 'StopFailure' && typeof errorCategory === 'string' && errorCategory.trim()) output.error_category = 'unknown';
  if (Number.isSafeInteger(source.timestamp) && source.timestamp >= 0) output.timestamp = source.timestamp;
  for (const key of ['count', 'pending_age_ms', 'unresolved_source_count', 'child_count']) {
    if (Number.isSafeInteger(source[key]) && source[key] >= 0) output[key] = source[key];
  }
  if (typeof source.usage_pressure_percent === 'number' && Number.isFinite(source.usage_pressure_percent) && source.usage_pressure_percent >= 0) output.usage_pressure_percent = source.usage_pressure_percent;
  if (source.usage_outlier === true || source.usage_outlier === false) output.usage_outlier = source.usage_outlier;
  // Claude documents these values for successful Agent PostToolUse output.
  // They describe the final request only, not the whole subagent run, so this
  // normalized event is structural telemetry and never a token receipt.
  if (isAgentPostToolUse(source, eventType)) {
    const agentId = identifier(agentStructuredValue(source, 'agent_id', 'agentId'));
    if (agentId) output.agent_id = agentId;
    for (const [outputKey, key, camelKey] of [
      ['total_tokens', 'total_tokens', 'totalTokens'],
      ['total_duration_ms', 'total_duration_ms', 'totalDurationMs'],
      ['total_tool_use_count', 'total_tool_use_count', 'totalToolUseCount'],
    ]) {
      const value = agentStructuredValue(source, key, camelKey);
      if (Number.isSafeInteger(value) && value >= 0) output[outputKey] = value;
    }
    const resolvedModel = text(agentStructuredValue(source, 'resolved_model', 'resolvedModel'));
    if (resolvedModel) output.resolved_model = resolvedModel;
    const rawModels = agentStructuredValue(source, 'models_used', 'modelsUsed');
    if (Array.isArray(rawModels)) {
      const models = rawModels.map(text).filter(Boolean).slice(0, 8);
      if (models.length) output.models_used = [...new Set(models)];
    }
  }
  return normalizeEfficiencyEvent(output);
}

export function normalizeClaudeUsage(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const input = Number.isSafeInteger(source.input_tokens) && source.input_tokens >= 0 ? source.input_tokens : null;
  const cached = Number.isSafeInteger(source.cache_read_input_tokens ?? source.cached_input_tokens ?? 0)
    && (source.cache_read_input_tokens ?? source.cached_input_tokens ?? 0) >= 0
    ? source.cache_read_input_tokens ?? source.cached_input_tokens ?? 0 : null;
  const rawCacheWrite = source.cache_creation_input_tokens ?? source.cache_write_input_tokens;
  const cacheWrite = rawCacheWrite === undefined || rawCacheWrite === null
    ? null
    : Number.isSafeInteger(rawCacheWrite) && rawCacheWrite >= 0 ? rawCacheWrite : null;
  const output = Number.isSafeInteger(source.output_tokens) && source.output_tokens >= 0 ? source.output_tokens : null;
  if ([input, cached, output].some((entry) => entry === null)) return { quality: 'unavailable', coverage: 'unavailable' };
  const aggregateInput = input + cached;
  const aggregateTotal = aggregateInput + output;
  if (!Number.isSafeInteger(aggregateInput) || !Number.isSafeInteger(aggregateTotal)) {
    return { quality: 'unavailable', coverage: 'unavailable' };
  }
  // Keep cache creation observed but outside total usage until a versioned
  // provider contract explicitly prices it as part of the aggregate.
  return normalizeObservedUsage({
    input_tokens: aggregateInput,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: aggregateTotal,
    cache_write_input_tokens: cacheWrite,
  }, { quality: 'exact', coverage: 'turn_only' });
}

/**
 * Upgrade only the one legacy Claude shape that is arithmetically provable:
 * old persisted records kept raw uncached input as `input_tokens`, retained a
 * separate cache-read counter, and made `total_tokens === input + output`.
 *
 * Current Claude normalization already persists aggregate input, so this is a
 * recovery-only adapter helper. Returning null rather than guessing preserves
 * ordinary cache anomalies as partial evidence.
 */
export function recoverLegacyClaudeCacheReadUsage(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const input = source.input_tokens;
  const cached = source.cached_input_tokens;
  const output = source.output_tokens;
  const total = source.total_tokens;
  if (![input, cached, output, total].every((entry) => Number.isSafeInteger(entry) && entry >= 0)) return null;
  // A current normalized Claude record always has cached input as a subset of
  // aggregate input. This pattern proves the persisted counters used the older
  // raw-input convention, while preserving the explicit raw audit counters.
  if (cached <= input || total !== input + output) return null;
  const aggregateInput = input + cached;
  const aggregateTotal = aggregateInput + output;
  if (!Number.isSafeInteger(aggregateInput) || !Number.isSafeInteger(aggregateTotal)) return null;
  return {
    input_tokens: aggregateInput,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: aggregateTotal,
    consistent: true,
  };
}

export function claudeCapabilities() {
  return {
    host: 'claude',
    hook_events: [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
      'PostToolUseFailure', 'PostToolBatch', 'SubagentStart', 'SubagentStop',
      'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'StopFailure',
      'PreCompact', 'PostCompact', 'MessageDisplay',
    ],
    fixture_evidence: 'pass',
    live_evidence: 'pending',
    structured_lifecycle: true,
    token_snapshots: true,
    subscription_quota_snapshot: false,
    api_cost_fields: false,
    reset_timestamps: false,
    shared_pool_scope: 'unknown',
    cache_semantics: claudeCacheSemantics(),
  };
}

export function claudeCacheSemantics() {
  return {
    cache_read_semantics: 'normalized_input_includes_cache_read',
    cache_write_semantics: 'observed_not_priced',
    input_includes_cache_read: true,
    input_excludes_cache_read: false,
    denominator_supported: true,
  };
}
