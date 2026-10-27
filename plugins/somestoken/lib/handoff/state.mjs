// Opt-in quota handoff: scoped settings and per-task delivery records kept in
// SomesToken's private optimization state. Deciding when to notify needs no
// model call; the notes themselves are written by the running agent.
import fs from 'node:fs';
import path from 'node:path';
import { hashOpaqueHostIdentifier,isHashedIdentity } from '../core.mjs';
import { policySelector } from '../optimization/active-policy.mjs';
import { DEFAULT_THRESHOLDS, sameCycle } from './quota.mjs';

// notify only shows the user quota notices: no progress note and no agent instruction.
export const HANDOFF_MODES = ['off', 'ask', 'auto', 'notify'];
export const HANDOFF_CHOICES = ['prepare', 'continue', 'close'];
const HOSTS = ['codex', 'claude'], SCOPES = ['task', 'project', 'repository', 'host'];
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'];
const MAX_SETTINGS = 128, MAX_TASKS = 256;
const integer = value => Number.isSafeInteger(value) && value >= 0;
// Up to three strictly descending percentages with at most one decimal place.
const validThresholds = list => Array.isArray(list) && list.length >= 1 && list.length <= 3
  && list.every((value, index) => Number.isFinite(value) && value > 0 && value <= 100 && Math.round(value * 10) / 10 === value
    && (index === 0 || value < list[index - 1]));
const OFF = Object.freeze({ mode: 'off', scope: null, thresholds: DEFAULT_THRESHOLDS, target: null, obsidian: false });

export function taskKey(host, sessionId) {
  return HOSTS.includes(host) ? hashOpaqueHostIdentifier(sessionId, host) : null;
}

export function normalizeHandoff(value) {
  const settings = {}, tasks = {};
  for (const [key, row] of Object.entries(value?.settings ?? {}).slice(-MAX_SETTINGS)) {
    if (!HOSTS.includes(row?.host) || !SCOPES.includes(row.scope) || typeof row.scope_key !== 'string'
      || key !== `${row.host}:${row.scope}:${row.scope_key}` || !HANDOFF_MODES.includes(row.mode)) continue;
    settings[key] = { host: row.host, scope: row.scope, scope_key: row.scope_key, mode: row.mode,
      thresholds: validThresholds(row.thresholds) ? [...row.thresholds] : [...DEFAULT_THRESHOLDS],
      target: typeof row.target === 'string' && path.isAbsolute(row.target) ? row.target : null,
      obsidian: row.obsidian === true, updated_at: integer(row.updated_at) ? row.updated_at : 0 };
  }
  for (const [key, row] of Object.entries(value?.tasks ?? {}).slice(-MAX_TASKS)) {
    if (!/^(?:codex|claude):[a-f0-9]{20}$/.test(key) || !row || typeof row !== 'object') continue;
    tasks[key] = {
      announced: HANDOFF_MODES.includes(row.announced) ? row.announced : null,
      cycle: typeof row.cycle?.window_key === 'string' && integer(row.cycle.resets_at_ms) ? { window_key: row.cycle.window_key, resets_at_ms: row.cycle.resets_at_ms } : null,
      emitted_stage: Number.isFinite(row.emitted_stage) ? row.emitted_stage : null,
      emitted_at: integer(row.emitted_at) ? row.emitted_at : 0,
      continued: row.continued === true, closed: row.closed === true,
      response: HANDOFF_CHOICES.includes(row.response) ? row.response : null,
      responded_at: integer(row.responded_at) ? row.responded_at : 0,
    };
  }
  return { settings, tasks };
}

/** Stores a scoped choice; a target must be an existing, unlinked directory. */
export function setHandoff(state, selector, { mode, thresholds = DEFAULT_THRESHOLDS, target = null, obsidian = false } = {}, at = Date.now()) {
  if (!selector || !HANDOFF_MODES.includes(mode) || !validThresholds(thresholds) || !integer(at)) return { ok: false, error: 'invalid_handoff_setting' };
  let resolved = null;
  if (target !== null) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) return { ok: false, error: 'invalid_handoff_target' };
    try {
      if (!fs.lstatSync(target).isDirectory()) return { ok: false, error: 'invalid_handoff_target' };
      resolved = fs.realpathSync(target);
    } catch { return { ok: false, error: 'invalid_handoff_target' }; }
  }
  const normalized = normalizeHandoff(state), key = `${selector.host}:${selector.scope}:${selector.scope_key}`;
  delete normalized.settings[key];
  normalized.settings[key] = { ...selector, mode, thresholds: [...thresholds], target: resolved, obsidian: obsidian === true && resolved !== null, updated_at: at };
  Object.assign(state, normalizeHandoff(normalized));
  return { ok: true, setting: normalized.settings[key] };
}

const keyOf = (host, session_id, task) => isHashedIdentity(task) ? task : taskKey(host, session_id);

/** Task over project over repository over the host default; closed tasks are off. */
export function effectiveHandoff(state, { host, session_id, task, cwd } = {}) {
  const normalized = normalizeHandoff(state), key = keyOf(host, session_id, task);
  if (key && normalized.tasks[`${host}:${key}`]?.closed) return { ...OFF, scope: 'task', closed: true };
  // Most hosts have no setting at all: skip repository lookups entirely.
  if (!Object.values(normalized.settings).some(row => row.host === host)) return { ...OFF };
  for (const selector of [key && { host, scope: 'task', scope_key: key }, policySelector({ host, scope: 'project', cwd }),
    policySelector({ host, scope: 'repository', cwd }), policySelector({ host, scope: 'host' })]) {
    const row = selector && normalized.settings[`${selector.host}:${selector.scope}:${selector.scope_key}`];
    if (row) return row;
  }
  return { ...OFF };
}

// With thresholds [5, 3, 1]: 5 prepares the note, 3 offers a handoff, 1 is the final warning.
function stageKind(stage, thresholds) {
  const ascending = [...thresholds].sort((a, b) => a - b);
  return stage === ascending[0] ? 'final' : stage === ascending[1] ? 'offer' : 'prepare';
}

/**
 * Decides what a supported hook may say for this task: a one-time notice that
 * notes are kept, and the most urgent newly crossed quota stage. `readQuota` is
 * called only when the feature is on; tool events reach this at most once per
 * public-bridge lease (a minute), the rest stay on the deferred path.
 */
export function handoffHookNotice(state, { host, session_id, cwd, event, source, now = Date.now() } = {}, readQuota) {
  if (!EVENTS.includes(event) || !integer(now)) return null;
  const setting = effectiveHandoff(state, { host, session_id, cwd }), key = taskKey(host, session_id);
  if (setting.mode === 'off' || !key) return null;
  const normalized = normalizeHandoff(state), id = `${host}:${key}`;
  const record = normalized.tasks[id] ?? normalizeHandoff({ tasks: { [id]: {} } }).tasks[id];
  const result = {};
  const reloaded = event === 'SessionStart' && ['resume', 'clear', 'compact'].includes(source);
  if (record.announced !== setting.mode || reloaded) {
    record.announced = setting.mode;
    if (setting.mode !== 'notify') result.announce = { mode: setting.mode, task: key };
  }
  const quota = readQuota?.(setting.thresholds, setting.mode === 'notify');
  if (quota?.status === 'observed' && quota.window) {
    const window = quota.window, anchor = record.cycle, cycle = { window_key: window.window_key, resets_at_ms: window.resets_at_ms };
    // The cycle is anchored to the window that last caused a notice. It ends when
    // that window resets; another window becoming the worst one does not end it.
    if (!anchor) record.cycle = cycle;
    else if (anchor.window_key === window.window_key ? !sameCycle(anchor, window) : now >= anchor.resets_at_ms) {
      Object.assign(record, { cycle, emitted_stage: null, continued: false });
    } else if (anchor.window_key === window.window_key) record.cycle = cycle;
    const final = Math.min(...setting.thresholds), stage = quota.stage;
    // "Continue" silences the earlier offers of this cycle, never the final warning.
    if (stage !== null && (record.emitted_stage === null || stage < record.emitted_stage) && !(record.continued && stage > final)) {
      Object.assign(record, { cycle, emitted_stage: stage, emitted_at: now });
      result.stage = { stage, kind: stageKind(stage, setting.thresholds), mode: setting.mode, window, task: key };
    }
  }
  delete normalized.tasks[id];
  normalized.tasks[id] = record;
  Object.assign(state, normalizeHandoff(normalized));
  return result.announce || result.stage ? result : null;
}

/** Records the user's answer to an offer for one task. */
export function respondHandoff(state, { host, session_id, task, choice, at = Date.now() } = {}) {
  const key = keyOf(host, session_id, task);
  if (!HOSTS.includes(host) || !key || !HANDOFF_CHOICES.includes(choice) || !integer(at)) return { ok: false, error: 'invalid_handoff_response' };
  const normalized = normalizeHandoff(state), id = `${host}:${key}`;
  const record = normalized.tasks[id] ?? normalizeHandoff({ tasks: { [id]: {} } }).tasks[id];
  Object.assign(record, { response: choice, responded_at: at }, choice === 'continue' ? { continued: true } : choice === 'close' ? { closed: true } : {});
  delete normalized.tasks[id];
  normalized.tasks[id] = record;
  Object.assign(state, normalizeHandoff(normalized));
  return { ok: true, task: key, choice };
}

/** Effective setting and delivery record of one task, without quota values. */
export function handoffStatus(state, { host, session_id, task, cwd } = {}) {
  const key = keyOf(host, session_id, task);
  const record = key ? normalizeHandoff(state).tasks[`${host}:${key}`] ?? null : null;
  const setting = effectiveHandoff(state, { host, task: key, cwd });
  return { ok: true, task: key, mode: setting.mode, scope: setting.scope, thresholds: setting.thresholds, target_configured: Boolean(setting.target),
    delivery: record && { announced: record.announced, emitted_stage: record.emitted_stage, continued: record.continued, closed: record.closed, response: record.response },
    delivery_basis: 'hook_emitted_not_user_seen' };
}
