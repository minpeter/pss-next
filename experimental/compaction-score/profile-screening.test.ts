import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  profileIdentity,
  writeCampaignRunFixture,
} from "./orchestration.test-support";
import { runProfileScreeningCli } from "./profile-screening";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

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
  const exitCode = await runProfileScreeningCli(args, {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stderr, stdout };
}

describe("profile screening CLI", () => {
  it("screens attributed run directories in canonical profile order", async () => {
    const baseline = await campaignRun({ profileId: "production" });
    const maximal = await campaignRun({ profileId: "senpi-maximal" });
    const minimal = await campaignRun({ profileId: "senpi-minimal" });

    const result = await invoke([
      "--baseline",
      baseline,
      "--profile",
      `senpi-maximal=${maximal}`,
      "--profile",
      `senpi-minimal=${minimal}`,
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly baseline: { readonly hash: string; readonly id: string };
      readonly profiles: readonly {
        readonly decision: { readonly passed: boolean };
        readonly profile: { readonly hash: string; readonly id: string };
      }[];
      readonly screened: boolean;
      readonly winner: { readonly hash: string; readonly id: string } | null;
    };

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(output.screened).toBe(true);
    expect(output.baseline).toEqual(profileIdentity("production"));
    expect(output.profiles.map(({ profile }) => profile)).toEqual([
      profileIdentity("senpi-minimal"),
      profileIdentity("senpi-maximal"),
    ]);
    expect(output.profiles.every(({ decision }) => decision.passed)).toBe(true);
    expect(output.winner).toEqual(profileIdentity("senpi-maximal"));
  });

  it("rejects an unknown requested profile before reading run artifacts", async () => {
    const result = await invoke([
      "--baseline",
      "/not-read-for-invalid-profile",
      "--profile",
      "does-not-exist=/also-not-read",
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly failures: readonly { readonly code: string }[];
      readonly screened: boolean;
    };

    expect(result).toMatchObject({ exitCode: 1, stderr: "" });
    expect(output.screened).toBe(false);
    expect(output.failures.map(({ code }) => code)).toContain(
      "PROFILE_UNKNOWN"
    );
  });

  it("rejects a trial whose profile is not attributable to its manifest", async () => {
    const baseline = await campaignRun({ profileId: "production" });
    const candidate = await campaignRun({
      profileId: "senpi-minimal",
      trialProfile: profileIdentity("senpi-maximal"),
    });

    const result = await invoke([
      "--baseline",
      baseline,
      "--profile",
      `senpi-minimal=${candidate}`,
    ]);
    const output = JSON.parse(result.stdout) as {
      readonly failures: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(1);
    expect(output.failures.map(({ code }) => code)).toContain(
      "TRIAL_PROFILE_MISMATCH"
    );
  });

  it("provides a credential-free help surface", async () => {
    const result = await invoke(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--baseline RUN_DIR");
    expect(result.stdout).toContain("--profile PROFILE_ID=RUN_DIR");
    expect(result.stdout).not.toContain("API_KEY");
  });
});
