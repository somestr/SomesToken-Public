import { BUDGET_SCHEMA_VERSION, validateUsageConfig } from './budgets.mjs';
import { PLAN_COMPARISON_MODES, WINDOW_TYPES } from './schema.mjs';
import { WORKFLOW_ADVISOR_DEFAULTS } from '../workflow-advisor.mjs';
import { WORKLOAD_CLASSES } from '../optimization/schema.mjs';
import { LIMIT_RECOVERY_MODES } from '../limit-recovery/state.mjs';
import { isSensitiveRuntimeValue } from '../core.mjs';

export const CONFIG_SCHEMA_VERSION = 2;
const MAX_CONFIG_BYTES = 16 * 1024;
const LIMITS = Object.freeze({
  max_events_per_scope: 256,
  max_scopes: 512,
  same_agent_respawn_watch: 1000,
  same_tool_repeat_watch: 1000,
  stop_continuation_watch: 1000,
  pending_source_age_ms: 7 * 24 * 60 * 60 * 1000,
  minimum_baseline_receipts: 1000,
});
const WORKFLOW_LIMITS = Object.freeze({
  minimum_elapsed_ms: 365 * 24 * 60 * 60 * 1000,
  minimum_comparable_receipts: 100,
  cooldown_ms: 365 * 24 * 60 * 60 * 1000,
  max_receipts: 100,
});

function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function safeText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) && !isSensitiveRuntimeValue(value) ? value : null;
}

export function normalizeSomesTokenConfig(value = {}) {
  const base = validateUsageConfig(value);
  if (!base.ok) return base;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const errors = [];
  const recoveryInput = source.codex_limit_recovery;
  const recovery = recoveryInput === undefined
    ? {}
    : recoveryInput && typeof recoveryInput === 'object' && !Array.isArray(recoveryInput) ? recoveryInput : null;
  if (source.codex_limit_recovery !== undefined && !recovery) errors.push('invalid_codex_limit_recovery');
  const allowedRecoveryKeys = new Set(['mode', 'max_wait_ms', 'reset_grace_ms', 'max_resume_attempts', 'require_active_goal']);
  for (const key of Object.keys(recovery ?? {})) if (!allowedRecoveryKeys.has(key)) errors.push('unknown_codex_limit_recovery_field');
  const recoveryMode = recovery?.mode ?? 'disabled';
  const maxWait = recovery?.max_wait_ms ?? 6 * 60 * 60 * 1000;
  const resetGrace = recovery?.reset_grace_ms ?? 30_000;
  const maxAttempts = recovery?.max_resume_attempts ?? 1;
  const requireGoal = recovery?.require_active_goal ?? true;
  if (!LIMIT_RECOVERY_MODES.includes(recoveryMode)) errors.push('invalid_codex_limit_recovery_mode');
  if (!Number.isSafeInteger(maxWait) || maxWait < 1 || maxWait > 24 * 60 * 60 * 1000) errors.push('invalid_codex_limit_recovery_wait');
  if (!Number.isSafeInteger(resetGrace) || resetGrace < 0 || resetGrace > 5 * 60 * 1000) errors.push('invalid_codex_limit_recovery_grace');
  if (maxAttempts !== 1) errors.push('invalid_codex_limit_recovery_attempts');
  if (requireGoal !== true) errors.push('active_goal_required');
  const manual = source.plan?.manual_capacity;
  let manualCapacity = null;
  if (manual !== undefined && manual !== null) {
    const capacity = typeof manual.capacity_units === 'number' && Number.isFinite(manual.capacity_units) && manual.capacity_units > 0 && manual.capacity_units <= Number.MAX_SAFE_INTEGER ? manual.capacity_units : null;
    if (capacity === null) errors.push('invalid_manual_capacity');
    const resetAt = manual.reset_at === undefined || manual.reset_at === null ? null : iso(manual.reset_at);
    if (manual.reset_at !== undefined && resetAt === null) errors.push('invalid_reset_at');
    const windowType = manual.window_type === undefined ? 'host_defined' : manual.window_type;
    if (!WINDOW_TYPES.includes(windowType)) errors.push('invalid_reset_window');
    const unit = manual.unit === undefined ? 'tokens' : safeText(manual.unit);
    if (!unit) errors.push('invalid_manual_unit');
    if (!errors.length) manualCapacity = { window_type: windowType, unit, capacity_units: capacity, ...(resetAt ? { reset_at: resetAt } : {}) };
  }
  const efficiencyInput = source.efficiency && typeof source.efficiency === 'object' ? source.efficiency : {};
  const efficiency = {
    max_events_per_scope: efficiencyInput.max_events_per_scope ?? 64,
    max_scopes: efficiencyInput.max_scopes ?? 128,
    same_agent_respawn_watch: efficiencyInput.same_agent_respawn_watch ?? 4,
    same_tool_repeat_watch: efficiencyInput.same_tool_repeat_watch ?? 6,
    stop_continuation_watch: efficiencyInput.stop_continuation_watch ?? 2,
    pending_source_age_ms: efficiencyInput.pending_source_age_ms ?? 600_000,
    minimum_baseline_receipts: efficiencyInput.minimum_baseline_receipts ?? 10,
  };
  for (const [key, number] of Object.entries(efficiency)) {
    if (!Number.isSafeInteger(number) || number < 1 || number > (LIMITS[key] ?? 0)) errors.push('efficiency_limit_exceeded');
  }
  const workflowInput = source.workflow_advisor && typeof source.workflow_advisor === 'object' && !Array.isArray(source.workflow_advisor)
    ? source.workflow_advisor
    : {};
  if (source.workflow_advisor !== undefined && (source.workflow_advisor === null || typeof source.workflow_advisor !== 'object' || Array.isArray(source.workflow_advisor))) {
    errors.push('invalid_workflow_advisor');
  }
  const allowedWorkflowKeys = new Set(['minimum_elapsed_ms', 'minimum_comparable_receipts', 'cooldown_ms', 'max_receipts', 'workload_class']);
  for (const key of Object.keys(workflowInput)) if (!allowedWorkflowKeys.has(key)) errors.push('unknown_workflow_advisor_field');
  const workloadClass = workflowInput.workload_class ?? 'unknown';
  if (!WORKLOAD_CLASSES.includes(workloadClass)) errors.push('workflow_advisor_invalid_workload_class');
  const workflowAdvisor = {
    minimum_elapsed_ms: workflowInput.minimum_elapsed_ms ?? WORKFLOW_ADVISOR_DEFAULTS.minimum_elapsed_ms,
    minimum_comparable_receipts: workflowInput.minimum_comparable_receipts ?? WORKFLOW_ADVISOR_DEFAULTS.minimum_comparable_receipts,
    cooldown_ms: workflowInput.cooldown_ms ?? WORKFLOW_ADVISOR_DEFAULTS.cooldown_ms,
    max_receipts: workflowInput.max_receipts ?? WORKFLOW_ADVISOR_DEFAULTS.max_receipts,
    workload_class: WORKLOAD_CLASSES.includes(workloadClass) ? workloadClass : 'unknown',
  };
  for (const [key, number] of Object.entries(workflowAdvisor)) {
    if (key === 'workload_class') continue;
    if (!Number.isSafeInteger(number) || number < 1 || number > WORKFLOW_LIMITS[key]) errors.push('workflow_advisor_limit_exceeded');
  }
  if (Number.isSafeInteger(workflowAdvisor.minimum_comparable_receipts)
    && Number.isSafeInteger(workflowAdvisor.max_receipts)
    && workflowAdvisor.max_receipts < workflowAdvisor.minimum_comparable_receipts) {
    errors.push('workflow_advisor_window_too_small');
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const config = {
    config_schema_version: CONFIG_SCHEMA_VERSION,
    ...base.config,
    plan: {
      ...base.config.plan,
      comparison_mode: PLAN_COMPARISON_MODES.includes(source.plan?.comparison_mode) ? source.plan.comparison_mode : base.config.plan.comparison_mode,
      ...(manualCapacity ? { manual_capacity: manualCapacity } : {}),
    },
    efficiency,
    workflow_advisor: workflowAdvisor,
    codex_limit_recovery: {
      mode: recoveryMode,
      max_wait_ms: maxWait,
      reset_grace_ms: resetGrace,
      max_resume_attempts: 1,
      require_active_goal: true,
    },
  };
  return { ok: true, config };
}

/**
 * Recover a previously normalized local configuration without expanding the
 * public configuration surface. The two version markers are persistence
 * envelopes, not user-configurable fields, so they are verified and removed
 * before the same strict public validator runs.
 */
export function recoverSomesTokenConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['invalid_persisted_configuration'] };
  const {
    config_schema_version: configSchemaVersion,
    budget_schema_version: budgetSchemaVersion,
    ...source
  } = value;
  if (configSchemaVersion !== undefined && ![1, CONFIG_SCHEMA_VERSION].includes(configSchemaVersion)) {
    return { ok: false, errors: ['unsupported_persisted_config_schema'] };
  }
  if (budgetSchemaVersion !== undefined && budgetSchemaVersion !== BUDGET_SCHEMA_VERSION) {
    return { ok: false, errors: ['unsupported_persisted_budget_schema'] };
  }
  return normalizeSomesTokenConfig(source);
}

export function readSomesTokenConfig(env = {}) {
  const raw = typeof env.SOMESTOKEN_CONFIG_JSON === 'string' ? env.SOMESTOKEN_CONFIG_JSON : '';
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return { source: 'unavailable', config: null };
  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeSomesTokenConfig(parsed);
    return normalized.ok ? { source: 'environment', config: normalized.config } : { source: 'invalid', config: null, errors: normalized.errors };
  } catch {
    return { source: 'unavailable', config: null };
  }
}
