import { listPlanProfiles, getPlanProfile } from './plans.mjs';

// Earlier persisted results may have treated an account allowance as a 1x base.
export const COMPARISON_SCHEMA_VERSION = 2;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function staleQuota(quota) {
  return quota?.stale === true || (Array.isArray(quota?.reason_codes) && quota.reason_codes.includes('stale_quota_snapshot'));
}

// A comparison that lacks only a configured plan capacity is not set up, not incomparable.
const NOT_CONFIGURED_REASONS = new Set(['manual_capacity_missing', 'shared_pool_unknown']);
/** The health counter a receipt's plan comparison adds to, or null when it compared. */
export function planComparisonHealthKey(comparison) {
  const reasons = comparison?.reason_codes ?? [];
  if (comparison?.quality !== 'unavailable' && reasons.length && reasons.every((code) => NOT_CONFIGURED_REASONS.has(code))) return 'plan_comparisons_not_configured';
  return comparison?.quality === 'unavailable' || reasons.length ? 'plan_comparisons_incomparable' : null;
}

export function buildPlanComparisons({
  provider,
  observed_units,
  base_capacity_units,
  unit,
  capacity_unit,
  window_type,
  capacity_window_type,
  selected_plan,
  comparison_mode = 'unavailable',
  quota,
} = {}) {
  const plans = listPlanProfiles(provider);
  const observed = finite(observed_units);
  const base = finite(base_capacity_units ?? quota?.limit_units);
  const current = getPlanProfile(provider, selected_plan);
  // A host allowance already belongs to the selected account plan. It is not
  // a Plus/1x denominator to multiply again by 5 or 20.
  const accountCapacity = base_capacity_units == null && finite(quota?.limit_units) !== null;
  const mode = ['host_quota', 'manual_capacity', 'relative_only', 'unavailable'].includes(comparison_mode) ? comparison_mode : 'unavailable';
  const capacityUnit = capacity_unit ?? (accountCapacity ? quota?.unit : undefined);
  const capacityWindow = capacity_window_type ?? (accountCapacity ? quota?.window_type : undefined);
  const unitMismatch = Boolean(unit && capacityUnit && unit !== capacityUnit);
  const windowMismatch = Boolean(window_type && capacityWindow && window_type !== capacityWindow);
  const unavailableQuota = accountCapacity && quota?.quality === 'unavailable';
  const providerMismatch = Boolean(accountCapacity && provider && quota?.provider && provider !== quota.provider);
  const incomparable = unitMismatch || windowMismatch || unavailableQuota || providerMismatch;
  const stale = staleQuota(quota);
  const unknownAccountPlan = accountCapacity && !current;
  const resultMode = incomparable || stale || unknownAccountPlan ? 'unavailable' : mode;
  const denominatorValid = base !== null && base > 0 && observed !== null && !incomparable && !stale && !unknownAccountPlan;
  const comparisons = plans.map((plan) => {
    const capacity = denominatorValid ? accountCapacity ? plan.id === current.id ? base : null : base * plan.standard_multiplier : null;
    const pressure = capacity === null ? null : rounded(observed / capacity);
    const usedPercent = capacity === null ? null : rounded((observed / capacity) * 100);
    return {
      id: plan.id,
      display_name: plan.display_name,
      standard_multiplier: plan.standard_multiplier,
      capacity_units: capacity,
      used_percent: resultMode === 'relative_only' || resultMode === 'unavailable' || capacity === null ? null : usedPercent,
      remaining_percent: resultMode === 'relative_only' || resultMode === 'unavailable' || capacity === null ? null : rounded(100 - usedPercent),
      relative_pressure: pressure,
      status: capacity === null ? 'unavailable' : observed > capacity ? 'over_equivalent_capacity' : 'within_capacity',
    };
  });
  const quality = incomparable || stale || unknownAccountPlan ? 'unavailable' : denominatorValid && resultMode !== 'relative_only' && resultMode !== 'unavailable'
    ? accountCapacity && quota?.quality === 'partial' ? 'partial' : 'exact' : 'partial';
  const reasonCodes = [];
  if (base === null || base <= 0 || observed === null) reasonCodes.push('manual_capacity_missing');
  if (quota?.measurement_basis === 'host_percent' && base === null) reasonCodes.push('different_unit');
  if (unitMismatch) reasonCodes.push('different_unit');
  if (windowMismatch) reasonCodes.push('different_window');
  if (unavailableQuota) reasonCodes.push('quota_values_missing');
  if (providerMismatch) reasonCodes.push('provider_mismatch');
  if (resultMode === 'relative_only') reasonCodes.push('shared_pool_unknown');
  if (stale) reasonCodes.push('stale_quota_snapshot');
  if (unknownAccountPlan && !stale && !incomparable) reasonCodes.push('selected_plan_unknown');
  return {
    comparison_schema_version: COMPARISON_SCHEMA_VERSION,
    comparison_mode: resultMode,
    quality,
    coverage: quota?.coverage ?? (mode === 'relative_only' ? 'shared_pool_unknown' : 'somestoken_observed'),
    selected_plan: current ? { ...current } : { id: 'unknown', display_name: 'Unknown', standard_multiplier: null },
    current_plan: current ? comparisons.find((entry) => entry.id === current.id) : null,
    alternative_plan_comparisons: comparisons,
    ...(reasonCodes.length ? { reason_codes: [...new Set(reasonCodes)] } : {}),
    ...(resultMode === 'relative_only' && !denominatorValid ? { reason: 'percentage comparison unavailable because no authoritative base allowance or denominator was supplied' } : {}),
  };
}
