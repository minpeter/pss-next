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
    | { readonly requestId: ProtocolRequestId; turn?: AgentTurn }
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
        case "abort": {
          const interrupted = active !== undefined;
          thread.interrupt();
          return { interrupted };
        }
        case "steer":
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
          const started = Promise.resolve(thread.send(prompt))
            .then((turn) => {
              if (active) {
                active.turn = turn;
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
