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

export function buildLifecycleFixture(seed: string): CompactionFixture {
  const messages: ModelMessage[] = [];
  const codename = `relay-${sha(`${seed}:project`, 5)}`;
  const checksum = sha(`${seed}:checksum`, 12);
  const blocker = "waiting for the signed accessibility test fixture";
  const nextAction =
    "migrate cache reads to src/storage.ts and finish task-storage-migration";
  const failedReason =
    "Safari private mode returned inconsistent transaction results";
  const failedTests =
    "12 passed, 3 failed; StorageAdapterError in cache persistence";
  const finalTests = "19 passed, 0 failed; storage migration verified";

  messages.push(
    user(
      `Build ${codename}, a browser storage migration. The completion target is a green migration test suite.`
    ),
    assistant(`Objective recorded for ${codename}.`),
    user(
      "Hard constraints: no external dependencies; support Safari 16; keep the public storage API synchronous."
    ),
    assistant(
      "Constraints recorded: no external dependencies, Safari 16, synchronous public API."
    ),
    user(
      "Provisional state: target Node 22 and implement the adapter in src/cache.ts."
    ),
    assistant("Node 22 and src/cache.ts are provisional, not final."),
    user(
      "Plan offline sync after storage migration. task-storage-migration is queued."
    ),
    assistant("Offline sync is planned; task-storage-migration is queued."),
    user(
      `Failed approach: IndexedDB adapter. Do not retry it because ${failedReason}.`
    ),
    assistant(
      `Recorded negative knowledge: do not retry the IndexedDB adapter; ${failedReason}.`
    ),
    user("Run the migration tests."),
    toolCall("lifecycle-tests-1", "run_tests"),
    toolResult("lifecycle-tests-1", "run_tests", failedTests),
    assistant("The first migration test run is red and unresolved."),
    user(
      "Explicit unknowns: Production domain: unknown. Deployment ID: unknown."
    ),
    assistant("Both production domain and deployment ID remain unknown.")
  );
  addDistractors(messages, seed, "before", 5);
  const firstEnd = messages.length;

  messages.push(
    user("Correction: the final runtime target is Node 24, not Node 22."),
    assistant("Final runtime target updated to Node 24."),
    user(
      "File lifecycle correction: rename src/cache.ts to src/storage.ts. src/cache.ts is deleted."
    ),
    assistant(
      "Current file is src/storage.ts; src/cache.ts status is deleted."
    ),
    user(
      "Cancel offline sync. Its final status is cancelled; do not implement it."
    ),
    assistant("Offline sync final status: cancelled."),
    user(`The migration manifest checksum is ${checksum}.`),
    assistant(`Exact migration manifest checksum: ${checksum}.`),
    user("Run the migration tests after the fix."),
    toolCall("lifecycle-tests-2", "run_tests"),
    toolResult("lifecycle-tests-2", "run_tests", finalTests),
    assistant("The final migration test run is green."),
    user(
      `Current board: task-storage-migration is in-progress; task-a11y-fixture is blocked; blocker: ${blocker}; Next action: ${nextAction}.`
    ),
    assistant(
      `task-storage-migration is in-progress. task-a11y-fixture is blocked. blocker: ${blocker}. Next action: ${nextAction}.`
    )
  );
  addDistractors(messages, seed, "after", 5);
  const secondEnd = messages.length;

  messages.push(
    user("Let us discuss release-note wording later."),
    assistant("Release-note wording is outside the active migration task."),
    user("Do not change the current migration decisions."),
    assistant("The current migration decisions remain authoritative."),
    user("We will continue from the storage migration next."),
    assistant("Ready to continue from the recorded next action."),
    user(
      "The production domain is unknown. The deployment ID is unknown. Do not invent either value."
    ),
    assistant(
      "Recorded that the production domain is unknown and the deployment ID is unknown."
    )
  );

  const questions: FixtureQuestion[] = [
    question("exact-recall", codename, "What is the exact project codename?"),
    question(
      "temporal-resolution",
      "Node 24",
      "What is the final runtime target?"
    ),
    question(
      "constraint-retention",
      "no external dependencies",
      "What dependency constraint must be preserved?"
    ),
    question(
      "constraint-retention",
      "Safari 16",
      "What minimum Safari version must remain supported?"
    ),
    question(
      "file-state",
      "src/storage.ts",
      "Which file contains the final storage adapter?"
    ),
    question("file-state", "deleted", "What is the status of src/cache.ts?"),
    question(
      "temporal-resolution",
      "cancelled",
      "What is the final status of offline sync?"
    ),
    question(
      "negative-knowledge",
      "IndexedDB adapter",
      "Which approach must not be retried?"
    ),
    question(
      "negative-knowledge",
      failedReason,
      "Why must the IndexedDB adapter not be retried?"
    ),
    question(
      "tool-history",
      failedTests,
      "What was the exact initial failing test output?"
    ),
    question(
      "tool-history",
      finalTests,
      "What was the exact final passing test output?"
    ),
    question(
      "task-continuation",
      "task-storage-migration",
      "Which task is currently in progress?"
    ),
    question(
      "task-continuation",
      blocker,
      "What exactly blocks task-a11y-fixture?"
    ),
    question("task-continuation", nextAction, "What is the exact next action?"),
    question(
      "hallucination-resistance",
      "unknown",
      "What is the production domain?"
    ),
    question(
      "hallucination-resistance",
      "unknown",
      "What is the deployment ID?"
    ),
    question(
      "exact-recall",
      checksum,
      "What is the exact migration manifest checksum?"
    ),
  ];

  return {
    compactionEnds: [firstEnd, secondEnd],
    messages,
    questions,
    scenario: "lifecycle",
  };
}

function addDistractors(
  messages: ModelMessage[],
  seed: string,
  phase: string,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    messages.push(
      user(`Side discussion ${phase}-${index}: browser event loop detail?`),
      assistant(
        `Unrelated note ${sha(`${seed}:${phase}:${index}`, 6)}: measure browser behavior independently.`
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
    content: [{ input: { cwd: "." }, toolCallId, toolName, type: "tool-call" }],
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
