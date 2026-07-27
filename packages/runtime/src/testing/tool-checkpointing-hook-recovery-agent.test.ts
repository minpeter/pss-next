import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHooks } from "../agent/core/hooks";
import { throwIfManualToolRecoveryRequired } from "../execution/resume/checkpoints";
import { ToolExecutionNeedsRecoveryError } from "../llm/tool-execution-checkpoint";
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
import { assistantMessage } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("hook-forced tool recovery through Agent", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets hooks stop tool execution after the before-tool checkpoint", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { checkpoints, host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executions = 0;
    const interceptedToolNames: string[] = [];

    generateTextMock.mockImplementationOnce(
      async (options: GenerateTextToolOptions) => {
        await executableTool(options.tools ?? {}, "dangerous_tool").execute?.(
          {},
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [assistantMessage("SHOULD NOT FINISH")],
        };
      }
    );

    const hooks: AgentHooks = {
      beforeToolExecution: (event) => {
        interceptedToolNames.push(event.toolName);
        return { status: "needs-recovery" };
      },
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        dangerous_tool: checkpointedTool("manual-recovery", () => {
          executions += 1;
          return { ok: true };
        }),
      },
    });

    const events = await collectRun(await agent.send("use the tool"));

    expect(interceptedToolNames).toEqual(["dangerous_tool"]);
    expect(executions).toBe(0);
    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "before-tool",
    ]);
    expect(checkpoints[0]?.pendingToolCall).toMatchObject({
      policy: "manual-recovery",
      toolName: "dangerous_tool",
    });
    expect(events.map((event) => event.type)).toContain("turn-error");
    await expect(
      host.store.turns.get(checkpoints[0]?.runId ?? "")
    ).resolves.toMatchObject({
      status: "needs-recovery",
    });
  });

  it("persists hook-forced recovery so idempotent tools cannot replay on resume", async () => {
    const { createAgent } = await import("../agent/core/agent");
    const { checkpoints, host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;
    let executions = 0;

    generateTextMock.mockImplementationOnce(
      async (options: GenerateTextToolOptions) => {
        await executableTool(options.tools ?? {}, "dangerous_tool").execute?.(
          {},
          toolOptions("call_sdk-tool-call-1", signal)
        );

        return {
          responseMessages: [assistantMessage("SHOULD NOT FINISH")],
        };
      }
    );

    const hooks: AgentHooks = {
      beforeToolExecution: () => ({ status: "needs-recovery" }),
    };

    const agent = await createAgent({
      host,
      model: fakeModel,
      hooks,
      tools: {
        dangerous_tool: checkpointedTool("idempotent", () => {
          executions += 1;
          return { ok: true };
        }),
      },
    });

    const events = await collectRun(await agent.send("use the tool"));
    const latestCheckpoint = await host.store.checkpoints.latest(
      checkpoints[0]?.runId ?? ""
    );

    expect(executions).toBe(0);
    expect(events.map((event) => event.type)).toContain("turn-error");
    expect(checkpoints.at(-1)?.pendingToolCall).toMatchObject({
      policy: "manual-recovery",
      toolName: "dangerous_tool",
    });
    expect(() => throwIfManualToolRecoveryRequired(latestCheckpoint)).toThrow(
      ToolExecutionNeedsRecoveryError
    );
  });
});
