import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/durable-object/cloudflare/image-codecs";
import { defineWorkerFetch } from "evlog/workers";

import type { Env } from "./env";
import { handleWorkerRpcRequest } from "./rpc/worker-rpc";
import { handleSessionEventsRequest } from "./session/session-events-server";
import { handleTelegramWebhook } from "./telegram/telegram";
import { ensureWorkerLogger, newCorrelationId } from "./worker-log";

// Edge-first: static wasm for AVIF/WebP/HEIC before any attachment staging.
installCloudflareImageCodecs();

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object classes to be exported from the worker entrypoint.
export { AgentDurableObject } from "./agent/agent-do";
export type { Env } from "./env";

const SESSION_EVENTS_PATHNAME = "/session/events";
const TUI_RPC_PATHNAME = "/trpc";

export default defineWorkerFetch<Env>(async (request, env, ctx, log) => {
  ensureWorkerLogger({
    environment: env.ENVIRONMENT,
    version: env.CF_VERSION_METADATA?.id,
  });
  const url = new URL(request.url);
  const correlationId = newCorrelationId();
  const handler = selectRequestHandler(url.pathname);

  log.set({
    correlationId,
    handler,
    method: request.method,
    path: url.pathname,
  });

  try {
    let response: Response;
    switch (handler) {
      case "session-events":
        response = await handleSessionEventsRequest(request, env);
        break;
      case "tui-rpc":
        response = await handleWorkerRpcRequest(request, env);
        break;
      case "telegram-webhook":
        response = await handleTelegramWebhook(
          request,
          env,
          ctx as ExecutionContext,
          { correlationId }
        );
        break;
      default:
        response = assertNever(handler);
    }

    log.set({ status: response.status });
    log.emit({ status: response.status });
    return response;
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    log.emit({ status: 500 });
    throw error;
  }
});

function selectRequestHandler(
  pathname: string
): "session-events" | "telegram-webhook" | "tui-rpc" {
  if (pathname === SESSION_EVENTS_PATHNAME) {
    return "session-events";
  }
  if (
    pathname === TUI_RPC_PATHNAME ||
    pathname.startsWith(`${TUI_RPC_PATHNAME}/`)
  ) {
    return "tui-rpc";
  }
  return "telegram-webhook";
}

function assertNever(value: never): never {
  throw new Error(`Unexpected worker request handler: ${String(value)}`);
}
