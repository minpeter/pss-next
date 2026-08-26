import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AgentHost } from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import { createConfiguredAgent } from "../agent/agent";
import type { WorkerAgentDeliveryResponse } from "../agent/agent-do-delivery";
import { threadStoreForHost } from "../agent/agent-host-thread-store";
import { localChannelBinding } from "../channel";
import { createThreadStoreSessionTranscriptReader } from "../session/session-transcript";
import {
  createSessionIndexStore,
  type SessionIndexStore,
} from "../session-index/session-index";
import { createFileSessionIndexRepository } from "../session-index/session-index-node";
import {
  resolveWorkerAgentTuiConfig,
  type WorkerAgentTuiConfig,
  WorkerAgentTuiConfigError,
} from "./tui-config";
import { TUI_SESSION_SCOPE_KEY } from "./tui-contract";
import { createRemoteTuiDeliveryClient } from "./tui-remote";
import {
  createTuiMessageSink,
  deliverRemoteTuiTurn,
  deliverTuiTurn,
  type TuiOutput,
} from "./tui-sink";

interface StartWorkerAgentTuiOptions {
  readonly config?: WorkerAgentTuiConfig;
  readonly host?: AgentHost;
  readonly output?: TuiOutput;
}

async function startWorkerAgentTui(
  options: StartWorkerAgentTuiOptions = {}
): Promise<void> {
  const config = options.config ?? resolveWorkerAgentTuiConfig();
  const output =
    options.output ??
    ({
      writeLine: (line) => process.stdout.write(`${line}\n`),
    } satisfies TuiOutput);

  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let inputClosed = false;
  input.once("close", () => {
    inputClosed = true;
  });
  const close = await configureTuiTurnDelivery(config, output, options.host);

  output.writeLine("pss worker-agent TUI. Type /exit to quit.");
  input.setPrompt("> ");
  if (inputClosed) {
    await close.dispose();
    return;
  }
  input.prompt();

  for await (const line of input) {
    const text = line.trim();
    if (text === "/exit" || text === "/quit") {
      break;
    }

    await close.deliver(text);
    if (!inputClosed) {
      input.prompt();
    }
  }

  if (!inputClosed) {
    input.close();
  }
  await close.dispose();
}

async function configureTuiTurnDelivery(
  config: WorkerAgentTuiConfig,
  output: TuiOutput,
  hostOverride?: AgentHost
): Promise<{
  readonly deliver: (text: string) => Promise<WorkerAgentDeliveryResponse>;
  readonly dispose: () => Promise<void>;
}> {
  switch (config.mode) {
    case "local": {
      await mkdir(config.directory, { recursive: true });
      const host =
        hostOverride ?? createFileHost({ directory: config.directory });
      const sessionIndex: SessionIndexStore = createSessionIndexStore(
        createFileSessionIndexRepository(
          join(config.directory, "session-index.json")
        )
      );
      const binding = localChannelBinding(config.channel);
      const sessionScopeKey = TUI_SESSION_SCOPE_KEY;
      const agent = await createConfiguredAgent(config.env, host, {
        sendMessage: {
          channel: () => config.channel,
          sink: createTuiMessageSink(output),
        },
        sessionTools: {
          currentConversationKey: () => binding.channelKey,
          currentSessionScopeKey: () => sessionScopeKey,
          reader: sessionIndex,
          transcriptReader: createThreadStoreSessionTranscriptReader({
            resolveThreadKey: (conversationKey) =>
              conversationKey === binding.channelKey
                ? binding.threadKey
                : sessionIndex.resolveThreadKey(conversationKey),
            store: threadStoreForHost(host),
          }),
        },
      });
      const thread = agent.thread(binding.thread);
      return {
        deliver: async (text) => {
          const assistantText: string[] = [];
          const delivery = await deliverTuiTurn({
            onAssistantOutput: (line) => assistantText.push(line),
            output,
            text,
            thread,
          });
          const trimmed = text.trim();
          if (trimmed) {
            await sessionIndex.upsert({
              assistantText,
              channel: binding.channel,
              sessionScopeKey,
              threadKey: binding.threadKey,
              userText: trimmed,
            });
          }
          return delivery;
        },
        dispose: () => thread.dispose(),
      };
    }
    case "remote": {
      const client = createRemoteTuiDeliveryClient(config);
      return {
        deliver: (text) =>
          deliverRemoteTuiTurn({
            client,
            output,
            text,
          }),
        dispose: () => Promise.resolve(),
      };
    }
    default:
      return assertNever(config);
  }
}

import { isMainModule } from "../shared/is-main-module";

if (isMainModule(import.meta.url)) {
  await startWorkerAgentTui();
}

function assertNever(value: never): never {
  throw new WorkerAgentTuiConfigError(
    `Unexpected TUI config variant: ${String(value)}`
  );
}
