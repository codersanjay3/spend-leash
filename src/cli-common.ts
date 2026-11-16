import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Ctx } from "./paths.js";
import type { Scope } from "./settings.js";

/** A mistake in how the command was called: exit 2. Anything else thrown exits 1. */
export class UsageError extends Error {}

export interface CommandEnv {
  ctx: Ctx;
  /** The project directory (process.cwd()). */
  cwd: string;
  /** Replaces the interactive prompt (tests). */
  ask?: (question: string) => Promise<boolean>;
}

export function stripPrefix(msg: string): string {
  return msg.replace(/^spend-leash:\s*/, "");
}

export function parseFlags<
  T extends Record<string, { type: "boolean" | "string"; short?: string }>,
>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

export function parseScope(v: string | undefined): Scope {
  if (v === undefined) return "user";
  if (v === "user" || v === "project" || v === "local") return v;
  throw new UsageError(`--scope must be user, project or local (got "${v}")`);
}

export type Budget = { usd: number } | { planPct: number };

/** Accepts `2`, `$2`, `2.50`, `10%`. */
export function parseBudget(v: string): Budget {
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v.trim());
  if (pct) {
    const n = Number(pct[1]);
    if (n > 0 && n <= 100) return { planPct: n };
  } else {
    const usd = /^\$?(\d+(?:\.\d+)?)$/.exec(v.trim());
    if (usd && Number(usd[1]) > 0) return { usd: Number(usd[1]) };
  }
  throw new UsageError(
    `--budget must be a dollar amount like 2, $2 or 2.50, or a plan percentage like 10% (got "${v}")`,
  );
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      res(/^y(es)?$/i.test(a.trim()));
    });
  });
}

/** `--yes` -> yes. No TTY and no `--yes` -> throws a usage error. Otherwise asks. */
export async function approve(
  yes: boolean,
  question: string,
  ask?: (question: string) => Promise<boolean>,
): Promise<boolean> {
  if (yes) return true;
  if (ask) return ask(question);
  if (!process.stdin.isTTY) throw new UsageError("Run with --yes to apply without a prompt.");
  return confirm(question);
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function ago(from: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
