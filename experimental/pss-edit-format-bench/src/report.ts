/**
 * Report rendering for the bench: pass rates with bootstrap uncertainty,
 * paired format deltas (HELM-style blocked comparison), and endpoint
 * fingerprint stratification. Pure string builder so it is unit-testable;
 * run.ts prints the result.
 */
import { EDIT_FORMATS } from "./formats";
import { EDIT_TASKS } from "./tasks";
import { bootstrapCell, pairedDelta } from "./stats";

export interface Attempt {
  readonly format: string;
  readonly model: string;
  readonly task: string;
  readonly run: number;
  readonly passed: boolean;
  readonly failure?: string;
  readonly durationMs: number;
  readonly outputTokens: number;
  readonly replyChars: number;
  readonly retries: number;
  readonly tolerances: readonly string[];
  readonly fingerprint: string | null;
  readonly recovery?: RecoveryRecord;
}

export interface RecoveryRecord {
  readonly attemptsUsed: number;
  readonly recovered: boolean;
  readonly firstAttemptFailed: boolean;
  readonly repeatedFailure: boolean;
}

const percent = (part: number, total: number): string =>
  total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)}%`;

const points = (value: number): string => `${(value * 100).toFixed(1)}pt`;

const isTransportFailure = (attempt: Attempt): boolean =>
  attempt.failure?.startsWith("request:") === true;

const scoredOf = (rows: readonly Attempt[]): readonly Attempt[] =>
  rows.filter((row) => !isTransportFailure(row));

const formatOrder = (attempts: readonly Attempt[]): readonly string[] => {
  const known = EDIT_FORMATS.map((format) => format.name).filter((name) =>
    attempts.some((attempt) => attempt.format === name)
  );
  const extras = [
    ...new Set(
      attempts
        .map((attempt) => attempt.format)
        .filter((name) => !known.includes(name))
    ),
  ].sort();
  return [...known, ...extras];
};

export const buildReport = (
  attempts: readonly Attempt[],
  models: readonly string[]
): string => {
  const formats = formatOrder(attempts);
  const out: string[] = [];
  const line = (text = ""): void => {
    out.push(text);
  };

  line("\n## Pass rate by model and format");
  line("");
  line(
    "| model | format | scored | pass | rate | se | 95% ci | strict pass | strict rate | request-failed | retries | mean output tokens | mean reply chars | mean ms |"
  );
  line("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const model of models) {
    for (const format of formats) {
      const rows = attempts.filter(
        (attempt) => attempt.model === model && attempt.format === format
      );
      if (rows.length === 0) {
        continue;
      }
      const unreachable = rows.filter(isTransportFailure).length;
      const scored = scoredOf(rows);
      const stats = bootstrapCell(scored.map((row) => row.passed));
      const strictPassed = scored.filter(
        (row) => row.passed && row.tolerances.length === 0
      ).length;
      const mean = (pick: (row: Attempt) => number): string =>
        scored.length === 0
          ? "n/a"
          : (
              scored.reduce((sum, row) => sum + pick(row), 0) / scored.length
            ).toFixed(0);
      const retries = rows.reduce((sum, row) => sum + row.retries, 0);
      line(
        `| ${model} | ${format} | ${scored.length}/${rows.length} | ${stats.passed}/${scored.length} | ${percent(stats.passed, scored.length)} | ${points(stats.se)} | [${percent(stats.ciLow * 100, 100)} – ${percent(stats.ciHigh * 100, 100)}] | ${strictPassed}/${scored.length} | ${percent(strictPassed, scored.length)} | ${unreachable} | ${retries} | ${mean((row) => row.outputTokens)} | ${mean((row) => row.replyChars)} | ${mean((row) => row.durationMs)} |`
      );
    }
  }

  line("\n## Failures by cause");
  line("");
  line("| model | format | cause | count |");
  line("|---|---|---|---|");
  for (const model of models) {
    for (const format of formats) {
      const causes = new Map<string, number>();
      for (const attempt of attempts) {
        if (attempt.model !== model || attempt.format !== format) {
          continue;
        }
        if (attempt.failure === undefined) {
          continue;
        }
        const cause = attempt.failure.split(":")[0] as string;
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
      }
      for (const [cause, count] of [...causes].sort((a, b) => b[1] - a[1])) {
        line(`| ${model} | ${format} | ${cause} | ${count} |`);
      }
    }
  }

  line("\n## Tolerance paths fired");
  line("");
  line("| model | format | tolerance | count |");
  line("|---|---|---|---|");
  for (const model of models) {
    for (const format of formats) {
      const counts = new Map<string, number>();
      for (const attempt of attempts) {
        if (attempt.model !== model || attempt.format !== format) {
          continue;
        }
        for (const tolerance of attempt.tolerances) {
          counts.set(tolerance, (counts.get(tolerance) ?? 0) + 1);
        }
      }
      for (const [tolerance, count] of [...counts].sort((a, b) => b[1] - a[1])) {
        line(`| ${model} | ${format} | ${tolerance} | ${count} |`);
      }
    }
  }

  line("\n## Paired format deltas");
  line("");
  line(
    "Bootstrap over per-task+run pairs; transport-failed attempts drop their pair."
  );
  line("");
  line("| model | pair | pairs | delta | se | 95% ci |");
  line("|---|---|---|---|---|---|");
  for (const model of models) {
    for (let left = 0; left < formats.length; left += 1) {
      for (let right = left + 1; right < formats.length; right += 1) {
        const formatA = formats[left] as string;
        const formatB = formats[right] as string;
        const keys = [
          ...new Set(
            attempts
              .filter(
                (attempt) =>
                  attempt.model === model &&
                  (attempt.format === formatA || attempt.format === formatB)
              )
              .map((attempt) => `${attempt.task}#${attempt.run}`)
          ),
        ];
        const outcomeOf = (format: string, key: string): boolean | null => {
          const [task, run] = key.split("#");
          const rows = attempts.filter(
            (attempt) =>
              attempt.model === model &&
              attempt.format === format &&
              attempt.task === task &&
              attempt.run === Number(run)
          );
          const scored = scoredOf(rows);
          return scored.length === 0 ? null : scored.every((row) => row.passed);
        };
        const stats = pairedDelta(
          keys.map((key) => outcomeOf(formatA, key)),
          keys.map((key) => outcomeOf(formatB, key))
        );
        if (stats.pairs === 0) {
          continue;
        }
        line(
          `| ${model} | ${formatA} vs ${formatB} | ${stats.pairs} | ${points(stats.delta)} | ${points(stats.se)} | [${points(stats.ciLow)} – ${points(stats.ciHigh)}] |`
        );
      }
    }
  }

  line("\n## Fingerprints");  line("");
  let anyMixed = false;
  for (const model of models) {
    for (const format of formats) {
      const fingerprints = [
        ...new Set(
          attempts
            .filter(
              (attempt) =>
                attempt.model === model &&
                attempt.format === format &&
                attempt.fingerprint !== null
            )
            .map((attempt) => attempt.fingerprint as string)
        ),
      ];
      if (fingerprints.length > 1) {
        anyMixed = true;
        line(
          `- ${model} / ${format}: mixed ${fingerprints.length} fingerprints (${fingerprints.join(", ")})`
        );
      }
    }
  }
  if (!anyMixed) {
    const singles = [
      ...new Set(
        attempts
          .filter((attempt) => attempt.fingerprint !== null)
          .map((attempt) => attempt.fingerprint as string)
      ),
    ];
    line(
      singles.length === 0
        ? "No provider fingerprints observed."
        : `Single fingerprint across the run: ${singles.join(", ")}`
    );
  }

  const recoveryRows = attempts.filter(
    (attempt) => attempt.recovery !== undefined
  );
  if (recoveryRows.length > 0) {
    line("\n## Recovery by model and format");
    line("");
    line(
      "| model | format | first-shot | recovered | recovery rate | repeated-failure | avg attempts |"
    );
    line("|---|---|---|---|---|---|---|");
    for (const model of models) {
      for (const format of formats) {
        const rows = recoveryRows.filter(
          (attempt) =>
            attempt.model === model && attempt.format === format
        );
        if (rows.length === 0) {
          continue;
        }
        const firstShot = rows.filter(
          (attempt) =>
            attempt.recovery?.recovered === true &&
            attempt.recovery?.firstAttemptFailed === false
        ).length;
        const recovered = rows.filter(
          (attempt) => attempt.recovery?.recovered === true
        ).length;
        const failedFirst = rows.filter(
          (attempt) => attempt.recovery?.firstAttemptFailed === true
        ).length;
        const recoveredFromFailure = rows.filter(
          (attempt) =>
            attempt.recovery?.firstAttemptFailed === true &&
            attempt.recovery?.recovered === true
        ).length;
        const repeated = rows.filter(
          (attempt) => attempt.recovery?.repeatedFailure === true
        ).length;
        const avgAttempts =
          rows.reduce(
            (sum, attempt) => sum + (attempt.recovery?.attemptsUsed ?? 0),
            0
          ) / rows.length;
        line(
          `| ${model} | ${format} | ${firstShot}/${rows.length} | ${recovered}/${rows.length} | ${percent(recoveredFromFailure, failedFirst)} | ${repeated}/${rows.length} | ${avgAttempts.toFixed(1)} |`
        );
      }
    }
  }

  line("\n## Per-task pass counts");
  line("");
  const header = models
    .flatMap((model) =>
      formats.map((format) => `${model.split("/").pop()} ${format}`)
    )
    .join(" | ");
  line(`| task | ${header} |`);
  line(`|---|${"---|".repeat(models.length * formats.length)}`);
  for (const task of EDIT_TASKS) {
    const cells = models.flatMap((model) =>
      formats.map((format) => {
        const scored = scoredOf(
          attempts.filter(
            (attempt) =>
              attempt.model === model &&
              attempt.format === format &&
              attempt.task === task.id
          )
        );
        return scored.length === 0
          ? "-"
          : `${scored.filter((row) => row.passed).length}/${scored.length}`;
      })
    );
    line(`| ${task.id} | ${cells.join(" | ")} |`);
  }

  return out.join("\n");
};
