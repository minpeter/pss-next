import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { policy } from "./speculative-compaction-detached-test-support";
import { context, message } from "./speculative-compaction-test-support";

describe("speculative compaction context isolation", () => {
  it.each([
    ["different unknown model contexts", "unknown", "unknown", "A", "B"],
    ["different provenance", "transformed", "unknown", "A", "A"],
    ["unproven unknown contexts", "unknown", "unknown", "A", "A"],
  ] as const)(
    "does not cross-reuse %s",
    async (_case, provenanceA, provenanceB, contextA, contextB) => {
      const summarizeA = vi
        .fn<AgentCompactionContext["summarize"]>()
        .mockResolvedValue("SUMMARY_A");
      const summarizeB = vi
        .fn<AgentCompactionContext["summarize"]>()
        .mockResolvedValue("SUMMARY_B");
      const history = Array.from({ length: 6 }, (_, index) =>
        message(String(index), index % 2 === 0 ? "user" : "assistant")
      );
      const compaction = policy();
      const pendingA = compaction(
        context(history, summarizeA, {
          modelContext: [{ content: contextA, role: "system" }, ...history],
          modelContextProvenance: provenanceA,
          reason: "overflow",
        })
      );
      const pendingB = compaction(
        context(history, summarizeB, {
          modelContext: [{ content: contextB, role: "system" }, ...history],
          modelContextProvenance: provenanceB,
          reason: "overflow",
        })
      );

      await expect(Promise.resolve(pendingA)).resolves.toMatchObject({
        summary: "SUMMARY_A",
      });
      await expect(Promise.resolve(pendingB)).resolves.toMatchObject({
        summary: "SUMMARY_B",
      });
      expect(summarizeA).toHaveBeenCalledTimes(1);
      expect(summarizeB).toHaveBeenCalledTimes(1);
    }
  );
});
