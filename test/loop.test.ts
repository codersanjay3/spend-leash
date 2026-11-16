import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  fingerprint,
  IGNORED_BY_DEFAULT,
  recordCall,
  recordFailure,
  WRITE_TOOLS,
} from "../src/loop.js";
import type { SessionState } from "../src/tasks.js";

type Loop = SessionState["loop"];
const cfg = DEFAULT_CONFIG.loop;
const empty = (): Loop => ({ calls: [], failures: {} });
const bash = (command: string) => ({ command });

/** Feed a sequence of [tool, input] calls; returns the verdict/count of every call. */
function run(calls: [string, unknown][], c = cfg, start: Loop = empty()) {
  let loop = start;
  const out: { verdict: string; count: number }[] = [];
  for (const [t, i] of calls) {
    const r = recordCall(loop, t, i, c);
    loop = r.loop;
    out.push({ verdict: r.verdict, count: r.count });
  }
  return { loop, out };
}

describe("fingerprint", () => {
  it("collapses whitespace in Bash commands", () => {
    expect(fingerprint("Bash", bash("ls  -la"))).toBe(fingerprint("Bash", bash("ls -la")));
    expect(fingerprint("Bash", bash("  ls\t-la \n"))).toBe(fingerprint("Bash", bash("ls -la")));
  });
  it("ignores Bash description/timeout/run_in_background", () => {
    expect(
      fingerprint("Bash", {
        command: "npm test",
        description: "a",
        timeout: 5,
        run_in_background: true,
      }),
    ).toBe(fingerprint("Bash", { command: "npm test" }));
  });
  it("is key-order independent, recursively", () => {
    expect(fingerprint("Read", { a: 1, b: 2 })).toBe(fingerprint("Read", { b: 2, a: 1 }));
    expect(fingerprint("X", { o: { p: 1, q: [{ y: 1, z: 2 }] } })).toBe(
      fingerprint("X", { o: { q: [{ z: 2, y: 1 }], p: 1 } }),
    );
  });
  it("distinguishes tools and inputs", () => {
    expect(fingerprint("Read", { file_path: "a" })).not.toBe(
      fingerprint("Read", { file_path: "b" }),
    );
    expect(fingerprint("Read", { file_path: "a" })).not.toBe(
      fingerprint("Glob", { file_path: "a" }),
    );
    expect(fingerprint("Bash", bash("ls"))).not.toBe(fingerprint("Bash", bash("ls -la")));
  });
  it("is <tool>:<lowercase hex> and stays small for huge inputs", () => {
    const fp = fingerprint("Write", { file_path: "a", content: "x".repeat(1_000_000) });
    expect(fp).toMatch(/^Write:[0-9a-f]{1,14}$/);
  });
  it("is total and deterministic for BigInt, cycles and deep nesting", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    let deep: unknown = "x";
    for (let i = 0; i < 20000; i++) deep = { n: deep };
    for (const input of [{ a: 1n }, cyc, deep]) {
      const f1 = fingerprint("Read", input);
      expect(f1).toMatch(/^Read:[0-9a-f]+$/);
      expect(fingerprint("Read", input)).toBe(f1);
    }
    expect(fingerprint("Read", { a: 1n })).not.toBe(fingerprint("Read", { a: 1 }));
  });
  it("shared (non-cyclic) references are not marked as cycles", () => {
    const shared = { k: 1 };
    expect(fingerprint("X", { a: shared, b: shared })).toBe(
      fingerprint("X", { a: { k: 1 }, b: { k: 1 } }),
    );
  });
  it("tolerates odd inputs", () => {
    expect(() => fingerprint("Bash", null)).not.toThrow();
    expect(() => fingerprint("Bash", "str")).not.toThrow();
    expect(() => fingerprint("Bash", undefined)).not.toThrow();
    expect(fingerprint("Bash", { command: 5 })).toMatch(/^Bash:/);
  });
});

describe("recordCall", () => {
  it("exports the documented tool lists", () => {
    expect([...WRITE_TOOLS]).toEqual(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
    expect([...IGNORED_BY_DEFAULT]).toEqual([
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
    ]);
  });
  it("warns on the 3rd identical call and stops on the 5th", () => {
    const { out } = run(Array(5).fill(["Bash", bash("npm run build")]));
    expect(out.map((o) => o.verdict)).toEqual(["ok", "ok", "warn", "warn", "stop"]);
    expect(out.map((o) => o.count)).toEqual([1, 2, 3, 4, 5]);
  });
  it("does not mutate its input", () => {
    const loop = empty();
    const r = recordCall(loop, "Read", { file_path: "a" }, cfg);
    expect(loop).toEqual(empty());
    expect(r.loop).not.toBe(loop);
  });
  it("a write tool clears history and is not recorded (Read/Edit/Read x6 never warns)", () => {
    const seq: [string, unknown][] = [];
    for (let i = 0; i < 6; i++) {
      seq.push(
        ["Read", { file_path: "a.ts" }],
        ["Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }],
      );
    }
    const { out, loop } = run(seq);
    expect(out.every((o) => o.verdict === "ok")).toBe(true);
    expect(loop).toEqual(empty());
  });
  it("every write tool clears calls and failures", () => {
    for (const w of WRITE_TOOLS) {
      let loop = recordCall(empty(), "Bash", bash("x"), cfg).loop;
      loop = recordFailure(loop, "Bash", bash("x"));
      const r = recordCall(loop, w, { file_path: "f" }, cfg);
      expect(r.verdict).toBe("ok");
      expect(r.loop).toEqual(empty());
    }
  });
  it("3 different commands interleaved within the window are ok", () => {
    const seq: [string, unknown][] = [];
    for (let i = 0; i < 2; i++)
      seq.push(["Bash", bash("a")], ["Bash", bash("b")], ["Bash", bash("c")]);
    expect(run(seq).out.every((o) => o.verdict === "ok")).toBe(true);
  });
  it("a call that fell out of the window no longer counts", () => {
    const seq: [string, unknown][] = [
      ["Bash", bash("a")],
      ["Bash", bash("a")],
    ];
    for (let i = 0; i < 12; i++) seq.push(["Bash", bash(`filler ${i}`)]);
    seq.push(["Bash", bash("a")]);
    const { out, loop } = run(seq);
    expect(out[out.length - 1]).toEqual({ verdict: "ok", count: 1 });
    expect(loop.calls).toHaveLength(12);
  });
  it("one recorded failure makes the next identical call count double", () => {
    let r = recordCall(empty(), "Bash", bash("npm test"), cfg);
    expect(r.count).toBe(1);
    const loop = recordFailure(r.loop, "Bash", bash("npm test"));
    r = recordCall(loop, "Bash", bash("npm test"), cfg);
    expect(r.count).toBe(3);
    expect(r.verdict).toBe("warn");
  });
  it("ignores a late failure whose call is not in the window", () => {
    const late = recordFailure(empty(), "Bash", bash("x"));
    expect(late).toEqual(empty());
    const r = recordCall(late, "Bash", bash("x"), cfg);
    expect(r.count).toBe(1);
    expect(r.verdict).toBe("ok");
  });
  it("recordFailure only touches failures", () => {
    const l = recordCall(empty(), "Bash", bash("x"), cfg).loop;
    const f = recordFailure(recordFailure(l, "Bash", bash("x")), "Bash", bash("x"));
    expect(f.calls).toEqual(l.calls);
    expect(f.failures[fingerprint("Bash", bash("x"))]).toBe(2);
    expect(l.failures).toEqual({});
  });
  it("prunes failures whose fingerprint left the window", () => {
    let loop = recordCall(empty(), "Bash", bash("old"), cfg).loop;
    loop = recordFailure(loop, "Bash", bash("old"));
    for (let i = 0; i < 12; i++) loop = recordCall(loop, "Bash", bash(`f${i}`), cfg).loop;
    expect(loop.failures).toEqual({});
  });
  it("TodoWrite x10 is ok and leaves state unchanged", () => {
    const { out, loop } = run(Array(10).fill(["TodoWrite", { todos: [] }]));
    expect(out.every((o) => o.verdict === "ok")).toBe(true);
    expect(loop).toEqual(empty());
  });
  it("honors cfg.ignoreTools", () => {
    const c = { ...cfg, ignoreTools: ["Read"] };
    const { out, loop } = run(Array(6).fill(["Read", { file_path: "a" }]), c);
    expect(out.every((o) => o.verdict === "ok")).toBe(true);
    expect(loop).toEqual(empty());
    // not ignored without the config
    expect(run(Array(6).fill(["Read", { file_path: "a" }])).out[5]?.verdict).toBe("stop");
  });
  it("honors custom thresholds and window", () => {
    const c = { warnAt: 2, stopAt: 3, window: 4, ignoreTools: [] };
    expect(run(Array(3).fill(["Bash", bash("a")]), c).out.map((o) => o.verdict)).toEqual([
      "ok",
      "warn",
      "stop",
    ]);
  });
});

describe("normal work is not misread as a loop", () => {
  const tests = ["Bash", bash("npm test")] as [string, unknown];
  const edit = (n: number): [string, unknown] => [
    "Edit",
    { file_path: "a.ts", old_string: `${n}`, new_string: "x" },
  ];
  it("run tests -> edit -> run tests -> edit -> run tests never warns", () => {
    const { out } = run([tests, edit(1), tests, edit(2), tests]);
    expect(out.every((o) => o.verdict === "ok")).toBe(true);
  });
  it("git status twice with different files read between is ok", () => {
    const status = ["Bash", bash("git status")] as [string, unknown];
    const { out } = run([
      status,
      ["Read", { file_path: "a" }],
      ["Read", { file_path: "b" }],
      status,
    ]);
    expect(out.every((o) => o.verdict === "ok")).toBe(true);
    expect(out[3]?.count).toBe(2);
  });
  it("cycling 3 reads 3 times with no edit IS repetitive and warns", () => {
    // Each file is read 3 identical times inside the window with nothing changed in between;
    // that is genuinely repetitive, so warning here is intended.
    const cycle: [string, unknown][] = ["a", "b", "c"].map((f) => ["Read", { file_path: f }]);
    const { out } = run([...cycle, ...cycle, ...cycle]);
    expect(out.slice(0, 6).every((o) => o.verdict === "ok")).toBe(true);
    expect(out.slice(6).map((o) => o.verdict)).toEqual(["warn", "warn", "warn"]);
  });
});
