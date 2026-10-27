---
name: somestoken-code
description: Review, simplify, clean up, refactor, restructure, deduplicate or optimise Swift/Python/Go/Java/JS/TS code, or confirm behaviour; edits stay only when project tests verify them.
---

# SomesToken code changes

Use the selected model and effort; start no subagents. Work as you normally would.
The only additions are two short commands around the edit.

`CHANGE` is `node '${CLAUDE_PLUGIN_ROOT}/bin/change.mjs'`. In Codex that placeholder
stays unfilled; use the plugin root, which is two folders above this skill file.

- **review**: report findings only. Do not edit files and do not run the CLI.
- **simplify, architecture, algorithm**: the request sets the level and the files;
  do not widen either one, and do not ask again for what it already allows.
  1. Start in the same command as your first read of the target:
     `CHANGE start --root <repo> --level <level> --files a,b && cat a b`, plus
     only the tests or callers you need. Add `--preserve file#Symbol` for an
     abstraction that callers rely on. The start line names the test command
     `finish` will run; that is the check. Do not write your own equivalence
     scripts or restart with another check. Only if it finds none, run
     `start` again with `--check "<command>"`, a command that already passes
     on the unchanged code.
  2. Edit only those files, in place, with your normal edit tool, and run
     `CHANGE finish --root <repo>` right after the edit in the same turn. Do not
     run the tests yourself; `finish` runs them.
  3. A `verified` line means the edit stays and has been checked; report it and
     stop. Otherwise safe scope files are restored. If the line reports
     `invalid_scope_file`, manual restoration is required after checking the
     path's ownership; do not write through the unsafe path. The line gives
     the reason and the failing check's last lines. Fix the edit and run
     `finish` again, or stop and report.

Both commands write only under `.git/somestoken-change/` (a private temp folder
when `.git` is read-only, as in Codex's sandbox), and `finish` refuses edits to
any other tracked file and any new source file you did not name in `--files`.
You do not need to check that yourself or read the CLI's source.

Architecture needs a named structural problem and an acceptance condition.
Algorithm needs `--bench "<command>"`; the edit stays only when it measurably
beats the baseline. For writing those conditions, see
[contracts](references/contracts.md). If `finish` reports a missing tool or no
check, read the note for that language: [Swift](references/languages/swift.md),
[Python](references/languages/python.md), [Go](references/languages/go.md),
[Java](references/languages/java.md) or
[JavaScript/TypeScript](references/languages/javascript.md).

Pass on the verdict line as it is. `verified` means these checks passed for these
files, nothing more. `unverified` and `rejected` are not successes. Keep source,
diffs and findings out of usage reports.
