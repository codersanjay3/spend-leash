import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHookFiles, copyHookFiles } from "../src/cmd-init.js";
import { cmdUninstall } from "../src/cmd-uninstall.js";
import { makeCtx } from "../src/paths.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let root: string;
let home: string;
let leash: string;
let proj: string;

const run = (args: string[], extraEnv: Record<string, string> = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: proj,
    input: "",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SPEND_LEASH_HOME: leash,
      NO_COLOR: "1",
      ...extraEnv,
    },
  });
const userSettings = () => join(home, ".claude", "settings.json");
const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const rd = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sl-cmd-"));
  home = join(root, "home");
  leash = join(home, ".spend-leash");
  proj = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("init", () => {
  it("non-TTY without --yes exits 2 and changes nothing", () => {
    const r = run(["init"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Run with --yes to apply without a prompt.");
    expect(existsSync(userSettings())).toBe(false);
    expect(existsSync(join(leash, "hook.mjs"))).toBe(false);
  });

  it("--yes installs hooks, copies files, writes config, prints guidance", () => {
    const r = run(["init", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("9 hooks");
    expect(r.stdout).toContain("add a status line");
    expect(r.stdout).toContain("Done. Every prompt now has a $2.00 budget (warn at 80%).");
    expect(r.stdout).toContain(".spend-leash/");
    expect(r.stdout).toContain("npx spend-leash uninstall");
    expect(r.stdout).toContain("#budget $5");
    expect(existsSync(join(leash, "hook.mjs"))).toBe(true);
    expect(existsSync(join(leash, "statusline.mjs"))).toBe(true);
    expect(JSON.parse(rd(join(leash, "config.json"))).task.usd).toBe(2);
    expect(Object.keys(JSON.parse(rd(userSettings())).hooks)).toHaveLength(9);
  });

  it("wraps an existing status line", () => {
    put(userSettings(), JSON.stringify({ statusLine: { type: "command", command: "echo hi" } }));
    const r = run(["init", "--yes"]);
    expect(r.stdout).toContain("wrap your existing status line");
  });

  it("re-running refreshes the hook files", () => {
    run(["init", "--yes"]);
    writeFileSync(join(leash, "hook.mjs"), "stale");
    const r = run(["init", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already installed; hook files refreshed");
    expect(rd(join(leash, "hook.mjs"))).not.toBe("stale");
  });

  it("--budget 10% writes task.planPct and keeps other config keys", () => {
    put(join(leash, "config.json"), JSON.stringify({ failClosed: true, task: { usd: 7 } }));
    const r = run(["init", "--yes", "--budget", "10%"]);
    expect(r.status).toBe(0);
    const cfg = JSON.parse(rd(join(leash, "config.json")));
    expect(cfg.task.planPct).toBe(10);
    expect(cfg.task.usd).toBe(7);
    expect(cfg.failClosed).toBe(true);
    expect(r.stdout).toContain("Pro/Max/Ultra");
  });

  it.each([
    ["2", 2],
    ["$2.5", 2.5],
    ["2.50", 2.5],
  ])("--budget %s sets task.usd", (arg, want) => {
    expect(run(["init", "--yes", "--budget", arg]).status).toBe(0);
    expect(JSON.parse(rd(join(leash, "config.json"))).task.usd).toBe(want);
  });

  it.each(["abc", "0", "-1", "150%", ""])("--budget %j is rejected with exit 2", (arg) => {
    const r = run(["init", "--yes", "--budget", arg]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--budget");
    expect(existsSync(userSettings())).toBe(false);
  });

  it("rejects a bad --scope with exit 2", () => {
    expect(run(["init", "--yes", "--scope", "galaxy"]).status).toBe(2);
  });

  it("refusal from install exits 1 with a prefixed message", () => {
    put(userSettings(), "{ not json");
    const r = run(["init", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^spend-leash: /);
    expect(r.stderr).not.toContain("spend-leash: spend-leash:");
    expect(rd(userSettings())).toBe("{ not json");
  });
});

describe("init safety", () => {
  it("--budget with an invalid config.json exits 1 before changing settings", () => {
    put(join(leash, "config.json"), "{ nope");
    const r = run(["init", "--yes", "--budget", "5"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `spend-leash: ${join(leash, "config.json")} is not valid JSON; fix or delete it, then re-run`,
    );
    expect(r.stdout).not.toContain("Done.");
    expect(existsSync(userSettings())).toBe(false);
    expect(rd(join(leash, "config.json"))).toBe("{ nope");
  });

  it("invalid config.json without --budget installs and prints the note once", () => {
    put(join(leash, "config.json"), "{ nope");
    const r = run(["init", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout.match(/not valid JSON/g)).toHaveLength(1);
  });

  it("missing hook files fail fast with a clear error", () => {
    const empty = join(root, "emptydist");
    mkdirSync(empty);
    expect(() => checkHookFiles(empty)).toThrow(/hook\.mjs not found/);
    expect(() => copyHookFiles(join(root, "lh"), empty)).toThrow(/not found/);
    expect(existsSync(join(root, "lh"))).toBe(false);
  });
});

describe("uninstall", () => {
  it("answering no changes nothing and exits 1", async () => {
    run(["init", "--yes"]);
    const before = rd(userSettings());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await cmdUninstall([], {
        ctx: makeCtx({ HOME: home, SPEND_LEASH_HOME: leash }),
        cwd: proj,
        ask: async () => false,
      });
      expect(code).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(rd(userSettings())).toBe(before);
    expect(existsSync(join(leash, "hook.mjs"))).toBe(true);
  });

  it("a hook file that cannot be removed is a note, not a failure", () => {
    run(["init", "--yes"]);
    rmSync(join(leash, "hook.mjs"));
    mkdirSync(join(leash, "hook.mjs", "sub"), { recursive: true });
    const r = run(["uninstall", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("note: could not remove");
    expect(r.stdout).toContain("delete it by hand");
    expect(existsSync(userSettings())).toBe(false);
  });

  it("nothing installed: exit 0", () => {
    const r = run(["uninstall", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing to uninstall.");
  });

  it("round trip leaves settings byte-identical and keeps data", () => {
    const original =
      '{\n  "theme": "dark",\n  "statusLine": { "type": "command", "command": "echo hi" }\n}\n';
    put(userSettings(), original);
    run(["init", "--yes"]);
    expect(rd(userSettings())).not.toBe(original);
    writeFileSync(join(leash, "tasks.jsonl"), "");
    const r = run(["uninstall"]);
    expect(r.status).toBe(2); // non-TTY without --yes
    const u = run(["uninstall", "--yes"]);
    expect(u.status).toBe(0);
    expect(rd(userSettings())).toBe(original);
    expect(existsSync(join(leash, "hook.mjs"))).toBe(false);
    expect(existsSync(join(leash, "statusline.mjs"))).toBe(false);
    expect(existsSync(join(leash, "tasks.jsonl"))).toBe(true);
    expect(existsSync(join(leash, "config.json"))).toBe(true);
    expect(u.stdout).toContain(leash);
  });

  it("round trip with no prior settings file leaves none", () => {
    run(["init", "--yes"]);
    run(["uninstall", "--yes"]);
    expect(existsSync(userSettings())).toBe(false);
  });
});

const task = (over: Record<string, unknown> = {}) => ({
  id: "abcd1234-1",
  startedAt: "2026-11-15T10:00:00.000Z",
  prompt: "refactor the parser",
  limitUsd: 2,
  limitPlanPct: null,
  baseUsd: 0.5,
  baseTokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  basePlanPct: null,
  warned: false,
  ...over,
});

function seedSession(id: string, state: Record<string, unknown>, snap?: Record<string, unknown>) {
  const dir = join(leash, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      sessionId: id,
      cwd: proj,
      taskSeq: 1,
      loop: { calls: [], failures: {} },
      planGuard: { off: false },
      ...state,
    }),
  );
  if (snap) writeFileSync(join(dir, `${id}.statusline.json`), JSON.stringify(snap));
}

describe("status", () => {
  it("not installed", () => {
    const r = run(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("spend-leash is not installed. Run: npx spend-leash init");
  });

  it("shows session spend, plan % and outcome from state only", () => {
    run(["init", "--yes"]);
    // 1,000,000 output tokens on sonnet-4-5 = $15; minus baseUsd 0.5
    const spend = {
      files: {
        "/t.jsonl": {
          offset: 0,
          partial: "",
          ids: [],
          byModel: {
            "claude-sonnet-4-5": {
              input: 0,
              output: 1_000_000,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
            },
          },
        },
      },
    };
    seedSession(
      "sess-aaaa",
      { spend, task: task({ outcome: "stopped-budget" }) },
      { at: new Date(Date.now() - 120_000).toISOString(), fiveHourPct: 42 },
    );
    const r = run(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("refactor the parser  $14.50 / $2.00");
    expect(r.stdout).toMatch(/5h 42% \(2m ago\)/);
    expect(r.stdout).toContain("stopped-budget");
    expect(r.stdout).toContain("plan %: available");
  });

  it("a stale snapshot still shows the % but plan data is unavailable", () => {
    run(["init", "--yes"]);
    seedSession(
      "sess-stale",
      { task: task() },
      { at: new Date(Date.now() - 20 * 60_000).toISOString(), fiveHourPct: 42 },
    );
    const r = run(["status"]);
    expect(r.stdout).toMatch(/5h 42% \(20m ago\)/);
    expect(r.stdout).toContain("plan %: unavailable");
  });

  it("omits missing pieces, skips sessions older than 24h, caps at 10, newest first", () => {
    run(["init", "--yes"]);
    for (let i = 0; i < 12; i++) {
      seedSession(`s${String(i).padStart(2, "0")}`, { task: task({ prompt: `prompt ${i}` }) });
      const t = (Date.now() - i * 60_000) / 1000;
      utimesSync(join(leash, "sessions", `s${String(i).padStart(2, "0")}.json`), t, t);
    }
    seedSession("old", { task: task({ prompt: "ancient" }) });
    const old = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(join(leash, "sessions", "old.json"), old, old);
    const r = run(["status"]);
    expect(r.stdout).not.toContain("ancient");
    expect(r.stdout).not.toContain("prompt 10");
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("prompt"));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("prompt 0");
    expect(lines[0]).not.toContain("5h");
    expect(r.stdout).toContain("plan %: unavailable — needs a Pro/Max/Ultra status line");
  });
});

const L = (o: Record<string, unknown>) =>
  JSON.stringify({
    ts: "2026-11-15T10:00:00.000Z",
    sessionId: "s",
    taskId: "t1",
    cwd: "/p",
    prompt: "p",
    usd: 1,
    tokens: {},
    planPctDelta: null,
    outcome: "completed",
    reason: "",
    ...o,
  });
const ledger = (...lines: string[]) => {
  mkdirSync(leash, { recursive: true });
  writeFileSync(join(leash, "tasks.jsonl"), `${lines.join("\n")}\n`);
};

describe("report", () => {
  it("--json on an empty ledger", () => {
    const r = run(["report", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"tasks":[],"totals":{"usd":0,"tasks":0}}');
  });

  it("dedupes by taskId (last wins), skips bad lines, newest first, totals", () => {
    ledger(
      L({ taskId: "a", ts: "2026-11-10T10:00:00.000Z", usd: 1, outcome: "stopped-budget" }),
      "garbage{",
      L({ taskId: "b", ts: "2026-11-12T10:00:00.000Z", usd: 0.333, prompt: "second" }),
      L({
        taskId: "a",
        ts: "2026-11-10T10:05:00.000Z",
        usd: 1.5,
        outcome: "completed",
        prompt: "first",
      }),
    );
    const j = JSON.parse(run(["report", "--json"]).stdout);
    expect(j.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["b", "a"]);
    expect(j.tasks[1].usd).toBe(1.5);
    expect(j.totals).toEqual({ usd: 1.83, tasks: 2 });
    const t = run(["report"]);
    expect(t.stdout).toContain("when");
    expect(t.stdout).toContain("outcome");
    expect(t.stdout).toContain("2 tasks · $1.83");
    expect(t.stdout.indexOf("second")).toBeLessThan(t.stdout.indexOf("first"));
  });

  it("-n limits rows and totals", () => {
    ledger(
      L({ taskId: "a", ts: "2026-11-10T10:00:00.000Z", usd: 1 }),
      L({ taskId: "b", ts: "2026-11-11T10:00:00.000Z", usd: 2 }),
      L({ taskId: "c", ts: "2026-11-12T10:00:00.000Z", usd: 4 }),
    );
    const j = JSON.parse(run(["report", "--json", "-n", "2"]).stdout);
    expect(j.totals).toEqual({ usd: 6, tasks: 2 });
    expect(run(["report", "-n", "0"]).status).toBe(2);
  });

  it("pluralizes the summary for a single task", () => {
    ledger(L({ taskId: "solo", usd: 1 }));
    expect(run(["report"]).stdout).toContain("1 task · $1.00");
  });

  it("--today keeps only local-today tasks", () => {
    ledger(
      L({ taskId: "old", ts: "2020-01-01T12:00:00.000Z" }),
      L({ taskId: "now", ts: new Date().toISOString() }),
    );
    const j = JSON.parse(run(["report", "--json", "--today"]).stdout);
    expect(j.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["now"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable ledger exits 1 instead of looking empty",
    () => {
      ledger(L({}));
      chmodSync(join(leash, "tasks.jsonl"), 0o000);
      try {
        const r = run(["report"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`spend-leash: cannot read ${join(leash, "tasks.jsonl")}`);
        expect(r.stdout).not.toContain("No tasks recorded");
      } finally {
        chmodSync(join(leash, "tasks.jsonl"), 0o600);
      }
    },
  );

  it("reads a ledger with a line spanning chunk boundaries", () => {
    ledger(
      ...Array.from({ length: 3000 }, (_, i) => L({ taskId: `t${i}`, prompt: "é".repeat(40) })),
    );
    expect(JSON.parse(run(["report", "--json", "-n", "5000"]).stdout).totals.tasks).toBe(3000);
  });

  it("truncates the prompt to 50 chars; empty ledger prints a hint", () => {
    expect(run(["report"]).stdout).toContain("No tasks recorded yet.");
    ledger(L({ prompt: "x".repeat(120) }));
    const out = run(["report"]).stdout;
    expect(out).toContain(`${"x".repeat(49)}…`);
    expect(out).not.toContain("x".repeat(50));
  });
});
