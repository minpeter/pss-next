import { deferred } from "../../internal/deferred";
import { assertNever } from "../../internal/guards";
import type { ThreadCompactionInput } from "../state/thread-state";
import type { ThreadCompactionHandler } from "./auto-compaction-types";

type HandlerOutcome =
  | { readonly kind: "commit-failed"; readonly error: unknown }
  | { readonly kind: "commit-returned"; readonly value: boolean }
  | { readonly kind: "handler-failed"; readonly error: unknown }
  | { readonly kind: "handler-returned"; readonly value: boolean };

interface RunCompactionHandlerOptions {
  readonly commit: (input: ThreadCompactionInput) => Promise<boolean>;
  readonly handler: ThreadCompactionHandler;
  readonly input: ThreadCompactionInput;
  readonly signal: AbortSignal;
}

export async function runCompactionHandler(
  options: RunCompactionHandlerOptions
): Promise<boolean> {
  const controller = new AbortController();
  let capabilityOpen = true;
  let commitStarted = false;
  const commitOutcome = deferred<HandlerOutcome>();
  const abortHandler = (): void => {
    capabilityOpen = false;
    controller.abort(options.signal.reason);
  };
  if (options.signal.aborted) {
    abortHandler();
  } else {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const commit = (input: ThreadCompactionInput): Promise<boolean> => {
    if (!capabilityOpen) {
      return Promise.resolve(false);
    }
    capabilityOpen = false;
    commitStarted = true;
    const running = options.commit(input);
    running.then(
      (value) => commitOutcome.resolve({ kind: "commit-returned", value }),
      (error: unknown) =>
        commitOutcome.resolve({ error, kind: "commit-failed" })
    );
    return running;
  };
  const handlerOutcome = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return options.handler(options.input, {
        commit,
        signal: controller.signal,
      });
    })
    .then<HandlerOutcome, HandlerOutcome>(
      (value) => ({ kind: "handler-returned", value }),
      (error: unknown) => ({ error, kind: "handler-failed" })
    );

  try {
    const first = await Promise.race([handlerOutcome, commitOutcome.promise]);
    let outcome: HandlerOutcome;
    switch (first.kind) {
      case "handler-failed":
      case "handler-returned":
        outcome = commitStarted ? await commitOutcome.promise : first;
        break;
      case "commit-failed":
      case "commit-returned":
        outcome = first;
        break;
      default:
        return assertNever(first);
    }
    capabilityOpen = false;
    switch (outcome.kind) {
      case "commit-returned":
      case "handler-returned":
        return outcome.value;
      case "commit-failed":
      case "handler-failed":
        throw outcome.error;
      default:
        return assertNever(outcome);
    }
  } finally {
    capabilityOpen = false;
    controller.abort();
    options.signal.removeEventListener("abort", abortHandler);
  }
}
