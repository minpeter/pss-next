import type { ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});
const path = "src/한글/設定/漢字.ts";
const identifier = "프로필＿更新・状態";
const clipping = "全角文字は80桁で切り詰めない";
const failedCommand = "명령 실패: 권한 거부 (EACCES)";
const failedTests = "실패: 2개; 型エラー at 漢字.ts:42";
const retrySuccess = "재시도 성공: 캐시를 초기화했습니다";
const finalTests = "통과: 18개; 東京✓";

export function buildToolStateCjkFixture(seed: string): CompactionFixture {
  const messages: ModelMessage[] = [
    user(
      `목표: ${identifier}를 ${path}에 구현. 제약: ${clipping}. seed=${seed}.`
    ),
    assistant("한국어, 日本語, 中文 식별자와 제약을 기록했습니다."),
    user("첫 번째 명령을 실행하세요."),
    toolCall("cjk-command-1", "pnpm 권한-검사"),
    toolResult("cjk-command-1", failedCommand),
    assistant("첫 번째 명령은 실패했고 역사적 증거로 남습니다."),
    user("실패한 테스트를 실행하세요."),
    toolCall("cjk-test-1", "pnpm test 漢字"),
    toolResult("cjk-test-1", failedTests),
    assistant("실패한 테스트 결과를 보존합니다."),
    user("권한을 수정한 뒤 명령을 재시도하세요."),
    toolCall("cjk-command-2", "pnpm 권한-검사"),
    toolResult("cjk-command-2", retrySuccess),
    assistant("재시도 명령은 성공했습니다."),
    user("최종 테스트를 실행하세요."),
    toolCall("cjk-test-2", "pnpm test 漢字"),
    toolResult("cjk-test-2", finalTests),
    assistant("최종 테스트는 성공했습니다."),
  ];
  const end = messages.length;
  messages.push(
    user("CJK 상태를 유지한 채 다음 turn으로 계속하세요."),
    assistant("정확한 Unicode 상태로 계속할 준비가 되었습니다.")
  );
  return {
    compactionEnds: [end],
    messages,
    questions: [
      question("exact-recall", identifier, "정확한 식별자는 무엇인가요?"),
      question("file-state", path, "현재 파일 경로는 무엇인가요?"),
      question(
        "constraint-retention",
        clipping,
        "정확한 잘림 제약은 무엇인가요?"
      ),
      question(
        "tool-history",
        failedCommand,
        "첫 명령 실패 결과는 무엇인가요?"
      ),
      question("tool-history", retrySuccess, "재시도 명령 결과는 무엇인가요?"),
      question("tool-history", failedTests, "실패한 테스트 결과는 무엇인가요?"),
      question("tool-history", finalTests, "최종 테스트 결과는 무엇인가요?"),
    ],
    scenario: "tool-state-cjk",
  };
}

function question(
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion {
  return { answer, category, question: text };
}

function toolCall(toolCallId: string, command: string): ModelMessage {
  return {
    content: [
      {
        input: { command },
        toolCallId,
        toolName: "run_command",
        type: "tool-call",
      },
    ],
    role: "assistant",
  };
}

function toolResult(toolCallId: string, value: string): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value },
        toolCallId,
        toolName: "run_command",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}
