import { type AgentHost, createAgent } from "@minpeter/pss-runtime";
import { parentThreadNamespace } from "@minpeter/pss-runtime/namespace";
import type { LanguageModel } from "ai";
import { createBackgroundOutputTool } from "./background-output-tool";
import { createConversationHooks } from "./conversation-hooks";
import { createDelegateToReaderTool } from "./delegate-tool";
import { createReadFileTool } from "./read-file-tool";

export async function createReaderAgent(model: LanguageModel, host: AgentHost) {
  return await createAgent({
    host,
    instructions:
      "fixtures/kb/ 문서를 read_file로 읽는다. 요청과 관련된 파일만 골라 읽고, 답변에 근거 파일 경로를 반드시 적어.",
    model,
    namespace: "reader",
    tools: {
      read_file: createReadFileTool(),
    },
  });
}

export async function createCoordinatorAgent(
  model: LanguageModel,
  options: {
    readonly executionHost: AgentHost;
    readonly host: AgentHost;
    readonly threadKey: string;
  }
) {
  const coordinatorNamespace = "coordinator";

  return await createAgent({
    host: options.host,
    instructions: [
      "대화를 조율한다.",
      "지식베이스 조회는 reader에게 delegate_to_reader로 백그라운드 위임한다.",
      "task_id를 받은 뒤 완료 전에는 결과를 기다리지 말고 사용자와 대화를 이어갈 수 있다.",
      "<system-reminder>가 올 때까지 background_output을 호출하지 마.",
      "알림 후 background_output({ task_id, block: true })로 결과를 확인하고, reader가 인용한 파일 경로를 포함해 요약해.",
    ].join(" "),
    model,
    namespace: coordinatorNamespace,
    hooks: createConversationHooks(),
    tools: {
      background_output: createBackgroundOutputTool({
        executionHost: options.executionHost,
        ownerNamespace: parentThreadNamespace(
          coordinatorNamespace,
          options.threadKey
        ),
        parentThreadKey: options.threadKey,
      }),
      delegate_to_reader: createDelegateToReaderTool({
        description:
          "지식베이스 문서 읽기를 reader 에이전트에게 백그라운드로 위임한다.",
        executionHost: options.executionHost,
        parentAgentNamespace: parentThreadNamespace(
          coordinatorNamespace,
          options.threadKey
        ),
        parentThreadKey: options.threadKey,
      }),
    },
  });
}
