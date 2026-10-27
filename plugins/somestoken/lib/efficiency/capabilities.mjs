import { isSensitiveRuntimeValue } from '../core.mjs';

export const CAPABILITY_SCHEMA_VERSION = 1;

export const CAPABILITY_STATUSES = Object.freeze([
  'documented',
  'fixture_verified',
  'observed',
  'live_verified',
  'unavailable',
  'version_incompatible',
  'missing_required_fields',
]);

const HOSTS = new Set(['codex', 'claude']);
const SAFE_VERSION = /^[A-Za-z0-9._:+-]{1,40}$/;
const SAFE_EVENT = /^[A-Za-z][A-Za-z0-9]{1,40}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;
const MAX_CAPABILITIES = 64;
const MAX_FIELDS = 8;
const MAX_REASONS = 8;

const DEFINITIONS = Object.freeze([
  ['codex', 'SessionStart', ['session_id'], ['session_start']],
  ['codex', 'SessionEnd', ['session_id'], ['session_reconciliation']],
  ['codex', 'UserPromptSubmit', ['session_id'], ['structural_no_progress']],
  ['codex', 'PreToolUse', ['tool_name'], ['tool_cycle_churn']],
  ['codex', 'PermissionRequest', ['tool_name'], ['tool_cycle_churn']],
  ['codex', 'PostToolUse', ['tool_name'], ['tool_cycle_churn', 'structural_no_progress']],
  ['codex', 'PreCompact', ['trigger'], ['compaction_churn']],
  ['codex', 'PostCompact', ['trigger'], ['compaction_churn']],
  ['codex', 'SubagentStart', ['agent_id', 'agent_type'], ['subagent_respawn_churn', 'same_agent_type_restarted']],
  ['codex', 'SubagentStop', ['agent_id', 'agent_type'], ['subagent_stop_continuation_churn']],
  ['codex', 'Stop', ['stop_hook_active'], ['stop_continuation_churn']],
  ['claude', 'SessionStart', ['session_id'], ['session_start']],
  ['claude', 'SessionEnd', ['session_id'], ['session_reconciliation']],
  ['claude', 'UserPromptSubmit', ['session_id'], ['structural_no_progress']],
  ['claude', 'MessageDisplay', ['session_id', 'final'], []],
  ['claude', 'PreToolUse', ['tool_name'], ['tool_cycle_churn']],
  ['claude', 'PostToolUse', ['tool_name'], ['tool_cycle_churn', 'structural_no_progress']],
  ['claude', 'PostToolUseFailure', ['tool_name', 'error_category'], ['tool_failure_retry_churn']],
  ['claude', 'PostToolBatch', ['tool_name'], ['tool_cycle_churn', 'fan_out_churn']],
  ['claude', 'PreCompact', ['trigger'], ['compaction_churn']],
  ['claude', 'PostCompact', ['trigger'], ['compaction_churn']],
  ['claude', 'SubagentStart', ['agent_id', 'agent_type'], ['subagent_respawn_churn', 'same_agent_type_restarted']],
  ['claude', 'SubagentStop', ['agent_id', 'agent_type'], ['subagent_stop_continuation_churn']],
  ['claude', 'TaskCreated', ['source_id'], ['fan_out_churn']],
  ['claude', 'TaskCompleted', ['source_id'], ['fan_out_churn', 'structural_no_progress']],
  ['claude', 'TeammateIdle', ['agent_id'], ['pending_source_stall']],
  ['claude', 'Stop', ['stop_hook_active'], ['stop_continuation_churn', 'background_activity_present', 'intentional_scheduled_activity']],
  ['claude', 'StopFailure', ['error_category'], ['tool_failure_retry_churn']],
]);

function safeVersion(value) {
  return typeof value === 'string' && SAFE_VERSION.test(value) && !isSensitiveRuntimeValue(value) ? value : 'unknown';
}

function safeFields(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === 'string' && SAFE_FIELD.test(entry) && !isSensitiveRuntimeValue(entry)))].slice(0, MAX_FIELDS)
    : [];
}

function safeReasons(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === 'string' && /^[a-z0-9_]{1,80}$/.test(entry) && !isSensitiveRuntimeValue(entry)))].slice(0, MAX_REASONS)
    : [];
}

function key(host, event) {
  return `${host}.${event}`;
}

function definition(host, event) {
  const row = DEFINITIONS.find((entry) => entry[0] === host && entry[1] === event);
  if (!row) return null;
  return { host: row[0], event: row[1], required_fields: row[2], reason_codes: row[3] };
}

function normalizeRecord(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const host = HOSTS.has(source.host) ? source.host : fallback.host;
  const event = typeof source.event === 'string' && SAFE_EVENT.test(source.event) ? source.event
    : typeof fallback.event === 'string' && SAFE_EVENT.test(fallback.event) ? fallback.event : null;
  const base = definition(host, event) ?? fallback;
  if (!HOSTS.has(host) || !event) return null;
  const required = safeFields(source.required_fields?.length ? source.required_fields : base.required_fields);
  const observed = source.observed_this_session === true;
  const liveAt = Number.isSafeInteger(source.live_verified_at) && source.live_verified_at >= 0 ? source.live_verified_at : null;
  const support = CAPABILITY_STATUSES.includes(source.support) ? source.support : (source.fixture_verified === true ? 'fixture_verified' : 'documented');
  return {
    capability_id: `${host}.${event.toLowerCase()}`,
    host,
    host_version: safeVersion(source.host_version ?? fallback.host_version),
    adapter_version: Number.isSafeInteger(source.adapter_version) && source.adapter_version > 0 ? Math.min(source.adapter_version, 100) : 1,
    event,
    required_fields: required,
    documented: source.documented !== false,
    fixture_verified: source.fixture_verified !== false,
    observed_this_session: observed,
    live_verified_at: liveAt,
    support,
    reason_codes: safeReasons(source.reason_codes?.length ? source.reason_codes : base.reason_codes),
  };
}

export function createCapabilityRegistry(options = {}) {
  const versions = options.host_versions && typeof options.host_versions === 'object' ? options.host_versions : {};
  const records = {};
  for (const [host, event, fields, reasons] of DEFINITIONS.slice(0, MAX_CAPABILITIES)) {
    const record = normalizeRecord({
      host,
      event,
      host_version: versions[host],
      required_fields: fields,
      reason_codes: reasons,
      documented: true,
      fixture_verified: true,
      support: 'fixture_verified',
    });
    if (record) records[key(host, event)] = record;
  }
  return {
    capability_schema_version: CAPABILITY_SCHEMA_VERSION,
    host_versions: {
      codex: safeVersion(versions.codex),
      claude: safeVersion(versions.claude),
    },
    records,
  };
}

export function getCapability(registry, host, event) {
  if (!HOSTS.has(host) || typeof event !== 'string' || !SAFE_EVENT.test(event)) return null;
  const entry = registry?.records?.[key(host, event)] ?? normalizeRecord({ host, event }, { host, event });
  return entry ? { ...entry, required_fields: [...entry.required_fields], reason_codes: [...entry.reason_codes] } : null;
}

function hasRequired(record, fields) {
  const present = new Set(safeFields(fields));
  return record.required_fields.every((field) => present.has(field));
}

export function observeCapability(registry, observation = {}) {
  if (!registry || typeof registry !== 'object' || !HOSTS.has(observation.host) || typeof observation.event !== 'string') {
    return { support: 'unavailable', observed_this_session: false, live_verified_at: null };
  }
  registry.records ??= {};
  const record = getCapability(registry, observation.host, observation.event);
  if (!record) return { support: 'unavailable', observed_this_session: false, live_verified_at: null };
  const fields = safeFields(observation.fields);
  const complete = hasRequired(record, fields);
  if (observation.version_compatible === false) {
    const next = { ...record, support: 'version_incompatible', observed_this_session: false };
    registry.records[key(observation.host, observation.event)] = next;
    return { ...next, required_fields: [...next.required_fields], reason_codes: [...next.reason_codes] };
  }
  const live = observation.live === true;
  const at = Number.isSafeInteger(observation.at) && observation.at >= 0 ? observation.at : null;
  const next = {
    ...record,
    observed_this_session: record.observed_this_session || complete,
    support: complete ? (live ? 'live_verified' : 'observed') : 'missing_required_fields',
    live_verified_at: live && complete ? (record.live_verified_at ?? at) : record.live_verified_at,
  };
  registry.records[key(observation.host, observation.event)] = next;
  return { ...next, required_fields: [...next.required_fields], reason_codes: [...next.reason_codes] };
}

export function listCapabilities(registry) {
  return Object.values(registry?.records ?? {}).slice(0, MAX_CAPABILITIES).map((entry) => ({
    ...entry,
    required_fields: [...(entry.required_fields ?? [])],
    reason_codes: [...(entry.reason_codes ?? [])],
  }));
}

export function recoverCapabilityRegistry(value) {
  const output = createCapabilityRegistry({
    host_versions: {
      codex: value?.host_versions?.codex,
      claude: value?.host_versions?.claude,
    },
  });
  output.records = {};
  const records = value?.records && typeof value.records === 'object' ? value.records : {};
  for (const [recordKey, raw] of Object.entries(records).slice(-MAX_CAPABILITIES)) {
    const parsed = typeof recordKey === 'string' && recordKey.includes('.') ? recordKey.split('.') : [];
    const record = normalizeRecord(raw, { host: parsed[0], event: parsed.slice(1).join('.') });
    if (!record || record.host !== parsed[0] || record.event !== parsed.slice(1).join('.')) continue;
    output.records[recordKey] = record;
  }
  return output;
}
