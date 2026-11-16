// Pure secret redaction for previews (no node:* imports; the browser simulator bundles this).
// Ported from mcp-leash src/hook-core.ts, plus `password=value`-style assignments inside strings.
const SECRET_KEY = /token|secret|password|key|auth/i;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_VALUE =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
const ASSIGNED_SECRET =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{0,40}(?:token|password|passwd|secret|api[_-]?key|auth)\s*[=:]\s*)[^\s&"']+/gi;
const SECRET_FLAG = /(--(?:password|passwd|token|api-key|apikey|secret)(?:=|\s+))[^\s"']+/gi;
const REDACTED = "[REDACTED]";

export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") {
    return value
      .replace(SECRET_VALUE, REDACTED)
      .replace(URL_CREDS, `$1${REDACTED}@`)
      .replace(BEARER, `$1 ${REDACTED}`)
      .replace(ASSIGNED_SECRET, `$1${REDACTED}`)
      .replace(SECRET_FLAG, `$1${REDACTED}`);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth > 6) return "[Deep]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, seen, depth + 1);
  }
  return out;
}

export function argsPreview(args: unknown, max = 300): string {
  if (args === undefined) return "";
  let s: string;
  try {
    s = JSON.stringify(redact(args)) ?? "";
  } catch {
    s = "[unserializable]";
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
