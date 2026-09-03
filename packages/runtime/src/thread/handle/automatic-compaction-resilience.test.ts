import { describe, expect, it } from "vitest";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createScriptedModelOptions,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import {
  agentWithCompaction,
  storedAssistantOutput,
  tokenCompactionPolicy,
  waitForModelCalls,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

describe("Agent thread automatic compaction resilience", () => {
  it("preserves latest tail and tool-call/tool-result adjacency when choosing the compacted range", async () => {
    const store = new SpyStore();
    const toolCall = toolCallPart("call-1", "lookup", { query: "old" });
    const model = createScriptedModelOptions([
      [assistantMessage([toolCall]), toolResultFor(toolCall)],
      [assistantMessage("tool turn complete")],
      // First-compaction forward progress prepares immediately after the tool turn,
      // so its summary response deliberately precedes the next user-turn response.
      [assistantMessage("tool turn summarized")],
      [assistantMessage("follow-up complete")],
      [assistantMessage("after summary complete")],
    ]);
    const agent = agentWithCompaction({
      ...model,
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
    });
    const thread = agent.thread("tool-tail");

    await collect(await thread.send("start"));
    await waitForModelCalls(() => model.model.doGenerateCalls.length, 2);
    expect(store.threads.get("tool-tail")?.state).not.toHaveProperty(
      "compactions"
    );

    await collect(await thread.send("follow-up"));
    await waitForModelCalls(() => model.model.doGenerateCalls.length, 4);

    expect(store.threads.get("tool-tail")?.state).toMatchObject({
      compactions: [
        {
          endSeqExclusive: 4,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "tool turn summarized", role: "system" },
        },
      ],
      schemaVersion: 2,
    });

    await collect(await thread.send("after-summary"));

    const followUpCall = model.model.doGenerateCalls.at(-1);
    expect(JSON.stringify(followUpCall)).toContain("tool turn summarized");
    expect(JSON.stringify(followUpCall)).toContain("follow-up");
    expect(JSON.stringify(followUpCall)).toContain("after-summary");
  });

  it("does not surface summary failures as turn errors or corrupt stored history", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("FIRST")];
        }
        if (calls === 2) {
          return [assistantMessage("SECOND")];
        }
        throw new Error("summary failed");
      }),
    });
    const thread = agent.thread("summary-fails");

    await collect(await thread.send("old"));
    const events = await collect(await thread.send("tail"));

    expect(eventTypes(events)).not.toContain("turn-error");
    await waitForModelCalls(() => calls, 3);
    expect(store.threads.get("summary-fails")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("FIRST"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("SECOND"),
      ],
      schemaVersion: 1,
    });
  });
});
