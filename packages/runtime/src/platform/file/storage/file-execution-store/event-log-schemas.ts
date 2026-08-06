import {
  createEventCursor,
  createThreadEventCursor,
} from "../../../../execution/host/event-cursors";
import type {
  StoredAgentEvent,
  StoredThreadEvent,
} from "../../../../execution/host/types";
import { isPlainRecord as isRecord } from "../../../../internal/guards";
import type { AgentEvent } from "../../../../thread/protocol/events";

export function parseEventLogLine(
  line: string,
  file: string
): StoredAgentEvent {
  const parsed = parseEventLineJson(line, file, "event log");
  if (
    !(isStoredEventBase(parsed) && isAgentEvent(parsed.event)) ||
    typeof parsed.runId !== "string"
  ) {
    throw invalidEventLog(file, "expected stored agent event");
  }

  return {
    cursor: createEventCursor(parsed.cursor.offset),
    event: parsed.event,
    runId: parsed.runId,
  };
}

export function parseThreadEventLogLine(
  line: string,
  file: string
): StoredThreadEvent {
  const parsed = parseEventLineJson(line, file, "thread event log");
  if (
    !(isStoredEventBase(parsed) && isAgentEvent(parsed.event)) ||
    typeof parsed.threadKey !== "string"
  ) {
    throw invalidEventLog(file, "expected stored thread event");
  }

  return {
    cursor: createThreadEventCursor(parsed.cursor.offset),
    event: parsed.event,
    threadKey: parsed.threadKey,
  };
}

function parseEventLineJson(
  line: string,
  file: string,
  kind: "event log" | "thread event log"
): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid FileExecutionStore ${kind} ${JSON.stringify(
          file
        )}: invalid JSON (${error.message})`
      );
    }
    throw error;
  }
}

function isStoredEventBase(value: unknown): value is {
  readonly cursor: { readonly offset: number };
  readonly event?: unknown;
  readonly runId?: unknown;
  readonly threadKey?: unknown;
} {
  return (
    isRecord(value) &&
    isRecord(value.cursor) &&
    typeof value.cursor.offset === "number"
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value.type === "string";
}

function invalidEventLog(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore event log ${JSON.stringify(file)}: ${message}`
  );
}
