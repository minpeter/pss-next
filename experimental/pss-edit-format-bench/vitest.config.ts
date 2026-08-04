import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
