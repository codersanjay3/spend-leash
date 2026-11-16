# spend-leash — design

Date: 2026-11-16. Owner: codersanjay3. Status: draft for approval.

## Intent and why

The owner is building open-source AI/agent repos for GitHub stars and real adoption (see sibling repo
`codersanjay3/mcp-leash`). spend-leash is a Claude Code hook pack that **stops a task before it burns
too much money or plan quota, breaks runaway loops, and leaves a handoff file so the work resumes
cleanly**.

Positioning (chosen by the owner over "handoff first"): **budget + loop breaker first**, handoff as the
safety net. One-liner: *"Per-task budgets and a loop breaker for Claude Code: stop a task at $2 or 10%
of your plan window, and pick up where it left off."*

Why this angle: research on 2026-11-14/16 found monitoring owned by ccusage (~19k★), handoff-at-limit
crowded with 1–8★ repos, and Claude Code natively auto-continuing after usage limits and offering
`--max-budget-usd` / `--max-turns` for print mode only. **Interactive per-task budgets are not native**
(open feature request). ~14 small repos touch budgets; the largest has 29★ and warns only; the few that
block are 0–2★, thin, or target other agents. None combines a hard stop, a loop breaker, plan-% budgets,
subagent-inclusive spend and an automatic resume.

## Goals

1. `npx spend-leash init` installs everything in one command; `npx spend-leash uninstall` removes exactly
   what init added (byte-identical restore when nothing else changed).
2. Every user prompt starts a **task**. Each task has a budget in **USD** and/or **% of the 5-hour plan
   window**. Defaults from config; override inline in the prompt.
3. At the warn threshold (default 80%) Claude is told to wrap up. At 100% the task is **stopped** and a
   handoff file is written.
4. **Loop breaker**: repeated identical tool calls or the same failing command → warn, then stop.
5. **Plan-window guard**: when the 5-hour window passes a threshold (default 95%), write a handoff and stop
   gracefully before the hard usage limit cuts the turn off.
6. **Resume**: the next session in the same project is told a handoff exists (SessionStart context).
7. Spend includes **subagents**.
8. `spend-leash report` shows recent tasks with cost, tokens, outcome (completed / warned / stopped / loop).
9. Same launch bar as mcp-leash: the owner's 16-item OSS checklist (GIF, one-line install, live demo page,
   MIT, topics, social preview, CI badge, secret scanning, good-first issues, CONTRIBUTING, issue templates,
   Discussions, tagged release + changelog, Show HN draft, response plan).

## Non-goals

- Not a usage dashboard / monitor (ccusage does that). `report` is per-task history only.
- No Codex / Gemini CLI support in v0.1 (Claude Code hooks only). Note as future work.
- Does not stop a model mid-generation: enforcement happens at tool boundaries and turn boundaries. A
  single tool-free reply cannot be cut off. Documented plainly.
- Not exact billing. USD is an estimate at list price (like Claude Code's own `/usage`).
- No network calls, no telemetry.

## Anti-goals (failure even if it "works")

- Breaking or slowing the user's Claude Code: hooks must fail open on any internal error and stay fast
  (target p95 < 50 ms per hook call on a 20 MB transcript, via incremental reads).
- Losing or corrupting the user's `settings.json` or their existing status line.
- False loop alarms on normal work (e.g., re-reading a file after editing it, re-running tests after a fix).
- A cloned repo being able to *loosen* the user's limits.
- Anything attributed to anyone but codersanjay3 (git author/committer, LICENSE, package author).

## Constraints / verified platform facts (Claude Code docs, 2026-11-16)

- Hook events used: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `PostToolBatch`, `Stop`, `StopFailure`, `SubagentStop`.
- Common hook input: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus `agent_id`/`agent_type`
  inside subagents. `transcript_path` may lag the in-memory conversation.
- Halting: output `{"continue": false, "stopReason": "..."}` stops Claude entirely. On PreToolUse, also
  return `hookSpecificOutput.permissionDecision: "deny"` so the pending call does not run.
  `PostToolBatch` with `decision: "block"` stops before the next model call. `additionalContext` injects a
  system reminder (warn path). `systemMessage` shows a message to the user.
- `StopFailure` fires on API errors (`error: "rate_limit"`, etc.) and has no decision control — logging /
  handoff only. Whether a plan usage limit surfaces as `rate_limit` is **unverified**; treat any
  StopFailure as "write a handoff".
- No hook input carries tokens or cost. Sources:
  - **Transcripts**: each assistant line has `message.id`, `message.model`, `message.usage`
    (`input_tokens`, `output_tokens`, `cache_creation_input_tokens` with `cache_creation.ephemeral_5m/1h`,
    `cache_read_input_tokens`). One API message appears on several lines → **dedupe by `message.id`**.
    Subagents: `<session dir>/subagents/agent-<id>.jsonl` (verified locally).
  - **Status line stdin** (interactive only): `cost.total_cost_usd` (estimate, resets on `/clear`),
    `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.*`,
    `rate_limits.spend_limit.*` (Pro/Max/Ultra or gateway; only after first response), `model.id`,
    `session_id`.
- Hooks for one event run in parallel; default command timeout is long (600 s) but we self-limit.
- Node ≥ 20, TypeScript ESM, zero runtime deps in the installed hook (copied single-file `.mjs`, like
  mcp-leash's `hook.mjs`).

## Approaches considered

1. **npx installer that edits settings and wraps the status line — CHOSEN by the owner.** Gives access to
   the plan-window % (only the status line sees it), reuses mcp-leash's proven settings-merge / backup /
   atomic-write / unmerge code, works for everyone with Node.
2. Claude Code plugin (`hooks/hooks.json`, `/budget` slash commands). Native install and uninstall, but a
   plugin cannot set the status line → no plan-% signal; would rely on a price table only. Rejected as the
   weaker product; may ship later as a thin wrapper.
3. Hybrid (both). Rejected: doubles install paths and tests for little gain at launch.

## Design

### Install footprint (`init`)

- Copies `hook.mjs` and `statusline.mjs` (bundled, dependency-free) to `~/.spend-leash/`.
- Writes `~/.spend-leash/config.json` if absent (defaults below).
- Merges into the chosen settings file (`--scope user` default; `project`/`local` supported, same paths as
  mcp-leash): one hook group per event above, matcher `*` where matchers apply, command
  `node "~/.spend-leash/hook.mjs" <event>`.
- **Status line**: if the user has a `statusLine`, init records the original object in state and replaces
  it with `node "~/.spend-leash/statusline.mjs"`. The wrapper reads stdin JSON, writes a snapshot, then
  runs the original command with the same stdin and prints its stdout unchanged (stderr and exit code
  passed through, timeout 2 s, on failure print nothing extra). If there was no status line, the wrapper
  prints a compact line of its own: `task $0.42/$2.00 · 5h 37%`.
- Records exactly what was added in `~/.spend-leash/state.json` (LockRecord-style), backs up the settings
  file first, writes atomically, preserves symlinks and file mode (all as in mcp-leash).
- Idempotent: running init twice adds nothing.
- `uninstall` removes exactly the recorded additions and restores the original `statusLine`. If the user
  changed `statusLine` since init, leave theirs and warn.

### Config

`~/.spend-leash/config.json` (user) and optional `<project>/.spend-leash.json`:

```json
{
  "task": { "usd": 2, "planPct": null, "warnAt": 0.8 },
  "plan": { "stopAtPct": 95 },
  "loop": { "warnAt": 3, "stopAt": 5, "window": 12, "ignoreTools": [] },
  "handoff": { "dir": ".spend-leash/handoffs" },
  "failClosed": false
}
```

- **Project config can only tighten** (lower budgets/thresholds); looser values are ignored with a note.
- `planPct` budget is measured as the increase in `five_hour.used_percentage` since the task started.
- If both `usd` and `planPct` are set, whichever trips first wins.

### Tasks and inline overrides (`UserPromptSubmit`)

- Each prompt starts a new task: record `{taskId, sessionId, startedAt, prompt (first 200 chars),
  baseline}` where baseline = current spend counters for the session (transcript totals + latest
  status-line snapshot).
- Inline directives, parsed from the start of the prompt and left in the prompt (Claude seeing them is
  harmless):
  - `#budget $5` / `#budget 15%` / `#budget $5 20%` — set this task's limits.
  - `#budget +$3` — continue the *previous* stopped task with $3 more (does not reset the baseline).
  - `#budget off` — no budget for this task (loop breaker still on).
  - `#budget new` — start a fresh task with the default budget even right after a stop.
  - `#budget plan-off` — turn the plan-window guard off for the rest of the session.
- A prompt that is a slash command still starts a task.
- **After a budget stop, a plain prompt continues the same task (owner's call: strict).** If the
  session's previous task ended with outcome `stopped` because of its task budget, the next prompt without a
  directive keeps that task's baseline and limits, so the next tool call stops again. The stop message and
  the injected context say how to go on: `#budget +$2` (more budget, same task) or `#budget new` (start a
  fresh task). After a *loop* stop the task also continues (same baseline) with loop history cleared, since
  its budget was not the problem. Plan-guard stops follow the plan-guard rule below.

### Measuring spend

- **Tokens/USD from transcripts** (always available, includes subagents): read the main transcript and
  every file in `<session dir>/subagents/`, dedupe by `message.id`, sum usage per model, price with a
  built-in table (`src/pricing.ts`: input, output, cache write 5m, cache write 1h, cache read per model
  family; unknown model → most expensive known family, flagged "estimated"). Price table overridable in
  config. Incremental: cache `{file, byteOffset, partialLine, seenIds, totals}` in
  `~/.spend-leash/sessions/<sessionId>.json` so each hook call reads only new bytes.
- **Plan % from the status-line snapshot**: `~/.spend-leash/sessions/<sessionId>.statusline.json`, written
  by the wrapper on every refresh. Use only if fresher than 10 minutes; else plan-% checks are skipped
  (and `status` says why). Cross-check: if the snapshot's `cost.total_cost_usd` exists, report it next to
  ours in `status` (do not enforce with it — it resets on `/clear` and excludes nothing we know of).

### Enforcement points

- `PreToolUse` (every tool call, main and subagents): compute task spend. Over limit → write handoff, return
  deny + `continue:false` + `stopReason` ("spend-leash: task budget $2.00 reached ($2.03). Handoff:
  <path>. Reply `#budget +$2` to continue."). Over warn threshold (first time per task) → allow, add
  `additionalContext` telling Claude the remaining budget and to wrap up and summarize. Plan window ≥
  `stopAtPct` → same as over-limit with a plan-specific message.
- `PostToolBatch`: same check, so a long batch that crossed the limit stops before the next model call.
- `Stop`: record the task as completed (or stopped) in the ledger. Never blocks.
- `StopFailure`: write a handoff (reason = error type), record in ledger.
- `SubagentStop`: no decision; triggers a spend refresh so the parent's next check includes it.
- `SessionStart`: if an unconsumed handoff exists for this `cwd` (newest within 7 days), inject
  `additionalContext`: "A previous task was stopped by spend-leash: <reason>. Handoff at <path>: <first
  ~1,500 chars>." Mark it consumed.

### Loop breaker (`PreToolUse` + `PostToolUseFailure`)

- Fingerprint = `tool_name` + canonical JSON of `tool_input` (sorted keys; for `Bash`, the command string
  with whitespace collapsed).
- Over a sliding window of the last `window` tool calls in the task: if one fingerprint occurs
  `warnAt` times → allow but add context ("You have run this exact call N times; the result will not
  change. Try a different approach or stop and explain."). At `stopAt` → deny + stop + handoff.
- Failures: the same failing fingerprint (PostToolUseFailure, or Bash with non-zero exit if detectable
  from `tool_response`) counts double.
- Not a loop: an intervening `Edit`/`Write`/`MultiEdit`/`NotebookEdit` resets the count for `Read` of the
  same file and for `Bash` test commands (fingerprint history is cleared on any write tool). `ignoreTools`
  in config. `TodoWrite` and similar bookkeeping tools ignored by default.

### Handoff file

- Path: `<cwd>/.spend-leash/handoffs/<UTC timestamp>-<reason>.md` (gitignore hint printed on first write;
  `init` offers nothing automatic to the repo). Also mirrored to
  `~/.spend-leash/handoffs/` when `cwd` is not writable.
- Deterministic content (no model call): reason and numbers; the task prompt; the last assistant message
  (from hook input or transcript); last 10 tool calls (name + redacted 120-char args preview — reuse
  mcp-leash's `redact`/`argsPreview`); `git status --short` and `git diff --stat` if `cwd` is a git repo
  (2 s timeout, skipped otherwise); the session id and a `claude --resume <id>` line; a "Next steps"
  section with Claude's last TodoWrite list if present in the transcript.

### Ledger and CLI

- `~/.spend-leash/tasks.jsonl` (mode 0600): one line per task end
  `{ts, sessionId, cwd, prompt, usd, tokens:{in,out,cacheW,cacheR}, planPctDelta, outcome, reason}`.
- Commands: `init [--scope] [--budget $2|10%] [--yes]`, `uninstall [--scope] [--yes]`,
  `status` (current/last task per session), `report [-n 20] [--json] [--today]`, `hook <event>`
  (internal), `statusline` (internal). `--help`, `--version`.
- `npx spend-leash` with no args = `status` if installed, else explains `init`.

### Failure behaviour

- Any exception, unreadable transcript, or 800 ms self-watchdog → fail open (exit 0, no output), log one
  line to `~/.spend-leash/errors.log`. `failClosed: true` makes budget errors deny instead.
- Concurrency: hooks for parallel subagents may run at once → per-session state written atomically with a
  short lock (mkdir lock, 200 ms max wait, then proceed read-only).

### Live demo (checklist #4)

GitHub Pages "simulator" built from the same core modules (as mcp-leash's playground): pick a scenario
(expensive refactor, test-fix loop, nearing 5-hour limit) or paste a transcript JSONL; it replays it
through the real enforcement logic and shows when the guard would warn/stop and the generated handoff.
Runs fully in the browser; nothing uploaded.

### Testing

- TDD. Unit: pricing, transcript reader (dedupe, incremental offsets, partial lines, subagent files),
  directive parser, loop fingerprints and resets, config tightening, settings merge/unmerge with status
  line wrap/restore, handoff rendering.
- Integration: spawn the built `hook.mjs` with recorded hook inputs against fixture transcripts in a temp
  HOME; spawn `statusline.mjs` wrapping a fake original command.
- E2E (manual, documented): a real `claude` session in a sandbox HOME with a tiny budget to watch it stop.
  (The CLI on the owner's machine is not logged in; mark unverified if it still is.)
- CI: ubuntu + macOS (+ windows-latest for the hook and statusline paths), Node 20/22/24.

## Resolved after the builder review (designer's calls unless marked)

- **`#` prefix is safe.** The current interactive-mode docs list only `/`, `!`, `@`, `:` and `?` as
  quick commands; `#` is no longer a memory shortcut, so `#budget …` reaches `UserPromptSubmit`. Verify in
  the E2E run.
- **Plan-% with no status-line data** (API-key users, `claude -p`, first turn): never silent. `init` and
  `status` say when plan data is unavailable; at the first task of a session with a `planPct` budget and no
  fresh snapshot, show one `systemMessage` ("plan-% budget inactive: no plan data yet"). If a USD budget is
  also set it still applies. The plan baseline is taken from the first fresh snapshot seen *after* the task
  started (re-baseline once), not a stale one.
- **Plan guard after it trips:** it blocks at most once per 5-hour window per session (keyed by
  `five_hour.resets_at`). Later prompts in that window run with a one-line warning, because the user has
  seen the stop and chose to continue. `#budget plan-off` disables the guard for the rest of the session.
- **Which `statusLine` init wraps:** the effective one: the highest-precedence scope that defines it
  (local > project > user); if none defines one, add the wrapper in user scope. The file wrapped is recorded
  in state and restored by uninstall. Hooks still go in the scope chosen with `--scope`.
- **Subagent stops:** every check is on session-wide task spend, so even if `continue:false` from a hook
  inside a subagent ends only that subagent, the parent's next `PreToolUse` / `PostToolBatch` check trips
  on the same numbers and stops the turn. Covered by an integration test and the E2E run.

## Decided by the owner

- Lead with budget + loop breaker; handoff is the safety net.
- Strict budgets: after a budget stop, a plain "continue" stays on the same task and budget.
- npx installer (approach 1). Name `spend-leash` (npm free, no exact GitHub match) unless the owner
  renames.
- Same 16-item checklist; Sonnet subagents build, Haiku for light work, never Opus; verify everything;
  all attribution codersanjay3 only.

## Left to the builder

- Module layout (mirror mcp-leash where it fits; copying its settings/backup code is fine — same owner,
  MIT).
- Exact wording of messages, the status-line format, and the price table values (take them from current
  Anthropic pricing at build time, cite the source in a comment).
- Simulator UI details, demo GIF script.
