import { defineConfig } from "tsdown";

export default defineConfig({
  dts: true,
  entry: ["src/index.ts", "src/mathjax-worker.ts"],
  fixedExtension: false,
  root: "src",
  sourcemap: true,
  unbundle: true,
});
