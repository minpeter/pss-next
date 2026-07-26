import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ThreadContextMessage } from "../state/context";
import {
  buildToolEvidenceLedger,
  withToolEvidenceLedger,
} from "./auto-compaction-tool-evidence";

const measureTokens = (text: string): number => Math.ceil(text.length / 4);

const toolMessage = (value: string): ThreadContextMessage =>
  ({
    content: [
      {
        output: { type: "text", value },
        toolCallId: "call-1",
        toolName: "inspect_log",
        type: "tool-result",
      },
    ],
    role: "tool",
  }) as ModelMessage;

const noisyLog = (): string =>
  [
    "FINAL_RELEASE_TICKET=RLS-1234567",
    ...Array.from(
      { length: 120 },
      (_, index) => `[debug:${index}] provisional=abcdef012345 status=ignored`
    ),
    "FINAL_ARTIFACT_SHA=194ea49130ed8f60",
    ...Array.from(
      { length: 120 },
      (_, index) =>
        `[debug:tail:${index}] provisional=fedcba543210 status=ignored`
    ),
    "FINAL_ROLLBACK_COMMAND=deployctl rollback 980361b50",
    "inspection complete; ticket RLS-1234567; artifact 194ea49130ed8f60",
  ].join("\n");

describe("buildToolEvidenceLedger", () => {
  it("keeps small tool outputs verbatim within budget", () => {
    const ledger = buildToolEvidenceLedger(
      [toolMessage("5 passed, 4 failed")],
      { budgetTokens: 1000, measureTokens }
    );

    expect(ledger).toBe('## Deterministic Tool Evidence\n"5 passed, 4 failed"');
  });

  it("condenses oversized outputs to salient and tail lines within budget", () => {
    const source = noisyLog();
    const budgetTokens = Math.floor(measureTokens(source) / 4);

    const ledger = buildToolEvidenceLedger([toolMessage(source)], {
      budgetTokens,
      measureTokens,
    });

    expect(measureTokens(ledger)).toBeLessThanOrEqual(budgetTokens);
    expect(ledger).toContain("FINAL_ARTIFACT_SHA=194ea49130ed8f60");
    expect(ledger).toContain("deployctl rollback 980361b50");
    expect(ledger).toContain("inspection complete");
    expect(ledger).toContain("lines omitted");
    expect(ledger).not.toContain("[debug:5]");
  });

  it("selects rare lines regardless of language or format", () => {
    const source = [
      ...Array.from(
        { length: 150 },
        (_, index) => `{"level":"info","event":"tick","seq":${index}}`
      ),
      '{"event":"finalized","checksum":"9f2e4c11ab30"}',
      ...Array.from(
        { length: 150 },
        (_, index) => `알림: 캐시 항목 ${index} 갱신됨`
      ),
      "최종 스냅샷 태그는 v0.9.3-rc2 입니다",
    ].join("\n");
    const budgetTokens = Math.floor(measureTokens(source) / 4);

    const ledger = buildToolEvidenceLedger([toolMessage(source)], {
      budgetTokens,
      measureTokens,
    });

    expect(measureTokens(ledger)).toBeLessThanOrEqual(budgetTokens);
    expect(ledger).toContain("9f2e4c11ab30");
    expect(ledger).toContain("v0.9.3-rc2");
    expect(ledger).not.toContain('\\"seq\\":77');
    expect(ledger).not.toContain("캐시 항목 77");
  });

  it("returns an empty ledger when nothing fits the budget", () => {
    const ledger = buildToolEvidenceLedger([toolMessage(noisyLog())], {
      budgetTokens: 1,
      measureTokens,
    });

    expect(ledger).toBe("");
    expect(withToolEvidenceLedger("summary", ledger)).toBe("summary");
  });
});
