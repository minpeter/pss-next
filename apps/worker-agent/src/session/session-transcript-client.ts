import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";
import { z } from "zod";

import { durableObjectName, type Env } from "../env";
import {
  MAX_SESSION_READ_LIMIT,
  type SessionTranscriptReader,
  type SessionTranscriptReadOptions,
  SessionTranscriptSchema,
} from "./session-transcript";

export const SESSION_TRANSCRIPT_READ_PATH = "/session-transcript/read";

const SESSION_TRANSCRIPT_ORIGIN = "https://agent.internal";

export const SessionTranscriptReadRequestSchema = z
  .object({
    before: z.number().int().min(0).optional(),
    conversationKey: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_SESSION_READ_LIMIT).optional(),
  })
  .strict();

const SessionTranscriptReadResponseSchema = z.discriminatedUnion("found", [
  z
    .object({
      conversationKey: z.string(),
      found: z.literal(false),
    })
    .strict(),
  SessionTranscriptSchema.extend({ found: z.literal(true) }).strict(),
]);

export function createSessionTranscriptClient(
  env: Env
): SessionTranscriptReader {
  return {
    read: async (conversationKey, options = {}) => {
      const body = await postTranscriptRead(env, conversationKey, options);
      const parsed = SessionTranscriptReadResponseSchema.parse(body);
      if (!parsed.found) {
        return;
      }
      const { found, ...transcript } = parsed;
      return transcript;
    },
  };
}

async function postTranscriptRead(
  env: Env,
  conversationKey: string,
  options: SessionTranscriptReadOptions
): Promise<unknown> {
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(conversationKey),
    request: new Request(
      `${SESSION_TRANSCRIPT_ORIGIN}${SESSION_TRANSCRIPT_READ_PATH}`,
      {
        body: JSON.stringify({
          conversationKey,
          ...(options.before === undefined ? {} : { before: options.before }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    ),
  });

  if (!response) {
    return { conversationKey, found: false };
  }
  if (!response.ok) {
    return { conversationKey, found: false };
  }
  return await response.json();
}

export function isSessionTranscriptPath(pathname: string): boolean {
  return pathname === SESSION_TRANSCRIPT_READ_PATH;
}
