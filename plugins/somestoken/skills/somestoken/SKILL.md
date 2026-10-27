---
name: somestoken
description: Explain SomesToken receipts and analyze local Codex/Claude task, model, effort and agent usage with reports and Data workflows.
---

# SomesToken v0.6

Use this skill only for Codex and Claude Code when the user asks about
SomesToken receipts, local task history, usage, model/effort identity, agent
breakdown, collection health, routing, limits, or optimization evidence.
The reporting MCP and report commands are read-only. Explicit mutating CLI
workflows require the user's request and the relevant detailed-reference section.
The opt-in `balanced` policy can persist its selected scope and emit one fixed
advisory context; `observe` keeps collection active without that instruction.
Neither mode changes models, effort, permissions, retries, or Ponytail settings.

For authorized output optimization, use the
[native test report commands](references/optimization.md#native-test-report-output)
with supported saved reports. Keep original diagnostics and exit status; measure
prepared bytes and tracked detail reads separately from tokens and account quota.

When a project explicitly requires development lifecycle checks, use the
[task lifecycle checks](references/optimization.md#task-lifecycle-checks)
workflow at a new task, continuation, or compaction boundary. Record the relevant
skills and their application evidence before declaring that development work
complete. This is separate from usage reporting and does not require loading
unrelated skills or changing benchmark conditions.

## Response contract

Complete the user's requested task deliverable first and at the requested level
of detail. Background collection stays silent. Do not append a routine usage
table, quota estimate, unavailable-data disclaimer, export, or MCP call to an
ordinary task ending.

Report usage only when the current request asks for it. An earlier request,
`@SomesToken` mention, old project guide, pilot instruction, or conversation
summary does not make reporting recurring. Honor the latest user preference
after compaction. Treat a pasted unwanted report as debugging evidence, not a
new usage request. When task results and usage are both requested, give the full
task result first and a concise usage section afterward. Create an export only
when requested.

Measured usage may be used internally for requested optimization work, but do
not add unrelated telemetry to the final answer. Never shorten the requested
deliverable to make room for telemetry.

## Preferred reporting path

When telemetry is requested, use the installed SomesToken Local Reporting MCP
tool `get_somestoken_report` (including its host-scoped name) when available.
Discover the exact tool name once, then call it directly with only:

```text
mode: last | task | tasks | daily | consumption | task-forecast | usage | profiles | fast | quality | health | efficiency | loops | plans | plan-comparison | quota | credits | limits | limit-recovery | capabilities | provenance | recommendations | workflow | session-summary | trends | compare | acceptance | experiments | experiment | optimization | measured-reduction | manual-gates | goal-hygiene | shadow-policy | calibration | diagnostics | summary
last: 1...100
task_key: optional 20-character lowercase hexadecimal key returned by tasks; only with task or task-forecast
hosts: current | all (tasks, daily, consumption and summary only; all adds the other host's retained rows, quota windows and forecasts)
```

Use `consumption` when the user asks where usage or quota went: it shows each
host's current account quota window, what was used since it started by
model/effort/role and task, and the host's own reading; task shares are token
shares, never quota shares. Use `task` for the current Codex task, `last` for a requested latest receipt and
main/subagent breakdown, `tasks` for the compact workspace list, `diagnostics`
for collection health, `summary` for everything at once (latest receipt, ten
most recent tasks, consumption and collection health), `usage` for totals, and `profiles` for observed model and
effort buckets. Choose the other fixed mode that directly matches the request.
Do not query telemetry as a routine development preflight.

`last`, `usage`, `profiles`, and other non-`task` historical modes have
`receipt_scope: local_history`. A historical receipt does not identify the
current task or prove the active model or effort. Do not attribute it to the
active agent without a verified task binding.

Without `task_key`, `task` uses only trusted per-call Codex metadata. Never pass
a task ID, path, metadata, prompt, or other free-form argument. Missing task
binding stays unavailable and must never fall back to the newest or another
task. `current_task_correlation: matched` and
`receipt_scope: current_task_completed_turns` identify a matched completed-turn
window. A separate `current_turn` is provisional, may exclude unflushed usage,
and never changes completed-history totals. Bounded history is not a lifetime
total. Claude MCP has no verified per-call task binding.

When the installed tool schema supports `task_key`, use a key from `tasks` to
read that task's retained `task` or `task-forecast` history on either host.
`identity_basis: explicit_task_selection` identifies this deliberate selection,
not the active task. Current-turn usage and automatic correlation remain
unavailable for that selection. Never substitute a key from another host.

The default answer should summarize only the requested task or view. The compact
`tasks` view intentionally omits full profile histories and per-model rate
diagnostics; preserve `total_tasks`, `returned_tasks`, `omitted_tasks`, and
`truncated`. Fetch explicit `task` detail only when the user asks for it or the
answer needs it. A single-task request must not carry another task's details.

If the MCP tool is unavailable and the user explicitly requested a historical
report, use the bundled reporter only through an official host-owned root:
`PLUGIN_ROOT` for Codex or `CLAUDE_PLUGIN_ROOT` for Claude. Do not guess an
installation path. A loaded reporter keeps its instructions and reported version
until the host reloads it; see
[loaded-session state](references/optimization.md#tool-discovery-and-loaded-session-state)
when a report looks stale. Use the stable local CLI for explicitly requested detail
when available and explain the loaded-session limit once when relevant.

## Truth and identity rules

Treat top-level status exactly as `exact`, `partial`, or `unavailable`. Preserve
`null` and `unknown`; never convert missing counters or unresolved sources to
zero and never infer model, reasoning effort, service tier, account quota, task
identity, or savings. `usage pending` is not terminal unavailability.

Report observed model names and reasoning effort as returned. The fixed Codex
routing catalog recognizes `luna`, `terra`, `sol`, and `astra` (`gpt-6-astra`)
with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Unknown values remain
unknown. Exact pinned verification requires the selected model, effort, and
`primary` role tuple. Configured host settings are not proof of per-response
consumption.

Use task for the work being tracked, session for the host conversation, and turn
for one request and response. State token amounts in tokens (K = 1,000, M =
1,000,000, B = 1,000,000,000), durations in seconds or milliseconds, and quota
readings in percent. Explain a problem state and the next action from diagnostics;
keep internal codes in structured data rather than user-facing prose.

Keep observed tokens, calculated provider-rate usage, local plan pressure, and
official host quota separate. Never turn local observations into account
percentages without a valid same-unit, same-window denominator. Do not describe
API-equivalent cost as a subscription charge. Fast/Standard classification
requires structured requested/effective tier evidence; latency and model family
do not substitute for it.

Efficiency findings are deterministic structural classifications. Flagged
tokens are affected usage, not proven waste. Recommendations and shadow-policy
labels are report-only. Keep `potential_savings: unmeasured` unless exact,
outcome-equivalent, independent comparison evidence passes the documented
gates. Fewer tokens on failed work are not savings. One valid pair is an
observation; three pairs are a trend, not a causal guarantee.

Token arithmetic must preserve the provider contract: cached input is part of
input, reasoning output is part of output, and cache-write input is separate.
Missing or unflushed fields remain missing. If cached input exceeds input,
preserve observed counters, clamp only the derived uncached value to zero, and
mark quality partial.

## Privacy and scope

The reporting MCP reads only sanitized SomesToken state or an explicitly enabled
read-only ledger. It never accepts a state, plugin, transcript, or session path
from the caller. Never inspect, print, search, or ingest Codex rollout
transcripts. Never expose task/session IDs, opaque bindings, hashes, paths,
prompts, responses, account identifiers, raw errors, or JSON-RPC bodies.
`CODEX_THREAD_ID` alone is not an official ownership proof; managed recovery
remains `ownership_unavailable` without the documented ownership evidence.

Keep tool availability separate from report availability. A successful tool
response with `status: unavailable` means the tool ran and data is unavailable.
Missing telemetry is not a reason to retry, switch model/effort, delegate work,
or change task scope. Interpret `telemetry_preflight` internally and continue the
exact requested work; do not announce connection success or recite preflight
boilerplate.

For Claude, use the installed plugin so supported lifecycle hooks can capture
sanitized usage. The standalone MCP cannot install hooks. Claude cache-write
input remains a separate observed component, and reasoning-output tokens remain
non-measured because the hook transcript contract does not expose them.

## Load detailed guidance only when needed

Use `rg -n '^## ' references/optimization.md` to locate the relevant heading,
then read only that section through the next same-level heading; do not load the
whole reference. Read [references/optimization.md](references/optimization.md)
only when the current request needs exact CLI syntax, detailed report schemas or
field semantics, diagnostics procedures, workspace monitoring, task forecasting,
routing/profile advice, limit recovery, active efficiency policy controls, task lifecycle checks, or
optimization experiment workflows.
For an ordinary requested usage summary, the entry workflow above is sufficient.

The detailed reference is explanatory guidance. Its commands do not broaden the
user's request, enable collection, authorize host control, or make savings
measured. Preserve this entry skill's response, truth, privacy, and scope rules
when using it.
