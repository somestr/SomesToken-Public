// Shared, content-free reconciliation diagnostics. Keep this vocabulary small:
// it crosses state recovery, public snapshots, CLI, and MCP boundaries.
export const TELEMETRY_OUTCOMES = Object.freeze([
  'received',
  'awaiting_post_turn_usage',
  'transcript_unavailable',
  'token_snapshot_missing',
  'transcript_ambiguous',
  'identity_rebaseline',
  'ambiguous_pending_turns',
  'session_closed_without_usage',
  'stop_failure_without_usage',
]);

const OUTCOME_SET = new Set(TELEMETRY_OUTCOMES);
const OUTCOME_LABELS = Object.freeze({
  transcript_unavailable: 'telemetry source unavailable',
  token_snapshot_missing: 'token snapshot missing',
  transcript_ambiguous: 'telemetry ambiguous',
  identity_rebaseline: 'safe source baseline established',
  ambiguous_pending_turns: 'pending turns ambiguous',
  session_closed_without_usage: 'session closed without usage',
});

export function isTelemetryOutcome(value) {
  return typeof value === 'string' && OUTCOME_SET.has(value);
}

export function telemetryOutcomeLabel(value) {
  return isTelemetryOutcome(value) ? OUTCOME_LABELS[value] : undefined;
}
