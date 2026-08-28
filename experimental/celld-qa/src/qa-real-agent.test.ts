import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCleanupReceipt } from "./campaign-cleanup";
import { type JsonValue, readCampaignReport } from "./campaign-report";
import {
  type RealAgentCampaignDependencies,
  runRealAgentCampaign,
} from "./qa-real-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("real-agent campaign runner", () => {
  it("emits a binary CampaignReport and cleanup receipt for every scenario", async () => {
    // Given deterministic HTTP scenario results and lifecycle spies
    const directory = await mkdtemp(join(tmpdir(), "celld-real-agent-"));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, "report.json");
    const calls: string[] = [];
    const scenarioResults: ReadonlyMap<
      string,
      Readonly<Record<string, JsonValue>>
    > = new Map<string, Readonly<Record<string, JsonValue>>>([
      ["tool-checkpoint:run", { passed: true, sideEffectCount: 1 }],
      [
        "tool-checkpoint:verify",
        { checkpointed: true, passed: true, sideEffectCount: 1 },
      ],
      [
        "input-ordering:run",
        {
          inputSources: ["send", "steer", "follow-up", "follow-up", "notify"],
          passed: true,
        },
      ],
      [
        "compaction:run",
        {
          automaticCompactions: 1,
          manualStatus: "compacted",
          passed: true,
        },
      ],
      [
        "compaction:verify",
        { markers: ["CMP-A", "CMP-B", "CMP-C"], passed: true },
      ],
      [
        "large-history:run",
        {
          chunked: true,
          markers: ["LARGE-00", "LARGE-01", "LARGE-02", "LARGE-03"],
          passed: true,
          payloadBytes: 32_768,
        },
      ],
      [
        "attachment:run",
        {
          hydratedByteLength: 68,
          hydratedMediaType: "image/png",
          normalized: true,
          passed: true,
          persistedReference: true,
        },
      ],
    ]);
    const dependencies: RealAgentCampaignDependencies = {
      cleanupPrefix: () => {
        calls.push("cleanup-prefix");
        return Promise.resolve();
      },
      createBucket: () => {
        calls.push("create-bucket");
        return Promise.resolve();
      },
      deploy: () => {
        calls.push("deploy");
        return Promise.resolve();
      },
      fetchScenario: (_baseUrl, scenario, phase) => {
        calls.push(`fetch:${scenario}:${phase}`);
        const result = scenarioResults.get(`${scenario}:${phase}`);
        if (result === undefined) {
          throw new Error(`Missing fixture for ${scenario}:${phase}`);
        }
        return Promise.resolve(result);
      },
      makeWatchDirectory: () => Promise.resolve(directory),
      removeWatchDirectory: () => {
        calls.push("remove-watch");
        return Promise.resolve();
      },
      restartCelld: () => {
        calls.push("restart");
        return Promise.resolve({ pid: 2 });
      },
      startCelld: () => {
        calls.push("start");
        return { pid: 1 };
      },
      stopCelld: () => {
        calls.push("stop");
        return Promise.resolve();
      },
      waitForListening: () => {
        calls.push("ready");
        return Promise.resolve();
      },
    };

    // When the campaign runs through both restart continuity boundaries
    const report = await runRealAgentCampaign(
      { port: 16_431, report: reportPath },
      dependencies
    );

    // Then the report is machine-parseable and cleanup is terminal and clean
    expect(report.passed).toBe(true);
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual([
      "tool-checkpoint-restart",
      "input-ordering",
      "compaction-restart",
      "large-history",
      "attachment-lifecycle",
    ]);
    await expect(readCampaignReport(reportPath)).resolves.toEqual(report);
    const receipt = await readCleanupReceipt(report.cleanup.receiptPath);
    expect(receipt.at(-1)).toMatchObject({
      kind: "cleanup-complete",
      passed: true,
    });
    expect(calls.filter((call) => call === "restart")).toHaveLength(2);
    expect(calls.slice(-3)).toEqual(["stop", "cleanup-prefix", "remove-watch"]);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      command: "real-agent",
      passed: true,
      schemaVersion: 1,
    });
  });
});
