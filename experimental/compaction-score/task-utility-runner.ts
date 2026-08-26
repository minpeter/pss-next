import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodingAgent } from "@minpeter/pss-coding-agent";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import {
  decodeStoredThreadState,
  encodeThreadSnapshot,
} from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import type { LanguageModel } from "ai";
import {
  abortableTaskUtilityWork,
  withTaskUtilityAttemptTimeout,
  withValidFullControl,
} from "./task-utility-attempt";
import {
  createTaskUtilityCheckpointIdentity,
  TASK_UTILITY_FULL_CONTROL_ATTEMPTS,
} from "./task-utility-checkpoint";
import { classifyTaskUtilityPair } from "./task-utility-classification";
import { runDeterministicTaskArm } from "./task-utility-deterministic";
import { taskUtilityAssistantOutput } from "./task-utility-events";
import {
  TASK_UTILITY_FIXTURES,
  type TaskUtilityFixture,
} from "./task-utility-fixtures";
import {
  loadTaskUtilityPartial,
  writeTaskUtilityPartial,
} from "./task-utility-storage";
import type {
  TaskArmExecution,
  TaskArmResult,
  TaskUtilityArm,
  TaskUtilityMode,
  TaskUtilityPair,
} from "./task-utility-types";
import { validateTaskWorkspace } from "./task-utility-validator";

export async function runTaskUtilityCampaign({
  attemptTimeoutMs,
  mode,
  outputDirectory,
  repetitions,
}: {
  readonly attemptTimeoutMs: number;
  readonly mode: TaskUtilityMode;
  readonly outputDirectory: string;
  readonly repetitions: number;
}): Promise<readonly TaskUtilityPair[]> {
  const model =
    mode === "live"
      ? createCodingLanguageModel({ providerName: "task-utility" })
      : undefined;
  const modelName =
    mode === "live"
      ? readOpenAICompatibleModelEnv().AI_MODEL
      : "deterministic-mock";
  const identity = createTaskUtilityCheckpointIdentity({
    attemptTimeoutMs,
    mode,
    model: modelName,
    repetitions,
  });
  const pairs: TaskUtilityPair[] = [
    ...(await loadTaskUtilityPartial(outputDirectory, identity)),
  ].filter(({ fullPassed }) => fullPassed);
  const completed = new Set(
    pairs.map((pair) => `${pair.fixture}:${pair.repetition}`)
  );
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const fixture of TASK_UTILITY_FIXTURES) {
      const key = `${fixture.id}:${repetition}`;
      if (completed.has(key)) {
        console.log(`[${fixture.id} r${repetition}] resume=preserved`);
        continue;
      }
      const order =
        repetition % 2 === 1
          ? (["full", "compact"] as const)
          : (["compact", "full"] as const);
      const pair = await withValidFullControl(
        TASK_UTILITY_FULL_CONTROL_ATTEMPTS,
        async () => {
          const arms: TaskArmResult[] = [];
          for (const arm of order) {
            arms.push(
              await runTaskArm({
                arm,
                attemptTimeoutMs,
                fixture,
                mode,
                model,
                outputDirectory,
                repetition,
              })
            );
          }
          const full = arms.find((result) => result.arm === "full");
          const compact = arms.find((result) => result.arm === "compact");
          if (!(full && compact)) {
            throw new TypeError("Task utility pair is missing an arm.");
          }
          return classifyTaskUtilityPair(
            fixture,
            repetition,
            order,
            full,
            compact
          );
        }
      );
      pairs.push(pair);
      completed.add(key);
      await writeTaskUtilityPartial(outputDirectory, identity, pairs);
      console.log(
        `[${fixture.id} r${repetition}] full=${pair.fullPassed} compact=${pair.compactPassed}`
      );
    }
  }
  return pairs.sort((left, right) => {
    const fixtureOrder =
      TASK_UTILITY_FIXTURES.findIndex(({ id }) => id === left.fixture) -
      TASK_UTILITY_FIXTURES.findIndex(({ id }) => id === right.fixture);
    return fixtureOrder || left.repetition - right.repetition;
  });
}

async function runTaskArm({
  arm,
  attemptTimeoutMs,
  fixture,
  mode,
  model,
  outputDirectory,
  repetition,
}: {
  readonly arm: TaskUtilityArm;
  readonly attemptTimeoutMs: number;
  readonly fixture: TaskUtilityFixture;
  readonly mode: TaskUtilityMode;
  readonly model: LanguageModel | undefined;
  readonly outputDirectory: string;
  readonly repetition: number;
}): Promise<TaskArmResult> {
  const workspace = join(
    outputDirectory,
    "workspaces",
    fixture.id,
    `r${repetition}`,
    arm
  );
  await rm(workspace, { force: true, recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, fixture.targetFile), fixture.initialSource);
  const initialValidation = await validateTaskWorkspace(fixture, workspace);
  if (initialValidation.passed) {
    throw new TypeError(`Fixture ${fixture.id} is not RED before execution.`);
  }
  const startedAt = performance.now();
  const execution = await withTaskUtilityAttemptTimeout(
    attemptTimeoutMs,
    async (abortSignal) => {
      if (mode === "deterministic") {
        return await runDeterministicTaskArm(fixture, workspace, arm);
      }
      if (model === undefined) {
        throw new TypeError("Live task utility mode requires a model.");
      }
      return await runLiveArm(fixture, workspace, arm, model, abortSignal);
    }
  );
  const validation = await validateTaskWorkspace(fixture, workspace);
  const result: TaskArmResult = {
    arm,
    assistantOutput: execution.assistantOutput,
    costUsd: null,
    durationMs: performance.now() - startedAt,
    events: execution.events,
    initialValidation,
    passed: validation.passed,
    summary: execution.summary,
    validation,
    workspace,
  };
  await writeFile(
    join(workspace, "task-utility-receipt.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );
  return result;
}

async function runLiveArm(
  fixture: TaskUtilityFixture,
  workspace: string,
  arm: TaskUtilityArm,
  model: LanguageModel,
  abortSignal: AbortSignal
): Promise<TaskArmExecution> {
  const host = createInMemoryHost();
  const threadKey = `${fixture.id}-${arm}-${randomUUID()}`;
  const committed = await host.store.threads.commit(
    threadKey,
    { state: encodeThreadSnapshot(fixture.history) },
    { expectedVersion: null }
  );
  if (!committed.ok) {
    throw new Error("Failed to seed task utility thread.");
  }
  const agent = await createCodingAgent({
    compaction: () => undefined,
    host,
    model,
    tools: {},
    workspace,
  });
  try {
    return await abortableTaskUtilityWork(
      (async () => {
        const thread = agent.thread(threadKey);
        let summary: string | null = null;
        if (arm === "compact") {
          const compacted = await thread.compact({ signal: abortSignal });
          if (compacted.status !== "compacted") {
            throw new Error(`Task utility compaction ${compacted.status}.`);
          }
          const stored = await host.store.threads.load(threadKey);
          const content =
            decodeStoredThreadState(stored).compactions.at(-1)?.summary.content;
          summary = typeof content === "string" ? content : null;
        }
        const turn = await thread.send(fixture.finalPrompt);
        const events: unknown[] = [];
        for await (const event of turn.events()) {
          events.push(event);
          if (event.type === "turn-error" || event.type === "turn-abort") {
            throw new Error(`Task utility turn ended with ${event.type}.`);
          }
        }
        return {
          assistantOutput: taskUtilityAssistantOutput(events),
          events,
          summary,
        };
      })(),
      abortSignal
    );
  } finally {
    await agent.dispose();
  }
}
