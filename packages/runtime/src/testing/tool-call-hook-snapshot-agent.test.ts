import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHooks } from "../agent/core/hooks";
import {
  checkpointedTool,
  createCheckpointSpyHost,
  type GenerateTextToolOptions,
  toolOptions,
} from "./execution-checkpoint-test-support";
import {
  collectRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
} from "./llm-test-utils";
import { assistantMessage, toolCallPart, toolResultFor } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

interface MutableNestedInput {
  readonly payload: {
    path: string;
  };
}

function isMutableNestedInput(value: unknown): value is MutableNestedInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "payload" in value &&
    typeof value.payload === "object" &&
    value.payload !== null &&
    "path" in value.payload &&
    typeof value.payload.path === "string"
  );
}

describe("tool-call hook snapshots through Agent", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps hook input mutations out of tool execution", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executedInput: unknown;

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart("call_sdk-tool-call-1", "checked_tool");
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      })
      .mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage("DONE")],
      }));

    const hooks: AgentHooks = {
      beforeToolExecution: (event) => {
        if (isMutableNestedInput(event.input)) {
          event.input.payload.path = "MUTATED.md";
        }
      },
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        checked_tool: checkpointedTool("idempotent", (input) => {
          executedInput = input;
          return { ok: true };
        }),
      },
    });

    await collectRun(await agent.send("use the tool"));

    expect(executedInput).toEqual({
      payload: { path: "README.md" },
    });
  });

  it("applies explicit beforeToolExecution transform to tool execute input", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executedInput: unknown;

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart("call_sdk-tool-call-1", "checked_tool");
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      })
      .mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage("DONE")],
      }));

    const hooks: AgentHooks = {
      beforeToolExecution: (event) => {
        if (!isMutableNestedInput(event.input)) {
          return;
        }
        return {
          input: {
            payload: { path: `jailed/${event.input.payload.path}` },
          },
          status: "continue",
        };
      },
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        checked_tool: checkpointedTool("idempotent", (input) => {
          executedInput = input;
          return { ok: true };
        }),
      },
    });

    await collectRun(await agent.send("use the tool"));

    expect(executedInput).toEqual({
      payload: { path: "jailed/README.md" },
    });
  });

  it("composes tool input transforms inside the single hook", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executedInput: unknown;
    const seenBySecond: unknown[] = [];

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart("call_sdk-tool-call-1", "checked_tool");
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      })
      .mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage("DONE")],
      }));

    const hooks: AgentHooks = {
      beforeToolExecution: (event) => {
        if (!isMutableNestedInput(event.input)) {
          return;
        }
        const firstInput = {
          payload: { path: `first/${event.input.payload.path}` },
        };
        seenBySecond.push(structuredClone(firstInput));
        return {
          input: {
            payload: { path: `second/${firstInput.payload.path}` },
          },
          status: "continue",
        };
      },
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        checked_tool: checkpointedTool("idempotent", (input) => {
          executedInput = input;
          return { ok: true };
        }),
      },
    });

    await collectRun(await agent.send("use the tool"));

    expect(seenBySecond).toEqual([{ payload: { path: "first/README.md" } }]);
    expect(executedInput).toEqual({
      payload: { path: "second/first/README.md" },
    });
  });

  it("fails closed when beforeToolExecution continue omits input", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executions = 0;

    generateTextMock.mockImplementationOnce(
      async (options: GenerateTextToolOptions) => {
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );
        return {
          responseMessages: [assistantMessage("UNREACHABLE")],
        };
      }
    );

    const hooks: AgentHooks = {
      beforeToolExecution: () => ({ status: "continue" }) as never,
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        checked_tool: checkpointedTool("idempotent", () => {
          executions += 1;
          return { ok: true };
        }),
      },
    });

    const events = await collectRun(await agent.send("use the tool"));

    expect(executions).toBe(0);
    expect(events.some((event) => event.type === "turn-error")).toBe(true);
  });

  it("keeps beforeToolExecution checkpoints out of public turn events", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    const interceptedToolNames: string[] = [];

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart("call_sdk-tool-call-1", "checked_tool");
        await executableTool(options.tools ?? {}, "checked_tool").execute?.(
          { payload: { path: "README.md" } },
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      })
      .mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage("DONE")],
      }));

    const hooks: AgentHooks = {
      beforeToolExecution: (event) => {
        interceptedToolNames.push(event.toolName);
      },
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        checked_tool: checkpointedTool("idempotent", () => ({ ok: true })),
      },
    });

    const events = await collectRun(await agent.send("use the tool"));

    expect(interceptedToolNames).toEqual(["checked_tool"]);
    expect(events.map((event) => event.type)).not.toContain(
      "beforeToolExecution"
    );
  });
});
