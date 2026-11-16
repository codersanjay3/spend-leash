import type { Config } from "./config.js";
import type { SessionState } from "./tasks.js";

// Pure: no node:fs / node:crypto (the browser simulator bundles this file).

export const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
export const IGNORED_BY_DEFAULT = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];

type Loop = SessionState["loop"];
export type LoopVerdict = "ok" | "warn" | "stop";

const MAX_DEPTH = 64;

/** Total canonicalization: never throws (depth cap, cycle marker, BigInt support). */
function canon(v: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): string {
  if (typeof v === "bigint") return `"${v.toString()}n"`;
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (seen.has(v)) return '"<cycle>"';
  if (depth >= MAX_DEPTH) return '"<deep>"';
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      return `[${v.map((x) => (x === undefined ? "null" : canon(x, depth + 1, seen))).join(",")}]`;
    }
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k], depth + 1, seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(v);
  }
}

/** cyrb53: fast pure-JS 53-bit hash. Not cryptographic; only used to compare calls. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** `<toolName>:<hash>` of the canonical input. Bash uses only `command`, whitespace collapsed. */
export function fingerprint(toolName: string, toolInput: unknown): string {
  let body: string;
  try {
    const cmd = (toolInput as { command?: unknown } | null | undefined)?.command;
    body =
      toolName === "Bash" && typeof cmd === "string"
        ? cmd.replace(/\s+/g, " ").trim()
        : canon(toolInput);
  } catch {
    body = "<unserializable>";
  }
  return `${toolName}:${hash53(body)}`;
}

export function recordCall(
  loop: Loop,
  toolName: string,
  toolInput: unknown,
  cfg: Config["loop"],
): { loop: Loop; verdict: LoopVerdict; count: number } {
  if (WRITE_TOOLS.includes(toolName)) {
    return { loop: { calls: [], failures: {} }, verdict: "ok", count: 0 };
  }
  if (IGNORED_BY_DEFAULT.includes(toolName) || cfg.ignoreTools.includes(toolName)) {
    return {
      loop: { calls: [...loop.calls], failures: { ...loop.failures } },
      verdict: "ok",
      count: 0,
    };
  }
  const fp = fingerprint(toolName, toolInput);
  const calls = [...loop.calls, fp].slice(-cfg.window);
  const present = new Set(calls);
  const failures: Record<string, number> = {};
  for (const [k, n] of Object.entries(loop.failures)) if (present.has(k)) failures[k] = n;
  const count = calls.filter((c) => c === fp).length + (failures[fp] ?? 0);
  const verdict: LoopVerdict = count >= cfg.stopAt ? "stop" : count >= cfg.warnAt ? "warn" : "ok";
  return { loop: { calls, failures }, verdict, count };
}

export function recordFailure(loop: Loop, toolName: string, toolInput: unknown): Loop {
  const fp = fingerprint(toolName, toolInput);
  // A failure only counts while its call is still in the window.
  if (!loop.calls.includes(fp)) return { calls: [...loop.calls], failures: { ...loop.failures } };
  return {
    calls: [...loop.calls],
    failures: { ...loop.failures, [fp]: (loop.failures[fp] ?? 0) + 1 },
  };
}
