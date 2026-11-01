#!/usr/bin/env node
// Claude Stop hook run with asyncRewake: the opt-in prompt-cache keep-alive (lib/cache-keepalive.mjs).
// Off by default; then it costs one small file read. Every path except a due ping exits 0.
import fs from 'node:fs';
import path from 'node:path';

const flag = process.argv.indexOf('--data-root'), dataRoot = flag > 0 ? process.argv[flag + 1] ?? '' : '';
let on = false;
if (path.isAbsolute(dataRoot)) {
  try { on = JSON.parse(fs.readFileSync(path.join(dataRoot, 'somestoken', 'cache-keepalive.json'), 'utf8')).enabled === true; } catch { /* off */ }
}
// Drain the payload even when off, so Claude Code's write to this hook's stdin never fails.
let input = '';
if (!process.stdin.isTTY) try { for await (const chunk of process.stdin) input += chunk; } catch { /* closed early */ }
if (!on) process.exit(0);
try {
  const {runKeepalive} = await import('../lib/cache-keepalive.mjs');
  process.exitCode = await runKeepalive({dataRoot, input});
} catch { process.exitCode = 0; }
