import type { ModelMessage } from "ai";
import {
  BASELINE_DISTRACTOR_TOPICS,
  baselineSha,
  buildBaselineFixtureData,
} from "./baseline-fixture-data";
import type { CompactionFixture, FixtureQuestion } from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });

const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});

const assistantToolCall = (
  toolCallId: string,
  toolName: string,
  input: Record<string, string>
): ModelMessage => ({
  content: [{ input, toolCallId, toolName, type: "tool-call" }],
  role: "assistant",
});

const toolResult = (
  toolCallId: string,
  toolName: string,
  value: string
): ModelMessage => ({
  content: [
    {
      output: { type: "text", value },
      toolCallId,
      toolName,
      type: "tool-result",
    },
  ],
  role: "tool",
});

export function buildCompactionFixture(seed: string): CompactionFixture {
  const messages: ModelMessage[] = [];
  const questions: FixtureQuestion[] = [];
  const {
    board,
    corrections,
    exactFacts,
    nextAction,
    projectName,
    storageKey,
    taskQuestions,
    toolFacts,
  } = buildBaselineFixtureData(seed);

  messages.push(
    user(
      `We are building a small vanilla JS task manager. ${exactFacts[0]?.statement ?? ""}`
    ),
    assistant(
      `Understood. I will use ${projectName} everywhere and keep the code dependency-free.`
    )
  );

  messages.push(
    user(exactFacts[6]?.statement ?? ""),
    assistant(`Noted: persistence key ${storageKey}.`)
  );

  for (const [index, correction] of corrections.entries()) {
    if (index % 2 === 0) {
      messages.push(
        user(correction.provisional),
        assistant("Recorded as the provisional value.")
      );
    }
  }

  messages.push(
    user("Let's check the current task board."),
    assistant(`Current board:\n${board}\nNext action: ${nextAction}.`)
  );

  for (const [index, fact] of exactFacts.slice(1, 5).entries()) {
    messages.push(
      user(fact.statement),
      assistant(`Recorded ${index + 1}: ${fact.answer}.`)
    );
  }

  for (const [index, fact] of toolFacts.entries()) {
    const callId = `call-${seed}-${index}`;
    messages.push(
      user(`Please run ${fact.tool}.`),
      assistantToolCall(callId, fact.tool, { cwd: "." }),
      toolResult(callId, fact.tool, fact.output),
      assistant(`${fact.tool} finished: ${fact.output}.`)
    );
  }

  for (const [index, fact] of exactFacts.slice(5).entries()) {
    messages.push(
      user(fact.statement),
      assistant(`Saved ${index + 5}: ${fact.answer}.`)
    );
  }

  for (const [index, correction] of corrections.entries()) {
    if (index % 2 === 1) {
      messages.push(
        user(correction.provisional),
        assistant("Recorded as the provisional value.")
      );
    }
  }

  for (const correction of corrections) {
    messages.push(
      user(correction.correction),
      assistant(`Updated. The final value is ${correction.answer}.`)
    );
  }

  for (const [index, topic] of BASELINE_DISTRACTOR_TOPICS.entries()) {
    messages.push(
      user(`Side question ${index + 1}: explain ${topic}.`),
      assistant(
        `On ${topic}: the short answer is detail ${baselineSha(`${seed}:dist:${index}`, 6)}. ` +
          "In practice it behaves the way the spec describes, with the usual browser caveats, " +
          "and the pattern to remember is to keep the hot path small and measure before tuning."
      )
    );
  }

  for (const question of exactFacts) {
    questions.push({
      answer: question.answer,
      category: "exact-recall",
      question: question.question,
    });
  }
  for (const correction of corrections) {
    questions.push({
      answer: correction.answer,
      category: "distractor-resolution",
      question: correction.question,
    });
  }
  for (const fact of toolFacts) {
    questions.push({
      answer: fact.answer,
      category: "tool-history",
      question: fact.question,
    });
  }
  questions.push(...taskQuestions);

  const tail: ModelMessage[] = [
    user(
      "Before we continue, quick status check: anything about the padding work to note?"
    ),
    assistant(
      "The distractor research is done; nothing from it feeds the task manager directly."
    ),
    user("Ok. Next up I want to review the dark-mode toggle wiring together."),
    assistant(
      "Sounds good. I will walk through the toggle handler and the persistence path first."
    ),
    user("Also remind me later to bump the footer copy."),
    assistant(
      "Noted as a follow-up; I will surface it when we wrap the toggle work."
    ),
    user("Great, let us keep going in the next message."),
    assistant("Ready when you are."),
  ];
  messages.push(...tail);

  return {
    compactionEnds: [messages.length - tail.length],
    messages,
    questions,
    scenario: "baseline",
  };
}
