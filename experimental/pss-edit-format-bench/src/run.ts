import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { config as loadDotenv } from "dotenv";
import { EDIT_FORMATS, type EditFormat } from "./formats";
import { buildReport, type Attempt } from "./report";
import { runWithRecovery, type RecoveryModelCaller } from "./recovery";
import { EDIT_TASKS, type EditTask } from "./tasks";
import { extractFingerprint } from "./stats";

loadDotenv({ override: false, quiet: true });

const DEFAULT_MODELS = ["deepseek-ai/deepseek-v4-flash", "minimaxai/minimax-m3"];
const DEFAULT_RUNS = 3;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_REQUEST_ATTEMPTS = 4;
const DEFAULT_RECOVERY_ATTEMPTS = 0;
const RETRY_BASE_DELAY_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Runs thunks through a bounded pool. Free-tier endpoints reject or stall when
 * every attempt is dispatched at once, which shows up as request failures that
 * look like model errors, so the pool width is part of the measurement setup.
 */
async function pooled<T>(
  thunks: readonly (() => Promise<T>)[],
  width: number
): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < thunks.length) {
      const index = next;
      next += 1;
      const thunk = thunks[index];
      if (thunk !== undefined) {
        results[index] = await thunk();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(width, thunks.length) }, worker)
  );
  return results;
}

function parseArguments(argv: readonly string[]) {
  const options = {
    concurrency: DEFAULT_CONCURRENCY,
    disableThinking: false,
    formats: EDIT_FORMATS,
    models: DEFAULT_MODELS,
    recoveryAttempts: DEFAULT_RECOVERY_ATTEMPTS,
    requestAttempts: DEFAULT_REQUEST_ATTEMPTS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    runs: DEFAULT_RUNS,
    tasks: undefined as string[] | undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--models" && value) {
      options.models = value.split(",").map((entry) => entry.trim());
      index += 1;
    } else if (flag === "--formats" && value) {
      const names = value.split(",").map((entry) => entry.trim());
      const unknown = names.filter(
        (name) => !EDIT_FORMATS.some((format) => format.name === name)
      );
      if (unknown.length > 0) {
        throw new Error(`Unknown format(s): ${unknown.join(", ")}`);
      }
      options.formats = EDIT_FORMATS.filter((format) =>
        names.includes(format.name)
      );
      index += 1;
    } else if (flag === "--runs" && value) {
      options.runs = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === "--concurrency" && value) {
      options.concurrency = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === "--request-attempts" && value) {
      options.requestAttempts = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === "--request-timeout-ms" && value) {
      options.requestTimeoutMs = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === "--recovery" && value) {
      options.recoveryAttempts = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === "--tasks" && value) {
      options.tasks = value.split(",").map((entry) => entry.trim());
      index += 1;
    } else if (flag === "--disable-thinking") {
      options.disableThinking = true;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (
    !Number.isInteger(options.requestAttempts) ||
    options.requestAttempts < 1
  ) {
    throw new Error("--request-attempts must be a positive integer");
  }
  if (
    !Number.isInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs < 1000
  ) {
    throw new Error("--request-timeout-ms must be at least 1000");
  }
  if (
    !Number.isInteger(options.recoveryAttempts) ||
    options.recoveryAttempts < 0
  ) {
    throw new Error("--recovery must be a non-negative integer");
  }
  return options;
}

const classifyFailure = (
  applyError: string | undefined,
  produced: string | undefined,
  expected: string
): string => {
  if (applyError !== undefined) {
    return `unparsable: ${applyError}`;
  }
  if (produced === undefined) {
    return "unparsable: no output";
  }
  if (produced.replaceAll(/[ \t]+$/gmu, "") === expected.replaceAll(/[ \t]+$/gmu, "")) {
    return "trailing-whitespace";
  }
  if (produced.replaceAll(/\s+/gu, "") === expected.replaceAll(/\s+/gu, "")) {
    return "indentation";
  }
  return "wrong-content";
};

async function runAttempt({
  disableThinking,
  format,
  model,
  provider,
  recoveryAttempts,
  requestAttempts,
  requestTimeoutMs,
  run,
  task,
}: {
  /**
   * Reasoning models answer these edit prompts eventually, but K-EXAONE spends
   * minutes of thinking on a two-line edit and trips the request timeout, which
   * scores as a transport failure. Turning thinking off measures the same edit
   * behaviour the coding agent path uses.
   */
  readonly disableThinking: boolean;
  readonly format: EditFormat;
  readonly model: string;
  readonly provider: ReturnType<typeof createOpenAICompatible>;
  readonly recoveryAttempts: number;
  readonly requestAttempts: number;
  readonly requestTimeoutMs: number;
  readonly run: number;
  readonly task: EditTask;
}): Promise<Attempt> {
  const rendered = format.render(task.path, task.initial);
  const startedAt = Date.now();
  let lastError = "";
  let fixedTemperature = false;
  const userPrompt = `${rendered.user}\n\nTask: ${task.instruction}`;
  const callModel: RecoveryModelCaller = async (messages) => {
    const result = await generateText({
      abortSignal: AbortSignal.timeout(requestTimeoutMs),
      instructions: rendered.system,
      messages: messages.map((message) => {
        if (message.role === "assistant" && "toolCallId" in message) {
          return {
            role: "assistant",
            content: [
              { type: "text", text: message.content },
              {
                type: "tool-call",
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                input: { payload: message.content },
              },
            ],
          };
        }
        if (message.role === "tool") {
          return {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                output: { type: "text", value: message.output },
              },
            ],
          };
        }
        return { content: message.content, role: message.role };
      }),
      model: provider(model),
      ...(disableThinking
        ? {
            providerOptions: {
              bench: { chat_template_kwargs: { enable_thinking: false } },
            },
          }
        : {}),
      ...(fixedTemperature ? {} : { temperature: 0 }),
    });
    return { text: result.text };
  };
  for (let tries = 0; tries < requestAttempts; tries += 1) {
    if (tries > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (tries - 1));
      });
    }
    try {
      if (recoveryAttempts > 1) {
        const recovery = await runWithRecovery({
          apply: (reply, initial, path) => format.apply(reply, initial, path),
          callModel,
          expected: task.expected,
          initial: task.initial,
          maxAttempts: recoveryAttempts,
          path: task.path,
          renderFile: (path, content) => format.render(path, content).user,
          toolName: format.name,
          userPrompt,
        });
        const benchMetadata = null;
        return {
          durationMs: Date.now() - startedAt,
          fingerprint: benchMetadata,
          format: format.name,
          model,
          outputTokens: 0,
          passed: recovery.recovered,
          recovery: {
            attemptsUsed: recovery.attemptsUsed,
            firstAttemptFailed: recovery.firstAttemptFailed,
            recovered: recovery.recovered,
            repeatedFailure: recovery.repeatedFailure,
          },
          replyChars: 0,
          retries: tries,
          run,
          task: task.id,
          tolerances: [],
          ...(recovery.recovered
            ? {}
            : { failure: recovery.errorSequence[0] ?? "unrecovered" }),
        };
      }
      const result = await generateText({
        abortSignal: AbortSignal.timeout(requestTimeoutMs),
        instructions: rendered.system,
        messages: [
          {
            content: userPrompt,
            role: "user",
          },
        ],
        model: provider(model),
        ...(disableThinking
          ? {
              providerOptions: {
                bench: { chat_template_kwargs: { enable_thinking: false } },
              },
            }
          : {}),
        // Prefer temperature 0 for reproducibility, but some models reject any
        // value but their default; those are measured at that default instead
        // of being dropped from the matrix.
        ...(fixedTemperature ? {} : { temperature: 0 }),
      });
      const outcome = format.apply(result.text, task.initial, task.path);
      const passed = outcome.text === task.expected;
      const benchMetadata = result.providerMetadata?.bench as
        | { systemFingerprint?: string }
        | undefined;
      return {
        durationMs: Date.now() - startedAt,
        fingerprint: benchMetadata?.systemFingerprint ?? null,
        format: format.name,
        model,
        outputTokens: result.usage.outputTokens ?? 0,
        passed,
        replyChars: result.text.length,
        retries: tries,
        run,
        task: task.id,
        tolerances: outcome.tolerances ?? [],
        ...(passed
          ? {}
          : {
              failure: classifyFailure(
                outcome.error,
                outcome.text,
                task.expected
              ),
            }),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!fixedTemperature && /only supports temperature/iu.test(lastError)) {
        fixedTemperature = true;
        tries -= 1;
      }
    }
  }
  return {
    durationMs: Date.now() - startedAt,
    failure: `request: ${lastError}`,
    fingerprint: null,
    format: format.name,
    model,
    outputTokens: 0,
    passed: false,
    replyChars: 0,
    retries: requestAttempts,
    run,
    task: task.id,
    tolerances: [],
  };
}

const options = parseArguments(process.argv.slice(2));
const apiKey = process.env.AI_API_KEY;
const baseURL = process.env.AI_BASE_URL;
if (!apiKey || !baseURL) {
  throw new Error("AI_API_KEY and AI_BASE_URL are required");
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
  name: "bench",
});
const tasks = EDIT_TASKS.filter(
  (task) => options.tasks === undefined || options.tasks.includes(task.id)
);
if (tasks.length === 0) {
  throw new Error("No tasks matched the requested selection");
}

const pending: (() => Promise<Attempt>)[] = [];
for (const model of options.models) {
  for (const format of options.formats) {
    for (const task of tasks) {
      for (let run = 1; run <= options.runs; run += 1) {
        pending.push(() =>
          runAttempt({
            disableThinking: options.disableThinking,
            format,
            model,
            provider,
            recoveryAttempts: options.recoveryAttempts,
            requestAttempts: options.requestAttempts,
            requestTimeoutMs: options.requestTimeoutMs,
            run,
            task,
          })
        );
      }
    }
  }
}
process.stdout.write(
  `Running ${pending.length} attempts: ${options.models.length} models x ${options.formats.length} formats x ${tasks.length} tasks x ${options.runs} runs (concurrency ${options.concurrency}, timeout ${options.requestTimeoutMs}ms, up to ${options.requestAttempts} tries${options.recoveryAttempts > 1 ? `, up to ${options.recoveryAttempts} recovery attempts` : ""})\n`
);
const attempts = await pooled(pending, options.concurrency);
process.stdout.write(buildReport(attempts, options.models));
process.stdout.write("\n");
