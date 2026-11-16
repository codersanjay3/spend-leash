import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./paths.js";
import {
  backupFile,
  canonicalPath,
  type HookGroup,
  readSettingsWithText,
  type Scope,
  type Settings,
  settingsPathFor,
  writeJsonAtomic,
  writeTextAtomic,
} from "./settings.js";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Stop",
  "StopFailure",
  "SubagentStop",
] as const;

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch"]);

const fwd = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

export function hookCommand(leashHome: string): (event: string) => string {
  return (event) => `node "${fwd(leashHome)}/hook.mjs" ${event}`;
}

export function statusLineCommand(leashHome: string): string {
  return `node "${fwd(leashHome)}/statusline.mjs"`;
}

export interface InstalledHook {
  event: string;
  command: string;
  /** false when the event key did not exist in the file before we added to it */
  eventExisted?: boolean;
}

export interface InstallRecord {
  scope: Scope;
  settingsPath: string;
  /** false when the `hooks` key did not exist in the settings file before */
  hooksExisted?: boolean;
  hooks: InstalledHook[];
  statusLine?: {
    settingsPath: string;
    original: unknown | null;
    wrapper: { type: "command"; command: string; [k: string]: unknown };
  };
  /** original bytes of every touched file (null = file did not exist), for byte-identical restore */
  originals: Record<string, string | null>;
}

export interface Change {
  path: string;
  before: Settings;
  after: Settings;
  /** exact bytes to write instead of serialising `after` */
  text?: string;
  /** delete the file (we created it and it is empty again) */
  remove?: boolean;
}

export interface InstallPlan {
  changes: Change[];
  record: InstallRecord;
  notes: string[];
}

export interface UninstallPlan {
  changes: Change[];
  warnings: string[];
}

const recordPath = (ctx: Ctx) => join(ctx.leashHome, "install.json");
const statusLineJsonPath = (ctx: Ctx) => join(ctx.leashHome, "statusline.json");

export function readInstallRecord(ctx: Ctx): InstallRecord | undefined {
  const p = recordPath(ctx);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    if (
      !v ||
      typeof v !== "object" ||
      !Array.isArray(v.hooks) ||
      typeof v.settingsPath !== "string"
    )
      throw new Error("unexpected shape");
    return v as InstallRecord;
  } catch (e) {
    throw new Error(`spend-leash: ${p} is corrupt (${(e as Error).message}); fix or delete it`);
  }
}

// ---------- helpers ----------

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkHooksShape(settings: Settings, path: string): void {
  const hooks: unknown = settings.hooks;
  if (hooks === undefined) return;
  if (!isObj(hooks))
    throw new Error(`spend-leash: ${path}: \`hooks\` is not an object; refusing to modify it`);
  for (const ev of HOOK_EVENTS) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) {
      throw new Error(`spend-leash: ${path}: hooks.${ev} is not an array; refusing to modify it`);
    }
  }
}

const hasCommand = (groups: HookGroup[], command: string) =>
  groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command));

class FileSet {
  private files = new Map<
    string,
    { path: string; text: string | null; before: Settings; after: Settings }
  >();
  get(path: string) {
    const key = canonicalPath(path);
    let f = this.files.get(key);
    if (!f) {
      const { settings, text } = readSettingsWithText(path);
      f = { path, text, before: settings, after: structuredClone(settings) };
      this.files.set(key, f);
    }
    return f;
  }
  all() {
    return [...this.files.values()];
  }
}

/** Effective statusLine: project-local > project > user. */
export function effectiveStatusLine(
  ctx: Ctx,
  project: string,
  notes?: string[],
): { path: string; value: unknown } | undefined {
  for (const scope of ["local", "project", "user"] as const) {
    const path = settingsPathFor(scope, ctx.home, project);
    let settings: Settings;
    try {
      settings = readSettingsWithText(path).settings;
    } catch {
      // a file we only read to find precedence must not block the install
      notes?.push(`could not read ${path}; status line precedence not checked`);
      continue;
    }
    if (settings.statusLine !== undefined) return { path, value: settings.statusLine };
  }
  return undefined;
}

// ---------- install ----------

export function planInstall(ctx: Ctx, opts: { scope: Scope; project: string }): InstallPlan {
  const hooksPath = settingsPathFor(opts.scope, ctx.home, opts.project);
  const existing = readInstallRecord(ctx);
  if (existing && canonicalPath(existing.settingsPath) !== canonicalPath(hooksPath)) {
    throw new Error(
      `spend-leash: already installed into ${existing.settingsPath}; run uninstall first`,
    );
  }
  const files = new FileSet();
  const notes: string[] = [];
  const hookFile = files.get(hooksPath);
  checkHooksShape(hookFile.before, hooksPath);

  const cmdFor = hookCommand(ctx.leashHome);
  const hooksExisted = existing?.hooksExisted ?? hookFile.before.hooks !== undefined;
  const added: InstalledHook[] = [];
  for (const event of HOOK_EVENTS) {
    const command = cmdFor(event);
    const cur = hookFile.after.hooks?.[event];
    if (cur !== undefined && hasCommand(cur, command)) continue;
    const group: HookGroup = {
      ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command }],
    };
    hookFile.after.hooks ??= {};
    hookFile.after.hooks[event] = [...(cur ?? []), group];
    added.push({ event, command, eventExisted: cur !== undefined });
  }

  // status line
  const wrapperCmd = statusLineCommand(ctx.leashHome);
  let statusLine = existing?.statusLine;
  const eff = effectiveStatusLine(ctx, opts.project, notes);
  const effVal = eff?.value;
  const isOurs = isObj(effVal) && effVal.type === "command" && effVal.command === wrapperCmd;
  if (!isOurs) {
    if (eff === undefined) {
      const userPath = settingsPathFor("user", ctx.home, opts.project);
      const f = files.get(userPath);
      const wrapper = { type: "command" as const, command: wrapperCmd };
      f.after.statusLine = wrapper;
      statusLine = { settingsPath: userPath, original: null, wrapper };
    } else if (isObj(effVal) && effVal.type === "command") {
      const f = files.get(eff.path);
      const wrapper: { type: "command"; command: string; [k: string]: unknown } = {
        ...structuredClone(effVal),
        type: "command",
        command: wrapperCmd,
      };
      f.after.statusLine = wrapper;
      statusLine = { settingsPath: eff.path, original: structuredClone(effVal), wrapper };
    } else {
      notes.push("status line is not a command; plan-% budgets unavailable");
    }
  }

  const changes: Change[] = [];
  const originals: Record<string, string | null> = { ...(existing?.originals ?? {}) };
  for (const f of files.all()) {
    if (same(f.before, f.after)) continue;
    changes.push({ path: f.path, before: f.before, after: f.after });
    const known = Object.keys(originals).find((k) => canonicalPath(k) === canonicalPath(f.path));
    if (known === undefined) originals[f.path] = f.text;
  }

  const record: InstallRecord = {
    scope: opts.scope,
    settingsPath: hooksPath,
    hooksExisted,
    hooks: [...(existing?.hooks ?? []), ...added],
    ...(statusLine ? { statusLine } : {}),
    originals,
  };
  return { changes, record, notes };
}

/** Throws (writing nothing) when any planned file changed since it was read. */
function verifyUnchanged(changes: Change[]): void {
  for (const c of changes) {
    const { settings } = readSettingsWithText(c.path);
    if (!same(settings, c.before)) {
      throw new Error(`spend-leash: settings changed since plan (${c.path}); re-run`);
    }
  }
}

export function applyInstall(ctx: Ctx, plan: InstallPlan): void {
  if (plan.changes.length === 0) return; // idempotent: never clobber the existing record
  verifyUnchanged(plan.changes);
  mkdirSync(ctx.leashHome, { recursive: true, mode: 0o700 });
  // record first, so a failed settings write still leaves a way back
  writeJsonAtomic(recordPath(ctx), plan.record);
  if (plan.record.statusLine) {
    writeJsonAtomic(statusLineJsonPath(ctx), { original: plan.record.statusLine.original });
  }
  for (const c of plan.changes) {
    backupFile(c.path, ctx.now());
    writeJsonAtomic(c.path, c.after);
  }
}

// ---------- uninstall ----------

export function planUninstall(ctx: Ctx, record: InstallRecord): UninstallPlan {
  const files = new FileSet();
  const warnings: string[] = [];

  const hookFile = files.get(record.settingsPath);
  checkHooksShape(hookFile.before, record.settingsPath);
  const hooks = hookFile.after.hooks;
  if (hooks) {
    for (const { event, command, eventExisted } of record.hooks) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept: HookGroup[] = [];
      for (const g of groups) {
        const hs = Array.isArray(g?.hooks) ? g.hooks : undefined;
        if (!hs) {
          kept.push(g);
          continue;
        }
        const rest = hs.filter((h) => h?.command !== command);
        if (rest.length === hs.length) kept.push(g);
        else if (rest.length > 0) kept.push({ ...g, hooks: rest });
      }
      if (kept.length > 0 || eventExisted !== false) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0 && record.hooksExisted === false) {
      delete hookFile.after.hooks;
    }
  }

  const sl = record.statusLine;
  if (sl) {
    const f = files.get(sl.settingsPath);
    if (same(f.after.statusLine, sl.wrapper)) {
      if (sl.original === null) delete f.after.statusLine;
      else f.after.statusLine = structuredClone(sl.original);
    } else if (
      f.after.statusLine !== undefined &&
      !(sl.original !== null && same(f.after.statusLine, sl.original))
    ) {
      warnings.push(
        `status line in ${sl.settingsPath} was changed after install; leaving your version in place`,
      );
    }
  }

  const changes: Change[] = [];
  for (const f of files.all()) {
    if (same(f.before, f.after)) continue;
    const key = Object.keys(record.originals ?? {}).find(
      (k) => canonicalPath(k) === canonicalPath(f.path),
    );
    const change: Change = { path: f.path, before: f.before, after: f.after };
    if (key !== undefined) {
      const orig = record.originals[key];
      if (orig === null) {
        if (Object.keys(f.after).length === 0) change.remove = true;
      } else {
        let parsed: unknown;
        try {
          parsed = orig.replace(/^﻿/, "").trim() === "" ? {} : JSON.parse(orig.replace(/^﻿/, ""));
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined && same(parsed, f.after)) change.text = orig;
      }
    }
    changes.push(change);
  }
  return { changes, warnings };
}

export function applyUninstall(ctx: Ctx, plan: UninstallPlan): void {
  verifyUnchanged(plan.changes);
  for (const c of plan.changes) {
    backupFile(c.path, ctx.now());
    if (c.remove) unlinkSync(c.path);
    else if (c.text !== undefined) writeTextAtomic(c.path, c.text);
    else writeJsonAtomic(c.path, c.after);
  }
  for (const p of [recordPath(ctx), statusLineJsonPath(ctx)]) {
    if (existsSync(p)) unlinkSync(p);
  }
}
