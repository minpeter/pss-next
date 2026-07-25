import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-runtime$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-coding-agent\/env$/,
        replacement: resolve(
          import.meta.dirname,
          "../../apps/coding-agent/src/env.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-coding-agent\/model$/,
        replacement: resolve(
          import.meta.dirname,
          "../../apps/coding-agent/src/model.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-coding-agent$/,
        replacement: resolve(
          import.meta.dirname,
          "../../apps/coding-agent/src/index.ts"
        ),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
