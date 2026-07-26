import { describe, expect, it } from "vitest";
import { resolveCodingAgentThreadConfig } from "./thread-config";

describe("resolveCodingAgentThreadConfig", () => {
  it("defaults to a durable home directory, cwd-scoped key, and automatic compaction", () => {
    expect(
      resolveCodingAgentThreadConfig({}, "/repo/demo", "/home/me")
    ).toEqual({
      autoCompaction: undefined,
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });

  it("allows callers to override the file directory and thread key", () => {
    expect(
      resolveCodingAgentThreadConfig(
        {
          PSS_THREAD_DIR: ".pss/threads",
          PSS_THREAD_KEY: "workspace:demo",
        },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: undefined,
      directory: ".pss/threads",
      key: "workspace:demo",
    });
  });

  it("treats blank env overrides as absent", () => {
    expect(
      resolveCodingAgentThreadConfig(
        { PSS_THREAD_DIR: " ", PSS_THREAD_KEY: "" },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: undefined,
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });

  it("sizes compaction from PSS_MODEL_CONTEXT_WINDOW when provided", () => {
    expect(
      resolveCodingAgentThreadConfig(
        { PSS_MODEL_CONTEXT_WINDOW: "64000" },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: { maxInputTokens: 64_000 },
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });

  it.each([
    { env: { PSS_MODEL_CONTEXT_WINDOW: "0" }, name: "zero" },
    { env: { PSS_MODEL_CONTEXT_WINDOW: "-10" }, name: "negative" },
    { env: { PSS_MODEL_CONTEXT_WINDOW: "12.5" }, name: "fractional" },
    { env: { PSS_MODEL_CONTEXT_WINDOW: "lots" }, name: "non-numeric" },
  ] as const)("rejects a malformed context window: $name", ({ env }) => {
    expect(() =>
      resolveCodingAgentThreadConfig(env, "/repo/demo", "/home/me")
    ).toThrow("PSS_MODEL_CONTEXT_WINDOW must be a positive integer.");
  });

  it("ignores the removed PSS_AUTO_COMPACTION_* off switch", () => {
    expect(
      resolveCodingAgentThreadConfig(
        {
          PSS_AUTO_COMPACTION_MIN_MESSAGES: "12",
          PSS_AUTO_COMPACTION_RETAIN_MESSAGES: "4",
        },
        "/repo/demo",
        "/home/me"
      ).autoCompaction
    ).toBeUndefined();
  });
});
