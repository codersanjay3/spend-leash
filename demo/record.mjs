// Records docs/demo.gif and docs/social-preview.png from REAL spend-leash output.
//  - `init` and `report` are the built CLI (dist/cli.js) run against a temp HOME.
//  - The Claude Code session is simulated terminal text, but every spend-leash line in it is the
//    real stdout of dist/hook.mjs, fed hook inputs and a fixture transcript.
// macOS only (uses Quick Look `qlmanage` to rasterize SVG) + ffmpeg.
// Usage: npm run demo:record
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "leash-demo-"));
const project = join(home, "my-project");
mkdirSync(project);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  SPEND_LEASH_HOME: join(home, ".spend-leash"),
  NO_COLOR: "1",
};
// Cosmetic only: show the temp HOME as ~ and the handoff path relative to the project.
const tidy = (s) => s.replace(/\S*my-project\//g, "").replaceAll(home, "~");

const cli = (args) => {
  const r = spawnSync("node", [join(root, "dist/cli.js"), ...args], {
    cwd: project,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")} failed: ${r.stderr}`);
  return tidy(r.stdout).trimEnd().split("\n");
};

const hook = (input) => {
  const r = spawnSync("node", [join(root, "dist/hook.mjs"), input.hook_event_name], {
    input: JSON.stringify(input),
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`hook ${input.hook_event_name} failed: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
};

const spendLine = (id, outputTokens) =>
  `${JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 1200, output_tokens: outputTokens },
      content: [{ type: "text", text: "..." }],
    },
  })}\n`;

function session(sid, prompt) {
  const transcript = join(home, `${sid}.jsonl`);
  writeFileSync(transcript, "");
  const base = { session_id: sid, transcript_path: transcript, cwd: project };
  return {
    spend: (id, tokens) => appendFileSync(transcript, spendLine(id, tokens)),
    send: (event, extra = {}) => hook({ ...base, hook_event_name: event, ...extra }),
    prompt: () => hook({ ...base, hook_event_name: "UserPromptSubmit", prompt }),
    tool: (name, input) => hook({ ...base, hook_event_name: "PreToolUse", tool_name: name, tool_input: input }),
  };
}

// ---- real output ----
const initOut = cli(["init", "--yes"]);

// An earlier, finished task so `report` shows more than one row.
const a = session("demo-a", "add a --json flag to the export command");
a.prompt();
a.spend("a1", 38_000);
a.send("Stop");

// The task in the recording.
const b = session("demo-b", "refactor the auth module to use sessions");
b.prompt();
b.spend("b1", 90_000);
b.tool("Read", { file_path: "src/auth/login.ts" });
b.spend("b2", 74_000);
const warn = b.tool("Edit", { file_path: "src/auth/session.ts" });
b.spend("b3", 40_000);
const stop = b.tool("Bash", { command: "npm test" });
b.send("Stop");
const warnText = tidy(warn?.hookSpecificOutput?.additionalContext ?? "");
const stopText = tidy(stop?.stopReason ?? "");
if (!warnText || !stopText) throw new Error("expected a warn and a stop from the hook");

const reportOut = cli(["report"]);

// ---- rendering ----
const W = 1280, H = 720, FS = 19, LH = 27, X = 36, Y0 = 92, COLS = 100;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const C = { text: "#c9d1d9", cmd: "#7ee787", dim: "#8b949e", warn: "#e3b341", stop: "#ff7b72", tool: "#79c0ff" };

function wrap(text, indent, color) {
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > COLS - indent.length) {
      out.push([indent + line, color]);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  out.push([indent + line, color]);
  return out;
}

function svg(lines, cursor) {
  const shown = lines.slice(-Math.floor((H - Y0 - 10) / LH));
  const body = shown
    .map(([l, c], i) => {
      const txt = esc(l) + (cursor && i === shown.length - 1 ? "▌" : "");
      return `<text x="${X}" y="${Y0 + i * LH}" fill="${c}" xml:space="preserve">${txt}</text>`;
    })
    .join("");
  // Square canvas: qlmanage renders thumbnails square; we crop to W x H afterwards.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
<rect width="${W}" height="${W}" fill="#0d1117"/>
<rect x="0" y="0" width="${W}" height="44" fill="#161b22"/>
<circle cx="26" cy="22" r="7" fill="#ff5f57"/><circle cx="50" cy="22" r="7" fill="#febc2e"/><circle cx="74" cy="22" r="7" fill="#28c840"/>
<text x="${W / 2}" y="28" fill="#8b949e" font-family="Helvetica Neue, sans-serif" font-size="15" text-anchor="middle">~/my-project</text>
<g font-family="Menlo, monospace" font-size="${FS}">${body}</g></svg>`;
}

const frames = []; // [lines, cursor, seconds]
const typeCmd = (cmd, prefix = []) => {
  for (let i = 2; i < cmd.length; i += 4) frames.push([[...prefix, [`$ ${cmd.slice(0, i)}`, C.cmd]], true, 0.05]);
  frames.push([[...prefix, [`$ ${cmd}`, C.cmd]], true, 0.35]);
};
const lineColor = (l) => (/^\$ /.test(l) ? C.cmd : /^Done|^spend-leash init/.test(l) ? C.text : C.text);

// Scene 1: init
typeCmd("npx spend-leash init --yes");
let s = [["$ npx spend-leash init --yes", C.cmd]];
for (const l of initOut) {
  s = [...s, [l, lineColor(l)]];
  if (l.trim()) frames.push([s, false, 0.07]);
}
frames.push([s, false, 1.3]);

// Scene 2: a simulated session; spend-leash lines are the real hook output.
s = [
  ["# simulated Claude Code session; the spend-leash lines are real hook output", C.dim],
  ["", C.text],
  ["> refactor the auth module to use sessions", C.cmd],
];
frames.push([s, false, 0.6]);
s = [...s, ["", C.text], ["● Read(src/auth/login.ts)", C.tool]];
frames.push([s, false, 0.5]);
s = [...s, ["● Edit(src/auth/session.ts)", C.tool], ...wrap(warnText, "  ⎿ ", C.warn)];
frames.push([s, false, 1.2]);
s = [...s, ["", C.text], ["● Bash(npm test)", C.tool], ...wrap(stopText, "  ⎿ ", C.stop)];
frames.push([s, false, 2.0]);

// Scene 3: report
typeCmd("npx spend-leash report");
s = [["$ npx spend-leash report", C.cmd]];
for (const l of reportOut) s = [...s, [l, C.text]];
frames.push([s, false, 2.0]);

const work = mkdtempSync(join(tmpdir(), "leash-frames-"));
const list = [];
frames.forEach(([lines, cursor, secs], i) => {
  const name = `f${String(i).padStart(4, "0")}`;
  writeFileSync(join(work, `${name}.svg`), svg(lines, cursor));
  list.push([name, secs]);
});

function rasterize(svgPaths) {
  for (let i = 0; i < svgPaths.length; i += 40) {
    execFileSync("qlmanage", ["-t", "-s", String(W), "-o", work, ...svgPaths.slice(i, i + 40)], { stdio: "ignore" });
  }
}
rasterize(list.map(([n]) => join(work, `${n}.svg`)));
mkdirSync(join(work, "png"));
for (const f of readdirSync(work)) {
  if (f.endsWith(".svg.png") && f.startsWith("f")) renameSync(join(work, f), join(work, "png", f.replace(".svg.png", ".png")));
}
const concat =
  list.map(([n, secs]) => `file '${join(work, "png", `${n}.png`)}'\nduration ${secs}`).join("\n") +
  `\nfile '${join(work, "png", `${list.at(-1)[0]}.png`)}'\n`;
writeFileSync(join(work, "list.txt"), concat);
const gif = join(root, "docs/demo.gif");
execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"),
  "-vf", `crop=${W}:${H}:0:0,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none`,
  "-loop", "0", gif]);
const total = list.reduce((t, [, secs]) => t + secs, 0);
console.log(`wrote ${gif} (${frames.length} frames, ${total.toFixed(1)} s)`);

// ---- social preview: demo/social-preview.svg (1280x640) -> docs/social-preview.png ----
const inner = readFileSync(join(root, "demo/social-preview.svg"), "utf8")
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "");
writeFileSync(
  join(work, "social.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280" viewBox="0 0 1280 1280">${inner}</svg>`,
);
rasterize([join(work, "social.svg")]);
const social = join(root, "docs/social-preview.png");
execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", join(work, "social.svg.png"),
  "-vf", "crop=1280:640:0:0", "-frames:v", "1", social]);
console.log(`wrote ${social}`);

rmSync(work, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
