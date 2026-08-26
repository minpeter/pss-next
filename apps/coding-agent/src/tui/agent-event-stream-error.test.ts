import type { AgentEvent, TurnErrorMetadataV1 } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { agentEventStreamParts } from "./agent-event-stream";
import type { TuiStreamPart } from "./stream-handlers";

describe("agentEventStreamParts error boundary", () => {
  it("keeps hostile turn-error metadata inside the stream boundary", async () => {
    // Given
    const metadata: TurnErrorMetadataV1 = new Proxy(
      { category: "unknown", version: 1 },
      {
        get() {
          throw new Error("STREAM_METADATA_SECRET");
        },
      }
    );
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      await Promise.resolve();
      yield {
        error: metadata,
        message: "Safe runtime failure",
        type: "turn-error",
      };
    })();

    // When
    const parts: TuiStreamPart[] = [];
    for await (const part of agentEventStreamParts(events)) {
      parts.push(part);
    }

    // Then
    expect(JSON.stringify(parts)).not.toContain("STREAM_METADATA_SECRET");
  });
});
