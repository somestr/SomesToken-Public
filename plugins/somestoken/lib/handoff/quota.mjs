// Account-quota stage for the optional handoff feature. Only each host's
// supported quota data is used; windows are judged separately and never summed,
// averaged or scaled. Missing or stale data is "unknown", never "zero left".
import { forecastQuotaWindows } from '../usage/forecast.mjs';

export const DEFAULT_THRESHOLDS = [5, 3, 1];
// A window projected to run out before its reset at the recent aggregate rate.
// It sorts after every remaining-percentage threshold, so a crossed threshold
// is always more urgent, and it is reported only when a caller asks for it.
export const PROJECTED_STAGE = 101;
// Codex quota is refreshed by the collector about once a minute while active;
// Claude's arrives with status-line updates.
const MAX_AGE_MS = 15 * 60000;
const CLOCK_SKEW_MS = 60000;
// A reset time that moves by less than this is the same window cycle.
const RESET_JITTER_MS = 10 * 60000;
// The general Codex bucket; model-specific buckets cannot be attributed to a task.
const CODEX_BUCKET = 'codex';

export function formatPercent(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export const sameCycle = (a, b) => Boolean(a && b) && a.window_key === b.window_key && Math.abs(a.resets_at_ms - b.resets_at_ms) < RESET_JITTER_MS;

/** Most urgent crossed threshold across the valid, fresh windows. */
export function quotaStage(observations, { thresholds = DEFAULT_THRESHOLDS, now = Date.now(), maxAgeMs = MAX_AGE_MS, projected = false } = {}) {
  const valid = (Array.isArray(observations) ? observations : []).filter(item => typeof item?.used_percent === 'number'
    && Number.isFinite(item.used_percent) && item.used_percent >= 0 && item.used_percent <= 100
    && Number.isSafeInteger(item.resets_at_ms) && item.resets_at_ms > now && Number.isFinite(new Date(item.resets_at_ms).getTime())
    && Number.isSafeInteger(item.snapshot_at_ms) && item.snapshot_at_ms <= now + CLOCK_SKEW_MS);
  if (!valid.length) return { status: 'unavailable', stage: null };
  const fresh = valid.filter(item => now - item.snapshot_at_ms <= maxAgeMs);
  if (!fresh.length) return { status: 'stale', stage: null };
  const worst = fresh.map(item => ({ ...item, remaining_percent: 100 - item.used_percent })).sort((a, b) => a.remaining_percent - b.remaining_percent)[0];
  let stage = [...thresholds].sort((a, b) => a - b).find(threshold => worst.remaining_percent <= threshold) ?? null, chosen = worst;
  if (stage === null && projected) {
    const runningOut = fresh.filter(item => Number.isSafeInteger(item.projected_exhaustion_at_ms) && item.projected_exhaustion_at_ms > now
      && item.projected_exhaustion_at_ms < item.resets_at_ms).sort((a, b) => a.projected_exhaustion_at_ms - b.projected_exhaustion_at_ms)[0];
    if (runningOut) { stage = PROJECTED_STAGE; chosen = { ...runningOut, remaining_percent: 100 - runningOut.used_percent }; }
  }
  return { status: 'observed', stage, window: { provider: chosen.provider, bucket: chosen.bucket, window_id: chosen.window_id,
    window_duration_mins: Number.isSafeInteger(chosen.window_duration_mins) && chosen.window_duration_mins > 0 ? chosen.window_duration_mins : null, window_key: `${chosen.provider}:${chosen.bucket}:${chosen.window_id}`, remaining_percent: chosen.remaining_percent,
    resets_at_ms: chosen.resets_at_ms, snapshot_at_ms: chosen.snapshot_at_ms,
    ...(stage === PROJECTED_STAGE ? { projected_exhaustion_at_ms: chosen.projected_exhaustion_at_ms } : {}) } };
}

/**
 * Latest observation per window of the general Codex bucket. Only the account
 * of the newest snapshot counts: an older login's windows are not merged in.
 */
export function codexObservations(sidecar, { now = Date.now() } = {}) {
  const rows = (Array.isArray(sidecar?.quota_history) ? sidecar.quota_history : [])
    .filter(item => (item?.provider ?? 'codex') === 'codex' && item.limit_id === CODEX_BUCKET && typeof item.window_id === 'string' && Number.isSafeInteger(item.snapshot_at_ms));
  const account = rows.reduce((newest, item) => (!newest || item.snapshot_at_ms > newest.snapshot_at_ms ? item : newest), null)?.account_id;
  const latest = new Map();
  for (const item of rows) {
    if (item.account_id !== account) continue;
    if (!latest.has(item.window_id) || latest.get(item.window_id).snapshot_at_ms < item.snapshot_at_ms) latest.set(item.window_id, item);
  }
  // The same constant-rate scenario the collector reports, from this account's history.
  const forecasts = forecastQuotaWindows(rows.filter(item => item.account_id === account), { at: now });
  return [...latest.values()].map(item => {
    const forecast = forecasts.find(f => f.window_id === item.window_id && f.status === 'predicted' && f.exhausts_before_reset === true && Number.isFinite(f.exhaustion_at_ms));
    return { provider: 'codex', bucket: CODEX_BUCKET, window_id: item.window_id, window_duration_mins: item.window_duration_mins,
      used_percent: item.used_percent, resets_at_ms: item.resets_at_ms, snapshot_at_ms: item.snapshot_at_ms,
      ...(forecast ? { projected_exhaustion_at_ms: Math.round(forecast.exhaustion_at_ms) } : {}) };
  });
}

/** Claude's account windows from one normalised status-line record. */
export function claudeObservations(record) {
  return (Array.isArray(record?.quota_windows) ? record.quota_windows : [])
    .filter(item => ['five_hour', 'seven_day'].includes(item?.window_id))
    .map(item => ({ provider: 'claude', bucket: 'account', window_id: item.window_id, window_duration_mins: item.window_id === 'five_hour' ? 300 : 10080,
      used_percent: item.used_percent, resets_at_ms: item.resets_at_ms, snapshot_at_ms: item.snapshot_at_ms }));
}
