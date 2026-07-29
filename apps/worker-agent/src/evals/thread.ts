import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type AgentEvent,
  type AgentOptions,
  type AgentTurn,
  createAgent,
} from "@minpeter/pss-runtime";
import type {
  AgentTurnLike,
  EvalThreadLike,
} from "@minpeter/pss-runtime/evals";
import { z } from "zod";

import { collectTurnDelivery, WORKER_AGENT_INSTRUCTIONS } from "../agent/agent";
import type { WorkerAgentThreadSender } from "../agent/agent-do-delivery";
import {
  type DeliverToolOnlyTurnOptions,
  deliverToolOnlyTurn,
} from "../agent/agent-do-delivery";
import {
  type ChannelAddress,
  type ChannelMessageSink,
  channelKey,
} from "../channel";
import type { WorkerAgentSessionToolOptions } from "../session/session-tools";
import { createSessionTools } from "../session/session-tools";
import { createWorkerAgentTools } from "../tools";
import { loadWorkerAgentEvalEnv } from "./eval-env";
import { createScriptedModel, type ScriptedResult } from "./scripted-model";

const DEFAULT_MODEL = "minimax/MiniMax-M3";
const REAL_ENV_FLAG = "PSS_WORKER_AGENT_EVAL_REAL";
const EvalModelEnvSchema = z.looseObject({
  AI_API_KEY: z.string().trim().min(1),
  AI_BASE_URL: z.url().trim().optional(),
  AI_MODEL: z.string().trim().min(1).optional(),
});

const EVAL_CHANNEL = {
  id: "eval",
  kind: "tui",
} satisfies ChannelAddress;

export interface WorkerEvalThreadOptions {
  readonly scriptedResults: readonly ScriptedResult[];
  readonly sessionTools?: WorkerAgentSessionToolOptions;
}

let cachedRealModel: ReturnType<ReturnType<typeof createOpenAICompatible>>;

export async function workerEvalThread(
  options: WorkerEvalThreadOptions
): Promise<EvalThreadLike> {
  const tools = createEvalTools(options);
  const agent = await createAgent({
    instructions: WORKER_AGENT_INSTRUCTIONS,
    model: evalModel(options.scriptedResults),
    tools,
  });

  return deliveryThread(agent.thread("eval"));
}

export function deliveryThread(
  thread: WorkerAgentThreadSender
): EvalThreadLike {
  return {
    send: async (input) => deliveryTurn(thread, input),
  };
}

export async function rawWorkerEvalThread(
  options: WorkerEvalThreadOptions
): Promise<EvalThreadLike> {
  const agent = await createAgent({
    instructions: WORKER_AGENT_INSTRUCTIONS,
    model: evalModel(options.scriptedResults),
    tools: createEvalTools(options),
  });

  return agent.thread("eval");
}

export function isWorkerAgentEvalRealMode(): boolean {
  return process.env[REAL_ENV_FLAG] !== "0";
}

function createEvalTools(
  options: WorkerEvalThreadOptions
): NonNullable<AgentOptions["tools"]> {
  return {
    ...createWorkerAgentTools({
      channel: () => EVAL_CHANNEL,
      sink: createEvalMessageSink(),
    }),
    ...(options.sessionTools ? createSessionTools(options.sessionTools) : {}),
  };
}

function deliveryTurn(
  thread: WorkerAgentThreadSender,
  input: string
): AgentTurnLike {
  return {
    events: () => deliveryEvents(thread, input),
  };
}

async function* deliveryEvents(
  thread: WorkerAgentThreadSender,
  input: string
): AsyncIterable<AgentEvent> {
  const events: AgentEvent[] = [];
  const options = {
    onEvent: (event) => events.push(event),
  } satisfies DeliverToolOnlyTurnOptions;

  try {
    await deliverToolOnlyTurn(thread, input, options);
  } catch (error) {
    yield* events;
    if (!events.some((event) => event.type === "turn-error")) {
      yield {
        message: error instanceof Error ? error.message : "turn failed",
        type: "turn-error",
      };
    }
    return;
  }

  yield* events;
}

export async function deliveredByRawTurn(
  turn: AgentTurn
): Promise<readonly AgentEvent[]> {
  const events: AgentEvent[] = [];
  await collectTurnDelivery(turn, { onEvent: (event) => events.push(event) });
  return events;
}

function evalModel(scriptedResults: readonly ScriptedResult[]) {
  if (isWorkerAgentEvalRealMode()) {
    return realModel();
  }

  return createScriptedModel(scriptedResults);
}

function realModel(): ReturnType<ReturnType<typeof createOpenAICompatible>> {
  if (cachedRealModel) {
    return cachedRealModel;
  }

  loadWorkerAgentEvalEnv();
  const env = EvalModelEnvSchema.parse(process.env);
  cachedRealModel = createOpenAICompatible({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL ?? "https://apis.opengateway.ai/v1",
    name: "custom",
  })(env.AI_MODEL ?? DEFAULT_MODEL);
  return cachedRealModel;
}

function createEvalMessageSink(): ChannelMessageSink {
  let nextMessageIndex = 0;
  return {
    send: (channel, _text) => {
      nextMessageIndex += 1;
      return Promise.resolve({
        channel: channelKey(channel),
        messageId: `eval-${nextMessageIndex}`,
      });
    },
  };
}
