import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function resetTrialLog(outputDir: string): Promise<string> {
  const trialsPath = join(outputDir, "trials.jsonl");
  await writeFile(trialsPath, "");
  return trialsPath;
}
