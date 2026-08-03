import { describe, expect, it, vi } from "vitest";
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
  agentWithCompaction,
  nextMacrotask,
  storedAssistantOutput,
  tokenCompactionPolicy,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

describe("Agent thread automatic compaction policy", () => {
  it("skips automatic compaction while history is below the threshold", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 10, trigger: 80 }),
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
      { compaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }) }
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

  it.each([
    {
      action: "cancel" as const,
      expectedSummary: undefined,
    },
    {
      action: "transform" as const,
      expectedSummary: "hook transformed summary",
    },
  ])(
    "allows beforeCompaction to $action a policy result",
    async ({ action, expectedSummary }) => {
      const store = new SpyStore();
      const agent = agentWithCompaction({
        compaction: ({ history }) =>
          history.length < 4
            ? undefined
            : { endSeqExclusive: 2, startSeq: 0, summary: "policy summary" },
        hooks: {
          beforeCompaction: ({ input }) =>
            action === "cancel"
              ? { action }
              : {
                  action,
                  input: { ...input, summary: "hook transformed summary" },
                },
        },
        host: hostWithThreads(store),
        model: createCallbackModel(() => [assistantMessage("DONE")]),
      });

      await collect(await agent.thread(`hook-${action}`).send("old"));
      await collect(await agent.thread(`hook-${action}`).send("tail"));
      await vi.waitFor(() => {
        const state = store.threads.get(`hook-${action}`)?.state as
          | { compactions?: Array<{ summary: { content: string } }> }
          | undefined;
        if (expectedSummary) {
          expect(state?.compactions?.[0]?.summary.content).toBe(
            expectedSummary
          );
        } else {
          expect(state?.compactions).toBeUndefined();
        }
      });
    }
  );
});
