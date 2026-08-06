import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentHost } from "../../execution";
import {
  createCloudflareStorageHost,
  InMemoryCloudflareDurableObjectStorage,
} from "../../platform/cloudflare/host/durable-object-host";
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
      "Cloudflare",
      () =>
        createCloudflareStorageHost({
          prefix: `follow-up-concurrency-${crypto.randomUUID()}`,
          storage: new InMemoryCloudflareDurableObjectStorage(),
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
      const model = createCallbackModel(async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return [assistantMessage(`DONE ${calls}`)];
      });
      const firstAgent = new Agent({ host, model });
      const secondAgent = new Agent({ host, model });

      const [first, second] = await Promise.all([
        firstAgent.thread("shared-follow-up").followUp("first"),
        secondAgent.thread("shared-follow-up").followUp("second"),
      ]);
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first),
        collect(second),
      ]);

      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
      expect(firstEvents.at(-1)?.type).toBe("turn-end");
      expect(secondEvents.at(-1)?.type).toBe("turn-end");
    });
  }
);
