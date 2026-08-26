import { deferred } from "../../internal/deferred";
import { waitForCompactionQueue } from "../runtime/compaction-queue-deadline";
import { threadKilledError } from "../state/thread-errors";
import type { AgentThreadContext } from "./agent-thread-context";

export function assertAgentThreadOpen(context: AgentThreadContext): void {
  if (context.terminal.state.tag !== "open") {
    throw threadKilledError();
  }
}

export async function waitForAgentThreadStartup(
  context: AgentThreadContext,
  signal: AbortSignal
): Promise<void> {
  await waitForCompactionQueue(ensureAgentThreadStarted(context), signal);
}

export function ensureAgentThreadStarted(
  context: AgentThreadContext
): Promise<void> {
  const lifecycle = context.lifecycle;
  const current = lifecycle.state;
  if (current.tag === "starting" || current.tag === "stopping") {
    return current.promise;
  }
  if (current.tag !== "created") {
    return Promise.resolve();
  }

  const start = deferred();
  lifecycle.to({ tag: "starting", promise: start.promise });
  context.state.ensureLoaded().then(
    () => {
      lifecycle.toIf("starting", { tag: "started" });
      start.resolve();
    },
    (error: unknown) => {
      // A failed load is retryable: return to `created` so the next call
      // reloads instead of replaying the first failure forever.
      lifecycle.toIf("starting", { tag: "created" });
      start.reject(error);
    }
  );
  return start.promise;
}
