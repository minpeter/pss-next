import { dispatchAgentNotification } from "@minpeter/pss-runtime/execution";
import { createScenarioAgent, numeric } from "./agent.js";

/** @typedef {import("@minpeter/pss-runtime").AgentEvent} AgentEvent */
/** @typedef {import("@minpeter/pss-runtime").AgentTurn} AgentTurn */
/** @typedef {import("@minpeter/pss-runtime/execution").AgentHost} AgentHost */
/** @typedef {import("@minpeter/pss-runtime/execution").Checkpoint} Checkpoint */
/** @typedef {import("@minpeter/pss-runtime/execution").LeaseFencedCheckpointWriteOptions} LeaseFencedCheckpointWriteOptions */
/** @typedef {import("@minpeter/pss-runtime/platform/durable-object/celld").CelldDurableObjectState} CelldState */
/** @typedef {{ checkpoint: Checkpoint, options: LeaseFencedCheckpointWriteOptions }} InterceptedCheckpoint */

/** @param {CelldState} state @param {string} phase @param {string} token */
export async function toolCheckpoint(state, phase, token) {
  const runKey = `real-agent:tool-run:${token}`;
  if (phase === "interrupt") {
    await interruptCheckpointedRun(state, runKey, token);
  }
  const runId = await state.storage.get(runKey);
  if (typeof runId !== "string") {
    return result(state, {}, undefined);
  }
  if (phase === "resume") {
    await resumeCheckpointedRun(state, runId, token);
  }
  const stored = await state.storage.get(`real-agent:tool-result:${token}`);
  const record = isRecord(stored) ? stored : {};
  return result(state, record, runId);
}

/** @param {CelldState} state @param {string} runKey @param {string} token */
async function interruptCheckpointedRun(state, runKey, token) {
  const { agent, host } = await createScenarioAgent(state);
  const interceptedCheckpoint = interceptAfterToolCheckpoint(host);
  const dispatched = await dispatchAgentNotification({
    host,
    idempotencyKey: `tool-checkpoint:${token}`,
    input: { text: `TOOL-CHECKPOINT ${token}`, type: "user-input" },
    namespace: "celld-real-agent",
    threadKey: `tool:${token}`,
  });
  await state.storage.put(runKey, dispatched.runId);
  const turn = await agent.resume(dispatched.runId);
  if (turn === null) {
    throw new TypeError("Durable tool run was not admitted.");
  }
  collect(turn).catch(() => undefined);
  await interceptedCheckpoint;
  throw new Error("simulated response loss after tool checkpoint");
}

/** @param {CelldState} state @param {string} runId @param {string} token */
async function resumeCheckpointedRun(state, runId, token) {
  const { agent, host } = await createScenarioAgent(state);
  await releaseInterruptedLease(host, runId);
  const turn = await agent.resume(runId);
  if (turn === null) {
    const blocked = await host.store.turns.get(runId);
    throw new TypeError(
      `Durable tool run ${runId} was not resumable (${blocked?.kind ?? "missing"}/${blocked?.status ?? "missing"}).`
    );
  }
  const events = await collect(turn);
  const [checkpoint, record] = await Promise.all([
    host.store.checkpoints.latest(runId),
    host.store.turns.get(runId),
  ]);
  await state.storage.put(`real-agent:tool-result:${token}`, {
    checkpointed: checkpoint !== null,
    errors: events.flatMap((event) =>
      event.type === "turn-error" ? [event.message] : []
    ),
    eventTypes: events.map((event) => event.type),
    resumedRunId: turn.runId,
    terminalResultCount: events.filter((event) =>
      ["turn-abort", "turn-end", "turn-error"].includes(event.type)
    ).length,
    turnStatus: record?.status,
  });
}

/** @param {AgentHost} host */
function interceptAfterToolCheckpoint(host) {
  const checkpoints = host.store.leaseFencedCheckpoints;
  if (checkpoints === undefined) {
    throw new TypeError("Lease-fenced checkpoint capability is required.");
  }
  const appendFenced = checkpoints.appendFenced.bind(checkpoints);
  const intercepted = checkpointDeferred();
  checkpoints.appendFenced = async (checkpoint, options) => {
    if (checkpoint.phase === "after-tool") {
      intercepted.resolve({ checkpoint, options });
      await new Promise(() => undefined);
    }
    return await appendFenced(checkpoint, options);
  };
  return intercepted.promise;
}

/** @param {AgentHost} host @param {string} runId */
async function releaseInterruptedLease(host, runId) {
  const [checkpoint, run] = await Promise.all([
    host.store.checkpoints.latest(runId),
    host.store.turns.get(runId),
  ]);
  if (
    checkpoint?.phase !== "before-tool" ||
    run?.kind !== "notification" ||
    (run.status !== "leased" && run.status !== "running")
  ) {
    return;
  }
  const { lease: _lease, ...released } = run;
  await host.store.turns.update({ ...released, status: "suspended" });
}

/** @param {AgentTurn} turn @returns {Promise<AgentEvent[]>} */
async function collect(turn) {
  /** @type {AgentEvent[]} */
  const events = [];
  for await (const event of turn.events()) {
    events.push(event);
  }
  return events;
}

/** @param {CelldState} state @param {Record<string, unknown>} record @param {string | undefined} runId */
async function result(state, record, runId) {
  const sideEffectCount = numeric(
    await state.storage.get("real-agent:effect-count")
  );
  const toolExecutionCount = numeric(
    await state.storage.get("real-agent:tool-execution-count")
  );
  const terminalResultCount = numeric(record.terminalResultCount);
  const resumedRunId =
    typeof record.resumedRunId === "string" ? record.resumedRunId : undefined;
  const checkpointed = record.checkpointed === true;
  return {
    checkpointed,
    errors: Array.isArray(record.errors) ? record.errors : [],
    eventTypes: Array.isArray(record.eventTypes) ? record.eventTypes : [],
    leaseRecovery: "checkpoint-proven-orphan-release",
    passed:
      checkpointed &&
      resumedRunId === runId &&
      sideEffectCount === 1 &&
      toolExecutionCount === 2 &&
      terminalResultCount === 1 &&
      record.turnStatus === "completed",
    resumedRunId,
    resumedSameRun: resumedRunId === runId,
    runId,
    sideEffectCount,
    terminalResultCount,
    toolExecutionCount,
  };
}

function checkpointDeferred() {
  /** @type {(value: InterceptedCheckpoint) => void} */
  let resolve = () => undefined;
  /** @type {Promise<InterceptedCheckpoint>} */
  const promise = new Promise((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
