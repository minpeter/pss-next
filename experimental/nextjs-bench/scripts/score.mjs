import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCampaignCommand } from "@minpeter/pss-bench-shared/score-cli";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await scoreCampaignCommand({
  argv: process.argv.slice(2),
  benchmarkRoot,
});
