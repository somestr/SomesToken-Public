import { isSensitiveRuntimeValue } from '../core.mjs';

export const RECOMMENDATION_SCHEMA_VERSION = 1;

const safeId = /^[a-z0-9_]{1,80}$/;
const MAX_RECOMMENDATIONS = 3;

export const RECOMMENDATION_CATALOG = Object.freeze({
  reduce_subagent_respawns: { copy: 'Reduce repeated subagent respawns within one bounded scope.', priority: 10, reasons: ['subagent_respawn_churn'] },
  narrow_subagent_scope: { copy: 'Narrow the subagent scope before starting another instance.', priority: 20, reasons: ['subagent_respawn_churn', 'same_agent_type_restarted'] },
  set_bounded_subagent_turns: { copy: 'Set a bounded turn policy for continuing agents.', priority: 30, reasons: ['stop_continuation_churn', 'subagent_stop_continuation_churn'] },
  reduce_parallel_fanout: { copy: 'Reduce unresolved parallel fan-out and wait for completions.', priority: 40, reasons: ['fan_out_churn'] },
  stop_retry_without_new_hypothesis: { copy: 'Stop a retry cycle unless a new bounded hypothesis is available.', priority: 50, reasons: ['tool_failure_retry_churn', 'tool_cycle_churn'] },
  investigate_repeated_tool_failure: { copy: 'Review the fixed failure category before retrying the same tool.', priority: 60, reasons: ['tool_failure_retry_churn'] },
  split_long_turn: { copy: 'Split a long structural window into smaller bounded turns.', priority: 70, reasons: ['tool_cycle_churn', 'usage_outlier'] },
  consider_fresh_session_after_compaction_churn: { copy: 'Consider a fresh session after repeated compaction boundaries.', priority: 80, reasons: ['compaction_churn'] },
  review_pending_source_stall: { copy: 'Review pending sources and their bounded completion state.', priority: 90, reasons: ['pending_source_stall'] },
  review_high_plan_pressure: { copy: 'Review high plan pressure with an authoritative or configured denominator.', priority: 100, reasons: ['high_plan_pressure', 'quota_near_limit', 'quota_exhausted'] },
  consider_lower_cost_model_candidate: { copy: 'Consider a lower-cost model candidate after comparable evidence accumulates.', priority: 110, reasons: ['usage_outlier'] },
  consider_lower_effort_candidate: { copy: 'Consider a lower-effort candidate only after comparable evidence accumulates.', priority: 120, reasons: ['usage_outlier'] },
  improve_cache_reuse_candidate: { copy: 'Review host-specific cache semantics and reuse opportunities.', priority: 130, reasons: ['usage_outlier'] },
  manual_gate_exit: { copy: 'Resolve the unchanged manual gate before continuing the goal.', priority: 140, reasons: ['stop_continuation_churn', 'repeated_warning_window'] },
  workflow_model_candidate: { copy: 'Review the bounded workflow profile candidate in a controlled comparison.', priority: 150, reasons: ['low_structural_pressure', 'watch_structural_pressure', 'high_structural_pressure'] },
  collect_more_evidence: { copy: 'Collect more comparable host evidence before changing behavior.', priority: 200, reasons: ['structural_no_progress', 'repeated_warning_window', 'background_activity_present', 'intentional_scheduled_activity'] },
});

function safeHost(value) {
  return value === 'codex' || value === 'claude' ? value : 'unknown';
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function confidence(provenance, evidence) {
  const quality = provenance?.evidence_quality;
  if (quality === 'live_verified' && evidence >= 4) return 'high';
  if (quality === 'live_verified' || quality === 'observed') return 'medium';
  return 'low';
}

function candidate(id, context, reasons, evidenceCounts) {
  const catalog = RECOMMENDATION_CATALOG[id];
  if (!catalog) return null;
  const affectedExact = safeCount(context.affected_exact_tokens);
  const affectedPartial = safeCount(context.affected_partial_lower_bound_tokens);
  return {
    recommendation_schema_version: RECOMMENDATION_SCHEMA_VERSION,
    id,
    status: 'candidate',
    host: safeHost(context.host),
    scope: context.scope === 'turn' || context.scope === 'session' ? context.scope : 'session',
    confidence: confidence(context.provenance, Math.max(0, ...Object.values(evidenceCounts))),
    reason_codes: [...new Set(reasons.filter((reason) => catalog.reasons.includes(reason)))].slice(0, 8),
    evidence_counts: Object.fromEntries(Object.entries(evidenceCounts).filter(([reason]) => catalog.reasons.includes(reason)).map(([reason, count]) => [reason, safeCount(count)])),
    capability_evidence: ['documented', 'fixture_verified', 'observed', 'live_verified'].includes(context.provenance?.evidence_quality) ? context.provenance.evidence_quality : 'insufficient_evidence',
    affected_usage_quality: affectedExact > 0 ? 'exact' : affectedPartial > 0 ? 'partial' : 'unavailable',
    ...(affectedExact > 0 ? { affected_tokens: affectedExact } : affectedPartial > 0 ? { affected_tokens: affectedPartial } : {}),
    potential_savings: 'unmeasured',
    copy: catalog.copy,
  };
}

export function normalizeRecommendation(value) {
  if (!value || typeof value !== 'object' || typeof value.id!=='string'||!safeId.test(value.id) || !RECOMMENDATION_CATALOG[value.id]) return null;
  const output = {
    recommendation_schema_version: RECOMMENDATION_SCHEMA_VERSION,
    id: value.id,
    status: value.status === 'candidate' ? 'candidate' : 'suppressed',
    host: safeHost(value.host),
    scope: value.scope === 'turn' ? 'turn' : 'session',
    confidence: ['low', 'medium', 'high'].includes(value.confidence) ? value.confidence : 'low',
    reason_codes: Array.isArray(value.reason_codes) ? [...new Set(value.reason_codes.filter((reason) => typeof reason === 'string' && safeId.test(reason) && !isSensitiveRuntimeValue(reason)))].slice(0, 8) : [],
    evidence_counts: {},
    capability_evidence: ['documented', 'fixture_verified', 'observed', 'live_verified', 'insufficient_evidence'].includes(value.capability_evidence) ? value.capability_evidence : 'insufficient_evidence',
    affected_usage_quality: ['exact', 'partial', 'unavailable'].includes(value.affected_usage_quality) ? value.affected_usage_quality : 'unavailable',
    potential_savings: 'unmeasured',
    copy: RECOMMENDATION_CATALOG[value.id].copy,
  };
  for (const [reason, count] of Object.entries(value.evidence_counts ?? {}).slice(0, 8)) if (safeId.test(reason) && !isSensitiveRuntimeValue(reason)) output.evidence_counts[reason] = safeCount(count);
  if (Number.isSafeInteger(value.affected_tokens) && value.affected_tokens >= 0) output.affected_tokens = Math.min(value.affected_tokens, Number.MAX_SAFE_INTEGER);
  return output;
}

export function generateRecommendations(input = {}) {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const candidates = new Map();
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const reasons = Array.isArray(finding.reason_codes) ? [...new Set(finding.reason_codes.filter((reason) => safeId.test(reason)))] : [];
    const counts = finding.evidence_counts && typeof finding.evidence_counts === 'object' ? finding.evidence_counts : {};
    const provenance = finding.provenance ?? input.provenance;
    const actionableEvidence = ['observed', 'live_verified'].includes(provenance?.evidence_quality);
    for (const [id, catalog] of Object.entries(RECOMMENDATION_CATALOG)) {
      if (!actionableEvidence) continue;
      const matching = reasons.filter((reason) => catalog.reasons.includes(reason));
      if (!matching.length) continue;
      if (['consider_lower_cost_model_candidate', 'consider_lower_effort_candidate'].includes(id)
        && (input.baseline?.quality !== 'exact' || safeCount(input.baseline?.sample_count) < 10)) continue;
      const evidenceCounts = Object.fromEntries(matching.map((reason) => [reason, safeCount(counts[reason])]));
      const result = candidate(id, { ...input, ...finding, provenance }, matching, evidenceCounts);
      if (result) candidates.set(id, result);
    }
  }
  const hasFindings = findings.some((finding) => Array.isArray(finding?.reason_codes) && finding.reason_codes.length > 0);
  if (candidates.size === 0 && hasFindings && (input.require_more_evidence !== false)) {
    const result = candidate('collect_more_evidence', { ...input, provenance: input.provenance }, ['structural_no_progress'], { structural_no_progress: 1 });
    if (result) candidates.set(result.id, result);
  }
  return [...candidates.values()]
    .sort((a, b) => (RECOMMENDATION_CATALOG[a.id].priority - RECOMMENDATION_CATALOG[b.id].priority) || a.id.localeCompare(b.id))
    .slice(0, MAX_RECOMMENDATIONS)
    .map(normalizeRecommendation)
    .filter(Boolean);
}
