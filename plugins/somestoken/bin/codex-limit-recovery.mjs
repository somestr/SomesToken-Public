#!/usr/bin/env node
import {humanLabel} from '../lib/core.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkpointLimitRecoveryState, mutateLimitRecoveryState } from '../lib/runtime.mjs';
import { readSomesTokenReport } from '../lib/report-adapter.mjs';
import { codexAppServerCapabilities, codexAppServerCompatible } from '../lib/hosts/codex-app-server.mjs';
import { createCodexAppServerTransport } from '../lib/limit-recovery/transport.mjs';
import { createLimitRecoveryEventChannel, runLimitRecoveryController } from '../lib/limit-recovery/controller.mjs';
import { transitionLimitRecovery } from '../lib/limit-recovery/state.mjs';
import { readSomesTokenConfig } from '../lib/usage/config.mjs';

const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const SCHEMA_TIMEOUT_MS = 10_000;
const SCHEMA_MAX_BYTES = 4 * 1024 * 1024;
const COMMANDS = new Set(['observe', 'run', 'status', 'cancel']);

export function parseLimitRecoveryArgs(argv = []) {
  if (!Array.isArray(argv) || argv.length === 0 || !COMMANDS.has(argv[0])) return { ok: false, error: 'invalid_limit_recovery_command' };
  const command = argv[0];
  let json = false;
  let explicitOptIn = false;
  let mode;
  let maxWaitMs;
  for (const argument of argv.slice(1)) {
    if (argument === '--json' && !json) { json = true; continue; }
    if (command === 'run' && argument === '--explicit-opt-in' && !explicitOptIn) { explicitOptIn = true; continue; }
    if (command === 'run' && typeof argument === 'string' && argument.startsWith('--mode=') && mode === undefined) {
      mode = argument.slice('--mode='.length);
      continue;
    }
    if (command === 'run' && typeof argument === 'string' && /^--max-wait-ms=\d+$/.test(argument) && maxWaitMs === undefined) {
      maxWaitMs = Number(argument.slice('--max-wait-ms='.length));
      if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > MAX_WAIT_MS) return { ok: false, error: 'invalid_max_wait_ms' };
      continue;
    }
    return { ok: false, error: 'invalid_limit_recovery_argument' };
  }
  if (command !== 'run' && (explicitOptIn || mode !== undefined || maxWaitMs !== undefined)) return { ok: false, error: 'invalid_limit_recovery_argument' };
  if (command === 'run' && (mode !== 'managed_companion' || explicitOptIn !== true)) return { ok: false, error: 'explicit_managed_opt_in_required' };
  return { ok: true, command, json, explicit_opt_in: explicitOptIn, mode: mode ?? 'disabled', max_wait_ms: maxWaitMs };
}

function output(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${value}\n`);
}

function codexRuntimeEnv(env = {}) {
  return { ...env, SOMESTOKEN_RUNTIME: 'codex' };
}

function unavailableReport(env, mode) {
  const report = readSomesTokenReport(codexRuntimeEnv(env), { mode: 'limit-recovery', last: 1 });
  return { command: mode, status: report.status, report: report.report, source: report.source };
}

function safeCommand(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,80}$/.test(value) ? value : 'codex';
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function schemaText(root, limit = SCHEMA_MAX_BYTES) {
  const pending = [root];
  const pieces = [];
  let remaining = limit;
  let visited = 0;
  while (pending.length && remaining > 0 && visited < 512) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(target);
          const bytes = Math.min(remaining, Math.max(0, stat.size));
          if (bytes > 0) {
            const fd = fs.openSync(target, 'r');
            try {
              const buffer = Buffer.allocUnsafe(bytes);
              const read = fs.readSync(fd, buffer, 0, bytes, 0);
              pieces.push(buffer.subarray(0, read).toString('utf8'));
              remaining -= read;
            } finally { fs.closeSync(fd); }
          }
        } catch { /* capability check fails below if required text is absent */ }
      }
      if (remaining <= 0 || visited >= 512) break;
    }
  }
  return pieces.join('\n');
}

/**
 * Check the local official App Server schema before a managed run. Temporary
 * schema output is bounded and removed immediately; it never enters plugin
 * state, reports, artifacts, or logs.
 */
export function generatedAppServerCapabilities(command = 'codex') {
  const schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'somestoken-appserver-schema-'));
  try {
    const generated = spawnSync(safeCommand(command), ['app-server', 'generate-json-schema', '--out', schemaRoot], {
      encoding: 'utf8', stdio: 'ignore', timeout: SCHEMA_TIMEOUT_MS,
    });
    if (generated.error || generated.status !== 0) return { compatible: false, capabilities: {} };
    const schema = schemaText(schemaRoot);
    const capabilities = codexAppServerCapabilities(schema);
    return { compatible: codexAppServerCompatible(schema), capabilities };
  } catch {
    return { compatible: false, capabilities: {} };
  } finally {
    try { fs.rmSync(schemaRoot, { recursive: true, force: true, maxRetries: 0 }); } catch { /* fail closed */ }
  }
}

/**
 * Wait for the actual reset/grace wall-clock boundary. A clear update is only
 * evidence; it cannot make the wait finish before the grace has elapsed. The
 * controller then performs the authoritative fresh read before mutation.
 */
export function boundedResetWait({ resets_at, reset_grace_ms = 0, deadline, signal, onClear } = {}) {
  const resetAt = Number.isSafeInteger(resets_at) && resets_at >= 0 ? resets_at : null;
  const deadlineAt = Number.isSafeInteger(deadline) && deadline >= 0 ? deadline : null;
  const graceMs = Number.isSafeInteger(reset_grace_ms) && reset_grace_ms >= 0 && reset_grace_ms <= 5 * 60 * 1000 ? reset_grace_ms : 0;
  if (resetAt === null || deadlineAt === null) return Promise.resolve({ timeout: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = null;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsubscribe?.(); } catch { /* no-op */ }
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      finish(undefined, error);
    };
    const readyAtMs = (resetAt * 1000) + graceMs;
    const deadlineMs = deadlineAt * 1000;
    const delayMs = Math.max(0, Math.min(readyAtMs, deadlineMs) - Date.now());
    const timer = setTimeout(() => {
      const nowMs = Date.now();
      finish(nowMs >= deadlineMs ? { timeout: true } : { now: Math.floor(nowMs / 1000) });
    }, delayMs);
    if (typeof onClear === 'function') {
      unsubscribe = onClear(() => {
        // Do not finish early. The timer is the one bounded completion path.
      });
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function boundedUsageLimitWait(waitForUsageLimit, { deadline, signal } = {}) {
  const deadlineMs = Number.isSafeInteger(deadline) ? deadline * 1000 : Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish({ timeout: true }), Math.max(0, deadlineMs - Date.now()));
    Promise.resolve(waitForUsageLimit({ signal, deadline })).then((value) => finish(value), (error) => finish(undefined, error));
  });
}

function replaceState(target, next) {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, next);
}

function defaultOwnership() {
  // CODEX_THREAD_ID is intentionally not considered here. It is not an
  // official ownership proof and could point at a Desktop-controlled task.
  return { verified: false, thread_id: null };
}

function configuredRecovery(env, parsed) {
  const configured = readSomesTokenConfig(env).config?.codex_limit_recovery ?? {};
  return {
    ...configured,
    mode: parsed.mode,
    max_wait_ms: parsed.max_wait_ms ?? configured.max_wait_ms ?? 6 * 60 * 60 * 1000,
    reset_grace_ms: configured.reset_grace_ms ?? 30_000,
    max_resume_attempts: 1,
    require_active_goal: true,
  };
}

function statePersister(runtimeEnv, provided) {
  if (typeof provided === 'function') return provided;
  let operationId = null;
  let generation = null;
  return async (next) => {
    const expected = operationId === null ? {} : { operation_id: operationId, operation_generation: generation };
    const result = await checkpointLimitRecoveryState(runtimeEnv, next, expected);
    if (result?.ok === true && operationId === null) {
      operationId = next.operation_id;
      generation = next.operation_generation;
    }
    return result;
  };
}

/**
 * Injectable command core used by protocol tests. Production supplies no
 * ownership proof, so it safely reports unavailable before launching a child.
 */
export async function runLimitRecoveryCommand(parsed, env = process.env, dependencies = {}) {
  const runtimeEnv = codexRuntimeEnv(env);
  const ownership = dependencies.ownership ?? defaultOwnership();
  const threadId = ownership?.verified === true && typeof ownership.thread_id === 'string' && ownership.thread_id.length > 0
    ? ownership.thread_id : null;
  if (!threadId) {
    return { command: 'run', status: 'unavailable', outcome: 'ownership_unavailable', reason_codes: ['ownership_unavailable'] };
  }
  const schema = dependencies.schemaCapabilities ?? generatedAppServerCapabilities(safeCommand(env.CODEX_APP_SERVER_COMMAND));
  if (schema?.compatible !== true) {
    return { command: 'run', status: 'unavailable', outcome: 'schema_version_incompatible', reason_codes: ['protocol_mismatch'] };
  }
  const config = configuredRecovery(env, parsed);
  const abortController = new AbortController();
  const events = createLimitRecoveryEventChannel();
  const createTransport = dependencies.createTransport ?? createCodexAppServerTransport;
  const transport = createTransport({
    command: safeCommand(env.CODEX_APP_SERVER_COMMAND),
    args: ['app-server'],
    timeoutMs: 10_000,
    targetThreadId: threadId,
    onNotification: (notification) => {
      events.observe(notification);
      if (events.cancellationReason()) abortController.abort();
    },
  });
  const onSignal = () => {
    abortController.abort();
    void transport.close?.();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const now = typeof dependencies.now === 'function' ? dependencies.now : nowSeconds;
    const result = await runLimitRecoveryController({
      transport,
      config,
      thread_id: threadId,
      ownership_verified: true,
      explicit_opt_in: parsed.explicit_opt_in,
      signal: abortController.signal,
      now,
      getCancellationReason: events.cancellationReason,
      markOwnTurnStart: events.markOwnTurnStart,
      persistState: statePersister(runtimeEnv, dependencies.persistState),
      waitForUsageLimit: dependencies.waitForUsageLimit ?? ((args) => boundedUsageLimitWait(events.waitForUsageLimit, args)),
      waitForReset: dependencies.waitForReset ?? ((args) => boundedResetWait({ ...args, onClear: events.onClear })),
    });
    return { command: 'run', status: result.ok ? 'exact' : 'partial', outcome: result.outcome, state: result.state, reason_codes: result.reason_codes };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    abortController.abort();
    await transport.close?.();
  }
}

async function runCommand(parsed, env) {
  return runLimitRecoveryCommand(parsed, env);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if(argv.includes('--help')) {output('SomesToken limit recovery · observe|status|cancel [--json] or run --mode=managed_companion --explicit-opt-in [--max-wait-ms=1..86400000] [--json]. Time bounds are milliseconds; run requires explicit opt-in.',false);return 0;}
  const parsed = parseLimitRecoveryArgs(argv);
  if (!parsed.ok) {
    const value = { command: 'invalid', status: 'invalid_request', error: parsed.error };
    output(argv.includes('--json')?value:`SomesToken limit recovery · invalid request · ${humanLabel(parsed.error)} · Next: use --help for supported options.`, argv.includes('--json'));
    return 2;
  }
  let value;
  if (parsed.command === 'run') value = await runCommand(parsed, env);
  else if (parsed.command === 'cancel') {
    const result = await mutateLimitRecoveryState(codexRuntimeEnv(env), (state) => {
      const next = transitionLimitRecovery(state, { type: 'cancel', reason: 'controller_conflict' });
      replaceState(state, next);
      return { command: 'cancel', status: 'exact', outcome: 'canceled', state: next };
    });
    value = result?.command ? result : { command: 'cancel', status: 'unavailable', outcome: 'state_unavailable' };
  } else value = unavailableReport(env, parsed.command);
  if (parsed.json) output(value, true);
  else output(`SomesToken limit recovery · ${humanLabel(value.status ?? 'unavailable')} · ${humanLabel(value.outcome ?? value.report?.state ?? 'unavailable')}${value.status==='exact'?'':' · Next: check SomesToken diagnostics and the explicit opt-in options in --help.'}`, false);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 0; });
}
