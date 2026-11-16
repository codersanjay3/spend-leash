import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The integration tests drive the real built binaries, so build once up front.
// Run tsup's own CLI with the current node binary: `npx` is a `.cmd` shim on
// Windows, and Node refuses to spawn `.cmd`/`.bat` files without a shell.
export default function setup() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [require.resolve("tsup/dist/cli-default.js"), "--silent"], {
    cwd: root,
    stdio: "inherit",
  });
}
