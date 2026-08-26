import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { typescriptSubprocessArguments } from "./typescript-subprocess.test-support";

const execFileAsync = promisify(execFile);
const DIGEST_PATTERN = /^[\da-f]{64}$/;
const PROFILE_HASH_PATTERN = /^sha256:[\da-f]{64}$/;

interface ProfilePacket {
  readonly profile: {
    readonly hash: string;
    readonly id: string;
    readonly rules: readonly string[];
  };
}

interface LongSessionPacket {
  readonly compactionEnds: readonly number[];
  readonly messages: ModelMessage[];
  readonly questions: readonly { readonly category: string }[];
  readonly scenario: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSingletonArray<Item>(
  value: unknown,
  isItem: (candidate: unknown) => candidate is Item
): value is [Item] {
  return Array.isArray(value) && value.length === 1 && isItem(value[0]);
}

function isProfilePacket(value: unknown): value is ProfilePacket {
  return (
    isRecord(value) &&
    isRecord(value.profile) &&
    typeof value.profile.hash === "string" &&
    typeof value.profile.id === "string" &&
    Array.isArray(value.profile.rules) &&
    value.profile.rules.every((rule) => typeof rule === "string")
  );
}

function isExpectedModelMessage(value: unknown): value is ModelMessage {
  if (!(isRecord(value) && typeof value.role === "string")) {
    return false;
  }
  if (value.role === "user") {
    return typeof value.content === "string";
  }
  if (value.role === "assistant") {
    return (
      typeof value.content === "string" ||
      (Array.isArray(value.content) &&
        value.content.every(
          (part) =>
            isRecord(part) &&
            part.type === "tool-call" &&
            typeof part.toolCallId === "string" &&
            typeof part.toolName === "string" &&
            isRecord(part.input) &&
            typeof part.input.command === "string"
        ))
    );
  }
  return (
    value.role === "tool" &&
    Array.isArray(value.content) &&
    value.content.every(
      (part) =>
        isRecord(part) &&
        part.type === "tool-result" &&
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string" &&
        isRecord(part.output) &&
        part.output.type === "text" &&
        typeof part.output.value === "string"
    )
  );
}

function isLongSessionPacket(value: unknown): value is LongSessionPacket {
  return (
    isRecord(value) &&
    Array.isArray(value.compactionEnds) &&
    value.compactionEnds.every((end) => typeof end === "number") &&
    Array.isArray(value.messages) &&
    value.messages.every(isExpectedModelMessage) &&
    Array.isArray(value.questions) &&
    value.questions.every(
      (question) => isRecord(question) && typeof question.category === "string"
    ) &&
    typeof value.scenario === "string"
  );
}

describe("export-packets CLI prompt profiles", () => {
  it("exports a named production profile through the packet surface", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      typescriptSubprocessArguments("export-packets.ts", [
        "--profile",
        "production",
        "baseline=profile-cli-test",
      ]),
      { cwd: import.meta.dirname }
    );

    const packets: unknown = JSON.parse(stdout);
    if (!isSingletonArray(packets, isProfilePacket)) {
      throw new TypeError("Expected one exported profile packet.");
    }
    expect(packets[0].profile).toMatchObject({
      id: "production",
      rules: expect.arrayContaining(["internal-control-isolation"]),
    });
    expect(packets[0].profile.hash).toMatch(PROFILE_HASH_PATTERN);
  }, 30_000);

  it("exports and parses the real long-session packet", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      typescriptSubprocessArguments("export-packets.ts", [
        "long-session=packet-long-session",
      ]),
      { cwd: import.meta.dirname, maxBuffer: 1024 * 1024 }
    );

    const packets: unknown = JSON.parse(stdout);
    if (!isSingletonArray(packets, isLongSessionPacket)) {
      throw new TypeError("Expected one long-session packet.");
    }
    const [packet] = packets;
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
      process.execPath,
      typescriptSubprocessArguments("export-packets.ts", [
        "--profile",
        "does-not-exist",
      ]),
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
