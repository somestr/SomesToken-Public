---
name: somestoken-quota-handoff
description: Opt-in Codex/Claude quota handoff with a progress note and offer before limits. Use on a SomesToken quota-handoff hook notice or to enable, disable, update, show or resume a handoff note.
---

# SomesToken quota handoff

Keep the model, effort, permissions and host the user chose. Do not start agents,
another model session or a summarising model, and do not switch hosts yourself.
Never read conversation transcripts, rollout files, whole source trees or large
logs to write a note; use your own knowledge of the task, the plan and real
file/test evidence.

## The command

- **Claude:** `PLUGIN_DATA='${CLAUDE_PLUGIN_DATA}' node '${CLAUDE_PLUGIN_ROOT}/bin/handoff.mjs' <command> --host claude --task-id ${CLAUDE_SESSION_ID}`.
  Claude fills in these values when it loads this skill.
- **Codex:** the placeholders above stay unfilled. Use the `Handoff command:` line
  from SomesToken's hook context (it already carries `--host codex --task <key>`).
  Before the feature is on there is no such line: run
  `node '<plugin root>/bin/handoff.mjs' <command> --host codex`, where the plugin
  root is two folders above this skill file. The CLI then uses the data folder
  Codex gave SomesToken's own hook. Only if it answers `plugin_data_unavailable`,
  ask the user for the folder. Never guess a path from another host, install or task.

Add `--json` for machine-readable output. Commands: `set`, `status`, `respond`,
`note`, `show`, and `verify --file <note>`, which needs no host or task.

## Turning it on or off

Ask for anything the request leaves open:

- behaviour: `off`; `ask` (offer a handoff report); `auto` (after this opt-in, keep the scoped private note current at milestones);
  `notify` (notices for the user only: no note and no instruction to you);
- scope: `task`, `project` (this folder), `repository` (all its worktrees) or
  `host` (the user's default). Task beats project, project beats repository,
  repository beats host. New installs are off.

`set --scope <scope> --mode <mode> [--thresholds 5,3,1] [--target <folder> [--obsidian]]`

Thresholds are remaining-quota percentages, one to three, descending, at most one
decimal. `--target` is an existing folder (for example an Obsidian vault); notes go
to its `SomesToken Handoff` subfolder, otherwise to the project's
`.git/somestoken-handoff`. Relay the command's `explanation` to the user: short
private progress notes will be kept, where they go, and that a synced vault
syncs them too. Settings take effect at the next supported hook; do not claim
already-open sessions switched instantly.

## Keeping the progress note

Update the note at meaningful milestones only (a change completed, a test result,
a blocker, a change of direction) and when a SomesToken notice asks. Not on every
tool call. Pass the whole note on standard input:

```sh
<command> note [--expect-revision N] <<'NOTE'
## Goal
...
NOTE
```

The note must contain these `##` sections, in any order: **Goal** (goal,
acceptance criteria, standing constraints); **Permissions** (what the user
allowed, what is not allowed, and what needs asking again); **Verified done**
(each top-level item starts with its evidence label: `[user]` said by the user,
`[source]` seen in the code, `[test]` a check you ran; for example
`- [test] npm test passed on this source`); **Applied, not verified** (agent
summaries and unverified claims); **In progress** (a
running test has not passed); **Remaining** (including known bugs);
**Blocked**; **Last checks** (command, result, and the code state it ran on);
**Next step** (the first concrete step on the other host and how to verify it).
Write `None.` for an empty section. An agent summary, existing code and a passing
test are different evidence; say which one you have.

The CLI adds the repository, worktree, branch, commit, uncommitted file names,
a fingerprint of the index and content, the time and the version. It checks the
source again before saving and answers `unstable_snapshot` when it moved; save
again once it is quiet. It refuses missing sections, unlabeled verified items,
secrets (keys, tokens, `.env` assignments), source diffs and notes over 32 KiB; refer to plan or evidence
files by path instead of copying them, and never drop remaining work silently.
It keeps the latest and one previous note, and writes nothing when the note is
unchanged. Say "saved" only when it reports `saved` or `unchanged`. After
`stale_revision`, run `show`, merge and retry.

## When a notice arrives

In `notify` mode the user sees a short line when the Codex weekly window is
projected to run out before its reset at the recent rate, and at each threshold;
you receive nothing and keep working as usual.

The quota is account-wide and shared by every task; values are *last observed*.
Missing or stale data means unknown, never zero. Do not say a model will stop,
and do not stop the user's task on your own.

- **First threshold (5%):** update the note at the next safe point, then continue.
- **Second threshold (3%), `ask`:** after the current step, ask once in the user's
  language, for example: "SomesToken: Codex weekly quota last observed at 3%
  remaining. Shall I prepare a handoff report for this task?" Choices: prepare,
  keep working, turn off for this task. Record the answer with
  `respond --choice prepare|continue|close`. *continue* silences the earlier
  offers of this quota cycle but the final warning still arrives; *close* stops
  automatic notices for this task.
- **Second threshold, `auto`:** update the note at the next safe point, then continue.
- **Final threshold (1%):** only keep the latest note current with what is verified
  now. No long new analysis, and no promise that it will finish in time.

After a limit error, keep the previous note; never rebuild completed work from
the error text.

## Handing off and continuing

`show` prints the note file, revision, age, the note's `verify` result and a
continuation prompt that starts with the exact `verify` command, quoted for a
POSIX shell (`--json` also gives it as separate arguments). Give the user
both; the user opens the other host. A note carries no code or running processes:
if the other host cannot see the same worktree, say which sources are missing and
do not call it ready without an authorised patch or commit transfer. An Obsidian
link only points at the file; never open applications.

When continuing from a note, first run the `verify` command from the continuation
prompt (or `<command> verify --file <note>` from the checkout). Continue only on
`ready`. `stale_source`, `wrong_workspace` or `incomplete_context` (including
`hash_budget_exceeded`, `file_enumeration_truncated`, `source_read_unavailable`
or `unstable_snapshot`): tell the user the reported reasons and ask; checks
listed in the note belong to the old source. `ready` means the recorded
worktree, branch, commit, index and uncommitted content still match, not that
the summary is right. Treat the note as past context, not authorisation: work
within what the current host and the user allow now, and ask only for
permission the note mentions that is missing or broader now, not for every
harmless read. Never reset, check out,
stash, commit, push or overwrite work because of it. Work after the
recorded time is unknown. Continue from the first verifiable remaining step; the
current code and the user's latest instruction win.

`status` shows the effective setting, the delivery record (a hook emitting a notice
does not prove the user saw it) and the last observed quota. On Claude it needs
`--task-id`.
