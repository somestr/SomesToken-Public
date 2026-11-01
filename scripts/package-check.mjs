#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { packageArtifactName, readPluginManifest, readPackageFile } from './plugin-manifest.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function archivePathFor(root = REPO_ROOT) {
  const archiveName = packageArtifactName(readPluginManifest(root));
  return archiveName ? path.join(root, 'plugins', 'somestoken', 'dist', archiveName) : null;
}

export const ARCHIVE_PATH = archivePathFor(REPO_ROOT);
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 256;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

// The complete release boundary: new runtime files require an explicit addition here.
export const REQUIRED_ENTRIES = Object.freeze([
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'claude.mcp.json',
  'hooks/codex-hooks.json',
  'hooks/claude-hooks.json',
  'hooks/somestoken.mjs',
  'lib/core.mjs',
  'lib/runtime.mjs',
  'lib/runtime/hot-path.mjs',
  'lib/runtime/state-store.mjs',
  'lib/telemetry-outcomes.mjs',
  'lib/savings.mjs',
  'lib/reporting.mjs',
  'lib/workflow-advisor.mjs',
  'lib/routing.mjs',
  'lib/profiles.mjs',
  'lib/profile-telemetry.mjs',
  'lib/fast-mode.mjs',
  'lib/public-bridge.mjs',
  'lib/public/schema.mjs',
  'lib/public/validate.mjs',
  'lib/public/build.mjs',
  'lib/public/write.mjs',
  'lib/public/read.mjs',
  'lib/public/evidence.mjs',
  'lib/report-adapter.mjs',
  'lib/workspace-diagnostics.mjs',
  'lib/freshness.mjs',
  'lib/usage/schema.mjs',
  'lib/usage/credits.mjs',
  'lib/usage/plans.mjs',
  'lib/usage/policy-profiles.mjs',
  'lib/usage/quota-snapshots.mjs',
  'lib/usage/comparison.mjs',
  'lib/usage/budgets.mjs',
  'lib/usage/config.mjs',
  'lib/efficiency/schema.mjs',
  'lib/efficiency/capabilities.mjs',
  'lib/efficiency/provenance.mjs',
  'lib/efficiency/sessions.mjs',
  'lib/efficiency/metrics.mjs',
  'lib/efficiency/recommendations.mjs',
  'lib/efficiency/acceptance.mjs',
  'lib/efficiency/signals.mjs',
  'lib/efficiency/classifier.mjs',
  'lib/efficiency/detector.mjs',
  'lib/optimization/schema.mjs',
  'lib/optimization/active-policy.mjs',
  'lib/optimization/lifecycle-checks.mjs',
  'lib/optimization/pilot.mjs',
  'lib/optimization/completed-work.mjs',
  'lib/optimization/tool-output.mjs',
  'lib/optimization/test-report-formats.mjs',
  'lib/optimization/output-accounting.mjs',
  'lib/optimization/output-command.mjs',
  'lib/optimization/output-guard.mjs',
  'lib/optimization/node-test-compact-reporter.mjs',
  'lib/optimization/gates.mjs',
  'lib/optimization/goal-hygiene.mjs',
  'lib/optimization/experiments.mjs',
  'lib/optimization/quota-study.mjs',
  'lib/optimization/pairing.mjs',
  'lib/optimization/reductions.mjs',
  'lib/optimization/shadow-policy.mjs',
  'lib/optimization/calibration.mjs',
  'lib/optimization/certification.mjs',
  'lib/hosts/codex.mjs',
  'lib/hosts/codex-app-server.mjs',
  'lib/hosts/claude-code.mjs',
  'lib/limit-recovery/state.mjs',
  'lib/limit-recovery/controller.mjs',
  'lib/limit-recovery/transport.mjs',
  'lib/hosts/claude-statusline.mjs',
  'mcp/server.mjs',
  'bin/report.mjs',
  'bin/optimization.mjs',
  'bin/console.mjs',
  'bin/statusline.mjs',
  'bin/evidence.mjs',
  'bin/change.mjs',
  'lib/change/imports.mjs',
  'lib/change/toolchain.mjs',
  'lib/change/workflow.mjs',
  'bin/handoff.mjs',
  'lib/handoff/hook.mjs',
  'lib/handoff/note.mjs',
  'lib/handoff/quota.mjs',
  'lib/handoff/state.mjs',
  'skills/somestoken-quota-handoff/SKILL.md',
  'skills/somestoken/SKILL.md',
  'skills/somestoken/references/optimization.md',
  'skills/somestoken-code/SKILL.md',
  'skills/somestoken-code/references/contracts.md',
  'skills/somestoken-code/references/languages/swift.md',
  'skills/somestoken-code/references/languages/python.md',
  'skills/somestoken-code/references/languages/go.md',
  'skills/somestoken-code/references/languages/java.md',
  'skills/somestoken-code/references/languages/javascript.md',
  'LICENSE',
  'assets/somestoken-icon.png',
  'bin/codex-limit-recovery.mjs',
  'bin/monitor.mjs',
  'lib/claude-capture.mjs',
  'lib/consumption.mjs',
  'lib/claude-workspace.mjs',
  'lib/capture-timings.mjs',
  'lib/codex-ledger.mjs',
  'lib/zstd-stream.mjs',
  'lib/host-paths.mjs',
  'lib/hot-events.mjs',
  'lib/monitor-lock.mjs',
  'lib/monitor-inputs.mjs',
  'lib/usage/forecast.mjs',
  'lib/usage/model-costs.mjs',
  'lib/usage/task-rates.mjs',
  'lib/version.mjs',
  'lib/workspace-usage.mjs',
  'lib/workspace-store.mjs',
  'lib/task-profiles.mjs',
  'lib/workspace-worker.mjs',
  'lib/workspace-stream.mjs',
]);
const HOST_EXCLUDED_ENTRIES = Object.freeze({
  codex: Object.freeze(['.claude-plugin/plugin.json', 'claude.mcp.json', 'hooks/claude-hooks.json']),
  claude: Object.freeze(['.codex-plugin/plugin.json', '.mcp.json', 'hooks/codex-hooks.json']),
});
export function packageEntriesForHost(host) {
  return host === 'codex' || host === 'claude'
    ? REQUIRED_ENTRIES.filter((entry) => !HOST_EXCLUDED_ENTRIES[host].includes(entry))
    : REQUIRED_ENTRIES;
}
const ALLOWED_ENTRIES = new Set(REQUIRED_ENTRIES);
const FORBIDDEN_INTERNAL_ENTRIES = Object.freeze([
  'lib/capabilities.mjs',
  'lib/efficiency/retention.mjs',
  'lib/public/retention.mjs',
]);
const FORBIDDEN_PREFIXES = ['.git/', '.somestoken-public/', 'docs/', 'tests/', 'fixtures/'];
const FORBIDDEN_SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|AGENTS\.md|.*\.(?:pem|key|p12|pfx|crt|cer|log|sqlite|db))$/i;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const CODEX_HOOK_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
]);
export const CLAUDE_HOOK_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'SubagentStart', 'SubagentStop', 'TaskCreated',
  'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact', 'Stop', 'StopFailure',
  'MessageDisplay',
]);
const CODEX_HOOK_COMMAND = 'if [ -n "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}" ]; then node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}/hooks/somestoken.mjs"; fi';
const CODEX_MCP_ARGS = Object.freeze(['./mcp/server.mjs', '--stdio']);
const CLAUDE_ASYNC_HOOK_EVENTS = Object.freeze(['PreToolUse', 'PostToolBatch']);
const CLAUDE_HOOK_ARGS = Object.freeze(['${CLAUDE_PLUGIN_ROOT}/hooks/somestoken.mjs', '--runtime', 'claude', '--data-root', '${CLAUDE_PLUGIN_DATA}']);
const CLAUDE_MCP_ARGS = Object.freeze(['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs', '--stdio']);
const CLAUDE_MCP_ENV = Object.freeze({
  PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}',
  PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}',
  SOMESTOKEN_RUNTIME: 'claude',
});

function error(message) {
  return { ok: false, errors: [message], entries: [] };
}

export function validateCodexMcpManifest(value) {
  const errors = [];
  const servers = value?.mcpServers;
  const server = servers?.['somestoken-local-reporting'];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)
    || Object.keys(servers).length !== 1 || !server || typeof server !== 'object' || Array.isArray(server)) {
    return ['Codex MCP manifest must expose exactly one local reporting server'];
  }
  if (server.command !== 'node' || JSON.stringify(server.args) !== JSON.stringify(CODEX_MCP_ARGS) || server.cwd !== '.') {
    errors.push('Codex MCP server command is invalid');
  }
  // Codex forwards env_vars only from its parent local environment. Plugin
  // hook variables are not present there; the packaged server derives its
  // own root and reads only the sanitized bridge instead.
  if (server.env_vars !== undefined || server.env !== undefined) {
    errors.push('Codex MCP manifest must not use hook-only environment forwarding');
  }
  return errors;
}

export function validateClaudeMcpManifest(value) {
  const errors = [];
  const servers = value?.mcpServers;
  const server = servers?.['somestoken-local-reporting'];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)
    || Object.keys(servers).length !== 1 || !server || typeof server !== 'object' || Array.isArray(server)) {
    return ['Claude MCP manifest must expose exactly one local reporting server'];
  }
  if (server.command !== 'node' || JSON.stringify(server.args) !== JSON.stringify(CLAUDE_MCP_ARGS)) {
    errors.push('Claude MCP server command is invalid');
  }
  const env = server.env;
  const expectedKeys = Object.keys(CLAUDE_MCP_ENV).sort();
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(expectedKeys)
    || Object.entries(CLAUDE_MCP_ENV).some(([key, expected]) => env[key] !== expected)) {
    errors.push('Claude MCP runtime context is invalid');
  }
  return errors;
}

export function validateArchiveEntries(names) {
  const errors = [];
  const seen = new Set();
  const normalized = new Set();
  const entries = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) {
      errors.push('empty archive path');
      continue;
    }
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'utf8'));
    } catch {
      errors.push('archive path is not valid UTF-8');
      continue;
    }
    const normalizedName = path.posix.normalize(decoded);
    const parts = decoded.split('/');
    if (decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded) || parts.includes('..') || normalizedName !== decoded || normalizedName.startsWith('../')) {
      errors.push('archive path is absolute or escapes the plugin root');
    }
    if (decoded.endsWith('/')) errors.push('directory archive entries are not supported');
    if (seen.has(decoded)) errors.push('duplicate archive path');
    if (normalized.has(normalizedName) || normalized.has(normalizedName.toLowerCase())) errors.push('archive path normalization collision');
    seen.add(decoded);
    normalized.add(normalizedName);
    normalized.add(normalizedName.toLowerCase());
    if (FORBIDDEN_PREFIXES.some((prefix) => decoded.startsWith(prefix)) || decoded === 'AGENTS.md') errors.push('repository-only content is present in the production archive');
    if (FORBIDDEN_SENSITIVE_PATH.test(decoded)) errors.push('sensitive or local-only file is present in the production archive');
    if (!ALLOWED_ENTRIES.has(decoded)) errors.push('archive entry is not allowlisted');
    entries.push(decoded);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], entries };
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseCentralDirectory(buffer) {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  if (buffer.length < 22) return { error: 'ZIP end record is missing' };
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === eocdSignature) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) return { error: 'ZIP end record is missing' };
  if (eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) return { error: 'ZIP end record length is invalid' };
  const count = buffer.readUInt16LE(eocd + 10);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 || buffer.readUInt16LE(eocd + 8) !== count) return { error: 'ZIP multipart archives are not supported' };
  if (count > MAX_ARCHIVE_ENTRIES) return { error: 'production archive exceeds entry budget' };
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return { error: 'ZIP64 archives are not supported' };
  if (offset + size !== eocd) return { error: 'ZIP central directory is outside the archive' };
  const entries = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== centralSignature) return { error: 'ZIP central directory entry is malformed' };
    if (buffer.readUInt16LE(cursor + 34) !== 0) return { error: 'ZIP multipart entries are not supported' };
    const crc = buffer.readUInt32LE(cursor + 16);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) return { error: 'ZIP central directory entry exceeds the archive' };
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      return { error: 'ZIP entry name is not valid UTF-8' };
    }
    entries.push({ name, crc, flags, method, compressedSize, uncompressedSize, externalAttributes, localOffset });
    cursor = end;
  }
  if (cursor !== eocd) return { error: 'ZIP central directory size does not match its entries' };
  return { entries, offset };
}

function extractEntries(buffer, centralEntries, centralOffset) {
  const localSignature = 0x04034b50;
  const output = new Map();
  for (const entry of centralEntries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== localSignature) return { error: 'ZIP local entry is malformed' };
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > centralOffset) return { error: 'ZIP entry data exceeds the archive' };
    if (buffer.readUInt16LE(offset + 6) !== entry.flags || buffer.readUInt16LE(offset + 8) !== entry.method
      || !buffer.subarray(offset + 30, offset + 30 + nameLength).equals(Buffer.from(entry.name))) return { error: 'ZIP local entry does not match its central header' };
    for (const [position, expected] of [[14, entry.crc], [18, entry.compressedSize], [22, entry.uncompressedSize]]) {
      const value = buffer.readUInt32LE(offset + position);
      if (value !== expected && (!(entry.flags & 8) || value !== 0)) return { error: 'ZIP local entry does not match its central header' };
    }
    const compressed = buffer.subarray(start, end);
    let data;
    try {
      data = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, entry.uncompressedSize),
      });
    } catch (caught) {
      if (caught?.code === 'ERR_BUFFER_TOO_LARGE') return { error: 'ZIP entry exceeds decompression budget' };
      return { error: 'ZIP entry compression is invalid' };
    }
    if (data.length !== entry.uncompressedSize) return { error: 'ZIP entry size does not match its header' };
    if (crc32(data) !== entry.crc) return { error: 'ZIP entry checksum does not match its header' };
    if (entry.flags & 8) {
      const matches = position => position + 12 <= centralOffset && buffer.readUInt32LE(position) === entry.crc
        && buffer.readUInt32LE(position + 4) === entry.compressedSize && buffer.readUInt32LE(position + 8) === entry.uncompressedSize;
      if (!matches(end) && !(end + 4 <= centralOffset && buffer.readUInt32LE(end) === 0x08074b50 && matches(end + 4))) return { error: 'ZIP data descriptor does not match its central header' };
    }
    output.set(entry.name, data);
  }
  return { files: output };
}

function parseJsonUtf8(data, label) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { value: JSON.parse(text) };
  } catch (caught) {
    return { error: `${label} is not valid UTF-8 JSON (${caught?.name === 'SyntaxError' ? 'syntax' : 'utf-8'})` };
  }
}

function isIdentifierCharacter(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_$]$/.test(value);
}

function skipComment(source, cursor) {
  if (source[cursor] !== '/') return cursor;
  if (source[cursor + 1] === '/') {
    const next = source.indexOf('\n', cursor + 2);
    return next < 0 ? source.length : next + 1;
  }
  if (source[cursor + 1] === '*') {
    const next = source.indexOf('*/', cursor + 2);
    return next < 0 ? source.length : next + 2;
  }
  return cursor;
}

function skipTrivia(source, cursor) {
  let next = cursor;
  while (next < source.length) {
    if (/\s/.test(source[next])) {
      next += 1;
      continue;
    }
    const afterComment = skipComment(source, next);
    if (afterComment !== next) {
      next = afterComment;
      continue;
    }
    break;
  }
  return next;
}

function readQuotedString(source, cursor) {
  const quote = source[cursor];
  if (!['\'', '"', '`'].includes(quote)) return null;
  let value = '';
  for (let next = cursor + 1; next < source.length; next += 1) {
    const character = source[next];
    if (character === '\\') {
      if (next + 1 >= source.length) return null;
      value += source[next + 1];
      next += 1;
      continue;
    }
    if (character === quote) return { value, end: next + 1 };
    value += character;
  }
  return null;
}

function matchesKeyword(source, cursor, keyword) {
  return source.startsWith(keyword, cursor)
    && !isIdentifierCharacter(source[cursor - 1])
    && !isIdentifierCharacter(source[cursor + keyword.length]);
}

function staticModuleSpecifiers(source) {
  const specifiers = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '/' && skipComment(source, cursor) !== cursor) {
      cursor = skipComment(source, cursor);
      continue;
    }
    if (['\'', '"', '`'].includes(character)) {
      const value = readQuotedString(source, cursor);
      cursor = value?.end ?? source.length;
      continue;
    }
    const keyword = matchesKeyword(source, cursor, 'import') ? 'import'
      : matchesKeyword(source, cursor, 'export') ? 'export'
        : null;
    if (!keyword) {
      cursor += 1;
      continue;
    }
    let next = skipTrivia(source, cursor + keyword.length);
    if (keyword === 'import' && (source[next] === '(' || source[next] === '.')) {
      cursor = next + 1;
      continue;
    }
    const direct = readQuotedString(source, next);
    if (keyword === 'import' && direct) {
      specifiers.push(direct.value);
      cursor = direct.end;
      continue;
    }
    while (next < source.length) {
      next = skipTrivia(source, next);
      if (matchesKeyword(source, next, 'from')) {
        const target = readQuotedString(source, skipTrivia(source, next + 4));
        if (target) {
          specifiers.push(target.value);
          cursor = target.end;
          break;
        }
      }
      if (source[next] === ';') {
        cursor = next + 1;
        break;
      }
      const quoted = ['\'', '"', '`'].includes(source[next]) ? readQuotedString(source, next) : null;
      next = quoted?.end ?? next + 1;
    }
    if (next >= source.length) cursor = source.length;
  }
  return specifiers;
}

/** Validate local ESM references without executing untrusted archive code. */
export function validateRuntimeImportClosure(files) {
  const errors = [];
  for (const [entry, data] of files) {
    if (!entry.endsWith('.mjs')) continue;
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      errors.push(`runtime module is not valid UTF-8: ${entry}`);
      continue;
    }
    for (const specifier of staticModuleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
      if (target === '..' || target.startsWith('../') || !files.has(target)) {
        errors.push(`runtime import is missing: ${entry} -> ${target}`);
      }
    }
  }
  return [...new Set(errors)];
}

export function validateHostHooks(hooks, host) {
  const isClaude = host === 'claude';
  const expectedEvents = isClaude ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS;
  const errors = [];
  const names = hooks?.hooks && typeof hooks.hooks === 'object' && !Array.isArray(hooks.hooks)
    ? Object.keys(hooks.hooks).sort()
    : [];
  if (JSON.stringify(names) !== JSON.stringify([...expectedEvents].sort())) {
    errors.push(`${isClaude ? 'Claude' : 'Codex'} hook event set is invalid`);
    return errors;
  }
  for (const event of expectedEvents) {
    const group = hooks.hooks[event];
    const entry = Array.isArray(group) && group.length === 1 && Array.isArray(group[0]?.hooks)
      && group[0].hooks.length === 1 ? group[0].hooks[0] : null;
    const expectedTimeout = !isClaude && event === 'SessionEnd' ? 3 : 10;
    const commandValid = isClaude
      ? entry?.command === 'node' && JSON.stringify(entry?.args) === JSON.stringify(CLAUDE_HOOK_ARGS)
      : entry?.command === CODEX_HOOK_COMMAND;
    // Claude runs these record-only tool events without blocking; context-carrying
    // events (SessionStart, UserPromptSubmit, PostToolUse, Stop...) must stay blocking.
    const asyncValid = isClaude && CLAUDE_ASYNC_HOOK_EVENTS.includes(event) ? entry?.async === true : entry?.async === undefined;
    if (!entry || entry.type !== 'command' || entry.timeout !== expectedTimeout || !commandValid || !asyncValid) {
      errors.push(`${isClaude ? 'Claude' : 'Codex'} ${event} hook command is invalid`);
    }
  }
  return errors;
}

export function validatePackageArchive(archivePath = ARCHIVE_PATH, overrides = {}) {
  let buffer;
  try {
    buffer = readPackageFile(archivePath, MAX_ARCHIVE_BYTES);
  } catch (caught) {
    const messages = { package_file_not_regular: 'production archive is not a regular file', package_file_size_budget: 'production archive exceeds size budget', package_file_changed: 'production archive changed during read' };
    return error(Object.hasOwn(messages, caught?.message) ? messages[caught.message] : 'production archive is missing');
  }
  const central = parseCentralDirectory(buffer);
  if (central.error) return error(central.error);
  if (central.entries.length > MAX_ARCHIVE_ENTRIES) return error('production archive exceeds entry budget');
  const totalUncompressed = central.entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (central.entries.some((entry) => entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES)
    || totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    return error('production archive exceeds uncompressed size budget');
  }
  const names = validateArchiveEntries(central.entries.map((entry) => entry.name));
  const errors = [...names.errors];
  const entries = names.entries;
  const entrySet = new Set(entries);
  for (const entry of FORBIDDEN_INTERNAL_ENTRIES) {
    if (entrySet.has(entry)) errors.push(`production archive contains non-runtime entry: ${entry}`);
  }
  const host = overrides.host === 'codex' || overrides.host === 'claude' ? overrides.host : null;
  for (const required of packageEntriesForHost(host)) if (!entrySet.has(required)) errors.push(`required archive entry is missing: ${required}`);
  if (host) {
    const forbidden = [...HOST_EXCLUDED_ENTRIES[host], 'hooks/hooks.json'];
    for (const entry of forbidden) if (entrySet.has(entry)) errors.push(`host archive contains foreign entry: ${entry}`);
  }
  const manifests = entries.filter((entry) => entry.endsWith('.codex-plugin/plugin.json'));
  if ((!host || host === 'codex') && (manifests.length !== 1 || manifests[0] !== '.codex-plugin/plugin.json')) errors.push('archive must contain exactly one root plugin manifest');
  if (host === 'claude' && manifests.length !== 0) errors.push('Claude archive must not contain a Codex manifest');
  const claudeManifests = entries.filter((entry) => entry.endsWith('.claude-plugin/plugin.json'));
  if ((!host || host === 'claude') && (claudeManifests.length !== 1 || claudeManifests[0] !== '.claude-plugin/plugin.json')) errors.push('archive must contain exactly one Claude plugin manifest');
  if (host === 'codex' && claudeManifests.length !== 0) errors.push('Codex archive must not contain a Claude manifest');
  for (const entry of central.entries) {
    if (entry.flags & 0x1) errors.push('encrypted ZIP entries are not supported');
    if (![0, 8].includes(entry.method)) errors.push('unsupported ZIP compression method');
    if (entry.externalAttributes !== 0) errors.push('special or symlink ZIP entry is not supported');
  }
  const extracted = extractEntries(buffer, central.entries, central.offset);
  if (extracted.error) return { ok: false, errors: [...new Set([...errors, extracted.error])], entries };
  const files = extracted.files;
  errors.push(...validateRuntimeImportClosure(files));
  const manifestBytes = overrides.manifestBytesOverride ?? files.get('.codex-plugin/plugin.json');
  const manifestParsed = host === 'claude' ? { value: null } : parseJsonUtf8(manifestBytes ?? Buffer.alloc(0), 'plugin manifest');
  if (manifestParsed.error) errors.push(manifestParsed.error);
  const manifest = overrides.manifestOverride
    ? (() => {
      try { return JSON.parse(Buffer.from(overrides.manifestOverride).toString('utf8')); } catch { return null; }
    })()
    : manifestParsed.value;
  if ((!host || host === 'codex') && (!manifest || manifest.name !== 'somestoken' || !SEMVER.test(manifest.version ?? ''))) errors.push('plugin manifest name or semantic version is invalid');
  if ((!host || host === 'codex') && manifest?.hooks !== './hooks/codex-hooks.json') errors.push('Codex manifest must select the host-specific hook file');
  const claudeManifestParsed = parseJsonUtf8(files.get('.claude-plugin/plugin.json') ?? Buffer.alloc(0), 'Claude plugin manifest');
  let claudeManifest = null;
  if (!host || host === 'claude') {
    if (claudeManifestParsed.error) errors.push(claudeManifestParsed.error);
    claudeManifest = claudeManifestParsed.value;
    if (!claudeManifest || claudeManifest.name !== 'somestoken' || !SEMVER.test(claudeManifest.version ?? '')) errors.push('Claude plugin manifest identity or version is invalid');
    if (claudeManifest?.hooks !== './hooks/claude-hooks.json') errors.push('Claude manifest must select the host-specific hook file');
  }
  if (!host || host === 'claude') {
    const claudeMcpParsed = parseJsonUtf8(files.get('claude.mcp.json') ?? Buffer.alloc(0), 'Claude MCP manifest');
    if (claudeMcpParsed.error) errors.push(claudeMcpParsed.error);
    else errors.push(...validateClaudeMcpManifest(claudeMcpParsed.value));
  }
  if (!host || host === 'codex') {
    const codexMcpParsed = parseJsonUtf8(files.get('.mcp.json') ?? Buffer.alloc(0), 'Codex MCP manifest');
    if (codexMcpParsed.error) errors.push(codexMcpParsed.error);
    else errors.push(...validateCodexMcpManifest(codexMcpParsed.value));
  }
  for (const targetHost of (host ? [host] : ['codex', 'claude'])) {
    const hooksPath = targetHost === 'claude' ? 'hooks/claude-hooks.json' : 'hooks/codex-hooks.json';
    const hooksParsed = parseJsonUtf8(files.get(hooksPath) ?? Buffer.alloc(0), `${targetHost === 'claude' ? 'Claude ' : ''}hooks manifest`);
    if (hooksParsed.error) errors.push(hooksParsed.error);
    else errors.push(...validateHostHooks(hooksParsed.value, targetHost));
  }
  const skillEntries = entries.filter((entry) => /^skills\/[^/]+\/SKILL\.md$/.test(entry));
  const skillNames = skillEntries.map((entry) => entry.split('/')[1].toLowerCase());
  if (new Set(skillNames).size !== skillNames.length || !skillNames.includes('somestoken')) errors.push('skill identity or layout is invalid');
  for (const entry of skillEntries) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(files.get(entry)); } catch { errors.push('skill metadata is not valid UTF-8'); }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], entries };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hostIndex = process.argv.indexOf('--host');
  const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : undefined;
  const archiveArgument = process.argv.find((argument, index) => index > 1 && !argument.startsWith('--') && process.argv[index - 1] !== '--host');
  const result = validatePackageArchive(archiveArgument || ARCHIVE_PATH, host ? { host } : {});
  process.stdout.write(JSON.stringify({ schema_version: 1, ...result }) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}
