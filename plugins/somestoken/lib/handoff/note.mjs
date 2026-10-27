import { unlinkOwnedFile } from '../host-paths.mjs';
import {isHashedIdentity} from '../core.mjs';
// The per-task handoff note: a small Markdown file owned by the user, written
// by the running agent through the CLI. Git context is filled in here; the work
// states come from the agent. Only the latest and one previous copy are kept.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

export const NOTE_SECTIONS = ['Goal', 'Permissions', 'Verified done', 'Applied, not verified', 'In progress', 'Remaining', 'Blocked', 'Last checks', 'Next step'];
// A verified item names its evidence; summaries and unverified claims belong under "Applied, not verified".
export const EVIDENCE_LABELS = ['user', 'source', 'test'];
const MAX_CONTENT_BYTES = 32 * 1024, MAX_NOTE_BYTES = 256 * 1024, MAX_LISTED_FILES = 50;
// The source check reads at most this much: the status listing and the content it hashes.
const LIMITS = { statusBytes: 4 * 1024 * 1024, hashedBytes: 64 * 1024 * 1024 };
const FOLDER = 'SomesToken Handoff';
const PRIVATE = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api_key', /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['source_diff', /^diff --git |^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m],
  // .env-style assignments of secret-looking names; prose that merely names them is fine.
  ['env_secret', /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*\S/m],
];

const git = (cwd, args, maxBuffer = 1024 * 1024) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer });
function gitContext(root, limits = LIMITS) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const toplevel = top.stdout.trim();
  // Porcelain v2 names each entry's index blob, so a staged change counts even
  // when the working tree matches. With -z names are verbatim and a rename's
  // source path follows as its own field. Fields: 1 XY sub mH mI mW hH hI path;
  // 2 XY sub mH mI mW hH hI score path; u XY sub m1 m2 m3 mW h1 h2 h3 path; ? path.
  const listing = git(toplevel, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], limits.statusBytes);
  const fields = listing.stdout.split('\0'), entries = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index], parts = field.split(' '), start = { 1: 8, 2: 9, u: 10 }[field[0]];
    if (field.startsWith('? ')) entries.push({ status: '??', index: '', path: field.slice(2) });
    else if (start && parts.length > start) {
      entries.push({ status: parts[1], index: field[0] === 'u' ? parts.slice(7, 10).join(',') : parts[7], path: parts.slice(start).join(' ') });
      if (field[0] === '2') index++;
    }
  }
  return { toplevel, common: path.resolve(toplevel, git(toplevel, ['rev-parse', '--git-common-dir']).stdout.trim()),
    branch: git(toplevel, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'unknown',
    commit: git(toplevel, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim() || 'none',
    entries, enumerated: listing.status === 0 && !listing.error };
}
// Uncommitted paths other than the note's own folder, when that folder is inside the checkout.
function workEntries(context, noteDir) {
  const own = path.relative(context.toplevel, noteDir);
  const inside = own && !own.startsWith('..') && !path.isAbsolute(own);
  return context.entries.filter(entry => !inside || (entry.path !== own && !entry.path.startsWith(`${own}/`)));
}
// One uncommitted path's identity, read through its own descriptor: links are
// not followed (a link counts by its target text), only regular files are read,
// at most `limit` bytes. `changed` when the file moved while it was read.
function pathIdentity(file, limit) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (error) {
    if (error.code === 'ENOENT') return { id: 'missing' };
    try { if (fs.lstatSync(file).isSymbolicLink()) return { id: `link:${fs.readlinkSync(file)}` }; } catch { /* Unreadable below. */ }
    return { id: 'unreadable', unverified: true };
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return { id: 'special', unverified: true };
    if (before.size > limit) return { id: `size:${before.size}:${before.mtimeMs}`, unverified: true, budget: true };
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let read = 0;
    for (let count; read < buffer.length && (count = fs.readSync(fd, buffer, read, buffer.length - read, read)); ) read += count;
    const after = fs.fstatSync(fd);
    return { id: createHash('sha256').update(buffer.subarray(0, read)).digest('hex'), bytes: Math.min(read, before.size),
      changed: read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino };
  } finally { fs.closeSync(fd); }
}
// The source a note describes: the commit plus the status, index blob and
// content of every uncommitted path, in path order. Content past the byte
// budget, special files and unreadable paths count only by what can be seen,
// and the check then says it is incomplete rather than calling it a match.
function sourceFingerprint(context, noteDir, limits = LIMITS) {
  const hash = createHash('sha256').update(`${context.commit}\0`);
  const coverage = { enumeration_complete: context.enumerated, files_in_scope: 0, files_hashed: 0, files_metadata_only: 0, bytes_hashed: 0, budget_exhausted: false };
  let budget = limits.hashedBytes, unreadable = false, changed = false;
  // Git lists each path once, so code-unit order needs no tie case.
  for (const entry of workEntries(context, noteDir).sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const found = pathIdentity(path.join(context.toplevel, entry.path), budget);
    coverage.files_in_scope++;
    if (found.unverified) coverage.files_metadata_only++;
    if (found.bytes !== undefined) { coverage.files_hashed++; coverage.bytes_hashed += found.bytes; budget -= found.bytes; }
    coverage.budget_exhausted ||= Boolean(found.budget);
    unreadable ||= found.unverified && !found.budget;
    changed ||= Boolean(found.changed);
    hash.update(`${entry.status}\0${entry.index}\0${entry.path}\0${found.id}\0`);
  }
  coverage.content_verification_complete = coverage.enumeration_complete && !coverage.files_metadata_only;
  const gaps = [...(coverage.enumeration_complete ? [] : ['file_enumeration_truncated']), ...(coverage.budget_exhausted ? ['hash_budget_exceeded'] : []),
    ...(unreadable ? ['source_read_unavailable'] : [])];
  return { fingerprint: hash.digest('hex'), coverage, gaps, changed };
}
const SOURCE_RECORD = /^<!-- somestoken-source (\{.*\}) -->$/m;
const COVERAGE_GAPS = ['file_enumeration_truncated', 'hash_budget_exceeded', 'source_read_unavailable'];
const missingSections = text => NOTE_SECTIONS.filter(section => !new RegExp(`^## ${section.replace(/[.,]/g, '\\$&')}\\s*$`, 'm').test(text));
const slug = directory => path.basename(directory).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'project';
// Top-level items under "## Verified done" must start with an evidence label, e.g. `- [test] npm test passed on this source`.
function unlabeledVerifiedItems(text) {
  const body = text.split(/^## Verified done\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  return body.split('\n').filter(line => line.startsWith('- ') && !EVIDENCE_LABELS.some(label => line.startsWith(`- [${label}] `))).length;
}

/**
 * POSIX shell text (sh, bash, zsh) for an argument list: every argument that is
 * not plain is single-quoted, so `$`, backticks and quotes stay literal. Null
 * when an argument holds a control character, which a pasted line cannot keep.
 */
export function shellCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string' && !/[\x00-\x1f\x7f]/.test(arg))) return null;
  return argv.map(arg => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(' ');
}

// Candidate folders: the chosen target first, then the project's private git directory.
function locations(context, target) {
  return [...(target ? [{ dir: path.join(target, FOLDER), vault: true }] : []), ...(context ? [{ dir: path.join(context.common, 'somestoken-handoff'), vault: false }] : [])];
}
// The parent must already exist unlinked; only the handoff folder itself is created.
function usableFolder(dir) {
  const real = file => { try { const stat = fs.lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } };
  if (!real(path.dirname(dir))) return false;
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') return false; }
  return real(dir);
}
function readExisting(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { text: null }; throw Error('unsafe_note_path'); }
  if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) throw Error('unsafe_note_path');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_NOTE_BYTES) throw Error('unsafe_note_path');
    const buffer = Buffer.alloc(stat.size + 1);let bytes = 0;
    while (bytes < buffer.length) { const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);if (!count) break;bytes += count; }
    if (bytes !== stat.size) throw Error('unsafe_note_path');
    return { text: buffer.subarray(0, bytes).toString('utf8') };
  } finally { fs.closeSync(fd); }
}
const revisionOf = text => {
  const value = Number(text?.match(/^<!-- somestoken-handoff revision=(\d+) /m)?.[1] ?? 0);
  return Number.isSafeInteger(value) ? value : null;
};
// The recorded time changes on every call; it does not make a note different.
const comparable = text => text?.split('\n').filter(line => !line.startsWith('<!-- somestoken-handoff') && !line.startsWith('- Recorded: ')).join('\n');

/** Writes the task's note atomically; the previous good note survives any failure. */
export function writeHandoffNote({ root, host, task, content, target = null, obsidian = false, expectRevision, version = 'unknown', now = Date.now(), limits = LIMITS, beforePublish } = {}) {
  if (!['codex', 'claude'].includes(host) || !isHashedIdentity(task) || typeof root !== 'string' || !Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) return { ok: false, error: 'invalid_note_request' };
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'invalid_note_content' };
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) return { ok: false, error: 'note_too_large' };
  const missing = missingSections(content);
  if (missing.length) return { ok: false, error: `missing_sections:${missing.join(',')}` };
  if (unlabeledVerifiedItems(content)) return { ok: false, error: 'unlabeled_verified_items', evidence_labels: EVIDENCE_LABELS };
  const leaked = PRIVATE.find(([, pattern]) => pattern.test(content));
  if (leaked) return { ok: false, error: `private_content_rejected:${leaked[0]}` };
  const context = gitContext(root, limits), candidates = locations(context, target);
  const location = candidates.find(candidate => usableFolder(candidate.dir));
  if (!location) return { ok: false, error: 'no_note_location' };
  const file = path.join(location.dir, `${slug(context?.toplevel ?? root)}-${task}.md`);
  let existing;
  try { existing = readExisting(file); } catch (error) { return { ok: false, error: error.message }; }
  const current = revisionOf(existing.text);
  if (current === null) return { ok: false, error: 'unsafe_note_revision', file };
  if (expectRevision !== undefined && expectRevision !== current) return { ok: false, error: 'stale_revision', revision: current, file };
  const dirty = context ? workEntries(context, location.dir).map(entry => entry.path) : [];
  const checked = context && sourceFingerprint(context, location.dir, limits);
  if (checked?.changed) return { ok: false, error: 'unstable_snapshot', file };
  // Machine-readable source record for `verify`; `-->` cannot end the comment early.
  const source = context && JSON.stringify({ worktree: context.toplevel, repository: context.common, branch: context.branch,
    commit: context.commit, fingerprint: checked.fingerprint, coverage: checked.coverage, coverage_gaps: checked.gaps }).replaceAll('-->', '--\\u003e');
  const document = [
    `# SomesToken handoff — ${slug(context?.toplevel ?? root)}`,
    `<!-- somestoken-handoff revision=${current + 1} task=${task} host=${host} -->`,
    ...(source ? [`<!-- somestoken-source ${source} -->`] : []),
    `- Recorded: ${new Date(now).toISOString()} (SomesToken ${version}, host ${host})`,
    context ? `- Repository: ${context.toplevel} · Branch: ${context.branch} · Commit: ${context.commit}` : '- Repository: not a git checkout',
    `- Uncommitted files (${dirty.length}): ${dirty.slice(0, MAX_LISTED_FILES).join(', ') || 'none'}${dirty.length > MAX_LISTED_FILES ? ', …' : ''}`,
    '- Work after the recorded time is unknown to this note; check the repository before continuing.',
    '', content.trim(), '',
  ].join('\n');
  const result = { file, fallback: Boolean(target) && !location.vault, ...(location.vault && obsidian ? { obsidian_uri: `obsidian://open?path=${encodeURIComponent(file)}` } : {}) };
  if (existing.text !== null && comparable(existing.text) === comparable(document)) return { ok: true, status: 'unchanged', revision: current, ...result };
  if (current === Number.MAX_SAFE_INTEGER) return { ok: false, error: 'note_revision_exhausted', file };
  const temporary = [];
  const stage = text => { const name = path.join(location.dir, `.${randomBytes(8).toString('hex')}.tmp`), fd = fs.openSync(name, 'wx', 0o600);
    try { temporary.push({name,owned:fs.fstatSync(fd)});fs.writeFileSync(fd, text);return name; } finally { fs.closeSync(fd); } };
  try {
    const next = stage(document);
    // The source is read again once the note is staged. If it moved meanwhile
    // the note would describe no single state: the last good note stays.
    beforePublish?.();
    const again = context && gitContext(root, limits), recheck = again && sourceFingerprint(again, location.dir, limits);
    if (context && (again?.commit !== context.commit || again.branch !== context.branch || recheck.changed || recheck.fingerprint !== checked.fingerprint))
      return { ok: false, error: 'unstable_snapshot', file };
    if (existing.text !== null) fs.renameSync(stage(existing.text), `${file}.previous`);
    fs.renameSync(next, file);
    if (readExisting(file).text !== document) return { ok: false, error: 'verify_failed', ...result };
    return { ok: true, status: 'saved', revision: current + 1, previous: existing.text !== null, ...result };
  } catch {
    return { ok: false, error: 'write_failed', file };
  } finally {
    for (const {name,owned} of temporary) try { unlinkOwnedFile(name,owned); } catch { /* A cleanup failure must not replace the write result. */ }
  }
}

/** Where the task's latest note is, its revision and recorded time. */
export function readHandoffNote({ root, task, target = null } = {}) {
  if (!isHashedIdentity(task)) return { ok: false, error: 'invalid_note_request' };
  const context = gitContext(root);
  for (const location of locations(context, target)) {
    const file = path.join(location.dir, `${slug(context?.toplevel ?? root)}-${task}.md`);
    try {
      const { text } = readExisting(file);
      if (text === null) continue;
      const revision = revisionOf(text);
      if (revision === null) return { ok: false, error: 'unsafe_note_revision' };
      const recorded = Date.parse(text.match(/^- Recorded: (\S+)/m)?.[1] ?? '');
      return { ok: true, file, revision, recorded_at: Number.isFinite(recorded) ? recorded : null };
    } catch { return { ok: false, error: 'unsafe_note_path' }; }
  }
  return { ok: false, error: 'note_not_found' };
}

/**
 * Compares a note with the checkout it is about to be continued in. `ready`
 * means the recorded worktree, branch, commit and uncommitted content still
 * match; it says nothing about whether the note's summary is right. A note
 * never carries permissions, so they are always to be rechecked.
 */
export function verifyHandoffNote({ file, root, limits = LIMITS } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof root !== 'string') return { ok: false, error: 'invalid_note_request' };
  let text;
  try { ({ text } = readExisting(file)); } catch (error) { return { ok: false, error: error.message }; }
  if (text === null) return { ok: false, error: 'note_not_found' };
  const revision = revisionOf(text);
  if (revision === null) return { ok: false, error: 'unsafe_note_revision' };
  const recorded = Date.parse(text.match(/^- Recorded: (\S+)/m)?.[1] ?? '');
  const result = (status, reasons = []) => ({ ok: true, file, revision, recorded_at: Number.isFinite(recorded) ? recorded : null,
    status, reasons, permissions: 'recheck_required' });
  let source = null;
  try { source = JSON.parse(text.match(SOURCE_RECORD)?.[1] ?? 'null'); } catch { /* A damaged record counts as missing. */ }
  if (!['worktree', 'repository', 'branch', 'commit', 'fingerprint'].every(key => typeof source?.[key] === 'string')) return result('incomplete_context', ['no_source_record']);
  if (missingSections(text).length || unlabeledVerifiedItems(text)) return result('incomplete_context', ['missing_sections']);
  const context = gitContext(root, limits);
  if (!context) return result('wrong_workspace', ['not_a_repository']);
  if (context.common !== source.repository) return result('wrong_workspace', ['other_repository']);
  if (context.toplevel !== source.worktree) return result('wrong_workspace', ['other_worktree']);
  const reasons = [];
  if (context.branch !== source.branch) reasons.push('branch_changed');
  if (context.commit !== source.commit) reasons.push('commit_changed');
  if (reasons.length) return result('stale_source', reasons);
  const current = sourceFingerprint(context, path.dirname(file), limits);
  if (current.fingerprint !== source.fingerprint) return result('stale_source', ['uncommitted_changed']);
  // An equal fingerprint proves equal content only for what both checks read.
  // Recorded gaps come from the note file, so only known codes are passed on.
  const recordedGaps = Array.isArray(source.coverage_gaps) ? source.coverage_gaps.map(gap => (COVERAGE_GAPS.includes(gap) ? gap : 'source_coverage_unknown')) : ['source_coverage_unknown'];
  const gaps = [...new Set([...recordedGaps, ...current.gaps, ...(current.changed ? ['unstable_snapshot'] : [])])];
  return gaps.length ? result('incomplete_context', gaps) : result('ready');
}
