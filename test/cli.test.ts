import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorsLog, ledgerPath, makeCtx, sessionDir } from "../src/paths.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

describe("cli", () => {
  it("--version prints 0.1.0", () => {
    const r = run("--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
  });
  it("--help lists commands", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    for (const c of ["init", "uninstall", "status", "report"]) expect(r.stdout).toContain(c);
  });
  it("unknown command exits 2", () => {
    expect(run("bogus").status).toBe(2);
  });
  it("stub commands exit 1", () => {
    const r = run("status");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not implemented");
  });
});

describe("paths", () => {
  it("honors SPEND_LEASH_HOME", () => {
    const ctx = makeCtx({ SPEND_LEASH_HOME: "/x/y", HOME: "/h" });
    expect(ctx.leashHome).toBe("/x/y");
    expect(ctx.home).toBe("/h");
    expect(ledgerPath(ctx)).toMatch(/tasks\.jsonl$/);
    expect(errorsLog(ctx)).toMatch(/errors\.log$/);
    expect(sessionDir(ctx, "s1")).toMatch(/sessions$/);
  });
  it("defaults to ~/.spend-leash, USERPROFILE fallback", () => {
    expect(makeCtx({ HOME: "/h" }).leashHome).toMatch(/\.spend-leash$/);
    expect(makeCtx({ USERPROFILE: "/u" }).home).toBe("/u");
  });
});
