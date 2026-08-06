import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../../agent/core/agent";
import { agentNamespace } from "../../../agent/identity/namespace";
import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import { dispatchAgentNotification } from "../../../execution/dispatch/notification-dispatch";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../../testing/test-fixtures";
import { collect } from "../../../thread/handle/test-support";
import { createFileHost } from "./file-host";
import { drainScheduledNodeWork } from "./scheduled-work-drainer";
import {
  ackScheduledNodeRun,
  ackScheduledNodeThreadPrompt,
  appendScheduledNodeRun,
  appendScheduledNodeThreadPrompt,
  listScheduledNodeRuns,
  listScheduledNodeThreadPrompts,
} from "./scheduled-work-store";

describeAgentHostFaultContract({
  createHost: () => {
    const directory = join(tmpdir(), `pss-host-contract-${randomUUID()}`);
    return {
      cleanup: () => removeTempDir(directory),
      host: createFileHost({ directory }),
    };
  },
  name: "file",
});

const malformedScheduledWorkPattern =
  /Invalid Node scheduled work file .*invalid JSON/;

describe("createFileHost", () => {
  it("persists resumable notification runs across reconstructed hosts", async () => {
    const directory = await tempDir();
    try {
      const firstHost = createFileHost({ directory });
      const dispatched = await dispatchAgentNotification({
        host: firstHost,
        idempotencyKey: "local-reminder:1",
        input: { text: "local reminder fired", type: "user-input" },
        namespace: "local-owner",
        observerEvents: [
          {
            text: "local reminder completed",
            type: "assistant-reasoning",
          },
        ],
        threadKey: "thread:local",
      });

      await expect(listScheduledNodeThreadPrompts(directory)).resolves.toEqual([
        expect.objectContaining({
          notificationId: dispatched.notificationId,
          runId: dispatched.runId,
          threadKey: "thread:local",
        }),
      ]);

      const secondHost = createFileHost({ directory });
      const createAgent = () =>
        new Agent({
          host: secondHost,
          model: createCallbackModel(() =>
            Promise.resolve([assistantMessage("RESUMED")])
          ),
          namespace: "local-owner",
        });
      const agent = createAgent();

      expect(agent.supportsResume).toBe(true);

      const run = await agent.resume(dispatched.runId);
      expect(run).not.toBeNull();
      if (!run) {
        throw new Error("Expected resumed node file run.");
      }

      const events = await collect(run);
      expect(eventTypes(events)).toEqual([
        "assistant-reasoning",
        "turn-start",
        "runtime-input",
        "step-start",
        "model-usage",
        "assistant-output",
        "step-end",
        "turn-end",
      ]);
      await expect(
        secondHost.store.turns.get(dispatched.runId)
      ).resolves.toEqual(
        expect.objectContaining({
          ownerNamespace: agentNamespace("local-owner"),
          status: "completed",
        })
      );

      const duplicate = await agent.resume(dispatched.runId);
      expect(duplicate).toBeNull();

      const drainResult = await drainScheduledNodeWork({
        agentForRun: () => createAgent(),
        directory,
      });
      expect(drainResult.ackedThreadPrompts).toEqual([
        expect.objectContaining({
          notificationId: dispatched.notificationId,
          runId: dispatched.runId,
          threadKey: "thread:local",
        }),
      ]);
      expect(drainResult.events).toEqual([]);

      const dataDirectory = await currentDataDirectory(directory);
      expect(await readdir(join(dataDirectory, "threads"))).not.toHaveLength(0);
      expect(await readdir(join(dataDirectory, "runs"))).not.toHaveLength(0);
      expect(
        await readdir(join(dataDirectory, "notifications"))
      ).not.toHaveLength(0);
      await expect(listScheduledNodeThreadPrompts(directory)).resolves.toEqual(
        []
      );
    } finally {
      await removeTempDir(directory);
    }
  });

  it("dedupes and acks local scheduled work files", async () => {
    const directory = await tempDir();
    try {
      await appendScheduledNodeRun(directory, "run:delayed", {
        runAfterMs: 1000,
      });
      await appendScheduledNodeRun(directory, "run:1");
      await appendScheduledNodeRun(directory, "run:1");
      await appendScheduledNodeThreadPrompt(directory, {
        idempotencyKey: "notify:1",
        notificationId: "notification:1",
        runId: "run:notify",
        threadKey: "thread:1",
      });
      await appendScheduledNodeThreadPrompt(directory, {
        idempotencyKey: "notify:1",
        notificationId: "notification:other",
        runId: "run:notify",
        threadKey: "thread:1",
      });

      await expect(listScheduledNodeRuns(directory)).resolves.toEqual([
        "run:1",
      ]);
      await expect(
        listScheduledNodeRuns(directory, { nowMs: Date.now() + 2000 })
      ).resolves.toEqual(["run:1", "run:delayed"]);
      const prompts = await listScheduledNodeThreadPrompts(directory);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toEqual({
        idempotencyKey: "notify:1",
        notificationId: "notification:1",
        runId: "run:notify",
        threadKey: "thread:1",
      });

      await ackScheduledNodeRun(directory, "run:1");
      await ackScheduledNodeThreadPrompt(directory, prompts[0]);

      await expect(listScheduledNodeRuns(directory)).resolves.toEqual([]);
      await expect(listScheduledNodeThreadPrompts(directory)).resolves.toEqual(
        []
      );
    } finally {
      await removeTempDir(directory);
    }
  });

  it("keeps scheduled work pending when the run is still leased", async () => {
    const directory = await tempDir();
    try {
      const host = createFileHost({ directory });
      const agent = new Agent({
        host,
        model: createCallbackModel(() =>
          Promise.resolve([assistantMessage("SHOULD NOT RUN")])
        ),
        namespace: "local-owner",
      });
      await host.store.turns.create({
        checkpointVersion: 0,
        kind: "notification",
        lease: {
          attempt: 1,
          leaseId: "active-lease",
          leaseUntilMs: Date.now() + 60_000,
        },
        ownerNamespace: agentNamespace("local-owner"),
        rootRunId: "run:leased",
        runId: "run:leased",
        status: "leased",
        threadKey: "thread:leased",
      });
      const prompt = {
        idempotencyKey: "notify:leased",
        notificationId: "notification:leased",
        runId: "run:leased",
        threadKey: "thread:leased",
      };
      await appendScheduledNodeRun(directory, "run:leased");
      await appendScheduledNodeThreadPrompt(directory, prompt);

      const drainResult = await drainScheduledNodeWork({
        agentForRun: () => agent,
        directory,
      });

      expect(drainResult.ackedRuns).toEqual([]);
      expect(drainResult.ackedThreadPrompts).toEqual([]);
      expect(drainResult.skippedRuns).toEqual(["run:leased"]);
      expect(drainResult.skippedThreadPrompts).toEqual([prompt]);
      await expect(listScheduledNodeRuns(directory)).resolves.toEqual([
        "run:leased",
      ]);
      await expect(listScheduledNodeThreadPrompts(directory)).resolves.toEqual([
        prompt,
      ]);
    } finally {
      await removeTempDir(directory);
    }
  });

  it("throws deterministic errors for malformed scheduled work files", async () => {
    const directory = await tempDir();
    try {
      await mkdir(join(directory, "scheduled-work", "run"), {
        recursive: true,
      });
      await writeFile(
        join(directory, "scheduled-work", "run", "bad.json"),
        "{ nope",
        "utf8"
      );

      await expect(listScheduledNodeRuns(directory)).rejects.toThrow(
        malformedScheduledWorkPattern
      );
    } finally {
      await removeTempDir(directory);
    }
  });
});

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pss-runtime-node-execution-host-"));
}

function removeTempDir(directory: string): Promise<void> {
  return rm(directory, { force: true, maxRetries: 10, recursive: true });
}

async function currentDataDirectory(directory: string): Promise<string> {
  const generationId = await readFile(
    join(directory, ".current-generation"),
    "utf8"
  );
  return join(directory, "generations", generationId.trim());
}
