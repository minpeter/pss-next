import { describe, expect, it } from "vitest";
import type { HostStore, ThreadEventCursor } from "../../execution";
import { collectThreadEvents } from "./fixtures";

export interface ThreadEventLogContractOptions {
  readonly createStore: () => HostStore;
}

export function describeThreadEventLogContract({
  createStore,
}: ThreadEventLogContractOptions): void {
  describe("thread event log", () => {
    it("replays thread events with limit and cursor pagination", async () => {
      const store = createStore();
      const threadEvents = store.threadEvents;
      if (!threadEvents) {
        throw new Error("expected thread event log");
      }

      await threadEvents.append("thread-1", { type: "turn-start" });
      const cursor = await threadEvents.append("thread-1", {
        text: "DONE",
        type: "assistant-output",
      });
      await threadEvents.append("thread-1", { type: "turn-end" });

      const firstPage = await collectThreadEvents(
        threadEvents.read("thread-1", { limit: 2 })
      );
      const secondPage = await collectThreadEvents(
        threadEvents.read("thread-1", { after: cursor })
      );

      expect(firstPage).toEqual([
        {
          cursor: { offset: 1 },
          event: { type: "turn-start" },
          threadKey: "thread-1",
        },
        {
          cursor: { offset: 2 },
          event: { text: "DONE", type: "assistant-output" },
          threadKey: "thread-1",
        },
      ]);
      expect(secondPage).toEqual([
        {
          cursor: { offset: 3 },
          event: { type: "turn-end" },
          threadKey: "thread-1",
        },
      ]);
    });

    it.each([
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])("rejects invalid thread event replay limit %s", async (limit) => {
      const threadEvents = createStore().threadEvents;
      if (!threadEvents) {
        throw new Error("expected thread event log");
      }

      await expect(
        collectThreadEvents(threadEvents.read("thread-1", { limit }))
      ).rejects.toThrow(RangeError);
    });

    it.each([
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])("rejects invalid thread event cursor offset %s", async (offset) => {
      const threadEvents = createStore().threadEvents;
      if (!threadEvents) {
        throw new Error("expected thread event log");
      }
      const after = { offset } as ThreadEventCursor;

      await expect(
        collectThreadEvents(threadEvents.read("thread-1", { after }))
      ).rejects.toThrow(RangeError);
    });

    it.each([{}, { offset: null }, null])(
      "rejects malformed present thread event cursor %j",
      async (value) => {
        const threadEvents = createStore().threadEvents;
        if (!threadEvents) {
          throw new Error("expected thread event log");
        }
        const after = value as unknown as ThreadEventCursor;

        await expect(
          collectThreadEvents(threadEvents.read("thread-1", { after }))
        ).rejects.toThrow(RangeError);
      }
    );
  });
}
