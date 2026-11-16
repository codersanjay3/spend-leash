import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, mergeConfig } from "./config.js";
import type { Ctx } from "./paths.js";

function readJson(path: string, label: string, notes: string[]): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined; // missing or unreadable file: not an error
  }
  try {
    return JSON.parse(text);
  } catch {
    notes.push(`${label}: not valid JSON, ignored`);
    return undefined;
  }
}

export function loadConfig(ctx: Ctx, cwd: string): { config: Config; notes: string[] } {
  const pre: string[] = [];
  const user = readJson(join(ctx.leashHome, "config.json"), "config.json", pre);
  const project = readJson(join(cwd, ".spend-leash.json"), ".spend-leash.json", pre);
  const { config, notes } = mergeConfig(user, project);
  return { config, notes: [...pre, ...notes] };
}
