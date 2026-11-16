// Pure helpers for the status-line wrapper (no I/O).
import type { SessionState, Snapshot } from "./tasks.js";
import { isObj } from "./util.js";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** ISO string or unix seconds -> ISO string; anything else is ignored. */
function resetIso(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  if (fin(v)) {
    const d = new Date(v * 1000);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  return undefined;
}

export function snapshotFrom(input: unknown, now: Date): Snapshot {
  const snap: Snapshot = { at: now.toISOString() };
  if (!isObj(input)) return snap;
  const rl = isObj(input.rate_limits) ? input.rate_limits : {};
  const five = isObj(rl.five_hour) ? rl.five_hour : {};
  const seven = isObj(rl.seven_day) ? rl.seven_day : {};
  if (fin(five.used_percentage)) snap.fiveHourPct = five.used_percentage;
  const reset = resetIso(five.resets_at);
  if (reset) snap.fiveHourResetsAt = reset;
  if (fin(seven.used_percentage)) snap.sevenDayPct = seven.used_percentage;
  if (isObj(input.cost) && fin(input.cost.total_cost_usd)) snap.costUsd = input.cost.total_cost_usd;
  if (isObj(input.model) && typeof input.model.id === "string") snap.model = input.model.id;
  return snap;
}

/** Shown only when the user has no original status line. Cheap: never reads transcripts. */
export function ownLine(s: SessionState | undefined, snap: Snapshot): string {
  const parts = ["spend-leash"];
  if (fin(snap.fiveHourPct)) parts.push(`5h ${Math.round(snap.fiveHourPct)}%`);
  const limit = s?.task?.limitUsd;
  if (fin(limit)) parts.push(`task limit $${limit.toFixed(2)}`);
  return parts.join(" · ");
}
