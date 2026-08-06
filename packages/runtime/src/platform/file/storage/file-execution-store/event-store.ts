import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createEventCursor,
  createThreadEventCursor,
  normalizeEventCursor,
  normalizeThreadEventReadOptions,
} from "../../../../execution/host/event-cursors";
import type {
  EventCursor,
  EventStore,
  StoredAgentEvent,
  StoredThreadEvent,
  ThreadEventCursor,
  ThreadEventLog,
  ThreadEventReadOptions,
} from "../../../../execution/host/types";
import { isNodeError } from "../../../../internal/guards";
import type { AgentEvent } from "../../../../thread/protocol/events";
import {
  parseEventLogLine,
  parseThreadEventLogLine,
} from "./event-log-schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileEventStore implements EventStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async append(runId: string, event: AgentEvent): Promise<EventCursor> {
    return await this.#lock(async () => {
      const file = await this.#fileForRun(runId);
      await mkdir(dirname(file), { recursive: true });
      const offset = (await this.#countUnlocked(file)) + 1;
      await appendFile(
        file,
        `${JSON.stringify({ cursor: { offset }, event, runId })}\n`,
        "utf8"
      );
      return createEventCursor(offset);
    });
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    const start = normalizeEventCursor(cursor);
    const events = await this.#lock(async () => {
      const file = await this.#fileForRun(runId);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const parsed: StoredAgentEvent[] = [];
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        parsed.push(parseEventLogLine(line, file));
      }
      return parsed;
    });

    for (const event of events.slice(start)) {
      yield structuredClone(event);
    }
  }

  async #countUnlocked(file: string): Promise<number> {
    try {
      const content = await readFile(file, "utf8");
      if (content.length === 0) {
        return 0;
      }
      return content.split("\n").filter((line) => line.length > 0).length;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async #fileForRun(runId: string): Promise<string> {
    return join(await this.#directory(), "events", `${encodeKey(runId)}.jsonl`);
  }
}

export class FileThreadEventLog implements ThreadEventLog {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async append(
    threadKey: string,
    event: AgentEvent
  ): Promise<ThreadEventCursor> {
    return await this.#lock(async () => {
      const file = await this.#fileForThread(threadKey);
      await mkdir(dirname(file), { recursive: true });
      const offset = (await this.#countUnlocked(file)) + 1;
      await appendFile(
        file,
        `${JSON.stringify({ cursor: { offset }, event, threadKey })}\n`,
        "utf8"
      );
      return createThreadEventCursor(offset);
    });
  }

  async *read(
    threadKey: string,
    options: ThreadEventReadOptions = {}
  ): AsyncIterable<StoredThreadEvent> {
    const { limit, start } = normalizeThreadEventReadOptions(options);
    const events = await this.#lock(async () => {
      const file = await this.#fileForThread(threadKey);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const parsed: StoredThreadEvent[] = [];
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        parsed.push(parseThreadEventLogLine(line, file));
      }
      return parsed;
    });

    const end = limit === undefined ? undefined : start + limit;
    for (const event of events.slice(start, end)) {
      yield structuredClone(event);
    }
  }

  async #countUnlocked(file: string): Promise<number> {
    try {
      const content = await readFile(file, "utf8");
      if (content.length === 0) {
        return 0;
      }
      return content.split("\n").filter((line) => line.length > 0).length;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async #fileForThread(threadKey: string): Promise<string> {
    return join(
      await this.#directory(),
      "thread-events",
      `${encodeKey(threadKey)}.jsonl`
    );
  }
}
