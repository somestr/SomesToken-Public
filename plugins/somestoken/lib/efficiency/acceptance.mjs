import { hashOpaqueHostIdentifier, safeOpaqueHostIdentifier, isSensitiveRuntimeValue } from '../core.mjs';

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_STATES = Object.freeze(['open', 'completed', 'interrupted', 'expired']);

const HOSTS = new Set(['codex', 'claude']);
const EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle',
  'Stop', 'StopFailure', 'MessageDisplay',
]);
const STATUSES = new Set(['started', 'completed', 'stopped', 'failure', 'pending', 'idle', 'success', 'unavailable']);
const ERROR_CATEGORIES = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed',
  'billing_error', 'invalid_request', 'model_not_found', 'server_error',
  'max_output_tokens', 'unknown',
]);
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/i;
const MAX_WINDOWS = 8;
const MAX_EVENTS = 64;
const MAX_FIELDS = 32;
const MAX_COUNTER = 1_000_000;
const MAX_ID = /^[a-f0-9]{20}$/;

function safeText(value) {
  if (typeof value !== 'string' || !SAFE_TEXT.test(value.trim())) return null;
  const normalized = value.trim();
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('..') || isSensitiveRuntimeValue(normalized)) return null;
  return normalized;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(MAX_COUNTER, value) : 0;
}

function safeId(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return MAX_ID.test(value) ? value : (safeOpaqueHostIdentifier(value)
    ? hashOpaqueHostIdentifier(value, 'acceptance-id')
    : null);
}

function safeHost(value) {
  return HOSTS.has(value) ? value : 'unknown';
}

function safeEvent(value) {
  return EVENTS.has(value) ? value : null;
}

function safeScenario(value) {
  return safeText(value) ?? 'manual';
}

function safeSha256(value) {
  return typeof value === 'string' && SAFE_SHA256.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * Live promotion is explicit and host-scoped. The checksum is a conscious
 * operator confirmation that the tested artifact was verified outside the
 * hook; SomesToken never reads package paths or computes it from host state.
 */
export function readLiveAcceptanceContext(env = {}, host) {
  const requestedHost = env && typeof env.SOMESTOKEN_ACCEPTANCE_HOST === 'string'
    ? env.SOMESTOKEN_ACCEPTANCE_HOST.trim()
    : '';
  const artifactSha256 = safeSha256(env?.SOMESTOKEN_ACCEPTANCE_ARTIFACT_SHA256);
  const rawScenario = env?.SOMESTOKEN_ACCEPTANCE_SCENARIO;
  const parsedScenario = rawScenario === undefined ? 'extended-events' : safeText(rawScenario);
  const scenario = parsedScenario ?? 'manual';
  return {
    enabled: env?.SOMESTOKEN_ACCEPTANCE_LIVE === '1'
      && HOSTS.has(host)
      && requestedHost === host
      && artifactSha256 !== null
      && parsedScenario !== null,
    scenario,
  };
}

function increment(map, key, amount = 1) {
  if (!map || !key) return;
  map[key] = Math.min(MAX_COUNTER, (map[key] ?? 0) + Math.max(0, amount));
}

function safeFieldPresence(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = {};
  const candidates = [
    'session_id', 'turn_id', 'agent_id', 'agent_type', 'tool_name', 'tool_use_id',
    'source_id', 'stop_hook_active', 'trigger', 'error_category', 'status',
    'final',
    'total_tokens', 'total_duration_ms', 'total_tool_use_count', 'resolved_model',
    'models_used', 'background', 'scheduled', 'recurring', 'structural_progress',
  ];
  for (const key of candidates.slice(0, MAX_FIELDS)) {
    const value = source[key] ?? source[key.replaceAll('_', '')];
    fields[key] = value !== undefined && value !== null;
  }
  return fields;
}

export function createAcceptanceWindow(input = {}) {
  const host = safeHost(input.host);
  const startedAt = safeTimestamp(input.started_at ?? input.timestamp) ?? Date.now();
  const scenario = safeScenario(input.scenario);
  const windowId = safeId(input.window_id ?? `${host}:${scenario}:${startedAt}`);
  return {
    acceptance_schema_version: ACCEPTANCE_SCHEMA_VERSION,
    window_id: windowId,
    host,
    host_version: safeText(input.host_version) ?? 'unknown',
    scenario,
    state: 'open',
    started_at: startedAt,
    ended_at: null,
    event_counts: {},
    observed_events: [],
    field_presence: {},
    safe_statuses: {},
    safe_error_categories: {},
    hashed_ids: [],
    dropped_events: 0,
  };
}

export function recordAcceptanceEvent(window, input = {}) {
  if (!window || typeof window !== 'object' || window.state !== 'open') return null;
  const event = safeEvent(input.event_type ?? input.hook_event_name);
  if (!event || !HOSTS.has(input.host ?? window.host) || window.event_counts && Object.values(window.event_counts).reduce((a, b) => a + b, 0) >= MAX_EVENTS) {
    window.dropped_events = Math.min(MAX_COUNTER, safeCount(window.dropped_events) + 1);
    return null;
  }
  increment(window.event_counts, event);
  if (!window.observed_events.includes(event)) window.observed_events = [...window.observed_events, event].slice(-MAX_EVENTS);
  const presence = safeFieldPresence(input);
  for (const [key, present] of Object.entries(presence)) if (present) window.field_presence[key] = true;
  const status = STATUSES.has(input.status) ? input.status : null;
  if (status) increment(window.safe_statuses, status);
  const errorCategory = ERROR_CATEGORIES.has(input.error_category) ? input.error_category : null;
  if (errorCategory) increment(window.safe_error_categories, errorCategory);
  for (const key of ['session_id', 'turn_id', 'agent_id', 'source_id', 'tool_use_id']) {
    const id = safeId(input[key]);
    if (id && !window.hashed_ids.includes(id)) window.hashed_ids = [...window.hashed_ids, id].slice(-MAX_FIELDS);
  }
  return window;
}

export function closeAcceptanceWindow(window, input = {}) {
  if (!window || typeof window !== 'object') return null;
  if (window.state !== 'open') return { ...window, event_counts: { ...(window.event_counts ?? {}) } };
  const requested = ACCEPTANCE_STATES.includes(input.state) && input.state !== 'open' ? input.state : 'completed';
  window.state = requested;
  window.ended_at = safeTimestamp(input.ended_at ?? input.timestamp) ?? Date.now();
  return window;
}

function normalizeWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const host = safeHost(value.host);
  const window = createAcceptanceWindow({
    host,
    host_version: value.host_version,
    scenario: value.scenario,
    window_id: value.window_id,
    started_at: value.started_at,
  });
  if (typeof value.window_id!=='string'||!MAX_ID.test(value.window_id)) return null;
  window.state = ACCEPTANCE_STATES.includes(value.state) ? value.state : 'interrupted';
  window.ended_at = value.ended_at === null ? null : safeTimestamp(value.ended_at);
  for (const [event, count] of Object.entries(value.event_counts ?? {}).slice(-MAX_EVENTS)) if (safeEvent(event)) window.event_counts[event] = safeCount(count);
  window.observed_events = [...new Set((Array.isArray(value.observed_events) ? value.observed_events : []).filter(safeEvent))].slice(0, MAX_EVENTS);
  for (const [field, present] of Object.entries(value.field_presence ?? {}).slice(0, MAX_FIELDS)) if (SAFE_FIELD.test(field) && !isSensitiveRuntimeValue(field) && present === true) window.field_presence[field] = true;
  for (const [status, count] of Object.entries(value.safe_statuses ?? {}).slice(0, 16)) if (STATUSES.has(status)) window.safe_statuses[status] = safeCount(count);
  for (const [category, count] of Object.entries(value.safe_error_categories ?? {}).slice(0, 16)) if (ERROR_CATEGORIES.has(category)) window.safe_error_categories[category] = safeCount(count);
  window.hashed_ids = [...new Set((Array.isArray(value.hashed_ids) ? value.hashed_ids : []).filter((entry) => typeof entry==='string'&&MAX_ID.test(entry)))].slice(0, MAX_FIELDS);
  window.dropped_events = safeCount(value.dropped_events);
  return window;
}

export function recoverAcceptanceWindows(value) {
  const rows = Array.isArray(value) ? value.slice(-MAX_WINDOWS) : [];
  return rows.map(normalizeWindow).filter(Boolean);
}
