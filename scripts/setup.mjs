#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { runDoctor } from './doctor.mjs';
import { installMonitor, prepareOfficialInstall, validVersion } from './live-update.mjs';
import { packageArtifactName, readPluginManifest } from './plugin-manifest.mjs';
import { probeCodexCapabilities } from './lib/capabilities.mjs';
import { configuredCodexLedgerRoot } from '../plugins/somestoken/lib/codex-ledger.mjs';
import { configuredClaudeWorkspaceRoot } from '../plugins/somestoken/lib/claude-workspace.mjs';
import { inspectPackageArtifact } from './package.mjs';
import {
  validateHostHooks,
  CODEX_HOOK_EVENTS as PACKAGE_CODEX_HOOK_EVENTS,
  CLAUDE_HOOK_EVENTS as PACKAGE_CLAUDE_HOOK_EVENTS,
} from './package-check.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MARKETPLACE_NAME = 'somestoken-local';
export const PLUGIN_NAME = 'somestoken';
export const PLUGIN_VERSION = readPluginManifest(REPO_ROOT)?.version ?? 'unavailable';
export const HOOK_EVENTS = PACKAGE_CODEX_HOOK_EVENTS;
export const CLAUDE_HOOK_EVENTS = PACKAGE_CLAUDE_HOOK_EVENTS;
// Version 2 adds installation-state outcomes such as `update_required` so
// callers can distinguish a valid repository archive from an older plugin
// that is still installed on the host.
export const SETUP_SCHEMA_VERSION = 2;
export const EXPECTED_HOOK_COMMAND = 'if [ -n "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}" ]; then node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}/hooks/somestoken.mjs"; fi';

const PLUGIN_ROOT = path.join('plugins', 'somestoken');
const HOOKS_FILE = path.join(PLUGIN_ROOT, 'hooks', 'codex-hooks.json');
const CLAUDE_HOOKS_FILE = path.join(PLUGIN_ROOT, 'hooks', 'claude-hooks.json');
const CLAUDE_PLUGIN_ROOT = './plugins/somestoken';
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4096;
const CLAUDE_INVENTORY_OUTPUT_LIMIT = 1024 * 1024;
const MANUAL_STEPS = [
  { name: 'hook_trust', status: 'manual', detail: 'host review and trust flow required; no trust bypass used' },
  { name: 'desktop_surface', status: 'manual', detail: 'desktop plugin and hook UI review remains host-owned' },
];
const CLAUDE_RELOAD_STEP = { name: 'claude_reload', status: 'manual', detail: 'restart Claude Code or start a fresh session after plugin install/update/enable; this is required when in-session plugin reload is unavailable' };
const CLAUDE_INSTALL_STEPS = [
  { name: 'claude_marketplace_source', status: 'manual', detail: 'enter only the repository path at the marketplace source prompt; do not paste later commands' },
  { name: 'claude_plugin_install', status: 'manual', detail: 'run /plugin install somestoken@somestoken-local after the marketplace command completes' },
  CLAUDE_RELOAD_STEP,
];

function check(name, status, detail) {
  return { name, status, detail };
}

function claudeManualSteps(state, scope) {
  if (state === 'install_required') return CLAUDE_INSTALL_STEPS;
  if (state === 'update_required' && scope) return [
    check('claude_marketplace_update', 'manual', 'run claude plugin marketplace update somestoken-local'),
    check('claude_plugin_update', 'manual', `then run claude plugin update somestoken@somestoken-local --scope ${scope}`),
    CLAUDE_RELOAD_STEP,
  ];
  if (state === 'enable_required' && scope) return [
    check('claude_plugin_enable', 'manual', `run claude plugin enable somestoken@somestoken-local --scope ${scope}`),
    CLAUDE_RELOAD_STEP,
  ];
  if (state === 'installed') return [CLAUDE_RELOAD_STEP];
  return [check('claude_plugin_inventory', 'manual', 'run claude plugin list --json and inspect the exact somestoken@somestoken-local identity, version, enabled flag and scope before choosing an installation action; managed installations require administrator review')];
}

function summary(checks) {
  const result = {
    pass: checks.filter((entry) => entry.status === 'pass').length,
    fail: checks.filter((entry) => entry.status === 'fail').length,
    unavailable: checks.filter((entry) => entry.status === 'unavailable').length,
    manual: checks.filter((entry) => entry.status === 'manual').length,
  };
  result.total = checks.length;
  result.ok = result.fail === 0;
  return result;
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readJson(root, relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  } catch {
    return null;
  }
}

function packageChecksum(root, host, manifest, claudeManifest) {
  const result = inspectPackageArtifact(root, host);
  const hostArchive = packageArtifactName(host === 'claude' ? claudeManifest : manifest)
    ?.replace(/^somestoken-/, `somestoken-${host}-`);
  const missingArchive = [packageArtifactName(manifest), hostArchive].filter(Boolean).some((name) => {
    try {
      fs.lstatSync(path.join(root, PLUGIN_ROOT, 'dist', name));
      return false;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  });
  return {
    actual: result.actual,
    expected: result.expected,
    valid: result.valid && !missingArchive,
    missing_archive: missingArchive,
    checksum_matches: result.checksum_matches,
    source_matches: result.source_matches,
  };
}

function inspectPackage(root, host = 'codex') {
  const manifest = readPluginManifest(root);
  const claudeManifest = readJson(root, path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const isClaude = host === 'claude';
  const hookFile = isClaude ? CLAUDE_HOOKS_FILE : HOOKS_FILE;
  const hookEvents = isClaude ? CLAUDE_HOOK_EVENTS : HOOK_EVENTS;
  const fingerprint = {
    marketplace_name: MARKETPLACE_NAME,
    plugin_name: PLUGIN_NAME,
    plugin_version: isClaude ? claudeManifest?.version ?? 'unavailable' : manifest?.version ?? 'unavailable',
    package_sha256: null,
    hook_fingerprint: null,
    hook_events: [...hookEvents],
  };
  const checks = [];
  const checksum = packageChecksum(root, host, manifest, claudeManifest);
  const doctor = runDoctor(root, { checkCodex: false });
  checks.push(check(
    'package_validation',
    doctor.summary.fail === 0 ? 'pass' : 'fail',
    doctor.summary.fail === 0 ? 'repository package and manifests validated' : 'repository package validation failed',
  ));

  const marketplace = readJson(root, '.agents/plugins/marketplace.json');
  const plugin = readJson(root, path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'));
  const identityValid = marketplace?.name === MARKETPLACE_NAME
    && plugin?.name === PLUGIN_NAME
    && plugin?.version === manifest?.version
    && Array.isArray(marketplace?.plugins)
    && marketplace.plugins.length === 1
    && marketplace.plugins[0]?.name === PLUGIN_NAME
    && marketplace.plugins[0]?.source?.source === 'local'
    && marketplace.plugins[0]?.source?.path === './plugins/somestoken';
  checks.push(check(
    'package_identity',
    identityValid ? 'pass' : 'fail',
    identityValid ? 'exact marketplace and plugin identity' : 'package identity mismatch',
  ));

  fingerprint.package_sha256 = checksum.actual;
  checks.push({
    ...check(
      'package_digest',
      checksum.valid ? 'pass' : 'fail',
      checksum.valid
        ? 'production archive matches SHA256SUMS and current source'
        : checksum.missing_archive
          ? 'production archive missing; run npm run build'
          : checksum.checksum_matches
            ? 'production archive is stale for current source; run npm run build'
            : 'production archive digest mismatch',
    ),
    ...(checksum.missing_archive ? { reason: 'archive_missing', action: 'npm run build' } : {}),
  });

  const hooks = readJson(root, hookFile);
  const hookShapeValid = validateHostHooks(hooks, host).length === 0;
  if (hookShapeValid) {
    fingerprint.hook_fingerprint = digest(Buffer.concat([
      fs.readFileSync(path.join(root, hookFile)),
      Buffer.from(checksum.actual ?? ''),
    ]));
  }
  checks.push(check(
    'hook_definition',
    hookShapeValid ? 'pass' : 'fail',
    hookShapeValid ? 'lifecycle hook definition validated' : 'lifecycle hook definition mismatch',
  ));
  return { fingerprint, checks };
}

function runCommand(command, args, root, env, marker) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
  });
  if (result.error?.code === 'ENOENT') return { status: 'unavailable', marker: false, exitCode: null };
  const output = [result.stdout ?? '', result.stderr ?? ''].join('').slice(0, OUTPUT_LIMIT);
  const markerPresent = !marker || output.includes(marker);
  return {
    status: result.status === 0 && markerPresent ? 'pass' : 'fail',
    marker: markerPresent,
    exitCode: result.status,
  };
}

function addManualChecks(checks) {
  checks.push(...MANUAL_STEPS.map((entry) => ({ ...entry })));
}

function baseResult(fingerprint, checks, state, options = {}) {
  const host = options.host || 'codex';
  const manualSteps = options.manualSteps || MANUAL_STEPS;
  return {
    schema_version: SETUP_SCHEMA_VERSION,
    host,
    state,
    marketplace: MARKETPLACE_NAME,
    plugin: { name: PLUGIN_NAME, version: options.pluginVersion ?? fingerprint.plugin_version ?? PLUGIN_VERSION },
    fingerprint,
    checks,
    manual_steps: manualSteps.map((entry) => entry.name),
    summary: summary(checks),
  };
}

function codexVersionCheck(command, root, env, checks) {
  const capability = probeCodexCapabilities(command, root, env);
  const version = {
    status: capability.codex_version ? 'pass' : capability.status === 'unavailable' ? 'unavailable' : 'fail',
  };
  checks.push(check(
    'codex_cli',
    version.status,
    version.status === 'pass' ? 'Codex CLI version observed' : version.status === 'unavailable' ? 'Codex CLI is not installed' : 'Codex CLI version check failed',
  ));
  checks.push(check(
    'codex_capabilities',
    version.status,
    version.status === 'pass' ? 'Version observed; model/reasoning remain hook-sourced' : version.status === 'unavailable' ? 'Codex capability probe unavailable' : 'Codex capability probe failed',
  ));
  return version.status;
}

/**
 * Read the host's own plugin inventory after package validation. This is
 * intentionally observation-only: it never exposes the returned source path,
 * changes an installation, or infers hook trust. A repository artifact can be
 * valid while Codex is still running an older installed version.
 */
function installedCodexPluginCheck(command, root, env, checks, expectedVersion) {
  const result = spawnSync(command, ['plugin', 'list', '--marketplace', MARKETPLACE_NAME, '--json'], {
    cwd: root,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
  });
  if (result.error?.code === 'ENOENT' || result.status !== 0) {
    checks.push(check('installed_plugin_identity', 'unavailable', 'installed plugin inventory is unavailable; repository package remains independently verified'));
    return 'installation_unavailable';
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout ?? '');
  } catch {
    checks.push(check('installed_plugin_identity', 'unavailable', 'installed plugin inventory is unreadable; repository package remains independently verified'));
    return 'installation_unavailable';
  }
  const installed = Array.isArray(payload?.installed) ? payload.installed : [];
  const entry = installed.find((candidate) => candidate
    && candidate.name === PLUGIN_NAME
    && candidate.marketplaceName === MARKETPLACE_NAME);
  if (!entry || entry.installed !== true) {
    checks.push(check('installed_plugin_identity', 'manual', 'SomesToken is not installed in the host inventory'));
    return 'install_required';
  }
  if (entry.enabled !== true) {
    checks.push(check('installed_plugin_identity', 'manual', 'SomesToken is installed but not enabled in the host inventory'));
    return 'enable_required';
  }
  if (entry.version !== expectedVersion) {
    checks.push(check('installed_plugin_identity', 'manual', 'installed SomesToken version differs from the repository artifact'));
    return 'update_required';
  }
  checks.push(check('installed_plugin_identity', 'pass', 'installed SomesToken identity matches the repository artifact'));
  return 'ready';
}

function installedClaudePluginCheck(command, root, env, checks, expectedVersion) {
  const result = spawnSync(command, ['plugin', 'list', '--json'], {
    cwd: root,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: CLAUDE_INVENTORY_OUTPUT_LIMIT,
  });
  if (result.error || result.status !== 0) {
    checks.push(check('claude_plugin_discovery', 'unavailable', 'Claude plugin inventory is unavailable; repository package remains independently verified'));
    return { state: 'unavailable' };
  }
  let entries;
  try {
    const payload = JSON.parse(result.stdout ?? '');
    if (!Array.isArray(payload) || !payload.every((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0)) throw new Error('invalid inventory');
    entries = payload.filter((entry) => entry.id === `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    if (entries.some((entry) => !validVersion(entry.version) || typeof entry.enabled !== 'boolean')) throw new Error('invalid plugin identity');
  } catch {
    checks.push(check('claude_plugin_discovery', 'unavailable', 'Claude plugin inventory is unreadable; repository package remains independently verified'));
    return { state: 'unavailable' };
  }
  if (entries.length > 1) {
    checks.push(check('claude_plugin_discovery', 'unavailable', 'Claude plugin inventory has ambiguous SomesToken installations; review the active installation scope'));
    return { state: 'unavailable' };
  }
  const entry = entries[0];
  if (!entry) {
    checks.push(check('claude_plugin_discovery', 'manual', 'SomesToken from the expected marketplace is not installed in the Claude inventory'));
    return { state: 'install_required' };
  }
  const scope = ['user', 'project', 'local'].includes(entry.scope) ? entry.scope : null;
  if (entry.version !== expectedVersion) {
    checks.push(check('claude_plugin_discovery', 'manual', 'installed SomesToken version differs from the repository artifact; update the Claude plugin'));
    return { state: 'update_required', scope };
  }
  if (!entry.enabled) {
    checks.push(check('claude_plugin_discovery', 'manual', 'SomesToken is installed but not enabled in the Claude inventory'));
    return { state: 'enable_required', scope };
  }
  checks.push(check('claude_plugin_discovery', 'pass', 'installed SomesToken identity and version match the repository artifact'));
  return { state: 'installed' };
}

function installationStep(command, checks, name, args, root, env, marker) {
  const result = runCommand(command, args, root, env, marker);
  const detail = result.status === 'pass'
    ? 'Codex lifecycle command completed'
    : result.status === 'unavailable'
      ? 'Codex CLI is not installed'
      : 'Codex lifecycle command failed';
  checks.push(check(name, result.status, detail));
  return result.status === 'pass';
}

function claudeObservation(command, checks, name, args, root, env, marker, passDetail, missingDetail) {
  const result = runCommand(command, args, root, env, marker);
  if (result.status === 'unavailable') {
    checks.push(check(name, 'unavailable', 'Claude CLI is not installed'));
    return 'unavailable';
  }
  if (result.status === 'pass') {
    checks.push(check(name, 'pass', passDetail));
    return 'pass';
  }
  if (result.exitCode === 0 && !result.marker) {
    checks.push(check(name, 'manual', missingDetail));
    return 'manual';
  }
  checks.push(check(name, 'fail', 'Claude CLI check failed'));
  return 'fail';
}

function runClaudeSetup(options, root, cwd, env) {
  const checks = [];
  const inspected = inspectPackage(root, 'claude');
  checks.push(check(
    'repository_root',
    cwd === root ? 'pass' : 'fail',
    cwd === root ? 'running from SomesToken repository root' : 'run this command from the SomesToken repository root',
  ));
  checks.push(...inspected.checks);
  const claudeManifest = readJson(root, path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const baseOptions = { host: 'claude', manualSteps: [], pluginVersion: claudeManifest?.version ?? 'unavailable' };

  if (cwd !== root) return baseResult(inspected.fingerprint, checks, 'blocked', baseOptions);
  if (checks.some((entry) => entry.status === 'fail')) return baseResult(inspected.fingerprint, checks, 'blocked', baseOptions);

  const claudeCommand = options.claudeCommand || 'claude';
  const validation = claudeObservation(
    claudeCommand,
    checks,
    'claude_plugin_validation',
    ['plugin', 'validate', CLAUDE_PLUGIN_ROOT, '--strict'],
    root,
    env,
    'Validation passed',
    'Claude plugin manifest validated',
  );
  if (validation === 'unavailable') return baseResult(inspected.fingerprint, checks, 'unavailable', baseOptions);
  if (validation !== 'pass') return baseResult(inspected.fingerprint, checks, 'blocked', baseOptions);

  const { state, scope } = installedClaudePluginCheck(claudeCommand, root, env, checks, baseOptions.pluginVersion);
  const manualSteps = claudeManualSteps(state, scope);
  checks.push(...manualSteps);
  return baseResult(inspected.fingerprint, checks, state, { ...baseOptions, manualSteps });
}

const COLLECTOR_LABEL = 'com.somestr.somestoken.monitor';

// The macOS collector job runs this checkout's monitor every 30 seconds for either host.
function runCollectorSetup(options, root, env) {
  const base = { schema_version: SETUP_SCHEMA_VERSION, mode: 'collector', label: COLLECTOR_LABEL, source: path.join(root, PLUGIN_ROOT) };
  if ((options.platform ?? process.platform) !== 'darwin') return { ...base, state: 'unsupported_platform', summary: { ok: false } };
  const home = env.HOME || os.homedir();
  // npm run prepends node_modules/.bin directories; keep the user's own PATH, which finds node and codex.
  const paths = (env.PATH || '').split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !entry.split(path.sep).includes('node_modules') && fs.existsSync(entry));
  // A PATH entry such as /opt/homebrew/bin/node keeps working after a Node upgrade; the resolved path does not.
  const node = paths.map((entry) => path.join(entry, 'node')).find((candidate) => {
    try { return fs.realpathSync(candidate) === fs.realpathSync(process.execPath); } catch { return false; }
  }) ?? process.execPath;
  const environment = { ...(paths.length ? { PATH: paths.join(path.delimiter) } : {}), HOME: home, ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}) };
  // The collector exits at start until a source is opted in; check with the environment the job will have.
  if (!configuredCodexLedgerRoot(environment) && !configuredClaudeWorkspaceRoot(environment)) return { ...base, state: 'not_enabled', summary: { ok: false } };
  try {
    const result = (options.installMonitor ?? installMonitor)(path.join(home, 'Library/LaunchAgents', COLLECTOR_LABEL + '.plist'), base.source, {
      executable: node,
      environment,
      logs: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'somestoken'),
    });
    const state = result.monitor_install === 'started' ? 'installed' : result.monitor_install;
    return { ...base, state, summary: { ok: state === 'installed' || state === 'existing' } };
  } catch (error) {
    return { ...base, state: 'failed', reason: /^[a-z_]+$/.test(error.message) ? error.message : 'monitor_install_failed', summary: { ok: false } };
  }
}

export function runSetup(options = {}) {
  const mode = options.mode ?? 'check', host = options.host ?? 'codex';
  if (!['check', 'apply', 'verify', 'collector'].includes(mode)) throw new Error('unsupported setup mode');
  if (!['codex', 'claude'].includes(host)) throw new Error('unsupported host');
  const root = path.resolve(options.root || REPO_ROOT);
  const env = { ...process.env, ...(options.env || {}) };
  if (mode === 'collector') return runCollectorSetup(options, root, env);
  if (host === 'claude' && mode !== 'check') throw new Error('Claude host supports check only');
  const cwd = path.resolve(options.cwd || process.cwd());
  const codexCommand = options.codexCommand || 'codex';
  if (host === 'claude') return runClaudeSetup(options, root, cwd, env);
  const checks = [];
  const inspected = inspectPackage(root);
  checks.push(check(
    'repository_root',
    cwd === root ? 'pass' : 'fail',
    cwd === root ? 'running from SomesToken repository root' : 'run this command from the SomesToken repository root',
  ));
  checks.push(...inspected.checks);

  if (cwd !== root) return baseResult(inspected.fingerprint, checks, 'blocked');
  if (checks.some((entry) => entry.status === 'fail')) return baseResult(inspected.fingerprint, checks, 'blocked');

  const versionStatus = codexVersionCheck(codexCommand, root, env, checks);
  if (versionStatus === 'unavailable') return baseResult(inspected.fingerprint, checks, 'unavailable');
  if (versionStatus !== 'pass') return baseResult(inspected.fingerprint, checks, 'blocked');

  if (mode === 'check') {
    const installationState = installedCodexPluginCheck(codexCommand, root, env, checks, inspected.fingerprint.plugin_version);
    addManualChecks(checks);
    return baseResult(inspected.fingerprint, checks, installationState);
  }

  if (mode === 'verify') {
    const discovered = installationStep(codexCommand, checks, 'plugin_discovery', ['plugin', 'list', '--marketplace', MARKETPLACE_NAME], root, env, PLUGIN_NAME);
    addManualChecks(checks);
    return baseResult(inspected.fingerprint, checks, discovered ? 'trust_required' : 'blocked');
  }

  // Preserve compatibility registrations across the official installer's cache replacement.
  // Only maintain an existing opt-in live installation; setup does not create one.
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  const liveRegistry = path.join(codexHome, 'somestoken/live-update.json');
  let compatibility = null;
  try {
    const registryStat = fs.lstatSync(liveRegistry);
    if (!registryStat.isFile() || registryStat.isSymbolicLink()) throw new Error('invalid_registry');
    const prior = JSON.parse(fs.readFileSync(liveRegistry, 'utf8'));
    compatibility = (Array.isArray(prior.compat_versions) ? prior.compat_versions : []).filter(validVersion);
    const cache = path.join(codexHome, 'plugins/cache/somestoken-local/somestoken');
    if (fs.existsSync(cache)) compatibility.push(...fs.readdirSync(cache).filter(validVersion));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      checks.push(check('live_compatibility', 'fail', 'existing compatibility registration is invalid'));
      return baseResult(inspected.fingerprint, checks, 'blocked');
    }
  }
  const steps = [
    ['marketplace_add', ['plugin', 'marketplace', 'add', '.']],
    ['marketplace_discovery', ['plugin', 'marketplace', 'list'], MARKETPLACE_NAME],
    ['plugin_discovery', ['plugin', 'list', '--marketplace', MARKETPLACE_NAME], PLUGIN_NAME],
    ['plugin_install', ['plugin', 'add', PLUGIN_NAME + '@' + MARKETPLACE_NAME]],
    ['plugin_discovery_after_install', ['plugin', 'list', '--marketplace', MARKETPLACE_NAME], PLUGIN_NAME],
  ];
  const liveOptions = { home: env.HOME || os.homedir(), codexHome, source: path.join(root, PLUGIN_ROOT), compat: compatibility || [] };
  for (const [name, args, marker] of steps) {
    let recovery = null;
    if (name === 'plugin_install' && compatibility !== null) {
      try { recovery = prepareOfficialInstall(liveOptions); }
      catch {
        checks.push(check('live_compatibility', 'fail', 'compatibility preflight failed; official plugin install was not started'));
        addManualChecks(checks);
        return baseResult(inspected.fingerprint, checks, 'blocked');
      }
    }
    if (!installationStep(codexCommand, checks, name, args, root, env, marker)) {
      const restored = recovery?.rollback();
      addManualChecks(checks);
      return { ...baseResult(inspected.fingerprint, checks, checks.some((entry) => entry.status === 'unavailable') ? 'unavailable' : 'blocked'), ...(restored ? { live_update: { rollback_status: restored.rollback_status, active_version: restored.active_version } } : {}) };
    }
    if (recovery) {
      try {
        recovery.refresh();
        recovery.commit();
        checks.push(check('live_compatibility', 'pass', 'compatibility paths verified and refreshed; loaded MCP reload remains host-owned'));
      } catch (error) {
        const restored = recovery.rollback();
        checks.push(check('live_compatibility', 'fail', 'official installation or compatibility refresh failed; previous installation recovery attempted'));
        addManualChecks(checks);
        return { ...baseResult(inspected.fingerprint, checks, 'blocked'), live_update: { rollback_status: error.result?.rollback_status === 'failed' ? 'failed' : restored.rollback_status, active_version: restored.active_version } };
      }
    }
  }
  addManualChecks(checks);
  return baseResult(inspected.fingerprint, checks, 'trust_required');
}

export function parseSetupArgs(argv = []) {
  const modes = [];
  let json = false;
  let codexCommand = 'codex';
  let claudeCommand = 'claude';
  let host = 'codex';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') modes.push('check');
    else if (arg === '--apply') modes.push('apply');
    else if (arg === '--verify') modes.push('verify');
    else if (arg === '--collector') modes.push('collector');
    else if (arg === '--json') json = true;
    else if (arg === '--codex-command') {
      codexCommand = argv[index + 1];
      if (!codexCommand || codexCommand.startsWith('--')) throw new Error('missing Codex command');
      index += 1;
    } else if (arg.startsWith('--codex-command=')) {
      codexCommand = arg.slice('--codex-command='.length);
      if (!codexCommand) throw new Error('missing Codex command');
    } else if (arg === '--claude-command') {
      claudeCommand = argv[index + 1];
      if (!claudeCommand || claudeCommand.startsWith('--')) throw new Error('missing Claude command');
      index += 1;
    } else if (arg.startsWith('--claude-command=')) {
      claudeCommand = arg.slice('--claude-command='.length);
      if (!claudeCommand) throw new Error('missing Claude command');
    } else if (arg === '--host') {
      host = argv[index + 1];
      if (!host || host.startsWith('--')) throw new Error('missing host');
      index += 1;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
      if (!host) throw new Error('missing host');
    } else {
      throw new Error('unknown setup argument');
    }
  }
  if (new Set(modes).size > 1) throw new Error('choose one setup mode');
  if (!['codex', 'claude'].includes(host)) throw new Error('unsupported host');
  const mode = modes[0] || 'check';
  if (host === 'claude' && mode !== 'check' && mode !== 'collector') throw new Error('Claude host supports --check only');
  return { mode, json, codexCommand, claudeCommand, host };
}

const COLLECTOR_NEXT = {
  installed: 'NEXT verify: complete a task, then run node plugins/somestoken/bin/report.mjs --diagnostics --json',
  existing: 'An existing collector job was found and left unchanged.',
  existing_unloaded: 'NEXT load: launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/' + COLLECTOR_LABEL + '.plist',
  not_enabled: 'NEXT consent: the collector reads session history only with your consent. Codex: node plugins/somestoken/bin/report.mjs --enable-codex-ledger="$HOME/.codex/sessions"; Claude Code: node plugins/somestoken/bin/report.mjs --enable-claude-feed; then run npm run setup -- --collector again',
  unsupported_platform: 'NEXT collector: automatic setup supports macOS only; run node plugins/somestoken/bin/monitor.mjs --watch instead',
  failed: 'NEXT collector: nothing was left installed; run node plugins/somestoken/bin/monitor.mjs --watch instead',
};

export function formatSetup(result, json = false) {
  if (json) return JSON.stringify(result) + '\n';
  if (result.mode === 'collector') {
    const detail = result.state === 'installed' ? ' · ' + result.label + ' runs ' + result.source + '/bin/monitor.mjs every 30 s' : result.reason ? ' · ' + result.reason : '';
    return 'SomesToken setup · collector=' + result.state + detail + '\n' + COLLECTOR_NEXT[result.state] + '\n';
  }
  if (result.host === 'claude') {
    const lines = [
      'SomesToken setup · host=claude · state=' + result.state,
      'Plugin ' + result.plugin.name + '@' + result.plugin.version + ' · marketplace ' + result.marketplace,
      'Artifact ' + (result.fingerprint.package_sha256 ?? 'unavailable') + ' · hooks ' + (result.fingerprint.hook_fingerprint ?? 'unavailable'),
      ...result.checks.map((entry) => entry.status.toUpperCase() + ' ' + entry.name + ': ' + entry.detail),
      ...result.checks.filter((entry) => result.manual_steps.includes(entry.name)).map((entry) => 'NEXT ' + entry.name + ': ' + entry.detail),
      'SUMMARY pass=' + result.summary.pass + ' fail=' + result.summary.fail + ' unavailable=' + result.summary.unavailable + ' manual=' + result.summary.manual,
    ];
    return lines.join('\n') + '\n';
  }
  const lines = [
    'SomesToken setup · state=' + result.state,
    'Plugin ' + result.plugin.name + '@' + result.plugin.version + ' · marketplace ' + result.marketplace,
    'Artifact ' + (result.fingerprint.package_sha256 ?? 'unavailable') + ' · hooks ' + (result.fingerprint.hook_fingerprint ?? 'unavailable'),
    ...result.checks.map((entry) => entry.status.toUpperCase() + ' ' + entry.name + ': ' + entry.detail),
    ...(result.state === 'update_required' ? ['NEXT plugin_update: run npm run setup -- --apply, then review hook trust in Codex'] : []),
    ...(result.state === 'install_required' ? ['NEXT plugin_install: run npm run setup -- --apply, then review hook trust in Codex'] : []),
    ...(result.state === 'enable_required' ? ['NEXT plugin_enable: enable SomesToken in Codex, then review hook trust'] : []),
    'NEXT hook_trust: review and trust SomesToken lifecycle hooks in the Codex host surface',
    'NEXT desktop_surface: complete desktop plugin and hook review in the ChatGPT Codex surface',
    'SUMMARY pass=' + result.summary.pass + ' fail=' + result.summary.fail + ' unavailable=' + result.summary.unavailable + ' manual=' + result.summary.manual,
  ];
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseSetupArgs(process.argv.slice(2));
  } catch {
    process.stdout.write('SomesToken setup · invalid arguments\n');
    process.exitCode = 2;
  }
  if (args) {
    const result = runSetup({ mode: args.mode, codexCommand: args.codexCommand, claudeCommand: args.claudeCommand, host: args.host });
    process.stdout.write(formatSetup(result, args.json));
    process.exitCode = result.summary.ok ? 0 : 1;
  }
}
