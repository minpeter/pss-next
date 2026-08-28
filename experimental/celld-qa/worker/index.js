import { Echo as EchoDurableObject } from "./echo.js";
import { RealAgent as RealAgentDurableObject } from "./real-agent.js";

export class Echo extends EchoDurableObject {}

export class RealAgent extends RealAgentDurableObject {}

export default {
  /**
   * @param {Request} request
   * @param {{
   *   ECHO: { idFromName(name: string): unknown, get(id: unknown): { fetch(request: Request): Promise<Response> } },
   *   REAL_AGENT: { idFromName(name: string): unknown, get(id: unknown): { fetch(request: Request): Promise<Response> } }
   * }} env
   */
  fetch(request, env) {
    const url = new URL(request.url);
    const objectName = url.searchParams.get("object") || "pss-smoke";
    const namespace =
      url.pathname === "/real-agent" ? env.REAL_AGENT : env.ECHO;
    return namespace.get(namespace.idFromName(objectName)).fetch(request);
  },
};
