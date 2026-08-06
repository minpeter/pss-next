import type {
  AgentEvent,
  AgentTurn,
  ThreadHandle,
} from "@minpeter/pss-runtime";
import {
  type ProtocolRequestId,
  ProtocolRpcError,
  type ProtocolServerHandler,
} from "@minpeter/pss-runtime/protocol";

interface RpcThread
  extends Pick<ThreadHandle, "interrupt" | "send" | "steer"> {}

export interface CodingAgentRpcSession {
  readonly handler: ProtocolServerHandler;
  readonly settled: Promise<void>;
}

export function createCodingAgentRpcSession(
  thread: RpcThread,
  options: { readonly threadKey?: string } = {}
): CodingAgentRpcSession {
  let active:
    | {
        abortRequested?: boolean;
        readonly requestId: ProtocolRequestId;
        turn?: AgentTurn;
      }
    | undefined;
  let background = Promise.resolve();
  const handler: ProtocolServerHandler = {
    handle(method, params, context) {
      switch (method) {
        case "state":
          return {
            activeRequestId: active?.requestId ?? null,
            status: active ? "running" : "idle",
            ...(options.threadKey === undefined
              ? {}
              : { threadKey: options.threadKey }),
          };
        case "abort":
          return abortActive(active, thread);
        case "steer":
          if (!active) {
            throw new ProtocolRpcError({
              code: -32_003,
              message: "No prompt is currently running",
            });
          }
          if (!active.turn) {
            throw new ProtocolRpcError({
              code: -32_004,
              message: "The active prompt is still starting",
            });
          }
          return steer(thread, params);
        case "prompt": {
          if (active) {
            throw new ProtocolRpcError({
              code: -32_002,
              message: "A prompt is already running",
            });
          }
          const prompt = requiredPrompt(params);
          active = { requestId: context.requestId };
          const started = Promise.resolve()
            .then(() => thread.send(prompt))
            .then((turn) => {
              if (active) {
                active.turn = turn;
                if (active.abortRequested) {
                  thread.interrupt();
                }
              }
              return consume(turn, (event) => context.emit(event));
            })
            .catch((error: unknown) =>
              context.emit({
                message: errorMessage(error),
                type: "protocol-error",
              })
            )
            .finally(() => {
              active = undefined;
            });
          background = Promise.allSettled([background, started]).then(
            () => undefined
          );
          context.defer?.(started);
          return { accepted: true };
        }
        default:
          throw new Error(
            `Unsupported protocol method: ${method satisfies never}`
          );
      }
    },
  };
  return {
    handler,
    get settled() {
      return background;
    },
  };
}

function abortActive(
  active: { abortRequested?: boolean } | undefined,
  thread: RpcThread
): { interrupted: boolean } {
  const interrupted = active !== undefined;
  if (active) {
    active.abortRequested = true;
  }
  thread.interrupt();
  return { interrupted };
}

async function steer(
  thread: RpcThread,
  params: Record<string, unknown>
): Promise<{ accepted: true }> {
  await thread.steer(requiredPrompt(params));
  return { accepted: true };
}

async function consume(
  turn: AgentTurn,
  emit: (event: AgentEvent) => void
): Promise<void> {
  for await (const event of turn.events()) {
    emit(event);
  }
}

function requiredPrompt(params: Record<string, unknown>): string {
  if (typeof params.prompt !== "string" || params.prompt.trim() === "") {
    throw new ProtocolRpcError({
      code: -32_602,
      message: "params.prompt must be a non-empty string",
    });
  }
  return params.prompt;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
