import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import { createCallbackModel } from "../../testing/test-fixtures";
import { collect } from "./test-support";
import { hostWithTurnErrorAppendFailure } from "./thread-events-test-support";

describe("AgentThread durable event replay", () => {
  it("keeps provider secrets out of live rollback failure events", async () => {
    const providerError = new APICallError({
      isRetryable: false,
      message: "Bearer secret-token request-secret response-secret url-secret",
      requestBodyValues: { apiKey: "request-secret" },
      responseBody: '{"secret":"response-secret"}',
      statusCode: 403,
      url: "https://provider.example/v1/chat?token=url-secret",
    });
    const base = createInMemoryHost();
    const agent = new Agent({
      host: hostWithTurnErrorAppendFailure(base),
      model: createCallbackModel(() => Promise.reject(providerError)),
    });

    const live = await collect(
      await agent.thread("safe-rollback-failure").send("hello")
    );
    const turnError = live
      .filter((event) => event.type !== "context-usage")
      .at(-1);
    const serialized = JSON.stringify(turnError);

    expect(turnError).toEqual({
      error: {
        category: "permission",
        observedRetryable: false,
        status: 403,
        version: 1,
      },
      message:
        "The provider refused this request. History rollback persistence failed.",
      type: "turn-error",
    });
    for (const secret of [
      "secret-token",
      "request-secret",
      "response-secret",
      "url-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
