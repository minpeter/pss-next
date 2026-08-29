import { expect, it } from "vitest";
import type { StoredThreadEvent } from "../../../../execution";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage,
} from "../../host/storage-host";

it("round-trips thread events with the public default Durable Object SQL test storage", async () => {
  const host = createDurableObjectStorageHost({
    prefix: "default-sql-thread-event-test",
    storage: new InMemoryDurableObjectStorage(),
  });
  const threadEvents = host.store.threadEvents;
  if (!threadEvents) {
    throw new Error("expected thread event log");
  }

  await threadEvents.append("thread-1", { type: "turn-start" });
  const cursor = await threadEvents.append("thread-1", {
    text: "DONE",
    type: "assistant-output",
  });
  await threadEvents.append("thread-1", { type: "turn-end" });

  await expect(
    collectThreadEventRecords(threadEvents.read("thread-1", { after: cursor }))
  ).resolves.toEqual([
    {
      cursor: { offset: 3 },
      event: { type: "turn-end" },
      threadKey: "thread-1",
    },
  ]);
});

async function collectThreadEventRecords(
  events: AsyncIterable<StoredThreadEvent>
): Promise<StoredThreadEvent[]> {
  const collected: StoredThreadEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
