import { readdir, readFile } from "node:fs/promises";

const RSS_PATTERN = /^VmHWM:\s+(\d+)\s+kB$/m;

export interface CelldProcessMetrics {
  readonly cpuSystemTicks: number;
  readonly cpuUserTicks: number;
  readonly maxRssBytes: number;
  readonly openFiles: number;
}

export async function readProcessMetrics(
  pid: number | undefined
): Promise<CelldProcessMetrics> {
  if (pid === undefined) {
    return { cpuSystemTicks: 0, cpuUserTicks: 0, maxRssBytes: 0, openFiles: 0 };
  }
  const [status, stat, fds] = await Promise.all([
    readFile(`/proc/${pid}/status`, "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
    readdir(`/proc/${pid}/fd`),
  ]);
  const rss = RSS_PATTERN.exec(status);
  const fields = stat.slice(stat.indexOf(")") + 2).split(" ");
  return {
    cpuSystemTicks: Number(fields[12] ?? 0),
    cpuUserTicks: Number(fields[11] ?? 0),
    maxRssBytes: Number(rss?.[1] ?? 0) * 1024,
    openFiles: fds.length,
  };
}
