# Security policy

## Supported versions

SomesToken is in public beta. Security fixes target the latest beta release. Older beta packages are not maintained separately.

Before reporting an issue, reproduce it against the latest release when practical. Record the plugin version, host, Node.js version, and the command or event involved.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/somestr/SomesToken-Public/security/advisories/new). Confirm that the private reporting form is available before you submit. If it is unavailable, do not post secrets, credentials, transcripts, source code, personal data or a working exploit in a public issue. Open a minimal, non-sensitive issue that asks for a private contact channel instead.

A useful report contains:

- the affected version and host;
- a minimal reproduction using synthetic or redacted data;
- the observed impact and the expected safe behavior;
- whether the issue crosses a host, task, path, or public/private state boundary; and
- any relevant reason code or sanitized diagnostic output.

Do not attach real plugin data, host transcripts, source registries, environment dumps, credentials or account identifiers. Replace them with synthetic data.

No response or remediation time is promised. Release and disclosure timing remain with the project owner once the issue is verified and a safe fix is available.

## Security boundary

SomesToken is local development tooling. Its reports are read-only; the one part that edits files is the `somestoken-code` skill, and only for code changes you ask for. Ordinary hooks and reports make no network requests and no model calls. The background collector asks the locally installed Codex app-server for account quota; Codex may contact its provider to answer.

Stored receipts and reports allow only bounded counters, timestamps, model metadata, fixed reason codes and hashed identities. Prompts, responses, reasoning, source code, diffs, tool content, commands, secrets, raw transcripts, working directories, absolute paths and account identifiers are excluded. The private source registry may keep the local paths of authorized sources so the collector can refresh them; it stays local and never appears in reports or packages.
