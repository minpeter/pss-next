import { createAgent } from "@minpeter/pss-runtime";
import {
  createCelldHost,
  drainCelldScheduledWork,
} from "@minpeter/pss-runtime/platform/celld";

const model = {
  doGenerate: async ({ prompt }) => ({
    content: [{ text: `echo:${lastUserText(prompt)}`, type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    warnings: [],
  }),
  modelId: "celld-echo",
  provider: "pss-celld-qa",
  specificationVersion: "v4",
};

export class Echo {
  constructor(state) {
    this.state = state;
    this.agentPromise = undefined;
    this.idempotency = new Map();
  }

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
  fetch(request, env) {
    const url = new URL(request.url);
    const objectName = url.searchParams.get("object") || "pss-smoke";
    return env.ECHO.get(env.ECHO.idFromName(objectName)).fetch(request);
  },
};

function lastUserText(prompt) {
  const message = prompt.at(-1);
  if (message === undefined || message.role !== "user") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  const part = message.content.find((item) => item.type === "text");
  return part?.text ?? "";
}

async function reserve(storage, key) {
  return await storage.transaction(async (transaction) => {
    const existing = await transaction.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = { status: "pending" };
    await transaction.put(key, pending);
    return { status: "reserved" };
  });
}

async function commit(storage, key, reply) {
  return await storage.transaction(async (transaction) => {
    const historyCount = ((await transaction.get("historyCount")) ?? 0) + 1;
    const commitCount = ((await transaction.get("commitCount")) ?? 0) + 1;
    const result = { commitCount, historyCount, ok: true, reply };
    await transaction.put("commitCount", commitCount);
    await transaction.put("historyCount", historyCount);
    if (key !== undefined) {
      await transaction.put(key, { result, status: "committed" });
    }
    return result;
  });
}
