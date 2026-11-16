import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import {
  approve,
  type Budget,
  type CommandEnv,
  parseBudget,
  parseFlags,
  parseScope,
  stripPrefix,
  usd,
} from "./cli-common.js";
import { DEFAULT_CONFIG } from "./config.js";
import { loadConfig } from "./config-load.js";
import { applyInstall, HOOK_EVENTS, planInstall } from "./install.js";
import { writeJsonAtomic } from "./settings.js";

const HOOK_FILES = ["hook.mjs", "statusline.mjs"];

function copyHookFiles(leashHome: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of HOOK_FILES) {
    if (!existsSync(join(here, f))) {
      throw new Error(`${join(here, f)} not found; reinstall spend-leash`);
    }
  }
  mkdirSync(leashHome, { recursive: true, mode: 0o700 });
  for (const f of HOOK_FILES) copyFileSync(join(here, f), join(leashHome, f));
}

/** Creates config.json with defaults when absent; with a budget, updates only that key. */
function writeConfig(configPath: string, budget: Budget | undefined, notes: string[]): void {
  let cfg: Record<string, unknown>;
  if (existsSync(configPath)) {
    try {
      const v: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      cfg = v as Record<string, unknown>;
    } catch {
      if (budget) notes.push(`${configPath} is not valid JSON; budget not written, fix it by hand`);
      return;
    }
    if (!budget) return;
  } else {
    cfg = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  }
  if (budget) {
    const t = cfg.task && typeof cfg.task === "object" && !Array.isArray(cfg.task) ? cfg.task : {};
    cfg.task = { ...t, ...budget };
  }
  writeJsonAtomic(configPath, cfg);
}

function budgetLine(task: { usd: number | null; planPct: number | null }): string {
  const parts: string[] = [];
  if (task.usd !== null) parts.push(usd(task.usd));
  if (task.planPct !== null) parts.push(`${task.planPct}% of the 5-hour plan`);
  return parts.length > 0 ? parts.join(" or ") : "none";
}

export async function cmdInit(argv: string[], env: CommandEnv): Promise<number> {
  const f = parseFlags(argv, {
    scope: { type: "string" },
    budget: { type: "string" },
    yes: { type: "boolean", short: "y" },
  });
  const scope = parseScope(f.scope);
  const budget = f.budget === undefined ? undefined : parseBudget(f.budget);
  const { ctx, cwd } = env;

  const plan = planInstall(ctx, { scope, project: cwd });
  const { config, notes } = loadConfig(ctx, cwd);
  const allNotes = [...plan.notes, ...notes];
  const configPath = join(ctx.leashHome, "config.json");

  if (plan.changes.length === 0) {
    copyHookFiles(ctx.leashHome);
    writeConfig(configPath, budget, allNotes);
    for (const n of allNotes) console.log(`note: ${n}`);
    console.log("spend-leash is already installed; hook files refreshed.");
    return 0;
  }

  const shown = { ...config.task, ...budget };
  console.log(pc.bold("spend-leash init"));
  console.log("Will change:");
  for (const c of plan.changes) console.log(`  ${pc.cyan(c.path)}`);
  console.log(`  ${HOOK_EVENTS.length} hooks`);
  const sl = plan.record.statusLine;
  if (sl) {
    console.log(
      sl.original === null
        ? "  add a status line (shows the budget; reads plan usage for % budgets)"
        : "  wrap your existing status line (its output is unchanged; the original keeps running)",
    );
  }
  console.log(`Budget per prompt: ${pc.bold(budgetLine(shown))}`);
  for (const n of allNotes) console.log(`note: ${n}`);
  if (shown.planPct !== null) {
    console.log("note: plan % budgets need a Pro/Max/Ultra status line; otherwise only $ applies");
  }

  if (!(await approve(Boolean(f.yes), "Apply these changes?"))) {
    console.log("Aborted. Nothing changed.");
    return 1;
  }

  copyHookFiles(ctx.leashHome); // hooks must never point at missing files
  try {
    applyInstall(ctx, plan);
  } catch (e) {
    throw new Error(stripPrefix((e as Error).message));
  }
  const after: string[] = [];
  writeConfig(configPath, budget, after);
  for (const n of after) console.log(`note: ${n}`);

  const final = loadConfig(ctx, cwd).config.task;
  console.log("");
  console.log(
    pc.green(
      `Done. Every prompt now has a ${budgetLine(final)} budget (warn at ${Math.round(final.warnAt * 100)}%).`,
    ),
  );
  console.log(`Add ${pc.bold(".spend-leash/")} to your .gitignore (handoff files live there).`);
  console.log(`To undo: ${pc.bold("npx spend-leash uninstall")}`);
  console.log(`Override per task: start a prompt with ${pc.bold("#budget $5 ")}your request`);
  return 0;
}
