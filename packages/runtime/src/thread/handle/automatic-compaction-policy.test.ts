import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { AgentThread } from "./agent-thread";
import {
  agentWithAutoCompaction,
  nextMacrotask,
  storedAssistantOutput,
  tokenCompactionPolicy,
  waitForModelCalls,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

const autoCompactionError = /autoCompaction/;
const triggerTokensError = /autoCompaction\.triggerTokens/;
const retainTokensError = /autoCompaction\.retainTokens/;

const largeUserText = (): string => "x".repeat(90_000);

describe("Agent thread automatic compaction policy", () => {
  it("compacts by default once the default context budget fills", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage(`DONE ${calls}`)];
      }),
    });
    const thread = agent.thread("default-enabled");

    for (let turn = 0; turn < 5; turn += 1) {
      await collect(await thread.send(largeUserText()));
    }
    await waitForModelCalls(() => calls, 6);

    expect(store.threads.get("default-enabled")?.state).toMatchObject({
      compactions: [
        {
          endSeqExclusive: 4,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "DONE 6", role: "system" },
        },
      ],
      schemaVersion: 2,
    });
  });

  it("skips automatic compaction while history is below the threshold", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 10, trigger: 80 }),
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });

    await collect(await agent.thread("below-threshold").send("small"));

    expect(calls).toBe(1);
    expect(store.threads.get("below-threshold")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("small")),
        storedAssistantOutput("DONE"),
      ],
      schemaVersion: 1,
    });
  });

  it("rejects malformed automatic compaction options during AgentOptions validation", () => {
    const model = createCallbackModel(() => [assistantMessage("unused")]);

    expect(() =>
      agentWithAutoCompaction({
        autoCompaction: false as unknown as Record<string, never>,
        model,
      })
    ).toThrow(autoCompactionError);

    expect(() =>
      agentWithAutoCompaction({
        autoCompaction: { maxInputTokens: 100_000, triggerTokens: 200_000 },
        model,
      })
    ).toThrow(triggerTokensError);

    expect(() =>
      agentWithAutoCompaction({
        autoCompaction: { retainTokens: 60_000, triggerTokens: 50_000 },
        model,
      })
    ).toThrow(retainTokensError);
  });

  it("does not schedule automatic compaction for notify-only turns", async () => {
    const store = new SpyStore();
    const summaryStarted = createDeferred();
    let calls = 0;
    const thread = new AgentThread(
      {
        model: createCallbackModel(() => {
          calls += 1;
          if (calls === 1) {
            return [assistantMessage("first notification done")];
          }
          if (calls === 2) {
            return [assistantMessage("second notification done")];
          }
          summaryStarted.resolve();
          return [assistantMessage("unexpected notify summary")];
        }),
      },
      { key: "notify-only-auto-skip", store },
      { autoCompaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }) }
    );

    await collect(await thread.notify("first notification"));
    await collect(await thread.notify("second notification"));

    const result = await Promise.race([
      summaryStarted.promise.then(() => "summary-started" as const),
      nextMacrotask().then(() => "idle" as const),
    ]);

    expect(result).toBe("idle");
    expect(calls).toBe(2);
    expect(store.threads.get("notify-only-auto-skip")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("first notification")),
        storedAssistantOutput("first notification done"),
        userTextToModelMessage(userText("second notification")),
        storedAssistantOutput("second notification done"),
      ],
      schemaVersion: 1,
    });
  });
});
