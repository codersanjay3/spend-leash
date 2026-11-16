// Status-line wrapper: records a snapshot, then reproduces the user's original status line.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "./paths.js";
import { appendError, readSession, writeSnapshot } from "./state.js";
import { ownLine, snapshotFrom } from "./statusline-core.js";

const TOTAL_MS = 2000;

const STDIN_WAIT_MS = 500;
const MIN_RUN_MS = 300;

/** Resolves on end/error, or after STDIN_WAIT_MS with whatever arrived so far. */
function readStdinBytes(): Promise<Buffer> {
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(t);
      res(Buffer.concat(chunks));
    };
    const t = setTimeout(done, STDIN_WAIT_MS);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function runOriginal(command: string, cwd: string, stdin: Buffer, budgetMs: number): Promise<void> {
  return new Promise((done) => {
    const posix = process.platform !== "win32";
    const out: Buffer[] = [];
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      process.stdout.write(Buffer.concat(out), () => done());
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd, detached: posix, stdio: "pipe" });
    } catch (e) {
      appendError(makeCtx(), `statusline: spawn failed: ${(e as Error).message}`);
      return done();
    }
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    child.on("error", (e) => {
      appendError(makeCtx(), `statusline: original failed: ${e.message}`);
      finish();
    });
    child.on("close", finish);
    timer = setTimeout(() => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
      finish();
    }, budgetMs);
  });
}

function originalCommand(leashHome: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(leashHome, "statusline.json"), "utf8"));
    const orig = (raw as { original?: { command?: unknown } } | null)?.original;
    return typeof orig?.command === "string" && orig.command.trim() ? orig.command : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  const bytes = await readStdinBytes();
  const ctx = makeCtx();
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    input = undefined;
  }
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
  const snap = snapshotFrom(input, ctx.now());
  if (sessionId) {
    try {
      writeSnapshot(ctx, sessionId, snap);
    } catch (e) {
      appendError(ctx, `statusline: ${(e as Error).message}`);
    }
  }
  const original = originalCommand(ctx.leashHome);
  if (original) {
    const budget = Math.max(MIN_RUN_MS, TOTAL_MS - (Date.now() - start));
    await runOriginal(
      original,
      typeof obj.cwd === "string" ? obj.cwd : process.cwd(),
      bytes,
      budget,
    );
    return;
  }
  let line = "spend-leash";
  try {
    line = ownLine(sessionId ? readSession(ctx, sessionId) : undefined, snap);
  } catch {}
  await new Promise<void>((r) => process.stdout.write(`${line}\n`, () => r()));
}

main()
  .catch((e) => appendError(makeCtx(), `statusline: ${(e as Error).message}`))
  .finally(() => process.exit(0));
