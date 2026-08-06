import { describe, expect, it } from "vitest";
import {
  type ClaimedThreadInput,
  type HostStore,
  ThreadInputDuplicateConflictError,
} from "../../execution";
import { describeThreadInputInboxRecoveryContract } from "./thread-input-recovery-contract";

export interface ThreadInputInboxContractOptions {
  readonly createStore: () => HostStore;
}

export function describeThreadInputInboxContract({
  createStore,
}: ThreadInputInboxContractOptions): void {
  describe("ThreadInputInbox", () => {
    it("admits thread inputs idempotently and rejects semantic conflicts", async () => {
      const store = createStore();
      const input = { text: "first", type: "user-input" } as const;

      const admitted = await store.inputs.admit({
        admittedAtMs: 1,
        input,
        kind: "send",
        messageId: "message-1",
        threadKey: "thread-1",
      });
      const duplicate = await store.inputs.admit({
        admittedAtMs: 2,
        input,
        kind: "send",
        messageId: "message-1",
        threadKey: "thread-1",
      });

      expect(admitted).toMatchObject({
        duplicate: false,
        record: {
          admittedSeq: 1,
          messageId: "message-1",
          status: "pending",
        },
      });
      expect(duplicate).toMatchObject({
        duplicate: true,
        record: {
          admittedAtMs: 1,
          admittedSeq: 1,
          messageId: "message-1",
          status: "pending",
        },
      });
      await expect(
        store.inputs.admit({
          admittedAtMs: 3,
          input: { text: "changed", type: "user-input" },
          kind: "send",
          messageId: "message-1",
          threadKey: "thread-1",
        })
      ).rejects.toThrow(ThreadInputDuplicateConflictError);
    });

    it("keeps stored input isolated from duplicate conflict error mutation", async () => {
      const store = createStore();

      await store.inputs.admit({
        admittedAtMs: 1,
        input: { text: "original", type: "user-input" },
        kind: "send",
        messageId: "message-conflict-clone",
        threadKey: "thread-conflict-clone",
      });

      let conflict: ThreadInputDuplicateConflictError | null = null;
      try {
        await store.inputs.admit({
          admittedAtMs: 2,
          input: { text: "conflicting", type: "user-input" },
          kind: "send",
          messageId: "message-conflict-clone",
          threadKey: "thread-conflict-clone",
        });
      } catch (error) {
        if (error instanceof ThreadInputDuplicateConflictError) {
          conflict = error;
        } else {
          throw error;
        }
      }

      expect(conflict).not.toBeNull();
      if (!conflict) {
        throw new Error("Expected duplicate conflict error.");
      }
      (conflict.existing.input as { text: string }).text = "corrupted";
      (conflict.incoming.input as { text: string }).text = "mutated incoming";

      await expect(
        store.inputs.claimNext("thread-conflict-clone", "turn-idle")
      ).resolves.toMatchObject({
        input: { text: "original", type: "user-input" },
        messageId: "message-conflict-clone",
      });
    });

    it("claims thread inputs by boundary and eligible admitted order", async () => {
      const store = createStore();

      await store.inputs.admit({
        admittedAtMs: 1,
        input: { text: "send", type: "user-input" },
        kind: "send",
        messageId: "send-1",
        threadKey: "thread-1",
      });
      await store.inputs.admit({
        admittedAtMs: 2,
        input: { text: "start", type: "user-input" },
        kind: "steer",
        messageId: "steer-start",
        placement: "step-start",
        threadKey: "thread-1",
      });
      await store.inputs.admit({
        admittedAtMs: 3,
        input: { text: "default end", type: "user-input" },
        kind: "steer",
        messageId: "steer-default",
        threadKey: "thread-1",
      });

      await expect(
        store.inputs.claimNext("thread-1", "turn-start")
      ).resolves.toBeNull();
      await expect(
        store.inputs.claimNext("thread-1", "step-end")
      ).resolves.toMatchObject({
        admittedSeq: 3,
        messageId: "steer-default",
        placement: "step-end",
        status: "claiming",
      });
      await expect(
        store.inputs.claimNext("thread-1", "step-start")
      ).resolves.toMatchObject({
        admittedSeq: 2,
        messageId: "steer-start",
        status: "claiming",
      });
      await expect(
        store.inputs.claimNext("thread-1", "turn-idle")
      ).resolves.toMatchObject({
        admittedSeq: 1,
        messageId: "send-1",
        status: "claiming",
      });
    });

    it("claims follow-ups only when the thread is idle", async () => {
      const store = createStore();
      await store.inputs.admit({
        admittedAtMs: 1,
        input: { text: "later", type: "user-input" },
        kind: "follow-up",
        messageId: "follow-up-1",
        threadKey: "thread-follow-up",
      });

      await expect(
        store.inputs.claimNext("thread-follow-up", "step-end")
      ).resolves.toBeNull();
      await expect(
        store.inputs.claimNext("thread-follow-up", "step-start")
      ).resolves.toBeNull();
      await expect(
        store.inputs.claimNext("thread-follow-up", "turn-start")
      ).resolves.toBeNull();
      await expect(
        store.inputs.claimNext("thread-follow-up", "turn-idle")
      ).resolves.toMatchObject({
        kind: "follow-up",
        messageId: "follow-up-1",
        status: "claiming",
      });
    });

    describeThreadInputInboxRecoveryContract({ createStore });

    it("releases and reclaims thread input claims with a fresh claim id", async () => {
      const store = createStore();
      await store.inputs.admit({
        admittedAtMs: 1,
        input: { text: "release", type: "user-input" },
        kind: "send",
        messageId: "message-release",
        threadKey: "thread-1",
      });
      const claimed = await expectClaimed(
        store.inputs.claimNext("thread-1", "turn-idle")
      );

      await expect(store.inputs.releaseClaim(claimed)).resolves.toMatchObject({
        messageId: "message-release",
        status: "pending",
      });
      const reclaimed = await expectClaimed(
        store.inputs.claimNext("thread-1", "turn-idle")
      );

      expect(reclaimed.claimId).not.toBe(claimed.claimId);
      expect(reclaimed.claimId).toEqual(expect.any(String));
      expect(reclaimed).toMatchObject({
        messageId: "message-release",
        status: "claiming",
      });
    });

    it("promotes and acks thread input claims", async () => {
      const store = createStore();
      await store.inputs.admit({
        admittedAtMs: 1,
        input: { text: "ack", type: "user-input" },
        kind: "send",
        messageId: "message-ack",
        threadKey: "thread-1",
      });
      const claimed = await expectClaimed(
        store.inputs.claimNext("thread-1", "turn-idle")
      );

      const promoted = await store.inputs.markPromoted(claimed);
      expect(promoted).toMatchObject({
        claimId: claimed.claimId,
        messageId: "message-ack",
        status: "promoted",
      });
      const acked = await store.inputs.ack(promoted ?? claimed);

      expect(acked).toMatchObject({
        messageId: "message-ack",
        status: "acked",
      });
      expect(acked).not.toHaveProperty("claimId");
      await expect(
        store.inputs.claimNext("thread-1", "turn-idle")
      ).resolves.toBeNull();
    });

    it("rolls back transaction thread input writes when the transaction fails", async () => {
      const store = createStore();

      await expect(
        store.transaction(async (tx) => {
          await tx.inputs.admit({
            admittedAtMs: 1,
            input: { text: "rolled back", type: "user-input" },
            kind: "send",
            messageId: "message-rollback",
            threadKey: "thread-1",
          });
          throw new Error("transaction failed");
        })
      ).rejects.toThrow("transaction failed");

      await expect(
        store.inputs.claimNext("thread-1", "turn-idle")
      ).resolves.toBeNull();
    });
  });
}

async function expectClaimed(
  claim: Promise<ClaimedThreadInput | null>
): Promise<ClaimedThreadInput> {
  const claimed = await claim;
  expect(claimed).not.toBeNull();
  if (!claimed) {
    throw new Error("Expected a claimed thread input.");
  }
  return claimed;
}
