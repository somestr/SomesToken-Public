import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_RELATIVE_ROOT = path.join('plugins', 'somestoken');
export const PLUGIN_MANIFEST_RELATIVE = path.join(PLUGIN_RELATIVE_ROOT, '.codex-plugin', 'plugin.json');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CODEX_CACHEBUSTER = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;

/** Read one stable regular package file; the archive limits also bound source reads. */
export function readPackageFile(file, limit = 2 * 1024 * 1024, expected) {
  let descriptor;
  try {
    const before = expected ?? fs.lstatSync(file);
    if (before.isSymbolicLink()) throw new Error('package_file_symlink');
    if (!before.isFile()) throw new Error('package_file_not_regular');
    if (before.size > limit) throw new Error('package_file_size_budget');
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error('package_file_not_regular');
    if (opened.size > limit) throw new Error('package_file_size_budget');
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error('package_file_changed');
    const data = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, null);
      if (!count) throw new Error('package_file_changed');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, null) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('package_file_changed');
    return data;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readPluginManifest(root) {
  try {
    const parsed = JSON.parse(readPackageFile(path.join(root, PLUGIN_MANIFEST_RELATIVE)).toString('utf8'));
    if (parsed?.name !== 'somestoken' || !SEMVER.test(parsed?.version ?? '')) return null;
    return { name: 'somestoken', version: parsed.version };
  } catch {
    return null;
  }
}

export function packageArtifactName(manifest) {
  if (manifest?.name !== 'somestoken' || !SEMVER.test(manifest?.version ?? '')) return null;
  return `somestoken-${manifest.version}.zip`;
}

export function packageVersionMatchesPlugin(packageVersion, pluginVersion) {
  if (!SEMVER.test(packageVersion ?? '') || !SEMVER.test(pluginVersion ?? '')) return false;
  if (pluginVersion === packageVersion) return true;
  if (packageVersion.includes('+')) return false;
  const prefix = `${packageVersion}+codex.`;
  return pluginVersion.startsWith(prefix) && CODEX_CACHEBUSTER.test(pluginVersion.slice(prefix.length));
}
