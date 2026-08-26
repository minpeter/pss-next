import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { defineConfig } from "tsdown";
import { configureBuildTemp } from "./build-temp.ts";

configureBuildTemp({
  ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
  env: process.env,
  home: homedir(),
});

const packageJson: unknown = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);
const version =
  typeof packageJson === "object" &&
  packageJson !== null &&
  "version" in packageJson &&
  typeof packageJson.version === "string"
    ? packageJson.version
    : undefined;

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/env.ts",
    "src/extensions/index.ts",
    "src/extensions/legacy.ts",
    "src/instructions.ts",
    "src/model.ts",
    "src/provider-registry.ts",
    "src/rpc.ts",
    "src/rpc-cli.ts",
    "src/thread-config.ts",
    "src/thread-inspect.ts",
    "src/tools.ts",
    "src/tui/app.ts",
    "src/workspace-tools/index.ts",
  ],
  unbundle: true,
  // Built-in extensions are private workspace packages; inline them so the
  // published coding-agent tarball does not depend on unpublished code.
  deps: {
    alwaysBundle: [
      "@minpeter/pss-extension-latex",
      "@minpeter/pss-extension-mermaid",
      "@minpeter/pss-extension-web",
    ],
  },
  root: "src",
  // Worker entrypoints are spawned by URL at runtime, so the bundler cannot
  // see them; ship them next to the inlined extension chunks.
  copy: [
    {
      from: "../../extensions/latex/dist/mathjax-worker.js",
      to: "dist/extensions/latex/dist",
    },
    {
      from: "../../extensions/mermaid/dist/mermaid-art-worker.js",
      to: "dist/extensions/mermaid/dist",
    },
  ],
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  define:
    version === undefined ? {} : { PSS_CLI_VERSION: JSON.stringify(version) },
});
