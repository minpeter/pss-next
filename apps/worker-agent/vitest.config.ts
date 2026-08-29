import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-runtime\/platform\/durable-object\/cloudflare\/image-codecs$/,
        replacement: resolve(
          import.meta.dirname,
          "src/testing/image-codecs-test-shim.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/platform\/durable-object\/cloudflare$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/durable-object/cloudflare/agents/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/platform\/durable-object$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/durable-object/host/storage-host.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/otel$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/otel/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/platform\/memory$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/memory/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/platform\/file$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/file/index.ts"
        ),
      },
      {
        find: /^cloudflare:workers$/,
        replacement: resolve(
          import.meta.dirname,
          "src/testing/cloudflare-workers-test-shim.ts"
        ),
      },
      {
        find: /^agents$/,
        replacement: resolve(
          import.meta.dirname,
          "src/testing/agents-test-shim.ts"
        ),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
