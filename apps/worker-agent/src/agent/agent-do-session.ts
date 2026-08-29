import type { Agent, ThreadHandle } from "@minpeter/pss-runtime";
import type { CloudflarePlatformContext } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import type { ChannelRuntimeBinding } from "../channel";
import type { Env } from "../env";
import type { SessionTranscriptReader } from "../session/session-transcript";
import {
  createSessionIndexStore,
  type SessionIndexStore,
} from "../session-index/session-index";
import type { SessionIndexClient } from "../session-index/session-index-client";
import { createSqlSessionIndexRepository } from "../session-index/session-index-sql";
import type { WorkerAgentSendMessageToolOptions } from "../tools";
import { createSessionAgent } from "./agent-do-session-agent";
import { AgentDoSessionHandlers } from "./agent-do-session-handlers";
import { createTurnSession, type TurnSession } from "./agent-do-turn-session";
import {
  type AgentDoState,
  AgentDurableObjectInvariantError,
  SESSION_BINDING_STORAGE_KEY,
  type SessionBindingRecord,
} from "./agent-do-types";

interface AgentDoSessionOptions {
  readonly createSendMessage: () => WorkerAgentSendMessageToolOptions;
  readonly env: Env;
  readonly platform: CloudflarePlatformContext<Agent>;
  readonly sessionIndexClient: SessionIndexClient;
  readonly sessionTranscriptClient: SessionTranscriptReader;
  readonly state: AgentDoState;
  readonly storage: DurableObjectStorage;
}

export class AgentDoSession {
  readonly #createSendMessage: () => WorkerAgentSendMessageToolOptions;
  readonly #env: Env;
  readonly #platform: CloudflarePlatformContext<Agent>;
  readonly #sessionIndexClient: SessionIndexClient;
  readonly #sessionTranscriptClient: SessionTranscriptReader;
  readonly #state: AgentDoState;
  readonly #storage: DurableObjectStorage;
  readonly #handlers: AgentDoSessionHandlers;
  #sessionIndexStore: SessionIndexStore | undefined;
  #turnSession: TurnSession | undefined;
  #turnSessionPromise: Promise<TurnSession> | undefined;
  #runtimeThread: ThreadHandle | undefined;

  constructor(options: AgentDoSessionOptions) {
    this.#createSendMessage = options.createSendMessage;
    this.#env = options.env;
    this.#platform = options.platform;
    this.#sessionIndexClient = options.sessionIndexClient;
    this.#sessionTranscriptClient = options.sessionTranscriptClient;
    this.#state = options.state;
    this.#storage = options.storage;
    this.#handlers = new AgentDoSessionHandlers({
      platform: options.platform,
      session: this,
      state: options.state,
      storage: options.storage,
    });
  }

  async restoreBinding(): Promise<void> {
    const stored = await this.#storage.get<SessionBindingRecord>(
      SESSION_BINDING_STORAGE_KEY
    );
    if (!stored) {
      return;
    }
    this.#state.channel = stored.channel;
    this.#state.sessionScopeKey = stored.sessionScopeKey;
  }

  runtimeThread(): ThreadHandle | undefined {
    return this.#runtimeThread;
  }

  sessionIndex(): SessionIndexStore {
    if (!this.#sessionIndexStore) {
      const sql = this.#storage.sql;
      if (!sql) {
        throw new AgentDurableObjectInvariantError(
          "Session index requires a SQLite-backed Durable Object."
        );
      }
      this.#sessionIndexStore = createSessionIndexStore(
        createSqlSessionIndexRepository(sql)
      );
    }
    return this.#sessionIndexStore;
  }

  async ensureTurnSession(
    binding: ChannelRuntimeBinding
  ): Promise<TurnSession> {
    if (this.#turnSession) {
      return this.#turnSession;
    }
    if (this.#turnSessionPromise) {
      return await this.#turnSessionPromise;
    }

    const initializing = (async () => {
      const agent = await createSessionAgent({
        binding,
        createSendMessage: this.#createSendMessage,
        env: this.#env,
        platform: this.#platform,
        sessionIndexClient: this.#sessionIndexClient,
        sessionTranscriptClient: this.#sessionTranscriptClient,
        state: this.#state,
      });
      try {
        const thread = agent.thread(binding.thread);
        const session = createTurnSession(thread);
        this.#runtimeThread = thread;
        this.#turnSession = session;
        return session;
      } catch (error) {
        await agent.dispose().catch(() => undefined);
        throw error;
      }
    })();
    this.#turnSessionPromise = initializing;
    try {
      return await initializing;
    } catch (error) {
      if (this.#turnSessionPromise === initializing) {
        this.#turnSessionPromise = undefined;
      }
      throw error;
    }
  }

  async handleEventStream(request: Request): Promise<Response> {
    return await this.#handlers.eventStream(request);
  }

  async handleSubmit(body: unknown): Promise<Response> {
    return await this.#handlers.submit(body);
  }

  async handleReplay(body: unknown): Promise<Response> {
    return await this.#handlers.replay(body);
  }

  async handleTranscript(body: unknown): Promise<Response> {
    return await this.#handlers.transcript(body);
  }
}
