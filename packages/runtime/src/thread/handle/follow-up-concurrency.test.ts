import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentHost } from "../../execution";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage,
} from "../../platform/durable-object/host/storage-host";
import { FileExecutionStore } from "../../platform/file/storage/file-execution-store";
import { tempDir } from "../../platform/file/storage/file-execution-store-test-support";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { collect } from "./test-support";

const hostFactories: readonly [string, () => AgentHost | Promise<AgentHost>][] =
  [
    ["memory", () => createInMemoryHost()],
    [
      "file",
      async () => {
        const fallback = createInMemoryHost();
        return {
          ...fallback,
          store: new FileExecutionStore(await tempDir()),
        };
      },
    ],
    [
      "durable object",
      () =>
        createDurableObjectStorageHost({
          prefix: `follow-up-concurrency-${crypto.randomUUID()}`,
          storage: new InMemoryDurableObjectStorage(),
        }),
    ],
  ];

describe.each(hostFactories)(
  "%s host follow-up ownership",
  (_name, hostFactory) => {
    it("serializes model turns across Agent handles sharing a thread", async () => {
      const host = await hostFactory();
      let active = 0;
      let calls = 0;
      let maxActive = 0;
      const modelOrder: string[] = [];
      const model = createCallbackModel(async ({ history }) => {
        modelOrder.push(JSON.stringify(history));
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return [assistantMessage(`DONE ${calls}`)];
      });
      const firstAgent = new Agent({ host, model });
      const secondAgent = new Agent({ host, model });

      const first = await firstAgent
        .thread("shared-follow-up")
        .followUp("first");
      const second = await secondAgent
        .thread("shared-follow-up")
        .followUp("second");
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first),
        collect(second),
      ]);

      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
      expect(modelOrder).toHaveLength(2);
      expect(modelOrder[0]).toContain("first");
      expect(modelOrder[0]).not.toContain("second");
      expect(modelOrder[1]).toContain("second");
      expect(firstEvents[0]).toMatchObject({
        text: "first",
        type: "user-input",
      });
      expect(secondEvents[0]).toMatchObject({
        text: "second",
        type: "user-input",
      });
      expect(firstEvents.at(-1)?.type).toBe("turn-end");
      expect(secondEvents.at(-1)?.type).toBe("turn-end");
    });

    it("refreshes a stale handle after another handle owns the thread", async () => {
      const host = await hostFactory();
      const model = createCallbackModel(() => [assistantMessage("DONE")]);
      const agentA = new Agent({ host, model });
      const agentB = new Agent({ host, model });
      const threadA = agentA.thread("alternating-follow-up");
      const threadB = agentB.thread("alternating-follow-up");

      const b1 = await collect(await threadB.followUp("B1"));
      const a1 = await collect(await threadA.followUp("A1"));
      const b2 = await collect(await threadB.followUp("B2"));

      expect(b1.at(-1)?.type).toBe("turn-end");
      expect(a1.at(-1)?.type).toBe("turn-end");
      expect(b2.at(-1)?.type).toBe("turn-end");
    });

    it.each([
      ["send", "send"],
      ["send", "followUp"],
    ] as const)(
      "keeps concurrent %s/%s records attached to their caller turns",
      async (firstMethod, secondMethod) => {
        const host = await hostFactory();
        const modelOrder: string[] = [];
        const model = createCallbackModel(async ({ history }) => {
          modelOrder.push(JSON.stringify(history));
          await new Promise((resolve) => setTimeout(resolve, 10));
          return [assistantMessage("DONE")];
        });
        const firstThread = new Agent({ host, model }).thread(
          `caller-turn-${firstMethod}-${secondMethod}`
        );
        const secondThread = new Agent({ host, model }).thread(
          `caller-turn-${firstMethod}-${secondMethod}`
        );

        const [firstTurn, secondTurn] = await Promise.all([
          firstThread[firstMethod]("first"),
          secondThread[secondMethod]("second"),
        ]);
        const [firstEvents, secondEvents] = await Promise.all([
          collect(firstTurn),
          collect(secondTurn),
        ]);

        expect(modelOrder).toHaveLength(2);
        expect(modelOrder.join("\n")).toContain("first");
        expect(modelOrder.join("\n")).toContain("second");
        expect(firstEvents[0]).toMatchObject({ text: "first" });
        expect(firstEvents.at(-1)?.type).toBe("turn-end");
        expect(secondEvents[0]).toMatchObject({ text: "second" });
        expect(secondEvents.at(-1)?.type).toBe("turn-end");
      }
    );
  }
);
