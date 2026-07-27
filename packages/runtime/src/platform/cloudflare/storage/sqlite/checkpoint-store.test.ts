import { describe, expect, it } from "vitest";
import type { TurnRecord } from "../../../../execution";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import {
  type CloudflareDurableObjectStorage,
  InMemoryCloudflareDurableObjectStorage,
} from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import { DurableObjectRunStore } from "../execution/run-store";
import {
  type DurableObjectSqliteCheckpointStore as CheckpointStoreType,
  DurableObjectSqliteCheckpointStore,
} from "./checkpoint-store";

const PREFIX = "pss-runtime";
const REQUIRES_SQLITE = /SQLite-backed/;

interface CheckpointRowProbe {
  readonly checkpoint: string;
  readonly version: number;
}

function checkpoint(
  runId: string,
  version: number,
  overrides: Partial<{
    checkpointId: string;
    phase: "before-model" | "after-tool";
    runtimeState: unknown;
    threadSnapshot: unknown;
  }> = {}
): Parameters<CheckpointStoreType["append"]>[0] {
  return {
    checkpointId: overrides.checkpointId ?? `checkpoint-${version}`,
    phase: overrides.phase ?? "before-model",
    runId,
    runtimeState: overrides.runtimeState ?? {},
    threadSnapshot: overrides.threadSnapshot ?? {},
    version,
  };
}

function createRun(runId = "run-1"): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
  };
}

async function createRanStore(
  runId = "run-1",
  options: { readonly maxPayloadBytes?: number } = {}
): Promise<{
  readonly storage: InMemoryCloudflareDurableObjectStorage;
  readonly store: DurableObjectSqliteCheckpointStore;
}> {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const runs = new DurableObjectRunStore(storage, PREFIX);
  await runs.create(createRun(runId));
  const store = new DurableObjectSqliteCheckpointStore(
    storage,
    PREFIX,
    options
  );
  return { storage, store };
}

function readRows(
  storage: InMemoryCloudflareDurableObjectStorage,
  runId: string
): CheckpointRowProbe[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<CheckpointRowProbe>(
      "SELECT version, checkpoint FROM pss_checkpoint WHERE run_key = ? ORDER BY version",
      storeKey(PREFIX, "checkpoints", runId)
    )
    .toArray();
}

describe("DurableObjectSqliteCheckpointStore", () => {
  it("throws when the Durable Object is not SQLite-backed", () => {
    expect(
      () =>
        new DurableObjectSqliteCheckpointStore(
          {} as CloudflareDurableObjectStorage,
          PREFIX
        )
    ).toThrow(REQUIRES_SQLITE);
  });

  it("appends a checkpoint as one row and returns the version", async () => {
    const { store, storage } = await createRanStore();

    const result = await store.append(checkpoint("run-1", 1), {
      expectedVersion: 0,
    });

    expect(result).toEqual({ ok: true, version: 1 });
    const rows = readRows(storage, "run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].checkpoint).toBe(JSON.stringify(checkpoint("run-1", 1)));
  });

  it("returns the latest checkpoint by version", async () => {
    const { store } = await createRanStore();
    await store.append(checkpoint("run-1", 1), { expectedVersion: 0 });
    await store.append(checkpoint("run-1", 2), { expectedVersion: 1 });
    await store.append(checkpoint("run-1", 3), { expectedVersion: 2 });

    await expect(store.latest("run-1")).resolves.toMatchObject({
      checkpointId: "checkpoint-3",
      version: 3,
    });
  });

  it("returns null for the latest checkpoint of an unknown run", async () => {
    const { store } = await createRanStore();
    await expect(store.latest("missing")).resolves.toBeNull();
  });

  it("rejects stale-version writes", async () => {
    const { store, storage } = await createRanStore();

    const first = await store.append(checkpoint("run-1", 1), {
      expectedVersion: 0,
    });
    const stale = await store.append(checkpoint("run-1", 2), {
      expectedVersion: 0,
    });

    expect(first).toEqual({ ok: true, version: 1 });
    expect(stale).toEqual({
      currentVersion: 1,
      ok: false,
      reason: "stale-version",
    });
    // Nothing was written for the rejected append: only the first checkpoint row exists.
    expect(readRows(storage, "run-1")).toHaveLength(1);
  });

  it("chunks checkpoint rows that exceed the serialized payload budget", async () => {
    const { storage, store } = await createRanStore("run-1", {
      maxPayloadBytes: 220,
    });
    const value = checkpoint("run-1", 1, {
      runtimeState: { notes: "x".repeat(300) },
    });

    await expect(store.append(value, { expectedVersion: 0 })).resolves.toEqual({
      ok: true,
      version: 1,
    });
    await expect(store.latest("run-1")).resolves.toEqual(value);
    const chunkRows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM pss_payload_chunk WHERE scope = ?",
        "checkpoint"
      )
      .toArray()[0];
    expect(chunkRows?.count).toBeGreaterThan(0);
  });

  it("appends many checkpoints without losing earlier ones", async () => {
    const { store, storage } = await createRanStore();
    for (let version = 1; version <= 5; version += 1) {
      await store.append(checkpoint("run-1", version), {
        expectedVersion: version - 1,
      });
    }

    const rows = readRows(storage, "run-1");
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    await expect(store.latest("run-1")).resolves.toMatchObject({ version: 5 });
  });

  it("isolates checkpoints by run id", async () => {
    const { store } = await createRanStore("run-1");
    const { storage } = await (async () => {
      const storage = new InMemoryCloudflareDurableObjectStorage({
        sql: new InMemorySqlStorage(),
      });
      await new DurableObjectRunStore(storage, PREFIX).create(
        createRun("run-2")
      );
      return { storage };
    })();
    const secondStore = new DurableObjectSqliteCheckpointStore(storage, PREFIX);

    await store.append(checkpoint("run-1", 1), { expectedVersion: 0 });
    await secondStore.append(checkpoint("run-2", 1), { expectedVersion: 0 });

    await expect(store.latest("run-1")).resolves.toMatchObject({ version: 1 });
    expect(readRows(storage, "run-1")).toEqual([]);
    expect(readRows(storage, "run-2")).toHaveLength(1);
  });

  it("round-trips checkpoints whose snapshot payload exceeds the 2MB blob limit", async () => {
    // Guards against SQLITE_TOOBIG-style accumulation failures:
    // each checkpoint embeds a full thread snapshot, and many tool-call
    // checkpoints past the ~2.2MB threshold blew up a single re-written value.
    const { store } = await createRanStore();
    const big = "x".repeat(120_000);

    for (let version = 1; version <= 20; version += 1) {
      await store.append(
        checkpoint("run-1", version, {
          threadSnapshot: { history: [big] },
        }),
        { expectedVersion: version - 1 }
      );
    }

    const latest = await store.latest("run-1");
    expect(latest).toMatchObject({ version: 20 });
    const snapshot = latest?.threadSnapshot as { history: string[] };
    expect(snapshot.history[0]).toHaveLength(120_000);
  });

  it("preserves full checkpoint fidelity (runtime state, phase, id)", async () => {
    const { store } = await createRanStore();
    const full = checkpoint("run-1", 1, {
      checkpointId: "cp-abc",
      phase: "after-tool",
      runtimeState: { toolCallId: "call_1", toolName: "web_search" },
      threadSnapshot: { history: [{ role: "user", content: "hi" }] },
    });

    await store.append(full, { expectedVersion: 0 });

    await expect(store.latest("run-1")).resolves.toEqual(full);
  });
});
