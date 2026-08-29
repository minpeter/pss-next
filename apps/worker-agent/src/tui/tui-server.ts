import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import type { WorkerAgentDeliveryResponse } from "../agent/agent-do-delivery";
import { channelKey } from "../channel";
import { durableObjectName, type Env } from "../env";
import {
  WorkerServerBadRequestError,
  WorkerServerUpstreamError,
} from "../rpc/server-errors";
import { type TuiTurnInput, TuiTurnOutputSchema } from "./tui-contract";

export async function dispatchTuiTurn(
  input: TuiTurnInput,
  env: Env
): Promise<WorkerAgentDeliveryResponse> {
  const channelId = input.channel.id.trim();
  const text = input.text.trim();
  if (!(channelId && text)) {
    throw new WorkerServerBadRequestError("text and tui channel required");
  }

  switch (input.channel.kind) {
    case "tui":
      break;
    case "telegram":
      throw new WorkerServerBadRequestError("text and tui channel required");
    default:
      return assertNever(input.channel.kind);
  }
  const payload = {
    channel: { id: channelId, kind: "tui" },
    ...(input.sessionScopeKey?.trim()
      ? { sessionScopeKey: input.sessionScopeKey.trim() }
      : {}),
    text,
  } satisfies TuiTurnInput;

  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelKey(payload.channel)),
    request: new Request("https://agent.internal/turn", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  });

  if (!response) {
    throw new WorkerServerUpstreamError("agent durable object unavailable");
  }

  const body: unknown = await response.json();
  return TuiTurnOutputSchema.parse(body);
}

function assertNever(value: never): never {
  throw new TuiServerInvariantError(
    `Unexpected channel variant: ${String(value)}`
  );
}

class TuiServerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuiServerInvariantError";
  }
}
