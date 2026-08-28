import { createAgent } from "@minpeter/pss-runtime";
import {
  createCelldHost,
  drainCelldScheduledWork,
} from "@minpeter/pss-runtime/platform/celld";
import { echoModel } from "./echo-model.js";
import { commitEcho, reserveEcho } from "./echo-storage.js";

/** @typedef {Parameters<typeof createCelldHost>[0]["state"]} CelldState */

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
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json({ error: "malformed_json" }, { status: 400 });
      }
      throw error;
    }
    if (!isEchoPayload(payload)) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    const key =
      payload.idempotencyKey === undefined
        ? undefined
        : `idempotency:${payload.idempotencyKey}`;
    const run = () => this.process(payload.text, key);
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

  /** @param {string} text @param {string | undefined} key */
  async process(text, key) {
    if (key !== undefined) {
      const reservation = await reserveEcho(this.state.storage, key);
      if (reservation.status === "committed") {
        return Response.json(reservation.result);
      }
      if (reservation.status === "pending") {
        return Response.json({ error: "idempotency_pending" }, { status: 409 });
      }
    }
    const agent = await this.agent();
    const turn = await agent.thread("default").send(text);
    let reply = "";
    for await (const event of turn.events()) {
      if (event.type === "assistant-output") {
        reply += event.text;
      }
    }
    if (turn.runId !== undefined) {
      await agent.host.scheduler.enqueueRun(turn.runId);
    }
    return Response.json(await commitEcho(this.state.storage, key, reply));
  }

  async agent() {
    if (this.agentPromise === undefined) {
      this.agentPromise = createAgent({
        host: createCelldHost({ state: this.state }),
        instructions: "Return the requested echo text exactly.",
        model: echoModel,
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

/** @param {unknown} value */
function isEchoPayload(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    (!("idempotencyKey" in value) ||
      (typeof value.idempotencyKey === "string" &&
        value.idempotencyKey.length > 0))
  );
}
