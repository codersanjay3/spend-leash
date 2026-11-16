import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { approve, type CommandEnv, parseFlags, stripPrefix } from "./cli-common.js";
import { applyUninstall, planUninstall, readInstallRecord } from "./install.js";

export async function cmdUninstall(argv: string[], env: CommandEnv): Promise<number> {
  const f = parseFlags(argv, {
    scope: { type: "string" }, // accepted for symmetry; the install record decides what to undo
    yes: { type: "boolean", short: "y" },
  });
  const { ctx } = env;
  const record = readInstallRecord(ctx);
  if (!record) {
    console.log("Nothing to uninstall.");
    return 0;
  }
  const plan = planUninstall(ctx, record);

  console.log(pc.bold("spend-leash uninstall"));
  console.log("Will remove:");
  console.log(`  ${record.hooks.length} hooks from ${pc.cyan(record.settingsPath)}`);
  if (record.statusLine) {
    console.log(
      record.statusLine.original === null
        ? `  the status line in ${pc.cyan(record.statusLine.settingsPath)}`
        : `  the status line wrapper in ${pc.cyan(record.statusLine.settingsPath)} (your original is restored)`,
    );
  }
  for (const w of plan.warnings) console.log(`note: ${w}`);

  if (!(await approve(Boolean(f.yes), "Apply these changes?", env.ask))) {
    console.log("Aborted. Nothing changed.");
    return 1;
  }
  try {
    applyUninstall(ctx, plan);
  } catch (e) {
    throw new Error(stripPrefix((e as Error).message));
  }
  for (const name of ["hook.mjs", "statusline.mjs"]) {
    const p = join(ctx.leashHome, name);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch (e) {
      console.log(`note: could not remove ${p}: ${(e as Error).message}; delete it by hand`);
    }
  }
  console.log(pc.green("Done. spend-leash is uninstalled."));
  console.log(
    `Kept your ledger, handoffs and config in ${ctx.leashHome}; delete it to remove them.`,
  );
  return 0;
}
