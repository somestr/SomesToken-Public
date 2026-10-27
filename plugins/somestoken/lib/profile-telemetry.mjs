import {
  modelFamily,
  ROUTING_EFFORTS,
  ROUTING_USAGE_SCHEMA_VERSION,
} from './routing.mjs';
import { accountingSignalForTurn, publicTurnBreakdown, qualitySummary } from './reporting.mjs';

export const PROFILE_TELEMETRY_SCHEMA_VERSION = 1;

const MAX_TURNS = 100;
const MAX_SOURCES = MAX_TURNS * 33;
const EFFORT_SET = new Set(ROUTING_EFFORTS);
const FAMILY_ORDER = Object.freeze(['luna', 'terra', 'sol', 'astra', 'unknown']);
const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'unknown']);
const SOURCE_STATUSES = new Set(['exact', 'partial', 'unavailable']);

function selectedReceipts(receipts, options = {}) {
  if (!Array.isArray(receipts)) return [];
  const requested = Number.isSafeInteger(options.last) ? options.last : MAX_TURNS;
  const count = Math.min(MAX_TURNS, Math.max(1, requested));
  return receipts.filter((entry) => entry && typeof entry === 'object').slice(-count);
}

function safeEffort(value) {
  return EFFORT_SET.has(value) ? value : 'unknown';
}

function safeStatus(value) {
  return SOURCE_STATUSES.has(value) ? value : 'unavailable';
}

function safeTotal(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function addBounded(left, right) {
  if (left > Number.MAX_SAFE_INTEGER - right) return Number.MAX_SAFE_INTEGER;
  return left + right;
}

function profileBucket(model_family, reasoning_effort) {
  return {
    model_family,
    reasoning_effort,
    sources: 0,
    total_tokens: null,
    exact_sources: 0,
    partial_sources: 0,
    unavailable_sources: 0,
    main_sources: 0,
    subagent_sources: 0,
    _known_sources: 0,
  };
}

function addSource(buckets, source, kind) {
  const model_family = modelFamily(source?.model);
  const reasoning_effort = safeEffort(source?.reasoning_effort);
  const key = `${model_family}\u0000${reasoning_effort}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = profileBucket(model_family, reasoning_effort);
    buckets.set(key, bucket);
  }
  bucket.sources = Math.min(MAX_SOURCES, bucket.sources + 1);
  if (kind === 'main') bucket.main_sources = Math.min(MAX_SOURCES, bucket.main_sources + 1);
  else bucket.subagent_sources = Math.min(MAX_SOURCES, bucket.subagent_sources + 1);

  const status = safeStatus(source?.status);
  if (status === 'exact') bucket.exact_sources = Math.min(MAX_SOURCES, bucket.exact_sources + 1);
  else if (status === 'partial') bucket.partial_sources = Math.min(MAX_SOURCES, bucket.partial_sources + 1);
  else bucket.unavailable_sources = Math.min(MAX_SOURCES, bucket.unavailable_sources + 1);

  const total = safeTotal(source?.usage?.total_tokens);
  if (total === null) return;
  bucket.total_tokens = addBounded(bucket.total_tokens ?? 0, total);
  bucket._known_sources = Math.min(MAX_SOURCES, bucket._known_sources + 1);
}

function roundedRatio(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function cleanProfiles(buckets) {
  return [...buckets.values()]
    .map((bucket) => {
      const { _known_sources, ...output } = bucket;
      return {
        ...output,
        average_tokens_per_source: _known_sources > 0
          ? roundedRatio(output.total_tokens, _known_sources)
          : null,
      };
    })
    .sort((left, right) => {
      const family = FAMILY_ORDER.indexOf(left.model_family) - FAMILY_ORDER.indexOf(right.model_family);
      if (family !== 0) return family;
      return EFFORT_ORDER.indexOf(left.reasoning_effort) - EFFORT_ORDER.indexOf(right.reasoning_effort);
    })
    .slice(0, MAX_TURNS);
}

function cleanRoutingBuckets(buckets) {
  return cleanProfiles(buckets).map(({
    average_tokens_per_source,
    main_sources,
    subagent_sources,
    ...output
  }) => output);
}

function sourceTotal(source) {
  return safeTotal(source?.usage?.total_tokens);
}

function collectProfileAnalytics(state, receipts, options = {}) {
  const selected = selectedReceipts(receipts, options);
  const combinedBuckets = new Map();
  const mainBuckets = new Map();
  const subagentBuckets = new Map();
  let mainTokens = 0;
  let subagentTokens = 0;
  let mainKnown = false;
  let subagentKnown = false;
  let allExact = selected.length > 0;
  let allUnavailable = selected.length > 0;

  for (const receipt of selected) {
    const breakdown = publicTurnBreakdown(state, receipt);
    const main = breakdown.main && typeof breakdown.main === 'object' ? breakdown.main : { status: 'unavailable' };
    const subagents = Array.isArray(breakdown.subagents) ? breakdown.subagents : [];
    addSource(combinedBuckets, main, 'main');
    addSource(mainBuckets, main, 'main');

    const mainTotal = sourceTotal(main);
    if (mainTotal !== null) {
      mainKnown = true;
      mainTokens = addBounded(mainTokens, mainTotal);
    }
    if (safeStatus(main.status) !== 'unavailable') allUnavailable = false;

    for (const subagent of subagents) {
      addSource(combinedBuckets, subagent, 'subagent');
      addSource(subagentBuckets, subagent, 'subagent');
      const subagentTotal = sourceTotal(subagent);
      if (subagentTotal !== null) {
        subagentKnown = true;
        subagentTokens = addBounded(subagentTokens, subagentTotal);
      }
      if (safeStatus(subagent.status) !== 'unavailable') allUnavailable = false;
    }

    const accounting = accountingSignalForTurn(receipt, breakdown);
    if (receipt.status !== 'exact' || breakdown.status !== 'exact'
      || accounting.source_total_mismatch || accounting.usage_consistency === 'inconsistent') allExact = false;
  }

  const totalKnown = mainKnown || subagentKnown;
  const totalTokens = totalKnown ? addBounded(mainKnown ? mainTokens : 0, subagentKnown ? subagentTokens : 0) : null;
  const quality = qualitySummary(selected, state?.health ?? null, {
    last: selected.length || 1,
    state,
  });
  const status = !selected.length || allUnavailable
    ? 'unavailable'
    : allExact && quality.source_total_mismatches === 0 && quality.usage_inconsistent === 0 ? 'exact' : 'partial';

  return {
    selected,
    combinedBuckets,
    mainBuckets,
    subagentBuckets,
    mainTokens,
    subagentTokens,
    mainKnown,
    subagentKnown,
    totalTokens,
    status,
    quality,
  };
}

export function profileTelemetryAnalytics(state, receipts, options = {}) {
  const analytics = collectProfileAnalytics(state, receipts, options);
  return {
    profile_telemetry_schema_version: PROFILE_TELEMETRY_SCHEMA_VERSION,
    status: analytics.status,
    turns: analytics.selected.length,
    profiles: cleanProfiles(analytics.combinedBuckets),
    totals: {
      main_tokens: analytics.mainKnown ? analytics.mainTokens : null,
      subagent_tokens: analytics.subagentKnown ? analytics.subagentTokens : null,
      total_tokens: analytics.totalTokens,
      subagent_share: analytics.totalTokens !== null && analytics.subagentKnown && analytics.totalTokens > 0
        ? roundedRatio(analytics.subagentTokens, analytics.totalTokens)
        : null,
    },
    quality: analytics.quality,
    target_status: 'unmeasured',
  };
}

/**
 * Return local observational use evidence grouped only by recognized model
 * family and fixed reasoning effort. This is not a routing history or a
 * causal measure of recommendation quality.
 */
export function routingUsageAnalytics(state, receipts, options = {}) {
  const analytics = collectProfileAnalytics(state, receipts, options);
  return {
    routing_usage_schema_version: ROUTING_USAGE_SCHEMA_VERSION,
    status: analytics.status,
    turns: analytics.selected.length,
    main: cleanRoutingBuckets(analytics.mainBuckets),
    subagents: cleanRoutingBuckets(analytics.subagentBuckets),
    quality: analytics.quality,
  };
}
