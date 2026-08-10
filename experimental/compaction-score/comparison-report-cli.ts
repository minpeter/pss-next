import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ComparisonArtifactError,
  renderComparisonMarkdown,
} from "./comparison-report";

const HELP = `Usage: pnpm table -- COMPARISON_JSON

Render a human-readable PSS vs pi-coding-agent table from comparison.json.`;

interface ComparisonReportCliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

const processIo: ComparisonReportCliIo = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

export async function runComparisonReportCli(
  args: readonly string[],
  io: ComparisonReportCliIo = processIo
): Promise<number> {
  const positional = args[0] === "--" ? args.slice(1) : args;
  if (positional.length === 1 && positional[0] === "--help") {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  const path = positional[0];
  if (positional.length !== 1 || path === undefined) {
    io.stderr(`${HELP}\n`);
    return 2;
  }

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    io.stderr("COMPARISON_ARTIFACT_READ_FAILED\n");
    return 1;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    io.stderr("COMPARISON_ARTIFACT_JSON_INVALID\n");
    return 1;
  }

  try {
    io.stdout(renderComparisonMarkdown(value));
    return 0;
  } catch (error) {
    if (error instanceof ComparisonArtifactError) {
      io.stderr("COMPARISON_ARTIFACT_INVALID\n");
      return 1;
    }
    throw error;
  }
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await runComparisonReportCli(process.argv.slice(2));
}
