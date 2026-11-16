// Pure handoff markdown renderer: no node:* imports (the browser simulator bundles this).
import { argsPreview, redact } from "./redact.js";
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
const MAX_CHANGED_LINES = 50;
const SAFE_SESSION = /^[\w-]+$/;

const clean = (s: string): string => String(redact(s));

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
  out.push(`**Stopped:** ${clean(d.reason)}: ${clean(d.detail)} (${d.now.toISOString()})`, "");

  out.push("## Task", "");
  out.push(d.task ? fence(clean(d.task.prompt)) : "(no task recorded)", "");

  out.push("## Where it stopped", "");
  const last = d.lastAssistant === undefined ? undefined : clean(d.lastAssistant).trim();
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
    const lines = [d.git.status.trim(), d.git.diffStat.trim()]
      .filter(Boolean)
      .join("\n\n")
      .split("\n");
    if (lines.length === 1 && lines[0] === "") out.push("(no uncommitted changes)", "");
    else {
      const shown = lines.slice(0, MAX_CHANGED_LINES);
      if (lines.length > shown.length) shown.push(`… and ${lines.length - shown.length} more`);
      out.push(fence(shown.join("\n")), "");
    }
  }

  if (d.todos && d.todos.length > 0) {
    out.push("## Next steps", "");
    for (const t of d.todos) out.push(`- ${clean(t).replace(/\n/g, " ")}`);
    out.push("");
  }

  out.push("## Resume", "");
  if (SAFE_SESSION.test(d.sessionId)) {
    out.push(`Continue this session: \`claude --resume ${d.sessionId}\``, "");
  }
  out.push("Then raise the limit with the first line of your prompt:", "");
  out.push("- `#budget +$2` adds $2 to this task's budget");
  out.push("- `#budget new` starts a fresh task with the default budget", "");
  return out.join("\n");
}

interface ToolUse {
  id?: string;
  name: string;
  input: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** tool_use blocks of assistant messages in parsed transcript records, oldest first, deduped by id. */
function toolUses(records: unknown[]): ToolUse[] {
  const out: ToolUse[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (!isObj(rec) || !isObj(rec.message)) continue;
    if (rec.type !== undefined && rec.type !== "assistant") continue;
    const content = rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isObj(b) || b.type !== "tool_use" || typeof b.name !== "string") continue;
      const id = typeof b.id === "string" ? b.id : undefined;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push({ id, name: b.name, input: b.input });
    }
  }
  return out;
}

export function recentCallsFrom(records: unknown[], n = 10): { tool: string; args: unknown }[] {
  if (n <= 0) return [];
  return toolUses(records)
    .slice(-n)
    .map((t) => ({ tool: t.name, args: t.input }));
}

/** The last TodoWrite list as `[status] content` strings; undefined when there is none. */
export function lastTodosFrom(records: unknown[]): string[] | undefined {
  const uses = toolUses(records);
  for (let i = uses.length - 1; i >= 0; i--) {
    const u = uses[i];
    if (u?.name !== "TodoWrite" || !isObj(u.input) || !Array.isArray(u.input.todos)) continue;
    const todos = u.input.todos
      .filter(isObj)
      .map(
        (t) =>
          `[${typeof t.status === "string" && t.status ? t.status : " "}] ${String(t.content)}`,
      );
    return todos.length > 0 ? todos : undefined;
  }
  return undefined;
}
