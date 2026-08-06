import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatJsonReport, formatTextReport } from "./format";
import { runEvals } from "./runner";

const HELP = `pss-eval - run agent evals against the real @minpeter/pss-runtime agent

Usage:
  pss-eval [filter...] [options]

A "filter" is a substring or /regexp/ matched against each eval id. With no
filters, every registered eval runs.

Options:
  --dir <path>   discovery root (default: ./evals; repeatable)
  --tag <name>   only run evals carrying this tag (repeatable)
  --json         emit machine-readable JSON instead of the text summary
  --strict       soft-threshold misses also fail (exit non-zero)
  --cwd <path>   working directory (default: process.cwd())
  -h, --help     show this help

Exit codes:
  0  all evals passed
  1  at least one eval failed
  2  configuration error (no eval files discovered)`;

export interface ParsedArgs {
  readonly asJson: boolean;
  readonly cwd: string;
  readonly dirs: readonly string[];
  readonly filters: readonly string[];
  readonly help: boolean;
  readonly strict: boolean;
  readonly tags: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const filters: string[] = [];
  const dirs: string[] = [];
  const tags: string[] = [];
  let cwd = process.cwd();
  let asJson = false;
  let help = false;
  let strict = false;

  const args = [...argv];
  let i = 0;
  while (i < args.length) {
    const arg = args[i++];
    if (arg === undefined) {
      break;
    }
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--json":
        asJson = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--cwd":
        cwd = args[i++] ?? cwd;
        break;
      case "--dir":
        dirs.push(args[i++] ?? "");
        break;
      case "--tag":
        tags.push(args[i++] ?? "");
        break;
      default:
        filters.push(arg);
        break;
    }
  }

  return { asJson, cwd, dirs, filters, help, strict, tags };
}

/** Combine CLI filter fragments into a single id matcher. */
export function compileFilters(
  filters: readonly string[]
): string | RegExp | undefined {
  if (filters.length === 0) {
    return;
  }
  if (filters.length === 1) {
    const [filter] = filters;
    return filter === undefined ? undefined : toPattern(filter);
  }
  const combined = filters
    .map((f) => {
      const pattern = regexFilterForm.exec(f);
      return pattern?.[1] ?? escapeRegExp(f);
    })
    .join("|");
  return new RegExp(combined);
}

function toPattern(filter: string): string | RegExp {
  const pattern = regexFilterForm.exec(filter);
  const source = pattern?.[1];
  return source === undefined ? filter : new RegExp(source, pattern?.[2]);
}

function escapeRegExp(value: string): string {
  return value.replace(regexMetachars, "\\$&");
}

const regexFilterForm = /^\/(.+)\/([gimsuy]*)$/;
const regexMetachars = /[.*+?^${}()|[\]\\]/g;

function resolveRoot(root: string, cwd: string): string {
  const trimmed = root.trim();
  return isAbsolute(trimmed) ? trimmed : join(cwd, trimmed);
}

/** Recursively collect `*.eval.ts` files under the given roots. */
export async function discoverEvalFiles(
  roots: readonly string[]
): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    try {
      const entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".eval.ts")) {
          found.add(join(entry.parentPath, entry.name));
        }
      }
    } catch {
      // Missing or unreadable roots are skipped silently.
    }
  }
  return [...found].sort();
}

/**
 * Run the CLI. Returns the process exit code instead of calling `process.exit`
 * directly, so it is testable.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const roots =
    args.dirs.length > 0
      ? args.dirs.map((dir) => resolveRoot(dir, args.cwd))
      : [join(args.cwd, "evals")];

  const files = await discoverEvalFiles(roots);
  if (files.length === 0) {
    process.stderr.write(
      `pss-eval: no .eval.ts files found under: ${roots.join(", ")}\n`
    );
    return 2;
  }

  for (const file of files) {
    await import(pathToFileURL(file).href);
  }

  const report = await runEvals({
    filter: compileFilters(args.filters),
    strict: args.strict,
    tags: args.tags,
  });

  const output = args.asJson
    ? formatJsonReport(report)
    : formatTextReport(report);
  process.stdout.write(`${output}\n`);

  return report.failed === 0 ? 0 : 1;
}
