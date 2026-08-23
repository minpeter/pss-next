import { describe, expect, it } from "vitest";
import { compactionContextForModel } from "../state/context";
import { COMPACTION_SUMMARY_CONTRACT } from "./auto-compaction-summary";

const SUMMARY_TAGS = /<summary>\ncompact handoff\n<\/summary>$/;

describe("automatic compaction summary contract", () => {
  it("defines machine-readable handoff sections and rules", () => {
    const sectionIds = COMPACTION_SUMMARY_CONTRACT.sections.map(({ id }) => id);

    expect(sectionIds).toEqual([
      "objective",
      "constraints",
      "progress",
      "decisions",
      "files",
      "tool-evidence",
      "open-work",
      "critical-values",
      "failed-approaches",
    ]);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    expect(COMPACTION_SUMMARY_CONTRACT.rules).toEqual({
      continueConversation: false,
      distinguishPlannedFromCompleted: true,
      extractIntentBeforeWriting: true,
      internalInstructionIsNotUserIntent: true,
      mergePreviousSummary: true,
      preserveActiveUserRequestVerbatim: true,
      preserveLabeledStateVerbatim: true,
      preserveLatestCorrections: true,
    });
  });

  it("wraps compacted state in structural summary tags", () => {
    const message = compactionContextForModel({
      endSeqExclusive: 2,
      role: "compaction",
      startSeq: 0,
      summary: "compact handoff",
    });

    expect(message.role).toBe("user");
    expect(message.content).toMatch(SUMMARY_TAGS);
  });
});
