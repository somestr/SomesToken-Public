#!/usr/bin/env node
// SomesToken cache keep-alive switch (Claude Code only). Writes one setting file in the Claude plugin data.
import fs from 'node:fs';
import {isHostOwnedAbsolutePath} from '../lib/host-paths.mjs';
import {recordedPluginData} from '../lib/handoff/hook.mjs';
import {readKeepaliveConfig, writeKeepaliveConfig} from '../lib/cache-keepalive.mjs';

const USAGE = 'usage: keepalive.mjs on [--max-pings N] [--min-context TOKENS] [--lead-seconds N] | off | status [--json]';
const args = process.argv.slice(2), json = args.includes('--json'), command = args[0];
const option = name => { const at = args.indexOf(name); return at > 0 ? Number(args[at + 1]) : undefined; };
function output(value, code = 0) {
  process.exitCode = code;
  if (json) return process.stdout.write(JSON.stringify(value) + '\n');
  process.stdout.write(value.ok
    ? `SomesToken cache keep-alive ${value.enabled ? 'on' : 'off'} · up to ${value.max_pings} pings · from ${value.min_context_tokens} context tokens · ${value.lead_seconds} s before expiry\n`
    : `${value.error}\n${USAGE}\n`);
}
const root = [process.env.CLAUDE_PLUGIN_DATA].find(isHostOwnedAbsolutePath) ?? recordedPluginData(process.env, 'claude');
if (!['on', 'off', 'status'].includes(command)) output({ok: false, error: 'invalid_keepalive_command'}, 1);
else if (!root || !fs.existsSync(root)) output({ok: false, error: 'claude_plugin_data_unavailable'}, 1);
else {
  try {
    const current = readKeepaliveConfig(root);
    const next = command === 'status' ? current : writeKeepaliveConfig(root, command === 'off' ? {...current, enabled: false} : {
      enabled: true, max_pings: option('--max-pings') ?? current.max_pings,
      min_context_tokens: option('--min-context') ?? current.min_context_tokens, lead_seconds: option('--lead-seconds') ?? current.lead_seconds,
    });
    output({ok: true, ...next});
  } catch { output({ok: false, error: 'invalid_keepalive_settings'}, 1); }
}
