import { createAgent } from "@minpeter/pss-runtime";
import { createCelldHost } from "@minpeter/pss-runtime/platform/celld";
import { z } from "zod";
import { createDeterministicModel } from "./model.js";

/** @typedef {Parameters<typeof createCelldHost>[0]["state"]} CelldState */

/**
 * @param {CelldState} state
 * @param {{ automatic?: boolean }} options
 */
export async function createScenarioAgent(state, options = {}) {
  const observations = {
    hydratedByteLength: 0,
    hydratedMediaType: "",
    promptText: "",
  };
  let automaticCompactions = 0;
  /** @type {import("@minpeter/pss-runtime").AgentCompaction | undefined} */
  const compaction = options.automatic
    ? (context) => {
        if (context.reason !== "completed-turn" || automaticCompactions > 0) {
          return;
        }
        automaticCompactions += 1;
        return {
          endSeqExclusive: context.history.length,
          startSeq: 0,
          summary: `automatic:${markersInHistory(context.history).join(",")}`,
        };
      }
    : undefined;
  const host = createCelldHost({ maxPayloadBytes: 512, state });
  const recordSideEffectTool = {
    execute: async (/** @type {unknown} */ input) =>
      await recordSideEffect(state, operationId(input)),
    inputSchema: z.object({ operationId: z.string().min(1) }),
    retryPolicy: /** @type {const} */ ("idempotent"),
  };
  const agent = await createAgent({
    ...(compaction === undefined ? {} : { compaction }),
    host,
    instructions: "Execute deterministic Celld validation requests.",
    model: createDeterministicModel(observations),
    namespace: "celld-real-agent",
    tools: { record_side_effect: recordSideEffectTool },
  });
  return {
    agent,
    automaticCompactions: () => automaticCompactions,
    host,
    observations,
  };
}

/** @param {CelldState} state @param {string} key */
async function recordSideEffect(state, key) {
  const executions =
    numeric(await state.storage.get("real-agent:tool-execution-count")) + 1;
  await state.storage.put("real-agent:tool-execution-count", executions);
  if (state.storage.transaction === undefined) {
    throw new TypeError("Celld storage transaction() is required.");
  }
  return await state.storage.transaction(async (storage) => {
    const prior = await storage.get(`real-agent:effect:${key}`);
    if (prior === true) {
      return { count: numeric(await storage.get("real-agent:effect-count")) };
    }
    const count = numeric(await storage.get("real-agent:effect-count")) + 1;
    await storage.put(`real-agent:effect:${key}`, true);
    await storage.put("real-agent:effect-count", count);
    return { count };
  });
}

/** @param {unknown} input */
function operationId(input) {
  if (
    typeof input === "object" &&
    input !== null &&
    "operationId" in input &&
    typeof input.operationId === "string" &&
    input.operationId.length > 0
  ) {
    return input.operationId;
  }
  throw new TypeError("Tool operation ID is required.");
}

/** @param {unknown} value */
export function numeric(value) {
  return typeof value === "number" ? value : 0;
}

/** @param {readonly unknown[]} history */
function markersInHistory(history) {
  return [...JSON.stringify(history).matchAll(/CMP-[A-C]/g)]
    .map((match) => match[0])
    .filter((value, index, values) => values.indexOf(value) === index);
}
