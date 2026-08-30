import { expect } from "vitest";
import type { AgentHost, TurnRecord } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import type { AgentTurn } from "../../thread/protocol/turn";
import { agentNamespace } from "../identity/namespace";

interface ResumableAgent {
  resume(runId: string): Promise<AgentTurn | null>;
}

export function expectResumeSurface(
  agent: unknown
): asserts agent is ResumableAgent {
  expect(
    getProperty(agent, "resume"),
    "agent resume path is not available"
  ).toBeTypeOf("function");
}

export function createThreadLoadFailingHost(): AgentHost {
  const base = createInMemoryHost();
  return {
    ...base,
    store: {
      ...base.store,
      threads: {
        commit: base.store.threads.commit.bind(base.store.threads),
        delete: base.store.threads.delete.bind(base.store.threads),
        load: () => Promise.reject(new Error("thread load failed")),
      },
      transaction: (callback) => base.store.transaction(callback),
    },
  };
}

export function notificationRunRecord({
  idempotencyKey,
  ownerNamespace = agentNamespace("notify-owner"),
  runId,
}: {
  readonly idempotencyKey: string;
  readonly ownerNamespace?: string;
  readonly runId: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    ownerNamespace,
    rootRunId: runId,
    runId,
    threadKey: "default",
    status: "queued",
  };
}

function getProperty(value: unknown, property: "resume"): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? value[property] : undefined;
}
