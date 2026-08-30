import type {
  AgentHost,
  ClaimedThreadInput,
  HostStoreTransaction,
} from "../../execution/host/types";
import type { ThreadState } from "../state/thread-state";
import type { ThreadExecutionRun } from "./execution";
import {
  appendDurableThreadEvents,
  type DurableThreadEventBuffer,
  restoreDurableThreadEvents,
  takeDurableThreadEvents,
  transactionalThreadEvents,
} from "./thread-event-log";

export async function commitAndAckDurableThreadInput({
  buffer,
  executionHost,
  executionRun,
  record,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost: AgentHost | undefined;
  readonly executionRun?: ThreadExecutionRun;
  readonly record: ClaimedThreadInput;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = takeDurableThreadEvents(buffer);
  if (!executionHost) {
    try {
      await state.commit();
    } catch (error) {
      restoreDurableThreadEvents(buffer, pendingEvents);
      throw error;
    }
    return;
  }

  const eventLogEnabled = executionHost.store.threadEvents !== undefined;
  try {
    await state.commitWith(async (commit) => {
      const persist = async (tx: HostStoreTransaction) => {
        const result = await tx.threads.commit(commit.key, commit.next, {
          expectedVersion: commit.expectedVersion,
        });
        if (!result.ok) {
          return result;
        }

        const promoted = await tx.inputs.markPromoted(record);
        if (!promoted) {
          throw new DurableThreadInputClaimError("promote", record);
        }

        const acked = await tx.inputs.ack(promoted);
        if (!acked) {
          throw new DurableThreadInputClaimError("ack", record);
        }

        if (eventLogEnabled && pendingEvents.length > 0) {
          await appendDurableThreadEvents(
            transactionalThreadEvents(tx),
            threadKey,
            pendingEvents
          );
        }

        return result;
      };
      if (executionRun) {
        return await executionRun.commitOwned(persist);
      }
      return await executionHost.store.transaction(persist);
    });
  } catch (error) {
    restoreDurableThreadEvents(buffer, pendingEvents);
    throw error;
  }
}

export async function ackDurableThreadInput({
  executionHost,
  record,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly record: ClaimedThreadInput;
}): Promise<void> {
  if (!executionHost) {
    return;
  }

  await executionHost.store.transaction(async (tx) => {
    const promoted = await tx.inputs.markPromoted(record);
    if (!promoted) {
      throw new DurableThreadInputClaimError("promote", record);
    }

    const acked = await tx.inputs.ack(promoted);
    if (!acked) {
      throw new DurableThreadInputClaimError("ack", record);
    }
  });
}

export class DurableThreadInputClaimError extends Error {
  constructor(operation: "ack" | "promote", record: ClaimedThreadInput) {
    super(
      `Unable to ${operation} durable thread input ${record.messageId} for ${record.threadKey}.`
    );
    this.name = "DurableThreadInputClaimError";
  }
}
