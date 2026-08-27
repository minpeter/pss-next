export class Echo {
  constructor(state) {
    this.state = state;
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
    const count = ((await this.state.storage.get("historyCount")) ?? 0) + 1;
    const result = { historyCount: count, ok: true, reply: `echo:${payload.text}` };
    await this.state.storage.put("historyCount", count);
    if (key !== undefined) {
      await this.state.storage.put(key, result);
    }
    return Response.json(result);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const objectName = url.searchParams.get("object") || "pss-smoke";
    return env.ECHO.get(env.ECHO.idFromName(objectName)).fetch(request);
  },
};
