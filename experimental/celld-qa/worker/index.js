import { createAgent } from "@minpeter/pss-runtime";
import {
  createCelldHost,
  drainCelldScheduledWork,
} from "@minpeter/pss-runtime/platform/celld";

/** @typedef {Parameters<typeof createCelldHost>[0]["state"]} CelldState */
/** @typedef {{ text: string, idempotencyKey?: string }} EchoPayload */
/** @typedef {{ commitCount: number, historyCount: number, ok: true, reply: string }} EchoResult */
/** @typedef {{ status: "committed", result: EchoResult } | { status: "pending" } | { status: "reserved" }} Reservation */

/** @type {Parameters<typeof createAgent>[0]["model"]} */
const model = {
  doGenerate: async ({ prompt }) => ({
    content: [{ text: `echo:${lastUserText(prompt)}`, type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: 0,
        total: 0,
      },
      outputTokens: { reasoning: 0, text: 0, total: 0 },
    },
    warnings: [],
  }),
  modelId: "celld-echo",
  provider: "pss-celld-qa",
  specificationVersion: "v4",
  supportedUrls: {},
  doStream: async ({ prompt }) => ({
    stream: echoStream(lastUserText(prompt)),
  }),
};

export class Echo {
  /** @param {CelldState} state */
  constructor(state) {
    this.state = state;
    this.agentPromise = undefined;
    this.idempotency = new Map();
  }

  /** @param {Request} request */
  async fetch(request) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "malformed_json" }, { status: 400 });
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.text !== "string" ||
      payload.text.length === 0 ||
      ("idempotencyKey" in payload &&
        (typeof payload.idempotencyKey !== "string" ||
          payload.idempotencyKey.length === 0))
    ) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    const key =
      typeof payload.idempotencyKey === "string"
        ? `idempotency:${payload.idempotencyKey}`
        : undefined;
    const run = () => this.process(payload, key);
    if (key === undefined) {
      return await run();
    }
    const prior = this.idempotency.get(key) ?? Promise.resolve();
    const current = prior.then(run);
    this.idempotency.set(
      key,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    try {
      return await current;
    } finally {
      this.idempotency.delete(key);
    }
  }

  /**
   * @param {EchoPayload} payload
   * @param {string | undefined} key
   */
  async process(payload, key) {
    if (key !== undefined) {
      const reservation = await reserve(this.state.storage, key);
      if (reservation.status === "committed") {
        return Response.json(reservation.result);
      }
      if (reservation.status === "pending") {
        return Response.json({ error: "idempotency_pending" }, { status: 409 });
      }
    }
    const agent = await this.agent();
    const turn = await agent.thread("default").send(payload.text);
    let reply = "";
    for await (const event of turn.events()) {
      if (event.type === "assistant-output") {
        reply += event.text;
      }
    }
    if (turn.runId !== undefined) {
      await agent.host.scheduler.enqueueRun(turn.runId);
    }
    const result = await commit(this.state.storage, key, reply);
    return Response.json(result);
  }

  async agent() {
    if (this.agentPromise === undefined) {
      this.agentPromise = createAgent({
        host: createCelldHost({ state: this.state }),
        instructions: "Return the requested echo text exactly.",
        model,
      });
    }
    return await this.agentPromise;
  }

  async alarm() {
    const agent = await this.agent();
    await drainCelldScheduledWork({
      agentForRun: () => agent,
      storage: this.state.storage,
    });
  }
}

export default {
  /**
   * @param {Request} request
   * @param {{ ECHO: { idFromName(name: string): unknown, get(id: unknown): { fetch(request: Request): Promise<Response> } } }} env
   */
  fetch(request, env) {
    const url = new URL(request.url);
    const objectName = url.searchParams.get("object") || "pss-smoke";
    return env.ECHO.get(env.ECHO.idFromName(objectName)).fetch(request);
  },
};

/** @param {readonly unknown[]} prompt */
function lastUserText(prompt) {
  const message = prompt.at(-1);
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "user" ||
    !("content" in message)
  ) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  const part = message.content.find((item) => item.type === "text");
  return typeof part?.text === "string" ? part.text : "";
}

/**
 * @param {CelldState["storage"]} storage
 * @param {string} key
 * @returns {Promise<Reservation>}
 */
async function reserve(storage, key) {
  if (storage.transaction === undefined) {
    throw new Error("Celld storage transaction() is required.");
  }
  return await storage.transaction(async (transaction) => {
    /** @type {Reservation | undefined} */
    const existing = await transaction.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = { status: "pending" };
    await transaction.put(key, pending);
    return { status: "reserved" };
  });
}

/**
 * @param {CelldState["storage"]} storage
 * @param {string | undefined} key
 * @param {string} reply
 * @returns {Promise<EchoResult>}
 */
async function commit(storage, key, reply) {
  if (storage.transaction === undefined) {
    throw new Error("Celld storage transaction() is required.");
  }
  return await storage.transaction(async (transaction) => {
    const historyCount =
      numericStorageValue(await transaction.get("historyCount")) + 1;
    const commitCount =
      numericStorageValue(await transaction.get("commitCount")) + 1;
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
function numericStorageValue(value) {
  return typeof value === "number" ? value : 0;
}

/** @param {string} text */
function echoStream(text) {
  return new ReadableStream({
    start(controller) {
      const id = "echo";
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ id, type: "text-start" });
      controller.enqueue({ delta: `echo:${text}`, id, type: "text-delta" });
      controller.enqueue({ id, type: "text-end" });
      controller.enqueue({
        finishReason: { raw: "stop", unified: "stop" },
        type: "finish",
        usage: {
          inputTokens: {
            cacheRead: 0,
            cacheWrite: 0,
            noCache: 0,
            total: 0,
          },
          outputTokens: { reasoning: 0, text: 0, total: 0 },
        },
      });
      controller.close();
    },
  });
}
