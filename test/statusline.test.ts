import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { makeCtx } from "../src/paths.js";
import { readSnapshot } from "../src/state.js";
import { ownLine, snapshotFrom } from "../src/statusline-core.js";
import type { SessionState } from "../src/tasks.js";

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "statusline.mjs");
const posix = process.platform !== "win32";
const NOW = new Date("2026-11-16T10:00:00.000Z");

const FULL = {
  session_id: "sess-1",
  cwd: tmpdir(),
  model: { id: "claude-sonnet-5-5", display_name: "Sonnet" },
  cost: { total_cost_usd: 0.42 },
  rate_limits: {
    five_hour: { used_percentage: 37.4, resets_at: 1795000000 },
    seven_day: { used_percentage: 12 },
  },
};

let tmp: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sl-"));
  env = { ...process.env, HOME: tmp, USERPROFILE: tmp, SPEND_LEASH_HOME: join(tmp, "leash") };
});

function setOriginal(command: string) {
  mkdirSync(env.SPEND_LEASH_HOME as string, { recursive: true });
  writeFileSync(
    join(env.SPEND_LEASH_HOME as string, "statusline.json"),
    JSON.stringify({ original: { type: "command", command } }),
  );
}

function run(input: unknown | Buffer) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [bin], { input: buf, env });
  return { ...r, ms: Date.now() - t0 };
}

const snapshot = (id = "sess-1") => readSnapshot(makeCtx(env), id);

describe("snapshotFrom", () => {
  it("maps a full statusline JSON", () => {
    expect(snapshotFrom(FULL, NOW)).toEqual({
      at: NOW.toISOString(),
      fiveHourPct: 37.4,
      fiveHourResetsAt: new Date(1795000000 * 1000).toISOString(),
      sevenDayPct: 12,
      costUsd: 0.42,
      model: "claude-sonnet-5-5",
    });
  });
  it("keeps ISO resets_at, ignores other types", () => {
    const iso = "2026-11-16T12:00:00Z";
    const mk = (r: unknown) => ({
      rate_limits: { five_hour: { used_percentage: 1, resets_at: r } },
    });
    expect(snapshotFrom(mk(iso), NOW).fiveHourResetsAt).toBe("2026-11-16T12:00:00.000Z");
    expect(snapshotFrom(mk({}), NOW).fiveHourResetsAt).toBeUndefined();
    expect(snapshotFrom(mk("garbage"), NOW).fiveHourResetsAt).toBeUndefined();
  });
  it("empty and junk inputs yield only `at`", () => {
    for (const x of [{}, null, "x", 5, [], { rate_limits: 3, cost: "a", model: [] }]) {
      expect(snapshotFrom(x, NOW)).toEqual({ at: NOW.toISOString() });
    }
  });
});

describe("ownLine", () => {
  const snap = { at: NOW.toISOString(), fiveHourPct: 37.4 };
  const withTask = (limitUsd: number | null) => ({ task: { limitUsd } }) as unknown as SessionState;
  it("shows plan pct and task limit", () => {
    expect(ownLine(withTask(2), snap)).toBe("spend-leash · 5h 37% · task limit $2.00");
  });
  it("omits unknown parts", () => {
    expect(ownLine(undefined, snap)).toBe("spend-leash · 5h 37%");
    expect(ownLine(withTask(null), { at: snap.at })).toBe("spend-leash");
    expect(ownLine(withTask(1.5), { at: snap.at })).toBe("spend-leash · task limit $1.50");
  });
});

describe("dist/statusline.mjs", () => {
  it("no original: prints ownLine and writes a 0600 snapshot", () => {
    const r = run(FULL);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("spend-leash · 5h 37%\n");
    expect(snapshot()?.fiveHourPct).toBe(37.4);
    if (posix) {
      const p = join(env.SPEND_LEASH_HOME as string, "sessions", "sess-1.statusline.json");
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it("garbage stdin: exit 0, no crash", () => {
    const r = run(Buffer.from("not json"));
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("spend-leash\n");
  });

  it("node -e original: bytes reproduced, receives the same stdin", () => {
    const script =
      "let d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(d)))";
    setOriginal(`"${process.execPath}" -e "${script}"`);
    const r = run(FULL);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual(FULL);
    expect(snapshot()?.costUsd).toBe(0.42);
  });

  it("node -e original exiting 1 with output: same output, exit 0", () => {
    setOriginal(
      `"${process.execPath}" -e "process.stdout.write('boom\\u001b[0m');process.exit(1)"`,
    );
    const r = run(FULL);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("boom\u001b[0m");
  });

  it.skipIf(!posix)("preserves ANSI bytes exactly", () => {
    setOriginal("printf '\\033[32mhi\\033[0m'");
    const r = run(FULL);
    expect(r.stdout.equals(Buffer.from("\u001b[32mhi\u001b[0m"))).toBe(true);
    expect(snapshot()).toBeDefined();
  });

  it.skipIf(!posix)("non-zero exit keeps output, multiline and trailing newline", () => {
    setOriginal("printf 'a\\nb\\n'; exit 3");
    const r = run(FULL);
    expect(r.stdout.toString()).toBe("a\nb\n");
    expect(snapshot()).toBeDefined();
  });

  it.skipIf(!posix)("passes stderr through", () => {
    setOriginal("echo oops >&2; printf ok");
    const r = run(FULL);
    expect(r.stdout.toString()).toBe("ok");
    expect(r.stderr.toString()).toBe("oops\n");
  });

  it.skipIf(!posix)("echoes stdin via cat", () => {
    setOriginal("cat");
    const r = run(FULL);
    expect(JSON.parse(r.stdout.toString())).toEqual(FULL);
  });

  it.skipIf(!posix)("runs in input.cwd", () => {
    setOriginal("pwd");
    const dir = mkdtempSync(join(tmpdir(), "slcwd-"));
    const r = run({ ...FULL, cwd: dir });
    expect(
      r.stdout
        .toString()
        .trim()
        .endsWith(dir.split("/").pop() as string),
    ).toBe(true);
  });

  it.skipIf(!posix)("hanging original is cut at 2 s, partial output kept, snapshot written", () => {
    setOriginal("printf partial; sleep 5");
    const r = run(FULL);
    expect(r.ms).toBeLessThan(2600);
    expect(r.ms).toBeGreaterThanOrEqual(1900);
    expect(r.stdout.toString()).toBe("partial");
    expect(r.status).toBe(0);
    expect(snapshot()).toBeDefined();
  });

  it("hanging node original is cut at 2 s", () => {
    setOriginal(`"${process.execPath}" -e "process.stdout.write('p');setTimeout(()=>{},5000)"`);
    const r = run(FULL);
    expect(r.ms).toBeLessThan(2900);
    expect(r.stdout.toString()).toBe("p");
  });

  it("unusable statusline.json falls back to ownLine", () => {
    mkdirSync(env.SPEND_LEASH_HOME as string, { recursive: true });
    writeFileSync(join(env.SPEND_LEASH_HOME as string, "statusline.json"), "{nope");
    expect(run(FULL).stdout.toString()).toBe("spend-leash · 5h 37%\n");
  });

  it("snapshot failure is swallowed, logged, and does not change the original's output", () => {
    const home = env.SPEND_LEASH_HOME as string;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "sessions"), "x"); // a FILE where the dir should be
    setOriginal(`"${process.execPath}" -e "process.stdout.write('orig')"`);
    const r = run(FULL);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("orig");
    expect(readFileSync(join(home, "errors.log"), "utf8")).toMatch(
      /^\d{4}-\d\d-\d\dT.*Z statusline: /m,
    );
  });

  it("path-traversal session_id writes nothing outside sessions/", () => {
    const r = run({ ...FULL, session_id: "../../evil" });
    expect(r.status).toBe(0);
    const home = env.SPEND_LEASH_HOME as string;
    expect(existsSync(join(tmp, "evil.statusline.json"))).toBe(false);
    expect(existsSync(join(home, "..", "evil.statusline.json"))).toBe(false);
    expect(readdirSync(join(home, "sessions")).length).toBe(1);
    expect(readdirSync(home)).toEqual(["sessions"]);
  });

  it("stdin that never closes: bounded, exit 0, original output printed", async () => {
    setOriginal(`"${process.execPath}" -e "process.stdout.write('orig')"`);
    const t0 = Date.now();
    const r = await new Promise<{ code: number | null; out: string }>((res) => {
      const c = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => {
        out += d;
      });
      c.on("close", (code) => res({ code, out }));
      c.stdin.on("error", () => {});
      c.stdin.write(JSON.stringify(FULL)); // never ended
    });
    expect(Date.now() - t0).toBeLessThan(2600);
    expect(r.code).toBe(0);
    expect(r.out).toBe("orig");
    expect(snapshot()?.costUsd).toBe(0.42);
  });

  it("stdin never closes and no original: prints ownLine", async () => {
    const r = await new Promise<{ code: number | null; out: string }>((res) => {
      const c = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => {
        out += d;
      });
      c.on("close", (code) => res({ code, out }));
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("spend-leash\n");
  });
});
