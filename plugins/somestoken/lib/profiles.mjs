import {
  MODEL_FAMILIES,
  ROUTING_EFFORTS,
  normalizeRoutingDescriptor,
  recommendRouting,
} from './routing.mjs';

export const PROFILE_SCHEMA_VERSION = 2;

const MODEL_IDS = Object.freeze({
  astra: 'gpt-6-astra',
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
});
const MODEL_FAMILY_SET = new Set(MODEL_FAMILIES);
const EFFORT_SET = new Set(ROUTING_EFFORTS);
const ROLE_SET = new Set(['primary', 'worker']);
const HOST_PROFILE_LIMIT = MODEL_FAMILIES.length * ROUTING_EFFORTS.length * ROLE_SET.size;
const OBSERVED_PROFILE_LIMIT = MODEL_FAMILIES.length * ROUTING_EFFORTS.length;

export function profileModelId(value) {
  return Object.hasOwn(MODEL_IDS, value) ? MODEL_IDS[value] : 'unknown';
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeProfileCapabilities(value) {
  const source = safeObject(value);
  const hostVerified = [];
  const hostSeen = new Set();
  for (const entry of Array.isArray(source.host_verified_profiles) ? source.host_verified_profiles : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!MODEL_FAMILY_SET.has(entry.model_family)
      || !EFFORT_SET.has(entry.reasoning_effort)
      || !ROLE_SET.has(entry.role)) continue;
    const key = `${entry.model_family}\u0000${entry.reasoning_effort}\u0000${entry.role}`;
    if (hostSeen.has(key)) continue;
    hostSeen.add(key);
    hostVerified.push({
      model_family: entry.model_family,
      reasoning_effort: entry.reasoning_effort,
      role: entry.role,
    });
    if (hostVerified.length === HOST_PROFILE_LIMIT) break;
  }

  const observed = [];
  const observedSeen = new Set();
  for (const entry of Array.isArray(source.observed_profiles) ? source.observed_profiles : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!MODEL_FAMILY_SET.has(entry.model_family) || !EFFORT_SET.has(entry.reasoning_effort)) continue;
    const key = `${entry.model_family}\u0000${entry.reasoning_effort}`;
    if (observedSeen.has(key)) continue;
    observedSeen.add(key);
    observed.push({ model_family: entry.model_family, reasoning_effort: entry.reasoning_effort });
    if (observed.length === OBSERVED_PROFILE_LIMIT) break;
  }

  return { host_verified_profiles: hostVerified, observed_profiles: observed };
}

function hasProfile(entries, family, effort, role) {
  return entries.some((entry) => entry.model_family === family
    && entry.reasoning_effort === effort
    && (!role || entry.role === role));
}

function hasObserved(entries, family, effort) {
  return entries.some((entry) => entry.model_family === family && entry.reasoning_effort === effort);
}

function primaryAvailability(recommendation, capabilities) {
  const family = recommendation.primary.model_family;
  const effort = recommendation.primary.reasoning_effort;
  if (recommendation.primary.availability === 'fallback') return 'fallback';
  if (hasProfile(capabilities.host_verified_profiles, family, effort, 'primary')) return 'host_verified';
  if (hasObserved(capabilities.observed_profiles, family, effort)) return 'observed';
  return recommendation.primary.availability;
}

function workerAvailability(workers, capabilities) {
  if (workers.model_family === 'host_default') return 'host_required';
  if (workers.model_family === 'none') return 'not_applicable';
  if (hasProfile(capabilities.host_verified_profiles, workers.model_family, workers.reasoning_effort, 'worker')) {
    return 'host_verified';
  }
  if (hasObserved(capabilities.observed_profiles, workers.model_family, workers.reasoning_effort)) return 'observed';
  return 'unverified';
}

function profilePrimary(recommendation, capabilities) {
  return {
    model_family: recommendation.primary.model_family,
    model_id: profileModelId(recommendation.primary.model_family),
    reasoning_effort: recommendation.primary.reasoning_effort,
    availability: primaryAvailability(recommendation, capabilities),
  };
}

function profileWorkers(recommendation, capabilities) {
  const workers = recommendation.workers;
  const modelId = ['none', 'host_default'].includes(workers.model_family)
    ? null
    : profileModelId(workers.model_family);
  return {
    cap: workers.cap,
    model_family: workers.model_family,
    model_id: modelId,
    reasoning_effort: workers.reasoning_effort,
    mode: workers.mode,
    availability: workerAvailability(workers, capabilities),
  };
}

function applyPrimaryVerification(recommendation, verified) {
  // The profile plan and its nested routing recommendation must agree on the
  // same exact family, effort, and primary role evidence. Router capabilities
  // currently describe effort availability, so apply the role-aware profile
  // evidence at this boundary and raise confidence only for that exact match.
  if (!verified || recommendation.primary.availability === 'fallback') return recommendation;
  return {
    ...recommendation,
    confidence: 'high',
    primary: {
      ...recommendation.primary,
      availability: 'host_verified',
    },
  };
}

export function buildProfilePlan(descriptor, capabilities = {}) {
  const normalized = normalizeRoutingDescriptor(descriptor);
  if (!normalized) return null;
  const safeCapabilities = normalizeProfileCapabilities(capabilities);
  // Resolve against the complete finite effort catalog first. This gives an
  // adaptive Ultra request a concrete model/effort pair to verify while
  // retaining the exact model/effort pair selected by a pinned descriptor.
  const probeRecommendation = recommendRouting(normalized, {
    host_verified_efforts: ROUTING_EFFORTS,
    observed_profiles: safeCapabilities.observed_profiles,
  });
  if (!probeRecommendation) return null;
  const primaryVerified = hasProfile(
    safeCapabilities.host_verified_profiles,
    probeRecommendation.primary.model_family,
    probeRecommendation.primary.reasoning_effort,
    'primary',
  );
  const recommendation = recommendRouting(normalized, {
    host_verified_efforts: primaryVerified ? [probeRecommendation.primary.reasoning_effort] : [],
    observed_profiles: safeCapabilities.observed_profiles,
  });
  if (!recommendation) return null;
  const verifiedRecommendation = applyPrimaryVerification(recommendation, primaryVerified);

  return {
    profile_schema_version: PROFILE_SCHEMA_VERSION,
    status: recommendation.status === 'constraint_conflict' ? 'constraint_conflict' : 'planned',
    advisory_action: 'review_only',
    application_status: 'host_required',
    host_action: 'apply_profile_if_supported',
    monitoring_action: 'continue_current_task',
    descriptor: normalized,
    recommendation: verifiedRecommendation,
    primary: profilePrimary(verifiedRecommendation, safeCapabilities),
    workers: profileWorkers(verifiedRecommendation, safeCapabilities),
    fallback_code: verifiedRecommendation.fallback_code,
    reason_codes: [...verifiedRecommendation.reason_codes],
  };
}
