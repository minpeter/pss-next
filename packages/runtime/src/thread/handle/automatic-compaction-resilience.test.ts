import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
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
import {
  ConflictOnCommitStore,
  collect,
  RejectOnCompactionCommitStore,
  SpyStore,
} from "./test-support";

describe("Agent thread automatic compaction resilience", () => {
  it("preserves latest tail and tool-call/tool-result adjacency when choosing the compacted range", async () => {
    const store = new SpyStore();
    const toolCall = toolCallPart("call-1", "lookup", { query: "old" });
    const model = createScriptedModelOptions([
      [assistantMessage([toolCall]), toolResultFor(toolCall)],
      [assistantMessage("tool turn complete")],
      [assistantMessage("follow-up complete")],
      [assistantMessage("tool turn summarized")],
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

  it("does not surface compaction commit conflicts as turn errors or corrupt stored history", async () => {
    const store = new ConflictOnCommitStore();
    store.conflictOnCommit = 5;
    const compactionSettled = createDeferred();
    store.onConflict = () => compactionSettled.resolve();
    let recoveryHistory: ModelMessage[] | undefined;
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        const lastUser = history
          .filter((message) => message.role === "user")
          .at(-1);
        if (lastUser?.content === "old") {
          return [assistantMessage("FIRST")];
        }
        if (lastUser?.content === "tail") {
          return [assistantMessage("SECOND")];
        }
        if (lastUser?.content === "after conflict") {
          recoveryHistory = [...history];
          return [assistantMessage("RECOVERED")];
        }
        return [assistantMessage("summary loses conflict")];
      }),
    });
    const thread = agent.thread("summary-conflict");

    await collect(await thread.send("old"));
    const events = await collect(await thread.send("tail"));

    expect(eventTypes(events)).not.toContain("turn-error");
    await compactionSettled.promise;
    expect(store.threads.get("summary-conflict")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("FIRST"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("SECOND"),
      ],
      schemaVersion: 1,
    });

    await collect(await thread.send("after conflict"));

    expect(recoveryHistory).toContainEqual(
      expect.objectContaining({ content: "tail", role: "user" })
    );
    expect(recoveryHistory).toContainEqual(
      expect.objectContaining({ content: "SECOND", role: "assistant" })
    );
    expect(recoveryHistory).toContainEqual(
      expect.objectContaining({ content: "after conflict", role: "user" })
    );
  });

  it("rolls back in-memory compaction state when compaction commit throws", async () => {
    const store = new RejectOnCompactionCommitStore();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("FIRST")];
        }
        if (calls === 2) {
          return [assistantMessage("SECOND")];
        }
        if (calls === 3) {
          return [assistantMessage("summary fails to commit")];
        }
        return [assistantMessage("AFTER FAILURE")];
      }),
    });
    const thread = agent.thread("summary-rejected");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    await waitForModelCalls(() => calls, 3);

    await collect(await thread.send("after failure"));

    expect(seenHistory.at(-1)).toContainEqual(
      userTextToModelMessage(userText("after failure"))
    );
    expect(store.threads.get("summary-rejected")?.state).toMatchObject({
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("FIRST"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("SECOND"),
        userTextToModelMessage(userText("after failure")),
        storedAssistantOutput("AFTER FAILURE"),
      ],
      schemaVersion: 1,
    });
  });

  it("re-evaluates a broader range after an append-only background compaction", async () => {
    const store = new SpyStore();
    const staleSummaryStarted = createDeferred();
    const staleSummaryRelease = createDeferred();
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(async () => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("FIRST")];
        }
        if (calls === 2) {
          return [assistantMessage("SECOND")];
        }
        if (calls === 3) {
          staleSummaryStarted.resolve();
          await staleSummaryRelease.promise;
          return [assistantMessage("STALE SUMMARY")];
        }
        if (calls === 4) {
          return [assistantMessage("THIRD")];
        }
        return [assistantMessage("FRESH BROADER SUMMARY")];
      }),
    });
    const thread = agent.thread("stale-background-summary");

    await collect(await thread.send("old"));
    await collect(await thread.send("middle"));
    await staleSummaryStarted.promise;
    await collect(await thread.send("tail"));
    staleSummaryRelease.resolve();
    await waitForModelCalls(() => calls, 5);

    expect(store.threads.get("stale-background-summary")?.state).toMatchObject({
      compactions: [
        {
          endSeqExclusive: 2,
          schemaVersion: 1,
          startSeq: 0,
          summary: {
            content: "STALE SUMMARY",
            role: "system",
          },
        },
        {
          endSeqExclusive: 4,
          schemaVersion: 1,
          startSeq: 0,
          summary: {
            content: "FRESH BROADER SUMMARY",
            role: "system",
          },
        },
      ],
      schemaVersion: 2,
    });
  });
});
