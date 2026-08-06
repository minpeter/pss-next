import { describe, expect, it } from "vitest";
import type { AgentHost, ClaimedThreadInput } from "../execution";

export interface AgentHostFaultContractOptions {
  readonly createHost: () => AgentHost;
  readonly name: string;
}

/**
 * Exercises durable boundaries where a host operation may commit even though
 * its caller never observes the result. These assertions intentionally cover
 * runtime-owned state only; hosts cannot make external side effects exactly
 * once.
 */
export function describeAgentHostFaultContract({
  createHost,
  name,
}: AgentHostFaultContractOptions): void {
  describe(`${name} AgentHost crash-boundary contract`, () => {
    it("uses exclusive, monotonic cursors when replay resumes after a crash", async () => {
      const store = createHost().store;
      const first = await store.events.append("run-cursor", {
        type: "turn-start",
      });
      const second = await store.events.append("run-cursor", {
        text: "durable",
        type: "assistant-output",
      });
      const third = await store.events.append("run-cursor", {
        type: "turn-end",
      });

      expect([first.offset, second.offset, third.offset]).toEqual([1, 2, 3]);
      expect(await collect(store.events.read("run-cursor", first))).toEqual([
        expect.objectContaining({ cursor: second }),
        expect.objectContaining({ cursor: third }),
      ]);
      expect(await collect(store.events.read("run-cursor", second))).toEqual([
        expect.objectContaining({ cursor: third }),
      ]);
      expect(await collect(store.events.read("run-cursor", third))).toEqual([]);
    });

    it("keeps a committed lease when the claim response is lost", async () => {
      const store = createHost().store;
      await store.turns.create(queuedRun("run-lease"));

      await expect(
        loseResponse(() =>
          store.turns.claim("run-lease", {
            attempt: 1,
            leaseId: "lease-lost-response",
            leaseMs: 100,
            nowMs: 1000,
          })
        )
      ).rejects.toThrow(LostHostResponseError);
      await expect(
        store.turns.claim("run-lease", {
          attempt: 2,
          leaseId: "lease-too-early",
          leaseMs: 100,
          nowMs: 1099,
        })
      ).resolves.toEqual({ ok: false, reason: "leased" });
      await expect(
        store.turns.claim("run-lease", {
          attempt: 2,
          leaseId: "lease-after-expiry",
          leaseMs: 50,
          nowMs: 1100,
        })
      ).resolves.toMatchObject({
        lease: {
          attempt: 2,
          leaseId: "lease-after-expiry",
          leaseUntilMs: 1150,
        },
        ok: true,
      });
    });

    it("makes admission retry-safe and recovers a claim lost at a crash boundary", async () => {
      const store = createHost().store;
      const admission = {
        admittedAtMs: 10,
        input: { text: "retry me", type: "user-input" } as const,
        kind: "send" as const,
        messageId: "input-lost-response",
        threadKey: "thread-input-crash",
      };

      await expect(
        loseResponse(() => store.inputs.admit(admission))
      ).rejects.toThrow(LostHostResponseError);
      await expect(store.inputs.admit(admission)).resolves.toMatchObject({
        duplicate: true,
        record: { admittedAtMs: 10, admittedSeq: 1, status: "pending" },
      });
      const claimed = await requireClaimed(
        store.inputs.claimNext("thread-input-crash", "turn-idle")
      );

      await expect(
        store.inputs.recoverClaims("thread-input-crash")
      ).resolves.toEqual({
        acked: [],
        released: [expect.objectContaining({ status: "pending" })],
      });
      const reclaimed = await requireClaimed(
        store.inputs.claimNext("thread-input-crash", "turn-idle")
      );
      expect(reclaimed.messageId).toBe(claimed.messageId);
      expect(reclaimed.claimId).not.toBe(claimed.claimId);
    });

    it("detects a checkpoint committed before its response was lost", async () => {
      const store = createHost().store;
      await store.turns.create(queuedRun("run-checkpoint"));
      const checkpoint = {
        checkpointId: "checkpoint-after-tool",
        phase: "after-tool" as const,
        runId: "run-checkpoint",
        runtimeState: { toolCall: "call-1" },
        threadSnapshot: { messages: [] },
        version: 1,
      };

      await expect(
        loseResponse(() =>
          store.checkpoints.append(checkpoint, { expectedVersion: 0 })
        )
      ).rejects.toThrow(LostHostResponseError);
      await expect(
        store.checkpoints.append(checkpoint, { expectedVersion: 0 })
      ).resolves.toEqual({
        currentVersion: 1,
        ok: false,
        reason: "stale-version",
      });
      await expect(store.checkpoints.latest("run-checkpoint")).resolves.toEqual(
        checkpoint
      );
    });

    it("does not expose partial runtime state when a transaction crashes", async () => {
      const store = createHost().store;

      await expect(
        store.transaction(async (tx) => {
          await tx.turns.create(queuedRun("run-transaction-crash"));
          await tx.events.append("run-transaction-crash", {
            type: "turn-start",
          });
          throw new InjectedHostCrashError();
        })
      ).rejects.toThrow(InjectedHostCrashError);

      await expect(
        store.turns.get("run-transaction-crash")
      ).resolves.toBeNull();
      expect(await collect(store.events.read("run-transaction-crash"))).toEqual(
        []
      );
    });
  });
}

class LostHostResponseError extends Error {
  constructor() {
    super("injected failure after host commit");
    this.name = "LostHostResponseError";
  }
}

class InjectedHostCrashError extends Error {
  constructor() {
    super("injected crash before transaction commit");
    this.name = "InjectedHostCrashError";
  }
}

async function loseResponse<T>(operation: () => Promise<T>): Promise<never> {
  await operation();
  throw new LostHostResponseError();
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function requireClaimed(
  claim: Promise<ClaimedThreadInput | null>
): Promise<ClaimedThreadInput> {
  const result = await claim;
  expect(result).not.toBeNull();
  if (!result) {
    throw new Error("Expected claimed input");
  }
  return result;
}

function queuedRun(runId: string) {
  return {
    checkpointVersion: 0,
    kind: "user-turn" as const,
    rootRunId: runId,
    runId,
    status: "queued" as const,
    threadKey: `thread:${runId}`,
  };
}
