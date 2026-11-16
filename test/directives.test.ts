import { describe, expect, it } from "vitest";
import { parseDirective } from "../src/directives.js";

describe("parseDirective", () => {
  it("parses set/add/off/new/plan-off", () => {
    expect(parseDirective("#budget $5 fix it")).toEqual({ kind: "set", usd: 5 });
    expect(parseDirective("#budget 15%")).toEqual({ kind: "set", planPct: 15 });
    expect(parseDirective("#budget $5 20%")).toEqual({ kind: "set", usd: 5, planPct: 20 });
    expect(parseDirective("#budget +$3")).toEqual({ kind: "add", usd: 3 });
    expect(parseDirective("#budget off")).toEqual({ kind: "off" });
    expect(parseDirective("#budget new")).toEqual({ kind: "new" });
    expect(parseDirective("#budget plan-off")).toEqual({ kind: "plan-off" });
    expect(parseDirective("#budget $2.50")).toEqual({ kind: "set", usd: 2.5 });
  });
  it("allows leading whitespace and any case", () => {
    expect(parseDirective("  \n#BUDGET $5")).toEqual({ kind: "set", usd: 5 });
    expect(parseDirective("#Budget OFF")).toEqual({ kind: "off" });
  });
  it("rejects invalid amounts", () => {
    for (const p of [
      "#budget $0",
      "#budget -1",
      "#budget 150%",
      "#budget $abc",
      "#budget",
      "#budget 0%",
      "#budget +$0",
    ]) {
      expect(parseDirective(p), p).toBeUndefined();
    }
  });
  it("only matches at the start", () => {
    expect(parseDirective("fix #budget $5")).toBeUndefined();
    expect(parseDirective("#budgetary $5")).toBeUndefined();
  });
});
