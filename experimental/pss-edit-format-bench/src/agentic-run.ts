import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config as loadDotenv } from "dotenv";
import type { AgenticAttempt } from "./agentic";
import { buildAgenticReport } from "./agentic-report";
import { createAgenticTraceWriter } from "./agentic-trace";
import { pooled } from "./harness/pool";
import {
  type MethodAttemptOptions,
  runMethodAttempt,
} from "./harness/run-attempt";
import { resolveEditMethods } from "./methods";
import { extractFingerprint } from "./stats";
import { EDIT_TASKS } from "./tasks";

loadDotenv({ override: false, quiet: true });

const DEFAULT_MODEL = "minimaxai/minimax-m3";
const DEFAULT_RUNS = 10;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_REQUEST_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_EVIDENCE_DIR = "../../../.omo/evidence/20260803-agentic-pss";

interface OptionState {
  concurrency: number;
  disableThinking: boolean;
  evidenceDir: string;
  maxSteps: number;
  methods: readonly string[] | undefined;
  model: string;
  requestAttempts: number;
  requestTimeoutMs: number;
  runs: number;
  tasks: readonly string[] | undefined;
}

type Options = Readonly<OptionState>;

const valueAfter = (argv: readonly string[], index: number): string => {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${argv[index]}`);
  }
  return value;
};

const applyValueOption = (
  options: OptionState,
  flag: string,
  value: string
): boolean => {
  switch (flag) {
    case "--model":
      options.model = value;
      return true;
    case "--runs":
      options.runs = Number.parseInt(value, 10);
      return true;
    case "--concurrency":
      options.concurrency = Number.parseInt(value, 10);
      return true;
    case "--request-attempts":
      options.requestAttempts = Number.parseInt(value, 10);
      return true;
    case "--request-timeout-ms":
      options.requestTimeoutMs = Number.parseInt(value, 10);
      return true;
    case "--max-steps":
      options.maxSteps = Number.parseInt(value, 10);
      return true;
    case "--tasks":
      options.tasks = value.split(",").map((task) => task.trim());
      return true;
    case "--methods":
      options.methods = value.split(",").map((method) => method.trim());
      return true;
    case "--evidence-dir":
      options.evidenceDir = value;
      return true;
    default:
      return false;
  }
};

const parseOptions = (argv: readonly string[]): Options => {
  const options: OptionState = {
    concurrency: DEFAULT_CONCURRENCY,
    disableThinking: false,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    maxSteps: DEFAULT_MAX_STEPS,
    methods: undefined,
    model: DEFAULT_MODEL,
    requestAttempts: DEFAULT_REQUEST_ATTEMPTS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    runs: DEFAULT_RUNS,
    tasks: undefined as readonly string[] | undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--disable-thinking") {
      options.disableThinking = true;
      continue;
    }
    const value = valueAfter(argv, index);
    if (!applyValueOption(options, flag, value)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    index += 1;
  }
  for (const [name, value] of [
    ["runs", options.runs],
    ["concurrency", options.concurrency],
    ["requestAttempts", options.requestAttempts],
    ["requestTimeoutMs", options.requestTimeoutMs],
    ["maxSteps", options.maxSteps],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return options;
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (apiKey === undefined || baseURL === undefined) {
    throw new Error("AI_API_KEY and AI_BASE_URL are required");
  }
  const methods = resolveEditMethods(options.methods);
  const tasks = EDIT_TASKS.filter(
    (task) => options.tasks === undefined || options.tasks.includes(task.id)
  );
  if (tasks.length === 0) {
    throw new Error("No tasks matched --tasks");
  }
  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    metadataExtractor: {
      createStreamExtractor: () => ({
        buildMetadata: () => undefined,
        processChunk: () => undefined,
      }),
      extractMetadata: ({ parsedBody }) => {
        const fingerprint = extractFingerprint(parsedBody);
        return Promise.resolve({
          bench: fingerprint === null ? {} : { systemFingerprint: fingerprint },
        });
      },
    },
    name: "agentic-bench",
  });
  const evidenceDir = resolve(
    dirname(import.meta.filename),
    options.evidenceDir
  );
  const methodLabel = methods.map((method) => method.id).join("+");
  const transcriptPath = resolve(
    evidenceDir,
    `agentic-${options.model.replaceAll("/", "_")}-${methodLabel}.jsonl`
  );
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(transcriptPath, "", "utf8");
  const writeTrace = createAgenticTraceWriter(transcriptPath);
  const pending: Array<() => Promise<AgenticAttempt>> = [];
  for (const method of methods) {
    for (const task of tasks) {
      for (let run = 1; run <= options.runs; run += 1) {
        const runOptions: MethodAttemptOptions = {
          disableThinking: options.disableThinking,
          maxSteps: options.maxSteps,
          method,
          model: options.model,
          provider,
          requestAttempts: options.requestAttempts,
          requestTimeoutMs: options.requestTimeoutMs,
          run,
          task,
          trace: writeTrace,
        };
        pending.push(() => runMethodAttempt(runOptions));
      }
    }
  }
  process.stdout.write(
    `Running ${pending.length} agentic attempts: ${options.model} x [${methods.map((m) => m.id).join(", ")}] x ${tasks.length} tasks x ${options.runs} runs (concurrency ${options.concurrency}, max steps ${options.maxSteps})\n`
  );
  let completed = 0;
  let transcriptWrites = Promise.resolve();
  const attempts = await pooled(
    pending,
    options.concurrency,
    async (attempt) => {
      transcriptWrites = transcriptWrites.then(() =>
        appendFile(
          transcriptPath,
          `${JSON.stringify({ attempt, type: "attempt_result" })}\n`,
          "utf8"
        )
      );
      await transcriptWrites;
      completed += 1;
      process.stdout.write(
        `[${completed}/${pending.length}] ${attempt.format} ${attempt.task}#${attempt.run} ${attempt.passed ? "PASS" : "FAIL"} reads=${attempt.readCalls} edits=${attempt.editCalls} steps=${attempt.steps} retries=${attempt.retryFailures.length}\n`
      );
    }
  );
  const report = buildAgenticReport(attempts);
  await writeFile(
    resolve(
      evidenceDir,
      `agentic-${options.model.replaceAll("/", "_")}-${methodLabel}.md`
    ),
    `${report}\n`,
    "utf8"
  );
  process.stdout.write(`\n${report}\n`);
};

await main();
