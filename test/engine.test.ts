import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runEngine } from "../src/engine.js";
import { step } from "../src/engine-core.js";
import type { Ctx } from "../src/paths.js";
import { ZERO } from "../src/pricing.js";
import { readSession, writeSnapshot } from "../src/state.js";
import type { HookInput } from "../src/types.js";

const SID = "sess-abcdef12";
let tmp: string;
let ctx: Ctx;
let cwd: string;
let transcript: string;
let clock: Date;
let n = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spend-leash-eng-"));
  cwd = join(tmp, "proj");
  mkdirSync(cwd);
  transcript = join(tmp, `${SID}.jsonl`);
  writeFileSync(transcript, "");
  clock = new Date("2026-11-16T12:00:00Z");
  ctx = { home: tmp, leashHome: join(tmp, "leash"), now: () => clock };
  n = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Appends an assistant message costing `usd` (sonnet-5-5 output is $10 per million). */
function spend(usd: number): void {
  const line = {
    type: "assistant",
    message: {
      id: `msg_${++n}`,
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 0, output_tokens: Math.round((usd / 10) * 1e6) },
      content: [{ type: "text", text: "x" }],
    },
  };
  appendFileSync(transcript, `${JSON.stringify(line)}\n`);
}

const base = (): HookInput => ({
  hook_event_name: "",
  session_id: SID,
  transcript_path: transcript,
  cwd,
});
const prompt = (p: string) => run({ ...base(), hook_event_name: "UserPromptSubmit", prompt: p });
const pre = (tool = "Bash", toolInput: unknown = { command: `echo ${++n}` }, extra = {}) =>
  run({
    ...base(),
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
    ...extra,
  });
function run(input: HookInput) {
  const r = runEngine(ctx, input);
  expect(r.code).toBe(0);
  return { ...r, json: r.stdout ? (JSON.parse(r.stdout) as Record<string, any>) : undefined };
}
const ledger = () =>
  existsSync(join(ctx.leashHome, "tasks.jsonl"))
    ? readFileSync(join(ctx.leashHome, "tasks.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const snap = (pct: number, resets = "2026-11-16T15:00:00Z", at = clock) =>
  writeSnapshot(ctx, SID, { at: at.toISOString(), fiveHourPct: pct, fiveHourResetsAt: resets });
const task = () => readSession(ctx, SID).task;

describe("engine", () => {
  it("UserPromptSubmit starts a task and leaves the ledger alone", () => {
    const r = prompt("fix the bug");
    expect(r.stdout).toBe("");
    expect(task()?.prompt).toBe("fix the bug");
    expect(ledger()).toEqual([]);
  });

  it("PreToolUse under budget is silent", () => {
    prompt("go");
    spend(0.5);
    expect(pre().stdout).toBe("");
  });

  it("warns once per task at warnAt, then stays silent", () => {
    prompt("go");
    spend(1.7);
    const w = pre();
    expect(w.json?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(w.json?.hookSpecificOutput.additionalContext).toBe(
      "spend-leash: 85% of this task's budget used ($1.70 of $2.00). Finish the current step, then stop and summarize what is left.",
    );
    expect(pre().stdout).toBe("");
  });

  it("over budget: deny + continue:false, handoff written, outcome stopped-budget", () => {
    prompt("go");
    spend(2.5);
    const r = pre();
    const msg = r.json?.stopReason as string;
    expect(r.json?.continue).toBe(false);
    expect(r.json?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.json?.hookSpecificOutput.permissionDecisionReason).toBe(msg);
    const m =
      /^spend-leash: task budget \$2\.00 reached \(\$2\.50\)\. Handoff: (.+)\. Reply "#budget \+\$2\.00" to continue this task or "#budget new" to start fresh\.$/.exec(
        msg,
      );
    expect(m).not.toBeNull();
    expect(existsSync(m?.[1] ?? "")).toBe(true);
    expect(task()?.outcome).toBe("stopped-budget");
    expect(msg).not.toContain("<HANDOFF>");
    expect(task()?.reason).not.toContain("<HANDOFF>");
  });

  it("is strict: a plain prompt then PreToolUse stops again without a second handoff; +$2 allows", () => {
    prompt("go");
    spend(2.5);
    const first = pre();
    const second = prompt("please continue");
    expect(second.json?.systemMessage).toBe(
      'spend-leash: continuing the stopped task ($2.50 of $2.00). Use "#budget +$N" for more or "#budget new" to start fresh.',
    );
    const again = pre();
    expect(again.json?.stopReason).toBe(first.json?.stopReason);
    const dir = join(cwd, ".spend-leash", "handoffs");
    expect(readdirCount(dir)).toBe(1);
    prompt("#budget +$2");
    expect(pre().stdout).toBe("");
  });

  it("plan stop fires once per resets_at; the next prompt in that window warns", () => {
    prompt("go");
    snap(96);
    const r = pre();
    expect(r.json?.stopReason).toMatch(
      /^spend-leash: 5-hour plan window at 96% \(stop at 95%\)\. Handoff: .+\. Resets .+\. Reply "#budget plan-off" to keep going\.$/,
    );
    expect(task()?.outcome).toBe("stopped-plan");
    const p = prompt("keep going");
    expect(p.json?.systemMessage).toContain("5-hour plan window at 96%");
    expect(task()?.outcome).toBeUndefined();
    expect(pre().stdout).toBe("");
    // a new window trips again
    snap(97, "2026-11-16T20:00:00Z");
    expect(pre().json?.stopReason).toContain("plan window at 97%");
  });

  it("#budget plan-off disables the plan guard", () => {
    prompt("#budget plan-off");
    snap(99);
    expect(pre().stdout).toBe("");
  });

  it("ignores a stale snapshot", () => {
    prompt("go");
    snap(99, "r", new Date(clock.getTime() - 20 * 60_000));
    expect(pre().stdout).toBe("");
  });

  it("subagent calls share the session task", () => {
    prompt("go");
    spend(2.5);
    const r = pre("Bash", { command: "ls" }, { agent_id: "a1" });
    expect(r.json?.continue).toBe(false);
    expect(task()?.outcome).toBe("stopped-budget");
  });

  it("main transcript is resolved from a subagent transcript_path", () => {
    prompt("go");
    spend(2.5);
    const sub = join(tmp, "agent-1.jsonl");
    writeFileSync(sub, "");
    const r = pre("Bash", { command: "ls" }, { agent_id: "a1", transcript_path: sub });
    expect(r.json?.continue).toBe(false);
  });

  it("PostToolBatch over budget returns the batch stop shape", () => {
    prompt("go");
    spend(2.5);
    const r = run({ ...base(), hook_event_name: "PostToolBatch" });
    expect(r.json?.continue).toBe(false);
    expect(r.json?.decision).toBe("block");
    expect(r.json?.reason).toBe(r.json?.stopReason);
    expect(r.json?.hookSpecificOutput).toBeUndefined();
  });

  it("Stop appends a ledger line (completed) with the expected fields", () => {
    prompt("secret token=abc123 do it");
    spend(0.4);
    const r = run({ ...base(), hook_event_name: "Stop" });
    expect(r.stdout).toBe("");
    const [l] = ledger();
    expect(l).toMatchObject({
      sessionId: SID,
      cwd,
      outcome: "completed",
      reason: "",
      planPctDelta: null,
    });
    expect(l.taskId).toBe(task()?.id);
    expect(l.usd).toBeCloseTo(0.4, 6);
    expect(l.tokens.output).toBe(40000);
    expect(l.prompt).not.toContain("abc123");
    expect(typeof l.ts).toBe("string");
  });

  it("Stop after a stop records the stop outcome", () => {
    prompt("go");
    spend(2.5);
    pre();
    run({ ...base(), hook_event_name: "Stop" });
    expect(ledger()[0]).toMatchObject({ outcome: "stopped-budget" });
    expect(ledger()[0].reason).toContain("task budget $2.00 reached");
  });

  it("StopFailure writes a handoff and an error ledger line", () => {
    prompt("go");
    const r = run({ ...base(), hook_event_name: "StopFailure", error: "rate_limit" });
    expect(r.stdout).toBe("");
    expect(readdirCount(join(cwd, ".spend-leash", "handoffs"))).toBe(1);
    expect(ledger()[0]).toMatchObject({ outcome: "error", reason: "rate_limit" });
  });

  it("SessionStart injects a pending handoff once, then consumes it", () => {
    prompt("go");
    spend(2.5);
    const stop = pre();
    const path = /Handoff: (.+)\. Reply/.exec(stop.json?.stopReason)?.[1] ?? "";
    const r = run({ ...base(), hook_event_name: "SessionStart", session_id: "other-session" });
    const c = r.json?.hookSpecificOutput;
    expect(c.hookEventName).toBe("SessionStart");
    expect(c.additionalContext).toContain(`Handoff at ${path}:`);
    expect(c.additionalContext).toContain("previous task in this project was stopped");
    const again = run({ ...base(), hook_event_name: "SessionStart", session_id: "other-session" });
    expect(again.stdout).toBe("");
  });

  it("planPct-only budget with no snapshot shows one systemMessage per session", () => {
    const a = prompt("#budget 10%");
    expect(a.json?.systemMessage).toContain("plan-% budget inactive");
    const b = prompt("#budget 10%");
    expect(b.json?.systemMessage).toBeUndefined();
  });

  it("#budget off: no budget stop, loop breaker still stops", () => {
    prompt("#budget off");
    spend(50);
    expect(pre("Bash", { command: "x1" }).stdout).toBe("");
    const same = { command: "same" };
    expect(pre("Bash", same).stdout).toBe("");
    expect(pre("Bash", same).stdout).toBe("");
    expect(pre("Bash", same).json?.hookSpecificOutput.additionalContext).toBe(
      "spend-leash: you have run this exact Bash call 3 times; the result will not change. Try a different approach, or stop and explain what is blocking you.",
    );
    pre("Bash", same);
    const stop = pre("Bash", same);
    expect(stop.json?.stopReason).toMatch(
      /^spend-leash: the same Bash call ran 5 times in a row; stopping to avoid a loop\. Handoff: .+\.$/,
    );
    expect(task()?.outcome).toBe("stopped-loop");
  });

  it("PostToolUseFailure makes a repeating failure count double", () => {
    prompt("go");
    const input = { command: "false" };
    pre("Bash", input);
    run({ ...base(), hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: input });
    const r = pre("Bash", input);
    // 2 calls + 1 failure = 3 -> warn
    expect(r.json?.hookSpecificOutput.additionalContext).toContain("3 times");
  });

  it("SubagentStop refreshes the spend cache and prints nothing", () => {
    prompt("go");
    spend(0.3);
    const r = run({ ...base(), hook_event_name: "SubagentStop" });
    expect(r.stdout).toBe("");
    expect(Object.keys(readSession(ctx, SID).spend?.files ?? {})).toContain(transcript);
  });

  it("combines budget warn and loop warn into one additionalContext; budget stop outranks plan and loop", () => {
    prompt("go");
    const same = { command: "same" };
    pre("Bash", same);
    pre("Bash", same);
    spend(1.7);
    const w = pre("Bash", same);
    const ctxText = w.json?.hookSpecificOutput.additionalContext as string;
    expect(ctxText).toContain("85% of this task's budget");
    expect(ctxText).toContain("exact Bash call 3 times");
    snap(99);
    spend(1);
    expect(pre("Bash", same).json?.stopReason).toContain("task budget");
  });

  it("unknown events are ignored", () => {
    expect(run({ ...base(), hook_event_name: "Notification" }).stdout).toBe("");
  });

  it("a failed handoff write never blocks the stop and says so", () => {
    const fileCwd = join(tmp, "not-a-dir");
    writeFileSync(fileCwd, "x");
    mkdirSync(ctx.leashHome, { recursive: true });
    writeFileSync(join(ctx.leashHome, "handoffs"), "blocked");
    cwd = fileCwd;
    prompt("go");
    spend(2.5);
    const r = pre();
    expect(r.json?.continue).toBe(false);
    expect(r.json?.stopReason).toContain("Handoff: (not written: ");
    expect(task()?.outcome).toBe("stopped-budget");
    expect(readFileSync(join(ctx.leashHome, "errors.log"), "utf8")).toContain("handoff failed");
  });

  it("#budget new after a budget stop starts a fresh task and allows the next call", () => {
    prompt("go");
    spend(2.5);
    pre();
    const oldId = task()?.id;
    const p = prompt("#budget new");
    expect(p.json?.systemMessage).toBeUndefined();
    expect(task()?.id).not.toBe(oldId);
    expect(pre().stdout).toBe("");
  });

  it("after a loop stop a plain prompt says the loop history was cleared", () => {
    prompt("#budget off");
    const same = { command: "same" };
    for (let i = 0; i < 5; i++) pre("Bash", same);
    expect(task()?.outcome).toBe("stopped-loop");
    const p = prompt("try again");
    expect(p.json?.systemMessage).toBe(
      "spend-leash: continuing the task after a loop stop; loop history cleared.",
    );
    expect(pre("Bash", same).stdout).toBe("");
  });

  it("plan-% budget stop uses the plan copy", () => {
    prompt("#budget 10%");
    snap(50);
    expect(pre().stdout).toBe("");
    snap(61);
    const r = pre();
    expect(r.json?.stopReason).toMatch(
      /^spend-leash: task plan budget 10% of the 5-hour window reached \(11% used, \$0\.00\)\. Handoff: .+\. Reply "#budget 15%" to continue this task or "#budget new" to start fresh\.$/,
    );
    expect(task()?.outcome).toBe("stopped-budget");
  });

  it("a Bash PostToolUse with a non-zero exit counts as a failure", () => {
    prompt("go");
    const input = { command: "npm test" };
    pre("Bash", input);
    run({
      ...base(),
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: input,
      tool_response: { exit_code: 1 },
    });
    // 2 calls + 1 failure = 3 -> warn already on the second call
    expect(pre("Bash", input).json?.hookSpecificOutput.additionalContext).toContain("3 times");
  });

  it("a subagent hook alone crossing warnAt warns", () => {
    prompt("go");
    spend(1.7);
    const sub = join(tmp, "agent-9.jsonl");
    writeFileSync(sub, "");
    const r = pre("Bash", { command: "ls" }, { agent_id: "a9", transcript_path: sub });
    expect(r.json?.hookSpecificOutput.additionalContext).toContain("85% of this task's budget");
  });

  it("without the session lock it decides and hands off but writes no shared state", () => {
    prompt("go");
    const before = readFileSync(join(ctx.leashHome, "sessions", `${SID}.json`), "utf8");
    mkdirSync(join(ctx.leashHome, "sessions", `${SID}.lock`));
    spend(2.5);
    const r = pre();
    expect(r.json?.continue).toBe(false);
    expect(r.json?.stopReason).not.toContain("<HANDOFF>");
    expect(readFileSync(join(ctx.leashHome, "sessions", `${SID}.json`), "utf8")).toBe(before);
    const stop = run({ ...base(), hook_event_name: "Stop" });
    expect(stop.stdout).toBe("");
    expect(ledger()).toEqual([]);
  });
});

describe("PostToolBatch", () => {
  const batch = () => run({ ...base(), hook_event_name: "PostToolBatch" });

  it("is silent under budget", () => {
    prompt("go");
    spend(0.2);
    expect(batch().stdout).toBe("");
  });

  it("warns once when crossing warnAt", () => {
    prompt("go");
    spend(1.7);
    const r = batch();
    expect(r.json?.hookSpecificOutput.hookEventName).toBe("PostToolBatch");
    expect(r.json?.hookSpecificOutput.additionalContext).toContain("85% of this task's budget");
    expect(batch().stdout).toBe("");
  });

  it("stops on a plan window at stopAtPct with the batch shape", () => {
    prompt("go");
    snap(96);
    const r = batch();
    expect(r.json?.continue).toBe(false);
    expect(r.json?.decision).toBe("block");
    expect(r.json?.reason).toContain("5-hour plan window at 96%");
    expect(task()?.outcome).toBe("stopped-plan");
  });
});

describe("engine-core purity", () => {
  it("step returns effects with the <HANDOFF> placeholder and does not mutate its input", () => {
    const state = {
      sessionId: SID,
      cwd: "/p",
      taskSeq: 0,
      loop: { calls: [], failures: {} },
      planGuard: { off: false },
    };
    const env = { config: DEFAULT_CONFIG, spendUsd: 0, tokens: ZERO, estimated: false, now: clock };
    const a = step(state, { ...base(), hook_event_name: "UserPromptSubmit", prompt: "x" }, env);
    const b = step(
      a.state,
      { ...base(), hook_event_name: "PreToolUse", tool_name: "Bash" },
      { ...env, spendUsd: 3 },
    );
    expect(JSON.stringify(b.output)).toContain("<HANDOFF>");
    expect(b.effects[0]).toMatchObject({ kind: "handoff", reason: "budget" });
    expect(a.state.task?.outcome).toBeUndefined();
    expect(state.taskSeq).toBe(0);
  });
});

function readdirCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}
