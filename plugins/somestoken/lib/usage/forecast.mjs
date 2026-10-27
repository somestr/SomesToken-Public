import {quotaRoundingUncertainty} from './quota-snapshots.mjs';
import { isSensitiveRuntimeValue } from '../core.mjs';

/** Pure empirical forecasts. Timestamps ending in `_ms` and options.at are epoch
 * milliseconds; durations are milliseconds. No wall clock or quota attribution. */
const MAX_RECORDS = 1000;
const MIN_TASKS = 20;
const QUOTA_IDENTITY = ['account_id', 'plan_id', 'limit_id', 'quota_group', 'window_id'];
const QUOTA_RATE_WINDOW_MS = 6 * 60 * 60 * 1000;
const QUOTA_COUNT_SATURATED = 'quota_observation_count_saturated';
// Hosts round reset times to the second, so reads of one window can differ by a
// second, and a window that has not started moves its reset with every read
// while it stays at 0%. Neither is a new window.
const RESET_TOLERANCE_MS = 60_000;
const sameWindowReset = (previousReset, previousUsed, reset, used) =>
  Math.abs(reset - previousReset) <= RESET_TOLERANCE_MS || (previousUsed === 0 && used === 0);
const DAY_MS = 86_400_000;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
export const FORECAST_FEATURE_KEYS = Object.freeze(['host', 'model', 'effort', 'workload', 'service_tier',
  'context_band', 'scope_band', 'verification_band', 'planned_subagent_policy']);
const FORECAST_ENUMS = Object.freeze({
  host: new Set(['codex', 'claude']),
  workload: new Set(['inspect', 'fix', 'refactor', 'migration', 'test']),
  service_tier: new Set(['default', 'standard', 'fast', 'priority', 'flex', 'batch', 'ultrafast']),
  context_band: new Set(['small', 'medium', 'large']),
  scope_band: new Set(['narrow', 'medium', 'broad']),
  verification_band: new Set(['light', 'standard', 'extensive']),
  planned_subagent_policy: new Set(['none', 'bounded', 'parallel']),
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && SAFE_LABEL.test(value) && !isSensitiveRuntimeValue(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
function timestamp(ms, iso) {
  if (ms !== undefined) return count(ms) ? ms : null;
  if (typeof iso !== 'string' || iso.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const parsed = Date.parse(iso);
  return count(parsed) ? parsed : null;
}
function records(values) { return Array.isArray(values) ? values.slice(-MAX_RECORDS) : []; }
function forecastFeatureState(value) {
  if (!object(value)) return { status: 'invalid' };
  let missing = false;
  for (const key of FORECAST_FEATURE_KEYS) {
    if (value[key] === undefined || value[key] === 'unknown' || value[key] === 'unavailable') { missing = true; continue; }
    if (!label(value[key]) || (FORECAST_ENUMS[key] && !FORECAST_ENUMS[key].has(value[key]))) return { status: 'invalid' };
  }
  if (missing) return { status: 'missing' };
  return { status: 'valid', features: Object.fromEntries(FORECAST_FEATURE_KEYS.map(key => [key, value[key]])) };
}
export function normalizeForecastFeatures(value) {
  const result = forecastFeatureState(value);
  return result.status === 'valid' ? result.features : null;
}
function cutoff(options) {
  return options?.at === undefined ? Number.MAX_SAFE_INTEGER : count(options.at) ? options.at : null;
}
function quotaIdentity(source) {
  if (!QUOTA_IDENTITY.every(key => label(source[key]))
    || (source.provider !== undefined && !label(source.provider))) return null;
  return { ...(source.provider === undefined ? {} : { provider: source.provider }),
    ...Object.fromEntries(QUOTA_IDENTITY.map(key => [key, source[key]])) };
}
const precision = value => percent(value) ? value : null;
const precisionSource = value => label(value) ? value : null;

export function selectForecastCohort(samples, features = {}, options = {}) {
  const at = cutoff(options);
  const featureState = forecastFeatureState(features);
  if (at === null || featureState.status === 'invalid') return { status: 'invalid', features: null, samples: [] };
  if (featureState.status === 'missing') return { status: 'missing', features: null, samples: [] };
  const controls = featureState.features;
  const eligible = records(samples).filter(sample => object(sample) && label(sample.task_key)
    && count(sample.completed_at_ms) && sample.completed_at_ms < at);
  const occurrences = new Map();
  for (const sample of eligible) occurrences.set(sample.task_key, (occurrences.get(sample.task_key) ?? 0) + 1);
  const cohort = eligible.filter(sample => occurrences.get(sample.task_key) === 1
    && sample.task_key !== options?.task_key
    && sample.status === 'completed' && sample.quality === 'exact' && sample.independent === true
    && sample.training_unit === 'completed_request_group'
    && sample.accounting_scope === 'full_parent_and_children'
    && forecastFeatureState(sample).status === 'valid'
    && FORECAST_FEATURE_KEYS.every(key => sample[key] === controls[key])
    && count(sample.total_tokens) && count(sample.duration_ms));
  return { status: 'valid', features: controls, samples: cohort };
}

/**
 * samples: [{ task_key, host, model, effort, workload, service_tier,
 * context_band, scope_band, verification_band, planned_subagent_policy,
 * status:'completed', quality:'exact', independent:true,
 * training_unit:'completed_request_group',
 * accounting_scope:'full_parent_and_children', completed_at_ms,
 * total_tokens, duration_ms }].
 * Each categorical value is an 80-character safe identifier. A task must represent
 * independent usage (not a parent total containing its children). Duplicate task
 * keys are excluded entirely rather than counted as independent observations.
 * features contain the same nine forecast controls. options: { at?: epoch
 * milliseconds, task_key?: excluded target task }.
 * Uses the last at most 1000 supplied records, then excludes future completions.
 * Predicts only the exact feature cohort; fewer than 20 tasks remains learning.
 * Quantiles are nearest-rank empirical values, not confidence intervals.
 */
export function forecastTaskUsage(samples, features = {}, options = {}) {
  const base = { status: 'learning', measurement_basis: 'predicted', method: 'empirical_nearest_rank',
    prediction_unit: 'request_group', sample_count: 0, minimum_samples: MIN_TASKS, quota_task_attribution: 'unavailable' };
  const selection = selectForecastCohort(samples, features, options);
  if (selection.status === 'invalid') {
    return { ...base, status: 'unavailable', reason_codes: ['invalid_forecast_features'] };
  }
  if(selection.status === 'missing')
    return {...base,reason_codes:['missing_forecast_features'],missing_features:FORECAST_FEATURE_KEYS.filter(key=>
      features[key]===undefined||features[key]==='unknown'||features[key]==='unavailable')};
  const controls = selection.features, cohort = selection.samples;
  const common = { ...base, sample_count: cohort.length,
    cohort: controls };
  if (cohort.length < MIN_TASKS) return { ...common, reason_codes: ['insufficient_independent_completed_tasks'] };
  const tokens = cohort.map(sample => sample.total_tokens);
  const durations = cohort.map(sample => sample.duration_ms);
  const priced=cohort.every(s=>s.cost_quality==='exact'&&Number.isFinite(s.calculated_dollar_equivalent)&&s.calculated_dollar_equivalent>=0
    && typeof s.price_revision==='string'&&s.price_revision===cohort[0].price_revision
    && Array.isArray(s.pricing_profile_cost_shares)&&s.pricing_profile_cost_shares.length>0
    && JSON.stringify(s.pricing_profile_cost_shares)===JSON.stringify(cohort[0].pricing_profile_cost_shares)
    && Array.isArray(s.pricing_profiles)&&s.pricing_profiles.length>0&&JSON.stringify(s.pricing_profiles)===JSON.stringify(cohort[0].pricing_profiles));
  const costs=priced?cohort.map(s=>s.calculated_dollar_equivalent):[];
  return { ...common, status: 'predicted',
    ...(priced?{price_revision:cohort[0].price_revision,pricing_profiles:cohort[0].pricing_profiles,pricing_profile_cost_shares:cohort[0].pricing_profile_cost_shares}:{}),
    p50: { total_tokens: quantile(tokens, 0.5), duration_ms: quantile(durations, 0.5),...(priced?{calculated_dollar_equivalent:quantile(costs,0.5)}:{}) },
    p80: { total_tokens: quantile(tokens, 0.8), duration_ms: quantile(durations, 0.8),...(priced?{calculated_dollar_equivalent:quantile(costs,0.8)}:{}) } };
}

/**
 * snapshots: [{ provider?, account_id, plan_id, limit_id, quota_group, window_id,
 * used_percent: number (0..100), window_duration_mins: positive number,
 * snapshot_at_ms, resets_at_ms }]. ISO snapshot_at/resets_at may replace *_ms.
 * window_id may be host primary/secondary or an opaque stable window identifier;
 * its name does not imply duration. All five identity fields are required.
 * quality:'unavailable' or stale:true observations are rejected.
 * options: { at?: epoch ms, max_age_ms?: nonnegative integer }.
 * Returns one latest-epoch scenario per provider/account/plan/limit/group/window.
 * An omitted provider is a separate legacy identity and never merges with an
 * explicit provider. Rate is the endpoint percentage change divided by elapsed
 * time in the latest six hours. Changed reset, duration, or any percentage
 * decrease starts a fresh epoch. Rounding bounds require explicit provider
 * precision_percent at both endpoints; unknown bounds are null. These are not
 * confidence intervals. Decimal formatting never establishes precision.
 * Extrapolation is a constant observed-rate scenario, explicitly not a measured
 * future outcome.
 */
export function forecastQuotaWindows(snapshots, options = {}) {
  const at = cutoff(options);
  if (at === null || (options?.max_age_ms !== undefined && !count(options.max_age_ms))) return [];
  const groups = new Map();
  for (const source of quotaPoints(snapshots)) {
    if (!object(source)) continue;
    const identity = quotaIdentity(source);
    if (identity === null) continue;
    const snapshotAt = timestamp(source.snapshot_at_ms, source.snapshot_at);
    const resetsAt = timestamp(source.resets_at_ms, source.resets_at);
    const duration = source.window_duration_mins;
    if (snapshotAt === null || snapshotAt > at || resetsAt === null || resetsAt <= snapshotAt
      || !percent(source.used_percent) || typeof duration !== 'number' || !Number.isFinite(duration)
      || duration <= 0 || duration * 60_000 > Number.MAX_SAFE_INTEGER
      || source.quality === 'unavailable' || source.stale === true) continue;
    const key = JSON.stringify(identity);
    if (!groups.has(key)) groups.set(key, { identity, values: [] });
    groups.get(key).values.push({ at: snapshotAt, reset: resetsAt, duration, used: source.used_percent,
      precision: precision(source.precision_percent), precision_source: precisionSource(source.precision_source),
      ambiguous: source.ambiguous === true });
  }
  return [...groups.values()].map(({ identity, values }) => {
    values.sort((a, b) => a.at - b.at || a.reset - b.reset || a.used - b.used);
    // Identical copies add no signal; conflicting copies could conceal a reset.
    const ambiguous = values.some(value => value.ambiguous) || values.some((value, i) => i > 0 && value.at === values[i - 1].at
      && (value.used !== values[i - 1].used || !sameWindowReset(values[i - 1].reset, values[i - 1].used, value.reset, value.used)
        || value.duration !== values[i - 1].duration || value.precision !== values[i - 1].precision
        || value.precision_source !== values[i - 1].precision_source));
    const unique = values.filter((value, i) => i === 0 || value.at !== values[i - 1].at);
    const latest = unique.at(-1);
    const base = { ...identity, status: 'unavailable', measurement_basis: 'predicted',
      method: 'constant_observed_rate_scenario', quota_task_attribution: 'unavailable', cross_epoch_samples: 0 };
    if (!latest || ambiguous) return { ...base, reason_codes: ['ambiguous_snapshot_times'] };
    const effectiveAt = options?.at === undefined ? latest.at : at;
    const common = { ...base, snapshot_at_ms: latest.at, resets_at_ms: latest.reset,
      window_duration_mins: latest.duration, used_percent: latest.used,
      rate_window_ms: QUOTA_RATE_WINDOW_MS };
    if (effectiveAt >= latest.reset || (options?.max_age_ms !== undefined && effectiveAt - latest.at > options.max_age_ms)) {
      return { ...common, reason_codes: ['stale_quota_snapshot'] };
    }
    let epoch = [];
    for (const value of unique) {
      const previous = epoch.at(-1);
      if (previous && (!sameWindowReset(previous.reset, previous.used, value.reset, value.used) || value.duration !== previous.duration
        || value.used < previous.used || value.at >= previous.reset)) epoch = [];
      epoch.push(value);
    }
    const recent = epoch.filter(value => value.at >= latest.at - QUOTA_RATE_WINDOW_MS);
    if (recent.length < 2) return { ...common, sample_count: recent.length, reason_codes: ['insufficient_quota_rate_samples'] };
    const first = recent[0];
    const interval = latest.at - first.at;
    const change = latest.used - first.used;
    const roundingUncertainty = quotaRoundingUncertainty(first.precision, latest.precision);
    const rateCommon = { ...common, sample_count: recent.length,
      rate_observation_interval_ms: interval, used_percent_change: change,
      used_percent_rounding_uncertainty: roundingUncertainty,
      bounds_basis: roundingUncertainty === null ? 'unavailable' : 'quota_rounding_only_not_confidence_interval',
      reason_codes: roundingUncertainty === null ? ['quota_precision_unavailable'] : [] };
    const rate = change / interval;
    if (!Number.isFinite(rate) || rate <= 0) return { ...rateCommon, reason_codes: ['no_positive_usage_signal'] };
    const lowerRate = roundingUncertainty === null ? null : Math.max(0, change - roundingUncertainty) / interval;
    const upperRate = roundingUncertainty === null ? null : Math.min(100, change + roundingUncertainty) / interval;
    const timeToExhaustion = (100 - latest.used) / rate;
    const exhaustionAt = latest.at + timeToExhaustion;
    if (!Number.isFinite(exhaustionAt) || exhaustionAt > Number.MAX_SAFE_INTEGER) {
      return { ...rateCommon, reason_codes: ['unbounded_exhaustion_scenario'] };
    }
    return { ...rateCommon, status: 'predicted',
      percent_per_hour: rate * 3_600_000,
      percent_per_hour_lower_bound: lowerRate === null ? null : lowerRate * 3_600_000,
      percent_per_hour_upper_bound: upperRate === null ? null : upperRate * 3_600_000,
      exhaustion_at_ms: exhaustionAt < latest.reset ? exhaustionAt : null,
      exhausts_before_reset: exhaustionAt < latest.reset,
      scenario: 'continued_observed_aggregate_rate' };
  });
}


/** Evaluate frozen, independently completed request-group predictions. Duplicate
 * task keys (including edited predictions) are excluded entirely within the last
 * 1000 supplied pairs. Persistence must preserve the original prediction; this
 * pure function cannot authenticate a caller's claimed freeze timestamp. */
export function evaluateForecasts(pairs) {
  const bounded = records(pairs);
  const occurrences = new Map();
  for (const pair of bounded) if (object(pair) && label(pair.task_key)) {
    occurrences.set(pair.task_key, (occurrences.get(pair.task_key) ?? 0) + 1);
  }
  const eligible = bounded.filter(pair => object(pair) && label(pair.task_key)
    && occurrences.get(pair.task_key) === 1
    && pair.forecast_controls_consistent === true
    && ['prediction_at_ms', 'completed_at_ms', 'p50_tokens', 'p80_tokens', 'actual_tokens', 'baseline_tokens'].every(key => count(pair[key]))
    && pair.prediction_at_ms < pair.completed_at_ms && pair.p50_tokens <= pair.p80_tokens
    && (pair.prediction_updated_at_ms === undefined || pair.prediction_updated_at_ms === pair.prediction_at_ms));
  eligible.sort((a, b) => a.completed_at_ms - b.completed_at_ms);
  const n = eligible.length;
  const average = fn => n ? eligible.reduce((sum, pair) => sum + fn(pair) / n, 0) : null;
  const coverage = n ? eligible.filter(pair => pair.actual_tokens <= pair.p80_tokens).length / n : null;
  const mae = average(pair => Math.abs(pair.actual_tokens - pair.p50_tokens));
  const baseline = average(pair => Math.abs(pair.actual_tokens - pair.baseline_tokens));
  const calibrated = n >= 50 && coverage >= 0.75 && coverage <= 0.85 && mae < baseline;
  return { prediction_unit: 'request_group', sample_count: n, p80_coverage: coverage,
    mean_absolute_error: mae, baseline_mean_absolute_error: baseline,
    rejected_count: bounded.length - n, status: n < 50 ? 'insufficient_evidence' : calibrated ? 'calibrated' : 'uncalibrated',
    reason_codes: n < 50 ? ['insufficient_independent_evaluations'] : calibrated ? [] : ['calibration_thresholds_not_met'] };
}

/** Retain numeric bucket summaries for eight days, with five-minute buckets in
 * the latest day and hourly buckets before it. Epochs never span identity/reset,
 * duration or percentage decreases. At most 32 epochs per identity are retained.
 * At most 32 identities are retained, prioritizing the most recent observation.
 * Existing summaries can be supplied again alongside new raw observations.
 * Counts describe observed samples, not polling intervals or inferred activity. */
export function compactQuotaHistory(input, options = {}) {
  const at = cutoff(options);
  const gaps = new Set();
  let dropped = 0;
  const groups = new Map();
  if (at === null || options?.at === undefined) return { records: [], coverage_gaps: ['invalid_retention_time'], dropped_record_count: 0, epoch_count: 0 };
  for (const source of Array.isArray(input) ? input : []) {
    const snapshotAt = object(source) ? timestamp(source.snapshot_at_ms, source.snapshot_at) : null;
    const reset = object(source) ? timestamp(source.resets_at_ms, source.resets_at) : null;
    const identity = object(source) ? quotaIdentity(source) : null;
    if (!object(source) || identity === null || snapshotAt === null
      || reset === null || reset <= snapshotAt || !percent(source.used_percent)
      || !Number.isFinite(source.window_duration_mins) || source.window_duration_mins <= 0
      || source.window_duration_mins * 60_000 > Number.MAX_SAFE_INTEGER
      || source.quality === 'unavailable' || source.stale === true) {
      dropped++; gaps.add('invalid_quota_observation'); continue;
    }
    if (snapshotAt > at) { dropped++; gaps.add('future_quota_observation'); continue; }
    if (snapshotAt < at - 8 * DAY_MS) { dropped++; gaps.add('quota_history_age_limit'); continue; }
    const key = JSON.stringify(identity);
    const summary = count(source.first_snapshot_at_ms) && source.first_snapshot_at_ms <= snapshotAt
      && percent(source.first_used_percent) && percent(source.min_used_percent) && percent(source.max_used_percent)
      && source.min_used_percent <= Math.min(source.first_used_percent, source.used_percent)
      && source.max_used_percent >= Math.max(source.first_used_percent, source.used_percent)
      && count(source.observation_count) && source.observation_count > 0;
    if (summary && source.first_snapshot_at_ms < at - 8 * DAY_MS) {
      dropped++; gaps.add('quota_history_age_limit'); continue;
    }
    const saturated = summary && Array.isArray(source.reason_codes) && source.reason_codes.includes(QUOTA_COUNT_SATURATED);
    if (saturated) gaps.add(QUOTA_COUNT_SATURATED);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...identity, snapshot_at_ms: snapshotAt, resets_at_ms: reset,
      window_duration_mins: source.window_duration_mins, used_percent: source.used_percent,
      precision_percent: precision(source.precision_percent), precision_source: precisionSource(source.precision_source),
      first_snapshot_at_ms: summary ? source.first_snapshot_at_ms : snapshotAt,
      first_used_percent: summary ? source.first_used_percent : source.used_percent,
      first_precision_percent: precision(summary ? source.first_precision_percent : source.precision_percent),
      first_precision_source: precisionSource(summary ? source.first_precision_source : source.precision_source),
      min_used_percent: summary ? source.min_used_percent : source.used_percent,
      max_used_percent: summary ? source.max_used_percent : source.used_percent,
      observation_count: summary ? source.observation_count : 1,
      ...(saturated ? { quality: 'partial', reason_codes: [QUOTA_COUNT_SATURATED] } : {}),
      ...(source.ambiguous === true ? { ambiguous: true } : {}),
      epoch_started_at_ms: summary && count(source.epoch_started_at_ms) && source.epoch_started_at_ms <= source.first_snapshot_at_ms ? source.epoch_started_at_ms : undefined });
  }
  const output = [];
  let epochCount = 0;
  const identities = [...groups.values()].sort((a, b) => b.reduce((latest, v) => Math.max(latest, v.snapshot_at_ms), 0) - a.reduce((latest, v) => Math.max(latest, v.snapshot_at_ms), 0));
  if (identities.length > 32) {
    gaps.add('quota_history_identity_limit');
    dropped += identities.slice(32).reduce((sum, group) => sum + group.length, 0);
  }
  for (const values of identities.slice(0, 32)) {
    let ambiguous = values.some(value => value.ambiguous);
    values.sort((a, b) => a.first_snapshot_at_ms - b.first_snapshot_at_ms || a.snapshot_at_ms - b.snapshot_at_ms);
    const epochs = [];
    let previous;
    for (const value of values) {
      if (previous && value.first_snapshot_at_ms <= previous.snapshot_at_ms) {
        if (value.first_snapshot_at_ms === value.snapshot_at_ms && value.snapshot_at_ms === previous.snapshot_at_ms
          && value.used_percent === previous.used_percent && sameWindowReset(previous.resets_at_ms, previous.used_percent, value.resets_at_ms, value.used_percent)
          && value.window_duration_mins === previous.window_duration_mins
          && value.precision_percent === previous.precision_percent && value.precision_source === previous.precision_source) continue;
        if (value.first_snapshot_at_ms === previous.first_snapshot_at_ms && value.snapshot_at_ms === previous.snapshot_at_ms
          && value.used_percent === previous.used_percent && value.first_used_percent === previous.first_used_percent
          && sameWindowReset(previous.resets_at_ms, previous.used_percent, value.resets_at_ms, value.used_percent) && value.window_duration_mins === previous.window_duration_mins
          && value.precision_percent === previous.precision_percent && value.first_precision_percent === previous.first_precision_percent
          && value.precision_source === previous.precision_source && value.first_precision_source === previous.first_precision_source) continue;
        gaps.add('overlapping_quota_observations'); ambiguous = true; dropped++; continue;
      }
      if (!previous || !sameWindowReset(previous.resets_at_ms, previous.used_percent, value.resets_at_ms, Math.max(value.first_used_percent, value.used_percent)) || value.window_duration_mins !== previous.window_duration_mins
        // A stored epoch start is not a boundary by itself: every real one (reset,
        // duration, drop, window end) is visible above, and history split by the
        // old exact-reset rule rejoins here.
        || value.first_used_percent < previous.used_percent || value.first_snapshot_at_ms >= previous.resets_at_ms) epochs.push([]);
      const epoch = epochs.at(-1);
      value.epoch_started_at_ms = epoch[0]?.epoch_started_at_ms ?? value.epoch_started_at_ms ?? value.first_snapshot_at_ms;
      epoch.push(value);
      previous = value;
    }
    if (epochs.length > 32) {
      gaps.add('quota_history_epoch_limit');
      dropped += epochs.slice(0, -32).reduce((sum, epoch) => sum + epoch.length, 0);
    }
    const retained = epochs.slice(-32);
    epochCount += retained.length;
    for (const epoch of retained) {
      const buckets = new Map();
      for (const value of epoch) {
        const width = value.snapshot_at_ms >= at - DAY_MS ? 300_000 : 3_600_000;
        const start = Math.floor(value.snapshot_at_ms / width) * width;
        const key = `${width}:${start}`;
        const existing = buckets.get(key);
        if (!existing) buckets.set(key, { ...value, bucket_start_ms: start, bucket_width_ms: width });
        else {
          existing.snapshot_at_ms = value.snapshot_at_ms;
          existing.used_percent = value.used_percent;
          existing.precision_percent = value.precision_percent;
          existing.precision_source = value.precision_source;
          existing.min_used_percent = Math.min(existing.min_used_percent, value.min_used_percent);
          existing.max_used_percent = Math.max(existing.max_used_percent, value.max_used_percent);
          const overflow = existing.observation_count > Number.MAX_SAFE_INTEGER - value.observation_count;
          existing.observation_count = overflow ? Number.MAX_SAFE_INTEGER : existing.observation_count + value.observation_count;
          if (overflow || value.reason_codes?.includes(QUOTA_COUNT_SATURATED)) {
            existing.quality = 'partial';
            existing.reason_codes = [QUOTA_COUNT_SATURATED];
            gaps.add(QUOTA_COUNT_SATURATED);
          }
        }
      }
      output.push(...[...buckets.values()].map(value => ambiguous ? { ...value, ambiguous: true } : value));
    }
  }
  output.sort((a, b) => a.snapshot_at_ms - b.snapshot_at_ms
    || JSON.stringify(quotaIdentity(a)).localeCompare(JSON.stringify(quotaIdentity(b))));
  return { records: output, coverage_gaps: [...gaps].sort(), dropped_record_count: dropped, epoch_count: epochCount };
}

function quotaPoints(input) {
  // Compacted history is already bounded per identity and epoch, so the legacy
  // shared raw-record cap must not starve a less frequently observed window.
  const sources = Array.isArray(input) && input.some(value => object(value) && value.bucket_width_ms !== undefined)
    ? input : records(input);
  return sources.flatMap(source => object(source) && count(source.first_snapshot_at_ms)
    && source.first_snapshot_at_ms < source.snapshot_at_ms && percent(source.first_used_percent)
    ? [{ ...source, snapshot_at_ms: source.first_snapshot_at_ms, used_percent: source.first_used_percent,
      precision_percent: source.first_precision_percent ?? null, precision_source: source.first_precision_source ?? null }, source] : [source]);
}
