import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  LeaseFencedCheckpointWriteResult,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import { createThreadToolExecutionContext } from "./execution-checkpoints";

type AuthorityConflict = Extract<
  LeaseFencedCheckpointWriteResult,
  { readonly reason: "lease-conflict" | "not-found" | "status-conflict" }
>["reason"];

const AUTHORITY_CONFLICTS = [
  ["lease-conflict", /checkpoint lease conflict/i],
  ["not-found", /checkpoint run is missing/i],
  ["status-conflict", /checkpoint status conflict.*terminal/i],
] as const satisfies readonly (readonly [AuthorityConflict, RegExp])[];

describe("thread execution checkpoint errors", () => {
  it.each(AUTHORITY_CONFLICTS)(
    "reports %s without collapsing its meaning",
    async (reason, messagePattern) => {
      // Given: a present run whose checkpoint append returns a typed conflict.
      const base = createInMemoryHost();
      const runId = `checkpoint-${reason}`;
      await base.store.turns.create({
        checkpointVersion: 0,
        kind: "user-turn",
        rootRunId: runId,
        runId,
        status: "running",
        threadKey: "thread",
      });
      const host = withCheckpointConflict(base, reason);
      const context = createThreadToolExecutionContext({
        executionHost: host,
        leaseId: null,
        runId,
        state: new ThreadState({ key: "thread", store: host.store.threads }),
      });
      if (!context.beforeTool) {
        throw new Error("Expected a before-tool checkpoint hook.");
      }

      // When: the runtime attempts its next tool checkpoint.
      const checkpoint = context.beforeTool({
        attempt: 1,
        idempotencyKey: `${runId}:tool`,
        input: {},
        policy: "idempotent",
        toolCallId: "tool-1",
        toolName: "test",
      });

      // Then: the rejection retains the conflict's stable meaning.
      await expect(checkpoint).rejects.toMatchObject({
        message: expect.stringMatching(messagePattern),
        name: "ThreadExecutionCheckpointAuthorityError",
        reason,
        runId,
      });
    }
  );
});

function withCheckpointConflict(
  base: AgentHost,
  reason: AuthorityConflict
): AgentHost {
  const capability = base.store.leaseFencedCheckpoints;
  if (!capability) {
    throw new Error("Expected checkpoint fencing support.");
  }
  const checkpoints = new Proxy(capability, {
    get(target, property) {
      if (property === "appendFenced") {
        return () => Promise.resolve({ ok: false as const, reason });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new Proxy(base.store, {
    get(target, property) {
      if (property === "leaseFencedCheckpoints") {
        return checkpoints;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...base, store };
}
