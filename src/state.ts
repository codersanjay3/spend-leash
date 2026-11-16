// Per-session state files: sessions/<id>.json, <id>.statusline.json, and the <id>.lock mkdir lock.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Ctx, sessionDir } from "./paths.js";
import type { SessionState, Snapshot } from "./tasks.js";

export { isFresh } from "./tasks.js";

const STALE_LOCK_MS = 5000;
const LOCK_WAIT_MS = 200;
const LOCK_POLL_MS = 10;

function safe(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
}

const file = (ctx: Ctx, id: string, suffix: string) =>
  join(sessionDir(ctx, id), `${safe(id)}${suffix}`);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function defaultState(sessionId: string): SessionState {
  return {
    sessionId,
    cwd: "",
    taskSeq: 0,
    loop: { calls: [], failures: {} },
    planGuard: { off: false },
  };
}

function validShape(v: unknown, sessionId: string): v is SessionState {
  if (!isObj(v) || v.sessionId !== sessionId || typeof v.cwd !== "string") return false;
  if (!isObj(v.loop) || !Array.isArray(v.loop.calls) || !isObj(v.loop.failures)) return false;
  if (!isObj(v.planGuard) || typeof v.planGuard.off !== "boolean") return false;
  if (v.task !== undefined && !isObj(v.task)) return false;
  if (v.spend !== undefined && !isObj(v.spend)) return false;
  return v.taskSeq === undefined || typeof v.taskSeq === "number";
}

/** Never throws: a missing, unreadable or malformed file yields a fresh default state. */
export function readSession(ctx: Ctx, sessionId: string): SessionState {
  try {
    const raw: unknown = JSON.parse(readFileSync(file(ctx, sessionId, ".json"), "utf8"));
    if (!validShape(raw, sessionId)) return defaultState(sessionId);
    return { ...raw, taskSeq: raw.taskSeq ?? 0 };
  } catch {
    return defaultState(sessionId);
  }
}

/** Atomic (temp file in the same dir + rename); dirs 0700, file 0600 on POSIX. */
export function writeSession(ctx: Ctx, s: SessionState): void {
  const dir = sessionDir(ctx, s.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = file(ctx, s.sessionId, ".json");
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialises read-modify-write on a session via an mkdir lock. Waits at most 200 ms
 * (polling every 10 ms), removes a lock older than 5 s, and on timeout runs `fn` anyway
 * (without releasing a lock it does not own): a hook must never hang or fail on contention.
 */
export function withSessionLock<T>(ctx: Ctx, sessionId: string, fn: () => T): T {
  const lock = file(ctx, sessionId, ".lock");
  let held = false;
  try {
    mkdirSync(sessionDir(ctx, sessionId), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        held = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
            rmdirSync(lock);
            continue;
          }
        } catch {
          continue; // vanished between mkdir and stat: retry
        }
        if (Date.now() >= deadline) break;
        sleep(LOCK_POLL_MS);
      }
    }
  } catch {
    // fall through: run unlocked
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch {}
    }
  }
}

export function readSnapshot(ctx: Ctx, sessionId: string): Snapshot | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file(ctx, sessionId, ".statusline.json"), "utf8"));
    return isObj(raw) && typeof raw.at === "string" ? (raw as unknown as Snapshot) : undefined;
  } catch {
    return undefined;
  }
}
