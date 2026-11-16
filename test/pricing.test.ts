import { describe, expect, it } from "vitest";
import { addUsage, costUsd, priceFor, ZERO } from "../src/pricing.js";

describe("pricing", () => {
  it("returns the exact table row for claude-sonnet-5-5", () => {
    expect(priceFor("claude-sonnet-5-5")).toEqual({
      price: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
      estimated: false,
    });
  });

  it("matches [1m] suffixes and dated ids to their family", () => {
    const opus = priceFor("claude-opus-5-5").price;
    expect(opus).toEqual({
      input: 4,
      output: 20,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
    });
    expect(priceFor("claude-opus-5-5[1m]")).toEqual({ price: opus, estimated: false });
    expect(priceFor("claude-opus-5-5-20261001").estimated).toBe(false);
    expect(priceFor("claude-opus-5-5-20261001").price).toEqual(opus);
    expect(priceFor("claude-haiku-4-5-20251001").price.input).toBe(1);
    expect(priceFor("claude-opus-4-1-20250805").price.input).toBe(15);
    expect(priceFor("claude-opus-4-20250514").price.input).toBe(15);
    expect(priceFor("claude-opus-4-6").price.input).toBe(5);
    expect(priceFor("claude-fable-5-2").price.input).toBe(8);
  });

  it("falls back to the most expensive known price for unknown models", () => {
    for (const m of ["gpt-x", "<synthetic>", ""]) {
      const r = priceFor(m);
      expect(r.estimated).toBe(true);
      expect(r.price.output).toBe(75);
      expect(r.price.input).toBe(15);
    }
  });

  it("computes cost per million tokens", () => {
    const p = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };
    expect(costUsd({ ...ZERO, input: 1e6 }, p)).toBe(3);
    expect(
      costUsd({ input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 }, p),
    ).toBeCloseTo(28.05, 10);
  });

  it("lets overrides win, by exact id or family prefix", () => {
    const o = { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 };
    expect(priceFor("claude-sonnet-5-5", { "claude-sonnet-5-5": o })).toEqual({
      price: o,
      estimated: false,
    });
    expect(priceFor("claude-sonnet-5-5-2027", { "claude-sonnet-": o }).price).toEqual(o);
    expect(priceFor("mystery", { mystery: o })).toEqual({ price: o, estimated: false });
  });

  it("adds usage", () => {
    const a = { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 };
    expect(addUsage(a, a)).toEqual({
      input: 2,
      output: 4,
      cacheWrite5m: 6,
      cacheWrite1h: 8,
      cacheRead: 10,
    });
    expect(addUsage(ZERO, a)).toEqual(a);
  });
});
