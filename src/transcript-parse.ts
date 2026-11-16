// Pure transcript-line parsing: no node:* imports (the browser simulator bundles this file).
// transcript.ts does the incremental file reading and calls usageFromLine for each line.
import type { UsageTotals } from "./pricing.js";

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

/**
 * Usage of one assistant transcript line, or undefined when the line carries none (or is not
 * valid JSON). `id` is the dedupe key (message id, else `uuid:<uuid>`); "" when the line has
 * neither, in which case it cannot be deduplicated.
 */
export function usageFromLine(
  line: string,
): { id: string; model: string; usage: UsageTotals } | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== "assistant") return undefined;
  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return undefined;
  const usage = msg.usage;
  if (!usage || typeof usage !== "object") return undefined;

  let id = "";
  if (typeof msg.id === "string" && msg.id) id = msg.id;
  else if (typeof rec.uuid === "string" && rec.uuid) id = `uuid:${rec.uuid}`;
  const model = typeof msg.model === "string" && msg.model ? msg.model : "unknown";
  return { id, model, usage: parseUsage(usage as Record<string, unknown>) };
}
