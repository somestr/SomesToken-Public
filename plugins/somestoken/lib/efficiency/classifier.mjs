import { detectSignals } from './signals.mjs';

export function classifyEfficiency(signals = {}, context = {}) {
  if (!signals || !Number.isSafeInteger(signals.event_count) || signals.event_count <= 0) return 'insufficient_evidence';
  const strong = Array.isArray(signals.strong_signals) ? signals.strong_signals : [];
  const weak = Array.isArray(signals.weak_signals) ? signals.weak_signals : [];
  if (signals.recurring && strong.length === 0) return 'intentional_recurring_activity';
  const repeatedStrongReasons = new Set([
    'stop_continuation_churn',
    'subagent_stop_continuation_churn',
    'subagent_respawn_churn',
    'same_agent_type_restarted',
    'tool_failure_retry_churn',
    'pending_source_stall',
    'fan_out_churn',
  ]);
  if (strong.length >= 2 || strong.some((reason) => repeatedStrongReasons.has(reason) && (signals.evidence_counts?.[reason] ?? 0) >= 3)) {
    return context.prior_warning ? 'runaway_risk' : 'likely_loop';
  }
  const corroboratingWeak = weak.filter((reason) => !['high_plan_pressure', 'quota_near_limit', 'quota_exhausted', 'usage_outlier', 'background_activity_present'].includes(reason));
  if (strong.length >= 1 && corroboratingWeak.length >= 2) return context.prior_warning ? 'runaway_risk' : 'likely_loop';
  if (strong.length >= 1 || corroboratingWeak.length >= 2) return 'watch';
  return 'normal';
}

export { detectSignals };
