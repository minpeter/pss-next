import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});

export function buildSparseFactFixture(seed: string): CompactionFixture {
  const exactId = `SPARSE-${hash(seed, "id", 10)}`;
  const toolChecksum = hash(seed, "tool", 16);
  const boundaryNonce = hash(seed, "boundary", 12);
  const messages: ModelMessage[] = [
    user(
      [
        "Retain the following sparse durable facts exactly.",
        `Sparse exact ID: ${exactId}`,
        "Sparse deployment owner: unknown",
        "Do not invent values that are not present in this conversation.",
      ].join("\n")
    ),
    assistant(
      `Recorded Sparse exact ID ${exactId}. Sparse deployment owner remains unknown.`
    ),
    user("Run sparse inspection."),
    toolCall("sparse-inspection"),
    toolResult("sparse-inspection", toolChecksum),
    assistant(`The tool-only checksum is ${toolChecksum}.`),
  ];
  for (let index = 0; index < 250; index += 1) {
    messages.push(
      user(
        `Noise ${index}: telemetry=${hash(seed, `noise-${index}`, 48)}; this is non-durable discussion.`
      ),
      assistant(`Noise ${index} acknowledged without durable state.`)
    );
  }
  messages.push(
    user(`Boundary nonce: ${boundaryNonce}. Keep this exact boundary nonce.`),
    assistant(`The boundary nonce is ${boundaryNonce}.`)
  );
  const end = messages.length;
  messages.push(
    user("Continue after sparse compaction."),
    assistant("Sparse durable facts remain available.")
  );
  return {
    compactionEnds: [end],
    messages,
    questions: [
      question("exact-recall", exactId, "What is the sparse exact ID?"),
      question("tool-history", toolChecksum, "What is the tool-only checksum?"),
      question("boundary-recall", boundaryNonce, "What is the boundary nonce?"),
      question(
        "hallucination-resistance",
        "unknown",
        "What is the sparse deployment owner?"
      ),
    ],
    scenario: "sparse-fact",
  };
}

export function buildDenseSmallRangeFixture(seed: string): CompactionFixture {
  const values = Array.from(
    { length: 18 },
    (_, index) =>
      `DENSE-${index.toString().padStart(2, "0")}-${hash(seed, `${index}`, 12)}`
  );
  const messages: ModelMessage[] = [];
  for (const [index, value] of values.entries()) {
    messages.push(
      user(
        `Durable dense fact ${index}: ${value}. This sentence must survive.`
      ),
      assistant(`Dense fact ${index} recorded exactly as ${value}.`)
    );
  }
  const end = messages.length;
  messages.push(
    user("Continue from the dense durable range."),
    assistant("Dense range remains available.")
  );
  return {
    compactionEnds: [end],
    messages,
    questions: values.map((answer, index) =>
      question("exact-recall", answer, `What is dense fact ${index}?`)
    ),
    scenario: "dense-small-range",
  };
}

function question(
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion {
  return { answer, category, question: text };
}

function hash(seed: string, scope: string, length: number): string {
  return createHash("sha256")
    .update(`${seed}:${scope}`)
    .digest("hex")
    .slice(0, length);
}

function toolCall(toolCallId: string): ModelMessage {
  return {
    content: [
      {
        input: { command: "inspect sparse" },
        toolCallId,
        toolName: "inspect_sparse",
        type: "tool-call",
      },
    ],
    role: "assistant",
  };
}

function toolResult(toolCallId: string, value: string): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value },
        toolCallId,
        toolName: "inspect_sparse",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}
