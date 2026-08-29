import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHost, Checkpoint } from "../execution";
import { InMemorySqlStorage } from "../platform/durable-object/sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../platform/durable-object/storage/durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "../platform/durable-object/storage/execution/store";
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
  loadAgent,
} from "./llm-test-utils";
import { assistantMessage, toolCallPart, toolResultFor } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const textEncoder = new TextEncoder();

function createCheckpointSpyCloudflareHost(maxPayloadBytes: number): {
  readonly checkpoints: Checkpoint[];
  readonly host: AgentHost;
} {
  const store = new DurableObjectExecutionStore({
    maxPayloadBytes,
    storage: new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    }),
  });
  const checkpoints: Checkpoint[] = [];

  return {
    checkpoints,
    host: {
      diagnostics: { report: () => undefined },
      scheduler: {
        enqueueRun: async () => undefined,
        resumeThread: async () => undefined,
      },
      store: {
        checkpoints: {
          append: async (checkpoint, options) => {
            const result = await store.checkpoints.append(checkpoint, options);
            if (result.ok) {
              checkpoints.push(checkpoint);
            }
            return result;
          },
          latest: (runId) => store.checkpoints.latest(runId),
        },
        deleteThread: store.deleteThread.bind(store),
        events: store.events,
        inputs: store.inputs,
        notifications: store.notifications,
        turns: store.turns,
        threads: store.threads,
        transaction: (fn) => store.transaction(fn),
      },
    },
  };
}

describe("tool checkpointing through Agent", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves aggregate deletion in the Cloudflare checkpoint host", async () => {
    const { host } = createCheckpointSpyCloudflareHost(900);
    const threadKey = "cloudflare-wrapper-delete";
    await host.store.threads.commit(
      threadKey,
      { state: { messages: ["delete me"] } },
      { expectedVersion: null }
    );
    await host.store.inputs.admit({
      input: { text: "delete", type: "user-input" },
      kind: "send",
      messageId: "delete-input",
      threadKey,
    });
    const deleteThread = host.store.deleteThread;
    if (deleteThread === undefined) {
      throw new TypeError("Cloudflare host must preserve aggregate deletion");
    }

    await deleteThread(threadKey);

    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(
      host.store.inputs.claimNext(threadKey, "turn-idle")
    ).resolves.toBeNull();
  });

  it("threads execution-host tool checkpoints through high-level Agent", async () => {
    const Agent = await loadAgent();
    const { checkpoints, host } = createCheckpointSpyHost();
    const signal = new AbortController().signal;

    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart(
          "call_sdk-tool-call-1",
          "checkpointed_tool"
        );
        await executableTool(
          options.tools ?? {},
          "checkpointed_tool"
        ).execute?.(
          { secret: "raw input must not persist" },
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

    const agent = new Agent({
      host,
      model: fakeModel,
      tools: {
        checkpointed_tool: checkpointedTool("idempotent", () => ({
          ok: true,
        })),
      },
    });

    await collectRun(await agent.send("use the tool"));

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "before-tool",
      "after-tool",
    ]);
    const [beforeTool, afterTool] = checkpoints;
    expect(beforeTool?.pendingToolCall).toMatchObject({
      idempotencyKey: `${beforeTool?.runId}:call_sdk-tool-call-1`,
      policy: "idempotent",
      toolName: "checkpointed_tool",
    });
    expect(beforeTool?.pendingToolCall).not.toHaveProperty("input");
    expect(afterTool?.pendingToolCall).toMatchObject({
      toolCallId: "call_sdk-tool-call-1",
      toolName: "checkpointed_tool",
    });
    expect(afterTool?.pendingToolCall).not.toHaveProperty("input");
    expect(afterTool?.pendingToolCall).not.toHaveProperty("output");
    expect(beforeTool?.threadSnapshot).toEqual({
      kind: "thread-reference",
      schemaVersion: 1,
      threadKey: "default",
      threadVersion: expect.any(String),
    });
    expect(beforeTool?.threadSnapshot).not.toHaveProperty("history");
    expect(afterTool?.threadSnapshot).toEqual(beforeTool?.threadSnapshot);
    await expect(
      host.store.turns.get(beforeTool?.runId ?? "")
    ).resolves.toMatchObject({
      checkpointVersion: 2,
      kind: "user-turn",
      status: "completed",
    });
  });

  it("keeps tool checkpoints bounded when the thread history is long", async () => {
    const Agent = await loadAgent();
    const { checkpoints, host } = createCheckpointSpyCloudflareHost(900);
    const signal = new AbortController().signal;

    for (let index = 0; index < 10; index += 1) {
      generateTextMock.mockImplementationOnce(async () => ({
        responseMessages: [assistantMessage(`ACK ${index}`)],
      }));
    }
    generateTextMock
      .mockImplementationOnce(async (options: GenerateTextToolOptions) => {
        const toolCall = toolCallPart(
          "call_sdk-tool-call-1",
          "checkpointed_tool"
        );
        await executableTool(
          options.tools ?? {},
          "checkpointed_tool"
        ).execute?.({}, toolOptions("call_sdk-tool-call-1", signal));

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

    const agent = new Agent({
      host,
      model: fakeModel,
      tools: {
        checkpointed_tool: checkpointedTool("idempotent", () => ({
          ok: true,
        })),
      },
    });

    for (let index = 0; index < 10; index += 1) {
      await collectRun(
        await agent.send(`history turn ${index}: ${"x".repeat(80)}`)
      );
    }

    const events = await collectRun(await agent.send("use the tool"));

    expect(events.map((event) => event.type)).not.toContain("turn-error");
    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "before-tool",
      "after-tool",
    ]);
    for (const checkpoint of checkpoints) {
      const checkpointBytes = textEncoder.encode(
        JSON.stringify(checkpoint)
      ).byteLength;
      expect(checkpointBytes).toBeLessThan(900);
      expect(checkpoint.threadSnapshot).toMatchObject({
        kind: "thread-reference",
        threadKey: "default",
      });
      expect(checkpoint.threadSnapshot).not.toHaveProperty("history");
    }
  });
});
