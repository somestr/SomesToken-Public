export const ROUTING_SCHEMA_VERSION = 1;
export const ROUTING_USAGE_SCHEMA_VERSION = 1;
export const ROUTES = Object.freeze(['light', 'medium', 'heavy', 'ultra']);
export const TASK_SHAPES = Object.freeze(['inspect', 'bounded_fix', 'diagnosis', 'migration', 'security', 'release']);
export const RISKS = Object.freeze(['low', 'medium', 'high']);
export const PARALLELISM = Object.freeze(['none', 'limited', 'independent']);
export const MODEL_FAMILIES = Object.freeze(['luna', 'terra', 'sol', 'astra']);
export const ROUTING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const ROUTE_SET = new Set(ROUTES);
const TASK_SHAPE_SET = new Set(TASK_SHAPES);
const RISK_SET = new Set(RISKS);
const PARALLELISM_SET = new Set(PARALLELISM);
const MODEL_FAMILY_SET = new Set(MODEL_FAMILIES);
const EFFORT_SET = new Set(ROUTING_EFFORTS);
const POLICY_SET = new Set(['adaptive', 'pinned']);
const ROUTING_PROFILE_LIMIT = MODEL_FAMILIES.length * ROUTING_EFFORTS.length;
const EFFORT_RANK = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 });
const REASON_ORDER = Object.freeze([
  'ROUTE_LIGHT',
  'ROUTE_MEDIUM',
  'ROUTE_HEAVY',
  'ROUTE_ULTRA',
  'TASK_SIMPLE',
  'TASK_DIAGNOSTIC',
  'TASK_MIGRATION',
  'TASK_SECURITY',
  'TASK_RELEASE',
  'RISK_LOW',
  'RISK_HIGH',
  'LUNA_EFFICIENCY',
  'TERRA_BALANCE',
  'SOL_ESCALATION',
  'INDEPENDENT_WORK',
  'SINGLE_WRITER',
  'PINNED_SELECTION',
  'REDUCED_EFFORT',
  'HOST_CAPABILITY_UNVERIFIED',
  'ULTRA_UNAVAILABLE',
  'EFFORT_CEILING_TOO_LOW',
]);
const ROUTING_FLAGS = Object.freeze({
  '--route': 'route',
  '--task-shape': 'task_shape',
  '--risk': 'risk',
  '--parallelism': 'parallelism',
  '--model-family': 'model_preference',
  '--effort-ceiling': 'effort_ceiling',
  '--policy': 'policy',
  '--pinned-model': 'pinned_model',
  '--pinned-effort': 'pinned_effort',
});
const INCOMPATIBLE_REPORT_FLAGS = new Set(['--quality', '--usage', '--health', '--summary', '--breakdown', '--profiles']);

export function modelFamily(value) {
  if (value === 'gpt-6-astra') return 'astra';
  if (value === 'gpt-5.6-luna') return 'luna';
  if (value === 'gpt-5.6-terra') return 'terra';
  if (value === 'gpt-5.6-sol') return 'sol';
  return 'unknown';
}

export function normalizeRoutingDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema_version !== 1
    || !ROUTE_SET.has(value.route)
    || !TASK_SHAPE_SET.has(value.task_shape)
    || !RISK_SET.has(value.risk)
    || !PARALLELISM_SET.has(value.parallelism)
    || !MODEL_FAMILY_SET.has(value.model_preference)
    || !EFFORT_SET.has(value.effort_ceiling)
    || !POLICY_SET.has(value.policy)) return null;

  const normalized = {
    schema_version: 1,
    route: value.route,
    task_shape: value.task_shape,
    risk: value.risk,
    parallelism: value.parallelism,
    model_preference: value.model_preference,
    effort_ceiling: value.effort_ceiling,
    policy: value.policy,
  };
  if (value.policy !== 'pinned') return normalized;
  if (!MODEL_FAMILY_SET.has(value.pinned_model)
    || !EFFORT_SET.has(value.pinned_effort)
    || value.pinned_model !== value.model_preference
    || value.pinned_effort !== value.effort_ceiling) return null;
  return { ...normalized, pinned_model: value.pinned_model, pinned_effort: value.pinned_effort };
}

export function parseRoutingArgs(argv) {
  if (!Array.isArray(argv)) return { ok: false, code: 'invalid_routing_command' };
  let recommend = false;
  let json = false;
  let profilePlan = false;
  let last;
  const values = {};
  for (const argument of argv) {
    if (typeof argument !== 'string') return { ok: false, code: 'invalid_routing_command' };
    if (argument === '--recommend') {
      if (recommend) return { ok: false, code: 'invalid_routing_command' };
      recommend = true;
      continue;
    }
    if (argument === '--json') {
      if (json) return { ok: false, code: 'invalid_routing_command' };
      json = true;
      continue;
    }
    if (argument === '--profile-plan') {
      if (profilePlan) return { ok: false, code: 'invalid_routing_command' };
      profilePlan = true;
      continue;
    }
    if (argument.startsWith('--profile-plan=')) return { ok: false, code: 'invalid_routing_command' };
    if (INCOMPATIBLE_REPORT_FLAGS.has(argument)) return { ok: false, code: 'invalid_routing_command' };
    const lastMatch = argument.match(/^--last=(\d{1,3})$/);
    if (lastMatch) {
      if (last !== undefined) return { ok: false, code: 'invalid_routing_descriptor' };
      const parsed = Number(lastMatch[1]);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return { ok: false, code: 'invalid_routing_descriptor' };
      last = parsed;
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals <= 2) return { ok: false, code: 'invalid_routing_descriptor' };
    const flag = argument.slice(0, equals);
    const field = Object.hasOwn(ROUTING_FLAGS,flag) ? ROUTING_FLAGS[flag] : undefined;
    if (!field || Object.hasOwn(values, field)) return { ok: false, code: 'invalid_routing_descriptor' };
    values[field] = argument.slice(equals + 1);
  }
  if (!recommend) return { ok: false, code: 'invalid_routing_command' };
  const descriptor = normalizeRoutingDescriptor({ schema_version: 1, ...values });
  if (!descriptor) return { ok: false, code: 'invalid_routing_descriptor' };
  return {
    ok: true,
    descriptor,
    last,
    ...(profilePlan ? { profile_plan: true } : {}),
  };
}

export function normalizeRoutingCapabilities(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hostVerified = [...new Set(Array.isArray(source.host_verified_efforts)
    ? source.host_verified_efforts.filter((effort) => EFFORT_SET.has(effort))
    : [])]
    .sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right])
    .slice(0, ROUTING_EFFORTS.length);
  const profiles = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.observed_profiles) ? source.observed_profiles : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!MODEL_FAMILY_SET.has(entry.model_family) || !EFFORT_SET.has(entry.reasoning_effort)) continue;
    const key = `${entry.model_family}\u0000${entry.reasoning_effort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({ model_family: entry.model_family, reasoning_effort: entry.reasoning_effort });
    if (profiles.length === ROUTING_PROFILE_LIMIT) break;
  }
  return { host_verified_efforts: hostVerified, observed_profiles: profiles };
}

function taskReason(taskShape) {
  if (taskShape === 'inspect' || taskShape === 'bounded_fix') return 'TASK_SIMPLE';
  if (taskShape === 'diagnosis') return 'TASK_DIAGNOSTIC';
  if (taskShape === 'migration') return 'TASK_MIGRATION';
  if (taskShape === 'security') return 'TASK_SECURITY';
  return 'TASK_RELEASE';
}

function sortedReasons(codes) {
  const selected = new Set(codes);
  return REASON_ORDER.filter((code) => selected.has(code));
}

export function recommendRouting(descriptor = {}, capabilities = {}) {
  const normalized = normalizeRoutingDescriptor(descriptor);
  if (!normalized) return null;
  descriptor = normalized;
  const pinned = descriptor.policy === 'pinned';
  const safeCapabilities = normalizeRoutingCapabilities(capabilities);
  const ultraRoute = descriptor.route === 'ultra';
  const ultraVerified = safeCapabilities.host_verified_efforts.includes('ultra');
  const pinnedUltraUnverified = pinned && descriptor.pinned_effort === 'ultra' && !ultraVerified;
  const heavyReview = descriptor.route === 'heavy'
    && ['migration', 'security', 'release'].includes(descriptor.task_shape);
  const escalatesToSol = heavyReview && descriptor.model_preference !== 'astra';
  const mediumReview = descriptor.route === 'medium'
    && ['diagnosis', 'migration'].includes(descriptor.task_shape);
  const modelFamily = pinned
    ? descriptor.pinned_model
    : (ultraRoute && descriptor.model_preference !== 'astra') || escalatesToSol
    ? 'sol'
    : descriptor.model_preference;
  const requestedEffort = pinned
    ? descriptor.pinned_effort
    : ultraRoute ? ultraVerified ? 'ultra' : 'max'
      : heavyReview ? 'max' : mediumReview ? 'high' : descriptor.task_shape === 'inspect' ? 'low' : 'medium';
  const ceilingConflict = !pinned && EFFORT_RANK[requestedEffort] > EFFORT_RANK[descriptor.effort_ceiling];
  const reasoningEffort = ceilingConflict ? descriptor.effort_ceiling : requestedEffort;
  const profileObserved = safeCapabilities.observed_profiles.some((profile) => profile.model_family === modelFamily
    && profile.reasoning_effort === reasoningEffort);
  const availability = !pinned && ultraRoute && !ultraVerified
    ? 'fallback'
    : reasoningEffort === 'ultra' && ultraVerified
      ? 'host_verified'
      : profileObserved ? 'observed' : 'unverified';
  const workers = ceilingConflict || descriptor.parallelism === 'none'
    ? { cap: 0, model_family: 'none', reasoning_effort: 'none', mode: 'none' }
    : ultraRoute
    ? { cap: 3, model_family: 'host_default', reasoning_effort: 'medium', mode: 'bounded_review' }
    : heavyReview
    ? { cap: 2, model_family: 'host_default', reasoning_effort: 'medium', mode: 'bounded_review' }
    : !pinned && mediumReview
      ? { cap: 1, model_family: modelFamily, reasoning_effort: 'medium', mode: 'bounded_review' }
    : !pinned && descriptor.route === 'light' && descriptor.task_shape === 'diagnosis'
      && descriptor.parallelism === 'independent' && modelFamily === 'luna'
      ? { cap: 2, model_family: 'luna', reasoning_effort: 'low', mode: 'independent_evidence' }
    : { cap: 0, model_family: 'none', reasoning_effort: 'none', mode: 'none' };
  const reasons = [
    `ROUTE_${descriptor.route.toUpperCase()}`,
    taskReason(descriptor.task_shape),
    descriptor.risk === 'low' ? 'RISK_LOW' : descriptor.risk === 'high' ? 'RISK_HIGH' : undefined,
    modelFamily === 'luna' ? 'LUNA_EFFICIENCY' : modelFamily === 'terra' ? 'TERRA_BALANCE' : undefined,
    escalatesToSol && !pinned ? 'SOL_ESCALATION' : undefined,
    workers.mode === 'independent_evidence' ? 'INDEPENDENT_WORK' : undefined,
    workers.cap === 0 ? 'SINGLE_WRITER' : undefined,
    pinned ? 'PINNED_SELECTION' : undefined,
    !pinned && requestedEffort !== descriptor.effort_ceiling && !ceilingConflict ? 'REDUCED_EFFORT' : undefined,
    pinnedUltraUnverified ? 'HOST_CAPABILITY_UNVERIFIED' : undefined,
    ultraRoute && !ultraVerified ? 'ULTRA_UNAVAILABLE' : undefined,
    ceilingConflict ? 'EFFORT_CEILING_TOO_LOW' : undefined,
  ];
  return {
    routing_schema_version: ROUTING_SCHEMA_VERSION,
    status: ceilingConflict ? 'constraint_conflict' : 'recommended',
    policy: descriptor.policy,
    primary: {
      model_family: modelFamily,
      reasoning_effort: reasoningEffort,
      availability,
    },
    workers,
    reason_codes: sortedReasons(reasons),
    fallback_code: ceilingConflict ? 'EFFORT_CEILING_TOO_LOW'
      : pinnedUltraUnverified ? 'HOST_CAPABILITY_UNVERIFIED'
      : !pinned && ultraRoute && !ultraVerified ? 'ULTRA_UNAVAILABLE' : 'NONE',
    confidence: ceilingConflict ? 'low' : ['host_verified', 'observed'].includes(availability) ? 'high' : 'medium',
  };
}
