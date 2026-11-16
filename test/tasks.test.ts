import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Directive } from "../src/directives.js";
import { type Ctx, sessionDir } from "../src/paths.js";
import { ZERO } from "../src/pricing.js";
import { readSession, readSnapshot, withSessionLock, writeSession } from "../src/state.js";
import { isFresh, type SessionState, type Snapshot, startTask, taskSpend } from "../src/tasks.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const SID = "abcdef12-3456-7890";
const config = DEFAULT_CONFIG;
const tokens = { ...ZERO, input: 100 };

function fresh(): SessionState {
  return {
    sessionId: SID,
    cwd: "/w",
    loop: { calls: [], failures: {} },
    planGuard: { off: false },
    taskSeq: 0,
  };
}

function start(
  s: SessionState,
  directive?: Directive,
  extra: { spendUsd?: number; snapshot?: Snapshot; prompt?: string } = {},
): SessionState {
  return startTask(s, {
    prompt: extra.prompt ?? "do the thing",
    ...(directive ? { directive } : {}),
    config,
    spendUsd: extra.spendUsd ?? 1,
    tokens,
    ...(extra.snapshot ? { snapshot: extra.snapshot } : {}),
    now: NOW,
  });
}

function stopped(
  outcome: "stopped-budget" | "stopped-plan" | "stopped-loop" | "completed",
  over: Partial<NonNullable<SessionState["task"]>> = {},
): SessionState {
  const s = start(fresh(), { kind: "set", usd: 3, planPct: 20 }, { spendUsd: 1 });
  const t = s.task as NonNullable<SessionState["task"]>;
  return {
    ...s,
    loop: { calls: ["a", "b"], failures: { a: 2 } },
    task: { ...t, outcome, reason: "r", warned: true, ...over },
  };
}

const snap = (pct: number, at = NOW): Snapshot => ({ at: at.toISOString(), fiveHourPct: pct });

describe("startTask", () => {
  it("starts a new task with config defaults and a baseline", () => {
    const s = start(fresh(), undefined, { spendUsd: 1.5, prompt: "x".repeat(300) });
    const t = s.task;
    expect(t).toMatchObject({
      id: "abcdef12-1",
      startedAt: NOW.toISOString(),
      limitUsd: 2,
      limitPlanPct: null,
      baseUsd: 1.5,
      baseTokens: tokens,
      basePlanPct: null,
      warned: false,
    });
    expect(t?.prompt).toHaveLength(200);
    expect(t?.outcome).toBeUndefined();
    expect(s.taskSeq).toBe(1);
  });

  it("increments the task counter per session", () => {
    const a = start(fresh());
    const b = start(a);
    expect(b.task?.id).toBe("abcdef12-2");
  });

  it("takes the plan baseline from a fresh snapshot only", () => {
    expect(start(fresh(), undefined, { snapshot: snap(30) }).task?.basePlanPct).toBe(30);
    const old = snap(30, new Date(NOW.getTime() - 11 * 60_000));
    expect(start(fresh(), undefined, { snapshot: old }).task?.basePlanPct).toBeNull();
  });

  it("does not mutate its input", () => {
    const s = stopped("stopped-budget");
    const copy = JSON.parse(JSON.stringify(s));
    start(s, { kind: "add", usd: 2 });
    expect(s).toEqual(copy);
  });

  it("set overrides limits on a new task; unspecified limit keeps the default", () => {
    expect(start(fresh(), { kind: "set", usd: 5, planPct: 20 }).task).toMatchObject({
      limitUsd: 5,
      limitPlanPct: 20,
    });
    expect(start(fresh(), { kind: "set", planPct: 15 }).task).toMatchObject({
      limitUsd: 2,
      limitPlanPct: 15,
    });
  });

  it("off on a new task sets both limits null", () => {
    expect(start(stopped("completed"), { kind: "off" }).task).toMatchObject({
      id: "abcdef12-2",
      limitUsd: null,
      limitPlanPct: null,
      baseUsd: 1,
    });
    expect(start(fresh(), { kind: "off" }).task).toMatchObject({
      limitUsd: null,
      limitPlanPct: null,
    });
  });

  it("off after stopped-budget continues that task with limits null", () => {
    const s = start(stopped("stopped-budget", { baseUsd: 0.25 }), { kind: "off" }, { spendUsd: 9 });
    expect(s.task).toMatchObject({
      id: "abcdef12-1",
      baseUsd: 0.25,
      limitUsd: null,
      limitPlanPct: null,
      warned: false,
    });
    expect(s.task?.outcome).toBeUndefined();
    expect(s.task?.reason).toBeUndefined();
  });

  it("add with no previous task starts a new task with default + amount", () => {
    expect(start(fresh(), { kind: "add", usd: 3 }).task).toMatchObject({
      id: "abcdef12-1",
      limitUsd: 5,
    });
    const noDefault = startTask(fresh(), {
      prompt: "p",
      directive: { kind: "add", usd: 3 },
      config: { ...config, task: { ...config.task, usd: null } },
      spendUsd: 0,
      tokens,
      now: NOW,
    });
    expect(noDefault.task?.limitUsd).toBe(3);
  });

  it("add after a completed task is treated like no previous task", () => {
    const s = start(
      stopped("completed", { baseUsd: 0.1 }),
      { kind: "add", usd: 3 },
      { spendUsd: 4 },
    );
    expect(s.task).toMatchObject({ id: "abcdef12-2", limitUsd: 5, baseUsd: 4 });
  });

  it("add after a stop keeps the task, raises limitUsd and clears outcome/warned", () => {
    for (const outcome of ["stopped-budget", "stopped-plan", "stopped-loop"] as const) {
      const s = start(
        stopped(outcome, { baseUsd: 0.25 }),
        { kind: "add", usd: 2 },
        { spendUsd: 9 },
      );
      expect(s.task, outcome).toMatchObject({
        id: "abcdef12-1",
        baseUsd: 0.25,
        limitUsd: 5,
        limitPlanPct: 20,
        warned: false,
      });
      expect(s.task?.outcome).toBeUndefined();
      expect(s.task?.reason).toBeUndefined();
      expect(s.taskSeq).toBe(1);
    }
  });

  it("strict: a plain prompt after stopped-budget keeps the same task, baseline and limits", () => {
    const prev = stopped("stopped-budget", { baseUsd: 0.25 });
    const s = start(prev, undefined, { spendUsd: 9, prompt: "keep going" });
    expect(s.task).toEqual(prev.task);
    expect(s.taskSeq).toBe(1);
  });

  it("strict: plan-off after stopped-budget also keeps the task, and sets planGuard.off", () => {
    const prev = stopped("stopped-budget");
    const s = start(prev, { kind: "plan-off" });
    expect(s.task).toEqual(prev.task);
    expect(s.planGuard.off).toBe(true);
  });

  it("set after stopped-budget keeps the baseline, replaces limits and clears outcome", () => {
    const s = start(stopped("stopped-budget", { baseUsd: 0.25 }), { kind: "set", usd: 10 });
    expect(s.task).toMatchObject({
      id: "abcdef12-1",
      baseUsd: 0.25,
      limitUsd: 10,
      limitPlanPct: 20,
      warned: false,
    });
    expect(s.task?.outcome).toBeUndefined();
    expect(s.task?.reason).toBeUndefined();
  });

  it("new always starts fresh, even right after stopped-budget", () => {
    const s = start(stopped("stopped-budget", { baseUsd: 0.25 }), { kind: "new" }, { spendUsd: 9 });
    expect(s.task).toMatchObject({
      id: "abcdef12-2",
      baseUsd: 9,
      limitUsd: 2,
      limitPlanPct: null,
      warned: false,
    });
    expect(s.loop).toEqual({ calls: [], failures: {} });
  });

  it("after stopped-loop a plain prompt keeps the task and clears loop history", () => {
    const prev = stopped("stopped-loop", { baseUsd: 0.25 });
    const s = start(prev, undefined, { spendUsd: 9 });
    expect(s.task).toMatchObject({ id: "abcdef12-1", baseUsd: 0.25, limitUsd: 3 });
    expect(s.task?.outcome).toBeUndefined();
    expect(s.loop).toEqual({ calls: [], failures: {} });
  });

  it("after stopped-loop set/off/add continue the same task and clear loop history", () => {
    const dirs: Directive[] = [{ kind: "set", usd: 9 }, { kind: "off" }, { kind: "add", usd: 2 }];
    for (const d of dirs) {
      const s = start(stopped("stopped-loop", { baseUsd: 0.25 }), d, { spendUsd: 9 });
      expect(s.task, d.kind).toMatchObject({ id: "abcdef12-1", baseUsd: 0.25, warned: false });
      expect(s.task?.outcome).toBeUndefined();
      expect(s.loop, d.kind).toEqual({ calls: [], failures: {} });
      expect(s.taskSeq).toBe(1);
    }
  });

  it("set/off after stopped-plan start a new task", () => {
    for (const d of [{ kind: "set", usd: 9 }, { kind: "off" }] as Directive[]) {
      expect(start(stopped("stopped-plan"), d).task?.id, d.kind).toBe("abcdef12-2");
    }
  });

  it("plan-off sets planGuard.off and otherwise behaves like no directive", () => {
    const s = start(stopped("completed"), { kind: "plan-off" });
    expect(s.planGuard.off).toBe(true);
    expect(s.task).toMatchObject({ id: "abcdef12-2", limitUsd: 2 });
  });

  it("a plain prompt after a completed task starts a new task", () => {
    const s = start(stopped("completed"), undefined, { spendUsd: 7 });
    expect(s.task).toMatchObject({ id: "abcdef12-2", baseUsd: 7, limitUsd: 2 });
  });

  it("a plain prompt after stopped-plan starts a new task", () => {
    const s = start(stopped("stopped-plan"), undefined, { spendUsd: 7 });
    expect(s.task).toMatchObject({ id: "abcdef12-2", baseUsd: 7 });
  });
});

describe("taskSpend and isFresh", () => {
  it("subtracts the baseline for usd", () => {
    const s = start(fresh(), undefined, { spendUsd: 1 });
    expect(taskSpend(s, 1.75, undefined, NOW)).toEqual({ usd: 0.75, planPct: null });
  });

  it("re-baselines on the first fresh snapshot, then reports the delta", () => {
    const s = start(fresh());
    expect(s.task?.basePlanPct).toBeNull();
    expect(taskSpend(s, 1, snap(40), NOW)).toEqual({ usd: 0, planPct: 0 });
    expect(s.task?.basePlanPct).toBe(40);
    expect(taskSpend(s, 1, snap(52), NOW).planPct).toBe(12);
  });

  it("a 5-hour window reset mid-task re-baselines to 0 instead of going negative", () => {
    const s = start(fresh(), undefined, { snapshot: snap(60) });
    expect(taskSpend(s, 1, snap(5), NOW)).toEqual({ usd: 0, planPct: 5 });
    expect(s.task?.basePlanPct).toBe(0);
    expect(taskSpend(s, 1, snap(8), NOW).planPct).toBe(8);
  });

  it("stale snapshot (11 min) gives planPct null and does not baseline", () => {
    const s = start(fresh(), undefined, { snapshot: snap(10) });
    const old = snap(50, new Date(NOW.getTime() - 11 * 60_000));
    expect(taskSpend(s, 1, old, NOW).planPct).toBeNull();
    const s2 = start(fresh());
    expect(taskSpend(s2, 1, old, NOW).planPct).toBeNull();
    expect(s2.task?.basePlanPct).toBeNull();
  });

  it("isFresh is true under 10 minutes and false at or beyond", () => {
    expect(isFresh(snap(1, new Date(NOW.getTime() - 9 * 60_000)), NOW)).toBe(true);
    expect(isFresh(snap(1, new Date(NOW.getTime() - 10 * 60_000)), NOW)).toBe(false);
    expect(isFresh({ at: "garbage" }, NOW)).toBe(false);
  });
});

describe("session state I/O", () => {
  let dir: string;
  let ctx: Ctx;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sl-state-"));
    ctx = { home: dir, leashHome: join(dir, "leash"), now: () => NOW };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns a default state for missing, garbage and wrong-shape files", () => {
    const want = { ...fresh(), sessionId: "s1", cwd: "" };
    expect(readSession(ctx, "s1")).toEqual(want);
    mkdirSync(sessionDir(ctx), { recursive: true });
    writeFileSync(join(sessionDir(ctx), "s1.json"), "{not json");
    expect(readSession(ctx, "s1")).toEqual(want);
    writeFileSync(join(sessionDir(ctx), "s1.json"), JSON.stringify({ sessionId: 5, loop: 1 }));
    expect(readSession(ctx, "s1")).toEqual(want);
    writeFileSync(join(sessionDir(ctx), "s1.json"), "[]");
    expect(readSession(ctx, "s1")).toEqual(want);
  });

  it("drops only the invalid sub-object of a structurally bad session file", () => {
    const good = start({ ...fresh(), sessionId: "s8" }, { kind: "set", usd: 4 });
    const put = (patch: object) =>
      writeFileSync(join(sessionDir(ctx), "s8.json"), JSON.stringify({ ...good, ...patch }));
    const t = good.task as object;
    put({ task: { ...t, limitUsd: "5" } });
    expect(readSession(ctx, "s8").task).toBeUndefined();
    expect(readSession(ctx, "s8").taskSeq).toBe(1);
    put({ task: { ...t, baseTokens: undefined } });
    expect(readSession(ctx, "s8").task).toBeUndefined();
    put({ loop: { calls: "x", failures: {} } });
    expect(readSession(ctx, "s8").loop).toEqual({ calls: [], failures: {} });
    expect(readSession(ctx, "s8").task).toEqual(good.task);
    put({ loop: { calls: [1, 2], failures: {} } });
    expect(readSession(ctx, "s8").loop).toEqual({ calls: [], failures: {} });
    put({ loop: { calls: [], failures: { a: "x" } } });
    expect(readSession(ctx, "s8").loop).toEqual({ calls: [], failures: {} });
    put({ taskSeq: "x" });
    expect(readSession(ctx, "s8").taskSeq).toBe(0);
    put({ taskSeq: -1 });
    expect(readSession(ctx, "s8").taskSeq).toBe(0);
    put({ spend: {} });
    expect(readSession(ctx, "s8").spend).toBeUndefined();
    put({ planGuard: { off: "no" } });
    expect(readSession(ctx, "s8").planGuard).toEqual({ off: false });
    put({ spend: { files: {} } });
    expect(readSession(ctx, "s8")).toEqual({ ...good, spend: { files: {} } });
  });

  it("round-trips, atomically, with private modes", () => {
    const s = start({ ...fresh(), sessionId: "s2" }, { kind: "set", usd: 4 });
    const own: Ctx = { ...ctx, leashHome: join(dir, "private") };
    writeSession(own, s);
    expect(readSession(own, "s2")).toEqual(s);
    expect(readdirSync(sessionDir(own))).toEqual(["s2.json"]);
    if (process.platform !== "win32") {
      expect(statSync(join(sessionDir(own), "s2.json")).mode & 0o777).toBe(0o600);
      expect(statSync(sessionDir(own)).mode & 0o777).toBe(0o700);
    }
  });

  it("session ids cannot escape the sessions dir", () => {
    writeSession(ctx, { ...fresh(), sessionId: "../../evil" });
    expect(readSession(ctx, "../../evil").sessionId).toBe("../../evil");
    expect(() => statSync(join(dir, "evil.json"))).toThrow();
  });

  it("readSnapshot reads the statusline file or returns undefined", () => {
    expect(readSnapshot(ctx, "nosnap")).toBeUndefined();
    writeFileSync(
      join(sessionDir(ctx), "s3.statusline.json"),
      JSON.stringify({ at: NOW.toISOString(), fiveHourPct: 12 }),
    );
    expect(readSnapshot(ctx, "s3")).toEqual({ at: NOW.toISOString(), fiveHourPct: 12 });
    writeFileSync(
      join(sessionDir(ctx), "s9.statusline.json"),
      JSON.stringify({ at: "t", fiveHourPct: "9", costUsd: 1, model: 5 }),
    );
    expect(readSnapshot(ctx, "s9")).toEqual({ at: "t", costUsd: 1 });
    writeFileSync(join(sessionDir(ctx), "s4.statusline.json"), "oops");
    expect(readSnapshot(ctx, "s4")).toBeUndefined();
  });

  it("withSessionLock returns fn's value, releases, and removes a stale lock", () => {
    expect(withSessionLock(ctx, "s5", () => 42)).toBe(42);
    expect(() => statSync(join(sessionDir(ctx), "s5.lock"))).toThrow();
    const lock = join(sessionDir(ctx), "s6.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    expect(withSessionLock(ctx, "s6", () => "ok")).toBe("ok");
  });

  it("withSessionLock runs fn anyway after the 200 ms wait budget", () => {
    mkdirSync(join(sessionDir(ctx), "s7.lock"));
    const t0 = Date.now();
    expect(withSessionLock(ctx, "s7", () => "ran")).toBe("ran");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    // a lock we did not take is left alone
    expect(statSync(join(sessionDir(ctx), "s7.lock")).isDirectory()).toBe(true);
  });

  it("20 concurrent processes incrementing a counter under the lock lose no update", async () => {
    // Bundle state.ts with esbuild (already a devDependency via tsup): works on any Node >= 20.
    const work = mkdtempSync(join(tmpdir(), "sl-lock-"));
    try {
      const bundle = join(work, "state.mjs");
      buildSync({
        entryPoints: [join(__dirname, "../src/state.ts")],
        outfile: bundle,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      const child = join(work, "child.mjs");
      writeFileSync(
        child,
        `import { readSession, writeSession, withSessionLock } from ${JSON.stringify(pathToFileURL(bundle).href)};
const ctx = { home: ${JSON.stringify(work)}, leashHome: ${JSON.stringify(work)}, now: () => new Date() };
withSessionLock(ctx, "ctr", () => {
  const s = readSession(ctx, "ctr");
  s.loop.failures.counter = (s.loop.failures.counter ?? 0) + 1;
  writeSession(ctx, s);
});
`,
      );
      const run = () =>
        new Promise<number>((resolve) => {
          const p = spawn(process.execPath, [child], { stdio: "ignore" });
          p.on("close", (c) => resolve(c ?? 1));
        });
      const codes = await Promise.all(Array.from({ length: 20 }, run));
      expect(codes.every((c) => c === 0)).toBe(true);
      const raw = readFileSync(join(work, "sessions", "ctr.json"), "utf8");
      expect(JSON.parse(raw).loop.failures.counter).toBe(20);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
