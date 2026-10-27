// What each host used since its account quota window started, next to the host's
// own reading of that window. Token shares only: a host reports one percentage for
// the whole account, so quota is never divided between tasks or models.
import { streamWorkspaceRecords, expandRecord, canonicalRecord } from './workspace-store.mjs';
import { withQuotaSidecar } from './workspace-usage.mjs';
import { forecastQuotaWindows } from './usage/forecast.mjs';
import { estimateAutoReviewCredits } from './usage/credits.mjs';

const HOSTS = ['codex', 'claude'];
// Account windows last at most a week; a day of margin covers clock skew.
const RETAINED_MS = 8 * 86_400_000;
// The general Codex bucket; model-specific buckets are listed, not used for the window.
const CODEX_BUCKET = 'codex';
const SHAPE_SIGNALS = new Set(['context_bloat', 'long_lived_thread', 'long_autonomous_turn', 'review_overhead']);
const REVIEW_MODELS = new Set(['codex-auto-review']);

const share = (part, whole) => whole > 0 ? Math.round(part / whole * 1000) / 10 : null;
// new_input_tokens is what the provider had not cached: uncached input plus cache
// writes (Claude writes each turn's new context to its cache; Codex reports none).
const total = () => ({ responses: 0, input_tokens: 0, cached_input_tokens: 0, uncached_input_tokens: 0, cache_write_input_tokens: 0,
  new_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
function add(sum, row) {
  const u = row.usage ?? {};
  sum.responses = Math.min(Number.MAX_SAFE_INTEGER, sum.responses + 1);
  sum.input_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.input_tokens + u.input_tokens);
  sum.cached_input_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.cached_input_tokens + u.cached_input_tokens);
  const uncached = Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)), written = u.cache_write_input_tokens ?? 0;
  sum.uncached_input_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.uncached_input_tokens + uncached);
  sum.cache_write_input_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.cache_write_input_tokens + written);
  sum.new_input_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.new_input_tokens + uncached + written);
  sum.output_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.output_tokens + u.output_tokens);
  sum.reasoning_output_tokens = Math.min(Number.MAX_SAFE_INTEGER, sum.reasoning_output_tokens + u.reasoning_output_tokens);
}
const dayOf = timeZone => {
  let format;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { format = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return at => format.format(at);
};

// Latest reading per window of the general Codex bucket, with the constant-rate scenario.
function codexWindows(history, now) {
  const rows = history.filter(q => (q.provider ?? 'codex') === 'codex' && q.limit_id === CODEX_BUCKET && Number.isSafeInteger(q.snapshot_at_ms));
  const latest = new Map();
  for (const q of rows) if (!latest.has(q.window_id) || latest.get(q.window_id).snapshot_at_ms < q.snapshot_at_ms) latest.set(q.window_id, q);
  const forecasts = forecastQuotaWindows(rows, { at: now });
  return [...latest.values()].map(q => {
    const f = forecasts.find(x => x.window_id === q.window_id && x.account_id === q.account_id);
    return { window_id: q.window_id, window_duration_mins: q.window_duration_mins, used_percent: q.used_percent, resets_at_ms: q.resets_at_ms,
      snapshot_at_ms: q.snapshot_at_ms, forecast: f ? { status: f.status, exhausts_before_reset: f.exhausts_before_reset ?? null,
        exhaustion_at_ms: Number.isFinite(f.exhaustion_at_ms) ? Math.round(f.exhaustion_at_ms) : null,
        percent_per_hour: Number.isFinite(f.percent_per_hour) ? Math.round(f.percent_per_hour * 100) / 100 : null,
        reason_codes: Array.isArray(f.reason_codes) ? f.reason_codes : [] } : { status: 'unavailable', reason_codes: ['no_quota_history'] } };
  });
}

// The newest Claude status-line reading across tasks; Claude gives no history to project.
function claudeWindows(tasks) {
  const observed = tasks.map(t => t.host_observation).filter(o => o?.host === 'claude' && Array.isArray(o.quota_windows))
    .sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0))[0];
  return (observed?.quota_windows ?? []).filter(w => typeof w?.window_id === 'string').map(w => ({ window_id: w.window_id,
    window_duration_mins: w.window_duration_mins, used_percent: w.used_percent, resets_at_ms: w.resets_at_ms, snapshot_at_ms: w.snapshot_at_ms,
    forecast: { status: 'unavailable', reason_codes: ['host_history_unavailable'] } }));
}

function summarize(host, windows, rows, tasks, timeZone, now) {
  const valid = windows.filter(w => Number.isSafeInteger(w.resets_at_ms) && Number.isSafeInteger(w.window_duration_mins) && w.window_duration_mins > 0);
  if (!valid.length) return null;
  const main = valid.sort((a, b) => b.window_duration_mins - a.window_duration_mins)[0];
  const startedAt = main.resets_at_ms - main.window_duration_mins * 60_000;
  const usage = total(), profiles = new Map(), perTask = new Map(), days = new Map(), day = dayOf(timeZone);
  for (const row of rows) {
    if (row.host !== host || row.observed_at < startedAt || row.observed_at > now) continue;
    add(usage, row);
    const kind = REVIEW_MODELS.has(row.model) ? 'review' : 'agent', key = `${row.model}\0${row.effort}\0${row.role}\0${kind}`;
    if (!profiles.has(key)) profiles.set(key, { model: row.model, effort: row.effort, role: row.role, kind, ...total() });
    add(profiles.get(key), row);
    if (!perTask.has(row.task_key)) perTask.set(row.task_key, { task_key: row.task_key, ...total() });
    add(perTask.get(row.task_key), row);
    const date = day(row.observed_at);
    if (!days.has(date)) days.set(date, { date, ...total() });
    add(days.get(date), row);
  }
  const byInput = (a, b) => b.input_tokens - a.input_tokens || String(a.task_key ?? a.model).localeCompare(String(b.task_key ?? b.model));
  const shape = new Map(tasks.map(t => [t.task_key, t]));
  return {
    host, window_id: main.window_id, window_duration_mins: main.window_duration_mins, window_started_at_ms: startedAt,
    resets_at_ms: main.resets_at_ms, used_percent: main.used_percent, snapshot_at_ms: main.snapshot_at_ms, forecast: main.forecast,
    other_windows: valid.filter(w => w !== main).map(w => ({ window_id: w.window_id, window_duration_mins: w.window_duration_mins,
      used_percent: w.used_percent, resets_at_ms: w.resets_at_ms })),
    // Claude does not report reasoning output separately; its count stays 0 and unmeasured.
    usage, reasoning_usage_status: host === 'claude' ? 'unmeasured' : 'observed',
    by_profile: [...profiles.values()].sort(byInput).map(p => ({ ...p, input_share_percent: share(p.input_tokens, usage.input_tokens),
      ...(host === 'codex' && REVIEW_MODELS.has(p.model) ? { estimated_auto_review_credits: estimateAutoReviewCredits(p) } : {}) })),
    top_tasks: [...perTask.values()].sort(byInput).slice(0, 10).map(t => ({ ...t, label: typeof shape.get(t.task_key)?.label === 'string' && /^Task [a-f0-9]{8}$/.test(shape.get(t.task_key).label) ? shape.get(t.task_key).label : null,
      signals: Array.isArray(shape.get(t.task_key)?.task_shape?.signals) ? shape.get(t.task_key).task_shape.signals.filter(signal => SHAPE_SIGNALS.has(signal)) : [], input_share_percent: share(t.input_tokens, usage.input_tokens) })),
    by_day: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    attribution: 'token_share_only', quota_task_attribution: 'unavailable',
  };
}

/** Streams the snapshot once and keeps only the last week's rows in compact form. */
export function readConsumption(directory, { now = Date.now(), hosts = HOSTS } = {}) {
  const rows = [], since = now - RETAINED_MS;
  const snapshot = streamWorkspaceRecords(directory, raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const r = expandRecord(raw);
    if (!canonicalRecord(r) || r.observed_at < since) return;
    rows.push({ host: r.host, task_key: r.task_key, model: r.model, effort: r.effort, role: r.role, observed_at: r.observed_at,
      usage: { input_tokens: r.usage?.input_tokens, cached_input_tokens: r.usage?.cached_input_tokens,
        cache_write_input_tokens: r.usage?.cache_write_input_tokens, output_tokens: r.usage?.output_tokens, reasoning_output_tokens: r.usage?.reasoning_output_tokens } });
  }, { skipKeys: new Set(['completed_work']), mapItem: (key, t) => key === 'tasks'
    ? { task_key: t?.task_key, host: t?.host, label: t?.label, task_shape: t?.task_shape, host_observation: t?.host_observation } : t });
  if (!snapshot) return { schema_version: 1, status: 'unavailable', observed_at: now, windows: [], reason_codes: ['workspace_snapshot_unavailable'] };
  const meta = withQuotaSidecar(directory, snapshot.meta), tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
  const timeZone = typeof meta.time_zone === 'string' ? meta.time_zone : 'UTC';
  const windows = [];
  for (const host of HOSTS.filter(h => hosts.includes(h))) {
    const summary = summarize(host, host === 'codex' ? codexWindows(Array.isArray(meta.quota_history) ? meta.quota_history : [], now) : claudeWindows(tasks),
      rows, tasks.filter(t => t.host === host), timeZone, now);
    if (summary) windows.push(summary);
  }
  return { schema_version: 1, status: windows.length ? 'observed' : 'unavailable', observed_at: now, time_zone: timeZone, windows,
    snapshot_observed_at: meta.observed_at ?? null, snapshot_status: meta.status === 'exact' ? 'exact' : 'partial',
    measurement_basis: 'host_counters_and_host_quota_readings' };
}
