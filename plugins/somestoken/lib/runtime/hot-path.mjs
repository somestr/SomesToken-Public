// High-frequency hook path: state lock, hot context and the deferred-event journal, without the full runtime.
// Moved from lib/runtime.mjs unchanged; runtime.mjs re-exports what it exported.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireFileLock, releaseFileLock } from '../monitor-lock.mjs';
import { hashId, safeOpaqueHostIdentifier } from '../core.mjs';
import { appendHotEvent } from '../hot-events.mjs';
import { isHostOwnedAbsolutePath } from '../host-paths.mjs';
import { normalizeCodexHook } from '../hosts/codex.mjs';
import { normalizeClaudeHook } from '../hosts/claude-code.mjs';
import { readLiveAcceptanceContext } from '../efficiency/acceptance.mjs';

const STATE_FILE = 'state.json';

export const MAX_THREADS = 256;

export const MAX_HEALTH_COUNTER = 1_000_000;

export function timestamp() {
  return Date.now();
}

export function stateFile(stateDir) {
  return path.join(stateDir, STATE_FILE);
}

export const STATE_DIR_NAME = 'somestoken';

export const LOCK_FILE = 'state.lock';

const HOT_CONTEXT_FILE = 'hot-context.json';

export const HOT_CONTEXT_SCHEMA_VERSION = 1;

// Tool and permission hooks can fire at high frequency. Their state writes
// remain atomic and bounded, but do not fsync on every event; lifecycle and
// receipt boundaries remain durable so a crash can only lose a recent
// structural observation, never create a torn or falsely exact receipt.
export const NON_DURABLE_EVENTS = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'PostToolBatch', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
]);

// A long active turn can legitimately have no receipt boundary for several
// minutes. Refresh the already-sanitized public snapshot at most once per
// lease while safe high-frequency lifecycle activity continues. This is not a
// timer, token observation, or completion signal.
export const PUBLIC_BRIDGE_ACTIVE_REFRESH_MS = 60_000;

const LOCK_WAIT_MS = 15;

const LOCK_TIMEOUT_MS = 900;

// Multiple command-hook handlers can enter this module concurrently in one
// Node process (for example, a host adapter or the test runner). Queue those
// local calls before touching the filesystem lock so bounded durable events do
// not lose state merely because the event loop scheduled them together. The
// map contains only currently active state directories and is capped as a
// defensive memory bound; separate processes still use the fail-open timeout
// below.
const LOCAL_LOCK_TAIL_LIMIT = 128;

const LOCAL_LOCK_TAILS = new Map();

export const CLAUDE_FINAL_SNAPSHOT_INVALIDATING_EVENTS = new Set([
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'PreCompact', 'PostCompact',
  'StopFailure',
]);

export function runtimeHost(runtime) {
  return runtime === 'claude' ? 'claude' : 'codex';
}

export function safeLifecycleId(value) {
  return safeOpaqueHostIdentifier(value);
}

export function sourceIdentity(runtime, sessionId, kind, generation = 0, agentId = undefined, turnId = undefined) {
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(sessionId);
  if (!session) return null;
  const generationPart = Number.isSafeInteger(generation) && generation > 0 ? `:g${generation}` : ':g0';
  if (kind === 'main') return hashId(`${host}:main-source:${session}${generationPart}`);
  const agent = safeLifecycleId(agentId);
  const turn = safeLifecycleId(turnId);
  // Agent ids may be reused for later parent turns. Retain the host's safe
  // turn boundary with the agent identity so a new child source starts a new
  // cumulative counter ledger without ever depending on a transcript path.
  return agent && turn ? hashId(`${host}:subagent-source:${session}${generationPart}:${turn}:${agent}`) : null;
}

export function turnIdentity(runtime, sessionId, turnId, generation = 0, kind = 'main', sourceId = undefined) {
  // Host turn ids are stable only within a host session. Only safe lifecycle
  // identifiers (never transcript paths) participate in the bounded hash.
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(sessionId) ?? 'unknown-session';
  const turn = safeLifecycleId(turnId) ?? 'unknown-turn';
  const source = typeof sourceId === 'string' && /^[a-f0-9]{20}$/.test(sourceId) ? sourceId : 'unlinked-source';
  const generationPart = Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  return hashId(`${host}:${kind}:turn:${session}:g${generationPart}:${source}:${turn}`);
}

export function scopeIdentity(runtime, sessionId, turnId, generation = 0) {
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(sessionId);
  const turn = safeLifecycleId(turnId);
  if (!session || !turn) return null;
  const generationPart = Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  return hashId(`${host}:main-scope:${session}:g${generationPart}:${turn}`);
}

export function fallbackScopeIdentity(runtime, sessionId, generation = 0) {
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(sessionId);
  if (!session) return null;
  const generationPart = Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  return hashId(`${host}:session-scope:${session}:g${generationPart}`);
}

export function lifecycleTurnIdentity(runtime, sessionId, turnId) {
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(sessionId);
  const turn = safeLifecycleId(turnId);
  return session && turn ? hashId(`${host}:lifecycle-turn:${session}:${turn}`) : null;
}

export function capabilityFields(input, normalized) {
  const fields = [];
  if (normalized?.scope_id) fields.push('scope_id');
  if (typeof input?.session_id === 'string' && input.session_id.length > 0) fields.push('session_id');
  if (typeof input?.tool_name === 'string' && normalized?.tool_name) fields.push('tool_name');
  if (normalized?.agent_id) fields.push('agent_id');
  if (normalized?.agent_type) fields.push('agent_type');
  if (normalized?.source_id) fields.push('source_id');
  if (normalized?.tool_use_id) fields.push('tool_use_id');
  if (normalized?.stop_hook_active !== undefined) fields.push('stop_hook_active');
  if (normalized?.final !== undefined) fields.push('final');
  if (normalized?.error_category) fields.push('error_category');
  if (normalized?.structural_progress !== undefined) fields.push('structural_progress');
  if (normalized?.pending_age_ms !== undefined) fields.push('pending_age_ms');
  if (normalized?.unresolved_source_count !== undefined) fields.push('unresolved_source_count');
  if (normalized?.child_count !== undefined) fields.push('child_count');
  if (normalized?.usage_outlier !== undefined) fields.push('usage_outlier');
  if (normalized?.usage_pressure_percent !== undefined) fields.push('usage_pressure_percent');
  if (normalized?.total_tokens !== undefined) fields.push('total_tokens');
  if (normalized?.total_duration_ms !== undefined) fields.push('total_duration_ms');
  if (normalized?.total_tool_use_count !== undefined) fields.push('total_tool_use_count');
  if (normalized?.resolved_model) fields.push('resolved_model');
  if (normalized?.background === true) fields.push('background');
  if (normalized?.scheduled === true) fields.push('scheduled');
  if (normalized?.recurring === true) fields.push('recurring');
  if (input?.trigger === 'manual' || input?.trigger === 'auto') fields.push('trigger');
  return [...new Set(fields)].slice(0, 32);
}

export function hotContextFile(stateDir) {
  return path.join(stateDir, HOT_CONTEXT_FILE);
}

export function stateFingerprint(stateDir) {
  try {
    const stat = fs.lstatSync(stateFile(stateDir));
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0) return null;
    return { size: stat.size, mtime_ms: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
}

function readHotContext(stateDir, runtime) {
  const target = hotContextFile(stateDir);
  let fd;
  try {
    const link = fs.lstatSync(target);
    if (!link.isFile() || link.isSymbolicLink() || link.size < 0 || link.size > 64 * 1024) return null;
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > 64 * 1024) return null;
    const buffer = Buffer.alloc(stat.size);
    if (stat.size > 0) fs.readSync(fd, buffer, 0, stat.size, 0);
    const value = JSON.parse(buffer.toString('utf8'));
    const expectedRuntime = runtime === 'claude' ? 'claude' : 'codex';
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.hot_context_schema_version !== HOT_CONTEXT_SCHEMA_VERSION
      || value.runtime !== expectedRuntime
      || !Number.isSafeInteger(value.state_size) || value.state_size < 0
      || !Number.isSafeInteger(value.state_mtime_ms) || value.state_mtime_ms < 0
      || !Number.isSafeInteger(value.last_public_bridge_attempt) || value.last_public_bridge_attempt < 0
      || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) return null;
    const fingerprint = stateFingerprint(stateDir);
    if (!fingerprint || fingerprint.size !== value.state_size || fingerprint.mtime_ms !== value.state_mtime_ms) return null;
    const sessions = Object.fromEntries(Object.entries(value.sessions)
      .filter(([session, entry]) => /^[a-f0-9]{20}$/.test(session)
        && entry && typeof entry === 'object' && !Array.isArray(entry)
        && Number.isSafeInteger(entry.generation) && entry.generation >= 0)
      .slice(-MAX_THREADS)
      .map(([session, entry]) => [session, { generation: Math.min(entry.generation, MAX_HEALTH_COUNTER) }]));
    return {
      last_public_bridge_attempt: value.last_public_bridge_attempt,
      sessions,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
}

function hotContextBridgeRefreshDue(context) {
  const last = context?.last_public_bridge_attempt;
  return !Number.isSafeInteger(last) || last <= 0 || timestamp() - last >= PUBLIC_BRIDGE_ACTIVE_REFRESH_MS;
}

function deferredClaudeFinalInvalidation(input, eventName, generation) {
  if (!CLAUDE_FINAL_SNAPSHOT_INVALIDATING_EVENTS.has(eventName)) return null;
  const session = safeLifecycleId(input?.session_id);
  const suppliedTurn = safeOpaqueHostIdentifier(input?.turn_id);
  const sourceId = sourceIdentity('claude', input?.session_id, 'main', generation);
  if (!session || !suppliedTurn || !sourceId) return { clear_session: true };
  const turnId = turnIdentity('claude', input?.session_id, suppliedTurn, generation, 'main', sourceId);
  const lifecycleTurnId = lifecycleTurnIdentity('claude', input?.session_id, suppliedTurn);
  return {
    clear_session: false,
    ...(turnId ? { turn_id: turnId } : {}),
    ...(lifecycleTurnId ? { lifecycle_turn_id: lifecycleTurnId } : {}),
  };
}

function deferredHotEvent(input, normalized, runtime, acceptance, context) {
  const session = normalized?.session;
  const generation = session && context?.sessions?.[session]?.generation;
  if (!session || !Number.isSafeInteger(generation) || generation < 0 || !safeLifecycleId(input?.session_id)) return null;
  const scopeId = scopeIdentity(runtime, input?.session_id, input?.turn_id, generation)
    ?? fallbackScopeIdentity(runtime, input?.session_id, generation);
  if (!scopeId) return null;
  const hostVersion = typeof input?.host_version === 'string' && /^[A-Za-z0-9._:+-]{1,40}$/.test(input.host_version)
    ? input.host_version
    : undefined;
  return {
    event: normalized,
    session,
    scope_id: scopeId,
    session_generation: generation,
    fields: capabilityFields(input, normalized),
    acceptance: { enabled: acceptance?.enabled === true, scenario: acceptance?.scenario ?? 'extended-events' },
    ...(hostVersion ? { host_version: hostVersion } : {}),
    ...(normalized?.turn_id ? { turn_id: normalized.turn_id } : {}),
    ...(runtime === 'claude'
      ? { claude_final_invalidation: deferredClaudeFinalInvalidation(input, normalized.event_type, generation) }
      : {}),
  };
}

export function safeStateDirectory(stateDir) {
  try {
    const stat = fs.lstatSync(stateDir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function ensureStateDirectory(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!safeStateDirectory(stateDir)) throw new Error('state-directory-invalid');
  const stat = fs.lstatSync(stateDir);
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(stateDir, 0o700);
}

// The state lock uses the shared store-lock protocol. Any acquisition error
// counts as busy, so callers keep the bounded wait and the timeout accounting.
export const tryFileLock = (lock) => { try { return acquireFileLock(lock); } catch { return null; } };

async function withFileLock(stateDir, operation) {
  const lock = path.join(stateDir, LOCK_FILE);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held;
  while (Date.now() < deadline) {
    held = tryFileLock(lock);
    if (held) break;
    await delay(LOCK_WAIT_MS);
  }
  if (!held) throw new Error('state-lock-timeout');
  try { return await operation(); }
  finally { releaseFileLock(lock, held); }
}

export async function withLock(stateDir, operation) {
  ensureStateDirectory(stateDir);
  const prior = LOCAL_LOCK_TAILS.get(stateDir);
  if (!prior && LOCAL_LOCK_TAILS.size >= LOCAL_LOCK_TAIL_LIMIT) {
    // Do not grow an in-process queue without bound. This path retains the
    // original cross-process lock and fail-open timeout semantics.
    return withFileLock(stateDir, operation);
  }
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  LOCAL_LOCK_TAILS.set(stateDir, current);
  try {
    if (prior) await prior;
    return await withFileLock(stateDir, operation);
  } finally {
    release();
    if (LOCAL_LOCK_TAILS.get(stateDir) === current) LOCAL_LOCK_TAILS.delete(stateDir);
  }
}

export function hookEnvironment(env = {}, runtime = 'codex') {
  if (runtime !== 'claude') return env;
  // Claude owns its plugin-data namespace. A generic PLUGIN_DATA inherited
  // from another host/plugin must not shadow the host-provided value.
  const dataRoot = isHostOwnedAbsolutePath(env.CLAUDE_PLUGIN_DATA)
    ? env.CLAUDE_PLUGIN_DATA
    : isHostOwnedAbsolutePath(env.PLUGIN_DATA) ? env.PLUGIN_DATA : '';
  const pluginRoot = isHostOwnedAbsolutePath(env.CLAUDE_PLUGIN_ROOT)
    ? env.CLAUDE_PLUGIN_ROOT
    : isHostOwnedAbsolutePath(env.PLUGIN_ROOT) ? env.PLUGIN_ROOT : '';
  return { ...env, PLUGIN_DATA: dataRoot, PLUGIN_ROOT: pluginRoot };
}

export async function deferHighFrequencyEvent(stateDir, input, normalized, eventName, runtime, acceptance) {
  return withLock(stateDir, async () => {
    const context = readHotContext(stateDir, runtime);
    // A missing/stale context or an expired public-bridge lease intentionally
    // falls back to the durable path. That is slower but preserves recovery,
    // session-generation, and public-report correctness without guessing.
    if (!context || hotContextBridgeRefreshDue(context)) return false;
    const record = deferredHotEvent(input, normalized, runtime, acceptance, context);
    if (!record || record.event.event_type !== eventName) return false;
    return appendHotEvent(stateDir, record).appended === true;
  });
}

// First step of every hook. A high-frequency event goes to the hot journal
// without loading the full runtime: 'handled' (recorded), 'ignored' (nothing
// to record), 'lock_timeout' (state lock stayed busy) or 'durable' (the full
// runtime must handle it, as for lifecycle events).
export async function deferHookEvent(input, eventName, env = process.env) {
  const name = eventName || input?.hook_event_name;
  if (!NON_DURABLE_EVENTS.has(name)) return 'durable';
  const runtime = env.SOMESTOKEN_RUNTIME === 'claude' ? 'claude' : 'codex';
  const hookEnv = hookEnvironment(env, runtime);
  const normalized = runtime === 'claude'
    ? normalizeClaudeHook({ ...(input ?? {}), hook_event_name: name })
    : normalizeCodexHook({ ...(input ?? {}), hook_event_name: name });
  if (!normalized) return 'ignored';
  const acceptance = readLiveAcceptanceContext(hookEnv, runtime);
  const dataRoot = isHostOwnedAbsolutePath(hookEnv.PLUGIN_DATA) ? hookEnv.PLUGIN_DATA : null;
  if (!dataRoot) return 'ignored';
  try {
    return await deferHighFrequencyEvent(path.join(dataRoot, STATE_DIR_NAME), input ?? {}, normalized, name, runtime, acceptance) ? 'handled' : 'durable';
  } catch (error) {
    return error?.message === 'state-lock-timeout' ? 'lock_timeout' : 'ignored';
  }
}
