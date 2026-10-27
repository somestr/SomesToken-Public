import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { REQUIRED_ENTRIES } from './package-check.mjs';
import { packageVersionMatchesPlugin } from './plugin-manifest.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function runBuild(root = REPO_ROOT, options = {}) {
  const run = options.run ?? spawnSync;
  const pluginRoot = path.join(root, 'plugins', 'somestoken');
  const required = [
    ...REQUIRED_ENTRIES.map((entry) => path.join('plugins', 'somestoken', entry)),
    '.agents/plugins/marketplace.json',
  ];
  for (const relative of required) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`missing package file: ${relative}`);
    if (relative.startsWith(path.join('plugins', 'somestoken', 'bin') + path.sep)) {
      try {
        if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
        if (['report.mjs', 'handoff.mjs'].includes(path.basename(file))) fs.accessSync(file, fs.constants.X_OK);
      } catch { throw new Error(`required program must be a regular executable file: ${relative}`); }
    }
  }
  for (const relative of [
    'plugins/somestoken/.codex-plugin/plugin.json',
    'plugins/somestoken/.claude-plugin/plugin.json',
    'plugins/somestoken/hooks/codex-hooks.json',
    'plugins/somestoken/hooks/claude-hooks.json',
    'plugins/somestoken/claude.mcp.json',
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
  ]) {
    JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const claudeManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const claudeMarketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const claudeMarketplaceEntry = Array.isArray(claudeMarketplace?.plugins)
    ? claudeMarketplace.plugins.find((entry) => entry?.name === 'somestoken')
    : null;
  if (!packageVersionMatchesPlugin(packageMetadata?.version, manifest?.version)) throw new Error('Codex plugin version must match the package base version and cachebuster contract');
  if (claudeManifest?.version !== packageMetadata?.version) throw new Error('Claude plugin version must match the package base version');
  if (claudeMarketplaceEntry?.version !== claudeManifest.version) throw new Error('Claude marketplace version must match the Claude plugin manifest');
  const result = run(process.execPath, [path.join(root, 'scripts/package.mjs')], { cwd: pluginRoot, stdio: 'inherit', timeout: 30_000, killSignal: 'SIGKILL' });
  if (result.error || result.status !== 0) return result.status ?? 1;
  const validation = run(process.execPath, [path.join(root, 'scripts/package-check.mjs')], { cwd: root, stdio: 'inherit', timeout: 30_000, killSignal: 'SIGKILL' });
  if (validation.error || validation.status !== 0) return validation.status ?? 1;
  for (const host of ['codex', 'claude']) {
    const hostArchiveName = host === 'codex'
      ? `somestoken-codex-${manifest.version}.zip`
      : `somestoken-claude-${claudeManifest.version}.zip`;
    const hostValidation = run(process.execPath, [path.join(root, 'scripts/package-check.mjs'), path.join(pluginRoot, 'dist', hostArchiveName), '--host', host], { cwd: root, stdio: 'inherit', timeout: 30_000, killSignal: 'SIGKILL' });
    if (hostValidation.error || hostValidation.status !== 0) return hostValidation.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBuild();
  if (process.exitCode) process.stderr.write('SomesToken build child failed or timed out\n');
}
