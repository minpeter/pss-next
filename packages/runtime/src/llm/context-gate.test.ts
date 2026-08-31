import { asSchema, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  defaultModelPromptMeasurementProfile,
  enforceContextGate,
  materializeModelPromptTools,
  modelPromptTools,
} from "./context-gate";

describe("model prompt measurement", () => {
  it("counts instructions and provider-visible tools once, with aligned marginal messages", async () => {
    const execute = vi.fn();
    const messages: readonly ModelMessage[] = [
      { content: "one", role: "user" },
      { content: "two", role: "assistant" },
    ];
    const tools = await modelPromptTools({
      search: {
        description: "Search",
        execute,
        inputSchema: jsonSchema({ type: "object" }),
      },
    } as unknown as ToolSet);
    const measurement = defaultModelPromptMeasurementProfile.measurePrompt({
      instructions: "Be useful",
      messages,
      toolChoice: { toolName: "search", type: "tool" },
      tools,
    });

    expect(measurement.messageUnits).toEqual(
      defaultModelPromptMeasurementProfile.measureMessages(messages)
    );
    expect(measurement.messageUnits).toHaveLength(messages.length);
    expect(measurement.totalUnits).toBe(
      measurement.fixedUnits +
        measurement.messageUnits.reduce((sum, units) => sum + units, 0)
    );
    expect(JSON.stringify(tools)).not.toContain("execute");
    expect(execute).not.toHaveBeenCalled();
  });

  it("distinguishes Japanese prompt density from equal-length ASCII", () => {
    // Given
    const ascii = { content: "a".repeat(372), role: "user" } as const;
    const japanese = { content: "日".repeat(372), role: "user" } as const;

    // When
    const measured = defaultModelPromptMeasurementProfile.measureMessages([
      ascii,
      japanese,
    ]);

    // Then
    expect(measured).toEqual([100, 286]);
  });

  it.each([
    ["ascii", { content: "hello world", role: "user" }],
    ["japanese", { content: "日本語のテキスト", role: "user" }],
    ["korean", { content: "한국어 텍스트", role: "user" }],
    ["emoji surrogate pair", { content: "😀😀😀", role: "user" }],
    ["lone high surrogate", { content: "\uD800", role: "user" }],
    ["lone low surrogate", { content: "\uDC00", role: "user" }],
    ["mixed scripts", { content: "ab日😀", role: "user" }],
    ["empty", { content: "", role: "user" }],
  ] as const)(
    "never measures below the legacy unit basis (%s)",
    (_name, message) => {
      // Given
      const legacy = JSON.stringify(message).length / 4;

      // When
      const [measured] = defaultModelPromptMeasurementProfile.measureMessages([
        message,
      ]);

      // Then
      expect(measured).toBeGreaterThanOrEqual(legacy);
    }
  );

  it("leaves pure-ASCII measurement exactly unchanged", () => {
    // Given
    const message = { content: "hello world", role: "user" } as const;
    const legacy = JSON.stringify(message).length / 4;

    // When
    const measured = defaultModelPromptMeasurementProfile.measureMessages([
      message,
    ]);

    // Then
    expect(measured).toEqual([legacy]);
  });

  it("projects the complete function-tool surface sent by the AI SDK", async () => {
    const description = vi.fn(() => "Dynamic search");
    const tools = await modelPromptTools({
      search: {
        description,
        inputExamples: [{ input: { query: "example" } }],
        inputSchema: jsonSchema({ type: "object" }),
        providerOptions: { provider: { cache: true } },
        strict: true,
      },
    } as unknown as ToolSet);

    expect(tools).toEqual([
      {
        description: "Dynamic search",
        inputExamples: [{ input: { query: "example" } }],
        inputSchema: { type: "object" },
        name: "search",
        providerOptions: { provider: { cache: true } },
        strict: true,
        type: "function",
      },
    ]);
    expect(description).toHaveBeenCalledWith({
      context: undefined,
      experimental_sandbox: undefined,
    });
  });

  it("materializes dynamic tool metadata once for measurement and dispatch", async () => {
    const description = vi
      .fn<() => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");
    const materialized = await materializeModelPromptTools({
      search: {
        description,
        inputSchema: jsonSchema({ type: "object" }),
      },
    } as unknown as ToolSet);
    const dispatched = materialized.tools?.search;

    expect(materialized.promptTools?.[0]?.description).toBe("first");
    expect(dispatched?.description).toBe("first");
    if (dispatched?.type !== "provider") {
      await asSchema(dispatched?.inputSchema).jsonSchema;
    }
    expect(description).toHaveBeenCalledTimes(1);
  });

  it("awaits asynchronous schemas and preserves their validator", async () => {
    const validate = vi.fn(() => ({
      success: true as const,
      value: { normalized: true },
    }));
    const materialized = await materializeModelPromptTools({
      search: {
        inputSchema: jsonSchema(
          Promise.resolve({
            properties: { query: { type: "string" } },
            type: "object",
          }),
          { validate }
        ),
      },
    });
    const dispatched = materialized.tools?.search;

    expect(materialized.promptTools?.[0]?.inputSchema).toEqual({
      properties: { query: { type: "string" } },
      type: "object",
    });
    if (dispatched?.type !== "provider") {
      const schema = asSchema(dispatched?.inputSchema);
      expect(await schema.validate?.({ query: "value" })).toEqual({
        success: true,
        value: { normalized: true },
      });
    }
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("keeps the context-gate custom estimator contract", () => {
    const estimateTokens = vi.fn(() => 1);
    const messages: readonly ModelMessage[] = [
      { content: "hello", role: "user" },
    ];

    enforceContextGate({
      contextGate: { estimateTokens, maxInputTokens: () => 2 },
      instructions: "instruction",
      messages,
    });

    expect(estimateTokens).toHaveBeenCalledWith({
      instructions: "instruction",
      messages,
      toolChoice: undefined,
      tools: undefined,
    });
  });
});
