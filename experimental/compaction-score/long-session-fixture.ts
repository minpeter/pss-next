import type { ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";
import {
  buildLongSessionFillerTurn,
  LONG_SESSION_FILLER_TURNS,
  longSessionFillerAcknowledgement,
} from "./long-session-filler";
import {
  buildLongSessionFixtureData,
  type LongSessionFact,
} from "./long-session-fixture-data";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});

export function buildLongSessionFixture(seed: string): CompactionFixture {
  const data = buildLongSessionFixtureData(seed);
  const messages: ModelMessage[] = [];

  for (const fact of data.earlyFacts) {
    pushFact(messages, fact);
  }
  messages.push(
    user(data.staleStatement),
    assistant("The provisional value is recorded as stale pending correction.")
  );
  pushFact(messages, data.correctedFact);
  for (const fact of data.negativeFacts) {
    pushFact(messages, fact);
  }
  pushFact(messages, data.unknownFact);

  messages.push(
    user("Run the retained long-session audit command now."),
    toolCall("long-session-audit", data.toolCommand.answer),
    toolResult("long-session-audit", data.toolResult.answer),
    assistant("The audit call and its result are retained as paired evidence.")
  );

  for (let index = 0; index < LONG_SESSION_FILLER_TURNS; index += 1) {
    messages.push(
      user(buildLongSessionFillerTurn(seed, index)),
      assistant(longSessionFillerAcknowledgement(seed, index))
    );
  }
  for (const fact of data.lateFacts) {
    pushFact(messages, fact);
  }
  const end = messages.length;

  messages.push(
    user("Switch to release-note wording without revising retained state."),
    assistant("Release-note wording is separate from the retained state."),
    user("Keep the durable handoff ready for the next turn."),
    assistant("The handoff remains ready without adding new durable facts."),
    user("Continue after the compaction boundary."),
    assistant("Ready to continue from the durable handoff.")
  );

  return {
    compactionEnds: [end],
    messages,
    questions: questionsFor(data),
    scenario: "long-session",
  };
}

function pushFact(messages: ModelMessage[], fact: LongSessionFact): void {
  messages.push(
    user(fact.statement),
    assistant("Durable fact recorded without restating its value.")
  );
}

function questionsFor(
  data: ReturnType<typeof buildLongSessionFixtureData>
): FixtureQuestion[] {
  return [
    ...data.earlyFacts,
    data.correctedFact,
    ...data.negativeFacts,
    data.unknownFact,
    data.toolCommand,
    data.toolResult,
    ...data.lateFacts,
  ].map(({ answer, category, question }) => ({ answer, category, question }));
}

function toolCall(toolCallId: string, command: string): ModelMessage {
  return {
    content: [
      {
        input: { command },
        toolCallId,
        toolName: "run_retention_audit",
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
        toolName: "run_retention_audit",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}
