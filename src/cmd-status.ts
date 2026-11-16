import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { ago, type CommandEnv, parseFlags, truncate, usd } from "./cli-common.js";
import { loadConfig } from "./config-load.js";
import { readInstallRecord } from "./install.js";
import { sessionDir } from "./paths.js";
import { costUsd, priceFor } from "./pricing.js";
import { readSession, readSnapshot } from "./state.js";
import { isFresh } from "./tasks.js";
import type { SpendCache } from "./transcript.js";

const DAY_MS = 24 * 3600_000;

export const NOT_INSTALLED = "spend-leash is not installed. Run: npx spend-leash init";

function cacheUsd(spend: SpendCache | undefined, prices: Parameters<typeof priceFor>[1]): number {
  let total = 0;
  for (const cur of Object.values(spend?.files ?? {})) {
    for (const [model, u] of Object.entries(cur.byModel ?? {})) {
      total += costUsd(u, priceFor(model, prices).price);
    }
  }
  return total;
}

function recentSessionIds(dir: string, now: Date): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { id: string; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n.endsWith(".statusline.json")) continue;
    try {
      const p = join(dir, n);
      const mtime = statSync(p).mtimeMs;
      if (now.getTime() - mtime > DAY_MS) continue;
      const v: unknown = JSON.parse(readFileSync(p, "utf8"));
      const id = (v as { sessionId?: unknown } | null)?.sessionId;
      if (typeof id === "string") out.push({ id, mtime });
    } catch {
      /* unreadable state file: skip */
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10)
    .map((s) => s.id);
}

export async function cmdStatus(argv: string[], env: CommandEnv): Promise<number> {
  parseFlags(argv, {});
  const { ctx, cwd } = env;
  if (!readInstallRecord(ctx)) {
    console.log(NOT_INSTALLED);
    return 0;
  }
  const { config } = loadConfig(ctx, cwd);
  const now = ctx.now();
  let planData = false;
  let shown = 0;
  for (const id of recentSessionIds(sessionDir(ctx), now)) {
    const s = readSession(ctx, id);
    const t = s.task;
    if (!t) continue;
    const snap = readSnapshot(ctx, id);
    const spent = Math.max(0, cacheUsd(s.spend, config.prices) - t.baseUsd);
    const parts: string[] = [];
    if (snap && typeof snap.fiveHourPct === "number") {
      const at = new Date(snap.at);
      parts.push(`5h ${Math.round(snap.fiveHourPct)}% (${ago(at, now)} ago)`);
      if (isFresh(snap, now)) planData = true;
    }
    if (t.outcome) parts.push(t.outcome);
    const spend = `${usd(spent)}${t.limitUsd !== null ? ` / ${usd(t.limitUsd)}` : ""}`;
    console.log([`${truncate(t.prompt, 60)}  ${spend}`, ...parts].join("  · "));
    shown++;
  }
  if (shown === 0) console.log("No sessions in the last 24 hours.");
  console.log(
    `plan %: ${planData ? pc.green("available") : "unavailable — needs a Pro/Max/Ultra status line"}`,
  );
  return 0;
}
