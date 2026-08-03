import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const CSV_QUOTING_PATTERN = /[",\n]/u;
const USAGE_KEYS = [
  "cacheReadTokens",
  "cacheWriteTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
];

async function collectFiles(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(path, name);
      }
      return entry.name === name ? [path] : [];
    })
  );
  return nested.flat();
}

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function addUsage(total, usage) {
  for (const key of USAGE_KEYS) {
    total[key] += usage?.[key] ?? 0;
  }
  return total;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return;
  }
}

async function readTranscriptUsage(path) {
  const total = emptyUsage();
  const events = (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(parseJsonLine);
  for (const event of events) {
    if (event?.type === "result") {
      addUsage(total, event.result?.usage);
    }
  }
  return total;
}

async function readUsage(campaignDirectory) {
  const transcripts = await collectFiles(
    campaignDirectory,
    "transcript-raw.jsonl"
  );
  const usages = await Promise.all(transcripts.map(readTranscriptUsage));
  return usages.reduce(addUsage, emptyUsage());
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

async function readRunResults(evalDirectory) {
  const runResultPaths = await collectFiles(evalDirectory, "result.json");
  return Promise.all(
    runResultPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")))
  );
}

async function readEvalScore(summaryPath) {
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const evalDirectory = dirname(summaryPath);
  const results = summary.results ?? (await readRunResults(evalDirectory));
  const passedRuns =
    summary.passedRuns ??
    results.filter(
      (result) =>
        result.result?.status === "passed" || result.status === "passed"
    ).length;
  const totalRuns = summary.totalRuns ?? results.length;
  const durations = results
    .map((result) => result.result?.duration ?? result.duration)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  return {
    eval: summary.evalName ?? basename(evalDirectory),
    passed: passedRuns > 0,
    passedRuns,
    totalRuns,
    // agent-eval reports durations in seconds; normalize to milliseconds.
    meanDurationMs: Math.round(
      (summary.meanDuration ?? mean(durations)) * 1000
    ),
  };
}

export async function scoreCampaign(campaignDirectory) {
  const summaryPaths = await collectFiles(campaignDirectory, "summary.json");
  const perEval = await Promise.all(summaryPaths.map(readEvalScore));
  perEval.sort((left, right) => left.eval.localeCompare(right.eval));
  const totalAttempts = perEval.reduce(
    (total, result) => total + result.totalRuns,
    0
  );
  const passedAttempts = perEval.reduce(
    (total, result) => total + result.passedRuns,
    0
  );
  const passedEvals = perEval.filter((result) => result.passed).length;
  return {
    attemptPassRate: totalAttempts === 0 ? 0 : passedAttempts / totalAttempts,
    meanEvalDurationMs: mean(
      perEval
        .map((result) => result.meanDurationMs)
        .filter((duration) => duration > 0)
    ),
    officialScore: perEval.length === 0 ? 0 : passedEvals / perEval.length,
    passedAttempts,
    passedEvals,
    perEval,
    totalAttempts,
    totalEvals: perEval.length,
    usage: await readUsage(campaignDirectory),
  };
}

function csvValue(value) {
  const text = String(value);
  return CSV_QUOTING_PATTERN.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

export function formatScoreCsv(score) {
  const rows = [
    ["eval", "passed", "passed_runs", "total_runs", "mean_duration_ms"],
    ...score.perEval.map((result) => [
      result.eval,
      result.passed,
      result.passedRuns,
      result.totalRuns,
      Math.round(result.meanDurationMs),
    ]),
  ];
  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}
