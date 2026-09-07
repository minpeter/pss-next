import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStreamAgentEvent } from "@minpeter/pss-runtime";
import { APICallError } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodingAgentExec } from "./exec";
import {
  isParsedStreamAgentEvent,
  type ParsedExecOutputLine,
  parseExecOutputLine,
} from "./exec-ndjson.test-support";

type MockStreamResult = Extract<
  Exclude<
    NonNullable<
      ConstructorParameters<typeof MockLanguageModelV4>[0]
    >["doStream"],
    (...args: never[]) => unknown
  >,
  { readonly stream: unknown }
>;
type MockStreamPart =
  MockStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 4,
  },
  outputTokens: { reasoning: undefined, text: 2, total: 2 },
};

const streamChunks = [
  { type: "stream-start", warnings: [] },
  { id: "text-1", type: "text-start" },
  { delta: "hello ", id: "text-1", type: "text-delta" },
  { delta: "world", id: "text-1", type: "text-delta" },
  { id: "text-1", type: "text-end" },
  {
    finishReason: { raw: "stop", unified: "stop" },
    type: "finish",
    usage,
  },
] satisfies MockStreamPart[];

function createStreamingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [{ stream: convertArrayToReadableStream(streamChunks) }],
  });
}

function createCapturedOutput() {
  let buffer = "";
  return {
    lines(): readonly ParsedExecOutputLine[] {
      return buffer
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseExecOutputLine);
    },
    output: {
      write(text: string) {
        buffer += text;
      },
    },
  };
}

describe("runCodingAgentExec", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-exec-test-"));
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  it("rejects inherited stream classifier keys in NDJSON", () => {
    const line = parseExecOutputLine(
      JSON.stringify({ event: { type: "toString" }, type: "agent_event" })
    );
    if (line.type !== "agent_event") {
      throw new TypeError("expected an agent event line");
    }

    expect(isParsedStreamAgentEvent(line.event)).toBe(false);
  });

  it("streams delta events as NDJSON but excludes them from the result", async () => {
    const captured = createCapturedOutput();

    const result = await runCodingAgentExec({
      model: createStreamingModel(),
      prompt: "say hello",
      stdout: captured.output,
      workspace,
    });

    const lines = captured.lines();
    const metadata = lines.find((line) => line.type === "metadata");
    expect(metadata).toMatchObject({ schema: "pss-headless-v1" });

    const agentEvents = lines
      .filter((line) => line.type === "agent_event")
      .map((line) => line.event);
    const deltaEvents = agentEvents.filter(
      (event) => event.type === "assistant-output-delta"
    );
    expect(deltaEvents).toEqual([
      expect.objectContaining({ text: "hello " }),
      expect.objectContaining({ text: "world" }),
    ]);
    expect(agentEvents.some(isParsedStreamAgentEvent)).toBe(true);

    const resultLine = lines.find((line) => line.type === "result");
    expect(resultLine).toBeDefined();
    if (resultLine === undefined) {
      throw new Error("expected an exec result line");
    }
    expect(resultLine.result.events.some(isParsedStreamAgentEvent)).toBe(false);

    expect(result.events.some((event) => isStreamAgentEvent(event))).toBe(
      false
    );
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("hello world");
  });

  it("streams authoritative retries to NDJSON and extension subscribers but not results", async () => {
    let calls = 0;
    const observed: { phase: string; stream: boolean }[] = [];
    const captured = createCapturedOutput();
    const result = await runCodingAgentExec({
      extensions: [
        {
          id: "retry-subscriber",
          default(pss) {
            pss.on("model-retry", (event, context) => {
              observed.push({ phase: event.phase, stream: context.stream });
            });
          },
        },
      ],
      model: new MockLanguageModelV4({
        doStream: () => {
          calls += 1;
          if (calls === 1) {
            throw new APICallError({
              message: "private provider",
              requestBodyValues: {},
              responseHeaders: { "retry-after-ms": "0" },
              statusCode: 429,
              url: "https://fixture.test",
            });
          }
          return Promise.resolve({
            stream: convertArrayToReadableStream(streamChunks),
          });
        },
      }),
      prompt: "say hello",
      stdout: captured.output,
      workspace,
    });
    expect(calls).toBe(2);
    expect(observed).toEqual([
      { phase: "scheduled", stream: true },
      { phase: "started", stream: true },
    ]);
    const lines = captured.lines();
    expect(
      lines.filter(
        (line) =>
          line.type === "agent_event" && line.event.type === "model-retry"
      )
    ).toHaveLength(2);
    const resultLine = lines.find((line) => line.type === "result");
    expect(resultLine?.result.events.some(isParsedStreamAgentEvent)).toBe(
      false
    );
    expect(result.events.some(isStreamAgentEvent)).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("hello world");
  });

  it("rejects hostile extension ids without exposing their bytes", async () => {
    const hostileId = "extension-secret\u001b[2J\u0007\nSECOND_LINE\u2028";

    const failure = await runCodingAgentExec({
      extensions: [{ default: () => undefined, id: hostileId }],
      model: createStreamingModel(),
      prompt: "do not run",
      workspace,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(TypeError);
    if (!(failure instanceof Error)) {
      throw new Error("expected extension validation to reject");
    }
    expect(failure.message).toBe("Invalid extension id.");
    expect(failure.message).not.toContain("extension-secret");
    expect(failure.message).not.toContain("SECOND_LINE");
    expect(failure.message).not.toContain("\u001b");
    expect(failure.message).not.toContain("\u0007");
    expect(failure.message).not.toContain("\u2028");
  });

  it("rejects duplicate extension ids without exposing their bytes", async () => {
    // Given
    const privateId = "private-api-token";
    const extension = { default: () => undefined, id: privateId };

    // When
    const failure = await runCodingAgentExec({
      extensions: [extension, extension],
      model: createStreamingModel(),
      prompt: "do not run",
      workspace,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    // Then
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected duplicate extension validation to reject");
    }
    expect(failure.message).toBe("Duplicate coding agent extension id.");
    expect(failure.message).not.toContain(privateId);
  });

  it("writes structured provider failures without leaking diagnostics", async () => {
    const captured = createCapturedOutput();
    const providerError = new APICallError({
      data: {
        error: {
          code: "account_denied",
          type: "provider_permission_error",
        },
      },
      isRetryable: false,
      message:
        "Access denied request-secret response-secret url-secret secret-token\u001b[31m",
      requestBodyValues: { apiKey: "request-secret" },
      responseBody: '{"secret":"response-secret"}',
      responseHeaders: {
        authorization: "Bearer response-secret",
        "x-request-id": "exec-request",
      },
      statusCode: 403,
      url: "https://provider.example/v1/chat/completions?token=url-secret",
    });
    const model = new MockLanguageModelV4({
      doStream: async () => Promise.reject(providerError),
    });

    const result = await runCodingAgentExec({
      model,
      prompt: "fail safely",
      stdout: captured.output,
      workspace,
    });
    const lines = captured.lines();
    const turnError = lines.find(
      (line) => line.type === "agent_event" && line.event.type === "turn-error"
    );

    expect(result.status).toBe("error");
    expect(turnError).toMatchObject({
      event: {
        error: {
          category: "permission",
          observedRetryable: false,
          status: 403,
          version: 1,
        },
        type: "turn-error",
      },
      type: "agent_event",
    });
    expect(turnError).not.toHaveProperty("event.error.code");
    expect(turnError).not.toHaveProperty("event.error.providerType");
    expect(turnError).not.toHaveProperty("event.error.correlationIds");
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("\\u001b");
    for (const secret of [
      "request-secret",
      "response-secret",
      "url-secret",
      "secret-token",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
