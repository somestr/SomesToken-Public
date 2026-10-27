import { SHADOW_DECISIONS, safeHost } from './schema.mjs';

export const GOAL_HYGIENE_SCHEMA_VERSION = 1;
function integer(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : fallback;
}

function usageQuality(value) {
  return ['exact', 'partial', 'unavailable'].includes(value) ? value : 'unavailable';
}

/**
 * Analyze only safe structural continuation inputs.  In particular, no
 * assistant text, prompt, error message, path or transcript content is read.
 */
export function evaluateGoalContinuation(input = {}) {
  const gate = input.gate && typeof input.gate === 'object' ? input.gate : null;
  const open = gate?.status === 'open';
  const gateRevision = integer(gate?.evidence_revision);
  const previousRevision = integer(input.previous_evidence_revision, gateRevision);
  const sameRevision = open && gateRevision === previousRevision;
  const continuationCount = integer(input.continuation_count);
  const stopCount = integer(input.stop_continuation_count);
  const structuralProgress = integer(input.structural_progress);
  const hasProgress = structuralProgress > 0 || input.structural_progress_occurred === true;
  const quality = usageQuality(input.usage_quality);
  const repeated = sameRevision && continuationCount >= 2;
  const repeatedStop = sameRevision && stopCount >= 2;
  const reasons = [];
  if (open && input.external_action_required === true) reasons.push('external_action_required');
  if (repeatedStop || repeated) reasons.push('manual_gate_continuation_churn');
  if (sameRevision && (continuationCount >= 1 || stopCount >= 1) && !hasProgress) reasons.push('goal_continued_without_new_evidence');
  if (sameRevision && continuationCount >= 3 && !hasProgress) reasons.push('blocked_goal_repetition');
  const classification = !open
    ? 'normal'
    : reasons.includes('blocked_goal_repetition')
      ? 'likely_loop'
      : reasons.length
        ? 'watch'
        : 'normal';
  return {
    goal_hygiene_schema_version: GOAL_HYGIENE_SCHEMA_VERSION,
    host: safeHost(input.host),
    gate_id: typeof gate?.gate_id === 'string' ? gate.gate_id : 'unknown',
    gate_status: typeof gate?.status === 'string' ? gate.status : 'unavailable',
    evidence_revision: gateRevision,
    previous_evidence_revision: previousRevision,
    same_evidence_revision: sameRevision,
    continuation_count: continuationCount,
    stop_continuation_count: stopCount,
    structural_progress: structuralProgress,
    usage_quality: quality,
    affected_exact_tokens: quality === 'exact' && Number.isSafeInteger(input.affected_tokens) ? input.affected_tokens : undefined,
    affected_partial_lower_bound_tokens: quality === 'partial' && Number.isSafeInteger(input.affected_tokens) ? input.affected_tokens : undefined,
    classification,
    reason_codes: [...new Set(reasons)].slice(0, 4),
    report_only: true,
    shadow_decision: SHADOW_DECISIONS.includes(input.shadow_decision) ? input.shadow_decision : undefined,
  };
}

export function recordGoalContinuation(state, input = {}) {
  if (!state || typeof state !== 'object') return evaluateGoalContinuation(input);
  const key = `${safeHost(input.host)}:${typeof input.gate_id === 'string' ? input.gate_id : 'unknown'}`;
  const prior = state[key] ?? {};
  const gate = input.gate ?? {};
  const same = integer(prior.last_evidence_revision, integer(gate.evidence_revision)) === integer(gate.evidence_revision)
    && gate.status === 'open';
  const continuationCount = same ? integer(prior.continuation_count) + 1 : 1;
  const result = evaluateGoalContinuation({
    ...input,
    previous_evidence_revision: prior.last_evidence_revision ?? gate.evidence_revision,
    continuation_count: continuationCount,
  });
  state[key] = {
    gate_id: result.gate_id,
    continuation_count: result.continuation_count,
    last_evidence_revision: result.evidence_revision,
    structural_progress: result.structural_progress,
    warnings: integer(prior.warnings) + (result.classification === 'normal' ? 0 : 1),
    updated_at: Number.isSafeInteger(input.now) ? input.now : Date.now(),
  };
  return result;
}
