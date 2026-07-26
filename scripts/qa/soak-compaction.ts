import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingAgent } from "@minpeter/pss-coding-agent";
import { inspectCodingAgentThread } from "@minpeter/pss-coding-agent/thread-inspect";
import {
  type ModelUsage,
  normalizeAgentAutoCompactionOptions,
} from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";

const CONTEXT_WINDOW = 8000;
const SOAK_ROOT = await mkdtemp(join(tmpdir(), "pss-soak-"));
const THREADS_DIR = join(SOAK_ROOT, "threads");
const WORKSPACE = join(SOAK_ROOT, "app");
const REPORT_PATH = join(
  tmpdir(),
  `pss-soak-report-${new Date().toISOString().replaceAll(":", "-")}.json`
);

const PROMPTS = [
  "Scaffold a vanilla JS single-page task manager called orbit-tasks (no build tools): index.html, styles.css, app.js with localStorage persistence. Pick port 8420 for the dev server and write that decision into README.md.",
  "Read back index.html, styles.css, and app.js, then summarize how the pieces fit together.",
  "Add a dark-mode toggle button; persist the choice in localStorage and default to system preference.",
  "Add task filters (all / active / done) with live counts in the footer.",
  "Add keyboard shortcuts: 'n' focuses the new-task input, '/' focuses a search box that filters tasks by text. Document them in README.md.",
  "Create server.mjs: a dependency-free node static file server that serves this directory on the port recorded in README.md.",
  "Add an optional due-date field to tasks, sort by due date, and migrate existing localStorage data on load.",
  "Refactor app.js into es modules: state.js (store + persistence), view.js (rendering), main.js (wiring). Keep every feature working.",
  "Add test/smoke.mjs that starts server.mjs on an ephemeral port, fetches /, and asserts the HTML contains the orbit-tasks title. Add an npm script for it.",
  "Without re-reading any files: what is the project name, which port did we choose, which files exist now, and what is still unfinished?",
];

interface TurnMeasurement {
  readonly assistantText: string;
  readonly compactionCountAfter: number;
  readonly compactions: readonly {
    readonly endSeqExclusive: number;
    readonly startSeq: number;
    readonly summaryBytes: number;
  }[];
  readonly eventCounts: Record<string, number>;
  readonly lastStepInputTokens: number | undefined;
  readonly messageCountAfter: number;
  readonly outcome: "completed" | "error";
  readonly turn: number;
  readonly turnError?: string;
}

const policy = normalizeAgentAutoCompactionOptions({
  maxInputTokens: CONTEXT_WINDOW,
});

await mkdir(WORKSPACE, { recursive: true });

const agent = await createCodingAgent({
  autoCompaction: { maxInputTokens: CONTEXT_WINDOW },
  host: createFileHost({ directory: THREADS_DIR }),
  webTools: { availability: "disabled" },
  workspace: WORKSPACE,
});
const thread = agent.thread("soak:webdev");

const measurements: TurnMeasurement[] = [];

const inspect = () =>
  inspectCodingAgentThread({
    autoCompaction: { maxInputTokens: CONTEXT_WINDOW },
    directory: THREADS_DIR,
    key: "soak:webdev",
  });

const macrotask = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const settleCompactions = async () => {
  let stableTicks = 0;
  let previous = -1;
  for (let tick = 0; tick < 200 && stableTicks < 5; tick += 1) {
    await macrotask();
    const count = (await inspect()).compactionCount;
    stableTicks = count === previous ? stableTicks + 1 : 0;
    previous = count;
  }
};

for (const [index, prompt] of PROMPTS.entries()) {
  let lastUsage: ModelUsage | undefined;
  let assistantText = "";
  let turnError: string | undefined;
  const eventCounts: Record<string, number> = {};
  const turn = await thread.send(prompt);
  for await (const event of turn.events()) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === "model-usage") {
      lastUsage = event;
    }
    if (event.type === "assistant-output") {
      assistantText += event.text;
    }
    if (event.type === "turn-error") {
      turnError = event.message;
    }
  }

  await settleCompactions();
  const settled = await inspect();
  measurements.push({
    assistantText,
    compactionCountAfter: settled.compactionCount,
    compactions: settled.compactions.map((record) => ({
      endSeqExclusive: record.endSeqExclusive,
      startSeq: record.startSeq,
      summaryBytes: record.summaryBytes,
    })),
    eventCounts,
    lastStepInputTokens: lastUsage?.inputTokens,
    messageCountAfter: settled.messageCount,
    outcome: turnError === undefined ? "completed" : "error",
    turn: index + 1,
    ...(turnError === undefined ? {} : { turnError }),
  });

  const latest = measurements.at(-1);
  console.log(
    `turn ${latest?.turn}: ${latest?.outcome} inputTokens(last step)=${latest?.lastStepInputTokens ?? "?"} messages=${latest?.messageCountAfter} compactions=${latest?.compactionCountAfter}${latest?.turnError ? ` error=${latest.turnError.slice(0, 120)}` : ""}`
  );
}

await writeFile(
  REPORT_PATH,
  JSON.stringify(
    {
      contextWindow: CONTEXT_WINDOW,
      measurements,
      policy,
      soakRoot: SOAK_ROOT,
      workspace: WORKSPACE,
    },
    null,
    2
  )
);

console.log(`policy: ${JSON.stringify(policy)}`);
console.log(`report: ${REPORT_PATH}`);

await rm(SOAK_ROOT, { force: true, recursive: true });
console.log(`cleanup: removed ${SOAK_ROOT}`);
