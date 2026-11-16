import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costUsd, priceFor, type UsageTotals, ZERO } from "../src/pricing.js";
import { readSpend } from "../src/transcript.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");

let tmp: string;
let main: string;
let subDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spend-leash-tr-"));
  mkdirSync(join(tmp, "proj"));
  main = join(tmp, "proj", "sess1.jsonl");
  subDir = join(tmp, "proj", "sess1", "subagents");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function line(
  id: string | null,
  model: string,
  u: Partial<{ i: number; o: number; cr: number; cc: number }>,
  extra: Record<string, unknown> = {},
  split?: { m5: number; h1: number },
): string {
  const usage: Record<string, unknown> = {
    input_tokens: u.i ?? 0,
    output_tokens: u.o ?? 0,
    cache_read_input_tokens: u.cr ?? 0,
    cache_creation_input_tokens: u.cc ?? 0,
  };
  if (split) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: split.m5,
      ephemeral_1h_input_tokens: split.h1,
    };
  }
  const message: Record<string, unknown> = { model, usage };
  if (id) message.id = id;
  return `${JSON.stringify({ type: "assistant", ...extra, message })}\n`;
}

function install(): void {
  cpSync(join(FIX, "sess1.jsonl"), main);
  mkdirSync(subDir, { recursive: true });
  cpSync(join(FIX, "sess1", "subagents", "agent-a1.jsonl"), join(subDir, "agent-a1.jsonl"));
}

const sum = (t: UsageTotals) => t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;

describe("readSpend", () => {
  it("counts duplicate message ids once and prices subagent models separately", () => {
    install();
    const r = readSpend(main);
    expect(r.tokens).toEqual({
      input: 2 + 10 + 5,
      output: 455 + 100 + 50,
      cacheWrite5m: 200 + 100,
      cacheWrite1h: 600,
      cacheRead: 52837 + 1000 + 500,
    });
    const expected =
      costUsd(
        { input: 2, output: 455, cacheWrite5m: 0, cacheWrite1h: 600, cacheRead: 52837 },
        priceFor("claude-sonnet-5-5").price,
      ) +
      costUsd(
        { input: 10, output: 100, cacheWrite5m: 200, cacheWrite1h: 0, cacheRead: 1000 },
        priceFor("claude-opus-5-5").price,
      ) +
      costUsd(
        { input: 5, output: 50, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 500 },
        priceFor("claude-haiku-4-5").price,
      );
    expect(r.usd).toBeCloseTo(expected, 10);
    expect(r.estimated).toBe(false);
  });

  it("dedupes an id across files", () => {
    install();
    appendFileSync(join(subDir, "agent-a1.jsonl"), line("msg_1", "claude-sonnet-5-5", { o: 999 }));
    const r = readSpend(main);
    expect(r.tokens.output).toBe(455 + 100 + 50);
  });

  it("reads only appended bytes on a second call", () => {
    install();
    const first = readSpend(main);
    expect(first.cache.files[main].offset).toBeGreaterThan(0);
    appendFileSync(main, line("msg_9", "claude-sonnet-5-5", { i: 7, o: 11 }));
    // Tamper: forget msg_1 in the cached ids. A re-read from offset 0 would count it
    // again and the totals would grow; an incremental read never sees it.
    const tampered = structuredClone(first.cache);
    tampered.files[main].ids = tampered.files[main].ids.filter((i) => i !== "msg_1");
    const redo = readSpend(main, tampered);
    expect(redo.tokens.output).toBe(first.tokens.output + 11);
    const second = readSpend(main, first.cache);
    expect(second.tokens.input).toBe(first.tokens.input + 7);
    expect(second.tokens.output).toBe(first.tokens.output + 11);
    expect(second.tokens.cacheRead).toBe(first.tokens.cacheRead);
    // Replaying the same cache against an unchanged file adds nothing.
    const third = readSpend(main, second.cache);
    expect(third.tokens).toEqual(second.tokens);
    // The input cache is not mutated.
    expect(first.cache.files[main].ids).not.toContain("msg_9");
  });

  it("holds a trailing line without newline in partial and counts it once completed", () => {
    const full = line("msg_a", "claude-sonnet-5-5", { i: 3, o: 4 });
    writeFileSync(main, full.slice(0, -1));
    const r1 = readSpend(main);
    expect(r1.tokens).toEqual(ZERO);
    expect(r1.cache.files[main].partial).toBe(full.slice(0, -1));
    appendFileSync(main, "\n");
    const r2 = readSpend(main, r1.cache);
    expect(r2.tokens.input).toBe(3);
    expect(r2.tokens.output).toBe(4);
    expect(r2.cache.files[main].partial).toBe("");
    const r3 = readSpend(main, r2.cache);
    expect(r3.tokens).toEqual(r2.tokens);
  });

  it("splits multibyte characters across read boundaries without corruption", () => {
    const full = line("msg_u", "claude-sonnet-5-5", { i: 1, o: 2 }, { note: "héllo wörld ✓" });
    const bytes = Buffer.from(full, "utf8");
    const cut = bytes.indexOf(Buffer.from("✓")) + 1; // mid-character
    writeFileSync(main, bytes.subarray(0, cut));
    const r1 = readSpend(main);
    appendFileSync(main, bytes.subarray(cut));
    const r2 = readSpend(main, r1.cache);
    expect(r2.tokens.input).toBe(1);
    expect(r2.tokens.output).toBe(2);
  });

  it("drops and recounts a file that shrank, without double counting", () => {
    writeFileSync(
      main,
      line("m1", "claude-sonnet-5-5", { o: 100 }, { uuid: "m1" }) +
        line("m2", "claude-sonnet-5-5", { o: 200 }, { uuid: "m2" }),
    );
    const r1 = readSpend(main);
    expect(r1.tokens.output).toBe(300);
    // New (shorter) content replaces the file, e.g. after /clear.
    writeFileSync(main, line("m3", "claude-sonnet-5-5", { o: 5 }, { uuid: "m3" }));
    const r2 = readSpend(main, r1.cache);
    expect(r2.tokens.output).toBe(5);
    expect(r2.cache.files[main].ids).toEqual(["m3"]);
    // Truncated to a prefix: same ids reappear and are counted exactly once.
    writeFileSync(
      main,
      line("m1", "claude-sonnet-5-5", { o: 100 }, { uuid: "m1" }) +
        line("m2", "claude-sonnet-5-5", { o: 200 }, { uuid: "m2" }),
    );
    const r3 = readSpend(main, r2.cache);
    expect(r3.tokens.output).toBe(300);
    truncateSync(main, 0);
    const r4 = readSpend(main, r3.cache);
    expect(r4.tokens).toEqual(ZERO);
  });

  it("returns zeros for a missing transcript or subagents dir", () => {
    const r = readSpend(join(tmp, "proj", "nope.jsonl"));
    expect(r.tokens).toEqual(ZERO);
    expect(r.usd).toBe(0);
    expect(r.estimated).toBe(false);
    writeFileSync(main, line("m1", "claude-sonnet-5-5", { o: 1 }));
    expect(readSpend(main).tokens.output).toBe(1);
  });

  it("ignores non-assistant and malformed lines", () => {
    writeFileSync(
      main,
      [
        '{"type":"user","message":{"usage":{"input_tokens":999}}}',
        '{"type":"assistant","message":{"id":"x","usage":{"input_tokens":5',
        '"assistant" "usage" but not json',
        "null",
        '{"type":"assistant","message":{"id":"nousage","model":"claude-sonnet-5-5"}}',
        "",
      ].join("\n") + line("ok", "claude-sonnet-5-5", { i: 1 }),
    );
    expect(readSpend(main).tokens.input).toBe(1);
  });

  it("counts all cache_creation_input_tokens as 5m when cache_creation is absent", () => {
    writeFileSync(main, line("m1", "claude-sonnet-5-5", { cc: 321 }));
    const r = readSpend(main);
    expect(r.tokens.cacheWrite5m).toBe(321);
    expect(r.tokens.cacheWrite1h).toBe(0);
  });

  it("counts lines without message.id, deduping by uuid when present", () => {
    writeFileSync(
      main,
      line(null, "claude-sonnet-5-5", { o: 1 }) +
        line(null, "claude-sonnet-5-5", { o: 1 }) +
        line(null, "claude-sonnet-5-5", { o: 10 }, { uuid: "u1" }) +
        line(null, "claude-sonnet-5-5", { o: 10 }, { uuid: "u1" }),
    );
    expect(readSpend(main).tokens.output).toBe(1 + 1 + 10);
  });

  it("flags unknown models as estimated and survives <synthetic>", () => {
    writeFileSync(
      main,
      line("s1", "<synthetic>", {}) + line("z1", "claude-zzz-9", { i: 1000, o: 1000 }),
    );
    const r = readSpend(main);
    expect(r.estimated).toBe(true);
    expect(r.usd).toBeGreaterThan(0);
    writeFileSync(main, line("s1", "<synthetic>", {}));
    const r2 = readSpend(main);
    expect(r2.usd).toBe(0);
    expect(r2.estimated).toBe(false);
  });

  it("applies price overrides", () => {
    writeFileSync(main, line("m1", "claude-sonnet-5-5", { i: 1_000_000 }));
    const o = { input: 100, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    expect(readSpend(main, undefined, { "claude-sonnet-5-5": o }).usd).toBeCloseTo(100, 6);
  });

  it("picks up subagent files that appear later", () => {
    writeFileSync(main, line("m1", "claude-sonnet-5-5", { o: 1 }));
    const r1 = readSpend(main);
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-b.jsonl"), line("m2", "claude-sonnet-5-5", { o: 2 }));
    const r2 = readSpend(main, r1.cache);
    expect(r2.tokens.output).toBe(3);
  });
});

describe("readSpend malformed caches", () => {
  const garbage = (m: string): unknown[] => [
    null,
    "x",
    [],
    {},
    { files: null },
    { files: [] },
    { files: { [m]: null } },
    { files: { [m]: { offset: 5 } } },
    { files: { [m]: { offset: -3, ids: "x", byModel: [], partial: 7 } } },
    { files: { [m]: { offset: 1.5, ids: [], byModel: {}, partial: "" } } },
    { files: { [m]: { offset: 5, ids: [1], byModel: {}, partial: "" } } },
    { files: { [m]: { offset: 5, ids: [], byModel: { a: { input: "x" } }, partial: "" } } },
    { files: { [m]: { offset: 5, ids: [], byModel: {}, partial: "", head: 3 } } },
    { files: { [m]: { offset: 1e9, ids: [], byModel: {}, partial: "" } } },
  ];

  it("gives the same totals as a fresh read and never throws", () => {
    install();
    const fresh = readSpend(main);
    for (const g of garbage(main)) {
      const r = readSpend(main, g as never);
      expect(r.tokens).toEqual(fresh.tokens);
      expect(r.usd).toBeCloseTo(fresh.usd, 10);
    }
  });

  it("survives model names like constructor and __proto__", () => {
    writeFileSync(
      main,
      line("a", "constructor", { i: 1000, o: 1000 }) +
        line("b", "__proto__", { i: 1000, o: 1000 }) +
        line("c", "toString", { i: 1 }),
    );
    const r = readSpend(main);
    expect(Number.isFinite(r.usd)).toBe(true);
    expect(r.usd).toBeGreaterThan(0);
    expect(r.tokens.input).toBe(2001);
    const again = readSpend(main, JSON.parse(JSON.stringify(r.cache)));
    expect(again.tokens).toEqual(r.tokens);
  });
});

describe("readSpend performance", () => {
  it("reads 20 MB fast the first time and 1 new line in under 20 ms", () => {
    const parts: string[] = [];
    const pad = "x".repeat(1500);
    let size = 0;
    let i = 0;
    while (size < 20 * 1024 * 1024) {
      const l = line(
        `msg_${i}`,
        "claude-sonnet-5-5",
        { i: 2, o: 10, cr: 1000, cc: 5 },
        { pad },
        { m5: 5, h1: 0 },
      );
      // Interleave non-assistant lines like real transcripts.
      const u = `${JSON.stringify({ type: "user", message: { content: pad } })}\n`;
      parts.push(l, u);
      size += l.length + u.length;
      i++;
    }
    writeFileSync(main, parts.join(""));
    const t0 = performance.now();
    const r1 = readSpend(main);
    const first = performance.now() - t0;
    expect(r1.tokens.output).toBe(10 * i);
    expect(first).toBeLessThan(1500);

    appendFileSync(main, line("msg_new", "claude-sonnet-5-5", { o: 1 }));
    const t1 = performance.now();
    const r2 = readSpend(main, r1.cache);
    const inc = performance.now() - t1;
    expect(r2.tokens.output).toBe(10 * i + 1);
    expect(sum(r2.tokens)).toBeGreaterThan(sum(r1.tokens));
    expect(inc).toBeLessThan(20);
  });
});
