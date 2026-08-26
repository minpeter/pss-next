import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";
import { ConflictOnCommitStore, collect, SpyStore } from "./test-support";

describe("Agent thread persistence", () => {
  it("emits and propagates runtime input commit conflicts without using the conflicted snapshot", async () => {
    const store = new ConflictOnCommitStore();
    store.conflictOnCommit = 2;
    const seenHistory: ModelMessage[][] = [];
    const thread = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    }).thread("runtime-conflict");
    const run = await thread.send("initial");
    const events: AgentEvent[] = [];
    let runtimeAdd: Promise<void> | undefined;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn-start" && !runtimeAdd) {
        runtimeAdd = thread.steer("conflicting runtime").then(() => undefined);
      }
    }

    await expect(runtimeAdd).resolves.toBeUndefined();
    const turnError = events.find((event) => event.type === "turn-error");
    expect(turnError).toMatchObject({ type: "turn-error" });
    expect(JSON.stringify(turnError)).not.toContain("runtime-conflict");
    expect(seenHistory).toEqual([]);
  });

  it("uses default and explicit default thread state interchangeably", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });

    await collect(await agent.send("first"));
    await collect(await agent.thread("default").send("second"));

    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      assistantMessage("DONE"),
      userTextToModelMessage(userText("second")),
    ]);
  });

  it("keeps overlay visible to one turn without persisting it", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistory.length}`),
        ]);
      }),
    });
    const thread = agent.thread("overlay");

    await collect(await thread.overlay("volatile context").send("first"));
    await collect(await thread.send("second"));

    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("volatile context")),
        userTextToModelMessage(userText("first")),
      ],
      [
        userTextToModelMessage(userText("first")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
    expect(JSON.stringify(store.threads.get("overlay")?.state)).not.toContain(
      "volatile context"
    );
  });

  it("isolates named thread keys and resumes same-key state", async () => {
    const seenHistory: Record<string, ModelMessage[][]> = { a: [], b: [] };
    let currentKey = "a";
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory[currentKey]?.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${currentKey}`)]);
      }),
    });

    currentKey = "a";
    await collect(await agent.thread("a").send("first a"));
    currentKey = "b";
    await collect(await agent.thread("b").send("first b"));
    currentKey = "a";
    await collect(await agent.thread("a").send("second a"));

    expect(seenHistory.a[1]).toEqual([
      userTextToModelMessage(userText("first a")),
      assistantMessage("DONE a"),
      userTextToModelMessage(userText("second a")),
    ]);
    expect(seenHistory.b[0]).toEqual([
      userTextToModelMessage(userText("first b")),
    ]);
  });

  it("serializes concurrent sends to the same key deterministically", async () => {
    const firstLlmCall = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          await firstLlmCall.promise;
        }
        return [assistantMessage(`DONE ${calls}`)];
      }),
    });

    const firstRun = await agent.thread("same").send("first");
    const secondRun = await agent.thread("same").send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);
    firstLlmCall.resolve();

    await Promise.all([firstEvents, secondEvents]);

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("first"))],
      [
        userTextToModelMessage(userText("first")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("shares the initial store load across concurrent first sends", async () => {
    const loadGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    const store = new SpyStore();
    store.loadGate = loadGate.promise;
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistory.length}`),
        ]);
      }),
    });
    const thread = agent.thread("race");

    const firstRun = thread.send("first");
    const secondRun = thread.send("second");
    expect(store.loadCount).toBe(1);
    loadGate.resolve();
    await Promise.all([collect(await firstRun), collect(await secondRun)]);

    expect(store.loadCount).toBe(1);
    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("first"))],
      [
        userTextToModelMessage(userText("first")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("persists versioned runtime-owned thread snapshots through ThreadStore", async () => {
    const store = new SpyStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.thread("spy").send("hello"));

    expect(store.commits.length).toBeGreaterThanOrEqual(1);
    const finalCommit = store.commits.at(-1);
    expect(finalCommit?.key).toBe("spy");
    expect(finalCommit?.next.state).toEqual(
      expect.objectContaining({ history: expect.any(Array), schemaVersion: 1 })
    );
    expect(finalCommit?.next.state).not.toBeInstanceOf(Array);
    expect(finalCommit?.next).not.toHaveProperty("version");
    expect(store.commits[0]?.expectedVersion).toBeNull();
  });

  it("surfaces thread commit conflicts as turn errors", async () => {
    const remoteHistory = [
      userTextToModelMessage(userText("remote")),
      assistantMessage("REMOTE"),
    ];
    const store = new ConflictOnCommitStore();
    store.conflictOnCommit = 1;
    store.threads.set("shared", {
      state: { history: remoteHistory, schemaVersion: 1 },
      version: "1",
    });
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    expect(
      eventTypes(await collect(await agent.thread("shared").send("probe")))
    ).toContain("turn-error");
    expect(store.threads.get("shared")?.state).toEqual({
      history: remoteHistory,
      schemaVersion: 1,
    });
  });
});
