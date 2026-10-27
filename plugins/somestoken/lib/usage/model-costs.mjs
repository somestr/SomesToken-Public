export const MODEL_COST_SCHEMA_VERSION = 1;

// A verified snapshot, not evidence that these rates applied before retrieval.
export const MODEL_COST_PROFILE = Object.freeze({
  profile_id: 'openai_api_usd_2026_09_08',
  source_url: 'https://developers.openai.com/api/docs/pricing',
  source_checked_at: '2026-09-08T14:09:45.000Z',
  effective_from: '2026-09-08T14:09:45.000Z',
  currency: 'USD',
  basis: 'api_token_dollar_equivalent',
});

const RATES = Object.freeze({
  'gpt-6-astra': Object.freeze({ input: 10, cached: 1, output: 50 }),
  'gpt-5.6-sol': Object.freeze({ input: 4, cached: 0.4, output: 20 }),
  'gpt-5.6-terra': Object.freeze({ input: 2, cached: 0.2, output: 12 }),
  'gpt-5.6-luna': Object.freeze({ input: 0.2, cached: 0.02, output: 1.2 }),
});
const TIERS = Object.freeze({ standard: 1, default: 1, fast: 2, priority: 2, batch: 0.5, flex: 0.5 });
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const round = (value) => Math.round(value * 1e9) / 1e9;

/**
 * Quotes observed text token components at direct OpenAI API list rates.
 * This is neither a billed charge nor a ChatGPT credit/quota conversion.
 * `single_request: true` permits the long-context rate to be selected from
 * this receipt's input. Aggregated input above 272K cannot establish which
 * requests incurred long-context pricing, so its short-rate quote is partial.
 * Reasoning effort changes usage, not the rate; reasoning is already in output.
 * `at` is the event time as an ISO string or epoch milliseconds.
 */
export function quoteModelUsage(usage, options = {}) {
  const base = {
    model_cost_schema_version: MODEL_COST_SCHEMA_VERSION,
    rate_profile_id: MODEL_COST_PROFILE.profile_id,
    source_url: MODEL_COST_PROFILE.source_url,
    source_checked_at: MODEL_COST_PROFILE.source_checked_at,
    rate_profile_effective_at: MODEL_COST_PROFILE.effective_from,
    currency: MODEL_COST_PROFILE.currency,
    basis: MODEL_COST_PROFILE.basis,
  };
  const unavailable = (reason) => ({ ...base, calculation_quality: 'unavailable', unpriced_components: [reason] });
  const model = options.model;
  if (typeof model !== 'string' || !Object.hasOwn(RATES, model)) return unavailable('model_rate_unavailable');
  const tier = options.service_tier;
  if (typeof tier !== 'string' || !Object.hasOwn(TIERS, tier)) return unavailable('service_tier_unavailable');
  // Missing event dates cannot safely be priced at today's rates.
  const at = typeof options.at === 'number' ? options.at : typeof options.at === 'string' ? Date.parse(options.at) : NaN;
  if (!Number.isFinite(at) || at < Date.parse(MODEL_COST_PROFILE.effective_from)) return unavailable('historical_rate_unavailable');
  if (model === 'gpt-5.6-sol' && at >= Date.parse('2026-11-22T00:00:00.000Z')) return unavailable('promotional_rate_requires_reverification');
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)
    || !['input_tokens', 'cached_input_tokens', 'output_tokens'].every((key) => count(usage[key]))
    || usage.quality === 'unavailable'
    || (usage.quality !== undefined && !['exact', 'partial'].includes(usage.quality))) return unavailable('token_receipt_unavailable');
  if (usage.cached_input_tokens > usage.input_tokens
    || (usage.reasoning_output_tokens !== undefined && (!count(usage.reasoning_output_tokens) || usage.reasoning_output_tokens > usage.output_tokens))) return unavailable('invalid_token_composition');
  if (usage.total_tokens !== undefined && (!count(usage.total_tokens)
    || usage.total_tokens !== usage.input_tokens + usage.output_tokens)) return unavailable('invalid_token_composition');
  const unpriced = [];
  if (usage.quality === 'partial') unpriced.push('incomplete_token_receipt');
  if (usage.cache_write_input_tokens != null && usage.cache_write_input_tokens !== 0) unpriced.push('cache_write_input_tokens');
  const long = usage.input_tokens > 272_000 && options.single_request === true;
  if (usage.input_tokens > 272_000 && options.single_request !== true) unpriced.push('request_context_unavailable');
  const rates = RATES[model];
  const multiplier = TIERS[tier];
  const inputRate = rates.input * multiplier * (long ? 2 : 1);
  const cachedRate = rates.cached * multiplier * (long ? 2 : 1);
  const outputRate = rates.output * multiplier * (long ? 1.5 : 1);
  const uncached = usage.input_tokens - usage.cached_input_tokens;
  return {
    ...base,
    model,
    service_tier: tier,
    context_pricing: long ? 'long' : (unpriced.includes('request_context_unavailable') ? 'short_rate_lower_bound' : 'short'),
    rates_per_million: { input: inputRate, cached_input: cachedRate, output: outputRate },
    calculated_dollar_equivalent: round((uncached * inputRate + usage.cached_input_tokens * cachedRate + usage.output_tokens * outputRate) / 1_000_000),
    calculation_quality: unpriced.length ? 'partial' : 'exact',
    ...(unpriced.length ? { unpriced_components: unpriced, lower_bound: true } : {}),
  };
}
