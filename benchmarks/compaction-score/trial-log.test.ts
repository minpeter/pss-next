import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resetTrialLog } from "./trial-log";

describe("resetTrialLog", () => {
  it("removes stale trial records before a benchmark rerun", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "compaction-score-log-"));
    const trialsPath = join(outputDir, "trials.jsonl");
    await writeFile(trialsPath, '{"id":"stale"}\n');

    const resetPath = await resetTrialLog(outputDir);

    expect(resetPath).toBe(trialsPath);
    await expect(readFile(trialsPath, "utf8")).resolves.toBe("");
  });
});
