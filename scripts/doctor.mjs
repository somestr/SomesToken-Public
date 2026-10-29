#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCodexCapabilities } from './lib/capabilities.mjs';
import {
  packageArtifactName,
  packageVersionMatchesPlugin,
  readPluginManifest,
} from './plugin-manifest.mjs';
import { validateHostHooks, validateCodexMcpManifest, validateClaudeMcpManifest } from './package-check.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REQUIRED_FILES = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  'plugins/somestoken/.codex-plugin/plugin.json',
  'plugins/somestoken/.mcp.json',
  'plugins/somestoken/.claude-plugin/plugin.json',
  'plugins/somestoken/claude.mcp.json',
  'plugins/somestoken/hooks/codex-hooks.json',
  'plugins/somestoken/hooks/claude-hooks.json',
  'plugins/somestoken/hooks/somestoken.mjs',
  'plugins/somestoken/lib/core.mjs',
  'plugins/somestoken/lib/version.mjs',
  'plugins/somestoken/lib/runtime.mjs',
  'plugins/somestoken/lib/workspace-diagnostics.mjs',
  'plugins/somestoken/lib/savings.mjs',
  'plugins/somestoken/lib/reporting.mjs',
  'scripts/lib/capabilities.mjs',
  'plugins/somestoken/lib/routing.mjs',
  'plugins/somestoken/lib/usage/credits.mjs',
  'plugins/somestoken/lib/usage/config.mjs',
  'plugins/somestoken/lib/efficiency/detector.mjs',
  'plugins/somestoken/lib/efficiency/capabilities.mjs',
  'plugins/somestoken/lib/efficiency/provenance.mjs',
  'plugins/somestoken/lib/efficiency/sessions.mjs',
  'plugins/somestoken/lib/efficiency/metrics.mjs',
  'plugins/somestoken/lib/efficiency/recommendations.mjs',
  'plugins/somestoken/lib/efficiency/acceptance.mjs',
  'plugins/somestoken/lib/hosts/codex.mjs',
  'plugins/somestoken/lib/hosts/claude-code.mjs',
  'plugins/somestoken/lib/hosts/claude-statusline.mjs',
  'plugins/somestoken/bin/report.mjs',
  'plugins/somestoken/skills/somestoken/SKILL.md',
];

function check(name, status, detail) {
  return { name, status, detail };
}

function readJson(root, relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  } catch {
    return null;
  }
}

function checkSummary(checks) {
  const summary = {
    pass: checks.filter((entry) => entry.status === 'pass').length,
    fail: checks.filter((entry) => entry.status === 'fail').length,
    unavailable: checks.filter((entry) => entry.status === 'unavailable').length,
  };
  summary.total = checks.length;
  summary.ok = summary.fail === 0;
  return summary;
}

export function runDoctor(root = REPO_ROOT, options = {}) {
  const checks = [];
  const manifest = readPluginManifest(root);
  const archiveName = packageArtifactName(manifest);
  const filesPresent = Boolean(archiveName) && [...REQUIRED_FILES, path.join('plugins', 'somestoken', 'dist', archiveName)]
    .every((relative) => fs.existsSync(path.join(root, relative)));
  checks.push(check('required_files', filesPresent ? 'pass' : 'fail', filesPresent ? 'required package files present' : 'required package files missing'));

  const marketplacePath = '.agents/plugins/marketplace.json';
  const pluginPath = 'plugins/somestoken/.codex-plugin/plugin.json';
  const codexMcpPath = 'plugins/somestoken/.mcp.json';
  const claudePluginPath = 'plugins/somestoken/.claude-plugin/plugin.json';
  const hooksPath = 'plugins/somestoken/hooks/codex-hooks.json';
  const claudeHooksPath = 'plugins/somestoken/hooks/claude-hooks.json';
  const claudeMcpPath = 'plugins/somestoken/claude.mcp.json';
  const claudeMarketplacePath = '.claude-plugin/marketplace.json';
  const marketplace = readJson(root, marketplacePath);
  const claudeMarketplace = readJson(root, claudeMarketplacePath);
  const plugin = readJson(root, pluginPath);
  const codexMcp = readJson(root, codexMcpPath);
  const claudePlugin = readJson(root, claudePluginPath);
  const packageMetadata = readJson(root, 'package.json');
  const hooks = readJson(root, hooksPath);
  const claudeHooks = readJson(root, claudeHooksPath);
  const claudeMcp = readJson(root, claudeMcpPath);
  checks.push(check('marketplace_manifest', marketplace ? 'pass' : 'fail', marketplace ? 'valid JSON' : 'invalid JSON'));
  checks.push(check('claude_marketplace_manifest', claudeMarketplace ? 'pass' : 'fail', claudeMarketplace ? 'valid JSON' : 'invalid JSON'));
  checks.push(check('plugin_manifest', plugin ? 'pass' : 'fail', plugin ? 'valid JSON' : 'invalid JSON'));
  const codexMcpValid = plugin?.mcpServers === './.mcp.json'
    && validateCodexMcpManifest(codexMcp).length === 0;
  checks.push(check('codex_mcp_manifest', codexMcpValid ? 'pass' : 'fail', codexMcpValid ? 'valid Codex MCP public bridge' : 'invalid Codex MCP manifest'));
  checks.push(check('hooks_manifest', hooks ? 'pass' : 'fail', hooks ? 'valid JSON' : 'invalid JSON'));
  checks.push(check(
    'codex_hook_path',
    plugin?.hooks === './hooks/codex-hooks.json' ? 'pass' : 'fail',
    plugin?.hooks === './hooks/codex-hooks.json' ? 'Codex manifest selects the host-specific hook file' : 'Codex manifest hook path is invalid',
  ));
  const claudePluginValid = claudePlugin?.name === 'somestoken'
    && claudePlugin?.version === packageMetadata?.version
    && claudePlugin?.hooks === './hooks/claude-hooks.json'
    && claudePlugin?.mcpServers === './claude.mcp.json';
  checks.push(check('claude_plugin_manifest', claudePluginValid ? 'pass' : 'fail', claudePluginValid ? 'valid Claude plugin manifest' : 'invalid Claude plugin manifest'));
  const claudeMarketplaceEntries = Array.isArray(claudeMarketplace?.plugins) ? claudeMarketplace.plugins : [];
  const claudeMarketplaceEntry = claudeMarketplaceEntries.find((entry) => entry?.name === 'somestoken');
  const claudeMarketplaceVersionValid = claudeMarketplaceEntry?.source === './plugins/somestoken'
    && claudeMarketplaceEntry?.version === claudePlugin?.version;
  checks.push(check(
    'claude_marketplace_version',
    claudeMarketplaceVersionValid ? 'pass' : 'fail',
    claudeMarketplaceVersionValid ? 'Claude marketplace and plugin version agree' : 'Claude marketplace version mismatch',
  ));
  const claudeHooksValid = validateHostHooks(claudeHooks, 'claude').length === 0;
  checks.push(check('claude_hooks_manifest', claudeHooksValid ? 'pass' : 'fail', claudeHooksValid ? 'Claude lifecycle, tool, task, compact, and stop hooks use the plugin-root command' : 'invalid Claude hooks manifest'));
  const claudeMcpValid = validateClaudeMcpManifest(claudeMcp).length === 0;
  checks.push(check('claude_mcp_manifest', claudeMcpValid ? 'pass' : 'fail', claudeMcpValid ? 'valid Claude MCP bridge' : 'invalid Claude MCP manifest'));

  const entries = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
  checks.push(check(
    'marketplace_identity',
    marketplace?.name === 'somestoken-local' && entries.length === 1 && entries[0]?.name === 'somestoken' ? 'pass' : 'fail',
    marketplace?.name === 'somestoken-local' && entries.length === 1 && entries[0]?.name === 'somestoken' ? 'exact marketplace and plugin names' : 'marketplace identity mismatch',
  ));
  const source = entries[0]?.source;
  checks.push(check(
    'marketplace_source',
    source?.source === 'local' && source?.path === './plugins/somestoken' ? 'pass' : 'fail',
    source?.source === 'local' && source?.path === './plugins/somestoken' ? 'supported local source' : 'marketplace source mismatch',
  ));
  checks.push(check(
    'plugin_identity',
    Boolean(manifest) ? 'pass' : 'fail',
    manifest ? 'exact plugin identifier and semantic version' : 'plugin identity mismatch',
  ));
  const versionsMatch = Boolean(manifest)
    && packageVersionMatchesPlugin(packageMetadata?.version, manifest.version);
  checks.push(check(
    'package_plugin_version',
    versionsMatch ? 'pass' : 'fail',
    versionsMatch ? 'repository base version and plugin version agree' : 'repository and plugin version mismatch',
  ));

  const safeHooks = validateHostHooks(hooks, 'codex').length === 0;
  checks.push(check('hook_commands', safeHooks ? 'pass' : 'fail', safeHooks ? 'Codex hook commands use the plugin-root compatibility fallback' : 'Codex hook command is not host-safe'));

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check('node_runtime', Number.isInteger(nodeMajor) && nodeMajor >= 24 ? 'pass' : 'fail', Number.isInteger(nodeMajor) && nodeMajor >= 24 ? 'Node runtime meets package floor' : `Node.js 24 or newer is required; found ${process.versions.node}`));

  if (options.checkCodex === false) {
    checks.push(check('codex_cli', 'unavailable', 'Codex CLI check skipped'));
    checks.push(check('codex_capabilities', 'unavailable', 'Codex capability probe skipped'));
  } else {
    const command = options.codexCommand || 'codex';
    const capability = probeCodexCapabilities(command, root, process.env);
    const status = capability.codex_version ? 'pass' : capability.status === 'unavailable' ? 'unavailable' : 'fail';
    const detail = status === 'pass'
      ? 'Codex CLI version observed; runtime model/reasoning remain hook-sourced'
      : status === 'unavailable' ? 'Codex CLI is not installed' : 'Codex CLI version check failed';
    checks.push(check('codex_cli', status, detail));
    checks.push(check('codex_capabilities', status, detail));
  }

  return { schema_version: 1, checks, summary: checkSummary(checks) };
}

export function formatDoctor(result, json = false) {
  if (json) return `${JSON.stringify(result)}\n`;
  const lines = result.checks.map((entry) => `${entry.status.toUpperCase()} ${entry.name}: ${entry.detail}`);
  lines.push(`SUMMARY pass=${result.summary.pass} fail=${result.summary.fail} unavailable=${result.summary.unavailable}`);
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json');
  const result = runDoctor();
  process.stdout.write(formatDoctor(result, json));
  process.exitCode = result.summary.ok ? 0 : 1;
}
