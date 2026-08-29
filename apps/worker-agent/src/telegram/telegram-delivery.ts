import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";
import { z } from "zod";

import type { AgentRequestAttachment } from "../agent/agent-do-request";
import { type ChannelAddress, channelKey } from "../channel";
import { durableObjectName, type Env, isDevelopment } from "../env";
import { workerErrors } from "../worker-errors";
import { logError, newCorrelationId } from "../worker-log";
import {
  collectTurnImages,
  TelegramAttachmentLimitError,
} from "./telegram-attachments";
import { collectTurnTexts } from "./telegram-ingress";
import type {
  ConversationContext,
  ConversationEnv,
  ConversationMessage,
  ConversationThread,
  TurnDeliverer,
  TurnDeliveryOptions,
} from "./telegram-types";
import { correlationStore } from "./telegram-types";

const DEV_NOTICE = "🧪 DEVELOPMENT ENVIRONMENT";
const FAILURE_REPLY =
  "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";

const AgentDeliverySchema = z.discriminatedUnion("delivered", [
  z
    .object({
      delivered: z.literal(true),
      mode: z.enum(["send", "steer"]).optional(),
      messages: z
        .array(
          z
            .object({
              channel: z.string(),
              messageId: z.string(),
              text: z.string(),
            })
            .strict()
        )
        .readonly()
        .optional(),
    })
    .strict(),
  z
    .object({
      delivered: z.literal(false),
      error: z.literal(MISSING_SEND_MESSAGE_ERROR),
      mode: z.enum(["send", "steer"]).optional(),
    })
    .strict(),
]);

export async function replyToThread({
  batchMessages,
  context,
  correlationId,
  deliverTurn,
  env,
  message,
  subscribe,
  thread,
}: {
  readonly batchMessages?: readonly ConversationMessage[];
  readonly context?: ConversationContext;
  readonly correlationId?: string;
  readonly deliverTurn: TurnDeliverer;
  readonly env: ConversationEnv;
  readonly message: ConversationMessage;
  readonly subscribe?: boolean;
  readonly thread: ConversationThread;
}): Promise<void> {
  const messages = batchMessages ?? [...(context?.skipped ?? []), message];
  const text = collectTurnTexts(messages);
  let attachments: readonly AgentRequestAttachment[] = [];
  try {
    attachments = await collectTurnImages(messages);
  } catch (error) {
    const normalized = normalizeError(error);
    if (error instanceof TelegramAttachmentLimitError) {
      logError(workerErrors.ATTACHMENT_LIMIT_EXCEEDED({ cause: normalized }), {
        scope: "telegram",
        action: "attachment_limit",
      });
    } else {
      logError(workerErrors.ATTACHMENT_FETCH_FAILED({ cause: normalized }), {
        scope: "telegram",
      });
    }
    await thread.post(FAILURE_REPLY);
    return;
  }

  if (!(text || attachments.length > 0)) {
    return;
  }

  try {
    if (subscribe) {
      await thread.subscribe();
    }
    if (isDevelopment(env)) {
      await thread.post(DEV_NOTICE);
    }

    await deliverTurn(thread.channelId, text, {
      attachments,
      ...(correlationId ? { correlationId } : {}),
      sessionScopeKey: telegramSessionScopeKeyFromMessages(messages),
    });
  } catch (error) {
    logError(
      workerErrors.TELEGRAM_HANDLER_FAILED({ cause: normalizeError(error) }),
      { scope: "telegram" }
    );
    await thread.post(FAILURE_REPLY);
  }
}

export async function requestAgentDelivery(
  env: Env,
  channelId: string,
  text: string,
  options: TurnDeliveryOptions = {}
): Promise<void> {
  const channel: ChannelAddress = { id: channelId, kind: "telegram" };
  const sessionScopeKey = options.sessionScopeKey?.trim();
  const correlationId =
    options.correlationId?.trim() ||
    correlationStore.getStore() ||
    newCorrelationId();
  const attachments = options.attachments ?? [];
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelKey(channel)),
    request: new Request("https://agent.internal/turn", {
      body: JSON.stringify({
        channel,
        correlationId,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(sessionScopeKey ? { sessionScopeKey } : {}),
        text,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  });

  if (!response) {
    throw new Error("agent durable object failed: missing");
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`agent durable object failed: ${response.status}`);
  }

  const payload = AgentDeliverySchema.safeParse(raw);
  if (payload.success) {
    if (payload.data.delivered) {
      return;
    }
    throw workerErrors.MISSING_SEND_MESSAGE();
  }

  if (!response.ok) {
    throw new Error(`agent durable object failed: ${response.status}`);
  }

  throw new Error(
    `agent durable object returned invalid delivery payload: ${response.status}`
  );
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`Non-Error thrown: ${String(error)}`);
}

function telegramSessionScopeKey(
  message: ConversationMessage
): string | undefined {
  const userId = message.author?.userId?.trim();
  return userId ? `telegram:user:${userId}` : undefined;
}

function telegramSessionScopeKeyFromMessages(
  messages: readonly ConversationMessage[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const scope = telegramSessionScopeKey(messages[index] ?? {});
    if (scope) {
      return scope;
    }
  }
  return;
}
