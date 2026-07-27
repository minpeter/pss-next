import { type Agent, createAgent } from "@minpeter/pss-runtime";
import { parentThreadNamespace } from "@minpeter/pss-runtime/namespace";
import type { LanguageModel } from "ai";
import { createConversationHooks } from "./conversation-hooks";
import { createDelegateToReaderTool } from "./delegate-tool";
import { createReadFileTool } from "./read-file-tool";

export async function createReaderAgent(model: LanguageModel) {
  return await createAgent({
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
    readonly readerAgent: Agent;
    readonly threadKey: string;
  }
) {
  const coordinatorNamespace = "coordinator";

  return await createAgent({
    instructions:
      "대화를 조율한다. 지식베이스 조회는 reader에게 delegate_to_reader로 위임하고, reader가 인용한 파일 경로를 사용자에게 전달해.",
    model,
    namespace: coordinatorNamespace,
    hooks: createConversationHooks(),
    tools: {
      delegate_to_reader: createDelegateToReaderTool({
        description: "지식베이스 문서 읽기를 reader 에이전트에게 위임한다.",
        parentAgentNamespace: parentThreadNamespace(
          coordinatorNamespace,
          options.threadKey
        ),
        parentThreadKey: options.threadKey,
        readerAgent: options.readerAgent,
      }),
    },
  });
}
