import { homedir } from "node:os";
import { join } from "node:path";

export interface Ctx {
  home: string;
  leashHome: string;
  now: () => Date;
}

export function makeCtx(env: NodeJS.ProcessEnv = process.env): Ctx {
  const home = env.HOME || env.USERPROFILE || homedir();
  const leashHome = env.SPEND_LEASH_HOME || join(home, ".spend-leash");
  return { home, leashHome, now: () => new Date() };
}

export function sessionDir(ctx: Ctx, _sessionId?: string): string {
  return join(ctx.leashHome, "sessions");
}

export function errorsLog(ctx: Ctx): string {
  return join(ctx.leashHome, "errors.log");
}

export function ledgerPath(ctx: Ctx): string {
  return join(ctx.leashHome, "tasks.jsonl");
}
