# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository. Include steps to reproduce and the version (`npx spend-leash --version`). I aim to respond within a few days.

## Scope

Reports in these areas are in scope:

- **Settings edits.** `init` and `uninstall` change your Claude Code settings file. Anything that corrupts it, loses your existing hooks or status line, follows a symlink somewhere unexpected, or leaves changes behind after `uninstall`.
- **Hook failure modes.** Hooks fail open by default: on an error or after about 1.5 seconds they exit 0 with no output. A way to make a hook hang Claude Code, or to bypass a stop without an error being logged, is in scope. With `failClosed: true`, budget-path errors deny the call.
- **Redaction.** Prompts and tool arguments are redacted by key name and by common token shapes before they reach the ledger, handoff files or `errors.log`. A realistic secret that gets through is in scope, though redaction is best effort and the files should still be treated as sensitive.
- **Project config tightening.** A `<project>/.spend-leash.json` can only lower limits. Any way for a repository to loosen the limits you set, change prices, or redirect handoff files is in scope.
- **File permissions.** `tasks.jsonl`, `sessions/*.json`, `errors.log` and handoff files are created with mode 0600 on POSIX.

## Things to know

- spend-leash reduces the chance of a runaway task; it is not a security boundary. It cannot stop Claude mid-generation, and a user with write access to `~/.spend-leash/config.json` or your settings can turn it off.
- It makes no network requests and sends no telemetry.
- It always writes a timestamped backup before editing a settings file.

## Supported versions

Only the latest release receives fixes.
