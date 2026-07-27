import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packAgentArtifact } from "@minpeter/pss-bench-shared/pack-agent";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(benchmarkRoot, "../..");

await packAgentArtifact({
  benchmarkRoot,
  packageDirectory: resolve(repositoryRoot, "apps/coding-agent"),
  packageFilter: "@minpeter/pss-coding-agent",
  repositoryRoot,
  stableTarballName: "pss-coding-agent.tgz",
});
