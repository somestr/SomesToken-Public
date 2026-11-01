// Opt-in Claude prompt-cache keep-alive. hooks/cache-keepalive.mjs runs as an asyncRewake Stop hook:
// it waits in the background until shortly before the 1-hour cache of the last request expires and,
// if the session is still idle, exits 2 so Claude Code wakes the model for a one-word turn. That turn
// reads the cached conversation, which restarts the cache's 1-hour lifetime. Every other path exits 0
// and sends no request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KEEPALIVE_MARKER = 'refreshing the prompt cache before it expires';
export const KEEPALIVE_DEFAULTS = Object.freeze({max_pings: 2, min_context_tokens: 100000, lead_seconds: 240});
// A lead under 120 s would leave too little of the hour to ping before the late guard (60 s) applies.
const LIMITS = Object.freeze({max_pings: [1, 12], min_context_tokens: [0, 2_000_000], lead_seconds: [120, 3540]});
const TTL_MS = 3600e3, LATE_MS = 60e3, POLL_MS = 10e3, SETTLE_MS = 2e3, SETTLE_TRIES = 3;
const TAIL_BYTES = 4 * 1024 * 1024, STATE_AGE_MS = 2 * 86400e3;

const configFile = root => path.join(root, 'somestoken', 'cache-keepalive.json');
/** One small state file per session; the session id is hashed, never stored. */
export const keepaliveStatePath = (root, sessionId) => path.join(root, 'somestoken', 'keepalive',
  crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 20) + '.json');

export function normalizeKeepaliveConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const config = {enabled: source.enabled === true, ...KEEPALIVE_DEFAULTS};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (source[key] === undefined) continue;
    if (!Number.isSafeInteger(source[key]) || source[key] < min || source[key] > max) return {...config, enabled: false};
    config[key] = source[key];
  }
  return config;
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('unsafe_keepalive_dir');
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temp, file);
}
export const readKeepaliveConfig = root => normalizeKeepaliveConfig(readJson(configFile(root)));
export function writeKeepaliveConfig(root, value) {
  const config = normalizeKeepaliveConfig(value);
  if (value?.enabled === true && !config.enabled) throw new Error('invalid_keepalive_config');
  writeJson(configFile(root), {schema_version: 1, ...config, updated_at: new Date().toISOString()});
  return config;
}

/** Parsed entries from the last 4 MiB of a transcript; a partial first line is dropped. */
export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.flatMap(line => { if (!line) return []; try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const main = e => e && typeof e === 'object' && e.isSidechain !== true;
const at = e => Date.parse(e?.timestamp);
const total = u => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const isResponse = e => e?.type === 'assistant' && main(e) && e.message?.usage && e.message.id && total(e.message.usage) > 0;
// A request-starting entry: a prompt or a tool result. Meta entries (local command output) start none.
const isRequestStart = e => e?.type === 'user' && main(e) && e.isMeta !== true;
const isToolResult = e => Array.isArray(e.message?.content) && e.message.content.some(block => block?.type === 'tool_result');
const text = e => typeof e.message?.content === 'string' ? e.message.content
  : Array.isArray(e.message?.content) ? e.message.content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
function ttlOf(u) {
  const written = u.cache_creation ?? {};
  if (written.ephemeral_1h_input_tokens > 0) return '1h';
  if (written.ephemeral_5m_input_tokens > 0) return '5m';
  return u.cache_creation_input_tokens > 0 ? 'unknown' : null;
}

/** The newest main-thread response, when its request started, its context size and cache lifetime. */
export function lastRequest(entries) {
  let k = entries.length - 1;
  while (k >= 0 && !isResponse(entries[k])) k--;
  if (k < 0) return null;
  const response = entries[k];
  let startedAt = NaN, ttl = null;
  for (let j = k - 1; j >= 0; j--) if (isRequestStart(entries[j])) { startedAt = at(entries[j]); break; }
  for (let j = k; j >= 0 && ttl === null; j--) if (isResponse(entries[j])) ttl = ttlOf(entries[j].message.usage);
  if (!Number.isFinite(startedAt)) return null;
  return {id: response.message.id, startedAt, ctx: total(response.message.usage), ttl, entrypoint: response.entrypoint ?? null};
}

const after = (entries, id) => {
  let k = entries.length - 1;
  while (k >= 0 && !(isResponse(entries[k]) && entries[k].message.id === id)) k--;
  return k < 0 ? [] : entries.slice(k + 1);
};

/** True when the person sent a prompt after `since`; keep-alive messages and tool results don't count. */
export function realPromptAfter(entries, since) {
  return entries.some(e => isRequestStart(e) && !isToolResult(e) && at(e) > since && !text(e).includes(KEEPALIVE_MARKER));
}

export function planPing({payload, entries, config, env, now, pings}) {
  if (!config?.enabled) return {skip: 'disabled'};
  if (payload?.hook_event_name !== 'Stop') return {skip: 'not_stop'};
  if (payload.agent_id) return {skip: 'subagent'};
  // Outside the interactive terminal Claude Code may run this hook in the foreground, so a wait would block.
  if (env?.CLAUDE_CODE_ENTRYPOINT !== 'cli') return {skip: 'not_interactive'};
  const request = lastRequest(entries);
  if (!request) return {skip: 'no_request'};
  if (request.entrypoint !== 'cli') return {skip: 'not_interactive'};
  if (after(entries, request.id).some(isRequestStart)) return {skip: 'in_flight'};
  if (request.ttl !== '1h') return {skip: 'not_one_hour'};
  if (request.ctx < config.min_context_tokens) return {skip: 'small'};
  if (pings >= config.max_pings) return {skip: 'cap_reached'};
  // The wait always ends inside the hook's 3,600 s timeout; after a clock jump Claude Code ends it, unpinged.
  const expiresAt = request.startedAt + TTL_MS, pingAt = expiresAt - config.lead_seconds * 1000;
  if (expiresAt - Math.max(now, pingAt) <= LATE_MS) return {skip: 'late'};
  return {id: request.id, startedAt: request.startedAt, ctx: request.ctx, expiresAt, pingAt};
}

/** 'ping' only when nothing started a request since the planned one and its cache is still alive. */
export function checkWake({plan, entries, now}) {
  if (plan.expiresAt - now <= LATE_MS) return 'late';
  const request = lastRequest(entries);
  if (!request) return 'no_request';
  if (request.id !== plan.id) return 'active';
  const since = after(entries, plan.id);
  if (since.some(e => e?.type === 'system' && e.subtype === 'compact_boundary')) return 'compacted';
  return since.some(isRequestStart) ? 'active' : 'ping';
}

export function pingMessage({plan, ping, max, now}) {
  const minutes = Math.max(1, Math.round((plan.expiresAt - now) / 60e3)), size = Math.round(plan.ctx / 1000);
  return `${KEEPALIVE_MARKER}: about ${minutes} min left on the ${size}k-token cached conversation (ping ${ping} of ${max}). `
    + 'This opt-in SomesToken turn only keeps the cache warm; it is not a request to continue, and nothing needs checking. Reply with only: ok\n';
}

function pruneStates(dir, now) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > STATE_AGE_MS) fs.unlinkSync(file);
    }
  } catch { /* pruning is best effort */ }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** The hook body. Returns the exit code: 2 only for a due ping whose state was saved first. */
export async function runKeepalive({dataRoot, input, env = process.env, now = Date.now, sleep = wait, ppid = () => process.ppid, write = value => process.stderr.write(value)}) {
  let payload;
  try { payload = JSON.parse(input); } catch { return 0; }
  const config = readKeepaliveConfig(dataRoot);
  if (!config.enabled || typeof payload?.session_id !== 'string' || typeof payload.transcript_path !== 'string') return 0;
  const stateFile = keepaliveStatePath(dataRoot, payload.session_id), state = readJson(stateFile) ?? {};
  const prior = Number.isSafeInteger(state.last_ping_at) ? state.last_ping_at : 0;
  let entries = readTail(payload.transcript_path);
  const pings = Number.isSafeInteger(state.pings) && !realPromptAfter(entries, prior) ? state.pings : 0;
  const planFrom = list => planPing({payload, entries: list, config, env, now: now(), pings});
  let plan = planFrom(entries);
  // Stop can arrive just before the final response reaches the transcript.
  for (let tries = 0; plan.skip === 'in_flight' && tries < SETTLE_TRIES; tries++) {
    await sleep(SETTLE_MS);
    plan = planFrom(entries = readTail(payload.transcript_path));
  }
  if (plan.skip) return 0;
  const owner = crypto.randomBytes(8).toString('hex'), parent = ppid();
  writeJson(stateFile, {owner, pings, last_ping_at: prior || null});
  pruneStates(path.dirname(stateFile), now());
  const mine = () => readJson(stateFile)?.owner === owner;
  while (now() < plan.pingAt) {
    await sleep(Math.min(POLL_MS, plan.pingAt - now()));
    // A newer Stop owns the session now, the setting was turned off, or Claude Code exited.
    if (!mine() || ppid() !== parent || !readKeepaliveConfig(dataRoot).enabled) return 0;
  }
  if (checkWake({plan, entries: readTail(payload.transcript_path), now: now()}) !== 'ping' || !mine()) return 0;
  writeJson(stateFile, {owner, pings: pings + 1, last_ping_at: now()});
  write(pingMessage({plan, ping: pings + 1, max: config.max_pings, now: now()}));
  return 2;
}
