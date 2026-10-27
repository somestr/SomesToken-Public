import { safeModel, isSensitiveRuntimeValue } from '../core.mjs';

export const USAGE_CORE_SCHEMA_VERSION = 2;

export const QUALITY = Object.freeze(['exact', 'partial', 'unavailable']);
export const CALCULATION_QUALITY = Object.freeze(['exact', 'partial', 'unavailable']);
export const COVERAGE = Object.freeze([
  'turn_only',
  'session_only',
  'somestoken_observed',
  'host_account_window',
  'shared_pool_partial',
  'shared_pool_unknown',
  'unavailable',
]);
export const WINDOW_TYPES = Object.freeze([
  'turn',
  'session',
  'rolling_5h',
  'daily',
  'weekly',
  'billing_cycle',
  'host_defined',
]);
export const PLAN_COMPARISON_MODES = Object.freeze([
  'host_quota',
  'manual_capacity',
  'relative_only',
  'unavailable',
]);

const QUALITY_SET = new Set(QUALITY);
const COVERAGE_SET = new Set(COVERAGE);
const COMPARISON_SET = new Set(PLAN_COMPARISON_MODES);
const MEASUREMENT_BASES = new Set(['units', 'host_percent']);
const TOKEN_KEYS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'uncached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'cache_write_input_tokens',
]);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UNCACHED_INPUT_BASES = new Set(['aggregate_derived', 'receipt_lower_bound', 'unavailable']);

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE ? value : null;
}

function quality(value, fallback = 'unavailable') {
  return QUALITY_SET.has(value) ? value : fallback;
}

function coverage(value) {
  return COVERAGE_SET.has(value) ? value : 'unavailable';
}

function numericTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    const number = safeCount(value[key]);
    if (number === null) return null;
    output[key] = number;
  }
  for (const key of ['cached_input_tokens', 'reasoning_output_tokens']) {
    if (key === 'reasoning_output_tokens' && value[key] === null) {
      output[key] = null;
      continue;
    }
    const number = value[key] === undefined ? 0 : safeCount(value[key]);
    if (number === null) return null;
    output[key] = number;
  }
  // Cache-write is a separately observed optional component. It is never
  // folded into total tokens, and an absent or invalid counter stays unknown.
  output.cache_write_input_tokens = value.cache_write_input_tokens === undefined
    || value.cache_write_input_tokens === null
    ? null
    : safeCount(value.cache_write_input_tokens);
  // Compare normalized values so an omitted cache-read counter is treated as zero.
  const cachedIsSubset = output.cached_input_tokens <= output.input_tokens;
  output.uncached_input_tokens = cachedIsSubset
    ? output.input_tokens - output.cached_input_tokens
    : 0;
  return output;
}

/**
 * Normalize only numeric usage counters. `cached_input_tokens` and
 * `reasoning_output_tokens` remain subsets; neither is added to total usage.
 */
export function normalizeObservedUsage(value, options = {}) {
  const parsed = numericTokens(value);
  const parsedQuality = quality(options.quality, parsed ? 'exact' : 'unavailable');
  const invalidArithmetic = Boolean(parsed && (parsed.input_tokens > MAX_SAFE - parsed.output_tokens
    || parsed.total_tokens !== parsed.input_tokens + parsed.output_tokens
    || parsed.reasoning_output_tokens > parsed.output_tokens));
  const compositionInvalid = Boolean(parsed && parsed.cached_input_tokens > parsed.input_tokens);
  const effectiveQuality = (invalidArithmetic || compositionInvalid || value?.consistent === false) && parsedQuality === 'exact' ? 'partial' : parsedQuality;
  if (!parsed) return { quality: 'unavailable', coverage: coverage(options.coverage) };
  return {
    ...parsed,
    uncached_input_basis: invalidArithmetic ? 'unavailable' : effectiveQuality === 'exact' && !compositionInvalid ? 'aggregate_derived' : 'receipt_lower_bound',
    ...(invalidArithmetic ? { reason_codes: ['invalid_token_composition'] } : {}),
    quality: effectiveQuality,
    coverage: coverage(options.coverage),
  };
}

function safeDecimal(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function calculatedLayer(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = { quality: quality(source.quality ?? source.calculation_quality, 'unavailable') };
  if (QUALITY_SET.has(source.calculation_quality)) output.calculation_quality = source.calculation_quality;
  const credits = safeDecimal(source.calculated_codex_credits);
  const cost = safeDecimal(source.calculated_api_cost);
  if (credits !== null) output.calculated_codex_credits = credits;
  if (cost !== null) output.calculated_api_cost = cost;
  for (const key of ['uncached_input_credits', 'cached_input_credits', 'output_credits']) {
    const valueNumber = safeDecimal(source[key]);
    if (valueNumber !== null) output[key] = valueNumber;
  }
  if (source.lower_bound === true) output.lower_bound = true;
  if (typeof source.display_value === 'string' && /^[≥0-9.]{1,32}$/.test(source.display_value)) output.display_value = source.display_value;
  if (Array.isArray(source.unpriced_components)) {
    const components = source.unpriced_components.filter((entry) => typeof entry === 'string' && /^[a-z_]{1,64}$/.test(entry) && !isSensitiveRuntimeValue(entry));
    if (components.length) output.unpriced_components = [...new Set(components)].slice(0, 16);
  }
  if (typeof source.rate_profile_id === 'string' && safeModel(source.rate_profile_id.replaceAll('+', '.'))) output.rate_profile_id = source.rate_profile_id;
  if (typeof source.rate_profile_effective_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(source.rate_profile_effective_at)
    && Number.isFinite(Date.parse(source.rate_profile_effective_at))) output.rate_profile_effective_at = source.rate_profile_effective_at;
  return output;
}

/** Normalize the four public usage layers without retaining unknown content. */
export function normalizeUsageLayers(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const observedSource = source.observed && typeof source.observed === 'object' ? source.observed : null;
  const observed = normalizeObservedUsage(observedSource, {
    quality: observedSource?.quality,
    coverage: source.coverage,
  });
  if (observedSource && UNCACHED_INPUT_BASES.has(observedSource.uncached_input_basis)
    && observed.quality !== 'unavailable' && !observed.reason_codes?.includes('invalid_token_composition')
    && (observedSource.uncached_input_basis !== 'aggregate_derived' || observed.quality === 'exact')) {
    observed.uncached_input_basis = observedSource.uncached_input_basis;
  }
  const comparisonMode = COMPARISON_SET.has(source.comparison_mode) ? source.comparison_mode : 'unavailable';
  const output = {
    usage_schema_version: USAGE_CORE_SCHEMA_VERSION,
    observed,
    calculated: observedSource && (observed.quality === 'unavailable' || observed.reason_codes?.includes('invalid_token_composition'))
      ? { quality: 'unavailable', calculation_quality: 'unavailable' }
      : calculatedLayer(source.calculated),
    coverage: coverage(source.coverage),
    comparison_mode: comparisonMode,
  };
  if (observed.quality === 'partial') {
    if (output.calculated.quality === 'exact') output.calculated.quality = 'partial';
    if (output.calculated.calculation_quality === 'exact') output.calculated.calculation_quality = 'partial';
  }
  if (source.quota && typeof source.quota === 'object' && !Array.isArray(source.quota)) {
    output.quota = {
      quality: quality(source.quota.quality),
      coverage: coverage(source.quota.coverage ?? source.coverage),
      ...(MEASUREMENT_BASES.has(source.quota.measurement_basis)
        ? { measurement_basis: source.quota.measurement_basis }
        : {}),
    };
  }
  return output;
}

export { TOKEN_KEYS };
