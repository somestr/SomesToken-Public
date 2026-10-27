#!/usr/bin/env node
import module from 'node:module';
import { deferHookEvent } from '../lib/runtime/hot-path.mjs';
import { captureClaudeWorkspaceHook } from '../lib/claude-workspace.mjs';
import { isHostOwnedAbsolutePath } from '../lib/host-paths.mjs';

// Tool-use events usually end in the hot journal; only the rest load the full
// runtime, whose compiled code Node may cache between hook processes.
module.enableCompileCache?.();

const MAX_INPUT_BYTES = 256 * 1024;

async function readInput() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    return null;
  }
}

const input = await readInput();
const eventName = input?.hook_event_name || process.env.CODEX_HOOK_EVENT_NAME || '';
const runtimeIndex = process.argv.indexOf('--runtime');
const runtime = runtimeIndex >= 0 ? process.argv[runtimeIndex + 1] : undefined;
const dataRootIndex = process.argv.indexOf('--data-root');
const explicitDataRoot = dataRootIndex >= 0 ? process.argv[dataRootIndex + 1] : undefined;
const dataRoot = isHostOwnedAbsolutePath(explicitDataRoot)
  ? explicitDataRoot
  : isHostOwnedAbsolutePath(process.env.CLAUDE_PLUGIN_DATA)
    ? process.env.CLAUDE_PLUGIN_DATA
    : isHostOwnedAbsolutePath(process.env.PLUGIN_DATA) ? process.env.PLUGIN_DATA : '';
const hookEnv = runtime === 'claude'
  ? {
    ...process.env,
    SOMESTOKEN_RUNTIME: 'claude',
    PLUGIN_DATA: dataRoot,
    PLUGIN_ROOT: isHostOwnedAbsolutePath(process.env.CLAUDE_PLUGIN_ROOT)
      ? process.env.CLAUDE_PLUGIN_ROOT
      : isHostOwnedAbsolutePath(process.env.PLUGIN_ROOT) ? process.env.PLUGIN_ROOT : '',
  }
  : process.env;
const deferred = await deferHookEvent(input ?? {}, eventName, hookEnv);
const response = deferred === 'handled' || deferred === 'ignored' ? {}
  : await (await import('../lib/runtime.mjs')).handleHook(input ?? {}, eventName, hookEnv, deferred);
// Feed failures must never interfere with the host's existing receipt hook.
try { captureClaudeWorkspaceHook(input ?? {}, eventName, hookEnv); } catch { /* optional numeric capture */ }
// Receipt collection is automatic; receipt presentation is on request. Limit
// unsolicited host output to the existing bounded alerts, so usage summaries
// cannot displace the assistant's task result. CLI/MCP reports keep all fields.
const notices = (response.systemMessage ?? '').split('\n').filter(line =>
  /^SomesToken (?:· (?:efficiency |local budget · |plan usage · |handoff · )|workflow advisor · )/.test(line));
const output = notices.length ? { systemMessage: notices.join('\n') } : {};
// Model context is either fixed policy text, exact handoff lines rebuilt from
// validated slots, or both; anything else drops the whole context.
const context = response.hookSpecificOutput, event = context?.hookEventName;
if (typeof context?.additionalContext === 'string') {
  const [{ isFixedPolicyContext }, { isHandoffContext }] = await Promise.all([
    import('../lib/optimization/active-policy.mjs'), import('../lib/handoff/hook.mjs')]);
  const lines = context.additionalContext.split('\n');
  const handoff = lines.filter(isHandoffContext), fixed = lines.filter(line => !isHandoffContext(line)).join('\n');
  if (['SessionStart', 'UserPromptSubmit', 'PostToolUse'].includes(event) && handoff.length <= 2
    && (fixed ? isFixedPolicyContext({ hookEventName: event, additionalContext: fixed }) : handoff.length > 0)) {
    output.hookSpecificOutput = { hookEventName: event, additionalContext: context.additionalContext };
  }
}
// Opt-in output guards (off by default): one fixed note after a large test-runner,
// file-read or search result. They never block or rewrite the tool result; a guard
// error adds nothing.
if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') && input?.tool_name === 'Bash') {
  try {
    const note = await (await import('../lib/optimization/output-guard.mjs'))
      .outputGuardNote(input ?? {}, eventName, runtime === 'claude' ? 'claude' : 'codex', hookEnv);
    if (note) output.hookSpecificOutput = { hookEventName: eventName,
      additionalContext: output.hookSpecificOutput ? `${output.hookSpecificOutput.additionalContext}\n${note}` : note };
  } catch { /* the guard is optional */ }
}
process.stdout.write(JSON.stringify(output));
