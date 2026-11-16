// Pure shared helpers (no node:* imports; the browser simulator bundles this).
export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
