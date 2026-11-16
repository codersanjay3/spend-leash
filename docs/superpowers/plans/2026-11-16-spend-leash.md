# spend-leash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An npx-installed Claude Code hook pack that enforces per-task USD / plan-% budgets, breaks runaway loops, and writes a handoff file that the next session picks up.

**Architecture:** A pure, synchronous `engine` turns one hook input plus on-disk state into one `HookResult`; thin entries (`hook.mjs`, `statusline.mjs`, `cli.js`) do I/O. Spend comes from incremental, deduplicated reads of the session transcript plus its `subagents/*.jsonl`; plan-% comes from snapshots written by a status-line wrapper. Settings install/uninstall is ported from the sibling repo mcp-leash (same owner, MIT).

**Tech Stack:** TypeScript ESM, Node ≥ 20, tsup 8 (esbuild override `^0.28.2`), vitest 4.1.12, biome 2, picocolors (CLI only). The bundled `hook.mjs` and `statusline.mjs` have zero runtime imports outside `node:*`.

**Spec:** `docs/superpowers/specs/2026-11-16-spend-leash-design.md` — read it before any task.

**Reference repo (read-only):** `the mcp-leash repo (github.com/codersanjay3/mcp-leash)`. Port, don't import.

## Global Constraints

- Package name `spend-leash`, bin `spend-leash` → `dist/cli.js`; version `0.1.0`; `"engines": {"node": ">=20"}`; tsup `target: "node20"`.
- License MIT, `Copyright (c) 2026 codersanjay3`; `package.json` `"author": "codersanjay3"`; repo URL `https://github.com/codersanjay3/spend-leash`.
- Git identity for every commit in this repo (set once in Task 1, local config): `user.name codersanjay3`, `user.email 97484430+codersanjay3@users.noreply.github.com`. **No Co-Authored-By or other names in commits.**
- State home: `~/.spend-leash`, overridable by env `SPEND_LEASH_HOME`; `HOME`/`USERPROFILE` respected (tests always use a temp HOME — never touch the real `~/.claude` or `~/.spend-leash`).
- Defaults (spec, verbatim): `task.usd = 2`, `task.planPct = null`, `task.warnAt = 0.8`, `plan.stopAtPct = 95`, `loop.warnAt = 3`, `loop.stopAt = 5`, `loop.window = 12`, `handoff.dir = ".spend-leash/handoffs"`, `failClosed = false`.
- Hooks fail open: any exception / watchdog (800 ms) → exit 0, empty stdout, one line appended to `~/.spend-leash/errors.log`. `failClosed: true` turns budget-path errors into a deny.
- Files written under `~/.spend-leash` that hold prompts or args (`tasks.jsonl`, `sessions/*.json`, handoffs) are mode 0600 (dirs 0700) on POSIX.
- No network calls anywhere. No telemetry.
- Message prefix for anything shown to user or Claude: `spend-leash: `.
- Biome clean, `tsc --noEmit` clean, all tests pass before every commit.

## Review Focus

1. **Transcript edge cases:** a half-written last line, a transcript that shrank or was replaced (`/clear` → new file, or offset > size), a missing `subagents/` dir, `<synthetic>` / unknown models → no crash, no double count, re-read from 0 when the file shrank. (Task 3 tests.)
2. **Normal work misread as a loop:** Read file → Edit file → Read file; run tests → edit → run tests; 3× `TodoWrite` → none of these warn. (Task 6 tests.)
3. **User's existing status line:** a command that prints color codes, exits non-zero, hangs > 2 s, or reads stdin → wrapper output is byte-identical to running it directly (minus the hang, cut at 2 s) and a snapshot is still written. (Task 7 tests.)
4. **Concurrent hooks** (parallel subagents firing PreToolUse at once) → per-session state never corrupt (valid JSON after 20 concurrent hook processes). (Task 10 integration test.)
5. **Settings with comments-free but unusual shapes:** `hooks` missing / not an object, existing `PreToolUse` groups from other tools, symlinked settings file, `statusLine` of type other than `command` → init/uninstall leave everything else byte-identical. (Task 9 tests.)

---

### Task 1: Scaffold, paths, CLI skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `biome.json`, `.gitignore`, `LICENSE`, `src/paths.ts`, `src/cli.ts`, `src/stdin.ts`, `test/global-setup.ts`, `test/cli.test.ts`, `.github/workflows/ci.yml`
- Copy-adapt from mcp-leash: `tsconfig.json`, `biome.json`, `vitest.config.ts`, `src/stdin.ts`, `test/global-setup.ts` (the version that runs tsup via `process.execPath` + `require.resolve("tsup/dist/cli-default.js")`), `exitAfterFlush` from `src/cli.ts`.

**Interfaces:**
- Produces: `interface Ctx { home: string; leashHome: string; now: () => Date }`; `makeCtx(env?: NodeJS.ProcessEnv): Ctx` in `src/paths.ts`; `sessionDir(ctx, sessionId) => string` (= `<leashHome>/sessions`), `errorsLog(ctx)`, `ledgerPath(ctx)` (= `<leashHome>/tasks.jsonl`).
- tsup builds three entries: `dist/cli.js` (shebang), `dist/hook.mjs` and `dist/statusline.mjs` (both `noExternal: [/.*/]`, no package imports).

- [ ] **Step 1:** `git init`, set the local identity from Global Constraints, write config files and `LICENSE`. devDependencies as mcp-leash (`@biomejs/biome ^2.6.7`, `@types/node ^22.19.0`, `tsup ^8.5.1`, `typescript ^5.9.3`, `vitest ^4.1.12`) plus `overrides.esbuild ^0.28.2`; dependency `picocolors ^1.1.1`. `npm install`; `npm audit` → 0 vulnerabilities.
- [ ] **Step 2: failing test** `test/cli.test.ts`: `spend-leash --version` prints `0.1.0` exit 0; `--help` contains `init`, `uninstall`, `status`, `report`; unknown command exits 2.
- [ ] **Step 3:** implement `src/cli.ts` with stub commands (each prints "not implemented" exit 1) and `src/paths.ts`; placeholder `src/hook.ts` / `src/statusline.ts` that exit 0.
- [ ] **Step 4:** `npm run lint && npx tsc --noEmit && npm test` → PASS.
- [ ] **Step 5:** CI workflow: matrix `os: [ubuntu-latest, macos-latest, windows-latest]`, `node: [20, 22, 24]`, steps `actions/checkout@v7`, `actions/setup-node@v7`, `npm ci`, lint, typecheck, test, build. Commit `chore: scaffold spend-leash`.

### Task 2: Pricing

**Files:** Create `src/pricing.ts`, `test/pricing.test.ts`

**Interfaces:**
- Produces: `interface UsageTotals { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }`; `const ZERO: UsageTotals`; `addUsage(a, b): UsageTotals`; `interface Price { input; output; cacheWrite5m; cacheWrite1h; cacheRead }` (USD per 1M tokens); `priceFor(model: string, overrides?: Record<string, Price>): { price: Price; estimated: boolean }`; `costUsd(u: UsageTotals, p: Price): number`.

- [ ] **Step 1:** Fetch current list prices for every current Claude model family (Fable, Opus, Sonnet, Haiku, plus the previous generation) from Anthropic's official pricing docs; put the URL and fetch date in a comment at the top of `src/pricing.ts`. Match model ids by family prefix (`claude-opus-`, `claude-sonnet-`, …), longest prefix first.
- [ ] **Step 2: failing tests:** exact price for `claude-sonnet-5-5` equals the table row; `claude-opus-5-5[1m]` and dated ids match their family; unknown model (`gpt-x`, `<synthetic>`) → most expensive known price with `estimated: true`; `costUsd({input:1e6,output:0,...},{input:3,...}) === 3`; override in config wins over the table.
- [ ] **Step 3:** implement. **Step 4:** tests pass. **Step 5:** commit `feat: pricing table`.

### Task 3: Incremental transcript spend reader

**Files:** Create `src/transcript.ts`, `test/transcript.test.ts`, `test/fixtures/transcripts/*.jsonl`

**Interfaces:**
- Consumes: `UsageTotals`, `addUsage`, `priceFor`, `costUsd`.
- Produces: `interface FileCursor { offset: number; partial: string; ids: string[]; byModel: Record<string, UsageTotals> }` (per-file ids and totals so a shrunk file can be dropped and recounted); `interface SpendCache { files: Record<string, FileCursor> }` (an id seen in any file counts once across files); `readSpend(transcriptPath: string, cache?: SpendCache, prices?: Record<string, Price>): { cache: SpendCache; usd: number; tokens: UsageTotals; estimated: boolean }` — reads `transcriptPath` and every `*.jsonl` in `<dirname(transcriptPath)>/<basename without .jsonl>/subagents/`.

- [ ] **Step 1: fixtures** built from the real line shape: `{"type":"assistant","message":{"id":"msg_1","model":"claude-sonnet-5-5","usage":{"input_tokens":2,"output_tokens":455,"cache_read_input_tokens":52837,"cache_creation_input_tokens":600,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":600}}}}` — duplicate `message.id` lines carry identical usage (verified on a real 425-line transcript) and must count once.
- [ ] **Step 2: failing tests:** (a) two lines with the same id count once; (b) a subagent file is included and its model priced separately; (c) a second call after appending lines reads only new bytes (assert by passing a cache whose offset is at EOF and appending one line → totals grow by exactly that line); (d) a trailing line without `\n` is held in `partial` and counted once it completes; (e) file shorter than cached offset → that file's old contribution is dropped and it is recounted from 0, with no double counting; (f) missing transcript or subagents dir → zeros, no throw; (g) non-assistant and malformed JSON lines ignored; (h) `cache_creation` absent → all `cache_creation_input_tokens` counted as 5m.
- [ ] **Step 3:** implement (`fs.openSync`/`readSync` from the cursor offset; on shrink drop that file's cursor and recount it from 0).
- [ ] **Step 4:** tests pass; plus a perf test: 20 MB synthetic transcript, first read < 1.5 s, incremental read of 1 new line < 20 ms. **Step 5:** commit `feat: incremental transcript spend reader`.

### Task 4: Config and inline directives

**Files:** Create `src/config.ts`, `src/directives.ts`, `test/config.test.ts`, `test/directives.test.ts`

**Interfaces:**
- Produces: `interface Config { task: { usd: number | null; planPct: number | null; warnAt: number }; plan: { stopAtPct: number }; loop: { warnAt: number; stopAt: number; window: number; ignoreTools: string[] }; handoff: { dir: string }; failClosed: boolean; prices?: Record<string, Price> }`; `DEFAULT_CONFIG: Config`; `loadConfig(ctx: Ctx, cwd: string): { config: Config; notes: string[] }` (user file `<leashHome>/config.json` merged over defaults, then `<cwd>/.spend-leash.json` applied **only where it tightens**).
- `type Directive = { kind: "set"; usd?: number; planPct?: number } | { kind: "add"; usd: number } | { kind: "off" } | { kind: "new" } | { kind: "plan-off" }`; `parseDirective(prompt: string): Directive | undefined`.

- [ ] **Step 1: failing tests (config):** defaults equal Global Constraints values; user file overrides any value; project `task.usd: 1` applies (tighter) but project `task.usd: 50` is ignored with a note containing `ignored`; project `failClosed: true` applies, `false` over user `true` ignored; project `loop.ignoreTools` is ignored (can only loosen); project `prices` ignored; malformed JSON → defaults + note, no throw.
- [ ] **Step 2: failing tests (directives):** `#budget $5 fix it` → set usd 5; `#budget 15%` → planPct 15; `#budget $5 20%` → both; `#budget +$3` → add 3; `#budget off`, `#budget new`, `#budget plan-off`; leading whitespace allowed; case-insensitive `#BUDGET`; `#budget $0`, `#budget -1`, `#budget 150%`, `#budget $abc` → undefined; directive not at start (`fix #budget $5`) → undefined; `$2.50` → 2.5.
- [ ] **Step 3:** implement. **Step 4:** pass. **Step 5:** commit `feat: config and #budget directives`.

### Task 5: Session state and task lifecycle

**Files:** Create `src/state.ts`, `src/tasks.ts`, `test/tasks.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `Config`, `Directive`, `SpendCache`, `UsageTotals`.
- Produces:
  - `interface Snapshot { at: string; fiveHourPct?: number; fiveHourResetsAt?: string; sevenDayPct?: number; costUsd?: number; model?: string }`
  - `interface Task { id: string; startedAt: string; prompt: string; limitUsd: number | null; limitPlanPct: number | null; baseUsd: number; baseTokens: UsageTotals; basePlanPct: number | null; warned: boolean; outcome?: "completed" | "stopped-budget" | "stopped-plan" | "stopped-loop" | "error"; reason?: string }`
  - `interface SessionState { sessionId: string; cwd: string; spend?: SpendCache; task?: Task; loop: { calls: string[]; failures: Record<string, number> }; planGuard: { off: boolean; trippedFor?: string }; noPlanDataShown?: boolean }`
  - `readSession(ctx, sessionId): SessionState`, `writeSession(ctx, s): void` (atomic temp+rename, 0600), `withSessionLock<T>(ctx, sessionId, fn: () => T): T` (mkdir lock `<id>.lock`, 200 ms max wait polling every 10 ms, stale lock > 5 s removed; on timeout run `fn` anyway).
  - `readSnapshot(ctx, sessionId): Snapshot | undefined` (`sessions/<id>.statusline.json`), `isFresh(s: Snapshot, now: Date): boolean` (< 10 min).
  - `startTask(s: SessionState, opts: { prompt: string; directive?: Directive; config: Config; spendUsd: number; tokens: UsageTotals; snapshot?: Snapshot; now: Date }): SessionState` implementing the spec's rules: new task with defaults; `set` overrides limits; `off` → both limits null; `add` → if previous task exists, keep it, `limitUsd += usd`, clear `outcome`/`warned`; **strict rule:** if previous task outcome is `stopped-budget` and no directive (or a `set` without `new`), keep the previous task (same baseline and limits); after `stopped-loop` keep the task and clear `loop`; `new` always starts fresh; `plan-off` sets `planGuard.off` and otherwise behaves like no directive.
  - `taskSpend(s, spendUsd, snapshot?): { usd: number; planPct: number | null }` — `planPct` = `snapshot.fiveHourPct - basePlanPct`; if `basePlanPct` is null and a fresh snapshot exists, set it now (re-baseline once) and return 0.

- [ ] **Step 1: failing tests** for every `startTask` rule above (one `it` per rule, named after it), plus: `taskSpend` re-baselines on first fresh snapshot; stale snapshot (11 min) → `planPct: null`.
- [ ] **Step 2: failing test** `withSessionLock`: 20 concurrent child processes each incrementing a counter in the session file under the lock → final counter 20 and file is valid JSON.
- [ ] **Step 3:** implement. **Step 4:** pass. **Step 5:** commit `feat: session state and task lifecycle`.

### Task 6: Loop breaker

**Files:** Create `src/loop.ts`, `test/loop.test.ts`

**Interfaces:**
- Produces: `fingerprint(toolName: string, toolInput: unknown): string` (tool name + canonical JSON with sorted keys; for `Bash` use `command` with whitespace collapsed); `WRITE_TOOLS = ["Edit","Write","MultiEdit","NotebookEdit"]`; `IGNORED_BY_DEFAULT = ["TodoWrite","TaskCreate","TaskUpdate","TaskList","TaskGet"]`; `recordCall(loop: SessionState["loop"], toolName, toolInput, cfg: Config["loop"]): { loop; verdict: "ok" | "warn" | "stop"; count: number }`; `recordFailure(loop, toolName, toolInput): SessionState["loop"]`.

- [ ] **Step 1: failing tests:** same Bash command 3× → third is `warn` with count 3; 5× → `stop`; `ls  -la` and `ls -la` share a fingerprint; `{a:1,b:2}` and `{b:2,a:1}` share one; a write tool call clears `calls` (Read→Edit→Read same file 6× alternating → never warn); 3 different commands interleaved within window 12 → ok; a call that fell out of the 12-call window no longer counts; one recorded failure makes the next identical call count double (2 runs + 1 failure → warn at the 2nd repeat); `TodoWrite` ×10 → ok; config `ignoreTools: ["Read"]` honored.
- [ ] **Step 2:** implement. **Step 3:** pass. **Step 4:** commit `feat: loop breaker`.

### Task 7: Status-line wrapper

**Files:** Create `src/statusline.ts` (bundled to `dist/statusline.mjs`), `src/statusline-core.ts`, `test/statusline.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `Snapshot`, `readSession`, `Config`.
- Produces: `snapshotFrom(input: unknown, now: Date): Snapshot` (maps `rate_limits.five_hour.used_percentage`, `.resets_at`, `rate_limits.seven_day.used_percentage`, `cost.total_cost_usd`, `model.id`); `ownLine(s: SessionState | undefined, snap: Snapshot): string` → e.g. `spend-leash task $0.42/$2.00 · 5h 37%` (omit parts that are unknown); the entry reads stdin, writes the snapshot (0600), then if `<leashHome>/statusline.json` has `{ "original": { "command": string } }` runs it via the platform shell with the same stdin, 2000 ms timeout, and writes its stdout to our stdout unchanged; otherwise prints `ownLine`. Errors never change the original's output.

- [ ] **Step 1: failing tests:** snapshot mapping from a full and from an empty statusline JSON; wrapping `printf '\033[32mhi\033[0m'` reproduces bytes exactly; original exiting 1 with output → same output; original that sleeps 5 s → wrapper returns in < 2.6 s; original that echoes stdin → receives the same JSON; snapshot file exists after each case; no original → `ownLine` printed.
- [ ] **Step 2:** implement. **Step 3:** pass. **Step 4:** commit `feat: status-line wrapper`.

### Task 8: Handoff files

**Files:** Create `src/handoff.ts`, `test/handoff.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `Task`, `Config`; port `redact` and `argsPreview` from mcp-leash `src/hook-core.ts`.
- Produces: `renderHandoff(d: { reason: string; detail: string; task?: Task; sessionId: string; lastAssistant?: string; recentCalls: { tool: string; args: unknown }[]; todos?: string[]; git?: { status: string; diffStat: string }; now: Date }): string` (markdown; sections: `# Handoff`, reason line with numbers, `## Task` (prompt), `## Where it stopped` (last assistant message, ≤ 2,000 chars), `## Recent tool calls` (≤ 10, 120-char redacted previews), `## Changed files` (git), `## Next steps` (todos if any), `## Resume` with `claude --resume <sessionId>` and the `#budget +$2` / `#budget new` hints); `writeHandoff(ctx, cwd, cfg, markdown, now, reason): string` (path `<cwd>/<handoff.dir>/<YYYYMMDDTHHMMSSZ>-<reason>.md`; fallback `<leashHome>/handoffs/` when cwd is not writable; 0600); `gitInfo(cwd): { status; diffStat } | undefined` (2 s timeout each, undefined if not a repo or git missing); `lastTodos(transcriptPath): string[] | undefined` (last `TodoWrite` tool_use input in the transcript, tail-read ≤ 2 MB); `pendingHandoff(ctx, cwd, now): { path: string; preview: string } | undefined` (newest unconsumed file < 7 days in either dir; preview ≤ 1,500 chars) and `markConsumed(ctx, path)` (recorded in `<leashHome>/consumed.json`).

- [ ] **Step 1: failing tests:** rendered markdown contains each section and the resume line; secrets in args (`ghp_…`, `sk-…`, `password=`) are redacted; non-git temp dir → no Changed files section; git temp repo with one modified file → it appears in status; unwritable cwd (chmod 0500, skip on Windows/root) → file lands in fallback dir; `pendingHandoff` returns newest, then nothing after `markConsumed`; 8-day-old handoff ignored.
- [ ] **Step 2:** implement. **Step 3:** pass. **Step 4:** commit `feat: handoff files`.

### Task 9: Install / uninstall into Claude Code settings

**Files:** Create `src/settings.ts`, `src/install.ts`, `test/install.test.ts`; port from mcp-leash `src/settings.ts`: `settingsPathFor`, `readSettingsFile`, `backupFile`, `canonicalPath`, `writeJsonAtomic` (symlink- and mode-preserving).

**Interfaces:**
- Produces: `HOOK_EVENTS = ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PostToolUseFailure","PostToolBatch","Stop","StopFailure","SubagentStop"] as const`; `hookCommand(leashHome): (event) => string` = `node "<leashHome>/hook.mjs" <event>` (forward slashes on Windows); `interface InstallRecord { scope; settingsPath; hooks: { event: string; command: string }[]; statusLine?: { settingsPath: string; original: unknown | null; wrapper: { type: "command"; command: string } } }`; `planInstall(ctx, opts: { scope: Scope; project: string }): { changes: { path: string; before: Settings; after: Settings }[]; record: InstallRecord }`; `applyInstall(ctx, plan)`; `planUninstall(ctx, record)`; `effectiveStatusLine(ctx, project): { path: string; value: unknown } | undefined` (local > project > user).
- Matchers: tool events use `"matcher": "*"`; non-tool events omit `matcher`.

- [ ] **Step 1: failing tests:** init into empty settings adds 9 hook groups and a wrapper `statusLine` in user scope with `"original": null` recorded; existing user `statusLine` `{type:"command",command:"~/sl.sh"}` → replaced by wrapper and `<leashHome>/statusline.json` holds the original; a `statusLine` defined in project-local `.claude/settings.local.json` is the one wrapped even with `--scope user`; running init twice → second plan has no changes; uninstall after init → every touched file byte-identical to before (both the hooks file and the statusLine file); user edited `statusLine` after init → uninstall leaves theirs and returns a warning; other tools' existing `PreToolUse` groups untouched in order; `hooks` not an object → refuse with a clear error, file untouched; symlinked settings stays a symlink with 0600 mode; a backup is created before each write.
- [ ] **Step 2:** implement. **Step 3:** pass. **Step 4:** commit `feat: install and uninstall`.

### Task 10: Engine and hook entry

**Files:** Create `src/engine.ts`, `src/hook.ts`, `src/types.ts`, `test/engine.test.ts`, `test/hook-integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `interface HookInput { hook_event_name: string; session_id: string; transcript_path: string; cwd: string; prompt?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown; tool_calls?: { tool_name: string; tool_input: unknown; tool_response?: unknown }[]; error?: string; last_assistant_message?: string; agent_id?: string; agent_transcript_path?: string; stop_hook_active?: boolean }`; `interface HookResult { stdout: string; stderr: string; code: number }`; `runEngine(ctx: Ctx, input: HookInput): HookResult` (pure apart from the state/ledger/handoff writes it performs through the modules above); `hook.ts` = mcp-leash-style supervisor (worker thread, 800 ms watchdog, fail open / `failClosed`), reading the event name from `argv[2]` with the stdin `hook_event_name` taking precedence.
- Output shapes (exact):
  - stop on PreToolUse: `{"continue":false,"stopReason":<msg>,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<msg>}}`
  - stop on PostToolBatch: `{"continue":false,"stopReason":<msg>,"decision":"block","reason":<msg>}`
  - warn (PreToolUse): `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":<warn>}}`
  - UserPromptSubmit context: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":<text>}}` plus `"systemMessage"` when the user must see something (plan data unavailable, continuing a stopped task).
  - SessionStart: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<handoff notice>}}`
  - Stop/StopFailure/SubagentStop/PostToolUse: no stdout.
- Messages (exact copy):
  - budget stop: `spend-leash: task budget $<limit> reached ($<spent>). Handoff: <path>. Reply "#budget +$<limit>" to continue this task or "#budget new" to start fresh.`
  - plan stop: `spend-leash: 5-hour plan window at <pct>% (stop at <stopAt>%). Handoff: <path>. Resets <local time>. Reply "#budget plan-off" to keep going.`
  - loop stop: `spend-leash: the same <tool> call ran <n> times in a row; stopping to avoid a loop. Handoff: <path>.`
  - warn: `spend-leash: <pct>% of this task's budget used ($<spent> of $<limit>). Finish the current step, then stop and summarize what is left.`
  - loop warn: `spend-leash: you have run this exact <tool> call <n> times; the result will not change. Try a different approach, or stop and explain what is blocking you.`

- [ ] **Step 1: failing engine tests (one per behavior):** UserPromptSubmit starts a task (ledger untouched); PreToolUse under budget → empty stdout; crossing `warnAt` → warn once per task; over budget → stop JSON above + handoff file exists + session task outcome `stopped-budget`; next plain prompt then PreToolUse → stops again (strict); `#budget +$2` then PreToolUse → allowed; plan snapshot 96% → plan stop once per `resets_at`, second prompt in same window → allowed with a `systemMessage` warning; `#budget plan-off` → no plan stop; subagent input (`agent_id` set) uses the same session task; PostToolBatch over budget → batch stop JSON; Stop → ledger line with outcome `completed` (or the stop outcome) and fields `{ts, sessionId, cwd, prompt, usd, tokens, planPctDelta, outcome, reason}`; StopFailure `rate_limit` → handoff written, ledger outcome `error`; SessionStart with a pending handoff → context contains its path, then consumed; planPct-only budget with no snapshot → one `systemMessage` per session containing `plan-% budget inactive`; `#budget off` → no budget stop but loop stop still works.
- [ ] **Step 2:** implement `engine.ts`. **Step 3:** pass.
- [ ] **Step 4: failing integration tests** (spawn built `dist/hook.mjs` in a temp HOME with fixture transcripts): budget stop end-to-end; a corrupt session file → exit 0, empty stdout, line in `errors.log`; `failClosed: true` + corrupt state → deny; 20 concurrent PreToolUse processes on one session → all exit 0 and the session file is valid JSON; p95 latency of 50 sequential PreToolUse calls on a 20 MB transcript after the first < 50 ms (skip on CI if `CI` and machine is slow? no — assert < 150 ms on CI, < 50 ms locally).
- [ ] **Step 5:** implement `hook.ts`; pass; commit `feat: enforcement engine and hook`.

### Task 11: CLI commands

**Files:** Modify `src/cli.ts`; create `src/cmd-init.ts`, `src/cmd-uninstall.ts`, `src/cmd-status.ts`, `src/cmd-report.ts`, `test/cli-commands.test.ts`

**Interfaces:**
- Consumes: `planInstall/applyInstall/planUninstall`, `readSession`, `readSnapshot`, `loadConfig`, ledger lines.
- `init [--scope user|project|local] [--budget $2|10%] [--yes]`: shows the planned changes (files, hook count, status line wrapped or added), asks to confirm in a TTY (`--yes` skips; non-TTY without `--yes` → exit 2 with a hint), copies `dist/hook.mjs` and `dist/statusline.mjs` to `<leashHome>`, writes `config.json` if absent (with `--budget` applied), applies, prints the gitignore hint `.spend-leash/` and how to undo. Notes when plan data cannot be available (prints that `planPct` needs a Pro/Max/Ultra status line).
- `uninstall [--scope] [--yes]`: reverse using `state.json`; leaves `<leashHome>` data (ledger, handoffs) in place and says so.
- `status`: per session in the last 24 h: task prompt (60 chars), spent / limit, plan % and snapshot age, outcome; "not installed" hint if no state.
- `report [-n 20] [--json] [--today]`: table of the last n ledger lines + totals; `--json` prints `{ tasks, totals }`.
- No args: `status` if installed, else a short explanation pointing to `init`.

- [ ] **Step 1: failing tests** for each command's happy path and: non-TTY init without `--yes` → exit 2; init then uninstall round-trip leaves settings byte-identical; `report --json` on an empty ledger → `{"tasks":[],"totals":{"usd":0,"tasks":0}}`; `--budget 10%` writes `task.planPct: 10`.
- [ ] **Step 2:** implement. **Step 3:** pass; `npm pack` then install the tarball into a temp dir and run `spend-leash --version` and `init --yes` with a temp HOME → exit 0. **Step 4:** commit `feat: CLI commands`.

### Task 12: Browser simulator (live demo)

**Files:** Create `site/index.html`, `site/style.css`, `site/main.ts`, `site/core.ts`, `site/scenarios.ts`, `scripts/build-site.mjs`, `.github/workflows/pages.yml`, `test/site-core.test.ts` (port the structure, theming tokens, 375 px layout rules and Pages workflow from mcp-leash's `site/`).

**Interfaces:**
- `simulate(events: HookInput[], transcriptLines: string[], config: Config): { steps: { i: number; event: string; tool?: string; usd: number; planPct: number | null; verdict: "ok" | "warn" | "stop"; message?: string }[]; handoff?: string }` in `site/core.ts`, built on the same `startTask`, `taskSpend`, `recordCall`, `renderHandoff` and pricing modules (pure; an in-memory state instead of files). Three scenarios in `scenarios.ts`: "Expensive refactor" (budget stop), "Test-fix loop" (loop warn then stop), "Near the 5-hour limit" (plan stop). Paste box accepts a transcript JSONL and replays its tool calls.
- [ ] **Step 1: failing test:** each scenario's verdict sequence and stop message equal what `runEngine` produces for the same inputs in a temp HOME (parity test, as mcp-leash's site-core test).
- [ ] **Step 2:** implement; build; verify in the browser pane at desktop, 375 px and dark mode with no console errors. **Step 3:** commit `feat: browser simulator`.

### Task 13: Docs, demo assets, launch checklist files

**Files:** `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (`## [0.1.0] - Unreleased`), `.github/ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,config.yml}`, `docs/show-hn.md`, `docs/good-first-issues.md` (5 issues: Codex CLI support research, `report --since`, per-project default budgets in `status`, a `/budget` slash-command plugin wrapper, Windows path edge cases), `demo/record.mjs` (port mcp-leash's: renders real CLI + hook output to `docs/demo.gif`), `demo/social-preview.svg` → `docs/social-preview.png` 1280×640 < 1 MB.
- README top: GIF, then the one-line description `Per-task budgets and a loop breaker for Claude Code: stop a task at $2 or 10% of your plan window, and pick up where it left off.`, then `npx spend-leash init`, then badges (CI, npm, license) and the simulator link `https://codersanjay3.github.io/spend-leash/`. Sections: how it works, `#budget` directives, config reference, what it cannot do (no mid-generation stop; USD is a list-price estimate; plan % needs a Pro/Max/Ultra status line), uninstall, comparison with ccusage and native `--max-budget-usd` (print mode only), sibling link to mcp-leash.
- [ ] **Step 1:** write files; `npm run demo:record` produces a GIF 5–10 s long; check frames visually.
- [ ] **Step 2:** checklist audit against the 16 items (PASS/FAIL/N/A per item with file) — GitHub-side items (topics, Discussions, secret scanning, release, labels) are listed as "after push, needs owner OK". Commit `docs: README, contributing, demo assets`.

### Task 14: Whole-repo verification (no new features)

- [ ] **Step 1:** fresh clone into a temp dir → `npm ci && npm run lint && npx tsc --noEmit && npm test && npm run build` all pass.
- [ ] **Step 2:** sandbox run with a temp HOME holding a copy of a realistic `~/.claude/settings.json` (with a status line) and a recorded real transcript: `init --yes`, feed recorded hook inputs through `dist/hook.mjs`, confirm warn → stop → handoff → SessionStart pickup → `report`; `uninstall --yes` → byte-identical settings. Real `~/.claude` and `~/.spend-leash` untouched (compare checksums before/after).
- [ ] **Step 3:** if `claude` is logged in, a live interactive-equivalent run (`claude -p` with a sandbox HOME is print mode — note that plan % is unavailable there) with `#budget $0.05` to observe a real stop; otherwise record "live E2E unverified" in the final report.
- [ ] **Step 4:** `npm audit` 0 vulnerabilities; `git log --format='%an %ae %cn %ce' | sort -u` shows only codersanjay3 noreply.
