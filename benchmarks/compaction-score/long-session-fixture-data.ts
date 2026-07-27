import { createHash } from "node:crypto";
import type { FixtureQuestion } from "./fixture";

export interface LongSessionFact extends FixtureQuestion {
  readonly statement: string;
}

export interface LongSessionFixtureData {
  readonly correctedFact: LongSessionFact;
  readonly earlyFacts: readonly LongSessionFact[];
  readonly lateFacts: readonly LongSessionFact[];
  readonly negativeFacts: readonly LongSessionFact[];
  readonly staleStatement: string;
  readonly toolCommand: FixtureQuestion;
  readonly toolResult: FixtureQuestion;
  readonly unknownFact: LongSessionFact;
}

const sha = (input: string, length: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

export function buildLongSessionFixtureData(
  seed: string
): LongSessionFixtureData {
  const sessionId = `lsn-${sha(`${seed}:session`, 12)}`;
  const requestId = `req_${sha(`${seed}:request`, 16)}`;
  const dashboardUrl = `https://retention.example.test/sessions/${sha(
    `${seed}:url`,
    10
  )}/durable-ledger`;
  const manifestPath = `artifacts/retention/${sha(
    `${seed}:path`,
    8
  )}/session-ledger.json`;
  const symbol = `verifyLongSessionState_${sha(`${seed}:symbol`, 6)}`;
  const toolCommand = `pnpm vitest run retention-${sha(
    `${seed}:tool-command`,
    7
  )}.test.ts --maxWorkers=1`;
  const toolOutput = `128 passed, 0 failed; evidence digest ${sha(
    `${seed}:tool-output`,
    20
  )}`;
  const blocker = `provider sandbox quota resets at ${
    9 + (Number.parseInt(sha(`${seed}:hour`, 2), 16) % 10)
  }:30 UTC on 2026-08-04`;
  const nextAction = `execute replay shard ${sha(
    `${seed}:next-shard`,
    9
  )} and attach artifact long-session-${sha(`${seed}:next-artifact`, 8)}.json`;

  return {
    correctedFact: fact(
      "temporal-resolution",
      "1375 milliseconds",
      "After the correction, what is the final retention timeout?",
      "Latest correction: the retention timeout is 1375 milliseconds, not 900 seconds."
    ),
    earlyFacts: [
      fact(
        "exact-recall",
        sessionId,
        "What is the exact long-session id?",
        `Long-session id: ${sessionId}.`
      ),
      fact(
        "exact-recall",
        requestId,
        "What is the exact replay request id?",
        `Replay request id: ${requestId}.`
      ),
      fact(
        "exact-recall",
        dashboardUrl,
        "What is the exact durable-ledger URL?",
        `Durable-ledger URL: ${dashboardUrl}.`
      ),
      fact(
        "file-state",
        manifestPath,
        "What is the exact retained manifest path?",
        `Retained manifest path: ${manifestPath}.`
      ),
      fact(
        "exact-recall",
        symbol,
        "What is the exact verifier symbol?",
        `Verifier symbol: ${symbol}.`
      ),
      fact(
        "exact-recall",
        "96 records per shard",
        "What is the exact replay batch size?",
        "Replay batch size: 96 records per shard."
      ),
      fact(
        "constraint-retention",
        "preserve source ordering across the compaction boundary",
        "What exact ordering constraint must be preserved?",
        "Hard constraint: preserve source ordering across the compaction boundary."
      ),
    ],
    lateFacts: [
      fact(
        "task-continuation",
        "completed",
        "What is the exact completed task state?",
        "task-ledger-scan: completed."
      ),
      fact(
        "task-continuation",
        "in-progress",
        "What is the exact current task state?",
        "task-retention-window: in-progress."
      ),
      fact(
        "task-continuation",
        "blocked",
        "What is the exact blocked task state?",
        "task-provider-replay: blocked."
      ),
      fact(
        "task-continuation",
        blocker,
        "What is the exact Blocker?",
        `Blocker: ${blocker}.`
      ),
      fact(
        "task-continuation",
        nextAction,
        "What is the exact Next action?",
        `Next action: ${nextAction}.`
      ),
    ],
    negativeFacts: [
      fact(
        "negative-knowledge",
        "single-pass regex transcript migration",
        "Which failed approach must not be retried?",
        "Failed approach: single-pass regex transcript migration. Do not retry it."
      ),
      fact(
        "negative-knowledge",
        "it reordered tool results before their matching calls",
        "Why must the failed transcript migration not be retried?",
        "Do-not-retry reason: it reordered tool results before their matching calls."
      ),
    ],
    staleStatement:
      "Stale provisional value: the retention timeout is 900 seconds.",
    toolCommand: {
      answer: toolCommand,
      category: "tool-history",
      question: "What exact command did the audit tool call execute?",
    },
    toolResult: {
      answer: toolOutput,
      category: "tool-history",
      question: "What exact result did the audit tool return?",
    },
    unknownFact: fact(
      "hallucination-resistance",
      "unknown",
      "Who owns the production signing key?",
      "Production signing key owner is explicitly unknown."
    ),
  };
}

function fact(
  category: FixtureQuestion["category"],
  answer: string,
  question: string,
  statement: string
): LongSessionFact {
  return { answer, category, question, statement };
}
