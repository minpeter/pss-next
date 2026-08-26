import { strictCompactionDeadline } from "../runtime/auto-compaction-deadline";
import { compactThreadManually } from "../runtime/auto-compaction-runner";
import type {
  CompactionSummaryOptions,
  ManualThreadCompactionResult,
} from "../runtime/auto-compaction-types";
import {
  compactionQueueDeadline,
  waitForCompactionQueue,
} from "../runtime/compaction-queue-deadline";
import { reserveThreadInputAdmission } from "../runtime/thread-input-admission-coordinator";
import { createTurnModelTransforms } from "../runtime/turn-model-transforms";
import type { ThreadCompactionInput } from "../state/thread-state";
import { enqueueAgentThreadInputAdmission } from "./agent-thread-admission";
import type { AgentThreadContext } from "./agent-thread-context";
import {
  assertAgentThreadOpen,
  waitForAgentThreadStartup,
} from "./agent-thread-lifecycle";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";
import { withAbortableThreadDrainOwnership } from "./thread-drain-coordinator";

type AgentThreadCompactionResult = boolean | ManualThreadCompactionResult;

export async function compactAgentThread(
  context: AgentThreadContext,
  input?: CompactionSummaryOptions | ThreadCompactionInput
): Promise<AgentThreadCompactionResult> {
  assertAgentThreadOpen(context);

  if (context.turn.state.tag !== "none") {
    throw new Error("Cannot compact while a turn is active.");
  }

  const explicitInput =
    input !== undefined && "summary" in input ? input : undefined;
  const summaryOptions =
    input !== undefined && !("summary" in input) ? input : undefined;
  const resultFor =
    explicitInput === undefined
      ? (
          compacted: boolean,
          historyEmpty: boolean
        ): ManualThreadCompactionResult => {
          if (historyEmpty) {
            return { status: "empty" };
          }
          return { status: compacted ? "compacted" : "skipped" };
        }
      : (compacted: boolean): boolean => compacted;
  const executionHost = context.execution.executionHost;
  const signal = summaryOptions?.signal ?? new AbortController().signal;
  const deadline = strictCompactionDeadline(
    context.execution.compaction?.deadlineMs
  );
  const queueDeadline = compactionQueueDeadline({
    deadline,
    reason: "manual",
    signal,
  });
  const reservation = executionHost
    ? reserveThreadInputAdmission(
        executionHost,
        context.threadKey,
        queueDeadline.signal
      )
    : undefined;
  let reservationEntered = false;
  const queued = enqueueAgentThreadInputAdmission(
    context,
    async () => {
      const compact = async (): Promise<AgentThreadCompactionResult> => {
        await waitForAgentThreadStartup(context, queueDeadline.signal);
        const ownership: Promise<AgentThreadCompactionResult> =
          withAbortableThreadDrainOwnership({
            executionHost,
            operation: async ({ refreshRequired }) => {
              await recoverThreadDurableInputClaims({
                allowOwned: executionHost !== undefined,
                executionHost,
                signal: queueDeadline.signal,
                state: context.durableInputRecovery,
                threadKey: context.threadKey,
              });
              if (refreshRequired) {
                await context.state.refresh();
              }
              queueDeadline.signal.throwIfAborted();
              assertAgentThreadOpen(context);
              if (context.turn.state.tag !== "none") {
                throw new Error("Cannot compact while a turn is active.");
              }
              const historyEmpty = context.state.modelSnapshot().length === 0;
              const transforms = createTurnModelTransforms({
                hookRuntime: context.execution.hookRuntime,
                state: context.state,
                threadKey: context.threadKey,
              });
              queueDeadline.dispose();
              const compacted = await compactThreadManually({
                compact: (compactionInput, capability) =>
                  context.events.compact(
                    context.state,
                    compactionInput,
                    capability
                  ),
                deadline,
                explicitInput,
                latestContextTransform: transforms.latestContextTransform,
                model: context.model,
                signal,
                state: context.state,
                summaryOptions,
                threadKey: context.threadKey,
                transformModelContext: transforms.transformModelContext,
              });
              return resultFor(compacted, historyEmpty);
            },
            owner: context,
            signal: queueDeadline.signal,
            threadKey: context.threadKey,
          });
        return await waitForCompactionQueue(ownership, queueDeadline.signal);
      };
      if (!reservation) {
        return await compact();
      }
      reservationEntered = true;
      return await reservation(compact);
    },
    queueDeadline.signal
  );
  try {
    return await queued;
  } finally {
    if (!reservationEntered) {
      reservation?.abandon();
    }
    queueDeadline.dispose();
  }
}
