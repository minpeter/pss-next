import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import { type ChannelAddress, channelKey } from "../channel";
import { durableObjectName, type Env } from "../env";
import { isAuthorizedWorkerRequest } from "../rpc/worker-rpc-auth";
import {
  parseSessionChannel,
  parseThreadEventCursor,
} from "./session-contract";

const INTERNAL_SESSION_EVENTS_URL = "https://agent.internal/session/events";

export async function handleSessionEventsRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!isAuthorizedWorkerRequest(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }

  const sourceUrl = new URL(request.url);
  const serializedChannel = sourceUrl.searchParams.get("channel");
  if (!serializedChannel) {
    return new Response("channel required", { status: 400 });
  }

  let channel: ChannelAddress;
  try {
    channel = parseSessionChannel(serializedChannel);
    const after = sourceUrl.searchParams.get("after");
    if (after !== null) {
      parseThreadEventCursor(after);
    }
  } catch {
    return new Response("invalid session event stream", { status: 400 });
  }

  const internalUrl = new URL(INTERNAL_SESSION_EVENTS_URL);
  internalUrl.search = sourceUrl.search;
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelKey(channel)),
    request: new Request(internalUrl, { method: "GET" }),
  });
  if (!response) {
    return new Response("agent durable object unavailable", { status: 502 });
  }
  return response;
}
