import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import type { AgentInput, UserInput } from "../../thread/input/input";
import type { AgentTurn } from "../../thread/protocol/turn";
import type { CompactionSummaryOptions } from "../../thread/runtime/auto-compaction-types";
import type { NotifyOptions } from "../../thread/runtime/notification";
import type { ThreadCompactionInput } from "../../thread/state/thread-state";
import { namespacePart } from "../identity/namespace";

export interface ThreadMetadata {
  readonly [key: string]: unknown;
}

export interface ThreadAddress {
  readonly key: string;
  readonly metadata?: ThreadMetadata;
  readonly scope?: string;
}

export type ThreadKey = string | ThreadAddress;

export interface ThreadHandle {
  compact(
    input?: CompactionSummaryOptions | ThreadCompactionInput
  ): Promise<boolean>;
  delete(): Promise<void>;
  dispose(): Promise<void>;
  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent>;
  followUp(input: AgentInput): Promise<AgentTurn>;
  interrupt(): void;
  overlay(input: AgentInput): ThreadHandle;
  send(input: AgentInput): Promise<AgentTurn>;
  steer(input: AgentInput): Promise<AgentTurn>;
}

export interface AgentThreadEntry {
  notify(
    input: AgentInput | UserInput,
    options?: NotifyOptions
  ): Promise<AgentTurn>;
  readonly publicHandle: ThreadHandle;
}

export function threadStoreKey(thread: ThreadKey): string {
  if (typeof thread === "string") {
    return thread;
  }

  if (thread.scope === undefined) {
    return thread.key;
  }

  return `scope:${namespacePart(thread.scope)}:thread:${namespacePart(
    thread.key
  )}`;
}
