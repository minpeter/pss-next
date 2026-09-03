import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { policy } from "./speculative-compaction-detached-test-support";
import { context, message } from "./speculative-compaction-test-support";

describe("speculative compaction context isolation", () => {
  it.each(["transformed", "unknown"] as const)(
    "does not install a late %s result for a later standard episode",
    async (modelContextProvenance) => {
      // Given: a non-standard overflow whose summary outlives its episode.
      const originatingEpisode = new AbortController();
      let resolveSummary: (summary: string) => void = () => {
        throw new TypeError("summary promise was not initialized");
      };
      const summary = new Promise<string>((resolve) => {
        resolveSummary = resolve;
      });
      const summarize = vi
        .fn<AgentCompactionContext["summarize"]>()
        .mockReturnValueOnce(summary)
        .mockResolvedValueOnce("FRESH_STANDARD_SUMMARY");
      const history = Array.from({ length: 6 }, (_, index) =>
        message(String(index), index % 2 === 0 ? "user" : "assistant")
      );
      const compaction = policy();
      const pending = compaction(
        context(history, summarize, {
          modelContext: [
            { content: "TENANT_A_SECRET", role: "system" },
            ...history,
          ],
          modelContextProvenance,
          reason: "overflow",
          signal: originatingEpisode.signal,
        })
      );
      expect(summarize).toHaveBeenCalledTimes(1);

      // When: the origin aborts, its result settles, and standard context runs.
      originatingEpisode.abort();
      resolveSummary("TENANT_A_SUMMARY");
      await expect(Promise.resolve(pending)).rejects.toMatchObject({
        name: "AbortError",
      });
      const standard = await compaction(
        context(history, summarize, { reason: "overflow" })
      );

      // Then: standard context makes and receives a fresh provider call.
      expect(standard?.summary).toBe("FRESH_STANDARD_SUMMARY");
      expect(summarize).toHaveBeenCalledTimes(2);
    }
  );

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
