import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInstall,
  applyUninstall,
  effectiveStatusLine,
  HOOK_EVENTS,
  hookCommand,
  planInstall,
  planUninstall,
  readInstallRecord,
  statusLineCommand,
} from "../src/install.js";
import type { Ctx } from "../src/paths.js";

const posix = process.platform !== "win32";
let root: string;
let ctx: Ctx;
let proj: string;

const userFile = () => join(ctx.home, ".claude", "settings.json");
const localFile = () => join(proj, ".claude", "settings.local.json");
const put = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const rd = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(rd(p));
const init = (scope: "user" | "project" | "local" = "user") => {
  const plan = planInstall(ctx, { scope, project: proj });
  applyInstall(ctx, plan);
  return plan;
};
const uninstall = () => {
  const rec = readInstallRecord(ctx);
  if (!rec) throw new Error("no record");
  const plan = planUninstall(ctx, rec);
  applyUninstall(ctx, plan);
  return plan;
};
const tree = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort()
    : [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sl-install-")));
  ctx = { home: join(root, "home"), leashHome: join(root, "leash"), now: () => new Date() };
  proj = join(root, "proj");
  mkdirSync(ctx.home, { recursive: true });
  mkdirSync(proj, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("init", () => {
  it("adds 9 hook groups and a wrapper statusLine to an empty user settings", () => {
    const plan = init();
    const s = json(userFile());
    expect(Object.keys(s.hooks)).toEqual([...HOOK_EVENTS]);
    const cmd = hookCommand(ctx.leashHome);
    for (const ev of HOOK_EVENTS) {
      const tool = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch"].includes(
        ev,
      );
      expect(s.hooks[ev]).toEqual([
        { ...(tool ? { matcher: "*" } : {}), hooks: [{ type: "command", command: cmd(ev) }] },
      ]);
    }
    expect(s.statusLine).toEqual({ type: "command", command: statusLineCommand(ctx.leashHome) });
    expect(plan.record.statusLine?.original).toBeNull();
    expect(readInstallRecord(ctx)?.statusLine?.original).toBeNull();
    expect(json(join(ctx.leashHome, "statusline.json"))).toEqual({ original: null });
    expect(cmd("Stop")).toBe(`node "${ctx.leashHome.replaceAll("\\", "/")}/hook.mjs" Stop`);
  });

  it("wraps an existing user statusLine and records the original", () => {
    put(
      userFile(),
      JSON.stringify({ statusLine: { type: "command", command: "~/sl.sh", padding: 2 } }),
    );
    init();
    expect(json(userFile()).statusLine).toEqual({
      type: "command",
      command: statusLineCommand(ctx.leashHome),
      padding: 2,
    });
    expect(json(join(ctx.leashHome, "statusline.json"))).toEqual({
      original: { type: "command", command: "~/sl.sh", padding: 2 },
    });
  });

  it("keeps every user statusLine key on the wrapper and restores byte-identically", () => {
    const text =
      '{"statusLine":{"type":"command","command":"echo hi","padding":1,"refreshInterval":5}}\n';
    put(userFile(), text);
    init();
    expect(json(userFile()).statusLine).toEqual({
      type: "command",
      command: statusLineCommand(ctx.leashHome),
      padding: 1,
      refreshInterval: 5,
    });
    const again = planInstall(ctx, { scope: "user", project: proj });
    expect(again.changes).toEqual([]);
    uninstall();
    expect(rd(userFile())).toBe(text);
  });

  it("wraps the project-local statusLine even with --scope user", () => {
    put(userFile(), JSON.stringify({ statusLine: { type: "command", command: "user.sh" } }));
    put(localFile(), JSON.stringify({ statusLine: { type: "command", command: "local.sh" } }));
    expect(effectiveStatusLine(ctx, proj)?.path).toBe(localFile());
    init("user");
    expect(json(localFile()).statusLine.command).toBe(statusLineCommand(ctx.leashHome));
    expect(json(userFile()).statusLine).toEqual({ type: "command", command: "user.sh" });
    expect(json(join(ctx.leashHome, "statusline.json")).original.command).toBe("local.sh");
  });

  it("leaves a non-command statusLine alone and notes it", () => {
    const text = JSON.stringify({ statusLine: { type: "static", text: "hi" } });
    put(userFile(), text);
    const plan = init();
    expect(plan.notes).toContain("status line is not a command; plan-% budgets unavailable");
    expect(json(userFile()).statusLine).toEqual({ type: "static", text: "hi" });
    expect(existsSync(join(ctx.leashHome, "statusline.json"))).toBe(false);
    uninstall();
    expect(rd(userFile())).toBe(text);
  });

  it("is idempotent: a second plan has no changes and the record is kept", () => {
    init();
    const before = rd(userFile());
    const rec = rd(join(ctx.leashHome, "install.json"));
    const again = planInstall(ctx, { scope: "user", project: proj });
    expect(again.changes).toEqual([]);
    applyInstall(ctx, again);
    expect(rd(userFile())).toBe(before);
    expect(rd(join(ctx.leashHome, "install.json"))).toBe(rec);
  });

  it("planInstall writes nothing", () => {
    put(userFile(), '{"a":1}');
    const snap = tree(root);
    planInstall(ctx, { scope: "user", project: proj });
    expect(tree(root)).toEqual(snap);
    expect(rd(userFile())).toBe('{"a":1}');
  });

  it("keeps other tools' groups untouched and in order, ours appended last", () => {
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "other.sh" }] };
    const other2 = { hooks: [{ type: "command", command: "second.sh" }] };
    put(userFile(), JSON.stringify({ hooks: { PreToolUse: [other, other2] } }));
    init();
    const pre = json(userFile()).hooks.PreToolUse;
    expect(pre.slice(0, 2)).toEqual([other, other2]);
    expect(pre).toHaveLength(3);
    expect(pre[2].hooks[0].command).toBe(hookCommand(ctx.leashHome)("PreToolUse"));
  });

  it("supports project scope paths", () => {
    init("project");
    expect(existsSync(join(proj, ".claude", "settings.json"))).toBe(true);
  });

  it("refuses to install into a different file than the recorded one", () => {
    init("user");
    expect(() => planInstall(ctx, { scope: "project", project: proj })).toThrow(/uninstall first/);
  });
});

describe("refusals leave the file untouched", () => {
  const bad: [string, string, RegExp][] = [
    ["invalid JSON", "{nope", /not valid JSON/],
    ["top-level array", "[]", /not a JSON object/],
    ["hooks not an object", '{"hooks":[]}', /`hooks` is not an object/],
    ["hooks null", '{"hooks":null}', /`hooks` is not an object/],
    ["event not an array", '{"hooks":{"Stop":{}}}', /hooks\.Stop is not an array/],
  ];
  for (const [name, text, re] of bad) {
    it(name, () => {
      put(userFile(), text);
      expect(() => init()).toThrow(re);
      expect(rd(userFile())).toBe(text);
      expect(existsSync(join(ctx.leashHome, "install.json"))).toBe(false);
      expect(readdirSync(join(ctx.home, ".claude"))).toEqual(["settings.json"]);
    });
  }
});

describe("uninstall", () => {
  it("restores byte-identical files (hooks file and statusLine file)", () => {
    const u =
      '{\n\t"model":"x",\n\t"hooks": {"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"o"}]}]}\n}'; // tabs, no trailing newline
    const l = '{"statusLine":   {"type":"command","command":"local.sh","padding":1}}\r\n';
    put(userFile(), u);
    put(localFile(), l);
    init();
    expect(rd(userFile())).not.toBe(u);
    expect(rd(localFile())).not.toBe(l);
    uninstall();
    expect(rd(userFile())).toBe(u);
    expect(rd(localFile())).toBe(l);
    expect(existsSync(join(ctx.leashHome, "install.json"))).toBe(false);
    expect(existsSync(join(ctx.leashHome, "statusline.json"))).toBe(false);
  });

  it("removes a file init created", () => {
    init();
    uninstall();
    expect(existsSync(userFile())).toBe(false);
  });

  it("restores the statusLine when settings had none but file existed", () => {
    const text = '{"model":"x"}\n';
    put(userFile(), text);
    init();
    uninstall();
    expect(rd(userFile())).toBe(text);
  });

  it("leaves a user-edited statusLine and warns; other edits survive, our hooks go", () => {
    put(userFile(), JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } }));
    init();
    const s = json(userFile());
    s.statusLine = { type: "command", command: "edited.sh" };
    s.theme = "dark";
    put(userFile(), JSON.stringify(s));
    const plan = uninstall();
    expect(plan.warnings.join(" ")).toMatch(/status line/);
    const after = json(userFile());
    expect(after.statusLine).toEqual({ type: "command", command: "edited.sh" });
    expect(after.theme).toBe("dark");
    expect(after.hooks).toBeUndefined();
  });

  it("removes only our entry from a group shared with another hook, keeping the group", () => {
    put(userFile(), "{}\n");
    init();
    const s = json(userFile());
    s.hooks.Stop[0].hooks.unshift({ type: "command", command: "theirs.sh" });
    put(userFile(), JSON.stringify(s));
    uninstall();
    expect(json(userFile()).hooks).toEqual({
      Stop: [{ hooks: [{ type: "command", command: "theirs.sh" }] }],
    });
  });

  it("keeps a pre-existing empty event array", () => {
    put(userFile(), JSON.stringify({ hooks: { Stop: [] } }));
    init();
    uninstall();
    expect(json(userFile())).toEqual({ hooks: { Stop: [] } });
  });

  it("refuses when the file became invalid, leaving it untouched", () => {
    init();
    put(userFile(), "{broken");
    const rec = readInstallRecord(ctx);
    if (!rec) throw new Error("no record");
    expect(() => planUninstall(ctx, rec)).toThrow(/not valid JSON/);
    expect(rd(userFile())).toBe("{broken");
  });
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("stale plans and failures", () => {
  it("install: refuses to apply when the file changed since plan", () => {
    put(userFile(), '{"a":1}\n');
    const plan = planInstall(ctx, { scope: "user", project: proj });
    put(userFile(), '{"a":1,"edited":true}\n');
    expect(() => applyInstall(ctx, plan)).toThrow(/settings changed since plan .*re-run/);
    expect(rd(userFile())).toBe('{"a":1,"edited":true}\n');
    expect(existsSync(join(ctx.leashHome, "install.json"))).toBe(false);
  });

  it("uninstall: refuses to apply when the file changed since plan", () => {
    init();
    const rec = readInstallRecord(ctx);
    if (!rec) throw new Error("no record");
    const plan = planUninstall(ctx, rec);
    const s = json(userFile());
    s.theme = "dark";
    put(userFile(), JSON.stringify(s));
    const edited = rd(userFile());
    expect(() => applyUninstall(ctx, plan)).toThrow(/settings changed since plan/);
    expect(rd(userFile())).toBe(edited);
    expect(existsSync(join(ctx.leashHome, "install.json"))).toBe(true);
  });

  it("checks every file before writing any", () => {
    put(userFile(), "{}\n");
    put(localFile(), '{"statusLine":{"type":"command","command":"l.sh"}}\n');
    const plan = planInstall(ctx, { scope: "user", project: proj });
    put(localFile(), '{"statusLine":{"type":"command","command":"changed.sh"}}\n');
    expect(() => applyInstall(ctx, plan)).toThrow(/changed since plan/);
    expect(rd(userFile())).toBe("{}\n");
  });

  it.skipIf(!posix || isRoot)(
    "a failing second write leaves a record; uninstall recovers cleanly",
    () => {
      put(userFile(), '{"model":"x"}\n');
      const l = '{"statusLine":{"type":"command","command":"l.sh"}}\n';
      put(localFile(), l);
      chmodSync(join(proj, ".claude"), 0o500);
      try {
        expect(() => init()).toThrow();
      } finally {
        chmodSync(join(proj, ".claude"), 0o700);
      }
      expect(existsSync(join(ctx.leashHome, "install.json"))).toBe(true);
      expect(json(userFile()).hooks.Stop).toBeDefined();
      expect(rd(localFile())).toBe(l);
      const plan = uninstall();
      expect(plan.warnings).toEqual([]);
      expect(rd(userFile())).toBe('{"model":"x"}\n');
      expect(rd(localFile())).toBe(l);
      expect(existsSync(join(ctx.leashHome, "install.json"))).toBe(false);
    },
  );
});

describe("non-target and unusual files", () => {
  it("skips an invalid non-target file with a note", () => {
    put(localFile(), "{broken");
    const plan = planInstall(ctx, { scope: "user", project: proj });
    expect(plan.notes).toContain(
      `could not read ${localFile()}; status line precedence not checked`,
    );
    applyInstall(ctx, plan);
    expect(rd(localFile())).toBe("{broken");
    expect(json(userFile()).hooks.Stop).toBeDefined();
  });

  it.skipIf(!posix)("a directory in place of a non-target file is skipped with a note", () => {
    mkdirSync(localFile(), { recursive: true });
    const plan = planInstall(ctx, { scope: "user", project: proj });
    expect(plan.notes.join(" ")).toMatch(/could not read .*settings\.local\.json/);
  });

  it.skipIf(!posix)("wraps a statusLine in a symlinked non-target file through the link", () => {
    const real = join(root, "dot", "local.json");
    put(real, '{"statusLine":{"type":"command","command":"l.sh"}}\n');
    mkdirSync(join(proj, ".claude"), { recursive: true });
    symlinkSync(real, localFile());
    init();
    expect(lstatSync(localFile()).isSymbolicLink()).toBe(true);
    expect(json(real).statusLine.command).toBe(statusLineCommand(ctx.leashHome));
    uninstall();
    expect(lstatSync(localFile()).isSymbolicLink()).toBe(true);
    expect(rd(real)).toBe('{"statusLine":{"type":"command","command":"l.sh"}}\n');
  });

  it.skipIf(!posix)("refuses a dangling symlink settings path", () => {
    mkdirSync(join(ctx.home, ".claude"), { recursive: true });
    symlinkSync(join(root, "nowhere.json"), userFile());
    expect(() => init()).toThrow(/dangling symlink/);
    expect(lstatSync(userFile()).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "nowhere.json"))).toBe(false);
  });

  for (const kind of ["local", "project"] as const) {
    it(`leaves a non-command statusLine in the ${kind} file untouched with a note`, () => {
      const f = kind === "local" ? localFile() : join(proj, ".claude", "settings.json");
      const text = '{"statusLine":{"type":"static","text":"hi"}}\n';
      put(f, text);
      const plan = init();
      expect(plan.notes).toContain("status line is not a command; plan-% budgets unavailable");
      expect(rd(f)).toBe(text);
      expect(json(userFile()).statusLine).toBeUndefined();
      uninstall();
      expect(rd(f)).toBe(text);
    });
  }

  it.skipIf(!posix)("leashHome is 0700", () => {
    init();
    expect(statSync(ctx.leashHome).mode & 0o777).toBe(0o700);
  });
});

describe("file handling", () => {
  it("creates a backup before the uninstall write", () => {
    put(userFile(), '{"model":"x"}\n');
    init();
    const installed = rd(userFile());
    uninstall();
    const baks = readdirSync(join(ctx.home, ".claude")).filter((f) =>
      f.startsWith("settings.json.bak-"),
    );
    expect(baks.map((b) => rd(join(ctx.home, ".claude", b)))).toContain(installed);
  });

  it("creates a backup before each write", () => {
    const u = '{"model":"x"}\n';
    put(userFile(), u);
    put(localFile(), '{"statusLine":{"type":"command","command":"l.sh"}}\n');
    init();
    const dirU = readdirSync(join(ctx.home, ".claude")).filter((f) =>
      f.startsWith("settings.json.bak-"),
    );
    const dirL = readdirSync(join(proj, ".claude")).filter((f) =>
      f.startsWith("settings.local.json.bak-"),
    );
    expect(dirU).toHaveLength(1);
    expect(dirL).toHaveLength(1);
    expect(rd(join(ctx.home, ".claude", dirU[0] as string))).toBe(u);
  });

  it.skipIf(!posix)(
    "keeps a symlinked settings file a symlink, preserves 0600, and restores through the link",
    () => {
      const real = join(root, "dotfiles", "settings.json");
      put(real, '{"model":"x"}\n');
      chmodSync(real, 0o600);
      mkdirSync(join(ctx.home, ".claude"), { recursive: true });
      symlinkSync(real, userFile());
      init();
      expect(lstatSync(userFile()).isSymbolicLink()).toBe(true);
      expect(json(real).hooks.Stop).toBeDefined();
      expect(statSync(real).mode & 0o777).toBe(0o600);
      const orig = '{"model":"x"}\n';
      uninstall();
      expect(lstatSync(userFile()).isSymbolicLink()).toBe(true);
      expect(rd(real)).toBe(orig);
      expect(statSync(real).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!posix)("preserves a non-default mode", () => {
    put(userFile(), "{}\n");
    chmodSync(userFile(), 0o640);
    init();
    expect(statSync(userFile()).mode & 0o777).toBe(0o640);
  });

  it.skipIf(!posix)("install.json and statusline.json are 0600", () => {
    init();
    expect(statSync(join(ctx.leashHome, "install.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.leashHome, "statusline.json")).mode & 0o777).toBe(0o600);
  });
});
