# Show HN draft

**Title:** Show HN: spend-leash - per-task budgets and a loop breaker for Claude Code

**Body:**

A Claude Code task can run away: an agent re-runs the same failing test, or a refactor keeps growing. Claude Code has `--max-budget-usd` and `--max-turns`, but only for print mode. In an interactive session, usage tools tell you what you have already spent, which is too late to change anything.

spend-leash gives every prompt a budget. `npx spend-leash init` installs it, and each task gets $2 by default (or a percent of your 5-hour plan window). At 80% Claude is told to wrap up. At 100% the next tool call is denied and the task stops. You can change the limit per prompt: `#budget $5 refactor the auth module`.

It also has a loop breaker (the same tool call or failing command three times is a warning, five is a stop; editing a file resets the count, so read-edit-read and test-fix-test are not loops), and a plan-window guard that stops before the 5-hour usage limit cuts a turn in half. Every stop writes a markdown handoff file: your prompt, where Claude got to, the last tool calls (redacted), the git state and a `claude --resume` line. The next session in that project is told the file exists.

How it works: it is a set of Claude Code hooks, one dependency-free file. No hook input carries cost, so it reads the session transcript Claude Code already writes (including subagent transcripts), counts each API message once and prices the tokens from a built-in table. Plan percent comes from a small status-line wrapper that saves a snapshot and then runs your original status line unchanged. `uninstall` restores your settings.

Limits: it cannot stop a model mid-generation, only at tool calls and turn boundaries, so a task can end a bit over budget. The dollar figure is a list-price estimate, not your bill. Plan-percent budgets need a Pro, Max or Ultra status line. Hooks fail open on any error, with an opt-in `failClosed`. A project `.spend-leash.json` can only tighten limits, so a cloned repo cannot loosen yours. Claude Code only for now. No network calls and no telemetry.

You can replay a session through the real enforcement code in the browser, without installing anything: https://codersanjay3.github.io/spend-leash/

Code (MIT): https://github.com/codersanjay3/spend-leash. I would like to hear which budget defaults feel right, and what a loop looks like in your own sessions.
