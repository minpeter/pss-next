import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

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
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/env.ts",
    "src/extensions/index.ts",
    "src/model.ts",
    "src/thread-config.ts",
    "src/thread-inspect.ts",
    "src/tools.ts",
    "src/tui/app.ts",
  ],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  define:
    version === undefined ? {} : { PSS_CLI_VERSION: JSON.stringify(version) },
});
