// Prices: USD per 1M tokens, from Anthropic's official pricing page
// https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-11-15).
// Columns used as published: base input, 5m cache write, 1h cache write, cache hits/refreshes, output.
// No column was derived. Claude Haiku 5.5 is tiered on the page; we use the
// "over 100,000 tokens" row (conservative: a budget guard should not under-count).
// Pure module: no node:fs, so the browser simulator can bundle it.

export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const ZERO: UsageTotals = {
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

const p = (
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
): Price => ({
  input,
  output,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
});

// Keys are model-id prefixes; the longest matching prefix wins.
const TABLE: Record<string, Price> = {
  "claude-fable-5-2": p(8, 10, 16, 0.2, 40),
  "claude-mythos-5-2": p(8, 10, 16, 0.2, 40),
  "claude-fable-5-1": p(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": p(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": p(10, 12.5, 20, 1, 50),
  "claude-mythos-5": p(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": p(4, 5, 8, 0.2, 20),
  "claude-opus-5": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1": p(15, 18.75, 30, 1.5, 75),
  "claude-opus-4": p(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5-5": p(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": p(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": p(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": p(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4": p(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": p(0.5, 0.625, 1, 0.05, 2.5),
  "claude-haiku-4-5": p(1, 1.25, 2, 0.1, 5),
};

function weight(x: Price): number {
  return x.input + x.output + x.cacheWrite5m + x.cacheWrite1h + x.cacheRead;
}

const MOST_EXPENSIVE: Price = Object.values(TABLE).reduce((a, b) =>
  weight(b) > weight(a) ? b : a,
);

function longestPrefix(model: string, table: Record<string, Price>): Price | undefined {
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : table[best];
}

export function priceFor(
  model: string,
  overrides?: Record<string, Price>,
): { price: Price; estimated: boolean } {
  const o = overrides ? longestPrefix(model, overrides) : undefined;
  if (o) return { price: o, estimated: false };
  const t = longestPrefix(model, TABLE);
  if (t) return { price: t, estimated: false };
  return { price: MOST_EXPENSIVE, estimated: true };
}

export function costUsd(u: UsageTotals, price: Price): number {
  return (
    (u.input * price.input +
      u.output * price.output +
      u.cacheWrite5m * price.cacheWrite5m +
      u.cacheWrite1h * price.cacheWrite1h +
      u.cacheRead * price.cacheRead) /
    1e6
  );
}
