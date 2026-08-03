import { createHash } from "node:crypto";
import type { FixtureQuestion } from "./fixture";

export const BASELINE_DISTRACTOR_TOPICS = [
  "how flexbox gap behaves with wrapped rows",
  "why localStorage is synchronous",
  "the difference between em and rem",
  "how event delegation works",
  "why JSON.stringify drops undefined fields",
  "how CSS specificity is calculated",
  "what the defer attribute does on script tags",
  "how array reduce can build an index map",
  "why HTTP/2 multiplexing helps small assets",
  "how passive event listeners improve scroll performance",
  "what aria-live regions announce",
  "how AbortController cancels fetch requests",
  "why crypto.getRandomValues beats Math.random for ids",
  "how the browser parses HTML incrementally",
  "what contained layouts do for paint performance",
  "how queueMicrotask differs from setTimeout 0",
];

export const baselineSha = (input: string, length = 8): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

export function buildBaselineFixtureData(seed: string) {
  const projectName = `orbit-${baselineSha(`${seed}:project`, 4)}`;
  const finalPort =
    8400 + (Number.parseInt(baselineSha(`${seed}:port`, 2), 16) % 90);
  const apiToken = `tok_${baselineSha(`${seed}:token`, 12)}`;
  const dbPath = `.data/${baselineSha(`${seed}:db`, 6)}/tasks.db`;
  const licenseKey = `LIC-${baselineSha(`${seed}:license`, 10).toUpperCase()}`;
  const cssVar = `--accent-${baselineSha(`${seed}:cssvar`, 5)}`;
  const storageKey = `${projectName}:v${
    (Number.parseInt(baselineSha(`${seed}:v`, 1), 16) % 5) + 1
  }`;
  const ownerEmail = `owner-${baselineSha(`${seed}:owner`, 6)}@example.dev`;

  const exactFacts = [
    {
      answer: projectName,
      question: "What is the exact project codename?",
      statement: `The project codename is ${projectName}. Use it in every header comment.`,
    },
    {
      answer: String(finalPort),
      question: "What is the final dev server port?",
      statement: `Final decision: the dev server port is ${finalPort}. This supersedes any earlier port.`,
    },
    {
      answer: apiToken,
      question: "What is the exact API token we recorded?",
      statement: `Record this API token for the sync adapter: ${apiToken}.`,
    },
    {
      answer: dbPath,
      question: "What is the exact database file path?",
      statement: `The tasks database lives at ${dbPath}. Do not move it.`,
    },
    {
      answer: licenseKey,
      question: "What is the exact license key?",
      statement: `The commercial license key is ${licenseKey}.`,
    },
    {
      answer: cssVar,
      question: "What is the exact name of the accent CSS custom property?",
      statement: `Name the accent color custom property ${cssVar}.`,
    },
    {
      answer: storageKey,
      question: "What is the exact localStorage key for persisted tasks?",
      statement: `Persist tasks under the localStorage key ${storageKey}.`,
    },
    {
      answer: ownerEmail,
      question: "What is the exact owner email on file?",
      statement: `The owner of record is ${ownerEmail}.`,
    },
  ];

  const provisionalPort =
    3000 + (Number.parseInt(baselineSha(`${seed}:pp`, 1), 16) % 9);
  const provisionalName = `nebula-${baselineSha(`${seed}:pn`, 4)}`;
  const provisionalDb = `.data/legacy-${baselineSha(`${seed}:pd`, 6)}/tasks.db`;
  const provisionalStorage = `${provisionalName}:v9`;

  const corrections = [
    {
      answer: String(finalPort),
      correction: `Correction: forget port ${provisionalPort}. The final dev server port is ${finalPort}.`,
      provisional: `Let's start the dev server on port ${provisionalPort} for now.`,
      question: "After all corrections, which port should the dev server bind?",
    },
    {
      answer: projectName,
      correction: `Correction: rename the project from ${provisionalName} to ${projectName}.`,
      provisional: `Provisionally calling the project ${provisionalName} until we decide.`,
      question: "After the rename, what is the final project codename?",
    },
    {
      answer: dbPath,
      correction: `Correction: the database moved from ${provisionalDb} to ${dbPath}.`,
      provisional: `Temporary database location: ${provisionalDb}.`,
      question: "After the move, where does the tasks database live?",
    },
    {
      answer: storageKey,
      correction: `Correction: migrate away from ${provisionalStorage}; the storage key is now ${storageKey}.`,
      provisional: `Until migration, tasks persist under ${provisionalStorage}.`,
      question: "After the migration, which localStorage key holds the tasks?",
    },
  ];

  const testRunOutput = `47 passed, 2 skipped, 0 failed; coverage ${
    80 + (Number.parseInt(baselineSha(`${seed}:cov`, 1), 16) % 19)
  }.${Number.parseInt(baselineSha(`${seed}:cov2`, 1), 16) % 10}%`;
  const buildHash = baselineSha(`${seed}:build`, 10);
  const lintOutput = `0 errors, ${
    3 + (Number.parseInt(baselineSha(`${seed}:lint`, 1), 16) % 6)
  } warnings (all no-console)`;
  const deployId = `dep_${baselineSha(`${seed}:deploy`, 9)}`;

  const toolFacts = [
    {
      answer: testRunOutput,
      output: testRunOutput,
      question: "What was the exact output of the last full test run?",
      tool: "run_tests",
    },
    {
      answer: buildHash,
      output: `build ok; content hash ${buildHash}`,
      question: "What is the exact content hash from the last build?",
      tool: "run_build",
    },
    {
      answer: lintOutput,
      output: lintOutput,
      question: "What was the exact lint summary line?",
      tool: "run_lint",
    },
    {
      answer: deployId,
      output: `deployed to staging as ${deployId}`,
      question: "What is the exact staging deployment id?",
      tool: "deploy_preview",
    },
  ];

  const tasks = [
    { id: "task-scaffold", status: "done" },
    { id: "task-localstorage", status: "done" },
    { id: "task-dark-mode", status: "in-progress" },
    {
      blocker: "waiting on the design token export from the theme repo",
      id: "task-theme-sync",
      status: "blocked",
    },
    { id: "task-offline-queue", status: "queued" },
  ];
  const nextAction = `wire ${cssVar} into the toggle and finish task-dark-mode`;
  const board = tasks
    .map((task) =>
      task.status === "blocked"
        ? `- ${task.id}: ${task.status} (blocker: ${task.blocker})`
        : `- ${task.id}: ${task.status}`
    )
    .join("\n");

  const taskQuestions: FixtureQuestion[] = [
    {
      answer: "task-dark-mode",
      category: "task-continuation",
      question: "Which task is currently in progress?",
    },
    {
      answer: "waiting on the design token export from the theme repo",
      category: "task-continuation",
      question: "What exactly is blocking task-theme-sync?",
    },
    {
      answer: nextAction,
      category: "task-continuation",
      question: "What is the recorded next action?",
    },
    {
      answer: "queued",
      category: "task-continuation",
      question: "What is the status of task-offline-queue?",
    },
    {
      answer: "done",
      category: "task-continuation",
      question: "What is the status of task-localstorage?",
    },
    {
      answer: "task-offline-queue",
      category: "task-continuation",
      question: "Which task is still queued?",
    },
    {
      answer: "task-scaffold",
      category: "task-continuation",
      question: "Which task was completed first on the board?",
    },
    {
      answer: "blocked",
      category: "task-continuation",
      question: "What is the status of task-theme-sync?",
    },
  ];

  return {
    board,
    corrections,
    exactFacts,
    nextAction,
    projectName,
    storageKey,
    taskQuestions,
    toolFacts,
  };
}
