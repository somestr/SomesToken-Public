import { hashOpaqueHostIdentifier, hashId, safeModel } from '../core.mjs';
import { spawn } from 'node:child_process';

import {
  normalizeGoalState,
  normalizeRateLimitSnapshot,
  normalizeRateLimitSnapshots,
  normalizeRateLimitUpdate,
  normalizeTurnLimitFailure,
  normalizeThreadRuntimeState,
} from '../hosts/codex-app-server.mjs';
import { SOMESTOKEN_VERSION } from '../version.mjs';

const MAX_LINE_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 32;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const REQUEST_METHODS = new Set([
  'initialize',
  'account/rateLimits/read',
  'account/read',
  'thread/goal/get',
  'thread/read',
  'thread/resume',
  'turn/start',
]);
const NOTIFICATION_METHODS = new Set([
  'account/rateLimits/updated',
  'thread/status/changed',
  'turn/completed',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/archived',
  'thread/deleted',
  'thread/closed',
  'turn/started',
  'thread/started',
]);
const TARGET_LIFECYCLE_METHODS = new Set([
  'thread/status/changed',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/archived',
  'thread/deleted',
  'thread/closed',
  'turn/started',
  'thread/started',
]);

// This is deliberately fixed and content-free. The managed companion can
// request one continuation without accepting a prompt or goal description.
export const CONTINUATION_INPUT = 'Continue the active goal from the latest verified state after the Codex usage-limit reset. Re-check current state before changing anything, do not repeat completed work, and stop if user input or approval is required.';

function boundedTimeout(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS ? value : DEFAULT_TIMEOUT_MS;
}

function transportError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeMethod(value) {
  return NOTIFICATION_METHODS.has(value) ? value : 'unknown';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function notificationThreadId(params) {
  const source = object(params);
  const thread = object(source.thread);
  const turn = object(source.turn);
  const candidates = [source.threadId, source.thread_id, thread.id, turn.threadId, turn.thread_id];
  return candidates.find((value) => typeof value === 'string' && value.length > 0 && value.length <= 512) ?? null;
}

function safeNotification(message, previousRateLimit = null, targetThreadId = null) {
  const method = safeMethod(message?.method);
  if (!NOTIFICATION_METHODS.has(method)) return { method, params_present: Boolean(message?.params) };
  if (method === 'account/rateLimits/updated') {
    const normalized = normalizeRateLimitUpdate(message?.params, previousRateLimit, { now: Math.floor(Date.now() / 1000) });
    return {
      method,
      params_present: true,
      normalized: normalized.quality === 'unavailable' ? { quality: 'unavailable' } : {
        quality: normalized.quality,
        used_percent: normalized.primary?.used_percent ?? null,
        remaining_percent: normalized.primary?.remaining_percent ?? null,
        resets_at: normalized.primary?.resets_at ?? null,
        ...(normalized.rate_limit_reached_type ? { rate_limit_reached_type: normalized.rate_limit_reached_type } : {}),
      },
    };
  }
  const target = typeof targetThreadId === 'string'
    ? notificationThreadId(message?.params) === targetThreadId
    : false;
  if (method === 'thread/status/changed') {
    const normalized = normalizeThreadRuntimeState(message?.params);
    return {
      method,
      target,
      state: normalized.state,
      waiting_on_approval: normalized.waiting_on_approval,
      ...(normalized.waiting_on_user_input === true ? { waiting_on_user_input: true } : {}),
    };
  }
  if (method === 'thread/goal/updated') {
    return { method, target, goal_state: normalizeGoalState(message?.params).state };
  }
  if (TARGET_LIFECYCLE_METHODS.has(method)) return { method, target };
  const failure = normalizeTurnLimitFailure(message?.params);
  return {
    method,
    target,
    params_present: Boolean(message?.params),
    failed: failure.failed,
    category: failure.category,
  };
}

function safeArgs(value) {
  if (!Array.isArray(value) || value.length > 32) return [];
  return value.every((entry) => typeof entry === 'string' && entry.length <= 64 * 1024) ? [...value] : [];
}

/**
 * Create a bounded JSON-RPC transport for an App Server process owned by the
 * caller. The child is never discovered or attached implicitly; close() only
 * terminates the process created by this instance.
 */
export function createCodexAppServerTransport(options = {}) {
  const command = typeof options.command === 'string' && options.command.length > 0 ? options.command : 'codex';
  const args = safeArgs(options.args);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const onNotification = typeof options.onNotification === 'function' ? options.onNotification : null;
  const targetThreadId = typeof options.targetThreadId === 'string' && options.targetThreadId.length > 0
    ? options.targetThreadId : null;
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  let initialized = false;
  let initializing = null;
  let closed = false;
  let intentionallyClosed = false;
  const lineBuffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
  let used = 0, oversized = false;
  let lastRateLimitSnapshot = null;
  const stats = {
    initialize_count: 0,
    requests: 0,
    responses: 0,
    notifications: 0,
    malformed_lines: 0,
    oversized_lines: 0,
    timeouts: 0,
    eof: 0,
    pending_requests: 0,
  };

  const updatePendingCount = () => { stats.pending_requests = pending.size; };

  const failPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    updatePendingCount();
  };

  const handleMessage = (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      updatePendingCount();
      stats.responses += 1;
      if (message.error && typeof message.error === 'object') {
        entry.reject(transportError('protocol_error'));
      } else {
        entry.resolve(message.result ?? null);
      }
      return;
    }
    if (typeof message.method === 'string') {
      stats.notifications += 1;
      const safe = safeNotification(message, lastRateLimitSnapshot, targetThreadId);
      if (message.method === 'account/rateLimits/updated') {
        const normalized = normalizeRateLimitUpdate(message?.params, lastRateLimitSnapshot, { now: Math.floor(Date.now() / 1000) });
        if (normalized.quality !== 'unavailable') lastRateLimitSnapshot = normalized;
      }
      if (onNotification) {
        try { onNotification(safe); } catch { /* observer failures cannot affect the host */ }
      }
    }
  };

  const consumeOutput = (chunk) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Match the MCP byte bound: discard an oversized frame through its newline.
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (!oversized) {
        if (used + end - start > MAX_LINE_BYTES) { oversized = true; stats.oversized_lines += 1; }
        else { bytes.copy(lineBuffer, used, start, end); used += end - start; }
      }
      if (newline < 0) break;
      if (!oversized) {
        try { handleMessage(JSON.parse(lineBuffer.toString('utf8', 0, used))); }
        catch { stats.malformed_lines += 1; }
      }
      used = 0; oversized = false;
      start = newline + 1;
    }
  };

  child.stdout?.on('data', consumeOutput);
  child.once('error', () => {
    if (!closed) {
      closed = true;
      failPending(transportError('transport_error'));
    }
  });
  child.once('close', () => {
    if (!closed) {
      stats.eof += 1;
      closed = true;
      failPending(transportError(intentionallyClosed ? 'transport_closed' : 'transport_eof'));
    }
  });

  function writeMessage(message) {
    if (closed || !child.stdin?.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function request(method, params = {}, requestOptions = {}) {
    if (!REQUEST_METHODS.has(method)) return Promise.reject(transportError('unsupported_method'));
    if (closed) return Promise.reject(transportError('transport_closed'));
    if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(transportError('pending_limit'));
    const id = nextId;
    nextId += 1;
    const mutation = requestOptions.mutation === true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        updatePendingCount();
        stats.timeouts += 1;
        reject(transportError(mutation ? 'uncertain_mutation' : 'request_timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      stats.requests += 1;
      if (!writeMessage({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        pending.delete(id);
        updatePendingCount();
        reject(transportError('transport_write_failed'));
      }
    });
  }

  async function initialize() {
    if (initialized) return { initialized: true };
    if (initializing) return initializing;
    initializing = (async () => {
      stats.initialize_count += 1;
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'somestoken', version: SOMESTOKEN_VERSION },
      });
      if (!writeMessage({ jsonrpc: '2.0', method: 'initialized', params: {} })) throw transportError('transport_write_failed');
      initialized = true;
      return { initialized: true };
    })();
    try { return await initializing; } finally { initializing = null; }
  }

  async function readyRequest(method, params = {}, requestOptions = {}) {
    await initialize();
    return request(method, params, requestOptions);
  }

  return {
    request,
    initialize,
    readQuotaInventory: async () => {
      const [limits, identity] = await Promise.allSettled([
        readyRequest('account/rateLimits/read', {}), readyRequest('account/read', {})]);
      if(limits.status !== 'fulfilled') throw limits.reason;
      const account=identity.status==='fulfilled'?identity.value?.account:null;
      const snapshots=normalizeRateLimitSnapshots(limits.value);
      const plan=account?.planType ?? limits.value?.rateLimits?.planType;
      const directKey=hashOpaqueHostIdentifier(account?.id,'quota:account');
      const loginKey=typeof account?.email==='string' && account.email.length<=320
        ? hashId('quota-login:'+account.type+':'+account.email.toLowerCase()) : null;
      return {snapshots,account_key:directKey??loginKey,identity_basis:directKey?'host_account_id':loginKey?'host_login_fingerprint':'unavailable',
        plan_id:typeof plan==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(plan)&&safeModel(plan)?plan:null};
    },
    readRateLimits: async () => {
      const raw = await readyRequest('account/rateLimits/read', {});
      const normalized = normalizeRateLimitSnapshot(raw, { now: Math.floor(Date.now() / 1000) });
      if (normalized.quality !== 'unavailable') lastRateLimitSnapshot = normalized;
      return raw;
    },
    readGoal: (threadId) => readyRequest('thread/goal/get', { threadId }),
    readThread: (threadId) => readyRequest('thread/read', { threadId, includeTurns: false }),
    resumeThread: (threadId) => readyRequest('thread/resume', { threadId }, { mutation: true }),
    startTurn: (threadId) => readyRequest('turn/start', {
      threadId,
      input: [{ type: 'text', text: CONTINUATION_INPUT }],
    }, { mutation: true }),
    diagnostics: () => ({ ...stats, pending_requests: pending.size }),
    close: async () => {
      if (closed) return;
      intentionallyClosed = true;
      closed = true;
      failPending(transportError('transport_closed'));
      try { child.stdin?.end(); } catch { /* fail open */ }
      if (!child.killed) child.kill();
    },
  };
}

export const CODEX_APP_SERVER_TRANSPORT_LIMITS = Object.freeze({
  max_line_bytes: MAX_LINE_BYTES,
  max_pending_requests: MAX_PENDING_REQUESTS,
  max_timeout_ms: MAX_TIMEOUT_MS,
});
