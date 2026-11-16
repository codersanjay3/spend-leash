// Bundles the simulator into site-dist/ and fails if anything Node-only slipped in.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsup";

const out = "site-dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entry: { main: "site/main.ts" },
  outDir: out,
  format: ["iife"],
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: false,
  clean: false,
  dts: false,
  silent: true,
  config: false,
  outExtension: () => ({ js: ".js" }),
});
for (const f of ["index.html", "style.css"]) copyFileSync(join("site", f), join(out, f));

const bad = /["'`]node:[a-z_/]+["'`]|\brequire\(/;
const offenders = readdirSync(out)
  .filter((f) => f.endsWith(".js"))
  .filter((f) => bad.test(readFileSync(join(out, f), "utf8")));
if (offenders.length) {
  console.error(`site build failed: node: import or require( found in ${offenders.join(", ")}`);
  process.exit(1);
}
console.log(`site built -> ${out}/ (${readdirSync(out).join(", ")}), no node: imports`);
