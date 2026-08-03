import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadStore } from "@minpeter/pss-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionManager } from "./session-manager";

const UNKNOWN_SESSION = /Unknown session/;
const NOT_A_USER_MESSAGE = /does not reference a user message/;
const UNIQUE_WORK_SESSION = /^cwd:\/work#[0-9a-f]{8}$/;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pss-session-manager-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function memoryThreadStore(): ThreadStore & {
  readonly loadCalls: string[];
  readonly stored: Map<string, unknown>;
} {
  const loadCalls: string[] = [];
  const stored = new Map<string, unknown>();
  return {
    commit: (key, next, options) => {
      const exists = stored.has(key);
      if (
        (options.expectedVersion === null && exists) ||
        (options.expectedVersion !== null && !exists)
      ) {
        return Promise.resolve({ ok: false, reason: "conflict" as const });
      }
      stored.set(key, next.state);
      return Promise.resolve({ ok: true, version: "1" });
    },
    delete: (key) => {
      stored.delete(key);
      return Promise.resolve();
    },
    load: (key) => {
      loadCalls.push(key);
      return Promise.resolve(
        stored.has(key) ? { state: stored.get(key), version: "1" } : null
      );
    },
    loadCalls,
    stored,
  };
}

function manager(threads = memoryThreadStore()) {
  return {
    manager: createSessionManager({ cwd: "/work", directory, threads }),
    threads,
  };
}

describe("createSessionManager", () => {
  it("creates a uniquely keyed session on first startup", async () => {
    const { manager: sessions } = manager();
    const entry = await sessions.resolveStartupSession();
    expect(entry.key).toMatch(UNIQUE_WORK_SESSION);
    expect(await sessions.listSessions()).toHaveLength(1);
  });

  it("creates a distinct session on every startup", async () => {
    const { manager: sessions } = manager();
    const first = await sessions.resolveStartupSession();
    const next = createSessionManager({ cwd: "/work", directory });
    const second = await next.resolveStartupSession();
    expect(second.key).not.toBe(first.key);
    expect(await next.listSessions()).toHaveLength(2);
  });

  it("prefers an explicit override key and records a startup name", async () => {
    const { manager: sessions } = manager();
    const entry = await sessions.resolveStartupSession({
      name: "ci",
      overrideKey: "custom:key",
    });
    expect(entry).toMatchObject({ key: "custom:key", name: "ci" });
  });

  it("does not let an override key clobber the active pointer", async () => {
    const { manager: sessions } = manager();
    const regular = await sessions.resolveStartupSession();
    await sessions.resolveStartupSession({ overrideKey: "ci:forced" });

    expect((await sessions.getSession(regular.key))?.key).toBe(regular.key);
    // The forced key is still registered for /name and /fork.
    expect((await sessions.findSession("ci:forced"))?.key).toBe("ci:forced");
  });

  it("creates uniquely keyed sessions and marks them active", async () => {
    const { manager: sessions } = manager();
    const first = await sessions.createSession();
    const second = await sessions.createSession();
    expect(first.key).not.toBe(second.key);
    expect((await sessions.getSession(second.key))?.key).toBe(second.key);
  });

  it("forks durable state and records the parent-thread reference", async () => {
    const { manager: sessions, threads } = manager();
    const source = await sessions.resolveStartupSession();
    threads.stored.set(source.key, { history: [], schemaVersion: 1 });

    const fork = await sessions.forkSession(source.key, {
      name: "experiment",
    });
    expect(fork.parentKey).toBe(source.key);
    expect(fork.name).toBe("experiment");
    expect(threads.stored.get(fork.key)).toEqual({
      history: [],
      schemaVersion: 1,
    });
    // The source thread stays untouched.
    expect(threads.stored.get(source.key)).toEqual({
      history: [],
      schemaVersion: 1,
    });
  });

  it("forks sessions without durable state as empty sessions", async () => {
    const { manager: sessions, threads } = manager();
    const source = await sessions.resolveStartupSession();
    const fork = await sessions.forkSession(source.key);
    expect(threads.stored.has(fork.key)).toBe(false);
    expect(fork.parentKey).toBe(source.key);
  });

  it("forks before an earlier user message with truncated history", async () => {
    const { manager: sessions, threads } = manager();
    const source = await sessions.resolveStartupSession();
    threads.stored.set(source.key, {
      appliedMigrations: { "ext/migration": 1 },
      compactions: [],
      history: [
        { content: "first ask", role: "user" },
        { content: "first answer", role: "assistant" },
        { content: "second ask", role: "user" },
        { content: "second answer", role: "assistant" },
      ],
      schemaVersion: 3,
    });

    const fork = await sessions.forkSession(source.key, {
      beforeHistoryIndex: 2,
    });
    const forked = threads.stored.get(fork.key) as {
      appliedMigrations: Record<string, number>;
      history: { content: string }[];
    };
    expect(forked.history.map((message) => message.content)).toEqual([
      "first ask",
      "first answer",
    ]);
    // Applied migrations are seeded so they never re-run on the fork.
    expect(forked.appliedMigrations).toEqual({ "ext/migration": 1 });
  });

  it("rejects fork points that are not user messages", async () => {
    const { manager: sessions, threads } = manager();
    const source = await sessions.resolveStartupSession();
    threads.stored.set(source.key, {
      history: [
        { content: "ask", role: "user" },
        { content: "answer", role: "assistant" },
      ],
      schemaVersion: 1,
    });
    await expect(
      sessions.forkSession(source.key, { beforeHistoryIndex: 1 })
    ).rejects.toThrow(NOT_A_USER_MESSAGE);
    await expect(
      sessions.forkSession(source.key, { beforeHistoryIndex: 9 })
    ).rejects.toThrow(NOT_A_USER_MESSAGE);
  });

  it("lists user messages as fork points with previews", async () => {
    const { manager: sessions, threads } = manager();
    const source = await sessions.resolveStartupSession();
    threads.stored.set(source.key, {
      history: [
        { content: "  first\n ask ", role: "user" },
        { content: "answer", role: "assistant" },
        {
          content: [{ text: "second ask", type: "text" }],
          role: "user",
        },
        {
          content: [{ data: "aGk=", mediaType: "image/png", type: "image" }],
          role: "user",
        },
      ],
      schemaVersion: 1,
    });
    expect(await sessions.listForkPoints(source.key)).toEqual([
      { historyIndex: 0, preview: "first ask" },
      { historyIndex: 2, preview: "second ask" },
      { historyIndex: 3, preview: "(no text)" },
    ]);
  });

  it("lists only sessions with stored messages as resumable", async () => {
    const { manager: sessions, threads } = manager();
    const empty = await sessions.resolveStartupSession();
    const populated = await sessions.createSession("populated");
    await sessions.createSession("missing");
    threads.stored.set(empty.key, { history: [], schemaVersion: 1 });
    threads.stored.set(populated.key, {
      history: [{ content: "hello", role: "user" }],
      schemaVersion: 1,
    });

    expect(await sessions.listResumableSessions()).toEqual([populated]);
  });

  it("caches resumable sessions until session state changes", async () => {
    const { manager: sessions, threads } = manager();
    const entry = await sessions.resolveStartupSession();
    threads.stored.set(entry.key, {
      history: [{ content: "hello", role: "user" }],
      schemaVersion: 1,
    });

    expect(await sessions.listResumableSessions()).toEqual([entry]);
    expect(await sessions.listResumableSessions()).toEqual([entry]);
    expect(threads.loadCalls).toEqual([entry.key]);

    threads.stored.set(entry.key, { history: [], schemaVersion: 1 });
    await sessions.touchSession(entry.key);
    expect(await sessions.listResumableSessions()).toEqual([]);
    expect(threads.loadCalls).toEqual([entry.key, entry.key]);
  });

  it("loads the decoded message history for a recorded session", async () => {
    const { manager: sessions, threads } = manager();
    const session = await sessions.resolveStartupSession();
    const history = [
      { content: "hello", role: "user" as const },
      { content: "welcome back", role: "assistant" as const },
    ];
    threads.stored.set(session.key, { history, schemaVersion: 1 });

    expect(await sessions.loadSessionHistory(session.key)).toEqual(history);
  });

  it("touches recency without failing for unknown keys", async () => {
    const { manager: sessions } = manager();
    const source = await sessions.resolveStartupSession();
    const before = (await sessions.getSession(source.key))?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await sessions.touchSession(source.key);
    const after = (await sessions.getSession(source.key))?.updatedAt;
    expect(after).not.toBe(before);
    await expect(sessions.touchSession("ghost")).resolves.toBeUndefined();
  });

  it("renames and finds sessions by name, key, and unique prefix", async () => {
    const { manager: sessions } = manager();
    const entry = await sessions.resolveStartupSession();
    await sessions.renameSession(entry.key, "bugfix");
    expect((await sessions.findSession("bugfix"))?.key).toBe(entry.key);
    expect((await sessions.findSession(entry.key))?.key).toBe(entry.key);
    expect((await sessions.findSession("bug"))?.key).toBe(entry.key);
    expect(await sessions.findSession("nope")).toBeUndefined();
  });

  it("rejects renames of unknown sessions", async () => {
    const { manager: sessions } = manager();
    await expect(sessions.renameSession("ghost", "x")).rejects.toThrow(
      UNKNOWN_SESSION
    );
  });

  it("removes sessions along with their durable thread state", async () => {
    const { manager: sessions, threads } = manager();
    const entry = await sessions.resolveStartupSession();
    threads.stored.set(entry.key, { messages: [] });
    await sessions.removeSession(entry.key);
    expect(threads.stored.has(entry.key)).toBe(false);
    expect(await sessions.listSessions()).toEqual([]);
  });

  it("switches between recorded sessions", async () => {
    const { manager: sessions } = manager();
    const first = await sessions.resolveStartupSession();
    await sessions.createSession();
    const switched = await sessions.switchToSession(first.key);
    expect(switched.key).toBe(first.key);
    expect((await sessions.getSession(first.key))?.updatedAt).toBe(
      switched.updatedAt
    );
  });

  it("rejects switching to unknown sessions", async () => {
    const { manager: sessions } = manager();
    await expect(sessions.switchToSession("ghost")).rejects.toThrow(
      UNKNOWN_SESSION
    );
  });
});
