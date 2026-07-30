import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionManager } from "./session-manager";
import { resolveSessionSelector } from "./session-resume";

const UNKNOWN_SESSION = /Unknown session "zzzzzzzz"/;
const UNKNOWN_NAME = /Unknown session "cleanup"/;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pss-session-resume-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

const manager = () => createSessionManager({ cwd: "/work", directory });

describe("resolveSessionSelector", () => {
  it("resolves a short id to the recorded session key", async () => {
    const sessions = manager();
    const created = await sessions.createSession();
    const shortId = created.key.slice(created.key.lastIndexOf("#") + 1);

    await expect(resolveSessionSelector(sessions, shortId)).resolves.toBe(
      created.key
    );
  });

  it("still resolves a full session key", async () => {
    const sessions = manager();
    const created = await sessions.createSession();

    await expect(resolveSessionSelector(sessions, created.key)).resolves.toBe(
      created.key
    );
  });

  it("rejects an unknown selector", async () => {
    const sessions = manager();
    await sessions.createSession();

    await expect(resolveSessionSelector(sessions, "zzzzzzzz")).rejects.toThrow(
      UNKNOWN_SESSION
    );
  });

  it("does not resolve a session name", async () => {
    const sessions = manager();
    const created = await sessions.createSession();
    await sessions.renameSession(created.key, "cleanup");

    await expect(resolveSessionSelector(sessions, "cleanup")).rejects.toThrow(
      UNKNOWN_NAME
    );
  });
});
