import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeSessionKey,
  emptySessionIndex,
  listSessionsForCwd,
  readSessionIndex,
  removeSession,
  renameSession,
  type SessionIndexEntry,
  sessionIndexPath,
  setActiveSession,
  upsertSession,
  writeSessionIndex,
} from "./session-index";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pss-session-index-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

const entry = (key: string, overrides?: Partial<SessionIndexEntry>) =>
  ({
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
    key,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as SessionIndexEntry;

describe("session index persistence", () => {
  it("round-trips through the index file", async () => {
    const path = sessionIndexPath(directory);
    let document = emptySessionIndex();
    document = upsertSession(document, entry("cwd:/work"));
    document = setActiveSession(document, "/work", "cwd:/work");
    await writeSessionIndex(path, document);

    const loaded = await readSessionIndex(path);
    expect(loaded.sessions).toHaveLength(1);
    expect(activeSessionKey(loaded, "/work")).toBe("cwd:/work");
  });

  it("returns an empty index for missing files", async () => {
    const loaded = await readSessionIndex(join(directory, "none.json"));
    expect(loaded).toEqual(emptySessionIndex());
  });

  it("fails safe on malformed content", async () => {
    const path = sessionIndexPath(directory);
    await writeFile(path, "{broken", "utf8");
    expect(await readSessionIndex(path)).toEqual(emptySessionIndex());
  });

  it("drops malformed entries and duplicate keys while parsing", async () => {
    const path = sessionIndexPath(directory);
    await writeFile(
      path,
      JSON.stringify({
        active: { "/work": 5 },
        schemaVersion: 1,
        sessions: [entry("a"), entry("a"), { key: "b" }, "junk"],
      }),
      "utf8"
    );
    const loaded = await readSessionIndex(path);
    expect(loaded.sessions.map((session) => session.key)).toEqual(["a"]);
    expect(loaded.active).toEqual({});
  });

  it("writes atomically without leaving temp files", async () => {
    const path = sessionIndexPath(directory);
    await writeSessionIndex(path, emptySessionIndex());
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("session index operations", () => {
  it("removes sessions and clears dangling active pointers", () => {
    let document = upsertSession(emptySessionIndex(), entry("a"));
    document = setActiveSession(document, "/work", "a");
    document = removeSession(document, "a");
    expect(document.sessions).toEqual([]);
    expect(activeSessionKey(document, "/work")).toBeUndefined();
  });

  it("ignores active pointers to unknown sessions", () => {
    const document = setActiveSession(emptySessionIndex(), "/work", "ghost");
    expect(activeSessionKey(document, "/work")).toBeUndefined();
  });

  it("renames sessions", () => {
    let document = upsertSession(emptySessionIndex(), entry("a"));
    document = renameSession(
      document,
      "a",
      "spike",
      "2026-01-02T00:00:00.000Z"
    );
    expect(document.sessions[0]).toMatchObject({
      name: "spike",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("lists sessions for a cwd sorted by recency", () => {
    let document = emptySessionIndex();
    document = upsertSession(
      document,
      entry("old", { updatedAt: "2026-01-01T00:00:00.000Z" })
    );
    document = upsertSession(
      document,
      entry("new", { updatedAt: "2026-01-03T00:00:00.000Z" })
    );
    document = upsertSession(document, entry("other", { cwd: "/elsewhere" }));
    expect(listSessionsForCwd(document, "/work").map((s) => s.key)).toEqual([
      "new",
      "old",
    ]);
  });
});
