// Entry point bundled to dist/hook.mjs.
//
// The main thread is a thin supervisor; the engine runs in a worker thread so a hang (slow disk,
// pathological input) cannot freeze Claude Code: after WATCHDOG_MS the worker is terminated and we
// fail open (exit 0, no stdout), or deny a PreToolUse when config.json sets failClosed.
// Stdout carries only the single JSON object (or nothing).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { runEngine } from "./engine.js";
import { stopOutput } from "./engine-core.js";
import { makeCtx } from "./paths.js";
import { appendError } from "./state.js";
import { readStdin } from "./stdin.js";
import type { HookInput, HookResult } from "./types.js";

const WATCHDOG_MS = 1500;

interface Work {
  stdin: string;
  argvEvent: string;
}

/** Cheap failClosed read: <leashHome>/config.json only. */
function failClosedOn(): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(makeCtx().leashHome, "config.json"), "utf8"));
    return (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { failClosed?: unknown }).failClosed === true
    );
  } catch {
    return false;
  }
}

function failure(event: string, msg: string): HookResult {
  try {
    appendError(makeCtx(), `hook ${event || "?"}: ${msg}`);
  } catch {}
  if (event === "PreToolUse" && failClosedOn()) {
    const m = "spend-leash: internal error (failClosed)";
    return { stdout: JSON.stringify(stopOutput(event, m)), stderr: "", code: 0 };
  }
  return { stdout: "", stderr: "", code: 0 };
}

function eventName(w: Work): string {
  try {
    const e = (JSON.parse(w.stdin) as { hook_event_name?: unknown }).hook_event_name;
    if (typeof e === "string" && e) return e;
  } catch {}
  return w.argvEvent;
}

function runHook(w: Work): HookResult {
  let input: HookInput;
  try {
    input = JSON.parse(w.stdin) as HookInput;
    if (typeof input !== "object" || input === null) throw new Error("input is not an object");
  } catch (e) {
    return failure(w.argvEvent, `bad stdin: ${(e as Error).message}`);
  }
  input.hook_event_name = input.hook_event_name || w.argvEvent;
  try {
    return runEngine(makeCtx(), input);
  } catch (e) {
    return failure(input.hook_event_name, `engine error: ${(e as Error).message}`);
  }
}

function emit(r: HookResult): Promise<void> {
  return new Promise((res) => {
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.stdout) process.stdout.write(`${r.stdout}\n`, () => res());
    else res();
  });
}

async function supervise(): Promise<void> {
  const work: Work = { stdin: await readStdin(), argvEvent: process.argv[2] ?? "" };
  const result = await new Promise<HookResult>((resolve) => {
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      resolve(failure(eventName(work), `watchdog: no result after ${WATCHDOG_MS} ms`));
      void worker?.terminate();
    }, WATCHDOG_MS);
    const done = (r: HookResult) => {
      clearTimeout(timer);
      resolve(r);
    };
    try {
      worker = new Worker(fileURLToPath(import.meta.url), { workerData: work });
    } catch {
      done(runHook(work)); // workers unavailable: run inline, still fail-open
      return;
    }
    worker.once("message", (r: HookResult) => done(r));
    worker.once("error", (e) => done(failure(eventName(work), `worker error: ${e.message}`)));
    worker.once("exit", () => done(failure(eventName(work), "worker exited early")));
  });
  await emit(result);
  process.exit(result.code);
}

if (isMainThread) {
  await supervise();
} else {
  parentPort?.postMessage(runHook(workerData as Work));
}
