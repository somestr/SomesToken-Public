#!/usr/bin/env node
import {workspaceDirectory,readWorkspaceSnapshot,workspaceTaskReport} from '../lib/workspace-usage.mjs';
import {completedWorkObservations} from '../lib/optimization/completed-work.mjs';
import {hashOpaqueHostIdentifier,humanLabel,compact as compactNumber} from '../lib/core.mjs';
import {configuredCodexLedgerRoot} from '../lib/codex-ledger.mjs';
import {recordedPluginData} from '../lib/handoff/hook.mjs';
import {isHostOwnedAbsolutePath} from '../lib/host-paths.mjs';
import {FORECAST_FEATURE_KEYS} from '../lib/usage/forecast.mjs';
import { readSomesTokenReport, SOMESTOKEN_REPORT_MODES, formatTelemetryDiagnostics, diagnosticAction } from '../lib/report-adapter.mjs';

const CONSOLE_VIEW_MODES = Object.freeze({
  tasks:'tasks',
  daily:'daily',
  consumption:'consumption',
  // Consumption comes from the workspace store only; the views below it read
  // turn receipts and need a recent Codex hook.
  status: 'consumption',
  usage: 'consumption',
  current: 'tasks',
  session: 'session-summary',
  quality: 'quality',
  efficiency: 'efficiency',
  capabilities: 'capabilities',
  recommendations: 'recommendations',
  experiments: 'experiments',
  'manual-gates': 'manual-gates',
  'shadow-policy': 'shadow-policy',
  health: 'health',
  evidence: 'acceptance',
  doctor: 'health',
  diagnostics: 'diagnostics',
  summary: 'summary',
});

const args = process.argv.slice(2);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const viewArg = args.find((value) => value.startsWith('--view='));
const json = args.includes('--json');
const forecast = viewArg === '--view=task-forecast';
const completedWork=args.includes('--completed-work');
function invalid(message) {
  process.stderr.write(`${message} · Next: use --help for supported options.\n`);
  process.exit(2);
}
async function writeTaskOutput(text) {
  // An explicit exit can truncate large JSON reports when stdout is a pipe.
  await new Promise((resolve,reject)=>process.stdout.write(`${text}\n`,error=>error?reject(error):resolve()));
}
const duplicate = ['--task-id=', '--turn-id=', '--host=', '--view=', '--last=', '--follow=', '--current', '--completed-work', '--json']
  .some(prefix => args.filter(value => prefix.endsWith('=') ? value.startsWith(prefix) : value === prefix).length > 1);
if (duplicate) invalid(args.some(value => value.startsWith('--task-id=')) ? 'Invalid task report arguments' : 'SomesToken console · invalid bounded view');
if (forecast && !args.some(value => value.startsWith('--task-id='))) invalid('SomesToken console · task-forecast requires --task-id=<UUID>');
if (forecast && args.some(value => value === '--current' || value.startsWith('--turn-id='))) invalid('SomesToken console · task-forecast cannot combine with --current or --turn-id=<UUID>');
if(args.some(a=>a.startsWith('--task-id='))){
  const id=args.find(a=>a.startsWith('--task-id='))?.slice(10);
  const turn=args.find(a=>a.startsWith('--turn-id='))?.slice(10);
  const host=args.find(a=>a.startsWith('--host='))?.slice(7)??'codex';
  const invalidTask=!uuid.test(id??'')||(turn!==undefined&&!uuid.test(turn))||!['codex','claude'].includes(host)
    ||(turn&&args.includes('--current'))||(completedWork&&(turn||args.includes('--current')||forecast))
    ||args.some(a=>!['--task-id=','--turn-id=','--host='].some(prefix=>a.startsWith(prefix))&&!['--current','--completed-work','--json',...(forecast?['--view=task-forecast']:[])].includes(a));
  if(invalidTask) invalid('Invalid task report arguments');
  const key=hashOpaqueHostIdentifier(id,host==='claude'?'workspace:claude:task':'workspace:task');
  if(completedWork) {
    const state=readWorkspaceSnapshot(workspaceDirectory(),{taskKey:key,host});
    const selected=state&&Array.isArray(state.tasks)&&Array.isArray(state.records)?{...state,
      tasks:state.tasks.filter(t=>t?.task_key===key&&(t.host??'codex')===host),
      records:state.records.filter(r=>r?.task_key===key&&(r.host??'codex')===host)}:null;
    await writeTaskOutput(JSON.stringify(completedWorkObservations(selected)??{status:'unavailable',reason:'workspace_snapshot_unavailable'}));
    process.exit(0);
  }
  if (forecast) {
    const report = readSomesTokenReport(process.env, {mode:'task-forecast'}, {publicOnly:true, workspaceTask:key, expectedHost:host});
    await writeTaskOutput(json ? JSON.stringify(report) : compactForecast(report));
    process.exit(0);
  }
  const turnKey=turn?hashOpaqueHostIdentifier(turn,host==='claude'?'workspace:claude:turn':'ledger:turn'):null;
  await writeTaskOutput(JSON.stringify(workspaceTaskReport(readWorkspaceSnapshot(workspaceDirectory(),{taskKey:key,host}),key,{current:args.includes('--current'),turnKey})));
  process.exit(0);
}

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`SomesToken console · views=${Object.keys(CONSOLE_VIEW_MODES).join(',')} · options=--view=<view> --last=1..100 --follow=0..10 --json\nFollow takes 0..10 samples, one per second. Usage counts tokens; quota is shared account capacity.\nTask report: --task-id=<UUID> [--host=codex|claude] [--current | --turn-id=<UUID> | --completed-work] --json\nTask forecast: --task-id=<UUID> --view=task-forecast [--host=codex|claude] [--json]\n`);
  process.exit(0);
}
const lastArg = args.find((value) => value.startsWith('--last='));
const followArg = args.find((value) => value.startsWith('--follow='));
const view = viewArg ? viewArg.slice('--view='.length) : 'session';
const mode = CONSOLE_VIEW_MODES[view];
const last = lastArg ? Number(lastArg.slice('--last='.length)) : 1;
const follow = followArg ? Number(followArg.slice('--follow='.length)) : 0;

if (!mode || !SOMESTOKEN_REPORT_MODES.includes(mode) || !Number.isSafeInteger(last) || last < 1 || last > 100
  || !Number.isSafeInteger(follow) || follow < 0 || follow > 10
  || args.some((value) => !value.startsWith('--view=') && !value.startsWith('--last=') && !value.startsWith('--follow=') && value !== '--json')) {
  process.stderr.write('SomesToken console · invalid bounded view · Next: use --help for supported options.\n');
  process.exit(2);
}

function read() {
  const root=configuredCodexLedgerRoot(process.env);
  // A terminal has no PLUGIN_DATA; use the data folder the Codex hook recorded.
  const data=isHostOwnedAbsolutePath(process.env.PLUGIN_DATA)?null:recordedPluginData(process.env,'codex');
  const report=readSomesTokenReport({...process.env,...(root?{SOMESTOKEN_CODEX_SESSION_ROOT:root}:{}),...(data?{PLUGIN_DATA:data}:{})}, { mode, last }, { publicOnly: true,expectedHost:'codex',workspaceAllHosts:true });
  // current: the most recently active task (tasks are sorted by last activity).
  const body=report.report;
  if(view!=='current'||!Array.isArray(body?.tasks))return report;
  const total=Number.isSafeInteger(body.total_tasks)?body.total_tasks:body.tasks.length;
  return {...report,report:{...body,tasks:body.tasks.slice(0,1),returned_tasks:Math.min(1,total),omitted_tasks:Math.max(0,total-1),truncated:total>1}};
}

function countValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 'unavailable';
}

function observedLabel(value) {
  return typeof value === 'string' && value !== 'unknown' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/.test(value) ? value : 'unavailable';
}

function snapshotLine(body) {
  const freshness = ['fresh','stale','clock_anomaly','unavailable'].includes(body.source_freshness)
    ? body.source_freshness : body.stale === true ? 'stale' : body.stale === false ? 'fresh' : 'unavailable';
  const observedAt = Number.isSafeInteger(body.observed_at) && body.observed_at > 0 && body.observed_at <= 8640000000000000
    ? new Date(body.observed_at).toISOString() : 'unavailable';
  return `Global snapshot · freshness=${humanLabel(freshness)} · observed at=${observedAt}`;
}

function quotaWindow(window) {
  const used = typeof window?.used_percent === 'number' && Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100
    ? `${window.used_percent}% used` : 'unavailable';
  return `${humanLabel(window?.window_id)}: ${used}`;
}

function compactTasks(report) {
  const body = report.report ?? {};
  const tasks = (body.tasks ?? []).slice(0,20);
  const total = report.status==='unavailable'?'unavailable':countValue(body.total_tasks);
  const omitted = typeof total === 'number' ? Math.max(0,total-tasks.length) : 'unavailable';
  const lines = [`SomesToken tasks · ${report.status ?? 'unavailable'} · shown=${report.status==='unavailable'?'unavailable':tasks.length} · total=${total} · omitted=${omitted} · sort=${humanLabel(body.sort_basis)}`, snapshotLine(body)];
  for (const task of tasks) {
    const activity = task.recent_activity ?? {};
    const rate = ['observed','quiet','partial'].includes(activity.status) && typeof activity.total_tokens_per_hour === 'number' && Number.isFinite(activity.total_tokens_per_hour) && activity.total_tokens_per_hour >= 0
      ? `${Math.round(activity.total_tokens_per_hour)} recorded tokens/h${activity.status === 'partial' ? ' (partial)' : ''}` : observedLabel(activity.status);
    lines.push(`${task.label ?? 'Task'} · host=${observedLabel(task.host)} · observed model=${observedLabel(task.current_model)} · observed effort=${observedLabel(task.current_effort)} · coverage=${humanLabel(task.coverage_status)}`);
    lines.push(`  recorded tokens: total=${countValue(task.usage?.total_tokens)} · main=${countValue(task.main_usage?.total_tokens)} · subagent=${countValue(task.subagent_usage?.total_tokens)} · unfinished observed=${countValue(task.unfinished_observed_usage?.total_tokens)} · activity=${rate}`);
    const observation = task.host_observation;
    if (observation?.quota_windows?.length) {
      lines.push(`  account quota (shared) · ${observation.stale ? 'stale' : 'observed'} · ${observation.quota_windows.map(quotaWindow).join(' · ')}`);
    }
    if (Array.isArray(task.quota_rate_estimates) && task.quota_rate_estimates.length) lines.push(`  estimated quota rate · ${task.quota_rate_estimates.map(window => {
      const value = window?.estimated_quota_burn_pp_per_hour;
      return `${humanLabel(window?.window_id ?? window?.provider)}: ${window?.status === 'estimated' && typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `~${value.toFixed(2)} percentage points/h` : humanLabel(window?.status)}`;
    }).join(' · ')}`);
  }
  if(tasks.some(task=>task.coverage_status!=='exact'))lines.push(`Next: ${diagnosticAction('review_coverage')}`);
  lines.push('Account quota · shared; task attribution unavailable');
  return lines.join('\n');
}

const tokens = value => Number.isSafeInteger(value)&&value>=0 ? `${compactNumber(value)} tokens` : 'unavailable';
const minute = ms => Number.isSafeInteger(ms) && ms > 0 ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z` : 'unavailable';
const percent = value => Number.isFinite(value) ? `${value}%` : 'unavailable';
const HOST_LABEL = { codex: 'Codex', claude: 'Claude' };

function compactConsumption(report) {
  const body = report.report ?? {};
  const lines = [`SomesToken consumption · ${report.status ?? 'unavailable'} · host=${observedLabel(body.host)} · observed_at=${minute(body.observed_at)}`];
  for (const w of Array.isArray(body.windows) ? body.windows : []) {
    lines.push(`${HOST_LABEL[w.host] ?? 'Host'} · ${humanLabel(w.window_id)} window ${minute(w.window_started_at_ms)} → ${minute(w.resets_at_ms)} · ${percent(w.used_percent)} used (observed ${minute(w.snapshot_at_ms)})`);
    const f = w.forecast ?? {};
    lines.push(f.status === 'predicted'
      ? (f.exhausts_before_reset ? `  forecast: runs out around ${minute(f.exhaustion_at_ms)} at the recent rate (${f.percent_per_hour} percentage points/h), before the reset`
        : `  forecast: lasts until the reset at the recent rate (${f.percent_per_hour} percentage points/h)`)
      : `  forecast: unavailable${Array.isArray(f.reason_codes) && f.reason_codes.length ? ` (${f.reason_codes.map(humanLabel).join(', ')})` : ''}`);
    if(f.status!=='predicted')lines.push(`  Next: ${diagnosticAction('await_source_activity')}`);
    if (w.other_windows?.length) lines.push(`  other windows: ${w.other_windows.map(o => `${humanLabel(o.window_id)} ${percent(o.used_percent)} used`).join(' · ')}`);
    const u = w.usage ?? {};
    lines.push(`  since the window started: ${countValue(u.responses)} responses · input ${tokens(u.input_tokens)} (cached ${tokens(u.cached_input_tokens)}) · new input ${tokens(u.new_input_tokens)} · output ${tokens(u.output_tokens)} (${w.reasoning_usage_status === 'unmeasured' ? 'reasoning not reported by the host' : `reasoning ${tokens(u.reasoning_output_tokens)}`})`);
    if (w.by_profile?.length) lines.push(`  by model/effort/role: ${w.by_profile.filter(p => p.input_share_percent > 0).slice(0, 6).map(p => `${observedLabel(p.model)} ${observedLabel(p.effort)} ${p.kind === 'review' ? 'review' : observedLabel(p.role)} ${percent(p.input_share_percent)}`).join(' · ')}`);
    for (const p of w.by_profile ?? []) if (p.estimated_auto_review_credits) {
      const e = p.estimated_auto_review_credits;
      lines.push(`  auto-review credits (${observedLabel(p.effort)}, ${observedLabel(p.role)}): ${e.lower_credits}–${e.upper_credits} · ${e.label} · Luna–Sol rates, observed tokens only`);
    }
    if (w.top_tasks?.length) lines.push(`  top tasks (share of input; quota is shared by the account): ${w.top_tasks.slice(0, 5).map(t => `${t.label ?? `Task ${String(t.task_key).slice(0, 8)}`} ${percent(t.input_share_percent)}${t.signals?.length ? ` [${t.signals.map(humanLabel).join(',')}]` : ''}`).join(' · ')}`);
    if (w.by_day?.length) lines.push(`  by day: ${w.by_day.map(d => `${String(d.date).slice(5)} ${tokens(d.input_tokens)}`).join(' · ')}`);
  }
  if (!body.windows?.length) lines.push('No account quota window observed yet.');
  return lines.join('\n');
}

function compactDaily(report) {
  const body = report.report ?? {}, days = new Map();
  for (const row of Array.isArray(body.daily) ? body.daily : []) {
    const key = `${row.date} · ${observedLabel(row.host)}`, u = row.usage ?? {};
    const sum = days.get(key) ?? { responses: 0, input: 0, fresh: 0, output: 0 };
    const add=(a,b)=>Number.isSafeInteger(a)&&a>=0&&Number.isSafeInteger(b)&&b>=0&&Number.isSafeInteger(a+b)?a+b:null;
    sum.responses=add(sum.responses,row.response_count);
    sum.input=add(sum.input,u.input_tokens);sum.output=add(sum.output,u.output_tokens);
    const fresh=Number.isSafeInteger(u.input_tokens)&&Number.isSafeInteger(u.cached_input_tokens)
      ?add(Math.max(0,u.input_tokens-u.cached_input_tokens),u.cache_write_input_tokens):null;
    sum.fresh=add(sum.fresh,fresh);
    days.set(key, sum);
  }
  const lines = [`SomesToken daily · ${report.status ?? 'unavailable'}`];
  for (const [key, sum] of [...days].sort(([a], [b]) => a.localeCompare(b)).slice(-28)) {
    lines.push(`${key} · ${countValue(sum.responses)} responses · input ${tokens(sum.input)} · new input ${tokens(sum.fresh)} · output ${tokens(sum.output)}`);
  }
  return lines.join('\n');
}

function compactForecast(report) {
  const body = report.report ?? {};
  const task = body.tasks?.[0];
  const prediction = task?.forecast ?? {};
  const status = ['learning','predicted','unavailable'].includes(prediction.status) ? prediction.status : 'unavailable';
  const unit = prediction.prediction_unit === 'request_group' ? 'request group' : 'unavailable';
  const lines = [`SomesToken task forecast · ${status} · host=${observedLabel(body.host)}${task ? ` · ${task.label ?? 'Task'}` : ''}`, snapshotLine(body),
    `Prediction unit=${unit} · samples=${countValue(prediction.sample_count)} request groups · minimum=${countValue(prediction.minimum_samples)} request groups`];
  for (const percentile of ['p50','p80']) if (status === 'predicted' && prediction[percentile]) {
    lines.push(`${percentile.toUpperCase()} · total=${countValue(prediction[percentile].total_tokens)} tokens · duration=${countValue(prediction[percentile].duration_ms)} ms`);
  }
  const reasons = [...(Array.isArray(prediction.reason_codes) ? prediction.reason_codes : []), ...(body.availability_reason ? [body.availability_reason] : [])]
    .filter(value => typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value));
  if (reasons.length) lines.push(`Reasons: ${[...new Set(reasons)].map(humanLabel).join(', ')}`);
  const missing=FORECAST_FEATURE_KEYS.filter(key=>Array.isArray(prediction.missing_features)&&prediction.missing_features.includes(key));
  if(missing.length)lines.push(`Missing controls: ${missing.map(humanLabel).join(', ')}`);
  if(status!=='predicted')lines.push(`Next: ${diagnosticAction(status==='learning'?'complete_normal_turn':'review_coverage')}`);
  return lines.join('\n');
}

// The latest receipt, recent tasks, consumption and collection health, as each view prints them.
function compactSummary(report) {
  const sections = report.report?.sections ?? {};
  const part = name => sections[name] ?? { status: 'unavailable' };
  const last = part('last'), receipt = last.report?.receipts?.at(-1);
  return [`SomesToken summary · ${report.status ?? 'unavailable'}`,
    `SomesToken last · ${last.status ?? 'unavailable'}${receipt ? ` · at=${minute(receipt.created_at)} · total tokens=${countValue(receipt.total_tokens)} · model=${observedLabel(receipt.metadata?.model)} · effort=${observedLabel(receipt.metadata?.reasoning_effort)}` : ''}`,
    compactTasks(part('tasks')), compactConsumption(part('consumption')), formatTelemetryDiagnostics(part('diagnostics').report ?? {})].join('\n');
}

function compact(report) {
  const status = report.status ?? 'unavailable';
  const body = report.report ?? {};
  if (mode === 'summary') return compactSummary(report);
  if (mode === 'tasks') return compactTasks(report);
  if (mode === 'consumption') return compactConsumption(report);
  if (mode === 'daily') return compactDaily(report);
  if (view === 'diagnostics') return formatTelemetryDiagnostics(body);
  // Receipt views need a Codex hook from the last few minutes; say why when there is none.
  const access = report.source === 'unavailable' ? report.telemetry_preflight?.data_access : null;
  const why = typeof access === 'string' && /^[a-z0-9_]{1,80}$/.test(access) ? ` · reason=${humanLabel(access)}` : '';
  if (view === 'session') return `SomesToken session · ${status} · closure=${humanLabel(body.closure ?? body.session_summary?.closure_state)}${why}`;
  if (view === 'health') return `SomesToken health · ${humanLabel(body.report?.status ?? body.status ?? status)}${why}`;
  if (view === 'recommendations') return `SomesToken recommendations · ${status} · count=${status==='unavailable'?'unavailable':countValue(body.recommendation_count ?? body.recommendations?.length)}${why}`;
  return `SomesToken ${view} · ${status}${why}`;
}

let count = 0;
let timer = null;
function emit() {
  const report = read();
  const next=!json&&report.status!=='exact'&&view!=='diagnostics'?`\nNext: ${diagnosticAction(report.source==='unavailable'?'verify_plugin_activation':'review_coverage')}`:'';
  process.stdout.write(`${json?JSON.stringify(report):compact(report)+next}\n`);
  count += 1;
  if (count >= Math.max(1, follow || 1)) clearInterval(timer);
}

timer = follow > 0 ? setInterval(emit, 1000) : null;
emit();
