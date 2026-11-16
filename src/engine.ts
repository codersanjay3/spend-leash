// I/O shell around engine-core: load state, measure spend, run `step`, perform effects, save.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "./config-load.js";
import { type Effect, HANDOFF_PLACEHOLDER, type StepEnv, step, stopOutput } from "./engine-core.js";
import {
  gitInfo,
  lastAssistantMessage,
  lastTodos,
  markConsumed,
  pendingHandoff,
  readTail,
  recentToolCalls,
  renderHandoff,
  writeHandoff,
} from "./handoff.js";
import { type Ctx, ledgerPath } from "./paths.js";
import { ZERO } from "./pricing.js";
import {
  appendError,
  readSessionChecked,
  readSnapshot,
  withSessionLock,
  writeSession,
} from "./state.js";
import type { Snapshot } from "./tasks.js";
import { readSpend } from "./transcript.js";
import type { HookInput, HookResult } from "./types.js";

const GIT_BUDGET_MS = 300;

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

const empty: HookResult = { stdout: "", stderr: "", code: 0 };

/** A subagent hook's transcript_path points at the subagent file: find the session's own. */
function mainTranscript(input: HookInput): string {
  const p = input.transcript_path;
  if (!p) return p;
  if (basename(p) === `${input.session_id}.jsonl`) return p;
  const main = join(dirname(p), `${input.session_id}.jsonl`);
  return existsSync(main) ? main : p;
}

function appendLedger(ctx: Ctx, line: unknown): void {
  mkdirSync(ctx.leashHome, { recursive: true, mode: 0o700 });
  appendFileSync(ledgerPath(ctx), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

const short = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);

const subst = (text: string, value: string): string => text.split(HANDOFF_PLACEHOLDER).join(value);

export function runEngine(ctx: Ctx, input: HookInput): HookResult {
  const started = Date.now();
  const event = input.hook_event_name;
  if (!HANDLED.has(event) || !input.session_id) return empty;
  const sid = input.session_id;

  return withSessionLock(ctx, sid, (held) => {
    const cwd = input.cwd || process.cwd();
    const now = ctx.now();
    const { config } = loadConfig(ctx, cwd);

    const loaded = readSessionChecked(ctx, sid);
    if (loaded.corrupt) {
      appendError(ctx, `session ${sid}: state file ${loaded.corrupt}; starting fresh`);
      if (config.failClosed && (event === "PreToolUse" || event === "PostToolBatch")) {
        // Keep denying (the bad file stays) until the next UserPromptSubmit rewrites the state.
        const msg = "spend-leash: internal error (failClosed)";
        return { stdout: JSON.stringify(stopOutput(event, msg)), stderr: "", code: 0 };
      }
    }
    let state = loaded.state;
    // Without the lock we stay read-only (decide and hand off, but never write shared state);
    // under failClosed a corrupt file is only rewritten by the next UserPromptSubmit.
    const mayWrite = held && !(loaded.corrupt && config.failClosed && event !== "UserPromptSubmit");

    const transcript = mainTranscript(input);
    let spendUsd = 0;
    let tokens = ZERO;
    let estimated = false;
    if (NEEDS_SPEND.has(event) && transcript) {
      const r = readSpend(transcript, state.spend, config.prices);
      state = { ...state, spend: r.cache };
      spendUsd = r.usd;
      tokens = r.tokens;
      estimated = r.estimated;
    }
    const snapshot: Snapshot | undefined = NEEDS_SNAPSHOT.has(event)
      ? readSnapshot(ctx, sid)
      : undefined;
    const pending = event === "SessionStart" ? pendingHandoff(ctx, cwd, now, config) : undefined;

    const env: StepEnv = {
      config,
      spendUsd,
      tokens,
      estimated,
      ...(snapshot ? { snapshot } : {}),
      now,
      ...(pending ? { pending } : {}),
    };
    const res = step(state, input, env);
    const next = res.state;

    // Perform effects in order; a failing effect is logged and never blocks the decision.
    let handoffText: string | undefined;
    const doEffect = (e: Effect): void => {
      if (e.kind === "handoff") {
        try {
          const tail = readTail(transcript);
          const g = Date.now() - started < GIT_BUDGET_MS ? gitInfo(cwd) : undefined;
          const todos = lastTodos(tail);
          const lastAssistant = input.last_assistant_message ?? lastAssistantMessage(tail);
          const md = renderHandoff({
            reason: e.reason,
            detail: e.detail,
            ...(next.task ? { task: next.task } : {}),
            sessionId: sid,
            cwd,
            ...(lastAssistant !== undefined ? { lastAssistant } : {}),
            recentCalls: recentToolCalls(tail),
            ...(todos ? { todos } : {}),
            ...(g ? { git: g } : {}),
            now,
          });
          handoffText = writeHandoff(ctx, cwd, config, md, now, e.reason);
        } catch (err) {
          appendError(ctx, `handoff failed: ${short(err)}`);
          handoffText = `(not written: ${short(err)})`;
        }
      } else if (!mayWrite) {
        return;
      } else if (e.kind === "ledger") {
        const line = { ...e.line, reason: subst(e.line.reason, handoffText ?? "(not written)") };
        try {
          appendLedger(ctx, line);
        } catch (err) {
          appendError(ctx, `ledger write failed: ${short(err)}`);
        }
      } else {
        try {
          markConsumed(ctx, e.path);
        } catch (err) {
          appendError(ctx, `markConsumed failed: ${short(err)}`);
        }
      }
    };
    for (const e of res.effects) doEffect(e);

    let stdout = "";
    if (res.output) {
      stdout = JSON.stringify(res.output);
      if (handoffText !== undefined) {
        stdout = subst(stdout, JSON.stringify(handoffText).slice(1, -1));
      }
    }
    if (handoffText !== undefined && next.task?.reason) {
      next.task.reason = subst(next.task.reason, handoffText);
    }
    if (mayWrite) writeSession(ctx, next);
    return { stdout, stderr: "", code: 0 };
  });
}
