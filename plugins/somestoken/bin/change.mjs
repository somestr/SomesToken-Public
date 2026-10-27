#!/usr/bin/env node
// Local code-change workflow for the host model: in-place start/finish with an
// automatic restore, or plan/candidate/verify/apply in an isolated worktree.
// Separate from usage telemetry.
import path from 'node:path';
import {humanLabel} from '../lib/core.mjs';
import { capabilities } from '../lib/change/toolchain.mjs';
import { planChange, candidatePatch, verifyChange, applyChange, changeStatus, startChange, finishChange, LEVELS } from '../lib/change/workflow.mjs';

const USAGE = [
  'SomesToken change · exit 0 ok, 2 invalid usage, 3 not verified/refused',
  `start [--root DIR] --level ${LEVELS.join('|')} --files a,b [--preserve file#Symbol]... [--check "command"]... [--bench "command"] [--json]`,
  'finish [--root DIR] [--plan ID] [--json]   (checks the in-place edit; restores it unless verified)',
  'capabilities [--root DIR]',
  `plan [--root DIR] --level ${LEVELS.join('|')} --files a,b [--preserve file#Symbol]... [--check "command"]... [--bench "command"]`,
  'candidate [--root DIR] --plan ID --file path=proposed-file... --out FILE',
  'verify [--root DIR] --plan ID --patch FILE',
  'apply [--root DIR] --plan ID --patch FILE',
  'status [--root DIR] --plan ID',
].join('\n');
const OPTIONS = {
  start: ['--root', '--level', '--files', '--preserve', '--check', '--bench'],
  finish: ['--root', '--plan'],
  capabilities: ['--root'],
  plan: ['--root', '--level', '--files', '--preserve', '--check', '--bench'],
  candidate: ['--root', '--plan', '--file', '--out'],
  verify: ['--root', '--plan', '--patch'],
  apply: ['--root', '--plan', '--patch'],
  status: ['--root', '--plan'],
};
const REPEATED = new Set(['--preserve', '--check', '--file']);

function parse(argv) {
  const [command, ...all] = argv;
  if (!OPTIONS[command]) return null;
  const values = { json: all.includes('--json') }, rest = all.filter(arg => arg !== '--json');
  for (let i = 0; i < rest.length; i += 2) {
    const [key, value] = [rest[i], rest[i + 1]];
    if (!OPTIONS[command].includes(key) || value === undefined || (!REPEATED.has(key) && key in values)) return null;
    if (REPEATED.has(key)) (values[key] ??= []).push(value);
    else values[key] = value;
  }
  return { command, values };
}

const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) { console.log(USAGE); process.exit(0); }
const parsed = parse(args);
if (!parsed) { console.log(JSON.stringify({ ok: false, error: 'invalid_usage' })); console.error(USAGE); process.exit(2); }
const { command, values } = parsed, root = path.resolve(values['--root'] ?? process.cwd());
const planOptions = () => ({ level: values['--level'], files: values['--files']?.split(',').map(file => file.trim()).filter(Boolean),
  preserve: values['--preserve'] ?? [], checks: values['--check'] ?? null, bench: values['--bench'] ?? null });
// The in-place pair answers in one line (plus the failing check's tail) unless --json asks for everything.
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
function reasonText(reason) {
  const separator = reason.indexOf(':'), code = separator < 0 ? reason : reason.slice(0, separator);
  let detail = separator < 0 ? undefined : reason.slice(separator + 1);
  if (code === 'verification_error') detail = detail.replace(/\s+/g, ' ').slice(0, 200);
  return `${humanLabel(code)}${detail === undefined ? '' : `: ${detail}`}`;
}
function line(result) {
  if (result.error === 'invalid_scope_file') return 'error: invalid_scope_file · Next: manual restoration is required after checking path ownership; do not write through the unsafe path.';
  if (command === 'start') return !result.ok ? `error: ${humanLabel(result.error)} · Next: use --help for supported options.` : `plan ${result.plan_id}: ${result.read_only ? 'review is read-only; report findings without editing'
    : `edit ${result.files.join(', ')} in place, then run finish; ${result.checks.length ? `it runs ${result.checks.join(', ')}` : 'no test command found, so run start again with --check "<command>"'}`}`;
  if (!result.verdict) return result.error === 'no_open_change' ? 'no open change; run start first' : `error: ${humanLabel(result.error)} · Next: use --help for supported options.`;
  const ran = result.checks.filter(check => check.stage === 'candidate');
  if (result.ok) return `verified: ${ran.map(check => `${check.command} passed (${seconds(check.duration_ms)})`).join(', ')}${result.benchmark ? `, time ${result.benchmark.time_change_percent}%${result.benchmark.memory_change_percent === null ? '' : `, memory ${result.benchmark.memory_change_percent}%`}` : ''}; kept ${result.files.join(', ')}`;
  const failed = ran.find(check => check.status === 'failed');
  return `${result.verdict}: ${result.reasons.map(reasonText).join(', ')}; ${result.restored ? `restored ${result.files.join(', ')}` : 'nothing was changed'}`
    + (failed ? `\n--- ${failed.command} (last lines)\n${failed.output_tail.trim().split('\n').slice(-25).join('\n').slice(-1500)}` : '');
}
const result = command === 'start' ? startChange(root, planOptions())
  : command === 'finish' ? finishChange(root, values['--plan'])
  : command === 'capabilities' ? { ok: true, ...capabilities(root) }
  : command === 'plan' ? planChange(root, planOptions())
  : command === 'candidate' ? candidatePatch(root, values['--plan'], Object.fromEntries((values['--file'] ?? []).map(pair => {
    const split = pair.indexOf('=');
    return split > 0 ? [pair.slice(0, split), path.resolve(pair.slice(split + 1))] : [pair, ''];
  })), values['--out'] && path.resolve(values['--out']))
  : command === 'verify' ? verifyChange(root, values['--plan'], values['--patch'])
  : command === 'apply' ? applyChange(root, values['--plan'], values['--patch'])
  : changeStatus(root, values['--plan']);
console.log(['start', 'finish'].includes(command) && !values.json ? line(result) : JSON.stringify(result));
process.exitCode = result.ok ? 0 : 3;
