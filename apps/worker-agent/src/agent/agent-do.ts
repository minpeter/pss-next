import type { Agent } from "@minpeter/pss-runtime";
import type {
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflarePlatformContext,
} from "@minpeter/pss-runtime/platform/durable-object/cloudflare";
import { createCloudflarePlatformContext } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";
import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/durable-object/cloudflare/image-codecs";
import { Agent as CloudflareAgent } from "agents";
import type { ChannelAddress } from "../channel";
import type { Env } from "../env";
import {
  createRequestSendMessageToolSetup,
  createSendMessageToolOptions,
  type SendMessageToolSetup,
} from "../message-sinks";
import {
  createSessionTranscriptClient,
  isSessionTranscriptPath,
} from "../session/session-transcript-client";
import {
  createSessionIndexClient,
  isSessionIndexPath,
} from "../session-index/session-index-client";
import { handleSessionIndexRequest } from "../session-index/session-index-routes";
import type { WorkerAgentSendMessageToolOptions } from "../tools";
import { ensureWorkerLogger } from "../worker-log";
import { createConfiguredAgent } from "./agent";
import { AgentDoSession } from "./agent-do-session";
import { AgentDoTurn } from "./agent-do-turn-delivery";
import {
  AgentDoState,
  SESSION_REPLAY_PATH,
  SESSION_STREAM_PATH,
  SESSION_SUBMIT_PATH,
} from "./agent-do-types";

installCloudflareImageCodecs();

export class AgentDurableObject extends CloudflareAgent<Env> {
  readonly #platform: CloudflarePlatformContext<Agent>;
  readonly #session: AgentDoSession;
  readonly #state = new AgentDoState();
  readonly #turn: AgentDoTurn;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureWorkerLogger({
      environment: env.ENVIRONMENT,
      version: env.CF_VERSION_METADATA?.id,
    });
    const sessionIndexClient = createSessionIndexClient(env);
    const sessionTranscriptClient = createSessionTranscriptClient(env);
    this.#platform = createCloudflarePlatformContext({
      cloudflareAgent: this,
      createAgent: ({ env: agentEnv, host }) =>
        createConfiguredAgent(agentEnv, host, {
          sendMessage: createSendMessageToolOptions(agentEnv, () => undefined),
        }),
      drain: {
        onEvent: () => this.#state.sessionEventLive.publish(),
      },
      durableObjectContext: this.ctx,
      env,
    });
    this.#session = new AgentDoSession({
      createSendMessage: () =>
        createLongLivedSendMessageOptions(env, this.#state),
      env,
      platform: this.#platform,
      sessionIndexClient,
      sessionTranscriptClient,
      state: this.#state,
      storage: ctx.storage,
    });
    this.#turn = new AgentDoTurn({
      createSendMessage: (channel) =>
        createTurnSendMessageSetup(env, this.#state, channel),
      env,
      session: this.#session,
      sessionIndexClient,
      state: this.#state,
    });
  }

  async resumePssRuntimeFiber(payload: unknown): Promise<void> {
    await this.#session.restoreBinding();
    try {
      await this.#platform.resumeScheduledFiber(payload);
    } finally {
      this.#state.sessionEventLive.publish();
    }
  }

  override async onFiberRecovered(
    ctx: CloudflareAgentsFiberRecoveryContext
  ): Promise<undefined | CloudflareAgentsFiberRecoveryResult> {
    try {
      const result = await this.#platform.recoverFiber(ctx);
      if (result === false) {
        return;
      }
      return result;
    } finally {
      this.#state.sessionEventLive.publish();
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === SESSION_STREAM_PATH) {
      if (request.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      return await this.#session.handleEventStream(request);
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === SESSION_SUBMIT_PATH) {
      return await this.#session.handleSubmit(await readRequestJson(request));
    }
    if (pathname === SESSION_REPLAY_PATH) {
      return await this.#session.handleReplay(await readRequestJson(request));
    }
    if (isSessionIndexPath(pathname)) {
      return await handleSessionIndexRequest({
        pathname,
        request,
        store: this.#session.sessionIndex(),
      });
    }
    if (isSessionTranscriptPath(pathname)) {
      return await this.#session.handleTranscript(
        await readRequestJson(request)
      );
    }

    return await this.#turn.handle(request);
  }
}

function createLongLivedSendMessageOptions(
  env: Env,
  state: AgentDoState
): WorkerAgentSendMessageToolOptions {
  return {
    channel: () => state.channel,
    sink: {
      send: async (channel, text) => {
        const setup = createRequestSendMessageToolSetup(env, channel);
        const sent = await setup.options.sink.send(channel, text);
        if (channel.kind === "tui") {
          state.tuiMessageCapture.push({
            channel: sent.channel,
            messageId: sent.messageId,
            text,
          });
        }
        return sent;
      },
    },
  };
}

function createTurnSendMessageSetup(
  env: Env,
  state: AgentDoState,
  channel: ChannelAddress
): SendMessageToolSetup {
  if (channel.kind === "tui") {
    return {
      messages: () => state.tuiMessageCapture,
      options: createLongLivedSendMessageOptions(env, state),
    };
  }
  return createRequestSendMessageToolSetup(env, channel);
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return;
  }
}
