// Pure enforcement logic: no node:* imports (the browser simulator bundles this file).
// engine.ts does the I/O and performs the returned effects.
import type { Config } from "./config.js";
import { parseDirective } from "./directives.js";
import { recordCall, recordFailure } from "./loop.js";
import type { UsageTotals } from "./pricing.js";
import { redact } from "./redact.js";
import {
  isFresh,
  type Outcome,
  type SessionState,
  type Snapshot,
  startTask,
  taskSpend,
} from "./tasks.js";
import type { HookInput, LedgerLine } from "./types.js";
import { isObj } from "./util.js";

/** Replaced by engine.ts with the written handoff path (or a "(not written: ...)" note). */
export const HANDOFF_PLACEHOLDER = "<HANDOFF>";

export type Effect =
  | { kind: "handoff"; reason: "budget" | "plan" | "loop" | "error"; detail: string }
  | { kind: "ledger"; line: LedgerLine }
  | { kind: "consume"; path: string };

export interface StepEnv {
  config: Config;
  spendUsd: number;
  tokens: UsageTotals;
  estimated: boolean;
  snapshot?: Snapshot;
  now: Date;
  pending?: { path: string; preview: string };
}

export interface StepResult {
  state: SessionState;
  output?: Record<string, unknown>;
  effects: Effect[];
}

const STOPS: Outcome[] = ["stopped-budget", "stopped-plan", "stopped-loop"];
const isStop = (o: Outcome | undefined): boolean => o !== undefined && STOPS.includes(o);

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number): string => String(Math.round(n * 10) / 10);

/** The deny/stop JSON for a stopped task. */
export function stopOutput(event: string, msg: string): Record<string, unknown> {
  if (event === "PostToolBatch") {
    return { continue: false, stopReason: msg, decision: "block", reason: msg };
  }
  return {
    continue: false,
    stopReason: msg,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: msg,
    },
  };
}

function resetsText(iso: string | undefined): string {
  if (!iso) return "when the window rolls over";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function freshPlan(s: Snapshot | undefined, now: Date): { pct: number; key: string } | undefined {
  if (!s || !isFresh(s, now) || typeof s.fiveHourPct !== "number") return undefined;
  return { pct: s.fiveHourPct, key: s.fiveHourResetsAt ?? "window" };
}

function cloneState(s: SessionState, cwd: string): SessionState {
  return {
    ...s,
    cwd: cwd || s.cwd,
    loop: { calls: [...s.loop.calls], failures: { ...s.loop.failures } },
    planGuard: { ...s.planGuard },
    ...(s.task ? { task: { ...s.task } } : {}),
  };
}

function ctxOut(event: string, additionalContext: string, extra?: Record<string, unknown>) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext }, ...extra };
}

function ensureTask(s: SessionState, env: StepEnv): SessionState {
  if (s.task) return s;
  return startTask(s, {
    prompt: "(task began before spend-leash saw a prompt)",
    config: env.config,
    spendUsd: env.spendUsd,
    tokens: env.tokens,
    ...(env.snapshot ? { snapshot: env.snapshot } : {}),
    now: env.now,
  });
}

function onPrompt(state: SessionState, input: HookInput, env: StepEnv): StepResult {
  const prompt = input.prompt ?? "";
  const directive = parseDirective(prompt);
  const prev = state.task;
  const s = startTask(state, {
    prompt,
    ...(directive ? { directive } : {}),
    config: env.config,
    spendUsd: env.spendUsd,
    tokens: env.tokens,
    ...(env.snapshot ? { snapshot: env.snapshot } : {}),
    now: env.now,
  });
  const t = s.task;
  const messages: string[] = [];
  let context: string | undefined;

  if (prev && t && prev.id === t.id && isStop(prev.outcome) && (!directive || isStop(t.outcome))) {
    if (prev.outcome === "stopped-loop") {
      context = "spend-leash: continuing the task after a loop stop; loop history cleared.";
    } else {
      const spent = Math.max(0, env.spendUsd - t.baseUsd);
      const ofLimit = t.limitUsd !== null ? ` of ${usd(t.limitUsd)}` : "";
      context = `spend-leash: continuing the stopped task (${usd(spent)}${ofLimit}). Use "#budget +$N" for more or "#budget new" to start fresh.`;
    }
    messages.push(context);
  }

  const plan = freshPlan(env.snapshot, env.now);
  if (plan && !s.planGuard.off && plan.pct >= env.config.plan.stopAtPct) {
    if (s.planGuard.trippedFor === plan.key) {
      messages.push(
        `spend-leash: 5-hour plan window at ${pct(plan.pct)}% (stop at ${env.config.plan.stopAtPct}%). Continuing because you already saw the stop; reply "#budget plan-off" to silence this.`,
      );
    }
  }

  if (t && t.limitPlanPct !== null && !plan && !s.noPlanDataShown) {
    s.noPlanDataShown = true;
    messages.push(
      "spend-leash: plan-% budget inactive: no plan data yet (the status line has not reported usage). Any $ budget still applies.",
    );
  }

  if (messages.length === 0) return { state: s, effects: [] };
  const systemMessage = messages.join("\n");
  const output = context
    ? ctxOut("UserPromptSubmit", context, { systemMessage })
    : { systemMessage };
  return { state: s, output, effects: [] };
}

function check(
  state: SessionState,
  input: HookInput,
  env: StepEnv,
  kind: "PreToolUse" | "PostToolBatch",
): StepResult {
  let s = ensureTask(state, env);
  const t = s.task;
  if (!t) return { state: s, effects: [] };
  if (isStop(t.outcome)) {
    const msg = t.reason ?? `spend-leash: task stopped (${t.outcome}).`;
    return { state: s, output: stopOutput(kind, msg), effects: [] };
  }

  const spend = taskSpend(s, env.spendUsd, env.snapshot, env.now);
  const cfg = env.config;
  let verdict: "ok" | "warn" | "stop" = "ok";
  let loopCount = 0;
  if (kind === "PreToolUse" && input.tool_name) {
    const r = recordCall(s.loop, input.tool_name, input.tool_input, cfg.loop);
    s = { ...s, loop: r.loop };
    verdict = r.verdict;
    loopCount = r.count;
  }
  const tool = input.tool_name ?? "tool";
  const hand = HANDOFF_PLACEHOLDER;

  const stop = (
    outcome: Outcome,
    reason: "budget" | "plan" | "loop",
    msg: string,
    detail: string,
  ) => {
    t.outcome = outcome;
    t.reason = msg;
    return {
      state: s,
      output: stopOutput(kind, msg),
      effects: [{ kind: "handoff", reason, detail } as Effect],
    };
  };

  // Budget stop.
  const usdHit = t.limitUsd !== null && spend.usd >= t.limitUsd;
  const planHit =
    t.limitPlanPct !== null && spend.planPct !== null && spend.planPct >= t.limitPlanPct;
  if (usdHit || planHit) {
    if (usdHit && t.limitUsd !== null) {
      const msg = `spend-leash: task budget ${usd(t.limitUsd)} reached (${usd(spend.usd)}). Handoff: ${hand}. Reply "#budget +${usd(t.limitUsd)}" to continue this task or "#budget new" to start fresh.`;
      return stop("stopped-budget", "budget", msg, `${usd(spend.usd)} of ${usd(t.limitUsd)}`);
    }
    const lim = t.limitPlanPct ?? 0;
    const used = spend.planPct ?? 0;
    const msg = `spend-leash: task plan budget ${pct(lim)}% of the 5-hour window reached (${pct(used)}% used, ${usd(spend.usd)}). Handoff: ${hand}. Reply "#budget ${pct(lim + 5)}%" to continue this task or "#budget new" to start fresh.`;
    return stop("stopped-budget", "budget", msg, `${pct(used)}% of ${pct(lim)}% plan budget`);
  }

  // Plan-window stop, once per window.
  const plan = freshPlan(env.snapshot, env.now);
  if (
    plan &&
    !s.planGuard.off &&
    plan.pct >= cfg.plan.stopAtPct &&
    s.planGuard.trippedFor !== plan.key
  ) {
    s.planGuard.trippedFor = plan.key;
    const msg = `spend-leash: 5-hour plan window at ${pct(plan.pct)}% (stop at ${cfg.plan.stopAtPct}%). Handoff: ${hand}. Resets ${resetsText(env.snapshot?.fiveHourResetsAt)}. Reply "#budget plan-off" to keep going.`;
    return stop("stopped-plan", "plan", msg, `window at ${pct(plan.pct)}%`);
  }

  // Loop stop.
  if (verdict === "stop") {
    const msg = `spend-leash: the same ${tool} call ran ${loopCount} times in a row; stopping to avoid a loop. Handoff: ${hand}.`;
    return stop("stopped-loop", "loop", msg, `${tool} x${loopCount}`);
  }

  // Warnings.
  const warns: string[] = [];
  const usdFrac = t.limitUsd ? spend.usd / t.limitUsd : 0;
  const planFrac = t.limitPlanPct && spend.planPct !== null ? spend.planPct / t.limitPlanPct : 0;
  const frac = Math.max(usdFrac, planFrac);
  if (!t.warned && (t.limitUsd || t.limitPlanPct) && frac >= cfg.task.warnAt) {
    t.warned = true;
    const tail = "Finish the current step, then stop and summarize what is left.";
    if (usdFrac >= planFrac && t.limitUsd !== null) {
      warns.push(
        `spend-leash: ${Math.round(frac * 100)}% of this task's budget used (${usd(spend.usd)} of ${usd(t.limitUsd)}). ${tail}`,
      );
    } else {
      warns.push(
        `spend-leash: ${Math.round(frac * 100)}% of this task's plan budget used (${pct(spend.planPct ?? 0)}% of ${pct(t.limitPlanPct ?? 0)}% of the 5-hour window). ${tail}`,
      );
    }
  }
  if (verdict === "warn") {
    warns.push(
      `spend-leash: you have run this exact ${tool} call ${loopCount} times; the result will not change. Try a different approach, or stop and explain what is blocking you.`,
    );
  }
  if (warns.length === 0) return { state: s, effects: [] };
  return { state: s, output: ctxOut(kind, warns.join("\n")), effects: [] };
}

const tokenDelta = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheWrite5m: Math.max(0, a.cacheWrite5m - b.cacheWrite5m),
  cacheWrite1h: Math.max(0, a.cacheWrite1h - b.cacheWrite1h),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
});

function ledgerEffect(
  s: SessionState,
  env: StepEnv,
  outcome: LedgerLine["outcome"],
  reason: string,
): Effect[] {
  const t = s.task;
  if (!t) return [];
  const spend = taskSpend(s, env.spendUsd, env.snapshot, env.now);
  const line: LedgerLine = {
    ts: env.now.toISOString(),
    sessionId: s.sessionId,
    taskId: t.id,
    cwd: s.cwd,
    prompt: String(redact(t.prompt)).slice(0, 200),
    usd: spend.usd,
    tokens: tokenDelta(env.tokens, t.baseTokens),
    planPctDelta: spend.planPct,
    outcome,
    reason,
  };
  return [{ kind: "ledger", line }];
}

function failedBash(input: HookInput): boolean {
  if (input.tool_name !== "Bash" || !isObj(input.tool_response)) return false;
  const r = input.tool_response;
  const code = r.exit_code ?? r.exitCode;
  return typeof code === "number" && code !== 0;
}

export function step(state: SessionState, input: HookInput, env: StepEnv): StepResult {
  const s = cloneState(state, input.cwd);
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return onPrompt(s, input, env);
    case "PreToolUse":
    case "PostToolBatch":
      return check(s, input, env, input.hook_event_name);
    case "PostToolUseFailure":
      if (input.tool_name) s.loop = recordFailure(s.loop, input.tool_name, input.tool_input);
      return { state: s, effects: [] };
    case "PostToolUse":
      if (failedBash(input) && input.tool_name) {
        s.loop = recordFailure(s.loop, input.tool_name, input.tool_input);
      }
      return { state: s, effects: [] };
    case "Stop":
      return {
        state: s,
        effects: ledgerEffect(s, env, s.task?.outcome ?? "completed", s.task?.reason ?? ""),
      };
    case "StopFailure": {
      const detail = input.error || "unknown";
      return {
        state: s,
        effects: [
          { kind: "handoff", reason: "error", detail },
          ...ledgerEffect(s, env, "error", detail),
        ],
      };
    }
    case "SessionStart": {
      if (!env.pending) return { state: s, effects: [] };
      const { path, preview } = env.pending;
      return {
        state: s,
        output: ctxOut(
          "SessionStart",
          `spend-leash: a previous task in this project was stopped. Handoff at ${path}:\n${preview}`,
        ),
        effects: [{ kind: "consume", path }],
      };
    }
    default:
      return { state: s, effects: [] };
  }
}
