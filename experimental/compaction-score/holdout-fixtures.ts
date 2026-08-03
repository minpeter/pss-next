/**
 * Hold-out fixtures for auditing compaction-quality results.
 *
 * These scenarios were written after freezing the runtime ledger heuristics
 * and deliberately avoid every surface pattern the original fixtures use:
 * no `FINAL_*=` assignments, no `[debug:...]` noise prefixes, no vocabulary
 * from any historical salience keyword list. Noise is JSON-lines, Korean
 * prose, and timestamped INFO logs; facts sit at early, middle, and late
 * log positions. Implementation changes after observing hold-out results
 * would re-contaminate them.
 */
import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import {
  type CompactionFixture,
  type FixtureQuestion,
  validateCompactionFixture,
} from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});
const sha = (input: string, length = 8): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

const toolCall = (toolCallId: string, toolName: string): ModelMessage => ({
  content: [
    { input: { scope: "all" }, toolCallId, toolName, type: "tool-call" },
  ],
  role: "assistant",
});

const toolResult = (
  toolCallId: string,
  toolName: string,
  value: string
): ModelMessage => ({
  content: [
    {
      output: { type: "text", value },
      toolCallId,
      toolName,
      type: "tool-result",
    },
  ],
  role: "tool",
});

const question = (
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion => ({ answer, category, question: text });

export function buildHoldoutFixture(
  scenario: "holdout-json" | "holdout-cjk" | "holdout-log",
  seed: string
): CompactionFixture {
  if (scenario === "holdout-json") {
    return buildHoldoutJsonFixture(seed);
  }
  if (scenario === "holdout-cjk") {
    return buildHoldoutCjkFixture(seed);
  }
  return buildHoldoutLogFixture(seed);
}

function buildHoldoutJsonFixture(seed: string): CompactionFixture {
  const checksum = sha(`${seed}:checksum`, 16);
  const undoCommand = `exportctl undo ${sha(`${seed}:undo`, 9)}`;
  const reviewToken = `rev_${sha(`${seed}:review`, 12)}`;
  const haltReason = "quota window exhausted";
  const rows = "58231";
  const columns = "17";

  const jsonNoise = (phase: string, count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `{"level":"info","event":"tick","phase":"${phase}","seq":${index},"lag_ms":${(index * 7) % 143}}`
    );
  const exportLog = [
    `{"event":"schema_locked","columns":${columns}}`,
    ...jsonNoise("early", 80),
    `{"event":"finalized","checksum":"${checksum}","rows":${rows}}`,
    ...jsonNoise("late", 80),
    `{"event":"undo_hint","command":"${undoCommand}"}`,
  ].join("\n");

  const messages: ModelMessage[] = [
    user(
      "Export the orders dataset and verify its integrity before publishing."
    ),
    assistant("I will export the dataset and verify every recorded value."),
    user("Hard requirement: keep the column order stable across exports."),
    assistant("Column order stability is recorded as a hard requirement."),
    user("Provisional dataset name: orders_v2."),
    assistant("orders_v2 noted as provisional."),
    user("Run the export now."),
    toolCall("export-1", "export_report"),
    toolResult(
      "export-1",
      "export_report",
      `{"event":"halted","reason":"${haltReason}"}`
    ),
    assistant("The first export halted without producing a report."),
    user("Retry the export with the full quota."),
    toolCall("export-2", "export_report"),
    toolResult("export-2", "export_report", exportLog),
    assistant(
      "The export completed; the log carries the definitive values and I will not restate them here."
    ),
    user("Correction: the dataset name is orders_final, not orders_v2."),
    assistant("Dataset name recorded as orders_final."),
    user(`The review token for this export is ${reviewToken}.`),
    assistant("The review token is recorded unchanged."),
    user(
      "Next action: publish orders_final to the metrics bucket, then close ticket TCK-4410."
    ),
    assistant("Publish to the metrics bucket, then close TCK-4410."),
  ];
  const end = messages.length;
  messages.push(
    user("Let's talk about the readme wording now."),
    assistant("Readme wording does not change any recorded export value."),
    user("Keep the export facts unchanged while we edit prose."),
    assistant("All export facts remain exactly as recorded.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "exact-recall",
      checksum,
      "What exact checksum appears in the export log?"
    ),
    question(
      "exact-recall",
      undoCommand,
      "What exact undo command appears in the export log?"
    ),
    question("tool-history", rows, "Exactly how many rows were finalized?"),
    question(
      "tool-history",
      columns,
      "Exactly how many columns were schema-locked?"
    ),
    question(
      "negative-knowledge",
      haltReason,
      "What exact reason halted the first export?"
    ),
    question(
      "temporal-resolution",
      "orders_final",
      "What is the final dataset name?"
    ),
    question(
      "boundary-recall",
      reviewToken,
      "What is the exact review token stated for this export?"
    ),
    question(
      "task-continuation",
      "publish orders_final to the metrics bucket, then close ticket TCK-4410",
      "What is the recorded next action?"
    ),
  ];

  return validateCompactionFixture({
    compactionEnds: [end],
    messages,
    questions,
    scenario: "holdout-json",
  });
}

function buildHoldoutCjkFixture(seed: string): CompactionFixture {
  const verifyHash = sha(`${seed}:검증`, 16);
  const restoreCommand = `bae undo ${sha(`${seed}:복원`, 9)}`;
  const region = "kr-central-2";
  const failedLesson =
    "메모리 캐시 프리로딩은 재시도 금지 - 콜드스타트 지연이 3배로 늘었다";

  const cjkNoise = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `알림: 캐시 항목 ${index + 1000}번이 갱신되었습니다 (지연 ${(index * 3) % 97}ms)`
    );
  const deployLog = [
    `대상 리전은 ${region} 입니다`,
    ...cjkNoise(110),
    `최종 검증 해시는 ${verifyHash} 입니다`,
    ...cjkNoise(110),
    `복원 절차: ${restoreCommand}`,
  ].join("\n");

  const messages: ModelMessage[] = [
    user("결제 서비스 배포를 진행하고 모든 검증 값을 정확히 보존해 주세요."),
    assistant("배포를 진행하며 검증 값을 그대로 보존하겠습니다."),
    user("제약: 공개 API 이름은 절대 바꾸지 마세요."),
    assistant("공개 API 이름 변경 금지 제약을 기록했습니다."),
    user("임시 포트는 8080 입니다."),
    assistant("포트 8080을 임시 값으로 기록했습니다."),
    user("배포 로그를 확인해 주세요."),
    toolCall("deploy-1", "read_deploy_log"),
    toolResult("deploy-1", "read_deploy_log", deployLog),
    assistant("배포 로그의 값이 최종본이며 여기서 반복하지 않겠습니다."),
    user("정정: 최종 포트는 8443 입니다. 8080이 아닙니다."),
    assistant("최종 포트를 8443으로 기록했습니다."),
    user(`실패 교훈: ${failedLesson}.`),
    assistant("해당 접근은 재시도하지 않도록 기록했습니다."),
    user("다음 작업: 8443 포트로 헬스체크를 붙이고 배포 티켓을 닫아 주세요."),
    assistant("8443 헬스체크 연결 후 배포 티켓을 닫겠습니다."),
  ];
  const end = messages.length;
  messages.push(
    user("이제 릴리스 노트 문구만 다듬어 봅시다."),
    assistant("릴리스 노트 문구는 기록된 배포 값에 영향을 주지 않습니다."),
    user("문구 작업 중에도 배포 값은 바꾸지 마세요."),
    assistant("배포 값은 기록된 그대로 유지됩니다.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "exact-recall",
      verifyHash,
      "배포 로그에 기록된 정확한 최종 검증 해시는 무엇인가요?"
    ),
    question(
      "exact-recall",
      restoreCommand,
      "배포 로그에 기록된 정확한 복원 명령은 무엇인가요?"
    ),
    question(
      "tool-history",
      region,
      "배포 로그에 기록된 정확한 대상 리전은 무엇인가요?"
    ),
    question("temporal-resolution", "8443", "최종 포트는 정확히 몇 번인가요?"),
    question(
      "negative-knowledge",
      failedLesson,
      "재시도하면 안 되는 접근과 그 이유는 정확히 무엇인가요?"
    ),
    question(
      "constraint-retention",
      "공개 API 이름은 절대 바꾸지 마세요",
      "기록된 공개 API 제약은 정확히 무엇인가요?"
    ),
    question(
      "task-continuation",
      "8443 포트로 헬스체크를 붙이고 배포 티켓을 닫아 주세요",
      "기록된 다음 작업은 무엇인가요?"
    ),
  ];

  return validateCompactionFixture({
    compactionEnds: [end],
    messages,
    questions,
    scenario: "holdout-cjk",
  });
}

function buildHoldoutLogFixture(seed: string): CompactionFixture {
  const experimentId = `exp-${sha(`${seed}:experiment`, 10)}`;
  const snapshotTag = `v1.4.0-rc3.${sha(`${seed}:snapshot`, 4)}`;
  const winnerLine = "winner determined: variant B-217 conversion 4.83%";
  const emptyReason = "no rows: retention filter mismatched";

  const infoNoise = (count: number, offset: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `2026-07-26 10:${String((index + offset) % 60).padStart(2, "0")}:${String(
          index % 60
        ).padStart(
          2,
          "0"
        )} INFO worker-${(index % 5) + 1} heartbeat seq=${index + offset}`
    );
  const experimentLog = [
    `analysis started for ${experimentId}`,
    ...infoNoise(100, 0),
    winnerLine,
    ...infoNoise(100, 200),
    `run finished; snapshot tag ${snapshotTag}`,
  ].join("\n");

  const messages: ModelMessage[] = [
    user(
      "Analyze the checkout experiment and keep every measured value exact."
    ),
    assistant("I will analyze the experiment and keep measurements exact."),
    user("Provisional sample size: 40000 sessions."),
    assistant("Sample size 40000 recorded as provisional."),
    user("Query the experiment results."),
    toolCall("query-1", "fetch_experiment_log"),
    toolResult("query-1", "fetch_experiment_log", emptyReason),
    assistant("The first query returned nothing usable."),
    user("Fix the filter and fetch the full log."),
    toolCall("query-2", "fetch_experiment_log"),
    toolResult("query-2", "fetch_experiment_log", experimentLog),
    assistant(
      "The full log is authoritative for every measurement; I will not repeat its values here."
    ),
    user("Correction: the sample size was 62000 sessions, not 40000."),
    assistant("Sample size recorded as 62000 sessions."),
    user("Next action: archive the losing variant and brief the growth team."),
    assistant("Archive the losing variant, then brief the growth team."),
  ];
  const end = messages.length;
  messages.push(
    user("Now let's rename the dashboard widgets."),
    assistant("Widget names do not change any measured value."),
    user("Keep the experiment numbers frozen while we rename things."),
    assistant("All experiment numbers stay exactly as measured.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "exact-recall",
      winnerLine,
      "What exact winner line appears in the experiment log?"
    ),
    question(
      "exact-recall",
      snapshotTag,
      "What exact snapshot tag appears in the experiment log?"
    ),
    question(
      "tool-history",
      experimentId,
      "What exact experiment id was analyzed?"
    ),
    question(
      "negative-knowledge",
      emptyReason,
      "What exact output came from the failed first query?"
    ),
    question(
      "temporal-resolution",
      "62000",
      "How many sessions were in the final sample? Answer with digits only."
    ),
    question(
      "task-continuation",
      "archive the losing variant and brief the growth team",
      "What is the recorded next action?"
    ),
  ];

  return validateCompactionFixture({
    compactionEnds: [end],
    messages,
    questions,
    scenario: "holdout-log",
  });
}
