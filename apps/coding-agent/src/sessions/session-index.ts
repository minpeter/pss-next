import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Durable metadata for coding-agent sessions (threads). The runtime's
 * thread store only persists opaque state, so display names, fork
 * parentage, and the per-directory "active session" pointer live in this
 * sidecar index next to the thread files.
 */
export interface SessionIndexEntry {
  readonly createdAt: string;
  readonly cwd: string;
  readonly key: string;
  readonly name?: string;
  /** Thread key of the session this one was forked from. */
  readonly parentKey?: string;
  readonly updatedAt: string;
}

export interface SessionIndexDocument {
  /** Maps a working directory to the thread key resumed on startup. */
  readonly active: Readonly<Record<string, string>>;
  readonly schemaVersion: 1;
  readonly sessions: readonly SessionIndexEntry[];
}

export const SESSION_INDEX_FILENAME = "sessions.json";

export function sessionIndexPath(threadDirectory: string): string {
  return join(threadDirectory, SESSION_INDEX_FILENAME);
}

export function emptySessionIndex(): SessionIndexDocument {
  return { active: {}, schemaVersion: 1, sessions: [] };
}

/**
 * Read the session index. A missing file yields an empty index; a
 * malformed file fails safe to an empty index as well (the durable thread
 * state itself is never touched by index corruption).
 */
export async function readSessionIndex(
  path: string
): Promise<SessionIndexDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return emptySessionIndex();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseSessionIndex(parsed);
  } catch {
    return emptySessionIndex();
  }
}

export async function writeSessionIndex(
  path: string,
  document: SessionIndexDocument
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8"
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function upsertSession(
  document: SessionIndexDocument,
  entry: SessionIndexEntry
): SessionIndexDocument {
  const existing = document.sessions.find(
    (session) => session.key === entry.key
  );
  const sessions =
    existing === undefined
      ? [...document.sessions, entry]
      : document.sessions.map((session) =>
          session.key === entry.key ? { ...existing, ...entry } : session
        );
  return { ...document, sessions };
}

export function touchSession(
  document: SessionIndexDocument,
  key: string,
  updatedAt: string
): SessionIndexDocument {
  return {
    ...document,
    sessions: document.sessions.map((session) =>
      session.key === key ? { ...session, updatedAt } : session
    ),
  };
}

export function renameSession(
  document: SessionIndexDocument,
  key: string,
  name: string,
  updatedAt: string
): SessionIndexDocument {
  return {
    ...document,
    sessions: document.sessions.map((session) =>
      session.key === key ? { ...session, name, updatedAt } : session
    ),
  };
}

export function removeSession(
  document: SessionIndexDocument,
  key: string
): SessionIndexDocument {
  const active = Object.fromEntries(
    Object.entries(document.active).filter(([, value]) => value !== key)
  );
  return {
    ...document,
    active,
    sessions: document.sessions.filter((session) => session.key !== key),
  };
}

export function setActiveSession(
  document: SessionIndexDocument,
  cwd: string,
  key: string
): SessionIndexDocument {
  return { ...document, active: { ...document.active, [cwd]: key } };
}

export function activeSessionKey(
  document: SessionIndexDocument,
  cwd: string
): string | undefined {
  const key = document.active[cwd];
  if (key === undefined) {
    return;
  }
  return document.sessions.some((session) => session.key === key)
    ? key
    : undefined;
}

export function listSessionsForCwd(
  document: SessionIndexDocument,
  cwd: string
): readonly SessionIndexEntry[] {
  return document.sessions
    .filter((session) => session.cwd === cwd)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function parseSessionIndex(value: unknown): SessionIndexDocument {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return emptySessionIndex();
  }
  const active: Record<string, string> = {};
  if (isRecord(value.active)) {
    for (const [cwd, key] of Object.entries(value.active)) {
      if (typeof key === "string") {
        active[cwd] = key;
      }
    }
  }
  const sessions: SessionIndexEntry[] = [];
  if (Array.isArray(value.sessions)) {
    for (const candidate of value.sessions) {
      const entry = parseSessionEntry(candidate);
      if (
        entry !== undefined &&
        !sessions.some((session) => session.key === entry.key)
      ) {
        sessions.push(entry);
      }
    }
  }
  return { active, schemaVersion: 1, sessions };
}

function parseSessionEntry(value: unknown): SessionIndexEntry | undefined {
  if (
    !(
      isRecord(value) &&
      typeof value.key === "string" &&
      typeof value.cwd === "string" &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string"
    )
  ) {
    return;
  }
  return {
    createdAt: value.createdAt,
    cwd: value.cwd,
    key: value.key,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.parentKey === "string"
      ? { parentKey: value.parentKey }
      : {}),
    updatedAt: value.updatedAt,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
