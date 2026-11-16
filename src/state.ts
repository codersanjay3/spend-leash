// Per-session state files: sessions/<id>.json, <id>.statusline.json, and the <id>.lock mkdir lock.
import {
  appendFileSync,
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
import { type Ctx, errorsLog, sessionDir } from "./paths.js";
import type { SessionState, Snapshot, Task } from "./tasks.js";
import type { SpendCache } from "./transcript.js";

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

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || fin(v);
const OUTCOMES = ["completed", "stopped-budget", "stopped-plan", "stopped-loop", "error"];

function validTask(t: unknown): t is Task {
  if (!isObj(t)) return false;
  const bt = t.baseTokens;
  return (
    typeof t.id === "string" &&
    typeof t.startedAt === "string" &&
    typeof t.prompt === "string" &&
    numOrNull(t.limitUsd) &&
    numOrNull(t.limitPlanPct) &&
    numOrNull(t.basePlanPct) &&
    fin(t.baseUsd) &&
    isObj(bt) &&
    ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"].every((k) => fin(bt[k])) &&
    typeof t.warned === "boolean" &&
    (t.outcome === undefined || (typeof t.outcome === "string" && OUTCOMES.includes(t.outcome))) &&
    (t.reason === undefined || typeof t.reason === "string")
  );
}

function validLoop(l: unknown): l is SessionState["loop"] {
  return (
    isObj(l) &&
    Array.isArray(l.calls) &&
    l.calls.every((c) => typeof c === "string") &&
    isObj(l.failures) &&
    Object.values(l.failures).every(fin)
  );
}

function validPlanGuard(g: unknown): g is SessionState["planGuard"] {
  return (
    isObj(g) &&
    typeof g.off === "boolean" &&
    (g.trippedFor === undefined || typeof g.trippedFor === "string")
  );
}

/** Keeps what is valid and drops only the bad sub-object. */
function sanitize(v: unknown, sessionId: string): SessionState | undefined {
  if (!isObj(v) || v.sessionId !== sessionId || typeof v.cwd !== "string") return undefined;
  const out = defaultState(sessionId);
  out.cwd = v.cwd;
  if (fin(v.taskSeq) && Number.isInteger(v.taskSeq) && v.taskSeq >= 0) out.taskSeq = v.taskSeq;
  if (validLoop(v.loop)) out.loop = v.loop;
  if (validPlanGuard(v.planGuard)) out.planGuard = v.planGuard;
  if (validTask(v.task)) out.task = v.task;
  if (isObj(v.spend) && isObj(v.spend.files)) out.spend = v.spend as unknown as SpendCache;
  if (typeof v.noPlanDataShown === "boolean") out.noPlanDataShown = v.noPlanDataShown;
  return out;
}

/**
 * Never throws. A missing file is a normal fresh state; an unreadable, malformed or
 * mismatched file yields a fresh default state plus `corrupt` (the reason), so callers can log it.
 */
export function readSessionChecked(
  ctx: Ctx,
  sessionId: string,
): { state: SessionState; corrupt?: string } {
  let text: string;
  try {
    text = readFileSync(file(ctx, sessionId, ".json"), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { state: defaultState(sessionId) }
      : { state: defaultState(sessionId), corrupt: `unreadable (${code ?? "error"})` };
  }
  try {
    const st = sanitize(JSON.parse(text) as unknown, sessionId);
    if (st) return { state: st };
    return { state: defaultState(sessionId), corrupt: "unexpected shape" };
  } catch {
    return { state: defaultState(sessionId), corrupt: "not valid JSON" };
  }
}

/** Never throws: a missing, unreadable or malformed file yields a fresh default state. */
export function readSession(ctx: Ctx, sessionId: string): SessionState {
  return readSessionChecked(ctx, sessionId).state;
}

export function atomicWrite(dir: string, target: string, data: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/** Atomic (temp file in the same dir + rename); dirs 0700, file 0600 on POSIX. */
export function writeSession(ctx: Ctx, s: SessionState): void {
  atomicWrite(sessionDir(ctx, s.sessionId), file(ctx, s.sessionId, ".json"), JSON.stringify(s));
}

/** Same atomic 0600 write as writeSession, for the status-line snapshot. */
export function writeSnapshot(ctx: Ctx, sessionId: string, snap: Snapshot): void {
  atomicWrite(
    sessionDir(ctx, sessionId),
    file(ctx, sessionId, ".statusline.json"),
    JSON.stringify(snap),
  );
}

/** Appends one `<iso> <msg>` line to errors.log; never throws. */
export function appendError(ctx: Ctx, msg: string): void {
  try {
    mkdirSync(ctx.leashHome, { recursive: true, mode: 0o700 });
    appendFileSync(errorsLog(ctx), `${ctx.now().toISOString()} ${msg.replace(/\s+/g, " ")}\n`, {
      mode: 0o600,
    });
  } catch {}
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
    if (!isObj(raw) || typeof raw.at !== "string") return undefined;
    const out: Snapshot = { at: raw.at };
    if (fin(raw.fiveHourPct)) out.fiveHourPct = raw.fiveHourPct;
    if (typeof raw.fiveHourResetsAt === "string") out.fiveHourResetsAt = raw.fiveHourResetsAt;
    if (fin(raw.sevenDayPct)) out.sevenDayPct = raw.sevenDayPct;
    if (fin(raw.costUsd)) out.costUsd = raw.costUsd;
    if (typeof raw.model === "string") out.model = raw.model;
    return out;
  } catch {
    return undefined;
  }
}
