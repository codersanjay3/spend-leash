import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  gitInfo,
  lastTodos,
  markConsumed,
  pendingHandoff,
  readTail,
  recentToolCalls,
  renderHandoff,
  writeHandoff,
} from "../src/handoff.js";
import type { Ctx } from "../src/paths.js";
import { ZERO } from "../src/pricing.js";
import type { Task } from "../src/tasks.js";

const NOW = new Date("2026-11-16T12:34:56Z");
const SID = "sess-1234";
const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let root: string;
let ctx: Ctx;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sl-handoff-"));
  ctx = { home: root, leashHome: join(root, "leash"), now: () => NOW };
  cwd = join(root, "proj");
  mkdirSync(cwd);
});

const task: Task = {
  id: "t1",
  startedAt: NOW.toISOString(),
  prompt: "refactor the parser",
  limitUsd: 2,
  limitPlanPct: null,
  baseUsd: 0,
  baseTokens: ZERO,
  basePlanPct: null,
  warned: true,
};

function render(over: Partial<Parameters<typeof renderHandoff>[0]> = {}) {
  return renderHandoff({
    reason: "budget",
    detail: "spent $2.05 of $2.00",
    task,
    sessionId: SID,
    cwd,
    lastAssistant: "Almost done with the parser.",
    recentCalls: [{ tool: "Bash", args: { command: "npm test" } }],
    now: NOW,
    ...over,
  });
}

function transcript(lines: unknown[]): string {
  const p = join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return p;
}

const use = (name: string, input: unknown, id: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});

describe("renderHandoff", () => {
  it("has every section and the resume hints", () => {
    const md = render({
      todos: ["[pending] write docs"],
      git: { status: " M a.ts", diffStat: " a.ts | 2 +-" },
    });
    expect(md.split("\n")[0]).toBe(
      `<!-- spend-leash handoff cwd=${JSON.stringify(cwd)} session="${SID}" -->`,
    );
    for (const h of [
      "# Handoff",
      "## Task",
      "## Where it stopped",
      "## Recent tool calls",
      "## Changed files",
      "## Next steps",
      "## Resume",
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("spent $2.05 of $2.00");
    expect(md).toContain("refactor the parser");
    expect(md).toContain("Almost done with the parser.");
    expect(md).toContain("[pending] write docs");
    expect(md).toContain(`claude --resume ${SID}`);
    expect(md).toContain("#budget +$2");
    expect(md).toContain("#budget new");
  });

  it("omits Changed files and Next steps when absent", () => {
    const md = render();
    expect(md).not.toContain("## Changed files");
    expect(md).not.toContain("## Next steps");
  });

  it("redacts secrets in args and caps previews, calls and the assistant message", () => {
    const calls = [
      {
        tool: "Bash",
        args: {
          command: "export GH=ghp_abcdefghijklmnopqrstuvwxyz0123 && curl -d password=hunter2",
        },
      },
      { tool: "Bash", args: { command: `echo sk-${"a".repeat(30)}` } },
      { tool: "Read", args: { file_path: "x".repeat(500) } },
      ...Array.from({ length: 12 }, (_, i) => ({ tool: "Grep", args: { pattern: `p${i}` } })),
    ];
    const md = render({ recentCalls: calls, lastAssistant: "z".repeat(5000) });
    expect(md).not.toContain("ghp_abc");
    expect(md).not.toContain("hunter2");
    expect(md).not.toContain("sk-aaaa");
    expect(md).not.toContain("x".repeat(130));
    expect(md).not.toContain("z".repeat(2001));
    expect(md.match(/^- `/gm)?.length ?? 0).toBeLessThanOrEqual(10 + 2); // calls + resume bullets
    expect(md).toContain('"p11"');
    expect(md).not.toContain("ghp_");
  });

  it("fences prompts containing backticks safely", () => {
    const md = render({ task: { ...task, prompt: "run ```x```" } });
    expect(md).toContain("````");
  });
});

describe("redaction and bounds", () => {
  it.each([
    "GITHUB_TOKEN=abc123def",
    "MY_PASSWORD=hunter2",
    "DB_SECRET: foo",
    "export FOO_TOKEN=abc123def",
    "mysql --password hunter2",
    "tool --token abc123def",
    "tool --api-key=abc123def",
    "tool --password=hunter2",
  ])("redacts %s", (s) => {
    const md = render({ recentCalls: [{ tool: "Bash", args: { command: s } }] });
    const secret = s.split(/[=:\s]+/).pop() as string;
    expect(md).not.toContain(secret);
    expect(md).toContain("[REDACTED]");
  });

  it("redacts free text: prompt, assistant message, todos, detail", () => {
    const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const sk = `sk-${"b".repeat(30)}`;
    const md = render({
      task: { ...task, prompt: `use ${gh} and ${sk}` },
      lastAssistant: `I saw ${gh} and ${sk}`,
      todos: [`[pending] rotate ${sk}`],
      detail: `leaked ${gh}`,
    });
    expect(md).not.toContain("ghp_abc");
    expect(md).not.toContain("sk-bbb");
  });

  it("caps Changed files at 50 lines with a remainder line", () => {
    const status = Array.from({ length: 80 }, (_, i) => ` M f${i}.ts`).join("\n");
    const md = render({ git: { status, diffStat: "" } });
    expect(md).toContain("f49.ts");
    expect(md).not.toContain("f50.ts");
    expect(md).toContain("… and 30 more");
  });

  it("omits the resume command for an unsafe session id and renders bad todo status", () => {
    const md = render({ sessionId: "a b; rm -rf" });
    expect(md).not.toContain("claude --resume");
    expect(md).toContain("#budget +$2");
    const p = transcript([
      use("TodoWrite", { todos: [{ content: "x" }, { content: "y", status: 3 }] }, "1"),
    ]);
    expect(lastTodos(p)).toEqual(["[ ] x", "[ ] y"]);
  });

  it("accepts pre-read tail records in both helpers", () => {
    const p = transcript([
      use("TodoWrite", { todos: [{ content: "a", status: "pending" }] }, "1"),
      use("Bash", { command: "ls" }, "2"),
    ]);
    const recs = readTail(p);
    expect(lastTodos(recs)).toEqual(["[pending] a"]);
    expect(recentToolCalls(recs, 1)).toEqual([{ tool: "Bash", args: { command: "ls" } }]);
  });

  it("survives a multibyte char straddling the 2 MB tail boundary", () => {
    const size = 2 * 1024 * 1024;
    const mid = JSON.stringify({ type: "user", message: { content: "é".repeat(size / 2 + 100) } });
    let midBoundary = 0;
    for (let shift = 0; shift < 2; shift++) {
      const command = "k".repeat(shift + 1);
      const tail = JSON.stringify(use("Bash", { command }, "k"));
      const buf = Buffer.from(`${mid}\n${tail}\n`);
      const at = buf.length - size;
      if (((buf[at] as number) & 0xc0) === 0x80) midBoundary++; // boundary splits a 2-byte char
      const p = join(root, `mb${shift}.jsonl`);
      writeFileSync(p, buf);
      expect(recentToolCalls(p, 1)).toEqual([{ tool: "Bash", args: { command } }]);
    }
    expect(midBoundary).toBe(1);
  });
});

describe("writeHandoff", () => {
  it("writes <cwd>/<dir>/<UTC stamp>-<reason>.md with mode 0600 and suffixes duplicates", () => {
    const p = writeHandoff(ctx, cwd, DEFAULT_CONFIG, "hi", NOW, "Budget!");
    expect(p).toBe(join(cwd, ".spend-leash/handoffs/20261116T123456Z-budget.md"));
    expect(readFileSync(p, "utf8")).toBe("hi");
    if (posix) expect(statSync(p).mode & 0o777).toBe(0o600);
    const p2 = writeHandoff(ctx, cwd, DEFAULT_CONFIG, "again", NOW, "budget");
    const p3 = writeHandoff(ctx, cwd, DEFAULT_CONFIG, "again", NOW, "budget");
    expect(p2.endsWith("-budget-2.md")).toBe(true);
    expect(p3.endsWith("-budget-3.md")).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hi");
  });

  it.skipIf(!posix || isRoot)("falls back to <leashHome>/handoffs when cwd is not writable", () => {
    chmodSync(cwd, 0o500);
    try {
      const p = writeHandoff(ctx, cwd, DEFAULT_CONFIG, "hi", NOW, "plan");
      expect(p).toBe(join(ctx.leashHome, "handoffs/20261116T123456Z-plan.md"));
      expect(readFileSync(p, "utf8")).toBe("hi");
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      chmodSync(cwd, 0o700);
    }
  });

  it("falls back when cwd does not exist", () => {
    const p = writeHandoff(ctx, join(root, "gone"), DEFAULT_CONFIG, "x", NOW, "loop");
    expect(p.startsWith(join(ctx.leashHome, "handoffs"))).toBe(true);
  });
});

describe("gitInfo", () => {
  it("is undefined outside a repo", () => {
    expect(gitInfo(cwd)).toBeUndefined();
    expect(gitInfo(join(root, "missing"))).toBeUndefined();
  });

  it("lists a modified file in a repo", () => {
    const g = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" });
    g("init", "-q");
    writeFileSync(join(cwd, "a.txt"), "1\n");
    g("add", ".");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(cwd, "a.txt"), "2\n");
    const info = gitInfo(cwd);
    expect(info?.status).toContain("a.txt");
    expect(info?.diffStat).toContain("a.txt");
  });
});

describe("transcript helpers", () => {
  it("recentToolCalls returns the last n oldest first, deduping repeated ids", () => {
    const p = transcript([
      use("Read", { file_path: "a" }, "1"),
      use("Read", { file_path: "a" }, "1"),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      use("Edit", { file_path: "b" }, "2"),
      use("Bash", { command: "ls" }, "3"),
    ]);
    expect(recentToolCalls(p, 2)).toEqual([
      { tool: "Edit", args: { file_path: "b" } },
      { tool: "Bash", args: { command: "ls" } },
    ]);
    expect(recentToolCalls(p)).toHaveLength(3);
  });

  it("tolerates a missing file, garbage and a half-written last line", () => {
    expect(recentToolCalls(join(root, "none.jsonl"))).toEqual([]);
    expect(lastTodos(join(root, "none.jsonl"))).toBeUndefined();
    const p = join(root, "bad.jsonl");
    writeFileSync(
      p,
      `not json\n${JSON.stringify(use("Bash", { command: "x" }, "9"))}\n{"type":"assis`,
    );
    expect(recentToolCalls(p)).toEqual([{ tool: "Bash", args: { command: "x" } }]);
  });

  it("only reads the last 2 MB and drops the partial first line", () => {
    const filler = {
      type: "assistant",
      message: { content: [{ type: "text", text: "f".repeat(1000) }] },
    };
    const lines = [use("Bash", { command: "old" }, "old")];
    for (let i = 0; i < 2500; i++) lines.push(filler as never);
    lines.push(use("Bash", { command: "new" }, "new"));
    const p = transcript(lines);
    expect(recentToolCalls(p, 5)).toEqual([{ tool: "Bash", args: { command: "new" } }]);
  });

  it("lastTodos returns the last TodoWrite as status strings", () => {
    const p = transcript([
      use("TodoWrite", { todos: [{ content: "old", status: "pending" }] }, "1"),
      use(
        "TodoWrite",
        {
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "in_progress" },
          ],
        },
        "2",
      ),
      use("Bash", { command: "ls" }, "3"),
    ]);
    expect(lastTodos(p)).toEqual(["[completed] a", "[in_progress] b"]);
  });

  it("lastTodos is undefined without TodoWrite (TaskCreate alone is ignored)", () => {
    expect(lastTodos(transcript([use("TaskCreate", { subject: "x" }, "1")]))).toBeUndefined();
  });
});

describe("pendingHandoff / markConsumed", () => {
  const write = (
    name: string,
    ageMs = 0,
    dir = join(cwd, ".spend-leash/handoffs"),
    body = `# Handoff ${name}`,
  ) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, body);
    const t = new Date(NOW.getTime() - ageMs);
    utimesSync(p, t, t);
    return p;
  };

  it("returns the newest, then nothing after markConsumed of each", () => {
    const old = write("a.md", 3600_000);
    const fresh = write("b.md", 60_000);
    const first = pendingHandoff(ctx, cwd, NOW);
    expect(first?.path).toBe(fresh);
    expect(first?.preview).toContain("Handoff b.md");
    markConsumed(ctx, fresh);
    expect(pendingHandoff(ctx, cwd, NOW)?.path).toBe(old);
    markConsumed(ctx, old);
    expect(pendingHandoff(ctx, cwd, NOW)).toBeUndefined();
    if (posix) expect(statSync(join(ctx.leashHome, "consumed.json")).mode & 0o777).toBe(0o600);
  });

  it("ignores handoffs older than 7 days", () => {
    write("old.md", 8 * 24 * 3600_000);
    expect(pendingHandoff(ctx, cwd, NOW)).toBeUndefined();
  });

  it("caps the preview at 1500 chars and hides the metadata line", () => {
    write(
      "big.md",
      0,
      undefined,
      `<!-- spend-leash handoff cwd="x" session="s" -->\n${"y".repeat(5000)}`,
    );
    const r = pendingHandoff(ctx, cwd, NOW);
    expect(r?.preview).toHaveLength(1500);
    expect(r?.preview).not.toContain("<!--");
  });

  it("finds fallback-dir handoffs only for the matching cwd", () => {
    const fb = join(ctx.leashHome, "handoffs");
    const mine = write(
      "m.md",
      1000,
      fb,
      `${renderHandoff({ reason: "plan", detail: "d", sessionId: "s", cwd, recentCalls: [], now: NOW })}`,
    );
    write(
      "other.md",
      500,
      fb,
      `${renderHandoff({ reason: "plan", detail: "d", sessionId: "s", cwd: "/elsewhere", recentCalls: [], now: NOW })}`,
    );
    write("nometa.md", 100, fb, "# no metadata");
    expect(pendingHandoff(ctx, cwd, NOW)?.path).toBe(mine);
  });

  it("round-trips a cwd containing -->, a newline and a quote through the fallback dir", () => {
    const odd = `${root}/we"ird --> \n dir`;
    const fb = join(ctx.leashHome, "handoffs");
    const mine = write(
      "odd.md",
      0,
      fb,
      renderHandoff({
        reason: "plan",
        detail: "d",
        sessionId: "s",
        cwd: odd,
        recentCalls: [],
        now: NOW,
      }),
    );
    expect(pendingHandoff(ctx, odd, NOW)?.path).toBe(mine);
    expect(pendingHandoff(ctx, cwd, NOW)).toBeUndefined();
  });

  it("prunes consumed entries whose files no longer exist", () => {
    const a = write("a.md");
    markConsumed(ctx, a);
    markConsumed(ctx, join(root, "ghost.md"));
    markConsumed(ctx, a);
    const list = JSON.parse(readFileSync(join(ctx.leashHome, "consumed.json"), "utf8")) as string[];
    expect(list).toEqual([a]);
  });
});
