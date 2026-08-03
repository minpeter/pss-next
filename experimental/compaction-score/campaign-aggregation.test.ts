import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CampaignAggregationValidationCode,
  CampaignAggregationValidationError,
  runCampaignAggregationCli,
} from "./campaign-aggregation";
import {
  profileIdentity,
  writeBaselineSummary,
  writeCampaignRunFixture,
} from "./orchestration.test-support";

const SECRET_SENTINEL = "G012_CAMPAIGN_SECRET_SENTINEL";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function baseline(): Promise<string> {
  const fixture = await writeBaselineSummary();
  temporaryDirectories.push(fixture.directory);
  return fixture.path;
}

async function campaignRun(
  options?: Parameters<typeof writeCampaignRunFixture>[0]
): Promise<string> {
  const directory = await writeCampaignRunFixture(options);
  temporaryDirectories.push(directory);
  return directory;
}

async function invoke(args: readonly string[]) {
  let stderr = "";
  let stdout = "";
  const exitCode = await runCampaignAggregationCli(args, {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stderr, stdout };
}

describe("campaign aggregation CLI", () => {
  it("represents profile mismatch with a typed validation code", () => {
    const error = new CampaignAggregationValidationError(
      "CAMPAIGN_PROFILE_MISMATCH"
    );
    const code: CampaignAggregationValidationCode = error.code;

    expect(error).toMatchObject({
      code,
      message: "CAMPAIGN_PROFILE_MISMATCH",
      name: "CampaignAggregationValidationError",
    });
  });

  it("promotes three valid tuples across two origins and records capability", async () => {
    const baselinePath = await baseline();
    const first = await campaignRun({
      baseUrl: "https://one.example/v1",
      label: "gateway-one",
      modelId: "model-a",
    });
    const second = await campaignRun({
      baseUrl: "https://one.example/compatible",
      label: "gateway-one",
      modelId: "model-b",
    });
    const third = await campaignRun({
      baseUrl: "https://two.example/v1",
      label: "gateway-two",
      manifestExtra: { authorization: `Bearer ${SECRET_SENTINEL}` },
      modelId: "model-c",
      seedCapability: {
        capability: "unsupported",
        status: "seeded-probe-rejected-seedless-probe-succeeded",
      },
      summaryExtra: { rawProviderError: SECRET_SENTINEL },
      trialExtra: { apiKey: SECRET_SENTINEL },
    });

    const result = await invoke([
      "--baseline",
      baselinePath,
      first,
      second,
      third,
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly campaigns: readonly {
        readonly decision: { readonly passed: boolean };
        readonly provider: { readonly baseOrigin: string };
        readonly seedCapability: { readonly capability: string };
      }[];
      readonly decision: string;
      readonly failures: readonly unknown[];
      readonly profile: { readonly hash: string; readonly id: string };
    };

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(output).toMatchObject({
      decision: "promote",
      failures: [],
      profile: profileIdentity("senpi-maximal"),
    });
    expect(output.campaigns).toHaveLength(3);
    expect(output.campaigns.every(({ decision }) => decision.passed)).toBe(
      true
    );
    expect(output.campaigns[2]?.seedCapability.capability).toBe("unsupported");
    expect(
      new Set(output.campaigns.map(({ provider }) => provider.baseOrigin)).size
    ).toBe(2);
    expect(result.stdout).not.toContain(SECRET_SENTINEL);
  });

  it("rejects duplicate sanitized campaign tuples", async () => {
    const baselinePath = await baseline();
    const duplicateOptions = {
      baseUrl: "https://one.example/a",
      label: "gateway-one",
      modelId: "model-a",
    } as const;
    const first = await campaignRun(duplicateOptions);
    const duplicate = await campaignRun({
      ...duplicateOptions,
      baseUrl: "https://one.example/different-path?ignored=true",
    });
    const third = await campaignRun({
      baseUrl: "https://two.example",
      label: "gateway-two",
      modelId: "model-c",
    });

    const result = await invoke([
      "--baseline",
      baselinePath,
      first,
      duplicate,
      third,
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly decision: string;
      readonly failures: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(1);
    expect(output.decision).toBe("no-promotion");
    expect(output.failures.map(({ code }) => code)).toContain(
      "campaign-tuple-duplicate"
    );
  });

  it("rejects campaigns that disagree on the attributed profile", async () => {
    const baselinePath = await baseline();
    const first = await campaignRun({
      baseUrl: "https://one.example/v1",
      label: "gateway-one",
      modelId: "model-a",
    });
    const second = await campaignRun({
      baseUrl: "https://one.example/v2",
      label: "gateway-one",
      modelId: "model-b",
    });
    const third = await campaignRun({
      baseUrl: "https://two.example/v1",
      label: "gateway-two",
      modelId: "model-c",
      profileId: "senpi-minimal",
    });

    const result = await invoke([
      "--baseline",
      baselinePath,
      first,
      second,
      third,
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly failures: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(1);
    expect(output.failures.map(({ code }) => code)).toContain(
      "CAMPAIGN_PROFILE_MISMATCH"
    );
  });

  it("rejects three aliases on one sanitized base origin", async () => {
    const baselinePath = await baseline();
    const first = await campaignRun({
      baseUrl: "https://same.example/one",
      label: "alias-a",
      modelId: "model-a",
    });
    const second = await campaignRun({
      baseUrl: "https://same.example/two",
      label: "alias-b",
      modelId: "model-b",
    });
    const third = await campaignRun({
      baseUrl: "https://same.example/three",
      label: "alias-c",
      modelId: "model-c",
    });

    const result = await invoke([
      "--baseline",
      baselinePath,
      first,
      second,
      third,
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly failures: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(1);
    expect(output.failures.map(({ code }) => code)).toContain(
      "campaign-origin-diversity-insufficient"
    );
  });

  it("provides a run-directory-only help surface", async () => {
    const result = await invoke(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--baseline SUMMARY_JSON");
    expect(result.stdout).toContain("RUN_DIR RUN_DIR RUN_DIR");
    expect(result.stdout).not.toContain("API_KEY");
  });
});
