import type { Agent } from "@minpeter/pss-runtime";
import type { CloudflarePlatformContext } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import {
  CHANNEL_DURABLE_OBJECT_THREAD_KEY,
  type ChannelAddress,
  durableObjectChannelBinding,
} from "../channel";
import {
  parseSessionChannel,
  parseThreadEventCursor,
  ReplayEventsRequestSchema,
  SubmitTurnRequestSchema,
  type ThreadEventCursor,
} from "../session/session-contract";
import { createSessionEventStreamResponse } from "../session/session-events";
import {
  replayDurableThreadEvents,
  submitDurableSessionTurn,
} from "../session/session-runtime";
import { createThreadStoreSessionTranscriptReader } from "../session/session-transcript";
import { SessionTranscriptReadRequestSchema } from "../session/session-transcript-client";
import { WORKER_AGENT_NAMESPACE } from "./agent";
import type { AgentDoSession } from "./agent-do-session";
import {
  type AgentDoState,
  requireRuntimeThread,
  SESSION_BINDING_STORAGE_KEY,
  type SessionBindingRecord,
} from "./agent-do-types";

export class AgentDoSessionHandlers {
  readonly #platform: CloudflarePlatformContext<Agent>;
  readonly #session: AgentDoSession;
  readonly #state: AgentDoState;
  readonly #storage: DurableObjectStorage;

  constructor({
    platform,
    session,
    state,
    storage,
  }: {
    readonly platform: CloudflarePlatformContext<Agent>;
    readonly session: AgentDoSession;
    readonly state: AgentDoState;
    readonly storage: DurableObjectStorage;
  }) {
    this.#platform = platform;
    this.#session = session;
    this.#state = state;
    this.#storage = storage;
  }

  async eventStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const serializedChannel = url.searchParams.get("channel");
    if (!serializedChannel) {
      return new Response("channel required", { status: 400 });
    }

    let channel: ChannelAddress;
    let after: ThreadEventCursor | undefined;
    try {
      channel = parseSessionChannel(serializedChannel);
      const serializedAfter = url.searchParams.get("after");
      after =
        serializedAfter === null
          ? undefined
          : parseThreadEventCursor(serializedAfter);
    } catch {
      return new Response("invalid session event stream", { status: 400 });
    }
    this.#state.channel = channel;
    this.#state.sessionScopeKey =
      url.searchParams.get("sessionScopeKey")?.trim() || undefined;
    await this.#session.ensureTurnSession(durableObjectChannelBinding(channel));
    const thread = requireRuntimeThread(this.#session.runtimeThread());

    return createSessionEventStreamResponse({
      ...(after ? { after } : {}),
      live: this.#state.sessionEventLive,
      replay: (cursor) =>
        replayDurableThreadEvents(thread, {
          ...(cursor ? { after: cursor } : {}),
          limit: 100,
        }),
    });
  }

  async submit(body: unknown): Promise<Response> {
    const parsed = SubmitTurnRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid session turn", { status: 400 });
    }

    const channelId = parsed.data.channel.id.trim();
    const text = parsed.data.text.trim();
    if (!(channelId && text)) {
      return new Response("invalid session turn", { status: 400 });
    }
    const channel = { id: channelId, kind: parsed.data.channel.kind };
    const sessionScopeKey = parsed.data.sessionScopeKey?.trim();
    this.#state.channel = channel;
    this.#state.sessionScopeKey = sessionScopeKey || undefined;
    await this.#storage.put(SESSION_BINDING_STORAGE_KEY, {
      channel,
      ...(sessionScopeKey ? { sessionScopeKey } : {}),
    } satisfies SessionBindingRecord);

    const admitted = await submitDurableSessionTurn({
      host: this.#platform.host(),
      idempotencyKey: parsed.data.idempotencyKey?.trim() || crypto.randomUUID(),
      input: text,
      namespace: WORKER_AGENT_NAMESPACE,
      threadKey: CHANNEL_DURABLE_OBJECT_THREAD_KEY,
    });
    return Response.json(admitted);
  }

  async replay(body: unknown): Promise<Response> {
    const parsed = ReplayEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid session replay", { status: 400 });
    }

    const channelId = parsed.data.channel.id.trim();
    if (!channelId) {
      return new Response("invalid session replay", { status: 400 });
    }
    const channel = { id: channelId, kind: parsed.data.channel.kind };
    this.#state.channel = channel;
    this.#state.sessionScopeKey =
      parsed.data.sessionScopeKey?.trim() || undefined;
    await this.#session.ensureTurnSession(durableObjectChannelBinding(channel));
    const thread = requireRuntimeThread(this.#session.runtimeThread());

    return Response.json(
      await replayDurableThreadEvents(thread, {
        ...(parsed.data.after ? { after: parsed.data.after } : {}),
        ...(parsed.data.limit === undefined
          ? {}
          : { limit: parsed.data.limit }),
      })
    );
  }

  async transcript(body: unknown): Promise<Response> {
    if (body === undefined) {
      return new Response("invalid json", { status: 400 });
    }

    const parsed = SessionTranscriptReadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid transcript read", { status: 400 });
    }

    const transcript = await createThreadStoreSessionTranscriptReader({
      resolveThreadKey: () => CHANNEL_DURABLE_OBJECT_THREAD_KEY,
      store: this.#platform.host().store.threads,
    }).read(parsed.data.conversationKey, {
      ...(parsed.data.before === undefined
        ? {}
        : { before: parsed.data.before }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });

    return Response.json(
      transcript
        ? { ...transcript, found: true }
        : { conversationKey: parsed.data.conversationKey, found: false }
    );
  }
}
