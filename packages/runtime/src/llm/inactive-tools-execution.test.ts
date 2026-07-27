import { jsonSchema, type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4ToolCall,
} from "../testing/mock-language-model-v4-test-utils";
import { generateModelStep } from "./model-step";

describe("inactive model-step tools", () => {
  it("does not execute a provider-emitted call for an inactive tool", async () => {
    let activeExecutions = 0;
    let inactiveExecutions = 0;
    const model = createMockLanguageModelV4([
      mockLanguageModelV4ToolCall({
        input: {},
        toolCallId: "call-inactive",
        toolName: "inactive",
      }),
    ]);
    const emptyInputSchema = jsonSchema({
      additionalProperties: false,
      properties: {},
      type: "object",
    });

    const response = await generateModelStep({
      history: [{ content: "Do not call inactive tools.", role: "user" }],
      model,
      prepareModelStep: () => ({ activeTools: ["active"] }),
      signal: new AbortController().signal,
      threadKey: "thread-inactive-tool-regression",
      tools: {
        active: tool({
          execute: () => {
            activeExecutions += 1;
            return { ok: true };
          },
          inputSchema: emptyInputSchema,
        }),
        inactive: tool({
          execute: () => {
            inactiveExecutions += 1;
            return { ok: true };
          },
          inputSchema: emptyInputSchema,
        }),
      },
    });

    expect(activeExecutions).toBe(0);
    expect(inactiveExecutions).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.tools?.map((entry) => entry.name)).toEqual(
      ["active"]
    );
    expect(response.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(JSON.stringify(response)).toContain("unavailable tool 'inactive'");
  });

  it("treats an unregistered inherited-property name as unavailable", async () => {
    let activeExecutions = 0;
    const model = createMockLanguageModelV4([
      mockLanguageModelV4ToolCall({
        input: {},
        toolCallId: "call-inherited",
        toolName: "toString",
      }),
    ]);

    const response = await generateModelStep({
      history: [{ content: "Do not call tools.", role: "user" }],
      model,
      prepareModelStep: () => ({ activeTools: ["active"] }),
      signal: new AbortController().signal,
      threadKey: "thread-inherited-name-regression",
      tools: {
        active: tool({
          execute: () => {
            activeExecutions += 1;
            return { ok: true };
          },
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: {},
            type: "object",
          }),
        }),
      },
    });

    expect(activeExecutions).toBe(0);
    expect(JSON.stringify(response)).toContain("unavailable tool 'toString'");
  });

  it.each(["constructor", "toString", "__proto__"])(
    "keeps registered but inactive special-name tool %s unavailable",
    async (toolName) => {
      let activeExecutions = 0;
      let inactiveExecutions = 0;
      const model = createMockLanguageModelV4([
        mockLanguageModelV4ToolCall({
          input: {},
          toolCallId: `call-${toolName}`,
          toolName,
        }),
      ]);
      const tools = Object.fromEntries([
        [
          "active",
          tool({
            execute: () => {
              activeExecutions += 1;
              return { ok: true };
            },
            inputSchema: jsonSchema({ type: "object" }),
          }),
        ],
        [
          toolName,
          tool({
            execute: () => {
              inactiveExecutions += 1;
              return { ok: true };
            },
            inputSchema: jsonSchema({ type: "object" }),
          }),
        ],
      ]) as ToolSet;

      const response = await generateModelStep({
        history: [{ content: "Do not call inactive tools.", role: "user" }],
        model,
        prepareModelStep: () => ({ activeTools: ["active"] }),
        signal: new AbortController().signal,
        threadKey: `thread-inactive-${toolName}`,
        tools,
      });

      expect(activeExecutions).toBe(0);
      expect(inactiveExecutions).toBe(0);
      expect(model.doGenerateCalls[0]?.tools?.map(({ name }) => name)).toEqual([
        "active",
      ]);
      expect(JSON.stringify(response)).toContain(
        `unavailable tool '${toolName}'`
      );
    }
  );

  it.each(["constructor", "toString", "__proto__"])(
    "executes active special-name tool %s only through an own registry entry",
    async (toolName) => {
      let executions = 0;
      const model = createMockLanguageModelV4([
        mockLanguageModelV4ToolCall({
          input: {},
          toolCallId: `call-${toolName}`,
          toolName,
        }),
      ]);
      const tools = Object.fromEntries([
        [
          toolName,
          tool({
            execute: () => {
              executions += 1;
              return { ok: true };
            },
            inputSchema: jsonSchema({ type: "object" }),
          }),
        ],
      ]) as ToolSet;

      await generateModelStep({
        history: [{ content: "Call the selected tool.", role: "user" }],
        model,
        prepareModelStep: () => ({ activeTools: [toolName] }),
        signal: new AbortController().signal,
        threadKey: `thread-active-${toolName}`,
        tools,
      });

      expect(executions).toBe(1);
      expect(model.doGenerateCalls[0]?.tools?.map(({ name }) => name)).toEqual([
        toolName,
      ]);
    }
  );
});
