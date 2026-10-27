# SomesToken detailed reporting and optimization reference

Read this reference only when an explicit request needs detailed CLI commands,
field interpretation, workspace monitoring, routing advice, limit recovery, or
optimization experiment procedures. The entry skill contains the rules that
apply to every invocation.

## Active efficiency policy

Use these controls only for an explicit efficiency-policy request:

```sh
node "$PLUGIN_ROOT/bin/optimization.mjs" policy set --host codex|claude --scope task|project|repository|host [--task-id <verified-host-id>] --mode balanced|observe --json
node "$PLUGIN_ROOT/bin/optimization.mjs" policy status --host codex|claude --scope task|project|repository|host [--task-id <verified-host-id>] --json
```

`task` requires a verified raw opaque host ID, which the CLI hashes internally.
`project` binds to the current exact working directory. `repository` explicitly
binds to the Git common directory, including nested directories and future
worktrees. Resolution is task, exact project directory, repository, then host.
`host` is an explicit all-task opt-in. `balanced` may emit one short fixed
instruction through the documented SessionStart/UserPromptSubmit
`additionalContext` path per scope revision and session; `observe` keeps
collection enabled without that instruction. Keep policy selection, hook
emission, actual application, and measured savings distinct. The policy never
changes model, effort, permissions, or retry behavior; retry guidance remains
advisory. Balanced guidance includes existing-code and standard-library reuse;
it does not require another optimization skill. For explicit comparisons, record
policy context version 2, the declared `ponytail_mode` and
`efficiency_policy_version` before work. Missing controls stay unknown; declared
mode is not host activation proof. A total-token decrease with higher uncached
input, output or cache-write input requires review. Missing component evidence
cannot support a positive recommendation. Pilot component costs include every
attempt and use accepted work as their denominator; missing data keeps its
target uncertain. Do not infer zero rework from passing acceptance checks alone.
See the official [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
and [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks).

Use this skill when the user asks to explain SomesToken receipts, see local history when available, inspect the last completed turn, review receipt accuracy, see the main/subagent breakdown, or inspect v0.4 optimization evidence in Codex or Claude Code sessions. If Ponytail is present, its configuration remains project-owned; SomesToken only reports an observed safe marker and never enables, installs or changes it. Ponytail is not required to use SomesToken.

Only use this workflow for Codex and Claude Code hosts.

## Native test report output

Use this when output optimization is authorized. Prefer the existing streaming
Node compact reporter for Node tests. The saved-report command supports these
native formats without running tests or intercepting other host tools:

| Format | Typical source |
| --- | --- |
| `junit-xml` | pytest `--junitxml=report.xml`, SwiftPM xUnit XML, Maven Surefire XML |
| `go-test-json` | `go test -json` output, including interleaved packages |
| `trx-xml` | `dotnet test --logger trx` results |
| `node-test-events-v1` | SomesToken's existing structured Node event contract, not arbitrary TAP |

Read the runner's actual exit status before summarizing. For example, inside the
project and using an existing report location:

```sh
go test -json ./... > report.json
test_status=$?
node "$PLUGIN_ROOT/bin/optimization.mjs" output summarize --host codex \
  --format go-test-json --input report.json --exit-code "$test_status" \
  --task-id "$CODEX_THREAD_ID"
```

The command returns that exit status. Keep the runner's stderr visible; build
errors outside the report are not captured by the summary. If the shell uses
`errexit`, capture failure explicitly before invoking the summary. For Claude,
use `--host claude` and its verified task ID. Supply verified `--run-id`,
`--model`, `--effort` and `--source-type main|subagent` when available; omitted
identity stays unknown. These are caller declarations, not host verification.

SwiftPM's XCTest xUnit generation requires its parallel runner in the inspected
version (`swift test --parallel --xunit-output report.xml`). Failure text may
require `--experimental-xunit-message-failure`; retain the native console output
when the report lacks diagnostics. Swift Testing can produce a separate XML
file. Do not change a project's test-library selection or parallelism solely to
enable compaction; use an already-produced supported report or keep native output.

Only structurally recognized, complete reports are projected. Failures and
warnings have bounded previews, with truncation and omitted-detail counts.
Unknown formats, unsafe XML, inconsistent totals, invalid UTF-8, and candidates
that are not smaller retain the original bytes. The CLI accepts regular,
non-symlink reports up to 4 MiB; larger files are rejected without output, so use
the runner's existing diagnostics path. It never deletes or copies the source.
`--max-bytes` (256–65536; default 16384) bounds projected stdout including the
receipt marker. It does not truncate an original passthrough report.

After a projected report, its marker supplies a receipt ID for bounded detail
reads. Use the same task and run scope and the unchanged original file:

```sh
node "$PLUGIN_ROOT/bin/optimization.mjs" output read --host codex \
  --input report.json --id RECEIPT --offset 0 --bytes 4096 \
  --task-id "$CODEX_THREAD_ID"
node "$PLUGIN_ROOT/bin/optimization.mjs" output report --json
```

Each explicit preparation and detail read records only bounded numeric metadata,
hashed task/run IDs, source digest and safe model/effort fields in existing state.
No report text, paths or additional background process is retained. Retention is
128 preparations and 128 reads; `dropped_records` discloses reduced coverage.
Per-scope `net_bytes_avoided = input_bytes - output_bytes - retrieval_bytes` can
be negative. Reads through `cat` or other tools are unobserved. Records describe
**prepared payload bytes**, not delivery to the model; they exclude instruction,
collection, parsing and later model/rework costs. Neither an absent read record
nor a positive byte difference proves token or account-quota savings.

The direct command and full optimization mirror retain task/run detail. Compact
snapshot schema 8 groups by host/model/effort and removes task/run IDs. It retains
64 detail groups plus at most two host overflow groups; `rolled_up_groups`
discloses lost detail while byte totals remain intact. Legacy snapshots return
null for this field. An MCP reader loaded before beta 39 keeps its previous code
until normal host refresh; later readers run each report from the settled installed
package (relinked Codex paths from beta 40). The streaming Node reporter does not automatically populate
this saved-report ledger.

Source contracts: [pytest JUnit XML](https://docs.pytest.org/en/stable/how-to/output.html#creating-junitxml-format-files),
[Go test2json](https://pkg.go.dev/cmd/test2json),
[SwiftPM test options](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Commands/SwiftTestCommand.swift),
[Microsoft TRX logger](https://github.com/microsoft/vstest/tree/main/src/Microsoft.TestPlatform.Extensions.TrxLogger).
Runner-specific XML extensions outside the supported subset pass through.

### Opt-in output guard

Off by default. `output guard enable|disable|status --host codex|claude` switches
it per host with that host's plugin data variable (`CLAUDE_PLUGIN_DATA` or
`PLUGIN_DATA`).

**When it fires.** It runs after a shell result: PostToolUse on Codex and Claude,
plus PostToolUseFailure on Claude, where a failing command lands. If the result
came from `node --test`, `pytest` or `go test` and holds at least 8 KiB of output,
it adds one fixed note to the model context. The note gives the compact recipe
for that runner and repeats for every large result while the guard is on.

**What it never does.** It never blocks, rewrites or stores a command. The command
and output are read in memory only. `output-guard.json` in the plugin state
directory keeps the switch and three counts per runner:
- `runs`: results from that runner;
- `nudged`: notes added;
- `compact`: runs that already used the compact reporter or `output summarize`.

**Not covered.**
- `npm test` and other wrappers hide their runner and are not matched.
- Claude drops hook input over 256 KiB.

The counts show whether the note fires and whether agents follow it. They are
not token or account-quota savings.

**Read guard (`--kind reads`).** A separate switch, off by default, with its own
file, `read-guard.json`; the test-runner guard above is `--kind tests`, the
default. It fires on the same events after a shell search (`rg`, `grep`,
`git grep`, `find`, `fd`) or file read (`cat`, `nl`, `head`, `tail`, `sed -n`)
with at least 8 KiB of output. The note suggests locating lines with `rg -n`
before reading a range with `sed -n`, or narrowing a search with `rg -l`,
`rg -m` or a path or glob. Test runners are matched first, then searches, then
reads; a read after a pipe (`git diff | head`) only filters another command's
output and is not matched. The file keeps `runs` and `nudged` per rule.
`SOMESTOKEN_READ_GUARD=on` or `off` in a host process's environment (for
example on one `codex exec`) switches the read guard for that process only and
wins over the file; it is meant for paired experiments, writes no state, and
those runs are not counted. Other values fall back to the file.
Claude's Read and Grep tools are not shell commands and are not covered. Large
reads and searches are an estimated 6–18% of credits in long Codex sessions on
one machine; savings not measured.

## Task lifecycle checks

Supported lifecycle hooks record a bounded, host-scoped check for new tasks and
continuations. SessionStart/resume, a new UserPromptSubmit, and PostCompact renew
the generation; Stop, StopFailure and SessionEnd close it. The first prompt after
SessionStart shares that generation. A generation from another task, host, or
previous continuation cannot satisfy the current check. No model is called.

Development skill checks are opt-in per task/project/repository/host, separate from the
balanced/observe efficiency mode. Preserve the existing mode when enabling them:

```sh
node "$PLUGIN_ROOT/bin/optimization.mjs" policy set --host codex --scope repository --mode balanced --development required --json
node "$PLUGIN_ROOT/bin/optimization.mjs" lifecycle status --host codex --task-id "$TASK_ID" --json
```

Use `--host claude`, `CLAUDE_PLUGIN_ROOT` (installed code) and
`CLAUDE_PLUGIN_DATA` (this host's data) for Claude. Manual shells do not inherit
hook variables automatically. Supply the known host-owned absolute data path;
do not guess it from another host or the latest task. Without a host data root,
lifecycle commands return `host_plugin_data_unavailable` and exit 2; an unreadable
root returns `plugin_data_unreadable`. Neither means the hook never ran.
`not_observed` means the selected identity has no lifecycle record in available
host data. Codex uses `PLUGIN_ROOT` and `PLUGIN_DATA`. A public package mirror is
not sufficient for a lifecycle attestation. Project scope uses
the exact working directory; repository scope also includes future worktrees. Task scope takes
precedence, so benchmark tasks can explicitly use `--development off` while
preserving their existing mode and Ponytail condition. Do not enable these
development requirements globally merely because a user runs a benchmark.

Select and read all relevant skills and supporting references before deciding
the implementation. Save one local receipt referencing the files actually used:

```json
{"skills":[{"id":"applicable-skill","references":["/absolute/SKILL.md","/absolute/support.md"],"application":"/absolute/handoff.md","verification":"/absolute/check.log"}]}
```

Obtain `N` from this task's `lifecycle status`, then register `--stage selected`
before implementation. After applying the skills and running the required
checks, register `--stage applied` and check completion:

```sh
node "$PLUGIN_ROOT/bin/optimization.mjs" lifecycle skills --host codex --task-id "$TASK_ID" --stage selected --generation N --evidence /absolute/receipt.json --json
node "$PLUGIN_ROOT/bin/optimization.mjs" lifecycle skills --host codex --task-id "$TASK_ID" --stage applied --generation N --evidence /absolute/receipt.json --json
node "$PLUGIN_ROOT/bin/optimization.mjs" lifecycle check --host codex --task-id "$TASK_ID" --json
```

Claude background-notification limitation (checked 2026-09-23, local CLI 2.1.280):
the [official UserPromptSubmit input](https://code.claude.com/docs/en/hooks#userpromptsubmit-input)
documents `prompt` plus common fields, with no reliable origin discriminator.
If a host version delivers a background task notification as UserPromptSubmit,
SomesToken cannot distinguish it from a real continuation: the generation will
renew. Prompt text, XML-like notification tags, timing and undocumented fields
are not used to bypass the development check. After a renewal, reselect/apply
relevant evidence against the new generation. Fixing that host ambiguity needs
a documented origin field or a host change; it is not claimed solved here.

Both `status` (read only) and `check` read current collector health and use the
shared interval-aware heartbeat calculation. `status` does not persist that view.
The final command exits 2 while the configured collector lacks recent successful
health evidence or required skill evidence is pending. It refreshes collector
health without resetting the generation. For an already-running task that has
not observed a supported hook since installation, explicit `lifecycle begin`
creates a new check; it cannot clear that task's existing development requirement.
Supply a known host task ID, never guess it from the latest receipt. These CLI
IDs select a record; they do not establish trusted current-task usage binding.

Only hashes, counts and fixed states are retained (at most 128 task/host checks).
Receipt input is limited to 64 KiB, 32 skills, and 16 source files per skill;
source/application/verification files are bounded at 1 MiB and must be regular,
non-symlink files. Reference hashes must match the recorded selection. Keep the
application note specific: which finding, implementation or validation used each
reference. Existing handoff and test logs suffice; do not copy raw telemetry.

This is **file-backed self-attestation**, not proof that a model understood a
skill, that the selection was exhaustive, or that skills caused savings. Collector
health proves a recent service observation, not complete current-task tokens.
`mode: optimization` exposes an identity-free `lifecycle_checks` summary only
when requested. Do not append it to ordinary task answers.

Fixed reminders use SessionStart/UserPromptSubmit additionalContext. PostCompact
resets evidence; its next supported prompt/start can carry the reminder. Claude's
PostCompact output cannot inject context. Hooks do not block the user's task or
create Stop retry loops; the required completion check is enforced by its nonzero
CLI result and the project's development instructions. Disabled/untrusted hooks
or an MCP module loaded before beta 39 cannot be silently overridden. See the
[Codex hook contract](https://developers.openai.com/de-DE/docs/hooks) and
[Claude hook contract](https://code.claude.com/docs/en/hooks).

## Response contract

The default final response is the user's requested task deliverable: findings,
changes, validation, remaining work, or the full report they asked for. Complete
that deliverable at the requested level of detail. Background usage collection
continues silently and does not add a usage appendix to ordinary task endings.

When the current request asks for usage, provide the requested scope and detail.
When it asks for both the task result and usage, deliver the complete task result
first, followed by a concise usage section. SomesToken must never replace, cut
short, or consume the space reserved for the requested task report. If space is
limited, shorten optional telemetry instead of the task deliverable.

An earlier usage request or an `@SomesToken` mention does not create a recurring
reporting requirement. Repeated completion reports require an explicit user
request for that behavior. Routine completions need no token/model/effort table,
quota estimate, unavailable-data disclaimer, export, or reporting-tool call.
If measured usage is needed to perform requested optimization work, use it
internally and include only findings relevant to that requested deliverable.
Create an export only when the user requests an export. Existing bounded
alerts and the optional host status line do not instruct the assistant to append
a usage report or to change the task's model, effort, workflow, or final output.

Honor the user's latest reporting preference after compaction and in ongoing
tasks. A request to stop repeated reports overrides older project guides, pilot
protocols, or conversation summaries that require completion telemetry. A pasted
usage report offered as a complaint or debugging example is not a new request to
calculate usage. Answer that complaint and preserve the active task deliverable;
do not revive an earlier usage or undo request from history. When investigating a
recurrence, check applicable project instructions as well as installed hooks:
silent hook output does not prove an assistant stopped generating its own tables.

For Claude Code users, install SomesToken as a Claude plugin so its `SessionStart`, `SubagentStart`, `SubagentStop`, and `Stop` hooks can capture Claude transcript usage. The bundled MCP server is read-only and reports the sanitized state produced by those hooks. A standalone MCP entrypoint can report existing state, but it cannot install hooks or create new receipts.

Claude transcript usage is normalized from provider fields: uncached input plus cache-read input becomes `input_tokens`, `cache_read_input_tokens` becomes `cached_input_tokens`, and `output_tokens` remains `output_tokens`. `cache_write_input_tokens` is retained as a separate observed component and is not folded into `total_tokens` without an active versioned pricing contract. Claude Code does not expose a separate reasoning-output counter in the hook transcript contract, so `reasoning_output_tokens` remains a non-measured zero for Claude receipts; do not describe it as observed reasoning usage.

Prefer the installed SomesToken Local Reporting MCP tool `get_somestoken_report`. In Claude Code its registered name is scoped by the plugin and server, for example `mcp__plugin_somestoken_somestoken-local-reporting__get_somestoken_report`; use the exact name shown by the host. Call it directly, using only these fixed inputs:

```text
mode: last | task | tasks | daily | consumption | task-forecast | usage | profiles | fast | quality | health | efficiency | loops | plans | plan-comparison | quota | credits | limits | limit-recovery | capabilities | provenance | recommendations | workflow | session-summary | trends | compare | acceptance | experiments | experiment | optimization | measured-reduction | manual-gates | goal-hygiene | shadow-policy | calibration | diagnostics | summary
last: 1...100
```

Use `summary` for one overview (newest receipt, ten most recent tasks, consumption and
collection health), `last` for the newest receipt and ordinal main/subagent breakdown, `usage` for
observed and plan-aware receipt totals, `consumption` for host account windows and retained workspace usage, `profiles` for observed model/effort buckets,
`quality` for accounting quality, `health` for bounded runtime counters,
`fast` for structured Fast/Standard service-tier usage, separately observed
ultrafast tiers, and comparable Fast/Standard token pressure,
`efficiency`/`loops` for structural findings, `plans`/`plan-comparison` for plan
pressure, `quota` for host/manual quota fields, `credits` for calculated
provider usage, `capabilities`/`provenance` for event support evidence,
`recommendations` for deterministic structural advisory candidates, `workflow`
for a time- and evidence-gated Codex model/workflow candidate, `session-summary` for
closed-session reconciliation and structural metrics, `trends`/`compare` for
comparable historical baselines, and `acceptance` for bounded host evidence.
The MCP bridge prefers host-provided plugin data and otherwise
reads only SomesToken's bounded, sanitized plugin-owned snapshot. Treat its
top-level `status` as exactly `exact`, `partial`, or `unavailable`.
For Codex, the bundled MCP server derives only its own package root and accepts
only a mirror explicitly marked `codex`; hostless legacy mirrors and a Claude
mirror are `unavailable`. It never accepts a state or plugin path from a tool
caller.

The fixed Codex routing catalog recognizes `luna`, `terra`, `sol`, and `astra`
(`gpt-6-astra`) with six retained efforts: `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. Capability evidence is bounded to 24 model/effort pairs;
profile-plan evidence is bounded to 48 model/effort/role entries for `primary`
and `worker`. Exact pinned host verification requires the selected model, effort,
and `primary` role tuple. Astra Max never automatically escalates to Sol; only
Luna/Terra Max retains the high-pressure Sol candidate.

## First useful answer

For an explicit installation or measurement-health question, use `diagnostics`.
Read its `collection` section independently of receipt `status`: a missing old
receipt does not mean a fresh collector stopped. Start with the collection
assessment, scoped host coverage and next action. Report collection as recent
snapshot evidence; `process_liveness: not_checked` is not a live process probe.
A stopped/stale collector needs a collector check, not a task/model restart.
Quota-only failure does not erase available local usage. Do not configure a new
feed during an unrelated task; disabled workspace monitoring is optional.

For task browsing, preserve `total_tasks`, `returned_tasks`, `omitted_tasks` and
`truncated`. Never describe the displayed first 100 tasks (20 in the console)
as the complete workspace when rows are omitted. Observed model/effort may
include transitions; unfinished historical records are not proof a task is
running now. Expand to the existing task/model/source detail only when needed.
The bounded tasks list retains model totals while omitting full profile histories
and per-model rate diagnostics; request explicit task detail for those fields.

For a requested forecast, use existing `task-forecast` with trusted task binding.
The explicit local fallback is `somestoken --task-id=<verified-task-UUID>
--host=codex --view=task-forecast --json` (or `--host=claude`). Keep the command on
one line when executing. It selects that task explicitly and does not establish
MCP caller identity. Never select the newest task as a substitute. State the
request-group prediction unit, learning/sample gate, snapshot freshness and
P50/P80 only when supplied; do not turn it into a whole-project promise.

Lead requested explanations with the answer, then necessary evidence and a
concrete next action if one remains. Preserve full requested reports and real
uncertainty. These presentation rules do not start recurring reports, add a
style plugin, change model/effort or call a model in background collection.

## Tool discovery and loaded-session state

When telemetry is actually requested, first check the host's callable tool
inventory for `get_somestoken_report`, including names scoped by the plugin or
`somestoken-local-reporting` server. If the host uses deferred tools, use its
provided tool discovery once with those exact names. A missing search result for
the display name `SomesToken` alone does not prove the tool is unavailable.
Call the exposed tool directly when present; do not search repeatedly.

Keep tool availability separate from report availability: a successful response
with `status: unavailable` means the tool ran but data is unavailable. A tool
missing from this session says nothing about hook capture or stored receipt
quality. Do not write a telemetry outcome or claim to record usage merely because
tool discovery failed. The reporting MCP is read-only.

Installed files and a running MCP process can differ after an update. A loaded
report schema below 16 lacks the `task` view; request only modes in the exposed
schema. Updated stable CLI and collector code can serve explicitly requested
current detail without interrupting the task. From beta 39 the loaded MCP reporter
runs each report from the settled installed package (relinked Codex paths from
beta 40). Its instructions and reported version, and reporters loaded before beta
39, remain unchanged until the host's normal reload. From beta 41 Claude refreshes
a changed tool schema on list_changed; Codex keeps the loaded schema until reload. For explicitly requested missing detail, use the stable
local console CLI fallback when available. Never claim installation reloaded an
existing session or repeatedly reinstall to repair that session's cached tool
inventory.

## Structured Codex task ledger (report schema 17)

When an operator has enabled the read-only Codex ledger, `mode: task` returns
`source: codex_ledger` directly from structured host usage records. This route
remains per-call task-bound and works when hook receipts stopped updating. It
reports completed main turns, linked descendant usage, response-level model and
effort buckets, source gaps, and the latest completed-turn timestamp. Receipts
are grouped by host root turn so resumed main turns never duplicate child usage.
`exact` covers the selected validated ledger window, not an unbounded lifetime,
current in-flight usage, billing, or savings. Unknown models remain unknown.
A bounded window that cuts a shared root turn stays partial.

The session root is explicit operator configuration, never an MCP argument:
`SOMESTOKEN_CODEX_SESSION_ROOT`, or the installation-local configuration written
by `node <installed-plugin>/bin/report.mjs --enable-codex-ledger=<absolute-session-root>`.
Do not enable access during unrelated work. Never silently scan a user's home
or infer a root from task IDs. The configuration and transcripts are excluded
from packaged artifacts. Without opt-in, the existing public receipt bridge
remains in use. A loaded schema 16 process does not acquire schema 17 by changing
files; installation and live process version must be distinguished.

For an explicitly requested historical repair, the operator CLI accepts
`--task-id=<verified-task-id> --codex-session-root=<authorized-root> --last=100 --json`.
This is a historical audit, not a current-caller MCP proof. It never rewrites
host logs or old receipts. Do not substitute last receipt metadata for the
per-response model buckets or treat missing descendants as zero consumption.

## Telemetry preflight

Do not invoke SomesToken as a routine preflight for unrelated development.
Interpret preflight fields internally. Do not announce connection success,
recite the skill contract, claim to save evidence, or announce that scope and
development decisions remain unchanged. Continue the requested work silently.
When the user requests telemetry, answer with the requested numbers and a short
scope/quality label; explain limitations only when relevant to that request.

For this Codex task's usage, prefer MCP `mode: task`. The server reads only
host-supplied `params._meta["x-codex-turn-metadata"]` for each call and matches
completed receipts to that thread. Do not supply task IDs, metadata, paths, or
other free-form arguments yourself. `current_task_correlation: matched` and
`receipt_scope: current_task_completed_turns` identify a matched completed-turn
window; `completed_history_status` describes its quality when present. `history_coverage` is bounded
recent history or a latest-receipt-only snapshot, never an entire task lifetime.
With structured Codex ledger access, host turn identity also selects a separate
`current_turn` snapshot. `current_turn_usage: partial` means observed usage is
available but the turn is unfinished; show its `main_usage`, `subagent_usage`,
`last_token_event_at` and coverage gaps separately from historical `total_tokens`.
The overall report is partial while such a live snapshot is present. A first
active turn may have usage while completed-history totals are null.
`current_turn_usage: unavailable` means no valid matching active snapshot is
available, not zero consumption. Unflushed responses are not measured. Never
select an active turn by date or newest-file order. Shared resumed roots do not
permit guessing which child usage belongs to the current main turn.
Missing metadata, no matching receipt, or legacy identity-free snapshots remain
unavailable. Do not substitute another task's newest receipt. Claude and the CLI
have no verified per-call task binding in this view and remain unavailable.

Other report modes describe completed local history. `receipt_scope:
local_history` and `previous_receipt_created_at` identify historical evidence;
they do not attribute it to the requesting task. Historical model metadata does
not prove the currently running model. Missing telemetry is not a reason to
switch models or delegate to another writer.

Package-root mirrors expire ten minutes after publication, even when copied or
reinstalled. Old mirrors without publication timestamps are unavailable until
a real hook rewrites them. A fresh mirror can still contain an old receipt:
check the receipt timestamp and preserve the returned evidence scope.

Every MCP response includes `telemetry_preflight`. If its `report_source` or
`usage` is `unavailable`, it is not a task blocker: keep usage unavailable,
do not retry telemetry or invent a value, and continue only within the
caller-supplied exact task scope. The fixed `data_access` enum says whether
host plugin data is absent/unreadable or a public snapshot is stale/unavailable
without revealing a path. `active_goal: not_observed` means SomesToken does not
read or control the host goal; it is not evidence that the host has no goal.
This is the internal preflight interpretation, not a message to echo:

```text
TELEMETRY_PREFLIGHT: source unavailable or no prior receipt; data_access explains the bounded source state; execution continues; usage remains unavailable; scope=exact_scope_only.
```

For a requested historical report, if the MCP tool is not available but the host supplies `PLUGIN_ROOT` (or Claude's
official `CLAUDE_PLUGIN_ROOT` alias), use the bundled reporter. It uses the same
report adapter and can read the sanitized snapshot without requiring a skill
shell to receive `PLUGIN_DATA`:

```sh
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  SOMESTOKEN_RUNTIME=claude node "$CLAUDE_PLUGIN_ROOT/bin/report.mjs" --json --last=10
elif [ -n "${PLUGIN_ROOT:-}" ]; then
  SOMESTOKEN_RUNTIME=codex node "$PLUGIN_ROOT/bin/report.mjs" --json --last=10
else
  printf '%s\n' 'SomesToken: local history unavailable in this session.'
fi
```

The runtime value above is derived only from the official host-owned root
alias. Do not set it from a guessed installation path or a generic shell
variable with ambiguous provenance.

Supported CLI variants include `--last=10`, `--breakdown`, `--summary --last=10`,
`--health`, `--quality --last=10`, `--usage --json --last=100`,
`--plans --json --last=100`, `--quota --json --last=100`,
`--credits --json --last=100`, `--efficiency --json --last=100`,
`--usage-json`, `--efficiency-json`, `--capabilities --json`,
`--provenance --json`, `--recommendations --json`,
`--session-summary --json`, `--trends --json`, `--compare --json`,
`--acceptance --json`, `--workflow --json`, `--experiments --json`, `--optimization --json`,
`--measured-reduction --json`, `--manual-gates --json`, `--goal-hygiene --json`,
`--shadow-policy --json`, `--calibration --json`, `--profiles --json --last=100`,
and `--json --last=10`.
Use `--fast --json --last=100` or `--fast-json --last=100` for observed Fast
versus Standard service-tier usage. `priority`/`fast` are Fast and `default` is
Standard; structured `ultrafast`, `auto`, and `flex` are retained separately and
never enter the Fast/Standard denominator. Fast is counted only when the host
supplies structured requested/effective service-tier fields; latency and model
family signals never replace observed Fast evidence. A requested Fast tier that
returns `default` is reported as downgraded. Missing effective-tier fields remain
unavailable. Token totals, usage ratios, latency, and model-family signals do
not infer a missing tier or enter observed Fast/Standard usage. Prompt text is
never inspected.

On-request receipt reports include the complete observed token partition (`input`, `cache hit`, derived `cache miss`, `output`, `reasoning output`, and `cache write`) in addition to totals. These values are aggregated across the main turn and resolved subagents; use `--breakdown` or the MCP `last` view for each ordinal subagent's six counters. The readable `--breakdown` labels the derived difference as `uncached input`, in tokens; JSON field names stay unchanged.

Use `--json` when the user asks which model or reasoning profile ran, or asks for detailed usage. Each selected receipt contains `turn_breakdown.main`, ordinal-only `turn_breakdown.subagents`, and `turn_breakdown.totals`. Resolved sources expose observed `model` and `reasoning_effort` plus `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `cache_write_input_tokens`, and `total_tokens`. Use `--breakdown` for a readable equivalent (`main`, `subagent 1`, `subagent 2`, …). Never expose internal hashes or infer missing model/reasoning values; say `unknown`, `partial`, or `unavailable` as returned.

The reporter and MCP share one adapter over either SomesToken's sanitized state under `PLUGIN_DATA` or its sanitized public snapshot. Task matching uses rotating opaque receipt bindings; neither those bindings nor internal hashes are exposed in MCP reports. A stale or expired host-owned public snapshot is `unavailable` for public-only reads; it never falls through to an older mirror or raw state. When host data is absent, the Codex MCP may use only its host-marked packaged mirror; a hostless or cross-host mirror remains unavailable. `--summary` reports bounded aggregate totals and conservative main/subagent breakdowns; `--health` reports bounded numeric data-quality counters; `--quality` reports the selected receipt window's exact/partial/unavailable distribution, exact-rate, source coverage, token-event validity, checked/consistent/inconsistent/unknown usage-consistency counters, and fixed degradation reasons. Explicit token arithmetic inconsistency is degraded; missing legacy consistency evidence remains unknown and is never counted as exact. Quality rates use explicit denominators and are `unavailable` when no denominator exists; it never invents missing values. Do not inspect, print, search, or ingest Codex rollout transcripts. Report `exact`, `partial`, and `usage unavailable` literally when state is present but unavailable; when a stop receipt is still reconciling a bounded post-turn source, report `usage pending` and do not treat it as terminal unavailable. Ordinary completion receipts are stored silently. The supported hook `systemMessage` path carries only existing bounded alerts, not routine usage summaries; alerts never replace the requested task deliverable.
For a requested Claude `StopFailure` report, explain the bounded unavailable receipt with `reason=stop_failure` and an optional fixed `stop_failure_category`; never expose `error_details` or `last_assistant_message`. A later structured `Stop` may reconcile that same pending receipt.

Use `--usage --json --last=100` for the bounded historical usage view. It separates main and subagent totals, attributed versus unattributed tokens, selected-turn and observed-receipt averages, subagent share, model/reasoning coverage, safe model/reasoning profile buckets, and an ordinal trend without turn IDs, agent hashes, paths, or transcript content. `status` is `exact`, `partial`, or `unavailable`; missing source telemetry remains `null`/`unknown` and is never inferred. Unresolved expected sources are not converted to zero.

Plan-aware usage keeps observed tokens, calculated provider-rate usage, local plan
pressure, and official host quota separate. Codex credits are labelled calculated;
Claude API cost is separate from Pro/Max subscription usage. Local Codex/Claude
observations do not become account percentages without a valid same-unit,
same-window denominator. Relative-only pressure is allowed; invented percentages
are not.

Workspace task reports also expose `recent_activity` per task/model/source and
`quota_rate_estimates`. Recorded rates use a recent wall-clock window, not summed
response durations. `quiet` means no recent recorded usage with healthy coverage;
unfinished/unflushed tokens remain unmeasured. Stale snapshots suppress rates.
Use existing `tasks`, `task-forecast`, or matching `task` views; the stable local
CLI serves running tasks whose loaded MCP schema has not refreshed.

Quota rate estimates are conditional predictions in percentage points per hour,
separate from exact `quota_percent`, which remains null. Calibration needs three
disjoint qualifying prospective intervals with matching provider/account/reset
and known price/model/effort/tier/context evidence. Rounding bounds are not
confidence intervals; cloud/other-device activity can confound local attribution.
Never present API dollar equivalents as subscription charges or effort as a
fixed quota multiplier. Codex quotas cannot calibrate Claude usage. A provider
without attributable quota evidence stays unavailable while token rates remain
available. Claude's optional official status-line capture exposes account quota
and configured model/effort in `host_observation`. Configured settings are not
per-response consumption metadata. That surface lacks account identity and its
context-window counters are not cumulative token usage. The optional status line fits the terminal width (or `COLUMNS`, capped at 256 columns) by dropping complete segments, so a value keeps its unit. At very narrow widths only the SomesToken label or an ellipsis fits. Missing usage is unavailable, with a diagnostics action when space permits; it is never shown as zero. Do not mix it into
Codex calibration or treat delivery time as a provider refresh timestamp.
Request-group quota forecasts also require a priced independent
historical cohort; they are not full-project cost or validated savings.

Use `--efficiency --json --last=100` for deterministic structural classifications
and fixed reason codes. High plan pressure alone never proves a loop. Background or
scheduled work is reported as intentional recurring activity when the host exposes
it. Flagged-turn tokens are affected usage, not wasted usage, and savings remain
unmeasured.

Use `--capabilities` or `--provenance` to see whether a reason code is documented,
fixture-verified, observed, live-verified, unavailable, version-incompatible, or
missing required fields. A fixture is never presented as live host evidence.
Use `--recommendations` for the fixed-template, report-only advisor; it never
changes a model, effort, plan, tool, agent, or host setting. `--session-summary`
closes only supported session windows and preserves pending or unavailable state.
`--trends` and `--compare` use only comparable, bounded historical receipts;
incomparable windows return an explicit unavailable result.

## Codex limit recovery

SomesToken v0.6 can observe an authoritative Codex App Server rate-limit
snapshot without turning ordinary hooks or MCP into a controller. The default
mode is `disabled`. `host_native_observe` records the host-owned Desktop
auto-continue choice as an external/manual capability; SomesToken does not read
or toggle that UI. `managed_companion` is a separate, explicit operator mode
and requires a single SomesToken-owned App Server session plus
`--explicit-opt-in`:

```sh
npm run limit-recovery -- status --json
npm run limit-recovery -- observe --json
npm run limit-recovery -- run --mode=managed_companion --explicit-opt-in --json
```

`CODEX_THREAD_ID` alone is not an official ownership proof and is never used to
attach to a task. The currently documented App Server surface does not expose a
same-transport SomesToken ownership receipt, so beta.2's live managed command
returns `ownership_unavailable` before launching an App Server child or sending
any thread mutation. The protocol fixture can exercise the bounded controller,
but it is not live reset/resume evidence. If an official ownership receipt is
introduced later, the companion may wait once for a structured usage-limit event
and reset snapshot, revalidate the active goal and idle thread, and send at most
one fixed continuation. It never consumes reset credits, replays a prompt,
attaches to a Desktop-owned thread, retries an uncertain mutation, blocks a
hook/tool, stops an agent, or changes a model/plan. `status` and `observe` are
read-only; `cancel` only terminalizes the SomesToken-owned bounded state. Missing
reset data, unsupported App Server methods, stale snapshots, approval/user
activity, process restart, or absent ownership remain `unavailable`/`canceled`
rather than being inferred. Public reports expose only fixed enums, percentages,
reset time, bounded counters, and reason codes; raw thread IDs, goal text,
prompts, responses, account identifiers, and JSON-RPC bodies are never
persisted or returned.

Use `--workflow --json --last=100` for the bounded workflow advisor. It waits for
the default ten exact comparable Codex turns and thirty minutes of elapsed
observation (or a validated local `workflow_advisor` configuration), plus
observed or live-verified capability evidence. A low
structural-pressure window can suggest a lower-cost balanced candidate such as
Terra/medium; a high-pressure window can suggest Sol/max/deep reasoning. The
result is a candidate for review before a host profile decision, never an
automatic model or effort change. Astra is a supported catalog family; high
pressure can raise Astra to Max by the effort axis, while Astra Max has no
automatic Sol candidate. Only Luna/Terra Max retains that model escalation.
Claude local usage remains insufficient for a guessed subscription model
recommendation, and all potential savings remain `unmeasured`. An eligible stop
receipt may include one cooldown-deduplicated `SomesToken workflow advisor` line;
report-only hooks never block, stop, restart, or continue a host action.

## Efficiency work and experiments

For requested efficiency work, use existing measurements internally. Read only
relevant file ranges and changed context, filter long tool output, give workers
bounded responsibilities and only the context they need, and avoid repeating a
passing broad check without a new change or concern. Preserve required tests
and the full requested deliverable. These are reviewable workflow choices,
not measured savings or automatic model/effort changes. Do not launch artificial
work or repeated telemetry queries to manufacture evidence.

For targeted Node test runs, request the compact deterministic projection with
the packaged reporter and pass the actual bounded test paths:

```sh
node --test --test-reporter="$PLUGIN_ROOT/lib/optimization/node-test-compact-reporter.mjs" tests/...
```

The reporter preserves test failures, process exit behavior, and original
standard error. Oversized diagnostics are explicitly marked as truncated; never
present a projected summary as complete native output.

Optimization experiments are explicit, local and CLI-only; MCP is read-only.
Use the host-owned plugin root (`PLUGIN_ROOT` for Codex or
`CLAUDE_PLUGIN_ROOT` for Claude) with `bin/optimization.mjs --help` for options.
Record the chosen policy controls before `experiment begin`, then close with
observed counters and verified acceptance evidence. Policy context is versioned:
subagent/fanout limits, retry, cache, session, manual-gate and context policies
are separate from measured cache hits, retries and actual fanout. A valid pair
changes one declared configuration axis; its measured results may differ.
Missing historical controls stay ineligible and cannot be filled in after work.
`other_safe_enum` is not an executable comparison axis.

Only exact, outcome-equivalent, independent task/root pairs with matching
acceptance evidence produce measured reductions. One pair is an observation;
three independent valid pairs form a paired trend, not a causal guarantee.
Use `experiment compare` for a requested comparison. Failed work with fewer
tokens is not an optimization. General recommendations retain
`potential_savings: unmeasured`; shadow-policy labels never control the host.

Close observations can include `input_tokens`, `cached_input_tokens`,
`output_tokens`, `reasoning_output_tokens`, `cache_write_input_tokens`,
`total_tokens`, `main_tokens`, `subagent_tokens`, `rework_count`,
`retry_rate`, and `fanout`. Cached input is already part of input; derived
`new_input_tokens` is input minus cached input and is not added again. Reasoning
output is a subset of output and is not re-added. Cache-write input is separate;
Claude reasoning remains unmeasured. Missing or unflushed values remain missing,
never zero.

Measured pairs expose `component_metrics`, and aggregate results expose
`component_summary`, with per-component observed percentages. Their
`duration_basis=work_started_to_closed_elapsed` includes waits from work start
through close and is not active model speed. `benefit_status` and
`benefit_reason_codes` separate measured token reduction from overall efficiency:
extra rework or elapsed work above `max(1 second, 5% of baseline)` requires
review; missing rework evidence is insufficient evidence. A positive token
reduction does not automatically produce recommendation status
`measured_positive`.

Use `--profiles --json --last=100` for actual observed model/effort profile telemetry. It groups the fixed `luna|terra|sol|astra|unknown` and `low|medium|high|xhigh|max|ultra|unknown` buckets, reports bounded main/subagent source counts and known token averages, and preserves `null` for missing usage. `target_status` is always `unmeasured`: this mode does not read or persist a profile plan and cannot claim that a target changed quality or token usage. `--profile-plan` and `--profiles` are separate, mutually exclusive workflows.

Profile and routing quality is `partial` with fixed reason `source_total_mismatch` when a usable receipt total disagrees with its sanitized source breakdown, or `usage_inconsistent` when explicit token arithmetic evidence is false. Missing totals remain `null`/unavailable and are not treated as mismatches; missing consistency flags remain unknown.

If a normalized receipt reports `cached_input_tokens` greater than
`input_tokens`, SomesToken keeps the observed counters and total, clamps derived
uncached input to zero, and downgrades usage and credit quality to `partial`.
It never reports a negative cache miss or treats that partition as exact. The
plan-aware aggregate labels the resulting `uncached_input_basis` as
`receipt_lower_bound`; do not describe that number as an exact aggregate
subtraction.

## Routing Advisor

Use the Routing Advisor when the user asks which Luna, Terra, Sol, or Astra model family and reasoning effort is suitable for a Codex task, whether a `max` ceiling can be lowered, or how many bounded workers are appropriate. It is local advice only: it does not change the active model, write a Codex profile, restart a session, create workers, accept hook trust, or change desktop settings.

First classify the request internally into these fixed values only:

```text
route: light | medium | heavy | ultra
task shape: inspect | bounded_fix | diagnosis | migration | security | release
risk: low | medium | high
parallelism: none | limited | independent
model family: luna | terra | sol | astra
effort ceiling: low | medium | high | xhigh | max | ultra
policy: adaptive | pinned
```

Never pass task text, prompts, source code, paths, identifiers, or any free-form user content to the reporter. Run only fixed `--name=value` arguments. For an adaptive Luna bounded fix:

```sh
if [ -n "${PLUGIN_ROOT:-}" ]; then
  node "$PLUGIN_ROOT/bin/report.mjs" --recommend --json \
    --route=light --task-shape=bounded_fix --risk=low --parallelism=none \
    --model-family=luna --effort-ceiling=max --policy=adaptive
else
  printf '%s\n' 'SomesToken routing · unavailable on this host'
fi
```

To request a capability-aware, host-required profile plan, use only the additional fixed flag:

```sh
if [ -n "${PLUGIN_ROOT:-}" ]; then
  node "$PLUGIN_ROOT/bin/report.mjs" --recommend --profile-plan --json \
    --route=light --task-shape=bounded_fix --risk=low --parallelism=none \
    --model-family=luna --effort-ceiling=max --policy=adaptive
else
  printf '%s\n' 'SomesToken routing · unavailable on this host'
fi
```

`--profile-plan` returns advice only. Its boundary labels are
`advisory_action=review_only`, `application_status=host_required`,
`host_action=apply_profile_if_supported`, and
`monitoring_action=continue_current_task`. SomesToken does not apply a model,
write a Codex profile, restart the session, create workers, or change
trust/desktop settings. A `host_default` worker remains explicit with
`model_id: null`; no host model is guessed. Exact host verification of a pinned
profile requires the selected model, effort, and `primary` role tuple.

For an explicit user selection, use `pinned` and repeat that safe selection in the required pinned fields:

```sh
if [ -n "${PLUGIN_ROOT:-}" ]; then
  node "$PLUGIN_ROOT/bin/report.mjs" --recommend --json \
    --route=light --task-shape=bounded_fix --risk=low --parallelism=none \
    --model-family=luna --effort-ceiling=max --policy=pinned \
    --pinned-model=luna --pinned-effort=max
else
  printf '%s\n' 'SomesToken routing · unavailable on this host'
fi
```

`adaptive` treats the selected effort as a ceiling and may recommend a lower fixed effort. `pinned` preserves the exact selection and reports `host_verified` only when the host supplies the exact model, effort, and `primary` role tuple; otherwise it remains unverified. `ultra` is host-specific: it becomes `host_verified` only when trusted capability input verifies the requested pair; otherwise the advisor reports a fixed fallback to `max` or an explicit constraint conflict. An `observed` availability label means SomesToken saw the same safe family/effort pair in local receipt metadata; it does not prove the profile is currently selectable.

The JSON result has a `recommendation` and `observed_usage`. The latter is an observational summary of existing sanitized receipts grouped only by recognized family/effort buckets, token totals, and exact/partial/unavailable source counts. It is not a causal claim that an advice result saved tokens, changed quality, or was applied by Codex. If no plugin data is available, the recommendation still works and `observed_usage.status` is `unavailable`.

When neither the MCP tool nor a host-owned plugin root is available, do not infer or hardcode an installation path. For an explicit usage request, state the session limitation once in a short sentence. During unrelated development, omit the fallback notice entirely and continue the requested work. Never echo CLI preflight boilerplate or claim to save an unavailable measurement. Missing or malformed bridge data is `unavailable`, never zero. Do not scan Codex data or transcripts.

### Plugin-wide model history

The structured Codex task report uses persistent operator opt-in across plugin upgrades and all tasks; no task-specific configuration is required. `details` exposes numbered source turns and ordered response `timeline` entries with model, effort, requested/effective service tier, timestamps and counters. Report model names literally, including names outside the routing catalog. This is observed response metadata, not every UI settings change. Check `details_complete`, `omitted_responses`, `timeline_complete` and coverage gaps before claiming full detail. Missing fields remain unknown. Local task JSON exports can provide more response detail than the bounded MCP view. Never treat other historical report modes as task-scoped merely because ledger access is enabled.

## Workspace monitor

The opt-in local Codex/Claude monitor (`bin/monitor.mjs --watch`, no web server) observes existing and new local tasks every 30 seconds, without restarting those tasks. Saved numeric snapshots support `tasks`, `daily`, and `task-forecast` reporting modes. Use the caller's host task identity for task-specific matching; never substitute the newest workspace task. Model, effort, role and parent-source breakdowns are observed metadata, not assumptions from the current assistant's configuration. The explicit task-detail view retains literal observed model, effort, and service-tier values per source.

The collector also refreshes bounded `completed_work` observations from retained
completed request groups. `diagnostics` exposes their identity-free counts and
comparison limitations alongside measured local CPU, memory, phase durations and
storage headroom. An explicitly requested task analysis can read its latest ten
observed groups through the stable installed CLI:

```sh
somestoken --task-id=<verified-host-task-UUID> --host=codex --completed-work --json
```

Use `--host=claude` for an explicitly identified Claude task. This read is
separate from current-turn/forecast views. It preserves literal model/effort
profiles, parent/child totals, unknown reasoning/cache fields, partial coverage
and omitted group counts. `agent_contributions` separates `main`, `host_review`
(only an explicitly recorded Codex `codex-auto-review` child) and
`other_subagent`. Its `*_share_percent` values use 0–100 denominators from the
observed group, separately for total tokens and input minus cached input.
Unknown model/effort counts remain visible; the review label does not identify
its underlying provider model. High contribution is not proof of waste.

Invalid bound rows and conflicting identities reject their affected completed
groups instead of silently discarding children. `rejected_group_count` is
distinct from ordinary unfinished groups. Input diagnostics count retained raw
rows; observation response counts deduplicate exact identities. Known-host
unbound invalidity affects only that host; unknown-host uncertainty remains
conservative. The selection fields identify a
bounded latest-per-task tail; it is not a representative sample of all history.
Diagnostics reject derived counts from a different workspace capture.

Older stored data can be analyzed without labeling an
idle task finished. These retrospective observations never enter accepted-work
experiments or forecast training automatically: acceptance, comparable workload
and complete retry/rework cost still require evidence. Use them to choose future
comparisons, not to claim that a different effort caused savings. Background
refresh uses local code; do not schedule model runs just to check these counters.
Byte, CPU and runtime reductions are not task-token or account-quota savings.

For an explicit forecast registration, use the monitor's fixed metadata fields.
The example records planning metadata only; it never starts a model, applies a
profile, or changes the current model or effort:

```sh
node "$PLUGIN_ROOT/bin/monitor.mjs" \
  --task=0123456789abcdef0123 --host=codex --model=gpt-6-astra --effort=medium \
  --workload=inspect --service-tier=standard --context-band=small \
  --scope-band=narrow --verification-band=light \
  --planned-subagent-policy=none
```

The accepted workload values are `inspect|fix|refactor|migration|test`;
service tiers are `default|standard|fast|priority|flex|batch|ultrafast`;
context bands are `small|medium|large`; scope bands are `narrow|medium|broad`;
verification bands are `light|standard|extensive`; and planned subagent
policies are `none|bounded|parallel`. Host is `codex|claude`. Metadata is
explicit and never inferred from prompts, names, paths, or transcripts. A
profile revision updates current planning but cannot relabel earlier work; the
first eligible numeric prediction remains frozen. Existing hooks and the
collector remain model-free and do not create tasks or apply profiles.

Unfinished recorded responses are measurable; the current unflushed response is unavailable, never zero. Header-only legacy tasks have no token total. Shared account quota windows cannot be exactly apportioned to simultaneous tasks. Forecasts remain experimental/learning until comparable independent samples exist; API dollar equivalents are not actual bills or Codex credit charges. The workspace collector covers configured Codex records and opted-in Claude numeric hook feeds. Claude capture authorizes host-supplied transcript paths and their exact task-owned documented subagent directory; private source configuration permits later background refresh without a new hook. It cannot prove inventory outside those task scopes. Cloud and other-device coverage remains unavailable. Updated stable CLI and collector code can serve explicitly requested current detail without interrupting active tasks; the loaded MCP implementation and schema remain old until the host's normal reload. Background collection continues without interrupting active tasks.

For explicitly requested telemetry in an already running task whose MCP inventory is old or absent, the managed local command `somestoken --task-id=<verified-Codex-task-UUID> --current --json` reads the latest observed request group from the collector. Omit `--current` for retained history. Verify the task UUID; never select the newest task in its place. This is an explicit local audit, not proof of MCP caller correlation. It does not call a model, restart a task, or rescan transcripts. Preserve stale/partial/unflushed limitations. No routine repeated invocation is required during unrelated work.


Explicit local CLI reports support `--task-id=<UUID> --host=codex|claude` with either `--current` or `--turn-id=<UUID>`. Current selects the latest observed request group, not a host-verified active turn. A requested group with no records is `requested_turn_not_observed`. Never substitute old completed usage. Claude MCP task matching remains unavailable without verified caller metadata; use the explicit CLI for an operator-requested task. Saved task and source quality, capture staleness, historical unverified usage and revalidated usage are distinct. Claude reasoning is unmeasured, not an observed zero.

The collector is a deterministic local process; it does not call a model to parse records. Its execution time, CPU, RSS and read bytes are local resource metrics. Reading reports into a model conversation can itself add context tokens. Monitor last success, last attempt, errors and quota status are separate. An installed package or matching digest does not establish that an updated Claude hook ran; verify the numeric capture fingerprint and timestamp independently.

Startup predictions and completed evaluation evidence are frozen. Forecast revisions do not rewrite them. Forecast cohorts require exact independent completed request groups with full parent-and-child accounting; 20 such groups enable experimental prediction. Calibrated requires at least 50 forward evaluations with P80 coverage 75–85% and MAE below the generic median baseline. Legacy samples missing controls remain in learning. Never present account quota slope, API dollars or standard Codex credits as an exact per-task subscription percentage. Historical rate profiles retain their dates.


Use task `profile_history` to show model/effort/tier transitions separately for every main/subagent source. Its basis is retained observed response metadata; it does not prove UI setting changes before any response. The explicit task-detail view lazily adds `profile_transitions`, capped at 200, with up to 50 equalized main responses per side. Child totals are assigned by timestamp-bound before/after spans and include gaps, unassignable descendants, coverage, finality, overlap status, and literal observed model/effort/tier values. `observed_percent_change` is an observational percentage, never a savings claim. Report `omitted_profile_segments` and `omitted_profile_transitions` when nonzero. Active observed responses remain included; partial observations remain partial and unflushed current responses remain unavailable, never zero. `capture_origin: registered_refresh` is a local reread, never evidence that a natural hook just fired. Source paths and raw identity configuration in `.authorized-sources` are private; never publish them. Monitor collection health is separate from `coverage_status`; successful partial scans are not failed capture attempts.


### Task shape (report-only)

Each workspace task carries `task_shape`, computed from its retained rows:
`median_input_tokens_per_response`, `active_span_hours` (first to last
retained response), `max_responses_per_turn` (responses in one user turn) and
`review_input_share_percent` (Codex `codex-auto-review` input).
`compaction_count`, `median_input_before_compaction` and
`median_input_after_compaction` describe context compactions: a response that
sends under 60% of the previous response's input in the same thread. Its
`signals` name patterns that multiply per-call context:

- `context_bloat`: median input per response of at least 100,000 tokens;
- `long_lived_thread`: retained activity spanning at least 72 hours;
- `long_autonomous_turn`: at least 150 responses in one user turn;
- `review_overhead`: review agents use at least 10% of the task's input.

The first, second and fourth need at least 50 responses. The thresholds are
heuristics; a signal is not waste, savings or a recommendation to change the
model, effort or permissions.

## Data-assisted project analysis

For requested SomesToken metric definitions, data quality investigation, or task/model comparisons, use the installed Data plugin's `data-analytics:index` workflow when available. For an underlying data defect use `data-analytics:analyze-data-quality`; for correctness review of an existing analysis use `data-analytics:validate-data`; for explaining a measured change use `data-analytics:metric-diagnostics`. Read the selected skill from the host's current skill catalog, not a version-pinned machine path. Data is an optional analysis companion, not a runtime dependency. On a host without Data, use SomesToken's existing reports and clearly distinguish that from executing a Data workflow.

Use SomesToken's read-only report interface and the explicit local task CLI above as the controlling measurement sources. A project checkout additionally exposes the canonical implementation in `plugins/somestoken/lib/workspace-usage.mjs`, host normalization in `lib/claude-workspace.mjs` and `lib/codex-ledger.mjs` under that plugin root, and pricing/forecast definitions under `lib/usage/`. Resolve these in the actual checkout; they are source references, not paths accepted by MCP. Do not duplicate a second set of formulas or embed raw host transcripts in project documentation.

Before a comparison, establish host, task identity, main/child source, turn/request group, time window and timezone. Verify snapshot freshness and the selected scope; inspect coverage gaps, retained-detail limits, source validation, identity ambiguity and duplicate-response handling. Analyze observed model/effort segments per source rather than assigning the current model to historical usage. Use comparable windows and completed request groups for performance comparisons; label unfinished observations separately. Shared parent totals and their child totals must not both be added into a combined total.

Preserve these measurement definitions in Data analysis:

- `input_tokens` already includes cached input; `total_tokens` is input plus output. `new_input_tokens` is input minus cached input. Reasoning output is not added again to output. Keep Claude cache writes separate and Claude reasoning explicitly unmeasured.
- Task/agent/model/effort token totals describe observed records. `profile_history` describes observed response transitions, not every settings change. Missing metadata and unflushed usage are unknown, not zero.
- Account quota percentages, calculated API dollar equivalents, provider credits and task tokens are different measures. Do not allocate shared quota to concurrent tasks by token share, report an API equivalent as a bill, or treat a token count as a proven saving.
- Preserve forecast learning/experimental/calibrated status, cohort and independent sample requirements from the existing forecast contract. Report prediction-versus-actual evidence only for matched prospective evaluations; one long task is not many independent samples.

Deliver requested analysis inline. Create a local numeric export only when the user requests an export, using the requested format. The SomesToken project has no website or dashboard. Do not add a web surface, scheduled model analysis, external upload or automatic Data call to the 30-second collector. Ordinary collection remains deterministic and model-free; explicitly requesting analysis can consume conversation tokens. An installed skill update does not prove that an already running agent has reloaded its instructions.


### Accepted-work comparison evidence

For experiment analysis, require frozen anonymous task/root binding, work-unit identifier, acceptance fingerprint, workload subtype, prospective registration/begin/close timestamps, exact whole-source coverage and nonoverlapping receipt identities. Current CLI supports `experiment start`, `begin`, `close`, `compare` and read-only `pilot`. CLI evidence is manual-recorded; do not call it provider verified. Old runs without these fields remain observations. Summaries report independent and rejected pairs; duplicate or conflicting task/run/receipt reuse cannot create a trend. Rework count may be unknown; elapsed time includes waits. An observational paired trend is neither causal router savings nor calibrated forecast accuracy. Do not start artificial tasks or relabel retrospective work to fill the prospective pilot.


### All-attempt efficiency pilot (beta 10)

An explicitly requested `node "$PLUGIN_ROOT/bin/optimization.mjs" experiment pilot --host codex --json`
(or `--host claude`) includes `efficiency_pilot`. The pilot targets an experimental
10–30% reduction and requires at least 20 independent matched work units per
controlled cohort before assessing its uncertainty band. This is separate from
the older three-pair observational trend and from forecast calibration.

Count every observed attempt, including failed/cancelled work, in cost per
accepted work. Unmatched, overlapping, truncated or incomplete attempt histories
withhold the percentage. New experiment registrations retain explicit
`attempt_evidence_complete`; old missing evidence cannot be filled retrospectively.
Token improvement with extra rework or material elapsed-time tradeoffs is not
unqualified efficiency. The pilot never creates model work, changes profiles,
converts shared quota into task percentages, or proves causal savings.

For an explicitly authorized new prospective measurement window, run
`node "$PLUGIN_ROOT/bin/optimization.mjs" experiment pilot-begin --host codex --json`
(or `--host claude`) before registering work. Repeating this command preserves
the active window. Only an explicit `--replace true` begins a later window;
old records stay stored within retention limits and are never relabelled.
New experiments receive the current host's window binding. Reusing an experiment
from an earlier window for new work is rejected; choose a new experiment ID.
Already-started work keeps its original boundary when closed.

`experiment pilot --host ...` identifies the selected window and its coverage.
Collection completeness is separate from per-attempt completeness: discarded,
corrupt or ambiguous current-window records withhold the percentage. Legacy
collection metadata is unknown. A new explicit window can measure future work
without claiming legacy history is complete. Hosts have separate windows; this
command does not generate test work, invoke a model, or supply acceptance proof.
