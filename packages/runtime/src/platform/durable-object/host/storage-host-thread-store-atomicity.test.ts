import { describe, expect, it } from "vitest";
import type { ThreadStore } from "../../../thread/store/types";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage,
} from "./storage-host";

describe("Durable Object external thread stores", () => {
  it("rejects stores that cannot join the host transaction", () => {
    // Given: a thread store whose writes live outside Durable Object storage.
    const threadStore: ThreadStore = {
      commit: () => Promise.resolve({ ok: true, version: "external-1" }),
      delete: () => Promise.resolve(),
      load: () => Promise.resolve(null),
    };

    // When/Then: host construction fails before exposing non-atomic storage.
    expect(() =>
      createDurableObjectStorageHost({
        storage: new InMemoryDurableObjectStorage(),
        threadStore,
      })
    ).toThrow("external threadStore cannot join its atomic transactions");
  });
});
