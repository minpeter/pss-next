import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});
const sha = (input: string, length = 8): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

export function buildBoundaryNoiseFixture(seed: string): CompactionFixture {
  const releaseTicket = `RLS-${sha(`${seed}:ticket`, 7).toUpperCase()}`;
  const rootCause = "case-sensitive import mismatch for ViewModel";
  const artifactSha = sha(`${seed}:artifact`, 16);
  const rollbackCommand = `deployctl rollback ${sha(`${seed}:rollback`, 9)}`;
  const boundaryNonce = `nonce_${sha(`${seed}:boundary`, 12)}`;
  const exactSymbol = "apiURL";
  const failedOutput =
    "inspection failed: log shard 7 unavailable; no conclusion recorded";
  const finalOutput = `inspection complete; ticket ${releaseTicket}; artifact ${artifactSha}`;
  const messages: ModelMessage[] = [
    user(
      "Diagnose the noisy release log. Preserve exact evidence but do not confuse provisional log lines with final values."
    ),
    assistant("I will treat the final labeled evidence as authoritative."),
    user(
      "Hard constraint: preserve CJK text without clipping and do not rename public symbols."
    ),
    assistant("CJK clipping and public-symbol stability are hard constraints."),
    user("Inspect the first release-log shard."),
    toolCall("noise-log-1", "inspect_log"),
    toolResult("noise-log-1", "inspect_log", failedOutput),
    assistant("The first inspection failed and produced no valid conclusion."),
    user("Inspect the complete release log."),
    toolCall("noise-log-2", "inspect_log"),
    toolResult(
      "noise-log-2",
      "inspect_log",
      buildNoisyLog({
        artifactSha,
        releaseTicket,
        rollbackCommand,
        rootCause,
        seed,
      })
    ),
    assistant(
      "The complete log is authoritative. I will not duplicate its exact values in this acknowledgement."
    ),
    user("Provisional public symbol spelling: apiUrl."),
    assistant("apiUrl is provisional."),
    user(`Correction: the exact public symbol is ${exactSymbol}, not apiUrl.`),
    assistant(`Final public symbol spelling recorded as ${exactSymbol}.`),
    user("Rollback owner is explicitly unknown; no owner has been assigned."),
    assistant("Rollback owner: unknown."),
  ];
  addNoiseConversation(messages, seed, 8);
  messages.push(
    user(`Boundary nonce immediately before compaction: ${boundaryNonce}.`),
    assistant("The boundary nonce is recorded without changing its value.")
  );
  const end = messages.length;

  messages.push(
    user("Now discuss only the release-note title."),
    assistant("The release-note title is unrelated to the preserved evidence."),
    user("Do not revise the diagnosis while discussing wording."),
    assistant("The diagnosis and exact evidence remain unchanged."),
    user("We will resume from the rollback evidence later."),
    assistant("Ready to resume from the preserved release state.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "boundary-recall",
      releaseTicket,
      "What exact release ticket appears in the complete tool log?"
    ),
    question(
      "boundary-recall",
      rootCause,
      "What exact root cause appears in the complete tool log?"
    ),
    question(
      "boundary-recall",
      artifactSha,
      "What exact final artifact SHA appears in the complete tool log?"
    ),
    question(
      "boundary-recall",
      rollbackCommand,
      "What exact rollback command appears in the complete tool log?"
    ),
    question(
      "boundary-recall",
      boundaryNonce,
      "What is the exact nonce stated immediately before compaction?"
    ),
    question(
      "temporal-resolution",
      exactSymbol,
      "What is the final exact public symbol spelling?"
    ),
    question(
      "constraint-retention",
      "preserve CJK text without clipping",
      "What CJK rendering constraint must be preserved?"
    ),
    question(
      "constraint-retention",
      "do not rename public symbols",
      "What public API naming constraint must be preserved?"
    ),
    question(
      "negative-knowledge",
      failedOutput,
      "What exact output came from the failed first inspection?"
    ),
    question(
      "tool-history",
      finalOutput,
      "What exact summary line represents the successful inspection?"
    ),
    question("hallucination-resistance", "unknown", "Who owns the rollback?"),
  ];

  return {
    compactionEnds: [end],
    messages,
    questions,
    scenario: "boundary-noise",
  };
}

function buildNoisyLog({
  artifactSha,
  releaseTicket,
  rollbackCommand,
  rootCause,
  seed,
}: {
  artifactSha: string;
  releaseTicket: string;
  rollbackCommand: string;
  rootCause: string;
  seed: string;
}): string {
  const lines = [
    `FINAL_RELEASE_TICKET=${releaseTicket}`,
    ...noiseLines(seed, "before", 90),
    `FINAL_ROOT_CAUSE=${rootCause}`,
    ...noiseLines(seed, "middle", 90),
    `FINAL_ARTIFACT_SHA=${artifactSha}`,
    ...noiseLines(seed, "after", 90),
    `FINAL_ROLLBACK_COMMAND=${rollbackCommand}`,
    `inspection complete; ticket ${releaseTicket}; artifact ${artifactSha}`,
  ];
  return lines.join("\n");
}

function noiseLines(seed: string, phase: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `[debug:${phase}:${index}] provisional=${sha(`${seed}:${phase}:${index}`, 20)} status=ignored`
  );
}

function addNoiseConversation(
  messages: ModelMessage[],
  seed: string,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    messages.push(
      user(`Unrelated log-format question ${index}?`),
      assistant(
        `Formatting note ${sha(
          `${seed}:conversation:${index}`,
          8
        )} is unrelated to final evidence.`
      )
    );
  }
}

function question(
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion {
  return { answer, category, question: text };
}

function toolCall(toolCallId: string, toolName: string): ModelMessage {
  return {
    content: [
      {
        input: { shard: "all" },
        toolCallId,
        toolName,
        type: "tool-call",
      },
    ],
    role: "assistant",
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  value: string
): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value },
        toolCallId,
        toolName,
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}
