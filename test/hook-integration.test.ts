import { execFile, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEngine } from "../src/engine.js";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "hook.mjs");
const SID = "integ-session-1";

let tmp: string;
let leash: string;
let cwd: string;
let transcript: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spend-leash-int-"));
  leash = join(tmp, "leash");
  cwd = join(tmp, "proj");
  mkdirSync(cwd);
  transcript = join(tmp, `${SID}.jsonl`);
  writeFileSync(transcript, "");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => ({ ...process.env, HOME: tmp, USERPROFILE: tmp, SPEND_LEASH_HOME: leash });

function hook(input: unknown, argvEvent?: string) {
  const r = spawnSync(process.execPath, [HOOK, ...(argvEvent ? [argvEvent] : [])], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: env(),
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

describe("hook entry point", () => {
  it("defaults the leash home to its own directory when SPEND_LEASH_HOME is unset", () => {
    const home = join(tmp, "custom-home");
    mkdirSync(home);
    const copy = join(home, "hook.mjs");
    writeFileSync(copy, readFileSync(HOOK));
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp };
    delete e.SPEND_LEASH_HOME;
    const r = spawnSync(process.execPath, [copy], {
      input: JSON.stringify(evt("UserPromptSubmit", { prompt: "hello" })),
      env: e,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, "sessions", `${SID}.json`))).toBe(true);
    expect(existsSync(join(tmp, ".spend-leash"))).toBe(false);
  });

  it("fails open within about 2.5 s when stdin never closes", async () => {
    const t0 = Date.now();
    const code = await new Promise<number | null>((res) => {
      const c = execFile(process.execPath, [HOOK, "Stop"], { env: env() });
      c.on("exit", (x) => res(x));
      // stdin is left open and never ended
    });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 10000);
});

const evt = (name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: name,
  session_id: SID,
  transcript_path: transcript,
  cwd,
  ...extra,
});

function spendLine(id: string, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 1, output_tokens: outputTokens },
      content: [{ type: "text", text: "x" }],
    },
  })}\n`;
}

const sessionFile = () => join(leash, "sessions", `${SID}.json`);

describe("hook.mjs", () => {
  it("budget stop end-to-end", () => {
    expect(hook(evt("UserPromptSubmit", { prompt: "do work" })).stdout).toBe("");
    appendFileSync(transcript, spendLine("m1", 300_000)); // $3
    const r = hook(evt("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.continue).toBe(false);
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const path = /Handoff: (.+)\. Reply/.exec(j.stopReason)?.[1] ?? "";
    expect(existsSync(path)).toBe(true);
  });

  it("uses argv[2] when stdin lacks the event name, and stdin wins when both exist", () => {
    hook(evt("UserPromptSubmit", { prompt: "x" }));
    appendFileSync(transcript, spendLine("m1", 300_000));
    const noName = {
      session_id: SID,
      transcript_path: transcript,
      cwd,
      tool_name: "Bash",
      tool_input: {},
    };
    expect(hook(noName, "PreToolUse").stdout).toContain("deny");
    // stdin says Stop (no output); argv says PreToolUse
    expect(hook(evt("Stop"), "PreToolUse").stdout).toBe("");
  });

  it("garbage stdin fails open and logs", () => {
    const r = hook("not json at all", "PreToolUse");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(join(leash, "errors.log"), "utf8")).toContain("bad stdin");
  });

  it("a corrupt session file: exit 0, empty stdout, error logged", () => {
    mkdirSync(join(leash, "sessions"), { recursive: true });
    writeFileSync(sessionFile(), "{ this is not json");
    const r = hook(evt("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(join(leash, "errors.log"), "utf8")).toMatch(/not valid JSON/);
  });

  it("failClosed + corrupt state denies", () => {
    mkdirSync(join(leash, "sessions"), { recursive: true });
    writeFileSync(sessionFile(), "{ this is not json");
    writeFileSync(join(leash, "config.json"), JSON.stringify({ failClosed: true }));
    const r = hook(evt("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(j.stopReason).toBe("spend-leash: internal error (failClosed)");
  });

  async function concurrentPre(n: number) {
    hook(evt("UserPromptSubmit", { prompt: "go" }));
    const runs = Array.from(
      { length: n },
      (_, i) =>
        new Promise<number>((res) => {
          const p = execFile(process.execPath, [HOOK], { env: env() }, (err) =>
            res(err ? ((err as { code?: number }).code ?? 1) : 0),
          );
          p.stdin?.end(
            JSON.stringify(
              evt("PreToolUse", { tool_name: "Bash", tool_input: { command: `c${i}` } }),
            ),
          );
        }),
    );
    for (const code of await Promise.all(runs)) expect(code).toBe(0);
    return JSON.parse(readFileSync(sessionFile(), "utf8"));
  }

  it("5 concurrent PreToolUse processes all land in the loop history", async () => {
    const parsed = await concurrentPre(5);
    expect(parsed.loop.calls.length).toBe(5);
  });

  it("20 concurrent PreToolUse processes leave a valid session file", async () => {
    const parsed = await concurrentPre(20);
    expect(parsed.sessionId).toBe(SID);
    expect(parsed.task).toBeDefined();
    expect(parsed.loop.calls.length).toBeGreaterThanOrEqual(1);
    expect(parsed.loop.calls.length).toBeLessThanOrEqual(20);
  });

  it("failClosed + corrupt state denies PostToolBatch too, and keeps denying until a prompt", () => {
    mkdirSync(join(leash, "sessions"), { recursive: true });
    writeFileSync(sessionFile(), "{ nope");
    writeFileSync(join(leash, "config.json"), JSON.stringify({ failClosed: true }));
    const batch = JSON.parse(hook(evt("PostToolBatch")).stdout);
    expect(batch.decision).toBe("block");
    expect(batch.reason).toBe("spend-leash: internal error (failClosed)");
    const tool = evt("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(hook(tool).stdout).toContain("deny");
    expect(hook(tool).stdout).toContain("deny");
    expect(hook(evt("UserPromptSubmit", { prompt: "go" })).stdout).toBe("");
    expect(hook(tool).stdout).toBe("");
  });

  it("perf: 50 sequential PreToolUse calls on a 20 MB transcript", () => {
    const line = spendLine("x", 1).trimEnd();
    const pad = "y".repeat(900);
    const chunks: string[] = [];
    let size = 0;
    for (let i = 0; size < 20 * 1024 * 1024; i++) {
      const l = `${line.replace('"id":"x"', `"id":"m${i}","pad":"${pad}"`)}\n`;
      chunks.push(l);
      size += l.length;
    }
    writeFileSync(transcript, chunks.join(""));
    hook(evt("UserPromptSubmit", { prompt: "perf" }));

    const input = (i: number) =>
      evt("PreToolUse", { tool_name: "Read", tool_input: { file: `f${i}` } });
    hook(input(-1)); // first call primes the cache
    const whole: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      const r = hook(input(i));
      whole.push(performance.now() - t);
      expect(r.code).toBe(0);
    }
    const p95 = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95) - 1] ?? 0;

    const startup: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      spawnSync(process.execPath, ["-e", "0"]);
      startup.push(performance.now() - t);
    }

    // In-process engine time, same cache-warm state.
    const ctx = { home: tmp, leashHome: leash, now: () => new Date() };
    const eng: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      runEngine(ctx, input(100 + i) as never);
      eng.push(performance.now() - t);
    }

    const out = { wholeP95: p95(whole), nodeStartupP95: p95(startup), engineP95: p95(eng) };
    console.info(`perf ${JSON.stringify(out)}`);
    expect(out.engineP95).toBeLessThan(50);
    // Whole-process p95 is ~50 ms locally: ~21 ms is bare Node startup and ~25 ms the worker thread
    // that guards against hangs, so the 50 ms target is not reachable by the engine alone. Hold the
    // engine to < 50 ms and the whole process to < 300 ms (ruling), not flaky at the 50 ms edge.
    expect(out.wholeP95).toBeLessThan(300);
  });
});
