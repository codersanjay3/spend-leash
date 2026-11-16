import { defineConfig } from "tsup";

// Standalone: must not import any package at runtime (fast cold start).
const standalone = (name: string, entry: string) => ({
  entry: { [name]: entry },
  format: ["esm" as const],
  target: "node20",
  platform: "node" as const,
  outExtension: () => ({ js: ".mjs" }),
  noExternal: [/.*/],
  minify: false,
});

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
  },
  standalone("hook", "src/hook.ts"),
  standalone("statusline", "src/statusline.ts"),
]);
