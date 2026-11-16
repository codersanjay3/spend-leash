// Handoff I/O: write, discover and consume handoff files. Rendering is in handoff-render.ts.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { lastTodosFrom, recentCallsFrom } from "./handoff-render.js";
import type { Ctx } from "./paths.js";
import { atomicWrite } from "./state.js";

export { type HandoffData, renderHandoff } from "./handoff-render.js";

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PREVIEW_CHARS = 1500;
const FALLBACK_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "ENOSPC"]);

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function writeUnique(dir: string, base: string, markdown: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 1; ; i++) {
    const path = join(dir, i === 1 ? `${base}.md` : `${base}-${i}.md`);
    try {
      writeFileSync(path, markdown, { mode: 0o600, flag: "wx" });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i > 1000) throw e;
    }
  }
}

/** Writes into `<cwd>/<handoff.dir>`; falls back to `<leashHome>/handoffs` when that is not writable. */
export function writeHandoff(
  ctx: Ctx,
  cwd: string,
  cfg: Config,
  markdown: string,
  now: Date,
  reason: string,
): string {
  const slug =
    reason
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "handoff";
  const base = `${stamp(now)}-${slug}`;
  try {
    if (!statSync(cwd).isDirectory())
      throw Object.assign(new Error("not a directory"), { code: "ENOENT" });
    return writeUnique(join(cwd, cfg.handoff.dir), base, markdown);
  } catch (e) {
    if (!FALLBACK_CODES.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    return writeUnique(join(ctx.leashHome, "handoffs"), base, markdown);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    timeout: 400,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function gitInfo(cwd: string): { status: string; diffStat: string } | undefined {
  try {
    return { status: git(cwd, ["status", "--short"]), diffStat: git(cwd, ["diff", "--stat"]) };
  } catch {
    return undefined;
  }
}

/** Complete JSON lines from the last ≤ maxBytes of a file; the partial first line is dropped. */
function tailLines(path: string, maxBytes = TAIL_BYTES): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/** Parsed JSON records from the transcript tail (≤ 2 MB); unreadable file or bad lines are skipped. */
export function readTail(transcriptPath: string): unknown[] {
  let lines: string[];
  try {
    lines = tailLines(transcriptPath);
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function recentToolCalls(
  transcript: string | unknown[],
  n = 10,
): { tool: string; args: unknown }[] {
  return recentCallsFrom(typeof transcript === "string" ? readTail(transcript) : transcript, n);
}

/** The last TodoWrite list as `[status] content` strings; undefined when there is none. */
export function lastTodos(transcript: string | unknown[]): string[] | undefined {
  return lastTodosFrom(typeof transcript === "string" ? readTail(transcript) : transcript);
}

const consumedFile = (ctx: Ctx) => join(ctx.leashHome, "consumed.json");

function readConsumed(ctx: Ctx): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(consumedFile(ctx), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === "string" && existsSync(p));
  } catch {
    return [];
  }
}

export function markConsumed(ctx: Ctx, path: string): void {
  const list = readConsumed(ctx);
  if (!list.includes(path)) list.push(path);
  atomicWrite(ctx.leashHome, consumedFile(ctx), JSON.stringify(list));
}

function metaCwd(firstLine: string): string | undefined {
  const m = /^<!-- spend-leash handoff cwd=("(?:[^"\\]|\\.)*") session=/.exec(firstLine);
  if (!m?.[1]) return undefined;
  try {
    const v: unknown = JSON.parse(m[1]);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function pendingHandoff(
  ctx: Ctx,
  cwd: string,
  now: Date,
  cfg?: Pick<Config, "handoff">,
): { path: string; preview: string } | undefined {
  const consumed = new Set(readConsumed(ctx));
  const dirs = [
    { dir: join(cwd, cfg?.handoff.dir ?? ".spend-leash/handoffs"), needMatch: false },
    { dir: join(ctx.leashHome, "handoffs"), needMatch: true },
  ];
  const found: { path: string; mtime: number; needMatch: boolean }[] = [];
  for (const { dir, needMatch } of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (consumed.has(path)) continue;
      try {
        const mtime = statSync(path).mtimeMs;
        if (now.getTime() - mtime < MAX_AGE_MS) found.push({ path, mtime, needMatch });
      } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? 1 : -1));
  let top: { path: string; text: string } | undefined;
  for (const f of found) {
    try {
      const text = readFileSync(f.path, "utf8");
      const nl = text.indexOf("\n");
      if (f.needMatch && metaCwd(nl < 0 ? text : text.slice(0, nl)) !== cwd) continue;
      top = { path: f.path, text };
      break;
    } catch {}
  }
  if (!top) return undefined;
  const body = top.text.startsWith("<!--") ? top.text.slice(top.text.indexOf("\n") + 1) : top.text;
  return { path: top.path, preview: body.trim().slice(0, PREVIEW_CHARS) };
}
