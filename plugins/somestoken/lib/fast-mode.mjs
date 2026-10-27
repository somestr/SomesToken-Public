import { modelFamily } from './routing.mjs';

export const FAST_MODE_SCHEMA_VERSION = 3;
// Current documented OpenAI tiers. `priority` is the effective response value
// for a Fast request; `ultrafast` is deliberately separate from Fast Mode.
export const SERVICE_TIERS = Object.freeze(['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']);

const TIER_SET = new Set(SERVICE_TIERS);
const SOURCE_SET = new Set(['hook', 'turn_context', 'hook+turn_context']);
const EFFORT_SET = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MAX_RECEIPTS = 100;
const MAX_SOURCES = MAX_RECEIPTS * 33;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,80}$/;
const UNAVAILABLE_SOURCE = Object.freeze({ status: 'unavailable' });

function boundedCount(value) {
  return Math.min(MAX_SOURCES, value);
}

function boundedAdd(left, right) {
  if (left > MAX_SAFE - right) return MAX_SAFE;
  return left + right;
}

function safeTier(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'standard') return 'default';
  return TIER_SET.has(normalized) ? normalized : undefined;
}

function safeSource(value) {
  return SOURCE_SET.has(value) ? value : undefined;
}

function structuredFastValue(value, keys) {
  const nested = [value?.agent_output, value?.agent]
    .find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ?? {};
  for (const key of keys) {
    if (value?.[key] !== undefined) return value[key];
    if (nested[key] !== undefined) return nested[key];
  }
  return undefined;
}

function fastFlag(tier) {
  if (tier === undefined) return null;
  if (tier === 'priority' || tier === 'fast') return true;
  if (tier === 'default') return false;
  return null;
}

/** Normalize only structured service-tier fields reported by the host. */
export function normalizeFastModeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const requested = safeTier(structuredFastValue(value, ['requested_service_tier', 'requestedServiceTier']));
  const effective = safeTier(structuredFastValue(value, ['service_tier', 'serviceTier', 'effective_service_tier', 'effectiveServiceTier']));
  if (requested === undefined && effective === undefined) return null;
  const requestedFast = fastFlag(requested);
  const effectiveFast = fastFlag(effective);
  return {
    ...(requested !== undefined ? { requested_service_tier: requested } : {}),
    ...(effective !== undefined ? { service_tier: effective } : {}),
    requested_fast: requestedFast,
    effective_fast: effectiveFast,
    downgraded: requestedFast === true && effectiveFast === false,
    status: requested !== undefined && effective !== undefined ? 'observed' : 'partial',
    ...(safeSource(value.source) ? { source: value.source } : {}),
  };
}

function selectedReceipts(receipts, options = {}) {
  if (!Array.isArray(receipts)) return [];
  const requested = Number.isSafeInteger(options.last) ? options.last : MAX_RECEIPTS;
  const count = Math.min(MAX_RECEIPTS, Math.max(1, requested));
  return receipts.filter((entry) => entry && typeof entry === 'object').slice(-count);
}

function safeStatus(source, receipt) {
  if (source?.status === 'unavailable' || receipt?.status === 'unavailable') return 'unavailable';
  if (source?.status === 'partial' || source?.ambiguous === true || receipt?.status === 'partial') return 'partial';
  if (!source?.usage || source?.valid === false) return 'unavailable';
  return 'exact';
}

function safeTotal(source) {
  const value = source?.usage?.total_tokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeEffort(source) {
  const value = source?.metadata?.reasoning_effort;
  return typeof value === 'string' && EFFORT_SET.has(value) ? value : 'unknown';
}

function safeModelGroup(value) {
  const family = modelFamily(value);
  if (family !== 'unknown') return family;
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return SAFE_MODEL.test(normalized) && !normalized.startsWith('sk-') && !normalized.startsWith('rk-') ? normalized : 'unknown';
}

function tierBucket(tier) {
  if (tier === 'priority' || tier === 'fast') return 'fast';
  if (tier === 'default') return 'standard';
  if (tier === 'ultrafast') return 'ultrafast';
  if (tier === 'auto' || tier === 'flex') return 'other';
  return 'unknown';
}

function emptyBucket() {
  return {
    sources: 0,
    exact_sources: 0,
    partial_sources: 0,
    unavailable_sources: 0,
    total_tokens: null,
    exact_tokens: null,
  };
}

function addBucket(bucket, status, total) {
  bucket.sources = boundedCount(bucket.sources + 1);
  if (status === 'exact') bucket.exact_sources = boundedCount(bucket.exact_sources + 1);
  else if (status === 'partial') bucket.partial_sources = boundedCount(bucket.partial_sources + 1);
  else bucket.unavailable_sources = boundedCount(bucket.unavailable_sources + 1);
  if (total === null) return;
  bucket.total_tokens = boundedAdd(bucket.total_tokens ?? 0, total);
  if (status === 'exact') bucket.exact_tokens = boundedAdd(bucket.exact_tokens ?? 0, total);
}

function sourceEntries(state, receipt) {
  const turn = state?.turns?.[receipt?.turn_id];
  const main = turn?.main && typeof turn.main === 'object' ? [{ source: turn.main, kind: 'main' }] : [{ source: null, kind: 'main' }];
  const subagents = turn?.subagents && typeof turn.subagents === 'object'
    ? Object.values(turn.subagents).slice(0, 32).map((source) => ({
      // Preserve an unlinked Stop candidate only in runtime state. Fast mode
      // reports observed usage, so it receives a child only after lifecycle
      // completion proves the source boundary.
      source: source?.status === 'completed' ? source : UNAVAILABLE_SOURCE,
      kind: 'subagent',
    }))
    : [];
  return [...main, ...subagents];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10000) / 10000;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function comparison(groups, knownTierSources) {
  const eligible = [...groups.values()].filter((group) => group.fast.length > 0 && group.standard.length > 0);
  if (!knownTierSources) return { status: 'unavailable', mode: 'unavailable', minimum_sources_per_tier: 2, groups: [] };
  if (!eligible.length) return { status: 'insufficient_evidence', mode: 'insufficient_evidence', minimum_sources_per_tier: 2, groups: [] };
  const comparable = eligible.filter((group) => group.fast.length >= 2 && group.standard.length >= 2);
  if (!comparable.length) {
    return {
      status: 'insufficient_evidence',
      mode: 'insufficient_evidence',
      minimum_sources_per_tier: 2,
      groups: eligible.map((group) => ({
        model_family: group.model_family,
        reasoning_effort: group.reasoning_effort,
        fast_sources: group.fast.length,
        standard_sources: group.standard.length,
      })).slice(0, 32),
    };
  }
  const fastValues = comparable.flatMap((group) => group.fast);
  const standardValues = comparable.flatMap((group) => group.standard);
  const fastAverage = fastValues.reduce((sum, value) => sum + value, 0) / fastValues.length;
  const standardAverage = standardValues.reduce((sum, value) => sum + value, 0) / standardValues.length;
  return {
    status: 'exact',
    mode: 'comparable_exact',
    minimum_sources_per_tier: 2,
    groups: comparable.map((group) => ({
      model_family: group.model_family,
      reasoning_effort: group.reasoning_effort,
      fast_sources: group.fast.length,
      standard_sources: group.standard.length,
    })).slice(0, 32),
    fast_samples: fastValues.length,
    standard_samples: standardValues.length,
    fast_median_tokens_per_source: median(fastValues),
    standard_median_tokens_per_source: median(standardValues),
    fast_average_tokens_per_source: Math.round(fastAverage * 10000) / 10000,
    standard_average_tokens_per_source: Math.round(standardAverage * 10000) / 10000,
    delta_tokens_per_source: Math.round((fastAverage - standardAverage) * 10000) / 10000,
    fast_to_standard_ratio: ratio(fastAverage, standardAverage),
  };
}

/** Return bounded observed Fast/Standard usage without inferring missing tiers. */
export function fastModeAnalytics(state, receipts, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const effective = {
    fast: emptyBucket(),
    standard: emptyBucket(),
    ultrafast: emptyBucket(),
    other: emptyBucket(),
    unknown: emptyBucket(),
  };
  const requested = { fast_sources: 0, standard_sources: 0, other_sources: 0, unknown_sources: 0 };
  const groups = new Map();
  let downgradedSources = 0;
  let observedTierSources = 0;
  let observedTierTokens = 0;
  let knownTierSources = 0;
  let knownTierTokens = 0;
  let partialOrUnavailable = false;

  for (const receipt of selected) {
    for (const { source } of sourceEntries(state, receipt)) {
      const metadata = normalizeFastModeMetadata(source?.metadata);
      const requestedTier = metadata?.requested_service_tier;
      const effectiveTier = metadata?.service_tier;
      if (requestedTier === 'priority' || requestedTier === 'fast') requested.fast_sources = boundedCount(requested.fast_sources + 1);
      else if (requestedTier === 'default') requested.standard_sources = boundedCount(requested.standard_sources + 1);
      else if (requestedTier !== undefined) requested.other_sources = boundedCount(requested.other_sources + 1);
      else requested.unknown_sources = boundedCount(requested.unknown_sources + 1);

      const status = safeStatus(source, receipt);
      const total = safeTotal(source);
      const bucketName = tierBucket(effectiveTier);
      addBucket(effective[bucketName], status, total);
      if (status !== 'exact') partialOrUnavailable = true;
      const model_family = safeModelGroup(source?.metadata?.model);
      const reasoning_effort = safeEffort(source);
      if (bucketName === 'unknown') {
        continue;
      }
      observedTierSources = boundedCount(observedTierSources + 1);
      if (total !== null) observedTierTokens = boundedAdd(observedTierTokens, total);
      if (metadata?.downgraded) downgradedSources = boundedCount(downgradedSources + 1);
      // Only Fast and Standard share an observed denominator. Ultrafast, auto,
      // and flex are documented tiers but are not Fast-versus-Standard data.
      if (bucketName !== 'fast' && bucketName !== 'standard') continue;
      knownTierSources = boundedCount(knownTierSources + 1);
      if (total !== null) knownTierTokens = boundedAdd(knownTierTokens, total);
      if (status !== 'exact' || total === null) continue;
      if (model_family === 'unknown') continue;
      const key = `${model_family}\u0000${reasoning_effort}`;
      const group = groups.get(key) ?? { model_family, reasoning_effort, fast: [], standard: [] };
      if (bucketName === 'fast') group.fast.push(total);
      else group.standard.push(total);
      groups.set(key, group);
    }
  }

  const hasObservedTier = observedTierSources > 0;
  const hasKnownTier = knownTierSources > 0;
  const hasSources = selected.length > 0;
  const status = !hasSources || (!hasObservedTier && effective.unknown.sources > 0)
    ? 'unavailable'
    : partialOrUnavailable || effective.unknown.sources > 0 ? 'partial' : 'exact';
  const knownTierShare = knownTierTokens > 0
    ? ratio(effective.fast.total_tokens ?? 0, knownTierTokens)
    : null;
  const comparisonResult = comparison(groups, hasKnownTier);
  return {
    fast_mode_schema_version: FAST_MODE_SCHEMA_VERSION,
    status,
    turns: selected.length,
    requested,
    effective,
    downgraded_sources: downgradedSources,
    observed_tier_sources: observedTierSources,
    observed_tier_tokens: hasObservedTier ? observedTierTokens : null,
    known_tier_sources: knownTierSources,
    known_tier_tokens: hasKnownTier ? knownTierTokens : null,
    fast_token_share_of_known_tiers: knownTierShare,
    coverage: hasObservedTier ? (effective.unknown.sources > 0 ? 'partial_effective_service_tier' : 'effective_service_tier_observed') : 'unavailable',
    comparison: comparisonResult,
  };
}
