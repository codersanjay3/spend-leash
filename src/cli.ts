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
`;
}

async function main(): Promise<number> {
  const [cmd] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(help());
    return 0;
  }
  if (cmd in COMMANDS) {
    console.error(`spend-leash: ${cmd} not implemented`);
    return 1;
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
