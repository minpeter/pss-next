import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareReports } from "./qa-compare";

describe("Celld QA comparison", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true }))
    );
  });

  it("fails an unchanged baseline and passes removed retention", async () => {
    const directory = await mkdtemp(join("/var/tmp", "pss-celld-compare-"));
    directories.push(directory);
    const baseline = join(directory, "baseline.json");
    const unchanged = join(directory, "unchanged.json");
    const candidate = join(directory, "candidate.json");
    await Promise.all([
      writeFile(baseline, JSON.stringify(report(100, 12_000))),
      writeFile(unchanged, JSON.stringify(report(100, 12_000))),
      writeFile(candidate, JSON.stringify(report(0, 0))),
    ]);

    await expect(
      compareReports({ baseline, candidate: unchanged })
    ).resolves.toMatchObject({ passed: false });
    await expect(
      compareReports({ baseline, candidate })
    ).resolves.toMatchObject({ passed: true });
  });
});

const directories: string[] = [];

function report(retainedResponseSlots: number, retainedResponseBytes: number) {
  return {
    celldCpuSystemTicks: 10,
    celldCpuUserTicks: 20,
    cpuSystemUs: 30,
    elapsedMs: 40,
    errors: 0,
    maxRssBytes: 50,
    retainedResponseBytes,
    retainedResponseSlots,
    runnerCpuUserUs: 60,
  };
}
