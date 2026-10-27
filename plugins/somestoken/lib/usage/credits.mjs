import { normalizeObservedUsage } from './schema.mjs';

export const CREDIT_SCHEMA_VERSION = 1;
export const CODEX_RATE_PROFILE_ID = 'codex_credits_2026_09_30';

const AUGUST_RATE_PROFILES = Object.freeze({
  'gpt-5.6-sol': { input: 125, cached: 12.5, output: 750 },
  'gpt-5.5-cyber': { input: 312.5, cached: 31.25, output: 1875 },
  'gpt-5.6-terra': { input: 50, cached: 5, output: 300 },
  'gpt-5.6-luna': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.5': { input: 125, cached: 12.5, output: 750 },
  'gpt-5.4': { input: 62.5, cached: 6.25, output: 375 },
  'gpt-5.4-mini': { input: 18.75, cached: 1.875, output: 113 },
});

const SEPTEMBER_8_RATE_PROFILES = Object.freeze({
  ...AUGUST_RATE_PROFILES,
  'gpt-6-astra': Object.freeze({ input: 250, cached: 25, output: 1250 }),
  'gpt-5.6-sol': Object.freeze({ input: 100, cached: 10, output: 500 }),
});

// Read from the pricing page on 2026-09-30; earlier models are unchanged.
const CODEX_RATE_PROFILES = Object.freeze({
  ...SEPTEMBER_8_RATE_PROFILES,
  'gpt-6.1-sol': Object.freeze({ input: 50, cached: 2.5, output: 250 }),
  'gpt-6-sol': Object.freeze({ input: 50, cached: 5, output: 250 }),
  'gpt-6-luna': Object.freeze({ input: 2.5, cached: 0.25, output: 12.5 }),
});

// Program labels are aliases only. Pricing and lifecycle keys remain canonical
// provider model IDs so a host display rename cannot change accounting.
export const CODEX_MODEL_ALIASES = Object.freeze({
  'daybreak-blue': 'gpt-5.6-sol',
  'daybreak-red': 'gpt-5.5-cyber',
});

const CODEX_MODEL_METADATA = Object.freeze({
  'gpt-6-astra': Object.freeze({ display_name: 'GPT-6 Astra', program: null, aliases: [] }),
  'gpt-6.1-sol': Object.freeze({ display_name: 'GPT-6.1 Sol', program: null, aliases: [] }),
  'gpt-6-sol': Object.freeze({ display_name: 'GPT-6 Sol', program: null, aliases: [] }),
  'gpt-6-luna': Object.freeze({ display_name: 'GPT-6 Luna', program: null, aliases: [] }),
  'gpt-5.6-sol': Object.freeze({ display_name: 'GPT-5.6 Sol', program: null, aliases: ['daybreak-blue'] }),
  'gpt-5.5-cyber': Object.freeze({ display_name: 'GPT-5.5 Cyber', program: 'daybreak', aliases: ['daybreak-red'] }),
  'gpt-5.6-terra': Object.freeze({ display_name: 'GPT-5.6 Terra', program: null, aliases: [] }),
  'gpt-5.6-luna': Object.freeze({ display_name: 'GPT-5.6 Luna', program: null, aliases: [] }),
  'gpt-5.5': Object.freeze({ display_name: 'GPT-5.5', program: null, aliases: [] }),
  'gpt-5.4': Object.freeze({ display_name: 'GPT-5.4', program: null, aliases: [] }),
  'gpt-5.4-mini': Object.freeze({ display_name: 'GPT-5.4 Mini', program: null, aliases: [] }),
});

// Retirement is surface-specific: OpenAI's ChatGPT-account Codex notice retires
// GPT-5.4 and GPT-5.4 mini on 2026-08-31, while API access is unaffected.
export const CODEX_MODEL_LIFECYCLES = Object.freeze({
  'gpt-5.4': Object.freeze({ chatgpt_codex_retirement_at: '2026-08-31T00:00:00.000Z' }),
  'gpt-5.4-mini': Object.freeze({ chatgpt_codex_retirement_at: '2026-08-31T00:00:00.000Z' }),
});

export const CODEX_RATE_PROFILE = Object.freeze({
  profile_id: CODEX_RATE_PROFILE_ID,
  provider: 'codex',
  // Retrieval establishes a safe lookup boundary, not the provider's launch date.
  effective_from: '2026-09-30T21:02:00.000Z',
  effective_until: null,
  source_checked_at: '2026-09-30T21:02:00.000Z',
  source_url: 'https://learn.chatgpt.com/docs/pricing',
  models: CODEX_RATE_PROFILES,
  model_lifecycles: CODEX_MODEL_LIFECYCLES,
});

export const CODEX_RATE_PROFILE_HISTORY = Object.freeze([
  Object.freeze({
    ...CODEX_RATE_PROFILE,
    profile_id: 'codex_credits_2026_08_20',
    effective_from: '2026-08-20T00:00:00.000Z',
    effective_until: '2026-09-08T14:09:45.000Z',
    source_checked_at: '2026-08-20T00:00:00.000Z',
    models: AUGUST_RATE_PROFILES,
  }),
  Object.freeze({
    ...CODEX_RATE_PROFILE,
    profile_id: 'codex_credits_2026_09_08',
    effective_from: '2026-09-08T14:09:45.000Z',
    effective_until: CODEX_RATE_PROFILE.effective_from,
    source_checked_at: '2026-09-08T14:09:45.000Z',
    models: SEPTEMBER_8_RATE_PROFILES,
  }),
  CODEX_RATE_PROFILE,
]);

export function canonicalCodexModel(model) {
  if (typeof model !== 'string') return undefined;
  return Object.hasOwn(CODEX_MODEL_ALIASES, model) ? CODEX_MODEL_ALIASES[model] : model;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function getCodexRateProfile(model, at = new Date().toISOString()) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const profile = CODEX_RATE_PROFILE_HISTORY.find((entry) => time >= Date.parse(entry.effective_from)
    && (!entry.effective_until || time < Date.parse(entry.effective_until)));
  if (!profile) return null;
  const canonicalModel = canonicalCodexModel(model);
  if (!Object.hasOwn(profile.models, canonicalModel)) return null;
  // The published promotion is guaranteed through November 21 only.
  if (canonicalModel === 'gpt-5.6-sol' && profile === CODEX_RATE_PROFILE
    && time >= Date.parse('2026-11-22T00:00:00.000Z')) return null;
  const rates = profile.models[canonicalModel];
  return rates ? {
    ...rates,
    model_id: canonicalModel,
    canonical_model: canonicalModel,
    ...(CODEX_MODEL_METADATA[canonicalModel] ?? {}),
    profile_id: profile.profile_id,
    effective_from: profile.effective_from,
    source_url: profile.source_url,
    source_checked_at: profile.source_checked_at,
    ...(CODEX_MODEL_LIFECYCLES[canonicalModel] ?? {}),
  } : null;
}

export function calculateCodexCredits(value, options = {}) {
  const observed = normalizeObservedUsage(value, { quality: options.quality ?? value?.quality, coverage: value?.coverage });
  const model = typeof options.model === 'string' ? options.model : undefined;
  const rates = getCodexRateProfile(model, options.at ?? new Date().toISOString());
  if (!rates) return { calculation_quality: 'unavailable', unpriced_components: ['model_rate_unavailable'] };
  const input = safeCount(observed.input_tokens);
  const cached = safeCount(observed.cached_input_tokens);
  const output = safeCount(observed.output_tokens);
  if (input === null || cached === null || output === null || observed.quality === 'unavailable'
    || observed.reason_codes?.includes('invalid_token_composition')) {
    return { calculation_quality: 'unavailable', unpriced_components: ['token_receipt_unavailable'] };
  }
  const uncached = Math.max(0, input - cached);
  const uncachedCredits = round((uncached * rates.input) / 1_000_000);
  const cachedCredits = round((cached * rates.cached) / 1_000_000);
  const outputCredits = round((output * rates.output) / 1_000_000);
  const result = {
    credit_schema_version: CREDIT_SCHEMA_VERSION,
    rate_profile_id: rates.profile_id,
    rate_profile_effective_at: rates.effective_from,
    uncached_input_credits: uncachedCredits,
    cached_input_credits: cachedCredits,
    output_credits: outputCredits,
    calculated_codex_credits: round(uncachedCredits + cachedCredits + outputCredits),
    calculation_quality: observed.quality === 'partial' ? 'partial' : 'exact',
  };
  if (observed.quality === 'partial') {
    result.lower_bound = true;
    result.display_value = `≥${result.calculated_codex_credits}`;
  } else {
    result.display_value = String(result.calculated_codex_credits);
  }
  if (Number.isSafeInteger(observed.cache_write_input_tokens) && observed.cache_write_input_tokens > 0) {
    result.unpriced_components = ['cache_write_input_tokens'];
  }
  return result;
}

export const AUTO_REVIEW_ESTIMATE_LABEL = 'model not exposed by host; estimate';

// Scenarios for observed tokens, not a host price, billed total or quota estimate.
export function estimateAutoReviewCredits(value) {
  const usage = { ...value, total_tokens: value?.total_tokens ?? value?.input_tokens + value?.output_tokens };
  if (value?.consistent === false || usage.cached_input_tokens > usage.input_tokens) return null;
  const lower = calculateCodexCredits(usage, { model: 'gpt-6-luna', at: CODEX_RATE_PROFILE.effective_from });
  const upper = calculateCodexCredits(usage, { model: 'gpt-6.1-sol', at: CODEX_RATE_PROFILE.effective_from });
  if (!Number.isFinite(lower.calculated_codex_credits) || !Number.isFinite(upper.calculated_codex_credits)) return null;
  return { label: AUTO_REVIEW_ESTIMATE_LABEL, lower_credits: lower.calculated_codex_credits, upper_credits: upper.calculated_codex_credits,
    lower_model: 'gpt-6-luna', upper_model: 'gpt-6.1-sol', rate_profile_id: CODEX_RATE_PROFILE_ID,
    basis: 'observed_tokens_at_assumed_model_rates' };
}

export function calculateApiCost(value, rates = {}) {
  const observed = normalizeObservedUsage(value, { quality: rates.quality ?? value?.quality });
  const inputRate = Number.isFinite(rates.input_cost_per_million) && rates.input_cost_per_million >= 0 ? rates.input_cost_per_million : null;
  const cachedRate = Number.isFinite(rates.cached_input_cost_per_million) && rates.cached_input_cost_per_million >= 0 ? rates.cached_input_cost_per_million : null;
  const outputRate = Number.isFinite(rates.output_cost_per_million) && rates.output_cost_per_million >= 0 ? rates.output_cost_per_million : null;
  if (observed.quality === 'unavailable' || observed.reason_codes?.includes('invalid_token_composition')
    || inputRate === null || cachedRate === null || outputRate === null) return { calculation_quality: 'unavailable' };
  const uncached = Math.max(0, observed.input_tokens - observed.cached_input_tokens);
  const cost = round((uncached * inputRate + observed.cached_input_tokens * cachedRate + observed.output_tokens * outputRate) / 1_000_000);
  if (!Number.isFinite(cost)) return { calculation_quality: 'unavailable' };
  return {
    calculation_quality: observed.quality === 'partial' ? 'partial' : 'exact',
    calculated_api_cost: cost,
    ...(observed.quality === 'partial' ? { lower_bound: true } : {}),
    ...(observed.cache_write_input_tokens > 0 ? { unpriced_components: ['cache_write_input_tokens'] } : {}),
  };
}

export { CODEX_RATE_PROFILES };
