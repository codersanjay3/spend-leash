// Pure config model + merge logic: no node:fs, so the browser simulator can bundle it.
// File reading lives in config-load.ts.
import type { Price } from "./pricing.js";

export interface Config {
  task: { usd: number | null; planPct: number | null; warnAt: number };
  plan: { stopAtPct: number };
  loop: { warnAt: number; stopAt: number; window: number; ignoreTools: string[] };
  handoff: { dir: string };
  failClosed: boolean;
  prices?: Record<string, Price>;
}

export const DEFAULT_CONFIG: Config = {
  task: { usd: 2, planPct: null, warnAt: 0.8 },
  plan: { stopAtPct: 95 },
  loop: { warnAt: 3, stopAt: 5, window: 12, ignoreTools: [] },
  handoff: { dir: ".spend-leash/handoffs" },
  failClosed: false,
};

const USER_FILE = "config.json";
const PROJECT_FILE = ".spend-leash.json";
const PRICE_KEYS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"] as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone(c: Config): Config {
  return {
    task: { ...c.task },
    plan: { ...c.plan },
    loop: { ...c.loop, ignoreTools: [...c.loop.ignoreTools] },
    handoff: { ...c.handoff },
    failClosed: c.failClosed,
    ...(c.prices ? { prices: { ...c.prices } } : {}),
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPct = (v: unknown): v is number => isNum(v) && v > 0 && v <= 100;
const isFrac = (v: unknown): v is number => isNum(v) && v > 0 && v <= 1;
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 1;

const SCHEMA: Record<string, Record<string, (v: unknown) => boolean>> = {
  task: {
    usd: (v) => v === null || (isNum(v) && v > 0),
    planPct: (v) => v === null || isPct(v),
    warnAt: isFrac,
  },
  plan: { stopAtPct: isPct },
  loop: {
    warnAt: isCount,
    stopAt: isCount,
    window: (v) => isNum(v) && Number.isInteger(v) && v >= 2,
    ignoreTools: (v) => Array.isArray(v) && v.every((t) => typeof t === "string"),
  },
  handoff: { dir: (v) => typeof v === "string" && v.trim() !== "" },
};

function parsePrices(
  raw: unknown,
  notes: string[],
  file: string,
): Record<string, Price> | undefined {
  if (!isObj(raw)) {
    notes.push(`${file}: prices ignored (must be an object)`);
    return undefined;
  }
  const out: Record<string, Price> = {};
  for (const [key, val] of Object.entries(raw)) {
    const ok =
      key.trim() !== "" &&
      isObj(val) &&
      PRICE_KEYS.every((k) => isNum(val[k]) && (val[k] as number) >= 0);
    if (!ok) {
      notes.push(
        `${file}: prices[${JSON.stringify(key)}] ignored (needs a non-empty key and five non-negative numbers)`,
      );
      continue;
    }
    const v = val as Obj;
    out[key] = {
      input: v.input as number,
      output: v.output as number,
      cacheWrite5m: v.cacheWrite5m as number,
      cacheWrite1h: v.cacheWrite1h as number,
      cacheRead: v.cacheRead as number,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function applyUser(user: unknown, cfg: Config, notes: string[]): void {
  if (user === undefined || user === null) return;
  if (!isObj(user)) {
    notes.push(`${USER_FILE}: ignored (top level must be an object)`);
    return;
  }
  for (const [section, val] of Object.entries(user)) {
    if (section === "failClosed") {
      if (typeof val === "boolean") cfg.failClosed = val;
      else
        notes.push(
          `${USER_FILE}: failClosed ${JSON.stringify(val)} ignored (must be true or false)`,
        );
    } else if (section === "prices") {
      const p = parsePrices(val, notes, USER_FILE);
      if (p) cfg.prices = p;
    } else if (SCHEMA[section]) {
      if (!isObj(val)) {
        notes.push(`${USER_FILE}: ${section} ignored (must be an object)`);
        continue;
      }
      const target = cfg[section as "task" | "plan" | "loop" | "handoff"] as unknown as Obj;
      for (const [k, v] of Object.entries(val)) {
        const check = SCHEMA[section]?.[k];
        if (!check) notes.push(`${USER_FILE}: unknown key ${section}.${k} ignored`);
        else if (check(v)) target[k] = Array.isArray(v) ? [...v] : v;
        else
          notes.push(
            `${USER_FILE}: ${section}.${k} ${JSON.stringify(v)} ignored (invalid value, default kept)`,
          );
      }
    } else {
      notes.push(`${USER_FILE}: unknown key ${section} ignored`);
    }
  }
  // Cross-field: stopAt must not be below warnAt.
  if (cfg.loop.stopAt < cfg.loop.warnAt) {
    notes.push(
      `${USER_FILE}: loop.stopAt ${cfg.loop.stopAt} is below loop.warnAt ${cfg.loop.warnAt}, loop defaults kept`,
    );
    cfg.loop.warnAt = DEFAULT_CONFIG.loop.warnAt;
    cfg.loop.stopAt = DEFAULT_CONFIG.loop.stopAt;
  }
}

const TIGHT_NOTE = "project config can only tighten limits";

function applyProject(project: unknown, cfg: Config, notes: string[]): void {
  if (project === undefined || project === null) return;
  if (!isObj(project)) {
    notes.push(`${PROJECT_FILE}: ignored (top level must be an object)`);
    return;
  }
  const ignore = (path: string, v: unknown, why: string) =>
    notes.push(`${PROJECT_FILE}: ${path} ${JSON.stringify(v)} ignored (${why})`);

  for (const [section, val] of Object.entries(project)) {
    if (section === "failClosed") {
      if (typeof val !== "boolean") ignore("failClosed", val, "must be true or false");
      else if (val) cfg.failClosed = true;
      else if (cfg.failClosed) ignore("failClosed", val, TIGHT_NOTE);
    } else if (section === "prices") {
      ignore("prices", "...", "project config cannot override prices");
    } else if (SCHEMA[section]) {
      if (!isObj(val)) {
        notes.push(`${PROJECT_FILE}: ${section} ignored (must be an object)`);
        continue;
      }
      for (const [k, v] of Object.entries(val)) {
        const path = `${section}.${k}`;
        const check = SCHEMA[section]?.[k];
        if (!check) {
          notes.push(`${PROJECT_FILE}: unknown key ${path} ignored`);
          continue;
        }
        if (path === "handoff.dir" || path === "loop.ignoreTools") {
          ignore(path, v, `project config cannot set ${path}`);
          continue;
        }
        if (!check(v)) {
          ignore(path, v, "invalid value");
          continue;
        }
        tighten(cfg, path, v, ignore);
      }
    } else {
      notes.push(`${PROJECT_FILE}: unknown key ${section} ignored`);
    }
  }
  if (cfg.loop.stopAt < cfg.loop.warnAt) {
    // Both individually tightened but inconsistent: keep stopAt >= warnAt.
    cfg.loop.warnAt = cfg.loop.stopAt;
  }
}

function tighten(
  cfg: Config,
  path: string,
  v: unknown,
  ignore: (path: string, v: unknown, why: string) => void,
): void {
  switch (path) {
    case "task.usd":
    case "task.planPct": {
      const key = path === "task.usd" ? "usd" : "planPct";
      if (v === null) return ignore(path, v, TIGHT_NOTE);
      const cur = cfg.task[key];
      if (cur === null || (v as number) < cur) cfg.task[key] = v as number;
      else if ((v as number) > cur) ignore(path, v, TIGHT_NOTE);
      return;
    }
    case "task.warnAt":
    case "plan.stopAtPct":
    case "loop.warnAt":
    case "loop.stopAt": {
      const [s, k] = path.split(".") as ["task" | "plan" | "loop", string];
      const target = cfg[s] as unknown as Record<string, number>;
      const cur = target[k] as number;
      if ((v as number) < cur) target[k] = v as number;
      else if ((v as number) > cur) ignore(path, v, TIGHT_NOTE);
      return;
    }
    case "loop.window":
      if ((v as number) > cfg.loop.window) cfg.loop.window = v as number;
      else if ((v as number) < cfg.loop.window) ignore(path, v, TIGHT_NOTE);
      return;
  }
}

export function mergeConfig(user: unknown, project: unknown): { config: Config; notes: string[] } {
  const config = clone(DEFAULT_CONFIG);
  const notes: string[] = [];
  applyUser(user, config, notes);
  applyProject(project, config, notes);
  return { config, notes };
}
