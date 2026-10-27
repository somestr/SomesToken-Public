import fs from 'node:fs';
import path from 'node:path';
import { buildPublicSnapshot } from './build.mjs';
import { normalizePublicSnapshot, publicSnapshotBounds } from './schema.mjs';
import { isHostOwnedAbsolutePath, unlinkOwnedFile } from '../host-paths.mjs';

const CURRENT_FILE = 'current.json';
const SESSIONS_DIR = 'sessions';

function explicitDataRoot(env = {}) {
  const one = (keys) => {
    const values = [...new Set(keys.map((key) => env?.[key]).filter(isHostOwnedAbsolutePath))];
    return values.length === 1 ? values[0] : null;
  };
  if (env?.SOMESTOKEN_RUNTIME === 'claude') {
    return one(['CLAUDE_PLUGIN_DATA']) ?? one(['PLUGIN_DATA']);
  }
  if (env?.SOMESTOKEN_RUNTIME === 'codex') return one(['PLUGIN_DATA']);
  return one(['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA']);
}

export function resolvePublicRoot(env = {}) {
  const root = explicitDataRoot(env);
  return root ? path.join(root, 'somestoken', 'public') : null;
}

function safeSnapshot(value) {
  const normalized = normalizePublicSnapshot(value);
  if (!normalized) return null;
  const serialized = `${JSON.stringify(normalized)}\n`;
  return Buffer.byteLength(serialized, 'utf8') <= publicSnapshotBounds().max_current_bytes ? serialized : null;
}

function atomicWrite(target, serialized) {
  const directory = path.dirname(target);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  let fd,owned;
  let committed = false;
  try {
    if (!safeDirectory(directory)) return false;
    fd = fs.openSync(temp, 'wx', 0o600);
    owned = fs.fstatSync(fd);
    // This public snapshot is a derived, replaceable view: atomic temp+rename
    // prevents partial reads and the next hook can regenerate it after a
    // crash. Avoiding a second fsync on every high-frequency tool event keeps
    // the report-only hook bounded; lifecycle/receipt state remains durable.
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    committed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fail open */ }
    if (!committed) try { unlinkOwnedFile(temp,owned); } catch { /* fail open */ }
  }
}

function safeDirectory(directory, create = true) {
  try {
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if (!create || error?.code !== 'ENOENT') return false;
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
      stat = fs.lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
    return true;
  } catch {
    return false;
  }
}

function ensurePublicRoot(root) {
  // The host owns the plugin-data root itself, which may legitimately be a
  // platform-managed link. Only SomesToken's direct child is ours to create
  // and must never redirect public state outside that namespace.
  const hostDataRoot = path.dirname(path.dirname(root));
  try {
    fs.mkdirSync(hostDataRoot, { recursive: true, mode: 0o700 });
    if (!fs.statSync(hostDataRoot).isDirectory()) return false;
  } catch {
    return false;
  }
  return safeDirectory(path.dirname(root)) && safeDirectory(root);
}

export function isPublicRootSafe(env = {}) {
  const root = resolvePublicRoot(env);
  return Boolean(root && safeDirectory(path.dirname(root), false) && safeDirectory(root, false));
}

export function writePublicSnapshot(env = {}, state, options = {}) {
  const root = resolvePublicRoot(env);
  if (!root) return { ok: false, status: 'bridge_unavailable', path: null, snapshot: null };
  const sequence = (Number.isSafeInteger(state?.public_bridge?.snapshot_sequence) ? state.public_bridge.snapshot_sequence : 0) + 1;
  const lastPublishedAt = Number.isSafeInteger(state?.public_bridge?.last_published_at)
    && state.public_bridge.last_published_at >= 0
    ? state.public_bridge.last_published_at
    : 0;
  const attemptedAt = Number.isSafeInteger(options.updated_at) && options.updated_at >= 0
    ? options.updated_at
    : Date.now();
  if (state && typeof state === 'object') {
    // Persist the attempt before writing. A failed active-bridge write must
    // remain fail-open, but it must not turn every tool hook into another IO
    // attempt; runtime uses this bounded timestamp as its retry lease.
    state.public_bridge = {
      snapshot_sequence: sequence,
      last_published_at: lastPublishedAt,
      last_attempted_at: attemptedAt,
    };
  }
  const snapshot = buildPublicSnapshot(state, env, {
    ...options,
    snapshot_sequence: sequence,
    updated_at: attemptedAt,
  });
  const serialized = safeSnapshot(snapshot);
  if (!serialized) return { ok: false, status: 'bridge_write_failed', path: null, snapshot: null };
  const currentPath = path.join(root, CURRENT_FILE);
  if (!ensurePublicRoot(root)) return { ok: false, status: 'bridge_write_failed', path: currentPath, snapshot };
  const ok = atomicWrite(currentPath, serialized);
  if (!ok) return { ok: false, status: 'bridge_write_failed', path: currentPath, snapshot };
  if (state && typeof state === 'object') {
    state.public_bridge = {
      snapshot_sequence: sequence,
      last_published_at: snapshot.updated_at,
      last_attempted_at: snapshot.updated_at,
    };
  }
  // Keep a small FIFO of closed snapshots. Files are generated from a bounded
  // sequence, never from host identifiers or content.
  try {
    const sessionsRoot = path.join(root, SESSIONS_DIR);
    // Retention is optional; never enumerate or prune through a redirected
    // directory. The current snapshot above remains authoritative if this
    // bounded history cannot be maintained safely.
    if (!safeDirectory(sessionsRoot)) return { ok: true, status: 'bridge_ready', path: currentPath, snapshot };
    if (snapshot.snapshot_state !== 'active' && snapshot.snapshot_state !== 'closing') {
      atomicWrite(path.join(sessionsRoot, `session-${snapshot.snapshot_sequence}.json`), serialized);
      if (!safeDirectory(sessionsRoot)) return { ok: true, status: 'bridge_ready', path: currentPath, snapshot };
      const files = fs.readdirSync(sessionsRoot).filter((name) => /^session-\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(8, -5)) - Number(b.slice(8, -5)));
      for (const name of files.slice(0, Math.max(0, files.length - publicSnapshotBounds().max_closed_sessions))) {
        try { fs.unlinkSync(path.join(sessionsRoot, name)); } catch { /* fail open */ }
      }
    }
  } catch { /* public current snapshot remains authoritative */ }
  return { ok: true, status: 'bridge_ready', path: currentPath, snapshot };
}

export function publicSnapshotPath(env = {}) {
  const root = resolvePublicRoot(env);
  return root ? path.join(root, CURRENT_FILE) : null;
}
