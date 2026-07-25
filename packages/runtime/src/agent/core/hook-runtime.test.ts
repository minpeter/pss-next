import { describe, expect, it } from "vitest";
import { AgentHookError } from "./hook-error";
import { AgentHookRuntime } from "./hook-runtime";

describe("AgentHookRuntime", () => {
  it("attributes callback failures to the host hook", async () => {
    const runtime = new AgentHookRuntime({
      acceptInput() {
        throw new Error("policy failed");
      },
    });

    const result = runtime.acceptInput(
      "thread",
      { text: "hello", type: "user-input" },
      [],
      new AbortController().signal
    );

    await expect(result).rejects.toMatchObject({
      hook: "acceptInput",
      name: "AgentHookError",
    });
    await expect(result).rejects.toBeInstanceOf(AgentHookError);
  });

  it("fails closed when a callback returns an invalid decision", async () => {
    const runtime = new AgentHookRuntime({
      acceptInput() {
        return JSON.parse('{"action":"unknown"}');
      },
    });

    const result = runtime.acceptInput(
      "thread",
      { text: "hello", type: "user-input" },
      [],
      new AbortController().signal
    );

    await expect(result).rejects.toMatchObject({
      hook: "acceptInput",
      name: "AgentHookError",
    });
  });

  it("rejects an input transform that changes the event kind", async () => {
    // Given
    const runtime = new AgentHookRuntime({
      acceptInput() {
        return JSON.parse(
          '{"action":"transform","value":{"text":"changed","type":"user-input"}}'
        );
      },
    });

    // When
    const result = runtime.acceptInput(
      "thread",
      {
        input: { text: "hello", type: "user-input" },
        placement: "turn-start",
        type: "runtime-input",
      },
      [],
      new AbortController().signal
    );

    // Then
    await expect(result).rejects.toMatchObject({
      cause: {
        message: "Agent input transform must preserve the input event kind",
      },
      hook: "acceptInput",
      name: "AgentHookError",
    });
  });
});
