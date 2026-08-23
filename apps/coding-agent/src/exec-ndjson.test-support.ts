import { streamAgentEventTypes } from "@minpeter/pss-runtime";

export type ParsedAgentEvent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

type ParsedMetadataLine = Readonly<Record<string, unknown>> & {
  readonly schema: string;
  readonly type: "metadata";
};

type ParsedAgentEventLine = Readonly<Record<string, unknown>> & {
  readonly event: ParsedAgentEvent;
  readonly type: "agent_event";
};

type ParsedResultLine = Readonly<Record<string, unknown>> & {
  readonly result: Readonly<Record<string, unknown>> & {
    readonly events: readonly ParsedAgentEvent[];
  };
  readonly type: "result";
};

type ParsedContextNoticeLine = Readonly<Record<string, unknown>> & {
  readonly message: string;
  readonly type: "context_notice";
};

export type ParsedExecOutputLine =
  | ParsedAgentEventLine
  | ParsedContextNoticeLine
  | ParsedMetadataLine
  | ParsedResultLine;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAgentEvent(value: unknown): ParsedAgentEvent {
  if (!(isRecord(value) && typeof value.type === "string")) {
    throw new TypeError("Expected an agent event object.");
  }
  return { ...value, type: value.type };
}

export function parseExecOutputLine(line: string): ParsedExecOutputLine {
  const value: unknown = JSON.parse(line);
  if (!(isRecord(value) && typeof value.type === "string")) {
    throw new TypeError("Expected an exec output line object.");
  }

  switch (value.type) {
    case "agent_event":
      return {
        ...value,
        event: parseAgentEvent(value.event),
        type: value.type,
      };
    case "context_notice":
      if (typeof value.message !== "string") {
        throw new TypeError("Expected a context notice message.");
      }
      return { ...value, message: value.message, type: value.type };
    case "metadata":
      if (typeof value.schema !== "string") {
        throw new TypeError("Expected an exec metadata schema.");
      }
      return { ...value, schema: value.schema, type: value.type };
    case "result": {
      if (!(isRecord(value.result) && Array.isArray(value.result.events))) {
        throw new TypeError("Expected an exec result payload.");
      }
      return {
        ...value,
        result: {
          ...value.result,
          events: value.result.events.map(parseAgentEvent),
        },
        type: value.type,
      };
    }
    default:
      throw new TypeError(`Unexpected exec output line type: ${value.type}`);
  }
}

export function isParsedStreamAgentEvent(event: ParsedAgentEvent): boolean {
  return event.type in streamAgentEventTypes;
}
