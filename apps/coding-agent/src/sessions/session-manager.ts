import { randomUUID } from "node:crypto";
import {
  decodeStoredThreadState,
  encodeThreadSnapshot,
  type ThreadStore,
} from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import {
  listSessionsForCwd,
  readSessionIndex,
  removeSession,
  renameSession,
  type SessionIndexDocument,
  type SessionIndexEntry,
  sessionIndexPath,
  setActiveSession,
  touchSession,
  upsertSession,
  writeSessionIndex,
} from "./session-index";

/** Why a session became (or is becoming) the active one. */
export type SessionLifecycleReason =
  | "clear"
  | "fork"
  | "new"
  | "resume"
  | "startup";

/** A user message in the source thread that a fork can branch before. */
export interface SessionForkPoint {
  /** Index of the user message in the stored history. */
  readonly historyIndex: number;
  /** Single-line text preview of the user message. */
  readonly preview: string;
}

export interface SessionForkOptions {
  /**
   * Branch before this user message: the fork keeps the history strictly
   * before `historyIndex` (which must reference a user message). Without
   * it the fork branches at the latest committed state.
   */
  readonly beforeHistoryIndex?: number;
  readonly name?: string;
}

export interface SessionManagerOptions {
  readonly cwd: string;
  /** Thread storage directory; the index lives next to the thread files. */
  readonly directory: string;
  readonly now?: () => Date;
  /** Durable thread store used to copy state when forking. */
  readonly threads?: ThreadStore;
}

export interface SessionManager {
  /** Create a new empty session and mark it active. */
  createSession(name?: string): Promise<SessionIndexEntry>;
  readonly cwd: string;
  /** Find a session for this cwd by exact key, name, or unique prefix. */
  findSession(query: string): Promise<SessionIndexEntry | undefined>;
  /**
   * Fork `fromKey` into a new session and record the parent-thread
   * reference. By default the fork copies the latest committed state
   * (including applied migrations); `beforeHistoryIndex` branches before an
   * earlier user message instead, keeping compaction records that fit the
   * truncated history.
   */
  forkSession(
    fromKey: string,
    options?: SessionForkOptions
  ): Promise<SessionIndexEntry>;
  getSession(key: string): Promise<SessionIndexEntry | undefined>;
  /** List the user messages of a stored thread a fork can branch before. */
  listForkPoints(fromKey: string): Promise<readonly SessionForkPoint[]>;
  listResumableSessions(): Promise<readonly SessionIndexEntry[]>;
  listSessions(): Promise<readonly SessionIndexEntry[]>;
  loadSessionHistory(key: string): Promise<readonly ModelMessage[]>;
  /** Delete a session's metadata and its durable thread state. */
  removeSession(key: string): Promise<void>;
  renameSession(key: string, name: string): Promise<SessionIndexEntry>;
  /**
   * Resolve which thread key this startup should use. An explicit override
   * reuses that key; otherwise every process gets a new per-cwd session.
   * Existing sessions remain available through `/resume`.
   */
  resolveStartupSession(options?: {
    readonly name?: string;
    readonly overrideKey?: string;
  }): Promise<SessionIndexEntry>;
  /** Mark an existing session active (e.g. after `/resume`). */
  switchToSession(key: string): Promise<SessionIndexEntry>;
  /** Bump a session's recency (no-op for unknown keys). */
  touchSession(key: string): Promise<void>;
}

export function createSessionManager(
  options: SessionManagerOptions
): SessionManager {
  const { cwd, directory, threads } = options;
  const now = options.now ?? (() => new Date());
  const indexPath = sessionIndexPath(directory);
  // Serialize read-modify-write cycles so concurrent commands cannot drop
  // one another's index updates.
  let queue: Promise<unknown> = Promise.resolve();
  let resumableSessionsCache: Promise<readonly SessionIndexEntry[]> | undefined;
  const invalidateResumableSessions = (): void => {
    resumableSessionsCache = undefined;
  };
  const enqueue = <Result>(
    task: (document: SessionIndexDocument) => Promise<{
      readonly document: SessionIndexDocument;
      readonly result: Result;
    }>
  ): Promise<Result> => {
    const run = queue.then(async () => {
      const document = await readSessionIndex(indexPath);
      const { document: next, result } = await task(document);
      if (next !== document) {
        await writeSessionIndex(indexPath, next);
      }
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const timestamp = (): string => now().toISOString();

  const registerActive = (
    document: SessionIndexDocument,
    entry: SessionIndexEntry
  ): SessionIndexDocument =>
    setActiveSession(upsertSession(document, entry), cwd, entry.key);

  return {
    createSession: (name) => {
      invalidateResumableSessions();
      return enqueue((document) => {
        const at = timestamp();
        const entry: SessionIndexEntry = {
          createdAt: at,
          cwd,
          key: newSessionKey(cwd),
          ...(name === undefined ? {} : { name }),
          updatedAt: at,
        };
        return Promise.resolve({
          document: registerActive(document, entry),
          result: entry,
        });
      });
    },
    cwd,
    findSession: (query) =>
      enqueue((document) =>
        Promise.resolve({
          document,
          result: matchSession(listSessionsForCwd(document, cwd), query),
        })
      ),
    forkSession: async (fromKey, forkOptions = {}) => {
      invalidateResumableSessions();
      if (threads === undefined) {
        throw new Error("Forking requires thread storage.");
      }
      const source = await threads.load(fromKey);
      const forkState = resolveForkState(source, forkOptions);
      const at = timestamp();
      const entry: SessionIndexEntry = {
        createdAt: at,
        cwd,
        key: newSessionKey(cwd),
        ...(forkOptions.name === undefined ? {} : { name: forkOptions.name }),
        parentKey: fromKey,
        updatedAt: at,
      };
      if (forkState !== undefined) {
        const committed = await threads.commit(
          entry.key,
          { state: forkState },
          { expectedVersion: null }
        );
        if (!committed.ok) {
          throw new Error(
            `Fork target thread ${JSON.stringify(entry.key)} already exists`
          );
        }
      }
      try {
        return await enqueue((document) =>
          Promise.resolve({
            document: registerActive(document, entry),
            result: entry,
          })
        );
      } catch (error) {
        // Never leave an orphaned thread copy behind when the metadata
        // registration fails.
        if (forkState !== undefined) {
          await threads.delete(entry.key).catch(() => undefined);
        }
        throw error;
      }
    },
    getSession: (key) =>
      enqueue((document) =>
        Promise.resolve({
          document,
          result: document.sessions.find((session) => session.key === key),
        })
      ),
    loadSessionHistory: async (key) =>
      threads === undefined
        ? []
        : decodeStoredThreadState(await threads.load(key)).history,
    listForkPoints: async (fromKey) => {
      if (threads === undefined) {
        return [];
      }
      const state = decodeStoredThreadState(await threads.load(fromKey));
      const points: SessionForkPoint[] = [];
      for (const [index, message] of state.history.entries()) {
        if (message.role !== "user") {
          continue;
        }
        points.push({
          historyIndex: index,
          preview: previewOfMessage(message),
        });
      }
      return points;
    },
    listResumableSessions: () => {
      if (resumableSessionsCache !== undefined) {
        return resumableSessionsCache;
      }
      const request = enqueue(async (document) => {
        if (threads === undefined) {
          return { document, result: [] };
        }
        const sessions = listSessionsForCwd(document, cwd);
        const stored = await Promise.all(
          sessions.map(async (session) => ({
            hasMessages:
              decodeStoredThreadState(await threads.load(session.key)).history
                .length > 0,
            session,
          }))
        );
        return {
          document,
          result: stored
            .filter(({ hasMessages }) => hasMessages)
            .map(({ session }) => session),
        };
      });
      resumableSessionsCache = request;
      request.catch(() => {
        if (resumableSessionsCache === request) {
          resumableSessionsCache = undefined;
        }
      });
      return request;
    },
    listSessions: () =>
      enqueue((document) =>
        Promise.resolve({
          document,
          result: listSessionsForCwd(document, cwd),
        })
      ),
    removeSession: async (key) => {
      invalidateResumableSessions();
      await enqueue((document) =>
        Promise.resolve({
          document: removeSession(document, key),
          result: undefined,
        })
      );
      await threads?.delete(key);
    },
    renameSession: (key, name) => {
      invalidateResumableSessions();
      return enqueue((document) => {
        const existing = document.sessions.find(
          (session) => session.key === key
        );
        if (existing === undefined) {
          return Promise.reject(
            new Error(`Unknown session ${JSON.stringify(key)}`)
          );
        }
        const at = timestamp();
        const next = renameSession(document, key, name, at);
        return Promise.resolve({
          document: next,
          result: { ...existing, name, updatedAt: at },
        });
      });
    },
    resolveStartupSession: ({ name, overrideKey } = {}) => {
      invalidateResumableSessions();
      return enqueue((document) => {
        const key = overrideKey ?? newSessionKey(cwd);
        const existing = document.sessions.find(
          (session) => session.key === key
        );
        const at = timestamp();
        const resolvedName = name ?? existing?.name;
        const entry: SessionIndexEntry = {
          createdAt: existing?.createdAt ?? at,
          cwd,
          key,
          ...(resolvedName === undefined ? {} : { name: resolvedName }),
          ...(existing?.parentKey === undefined
            ? {}
            : { parentKey: existing.parentKey }),
          updatedAt: at,
        };
        // An env-forced key is registered (so /name and /fork work) but
        // must not clobber the active pointer for regular startups.
        const next =
          overrideKey === undefined
            ? registerActive(document, entry)
            : upsertSession(document, entry);
        return Promise.resolve({ document: next, result: entry });
      });
    },
    touchSession: (key) => {
      invalidateResumableSessions();
      return enqueue((document) => {
        const exists = document.sessions.some((session) => session.key === key);
        return Promise.resolve({
          document: exists
            ? touchSession(document, key, timestamp())
            : document,
          result: undefined,
        });
      });
    },
    switchToSession: (key) => {
      invalidateResumableSessions();
      return enqueue((document) => {
        const existing = document.sessions.find(
          (session) => session.key === key
        );
        if (existing === undefined) {
          return Promise.reject(
            new Error(`Unknown session ${JSON.stringify(key)}`)
          );
        }
        const at = timestamp();
        const next = setActiveSession(
          touchSession(document, key, at),
          cwd,
          key
        );
        return Promise.resolve({
          document: next,
          result: { ...existing, updatedAt: at },
        });
      });
    },
  };
}

export function describeSession(entry: SessionIndexEntry): string {
  const name = entry.name === undefined ? "" : ` "${entry.name}"`;
  const fork = entry.parentKey === undefined ? "" : " (fork)";
  return `${entry.key}${name}${fork}`;
}

function matchSession(
  sessions: readonly SessionIndexEntry[],
  query: string
): SessionIndexEntry | undefined {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return;
  }
  const exactKey = sessions.find((session) => session.key === trimmed);
  if (exactKey !== undefined) {
    return exactKey;
  }
  const lower = trimmed.toLowerCase();
  const byName = sessions.filter(
    (session) => session.name?.toLowerCase() === lower
  );
  if (byName.length === 1) {
    return byName[0];
  }
  const byPrefix = sessions.filter(
    (session) =>
      session.key.toLowerCase().startsWith(lower) ||
      session.name?.toLowerCase().startsWith(lower)
  );
  return byPrefix.length === 1 ? byPrefix[0] : undefined;
}

function newSessionKey(cwd: string): string {
  return `cwd:${cwd}#${randomUUID().slice(0, 8)}`;
}

const FORK_PREVIEW_LENGTH = 64;
const WHITESPACE_RUN = /\s+/g;

/**
 * Compute the state a fork starts from. A head fork copies the stored
 * state verbatim (no decode/re-encode round trip); a fork before an
 * earlier user message re-encodes the truncated history, keeping only
 * compaction records that fit inside it and the applied-migration seed.
 * Returns `undefined` when there is nothing to copy.
 */
function resolveForkState(
  source: Awaited<ReturnType<ThreadStore["load"]>>,
  options: SessionForkOptions
): unknown {
  if (options.beforeHistoryIndex === undefined) {
    return source?.state;
  }
  const index = options.beforeHistoryIndex;
  const state = decodeStoredThreadState(source);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= state.history.length ||
    state.history[index]?.role !== "user"
  ) {
    throw new Error(
      `Fork point ${String(index)} does not reference a user message`
    );
  }
  return encodeThreadSnapshot(
    state.history.slice(0, index),
    state.compactions.filter((record) => record.endSeqExclusive <= index),
    state.appliedMigrations
  );
}

function previewOfMessage(message: ModelMessage): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) =>
            typeof part === "object" && part !== null && "text" in part
              ? String(part.text)
              : ""
          )
          .join(" ");
  const collapsed = text.replace(WHITESPACE_RUN, " ").trim();
  if (collapsed.length === 0) {
    // e.g. attachment-only user messages still need a legible fork label.
    return "(no text)";
  }
  if (collapsed.length <= FORK_PREVIEW_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, FORK_PREVIEW_LENGTH - 1)}…`;
}
