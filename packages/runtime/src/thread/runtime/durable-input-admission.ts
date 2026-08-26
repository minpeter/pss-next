import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type {
  AdmitReceipt,
  AgentHost,
  ThreadInputKind,
  ThreadInputPlacement,
  TurnRecord,
} from "../../execution/host/types";
import { ThreadInputInboxUnavailableError } from "../../execution/host/unsupported-thread-input-inbox";
import type { UserInput } from "../input/input";
import { precreateThreadExecutionRun } from "./execution";
import {
  type ThreadInputAdmissionOperation,
  withThreadInputAdmission,
} from "./thread-input-admission-coordinator";

export type DurableInputAdmission =
  | {
      readonly executionRun?: TurnRecord;
      readonly kind: "admitted";
      readonly receipt: AdmitReceipt;
    }
  | { readonly kind: "unavailable" };

export async function admitDurableThreadInput({
  executionHost,
  input,
  kind,
  messageId = crypto.randomUUID(),
  placement,
  precreateExecutionRun = false,
  reservation,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly input: UserInput;
  readonly kind: ThreadInputKind;
  readonly messageId?: string;
  readonly placement?: ThreadInputPlacement;
  readonly precreateExecutionRun?: boolean;
  readonly reservation?: ThreadInputAdmissionOperation;
  readonly threadKey: string;
}): Promise<DurableInputAdmission> {
  if (!executionHost) {
    return { kind: "unavailable" };
  }

  const operation = async (): Promise<DurableInputAdmission> => {
    try {
      if (precreateExecutionRun) {
        return await executionHost.store.transaction(async (transaction) => {
          const receipt = await transaction.inputs.admit({
            input,
            kind,
            messageId,
            placement,
            threadKey,
          });
          if (receipt.duplicate) {
            return { kind: "admitted", receipt };
          }
          const executionRun = await precreateThreadExecutionRun({
            kind: "user-turn",
            runId: createThreadExecutionRunId({ threadKey, turnId: messageId }),
            threadKey,
            turnStore: transaction.turns,
          });
          return { executionRun, kind: "admitted", receipt };
        });
      }

      const receipt = await executionHost.store.inputs.admit({
        input,
        kind,
        messageId,
        placement,
        threadKey,
      });
      return { kind: "admitted", receipt };
    } catch (error) {
      if (error instanceof ThreadInputInboxUnavailableError) {
        return { kind: "unavailable" };
      }
      throw error;
    }
  };
  return await (
    reservation ??
    ((reservedOperation) =>
      withThreadInputAdmission(executionHost, threadKey, reservedOperation))
  )(operation);
}
