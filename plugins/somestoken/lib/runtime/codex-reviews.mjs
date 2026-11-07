// Codex runs an auto-review (a "guardian") and each spawned agent in a rollout of its own; it fires no
// subagent hook for a review, and runs a spawned agent's SubagentStart in the agent's own turn
// (observed with Codex 0.164-0.166, not verified against Codex itself). Both rollouts name the root
// session and, on each usage record, the main turn the work was for. Called only with the session root
// that the Codex history collection opt-in names, a Codex Stop reads this session's review and agent
// rollouts changed since the thread's last commit and counts the records whose root turn is this turn.
// Lives outside core.mjs and codex-ledger.mjs so the collector's parser revisions stay.
import fs from 'node:fs';
import path from 'node:path';
import { hashOpaqueHostIdentifier, parseTokenSnapshots, sumUsage } from '../core.mjs';

// The slack covers file systems that store modification times in whole (or two) seconds.
const DAY_MS = 86_400_000, MAX_DAYS = 31, MAX_CANDIDATES = 512, MTIME_SLACK_MS = 2000;
// A Stop reads every review rollout changed since the thread's last commit. On the maintainer's Mac (2026-11-07)
// a main turn's reviews take 1.2 MiB at the median and 73.7 MiB at most (a 20-hour turn, 87 MiB of candidates).
const HEAD_BYTES = 64 * 1024, MAX_REVIEW_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
// Agent rollouts reach 21 MiB, and 46 MiB for one main turn (24 on the maintainer's Mac, 2026-11-07); two
// agents' tool output filled 771 MiB. The bound holds for one agent and for all of a Stop.
// ponytail: a larger rollout is not read; a backward scan that keeps only record and turn lines, as for
// the main rollout, would count it.
const MAX_AGENT_BYTES = 64 * 1024 * 1024;
// Every turn Codex starts in a rollout ends with one of these events; a later start is a turn still running.
const TURN_START = '"type":"task_started"', TURN_ENDS = ['"type":"task_complete"', '"type":"turn_aborted"'];

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

// Returns null when nothing may be read, else { usage, unknown, agents }: usage sums the reviews bound to
// this turn; unknown means a review of this turn may exist that could not be counted (unbindable,
// unreadable, compressed or over a bound), so the receipt cannot be exact. agents.counted lists each
// finished agent rollout (its thread id, in memory only, and the usage of its records bound to this turn,
// or null); agents.unresolved lists the agents whose usage for this turn may be incomplete: a turn still
// running, a record that does not reconcile, usage without records, or a rollout over a bound.
export function codexChildUsage({ root, transcriptPath, sessionId, turnId, since, now = Date.now() }) {
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
  // A bound passed before any rollout is read leaves every review and agent of this turn uncounted.
  const unread = { usage: null, unknown: true, agents: { counted: [], unresolved: [] } };
  if (days.size > MAX_DAYS) return unread;
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
      // if Codex compresses fresh rollouts again (it stopped on 2026-10-30 on the maintainer's Mac).
      // While both copies exist the plain one is read, as the collector does.
      if (compressed) { if (!names.includes(name.slice(0, -4))) unknown = true; continue; }
      candidates.push(file);
    }
  }
  if (candidates.length > MAX_CANDIDATES) return unread;
  const usages = [], counted = [], unresolved = [];
  let bytes = 0, agentBytes = 0;
  for (const file of candidates) {
    const head = readRegular(file, HEAD_BYTES), newline = head?.indexOf('\n') ?? -1;
    let meta;
    try { meta = JSON.parse(newline < 0 ? head : head.slice(0, newline)).payload; } catch { unknown = true; continue; }
    if (meta?.session_id !== sessionId) continue;
    if (meta.source?.subagent?.thread_spawn && typeof meta.id === 'string') {
      const text = readRegular(file, MAX_AGENT_BYTES - agentBytes, true);
      if (text === null) { unresolved.push(meta.id); continue; }
      agentBytes += Buffer.byteLength(text);
      const own = hashOpaqueHostIdentifier(meta.id, 'ledger:thread'), parsed = parseTokenSnapshots(text);
      const bound = (parsed.ledger?.turns ?? []).filter((t) => t.session === session && t.root === turn && t.thread === own);
      const running = text.lastIndexOf(TURN_START) > Math.max(...TURN_ENDS.map((end) => text.lastIndexOf(end)));
      if (running || bound.some((t) => t.status !== 'exact' || !t.usage) || (!parsed.ledger?.present && parsed.latest)) unresolved.push(meta.id);
      else counted.push({ thread: meta.id, usage: bound.length ? sumUsage(bound.map((t) => t.usage)) : null });
      continue;
    }
    if (meta.source?.subagent?.other !== 'guardian') continue;
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
  return { usage: usages.length ? sumUsage(usages) : null, unknown, agents: { counted, unresolved } };
}
