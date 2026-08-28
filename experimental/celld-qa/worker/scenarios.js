import { dispatchAgentNotification } from "@minpeter/pss-runtime/execution";
import { createScenarioAgent } from "./agent.js";
import { markers } from "./model.js";
import { attachmentLifecycle, largeHistory } from "./payload-scenarios.js";
import { toolCheckpoint } from "./tool-checkpoint.js";

/** @typedef {import("@minpeter/pss-runtime").AgentEvent} AgentEvent */
/** @typedef {import("@minpeter/pss-runtime").AgentTurn} AgentTurn */
/** @typedef {{ exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }} SqlStorage */
/** @typedef {import("@minpeter/pss-runtime/platform/celld").CelldDurableObjectState & { readonly storage: { readonly sql: SqlStorage } }} CelldState */
/** @typedef {"tool-checkpoint" | "input-ordering" | "compaction" | "large-history" | "attachment"} ScenarioName */

/** @param {CelldState} state @param {ScenarioName} scenario @param {string} phase @param {string} token */
export async function runScenario(state, scenario, phase, token) {
  switch (scenario) {
    case "tool-checkpoint":
      return await toolCheckpoint(state, phase, token);
    case "input-ordering":
      return await inputOrdering(state, token);
    case "compaction":
      return await compactionContinuity(state, phase, token);
    case "large-history":
      return await largeHistory(state, token);
    case "attachment":
      return await attachmentLifecycle(state, token);
    default:
      return assertNever(scenario);
  }
}

/** @param {CelldState} state @param {string} token */
async function inputOrdering(state, token) {
  const { agent, host } = await createScenarioAgent(state);
  const thread = agent.thread(`ordering:${token}`);
  const first = await thread.send("ordering send");
  /** @type {AgentEvent[]} */
  const events = [];
  /** @type {AgentTurn[]} */
  let followUps = [];
  let steered = false;
  for await (const event of first.events()) {
    events.push(event);
    if (event.type === "step-start" && followUps.length === 0) {
      followUps = await Promise.all([
        thread.followUp("ordering follow-up one"),
        thread.followUp("ordering follow-up two"),
      ]);
    }
    if (event.type === "step-end" && !steered) {
      steered = true;
      await thread.steer("ordering steer");
    }
  }
  for (const followUp of followUps) {
    events.push(...(await collect(followUp)));
  }
  const notification = await dispatchAgentNotification({
    host,
    idempotencyKey: `ordering-notify:${token}`,
    input: { text: "ordering notify", type: "user-input" },
    namespace: "celld-real-agent",
    threadKey: `ordering:${token}`,
  });
  const resumed = await agent.resume(notification.runId);
  if (resumed === null) {
    throw new TypeError("Notification resume was not admitted.");
  }
  events.push(...(await collect(resumed)));
  const inputSources = events.flatMap(sourceFromEvent);
  const expected = ["send", "steer", "follow-up", "follow-up", "notify"];
  return {
    inputSources,
    passed: JSON.stringify(inputSources) === JSON.stringify(expected),
  };
}

/** @param {CelldState} state @param {string} phase @param {string} token */
async function compactionContinuity(state, phase, token) {
  const threadKey = `compaction:${token}`;
  if (phase === "run") {
    const context = await createScenarioAgent(state, { automatic: true });
    const thread = context.agent.thread(threadKey);
    for (const marker of ["CMP-A", "CMP-B", "CMP-C"]) {
      await collect(await thread.send(`${marker} durable context`));
    }
    const manual = await thread.compact();
    const result = {
      automaticCompactions: context.automaticCompactions(),
      manualStatus: manual.status,
      passed:
        context.automaticCompactions() === 1 && manual.status === "compacted",
    };
    await state.storage.put(`real-agent:compaction-result:${token}`, result);
    return result;
  }
  const context = await createScenarioAgent(state);
  await collect(
    await context.agent.thread(threadKey).send("continuity marker check")
  );
  const visibleMarkers = markers(context.observations.promptText).filter(
    (marker) => marker.startsWith("CMP-")
  );
  return {
    markers: visibleMarkers,
    passed:
      JSON.stringify(visibleMarkers) ===
      JSON.stringify(["CMP-A", "CMP-B", "CMP-C"]),
  };
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

/** @param {unknown} event */
function sourceFromEvent(event) {
  if (
    typeof event === "object" &&
    event !== null &&
    "meta" in event &&
    typeof event.meta === "object" &&
    event.meta !== null &&
    "source" in event.meta &&
    typeof event.meta.source === "string"
  ) {
    return [event.meta.source];
  }
  return [];
}

/** @param {never} value */
function assertNever(value) {
  throw new TypeError(`Unexpected scenario: ${String(value)}`);
}
