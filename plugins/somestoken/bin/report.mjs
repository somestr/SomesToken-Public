#!/usr/bin/env node
import { readCodexTaskLedger, configureCodexLedger, configuredCodexLedgerRoot } from '../lib/codex-ledger.mjs';
import { configureClaudeFeed } from '../lib/claude-workspace.mjs';
import { compact, formatReceipt, hashOpaqueHostIdentifier, humanLabel, PONYTAIL_UNKNOWN_REASON } from '../lib/core.mjs';
import { SOMESTOKEN_REPORT_SCHEMA_VERSION, SOMESTOKEN_EXTENDED_REPORT_MODES, readSomesTokenState, readSomesTokenReport, reportFromState, formatTelemetryDiagnostics, diagnosticAction } from '../lib/report-adapter.mjs';
import {
  publicReceipt,
  publicTurnBreakdown,
  summarizeReceipts,
  summarizeTurnBreakdowns,
} from '../lib/reporting.mjs';
import { buildProfilePlan } from '../lib/profiles.mjs';
import { routingUsageAnalytics } from '../lib/profile-telemetry.mjs';
import { MODEL_FAMILIES, ROUTING_EFFORTS, parseRoutingArgs, recommendRouting } from '../lib/routing.mjs';

const rawArgs = process.argv.slice(2);
if(process.argv.includes('--help')) {process.stdout.write(`SomesToken report · read local usage receipts and diagnostics.\nOptions: --last=1..100 --json --summary --usage --quality --health --diagnostics --profiles --breakdown.\nOther reports: ${SOMESTOKEN_EXTENDED_REPORT_MODES.map(mode=>'--'+mode).join(' ')}.\nRouting advice: --recommend [--profile-plan] with fixed --route, --task-shape, --risk, --parallelism, --model-family, --effort-ceiling and --policy options.\nExplicit ledger controls: --enable-codex-ledger=<directory> or --disable-codex-ledger; --enable-claude-feed or --disable-claude-feed.\nUse console.mjs --help for retained workspace tasks and forecasts. Unavailable means missing evidence; zero means an observed count of zero.\n`);process.exit(0);}
const args = new Set(rawArgs);
const enableLedger = rawArgs.find(a=>a.startsWith('--enable-codex-ledger='));
const taskId = rawArgs.find(a=>a.startsWith('--task-id='));
if (enableLedger || args.has('--disable-codex-ledger')) {
  if(rawArgs.length!==1) process.exit(2);
  configureCodexLedger(enableLedger ? enableLedger.slice('--enable-codex-ledger='.length) : null);
  process.stdout.write(`SomesToken: plugin-wide Codex ledger ${enableLedger ? 'enabled' : 'disabled'}.\n`);
  process.exit(0);
}
const claudeFeed = ['--enable-claude-feed','--disable-claude-feed'].find(a=>args.has(a));
if (claudeFeed) {
  if(rawArgs.length!==1) process.exit(2);
  configureClaudeFeed(claudeFeed==='--enable-claude-feed');
  process.stdout.write(`SomesToken: Claude usage capture ${claudeFeed==='--enable-claude-feed' ? 'enabled' : 'disabled'}.\n`);
  process.exit(0);
}
if (taskId) {
  const rootArg=rawArgs.find(a=>a.startsWith('--codex-session-root='));
  const root=rootArg?.slice('--codex-session-root='.length) ?? configuredCodexLedgerRoot(process.env);
  const task=hashOpaqueHostIdentifier(taskId.slice('--task-id='.length),'codex');
  if(!task || !root || rawArgs.some(a=>!/^--(?:task-id=|codex-session-root=|last=\d+$|json$)/.test(a))) process.exit(2);
  const last=Number(rawArgs.find(a=>a.startsWith('--last='))?.slice(7) ?? 100);
  if(!Number.isSafeInteger(last) || last<1 || last>100) process.exit(2);
  await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(readCodexTaskLedger(root,task,{last,fullDetails:true}))+'\n',error=>error?reject(error):resolve()));
  process.exit(0);
}

const resolvedState = readSomesTokenState(process.env, { publicOnly: args.has('--diagnostics') });
const state = resolvedState.state ?? { receipts: [], turns: {}, health: null };
const receipts = Array.isArray(state.receipts) ? state.receipts : [];
const countArg = process.argv.slice(2).find((arg) => /^--last=\d+$/.test(arg));
const count = countArg ? Math.min(100, Math.max(1, Number(countArg.split('=')[1]))) : 1;
const selected = receipts.slice(-count);
const hasReportState = resolvedState.source !== 'unavailable';
if (args.has('--diagnostics')) {
  if (rawArgs.some((arg) => !['--diagnostics', '--json'].includes(arg))) {
    process.stderr.write('SomesToken diagnostics · invalid bounded request · Next: use --help for supported options.\n');
    process.exit(2);
  }
  const report = readSomesTokenReport(process.env, { mode: 'diagnostics' }, { publicOnly: true }).report;
  process.stdout.write(`${args.has('--json') ? JSON.stringify(report) : formatTelemetryDiagnostics(report)}\n`);
  process.exit(0);
}
function manualHistoryText() {
  const dataAccess = resolvedState.data_access === 'plugin_data_unreadable'
    ? 'Data access · plugin data unreadable\n'
    : '';
  const reason = typeof resolvedState.data_access === 'string' && /^[a-z_]{1,80}$/.test(resolvedState.data_access)
    ? humanLabel(resolvedState.data_access)
    : 'unavailable';
  return `SomesToken · manual history unavailable on this host\nReceipt collection is independent of this report.\nWork continues within the requested scope · usage unavailable · reason=${reason}\n${dataAccess}Next: ${diagnosticAction('verify_plugin_activation')}\n`;
}

const tokenAmount=value=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?`${compact(value)} tokens`:'unavailable';
const nextText=report=>report?.status==='exact'&&!['insufficient_evidence','insufficient_data','unavailable'].includes(report.classification??report.target_status)?'':`\nNext: ${diagnosticAction('review_coverage')}`;

function summaryText(summary, breakdown, latestReceipt = null) {
  if (summary.status === 'unavailable') return formatReceipt(latestReceipt);
  const total = tokenAmount(summary.total_tokens);
  const parts = [
    `SomesToken summary · ${summary.turns} turns · ${total} total · ${humanLabel(summary.status)}`,
    `exact=${tokenText(summary.exact_receipts)} receipts`,
    `partial=${tokenText(summary.partial_receipts)} receipts`,
    `unavailable=${tokenText(summary.unavailable_receipts)} receipts`,
    `sources=${summary.resolved_sources}/${summary.expected_sources}`,
  ];
  if (breakdown.main_tokens || breakdown.subagent_tokens) {
    parts.push(`main=${tokenAmount(breakdown.main_tokens?.total_tokens)}`);
    parts.push(`subagents=${tokenAmount(breakdown.subagent_tokens?.total_tokens)}`);
  }
  return parts.join(' · ');
}

function healthText(health) {
  if (health.status === 'unavailable') return 'SomesToken health · unavailable';
  const counters = [
    'token_events_seen',
    'malformed_events',
    'duplicate_hooks',
    'duplicate_events',
    'counter_resets',
    'partial_receipts',
    'unavailable_receipts',
    'unresolved_sources',
    'lock_timeouts',
    'state_recoveries',
    'retention_drops',
    'efficiency_retention_drops',
    'receipt_retention_drops',
    'state_retention_drops',
    'late_events_after_close',
    'session_start_before_end',
    'stale_session_end_ignored',
  ].map((key) => `${humanLabel(key)}=${tokenText(health[key])}`).join(' · ');
  const reasons = health.degraded_reasons.length ? ` · reasons=${health.degraded_reasons.map(humanLabel).join(', ')}` : '';
  return `SomesToken health · ${health.status} · ${counters}${reasons}`;
}

function percentage(value) {
  if (value === null || !Number.isFinite(value)) return 'unavailable';
  const rounded = Math.round(value * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function percentValue(value) {
  return Number.isFinite(value) ? `${Math.round(value * 1000) / 1000}%` : 'unavailable';
}

function qualityText(quality) {
  if (quality.status === 'unavailable') return 'SomesToken quality · unavailable';
  const sourceRate = percentage(quality.source_coverage);
  const eventDenominator = quality.token_events_seen + quality.malformed_events;
  const parts = [
    `SomesToken quality · ${quality.turns} turns · ${quality.status}`,
    `exact=${percentage(quality.exact_rate)} (${quality.exact_receipts}/${quality.turns})`,
    `partial=${quality.partial_receipts}`,
    `unavailable=${quality.unavailable_receipts}`,
    `sources=${quality.source_resolved}/${quality.source_expected} (${sourceRate})`,
    `events=${quality.token_events_seen}/${eventDenominator} (${percentage(quality.token_event_validity)})`,
    `consistency=${quality.usage_consistent}/${quality.usage_consistency_checked} (${percentage(quality.usage_consistency_rate)})`,
  ];
  if (quality.degraded_reasons.length) parts.push(`reasons=${quality.degraded_reasons.map(humanLabel).join(', ')}`);
  return parts.join(' · ');
}

function usageText(usage) {
  if (usage.status === 'unavailable') return 'SomesToken usage · unavailable';
  const fmt = tokenAmount;
  const totals = usage.totals;
  const metadata = usage.metadata;
  return [
    `SomesToken usage · ${usage.turns} turns · ${usage.status}`,
    `main=${fmt(totals.main_tokens)}`,
    `subagents=${fmt(totals.subagent_tokens)}`,
    `total=${fmt(totals.total_tokens)}`,
    `unattributed=${fmt(totals.unattributed_tokens)}`,
    `average per selected turn=${fmt(usage.averages.total_tokens_per_selected_turn)}`,
    `average per observed receipt=${fmt(usage.averages.total_tokens_per_observed_receipt)}`,
    `model coverage=${percentage(metadata.model_coverage)}`,
    `reasoning effort coverage=${percentage(metadata.reasoning_coverage)}`,
  ].join(' · ');
}

function planAwareText(report) {
  const selected = report.selected_plan?.id==='unknown'?'plan unavailable':report.selected_plan?.display_name ?? 'plan unavailable';
  const total = tokenAmount(report.observed_tokens?.total_tokens);
  const credits = report.calculated_usage?.calculated_codex_credits ?? report.calculated_usage?.calculated_api_cost;
  const creditLabel = Number.isFinite(credits)&&credits>=0 ? `${credits} ${report.calculated_usage?.calculated_codex_credits!==undefined?'Codex credits':'USD API equivalent'}` : 'unavailable';
  const creditText = `calculated provider-rate equivalent=${creditLabel} (not billed charge)`;
  const observed = report.observed_tokens ?? {};
  const uncached = observed.uncached_input_tokens === null || observed.uncached_input_tokens === undefined
    ? 'unavailable'
    : tokenAmount(observed.uncached_input_tokens);
  const uncachedLabel = observed.uncached_input_basis === 'receipt_lower_bound'
    ? `uncached input lower bound=${uncached}`
    : `uncached input=${uncached}`;
  const capability = report.capabilities?.host && report.capabilities.host !== 'unknown'
    ? `${report.capabilities.host}/${humanLabel(report.capabilities.live_evidence)}`
    : 'unavailable';
  return `SomesToken plans · ${total} observed · ${uncachedLabel} · ${humanLabel(report.token_quality ?? 'unavailable')} · ${creditText} · ${selected} · coverage=${humanLabel(report.coverage ?? 'unavailable')} · quota=${humanLabel(report.quota_quality ?? 'unavailable')} · basis=${humanLabel(report.measurement_basis ?? 'unavailable')} · capabilities=${capability} · efficiency=${humanLabel(report.classification ?? 'insufficient_evidence')}`;
}

function efficiencyText(report) {
  return `SomesToken efficiency · ${humanLabel(report.classification ?? 'insufficient_evidence')} · reasons=${(report.reason_codes ?? []).map(humanLabel).join(', ') || 'none'} · affected=${tokenText(report.affected_exact_tokens)} exact tokens · savings unmeasured`;
}

function limitRecoveryText(report) {
  const limit = report.limit ?? {};
  const recovery = report.recovery ?? {};
  const used = percentValue(limit.used_percent);
  const resetDate = Number.isSafeInteger(limit.resets_at)&&limit.resets_at>0 ? new Date(limit.resets_at*1000) : null;
  const reset = resetDate&&Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : 'unavailable';
  return `SomesToken limit recovery · ${humanLabel(report.status ?? 'unavailable')} · mode=${humanLabel(report.mode ?? 'disabled')} · state=${humanLabel(report.state ?? 'unavailable')} · controller=${humanLabel(report.controller ?? 'none')} · used=${used} · remaining=${percentValue(limit.remaining_percent)} · reset=${reset} · goal=${humanLabel(recovery.goal_state ?? 'unavailable')} · resume attempts=${tokenText(recovery.resume_attempts)} · reasons=${(report.reason_codes ?? []).map(humanLabel).join(', ') || 'none'}`;
}

function fastText(report) {
  const fast = report.effective?.fast ?? {};
  const standard = report.effective?.standard ?? {};
  const ultrafast = report.effective?.ultrafast ?? {};
  const fastTokens = tokenAmount(fast.total_tokens);
  const standardTokens = tokenAmount(standard.total_tokens);
  const ultrafastTokens = tokenAmount(ultrafast.total_tokens);
  const comparison = report.comparison?.mode ?? 'unavailable';
  return `SomesToken fast · ${humanLabel(report.status ?? 'unavailable')} · fast=${fastTokens} · standard=${standardTokens} · ultrafast=${ultrafastTokens} · requested Fast sources=${tokenText(report.requested?.fast_sources)} · downgraded=${tokenText(report.downgraded_sources)} · comparison=${humanLabel(comparison)} · tier evidence=${humanLabel(report.coverage ?? 'unavailable')}`;
}

function advisorText(report, mode) {
  if (mode === 'capabilities') {
    const capabilities = report.capabilities ?? {};
    return `SomesToken capabilities · ${humanLabel(report.status ?? 'unavailable')} · support=${humanLabel(capabilities.support ?? 'unavailable')} · observed=${tokenText(capabilities.observed_count)} · live=${tokenText(capabilities.live_verified_count)}`;
  }
  if (mode === 'provenance') {
    return `SomesToken provenance · ${humanLabel(report.status ?? 'unavailable')} · evidence=${humanLabel(report.provenance?.evidence_quality ?? 'insufficient_evidence')} · reasons=${(report.reason_codes ?? []).map(humanLabel).join(', ') || 'none'}`;
  }
  if (mode === 'recommendations') {
    const top = report.recommendations?.[0];
    return `SomesToken recommendations · ${humanLabel(report.status ?? 'unavailable')} · ${humanLabel(top?.id ?? 'collect_more_evidence')} · savings unmeasured`;
  }
  if (mode === 'workflow') {
    const top = report.recommendations?.[0];
    const candidate = top ? ` · candidate=${top.model_family}/${top.reasoning_effort}` : '';
    const axis = top?.comparison_axis ?? 'unavailable';
    const progress = report.experiment_progress ?? {};
    const next = typeof progress.next_action === 'string' && /^[a-z_]{1,40}$/.test(progress.next_action)
      ? progress.next_action
      : 'collect_more_evidence';
    const lifecycle = typeof progress.status === 'string' && /^[a-z_]{1,40}$/.test(progress.status)
      ? ` · experiment=${humanLabel(progress.status)}`
      : '';
    const scope = ['active_session', 'comparable_workload_cohort'].includes(report.decision_scope)
      ? report.decision_scope
      : 'active_session';
    const consumption = ['typical', 'elevated', 'unavailable'].includes(report.consumption_context?.pressure)
      ? report.consumption_context.pressure
      : 'unavailable';
    const measurement = ['measurement_unavailable', 'single_pair_measured_observation', 'measured_paired_trend'].includes(progress.measurement_status)
      ? progress.measurement_status
      : 'measurement_unavailable';
    return `SomesToken workflow advisor · ${humanLabel(report.eligibility ?? 'unavailable')} · axis=${humanLabel(axis)} · next=${humanLabel(next)}${lifecycle}${candidate} · scope=${humanLabel(scope)} · consumption=${humanLabel(consumption)} · measurement=${humanLabel(measurement)} · samples=${tokenText(report.sample_count)} · savings unmeasured`;
  }
  if (mode === 'session-summary') {
    const summary = report.session_summary;
    return `SomesToken session · ${humanLabel(report.status ?? 'unavailable')} · closure=${humanLabel(summary?.closure_state ?? 'unavailable')} · events=${summary?Object.values(summary.event_counts??{}).reduce((total,value)=>total+value,0):'unavailable'}`;
  }
  if (mode === 'trends' || mode === 'compare') {
    const baseline = report.baseline_comparison ?? {};
    return `SomesToken ${mode} · ${humanLabel(report.status ?? 'unavailable')} · baseline=${humanLabel(baseline.quality ?? 'insufficient_data')} · samples=${tokenText(baseline.sample_count)}`;
  }
  if (mode === 'optimization') {
    const reduction = report.reduction_summary ?? {};
    return `SomesToken optimization · ${humanLabel(report.status ?? 'unavailable')} · experiments=${tokenText(report.experiments?.length)} · pairs=${tokenText(reduction.valid_pairs)} · shadow=${tokenText(report.shadow_policy?.decisions)} · savings unmeasured`;
  }
  if (['experiments', 'experiment', 'measured-reduction'].includes(mode)) {
    const reduction = report.reduction_summary ?? {};
    return `SomesToken optimization · ${humanLabel(report.status ?? 'unavailable')} · pairs=${tokenText(reduction.valid_pairs)} · evidence=${humanLabel(reduction.evidence ?? 'measurement unavailable')} · savings unmeasured`;
  }
  if (mode === 'manual-gates') return `SomesToken manual gates · ${humanLabel(report.status ?? 'unavailable')} · open=${tokenText(report.manual_gates?.open_count)} · satisfied=${tokenText(report.manual_gates?.satisfied_count)}`;
  if (mode === 'goal-hygiene') return `SomesToken goal hygiene · ${humanLabel(report.status ?? 'unavailable')} · windows=${tokenText(report.goal_hygiene?.length)} · report-only`;
  if (mode === 'shadow-policy') return `SomesToken shadow policy · ${humanLabel(report.status ?? 'unavailable')} · decisions=${tokenText(report.shadow_policy?.decisions)} · mode=shadow`;
  if (mode === 'calibration') return `SomesToken calibration · ${humanLabel(report.status ?? 'unavailable')} · feedback=${tokenText(report.calibration?.feedback_seen)}`;
  return `SomesToken acceptance · ${humanLabel(report.status ?? 'unavailable')} · windows=${tokenText(report.acceptance?.length)}`;
}

function safeIdentity(entry = {}) {
  const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const modelValue = metadata.model ?? entry.model;
  const reasoningValue = metadata.reasoning_effort ?? entry.reasoning_effort;
  const model = typeof modelValue === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(modelValue.trim()) ? modelValue.trim() : undefined;
  const reasoning = typeof reasoningValue === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(reasoningValue.trim()) ? reasoningValue.trim() : undefined;
  return `${model ? ` model=${model}` : ''}${reasoning ? ` reasoning=${reasoning}` : ''}`;
}

function tokenText(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 'unavailable';
}

function detail(label, usage, status, entry = {}) {
  if (!usage) return `${label}: usage unavailable`;
  const sources = entry.expected_sources === undefined ? '' : ` sources=${tokenText(entry.resolved_sources)}/${tokenText(entry.expected_sources)}`;
  const metadata = entry.metadata_status ? ` metadata=${humanLabel(entry.metadata_status)}/${humanLabel(entry.metadata_confidence ?? 'low')}` : '';
  const input = tokenText(usage.input_tokens);
  const cached = tokenText(usage.cached_input_tokens);
  const cacheMiss = typeof input === 'number' && typeof cached === 'number'
    ? Math.max(0, input - cached)
    : 'unavailable';
  return `${label}:${safeIdentity(entry)} input=${input} tokens · cached input=${cached} tokens · uncached input=${cacheMiss} tokens · output=${tokenText(usage.output_tokens)} tokens · reasoning output=${tokenText(usage.reasoning_output_tokens)} tokens · total=${tokenText(usage.total_tokens)} tokens · cache write=${tokenText(usage.cache_write_input_tokens)} tokens · status=${humanLabel(status)}${sources}${metadata}`;
}

function routingText(report) {
  const recommendation = report.recommendation;
  const lines = [
    `SomesToken routing · ${humanLabel(recommendation.policy)}/${humanLabel(report.descriptor.route)}`,
    `primary=${recommendation.primary.model_family}/${recommendation.primary.reasoning_effort}`,
    `availability=${humanLabel(recommendation.primary.availability)}`,
    `workers=${recommendation.workers.cap}/${humanLabel(recommendation.workers.mode)}`,
    `fallback=${humanLabel(recommendation.fallback_code.toLowerCase())}`,
  ].join(' · ');
  if (!report.profile_plan) return lines;
  const plan = report.profile_plan;
  return `${lines}\nSomesToken profile plan · application=${humanLabel(plan.application_status)}/${humanLabel(plan.host_action)} · primary=${plan.primary.model_family}/${plan.primary.model_id}/${plan.primary.reasoning_effort} · workers=${plan.workers.cap}/${humanLabel(plan.workers.mode)} · fallback=${humanLabel(plan.fallback_code.toLowerCase())}`;
}

function routingError(code, json) {
  const result = { routing_schema_version: 1, status: 'invalid_request', error: code };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write('SomesToken routing · invalid request · Next: use --help for supported options.\n');
  process.exitCode = 2;
}

function profileError(json) {
  const result = { report_schema_version: SOMESTOKEN_REPORT_SCHEMA_VERSION, status: 'invalid_request', error: 'invalid_report_command' };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write('SomesToken profiles · invalid request · Next: use --help for supported options.\n');
  process.exitCode = 2;
}

function parseProfileArgs(argv) {
  if (!Array.isArray(argv)) return { ok: false };
  let profiles = 0;
  let json = 0;
  let last;
  for (const argument of argv) {
    if (argument === '--profiles') {
      profiles += 1;
      continue;
    }
    if (argument === '--json') {
      json += 1;
      continue;
    }
    const match = typeof argument === 'string' ? argument.match(/^--last=(\d{1,3})$/) : null;
    if (!match || last !== undefined) return { ok: false };
    last = Number(match[1]);
    if (!Number.isSafeInteger(last) || last < 1 || last > 100) return { ok: false };
  }
  if (profiles !== 1 || json > 1) return { ok: false };
  return { ok: true, json: json === 1, last: last ?? 100 };
}

function profileText(report) {
  const format = tokenAmount;
  return [
    `SomesToken profiles · ${humanLabel(report.status)} · ${report.turns} turns`,
    `main=${format(report.totals.main_tokens)}`,
    `subagents=${format(report.totals.subagent_tokens)}`,
    `total=${format(report.totals.total_tokens)}`,
    `target=${humanLabel(report.target_status)}`,
  ].join(' · ');
}

function observedRoutingCapabilities(observedUsage) {
  const profiles = [
    ...(Array.isArray(observedUsage?.main) ? observedUsage.main : []),
    ...(Array.isArray(observedUsage?.subagents) ? observedUsage.subagents : []),
  ]
    .filter((entry) => MODEL_FAMILIES.includes(entry?.model_family)
      && ROUTING_EFFORTS.includes(entry?.reasoning_effort))
    .map((entry) => ({ model_family: entry.model_family, reasoning_effort: entry.reasoning_effort }));
  return { observed_profiles: profiles };
}

const profilePlanArgument = rawArgs.some((argument) => argument === '--profile-plan' || argument.startsWith('--profile-plan='));
const profilesArgument = rawArgs.some((argument) => argument === '--profiles' || argument.startsWith('--profiles='));
const extendedMode = SOMESTOKEN_EXTENDED_REPORT_MODES.find((mode) => args.has(`--${mode}`));
const usageJsonAlias = args.has('--usage-json');
const efficiencyJsonAlias = args.has('--efficiency-json');
const fastJsonAlias = args.has('--fast-json');

if (extendedMode) {
  const report = reportFromState(
    hasReportState ? state : null,
    { mode: extendedMode, last: count },
    resolvedState.source,
  ).report;
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else if (!hasReportState) process.stdout.write(manualHistoryText());
  else if (extendedMode === 'fast') process.stdout.write(`${fastText(report)}${nextText(report)}\n`);
  else if (['efficiency', 'loops'].includes(extendedMode)) process.stdout.write(`${efficiencyText(report)}${nextText(report)}\n`);
  else if (['limits', 'limit-recovery'].includes(extendedMode)) process.stdout.write(`${limitRecoveryText(report)}${nextText(report)}\n`);
  else if (['capabilities', 'provenance', 'recommendations', 'workflow', 'session-summary', 'trends', 'compare', 'acceptance', 'experiments', 'experiment', 'optimization', 'measured-reduction', 'manual-gates', 'goal-hygiene', 'shadow-policy', 'calibration'].includes(extendedMode)) process.stdout.write(`${advisorText(report, extendedMode)}${nextText(report)}\n`);
  else process.stdout.write(`${planAwareText(report)}${nextText(report)}\n`);
} else if (usageJsonAlias) {
  const report = reportFromState(hasReportState ? state : null, { mode: 'usage', last: count }, resolvedState.source).report;
  if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (efficiencyJsonAlias) {
  const report = reportFromState(hasReportState ? state : null, { mode: 'efficiency', last: count }, resolvedState.source).report;
  if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (fastJsonAlias) {
  const report = reportFromState(hasReportState ? state : null, { mode: 'fast', last: count }, resolvedState.source).report;
  if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (profilesArgument && args.has('--recommend')) {
  routingError('invalid_routing_command', args.has('--json'));
} else if (profilesArgument) {
  const conflicting = ['--recommend', '--profile-plan', '--summary', '--health', '--quality', '--usage', '--breakdown']
    .some((flag) => args.has(flag));
  const parsedProfiles = parseProfileArgs(rawArgs);
  if (conflicting || !parsedProfiles.ok) {
    profileError(args.has('--json'));
  } else {
    const report = reportFromState(
      hasReportState ? state : null,
      { mode: 'profiles', last: parsedProfiles.last },
      resolvedState.source,
    ).report;
    if (parsedProfiles.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write(`${profileText(report)}${nextText(report)}\n`);
  }
} else if (profilePlanArgument && !args.has('--recommend')) {
  routingError('invalid_routing_command', args.has('--json'));
} else if (args.has('--recommend')) {
  const parsed = parseRoutingArgs(rawArgs);
  if (!parsed.ok) {
    routingError(parsed.code, args.has('--json'));
  } else {
    const observedUsage = routingUsageAnalytics(
      hasReportState ? state : null,
      hasReportState ? receipts : [],
      { last: parsed.last ?? count },
    );
    const recommendation = recommendRouting(parsed.descriptor, observedRoutingCapabilities(observedUsage));
    const report = {
      routing_schema_version: 1,
      status: recommendation.status,
      descriptor: parsed.descriptor,
      recommendation,
      observed_usage: observedUsage,
      ...(parsed.profile_plan
        ? { profile_plan: buildProfilePlan(parsed.descriptor, observedRoutingCapabilities(observedUsage)) }
        : {}),
    };
    if (args.has('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write(`${routingText(report)}\n`);
  }
} else if (args.has('--quality')) {
  const quality = reportFromState(hasReportState ? state : null, { mode: 'quality', last: count }, resolvedState.source).report;
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(quality)}\n`);
  else if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${qualityText(quality)}${nextText(quality)}\n`);
} else if (args.has('--usage')) {
  const usage = reportFromState(hasReportState ? state : null, { mode: 'usage', last: count }, resolvedState.source).report;
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(usage)}\n`);
  else if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${usageText(usage)}${nextText(usage)}\n`);
} else if (args.has('--health')) {
  const health = reportFromState(hasReportState ? state : null, { mode: 'health', last: count }, resolvedState.source).report;
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(health)}\n`);
  else if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${healthText(health)}${nextText(health)}\n`);
} else if (args.has('--summary')) {
  const summary = summarizeReceipts(hasReportState ? receipts : [], { last: count });
  const breakdown = summarizeTurnBreakdowns(hasReportState ? state : null, hasReportState ? receipts : [], { last: count });
  if (args.has('--json')) process.stdout.write(`${JSON.stringify({ ...summary, breakdown })}\n`);
  else if (!hasReportState) process.stdout.write(manualHistoryText());
  else process.stdout.write(`${summaryText(summary, breakdown, selected.at(-1))}${summary.status==='unavailable'?'':nextText(summary)}\n`);
} else if (!selected.length) {
  process.stdout.write(hasReportState
    ? 'SomesToken · usage unavailable · Next: check SomesToken diagnostics.\n'
    : manualHistoryText());
} else if (args.has('--json')) {
  const safe = selected.map((receipt) => {
    const output = publicReceipt(receipt);
    if (!output) return null;
    output.turn_breakdown = publicTurnBreakdown(state, receipt);
    return output;
  }).filter(Boolean);
  process.stdout.write(`${JSON.stringify(safe)}\n`);
} else {
  const lines = selected.map((receipt) => formatReceipt(receipt));
  if (args.has('--breakdown')) {
    const turnIds = new Set(selected.map((receipt) => receipt.turn_id));
    for (const turn of Object.values(state.turns)) {
      if (!turnIds.has(turn.turn_id)) continue;
      const receipt = selected.find((entry) => entry.turn_id === turn.turn_id);
      if (receipt) {
        const ponytailReason = receipt.ponytail?.reason ? ` ponytail reason=${receipt.ponytail.reason===PONYTAIL_UNKNOWN_REASON?PONYTAIL_UNKNOWN_REASON:humanLabel(receipt.ponytail.reason)}` : '';
        lines.push(`sources: expected=${tokenText(receipt.expected_sources)} resolved=${tokenText(receipt.resolved_sources)} unavailable=${tokenText(receipt.unavailable_sources)} overflow=${tokenText(receipt.overflow_sources)} accounting=${humanLabel(receipt.accounting_status ?? receipt.status)} metadata=${humanLabel(receipt.metadata_status ?? 'unknown')} confidence=${humanLabel(receipt.metadata_confidence ?? 'low')} ponytail=${humanLabel(receipt.ponytail?.status ?? 'unknown')}${ponytailReason} savings=${humanLabel(receipt.savings?.status ?? 'unmeasured')}`);
      }
      const breakdown = publicTurnBreakdown(state, receipt);
      lines.push(detail('main', breakdown.main?.usage, breakdown.main?.status, breakdown.main));
      for (const [index, entry] of (breakdown.subagents ?? []).entries()) {
        lines.push(detail(`subagent ${index + 1}`, entry.usage, entry.status, entry));
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
