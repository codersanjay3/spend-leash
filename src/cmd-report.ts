import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type CommandEnv, parseFlags, truncate, UsageError, usd } from "./cli-common.js";
import { ledgerPath } from "./paths.js";
import type { LedgerLine } from "./types.js";

/** Calls `onLine` for each line, reading in chunks so memory does not scale with file size. */
function eachLine(path: string, onLine: (line: string) => void): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    const dec = new StringDecoder("utf8");
    const buf = Buffer.alloc(64 * 1024);
    let rest = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const parts = (rest + dec.write(buf.subarray(0, n))).split("\n");
      rest = parts.pop() ?? "";
      for (const l of parts) onLine(l);
    }
    onLine(rest + dec.end());
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  } finally {
    closeSync(fd);
  }
}

function readLedger(path: string): LedgerLine[] {
  // dedupe by taskId, keeping the LAST line
  const byId = new Map<string, LedgerLine>();
  eachLine(path, (line) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line) as Partial<LedgerLine> | null;
      if (
        v &&
        typeof v === "object" &&
        typeof v.taskId === "string" &&
        typeof v.ts === "string" &&
        Number.isFinite(Date.parse(v.ts)) &&
        typeof v.usd === "number" &&
        Number.isFinite(v.usd)
      ) {
        byId.delete(v.taskId);
        byId.set(v.taskId, v as LedgerLine);
      }
    } catch {
      /* bad line: skip */
    }
  });
  return [...byId.values()];
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localWhen = (d: Date) => `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export async function cmdReport(argv: string[], env: CommandEnv): Promise<number> {
  const f = parseFlags(argv, {
    n: { type: "string", short: "n" },
    json: { type: "boolean" },
    today: { type: "boolean" },
  });
  let limit = 20;
  if (f.n !== undefined) {
    if (!/^\d+$/.test(f.n) || Number(f.n) < 1)
      throw new UsageError("-n must be a positive integer");
    limit = Number(f.n);
  }
  const now = env.ctx.now();
  let rows = readLedger(ledgerPath(env.ctx));
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)); // stable: ties keep file order
  if (f.today) rows = rows.filter((r) => localDate(new Date(r.ts)) === localDate(now));
  rows = rows.slice(0, limit);
  const total = Math.round(rows.reduce((s, r) => s + r.usd, 0) * 100) / 100;

  if (f.json) {
    console.log(JSON.stringify({ tasks: rows, totals: { usd: total, tasks: rows.length } }));
    return 0;
  }
  if (rows.length === 0) {
    console.log("No tasks recorded yet.");
    return 0;
  }
  const cells = rows.map((r) => [
    localWhen(new Date(r.ts)),
    r.outcome,
    usd(r.usd),
    truncate(r.prompt, 50),
  ]);
  const head = ["when", "outcome", "usd", "prompt"];
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const fmt = (c: string[]) =>
    c
      .map((x, i) => (i === 2 ? x.padStart(w[i] ?? 0) : x.padEnd(w[i] ?? 0)))
      .join("  ")
      .trimEnd();
  console.log(fmt(head));
  for (const c of cells) console.log(fmt(c));
  console.log(`${rows.length} ${rows.length === 1 ? "task" : "tasks"} · ${usd(total)}`);
  return 0;
}
