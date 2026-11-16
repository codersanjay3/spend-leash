import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Scope = "user" | "project" | "local";

export interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
export interface Settings {
  hooks?: Record<string, HookGroup[] | undefined>;
  statusLine?: unknown;
  [k: string]: unknown;
}

export function settingsPathFor(scope: Scope, home: string, project: string): string {
  switch (scope) {
    case "user":
      return join(home, ".claude", "settings.json");
    case "project":
      return join(resolve(project), ".claude", "settings.json");
    case "local":
      return join(resolve(project), ".claude", "settings.local.json");
  }
}

function assertNotDangling(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    /* does not exist at all */
  }
  if (isLink) {
    throw new Error(`spend-leash: ${path} is a dangling symlink; refusing to replace it`);
  }
}

/** Read a settings file. Missing -> {} with text null. Invalid content throws (never clobbered). */
export function readSettingsWithText(path: string): { settings: Settings; text: string | null } {
  if (!existsSync(path)) {
    assertNotDangling(path);
    return { settings: {}, text: null };
  }
  const text = readFileSync(path, "utf8");
  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") return { settings: {}, text };
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `spend-leash: ${path} is not valid JSON (${(e as Error).message}); refusing to modify it`,
    );
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`spend-leash: ${path} is not a JSON object; refusing to modify it`);
  }
  return { settings: v as Settings, text };
}

export function readSettingsFile(path: string): Settings {
  return readSettingsWithText(path).settings;
}

export function backupFile(path: string, now = new Date()): string | undefined {
  if (!existsSync(path)) return undefined;
  const ts = now.toISOString().replace(/[:.]/g, "-");
  let dest = `${path}.bak-${ts}`;
  let n = 1;
  while (existsSync(dest)) dest = `${path}.bak-${ts}-${n++}`;
  copyFileSync(path, dest);
  return dest;
}

/** The real path of `path` when it exists (resolves symlinks), else `path` unchanged. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Atomically write text. Follows symlinks (temp file next to the real file, renamed onto it, so a
 * symlinked settings.json stays a symlink) and keeps the original file mode; new files are 0600.
 */
export function writeTextAtomic(path: string, text: string): void {
  if (!existsSync(path)) assertNotDangling(path);
  const target = canonicalPath(path);
  mkdirSync(dirname(target), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    /* new file */
  }
  const tmp = `${target}.spend-leash.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode); // writeFileSync's mode is filtered by the umask
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
