import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/otel/index.ts",
    "src/platform/cloudflare/index.ts",
    // Edge-only: static .wasm imports for Workers (not pulled into Node CF barrel).
    "src/platform/cloudflare/image-codecs-edge.ts",
    "src/platform/file/index.ts",
    "src/platform/memory/index.ts",
    "src/platform/sql-queue/index.ts",
    "src/execution/index.ts",
    "src/namespace.ts",
    "src/evals/index.ts",
    "src/evals/cli-bin.ts",
    "src/fsm/index.ts",
    "src/channel/index.ts",
    "src/testing/index.ts",
  ],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  inputOptions: {
    // The dts pipeline (rolldown-plugin-dts:fake-js) intentionally emits no
    // sourcemap for `.d.ts` chunks, which triggers a spurious SOURCEMAP_BROKEN
    // warning even though the published `.js.map` files are correct. Drop only
    // that one log and let every other warning through.
    onLog(level, log, defaultHandler) {
      if (log.code === "SOURCEMAP_BROKEN") {
        return;
      }
      defaultHandler(level, log);
    },
  },
});
