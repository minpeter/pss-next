import {
  isCompactionContextMessage,
  type ThreadContextMessage,
} from "../state/context";

const TOOL_EVIDENCE_LEDGER_HEADING = "## Deterministic Tool Evidence";

/**
 * Lines that carry durable, exact evidence worth preserving verbatim even
 * when a tool output must be condensed: final state assignments, pass/fail
 * counts, errors, and rollback/exit facts.
 */
const SALIENT_LINE_PATTERN =
  /\b(?:error|fail(?:ed|ure)?|fatal|panic|exception|rollback|revert|root cause|exit code|complete(?:d)?|success(?:ful)?|passed|blocked)\b|^[A-Z][A-Z0-9_]{2,}=/im;

const NOISE_LINE_PATTERN = /^\s*\[?(?:debug|trace|verbose)\b/i;

const MAX_SALIENT_LINES_PER_ITEM = 60;

export interface ToolEvidenceLedgerBudget {
  readonly budgetTokens: number;
  readonly measureTokens: (text: string) => number;
}

interface CondensePlan {
  readonly headLines: number;
  readonly keepSalient: boolean;
  readonly tailLines: number;
}

const CONDENSE_STAGES: readonly CondensePlan[] = [
  { headLines: 3, keepSalient: true, tailLines: 10 },
  { headLines: 0, keepSalient: true, tailLines: 5 },
  { headLines: 0, keepSalient: false, tailLines: 3 },
];

/**
 * Build the deterministic tool-evidence ledger for a compaction summary.
 *
 * Without a budget the ledger preserves every unique tool output verbatim.
 * With a budget it degrades deterministically: full verbatim, then per-item
 * head + salient + tail condensation, then tail-only, then dropping the
 * oldest items, and finally an empty ledger when nothing fits.
 */
export function buildToolEvidenceLedger(
  history: readonly ThreadContextMessage[],
  budget?: ToolEvidenceLedgerBudget
): string {
  const evidence = uniqueToolEvidence(history);
  if (evidence.length === 0) {
    return "";
  }
  const full = ledgerText(evidence);
  if (!budget || budget.measureTokens(full) <= budget.budgetTokens) {
    return full;
  }
  return condensedLedger(evidence, budget);
}

export function withToolEvidenceLedger(
  summary: string,
  ledger: string
): string {
  if (ledger.length === 0) {
    return summary;
  }
  return [summary, ledger].join("\n");
}

function condensedLedger(
  evidence: readonly string[],
  budget: ToolEvidenceLedgerBudget
): string {
  for (const stage of CONDENSE_STAGES) {
    const text = ledgerText(evidence.map((item) => condenseItem(item, stage)));
    if (budget.measureTokens(text) <= budget.budgetTokens) {
      return text;
    }
  }

  const minimal = evidence.map((item) =>
    condenseItem(item, CONDENSE_STAGES.at(-1) as CondensePlan)
  );
  for (let start = 1; start < minimal.length; start += 1) {
    const text = ledgerText(minimal.slice(start));
    if (budget.measureTokens(text) <= budget.budgetTokens) {
      return text;
    }
  }
  return "";
}

function condenseItem(item: string, plan: CondensePlan): string {
  const lines = item.split("\n");
  if (lines.length <= plan.headLines + plan.tailLines) {
    return item;
  }
  const head = lines.slice(0, plan.headLines);
  const tail = plan.tailLines > 0 ? lines.slice(-plan.tailLines) : [];
  const middle = plan.keepSalient
    ? salientLines(lines.slice(plan.headLines, lines.length - plan.tailLines))
    : [];
  const omitted = lines.length - head.length - middle.length - tail.length;
  const kept = [...head, ...middle];
  if (omitted > 0) {
    kept.push(`[... ${omitted} lines omitted ...]`);
  }
  kept.push(...tail);
  return kept.join("\n");
}

function salientLines(lines: readonly string[]): string[] {
  const matches = lines.filter(
    (line) => SALIENT_LINE_PATTERN.test(line) && !NOISE_LINE_PATTERN.test(line)
  );
  return matches.slice(-MAX_SALIENT_LINES_PER_ITEM);
}

function ledgerText(evidence: readonly string[]): string {
  return [
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
