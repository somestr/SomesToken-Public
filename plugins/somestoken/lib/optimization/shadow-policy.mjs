import { normalizeShadowDecision, safeHost } from './schema.mjs';

export const SHADOW_POLICY_VERSION = '1';

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function quality(value) {
  return ['exact', 'partial', 'unavailable'].includes(value) ? value : 'unavailable';
}

/** Deterministic, report-only policy simulation. */
export function evaluateShadowPolicy(input = {}) {
  const gate = input.manual_gate && typeof input.manual_gate === 'object' ? input.manual_gate : null;
  const gateOpen = gate?.status === 'open';
  const sameRevision = input.same_evidence_revision === true;
  const continuations = integer(input.stop_continuation_count ?? input.manual_gate_continuations);
  const progress = integer(input.structural_progress);
  const exact = quality(input.quality) === 'exact';
  const capabilityQuality = input.capability_quality ?? 'insufficient_evidence';
  const reasons = [];
  let decision = 'would_do_nothing';
  if (!['documented', 'fixture_verified', 'observed', 'live_verified'].includes(capabilityQuality) || quality(input.quality) === 'unavailable') {
    decision = 'insufficient_evidence';
  } else if (input.duplicate === true) {
    decision = 'would_suppress_duplicate';
    reasons.push('duplicate_policy_decision');
  } else if (gateOpen && sameRevision && continuations >= 2 && progress === 0 && exact) {
    decision = 'would_recommend_stop_goal';
    reasons.push('manual_gate_continuation_churn', 'goal_continued_without_new_evidence');
  } else if (gateOpen && input.external_action_required === true) {
    decision = 'would_request_user_action';
    reasons.push('external_action_required');
  } else if (exact && Number.isFinite(input.session_budget) && input.session_budget >= 0 && Number.isFinite(input.session_tokens) && input.session_tokens >= input.session_budget) {
    decision = 'would_warn';
    reasons.push('local_budget_exceeded');
  } else if (integer(input.unresolved_fanout) >= 2 || Number(input.retry_rate) >= 0.5) {
    decision = 'would_recommend_pause';
    if (integer(input.unresolved_fanout) >= 2) reasons.push('fan_out_churn');
    if (Number(input.retry_rate) >= 0.5) reasons.push('tool_failure_retry_churn');
  }
  return normalizeShadowDecision({
    decision_id: input.decision_id,
    host: safeHost(input.host),
    decision,
    policy_version: SHADOW_POLICY_VERSION,
    quality: quality(input.quality),
    capability_quality: capabilityQuality,
    reason_codes: reasons,
    created_at: input.created_at,
    suppressed_duplicate: decision === 'would_suppress_duplicate',
  });
}

export function shadowPolicySummary(history) {
  const entries = Array.isArray(history) ? history : [];
  const count = (decision) => entries.filter((entry) => entry?.decision === decision).length;
  return {
    policy_version: SHADOW_POLICY_VERSION,
    mode: 'shadow',
    decisions: entries.length,
    shadow_warn_rate: entries.length ? count('would_warn') / entries.length : null,
    shadow_pause_rate: entries.length ? count('would_recommend_pause') / entries.length : null,
    shadow_stop_goal_rate: entries.length ? count('would_recommend_stop_goal') / entries.length : null,
    duplicate_suppression_rate: entries.length ? entries.filter((entry) => entry?.suppressed_duplicate === true).length / entries.length : null,
    by_decision: Object.fromEntries(['would_do_nothing', 'would_warn', 'would_recommend_pause', 'would_recommend_stop_goal', 'would_request_user_action', 'would_suppress_duplicate', 'insufficient_evidence'].map((decision) => [decision, count(decision)])),
  };
}
