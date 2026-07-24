import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});

export function buildProgressiveFiveHopFixture(
  seed: string
): CompactionFixture {
  const suffix = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const originalFailure = "5 passed, 4 failed; CacheV1Error at src/cache.ts";
  const finalOutput = `14 passed, 0 failed; state-${suffix} verified`;
  const blocker = "waiting for the signed schema-v5 fixture";
  const nextAction =
    "publish the src/state.ts manifest and unblock task-release";
  const messages: ModelMessage[] = [];
  const compactionEnds: number[] = [];

  messages.push(
    user(
      "Migrate the state layer. Initial runtime target: Node 20. Initial file: src/cache.ts. task-migrate is queued."
    ),
    assistant(
      "The initial Node 20, src/cache.ts, and queued state are recorded."
    ),
    user("Run the initial state tests."),
    toolCall("five-hop-1"),
    toolResult("five-hop-1", originalFailure),
    assistant(
      "The original state test run failed and remains historical evidence."
    )
  );
  addTransientTrace(messages, seed, 1);
  compactionEnds.push(messages.length);

  messages.push(
    user(
      "Correction 1: target Node 22, not Node 20. Rename src/cache.ts to src/store.ts. task-migrate is in-progress."
    ),
    assistant("Correction 1 recorded; the older values remain historical."),
    user("Run the tests after correction 1."),
    toolCall("five-hop-2"),
    toolResult("five-hop-2", "8 passed, 2 failed; StoreV2Error"),
    assistant("Correction 1 still has two failing tests.")
  );
  addTransientTrace(messages, seed, 2);
  compactionEnds.push(messages.length);

  messages.push(
    user(
      "Correction 2: target Node 24. Current file is src/storage.ts; src/cache.ts and src/store.ts are deleted. task-migrate is blocked."
    ),
    assistant("Correction 2 recorded without removing earlier source facts."),
    user("Run the tests after correction 2."),
    toolCall("five-hop-3"),
    toolResult("five-hop-3", "10 passed, 1 failed; StorageV3Error"),
    assistant("Correction 2 still has one failing test.")
  );
  addTransientTrace(messages, seed, 3);
  compactionEnds.push(messages.length);

  messages.push(
    user(
      "Correction 3: move the current file to src/persistence.ts; src/storage.ts is deleted. task-migrate returns to in-progress."
    ),
    assistant("Correction 3 recorded; src/persistence.ts is provisional."),
    user("Run the tests after correction 3."),
    toolCall("five-hop-4"),
    toolResult("five-hop-4", "12 passed, 1 failed; SchemaV4Error"),
    assistant("Correction 3 still has a schema failure.")
  );
  addTransientTrace(messages, seed, 4);
  compactionEnds.push(messages.length);

  messages.push(
    user(
      "Final correction: target Node 26. Current file is src/state.ts; src/persistence.ts is deleted."
    ),
    assistant("Final runtime and file corrections recorded."),
    user(
      `Final board: task-migrate is completed; task-release is blocked. Blocker: ${blocker}. Next action: ${nextAction}.`
    ),
    assistant(
      "The final task board, blocker, and next action are authoritative."
    ),
    user(
      "Explicit unknowns: deployment owner: unknown. Production rollout ID: unknown."
    ),
    assistant("Deployment owner and production rollout ID remain unknown."),
    user("Run the final state verification."),
    toolCall("five-hop-5"),
    toolResult("five-hop-5", finalOutput),
    assistant("The final state verification passed.")
  );
  addTransientTrace(messages, seed, 5);
  compactionEnds.push(messages.length);

  messages.push(
    user("Continue with the final corrected state only."),
    assistant("Ready to continue from the final corrected state.")
  );

  return {
    compactionEnds,
    messages,
    questions: [
      question(
        "tool-history",
        originalFailure,
        "What was the original failure?"
      ),
      question(
        "temporal-resolution",
        "Node 26",
        "What is the final runtime target?"
      ),
      question("file-state", "src/state.ts", "What is the current state file?"),
      question("file-state", "deleted", "What is the status of src/cache.ts?"),
      question(
        "file-state",
        "deleted",
        "What is the status of src/storage.ts?"
      ),
      question(
        "file-state",
        "deleted",
        "What is the status of src/persistence.ts?"
      ),
      question(
        "task-continuation",
        "completed",
        "What is task-migrate's final status?"
      ),
      question(
        "task-continuation",
        "blocked",
        "What is task-release's final status?"
      ),
      question(
        "task-continuation",
        blocker,
        "What is the exact current Blocker?"
      ),
      question(
        "task-continuation",
        nextAction,
        "What is the exact Next action?"
      ),
      question(
        "tool-history",
        finalOutput,
        "What was the final verification output?"
      ),
      question("hallucination-resistance", "unknown", "Who owns deployment?"),
    ],
    scenario: "progressive-five-hop",
  };
}

function question(
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion {
  return { answer, category, question: text };
}

function addTransientTrace(
  messages: ModelMessage[],
  seed: string,
  phase: number
): void {
  const trace = Array.from(
    { length: 36 },
    (_, index) =>
      `TRANSIENT phase=${phase} sample=${index} digest=${createHash("sha256").update(`${seed}:${phase}:${index}`).digest("hex")}; ignore this telemetry when preserving durable state.`
  ).join("\n");
  messages.push(
    user(trace),
    assistant("The transient telemetry has no durable state.")
  );
}

function toolCall(toolCallId: string): ModelMessage {
  return {
    content: [
      {
        input: { command: "pnpm test state" },
        toolCallId,
        toolName: "run_tests",
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
        toolName: "run_tests",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}
