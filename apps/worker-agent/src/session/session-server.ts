import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import { channelKey } from "../channel";
import { durableObjectName, type Env } from "../env";
import {
  WorkerServerBadRequestError,
  WorkerServerUpstreamError,
} from "../rpc/server-errors";
import {
  type ReplayEventsRequest,
  ReplayEventsResponseSchema,
  type SubmitTurnRequest,
  SubmitTurnResponseSchema,
} from "./session-contract";

const SESSION_SUBMIT_PATH = "/session/turn";
const SESSION_REPLAY_PATH = "/session/events/replay";

export async function dispatchSessionSubmitTurn(
  input: SubmitTurnRequest,
  env: Env
) {
  const payload = normalizeSubmitTurnRequest(input);
  return await requestSessionDurableObject({
    env,
    path: SESSION_SUBMIT_PATH,
    payload,
    parse: (body) => SubmitTurnResponseSchema.parse(body),
  });
}

export async function dispatchSessionEventReplay(
  input: ReplayEventsRequest,
  env: Env
) {
  const payload = normalizeReplayEventsRequest(input);
  return await requestSessionDurableObject({
    env,
    path: SESSION_REPLAY_PATH,
    payload,
    parse: (body) => ReplayEventsResponseSchema.parse(body),
  });
}

function normalizeSubmitTurnRequest(
  input: SubmitTurnRequest
): SubmitTurnRequest {
  const channel = normalizeChannel(input.channel);
  const text = input.text.trim();
  if (!text) {
    throw new WorkerServerBadRequestError("text and channel required");
  }
  const idempotencyKey = input.idempotencyKey?.trim();
  const sessionScopeKey = input.sessionScopeKey?.trim();
  return {
    channel,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
    text,
  };
}

function normalizeReplayEventsRequest(
  input: ReplayEventsRequest
): ReplayEventsRequest {
  const sessionScopeKey = input.sessionScopeKey?.trim();
  return {
    ...(input.after ? { after: input.after } : {}),
    channel: normalizeChannel(input.channel),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
  };
}

function normalizeChannel(channel: SubmitTurnRequest["channel"]) {
  const id = channel.id.trim();
  if (!id) {
    throw new WorkerServerBadRequestError("text and channel required");
  }
  return { id, kind: channel.kind };
}

async function requestSessionDurableObject<T>({
  env,
  parse,
  path,
  payload,
}: {
  readonly env: Env;
  readonly parse: (body: unknown) => T;
  readonly path: string;
  readonly payload: ReplayEventsRequest | SubmitTurnRequest;
}): Promise<T> {
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelKey(payload.channel)),
    request: new Request(`https://agent.internal${path}`, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  });
  if (!response) {
    throw new WorkerServerUpstreamError("agent durable object unavailable");
  }
  if (!response.ok) {
    throw new WorkerServerUpstreamError(
      `agent durable object session request failed: ${response.status}`
    );
  }
  return parse(await response.json());
}
