import {
  isCompactionContextMessage,
  type ThreadContextMessage,
} from "../state/context";

const TOOL_EVIDENCE_LEDGER_HEADING = "## Deterministic Tool Evidence";

export function withToolEvidenceLedger(
  summary: string,
  history: readonly ThreadContextMessage[]
): string {
  const evidence = uniqueToolEvidence(history);
  if (evidence.length === 0) {
    return summary;
  }
  return [
    summary,
    TOOL_EVIDENCE_LEDGER_HEADING,
    ...evidence.map((value) => JSON.stringify(value)),
  ].join("\n");
}

function uniqueToolEvidence(
  history: readonly ThreadContextMessage[]
): readonly string[] {
  return [
    ...new Set(
      history.flatMap((message) => {
        if (isCompactionContextMessage(message)) {
          return ledgerEvidence(message.summary);
        }
        return message.role === "tool"
          ? toolResultEvidence(message.content)
          : [];
      })
    ),
  ];
}

function ledgerEvidence(summary: string): readonly string[] {
  const ledger = summary.split(`${TOOL_EVIDENCE_LEDGER_HEADING}\n`)[1];
  if (ledger === undefined) {
    return [];
  }
  return ledger
    .split("\n## ")[0]
    .split("\n")
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === "string" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function toolResultEvidence(content: unknown): readonly string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (
      typeof part !== "object" ||
      part === null ||
      !("type" in part) ||
      part.type !== "tool-result" ||
      !("output" in part) ||
      typeof part.output !== "object" ||
      part.output === null ||
      !("type" in part.output) ||
      part.output.type !== "text" ||
      !("value" in part.output) ||
      typeof part.output.value !== "string"
    ) {
      return [];
    }
    return [part.output.value];
  });
}
