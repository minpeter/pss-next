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
      payload.text.length === 0
    ) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    const key =
      typeof payload.idempotencyKey === "string"
        ? `idempotency:${payload.idempotencyKey}`
        : undefined;
    if (key !== undefined) {
      const prior = await this.state.storage.get(key);
      if (prior !== undefined) {
        return Response.json(prior);
      }
    }
    const run = () => this.process(payload, key);
    if (key === undefined) {
      return Response.json(await run());
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
      return Response.json(await current);
    } finally {
      this.idempotency.delete(key);
    }
  }

  async process(payload, key) {
    if (key !== undefined) {
      const prior = await this.state.storage.get(key);
      if (prior !== undefined) {
        return prior;
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
    const count = ((await this.state.storage.get("historyCount")) ?? 0) + 1;
    const commitCount =
      ((await this.state.storage.get("commitCount")) ?? 0) + 1;
    const result = {
      commitCount,
      historyCount: count,
      ok: true,
      reply,
    };
    await this.state.storage.put("commitCount", commitCount);
    await this.state.storage.put("historyCount", count);
    if (key !== undefined) {
      await this.state.storage.put(key, result);
    }
    return result;
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
