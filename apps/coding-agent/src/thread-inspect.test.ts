import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatThreadInspectionReport,
  inspectCodingAgentThread,
  storageFileForThread,
} from "./thread-inspect";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pss-coding-agent-inspect-"));
}

describe("thread inspection", () => {
  it("reports schemaVersion 2 compaction records from local thread storage", async () => {
    const directory = await tempDir();
    const key = "inspect:key";
    const summary = { content: "old context summarized", role: "system" };
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
    const storageFile = storageFileForThread(directory, key);

    try {
      await mkdir(dirname(storageFile), { recursive: true });
      await writeFile(
        storageFile,
        `${JSON.stringify(
          {
            state: {
              compactions: [
                {
                  endSeqExclusive: 2,
                  schemaVersion: 1,
                  startSeq: 0,
                  summary,
                },
              ],
              history: [
                { content: "one", role: "user" },
                { content: "two", role: "assistant" },
                { content: "three", role: "user" },
              ],
              schemaVersion: 2,
            },
            version: "7",
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const report = await inspectCodingAgentThread({
        autoCompaction: { maxInputTokens: 64_000 },
        directory,
        key,
      });

      expect(formatThreadInspectionReport(report)).toBe(`threadKey: inspect:key
storageFile: ${storageFile}
version: 7
messageCount: 3
compactionCount: 1
compactions:
  - startSeq=0 endSeqExclusive=2 summaryBytes=${summaryBytes}
summaryBytes: ${summaryBytes}
autoCompaction: auto max=64000`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports zero counts for a missing local thread", async () => {
    const directory = await tempDir();
    const key = "missing:key";

    try {
      const report = await inspectCodingAgentThread({
        autoCompaction: undefined,
        directory,
        key,
      });

      expect(formatThreadInspectionReport(report)).toBe(`threadKey: missing:key
storageFile: ${storageFileForThread(directory, key)}
version: none
messageCount: 0
compactionCount: 0
compactions: none
summaryBytes: 0
autoCompaction: auto`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
