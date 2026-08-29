import type { Agent } from "@minpeter/pss-runtime";
import type { CloudflarePlatformContext } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import {
  type ChannelRuntimeBinding,
  durableObjectChannelBinding,
} from "../channel";
import type { Env } from "../env";
import type { SessionTranscriptReader } from "../session/session-transcript";
import type { SessionIndexClient } from "../session-index/session-index-client";
import type { WorkerAgentSendMessageToolOptions } from "../tools";
import { createConfiguredAgent } from "./agent";
import type { AgentDoState } from "./agent-do-types";

export async function createSessionAgent({
  binding,
  createSendMessage,
  env,
  platform,
  sessionIndexClient,
  sessionTranscriptClient,
  state,
}: {
  readonly binding: ChannelRuntimeBinding;
  readonly createSendMessage: () => WorkerAgentSendMessageToolOptions;
  readonly env: Env;
  readonly platform: CloudflarePlatformContext<Agent>;
  readonly sessionIndexClient: SessionIndexClient;
  readonly sessionTranscriptClient: SessionTranscriptReader;
  readonly state: AgentDoState;
}): Promise<Agent> {
  return await createConfiguredAgent(env, platform.host(), {
    sendMessage: createSendMessage(),
    sessionTools: {
      currentConversationKey: () => {
        const channel = state.channel;
        if (!channel) {
          return binding.channelKey;
        }
        return durableObjectChannelBinding(channel).channelKey;
      },
      currentSessionScopeKey: () => state.sessionScopeKey,
      reader: sessionIndexClient,
      transcriptReader: sessionTranscriptClient,
    },
    observability: {
      log: (entry) => {
        state.observability?.record(entry);
      },
    },
  });
}
