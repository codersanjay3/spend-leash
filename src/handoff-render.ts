// Pure handoff markdown renderer: no node:* imports (the browser simulator bundles this).
import { argsPreview } from "./redact.js";
import type { Task } from "./tasks.js";

export interface HandoffData {
  reason: string;
  detail: string;
  task?: Task;
  sessionId: string;
  cwd?: string;
  lastAssistant?: string;
  recentCalls: { tool: string; args: unknown }[];
  todos?: string[];
  git?: { status: string; diffStat: string };
  now: Date;
}

const MAX_ASSISTANT = 2000;
const MAX_CALLS = 10;
const PREVIEW_CHARS = 120;

/** First line of every handoff; pendingHandoff matches files to a project through it. */
export function metaLine(cwd: string, sessionId: string): string {
  const c = JSON.stringify(cwd).replace(/>/g, "\\u003e");
  const s = JSON.stringify(sessionId).replace(/>/g, "\\u003e");
  return `<!-- spend-leash handoff cwd=${c} session=${s} -->`;
}

function fence(text: string): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}\n${text}\n${ticks}`;
}

export function renderHandoff(d: HandoffData): string {
  const out: string[] = [];
  if (d.cwd !== undefined) out.push(metaLine(d.cwd, d.sessionId));
  out.push("# Handoff", "");
  out.push(`**Stopped:** ${d.reason}: ${d.detail} (${d.now.toISOString()})`, "");

  out.push("## Task", "");
  out.push(d.task ? fence(d.task.prompt) : "(no task recorded)", "");

  out.push("## Where it stopped", "");
  const last = d.lastAssistant?.trim();
  if (last) {
    const cut = last.length > MAX_ASSISTANT ? `${last.slice(0, MAX_ASSISTANT - 1)}…` : last;
    out.push(fence(cut), "");
  } else out.push("(no assistant message available)", "");

  out.push("## Recent tool calls", "");
  const calls = d.recentCalls.slice(-MAX_CALLS);
  if (calls.length === 0) out.push("(none)");
  for (const c of calls) {
    out.push(`- \`${c.tool}\` ${argsPreview(c.args, PREVIEW_CHARS).replace(/\n/g, " ")}`);
  }
  out.push("");

  if (d.git) {
    out.push("## Changed files", "");
    const body = [d.git.status.trim(), d.git.diffStat.trim()].filter(Boolean).join("\n\n");
    out.push(body ? fence(body) : "(no uncommitted changes)", "");
  }

  if (d.todos && d.todos.length > 0) {
    out.push("## Next steps", "");
    for (const t of d.todos) out.push(`- ${t.replace(/\n/g, " ")}`);
    out.push("");
  }

  out.push("## Resume", "");
  out.push(`Continue this session: \`claude --resume ${d.sessionId}\``, "");
  out.push("Then raise the limit with the first line of your prompt:", "");
  out.push("- `#budget +$2` adds $2 to this task's budget");
  out.push("- `#budget new` starts a fresh task with the default budget", "");
  return out.join("\n");
}
