import { detectSignals, classifyEfficiency } from './classifier.mjs';
import { normalizeEfficiencyEvent, normalizeEfficiencyResult } from './schema.mjs';

export function detectEfficiency(events, context = {}) {
  const normalized = (Array.isArray(events) ? events : []).map(normalizeEfficiencyEvent).filter(Boolean);
  const signals = detectSignals(normalized, context);
  const classification = classifyEfficiency(signals, context);
  const repeated = context.prior_warning === true && ['watch', 'likely_loop', 'runaway_risk'].includes(classification);
  return normalizeEfficiencyResult({
    classification,
    reason_codes: repeated ? [...signals.reason_codes, 'repeated_warning_window'] : signals.reason_codes,
    evidence_counts: signals.evidence_counts,
    affected_exact_tokens: context.affected_exact_tokens,
    affected_partial_lower_bound_tokens: context.affected_partial_lower_bound_tokens,
    affected_calculated_credits: context.affected_calculated_credits,
    coverage: context.coverage,
  });
}
