#!/usr/bin/env node
import { configuredClaudeWorkspaceRoot } from '../lib/claude-workspace.mjs';
import { configuredCodexLedgerRoot } from '../lib/codex-ledger.mjs';
import { recordedPluginData } from '../lib/handoff/hook.mjs';
import { isHostOwnedAbsolutePath } from '../lib/host-paths.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  SOMESTOKEN_REPORT_SCHEMA_VERSION,
  TELEMETRY_PREFLIGHT_SCHEMA_VERSION,
  SOMESTOKEN_REPORT_MODES,
  readSomesTokenReport,
  reportRuntime,
} from '../lib/report-adapter.mjs';
import { TELEMETRY_OUTCOMES } from '../lib/telemetry-outcomes.mjs';
import { SOMESTOKEN_VERSION } from '../lib/version.mjs';
import { hashOpaqueHostIdentifier, safeOpaqueHostIdentifier } from '../lib/core.mjs';

const SERVER_NAME = 'SomesToken Local Reporting';
const SERVER_VERSION = SOMESTOKEN_VERSION;
const TOOL_NAME = 'get_somestoken_report';
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const UPDATING = -32603;
const MAX_REQUEST_BYTES = 256 * 1024;
// Codex does not forward hook-only PLUGIN_DATA/PLUGIN_ROOT values into its
// plugin-provided MCP process. Codex reports then use the data folder the hook
// recorded (plugin-data.json); no caller can supply a path.
const ENTRY = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(ENTRY), '..');

export const REPORT_TOOL = Object.freeze({
  name: TOOL_NAME,
  title: 'Get SomesToken Report',
  description: 'Read sanitized, bounded local usage, model/effort, quota, health, one-axis manual workflow candidates and optimization evidence for requested telemetry/optimization only. Read-only; no paths or host-control inputs. status exact/partial/unavailable; unavailable is missing data, not a tool error. Usage counts tokens; quota is shared account capacity; zero is observed.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: SOMESTOKEN_REPORT_MODES,
        description: 'task uses trusted caller metadata; current-turn usage is separate, provisional; unflushed data unavailable. diagnostics: collector health, local overhead and passive evidence, never process liveness or active-task identity. tasks includes bounded history and omission counts. Other modes are local history, not active identity.',
      },
      last: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 1,
        description: 'Maximum newest completed turns.',
      },
      task_key: {
        type: 'string',
        pattern: '^[a-f0-9]{20}$',
        description: 'Key from tasks for host-scoped task/task-forecast history only; never active-task identity or current-turn usage.',
      },
      hosts: {
        type: 'string',
        enum: ['current', 'all'],
        default: 'current',
        description: 'tasks/daily/consumption/summary only: all adds the other host\'s retained tasks, daily rows, quota windows/forecasts. Rows keep host; never selects a current task.',
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      somestoken_report_schema_version: { type: 'integer', const: SOMESTOKEN_REPORT_SCHEMA_VERSION },
      mode: { type: 'string', enum: SOMESTOKEN_REPORT_MODES },
      status: { type: 'string', enum: ['exact', 'partial', 'unavailable'] },
      source: { type: 'string', enum: ['plugin_data', 'public_snapshot', 'codex_ledger', 'workspace_snapshot', 'unavailable'] },
      telemetry_preflight: {
        type: 'object',
        properties: {
          telemetry_preflight_schema_version: { type: 'integer', const: TELEMETRY_PREFLIGHT_SCHEMA_VERSION },
          report_source: { type: 'string', enum: ['plugin_data', 'public_snapshot', 'codex_ledger', 'workspace_snapshot', 'unavailable'] },
          previous_receipt: { type: 'string', enum: ['available', 'unavailable'] },
          previous_receipt_created_at: { type: ['integer', 'null'], minimum: 0 },
          receipt_scope: { type: 'string', enum: ['local_history', 'current_task_completed_turns', 'unavailable'] },
          current_task_correlation: { type: 'string', enum: ['matched', 'unavailable'] },
          current_task_usage: { type: 'string', enum: ['exact', 'partial', 'unavailable'] },
          active_goal: { type: 'string', const: 'not_observed' },
          execution: { type: 'string', const: 'continue' },
          scope_policy: { type: 'string', const: 'exact_scope_only' },
          data_access: {
            type: 'string',
            enum: [
              'available', 'host_plugin_data_unavailable', 'plugin_data_unreadable',
              'public_snapshot_stale', 'public_snapshot_unavailable', 'public_snapshot_unreadable',
              'public_snapshot_host_mismatch',
            ],
          },
          usage: { type: 'string', enum: ['exact', 'partial', 'unavailable'] },
          telemetry_outcome: {
            type: 'string',
            enum: [...TELEMETRY_OUTCOMES, 'unavailable'],
          },
        },
        required: ['telemetry_preflight_schema_version', 'report_source', 'previous_receipt', 'previous_receipt_created_at', 'receipt_scope', 'current_task_correlation', 'current_task_usage', 'active_goal', 'execution', 'scope_policy', 'data_access', 'usage', 'telemetry_outcome'],
        additionalProperties: false,
      },
      report: { type: 'object' },
    },
    required: ['somestoken_report_schema_version', 'mode', 'status', 'source', 'telemetry_preflight', 'report'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

// Identifies the contract the host cached from tools/list at connect time.
const TOOL_DIGEST = createHash('sha256').update(JSON.stringify(REPORT_TOOL)).digest('hex');

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function callerTaskSession(message, expectedHost, kind = 'thread') {
  // Claude exposes no verified per-call task binding here. Never infer its
  // active session from the newest hook record or another host's metadata.
  if (expectedHost !== 'codex') return undefined;
  // Per-call host metadata, not model-supplied arguments or shared process
  // environment. Codex's MCP session_id is not its lifecycle thread_id.
  let metadata = message?.params?._meta?.['x-codex-turn-metadata'];
  if (typeof metadata === 'string') {
    if (Buffer.byteLength(metadata, 'utf8') > 64 * 1024) return undefined;
    try { metadata = JSON.parse(metadata); } catch { return undefined; }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || !safeOpaqueHostIdentifier(metadata.turn_id)) return undefined;
  if (!safeOpaqueHostIdentifier(metadata.thread_id)) return undefined;
  if(kind === 'workspace') return hashOpaqueHostIdentifier(metadata.thread_id, 'workspace:task');
  return kind === 'turn' ? hashOpaqueHostIdentifier(metadata.turn_id, 'ledger:turn') : hashOpaqueHostIdentifier(metadata.thread_id, 'codex');
}

export function handleRequest(message, env = process.env, options = {}) {
  const id = message?.id;
  if (message?.method === 'initialize') {
    return result(id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Usage only if requested now; pasted reports are complaint/debugging examples. Task deliverable first; no unsolicited usage/exports/preflight. Discover host-scoped tool once. task_key: retained history, never active identity. Preserve exact/partial/unavailable/unknown; never invent attribution/acceptance/savings. telemetry_preflight: internal collection readiness, non-blocking; continue exact task scope, no retries or model/effort changes. Calls use installed package; list_changed updates supported hosts\' tools; reconnect loads instructions/version.',
    });
  }
  if (message?.method === 'ping') return result(id, {});
  if (message?.method === 'tools/list') return result(id, { tools: [REPORT_TOOL] });
  if (message?.method === 'tools/call') {
    if (message.params?.name !== TOOL_NAME) return error(id, INVALID_PARAMS, 'Unknown SomesToken report tool.');
    try {
      const expectedHost = options.expectedHost ?? (reportRuntime(env) === 'claude' ? 'claude' : 'codex');
      // Local operator configuration is deliberately outside the distributed package.
      // It is read at request time; no model-supplied argument can select this root.
      let reportEnv = env;
      if (expectedHost === 'codex' && !env.SOMESTOKEN_CODEX_SESSION_ROOT) {
        const configurationRoot=options.pluginRoot ?? env.PLUGIN_ROOT ?? (env.PLUGIN_DATA ? null : PACKAGE_ROOT);
        const root=configuredCodexLedgerRoot(env,configurationRoot);
        if(root) reportEnv={...env,SOMESTOKEN_CODEX_SESSION_ROOT:root};
      }
      // Codex starts plugin MCP servers without PLUGIN_DATA; use the folder its hook recorded.
      const data=expectedHost==='codex'&&!isHostOwnedAbsolutePath(env.PLUGIN_DATA)?recordedPluginData(env,'codex'):null;
      if(data) reportEnv={...reportEnv,PLUGIN_DATA:data};
      if(expectedHost==='claude') {
        const root=configuredClaudeWorkspaceRoot(env);
        if(root)reportEnv={...env,SOMESTOKEN_CLAUDE_WORKSPACE_ROOT:root};
      }
      const report = readSomesTokenReport(reportEnv, message.params?.arguments ?? {}, {
        publicOnly: true,
        pluginRoot: options.pluginRoot ?? PACKAGE_ROOT,
        expectedHost,
        taskSession: callerTaskSession(message, expectedHost),
        taskTurn: callerTaskSession(message, expectedHost, 'turn'),
        workspaceTask: callerTaskSession(message, expectedHost, 'workspace'),
        reporterVersion: options.reporterVersion,
      });
      return result(id, {
        content: [{ type: 'text', text: JSON.stringify(report) }],
        structuredContent: report,
        isError: false,
      });
    } catch {
      return error(id, INVALID_PARAMS, 'Invalid SomesToken report request.');
    }
  }
  return id === undefined ? null : error(id, METHOD_NOT_FOUND, 'Method not found.');
}

// Hosts keep this process for the whole session while installs change what its
// entry path reaches: Claude reads the directory source in place and Codex
// relinks old version paths to the new install. Once the reachable package
// differs from the loaded one and has settled, a report runs in a short-lived
// process from that path, so updates reach open sessions without a reconnect.
// The child reports under the loaded server version: the host still holds the
// loaded instructions and server info. The tool list follows the installed
// contract for hosts that honor list_changed (Claude); for others the loaded
// contract stays, and the loaded code answers it.
const CALL_MARKER = 'somestoken-report-call'; // Call protocol: keep stable across releases.
const CALL_TIMEOUT_MS = 30_000;
const SETTLE_MS = 5_000;
const VERSION_ARGUMENT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/;

// Identity of the package reachable now, from metadata only: a Codex install
// changes the resolved root and every release rewrites lib/version.mjs. Files
// written in the last few seconds may belong to an install still in progress.
function packageStamp() {
  try {
    const root = path.resolve(path.dirname(fs.realpathSync(ENTRY)), '..');
    const files = ['lib/version.mjs', 'mcp/server.mjs'].map(file => fs.statSync(path.join(root, file)));
    const age = Date.now() - Math.max(...files.map(file => file.mtimeMs));
    return { id: JSON.stringify([root, ...files.map(file => [file.dev, file.ino, file.size, file.mtimeMs])]),
      // mtimeMs has sub-millisecond precision, so a just-written file can look a
      // fraction of a millisecond ahead of Date.now(); only a distant future
      // mtime is clock skew, which must not block updates forever.
      settled: Math.abs(age) >= SETTLE_MS };
  } catch { return null; }
}
const LOADED_STAMP = packageStamp()?.id;
const refused = new Set(), notified = new Set(), described = new Map();
let hostDigest = TOOL_DIGEST; // Contract of the tool list the host last received.

function installedProcess(args, input, env, { entry = ENTRY, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
  });
}
// Entries before this protocol ignore these arguments and may still answer, so the
// child must confirm its tool contract on stderr; stdout stays plain JSON.
const confirmed = (child, digest) => child.status === 0 && Boolean(child.stderr?.split('\n').includes(`${CALL_MARKER} ${digest}`));

/** Runs one report with the package installed at `entry`; exported as a test seam. */
export function installedCall(message, line, env, { digest = TOOL_DIGEST, ...options } = {}) {
  const child = installedProcess([`--call=${digest}`, `--loaded=${SERVER_VERSION}`], line, env, options);
  if (confirmed(child, digest)) {
    try {
      const response = JSON.parse(child.stdout);
      if (response?.jsonrpc === '2.0' && response.id === message.id) return { accepted: true, response };
    } catch { /* An incomplete reply is refused below. */ }
  }
  return { accepted: false, contractChanged: child.status === 3 };
}

// The installed package's tool definition, or null when it cannot describe one.
function installedTool(env) {
  const child = installedProcess(['--describe'], '', env);
  const digest = createHash('sha256').update(child.stdout ?? '').digest('hex');
  if (!confirmed(child, digest)) return null;
  try { return { tool: JSON.parse(child.stdout), digest }; } catch { return null; }
}

function toolList(env) {
  const stamp = packageStamp();
  let installed = null;
  if (stamp?.settled && stamp.id !== LOADED_STAMP) {
    if (!described.has(stamp.id)) described.set(stamp.id, installedTool(env));
    installed = described.get(stamp.id);
    // An installed contract whose report calls were refused cannot serve the host.
    if (installed && refused.has(`${stamp.id}|${installed.digest}`)) installed = null;
  }
  hostDigest = installed?.digest ?? TOOL_DIGEST;
  return installed?.tool ?? REPORT_TOOL;
}

// The installed code's reply, or null so the loaded code answers. The loaded code
// is valid only while the host holds the loaded contract; otherwise the host is
// told to refresh its tool list (once per install) and to retry.
function reportCall(message, line, env) {
  const stamp = packageStamp(), key = `${stamp?.id}|${hostDigest}`, loadedValid = hostDigest === TOOL_DIGEST;
  let contractChanged = false;
  if (stamp?.settled && stamp.id !== LOADED_STAMP && !refused.has(key)) {
    const result = installedCall(message, line, env, { digest: hostDigest });
    const stable = packageStamp()?.id === stamp.id; // Otherwise retry on the next report.
    // An error reply from the installed code (e.g. a half-applied install) falls
    // back when the loaded code can answer the host's contract.
    if (stable && result.accepted && (!result.response.error || !loadedValid)) return { response: result.response, notify: false };
    if (stable && !result.accepted) { refused.add(key); contractChanged = result.contractChanged; }
  }
  const notify = (contractChanged || !loadedValid) && !notified.has(key);
  if (notify) notified.add(key);
  return { response: loadedValid ? null : error(message?.id, UPDATING, 'SomesToken was updated; its tool list is refreshing. Retry the request.'), notify };
}

export async function runStdio(env = process.env, options = {}) {
  if(process.platform!=='darwin')process.title='SomesToken';
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const pending = Buffer.allocUnsafe(MAX_REQUEST_BYTES);
  let used = 0, oversized = false;
  const reply = () => {
    if (oversized) return JSON.stringify(error(null, -32600, 'SomesToken request exceeds size limit.')) + '\n';
    const line = pending.toString('utf8', 0, used);
    if (!line.trim()) return null;
    let message;
    try { message = JSON.parse(line); } catch { return null; }
    // Injected handler options are in-process test seams, not installed state.
    const live = options.pluginRoot === undefined && options.expectedHost === undefined;
    let response = null, notify = false;
    if (live && message?.method === 'tools/call') ({ response, notify } = reportCall(message, line, env));
    else if (live && message?.method === 'tools/list') response = result(message.id, { tools: [toolList(env)] });
    response ??= handleRequest(message, env, options);
    const lines = [response, notify && { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }].filter(Boolean);
    return lines.length ? lines.map(value => JSON.stringify(value) + '\n').join('') : null;
  };
  // A fixed byte buffer also bounds newline-free and fragmented UTF-8 input.
  // pipeline waits for a slow host to drain instead of queuing more reports.
  await pipeline(input, async function* (chunks) {
    for await (const raw of chunks) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (!oversized) {
          if (used + end - start > MAX_REQUEST_BYTES) oversized = true;
          else { chunk.copy(pending, used, start, end); used += end - start; }
        }
        if (newline < 0) break;
        const response = reply();
        used = 0; oversized = false;
        if (response) yield response;
        start = newline + 1;
      }
    }
    if (used || oversized) { const response = reply(); if (response) yield response; }
  }, output);
}

const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
let main = false;
// Hosts may launch through a linked path (relinked Codex versions, macOS /var);
// import.meta.url is always the resolved file.
try { main = fs.realpathSync(process.argv[1]) === ENTRY; } catch { /* Imported, not launched. */ }
if (main) {
  const call = argument('call');
  if (process.argv.includes('--describe')) {
    process.stdout.write(JSON.stringify(REPORT_TOOL));
    process.stderr.write(`${CALL_MARKER} ${TOOL_DIGEST}\n`);
  } else if (call === undefined) runStdio().catch(() => { process.exitCode = 1; });
  else if (call !== TOOL_DIGEST) process.exitCode = 3;
  else {
    // The parent already bounded this request to one line of at most MAX_REQUEST_BYTES.
    const loaded = argument('loaded');
    const response = handleRequest(JSON.parse(fs.readFileSync(0, 'utf8')), process.env,
      VERSION_ARGUMENT.test(loaded ?? '') ? { reporterVersion: loaded } : {});
    process.stdout.write(JSON.stringify(response)); // Drained before exit; a single writeSync can be partial on a pipe.
    process.stderr.write(`${CALL_MARKER} ${TOOL_DIGEST}\n`);
  }
}
