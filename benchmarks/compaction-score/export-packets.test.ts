import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PROFILE_HASH_PATTERN = /^sha256:[\da-f]{64}$/;

describe("export-packets CLI prompt profiles", () => {
  it("exports a named production profile through the packet surface", async () => {
    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "--conditions=@minpeter/pss-source",
        "export-packets.ts",
        "--profile",
        "production",
        "baseline=profile-cli-test",
      ],
      { cwd: import.meta.dirname }
    );

    const packets = JSON.parse(stdout) as readonly [
      {
        readonly profile: {
          readonly hash: string;
          readonly id: string;
          readonly rules: readonly string[];
        };
      },
    ];
    expect(packets[0].profile).toMatchObject({
      id: "production",
      rules: expect.arrayContaining(["internal-control-isolation"]),
    });
    expect(packets[0].profile.hash).toMatch(PROFILE_HASH_PATTERN);
  }, 30_000);

  it("rejects an unknown profile before packet generation", async () => {
    const result = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "--conditions=@minpeter/pss-source",
        "export-packets.ts",
        "--profile",
        "does-not-exist",
      ],
      { cwd: import.meta.dirname }
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: { readonly code?: number; readonly stderr?: string }) => ({
        code: error.code ?? 1,
        stderr: error.stderr ?? "",
      })
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Unknown compaction prompt profile: does-not-exist"
    );
  }, 30_000);
});
