import { getPlanProfile } from './plans.mjs';

export const BUDGET_SCHEMA_VERSION = 1;

const DEFAULT_THRESHOLDS = [50, 75, 90, 100];

function safeBudget(value) {
  return value === null || value === undefined
    ? null
    : Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

export function validateUsageConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const errors = [];
  const allowed = new Set(['mode', 'enabled', 'live_warnings', 'warning_cooldown_ms', 'plan', 'usage_alerts', 'local_budgets', 'efficiency', 'workflow_advisor', 'codex_limit_recovery']);
  for (const key of Object.keys(source)) if (!allowed.has(key)) errors.push('unknown_configuration_field');
  const provider = source.plan?.provider;
  const id = source.plan?.id;
  if (provider && id && !getPlanProfile(provider, id)) errors.push('plan_provider_mismatch');
  const thresholds = source.usage_alerts?.thresholds_percent ?? DEFAULT_THRESHOLDS;
  if (!Array.isArray(thresholds) || thresholds.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 100) || thresholds.some((entry, index) => index > 0 && entry <= thresholds[index - 1])) errors.push('invalid_thresholds');
  const budgets = source.local_budgets && typeof source.local_budgets === 'object' ? source.local_budgets : {};
  const allowedBudgetKeys = new Set([
    'max_tokens_per_turn',
    'max_tokens_per_session',
    'max_calculated_credits_per_turn',
    'max_calculated_credits_per_session',
    'max_subagents_per_turn',
    'max_efficiency_warnings_per_session',
  ]);
  for (const key of Object.keys(budgets)) if (!allowedBudgetKeys.has(key)) errors.push('unknown_budget_field');
  for (const valueEntry of Object.values(budgets)) {
    if (valueEntry !== null && (!Number.isSafeInteger(valueEntry) || valueEntry < 0)) errors.push('negative_budget');
  }
  const cooldown = source.warning_cooldown_ms;
  if (cooldown !== undefined && (!Number.isSafeInteger(cooldown) || cooldown < 0)) errors.push('invalid_cooldown');
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const config = {
    budget_schema_version: BUDGET_SCHEMA_VERSION,
    mode: source.mode === 'report_only' ? 'report_only' : 'report_only',
    enabled: source.enabled !== false,
    live_warnings: source.live_warnings !== false,
    warning_cooldown_ms: cooldown ?? 60_000,
    plan: source.plan && provider && id ? {
      provider,
      id,
      comparison_mode: ['auto', 'host_quota', 'manual_capacity', 'relative_only', 'unavailable'].includes(source.plan.comparison_mode)
        ? source.plan.comparison_mode : 'auto',
    } : { provider: 'unknown', id: 'unknown', comparison_mode: 'auto' },
    usage_alerts: { enabled: source.usage_alerts?.enabled !== false, thresholds_percent: [...thresholds] },
    local_budgets: {},
  };
  for (const [key, number] of Object.entries(budgets)) {
    const safe = safeBudget(number);
    if (safe !== undefined) config.local_budgets[key] = safe;
  }
  return { ok: true, config };
}

export function alertThresholds(usedPercent, thresholds = DEFAULT_THRESHOLDS, windowKey = 'unknown-window', seen = new Set()) {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return [];
  const output = [];
  for (const threshold of [...new Set(thresholds)].sort((a, b) => a - b)) {
    if (usedPercent < threshold) continue;
    const key = `${windowKey}:${threshold}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ reason_code: `plan_usage_${threshold}`, threshold_percent: threshold, scope: 'local', window_key: windowKey });
  }
  return output;
}

export function localBudgetAlerts(value, budget, scope = 'turn', windowKey = 'unknown-window', seen = new Set()) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return [];
  const usedPercent = (value / budget) * 100;
  const output = [];
  for (const threshold of [50, 75, 90]) {
    if (usedPercent < threshold) continue;
    const key = `local:${scope}:${windowKey}:${threshold}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ reason_code: `local_budget_${threshold}`, threshold_percent: threshold, scope: 'local', budget_scope: scope, window_key: windowKey });
  }
  if (usedPercent >= 100) {
    const key = `local:${scope}:${windowKey}:exceeded`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ reason_code: 'local_budget_exceeded', threshold_percent: 100, scope: 'local', budget_scope: scope, window_key: windowKey });
    }
  }
  return output;
}

export { DEFAULT_THRESHOLDS };
