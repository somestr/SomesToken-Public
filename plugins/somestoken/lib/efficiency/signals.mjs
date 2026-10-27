import { normalizeEfficiencyEvent } from './schema.mjs';

const DEFAULTS = Object.freeze({
  same_agent_respawn_watch: 4,
  same_tool_repeat_watch: 6,
  stop_continuation_watch: 2,
  pending_source_age_ms: 600_000,
});

function count(map, key, amount = 1) {
  map[key] = Math.min(1_000_000, (map[key] ?? 0) + amount);
}

function normalized(events) {
  return (Array.isArray(events) ? events : []).map(normalizeEfficiencyEvent).filter(Boolean);
}

/**
 * A retry is a failure whose next tool event is a PreToolUse of the same tool.
 * Claude runs PreToolUse and PostToolBatch asynchronously, so the failed call's
 * own PreToolUse can land after its failure and a batch boundary sits between a
 * failure and the next call; neither counts as the next event.
 */
export function toolFailureRetries(entries) {
  let retries = 0;
  entries.forEach((failure, index) => {
    if (failure.event_type !== 'PostToolUseFailure' || !failure.tool_name) return;
    const next = entries.slice(index + 1).find(entry => entry.event_type !== 'PostToolBatch'
      && !(failure.tool_use_id && entry.tool_use_id === failure.tool_use_id));
    if (next?.event_type === 'PreToolUse' && next.tool_name === failure.tool_name) retries += 1;
  });
  return retries;
}

export function detectSignals(events, options = {}) {
  const entries = normalized(events);
  const settings = { ...DEFAULTS, ...options };
  const evidenceCounts = {};
  const reasons = new Set();
  const strong = new Set();
  const weak = new Set();
  const mark = (reason, amount, kind = 'weak') => {
    if (!amount) return;
    reasons.add(reason);
    count(evidenceCounts, reason, amount);
    (kind === 'strong' ? strong : weak).add(reason);
  };

  const stops = entries.filter((entry) => entry.event_type === 'Stop' && entry.stop_hook_active === true);
  const subagentStops = entries.filter((entry) => entry.event_type === 'SubagentStop' && entry.stop_hook_active === true);
  mark('stop_continuation_churn', stops.length >= settings.stop_continuation_watch ? stops.length : 0, 'strong');
  mark('subagent_stop_continuation_churn', subagentStops.length >= settings.stop_continuation_watch ? subagentStops.length : 0, 'strong');

  const startsByType = new Map();
  const stopsByType = new Map();
  for (const entry of entries) {
    if (entry.event_type === 'SubagentStart' && entry.agent_type) startsByType.set(entry.agent_type, (startsByType.get(entry.agent_type) ?? 0) + 1);
    if (entry.event_type === 'SubagentStop' && entry.agent_type) stopsByType.set(entry.agent_type, (stopsByType.get(entry.agent_type) ?? 0) + 1);
  }
  const maxStarts = Math.max(0, ...startsByType.values());
  const respawnTypes = [...startsByType.entries()].filter(([, value]) => value >= settings.same_agent_respawn_watch);
  mark('subagent_respawn_churn', respawnTypes.reduce((sum, [, value]) => sum + value, 0), 'strong');
  mark('same_agent_type_restarted', respawnTypes.length, 'strong');

  const toolEntries = entries.filter((entry) => entry.tool_name && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch'].includes(entry.event_type));
  const toolCounts = new Map();
  for (const entry of toolEntries) toolCounts.set(entry.tool_name, (toolCounts.get(entry.tool_name) ?? 0) + 1);
  const repeatedTool = [...toolCounts.values()].some((value) => value >= settings.same_tool_repeat_watch);
  const alternating = toolEntries.length >= settings.same_tool_repeat_watch
    && new Set(toolEntries.slice(-settings.same_tool_repeat_watch).map((entry) => entry.tool_name)).size >= 2;
  mark('tool_cycle_churn', alternating && (repeatedTool || toolEntries.length >= settings.same_tool_repeat_watch) ? toolEntries.length : 0, 'weak');

  mark('tool_failure_retry_churn', toolFailureRetries(entries), 'strong');

  const pending = entries.filter((entry) => (entry.pending_age_ms ?? 0) >= settings.pending_source_age_ms || (entry.unresolved_source_count ?? 0) > 0);
  mark('pending_source_stall', pending.length, 'strong');
  const noProgress = entries.filter((entry) => entry.structural_progress === false).length;
  mark('structural_no_progress', noProgress >= 2 ? noProgress : 0, 'strong');
  const unresolvedFanout = entries.filter((entry) => (entry.unresolved_source_count ?? 0) >= 2 || (entry.child_count ?? 0) > 32).length;
  mark('fan_out_churn', unresolvedFanout, 'strong');

  const preCompact = entries.filter((entry) => entry.event_type === 'PreCompact' || entry.event_type === 'PostCompact').length;
  mark('compaction_churn', preCompact >= 2 && (stops.length || subagentStops.length) ? preCompact : 0, 'weak');
  const background = entries.filter((entry) => entry.background === true).length;
  mark('background_activity_present', background, 'weak');
  const scheduled = entries.filter((entry) => entry.scheduled === true || entry.recurring === true).length;
  mark('intentional_scheduled_activity', scheduled, 'weak');
  if (scheduled && !strong.size) reasons.add('intentional_scheduled_activity');
  const outliers = entries.filter((entry) => entry.usage_outlier === true).length;
  mark('usage_outlier', outliers, 'weak');

  const pressured = entries.filter((entry) => (entry.usage_pressure_percent ?? 0) >= 75).length;
  const nearLimit = entries.filter((entry) => (entry.usage_pressure_percent ?? 0) >= 90 && (entry.usage_pressure_percent ?? 0) < 100).length;
  const exhausted = entries.filter((entry) => (entry.usage_pressure_percent ?? 0) >= 100).length;
  mark('high_plan_pressure', pressured, 'weak');
  mark('quota_near_limit', nearLimit, 'weak');
  mark('quota_exhausted', exhausted, 'weak');

  return {
    event_count: entries.length,
    reason_codes: [...reasons],
    evidence_counts: evidenceCounts,
    strong_signals: [...strong],
    weak_signals: [...weak],
    max_agent_starts: maxStarts,
    recurring: scheduled > 0,
  };
}
