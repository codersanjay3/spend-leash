import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { loadConfig } from "../src/config-load.js";
import type { Ctx } from "../src/paths.js";

describe("config", () => {
  it("has the spec defaults", () => {
    expect(DEFAULT_CONFIG).toEqual({
      task: { usd: 2, planPct: null, warnAt: 0.8 },
      plan: { stopAtPct: 95 },
      loop: { warnAt: 3, stopAt: 5, window: 12, ignoreTools: [] },
      handoff: { dir: ".spend-leash/handoffs" },
      failClosed: false,
    });
    expect(mergeConfig(undefined, undefined)).toEqual({ config: DEFAULT_CONFIG, notes: [] });
  });

  it("does not mutate DEFAULT_CONFIG", () => {
    const { config } = mergeConfig({ loop: { ignoreTools: ["X"] }, task: { usd: 9 } }, undefined);
    config.loop.ignoreTools.push("Y");
    expect(DEFAULT_CONFIG.loop.ignoreTools).toEqual([]);
    expect(DEFAULT_CONFIG.task.usd).toBe(2);
  });

  it("user file overrides values", () => {
    const { config, notes } = mergeConfig(
      {
        task: { usd: 10, planPct: 30, warnAt: 0.5 },
        plan: { stopAtPct: 90 },
        loop: { warnAt: 2, stopAt: 4, window: 8, ignoreTools: ["TodoWrite"] },
        handoff: { dir: "h" },
        failClosed: true,
        prices: { foo: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 } },
      },
      undefined,
    );
    expect(notes).toEqual([]);
    expect(config.task).toEqual({ usd: 10, planPct: 30, warnAt: 0.5 });
    expect(config.plan.stopAtPct).toBe(90);
    expect(config.loop).toEqual({ warnAt: 2, stopAt: 4, window: 8, ignoreTools: ["TodoWrite"] });
    expect(config.handoff.dir).toBe("h");
    expect(config.failClosed).toBe(true);
    expect(config.prices?.foo?.cacheRead).toBe(5);
    expect(mergeConfig({ task: { usd: null } }, undefined).config.task.usd).toBeNull();
  });

  it("drops invalid user values with a note and keeps defaults", () => {
    const { config, notes } = mergeConfig(
      {
        task: { usd: -1, warnAt: 1.5, planPct: 150 },
        plan: { stopAtPct: 0 },
        loop: { window: 1, warnAt: "x" },
        failClosed: "yes",
        bogus: 1,
        prices: {
          "": { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 },
          bad: { input: -1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 },
          short: { input: 1 },
        },
      },
      undefined,
    );
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(notes.length).toBeGreaterThanOrEqual(10);
    expect(notes.every((n) => n.startsWith("config.json: "))).toBe(true);
  });

  it("drops NaN-like values and stopAt < warnAt", () => {
    const { config, notes } = mergeConfig(
      { task: { usd: Number.NaN }, loop: { warnAt: 4, stopAt: 2 } },
      undefined,
    );
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(notes.some((n) => n.includes("stopAt"))).toBe(true);
  });

  it("project tightens: lower usd applies, higher is ignored with a note", () => {
    expect(mergeConfig(undefined, { task: { usd: 1 } }).config.task.usd).toBe(1);
    const r = mergeConfig(undefined, { task: { usd: 50 } });
    expect(r.config.task.usd).toBe(2);
    expect(r.notes).toEqual([
      ".spend-leash.json: task.usd 50 ignored (project config can only tighten limits)",
    ]);
  });

  it("project number tightens a no-limit planPct; null never loosens", () => {
    expect(mergeConfig(undefined, { task: { planPct: 20 } }).config.task.planPct).toBe(20);
    const r = mergeConfig({ task: { usd: null } }, { task: { usd: null } });
    expect(r.config.task.usd).toBeNull();
    expect(r.notes[0]).toContain("ignored");
    expect(mergeConfig(undefined, { task: { usd: null } }).config.task.usd).toBe(2);
  });

  it("project tightens warnAt, stopAtPct, loop thresholds; window tightens when higher", () => {
    const { config } = mergeConfig(undefined, {
      task: { warnAt: 0.5 },
      plan: { stopAtPct: 80 },
      loop: { warnAt: 2, stopAt: 4, window: 20 },
    });
    expect(config.task.warnAt).toBe(0.5);
    expect(config.plan.stopAtPct).toBe(80);
    expect(config.loop).toMatchObject({ warnAt: 2, stopAt: 4, window: 20 });
    const loose = mergeConfig(undefined, {
      plan: { stopAtPct: 99 },
      loop: { window: 5, stopAt: 9 },
    });
    expect(loose.config.plan.stopAtPct).toBe(95);
    expect(loose.config.loop).toMatchObject({ stopAt: 5, window: 12 });
    expect(loose.notes).toHaveLength(3);
  });

  it("project failClosed true applies, false over user true is ignored", () => {
    expect(mergeConfig(undefined, { failClosed: true }).config.failClosed).toBe(true);
    const r = mergeConfig({ failClosed: true }, { failClosed: false });
    expect(r.config.failClosed).toBe(true);
    expect(r.notes[0]).toContain("ignored");
  });

  it("project ignoreTools, handoff.dir, prices and unknown keys are ignored with notes", () => {
    const r = mergeConfig(undefined, {
      loop: { ignoreTools: ["Read"] },
      handoff: { dir: "/etc" },
      prices: { x: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 } },
      nope: 1,
      task: { nope: 1 },
    });
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.notes).toHaveLength(5);
    expect(r.notes.every((n) => n.startsWith(".spend-leash.json: ") && n.includes("ignored"))).toBe(
      true,
    );
  });

  it("tolerates non-object input", () => {
    expect(mergeConfig([], 5).config).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig([], 5).notes).toHaveLength(2);
  });
});

describe("loadConfig", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "sl-cfg-"));
    const leashHome = join(root, "leash");
    const cwd = join(root, "proj");
    mkdirSync(leashHome);
    mkdirSync(cwd);
    const ctx: Ctx = { home: root, leashHome, now: () => new Date() };
    return { ctx, leashHome, cwd };
  }

  it("returns defaults when no files exist", () => {
    const { ctx, cwd } = setup();
    expect(loadConfig(ctx, cwd)).toEqual({ config: DEFAULT_CONFIG, notes: [] });
  });

  it("merges user then project files", () => {
    const { ctx, leashHome, cwd } = setup();
    writeFileSync(join(leashHome, "config.json"), JSON.stringify({ task: { usd: 10 } }));
    writeFileSync(join(cwd, ".spend-leash.json"), JSON.stringify({ task: { usd: 3 } }));
    expect(loadConfig(ctx, cwd).config.task.usd).toBe(3);
  });

  it("malformed JSON gives defaults plus a note, no throw", () => {
    const { ctx, leashHome, cwd } = setup();
    writeFileSync(join(leashHome, "config.json"), "{ nope");
    writeFileSync(join(cwd, ".spend-leash.json"), "[[");
    const r = loadConfig(ctx, cwd);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.notes).toEqual([
      "config.json: not valid JSON, ignored",
      ".spend-leash.json: not valid JSON, ignored",
    ]);
  });
});
