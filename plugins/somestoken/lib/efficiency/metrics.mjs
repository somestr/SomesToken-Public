import { toolFailureRetries } from './signals.mjs';
import { normalizeEfficiencyEvent } from './schema.mjs';

export const METRICS_SCHEMA_VERSION = 1;
const MAX_SAMPLES = 100;
const HOSTS = new Set(['codex', 'claude']);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function metric(numerator, denominator, options = {}) {
  const n = finite(numerator);
  const d = finite(denominator);
  const quality = ['exact', 'partial', 'unavailable'].includes(options.quality) ? options.quality : 'exact';
  if (n === null || d === null || d <= 0) return {
    value: null,
    numerator: n,
    denominator: d,
    quality: 'unavailable',
    coverage: options.coverage ?? 'unavailable',
  };
  return {
    value: round(n / d),
    numerator: n,
    denominator: d,
    quality,
    coverage: options.coverage ?? 'somestoken_observed',
  };
}

function rate(numerator, denominator, options = {}) {
  return metric(numerator, denominator, options);
}

function sumTokens(receipts) {
  let total = 0;
  let known = 0;
  let partial = false;
  let saturated = false;
  for (const receipt of receipts) {
    const token = safeInteger(receipt?.total_tokens);
    if (token === null || !['exact', 'partial'].includes(receipt?.status)) continue;
    if (total > Number.MAX_SAFE_INTEGER - token) {
      total = Number.MAX_SAFE_INTEGER;
      saturated = true;
    } else {
      total += token;
    }
    known += 1;
    partial ||= receipt.status === 'partial';
  }
  return { total, known, quality: partial || saturated ? 'partial' : known ? 'exact' : 'unavailable' };
}

function normalizedEvents(events) {
  return (Array.isArray(events) ? events : []).map(normalizeEfficiencyEvent).filter(Boolean);
}

export function cacheEfficiency(host, observed = {}, semantics = undefined) {
  if (!HOSTS.has(host) || !semantics || typeof semantics !== 'object' || semantics.denominator_supported !== true) {
    return metric(null, null, { coverage: 'unavailable' });
  }
  const input = safeInteger(observed.input_tokens);
  const cached = safeInteger(observed.cached_input_tokens);
  if (input === null || cached === null) return metric(null, null, { quality: 'partial', coverage: 'somestoken_observed' });
  if (observed.quality === 'unavailable' || (semantics.input_includes_cache_read === true && cached > input)) {
    return metric(null, null, { coverage: 'somestoken_observed' });
  }
  const denominator = semantics.input_includes_cache_read === true
    ? input
    : semantics.input_excludes_cache_read === true && input <= Number.MAX_SAFE_INTEGER - cached
      ? input + cached
      : null;
  if (denominator === null) return metric(null, null, { coverage: 'unavailable' });
  const quality = observed.quality === 'partial' ? 'partial' : 'exact';
  return { ...metric(cached, denominator, { quality, coverage: 'somestoken_observed' }), cache_read_semantics: semantics.input_includes_cache_read === true ? 'input_includes_cache_read' : 'input_excludes_cache_read' };
}

export function calculateStructuralMetrics(input = {}) {
  const receipts = Array.isArray(input.receipts) ? input.receipts.slice(-MAX_SAMPLES) : [];
  const events = normalizedEvents(input.events);
  const tokenTotals = sumTokens(receipts);
  const completed = receipts.filter((entry) => ['exact', 'partial'].includes(entry?.status));
  const exact = receipts.filter((entry) => entry?.status === 'exact');
  const partial = receipts.filter((entry) => entry?.status === 'partial');
  const toolEvents = events.filter((entry) => ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch'].includes(entry.event_type));
  const failures = events.filter((entry) => entry.event_type === 'PostToolUseFailure' || entry.status === 'failure' || entry.error_category);
  const retries = toolFailureRetries(events);
  const starts = events.filter((entry) => entry.event_type === 'SubagentStart');
  const stops = events.filter((entry) => entry.event_type === 'SubagentStop');
  const taskStarts = events.filter((entry) => entry.event_type === 'TaskCreated');
  const taskStops = events.filter((entry) => entry.event_type === 'TaskCompleted');
  const pending = events.filter((entry) => (entry.unresolved_source_count ?? 0) > 0 || (entry.pending_age_ms ?? 0) > 0);
  const compactions = events.filter((entry) => entry.event_type === 'PreCompact' || entry.event_type === 'PostCompact');
  const stopEvents = events.filter((entry) => entry.event_type === 'Stop');
  const activeStops = stopEvents.filter((entry) => entry.stop_hook_active === true);
  const progress = events.filter((entry) => typeof entry.structural_progress === 'boolean');
  const progressPositive = progress.filter((entry) => entry.structural_progress === true);
  const warnings = safeInteger(input.warning_count) ?? 0;
  const priorWarnings = safeInteger(input.prior_warning_count) ?? 0;
  const coverage = input.coverage ?? 'somestoken_observed';
  const quality = tokenTotals.quality;
  const output = {
    metrics_schema_version: METRICS_SCHEMA_VERSION,
    coverage,
    tokens_per_completed_turn: metric(tokenTotals.total, completed.length, { quality, coverage }),
    tokens_per_resolved_source: metric(tokenTotals.total, completed.reduce((sum, entry) => sum + (safeInteger(entry.resolved_sources) ?? 0), 0), { quality, coverage }),
    tool_events_per_completed_turn: metric(toolEvents.length, completed.length, { coverage }),
    tool_events_per_resolved_source: metric(toolEvents.length, completed.reduce((sum, entry) => sum + (safeInteger(entry.resolved_sources) ?? 0), 0), { coverage }),
    structured_failure_rate: rate(failures.length, toolEvents.length, { coverage }),
    retry_after_failure_rate: rate(retries, failures.length, { coverage }),
    subagent_respawn_rate: rate(Math.max(0, starts.length - new Set(starts.map((entry) => entry.agent_type).filter(Boolean)).size), starts.length, { coverage }),
    subagent_resolution_rate: rate(stops.length, starts.length, { coverage }),
    fanout_resolution_rate: rate(taskStops.length, taskStarts.length, { coverage }),
    pending_source_rate: rate(pending.length, events.length, { coverage }),
    compactions_per_turn: rate(compactions.length, completed.length, { coverage }),
    compactions_per_100k_tokens: metric(compactions.length * 100_000, tokenTotals.total, { quality, coverage }),
    stop_continuation_rate: rate(activeStops.length, stopEvents.length, { coverage }),
    warning_recurrence_rate: rate(warnings, warnings + priorWarnings, { coverage }),
    structural_progress_event_rate: rate(progressPositive.length, progress.length, { coverage }),
    exact_receipt_rate: rate(exact.length, completed.length + receipts.filter((entry) => entry?.status === 'unavailable').length, { coverage }),
    partial_receipt_rate: rate(partial.length, completed.length + receipts.filter((entry) => entry?.status === 'unavailable').length, { coverage }),
    capability_coverage_rate: metric(input.capability_coverage?.observed, input.capability_coverage?.total, { quality: input.capability_coverage?.quality, coverage: input.capability_coverage?.quality === 'partial' ? 'partial' : coverage }),
  };
  output.cache_efficiency = cacheEfficiency(input.host, input.cache_observed, input.cache_semantics);
  return output;
}

export function comparableKey(value = {}) {
  const safe = (entry) => typeof entry === 'string' && /^[A-Za-z0-9._:+-]{1,80}$/.test(entry) ? entry : 'unknown';
  return [safe(value.host), safe(value.model), safe(value.effort), safe(value.source_type), safe(value.schema_version), safe(value.usage_schema_version)].join('|');
}

function callerComparableKey(value, keyFor) {
  if (typeof keyFor !== 'function') return comparableKey(value);
  try {
    const key = keyFor(value);
    return typeof key === 'string' && /^[A-Za-z0-9._:+|-]{1,160}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return values[index];
}

export function compareComparableBaseline(current, history, options = {}) {
  const minimum = Number.isSafeInteger(options.minimum_samples) && options.minimum_samples > 0 ? Math.min(100, options.minimum_samples) : 10;
  const currentKey = callerComparableKey(current, options.key_for);
  const currentTokens = safeInteger(current?.total_tokens);
  const values = currentKey === null ? [] : (Array.isArray(history) ? history : [])
    .filter((entry) => entry && entry.status === 'exact' && safeInteger(entry.total_tokens) !== null && callerComparableKey(entry, options.key_for) === currentKey)
    .slice(-MAX_SAMPLES)
    .map((entry) => entry.total_tokens)
    .sort((a, b) => a - b);
  if (current?.status !== 'exact' || currentTokens === null || values.length < minimum) return {
    baseline_schema_version: 1,
    quality: 'insufficient_data',
    group_key: currentKey ?? 'unavailable',
    sample_count: values.length,
    minimum_samples: minimum,
    median: null,
    mad: null,
    p50: null,
    p90: null,
    p95: null,
    current_tokens: currentTokens,
    delta_from_median: null,
  };
  const median = values[Math.floor(values.length / 2)];
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  return {
    baseline_schema_version: 1,
    quality: 'exact',
    group_key: currentKey,
    sample_count: values.length,
    minimum_samples: minimum,
    median,
    mad,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    current_tokens: currentTokens,
    delta_from_median: currentTokens - median,
  };
}
