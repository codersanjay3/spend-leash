// Pure task lifecycle: no node:fs (the browser simulator bundles this). I/O lives in state.ts.
import type { Config } from "./config.js";
import type { Directive } from "./directives.js";
import type { UsageTotals } from "./pricing.js";
import type { SpendCache } from "./transcript.js";

export interface Snapshot {
  at: string;
  fiveHourPct?: number;
  fiveHourResetsAt?: string;
  sevenDayPct?: number;
  costUsd?: number;
  model?: string;
}

export type Outcome = "completed" | "stopped-budget" | "stopped-plan" | "stopped-loop" | "error";

export interface Task {
  id: string;
  startedAt: string;
  prompt: string;
  limitUsd: number | null;
  limitPlanPct: number | null;
  baseUsd: number;
  baseTokens: UsageTotals;
  basePlanPct: number | null;
  warned: boolean;
  outcome?: Outcome;
  reason?: string;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  spend?: SpendCache;
  task?: Task;
  /** Number of tasks started in this session; feeds task ids. */
  taskSeq: number;
  loop: { calls: string[]; failures: Record<string, number> };
  planGuard: { off: boolean; trippedFor?: string };
  noPlanDataShown?: boolean;
}

export interface StartOpts {
  prompt: string;
  directive?: Directive;
  config: Config;
  spendUsd: number;
  tokens: UsageTotals;
  snapshot?: Snapshot;
  now: Date;
}

const FRESH_MS = 10 * 60_000;

export function isFresh(s: Snapshot, now: Date): boolean {
  const at = Date.parse(s.at);
  return Number.isFinite(at) && now.getTime() - at < FRESH_MS;
}

function freshPct(snapshot: Snapshot | undefined, now: Date): number | null {
  return snapshot && isFresh(snapshot, now) && typeof snapshot.fiveHourPct === "number"
    ? snapshot.fiveHourPct
    : null;
}

function newTask(s: SessionState, o: StartOpts, seq: number): Task {
  const d = o.directive;
  let limitUsd = o.config.task.usd;
  let limitPlanPct = o.config.task.planPct;
  if (d?.kind === "set") {
    if (d.usd !== undefined) limitUsd = d.usd;
    if (d.planPct !== undefined) limitPlanPct = d.planPct;
  } else if (d?.kind === "off") {
    limitUsd = null;
    limitPlanPct = null;
  } else if (d?.kind === "add") {
    limitUsd = (o.config.task.usd ?? 0) + d.usd;
  }
  return {
    id: `${s.sessionId.slice(0, 8)}-${seq}`,
    startedAt: o.now.toISOString(),
    prompt: o.prompt.slice(0, 200),
    limitUsd,
    limitPlanPct,
    baseUsd: o.spendUsd,
    baseTokens: { ...o.tokens },
    basePlanPct: freshPct(o.snapshot, o.now),
    warned: false,
  };
}

/** The same task, running again: outcome/reason/warned cleared, baseline kept. */
function resume(t: Task, limits?: Partial<Pick<Task, "limitUsd" | "limitPlanPct">>): Task {
  const { outcome: _o, reason: _r, ...rest } = t;
  return { ...rest, ...limits, warned: false };
}

/**
 * Applies a new prompt to the session. Returns a new state; the input is not mutated.
 * Strict budget rule: after `stopped-budget`, only `set`, `add`, `off` or `new` change the task.
 */
export function startTask(s: SessionState, o: StartOpts): SessionState {
  const planGuard = o.directive?.kind === "plan-off" ? { ...s.planGuard, off: true } : s.planGuard;
  const d = o.directive?.kind === "plan-off" ? undefined : o.directive;
  const prev = s.task;
  const base: SessionState = { ...s, planGuard, loop: { ...s.loop } };
  const fresh = (): SessionState => {
    const seq = s.taskSeq + 1;
    return {
      ...base,
      taskSeq: seq,
      task: newTask(s, { ...o, ...(d ? { directive: d } : { directive: undefined }) }, seq),
      loop: { calls: [], failures: {} },
    };
  };
  const keep = (t: Task, loop = base.loop): SessionState => ({ ...base, task: t, loop });

  if (!prev || d?.kind === "new") return fresh();

  if (prev.outcome === "stopped-budget") {
    if (!d) return keep(prev);
    if (d.kind === "set") {
      return keep(
        resume(prev, {
          limitUsd: d.usd ?? prev.limitUsd,
          limitPlanPct: d.planPct ?? prev.limitPlanPct,
        }),
      );
    }
    if (d.kind === "off") return keep(resume(prev, { limitUsd: null, limitPlanPct: null }));
    if (d.kind === "add") {
      return keep(resume(prev, { limitUsd: (prev.limitUsd ?? o.config.task.usd ?? 0) + d.usd }));
    }
  }

  if (prev.outcome === "stopped-plan" || prev.outcome === "stopped-loop") {
    if (d?.kind === "add") {
      return keep(resume(prev, { limitUsd: (prev.limitUsd ?? o.config.task.usd ?? 0) + d.usd }));
    }
    // Its budget was not the problem: a plain prompt carries on with loop history cleared.
    if (!d && prev.outcome === "stopped-loop") {
      return keep(resume(prev), { calls: [], failures: {} });
    }
  }

  return fresh();
}

/**
 * Spend attributed to the current task. If the task has no plan baseline yet and a fresh
 * snapshot exists, baselines now (mutates `s.task.basePlanPct`) and reports 0.
 */
export function taskSpend(
  s: SessionState,
  spendUsd: number,
  snapshot?: Snapshot,
  now: Date = new Date(),
): { usd: number; planPct: number | null } {
  const t = s.task;
  if (!t) return { usd: 0, planPct: null };
  const usd = Math.max(0, spendUsd - t.baseUsd);
  const pct = freshPct(snapshot, now);
  if (pct === null) return { usd, planPct: null };
  if (t.basePlanPct === null) {
    t.basePlanPct = pct;
    return { usd, planPct: 0 };
  }
  return { usd, planPct: pct - t.basePlanPct };
}
