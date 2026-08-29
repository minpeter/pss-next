import type { TurnRecord } from "../../../../execution";
import type { AgentEvent } from "../../../../index";
import {
  createDurableObjectStorageHost,
  type DurableObjectStorage,
} from "../../host/storage-host";

const assistantDefaultPayloadBytes = 1536;
const notificationStride = 3;
const payloadCache = new Map<string, string>();

export interface MockAgentStorageScenarioConfig {
  readonly agentCount: number;
  readonly assistantPayloadBytes: number;
  readonly checkpointPayloadBytes: number;
  readonly eventPayloadBytes: number;
  readonly largeAssistantStride: number;
  readonly maxPayloadBytes: number;
  readonly notificationPayloadBytes: number;
  readonly prefix: string;
  readonly targetStoredChunkBytes: number;
  readonly threadCommitStride: number;
  readonly threadsPerUser: number;
  readonly turnsPerThread: number;
  readonly usersPerAgent: number;
}

export interface MockAgentStorageScenarioResult {
  readonly finalThreadKey: string;
  readonly finalThreadVersion: string;
  readonly notifications: number;
  readonly threadMessages: number;
  readonly threads: number;
  readonly turns: number;
}

export async function runMockAgentStorageScenario(
  storage: DurableObjectStorage,
  config: MockAgentStorageScenarioConfig
): Promise<MockAgentStorageScenarioResult> {
  const host = createDurableObjectStorageHost({
    maxPayloadBytes: config.maxPayloadBytes,
    prefix: config.prefix,
    storage,
  });
  const threads =
    config.agentCount * config.usersPerAgent * config.threadsPerUser;
  const turns = threads * config.turnsPerThread;
  let notifications = 0;
  let finalThreadKey = "";

  for (let agent = 0; agent < config.agentCount; agent += 1) {
    for (let user = 0; user < config.usersPerAgent; user += 1) {
      for (let thread = 0; thread < config.threadsPerUser; thread += 1) {
        const threadKey = threadKeyFor({ agent, thread, user });
        finalThreadKey = threadKey;
        const threadNotifications = await writeThreadTurns({
          assistantPayloadBytes: config.assistantPayloadBytes,
          checkpointPayloadBytes: config.checkpointPayloadBytes,
          eventPayloadBytes: config.eventPayloadBytes,
          host,
          largeAssistantStride: config.largeAssistantStride,
          notificationPayloadBytes: config.notificationPayloadBytes,
          threadCommitStride: config.threadCommitStride,
          threadKey,
          turnsPerThread: config.turnsPerThread,
        });
        notifications += threadNotifications;
      }
    }
  }

  return {
    finalThreadVersion: String(
      threadCommitCount(config.turnsPerThread, config.threadCommitStride)
    ),
    finalThreadKey,
    notifications,
    threadMessages: turns * 2,
    threads,
    turns,
  };
}

interface ThreadKeyParts {
  readonly agent: number;
  readonly thread: number;
  readonly user: number;
}

interface WriteThreadTurnsInput {
  readonly assistantPayloadBytes: number;
  readonly checkpointPayloadBytes: number;
  readonly eventPayloadBytes: number;
  readonly host: ReturnType<typeof createDurableObjectStorageHost>;
  readonly largeAssistantStride: number;
  readonly notificationPayloadBytes: number;
  readonly threadCommitStride: number;
  readonly threadKey: string;
  readonly turnsPerThread: number;
}

async function writeThreadTurns(input: WriteThreadTurnsInput): Promise<number> {
  let expectedVersion: string | null = null;
  const history: unknown[] = [];
  let notificationCount = 0;

  for (let turn = 0; turn < input.turnsPerThread; turn += 1) {
    const runId = `${input.threadKey}:run-${turn}`;
    history.push({ content: `user-turn:${turn}`, role: "user" });
    history.push({ content: assistantContent(turn, input), role: "assistant" });

    if (shouldCommitThread(turn, input)) {
      const commit = await input.host.store.threads.commit(
        input.threadKey,
        { state: { history: [...history], schemaVersion: 1 } },
        { expectedVersion }
      );
      if (!commit.ok) {
        throw new Error(`mock thread commit failed for ${input.threadKey}`);
      }
      expectedVersion = commit.version;
    }

    const run = runRecord({ runId, threadKey: input.threadKey });
    const create = await input.host.store.turns.create(run);
    if (!create.ok) {
      throw new Error(`mock run create failed for ${runId}`);
    }
    if (turn === 0) {
      const duplicate = await input.host.store.turns.create(run);
      if (duplicate.ok) {
        throw new Error(`mock run duplicate was inserted for ${runId}`);
      }
    }

    await input.host.store.events.append(
      runId,
      eventRecord("step-start", input.eventPayloadBytes)
    );
    await input.host.store.checkpoints.append(
      {
        checkpointId: `${runId}:checkpoint-1`,
        phase: "before-model",
        runId,
        runtimeState: runtimeState(turn, input.checkpointPayloadBytes),
        threadSnapshot: {
          threadKey: input.threadKey,
          version: expectedVersion,
        },
        version: 1,
      },
      { expectedVersion: 0 }
    );
    await input.host.store.events.append(
      runId,
      eventRecord("step-end", input.eventPayloadBytes)
    );
    await input.host.store.turns.update({
      ...run,
      checkpointVersion: 1,
      status: "completed",
    });

    if (turn % notificationStride === 0) {
      const notificationKey = `${runId}:notification`;
      await input.host.store.notifications.enqueue({
        idempotencyKey: notificationKey,
        input: {
          text: notificationContent(runId, input.notificationPayloadBytes),
          type: "user-input",
        },
        notificationId: notificationKey,
        runId,
        status: "pending",
        threadKey: input.threadKey,
      });
      await input.host.store.notifications.claimByIdempotencyKey(
        notificationKey
      );
      await input.host.scheduler.enqueueRun(runId);
      await input.host.scheduler.resumeThread(input.threadKey, {
        idempotencyKey: notificationKey,
        runId,
      });
      notificationCount += 1;
    }
  }

  return notificationCount;
}

function shouldCommitThread(
  turn: number,
  input: WriteThreadTurnsInput
): boolean {
  return (
    turn + 1 === input.turnsPerThread ||
    (turn + 1) % input.threadCommitStride === 0
  );
}

function threadCommitCount(turnsPerThread: number, threadCommitStride: number) {
  return Math.ceil(turnsPerThread / threadCommitStride);
}

function threadKeyFor(parts: ThreadKeyParts): string {
  return `agent-${parts.agent}:user-${parts.user}:thread-${parts.thread}`;
}

function assistantContent(turn: number, input: WriteThreadTurnsInput): string {
  return turn % input.largeAssistantStride === 0
    ? payloadText("assistant-storage-chunk", input.assistantPayloadBytes)
    : `assistant-turn:${turn}`;
}

function runRecord(input: {
  readonly runId: string;
  readonly threadKey: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: `${input.runId}:dedupe`,
    kind: "user-turn",
    rootRunId: input.runId,
    runId: input.runId,
    status: "queued",
    threadKey: input.threadKey,
  };
}

function eventRecord(
  type: "step-end" | "step-start",
  payloadBytes: number
): AgentEvent {
  if (payloadBytes > 0) {
    return {
      text: payloadText(`event-${type}`, payloadBytes),
      type: "assistant-output",
    };
  }
  if (type === "step-start") {
    return { type: "step-start" };
  }
  return { type: "step-end" };
}

function notificationContent(runId: string, payloadBytes: number): string {
  return payloadBytes > 0
    ? payloadText("notification-storage-chunk", payloadBytes)
    : `notify:${runId}`;
}

function runtimeState(turn: number, payloadBytes: number): unknown {
  return payloadBytes > 0
    ? { payload: payloadText("checkpoint-storage-chunk", payloadBytes), turn }
    : { turn };
}

function payloadText(label: string, bytes: number): string {
  const effectiveBytes = bytes > 0 ? bytes : assistantDefaultPayloadBytes;
  const key = `${label}:${effectiveBytes}`;
  const cached = payloadCache.get(key);
  if (cached) {
    return cached;
  }
  const seed = `${label}:`;
  const value = seed
    .repeat(Math.ceil(effectiveBytes / seed.length))
    .slice(0, effectiveBytes);
  payloadCache.set(key, value);
  return value;
}
