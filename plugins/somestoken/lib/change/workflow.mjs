// Contract-first change workflow. The in-place pair (start → edit → finish)
// keeps a base copy of the scope files, checks the edit where the user's build
// caches live and restores the base copy when it is not verified. The isolated
// path (plan → candidate → verify → apply) checks a patch in a worktree before
// it touches the tree. Records live in the repository's own git directory, or
// in a private per-user temp directory when .git is read-only (Codex's
// workspace-write sandbox), never in SomesToken usage telemetry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { importGraph, newCycles } from './imports.mjs';
import { languageOf, projectChecks, toolAvailable, externalPaths } from './toolchain.mjs';

export const LEVELS = ['review', 'simplify', 'architecture', 'algorithm'];
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_BYTES = 2000;
// Ignored dependency directories are linked, not copied, so isolated checks can
// resolve installed packages. Build output directories are never shared.
const DEPENDENCY_DIRECTORIES = ['node_modules', '.venv', 'venv'];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (cwd, argv, options = {}) => spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const git = (cwd, ...args) => run(cwd, ['git', ...args]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Project checks run without inherited test-runner internals: a nested `node --test`
// that sees NODE_TEST_CONTEXT reports to a parent runner and exits 0 on failures.
function checkEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
const languagesOf = files => [...new Set(files.map(languageOf).filter(Boolean))];

function repository(root) {
  const top = git(root, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) throw Error('not_a_git_repository');
  const resolved = fs.realpathSync(top.stdout.trim());
  if (resolved !== fs.realpathSync(root)) throw Error('root_is_not_repository_top_level');
  const common = path.resolve(resolved, git(resolved, 'rev-parse', '--git-common-dir').stdout.trim());
  const primary = path.join(common, 'somestoken-change'), usable = writable(primary);
  // The temp directory is created only when .git is read-only, but always searched.
  const states = [primary, privateTempState(resolved, !usable)].filter(Boolean);
  return { root: resolved, states, state: usable ? primary : states.find(state => state !== primary && writable(state)) ?? primary };
}
// Only a directory this user owns and nobody else can open holds baselines of
// the user's files; a shared, foreign or linked one is never used.
function privateTempState(root, create) {
  const parent = path.join(os.tmpdir(), `somestoken-change-${process.getuid?.() ?? 'user'}`);
  if (create) try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') return null; }
  const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) return null;
  return path.join(parent, sha256(root).slice(0, 16));
}
// mkdir can succeed where writes are denied, so probe with a real file.
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.probe-${randomBytes(6).toString('hex')}`);
    fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    fs.rmSync(probe);
    return true;
  } catch { return false; }
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  let fd, owned;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, text);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    owned = undefined;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { if (owned) { const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
      if (current?.isFile() && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(temporary); } }
  }
}
function planFile(repo, id) {
  if (typeof id!=='string'||!/^[a-f0-9]{16}$/.test(id)) throw Error('invalid_plan_id');
  return path.join(repo.state, 'plans', `${id}.json`);
}
const savePlan = (repo, plan) => writePrivate(planFile(repo, plan.id), JSON.stringify(plan, null, 1) + '\n');
// A plan is read from whichever state directory holds it; its baselines and
// logs then stay next to it.
function loadPlan(repo, id) {
  for (const state of [repo.state, ...repo.states.filter(other => other !== repo.state)]) {
    try { const plan = JSON.parse(fs.readFileSync(planFile({ state }, id), 'utf8')); repo.state = state; return plan; }
    catch (error) { if (error.message === 'invalid_plan_id') throw error; }
  }
  throw Error('plan_not_found');
}

function scopeFile(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw Error('invalid_scope_file');
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative === '.git' || relative.startsWith('.git/')) throw Error('invalid_scope_file');
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!stat) break;
    if (!stat.isDirectory()) throw Error('invalid_scope_file');
  }
  return relative;
}
function fingerprints(root, files) {
  return Object.fromEntries(files.map(file => {
    scopeFile(root, file);
    let stat;
    try { stat = fs.lstatSync(path.join(root, file)); } catch { return [file, 'absent']; }
    return [file, stat.isFile() ? sha256(fs.readFileSync(path.join(root, file))) : 'not_a_regular_file'];
  }));
}
function readPatch(file, code = 'invalid_patch_file') {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw Error(code);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PATCH_BYTES) throw Error(code);
    const buffer=Buffer.allocUnsafe(stat.size+1);let used=0,count;
    while(used<buffer.length&&(count=fs.readSync(fd,buffer,used,buffer.length-used,null)))used+=count;
    if(used>stat.size)throw Error(code);
    return buffer.subarray(0,used);
  } catch { throw Error(code); } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Files a patch touches, as git itself parses it; null when git cannot read it.
function patchStats(root, patchFile) {
  const result = git(root, 'apply', '--numstat', '-z', patchFile);
  if (result.status !== 0) return null;
  const tokens = result.stdout.split('\0'), files = [];
  let changed = 0;
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    changed += (match[1] === '-' ? 1 : Number(match[1])) + (match[2] === '-' ? 1 : Number(match[2]));
    if (match[3]) files.push(match[3]);
    else files.push(tokens[++i], tokens[++i]); // rename or copy: source and destination follow
  }
  return { files: [...new Set(files)], changed };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Lexical definition check for a named abstraction; not a semantic analysis.
const DEFINITION = {
  javascript: name => new RegExp(`\\b(?:class|function\\*?|interface|type|enum|const|let|var)\\s+${name}(?![\\w$])`),
  python: name => new RegExp(`^\\s*(?:async\\s+)?(?:class|def)\\s+${name}\\b|^${name}\\s*=`, 'm'),
  go: name => new RegExp(`^\\s*(?:type|func(?:\\s*\\([^)]*\\))?|var|const)\\s+${name}\\b`, 'm'),
  java: name => new RegExp(`\\b(?:class|interface|enum|record|@interface)\\s+${name}\\b|\\b(?:public|protected|private|static|final|abstract|default|synchronized)\\s[\\w<>\\[\\],.?\\s]*\\b${name}\\s*\\(`),
  swift: name => new RegExp(`\\b(?:class|struct|protocol|enum|actor|func|typealias|var|let)\\s+${name}\\b`),
};
function definesSymbol(tree, item) {
  const [file, name] = item.split('#'), language = languageOf(file);
  let text;
  try { text = fs.readFileSync(path.join(tree, file), 'utf8'); } catch { return false; }
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return language ? DEFINITION[language](literal).test(text) : new RegExp(`(?<![\\w$])${literal}(?![\\w$])`).test(text);
}

// A detached worktree at HEAD with the user's tracked edits, deletions and
// untracked files copied in, so checks see exactly what the user has. Manifest
// paths that leave the repository ('../lib') are linked at the same relative
// place, so local path dependencies resolve as they do for the user.
function isolate(root) {
  const outside = externalPaths(root), depth = Math.max(0, ...outside.map(entry => entry.split('/').filter(part => part === '..').length));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'somestoken-change-')), tree = path.join(parent, ...Array(depth).fill('up'), 'tree');
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  if (git(root, 'worktree', 'add', '--detach', '--quiet', tree, 'HEAD').status !== 0) {
    fs.rmSync(parent, { recursive: true, force: true });
    throw Error('isolation_failed');
  }
  const mirror = file => {
    const source = path.join(root, file), target = path.join(tree, file);
    let stat;
    try { stat = fs.lstatSync(source); } catch { fs.rmSync(target, { recursive: true, force: true }); return; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else if (stat.isFile()) fs.copyFileSync(source, target);
  };
  const entries = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all').stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const code = entries[i].slice(0, 2);
    mirror(entries[i].slice(3));
    if (code[0] === 'R' || code[0] === 'C') mirror(entries[++i]);
  }
  for (const name of DEPENDENCY_DIRECTORIES) {
    if (fs.existsSync(path.join(root, name)) && !fs.existsSync(path.join(tree, name))) fs.symlinkSync(path.join(root, name), path.join(tree, name));
  }
  for (const entry of outside) {
    const source = path.resolve(root, entry), link = path.resolve(tree, entry);
    if (!fs.existsSync(source) || fs.existsSync(link) || !link.startsWith(parent + path.sep)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link);
  }
  return { parent, tree };
}
function release(root, isolated) {
  git(root, 'worktree', 'remove', '--force', isolated.tree);
  fs.rmSync(isolated.parent, { recursive: true, force: true });
  git(root, 'worktree', 'prune');
}

const tail = text => {
  const bytes = Buffer.from(text);
  return bytes.length <= OUTPUT_TAIL_BYTES ? text : `…${bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString('utf8')}`;
};
// One project check; the full output is kept in a private log, the reply shows its tail.
function runCheck(repo, plan, attempt, tree, check, stage) {
  const command = check.shell ?? check.argv.join(' ');
  if (check.tool && !toolAvailable(check.tool, tree)) return { name: check.name, stage, status: 'unavailable', reason: `tool_missing:${check.tool}`, command };
  const started = Date.now();
  const result = run(tree, check.shell ? ['/bin/sh', '-c', check.shell] : check.argv, { timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL', env: checkEnvironment() });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const log = path.join(repo.state, 'logs', `${plan.id}-${attempt.n}-${check.name}-${stage}.log`);
  writePrivate(log, output);
  const missing = result.error?.code === 'ENOENT' || result.status === 127;
  return {
    name: check.name, stage, status: missing ? 'unavailable' : result.status === 0 ? 'passed' : 'failed',
    ...(missing ? { reason: 'tool_missing' } : {}), ...(result.error?.code === 'ETIMEDOUT' ? { reason: 'timeout' } : {}),
    command, exit_code: result.status, duration_ms: Date.now() - started, log, output_tail: tail(output),
  };
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
// `switchTo(stage)` puts the baseline or the candidate in place and reports success.
function benchmark(tree, switchTo, command, runs) {
  const flag = process.platform === 'darwin' ? '-l' : process.platform === 'linux' ? '-v' : null;
  const timer = flag && fs.existsSync('/usr/bin/time') ? ['/usr/bin/time', flag] : [];
  let state = 'candidate';
  const use = stage => {
    if (stage === state) return true;
    const ok = switchTo(stage);
    if (ok) state = stage;
    return ok;
  };
  const samples = { baseline: [], candidate: [] };
  // Alternating order spreads warm-up and background load across both sides.
  for (let i = 0; i < runs; i++) {
    for (const stage of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      if (!use(stage)) return { runs, improved: false, reason: 'benchmark_setup_failed' };
      const started = process.hrtime.bigint();
      const result = run(tree, [...timer, '/bin/sh', '-c', command], { timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL', env: checkEnvironment() });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (result.status !== 0) { use('candidate'); return { runs, improved: false, reason: `benchmark_failed:${stage}` }; }
      const darwin = result.stderr?.match(/(\d+)\s+maximum resident set size/), linux = result.stderr?.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
      samples[stage].push({ ms, rss: darwin ? Number(darwin[1]) : linux ? Number(linux[1]) * 1024 : null });
    }
  }
  use('candidate');
  const summary = stage => {
    const rss = samples[stage].map(sample => sample.rss);
    return { median_ms: Math.round(median(samples[stage].map(sample => sample.ms))), median_peak_rss_bytes: rss.every(value => value !== null) ? median(rss) : null };
  };
  const baseline = summary('baseline'), candidate = summary('candidate');
  const time = (baseline.median_ms - candidate.median_ms) / baseline.median_ms;
  const memory = baseline.median_peak_rss_bytes && candidate.median_peak_rss_bytes
    ? (baseline.median_peak_rss_bytes - candidate.median_peak_rss_bytes) / baseline.median_peak_rss_bytes : null;
  // Time and memory are judged together: a gain on one side must not cost more than 10% on the other.
  const improved = (time >= 0.05 && (memory === null || memory >= -0.1)) || (memory !== null && memory >= 0.05 && time >= -0.1);
  return { runs, baseline, candidate, time_change_percent: Math.round(-time * 1000) / 10,
    memory_change_percent: memory === null ? null : Math.round(-memory * 1000) / 10, memory_basis: timer.length ? 'peak_rss_of_benchmark_process' : 'unavailable',
    improved, ...(improved ? {} : { reason: 'no_measured_improvement' }) };
}

/** Records the scope and base fingerprints of an authorised change. */
export function planChange(root, { level, files, preserve = [], checks = null, bench = null } = {}) {
  try {
    const repo = repository(root);
    if (!LEVELS.includes(level)) throw Error('invalid_level');
    if (!Array.isArray(files) || !files.length || files.length > 200) throw Error('invalid_scope');
    const scope = [...new Set(files.map(file => scopeFile(repo.root, file)))].sort();
    const kept = preserve.map(item => {
      const [file, name, extra] = String(item).split('#');
      if (!IDENTIFIER.test(name ?? '') || extra !== undefined) throw Error('invalid_preserve');
      return `${scopeFile(repo.root, file)}#${name}`;
    });
    if (checks !== null && (!Array.isArray(checks) || !checks.length || checks.some(check => typeof check !== 'string' || !check.trim()))) throw Error('invalid_check');
    if (bench !== null && (typeof bench !== 'string' || !bench.trim())) throw Error('invalid_benchmark');
    if (git(repo.root, 'rev-parse', '--verify', '--quiet', 'HEAD').status !== 0) throw Error('repository_without_commits');
    const plan = { schema_version: 1, id: randomBytes(8).toString('hex'), created_at: Date.now(), level, files: scope,
      base: fingerprints(repo.root, scope), preserve: kept, checks, bench, attempts: [], applied: null };
    savePlan(repo, plan);
    return { ok: true, plan_id: plan.id, level, files: scope, languages: languagesOf(scope), read_only: level === 'review', record: planFile(repo, plan.id) };
  } catch (error) { return { ok: false, error: error.message }; }
}

/** Builds a patch from proposed full-file contents without touching the user's tree. */
export function candidatePatch(root, id, proposals, out) {
  let work;
  try {
    const repo = repository(root), plan = loadPlan(repo, id);
    const entries = Object.entries(proposals ?? {}).map(([file, proposed]) => [scopeFile(repo.root, file), proposed]).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length || typeof out !== 'string' || !out) throw Error('invalid_proposal');
    const outside = entries.find(([file]) => !plan.files.includes(file));
    if (outside) return { ok: false, error: `out_of_scope:${outside[0]}` };
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'somestoken-candidate-'));
    let patch = '';
    for (const [file, proposed] of entries) {
      const current = path.join(repo.root, file), next = path.join(work, 'new', file), old = path.join(work, 'old', file);
      fs.mkdirSync(path.dirname(next), { recursive: true });
      fs.writeFileSync(next, readPatch(proposed, 'invalid_proposal'));
      const exists = fs.lstatSync(current, { throwIfNoEntry: false })?.isFile();
      if (exists) { fs.mkdirSync(path.dirname(old), { recursive: true }); fs.copyFileSync(current, old); }
      const diff = run(work, ['git', 'diff', '--no-index', '--no-renames', '--binary', '--', exists ? `old/${file}` : '/dev/null', `new/${file}`]);
      if (diff.status > 1) throw Error('diff_failed'); // 1 only means "files differ"
      // Rewrite the per-file header (before the first hunk) to repository paths.
      let header = true;
      patch += diff.stdout.split('\n').map(line => {
        if (line.startsWith('@@') || line.startsWith('GIT binary patch')) header = false;
        if (!header) return line;
        if (line.startsWith('diff --git ')) return `diff --git a/${file} b/${file}`;
        if (line.startsWith('--- ') && line !== '--- /dev/null') return `--- a/${file}`;
        if (line.startsWith('+++ ')) return `+++ b/${file}`;
        return line;
      }).join('\n');
    }
    fs.writeFileSync(out, patch, { mode: 0o600 });
    return { ok: true, patch: out, files: entries.map(([file]) => file) };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { if (work) fs.rmSync(work, { recursive: true, force: true }); }
}

/** Verifies one candidate diff in isolation; every attempt is retained in the plan. */
export function verifyChange(root, id, patchFile, { benchRuns = 3 } = {}) {
  let repo, plan, patch;
  // Checks run in another directory, so a relative patch path is fixed to the caller's.
  patchFile = typeof patchFile === 'string' && patchFile ? path.resolve(patchFile) : patchFile;
  try { repo = repository(root); plan = loadPlan(repo, id); patch = readPatch(patchFile); }
  catch (error) { return { ok: false, error: error.message }; }
  const started = Date.now(), missing = [];
  const attempt = { n: plan.attempts.length + 1, patch_sha256: sha256(patch), started_at: started, reasons: [], checks: [] };
  const finish = verdict => {
    Object.assign(attempt, { verdict, duration_ms: Date.now() - started });
    plan.attempts.push(attempt);
    savePlan(repo, plan);
    return { ok: verdict === 'verified', plan_id: plan.id, attempt: attempt.n, verdict, reasons: attempt.reasons, checks: attempt.checks,
      ...(attempt.preserved ? { preserved: attempt.preserved } : {}), ...(attempt.architecture ? { architecture: attempt.architecture } : {}),
      ...(attempt.benchmark ? { benchmark: attempt.benchmark } : {}), duration_ms: attempt.duration_ms };
  };
  const reject = (...reasons) => { attempt.reasons.push(...reasons); return finish('rejected'); };
  if (plan.level === 'review') return reject('review_is_read_only');
  const stats = patchStats(repo.root, patchFile);
  if (!stats || !stats.changed) return reject(patch.length && !stats ? 'patch_unreadable' : 'empty_patch');
  const outside = stats.files.filter(file => !plan.files.includes(file));
  if (outside.length) return reject(...outside.map(file => `out_of_scope:${file}`));
  if (!same(fingerprints(repo.root, plan.files), plan.base)) return reject('stale_source');
  let isolated;
  try {
    isolated = isolate(repo.root);
    const tree = isolated.tree, languages = languagesOf(plan.files);
    const before = Object.fromEntries(languages.map(language => [language, importGraph(tree, language)]));
    if (git(tree, 'apply', '--whitespace=nowarn', patchFile).status !== 0) return reject('patch_does_not_apply');
    attempt.candidate = fingerprints(tree, plan.files);
    attempt.preserved = plan.preserve.map(item => ({ item, present: definesSymbol(tree, item) }));
    attempt.reasons.push(...attempt.preserved.filter(item => !item.present).map(item => `required_symbol_removed:${item.item}`));
    const after = Object.fromEntries(languages.map(language => [language, importGraph(tree, language)]));
    const graphed = languages.filter(language => after[language].status !== 'unavailable');
    attempt.architecture = {
      graphs: Object.fromEntries(languages.map(language => [language, after[language].status === 'unavailable' ? `unavailable:${after[language].reason}` : after[language].status])),
      new_cycles: graphed.flatMap(language => newCycles(before[language], after[language])),
      unresolved_dynamic: graphed.reduce((sum, language) => sum + after[language].unresolved_dynamic, 0),
    };
    if (attempt.architecture.new_cycles.length) attempt.reasons.push('new_dependency_cycle');
    if (plan.level === 'architecture' && graphed.length < languages.length || plan.level === 'architecture' && !languages.length) missing.push('architecture_check_unavailable');
    const checks = plan.checks ? plan.checks.map((shell, index) => ({ name: `check_${index + 1}`, shell }))
      : [...new Map(languages.flatMap(language => projectChecks(tree, language)).map(check => [check.argv.join(' '), check])).values()];
    if (!checks.length) missing.push('no_behavior_check');
    for (const check of checks) {
      const result = runCheck(repo, plan, attempt, tree, check, 'candidate');
      attempt.checks.push(result);
      if (result.status === 'unavailable') missing.push(`check_unavailable:${check.name}`);
      if (result.status !== 'failed') continue;
      // The baseline run only classifies the failure; the candidate is rejected either way.
      attempt.reasons.push(`check_failed:${check.name}`);
      git(tree, 'apply', '-R', '--whitespace=nowarn', patchFile);
      const baseline = runCheck(repo, plan, attempt, tree, check, 'baseline');
      attempt.checks.push(baseline);
      attempt.reasons.push(baseline.status === 'passed' ? 'candidate_regression' : 'baseline_failing');
      git(tree, 'apply', '--whitespace=nowarn', patchFile);
    }
    if (plan.level === 'algorithm' && !attempt.reasons.length && !missing.length) {
      if (!plan.bench) missing.push('no_benchmark');
      else {
        attempt.benchmark = benchmark(tree, stage => git(tree, 'apply', ...(stage === 'baseline' ? ['-R'] : []), '--whitespace=nowarn', patchFile).status === 0, plan.bench, benchRuns);
        if (!attempt.benchmark.improved) attempt.reasons.push(attempt.benchmark.reason);
      }
    } else if (plan.level === 'algorithm' && !plan.bench) missing.push('no_benchmark');
  } catch (error) {
    attempt.reasons.push(`verification_error:${error.message}`);
  } finally {
    if (isolated) release(repo.root, isolated);
  }
  if (attempt.reasons.length) return finish('rejected');
  attempt.reasons.push(...missing);
  return finish(missing.length ? 'unverified' : 'verified');
}

/** Applies a verified patch to the scope files if their source is unchanged. */
export function applyChange(root, id, patchFile) {
  try {
    const repo = repository(root), plan = loadPlan(repo, id);
    if (plan.level === 'review') return { ok: false, error: 'review_is_read_only' };
    patchFile = path.resolve(patchFile);
    const hash = sha256(readPatch(patchFile));
    const attempt = plan.attempts.findLast(item => item.patch_sha256 === hash);
    if (attempt?.verdict !== 'verified') return { ok: false, error: 'not_verified' };
    if (!same(fingerprints(repo.root, plan.files), plan.base)) return { ok: false, error: 'stale_source' };
    // git apply is all-or-nothing, so a refused apply leaves every file as it was.
    if (git(repo.root, 'apply', '--whitespace=nowarn', patchFile).status !== 0) return { ok: false, error: 'patch_does_not_apply' };
    const result = fingerprints(repo.root, plan.files);
    plan.applied = { at: Date.now(), patch_sha256: hash, matches_verified: same(result, attempt.candidate) };
    savePlan(repo, plan);
    // No automatic rollback: a mismatch is reported for the user to inspect.
    if (!plan.applied.matches_verified) return { ok: false, error: 'applied_result_mismatch' };
    return { ok: true, applied: plan.files.filter(file => result[file] !== plan.base[file]) };
  } catch (error) { return { ok: false, error: error.message }; }
}

// Tracked files that differ from HEAD; untracked build output is not scope.
function trackedChanges(root) {
  const entries = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=no').stdout.split('\0'), files = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    files.push(entries[i].slice(3));
    if (entries[i][0] === 'R' || entries[i][0] === 'C') files.push(entries[++i]);
  }
  return files;
}
// Untracked, not ignored source files: a new module beside the scope is part of
// the change, so it must be named in the scope like any other file.
const untrackedSources = root => git(root, 'ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0').filter(file => file && languageOf(file));
function latestOpenChange(repo) {
  let latest = null, where = repo.state;
  for (const state of repo.states) {
    try {
      for (const name of fs.readdirSync(path.join(state, 'plans'))) {
        if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
        try {
          const plan = JSON.parse(fs.readFileSync(path.join(state, 'plans', name), 'utf8'));
          if (plan.mode === 'in_place' && !plan.closed && (!latest || plan.created_at > latest.created_at)) { latest = plan; where = state; }
        } catch { /* A damaged record is not an open change. */ }
      }
    } catch { /* No plans here yet. */ }
  }
  repo.state = where;
  return latest;
}

/** Starts an in-place change: the scope, a base copy of each scope file and the base dependency graph. */
// The checks finish runs: the requested commands, or the project's own.
const checksFor = (root, plan) => plan.checks ? plan.checks.map((shell, index) => ({ name: `check_${index + 1}`, shell }))
  : [...new Map(languagesOf(plan.files).flatMap(language => projectChecks(root, language)).map(check => [check.argv.join(' '), check])).values()];

export function startChange(root, options = {}) {
  const planned = planChange(root, options);
  if (!planned.ok) return planned;
  try {
    const repo = repository(root), plan = loadPlan(repo, planned.plan_id), copies = path.join(repo.state, 'baselines', plan.id), modes = [];
    for (const file of plan.files) {
      if (plan.base[file] === 'absent') continue;
      if (plan.base[file] === 'not_a_regular_file') throw Error(`not_a_regular_file:${file}`);
      const stat = fs.lstatSync(path.join(repo.root, file));
      if (!stat.isFile()) throw Error(`not_a_regular_file:${file}`);
      modes.push([file, stat.mode & 0o777]);
      writePrivate(path.join(copies, file), fs.readFileSync(path.join(repo.root, file)));
    }
    Object.assign(plan, { mode: 'in_place', closed: false, untracked_sources: true, base_modes: Object.fromEntries(modes),
      others: fingerprints(repo.root, [...trackedChanges(repo.root), ...untrackedSources(repo.root)].filter(file => !plan.files.includes(file))),
      graphs: plan.level === 'review' ? {} : Object.fromEntries(languagesOf(plan.files).map(language => [language, importGraph(repo.root, language)])) });
    savePlan(repo, plan);
    return { ok: true, plan_id: plan.id, level: plan.level, files: plan.files, read_only: plan.level === 'review',
      checks: plan.level === 'review' ? [] : checksFor(repo.root, plan).map(check => check.shell ?? check.argv.join(' ')) };
  } catch (error) { return { ok: false, error: error.message }; }
}

/**
 * Checks an in-place edit of an open change (the latest one when `id` is
 * omitted). An edit that is not verified is put back to its base copy; a
 * rejected change stays open for another attempt.
 */
export function finishChange(root, id, { benchRuns = 3 } = {}) {
  let repo, plan;
  try { repo = repository(root); plan = id ? loadPlan(repo, id) : latestOpenChange(repo); }
  catch (error) { return { ok: false, error: error.message }; }
  if (!plan) return { ok: false, error: 'no_open_change' };
  if (plan.mode !== 'in_place' || plan.closed) return { ok: false, error: 'change_not_open' };
  try { for (const file of [...plan.files, ...plan.preserve.map(item => item.split('#')[0])]) scopeFile(repo.root, file); }
  catch (error) { return { ok: false, error: error.message }; }
  const copies = path.join(repo.state, 'baselines', plan.id);
  const state = which => Object.fromEntries(plan.files.map(file => {
    if (which === 'base') return [file, plan.base[file] === 'absent' ? null : fs.readFileSync(path.join(copies, file))];
    const stat = fs.lstatSync(path.join(repo.root, file), { throwIfNoEntry: false });
    return [file, !stat ? null : stat.isFile() ? fs.readFileSync(path.join(repo.root, file)) : undefined];
  }));
  const candidateModes = Object.fromEntries(plan.files.map(file => {
    const stat = fs.lstatSync(path.join(repo.root, file), { throwIfNoEntry: false });
    return [file, stat?.isFile() ? stat.mode & 0o777 : undefined];
  }));
  if (plan.base_modes !== undefined && (!plan.base_modes || typeof plan.base_modes !== 'object' || Array.isArray(plan.base_modes))) {
    return { ok: false, error: 'invalid_file_mode' };
  }
  // Legacy plans cannot recover an earlier mode; preserve the current one when available.
  const baseModes = Object.fromEntries(plan.files.filter(file => plan.base[file] !== 'absent').map(file =>
    [file, plan.base_modes === undefined ? candidateModes[file] ?? 0o644 : plan.base_modes[file]]));
  if (Object.values(baseModes).some(mode => !Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
    return { ok: false, error: 'invalid_file_mode' };
  }
  // Validate parents before replacing the leaf itself.
  const write = (contents, modes) => {
    for (const file of plan.files) scopeFile(repo.root, file);
    for (const file of plan.files) {
      if (contents[file] === undefined) continue;
      const target = path.join(repo.root, file);
      fs.rmSync(target, { force: true });
      if (contents[file] !== null) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const fd = fs.openSync(target, 'wx', 0o600);
        try { fs.writeFileSync(fd, contents[file]); fs.fchmodSync(fd, modes[file]); }
        finally { fs.closeSync(fd); }
      }
    }
  };
  const baseline = state('base'), candidate = state('current');
  const started = Date.now(), missing = [];
  const attempt = { n: plan.attempts.length + 1, mode: 'in_place', started_at: started, reasons: [], checks: [], candidate: fingerprints(repo.root, plan.files) };
  const changed = plan.files.filter(file => attempt.candidate[file] !== plan.base[file]
    || (plan.base_modes !== undefined && candidateModes[file] !== baseModes[file]));
  const done = verdict => {
    const restored = verdict !== 'verified' && changed.length > 0;
    try {
      for (const file of plan.files) scopeFile(repo.root, file);
      if (restored) write(baseline, baseModes);
    } catch (error) { return { ok: false, error: error.message }; }
    Object.assign(attempt, { verdict, changed, restored, duration_ms: Date.now() - started });
    plan.attempts.push(attempt);
    if (verdict === 'verified') Object.assign(plan, { closed: true, applied: { at: Date.now(), mode: 'in_place', matches_verified: true } });
    savePlan(repo, plan);
    return { ok: verdict === 'verified', plan_id: plan.id, attempt: attempt.n, verdict, reasons: attempt.reasons, files: changed, restored,
      checks: attempt.checks.map(({ name, stage, status, reason, command, duration_ms, output_tail }) =>
        ({ name, stage, status, ...(reason ? { reason } : {}), command, duration_ms, ...(status === 'failed' ? { output_tail } : {}) })),
      ...(attempt.preserved?.length ? { preserved: attempt.preserved } : {}), ...(attempt.architecture ? { architecture: attempt.architecture } : {}),
      ...(attempt.benchmark ? { benchmark: attempt.benchmark } : {}), duration_ms: attempt.duration_ms };
  };
  const reject = (...reasons) => { attempt.reasons.push(...reasons); return done('rejected'); };
  if (plan.level === 'review') return reject('review_is_read_only');
  if (!changed.length) return reject('empty_change');
  const irregular = plan.files.filter(file => candidate[file] === undefined);
  if (irregular.length) return reject(...irregular.map(file => `not_a_regular_file:${file}`));
  // Plans started before untracked sources were recorded compare tracked files only.
  const others = [...trackedChanges(repo.root), ...(plan.untracked_sources ? untrackedSources(repo.root) : [])]
    .filter(file => !plan.files.includes(file)), now = fingerprints(repo.root, others);
  const outside = others.filter(file => plan.others?.[file] !== now[file]);
  if (outside.length) return reject(...outside.map(file => `out_of_scope:${file}`));
  try {
    const languages = languagesOf(plan.files);
    attempt.preserved = plan.preserve.map(item => ({ item, present: definesSymbol(repo.root, item) }));
    attempt.reasons.push(...attempt.preserved.filter(item => !item.present).map(item => `required_symbol_removed:${item.item}`));
    // The Swift graph comes from Package.swift alone; out-of-scope edits were
    // refused above, so an unscoped manifest still has the graph from start.
    const after = Object.fromEntries(languages.map(language => [language, language === 'swift' && plan.graphs?.swift && !plan.files.includes('Package.swift')
      ? plan.graphs.swift : importGraph(repo.root, language)]));
    const graphed = languages.filter(language => after[language].status !== 'unavailable' && plan.graphs?.[language]);
    attempt.architecture = {
      graphs: Object.fromEntries(languages.map(language => [language, after[language].status === 'unavailable' ? `unavailable:${after[language].reason}` : after[language].status])),
      new_cycles: graphed.flatMap(language => newCycles(plan.graphs[language], after[language])),
      unresolved_dynamic: graphed.reduce((sum, language) => sum + after[language].unresolved_dynamic, 0),
    };
    if (attempt.architecture.new_cycles.length) attempt.reasons.push('new_dependency_cycle');
    if (plan.level === 'architecture' && (graphed.length < languages.length || !languages.length)) missing.push('architecture_check_unavailable');
    if (attempt.reasons.length) return done('rejected');
    const checks = checksFor(repo.root, plan);
    if (!checks.length) missing.push('no_behavior_check');
    for (const check of checks) {
      const result = runCheck(repo, plan, attempt, repo.root, check, 'candidate');
      attempt.checks.push(result);
      if (result.status === 'unavailable') missing.push(`check_unavailable:${check.name}`);
      if (result.status !== 'failed') continue;
      // The baseline run only classifies the failure; the edit is rejected either way.
      attempt.reasons.push(`check_failed:${check.name}`);
      write(baseline, baseModes);
      const base = runCheck(repo, plan, attempt, repo.root, check, 'baseline');
      attempt.checks.push(base);
      attempt.reasons.push(base.status === 'passed' ? 'candidate_regression' : 'baseline_failing');
      write(candidate, candidateModes);
    }
    if (plan.level === 'algorithm' && !attempt.reasons.length && !missing.length) {
      if (!plan.bench) missing.push('no_benchmark');
      else {
        attempt.benchmark = benchmark(repo.root, stage => { write(stage === 'baseline' ? baseline : candidate, stage === 'baseline' ? baseModes : candidateModes); return true; }, plan.bench, benchRuns);
        if (!attempt.benchmark.improved) attempt.reasons.push(attempt.benchmark.reason);
      }
    } else if (plan.level === 'algorithm' && !plan.bench) missing.push('no_benchmark');
  } catch (error) {
    attempt.reasons.push(`verification_error:${error.message}`);
  }
  if (attempt.reasons.length) return done('rejected');
  attempt.reasons.push(...missing);
  return done(missing.length ? 'unverified' : 'verified');
}

/** Plan summary with every retained attempt, for status and cost review. */
export function changeStatus(root, id) {
  try {
    const plan = loadPlan(repository(root), id);
    return { ok: true, plan_id: plan.id, level: plan.level, files: plan.files, preserve: plan.preserve, applied: plan.applied,
      attempts: plan.attempts.map(({ n, verdict, reasons, duration_ms, patch_sha256 }) => ({ n, verdict, reasons, duration_ms, patch_sha256 })),
      total_verification_ms: plan.attempts.reduce((sum, item) => sum + item.duration_ms, 0) };
  } catch (error) { return { ok: false, error: error.message }; }
}
