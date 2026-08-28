import { z } from "zod";
import { runScenario } from "./scenarios.js";

const requestSchema = z.object({
  phase: z.enum(["run", "verify"]),
  scenario: z.enum([
    "tool-checkpoint",
    "input-ordering",
    "compaction",
    "large-history",
    "attachment",
  ]),
  token: z.string().min(1),
});

/** @typedef {{ exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }} SqlStorage */
/** @typedef {import("@minpeter/pss-runtime/platform/celld").CelldDurableObjectState & { readonly storage: { readonly sql: SqlStorage } }} CelldState */

export class RealAgent {
  /** @param {CelldState} state */
  constructor(state) {
    this.state = state;
  }

  /** @param {Request} request */
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    let input;
    try {
      input = requestSchema.parse(await request.json());
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return Response.json({ error: "invalid_input" }, { status: 400 });
      }
      throw error;
    }
    return Response.json(
      await runScenario(this.state, input.scenario, input.phase, input.token)
    );
  }
}
