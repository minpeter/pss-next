import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const fromRoot = (...segments: string[]) =>
  resolve(import.meta.dirname, ...segments);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-runtime$/,
        replacement: fromRoot("packages/runtime/src/index.ts"),
      },
      {
        find: /^@minpeter\/pss-runtime\/namespace$/,
        replacement: fromRoot("packages/runtime/src/namespace.ts"),
      },
      {
        find: /^@minpeter\/pss-runtime\/platform\/cloudflare\/image-codecs$/,
        replacement: fromRoot(
          "packages/runtime/src/platform/cloudflare/image-codecs-edge.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/(.+)$/,
        replacement: fromRoot("packages/runtime/src/$1/index.ts"),
      },
      {
        find: /^@minpeter\/pss-coding-agent\/extension$/,
        replacement: fromRoot("apps/coding-agent/src/extensions/index.ts"),
      },
      {
        find: /^@minpeter\/pss-extension-(latex|mermaid|web)$/,
        replacement: fromRoot("extensions/$1/src/index.ts"),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
    include: [
      "packages/runtime/src/**/*.test.ts",
      "apps/coding-agent/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/core",
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 82,
        lines: 80,
      },
      include: [
        "packages/runtime/src/**/*.ts",
        "apps/coding-agent/src/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.test-support.ts", "**/test-fixtures.ts"],
    },
  },
});
