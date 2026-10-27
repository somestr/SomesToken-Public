import { unlinkOwnedFile } from './host-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

import {safeModel} from './core.mjs';
import { normalizeEfficiencyEvent } from './efficiency/schema.mjs';

export const HOT_EVENT_DIRECTORY_NAME = 'hot-events';

const HOT_EVENT_SCHEMA_VERSION = 1;
const INDEX_FILE = 'index.json';
const SEGMENT_PREFIX = 'segment-';
const SEGMENT_SUFFIX = '.ndjson';
const MAX_SEGMENTS = 128;
const MAX_SEGMENT_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 4096;
const MAX_EVENT_EPOCH = 1_000_000_000;
const HASH = /^[a-f0-9]{20}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SEGMENT_FILE = /^segment-([1-9]\d*)\.ndjson$/;

// ponytail: bounded append-only segments avoid a resident worker, timer, or
// full-state rewrite on each hook while retaining only structural evidence.

function safeInteger(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EVENT_EPOCH ? value : fallback;
}

function safeText(value) {
  return typeof value === 'string' && SAFE_TEXT.test(value) && safeModel(value) && !value.startsWith('/') && !value.includes('..') && !value.includes('\\')
    ? value
    : null;
}

function hotDirectory(stateDir) {
  return path.join(stateDir, HOT_EVENT_DIRECTORY_NAME);
}

function indexPath(stateDir) {
  return path.join(hotDirectory(stateDir), INDEX_FILE);
}

function segmentName(id) {
  return `${SEGMENT_PREFIX}${id}${SEGMENT_SUFFIX}`;
}

function segmentPath(stateDir, id) {
  return path.join(hotDirectory(stateDir), segmentName(id));
}

function safeSegmentId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_EVENT_EPOCH ? value : null;
}

function blankIndex(epoch = 1, dropped = 0) {
  return {
    hot_event_schema_version: HOT_EVENT_SCHEMA_VERSION,
    epoch: safeSegmentId(epoch) ?? 1,
    next_segment: 1,
    segments: [],
    dropped_events: Math.min(MAX_EVENT_EPOCH, safeInteger(dropped, 0)),
  };
}

function normalizeIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.hot_event_schema_version !== HOT_EVENT_SCHEMA_VERSION) return null;
  const epoch = safeSegmentId(value.epoch);
  const next = safeSegmentId(value.next_segment);
  if (!epoch || !next) return null;
  const ids = Array.isArray(value.segments)
    ? [...new Set(value.segments.map(safeSegmentId).filter(Boolean))].slice(-MAX_SEGMENTS)
    : [];
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) return null;
  return {
    hot_event_schema_version: HOT_EVENT_SCHEMA_VERSION,
    epoch,
    next_segment: next,
    segments: ids,
    dropped_events: Math.min(MAX_EVENT_EPOCH, safeInteger(value.dropped_events, 0)),
  };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = normalizeEfficiencyEvent(value.event);
  const session = typeof value.session === 'string' && HASH.test(value.session) ? value.session : null;
  const scopeId = typeof value.scope_id === 'string' && HASH.test(value.scope_id) ? value.scope_id : null;
  const generation = safeInteger(value.session_generation);
  if (!event || !session || !scopeId || generation === null || event.session !== session) return null;
  const fields = Array.isArray(value.fields)
    ? [...new Set(value.fields.filter((entry) => typeof entry === 'string' && SAFE_FIELD.test(entry)))].slice(0, 32)
    : [];
  const acceptance = value.acceptance && typeof value.acceptance === 'object' && !Array.isArray(value.acceptance)
    ? {
      enabled: value.acceptance.enabled === true,
      scenario: safeText(value.acceptance.scenario) ?? 'extended-events',
    }
    : { enabled: false, scenario: 'extended-events' };
  const hostVersion = safeText(value.host_version);
  const turnId = typeof value.turn_id === 'string' && HASH.test(value.turn_id) ? value.turn_id : null;
  const invalidation = value.claude_final_invalidation && typeof value.claude_final_invalidation === 'object'
    && !Array.isArray(value.claude_final_invalidation)
    ? {
      clear_session: value.claude_final_invalidation.clear_session === true,
      ...(typeof value.claude_final_invalidation.turn_id === 'string' && HASH.test(value.claude_final_invalidation.turn_id)
        ? { turn_id: value.claude_final_invalidation.turn_id } : {}),
      ...(typeof value.claude_final_invalidation.lifecycle_turn_id === 'string' && HASH.test(value.claude_final_invalidation.lifecycle_turn_id)
        ? { lifecycle_turn_id: value.claude_final_invalidation.lifecycle_turn_id } : {}),
    }
    : null;
  return {
    event,
    session,
    scope_id: scopeId,
    session_generation: generation,
    fields,
    acceptance,
    ...(hostVersion ? { host_version: hostVersion } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    ...(invalidation ? { claude_final_invalidation: invalidation } : {}),
  };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('hot-event-directory-invalid');
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
}

function atomicWrite(target, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  let fd,owned;
  let committed = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    committed = true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
    if (!committed) {
      try { unlinkOwnedFile(temp,owned); } catch { /* fail open */ }
    }
  }
}

function readSmallFile(target, maxBytes) {
  let fd;
  try {
    const link = fs.lstatSync(target);
    if (!link.isFile() || link.isSymbolicLink()) return null;
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    if (stat.size > 0) fs.readSync(fd, buffer, 0, stat.size, 0);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
}

function safeSegmentSize(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() && Number.isSafeInteger(stat.size) && stat.size >= 0
      ? stat.size
      : null;
  } catch {
    return 0;
  }
}

function appendableSegment(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function appendSegment(target, serialized) {
  if (!appendableSegment(target)) throw new Error('hot-event-segment-invalid');
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow | fs.constants.O_NONBLOCK;
  let fd;
  try {
    fd = fs.openSync(target, flags, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('hot-event-segment-invalid');
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fchmodSync(fd, 0o600);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
}

function readIndex(stateDir) {
  const target = indexPath(stateDir);
  if (!fs.existsSync(target)) return { index: blankIndex(), recovered: false };
  const text = readSmallFile(target, 64 * 1024);
  if (!text) return { index: null, recovered: true };
  try {
    const index = normalizeIndex(JSON.parse(text));
    return index ? { index, recovered: false } : { index: null, recovered: true };
  } catch {
    return { index: null, recovered: true };
  }
}

function countRecords(stateDir, id) {
  const text = readSmallFile(segmentPath(stateDir, id), MAX_SEGMENT_BYTES);
  return text ? text.split('\n').filter(Boolean).length : 0;
}

function removeSegment(stateDir, id) {
  try { fs.unlinkSync(segmentPath(stateDir, id)); } catch { /* fail open */ }
}

function discardKnownSegments(stateDir) {
  const directory = hotDirectory(stateDir);
  let dropped = 0;
  try {
    for (const file of fs.readdirSync(directory)) {
      const match = SEGMENT_FILE.exec(file);
      if (!match) continue;
      const id = safeSegmentId(Number(match[1]));
      if (!id) continue;
      dropped += countRecords(stateDir, id);
      try { fs.unlinkSync(path.join(directory, file)); } catch { /* fail open */ }
    }
  } catch { /* fail open */ }
  return Math.min(MAX_EVENT_EPOCH, dropped);
}

function recoverIndex(stateDir) {
  const discarded = discardKnownSegments(stateDir);
  const index = blankIndex(1, discarded);
  atomicWrite(indexPath(stateDir), index);
  return index;
}

/** Append one pre-sanitized hot event without rewriting the full state tree. */
export function appendHotEvent(stateDir, value) {
  const record = normalizeRecord(value);
  if (!record) return { appended: false, dropped: 1, recovered: false };
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LINE_BYTES) return { appended: false, dropped: 1, recovered: false };
  try {
    ensureDirectory(hotDirectory(stateDir));
    let { index, recovered } = readIndex(stateDir);
    if (!index) {
      index = recoverIndex(stateDir);
      recovered = true;
    }
    let active = index.segments.at(-1);
    const activeSize = active ? safeSegmentSize(segmentPath(stateDir, active)) : 0;
    if (!active || !Number.isSafeInteger(activeSize) || activeSize < 0 || activeSize + Buffer.byteLength(serialized, 'utf8') > MAX_SEGMENT_BYTES) {
      if (index.next_segment >= MAX_EVENT_EPOCH) {
        let dropped = index.dropped_events;
        for (const id of index.segments) {
          dropped = Math.min(MAX_EVENT_EPOCH, dropped + countRecords(stateDir, id));
          removeSegment(stateDir, id);
        }
        index = blankIndex(1, dropped);
      }
      active = index.next_segment;
      if (!appendableSegment(segmentPath(stateDir, active))) return { appended: false, dropped: 1, recovered };
      index.next_segment += 1;
      if (index.segments.length >= MAX_SEGMENTS) {
        const expired = index.segments.shift();
        if (expired) {
          index.dropped_events = Math.min(MAX_EVENT_EPOCH, index.dropped_events + countRecords(stateDir, expired));
          removeSegment(stateDir, expired);
        }
      }
      // A wrapped segment id can only collide after the bounded counter wraps.
      // Drop the exact old segment before reusing its generated filename.
      if (index.segments.includes(active)) {
        index.dropped_events = Math.min(MAX_EVENT_EPOCH, index.dropped_events + countRecords(stateDir, active));
        index.segments = index.segments.filter((id) => id !== active);
        removeSegment(stateDir, active);
      }
      index.segments.push(active);
      atomicWrite(indexPath(stateDir), index);
    }
    appendSegment(segmentPath(stateDir, active), serialized);
    return { appended: true, dropped: 0, recovered };
  } catch {
    return { appended: false, dropped: 1, recovered: false };
  }
}

/** Read bounded, normalized records. A truncated final line is discarded. */
export function readHotEvents(stateDir) {
  const { index, recovered } = readIndex(stateDir);
  if (!index) return { epoch: null, events: [], dropped: 1, retention_drops: 0, recovered: true };
  const events = [];
  let malformed = 0;
  for (const id of index.segments) {
    const text = readSmallFile(segmentPath(stateDir, id), MAX_SEGMENT_BYTES);
    if (text === null) {
      malformed += 1;
      continue;
    }
    const complete = text.split('\n');
    if (complete.pop()) malformed += 1;
    for (const line of complete) {
      if (!line) continue;
      try {
        const event = normalizeRecord(JSON.parse(line));
        if (event) events.push(event);
        else malformed += 1;
      } catch {
        malformed += 1;
      }
    }
  }
  return {
    epoch: index.epoch,
    events,
    dropped: Math.min(MAX_EVENT_EPOCH, malformed + index.dropped_events),
    retention_drops: index.dropped_events,
    recovered,
  };
}

/** Reset only the fixed generated segment files after their epoch is durable. */
export function resetHotEvents(stateDir, epoch) {
  const { index } = readIndex(stateDir);
  const current = index ?? blankIndex();
  const nextEpoch = safeSegmentId(epoch) && current.epoch <= epoch
    ? (epoch >= MAX_EVENT_EPOCH ? 1 : epoch + 1)
    : current.epoch;
  try {
    ensureDirectory(hotDirectory(stateDir));
    if (index) {
      for (const id of current.segments) removeSegment(stateDir, id);
    } else {
      discardKnownSegments(stateDir);
    }
    atomicWrite(indexPath(stateDir), blankIndex(nextEpoch));
    return true;
  } catch {
    return false;
  }
}
