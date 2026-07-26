import { describe, expect, it } from "vitest";
import { assistantMessage, userText } from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { ModelMessageHistory } from "./history";
import {
  decodeStoredThreadSnapshot,
  decodeStoredThreadState,
  encodeThreadSnapshot,
  ThreadCompactionValidationError,
  ThreadStateValidationError,
} from "./snapshot";

describe("thread snapshot", () => {
  it("encodes model continuation state as a versioned runtime snapshot", () => {
    const history = [assistantMessage("DONE")];
    const snapshot = encodeThreadSnapshot(history);

    expect(snapshot).toEqual({
      history,
      schemaVersion: 1,
    });
    expect(snapshot.history).not.toBe(history);
  });

  it("decodes missing threads to empty continuation state", () => {
    expect(decodeStoredThreadSnapshot(null)).toEqual([]);
  });

  it("decodes cloned v1 snapshots from opaque stored state", () => {
    const history = [assistantMessage("persisted")];
    const decoded = decodeStoredThreadSnapshot({
      state: { history, schemaVersion: 1 },
      version: "1",
    });

    expect(decoded).toEqual(history);
    expect(decoded).not.toBe(history);
  });

  it("encodes v2 snapshots only when compactions exist", () => {
    const history = [
      userTextToModelMessage(userText("old")),
      assistantMessage("ok"),
    ];
    const snapshot = encodeThreadSnapshot(history, [
      {
        endSeqExclusive: 1,
        schemaVersion: 1,
        startSeq: 0,
        summary: { content: "old turns summarized", role: "system" },
      },
    ]);

    expect(snapshot).toEqual({
      compactions: [
        {
          endSeqExclusive: 1,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "old turns summarized", role: "system" },
        },
      ],
      history,
      schemaVersion: 2,
    });
  });

  it("decodes v2 snapshots with compacted context while preserving full history", () => {
    const history = [
      userTextToModelMessage(userText("old 1")),
      assistantMessage("old 2"),
      userTextToModelMessage(userText("tail")),
    ];
    const decoded = decodeStoredThreadState({
      state: {
        compactions: [
          {
            endSeqExclusive: 2,
            schemaVersion: 1,
            startSeq: 0,
            summary: { content: "summary", role: "system" },
          },
        ],
        history,
        schemaVersion: 2,
      },
      version: "1",
    });

    expect(decoded.history).toEqual(history);
    expect(
      new ModelMessageHistory(
        decoded.history,
        undefined,
        decoded.compactions
      ).modelContextSnapshot()
    ).toEqual([
      {
        endSeqExclusive: 2,
        role: "compaction",
        startSeq: 0,
        summary: "summary",
      },
      userTextToModelMessage(userText("tail")),
    ]);
  });

  it("encodes and decodes v3 snapshots with applied migrations", () => {
    const history = [assistantMessage("sanitized")];
    const snapshot = encodeThreadSnapshot(history, [], {
      "workspace/sanitize": 2,
    });

    expect(snapshot).toEqual({
      appliedMigrations: { "workspace/sanitize": 2 },
      compactions: [],
      history,
      schemaVersion: 3,
    });
    expect(decodeStoredThreadState({ state: snapshot, version: "3" })).toEqual({
      appliedMigrations: { "workspace/sanitize": 2 },
      compactions: [],
      history,
    });
  });

  it("rejects malformed applied migration versions", () => {
    expect(() =>
      decodeStoredThreadState({
        state: {
          appliedMigrations: { "workspace/sanitize": 0 },
          compactions: [],
          history: [],
          schemaVersion: 3,
        },
        version: "3",
      })
    ).toThrow("Unsupported stored thread state");
  });

  it("prefers newer overlapping compactions in model context", () => {
    const history = [
      userTextToModelMessage(userText("old 1")),
      assistantMessage("old 2"),
      userTextToModelMessage(userText("old 3")),
      assistantMessage("tail"),
    ];
    const modelHistory = new ModelMessageHistory(history, undefined, [
      {
        endSeqExclusive: 2,
        schemaVersion: 1,
        startSeq: 0,
        summary: { content: "older summary", role: "system" },
      },
      {
        endSeqExclusive: 3,
        schemaVersion: 1,
        startSeq: 1,
        summary: { content: "newer summary", role: "system" },
      },
    ]);

    expect(modelHistory.modelContextSnapshot()).toEqual([
      userTextToModelMessage(userText("old 1")),
      {
        endSeqExclusive: 3,
        role: "compaction",
        startSeq: 1,
        summary: "newer summary",
      },
      assistantMessage("tail"),
    ]);
  });

  it("rejects malformed thread compaction records", () => {
    expect(() =>
      decodeStoredThreadState({
        state: {
          compactions: [
            {
              endSeqExclusive: 0,
              schemaVersion: 1,
              startSeq: 0,
              summary: { content: "summary", role: "system" },
            },
          ],
          history: [],
          schemaVersion: 2,
        },
        version: "1",
      })
    ).toThrow(ThreadCompactionValidationError);
  });

  it("keeps model-message shape validation inside thread state", () => {
    const malformed = { role: "assistant" } as never;

    expect(() => encodeThreadSnapshot([malformed])).toThrow(
      ThreadStateValidationError
    );
    expect(() =>
      decodeStoredThreadState({
        state: { history: [malformed], schemaVersion: 1 },
        version: "1",
      })
    ).toThrow(ThreadStateValidationError);
    expect(() =>
      new ModelMessageHistory().appendModelMessage(malformed)
    ).toThrow(ThreadStateValidationError);
  });

  it("rejects unsupported stored thread state versions", () => {
    expect(() =>
      decodeStoredThreadSnapshot({
        state: { history: [], schemaVersion: 2 },
        version: "1",
      })
    ).toThrow("Unsupported stored thread state");
  });
});
