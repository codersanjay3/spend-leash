import { execFileSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configFrom,
  SIM_SESSION,
  scenarioFromTranscript,
  simulate,
  verdictOf,
} from "../site/core.js";
import { SCENARIOS } from "../site/scenarios.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runEngine } from "../src/engine.js";
import type { Ctx } from "../src/paths.js";
import { writeSnapshot } from "../src/state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = Date.parse("2026-11-16T12:00:00Z");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spend-leash-site-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** The written handoff path differs (absolute vs relative); everything else must match. */
const normalise = (m: string | undefined) => m?.replace(/Handoff: .*?\.md/, "Handoff: <H>");

const scenario = (name: string) => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
};

/** Runs the scenario through the real runEngine in a temp HOME. */
function realRun(name: string) {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd);
  const transcript = join(tmp, `${SIM_SESSION}.jsonl`);
  writeFileSync(transcript, "");
  let clock = new Date(START);
  const ctx: Ctx = { home: tmp, leashHome: join(tmp, "leash"), now: () => clock };
  const out: { verdict: string; message?: string }[] = [];
  let handoffFile: string | undefined;
  scenario(name).steps.forEach((s, i) => {
    clock = new Date(START + i * 10_000);
    for (const line of s.transcript ?? []) appendFileSync(transcript, `${line}\n`);
    if (s.snapshot) writeSnapshot(ctx, SIM_SESSION, { ...s.snapshot, at: clock.toISOString() });
    const r = runEngine(ctx, { ...s.input, transcript_path: transcript, cwd });
    const j = verdictOf(r.stdout ? JSON.parse(r.stdout) : undefined);
    out.push(j);
    const dir = join(cwd, ".spend-leash", "handoffs");
    if (existsSync(dir)) {
      const f = readdirSync(dir).sort()[0];
      if (f) handoffFile = join(dir, f);
    }
  });
  return { out, handoff: handoffFile ? readFileSync(handoffFile, "utf8") : undefined };
}

const section = (md: string, h: string) => {
  const a = md.indexOf(h);
  const b = md.indexOf("\n## ", a + h.length);
  return md.slice(a, b === -1 ? undefined : b);
};

describe("simulate matches the real engine", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: verdicts and messages equal runEngine`, () => {
      const real = realRun(s.name);
      const sim = simulate(s);
      expect(sim.steps.map((x) => x.verdict)).toEqual(real.out.map((x) => x.verdict));
      expect(sim.steps.map((x) => normalise(x.message))).toEqual(
        real.out.map((x) => normalise(x.message)),
      );
      expect(sim.handoff !== undefined).toBe(real.handoff !== undefined);
      if (sim.handoff && real.handoff) {
        expect(section(sim.handoff, "## Recent tool calls")).toBe(
          section(real.handoff, "## Recent tool calls"),
        );
        expect(section(sim.handoff, "## Task")).toBe(section(real.handoff, "## Task"));
      }
    });
  }
});

describe("scenario outcomes", () => {
  it("Expensive refactor: warn, then the exact budget stop, then +$2 continues", () => {
    const r = simulate(scenario("Expensive refactor"));
    const verdicts = r.steps.map((x) => x.verdict);
    expect(verdicts.indexOf("warn")).toBeGreaterThan(0);
    const stop = r.steps.find((x) => x.verdict === "stop");
    expect(stop?.message).toMatch(
      /^spend-leash: task budget \$2\.00 reached \(\$2\.\d\d\)\. Handoff: \.spend-leash\/handoffs\/20261116T\d{6}Z-budget\.md\. Reply "#budget \+\$2\.00" to continue this task or "#budget new" to start fresh\.$/,
    );
    expect(verdicts.indexOf("warn")).toBeLessThan(verdicts.indexOf("stop"));
    expect(r.steps.at(-1)?.verdict).toBe("ok");
    expect(r.steps.at(-2)?.verdict).toBe("ok");
    expect(r.handoff).toContain("# Handoff");
    expect(r.handoffPath).toMatch(/^\.spend-leash\/handoffs\//);
  });

  it("Test-fix loop: warn at the 3rd identical call, stop at the 5th", () => {
    const r = simulate(scenario("Test-fix loop"));
    const bash = r.steps.filter((x) => x.tool === "Bash").map((x) => x.verdict);
    expect(bash).toEqual(["ok", "ok", "warn", "warn", "stop", "stop"]);
  });

  it("Near the 5-hour limit: one plan stop, then a notice on the next prompt", () => {
    const r = simulate(scenario("Near the 5-hour limit"));
    expect(r.steps.filter((x) => x.verdict === "stop")).toHaveLength(1);
    const next = r.steps.find((x) => x.event === "UserPromptSubmit" && x.verdict === "warn");
    expect(next?.message).toContain("Continuing because you already saw the stop");
    expect(r.steps.map((x) => x.planPct).slice(0, 5)).toEqual([90, 91, 92, 94, 96]);
  });

  it("config changes re-run live: a $1 budget stops the refactor earlier", () => {
    const base = simulate(scenario("Expensive refactor"));
    const { config } = configFrom({ budgetUsd: 1, warnPct: 80, loopWarn: 3, loopStop: 5 });
    const tight = simulate(scenario("Expensive refactor"), config);
    expect(tight.steps.findIndex((x) => x.verdict === "stop")).toBeLessThan(
      base.steps.findIndex((x) => x.verdict === "stop"),
    );
  });

  it("configFrom rejects nonsense and keeps defaults", () => {
    const r = configFrom({ budgetUsd: -5, warnPct: 80, loopWarn: 3, loopStop: 5 });
    expect(r.config.task.usd).toBe(DEFAULT_CONFIG.task.usd);
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

describe("pasted transcripts", () => {
  const user = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const asst = (id: string, tool: string, input: unknown, out: number) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        model: "claude-sonnet-5-5",
        content: [{ type: "tool_use", id: `t_${id}`, name: tool, input }],
        usage: { input_tokens: 10, output_tokens: out },
      },
    });

  it("derives a prompt step and a tool step per tool_use with its spend", () => {
    const text = [
      user("do it"),
      asst("m1", "Read", { file_path: "/a" }, 100000),
      "{ not json",
    ].join("\n");
    const { scenario: sc, error } = scenarioFromTranscript(text);
    expect(error).toBeUndefined();
    expect(sc?.steps.map((s) => s.input.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
    ]);
    expect(sc?.description).toContain("1 unreadable line skipped");
    const r = simulate(sc as NonNullable<typeof sc>);
    expect(r.steps[1]?.tool).toBe("Read");
    expect(r.steps[1]?.usd).toBeCloseTo(1.00002, 4);
  });

  it("stops a pasted transcript that exceeds the budget", () => {
    const text = [user("go"), asst("m1", "Bash", { command: "x" }, 300000)].join("\n");
    const r = simulate((scenarioFromTranscript(text).scenario as never) ?? {});
    expect(r.steps[1]?.verdict).toBe("stop");
  });

  it("never throws; bad input gives a friendly message", () => {
    for (const bad of [
      "",
      "   ",
      "hello world",
      "[1,2,3]",
      "{}\n{}",
      "\u0000\u0001",
      "x".repeat(10),
    ]) {
      const r = scenarioFromTranscript(bad);
      expect(typeof (r.error ?? r.scenario?.name)).toBe("string");
    }
    expect(scenarioFromTranscript("hello").error).toMatch(/parsed as JSON/);
    expect(scenarioFromTranscript("x".repeat(5_000_000)).error).toMatch(/over 4 MB/);
  });

  it("simulate survives odd inputs", () => {
    const r = simulate({
      name: "x",
      description: "",
      steps: [
        { input: { hook_event_name: "Nope", session_id: "s", transcript_path: "", cwd: "" } },
        {
          input: { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: "" },
          transcript: ["junk"],
        },
      ],
    });
    expect(r.steps).toHaveLength(2);
  });
});

describe("site bundle", () => {
  it("builds with no node: imports or require(", () => {
    execFileSync("node", [join(ROOT, "scripts", "build-site.mjs")], { cwd: ROOT, stdio: "pipe" });
    const js = readFileSync(join(ROOT, "site-dist", "main.js"), "utf8");
    expect(js).not.toMatch(/node:/);
    expect(js).not.toMatch(/require\(/);
    expect(existsSync(join(ROOT, "site-dist", "index.html"))).toBe(true);
    expect(existsSync(join(ROOT, "site-dist", "style.css"))).toBe(true);
  });
});
