import type {
  AgentHost,
  ClaimedThreadInput,
  RecoverThreadInputClaimsResult,
  ThreadInputBoundary,
} from "../../execution/host/types";
import { ThreadInputInboxUnavailableError } from "../../execution/host/unsupported-thread-input-inbox";

export type DurableInputClaim =
  | {
      readonly kind: "claimed";
      readonly record: ClaimedThreadInput | null;
    }
  | { readonly kind: "unavailable" };

export async function claimDurableThreadInput({
  boundary,
  executionHost,
  messageId,
  threadKey,
}: {
  readonly boundary: ThreadInputBoundary;
  readonly executionHost: AgentHost | undefined;
  readonly messageId?: string;
  readonly threadKey: string;
}): Promise<DurableInputClaim> {
  if (!executionHost) {
    return { kind: "unavailable" };
  }

  try {
    const record = await executionHost.store.inputs.claimNext(
      threadKey,
      boundary,
      messageId ? { messageId } : undefined
    );
    return { kind: "claimed", record };
  } catch (error) {
    if (error instanceof ThreadInputInboxUnavailableError) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

export async function recoverDurableThreadInputs({
  executionHost,
  signal,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly signal?: AbortSignal;
  readonly threadKey: string;
}): Promise<RecoverThreadInputClaimsResult> {
  signal?.throwIfAborted();
  if (!executionHost) {
    return emptyRecoveredThreadInputClaims();
  }

  try {
    return await executionHost.store.inputs.recoverClaims(
      threadKey,
      signal ? { signal } : undefined
    );
  } catch (error) {
    if (error instanceof ThreadInputInboxUnavailableError) {
      return emptyRecoveredThreadInputClaims();
    }
    throw error;
  }
}

export async function releaseDurableThreadInputClaim({
  executionHost,
  record,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly record: ClaimedThreadInput;
}): Promise<void> {
  if (!executionHost) {
    return;
  }

  await executionHost.store.inputs.releaseClaim(record);
}

function emptyRecoveredThreadInputClaims(): RecoverThreadInputClaimsResult {
  return { acked: [], released: [] };
}
