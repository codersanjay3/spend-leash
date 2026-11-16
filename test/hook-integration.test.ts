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

  it("20 concurrent PreToolUse processes leave a valid session file", async () => {
    hook(evt("UserPromptSubmit", { prompt: "go" }));
    const runs = Array.from(
      { length: 20 },
      (_, i) =>
        new Promise<{ code: number | null; stdout: string }>((res) => {
          const p = execFile(process.execPath, [HOOK], { env: env() }, (err, stdout) =>
            res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
          );
          p.stdin?.end(
            JSON.stringify(
              evt("PreToolUse", { tool_name: "Bash", tool_input: { command: `c${i}` } }),
            ),
          );
        }),
    );
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code).toBe(0);
    const parsed = JSON.parse(readFileSync(sessionFile(), "utf8"));
    expect(parsed.sessionId).toBe(SID);
    expect(parsed.task).toBeDefined();
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
