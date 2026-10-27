import { safeModel, isHashedIdentity } from '../core.mjs';

export const EFFICIENCY_SCHEMA_VERSION = 1;

export const CLASSIFICATIONS = Object.freeze([
  'normal',
  'watch',
  'likely_loop',
  'runaway_risk',
  'intentional_recurring_activity',
  'insufficient_evidence',
]);

export const REASON_CODES = Object.freeze([
  'stop_continuation_churn',
  'subagent_stop_continuation_churn',
  'subagent_respawn_churn',
  'same_agent_type_restarted',
  'tool_cycle_churn',
  'tool_failure_retry_churn',
  'pending_source_stall',
  'structural_no_progress',
  'fan_out_churn',
  'compaction_churn',
  'repeated_warning_window',
  'background_activity_present',
  'intentional_scheduled_activity',
  'usage_outlier',
  'high_plan_pressure',
  'quota_near_limit',
  'quota_exhausted',
]);

const CLASSIFICATION_SET = new Set(CLASSIFICATIONS);
const REASON_SET = new Set(REASON_CODES);
const EVENT_TYPES = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'TeammateIdle', 'PreCompact', 'PostCompact', 'Notification', 'MessageDisplay',
]);
const HOSTS = new Set(['codex', 'claude']);
const STATUSES = new Set(['started', 'completed', 'stopped', 'failure', 'pending', 'idle', 'success', 'unavailable']);
const ERROR_CATEGORIES = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed',
  'billing_error', 'invalid_request', 'model_not_found', 'server_error',
  'max_output_tokens', 'unknown',
]);
// Structural labels are persisted and reported; free-form host strings do
// not belong in this boundary.
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;
const PROVENANCE_QUALITIES = new Set(['documented', 'fixture_verified', 'observed', 'live_verified', 'insufficient_evidence']);
const PROVENANCE_SUPPORT = new Set(['documented', 'fixture_verified', 'observed', 'live_verified', 'unavailable', 'version_incompatible', 'missing_required_fields']);

function safeText(value) {
  if (typeof value !== 'string' || !SAFE_TEXT.test(value.trim())) return undefined;
  const normalized = value.trim();
  return normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('..') || !safeModel(normalized) ? undefined : normalized;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : undefined;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Convert a host event into a content-free structural event. */
export function normalizeEfficiencyEvent(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  if (EVENT_TYPES.has(source.event_type)) output.event_type = source.event_type;
  else return null;
  if (HOSTS.has(source.host)) output.host = source.host;
  else return null;
  for (const key of ['session', 'scope_id', 'turn_id', 'source_id', 'agent_id', 'tool_use_id']) {
    if (isHashedIdentity(source[key])) output[key] = source[key];
  }
  for (const key of ['agent_type', 'tool_name']) {
    const safe = safeText(source[key]);
    if (safe) output[key] = safe;
  }
  if (STATUSES.has(source.status)) output.status = source.status;
  if (ERROR_CATEGORIES.has(source.error_category)) output.error_category = source.error_category;
  const timestamp = safeTimestamp(source.timestamp);
  if (timestamp !== undefined) output.timestamp = timestamp;
  const count = safeCount(source.count);
  if (count !== undefined) output.count = count;
  if (source.recurring === true) output.recurring = true;
  if (source.background === true) output.background = true;
  if (source.scheduled === true) output.scheduled = true;
  if (source.trigger === 'manual' || source.trigger === 'auto') output.trigger = source.trigger;
  for (const key of ['total_tokens', 'total_duration_ms', 'total_tool_use_count', 'models_used_count']) {
    const value = safeCount(source[key]);
    if (value !== undefined) output[key] = value;
  }
  const resolvedModel = safeText(source.resolved_model);
  if (resolvedModel) output.resolved_model = resolvedModel;
  if (Array.isArray(source.models_used)) {
    const models = source.models_used.map(safeText).filter(Boolean).slice(0, 8);
    if (models.length) output.models_used = [...new Set(models)];
  }
  for (const key of ['stop_hook_active', 'structural_progress', 'usage_outlier', 'final']) {
    if (source[key] === true || source[key] === false) output[key] = source[key];
  }
  for (const key of ['pending_age_ms', 'unresolved_source_count', 'child_count']) {
    const value = safeCount(source[key]);
    if (value !== undefined) output[key] = value;
  }
  if (typeof source.usage_pressure_percent === 'number' && Number.isFinite(source.usage_pressure_percent) && source.usage_pressure_percent >= 0) {
    output.usage_pressure_percent = Math.min(1000, source.usage_pressure_percent);
  }
  return output;
}

function safeDecimal(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const quality = PROVENANCE_QUALITIES.has(value.evidence_quality) ? value.evidence_quality : 'insufficient_evidence';
  const entries = Array.isArray(value.entries) ? value.entries.slice(0, 16).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const output = {
      reason_code: REASON_SET.has(entry.reason_code) ? entry.reason_code : undefined,
      host: HOSTS.has(entry.host) ? entry.host : 'unknown',
      required_events: Array.isArray(entry.required_events) ? [...new Set(entry.required_events.filter((item) => EVENT_TYPES.has(item)))].slice(0, 8) : [],
      required_safe_fields: Array.isArray(entry.required_safe_fields) ? [...new Set(entry.required_safe_fields.filter((item) => SAFE_FIELD.test(item) && safeModel(item)))].slice(0, 8) : [],
      observed_events: Array.isArray(entry.observed_events) ? [...new Set(entry.observed_events.filter((item) => EVENT_TYPES.has(item)))].slice(0, 8) : [],
      support: PROVENANCE_SUPPORT.has(entry.support) ? entry.support : 'unavailable',
      evidence_scope: typeof entry.evidence_scope === 'string' && SAFE_TEXT.test(entry.evidence_scope) && safeModel(entry.evidence_scope) ? entry.evidence_scope : 'unavailable',
      recommendation_ids: Array.isArray(entry.recommendation_ids) ? [...new Set(entry.recommendation_ids.filter((item) => /^[a-z0-9_]{1,80}$/.test(item) && safeModel(item)))].slice(0, 8) : [],
    };
    return output.reason_code ? output : null;
  }).filter(Boolean) : [];
  return { provenance_schema_version: 1, evidence_quality: quality, entries };
}

/** Keep public efficiency output bounded and explicitly unmeasured for savings. */
export function normalizeEfficiencyResult(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {
    classification: CLASSIFICATION_SET.has(source.classification) ? source.classification : 'insufficient_evidence',
    reason_codes: [],
    evidence_counts: {},
    avoidable_usage: 'unmeasured',
  };
  const reasons = Array.isArray(source.reason_codes) ? [...new Set(source.reason_codes.filter((entry) => REASON_SET.has(entry)))] : [];
  output.reason_codes = reasons.slice(0, 16);
  if (source.evidence_counts && typeof source.evidence_counts === 'object' && !Array.isArray(source.evidence_counts)) {
    for (const reason of output.reason_codes) {
      const count = safeCount(source.evidence_counts[reason]);
      if (count !== undefined) output.evidence_counts[reason] = count;
    }
  }
  for (const key of ['affected_exact_tokens', 'affected_partial_lower_bound_tokens']) {
    const count = safeCount(source[key]);
    if (count !== undefined) output[key] = count;
  }
  const credits = safeDecimal(source.affected_calculated_credits);
  if (credits !== undefined) output.affected_calculated_credits = credits;
  if (source.coverage && typeof source.coverage === 'string' && SAFE_TEXT.test(source.coverage) && safeModel(source.coverage)) output.coverage = source.coverage;
  const provenance = safeProvenance(source.provenance);
  if (provenance) output.provenance = provenance;
  return output;
}

export { EVENT_TYPES, ERROR_CATEGORIES };
