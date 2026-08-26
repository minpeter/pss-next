import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
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

describe("Agent thread automatic compaction commit resilience", () => {
  it("does not surface commit conflicts or corrupt stored history", async () => {
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

  it("rolls back in-memory compaction state when commit throws", async () => {
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

  it("re-evaluates a broader range after append-only compaction", async () => {
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
          summary: { content: "STALE SUMMARY", role: "system" },
        },
        {
          endSeqExclusive: 4,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "FRESH BROADER SUMMARY", role: "system" },
        },
      ],
      schemaVersion: 2,
    });
  });
});
