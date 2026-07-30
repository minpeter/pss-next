import type { SessionManager } from "./session-manager";

export const resolveSessionSelector = async (
  sessions: SessionManager,
  selector: string
): Promise<string> => {
  const recorded = await sessions.listSessions();
  const match = recorded.find(
    (session) =>
      session.key === selector ||
      session.key.slice(session.key.lastIndexOf("#") + 1) === selector
  );
  if (match === undefined) {
    throw new Error(`Unknown session ${JSON.stringify(selector)}`);
  }
  return match.key;
};
