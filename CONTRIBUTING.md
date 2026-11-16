# Contributing

Thanks for helping. This is a small project; the bar is "tests pass and the change is easy to review".

## Setup

```sh
git clone https://github.com/codersanjay3/spend-leash
cd spend-leash
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

Requires Node 20 or newer. Build before testing: the integration tests run the built `dist/hook.mjs` and `dist/statusline.mjs`.

| Command | What it does |
| --- | --- |
| `npm test` | Runs the tests (vitest). |
| `npm run lint` | Biome check over `src`, `test` and `site`. `npm run format` fixes what it can. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | Bundles `dist/cli.js`, `dist/hook.mjs` and `dist/statusline.mjs`. |
| `npm run site:build` | Builds the browser simulator into `site-dist/`. Open `site-dist/index.html` to try it. |
| `npm run demo:record` | Re-records `docs/demo.gif` and `docs/social-preview.png` from real output. macOS and ffmpeg only. |

## Ground rules

- **Never touch the real home directory in tests.** Tests use a temp `HOME` (and `USERPROFILE`) and set `SPEND_LEASH_HOME` to a temp directory. A test that reads or writes the real `~/.claude` or `~/.spend-leash` will be rejected. Copy the setup in `test/hook-integration.test.ts`: `mkdtempSync`, pass the overrides in the child process `env`, delete the directory in `afterEach`.
- **Test first.** Add a failing test, then the change. Unit tests are in `test/*.test.ts`. Integration tests spawn the built hook with recorded hook inputs against fixture transcripts in `test/fixtures`.
- **Hooks fail open and stay fast.** An exception in a hook must end in exit 0 with empty stdout and one line in `errors.log`. Do not add work that reads a whole transcript on every call; spend is read incrementally.
- **Pure core modules stay pure.** `tasks.ts`, `loop.ts`, `directives.ts`, `pricing.ts`, `config.ts`, `engine-core.ts`, `handoff-render.ts`, `redact.ts` and `statusline-core.ts` must not import `node:fs` or `node:child_process`, because the simulator bundles them for the browser. `npm run site:build` fails if a Node-only import slips in. File and process I/O belongs in `state.ts`, `handoff.ts`, `config-load.ts` and the entry points.
- **The installed hook has no runtime dependencies.** `dist/hook.mjs` and `dist/statusline.mjs` are single files.
- **Windows and POSIX.** Tests that need chmod, symlinks or a POSIX shell use `it.skipIf(process.platform === "win32")`. CI runs Windows too.
- **Keep Claude Code facts accurate.** If you change how a hook event is used, check the Claude Code hooks documentation and say which version you tested.

## Pull requests

- One topic per PR. Describe what changed and why.
- Update `CHANGELOG.md` under "Unreleased" for user-visible changes.
- Checklist before you open it:
  - [ ] `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass
  - [ ] new behavior has a test that failed before the change
  - [ ] no test touches the real home directory
  - [ ] README or config docs updated if a flag, key or message changed
  - [ ] changelog entry added
- CI runs on Ubuntu, macOS and Windows with Node 20, 22 and 24.

AI-assisted contributions are welcome. Say so in the PR description, and make sure you have read and can explain every line you submit.

I aim to reply to every issue and pull request within one day. If you have heard nothing after three days, ping the thread.

Looking for something to start with? See `docs/good-first-issues.md`.
