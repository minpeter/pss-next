import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DIGEST_PATTERN = /^[\da-f]{64}$/;
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

  it("exports and parses the real long-session packet", async () => {
    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "--conditions=@minpeter/pss-source",
        "export-packets.ts",
        "long-session=packet-long-session",
      ],
      { cwd: import.meta.dirname, maxBuffer: 1024 * 1024 }
    );

    const [packet] = JSON.parse(stdout) as readonly [
      {
        readonly compactionEnds: readonly number[];
        readonly messages: ModelMessage[];
        readonly questions: readonly { readonly category: string }[];
        readonly scenario: string;
      },
    ];
    const end = packet.compactionEnds[0] ?? 0;
    const parsed = {
      categories: [
        ...new Set(packet.questions.map(({ category }) => category)),
      ],
      digest: createHash("sha256")
        .update(JSON.stringify(packet.messages))
        .digest("hex"),
      ends: packet.compactionEnds,
      questions: packet.questions.length,
      tokens: estimateModelMessagesTokens(packet.messages.slice(0, end)),
    };

    expect(packet.scenario).toBe("long-session");
    expect(parsed.digest).toMatch(DIGEST_PATTERN);
    expect(parsed.tokens).toBeGreaterThan(32_000);
    expect(parsed.questions).toBe(18);
    expect(parsed.categories).toHaveLength(8);
    expect(parsed.ends).toEqual([134]);
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
