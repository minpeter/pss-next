import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export async function resetTrialLog(outputDir: string): Promise<string> {
  const trialsPath = join(outputDir, "trials.jsonl");
  await writeFile(trialsPath, "");
  return trialsPath;
}
