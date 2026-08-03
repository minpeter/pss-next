import {
  type FileThreadInspection,
  type FileThreadInspectionCompaction,
  fileThreadStoragePath,
  inspectFileThread,
} from "@minpeter/pss-runtime/platform/file";
import type { CodingAgentThreadConfig } from "./thread-config";

export type ThreadInspectionCompaction = FileThreadInspectionCompaction;

export interface ThreadInspectionReport extends FileThreadInspection {
  readonly compactionMaxInputTokens: number;
  readonly compactions: readonly ThreadInspectionCompaction[];
}

export async function inspectCodingAgentThread(
  config: CodingAgentThreadConfig
): Promise<ThreadInspectionReport> {
  const inspection = await inspectFileThread({
    directory: config.directory,
    key: config.key,
  });

  return {
    compactionMaxInputTokens: config.compactionMaxInputTokens,
    ...inspection,
  };
}

export function formatThreadInspectionReport(
  report: ThreadInspectionReport
): string {
  const compactions =
    report.compactions.length === 0
      ? "compactions: none"
      : `compactions:\n${report.compactions
          .map(
            (record) =>
              `  - startSeq=${record.startSeq} endSeqExclusive=${record.endSeqExclusive} summaryBytes=${record.summaryBytes}`
          )
          .join("\n")}`;

  return [
    `threadKey: ${report.threadKey}`,
    `storageFile: ${report.storageFile}`,
    `version: ${report.version ?? "none"}`,
    `messageCount: ${report.messageCount}`,
    `compactionCount: ${report.compactionCount}`,
    compactions,
    `summaryBytes: ${report.summaryBytes}`,
    `compaction: enabled max=${report.compactionMaxInputTokens}`,
  ].join("\n");
}

export function storageFileForThread(directory: string, key: string): string {
  return fileThreadStoragePath({ directory, key });
}
