import { describe, expect, it, vi } from "vitest";
import type { ThreadCompactionInput } from "../state/thread-state";
import type { ThreadCompactionHandler } from "./auto-compaction-types";
import { runCompactionHandler } from "./compaction-handler-capability";

const input: ThreadCompactionInput = {
  endSeqExclusive: 2,
  startSeq: 0,
  summary: "candidate",
};

describe("compaction handler capability", () => {
  it("rejects an already-aborted signal before custom work starts", async () => {
    // Given
    const reason = new TypeError("aborted before handler");
    const controller = new AbortController();
    controller.abort(reason);
    const provider = vi.fn(async (): Promise<void> => undefined);
    const commit = vi.fn<
      (candidate: ThreadCompactionInput) => Promise<boolean>
    >(async () => true);
    const handler = vi.fn<ThreadCompactionHandler>(async () => {
      await provider();
      return false;
    });

    // When
    const outcome = await runCompactionHandler({
      commit,
      handler,
      input,
      signal: controller.signal,
    }).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ error, kind: "rejected" as const })
    );

    // Then
    expect({
      commitCalls: commit.mock.calls.length,
      handlerCalls: handler.mock.calls.length,
      outcomeKind: outcome.kind,
      providerCalls: provider.mock.calls.length,
      rejectedWithReason:
        outcome.kind === "rejected" && outcome.error === reason,
    }).toEqual({
      commitCalls: 0,
      handlerCalls: 0,
      outcomeKind: "rejected",
      providerCalls: 0,
      rejectedWithReason: true,
    });
  });
});
