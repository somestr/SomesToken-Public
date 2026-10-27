import { REASON_CODES } from './schema.mjs';

const HOSTS = Object.freeze(['codex', 'claude']);
const MAX_ENTRIES = 16;
const STATUS_ORDER = Object.freeze({
  unavailable: 0,
  missing_required_fields: 0,
  version_incompatible: 0,
  documented: 1,
  fixture_verified: 2,
  observed: 3,
  live_verified: 4,
});

const DEFAULT_RECOMMENDATIONS = Object.freeze({
  stop_continuation_churn: ['set_bounded_subagent_turns'],
  subagent_stop_continuation_churn: ['set_bounded_subagent_turns'],
  subagent_respawn_churn: ['reduce_subagent_respawns', 'narrow_subagent_scope'],
  same_agent_type_restarted: ['narrow_subagent_scope'],
  tool_cycle_churn: ['stop_retry_without_new_hypothesis', 'split_long_turn'],
  tool_failure_retry_churn: ['investigate_repeated_tool_failure', 'stop_retry_without_new_hypothesis'],
  pending_source_stall: ['review_pending_source_stall'],
  structural_no_progress: ['collect_more_evidence'],
  fan_out_churn: ['reduce_parallel_fanout'],
  compaction_churn: ['consider_fresh_session_after_compaction_churn'],
  repeated_warning_window: ['collect_more_evidence'],
  background_activity_present: ['collect_more_evidence'],
  intentional_scheduled_activity: ['collect_more_evidence'],
  usage_outlier: ['split_long_turn', 'collect_more_evidence'],
  high_plan_pressure: ['review_high_plan_pressure'],
  quota_near_limit: ['review_high_plan_pressure'],
  quota_exhausted: ['review_high_plan_pressure'],
});

const make = (hosts, events, fields, minimum_event_count, signal_strength, classification_contribution, supported_fallback, recommendations) => ({
  hosts,
  required_events: events,
  required_safe_fields: fields,
  minimum_event_count,
  signal_strength,
  classification_contribution,
  supported_fallback,
  recommendation_ids: recommendations,
});

export const REASON_CODE_WIRING = Object.freeze({
  stop_continuation_churn: make(HOSTS, ['Stop'], ['stop_hook_active'], 2, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.stop_continuation_churn),
  subagent_stop_continuation_churn: make(HOSTS, ['SubagentStop'], ['stop_hook_active', 'agent_type'], 2, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.subagent_stop_continuation_churn),
  subagent_respawn_churn: make(HOSTS, ['SubagentStart', 'SubagentStop'], ['agent_id', 'agent_type'], 4, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.subagent_respawn_churn),
  same_agent_type_restarted: make(HOSTS, ['SubagentStart'], ['agent_type'], 4, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.same_agent_type_restarted),
  tool_cycle_churn: make(HOSTS, ['PreToolUse', 'PostToolUse'], ['tool_name'], 6, 'weak', 'watch_only', 'insufficient_evidence', [...DEFAULT_RECOMMENDATIONS.tool_cycle_churn, 'reduce_parallel_fanout']),
  tool_failure_retry_churn: make(['claude'], ['PostToolUseFailure', 'PreToolUse'], ['tool_name', 'error_category'], 1, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.tool_failure_retry_churn),
  pending_source_stall: make(HOSTS, ['SubagentStart', 'SubagentStop'], ['pending_age_ms', 'unresolved_source_count'], 1, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.pending_source_stall),
  structural_no_progress: make(HOSTS, ['PostToolUse', 'TaskCompleted', 'Stop'], ['structural_progress'], 2, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.structural_no_progress),
  fan_out_churn: make(HOSTS, ['SubagentStart', 'SubagentStop'], ['child_count', 'unresolved_source_count'], 1, 'strong', 'watch_or_loop', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.fan_out_churn),
  compaction_churn: make(HOSTS, ['PreCompact', 'PostCompact'], ['trigger'], 2, 'weak', 'watch_only', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.compaction_churn),
  repeated_warning_window: make(HOSTS, ['Stop'], ['scope_id'], 2, 'weak', 'runaway_only', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.repeated_warning_window),
  background_activity_present: make(['claude'], ['Stop', 'SubagentStop'], ['background'], 1, 'weak', 'context_only', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.background_activity_present),
  intentional_scheduled_activity: make(['claude'], ['Stop', 'SubagentStop'], ['scheduled', 'recurring'], 1, 'weak', 'intentional_only', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.intentional_scheduled_activity),
  usage_outlier: make(HOSTS, ['Stop'], ['usage_outlier'], 1, 'weak', 'watch_only', 'insufficient_evidence', DEFAULT_RECOMMENDATIONS.usage_outlier),
  high_plan_pressure: make(HOSTS, ['Stop'], ['usage_pressure_percent'], 1, 'weak', 'context_only', 'unavailable', DEFAULT_RECOMMENDATIONS.high_plan_pressure),
  quota_near_limit: make(HOSTS, ['Stop'], ['usage_pressure_percent'], 1, 'weak', 'context_only', 'unavailable', DEFAULT_RECOMMENDATIONS.quota_near_limit),
  quota_exhausted: make(HOSTS, ['Stop'], ['usage_pressure_percent'], 1, 'weak', 'context_only', 'unavailable', DEFAULT_RECOMMENDATIONS.quota_exhausted),
});

function safeReason(value) {
  return REASON_CODES.includes(value) ? value : null;
}

function safeHost(value) {
  return HOSTS.includes(value) ? value : null;
}

function safeStatus(value) {
  return Object.prototype.hasOwnProperty.call(STATUS_ORDER, value) ? value : 'unavailable';
}

function statusForReason(reason, host, options = {}) {
  const wiring = REASON_CODE_WIRING[reason];
  if (!wiring || !wiring.hosts.includes(host)) return 'unavailable';
  if (options.support) return safeStatus(options.support);
  if (options.capabilities && typeof options.capabilities === 'object') {
    const supports = wiring.required_events.map((event) => safeStatus(options.capabilities[`${host}.${event}`]));
    if (supports.some((value) => ['unavailable', 'version_incompatible'].includes(value))) return 'unavailable';
    const observedFields = options.observed_fields && typeof options.observed_fields === 'object' ? options.observed_fields : {};
    let fieldsWereObserved = false;
    for (const event of wiring.required_events) {
      const fields = observedFields[`${host}.${event}`];
      if (Array.isArray(fields)) {
        fieldsWereObserved = true;
        if (!wiring.required_safe_fields.every((field) => fields.includes(field))) return 'missing_required_fields';
      }
    }
    const usable = supports.filter((value) => value !== 'missing_required_fields');
    if (!usable.length) return fieldsWereObserved ? 'observed' : 'missing_required_fields';
    return usable.reduce((best, value) => STATUS_ORDER[value] < STATUS_ORDER[best] ? value : best, 'live_verified');
  }
  return options.observed_events?.length ? (options.live ? 'live_verified' : 'observed') : 'fixture_verified';
}

export function getReasonCodeWiring(reasonCode, host) {
  const reason = safeReason(reasonCode);
  const wiring = reason ? REASON_CODE_WIRING[reason] : null;
  if (!wiring || (host && !wiring.hosts.includes(host))) return null;
  return {
    reason_code: reason,
    host_applicability: [...wiring.hosts],
    required_events: [...wiring.required_events],
    required_safe_fields: [...wiring.required_safe_fields],
    minimum_event_count: wiring.minimum_event_count,
    signal_strength: wiring.signal_strength,
    classification_contribution: wiring.classification_contribution,
    supported_fallback: wiring.supported_fallback,
    recommendation_ids: [...wiring.recommendation_ids],
  };
}

export function auditReasonCodeWiring(options = {}) {
  const host = safeHost(options.host);
  return REASON_CODES.map((reason) => {
    const wiring = getReasonCodeWiring(reason, host) ?? getReasonCodeWiring(reason);
    if (!wiring) return {
      reason_code: reason,
      host_applicability: [],
      required_events: [],
      required_safe_fields: [],
      capability: 'unavailable',
      supported_fallback: 'insufficient_evidence',
      recommendation_ids: [...(DEFAULT_RECOMMENDATIONS[reason] ?? [])],
    };
    return {
      ...wiring,
      capability: host && !wiring.host_applicability.includes(host)
        ? 'unavailable'
        : options.fixture_verified === false ? 'documented' : 'fixture_verified',
    };
  });
}

export function buildProvenance(reasonCodes, options = {}) {
  const host = safeHost(options.host);
  const reasons = [...new Set((Array.isArray(reasonCodes) ? reasonCodes : []).map(safeReason).filter(Boolean))].slice(0, MAX_ENTRIES);
  const observedEvents = [...new Set((Array.isArray(options.observed_events) ? options.observed_events : []).filter((entry) => typeof entry === 'string'))].slice(0, 16);
  const entries = reasons.map((reason) => {
    const wiring = getReasonCodeWiring(reason, host);
    const support = statusForReason(reason, host, options);
    const requiredEvents = wiring?.required_events ?? [];
    return {
      reason_code: reason,
      host: host ?? 'unknown',
      required_events: requiredEvents,
      required_safe_fields: wiring?.required_safe_fields ?? [],
      observed_events: observedEvents.filter((event) => requiredEvents.includes(event)),
      support,
      evidence_scope: support === 'live_verified' ? 'live-observed' : support === 'observed' ? 'observed' : support === 'fixture_verified' ? 'fixture' : support === 'documented' ? 'documented' : 'unavailable',
      recommendation_ids: wiring?.recommendation_ids ?? [],
    };
  });
  const observedSupport = Object.values(options.capabilities ?? {}).filter((value) => value === 'observed' || value === 'live_verified');
  const quality = entries.length === 0
    ? observedSupport.length > 0 ? (observedSupport.some((value) => value === 'live_verified') ? 'live_verified' : 'observed') : 'insufficient_evidence'
    : entries.some((entry) => ['unavailable', 'missing_required_fields', 'version_incompatible'].includes(entry.support))
      ? 'insufficient_evidence'
      : entries.every((entry) => entry.support === 'live_verified')
        ? 'live_verified'
        : entries.some((entry) => entry.support === 'observed')
          ? 'observed'
          : entries.some((entry) => entry.support === 'fixture_verified')
            ? 'fixture_verified'
            : 'documented';
  return {
    provenance_schema_version: 1,
    evidence_quality: quality,
    entries,
  };
}
