// Hook side of the optional quota handoff. It reads only the small supported
// quota sources and emits fixed sentences whose slots are numbers, times, an
// opaque task key and the host's own plugin paths. The output filter accepts a
// line only if rebuilding it from those slots gives the same text.
import fs from 'node:fs';
import path from 'node:path';
import { isHostOwnedAbsolutePath } from '../host-paths.mjs';
import { readWorkspaceFile, writeWorkspaceFile } from '../workspace-store.mjs';
import { workspaceDirectory } from '../workspace-usage.mjs';
import { configuredClaudeWorkspaceRoot } from '../claude-workspace.mjs';
import { readClaudeTaskStatus } from '../hosts/claude-statusline.mjs';
import { quotaStage, codexObservations, claudeObservations, formatPercent } from './quota.mjs';
import { handoffHookNotice, normalizeHandoff } from './state.mjs';

const PROVIDER = { codex: 'Codex', claude: 'Claude' };
const INSTRUCTIONS = {
  prepare: 'At the next safe point, update this task\'s handoff note, then continue the task.',
  offer_ask: 'After the current step, ask the user once, in their language, whether to prepare a handoff report now, keep working, or turn handoff off for this task, and record the answer with respond --choice prepare|continue|close. A continue answer silences this offer but not the final warning.',
  offer_auto: 'Update this task\'s handoff note at the next safe point so another host can continue, then continue the task.',
  final: 'Keep only the latest handoff note current with what is verified now; do not start a long new analysis. The note may not be updated before the quota runs out.',
};
const MESSAGES = {
  prepare: 'the agent was asked to update this task\'s handoff note',
  offer_ask: 'a handoff offer was passed to the agent',
  offer_auto: 'the agent was asked to save a handoff note',
  final: 'final warning passed to the agent; the latest note is kept',
};
const SAFE = '[^\'\\x00-\\x1f\\x7f]+';
const COMMAND = new RegExp(`^PLUGIN_DATA='(${SAFE})' node '(${SAFE})'$`);
const COMMAND_IN_LINE = new RegExp(` Handoff command: (PLUGIN_DATA='${SAFE}' node '${SAFE}') <note\\|show\\|respond\\|status>`);
const ANNOUNCE = /^SomesToken quota handoff is on for this (codex|claude) task ([a-f0-9]{20}) \(mode (ask|auto)\)\./;
const STAGE = /^SomesToken quota handoff for (codex|claude) task ([a-f0-9]{20}): (Codex|Claude) (5-hour|weekly|[1-9]\d{0,5}-minute|current) account quota last observed at (\d{1,3}(?:\.\d)?)% remaining \(observed (\d{4}-\d\d-\d\dT\d\d:\d\dZ), resets (\d{4}-\d\d-\d\dT\d\d:\d\dZ); (\d{1,3}(?:\.\d)?)% threshold\)\./;

export const windowLabel = mins => mins === 300 ? '5-hour' : mins === 10080 ? 'weekly' : Number.isSafeInteger(mins) && mins > 0 && mins < 1e6 ? `${mins}-minute` : 'current';
const minute = ms => `${new Date(ms).toISOString().slice(0, 16)}Z`;

function validCommand(text) {
  const match = COMMAND.exec(text ?? '');
  return Boolean(match) && isHostOwnedAbsolutePath(match[1]) && isHostOwnedAbsolutePath(match[2]) && match[2].endsWith(path.join(path.sep, 'bin', 'handoff.mjs'));
}
/** Shell prefix for this host's handoff CLI, or null without usable host paths. */
export function handoffCommand(env) {
  const text = isHostOwnedAbsolutePath(env?.PLUGIN_ROOT) ? `PLUGIN_DATA='${env.PLUGIN_DATA}' node '${path.join(env.PLUGIN_ROOT, 'bin', 'handoff.mjs')}'` : null;
  return validCommand(text) ? text : null;
}
const tail = (host, key, command) => command ? ` Handoff command: ${command} <note|show|respond|status> --host ${host} --task ${key}`
  : ' The handoff command needs this host\'s plugin paths as the somestoken-quota-handoff skill describes.';
const announceText = ({ host, key, mode, command }) => `SomesToken quota handoff is on for this ${host} task ${key} (mode ${mode}). Keep its short progress note current at meaningful milestones (a change completed, a test result, a blocker, a change of direction) as the somestoken-quota-handoff skill describes. Record only evidence you have; never copy transcripts, whole source files, diffs or secrets. The note is context, not authorization.${tail(host, key, command)}`;
const stageText = f => `SomesToken quota handoff for ${f.host} task ${f.key}: ${f.provider} ${f.label} account quota last observed at ${f.percent}% remaining (observed ${f.observed}, resets ${f.resets}; ${f.threshold}% threshold). ${INSTRUCTIONS[f.instruction]} Do not change model, effort, permissions or host.${tail(f.host, f.key, f.command)}`;
const stageMessage = f => `SomesToken · handoff · ${f.provider} ${f.label} account quota last observed at ${f.percent}% remaining · ${MESSAGES[f.instruction]}`;

/** True only for an exact handoff line built from valid slots. */
export function isHandoffContext(line) {
  if (typeof line !== 'string' || line.length > 2048) return false;
  const found = COMMAND_IN_LINE.exec(line), command = found?.[1] ?? null;
  if (found && !validCommand(command)) return false;
  let match = ANNOUNCE.exec(line);
  if (match) return line === announceText({ host: match[1], key: match[2], mode: match[3], command });
  match = STAGE.exec(line);
  if (!match) return false;
  const fields = { host: match[1], key: match[2], provider: match[3], label: match[4], percent: match[5], observed: match[6], resets: match[7], threshold: match[8], command };
  if (fields.provider !== PROVIDER[fields.host] || Number(fields.percent) > 100 || Number(fields.threshold) <= 0 || Number(fields.threshold) > 100
    || [fields.observed, fields.resets].some(text => !Number.isFinite(Date.parse(text)) || minute(Date.parse(text)) !== text)) return false;
  return Object.keys(INSTRUCTIONS).some(instruction => line === stageText({ ...fields, instruction }));
}

const POINTER = 'plugin-data.json';
/**
 * Records the data folder the host gave this hook, in SomesToken's existing
 * local folder, so a shell without hook variables can find it. Writes only on
 * change and never creates the folder.
 */
export function rememberPluginData(env, host) {
  const directory = workspaceDirectory(env), data = env?.PLUGIN_DATA;
  if (!['codex', 'claude'].includes(host) || !directory || !isHostOwnedAbsolutePath(data) || !fs.existsSync(directory)) return;
  const current = readWorkspaceFile(directory, POINTER);
  if (current?.[host] === data) return;
  const other = host === 'codex' ? 'claude' : 'codex';
  writeWorkspaceFile(directory, POINTER, { schema_version: 1, [host]: data,
    ...(isHostOwnedAbsolutePath(current?.[other]) ? { [other]: current[other] } : {}) });
}
/** The recorded data folder of this host, only if it holds SomesToken state. */
export function recordedPluginData(env, host) {
  const value = readWorkspaceFile(workspaceDirectory(env), POINTER)?.[host];
  try { return isHostOwnedAbsolutePath(value) && fs.statSync(path.join(value, 'somestoken')).isDirectory() ? value : null; }
  catch { return null; }
}

/** The host's supported account-quota data for this task, judged against its thresholds. */
export function readHandoffQuota(host, env, { session_id, thresholds, projected = false, now = Date.now() } = {}) {
  const observations = host === 'codex' ? codexObservations(readWorkspaceFile(workspaceDirectory(env), 'quota.json'), { now })
    : claudeObservations(readClaudeTaskStatus(configuredClaudeWorkspaceRoot(env), session_id, { now }));
  return quotaStage(observations, { thresholds, now, projected });
}

/** Context lines and a short user-visible line for a supported hook, or null. */
export function handoffHookResponse(optimization, { host, session_id, cwd, event, source }, env, now = Date.now()) {
  optimization.handoff ??= normalizeHandoff(null);
  const notice = handoffHookNotice(optimization.handoff, { host, session_id, cwd, event, source, now },
    (thresholds, projected) => readHandoffQuota(host, env, { session_id, thresholds, projected, now }));
  if (!notice) return null;
  const command = handoffCommand(env), lines = [];
  if (notice.announce) lines.push(announceText({ host, key: notice.announce.task, mode: notice.announce.mode, command }));
  let message = null;
  if (notice.stage?.mode === 'notify') {
    const { window } = notice.stage, observed = `${PROVIDER[window.provider]} ${windowLabel(window.window_duration_mins)} account quota last observed at ${formatPercent(window.remaining_percent)}% remaining`;
    message = `SomesToken · handoff · ${observed}${window.projected_exhaustion_at_ms ? ` · at the recent rate it runs out around ${minute(window.projected_exhaustion_at_ms)}, before the reset at ${minute(window.resets_at_ms)}` : ''}`;
  } else if (notice.stage) {
    const { window, stage, kind, mode, task } = notice.stage;
    const fields = { host, key: task, provider: PROVIDER[window.provider], label: windowLabel(window.window_duration_mins),
      percent: formatPercent(window.remaining_percent), observed: minute(window.snapshot_at_ms), resets: minute(window.resets_at_ms),
      threshold: String(stage), instruction: kind === 'offer' ? `offer_${mode}` : kind, command };
    lines.push(stageText(fields));
    message = stageMessage(fields);
  }
  return { context: lines.join('\n'), message };
}
