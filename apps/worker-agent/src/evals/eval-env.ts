import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadWorkerAgentEvalEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;

  const varsPath = resolve(import.meta.dirname, "../../.dev.vars");
  if (existsSync(varsPath)) {
    process.loadEnvFile(varsPath);
  }
}
