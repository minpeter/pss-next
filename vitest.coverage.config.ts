import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
    include: [
      "packages/runtime/src/**/*.test.{ts,js}",
      "apps/coding-agent/**/*.test.{ts,js}",
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
        "packages/runtime/src/**": {
          statements: 83,
          branches: 75,
          functions: 87,
          lines: 83,
        },
        "apps/coding-agent/src/**": {
          statements: 75,
          branches: 68,
          functions: 74,
          lines: 75,
        },
      },
      include: [
        "packages/runtime/src/**/*.ts",
        "apps/coding-agent/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.{ts,js}",
        "**/*.test-support.ts",
        "**/test-support.ts",
        "**/test-fixtures.ts",
      ],
    },
  },
});
