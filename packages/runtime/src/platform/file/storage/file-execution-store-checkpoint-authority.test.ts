import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileExecutionStore } from "./file-execution-store";
import { FileRunStore } from "./file-execution-store/run-store";
import {
  base64Url,
  checkpointRecord,
  currentDataDirectory,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

const CHECKPOINT_APPENDERS = [
  [
    "legacy append",
    (store: FileExecutionStore, runId: string) =>
      store.checkpoints.append(checkpointRecord(runId, 1), {
        expectedVersion: 0,
      }),
  ],
  [
    "fenced append",
    (store: FileExecutionStore, runId: string) =>
      store.leaseFencedCheckpoints.appendFenced(checkpointRecord(runId, 1), {
        expectedLeaseId: null,
        expectedVersion: 0,
      }),
  ],
] as const;

describe("FileExecutionStore checkpoint authority", () => {
  it("rejects a fenced append when the addressed run file has foreign identity", async () => {
    // Given: the addressed file contains a valid record for another run.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const addressedRunId = "addressed-run";
    const foreignRunId = "foreign-run";
    await store.turns.create(runRecord(addressedRunId));
    const dataDirectory = await currentDataDirectory(directory);
    await writeFile(
      join(dataDirectory, "runs", `${base64Url(addressedRunId)}.json`),
      `${JSON.stringify(runRecord(foreignRunId))}\n`,
      "utf8"
    );

    // When: a fenced write addresses the corrupted file key.
    const result = await store.leaseFencedCheckpoints.appendFenced(
      checkpointRecord(addressedRunId, 1),
      { expectedLeaseId: null, expectedVersion: 0 }
    );

    // Then: no addressed payload or foreign authority write escapes.
    expect(result).toEqual({ ok: false, reason: "not-found" });
    await expect(store.checkpoints.latest(addressedRunId)).resolves.toBeNull();
    await expect(store.turns.get(foreignRunId)).resolves.toBeNull();
    await expect(
      readdir(
        join(
          await currentDataDirectory(directory),
          "checkpoints",
          base64Url(addressedRunId)
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(CHECKPOINT_APPENDERS)(
    "discards staged payload when %s cannot publish run authority",
    async (_caseName, append) => {
      // Given: a run at version zero and a failure injected after its staged
      // checkpoint payload is written but before run authority can advance.
      const directory = await tempDir();
      const runId = "run:failed-publication";
      const store = new FileExecutionStore(directory);
      await store.turns.create(runRecord(runId));
      const generationBefore = await generationId(directory);
      let stagedPayloadObserved = false;
      const update = vi
        .spyOn(FileRunStore.prototype, "updateCheckpointVersion")
        .mockImplementationOnce(async () => {
          const stagedGeneration = (
            await readdir(join(directory, "generations"))
          ).find((candidate) => candidate !== generationBefore);
          if (!stagedGeneration) {
            throw new Error("Expected a staged checkpoint generation.");
          }
          const payload = await readFile(
            join(
              directory,
              "generations",
              stagedGeneration,
              "checkpoints",
              base64Url(runId),
              "1.json"
            ),
            "utf8"
          );
          stagedPayloadObserved = payload.includes(
            checkpointRecord(runId, 1).checkpointId
          );
          throw new Error("injected run-version failure");
        });

      // When: standalone append reaches the run-version write.
      try {
        await expect(append(store, runId)).rejects.toThrow(
          "injected run-version failure"
        );
      } finally {
        update.mockRestore();
      }

      // Then: staging contained the payload, but no generation was published.
      expect(stagedPayloadObserved).toBe(true);
      expect(await generationId(directory)).toBe(generationBefore);
      await expect(store.turns.get(runId)).resolves.toMatchObject({
        checkpointVersion: 0,
      });
      await expect(store.checkpoints.latest(runId)).resolves.toBeNull();
      await expect(
        readdir(
          join(
            await currentDataDirectory(directory),
            "checkpoints",
            base64Url(runId)
          )
        )
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("ignores an abandoned staged generation after reopen", async () => {
    // Given: the authoritative generation has version zero while an
    // unreferenced staging generation contains a newer run and checkpoint.
    const directory = await tempDir();
    const runId = "run:abandoned-staging";
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord(runId));
    const generationBefore = await generationId(directory);
    const stagingDirectory = join(
      directory,
      "generations",
      "transaction-abandoned"
    );
    await mkdir(join(stagingDirectory, "runs"), { recursive: true });
    await mkdir(join(stagingDirectory, "checkpoints", base64Url(runId)), {
      recursive: true,
    });
    await writeFile(
      join(stagingDirectory, "runs", `${base64Url(runId)}.json`),
      `${JSON.stringify(runRecord(runId, { checkpointVersion: 1 }))}\n`,
      "utf8"
    );
    await writeFile(
      join(stagingDirectory, "checkpoints", base64Url(runId), "1.json"),
      `${JSON.stringify(checkpointRecord(runId, 1))}\n`,
      "utf8"
    );

    // When: a new store opens the directory.
    const reopened = new FileExecutionStore(directory);

    // Then: only the generation named by .current-generation is visible.
    expect(await generationId(directory)).toBe(generationBefore);
    await expect(reopened.turns.get(runId)).resolves.toMatchObject({
      checkpointVersion: 0,
    });
    await expect(reopened.checkpoints.latest(runId)).resolves.toBeNull();
  });

  it("publishes standalone checkpoint and run-version writes in one generation", async () => {
    // Given: a persisted run in the current generation.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord("run:atomic"));
    const generationBefore = await generationId(directory);

    // When: the standalone checkpoint port appends version one.
    await store.checkpoints.append(checkpointRecord("run:atomic", 1), {
      expectedVersion: 0,
    });

    // Then: one generation publication exposes both authority and payload.
    expect(await generationId(directory)).not.toBe(generationBefore);
    await expect(store.turns.get("run:atomic")).resolves.toMatchObject({
      checkpointVersion: 1,
    });
    await expect(store.checkpoints.latest("run:atomic")).resolves.toEqual(
      checkpointRecord("run:atomic", 1)
    );
  });

  it("ignores an orphan checkpoint when run authority is zero", async () => {
    // Given: a run at version zero and a higher legacy orphan file.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord("run:orphan-zero"));
    await writeCheckpointFile(
      directory,
      checkpointRecord("run:orphan-zero", 9)
    );

    // When: latest resolves the authoritative checkpoint.
    const latest = store.checkpoints.latest("run:orphan-zero");

    // Then: the uncommitted orphan is invisible.
    await expect(latest).resolves.toBeNull();
  });

  it("ignores an orphan newer than the authoritative run version", async () => {
    // Given: version one was committed, then a legacy orphan version two exists.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(runRecord("run:orphan-newer"));
    await store.checkpoints.append(checkpointRecord("run:orphan-newer", 1), {
      expectedVersion: 0,
    });
    await writeCheckpointFile(
      directory,
      checkpointRecord("run:orphan-newer", 2)
    );

    // When: latest resolves the authoritative checkpoint.
    const latest = store.checkpoints.latest("run:orphan-newer");

    // Then: run version one wins over the directory maximum.
    await expect(latest).resolves.toEqual(
      checkpointRecord("run:orphan-newer", 1)
    );
  });

  it("reports corruption when positive run authority has no checkpoint", async () => {
    // Given: persisted run authority references a missing checkpoint payload.
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.turns.create(
      runRecord("run:missing-checkpoint", { checkpointVersion: 3 })
    );

    // When: latest resolves the authoritative checkpoint.
    const latest = store.checkpoints.latest("run:missing-checkpoint");

    // Then: missing committed data is reported as corruption.
    await expect(latest).rejects.toMatchObject({
      checkpointVersion: 3,
      name: "FileCheckpointCorruptionError",
      runId: "run:missing-checkpoint",
    });
  });
});

async function generationId(directory: string): Promise<string> {
  return (
    await readFile(join(directory, ".current-generation"), "utf8")
  ).trim();
}

async function writeCheckpointFile(
  directory: string,
  checkpoint: ReturnType<typeof checkpointRecord>
): Promise<void> {
  const checkpointDirectory = join(
    await currentDataDirectory(directory),
    "checkpoints",
    base64Url(checkpoint.runId)
  );
  await mkdir(checkpointDirectory, { recursive: true });
  await writeFile(
    join(checkpointDirectory, `${checkpoint.version}.json`),
    `${JSON.stringify(checkpoint)}\n`,
    "utf8"
  );
}
