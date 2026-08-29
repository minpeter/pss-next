/** @typedef {import("@minpeter/pss-runtime/platform/durable-object/celld").CelldDurableObjectStorage} CelldStorage */
/** @typedef {{ commitCount: number, historyCount: number, ok: true, reply: string }} EchoResult */
/** @typedef {{ status: "committed", result: EchoResult } | { status: "pending" } | { status: "reserved" }} Reservation */

/** @param {CelldStorage} storage @param {string} key @returns {Promise<Reservation>} */
export async function reserveEcho(storage, key) {
  if (storage.transaction === undefined) {
    throw new TypeError("Celld storage transaction() is required.");
  }
  return await storage.transaction(async (transaction) => {
    /** @type {Reservation | undefined} */
    const existing = await transaction.get(key);
    if (existing !== undefined) {
      return existing;
    }
    await transaction.put(key, { status: "pending" });
    return { status: "reserved" };
  });
}

/** @param {CelldStorage} storage @param {string | undefined} key @param {string} reply */
export async function commitEcho(storage, key, reply) {
  if (storage.transaction === undefined) {
    throw new TypeError("Celld storage transaction() is required.");
  }
  return await storage.transaction(async (transaction) => {
    const historyCount = numeric(await transaction.get("historyCount")) + 1;
    const commitCount = numeric(await transaction.get("commitCount")) + 1;
    /** @type {EchoResult} */
    const result = { commitCount, historyCount, ok: true, reply };
    await transaction.put("commitCount", commitCount);
    await transaction.put("historyCount", historyCount);
    if (key !== undefined) {
      await transaction.put(key, { result, status: "committed" });
    }
    return result;
  });
}

/** @param {unknown} value */
function numeric(value) {
  return typeof value === "number" ? value : 0;
}
