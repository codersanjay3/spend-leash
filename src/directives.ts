// Pure: parses a leading `#budget ...` directive from a prompt.
export type Directive =
  | { kind: "set"; usd?: number; planPct?: number }
  | { kind: "add"; usd: number }
  | { kind: "off" }
  | { kind: "new" }
  | { kind: "plan-off" };

const USD = /^\$(\d+(?:\.\d+)?)$/;
const ADD = /^\+\$(\d+(?:\.\d+)?)$/;
const PCT = /^(\d+(?:\.\d+)?)%$/;

export function parseDirective(prompt: string): Directive | undefined {
  const m = /^\s*#budget(?:\s+(\S.*))?$/is.exec(prompt);
  if (!m?.[1]) return undefined;
  const tokens = m[1].split(/\s+/);
  const first = (tokens[0] ?? "").toLowerCase();
  if (first === "off") return { kind: "off" };
  if (first === "new") return { kind: "new" };
  if (first === "plan-off") return { kind: "plan-off" };
  const add = ADD.exec(tokens[0] ?? "");
  if (add) {
    const usd = Number(add[1]);
    return usd > 0 ? { kind: "add", usd } : undefined;
  }
  let usd: number | undefined;
  let planPct: number | undefined;
  for (const [i, t] of tokens.slice(0, 2).entries()) {
    const u = USD.exec(t);
    const p = PCT.exec(t);
    if (u && usd === undefined) {
      usd = Number(u[1]);
      if (!(usd > 0)) return undefined;
    } else if (p && planPct === undefined) {
      planPct = Number(p[1]);
      if (!(planPct > 0 && planPct <= 100)) return undefined;
    } else if (i === 0) {
      return undefined; // first token must be a valid amount
    } else {
      break;
    }
  }
  if (usd === undefined && planPct === undefined) return undefined;
  return {
    kind: "set",
    ...(usd !== undefined ? { usd } : {}),
    ...(planPct !== undefined ? { planPct } : {}),
  };
}
