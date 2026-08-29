import type { TurnRecord } from "../../../../execution";
import type { AgentEvent } from "../../../../index";
import { createDurableObjectStorageHost } from "../../host/storage-host";
import type { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";

export async function hostLoadFinalThread(
  storage: InMemoryDurableObjectStorage,
  prefix: string,
  threadKey: string
) {
  const host = createDurableObjectStorageHost({ prefix, storage });
  return await host.store.threads.load(threadKey);
}

export function runRecord(input: {
  readonly runId: string;
  readonly threadKey: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: input.runId,
    runId: input.runId,
    status: "queued",
    threadKey: input.threadKey,
  };
}

export function eventRecord(type: "step-start" | "step-end"): AgentEvent {
  if (type === "step-start") {
    return { type: "step-start" };
  }
  return { type: "step-end" };
}
