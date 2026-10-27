import { getPlanProfile } from './plans.mjs';

export const POLICY_PROFILE_SCHEMA_VERSION = 1;

function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function validatePromotion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value.id) ? value.id : null;
  const effectiveFrom = iso(value.effective_from);
  const effectiveUntil = iso(value.effective_until);
  const multiplier = Number.isSafeInteger(value.effective_multiplier) && value.effective_multiplier >= 1 && value.effective_multiplier <= 100
    ? value.effective_multiplier : null;
  const sourceVersion = typeof value.source_version === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value.source_version)
    ? value.source_version : null;
  if (!id || !effectiveFrom || !effectiveUntil || !multiplier || !sourceVersion || Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) return null;
  return {
    id,
    effective_from: effectiveFrom,
    effective_until: effectiveUntil,
    effective_multiplier: multiplier,
    source_version: sourceVersion,
  };
}

export function resolvePolicyProfile(planId, at = new Date().toISOString(), promotions = []) {
  const plan = Object.values({ codex: 'codex', claude: 'claude' })
    .map((provider) => getPlanProfile(provider, planId))
    .find(Boolean);
  const standard = plan?.standard_multiplier ?? null;
  const date = Date.parse(at);
  const validDate = Number.isFinite(date);
  const candidates = Array.isArray(promotions) ? promotions.map(validatePromotion).filter(Boolean) : [];
  const active = validDate
    ? candidates.find((promotion) => date >= Date.parse(promotion.effective_from) && date < Date.parse(promotion.effective_until))
    : null;
  return {
    policy_schema_version: POLICY_PROFILE_SCHEMA_VERSION,
    plan_id: plan?.id ?? planId,
    provider: plan?.provider ?? 'unknown',
    standard_multiplier: standard,
    effective_multiplier: active?.effective_multiplier ?? standard,
    promotion_status: active ? 'active' : candidates.length ? 'not_active' : 'not_active',
    ...(active ? { promotion: active } : {}),
  };
}
