import type { ModelMessage } from "ai";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { AgentCompactionContext } from "./auto-compaction-types";

export const message = (
  content: string,
  role: "user" | "assistant" = "user"
): ModelMessage => ({ content, role });
const threadIdentity = Object.freeze({});

export function context(
  history: readonly ModelMessage[],
  summarize: AgentCompactionContext["summarize"],
  overrides: Partial<AgentCompactionContext> = {}
): AgentCompactionContext {
  return {
    compactions: [],
    estimatedContextTokens: history.length * 10,
    estimatedHistory: history,
    history,
    instructionsTokens: 0,
    modelContext: history,
    modelContextProvenance: "standard",
    reason: "completed-turn",
    signal: new AbortController().signal,
    summarize,
    threadIdentity,
    threadKey: "thread",
    ...overrides,
  };
}

export function committedProjection(
  record: ThreadCompactionRecord,
  history: readonly ModelMessage[]
): Partial<AgentCompactionContext> {
  return {
    compactions: [record],
    modelContext: [
      compactionContextForModel(compactionContextMessage(record)),
      ...history.slice(record.endSeqExclusive),
    ],
  };
}
