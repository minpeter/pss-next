import type { TurnRecord } from "../../../../execution";
import type { AgentEvent } from "../../../../index";
import type { StorageLatencyTiming } from "./storage-metrics";

export const payloadBudget = 64_000;
export const oversizedEventText = makeText("model-event", 384_000);
export const oversizedCheckpointText = makeText("checkpoint", 384_000);
export const oversizedThreadText = makeText("thread-message", 144_000);
export const oversizedUserInput = makeText("user-input", 384_000);
export const prefix = "oversized-payload-stress";
export const runId = "agent-1:user-1:thread-1:run-1";
export const threadKey = "agent-1:user-1:thread-1";

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

export async function collectEventSummaries(
  events: {
    read(runId: string): AsyncIterable<{ readonly event: AgentEvent }>;
  },
  runIdValue: string
): Promise<readonly EventSummary[]> {
  const collected: EventSummary[] = [];
  for await (const entry of events.read(runIdValue)) {
    collected.push(eventSummary(entry.event));
  }
  return collected;
}

export function makeText(label: string, size: number): string {
  return `${label}:`.padEnd(size, "x");
}

export function threadHistoryTextLength(state: unknown, index: number): number {
  const snapshot = threadSnapshot(state);
  const message = snapshot.history[index];
  if (!isTextMessage(message)) {
    throw new Error(`missing text message at index ${index}`);
  }
  return message.content.length;
}

type EventSummary =
  | { readonly textLength: number; readonly type: "assistant-output" }
  | { readonly outputLength: number; readonly type: "tool-result" };

interface TextMessageProbe {
  readonly content: string;
}

interface TextOutputProbe {
  readonly text: string;
}

interface ThreadSnapshotProbe {
  readonly history: readonly unknown[];
}

function threadSnapshot(value: unknown): ThreadSnapshotProbe {
  if (!isThreadSnapshot(value)) {
    throw new Error("stored thread is not a snapshot");
  }
  return value;
}

function isThreadSnapshot(value: unknown): value is ThreadSnapshotProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    "history" in value &&
    Array.isArray(value.history)
  );
}

function isTextMessage(value: unknown): value is TextMessageProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    "content" in value &&
    typeof value.content === "string"
  );
}

function eventSummary(event: AgentEvent): EventSummary {
  if (event.type === "assistant-output") {
    return { textLength: event.text.length, type: "assistant-output" };
  }
  if (event.type === "tool-result" && isTextOutput(event.output)) {
    return { outputLength: event.output.text.length, type: "tool-result" };
  }
  throw new Error(`unexpected oversized event ${event.type}`);
}

function isTextOutput(value: unknown): value is TextOutputProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

export async function timed<T>(
  timings: StorageLatencyTiming[],
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  timings.push({ label, ms: performance.now() - start });
  return result;
}
