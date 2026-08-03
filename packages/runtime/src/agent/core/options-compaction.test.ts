import { describe, expect, it } from "vitest";
import { createCallbackModel } from "../../testing/test-fixtures";
import { assertAgentOptions } from "./options";

describe("AgentOptions.compaction", () => {
  it("rejects non-functions", () => {
    expect(() =>
      assertAgentOptions({
        compaction: {} as never,
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction must be a function.");
  });
});
