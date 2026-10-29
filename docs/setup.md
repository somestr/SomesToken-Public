# Setup and verification

SomesToken runs locally on Node.js 24 or newer. Run these commands from the SomesToken folder, not from a project you want to observe. Your projects do not need SomesToken as a dependency.

## Get the source

```sh
git clone https://github.com/somestr/SomesToken-Public.git SomesToken
cd SomesToken
node --version
npm run build
```

The runtime has no dependencies, so `npm install` is not required. The build creates the Codex and Claude plugin archives and their checksums in `plugins/somestoken/dist/`. The [releases](https://github.com/somestr/SomesToken-Public/releases) carry the same archives, with `SHA256SUMS`.

## Codex Desktop and CLI

Inspect the repository and the current installation:

```sh
npm run setup -- --check
```

If the result says `install_required` or `update_required`, install the local package:

```sh
npm run setup -- --apply
```

Then approve the SomesToken hooks in Codex (`/hooks`) and enable the plugin when prompted. Codex 0.164 fingerprints the whole plugin folder, so it asks again after every install or update; until you approve, Codex skips the SomesToken hooks. The Codex desktop app can skip changed hooks without offering a way to approve them ([openai/codex#37362](https://github.com/openai/codex/issues/37362)); approve them in the Codex CLI instead: run `codex`, open `/hooks`, approve the SomesToken hooks and quit.

Verify the package and the observed installation:

```sh
npm run setup -- --verify
```

The automated check cannot approve hooks or prove Desktop behavior. A normal completed task, followed by the diagnostics below, shows that collection works.

## Claude Code

Install at user scope (all your projects):

```sh
claude plugin marketplace add ./
claude plugin install somestoken@somestoken-local --scope user
```

Inside Claude Code, the equivalent is `/plugin marketplace add /ABSOLUTE/PATH/TO/SomesToken`, then `/plugin install somestoken@somestoken-local`. Use `--scope local` for only the current repository, or `--scope project` for shared project settings; the host writes the settings of the scope you choose. Review the hooks and MCP permissions before you enable the plugin.

Check the installation:

```sh
npm run setup -- --host=claude --check
claude plugin list
```

Then open `/mcp`. The plugin provides a read-only reporting tool with a scoped name similar to `mcp__plugin_somestoken_somestoken-local-reporting__get_somestoken_report`.

## Background collector

Hooks record each turn's usage as it completes. Task lists, daily totals and quota windows come from a separate collector, `plugins/somestoken/bin/monitor.mjs`. It reads session history only with your consent, so first opt in for each host you use:

```sh
node plugins/somestoken/bin/report.mjs --enable-codex-ledger="$HOME/.codex/sessions"   # Codex
node plugins/somestoken/bin/report.mjs --enable-claude-feed                          # Claude Code
```

- **Codex:** the collector reads Codex's saved sessions. Use your `$CODEX_HOME/sessions` if you set `CODEX_HOME`.
- **Claude Code:** SomesToken's hooks and the collector read usage numbers from Claude Code's transcripts in `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` if you set it). The numbers go to `~/.codex/somestoken/claude-feed`, capped at 64 MiB.

Both choices are stored in `~/.codex/somestoken/ledger-config.json` and survive updates. Revoke them with `--disable-codex-ledger` and `--disable-claude-feed`.

Then, on macOS, install the collector once:

```sh
npm run setup -- --collector
```

This creates and loads the launchd job `com.somestr.somestoken.monitor` (`~/Library/LaunchAgents/com.somestr.somestoken.monitor.plist`). Every 30 seconds it runs the collector from this SomesToken folder: it checks for changed sources, captures only those and exits, so no process stays resident between runs. Its logs go to `~/.codex/somestoken/`, and daily totals use your system time zone.

- `collector=installed`: the job is loaded and its first run starts now.
- `collector=existing`: a job file already exists; setup leaves it unchanged.
- `collector=existing_unloaded`: the job file exists but is not loaded; the output gives the `launchctl bootstrap` command.
- `collector=not_enabled`: no opt-in was found, so nothing was installed.
- `collector=failed`: nothing was left installed.

Keep the SomesToken folder where it is, on your startup disk and outside Desktop, Documents and Downloads: the job runs the collector from it, and macOS can deny background jobs access to external drives and those folders. If you use Codex, the collector also reads account quota from the local Codex app-server.

If you later revoke every opt-in, each run of the job exits at once (exit code 1) and writes nothing. Unload it with `launchctl bootout "gui/$(id -u)/com.somestr.somestoken.monitor"` so it stops starting.

Without launchd, or on another platform, run the collector yourself: `node plugins/somestoken/bin/monitor.mjs --once` refreshes on demand, and `--watch` keeps it running in an open terminal.

## Check that it works

Complete one normal task in the host, then run:

```sh
node plugins/somestoken/bin/console.mjs --view=daily
node plugins/somestoken/bin/report.mjs --diagnostics --json
```

`daily` lists the collector's responses per day and host. Diagnostics separates the loaded reporter version, data source, snapshot age, receipt age, quality and the next action; its `collection` block describes the collector. A terminal does not receive the host's plugin data, so there the top-level receipt fields read `unavailable` with the reason `host_plugin_data_unavailable`, and `report.mjs --summary` has no receipts to show. Turn receipts are reported inside the host (see [Reports](#reports)). `unavailable` can be a valid state, for example before the first collector run; it never stands for zero usage.

## Reports

In Codex, mention `@SomesToken`. In Claude Code, ask for a SomesToken report; the plugin's skill uses its read-only MCP tool. From a terminal:

```sh
node plugins/somestoken/bin/report.mjs --help
node plugins/somestoken/bin/console.mjs --help
node plugins/somestoken/bin/console.mjs --view=consumption
node plugins/somestoken/bin/console.mjs --view=daily
```

`consumption` shows each host's current account quota window and what was used since it started, by model, effort, role and task. Quota is shared by the account, so tasks get token shares only. Calculated prices are not bills.

## Optional features

All of these are off until you turn them on. Session-history consent is part of the [background collector](#background-collector) setup.

- **Efficiency guidance.** Run this from the project folder you want it in: `node /ABSOLUTE/PATH/TO/SomesToken/plugins/somestoken/bin/optimization.mjs policy set --host codex --scope project --mode balanced --json`. It adds a fixed advisory note to new tasks in that folder; `--mode observe` turns it off again. It never changes the model, effort or permissions. In our trials so far it has not measurably reduced cost, so treat it as an experiment.
- **Quota handoff.** `node plugins/somestoken/bin/handoff.mjs set --host codex --scope host --mode notify` shows a short notice when the Codex weekly quota is projected to run out before it resets. The `ask` and `auto` modes also keep a progress note, which can contain task context and local paths. `--mode off` turns it off. SomesToken never switches hosts or models for you.
- **Task profiles and forecasts.** `node plugins/somestoken/bin/monitor.mjs --help` lists the profile options. Forecasts stay experimental until at least 50 forward evaluations calibrate them, and they never promise a task or quota percentage.

## Storage and limits

SomesToken does not copy host conversation logs. It keeps derived numbers in host-owned folders: `~/.codex/somestoken/` and Claude's plugin-data folder.

- The workspace store is capped at 64 MiB. Responses are kept for up to 90 days, at most 100,000 of them, and a byte budget can evict older responses sooner. When a limit applies, the oldest responses go first and reports name the `response_retention_bound` gap.
- Claude's numeric feed has its own 64 MiB budget.
- A Claude turn receipt reads the whole session transcript up to 64 MiB. Past 32 MiB, each turn also stores a small checkpoint: the transcript's identity, a CRC32 of the part already read and the running totals. A longer transcript is read from that checkpoint, parsing at most 64 MiB of new data. One turn is `unavailable` while the counter is rebased when a session over 64 MiB has no checkpoint yet (for example right after you update), when its transcript was rewritten, or when it grew by more than 64 MiB in one turn. With the Claude opt-in, the collector still records that session's usage in daily totals and tasks.
- The collector trims only its own logs and its own abandoned temporary files. Host transcripts, Codex databases and other projects are never cleanup targets.

## Update

```sh
git pull --ff-only
npm run build
```

- **Codex:** run `npm run setup -- --check`, `npm run setup -- --apply` and `npm run setup -- --verify` again, and approve the SomesToken hooks in `/hooks` again.
- **Claude Code:**

  ```sh
  claude plugin marketplace update somestoken-local
  claude plugin update somestoken@somestoken-local --scope user
  ```

Use the scope that `claude plugin list` reports. Open sessions keep the hooks and MCP code they loaded until the host reloads them; in Claude Code's terminal, `/reload-plugins` applies pending plugin changes. Updates keep your consent settings. They do not publish local data or change model settings. The collector job runs from your SomesToken folder, so it uses the new code on its next run.

## Remove SomesToken

Disable SomesToken first in each host, then stop its writers before you remove anything. In Codex CLI, `/plugins` opens the installed plugin browser: select SomesToken and turn it off. In Claude Code, use `/plugin` → Installed → SomesToken → Disable. Reload or close the sessions that still hold the old hooks or MCP server.

If you set up the launchd collector, stop it and remove its file:

```sh
launchctl bootout "gui/$(id -u)/com.somestr.somestoken.monitor"
rm ~/Library/LaunchAgents/com.somestr.somestoken.monitor.plist
```

A collector started with `--watch` must be stopped separately.

Then remove the packages:

```sh
codex plugin remove somestoken@somestoken-local
claude plugin uninstall somestoken@somestoken-local --scope user --keep-data
```

Choose the Claude scope that `claude plugin list` reports. `--keep-data` keeps the plugin-data folder; without it, Claude Code can delete that data when the last installation scope is removed. Codex removal deletes its plugin cache.

Delete only paths that you have inspected and confirmed belong to SomesToken. Collector records, ledger consent, source registrations and handoff notes may remain under `~/.codex/somestoken/` and Claude's plugin-data folder. Never delete a host's home folder, its transcripts or your source folders as part of cleanup.
