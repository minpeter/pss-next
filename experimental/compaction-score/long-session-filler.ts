import { createHash } from "node:crypto";

export const LONG_SESSION_FILLER_LINES_PER_TURN = 18;
export const LONG_SESSION_FILLER_TURNS = 48;

const sha = (input: string, length: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

export function buildLongSessionFillerTurn(
  seed: string,
  turnIndex: number
): string {
  return Array.from(
    { length: LONG_SESSION_FILLER_LINES_PER_TURN },
    (_, lineIndex) => {
      const ordinal =
        turnIndex * LONG_SESSION_FILLER_LINES_PER_TURN + lineIndex;
      const label = ordinal.toString().padStart(4, "0");
      const trace = sha(`${seed}:filler:${ordinal}:trace`, 24);
      const payload = sha(`${seed}:filler:${ordinal}:payload`, 64);
      return (
        `DISTRACTOR ${label} trace=${trace} payload=${payload} ` +
        `is an ephemeral telemetry observation for synthetic lane ${label}; ` +
        "discard it after this turn because it carries no retained decision, " +
        "identifier, path, symbol, tool evidence, or task state."
      );
    }
  ).join("\n");
}

export function longSessionFillerAcknowledgement(
  seed: string,
  turnIndex: number
): string {
  return `Ephemeral telemetry turn ${turnIndex} reviewed under receipt ${sha(
    `${seed}:filler:${turnIndex}:receipt`,
    14
  )}; no durable state was recorded.`;
}
