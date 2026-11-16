// Incremental transcript spend reader. Hot path of every hook call: sync fs only,
// reads only bytes appended since the cursor, parses only candidate lines.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { addUsage, costUsd, type Price, priceFor, type UsageTotals, ZERO } from "./pricing.js";

export interface FileCursor {
  offset: number;
  partial: string;
  ids: string[];
  byModel: Record<string, UsageTotals>;
  /** First bytes of the file (latin1), to detect a same-path replacement that is not shorter. */
  head?: string;
}

export interface SpendCache {
  files: Record<string, FileCursor>;
}

export interface SpendResult {
  cache: SpendCache;
  usd: number;
  tokens: UsageTotals;
  estimated: boolean;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function parseUsage(usage: Record<string, unknown>): UsageTotals {
  const cc = usage.cache_creation;
  let cacheWrite5m: number;
  let cacheWrite1h = 0;
  if (cc && typeof cc === "object") {
    const o = cc as Record<string, unknown>;
    cacheWrite5m = num(o.ephemeral_5m_input_tokens);
    cacheWrite1h = num(o.ephemeral_1h_input_tokens);
  } else {
    cacheWrite5m = num(usage.cache_creation_input_tokens);
  }
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: num(usage.cache_read_input_tokens),
  };
}

function listFiles(transcriptPath: string): string[] {
  const files = [transcriptPath];
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  try {
    const subs = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    for (const f of subs) files.push(join(dir, f));
  } catch {
    // no subagents dir
  }
  return files;
}

function readRange(path: string, from: number, to: number): Buffer {
  const buf = Buffer.allocUnsafe(to - from);
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const HEAD_BYTES = 64;

function readHead(path: string, n: number): string {
  return readRange(path, 0, n).toString("latin1");
}

const USAGE_KEYS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Returns a deep copy of a trusted-shape cursor, or undefined if the shape is invalid. */
function cloneCursor(v: unknown): FileCursor | undefined {
  if (!isObj(v)) return undefined;
  const { offset, partial, ids, byModel, head } = v;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return undefined;
  if (typeof partial !== "string") return undefined;
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) return undefined;
  if (head !== undefined && typeof head !== "string") return undefined;
  if (!isObj(byModel)) return undefined;
  const bm = dict<UsageTotals>();
  for (const m of Object.keys(byModel)) {
    const u = byModel[m];
    if (!isObj(u)) return undefined;
    const t = { ...ZERO };
    for (const k of USAGE_KEYS) {
      const n = u[k];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
      t[k] = n;
    }
    bm[m] = t;
  }
  return { offset, partial, ids: [...(ids as string[])], byModel: bm, head };
}

function sameHead(path: string, c: FileCursor): boolean {
  if (c.offset === 0 || !c.head) return true;
  try {
    return readHead(path, c.head.length) === c.head;
  } catch {
    return false;
  }
}

function processLine(line: string, cur: FileCursor, seen: Set<string>): void {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!obj || typeof obj !== "object") return;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== "assistant") return;
  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return;
  const usage = msg.usage;
  if (!usage || typeof usage !== "object") return;

  let key: string | undefined;
  if (typeof msg.id === "string" && msg.id) key = msg.id;
  else if (typeof rec.uuid === "string" && rec.uuid) key = `uuid:${rec.uuid}`;
  if (key !== undefined) {
    if (seen.has(key)) return;
    seen.add(key);
    cur.ids.push(key);
  }
  const model = typeof msg.model === "string" && msg.model ? msg.model : "unknown";
  const u = parseUsage(usage as Record<string, unknown>);
  cur.byModel[model] = addUsage(cur.byModel[model] ?? ZERO, u);
}

export function readSpend(
  transcriptPath: string,
  cache?: SpendCache,
  prices?: Record<string, Price>,
): SpendResult {
  const files = listFiles(transcriptPath);
  const next: SpendCache = { files: {} };
  const sizes = new Map<string, number>();
  const oldFiles = isObj(cache) && isObj(cache.files) ? cache.files : undefined;

  // Pass 1: stat; keep cursors only for files that still exist and did not shrink.
  for (const f of files) {
    let size: number;
    try {
      const st = statSync(f);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    sizes.set(f, size);
    const old = oldFiles ? cloneCursor(oldFiles[f]) : undefined;
    if (old && size >= old.offset && sameHead(f, old)) next.files[f] = old;
  }

  const seen = new Set<string>();
  for (const c of Object.values(next.files)) for (const id of c.ids) seen.add(id);

  // Pass 2: read appended bytes.
  for (const f of files) {
    const size = sizes.get(f);
    if (size === undefined) continue;
    const cur = next.files[f] ?? { offset: 0, partial: "", ids: [], byModel: dict<UsageTotals>() };
    next.files[f] = cur;
    if (size === cur.offset) continue;
    let chunk: Buffer;
    try {
      chunk = readRange(f, cur.offset, size);
    } catch {
      continue;
    }
    const data = cur.partial ? Buffer.concat([Buffer.from(cur.partial, "latin1"), chunk]) : chunk;
    const nl = data.lastIndexOf(0x0a);
    if (nl === -1) {
      cur.partial = data.toString("latin1");
    } else {
      const lines = data.toString("utf8", 0, nl).split("\n");
      for (const line of lines) processLine(line, cur, seen);
      cur.partial = data.toString("latin1", nl + 1);
    }
    if (cur.offset === 0) cur.head = data.toString("latin1", 0, Math.min(HEAD_BYTES, data.length));
    cur.offset += chunk.length;
  }

  const totalsByModel = dict<UsageTotals>();
  let tokens = ZERO;
  for (const c of Object.values(next.files)) {
    for (const [m, u] of Object.entries(c.byModel)) {
      totalsByModel[m] = addUsage(totalsByModel[m] ?? ZERO, u);
      tokens = addUsage(tokens, u);
    }
  }
  let usd = 0;
  let estimated = false;
  for (const [m, u] of Object.entries(totalsByModel)) {
    const { price, estimated: est } = priceFor(m, prices);
    const c = costUsd(u, price);
    if (!Number.isFinite(c)) {
      estimated = true;
      continue;
    }
    usd += c;
    if (est && c > 0) estimated = true;
  }
  return { cache: next, usd, tokens, estimated };
}
