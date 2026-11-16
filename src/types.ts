// Shared hook types. Pure: no node:* imports (the browser simulator bundles engine-core).
import type { UsageTotals } from "./pricing.js";

export interface HookInput {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_calls?: { tool_name: string; tool_input: unknown; tool_response?: unknown }[];
  error?: string;
  last_assistant_message?: string;
  agent_id?: string;
  agent_transcript_path?: string;
  stop_hook_active?: boolean;
}

export interface HookResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** One line of `<leashHome>/tasks.jsonl`. `report` dedupes by `taskId`, keeping the last line. */
export interface LedgerLine {
  ts: string;
  sessionId: string;
  taskId: string;
  cwd: string;
  /** Redacted, at most 200 characters. */
  prompt: string;
  usd: number;
  tokens: UsageTotals;
  planPctDelta: number | null;
  outcome: "completed" | "stopped-budget" | "stopped-plan" | "stopped-loop" | "error";
  reason: string;
}
