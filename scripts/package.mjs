import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkOwnedFile } from '../plugins/somestoken/lib/host-paths.mjs';

import { packageArtifactName, packageVersionMatchesPlugin, readPluginManifest, readPackageFile } from './plugin-manifest.mjs';
import { REQUIRED_ENTRIES, packageEntriesForHost, crc32, MAX_ARCHIVE_BYTES, MAX_ENTRY_UNCOMPRESSED_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES } from './package-check.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'somestoken');
const excluded = new Set(['.git', '.somestoken-public', 'dist', 'node_modules']);
const forbiddenSensitivePath = /(?:^|\/)(?:\.env(?:\..*)?|AGENTS\.md|.*\.(?:pem|key|p12|pfx|crt|cer|log|sqlite|db))$/i;
const allowedEntries = new Set(REQUIRED_ENTRIES);

function filesUnder(directory, prefix = '', budget = { bytes: 0 }) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (excluded.has(entry.name) || entry.name === '.DS_Store') continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.join(prefix, entry.name);
    const normalized = relative.split(path.sep).join('/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || path.posix.normalize(normalized) !== normalized) throw new Error('unsafe package path');
    if (forbiddenSensitivePath.test(normalized)) throw new Error('sensitive or local-only file is not packageable');
    if (entry.isSymbolicLink()) throw new Error('symbolic links are not supported in the production package');
    if (entry.isDirectory()) {
      if (!REQUIRED_ENTRIES.some((name) => name.startsWith(`${normalized}/`))) throw new Error('package directory is not allowlisted');
      result.push(...filesUnder(absolute, relative, budget));
    } else if (entry.isFile()) {
      if (!allowedEntries.has(normalized)) throw new Error('package file is not allowlisted');
      const data = readPackageFile(absolute, Math.min(MAX_ENTRY_UNCOMPRESSED_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES - budget.bytes));
      budget.bytes += data.length;
      result.push({ name: normalized, data });
    } else throw new Error('special files are not supported in the production package');
  }
  return result;
}

function localHeader(name, data, compressed, crc) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, compressed]);
}

function centralHeader(name, data, compressed, crc, offset) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    // Store entries without zlib so builds are byte-identical across Node versions.
    const stored = entry.data;
    const crc = crc32(entry.data);
    const header = localHeader(entry.name, entry.data, stored, crc);
    local.push(header);
    central.push(centralHeader(entry.name, entry.data, stored, crc, offset));
    offset += header.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const data = Buffer.concat([...local, centralData, end]);
  if (data.length > MAX_ARCHIVE_BYTES) throw new Error('production archive exceeds size budget');
  return data;
}

function hostEntries(entries, host) {
  const allowed = new Set(packageEntriesForHost(host));
  return entries.filter((entry) => allowed.has(entry.name));
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Assemble deterministic archive bytes without writing to the source tree.
 * Setup uses this bounded in-memory result to detect an archive that still
 * matches SHA256SUMS but no longer represents the current plugin source.
 */
export function buildPackageArtifacts(repositoryRoot = REPO_ROOT) {
  const pluginRoot = path.join(repositoryRoot, 'plugins', 'somestoken');
  const manifest = readPluginManifest(repositoryRoot);
  const archiveName = packageArtifactName(manifest);
  if (!archiveName) throw new Error('plugin manifest is invalid');
  const claudeManifest = JSON.parse(readPackageFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json')).toString('utf8'));
  if (typeof claudeManifest?.version !== 'string' || !packageArtifactName(claudeManifest)
    || !packageVersionMatchesPlugin(claudeManifest.version, manifest.version)) {
    throw new Error('Claude plugin manifest is invalid');
  }
  const entries = filesUnder(pluginRoot);
  const entryNames = new Set(entries.map((entry) => entry.name));
  for (const required of REQUIRED_ENTRIES) {
    if (!entryNames.has(required)) throw new Error(`required package file is missing: ${required}`);
  }
  return {
    plugin_root: pluginRoot,
    entries,
    combined: { name: archiveName, data: makeZip(entries) },
    hosts: {
      codex: { name: `somestoken-codex-${manifest.version}.zip`, data: makeZip(hostEntries(entries, 'codex')) },
      claude: { name: `somestoken-claude-${claudeManifest.version}.zip`, data: makeZip(hostEntries(entries, 'claude')) },
    },
  };
}

function readChecksums(checksumPath) {
  const checksums = new Map();
  try {
    for (const line of readPackageFile(checksumPath, MAX_ARCHIVE_BYTES).toString('utf8').split(/\r?\n/)) {
      const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9._+-]+\.zip)$/);
      if (match) checksums.set(match[2], match[1]);
    }
  } catch {
    // A missing checksum file is recreated from the deterministic package output.
  }
  return checksums;
}

function packageDirectory(directory, create = false, owned) {
  if (fs.realpathSync(path.dirname(directory)) !== path.dirname(directory)) throw new Error('unsafe_package_directory');
  if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const current = fs.lstatSync(directory);
  if (!current.isDirectory() || (owned && (current.dev !== owned.dev || current.ino !== owned.ino))) throw new Error('unsafe_package_directory');
  return current;
}

function writeArtifact(file, data, onlyAbsent = false, mode = 0o600) {
  const directory = path.dirname(file), parent = packageDirectory(directory);
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!onlyAbsent && current && !current.isFile()) throw new Error('unsafe_package_artifact');
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let descriptor, owned;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode); owned = fs.fstatSync(descriptor);
    fs.writeFileSync(descriptor, data); fs.closeSync(descriptor); descriptor = undefined;
    packageDirectory(directory, false, parent);
    const ready = fs.lstatSync(temporary);
    if (!ready.isFile() || ready.dev !== owned.dev || ready.ino !== owned.ino) throw new Error('package_artifact_changed');
    if (onlyAbsent) { try { fs.linkSync(temporary, file); } catch (error) { if (error.code === 'EEXIST') return false; throw error; } }
    else fs.renameSync(temporary, file);
    return true;
  } finally { try { if (descriptor !== undefined) fs.closeSync(descriptor); } finally { unlinkOwnedFile(temporary, owned); } }
}

/**
 * Hosts copy the whole plugin folder into every installed version, so archives
 * of earlier versions leave `dist/` for `release-archives/` at the repository
 * root. SHA256SUMS keeps their entries. Nothing is deleted unless an identical
 * copy is already archived, and a different file of the same name stays put.
 */
function archiveOlderArtifacts(dist, archive, current) {
  let moved = 0;
  for (const name of fs.readdirSync(dist)) {
    if (!name.endsWith('.zip') || current.has(name)) continue;
    const from = path.join(dist, name), to = path.join(archive, name);
    const owned = fs.lstatSync(from); if (!owned.isFile()) continue;
    packageDirectory(archive, true);
    let data; try { data = readPackageFile(from, MAX_ARCHIVE_BYTES, owned); } catch { continue; }
    if (!fs.existsSync(to)) { if (!writeArtifact(to, data, true, owned.mode & 0o777)) continue; }
    else { try { if (!readPackageFile(to, MAX_ARCHIVE_BYTES).equals(data)) continue; } catch { continue; } }
    const remaining = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!remaining?.isFile() || remaining.dev !== owned.dev || remaining.ino !== owned.ino || remaining.size !== owned.size || remaining.mtimeMs !== owned.mtimeMs || remaining.ctimeMs !== owned.ctimeMs) continue;
    unlinkOwnedFile(from, owned);
    if (!fs.existsSync(from)) moved++;
  }
  return moved;
}

/** Write the combined and host-specific deterministic artifacts plus checksums. */
export function writePackageArtifacts(repositoryRoot = REPO_ROOT) {
  const outputRoot = fs.realpathSync(repositoryRoot);
  packageDirectory(path.join(outputRoot, 'plugins', 'somestoken'));
  const artifacts = buildPackageArtifacts(repositoryRoot);
  const dist = path.join(outputRoot, 'plugins', 'somestoken', 'dist');
  packageDirectory(dist, true);
  const records = [artifacts.combined, artifacts.hosts.codex, artifacts.hosts.claude].map((artifact) => {
    writeArtifact(path.join(dist, artifact.name), artifact.data);
    return { name: artifact.name, digest: digest(artifact.data) };
  });
  const checksums = readChecksums(path.join(dist, 'SHA256SUMS'));
  for (const artifact of records) checksums.set(artifact.name, artifact.digest);
  const checksumText = [...checksums.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${value}  ${name}`)
    .join('\n');
  writeArtifact(path.join(dist, 'SHA256SUMS'), `${checksumText}\n`);
  const archived = archiveOlderArtifacts(dist, path.join(outputRoot, 'release-archives'), new Set(records.map((record) => record.name)));
  return {
    archived,
    file_count: artifacts.entries.length,
    combined: records[0],
    hosts: { codex: records[1], claude: records[2] },
  };
}

/**
 * Return only digest/boolean evidence. It intentionally omits filesystem
 * paths so setup output can report a stale source artifact without exposing
 * a local checkout location.
 */
export function inspectPackageArtifact(repositoryRoot = REPO_ROOT, host = 'codex') {
  try {
    const artifacts = buildPackageArtifacts(repositoryRoot);
    const selected = host === 'combined'
      ? artifacts.combined
      : host === 'codex'
        ? artifacts.hosts.codex
        : host === 'claude'
          ? artifacts.hosts.claude
          : null;
    if (!selected) throw new Error('unsupported package artifact target');
    const dist = path.join(artifacts.plugin_root, 'dist');
    const archive = readPackageFile(path.join(dist, selected.name), MAX_ARCHIVE_BYTES);
    const actual = digest(archive);
    const expected = readChecksums(path.join(dist, 'SHA256SUMS')).get(selected.name) ?? null;
    const checksumMatches = expected === actual;
    // Source freshness needs an exact byte comparison, not a second digest of
    // packaged source. Keep only the requested artifact SHA in this result.
    const sourceMatches = archive.equals(selected.data);
    return {
      actual,
      expected,
      checksum_matches: checksumMatches,
      source_matches: sourceMatches,
      valid: checksumMatches && sourceMatches,
    };
  } catch {
    return {
      actual: null,
      expected: null,
      checksum_matches: false,
      source_matches: false,
      valid: false,
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writePackageArtifacts();
  process.stdout.write(`packaged ${result.file_count} files: dist/${result.combined.name}\n`);
}
