// Browser simulator core. It does NOT reimplement any decision: it drives the same pure
// `step` from src/engine-core.ts that the real hook runs, with an in-memory SessionState
// instead of files (mirrors runEngine in src/engine.ts). Pure: no DOM, no node:* imports.
import { type Config, DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { HANDOFF_PLACEHOLDER, type StepEnv, step } from "../src/engine-core.js";
import { lastTodosFrom, recentCallsFrom, renderHandoff } from "../src/handoff-render.js";
import { addUsage, costUsd, priceFor, type UsageTotals, ZERO } from "../src/pricing.js";
import { argsPreview } from "../src/redact.js";
import { isFresh, type SessionState, type Snapshot } from "../src/tasks.js";
import { usageFromRecord } from "../src/transcript-parse.js";
import type { HookInput } from "../src/types.js";
import { isObj } from "../src/util.js";

export interface ScenarioStep {
  input: HookInput;
  /** Assistant JSONL lines appended to the transcript before this step. */
  transcript?: string[];
  /** Status-line data visible at this step (its `at` is the simulated clock). */
  snapshot?: Omit<Snapshot, "at">;
}

export interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

export type Verdict = "ok" | "warn" | "stop";

export interface SimStep {
  i: number;
  event: string;
  tool?: string;
  /** Short human summary of the call (arguments preview or the prompt). */
  summary?: string;
  /** Spend attributed to the current task so far. */
  usd: number;
  /** The 5-hour window percent reported by the status line at this step, or null. */
  planPct: number | null;
  verdict: Verdict;
  message?: string;
}

export interface SimResult {
  steps: SimStep[];
  handoff?: string;
  /** Where the handoff would be written (relative to the project). */
  handoffPath?: string;
}

export const SIM_SESSION = "sim-session";
export const SIM_CWD = "/home/you/project";
export const SIM_TRANSCRIPT = "~/.claude/projects/-home-you-project/sim-session.jsonl";
export const SIM_START = Date.parse("2026-11-16T12:00:00Z");
export const STEP_MS = 10_000;

export function simInput(event: string, extra: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: event,
    session_id: SIM_SESSION,
    transcript_path: SIM_TRANSCRIPT,
    cwd: SIM_CWD,
    ...extra,
  };
}

// Same event subsets as src/engine.ts.
const HANDLED = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolBatch",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "SessionStart",
]);
const NEEDS_SPEND = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolBatch",
  "Stop",
  "StopFailure",
  "SubagentStop",
]);
const NEEDS_SNAPSHOT = new Set(["UserPromptSubmit", "PreToolUse", "PostToolBatch", "Stop"]);

const pad = (n: number) => String(n).padStart(2, "0");

/** Same stamp format as the real handoff file names. */
export function stamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

const subst = (text: string, value: string): string => text.split(HANDOFF_PLACEHOLDER).join(value);

function initialState(): SessionState {
  return {
    sessionId: SIM_SESSION,
    cwd: SIM_CWD,
    taskSeq: 0,
    loop: { calls: [], failures: {} },
    planGuard: { off: false },
  };
}

function totalSpend(
  byModel: Map<string, UsageTotals>,
  prices: Config["prices"],
): { usd: number; tokens: UsageTotals; estimated: boolean } {
  let usd = 0;
  let tokens = ZERO;
  let estimated = false;
  for (const [model, u] of byModel) {
    tokens = addUsage(tokens, u);
    const { price, estimated: est } = priceFor(model, prices);
    const c = costUsd(u, price);
    if (!Number.isFinite(c)) {
      estimated = true;
      continue;
    }
    usd += c;
    if (est && c > 0) estimated = true;
  }
  return { usd, tokens, estimated };
}

function summarise(input: HookInput): string | undefined {
  if (input.hook_event_name === "UserPromptSubmit") return input.prompt;
  if (input.tool_name) return argsPreview(input.tool_input, 90);
  return undefined;
}

/** Verdict and text of a hook output: deny/stop is "stop", any injected message is "warn". */
export function verdictOf(output: Record<string, unknown> | undefined): {
  verdict: Verdict;
  message?: string;
} {
  if (!output) return { verdict: "ok" };
  if (output.continue === false) {
    const m = typeof output.stopReason === "string" ? output.stopReason : undefined;
    return { verdict: "stop", ...(m ? { message: m } : {}) };
  }
  const hso = isObj(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
  const text =
    typeof output.systemMessage === "string"
      ? output.systemMessage
      : typeof hso.additionalContext === "string"
        ? hso.additionalContext
        : undefined;
  return text ? { verdict: "warn", message: text } : { verdict: "ok" };
}

export function simulate(scenario: Scenario, config: Config = DEFAULT_CONFIG): SimResult {
  let state = initialState();
  const byModel = new Map<string, UsageTotals>();
  const seen = new Set<string>();
  const records: unknown[] = [];
  let snapshot: Snapshot | undefined;
  let handoff: string | undefined;
  let handoffPath: string | undefined;
  const steps: SimStep[] = [];

  scenario.steps.forEach((s, i) => {
    const now = new Date(SIM_START + i * STEP_MS);
    for (const line of s.transcript ?? []) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a bad line is skipped, as the real reader does
      }
      records.push(rec);
      const u = usageFromRecord(rec);
      if (u && !(u.id && seen.has(u.id))) {
        if (u.id) seen.add(u.id);
        byModel.set(u.model, addUsage(byModel.get(u.model) ?? ZERO, u.usage));
      }
    }
    if (s.snapshot) snapshot = { ...s.snapshot, at: now.toISOString() };

    const input = s.input;
    const event = input.hook_event_name;
    const total = totalSpend(byModel, config.prices);
    let verdict: Verdict = "ok";
    let message: string | undefined;

    if (HANDLED.has(event)) {
      const snap = NEEDS_SNAPSHOT.has(event) ? snapshot : undefined;
      const spendOn = NEEDS_SPEND.has(event);
      const env: StepEnv = {
        config,
        spendUsd: spendOn ? total.usd : 0,
        tokens: spendOn ? total.tokens : ZERO,
        estimated: spendOn ? total.estimated : false,
        ...(snap ? { snapshot: snap } : {}),
        now,
      };
      const res = step(state, input, env);
      const next = res.state;
      let path: string | undefined;
      for (const e of res.effects) {
        if (e.kind !== "handoff") continue;
        const todos = lastTodosFrom(records);
        handoff = renderHandoff({
          reason: e.reason,
          detail: e.detail,
          ...(next.task ? { task: next.task } : {}),
          sessionId: input.session_id,
          cwd: input.cwd,
          ...(input.last_assistant_message !== undefined
            ? { lastAssistant: input.last_assistant_message }
            : {}),
          recentCalls: recentCallsFrom(records),
          ...(todos ? { todos } : {}),
          now,
        });
        path = `${config.handoff.dir}/${stamp(now)}-${e.reason}.md`;
        handoffPath = path;
      }
      const judged = verdictOf(res.output);
      verdict = judged.verdict;
      message = judged.message;
      if (path !== undefined) {
        if (message !== undefined) message = subst(message, path);
        if (next.task?.reason) next.task.reason = subst(next.task.reason, path);
      }
      state = next;
    }

    const t = state.task;
    steps.push({
      i,
      event,
      ...(input.tool_name ? { tool: input.tool_name } : {}),
      ...(summarise(input) ? { summary: summarise(input) as string } : {}),
      usd: Math.max(0, total.usd - (t?.baseUsd ?? 0)),
      planPct: snapshot && isFresh(snapshot, now) ? (snapshot.fiveHourPct ?? null) : null,
      verdict,
      ...(message !== undefined ? { message } : {}),
    });
  });

  return { steps, ...(handoff !== undefined ? { handoff, handoffPath } : {}) };
}

export interface ConfigInput {
  budgetUsd: number | null;
  warnPct: number;
  loopWarn: number;
  loopStop: number;
}

/** Builds a Config through the real merge/validation; invalid values fall back to defaults. */
export function configFrom(c: ConfigInput): { config: Config; notes: string[] } {
  return mergeConfig(
    {
      task: { usd: c.budgetUsd, warnAt: c.warnPct / 100 },
      loop: { warnAt: c.loopWarn, stopAt: c.loopStop },
    },
    null,
  );
}

// ---------- pasted transcripts ----------

export const MAX_PASTE_CHARS = 4_000_000;
export const MAX_PASTE_STEPS = 2_000;

function userText(rec: Record<string, unknown>): string | undefined {
  if (rec.isMeta === true || !isObj(rec.message)) return undefined;
  const c = rec.message.content;
  if (typeof c === "string") return c.trim() ? c : undefined;
  if (!Array.isArray(c)) return undefined;
  const text = c
    .filter((b): b is Record<string, unknown> => isObj(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
  return text.trim() ? text : undefined;
}

/** Turns a Claude Code transcript JSONL into scenario steps. Never throws. */
export function scenarioFromTranscript(text: string): {
  scenario?: Scenario;
  error?: string;
  truncatedFrom?: number;
} {
  try {
    if (!text.trim()) return { error: "Paste a Claude Code transcript (JSONL) to replay it." };
    if (text.length > MAX_PASTE_CHARS) {
      return { error: "That transcript is over 4 MB; paste a smaller slice of it." };
    }
    const steps: ScenarioStep[] = [];
    let pending: string[] = [];
    let valid = 0;
    let bad = 0;
    let total = 0;
    const room = () => steps.length < MAX_PASTE_STEPS;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      if (!isObj(rec)) {
        bad++;
        continue;
      }
      valid++;
      if (rec.type === "user") {
        const prompt = userText(rec);
        if (prompt !== undefined) {
          total++;
          if (room()) {
            steps.push({
              input: simInput("UserPromptSubmit", { prompt }),
              ...(pending.length ? { transcript: pending } : {}),
            });
            pending = [];
          }
        }
      } else if (rec.type === "assistant") {
        if (room()) pending.push(line);
        const content = isObj(rec.message) ? rec.message.content : undefined;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!isObj(b) || b.type !== "tool_use" || typeof b.name !== "string") continue;
          total++;
          if (!room()) continue;
          steps.push({
            input: simInput("PreToolUse", { tool_name: b.name, tool_input: b.input }),
            ...(pending.length ? { transcript: pending } : {}),
          });
          pending = [];
        }
      }
    }
    if (valid === 0) {
      return {
        error: `None of the ${bad} line${bad === 1 ? "" : "s"} parsed as JSON. Paste a Claude Code transcript: one JSON object per line.`,
      };
    }
    if (pending.length && room()) steps.push({ input: simInput("Stop"), transcript: pending });
    if (steps.every((s) => s.input.hook_event_name === "Stop") || steps.length === 0) {
      return { error: "No prompts or tool calls found in that transcript." };
    }
    const skipped = bad ? ` (${bad} unreadable line${bad === 1 ? "" : "s"} skipped)` : "";
    const cut = total > MAX_PASTE_STEPS;
    const note = cut ? ` Showing the first 2,000 of ${total} calls.` : "";
    return {
      scenario: {
        name: "Pasted transcript",
        description: `${steps.length} steps replayed from your transcript${skipped}.${note}`,
        steps,
      },
      ...(cut ? { truncatedFrom: total } : {}),
    };
  } catch {
    return {
      error: "Could not read that transcript. Paste Claude Code JSONL, one object per line.",
    };
  }
}
