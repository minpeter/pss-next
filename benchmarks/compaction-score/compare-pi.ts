/**
 * Head-to-head comparison: pss runtime compaction vs pi-coding-agent default
 * compaction, on the same fixtures, cut points, evaluator, and scorer.
 *
 * The pi arm replicates the pi-coding-agent protocol verbatim:
 * - serialized `<conversation>` text (tool results truncated to 2000 chars),
 * - pi SUMMARIZATION_SYSTEM_PROMPT + SUMMARIZATION_PROMPT,
 * - UPDATE_SUMMARIZATION_PROMPT with `<previous-summary>` on later hops,
 * - `<read-files>` / `<modified-files>` appendix from tool calls,
 * - summary output budget of floor(0.8 * 16384) tokens.
 *
 * Both arms share cut points, temperature 0, and per-hop seeds so the
 * comparison isolates summarization quality rather than trigger policy.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import {
  compactionContextForModel,
  estimateModelMessagesTokens,
  ModelMessageHistory,
} from "@minpeter/pss-runtime";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";
import { parseBatchedAnswers } from "./protocol";
import { buildScenarioFixture } from "./scenario-fixtures";
import { type CompactionScore, scoreAnswers } from "./scorer";
import { runCompactionTrial } from "./trial-runner";

const PI_RESERVE_TOKENS = 16_384;
const PI_TOOL_RESULT_MAX_CHARS = 2000;
const PROVIDER_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const REPETITIONS = 2;
const SCENARIOS = ["baseline", "lifecycle", "boundary-noise"] as const;

const PI_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const PI_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const PI_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

interface ArmResult {
  readonly error?: string;
  readonly hops?: readonly { prefixTokens: number; summaryTokens: number }[];
  readonly score?: CompactionScore;
  readonly status: string;
}

interface ComparisonRow {
  readonly pi: ArmResult;
  readonly pss: ArmResult;
  readonly repetition: number;
  readonly scenario: string;
}

async function main(): Promise<void> {
  const model = createCodingLanguageModel({ providerName: "compare-pi" });
  const env = readOpenAICompatibleModelEnv();
  const outputDir =
    process.argv[2] ?? `/tmp/compaction-vs-pi-${new Date().toISOString()}`;
  await mkdir(outputDir, { recursive: true });
  console.log(`model=${env.AI_MODEL} output=${outputDir}`);

  const rows: ComparisonRow[] = [];
  for (const scenario of SCENARIOS) {
    const fixtureSeed = `compare-pi-${scenario}-1`;
    const fixture = buildScenarioFixture(scenario, fixtureSeed);
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      console.log(
        `[${scenario} r${repetition}] hops=${fixture.compactionEnds.length} questions=${fixture.questions.length}`
      );
      const pss = await runArmWithRetry(() =>
        runPssArm(fixture, fixtureSeed, repetition, model)
      );
      console.log(`  pss: ${describeArm(pss)}`);
      const pi = await runArmWithRetry(() =>
        runPiArm(fixture, repetition, model)
      );
      console.log(`  pi : ${describeArm(pi)}`);
      rows.push({ pi, pss, repetition, scenario });
    }
  }

  const report = {
    aggregate: {
      pi: aggregate(rows.map((row) => row.pi)),
      pss: aggregate(rows.map((row) => row.pss)),
    },
    model: env.AI_MODEL,
    rows,
  };
  await writeFile(
    join(outputDir, "comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log(`report: ${join(outputDir, "comparison.json")}`);
}

async function runArmWithRetry(
  run: () => Promise<ArmResult>
): Promise<ArmResult> {
  let last: ArmResult = { error: "not-run", status: "invalid" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await run();
    if (last.status === "valid") {
      return last;
    }
  }
  return last;
}

async function runPssArm(
  fixture: CompactionFixture,
  fixtureSeed: string,
  repetition: number,
  model: LanguageModel
): Promise<ArmResult> {
  const record = await runCompactionTrial({
    attempt: 1,
    fixture,
    fixtureSeed,
    id: `pss-${fixture.scenario}-r${repetition}`,
    model,
    providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    repetition,
    summaryMaxOutputTokens: 2048,
  });
  if (record.status !== "valid") {
    return { error: record.error, status: record.status };
  }
  return {
    hops: record.hops.map((hop) => ({
      prefixTokens: hop.prefixTokens,
      summaryTokens: hop.summaryTokens,
    })),
    score: record.score,
    status: "valid",
  };
}

async function runPiArm(
  fixture: CompactionFixture,
  repetition: number,
  model: LanguageModel
): Promise<ArmResult> {
  const history = new ModelMessageHistory(fixture.messages);
  const fullContext = history.modelSnapshot();
  const hops: { prefixTokens: number; summaryTokens: number }[] = [];
  const fileOps = { edited: new Set<string>(), read: new Set<string>() };
  let previousSummary: string | undefined;
  let previousEnd = 0;

  for (const endSeqExclusive of fixture.compactionEnds) {
    const newMessages = fullContext.slice(previousEnd, endSeqExclusive);
    collectFileOps(newMessages, fileOps);
    let summary: string;
    try {
      summary = await generatePiSummary({
        model,
        newMessages,
        previousSummary,
      });
    } catch (cause) {
      return { error: String(cause), status: "summary-provider-failure" };
    }
    if (summary.length === 0) {
      return { error: "empty pi summary", status: "protocol-failure" };
    }
    summary += formatFileOperations(fileOps);
    history.recordCompaction({
      endSeqExclusive,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: summary, role: "system" },
    });
    hops.push({
      prefixTokens: estimateModelMessagesTokens(
        fullContext.slice(0, endSeqExclusive)
      ),
      summaryTokens: estimateModelMessagesTokens([
        compactionContextForModel({
          endSeqExclusive,
          role: "compaction",
          startSeq: 0,
          summary,
        }),
      ]),
    });
    previousSummary = summary;
    previousEnd = endSeqExclusive;
  }

  const compactedContext = history
    .modelContextSnapshot()
    .map((message) =>
      message.role === "compaction"
        ? compactionContextForModel(message)
        : message
    );
  return evaluateBothArms({
    compactedContext,
    fullContext,
    hops,
    model,
    questions: fixture.questions,
    repetition,
  });
}

async function evaluateBothArms({
  compactedContext,
  fullContext,
  hops,
  model,
  questions,
  repetition,
}: {
  readonly compactedContext: ModelMessage[];
  readonly fullContext: ModelMessage[];
  readonly hops: { prefixTokens: number; summaryTokens: number }[];
  readonly model: LanguageModel;
  readonly questions: readonly FixtureQuestion[];
  readonly repetition: number;
}): Promise<ArmResult> {
  const { evaluateArm } = await import("./trial-provider-boundary");
  const contexts =
    repetition % 2 === 0
      ? ([compactedContext, fullContext] as const)
      : ([fullContext, compactedContext] as const);
  const answers = new Map<ModelMessage[], Map<FixtureQuestion, string>>();
  for (const context of contexts) {
    try {
      const output = await evaluateArm({
        context,
        model,
        questions,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      answers.set(context, parseBatchedAnswers(output, questions));
    } catch (cause) {
      return { error: String(cause), status: "evaluation-provider-failure" };
    }
  }
  try {
    const score = scoreAnswers(
      questions,
      answers.get(fullContext) as Map<FixtureQuestion, string>,
      answers.get(compactedContext) as Map<FixtureQuestion, string>
    );
    return { hops, score, status: "valid" };
  } catch (cause) {
    return { error: String(cause), status: "invalid-full-control" };
  }
}

async function generatePiSummary({
  model,
  newMessages,
  previousSummary,
}: {
  readonly model: LanguageModel;
  readonly newMessages: readonly ModelMessage[];
  readonly previousSummary: string | undefined;
}): Promise<string> {
  const conversationText = serializePiConversation(newMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary !== undefined) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText +=
    previousSummary === undefined
      ? PI_SUMMARIZATION_PROMPT
      : PI_UPDATE_SUMMARIZATION_PROMPT;
  const { text } = await generateText({
    abortSignal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    maxOutputTokens: Math.floor(0.8 * PI_RESERVE_TOKENS),
    messages: [{ content: promptText, role: "user" }],
    model,
    system: PI_SUMMARIZATION_SYSTEM_PROMPT,
    temperature: 0,
  });
  return text.trim();
}

function serializePiConversation(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = plainText(message.content);
      if (content) {
        parts.push(`[User]: ${content}`);
      }
    } else if (message.role === "assistant") {
      parts.push(...serializeAssistant(message));
    } else if (message.role === "tool") {
      const content = toolResultText(message.content);
      if (content) {
        parts.push(
          `[Tool result]: ${truncateForSummary(content, PI_TOOL_RESULT_MAX_CHARS)}`
        );
      }
    }
  }
  return parts.join("\n\n");
}

function serializeAssistant(
  message: Extract<ModelMessage, { role: "assistant" }>
): string[] {
  const parts: string[] = [];
  const text = plainText(message.content);
  const toolCalls: string[] = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "tool-call") {
        const args = Object.entries(
          (part.input ?? {}) as Record<string, unknown>
        )
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ");
        toolCalls.push(`${part.toolName}(${args})`);
      }
    }
  }
  if (text) {
    parts.push(`[Assistant]: ${text}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
  }
  return parts;
}

function plainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { text: string; type: "text" } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const values: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-result" &&
      "output" in part &&
      typeof part.output === "object" &&
      part.output !== null &&
      "value" in part.output &&
      typeof part.output.value === "string"
    ) {
      values.push(part.output.value);
    }
  }
  return values.join("\n");
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

function collectFileOps(
  messages: readonly ModelMessage[],
  fileOps: { edited: Set<string>; read: Set<string> }
): void {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-call") {
        recordFileOp(part.toolName, part.input, fileOps);
      }
    }
  }
}

function recordFileOp(
  toolName: string,
  rawInput: unknown,
  fileOps: { edited: Set<string>; read: Set<string> }
): void {
  const input = rawInput as Record<string, unknown> | undefined;
  const path = typeof input?.path === "string" ? input.path : undefined;
  if (!path) {
    return;
  }
  if (toolName === "read") {
    fileOps.read.add(path);
  } else if (toolName === "write" || toolName === "edit") {
    fileOps.edited.add(path);
  }
}

function formatFileOperations(fileOps: {
  edited: Set<string>;
  read: Set<string>;
}): string {
  const modified = [...fileOps.edited].sort();
  const readOnly = [...fileOps.read]
    .filter((file) => !fileOps.edited.has(file))
    .sort();
  const sections: string[] = [];
  if (readOnly.length > 0) {
    sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  }
  if (modified.length > 0) {
    sections.push(
      `<modified-files>\n${modified.join("\n")}\n</modified-files>`
    );
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

function aggregate(results: readonly ArmResult[]): {
  compressionMean: number | null;
  invalid: number;
  retained: number;
  total: number;
  valid: number;
} {
  let retained = 0;
  let total = 0;
  const ratios: number[] = [];
  let valid = 0;
  for (const result of results) {
    if (result.status !== "valid" || !result.score) {
      continue;
    }
    valid += 1;
    retained += result.score.headline.correct;
    total += result.score.headline.total;
    for (const hop of result.hops ?? []) {
      ratios.push(hop.summaryTokens / hop.prefixTokens);
    }
  }
  return {
    compressionMean:
      ratios.length === 0
        ? null
        : ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    invalid: results.length - valid,
    retained,
    total,
    valid,
  };
}

function describeArm(result: ArmResult): string {
  if (result.status !== "valid" || !result.score) {
    return `invalid status=${result.status} error=${result.error}`;
  }
  const ratio = (result.hops ?? [])
    .map((hop) => (hop.summaryTokens / hop.prefixTokens).toFixed(3))
    .join(",");
  return `valid ${result.score.headline.correct}/${result.score.headline.total} ratio=[${ratio}]`;
}

await main();
