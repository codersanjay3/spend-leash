import { stripPrefix, UsageError } from "./cli-common.js";
import { cmdInit } from "./cmd-init.js";
import { cmdReport } from "./cmd-report.js";
import { cmdStatus } from "./cmd-status.js";
import { cmdUninstall } from "./cmd-uninstall.js";
import { makeCtx } from "./paths.js";

const VERSION = "0.1.0";

const COMMANDS: Record<string, string> = {
  init: "Install the spend-leash hooks and status line into Claude Code settings",
  uninstall: "Remove everything init installed",
  status: "Show the current task budget and loop state",
  report: "Summarize spend per task",
};

function help(): string {
  const rows = Object.entries(COMMANDS)
    .map(([name, desc]) => `  ${name.padEnd(10)}${desc}`)
    .join("\n");
  return `spend-leash ${VERSION}

Usage: spend-leash <command> [options]

Commands:
${rows}

Options:
  -h, --help     Show this help
  -v, --version  Show version

init options:
  --scope user|project|local  Which settings file gets the hooks (default: user)
  --budget 2                  Default per-prompt budget in dollars (--budget 10% for plan %;
                              quote \$2 in shells)
  -y, --yes                   Apply without asking

uninstall options:
  -y, --yes                   Apply without asking

report options:
  -n <count>                  Number of tasks (default 20)
  --today                     Only tasks from today
  --json                      Machine-readable output
`;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(help());
    return 0;
  }
  const env = { ctx: makeCtx(), cwd: process.cwd() };
  try {
    switch (cmd) {
      case undefined:
      case "status":
        return await cmdStatus(rest, env);
      case "init":
        return await cmdInit(rest, env);
      case "uninstall":
        return await cmdUninstall(rest, env);
      case "report":
        return await cmdReport(rest, env);
    }
  } catch (e) {
    const msg = stripPrefix(e instanceof Error ? e.message : String(e));
    console.error(`spend-leash: ${msg}`);
    return e instanceof UsageError ? 2 : 1;
  }
  console.error(`spend-leash: unknown command "${cmd}"\n\n${help()}`);
  return 2;
}

// process.exit() right after writing drops queued output when stdout is an async pipe
// (macOS). Flush both streams first, then exit.
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

main().then(exitAfterFlush, (e) => {
  console.error(`spend-leash: ${e instanceof Error ? e.message : String(e)}`);
  exitAfterFlush(1);
});
