# Good first issues (drafts)

Copy each into a GitHub issue labelled `good first issue`. Run `npm test` and `npm run lint` before opening a PR; see CONTRIBUTING.md.

## 1. Research: what would Codex CLI support need?

**Context.** spend-leash only supports Claude Code hooks. Before writing any code we need to know whether Codex CLI exposes enough to enforce a per-task budget.

**What to do.** Write `docs/codex-research.md` (no source changes) answering, with links to the Codex CLI docs and the version you tested:
- Which lifecycle events or hooks exist (prompt submit, before a tool call, after a tool call, stop)? Can a hook deny a call or stop the run?
- Where are session transcripts or logs written, and do they record token usage per message?
- Is there anything like a status line that exposes plan or rate-limit usage?
- Where would settings live, and could `init` edit them safely?

**Acceptance criteria.**
- Each question above has an answer or an explicit "not found".
- The doc ends with a recommendation: feasible, partly feasible, or not now, and why.
- Nothing is claimed without a source or a command you ran.

**Pointers.** `src/install.ts` (`HOOK_EVENTS`), `src/engine-core.ts` (what the engine needs from hook input), `src/types.ts` (`HookInput`).

## 2. `report --since <duration>`

**Context.** `spend-leash report` has `-n` and `--today`. People want "what did the last 3 days cost" without counting rows.

**What to do.** Add `--since <duration>` accepting a number and a unit, for example `90m`, `12h`, `3d`. Keep `--today` working. Reject bad values with a usage error (exit 2) like `-n` does.

**Acceptance criteria.**
- `report --since 2d` only lists tasks whose `ts` is within the last 2 days, and the total line matches the rows shown.
- Works together with `-n` and `--json`.
- A pure duration parser with unit tests for valid input, zero, negative, missing unit and unknown unit.
- `spend-leash --help` and the README Commands section mention the flag.

**Pointers.** `src/cmd-report.ts` (`cmdReport`, uses `ctx.now()` so tests can fix the time), `src/cli.ts` (`help`), `test/cli-commands.test.ts`.

## 3. Show the project's effective budget in `status`

**Context.** `status` prints one line per recent session. It does not say what budget a new task in the current directory would get, which depends on `~/.spend-leash/config.json` and an optional project `.spend-leash.json` that can only tighten.

**What to do.** At the end of `status`, print the effective limits for the current directory (`task.usd`, `task.planPct`, `task.warnAt`, `plan.stopAtPct`) and print any config notes, such as "project config can only tighten limits".

**Acceptance criteria.**
- In a directory with a tighter `.spend-leash.json`, `status` shows the tightened value.
- A looser value in the project file is shown as ignored, not applied.
- Output is unchanged when spend-leash is not installed (the "not installed" message only).
- Tests use a temp HOME and a temp project directory.

**Pointers.** `src/cmd-status.ts` (it already calls `loadConfig`), `src/config-load.ts` (returns `notes`), `src/config.ts` (`mergeConfig`), `test/cli-commands.test.ts`.

## 4. A `/budget` slash command as a Claude Code plugin

**Context.** Directives are typed as `#budget $5 ...` at the start of a prompt. A plugin that adds a `/budget` command could make the syntax discoverable, with `/budget` explaining the current limits and the directive forms. The design is open, so please comment on the issue with a short plan before building.

**What to do.** Add a `plugin/` folder with the manifest and a `commands/budget.md`. It must not change how `init` installs hooks, and it must not duplicate the enforcement logic.

**Acceptance criteria.**
- The plugin installs and uninstalls independently of `npx spend-leash init`.
- The command text lists every directive from the README table accurately.
- The README gains a short "Optional: /budget plugin" section stating what it does and does not do.
- No new runtime dependencies in `dist/hook.mjs`.

**Pointers.** `src/directives.ts` (the exact syntax), README "`#budget` directives", Claude Code plugin docs.

## 5. Windows path edge cases

**Context.** CI runs on Windows, but several paths are only exercised with simple temp directories. Things worth checking: spaces and non-ASCII characters in the user name, `USERPROFILE` versus `HOME`, drive-letter case in `cwd` when matching a handoff to a project, and the quoting in the hook command that goes into settings.

**What to do.** Add tests (and fixes where they fail) for at least three of these. Tests that need POSIX behavior should use `it.skipIf(process.platform === "win32")`; the new ones should run on Windows.

**Acceptance criteria.**
- Each case has a test that runs on `windows-latest` in CI.
- A handoff written for `C:\Users\Name\proj` is found by `SessionStart` when `cwd` is reported as `c:\users\name\proj`, or the issue explains why that is not safe.
- The command in `settings.json` runs when the home path contains a space.
- No change in behavior on macOS or Linux.

**Pointers.** `src/install.ts` (`hookCommand`, `fwd`), `src/paths.ts` (`makeCtx`), `src/handoff.ts` (`pendingHandoff`), `src/handoff-render.ts` (`metaLine`), `test/install.test.ts`, `test/handoff.test.ts`.
