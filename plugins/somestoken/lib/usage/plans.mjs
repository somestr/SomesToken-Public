export const PLAN_PROFILES = Object.freeze({
  codex_plus: Object.freeze({ provider: 'codex', id: 'codex_plus', display_name: 'Plus', standard_multiplier: 1 }),
  codex_pro_5x: Object.freeze({ provider: 'codex', id: 'codex_pro_5x', display_name: 'Pro 5x', standard_multiplier: 5 }),
  codex_pro_20x: Object.freeze({ provider: 'codex', id: 'codex_pro_20x', display_name: 'Pro 20x', standard_multiplier: 20 }),
  claude_pro: Object.freeze({ provider: 'claude', id: 'claude_pro', display_name: 'Pro', standard_multiplier: 1 }),
  claude_max_5x: Object.freeze({ provider: 'claude', id: 'claude_max_5x', display_name: 'Max 5x', standard_multiplier: 5 }),
  claude_max_20x: Object.freeze({ provider: 'claude', id: 'claude_max_20x', display_name: 'Max 20x', standard_multiplier: 20 }),
});

export function getPlanProfile(provider, id) {
  const plan = typeof id === 'string' ? PLAN_PROFILES[id] : null;
  return plan && plan.provider === provider ? { ...plan } : null;
}

export function listPlanProfiles(provider) {
  return Object.values(PLAN_PROFILES).filter((plan) => plan.provider === provider).map((plan) => ({ ...plan }));
}
