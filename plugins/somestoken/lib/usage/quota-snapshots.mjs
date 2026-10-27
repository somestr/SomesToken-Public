import { COVERAGE, WINDOW_TYPES } from './schema.mjs';
import { isSensitiveRuntimeValue } from '../core.mjs';

export const QUOTA_SCHEMA_VERSION = 2;

/** Endpoint rounding widths must come from the provider contract, never the
 * printed number's decimal places. This is not a statistical confidence bound. */
export function quotaRoundingUncertainty(before, after) {
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  return known(before) && known(after) ? (before + after) / 2 : null;
}

const COVERAGE_BY_SOURCE = Object.freeze({
  host: 'host_account_window',
  codex_app_server: 'host_account_window',
  manual: 'somestoken_observed',
  shared_pool_partial: 'shared_pool_partial',
  shared_pool_unknown: 'shared_pool_unknown',
});
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const QUOTA_SOURCES = new Set(['host', 'codex_app_server', 'manual', 'shared_pool_partial', 'shared_pool_unknown']);
const QUOTA_SCOPES = new Set(['account', 'workspace', 'shared_pool', 'session', 'unknown']);

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function supplied(value) {
  return value !== undefined && value !== null;
}

function complementary(used, remaining, limit) {
  // Divide first to avoid overflow while tolerating ordinary floating-point rounding.
  return Math.abs(used / limit + remaining / limit - 1) <= Number.EPSILON * 8;
}

function iso(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    const milliseconds = value < 1e12 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function percent(value) {
  return Math.round(value * 1000) / 10;
}

function boundedPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function inferredWindowType(duration) {
  if (duration === 300) return 'rolling_5h';
  if (duration === 1_440) return 'daily';
  if (duration === 10_080) return 'weekly';
  return 'host_defined';
}

function normalizeHostPercentSnapshot(source, options = {}) {
  const usedInput = source.used_percent ?? source.usedPercent;
  const used = boundedPercent(usedInput);
  const remainingInput = source.remaining_percent ?? source.remainingPercent;
  const remaining = !supplied(remainingInput)
    ? (used === null ? null : Math.max(0, 100 - used))
    : boundedPercent(remainingInput);
  const snapshotAt = iso(source.snapshot_at ?? options.now);
  const resetsAt = source.resets_at === undefined ? null : iso(source.resets_at);
  const duration = number(source.window_duration_mins ?? source.windowDurationMins);
  const windowType = WINDOW_TYPES.includes(source.window_type)
    ? source.window_type
    : duration !== null && duration > 0 ? inferredWindowType(duration) : null;
  const reasons = [];
  if (used === null) reasons.push(supplied(usedInput) ? 'invalid_percentage' : 'quota_values_missing');
  if (remaining === null && supplied(remainingInput)) reasons.push('invalid_percentage');
  if (used !== null && remaining !== null && !complementary(used, remaining, 100)) reasons.push('inconsistent_quota_values');
  if (!snapshotAt) reasons.push('snapshot_time_missing');
  if (!windowType) reasons.push('window_missing');
  if (source.resets_at !== undefined && resetsAt === null) reasons.push('reset_time_invalid');
  const now = Date.parse(options.now ?? new Date().toISOString());
  const staleAfter = Number.isFinite(options.stale_after_ms) && options.stale_after_ms >= 0
    ? options.stale_after_ms : 6 * 60 * 60 * 1000;
  const stale = Boolean(snapshotAt && Number.isFinite(now)
    && (now - Date.parse(snapshotAt) > staleAfter || (resetsAt && now >= Date.parse(resetsAt))));
  if (stale) reasons.push('stale_quota_snapshot');
  if (used === null || remaining === null || !snapshotAt || !windowType || reasons.includes('inconsistent_quota_values')) {
    return {
      quota_schema_version: QUOTA_SCHEMA_VERSION,
      quality: 'unavailable',
      coverage: 'host_account_window',
      quota_source: 'codex_app_server',
      measurement_basis: 'host_percent',
      reason_codes: [...new Set(reasons.length ? reasons : ['quota_values_missing'])].slice(0, 8),
    };
  }
  return {
    quota_schema_version: QUOTA_SCHEMA_VERSION,
    quality: stale ? 'partial' : reasons.length ? 'partial' : 'exact',
    coverage: 'host_account_window',
    ...(source.provider === 'codex' ? { provider: 'codex' } : {}),
    quota_source: 'codex_app_server',
    quota_scope: ['account', 'workspace'].includes(source.quota_scope) ? source.quota_scope : 'account',
    measurement_basis: 'host_percent',
    ...(typeof source.limit_id === 'string' && SAFE_TEXT.test(source.limit_id) && !isSensitiveRuntimeValue(source.limit_id) ? { limit_id: source.limit_id } : {}),
    window_type: windowType,
    used_percent: percent(used / 100),
    remaining_percent: percent(remaining / 100),
    ...(duration !== null && duration > 0 ? { window_duration_mins: duration } : {}),
    ...(snapshotAt ? { snapshot_at: snapshotAt } : {}),
    ...(resetsAt ? { resets_at: resetsAt } : {}),
    ...(stale ? { stale: true } : {}),
    ...(reasons.length ? { reason_codes: [...new Set(reasons)].slice(0, 8) } : {}),
  };
}

export function normalizeQuotaSnapshot(value, options = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const measurementBasis = source.measurement_basis ?? source.measurementBasis;
  const isHostPercent = measurementBasis === 'host_percent' || source.quota_source === 'codex_app_server';
  if (isHostPercent) return normalizeHostPercentSnapshot(source, options);
  const used = number(source.used_units);
  const limit = number(source.limit_units);
  const remainingSupplied = supplied(source.remaining_units);
  const remaining = remainingSupplied ? number(source.remaining_units)
    : used === null || limit === null ? null : Math.max(0, limit - used);
  const snapshotAt = iso(source.snapshot_at);
  const resetsAt = iso(source.resets_at);
  const windowStartedAt = source.window_started_at === undefined ? null : iso(source.window_started_at);
  const windowEndsAt = source.window_ends_at === undefined ? null : iso(source.window_ends_at);
  const windowType = WINDOW_TYPES.includes(source.window_type) ? source.window_type : null;
  const unit = typeof source.unit === 'string' && SAFE_TEXT.test(source.unit) && !isSensitiveRuntimeValue(source.unit) ? source.unit : null;
  const quotaSource = QUOTA_SOURCES.has(source.quota_source) ? source.quota_source : 'unknown';
  const provider = source.provider === 'codex' || source.provider === 'claude' ? source.provider : null;
  const coverage = COVERAGE_BY_SOURCE[quotaSource] ?? 'unavailable';
  const reasonCodes = [];
  if (!supplied(source.used_units) || !supplied(source.limit_units)) reasonCodes.push('quota_values_missing');
  const invalidValues = (supplied(source.used_units) && used === null)
    || (supplied(source.limit_units) && limit === null)
    || (remainingSupplied && remaining === null)
    || (limit !== null && ((used !== null && used > limit) || (remaining !== null && remaining > limit)));
  if (invalidValues) reasonCodes.push('invalid_quota_values');
  const inconsistentValues = !invalidValues && used !== null && limit > 0 && remaining !== null
    && !complementary(used, remaining, limit);
  if (inconsistentValues) reasonCodes.push('inconsistent_quota_values');
  if (limit === 0) reasonCodes.push('zero_denominator');
  if (!windowType) reasonCodes.push('window_missing');
  if (!unit) reasonCodes.push('unit_missing');
  if (source.window_started_at !== undefined && !windowStartedAt) reasonCodes.push('window_start_invalid');
  if (source.window_ends_at !== undefined && !windowEndsAt) reasonCodes.push('window_end_invalid');
  const now = Date.parse(options.now ?? new Date().toISOString());
  const staleAfter = Number.isFinite(options.stale_after_ms) && options.stale_after_ms >= 0 ? options.stale_after_ms : 6 * 60 * 60 * 1000;
  let stale = false;
  if (!snapshotAt || !Number.isFinite(now)) reasonCodes.push('snapshot_time_missing');
  else if (now - Date.parse(snapshotAt) > staleAfter || (resetsAt && now >= Date.parse(resetsAt))) stale = true;
  if (stale) reasonCodes.push('stale_quota_snapshot');
  const complete = used !== null && limit !== null && limit > 0 && remaining !== null
    && !invalidValues && !inconsistentValues && windowType && unit && snapshotAt;
  if (!complete) return {
    quota_schema_version: QUOTA_SCHEMA_VERSION,
    quality: 'unavailable',
    coverage,
    reason_codes: [...new Set(reasonCodes)].slice(0, 8),
  };
  const quality = stale ? 'partial' : reasonCodes.length ? 'partial' : 'exact';
  return {
    quota_schema_version: QUOTA_SCHEMA_VERSION,
    quality,
    coverage: COVERAGE.includes(coverage) ? coverage : 'unavailable',
    ...(provider ? { provider } : {}),
    quota_source: quotaSource,
    quota_scope: QUOTA_SCOPES.has(source.quota_scope) ? source.quota_scope : 'unknown',
    measurement_basis: 'units',
    unit,
    window_type: windowType,
    used_units: used,
    limit_units: limit,
    remaining_units: remaining,
    used_percent: percent(used / limit),
    remaining_percent: percent(remaining / limit),
    ...(snapshotAt ? { snapshot_at: snapshotAt } : {}),
    ...(windowStartedAt ? { window_started_at: windowStartedAt } : {}),
    ...(windowEndsAt ? { window_ends_at: windowEndsAt } : {}),
    ...(resetsAt ? { resets_at: resetsAt } : {}),
    ...(stale ? { stale: true } : {}),
    ...(reasonCodes.length ? { reason_codes: [...new Set(reasonCodes)].slice(0, 8) } : {}),
  };
}
