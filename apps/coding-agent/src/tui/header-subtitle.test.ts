import { describe, expect, it } from "vitest";
import { formatTuiHeaderSubtitle } from "./header-subtitle";

describe("formatTuiHeaderSubtitle", () => {
  it("labels the cwd-derived default thread without repeating the cwd", () => {
    expect(
      formatTuiHeaderSubtitle({
        cwd: "/workspace/project",
        maxInputTokens: undefined,
        modelLabel: "mimo-v2.5-free (free tier)",
        threadKey: "cwd:/workspace/project",
      })
    ).toBe(
      "mimo-v2.5-free (free tier)\n/workspace/project · thread default · compaction auto max=default"
    );
  });

  it("retains an explicitly named thread key", () => {
    expect(
      formatTuiHeaderSubtitle({
        cwd: "/workspace/project",
        maxInputTokens: 12_000,
        modelLabel: "model-a",
        threadKey: "release-review",
      })
    ).toBe(
      "model-a\n/workspace/project · thread release-review · compaction auto max=12000"
    );
  });
});
