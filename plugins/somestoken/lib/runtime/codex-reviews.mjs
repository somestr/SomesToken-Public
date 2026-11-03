// Codex runs an auto-review (a "guardian") in a rollout of its own and fires no subagent hook for
// it (observed with Codex 0.164-0.166, not verified against Codex itself). Called only with the
// session root that the Codex history collection opt-in names, a Codex Stop reads this session's
// auto-review rollouts changed since the thread's last commit and counts the usage of the records
// whose root turn is this turn. Spawned agents share the session and root turn; the header's source
// keeps them out. Lives outside core.mjs and codex-ledger.mjs so the collector's parser revisions stay.
import fs from 'node:fs';
import path from 'node:path';
import { hashOpaqueHostIdentifier, parseTokenSnapshots, sumUsage } from '../core.mjs';

// The slack covers file systems that store modification times in whole (or two) seconds.
const DAY_MS = 86_400_000, MAX_DAYS = 31, MAX_CANDIDATES = 512, MTIME_SLACK_MS = 2000;
const HEAD_BYTES = 64 * 1024, MAX_REVIEW_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;

// A regular file's first `limit` bytes (or, with `whole`, all of it up to `limit`); links are not followed.
function readRegular(file, limit, whole = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (whole && stat.size > limit)) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let used = 0, count;
    while (used < buffer.length && (count = fs.readSync(fd, buffer, used, buffer.length - used, used))) used += count;
    return buffer.subarray(0, used).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// Returns null when nothing may be read, else { usage, unknown }: usage sums the reviews bound to this
// turn; unknown means a review of this turn may exist that could not be counted (unbindable, unreadable,
// compressed or over a bound), so the receipt cannot be exact.
export function codexReviewUsage({ root, transcriptPath, sessionId, turnId, since, now = Date.now() }) {
  const session = hashOpaqueHostIdentifier(sessionId, 'ledger:session'), turn = hashOpaqueHostIdentifier(turnId, 'ledger:turn');
  let base, main;
  try { base = fs.realpathSync(root); main = fs.realpathSync(transcriptPath); } catch { return null; }
  if (!session || !turn || !main.startsWith(base + path.sep)) return null;
  const start = Number.isFinite(since) && since <= now ? since : now - DAY_MS;
  // Codex names day folders by local date. Half-day steps with a day of slack on each side
  // cover daylight-saving days and time zone changes.
  const days = new Set();
  for (let at = start - DAY_MS; at <= now + DAY_MS; at += DAY_MS / 2) {
    const d = new Date(at), p = (n) => String(n).padStart(2, '0');
    days.add(path.join(base, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())));
  }
  if (days.size > MAX_DAYS) return { usage: null, unknown: true };
  let unknown = false;
  const candidates = [];
  for (const day of days) {
    let names;
    try { names = fs.readdirSync(day); } catch { continue; }
    for (const name of names) {
      const file = path.join(day, name), compressed = name.endsWith('.jsonl.zst');
      if (!name.startsWith('rollout-') || !(compressed || name.endsWith('.jsonl')) || file === main) continue;
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile() || stat.mtimeMs < start - MTIME_SLACK_MS) continue;
      // ponytail: a compressed rollout changed in the window is not read; decompress with zstdChunks
      // if Codex compresses fresh rollouts again (it stopped on 2026-10-26 on the maintainer's Mac).
      // While both copies exist the plain one is read, as the collector does.
      if (compressed) { if (!names.includes(name.slice(0, -4))) unknown = true; continue; }
      candidates.push(file);
    }
  }
  if (candidates.length > MAX_CANDIDATES) return { usage: null, unknown: true };
  const usages = [];
  let bytes = 0;
  for (const file of candidates) {
    const head = readRegular(file, HEAD_BYTES), newline = head?.indexOf('\n') ?? -1;
    let meta;
    try { meta = JSON.parse(newline < 0 ? head : head.slice(0, newline)).payload; } catch { unknown = true; continue; }
    if (meta?.source?.subagent?.other !== 'guardian' || meta.session_id !== sessionId) continue;
    const text = readRegular(file, MAX_REVIEW_BYTES, true);
    bytes += text?.length ?? 0;
    if (text === null || bytes > MAX_TOTAL_BYTES) { unknown = true; continue; }
    const parsed = parseTokenSnapshots(text);
    for (const t of parsed.ledger?.turns ?? []) {
      if (t.session !== session || t.root !== turn) continue;
      if (t.status === 'exact' && t.usage) usages.push(t.usage);
      else unknown = true;
    }
    // Usage without structured records names no root turn, so it cannot be bound to this one.
    if (!parsed.ledger?.present && parsed.latest) unknown = true;
  }
  return { usage: usages.length ? sumUsage(usages) : null, unknown };
}
