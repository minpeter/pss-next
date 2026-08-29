import { createScenarioAgent } from "./agent.js";
import { markers } from "./model.js";

/** @typedef {import("@minpeter/pss-runtime").AgentEvent} AgentEvent */
/** @typedef {import("@minpeter/pss-runtime").AgentTurn} AgentTurn */
/** @typedef {{ exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }} SqlStorage */
/** @typedef {import("@minpeter/pss-runtime/platform/durable-object/celld").CelldDurableObjectState & { readonly storage: { readonly sql: SqlStorage } }} CelldState */

/** @param {CelldState} state @param {string} token */
export async function largeHistory(state, token) {
  const context = await createScenarioAgent(state);
  const thread = context.agent.thread(`large:${token}`);
  const payloads = Array.from({ length: 4 }, (_, index) => {
    const marker = `LARGE-${String(index).padStart(2, "0")}`;
    return `${marker}:${"x".repeat(8192 - marker.length - 1)}`;
  });
  for (const payload of payloads) {
    await collect(await thread.send(payload));
  }
  const visibleMarkers = markers(context.observations.promptText).filter(
    (marker) => marker.startsWith("LARGE-")
  );
  const threadKey = state.storage.sql
    .exec("SELECT thread_key FROM pss_thread_meta")
    .toArray()
    .find(isLargeThreadKey(token));
  if (!isThreadKeyRow(threadKey)) {
    throw new TypeError("Large-history thread metadata was not persisted.");
  }
  const messages = state.storage.sql
    .exec(
      "SELECT seq, message FROM pss_thread_message WHERE thread_key = ? ORDER BY seq",
      threadKey.thread_key
    )
    .toArray();
  const sequenceNumbers = messages.flatMap(sequenceNumber);
  const placeholders = sequenceNumbers.map(() => "?").join(", ");
  const chunkCount =
    placeholders.length === 0
      ? 0
      : state.storage.sql
          .exec(
            `SELECT seq, chunk_index, chunk FROM pss_thread_message_chunk WHERE thread_key = ? AND seq IN (${placeholders}) ORDER BY seq, chunk_index`,
            threadKey.thread_key,
            ...sequenceNumbers
          )
          .toArray().length;
  return {
    chunked: chunkCount > 0,
    markers: visibleMarkers,
    passed: chunkCount > 0 && visibleMarkers.length === payloads.length,
    payloadBytes: payloads.reduce(
      (total, payload) => total + new TextEncoder().encode(payload).byteLength,
      0
    ),
  };
}

/** @param {CelldState} state @param {string} token */
export async function attachmentLifecycle(state, token) {
  const context = await createScenarioAgent(state);
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    ),
    (character) => character.charCodeAt(0)
  );
  const events = await collect(
    await context.agent.thread(`attachment:${token}`).send([
      { text: "attachment hydration", type: "text" },
      {
        data: png,
        filename: "pixel.png",
        mediaType: "image/png",
        type: "file",
      },
    ])
  );
  const persistedReference = JSON.stringify(events).includes("pss-attachment:");
  return {
    hydratedByteLength: context.observations.hydratedByteLength,
    hydratedMediaType: context.observations.hydratedMediaType,
    normalized: context.observations.hydratedMediaType === "image/png",
    passed:
      persistedReference &&
      context.observations.hydratedByteLength === png.byteLength &&
      context.observations.hydratedMediaType === "image/png",
    persistedReference,
  };
}

/** @param {string} token */
function isLargeThreadKey(token) {
  return (/** @type {unknown} */ row) =>
    isThreadKeyRow(row) && row.thread_key.includes(`large:${token}`);
}

/** @param {unknown} row @returns {row is { readonly thread_key: string }} */
function isThreadKeyRow(row) {
  return (
    typeof row === "object" &&
    row !== null &&
    "thread_key" in row &&
    typeof row.thread_key === "string"
  );
}

/** @param {unknown} row */
function sequenceNumber(row) {
  return typeof row === "object" &&
    row !== null &&
    "seq" in row &&
    typeof row.seq === "number"
    ? [row.seq]
    : [];
}

/** @param {AgentTurn} turn @returns {Promise<AgentEvent[]>} */
async function collect(turn) {
  const events = [];
  for await (const event of turn.events()) {
    events.push(event);
  }
  return events;
}
