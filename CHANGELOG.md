# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added
- `init`: installs `hook.mjs` and `statusline.mjs` into `~/.spend-leash/`, writes a default
  `config.json`, and merges nine hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `StopFailure`, `SubagentStop`)
  into Claude Code settings (user, project or local scope). Shows a diff, asks first, backs up
  the settings file, and is idempotent. `--budget` sets the default task limit.
- `uninstall`: removes exactly what `init` recorded and restores the original `statusLine`.
- Per-task budgets in dollars, in percent of the 5-hour plan window, or both. Default $2.
  A warning to Claude at 80% and a stop at 100%.
- `#budget` directives: `$5`, `15%`, `$5 20%`, `+$3`, `off`, `new` and `plan-off`. After a
  budget stop a plain prompt continues the same task.
- Spend from Claude Code transcripts, including subagent transcripts, with each API message
  counted once, read incrementally, and priced from a built-in table (overridable with
  `prices` in `config.json`).
- Status-line wrapper: records plan usage snapshots, runs your original status line unchanged
  (2 second limit), and prints its own short line when you had none.
- Plan-window guard: stops gracefully when the 5-hour window passes `plan.stopAtPct` (95),
  at most once per window per session.
- Loop breaker: warns at 3 and stops at 5 repeats of the same tool call or failing command
  in the last 12 calls. Edits reset the count; `TodoWrite` and task-list tools are ignored.
- Handoff files: reason, task prompt, last assistant message, last 10 tool calls (redacted),
  git status and diff stat, a resume command and the last todo list. The next session in the
  project is told a handoff exists.
- `status` and `report` (`-n`, `--today`, `--json`) commands, and a per-task ledger in
  `~/.spend-leash/tasks.jsonl`.
- Project `.spend-leash.json` that can only tighten limits.
- Browser simulator at https://codersanjay3.github.io/spend-leash/ that runs the same
  decision code client-side.

### Security and robustness
- Hooks fail open on any error or after about 1.5 seconds, logging one line to
  `errors.log`; `failClosed` is opt-in.
- Per-session state is written atomically under a short lock so parallel subagent hooks do
  not corrupt it.
- Ledger, session state, `errors.log` and handoff files are created with mode 0600 (POSIX).
- Prompts and tool arguments are redacted before they are written.
- No network calls and no telemetry.

### Requirements
- Node 20 or newer. CI runs Node 20, 22 and 24 on Ubuntu, macOS and Windows.

[0.1.0]: https://github.com/codersanjay3/spend-leash/releases/tag/v0.1.0
