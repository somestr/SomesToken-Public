import {workspaceDirectory,readWorkspaceFile,readWorkspaceSnapshot,publicWorkspace,workspaceTaskReport} from './workspace-usage.mjs';
import {workspaceDiagnostics,runtimeCompatibility,installedPackageVersion} from './workspace-diagnostics.mjs';
import { readConsumption } from './consumption.mjs';
import { configuredClaudeWorkspaceRoot } from './claude-workspace.mjs';
import { configuredCodexLedgerRoot, readCodexTaskLedger } from './codex-ledger.mjs';
import { stateFromPublicSnapshot } from './public-bridge.mjs';
import { readPublicSnapshot } from './public/read.mjs';
import { profileTelemetryAnalytics } from './profile-telemetry.mjs';
import { fastModeAnalytics } from './fast-mode.mjs';
import { isTelemetryOutcome } from './telemetry-outcomes.mjs';
import {
  REPORT_SCHEMA_VERSION,
  healthSummary,
  publicReceipt,
  publicTurnBreakdown,
  qualitySummary,
  usageAnalytics,
  planAwareUsage,
  efficiencyAnalytics,
  advisorReport,
  optimizationReport,
  limitRecoveryAnalytics,
} from './reporting.mjs';
import { readPublicState } from './runtime.mjs';
import { isHostOwnedAbsolutePath } from './host-paths.mjs';
import { SOMESTOKEN_VERSION } from './version.mjs';
import { humanLabel, receiptMatchesTask } from './core.mjs';

export const SOMESTOKEN_REPORT_SCHEMA_VERSION = 18;
export const TELEMETRY_PREFLIGHT_SCHEMA_VERSION = 6;
export const SOMESTOKEN_REPORT_MODES = Object.freeze(['tasks', 'daily', 'consumption', 'task-forecast', 'last', 'task', 'usage', 'profiles', 'fast', 'quality', 'health', 'efficiency', 'loops', 'plans', 'plan-comparison', 'quota', 'credits', 'limits', 'limit-recovery', 'capabilities', 'provenance', 'recommendations', 'workflow', 'session-summary', 'trends', 'compare', 'acceptance', 'experiments', 'experiment', 'optimization', 'measured-reduction', 'manual-gates', 'goal-hygiene', 'shadow-policy', 'calibration', 'diagnostics', 'summary']);

export const SOMESTOKEN_EXTENDED_REPORT_MODES = Object.freeze(['fast', 'efficiency', 'loops', 'plans', 'plan-comparison', 'quota', 'credits', 'limits', 'limit-recovery', 'capabilities', 'provenance', 'recommendations', 'workflow', 'session-summary', 'trends', 'compare', 'acceptance', 'experiments', 'experiment', 'optimization', 'measured-reduction', 'manual-gates', 'goal-hygiene', 'shadow-policy', 'calibration']);

const REPORT_MODE_SET = new Set(SOMESTOKEN_REPORT_MODES);
const REPORT_SOURCE_SET = new Set(['plugin_data', 'public_snapshot', 'codex_ledger', 'workspace_snapshot', 'unavailable']);
const STATUS_SET = new Set(['exact', 'partial', 'unavailable']);
const DATA_ACCESS_SET = new Set([
  'available',
  'host_plugin_data_unavailable',
  'plugin_data_unreadable',
  'public_snapshot_stale',
  'public_snapshot_unavailable',
  'public_snapshot_unreadable',
  'public_snapshot_host_mismatch',
]);

function usableEnvironmentPath(value) {
  return isHostOwnedAbsolutePath(value);
}

function unambiguousEnvironmentPath(env, keys) {
  const paths = [...new Set(keys.map((key) => env?.[key]).filter(usableEnvironmentPath))];
  return paths.length === 1 ? paths[0] : undefined;
}

export function reportRuntime(env) {
  if (env?.SOMESTOKEN_RUNTIME === 'claude' || env?.SOMESTOKEN_RUNTIME === 'codex') {
    return env.SOMESTOKEN_RUNTIME;
  }
  const claudeData = unambiguousEnvironmentPath(env, ['CLAUDE_PLUGIN_DATA']);
  const genericData = unambiguousEnvironmentPath(env, ['PLUGIN_DATA']);
  const claudeRoot = unambiguousEnvironmentPath(env, ['CLAUDE_PLUGIN_ROOT']);
  const genericRoot = unambiguousEnvironmentPath(env, ['PLUGIN_ROOT']);
  const hasClaudeAlias = Boolean(claudeData || claudeRoot);
  // A provider-specific alias is host evidence, not a guessed path. Still
  // fail closed when any inherited generic alias differs or is unowned.
  const dataCompatible = !genericData || (claudeData && genericData === claudeData);
  const rootCompatible = !genericRoot || (claudeRoot && genericRoot === claudeRoot);
  return hasClaudeAlias && dataCompatible && rootCompatible ? 'claude' : 'unknown';
}

/**
 * Normalize the host-owned environment aliases at the report boundary.
 * Claude Code guarantees CLAUDE_PLUGIN_DATA/ROOT, while the shared SomesToken
 * adapter historically consumed PLUGIN_DATA/ROOT. Copying only the validated
 * host value into the shared names keeps the rest of the reader host-neutral
 * without guessing a filesystem path or mixing namespaces.
 */
function reportEnvironmentContext(env = {}) {
  const runtime = reportRuntime(env);
  const dataRoot = runtime === 'claude'
    ? unambiguousEnvironmentPath(env, ['CLAUDE_PLUGIN_DATA']) ?? unambiguousEnvironmentPath(env, ['PLUGIN_DATA'])
    : runtime === 'codex'
      ? unambiguousEnvironmentPath(env, ['PLUGIN_DATA'])
      : unambiguousEnvironmentPath(env, ['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA']);
  const pluginRoot = runtime === 'claude'
    ? unambiguousEnvironmentPath(env, ['CLAUDE_PLUGIN_ROOT']) ?? unambiguousEnvironmentPath(env, ['PLUGIN_ROOT'])
    : runtime === 'codex'
      ? unambiguousEnvironmentPath(env, ['PLUGIN_ROOT'])
      : unambiguousEnvironmentPath(env, ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT']);
  // Downstream public-state helpers deliberately understand both host aliases.
  // Remove every inherited alias first, then reintroduce only the single
  // unambiguous canonical value selected above so a Codex report cannot fall
  // through to an unrelated Claude root (or vice versa).
  const normalized = { ...env };
  delete normalized.PLUGIN_DATA;
  delete normalized.CLAUDE_PLUGIN_DATA;
  delete normalized.PLUGIN_ROOT;
  delete normalized.CLAUDE_PLUGIN_ROOT;
  return {
    env: {
      ...normalized,
      ...(runtime !== 'unknown' ? { SOMESTOKEN_RUNTIME: runtime } : {}),
      ...(dataRoot ? { PLUGIN_DATA: dataRoot } : {}),
      ...(pluginRoot ? { PLUGIN_ROOT: pluginRoot } : {}),
    },
    has_plugin_data: Boolean(dataRoot),
  };
}

function requestOrThrow(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['mode', 'last', 'task_key', 'hosts'].includes(key))) {
    throw new Error('invalid_report_request');
  }
  const mode = request?.mode;
  const last = request?.last ?? 1;
  if (!REPORT_MODE_SET.has(mode) || !Number.isSafeInteger(last) || last < 1 || last > 100) {
    throw new Error('invalid_report_request');
  }
  if (Object.hasOwn(request, 'task_key') && (!['task', 'task-forecast'].includes(mode)
    || typeof request.task_key !== 'string' || !/^[a-f0-9]{20}$/.test(request.task_key))) {
    throw new Error('invalid_report_request');
  }
  // A cross-host view covers retained workspace lists only; task identity stays per host.
  if (Object.hasOwn(request, 'hosts') && (!['current', 'all'].includes(request.hosts)
    || (request.hosts === 'all' && !['tasks', 'daily', 'consumption', 'summary'].includes(mode)))) {
    throw new Error('invalid_report_request');
  }
  return { mode, last };
}

function stateParts(state) {
  return {
    state: state && typeof state === 'object' ? state : null,
    receipts: Array.isArray(state?.receipts) ? state.receipts : [],
    health: state?.health ?? null,
  };
}

function telemetryPreflight(receipts, source, dataAccess = undefined) {
  const reportSource = REPORT_SOURCE_SET.has(source) ? source : 'unavailable';
  const previous = reportSource === 'unavailable' || !Array.isArray(receipts) ? null : receipts.at(-1);
  const access = DATA_ACCESS_SET.has(dataAccess)
    ? dataAccess
    : reportSource === 'unavailable'
      ? 'host_plugin_data_unavailable'
      : 'available';
  return {
    telemetry_preflight_schema_version: TELEMETRY_PREFLIGHT_SCHEMA_VERSION,
    report_source: reportSource,
    previous_receipt: previous ? 'available' : 'unavailable',
    previous_receipt_created_at: Number.isSafeInteger(previous?.created_at) && previous.created_at >= 0
      ? previous.created_at : null,
    receipt_scope: previous ? 'local_history' : 'unavailable',
    // Identity-free history cannot prove it belongs to the requesting task,
    // even when the hook just refreshed the snapshot during another task.
    current_task_correlation: 'unavailable',
    current_task_usage: 'unavailable',
    // SomesToken does not read or control the host's active goal.
    active_goal: 'not_observed',
    execution: 'continue',
    scope_policy: 'exact_scope_only',
    data_access: access,
    usage: STATUS_SET.has(previous?.status) ? previous.status : 'unavailable',
    telemetry_outcome: isTelemetryOutcome(previous?.telemetry_reconciliation?.outcome)
      ? previous.telemetry_reconciliation.outcome
      : 'unavailable',
  };
}

function lastReport(state, receipts, last) {
  const selected = receipts.slice(-last);
  const safe = selected.map((receipt) => {
    const output = publicReceipt(receipt);
    if (!output) return null;
    return { ...output, turn_breakdown: publicTurnBreakdown(state, receipt) };
  }).filter(Boolean);
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    status: usageAnalytics(state, selected, { last }).status,
    turns: safe.length,
    receipts: safe,
  };
}

function telemetryDiagnostics(preflight, options) {
  const recentWindowMs = 10 * 60 * 1000;
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const now = timestamp(options.now ?? Date.now());
  const createdAt = preflight.previous_receipt_created_at;
  const age = (at) => now !== null && at !== null && now >= at ? now - at : null;
  const receiptAge = age(createdAt);
  const freshness = now === null || createdAt === null ? 'unavailable'
    : now < createdAt ? 'clock_anomaly' : receiptAge < recentWindowMs ? 'recent' : 'older';
  const accessActions = {
    host_plugin_data_unavailable: 'verify_plugin_activation',
    plugin_data_unreadable: 'run_doctor',
    public_snapshot_unreadable: 'run_doctor',
    public_snapshot_host_mismatch: 'verify_host_namespace',
    public_snapshot_stale: 'await_next_hook',
    public_snapshot_unavailable: 'await_next_hook',
  };
  let reason = preflight.data_access;
  let action = accessActions[reason];
  if (!action) {
    if (preflight.previous_receipt === 'unavailable') { reason = 'no_completed_receipt'; action = 'await_turn_completion'; }
    else if (freshness === 'clock_anomaly') { reason = 'clock_anomaly'; action = 'check_system_clock'; }
    else if (freshness === 'unavailable') { reason = 'receipt_timestamp_unavailable'; action = 'run_doctor'; }
    else if (preflight.usage === 'unavailable') {
      reason = preflight.telemetry_outcome;
      action = reason === 'awaiting_post_turn_usage' ? 'await_next_hook' : 'run_doctor';
    } else { reason = 'historical_receipt'; action = freshness === 'older' ? 'await_next_hook' : 'review_local_history'; }
  }
  const snapshotAt = timestamp(options.snapshot_updated_at);
  return {
    diagnostics_schema_version: 1,
    reporter_version: options.reporterVersion ?? SOMESTOKEN_VERSION,
    // A version identifies this loaded reporter, not installed bytes or trust.
    installed_artifact_identity: 'unverified',
    status: preflight.usage,
    source: preflight.report_source,
    data_access: preflight.data_access,
    snapshot_kind: ['host_public_snapshot', 'legacy_state'].includes(options.snapshot_kind)
      ? options.snapshot_kind : 'unavailable',
    snapshot_updated_at: snapshotAt,
    snapshot_age_ms: age(snapshotAt),
    receipt_scope: preflight.receipt_scope,
    receipt_created_at: createdAt,
    receipt_age_ms: receiptAge,
    receipt_freshness: freshness,
    receipt_recent_window_ms: recentWindowMs,
    current_task_correlation: preflight.current_task_correlation,
    current_task_usage: preflight.current_task_usage,
    reason_codes: [reason],
    next_action: action,
    execution: 'continue',
  };
}

const DIAGNOSTIC_ACTIONS = {
  verify_plugin_activation: 'Verify that SomesToken is enabled in this host.',
  run_doctor: 'Run the SomesToken doctor check.',
  verify_host_namespace: 'Use the plugin data belonging to this host.',
  await_next_hook: 'Wait for the next host hook, then check this report again.',
  await_turn_completion: 'Finish a normal turn, then check this report again.',
  check_system_clock: 'Check the system clock, then check this report again.',
  review_local_history: 'Review local history; select a task explicitly for task detail.',
  view_tasks: 'Open the tasks view to see recorded work.',
  configure_workspace_if_needed: 'Enable workspace collection in SomesToken setup if you want this view.',
  await_capture: 'Wait for the collector to finish its next capture.',
  start_collector: 'Start the workspace collector using SomesToken setup.',
  check_collector: 'Check collector health in the SomesToken doctor check.',
  await_source_activity: 'Collection is up to date; wait for new source activity.',
  check_quota_connection: 'Check the host quota connection; recorded task usage is separate.',
  review_coverage: 'Review source coverage in the tasks view.',
  complete_normal_turn: 'Complete a normal turn to provide the first task observation.',
};
export const diagnosticAction = code => Object.hasOwn(DIAGNOSTIC_ACTIONS,code) ? DIAGNOSTIC_ACTIONS[code] : 'Review the diagnostic reason above.';

export function formatTelemetryDiagnostics(report) {
  const age=Number.isSafeInteger(report.receipt_age_ms)?`${report.receipt_age_ms} ms`:'unavailable';
  const receipt=`SomesToken diagnostics · reporter=${report.reporter_version} · source=${humanLabel(report.source)} · scope=${humanLabel(report.receipt_scope)} · freshness=${humanLabel(report.receipt_freshness)} · receipt age=${age} · current task=unavailable · reason=${humanLabel(report.reason_codes?.[0])}`;
  const c=report.collection;
  const lines=[receipt];
  if(c?.enabled)lines.push(`Collection · ${humanLabel(c.status)} · host=${humanLabel(c.host)} · ${c.task_count??'unavailable'} tasks · snapshot=${humanLabel(c.snapshot_freshness)} · coverage=${humanLabel(c.coverage_status)} · collector=${humanLabel(c.collector.status)} · account quota=${humanLabel(c.collector.quota_status)} · reason=${humanLabel(c.reason_codes?.[0])}`);
  lines.push(`Receipt next · ${diagnosticAction(report.next_action)}`);
  if(c?.enabled)lines.push(`Collection next · ${diagnosticAction(c.next_action)}`);
  return lines.join('\n');
}

function normalizedStatus(mode, report) {
  if (mode === 'diagnostics') return STATUS_SET.has(report?.status) ? report.status : 'unavailable';
  if (REPORT_MODE_SET.has(mode) && !['health', 'quality'].includes(mode)) {
    return STATUS_SET.has(report?.status) ? report.status : 'unavailable';
  }
  if (report?.status === 'healthy') return 'exact';
  if (report?.status === 'degraded') return 'partial';
  return 'unavailable';
}

export function reportFromState(state, request, source = 'unavailable', dataAccess = undefined, options = {}) {
  const { mode, last } = requestOrThrow(request);
  // A summary combines workspace views; only readSomesTokenReport can build it.
  if (mode === 'summary') throw new Error('invalid_report_request');
  const parts = stateParts(state);
  let report;
  const reportSource = REPORT_SOURCE_SET.has(source) ? source : 'unavailable';
  const preflight = telemetryPreflight(parts.receipts, reportSource, dataAccess);
  if (mode === 'task') {
    const selected = reportSource === 'unavailable' ? []
      : parts.receipts.filter((receipt) => receiptMatchesTask(receipt, options.taskSession)).slice(-last);
    report = {
      ...lastReport(parts.state, selected, last),
      scope: 'current_task_completed_turns',
      history_coverage: parts.state?.public_aggregate ? 'latest_receipt_only' : 'bounded_recent_receipts',
      current_turn_usage: 'unavailable',
      latest_completed_at: selected.at(-1)?.created_at ?? null,
      observed_at: Date.now(),
      availability_reason: !options.taskSession ? 'missing_task_metadata' : selected.length ? 'matched_completed_receipts' : 'no_matching_completed_receipt',
    };
    Object.assign(preflight, telemetryPreflight(selected, reportSource, dataAccess));
    if (selected.length) {
      preflight.receipt_scope = 'current_task_completed_turns';
      preflight.current_task_correlation = 'matched';
      // Quality covers only the returned completed-turn window, never the
      // in-flight turn or an unbounded lifetime total for this task.
      preflight.current_task_usage = report.status;
    }
  }
  else if (mode === 'diagnostics') report = telemetryDiagnostics(preflight, options);
  else if (mode === 'last') {
    report = lastReport(parts.state, parts.receipts, last);
    if (parts.state?.public_aggregate) {
      report.scope = 'latest_receipt';
      if (!parts.state.public_aggregate.latest_available && parts.state.public_aggregate.receipt_count !== 0) {
        report.reason_codes = ['aggregate_only_snapshot'];
      }
    }
  }
  else if (mode === 'usage') report = { ...usageAnalytics(parts.state, parts.receipts, { last }), ...planAwareUsage(parts.state, parts.receipts, { last }) };
  else if (mode === 'profiles') report = profileTelemetryAnalytics(parts.state, parts.receipts, { last });
  else if (mode === 'fast') report = fastModeAnalytics(parts.state, parts.receipts, { last });
  else if (mode === 'quality') report = qualitySummary(parts.receipts, parts.health, { last, state: parts.state });
  else if (mode === 'efficiency' || mode === 'loops') report = efficiencyAnalytics(parts.state, parts.receipts, { last });
  else if (mode === 'limits' || mode === 'limit-recovery') report = limitRecoveryAnalytics(parts.state);
  else if (['capabilities', 'provenance', 'recommendations', 'workflow', 'session-summary', 'trends', 'compare', 'acceptance'].includes(mode)) {
    const advisor = advisorReport(parts.state, parts.receipts, { last });
    if (mode === 'capabilities') report = { advisor_schema_version: advisor.advisor_schema_version, status: advisor.status, host: advisor.host, host_version: advisor.host_version, capabilities: advisor.capabilities };
    else if (mode === 'provenance') report = { advisor_schema_version: advisor.advisor_schema_version, status: advisor.status, host: advisor.host, provenance: advisor.provenance, reason_code_wiring: advisor.reason_code_wiring, reason_codes: advisor.reason_codes, evidence_counts: advisor.evidence_counts };
    else if (mode === 'recommendations') report = { advisor_schema_version: advisor.advisor_schema_version, status: advisor.status, host: advisor.host, recommendations: advisor.recommendations, recommendation_count: advisor.recommendation_count, provenance: advisor.provenance };
    else if (mode === 'workflow') report = advisor.workflow_advisor;
    else if (mode === 'session-summary') report = { advisor_schema_version: advisor.advisor_schema_version, status: advisor.status, host: advisor.host, session_summary: advisor.session_summary, sessions: advisor.sessions, closure: advisor.session_summary?.closure_state ?? 'unavailable' };
    else if (mode === 'trends' || mode === 'compare') report = { advisor_schema_version: advisor.advisor_schema_version, status: advisor.status, host: advisor.host, structural_metrics: advisor.structural_metrics, baseline_comparison: advisor.baseline_comparison };
    else report = { advisor_schema_version: advisor.advisor_schema_version, status: advisor.status, host: advisor.host, acceptance: advisor.acceptance, capabilities: advisor.capabilities };
  } else if (['experiments', 'experiment', 'optimization', 'measured-reduction', 'manual-gates', 'goal-hygiene', 'shadow-policy', 'calibration'].includes(mode)) {
    const optimization = optimizationReport(parts.state);
    if (mode === 'experiments' || mode === 'experiment') report = { optimization_schema_version: optimization.optimization_schema_version, status: optimization.status, experiments: optimization.experiments, pairs: optimization.pairs };
    else if (mode === 'optimization') report = optimization;
    else if (mode === 'measured-reduction') report = { optimization_schema_version: optimization.optimization_schema_version, status: optimization.status, reduction_summary: optimization.reduction_summary, reductions: optimization.reductions, pairs: optimization.pairs };
    else if (mode === 'manual-gates') report = { optimization_schema_version: optimization.optimization_schema_version, status: optimization.status, manual_gates: optimization.manual_gates };
    else if (mode === 'goal-hygiene') report = { optimization_schema_version: optimization.optimization_schema_version, status: optimization.status, goal_hygiene: optimization.goal_hygiene };
    else if (mode === 'shadow-policy') report = { optimization_schema_version: optimization.optimization_schema_version, status: optimization.status, shadow_policy: optimization.shadow_policy, shadow_decisions: optimization.shadow_decisions };
    else report = { optimization_schema_version: optimization.optimization_schema_version, status: optimization.status, calibration: optimization.calibration };
  }
  else if (mode === 'plans' || mode === 'plan-comparison' || mode === 'quota' || mode === 'credits') {
    const usage = planAwareUsage(parts.state, parts.receipts, { last });
    if (mode === 'plans' || mode === 'plan-comparison') report = usage;
    else if (mode === 'quota') report = {
      public_schema_version: usage.public_schema_version,
      quota_source: usage.quota_source,
      quota_scope: usage.quota_scope,
      quota_quality: usage.quota_quality,
      measurement_basis: usage.measurement_basis,
      quota_window: usage.quota_window,
      window_started_at: usage.window_started_at,
      window_ends_at: usage.window_ends_at,
      used_units: usage.used_units,
      limit_units: usage.limit_units,
      remaining_units: usage.remaining_units,
      used_percent: usage.used_percent,
      remaining_percent: usage.remaining_percent,
      resets_at: usage.resets_at,
      coverage: usage.coverage,
    };
    else report = {
      public_schema_version: usage.public_schema_version,
      calculated_usage: usage.calculated_usage,
      calculation_quality: usage.calculation_quality,
      rate_profile: usage.rate_profile,
      coverage: usage.coverage,
    };
  } else report = healthSummary(parts.health);
  const aggregate = parts.state?.public_aggregate;
  if (aggregate && mode === 'diagnostics' && !aggregate.latest_available && aggregate.receipt_count !== 0) {
    report.reason_codes = ['aggregate_only_snapshot'];
    report.next_action = 'await_next_hook';
  }
  if (aggregate && ['usage', 'plans', 'plan-comparison'].includes(mode)) {
    // Compact history cannot answer a narrower window. Report its explicit
    // aggregate scope and never present its totals as a receipt or main source.
    const sameTurn = aggregate.receipt_count === 1 && aggregate.latest_available;
    const base = sameTurn ? report : {
      ...usageAnalytics(parts.state, [], { last: 1 }),
      ...planAwareUsage(parts.state, [], { last: 1 }),
    };
    report = {
      ...base,
      scope: aggregate.scope,
      turns: aggregate.receipt_count,
      status: aggregate.quality,
      token_quality: aggregate.usage.quality,
      observed_tokens: aggregate.usage,
      totals: { ...base.totals, total_tokens: aggregate.usage.total_tokens ?? null,
        ...(!sameTurn ? { main_tokens: null, subagent_tokens: null, attributed_tokens: null, unattributed_tokens: null } : {}) },
      source_counts: aggregate.counts ? Object.fromEntries(
        ['expected_sources', 'resolved_sources', 'unavailable_sources', 'overflow_sources'].map((key) => [key, aggregate.counts[key]]),
      ) : null,
      reason_codes: aggregate.latest_available || aggregate.receipt_count === 0 ? [] : ['aggregate_only_snapshot'],
    };
  }
  return {
    somestoken_report_schema_version: SOMESTOKEN_REPORT_SCHEMA_VERSION,
    mode,
    status: normalizedStatus(mode, report),
    source: reportSource,
    telemetry_preflight: preflight,
    report,
  };
}

export function readSomesTokenState(env = process.env, options = {}) {
  const context = reportEnvironmentContext(env);
  const resolvedEnv = context.env;
  const expectedHost = options.expectedHost === 'codex' || options.expectedHost === 'claude'
    ? options.expectedHost
    : resolvedEnv?.SOMESTOKEN_RUNTIME === 'codex' || resolvedEnv?.SOMESTOKEN_RUNTIME === 'claude'
      ? resolvedEnv.SOMESTOKEN_RUNTIME
      : undefined;
  const hasPluginData = usableEnvironmentPath(resolvedEnv?.PLUGIN_DATA);
  if (options.publicOnly === true) {
    // `current.json` is the host-owned public authority. A stale or invalid
    // authority must not fall through to an older mirror and become exact.
    const bridge = readPublicSnapshot(resolvedEnv);
    const bridgeStatus = bridge.status;
    if (bridge.snapshot && expectedHost && bridge.snapshot.host !== expectedHost) {
      return { state: null, source: 'unavailable', data_access: 'public_snapshot_host_mismatch' };
    }
    if (bridgeStatus === 'bridge_ready') {
      const publicState = stateFromPublicSnapshot(bridge.snapshot);
      if (publicState) return { state: publicState, source: 'public_snapshot', data_access: 'available', snapshot_kind: 'host_public_snapshot', snapshot_updated_at: bridge.snapshot.updated_at };
    }
    if (bridgeStatus === 'bridge_stale') {
      return { state: null, source: 'unavailable', data_access: 'public_snapshot_stale' };
    }
    if (bridgeStatus === 'bridge_unavailable' && bridge.snapshot) {
      return { state: null, source: 'unavailable', data_access: 'public_snapshot_unavailable' };
    }
    if (hasPluginData && bridge.missing !== true) {
      return { state: null, source: 'unavailable', data_access: 'public_snapshot_unreadable' };
    }
    // Compatibility fallback: runtime state is immediately sanitized through
    // reportFromState and is never returned as raw MCP content. The bridge is
    // preferred whenever the host-owned public file is available.
    if (hasPluginData) {
      const state = readPublicState(resolvedEnv);
      if (state?.health !== null) return { state, source: 'plugin_data', data_access: 'available', snapshot_kind: 'legacy_state' };
      return { state: null, source: 'unavailable', data_access: 'plugin_data_unreadable' };
    }
    return {
      state: null,
      source: 'unavailable',
      data_access: bridgeStatus === 'bridge_read_failed' || bridgeStatus === 'bridge_schema_mismatch'
        ? 'public_snapshot_unreadable'
        : 'host_plugin_data_unavailable',
    };
  }
  if (hasPluginData) {
    const state = readPublicState(resolvedEnv);
    if (state?.health !== null) return { state, source: 'plugin_data', data_access: 'available' };
    return { state: null, source: 'unavailable', data_access: 'plugin_data_unreadable' };
  }
  return { state: null, source: 'unavailable', data_access: context.has_plugin_data ? 'plugin_data_unreadable' : 'host_plugin_data_unavailable' };
}

export function readSomesTokenReport(env, request, options = {}) {
  requestOrThrow(request);
  const selectedTask = request.task_key;
  // A caller can select retained history, but cannot thereby identify the
  // host's active task or borrow current-turn metadata from another task.
  if (selectedTask) options = { ...options, workspaceTask: selectedTask, taskSession: undefined, taskTurn: undefined };
  if (request.hosts === 'all') options = { ...options, workspaceAllHosts: true };
  const host=options.expectedHost ?? (reportRuntime(env)==='claude'?'claude':'codex');
  const configurationRoot=options.pluginRoot ?? reportEnvironmentContext(env).env.PLUGIN_ROOT;
  const workspaceEnabled=(host==='claude'?configuredClaudeWorkspaceRoot(env):configuredCodexLedgerRoot(env,configurationRoot))
    || (options.workspaceAllHosts===true&&(configuredClaudeWorkspaceRoot(env)||configuredCodexLedgerRoot(env,configurationRoot)));
  const workspaceState=workspaceEnabled&&['tasks','daily','task-forecast','task','diagnostics'].includes(request.mode)
    ?readWorkspaceSnapshot(workspaceDirectory(env),{
      includeRecords:request.mode==='task'&&Boolean(options.workspaceTask),
      ...(['task','task-forecast'].includes(request.mode)&&options.workspaceTask?{taskKey:options.workspaceTask}:{}),
      ...(options.workspaceAllHosts===true?{}:{host}),
    }):null;
  const hostMatches=t=>t && (options.workspaceAllHosts===true || (t.host??'codex')===host);
  if (request.mode==='summary') {
    // One requested overview, each part exactly as its own view reports it.
    const sections={};
    for(const mode of ['last','tasks','consumption','diagnostics']){
      const part=readSomesTokenReport(env,{mode},options);
      sections[mode]={status:part.status,source:part.source,report:part.report,...(mode==='last'?{telemetry_preflight:part.telemetry_preflight}:{})};
    }
    const listed=sections.tasks.report;
    if(Array.isArray(listed?.tasks)&&listed.tasks.length>10)
      sections.tasks.report={...listed,tasks:listed.tasks.slice(0,10),returned_tasks:10,omitted_tasks:Math.max(0,(listed.total_tasks??listed.tasks.length)-10),truncated:true};
    const parts=Object.values(sections);
    const status=parts.every(p=>p.status==='exact')?'exact':parts.every(p=>p.status==='unavailable')?'unavailable':'partial';
    const preflight=sections.last.telemetry_preflight;delete sections.last.telemetry_preflight;
    return {somestoken_report_schema_version:SOMESTOKEN_REPORT_SCHEMA_VERSION,mode:'summary',
      source:parts.find(p=>p.source!=='unavailable')?.source??'unavailable',status,telemetry_preflight:preflight,
      report:{host:options.workspaceAllHosts===true?'all':host,sections}};
  }
  if (request.mode==='consumption') {
    const report=workspaceEnabled?readConsumption(workspaceDirectory(env),{hosts:options.workspaceAllHosts===true?['codex','claude']:[host]})
      :{schema_version:1,status:'unavailable',windows:[],reason_codes:['workspace_not_enabled']};
    const status=report.windows.length?(report.snapshot_status==='exact'?'exact':'partial'):'unavailable';
    const source=report.status==='unavailable'&&!report.windows.length?'unavailable':'workspace_snapshot';
    return {somestoken_report_schema_version:SOMESTOKEN_REPORT_SCHEMA_VERSION,mode:request.mode,source,status,
      telemetry_preflight:telemetryPreflight([],source,workspaceEnabled?'available':'host_plugin_data_unavailable'),
      report:{...report,host:options.workspaceAllHosts===true?'all':host}};
  }
  if (['tasks','daily','task-forecast'].includes(request.mode)) {
    const state=workspaceState;
    const taskKey=request.mode==='task-forecast'?options.workspaceTask:undefined;
    let report=request.mode==='task-forecast'&&!taskKey
      ? {status:'unavailable',availability_reason:'missing_task_metadata',tasks:[]}
      : publicWorkspace(state,{taskKey});
    report={...report,tasks:(report.tasks??[]).filter(hostMatches),daily:(report.daily??[]).filter(hostMatches),host:options.workspaceAllHosts===true?'all':host};
    if(options.workspaceAllHosts!==true)for(const field of ['quota_calibration','quota_forecasts','quota_windows'])
      report[field]=(report[field]??[]).filter(r=>(r.provider??'codex')===host);
    if(request.mode==='task-forecast'&&!report.tasks.length)report={...report,status:'unavailable',availability_reason:taskKey?'no_matching_workspace_task':'missing_task_metadata'};
    if(selectedTask)report={...report,identity_basis:'explicit_task_selection'};
    if(request.mode==='tasks') {
      const ordered=[...report.tasks].sort((a,b)=>
        (Number.isSafeInteger(b.last_observed_at)?b.last_observed_at:0)-(Number.isSafeInteger(a.last_observed_at)?a.last_observed_at:0)
        || String(a.task_key).localeCompare(String(b.task_key)));
      report={...report,daily:undefined,total_tasks:ordered.length,returned_tasks:Math.min(ordered.length,100),
        omitted_tasks:Math.max(0,ordered.length-100),truncated:ordered.length>100,sort_basis:'last_observed_at_desc',
        // Keep browsing inexpensive. Per-source histories and per-model rate
        // diagnostics belong to the explicitly selected task, not every row.
        tasks:ordered.slice(0,100).map(({sources,profile_history,profile_transitions,forecast_revisions,forecast_original,...t})=>({
          ...t,
          ...(Array.isArray(t.models)?{models:t.models.map(model=>{
            if(!model||typeof model!=='object'||Array.isArray(model))return model;
            const {recent_activity,quota_rate_estimates,cost_basis,...summary}=model;
            return summary;
          })}:{}),
        }))};
    }
    if(request.mode==='daily') report={...report,tasks:undefined,daily:(report.daily??[]).slice(-1000)};
    const status=['exact','partial'].includes(report.status)?report.status:'unavailable';
    const source=state?'workspace_snapshot':'unavailable';
    const preflight=telemetryPreflight([],source,state?'available':'host_plugin_data_unavailable');
    return {somestoken_report_schema_version:SOMESTOKEN_REPORT_SCHEMA_VERSION,mode:request.mode,
      source,status,telemetry_preflight:preflight,report};
  }
  if (request.mode === 'task' && selectedTask) {
    const task = publicWorkspace(workspaceState,{taskKey:selectedTask}).tasks?.find(hostMatches);
    const report = {
      ...(task ? workspaceTaskReport(workspaceState,selectedTask)
        : {status:'unavailable',availability_reason:'no_matching_workspace_task',task_key:selectedTask}),
      host, scope:'retained_task_history', identity_basis:'explicit_task_selection', current_turn_usage:'unavailable',
    };
    const source=workspaceState?'workspace_snapshot':'unavailable';
    return {somestoken_report_schema_version:SOMESTOKEN_REPORT_SCHEMA_VERSION,mode:'task',source,
      status:report.status,telemetry_preflight:telemetryPreflight([],source,workspaceState?'available':'host_plugin_data_unavailable'),report};
  }
  if (request.mode === 'task' && options.expectedHost === 'codex' && env?.SOMESTOKEN_CODEX_SESSION_ROOT) {
    const report = readCodexTaskLedger(env.SOMESTOKEN_CODEX_SESSION_ROOT, options.taskSession, {last:request.last,taskTurn:options.taskTurn});
    const workspace=publicWorkspace(workspaceState,{taskKey:options.workspaceTask});
    const matchedTask=workspace.tasks?.find(hostMatches);
    if(options.workspaceTask) {
      report.task_key=options.workspaceTask;report.workspace_task=matchedTask??null;
      if(matchedTask)report.workspace_observed_usage={...workspaceTaskReport(workspaceState,options.workspaceTask),identity_basis:'host_task_metadata'};
    }
    const preflight = telemetryPreflight(report.receipts, 'codex_ledger', 'available');
    const matched = report.turns > 0 || report.current_turn_usage === 'partial';
    Object.assign(preflight, { receipt_scope:report.turns > 0?'current_task_completed_turns':'unavailable',
      current_task_correlation:matched?'matched':'unavailable', current_task_usage:report.status,
      usage:report.status, telemetry_outcome:matched?'received':'unavailable' });
    return {somestoken_report_schema_version:SOMESTOKEN_REPORT_SCHEMA_VERSION,mode:'task',
      source:'codex_ledger',status:report.status,telemetry_preflight:preflight,report};
  }
  const resolved = readSomesTokenState(env, options);
  const output=reportFromState(resolved.state, request, resolved.source, resolved.data_access, { ...resolved, taskSession: options.taskSession, reporterVersion: options.reporterVersion });
  if(request.mode==='diagnostics') {
    const collection=workspaceDiagnostics({workspace:workspaceState,
      monitor:workspaceEnabled?readWorkspaceFile(workspaceDirectory(env),'monitor.json'):null,
      enabled:Boolean(workspaceEnabled),host:options.workspaceAllHosts===true?'all':host});
    output.report.collection=collection;
    output.report.runtime_compatibility=runtimeCompatibility({reporter:options.reporterVersion??SOMESTOKEN_VERSION,
      installed:installedPackageVersion(configurationRoot,host),collector:collection.collector.version,hook:resolved.state?.hook_version});
  }
  if(request.mode==='task'&&workspaceState&&options.workspaceTask) {
    const task=publicWorkspace(workspaceState,{taskKey:options.workspaceTask}).tasks?.find(hostMatches);
    if(task) {
      output.report.workspace_task=task;
      output.report.workspace_observed_usage={...workspaceTaskReport(workspaceState,options.workspaceTask),identity_basis:'host_task_metadata'};
      // Workspace history cannot establish which request is currently running.
      // Only an explicit, trusted host turn binding permits request-group usage.
      if(options.taskTurn)output.report.workspace_request_usage={...workspaceTaskReport(workspaceState,options.workspaceTask,{turnKey:options.taskTurn}),identity_basis:'host_turn_metadata'};
    }
  }
  return output;
}
