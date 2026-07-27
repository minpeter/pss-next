import {
  type AgentEvent,
  type AgentTurn,
  isStreamAgentEvent,
} from "@minpeter/pss-runtime";

interface CliPrintState {
  sawOutputDelta: boolean;
}

export async function drainRunForCli(run: AgentTurn) {
  const state: CliPrintState = { sawOutputDelta: false };
  for await (const event of run.events()) {
    printCliEvent(event, state);
  }
}

function printCliEvent(event: AgentEvent, state: CliPrintState) {
  switch (event.type) {
    case "step-start":
      state.sawOutputDelta = false;
      console.log(`\n[${event.type}]`, event);
      return;
    case "assistant-output-delta":
      state.sawOutputDelta = true;
      process.stdout.write(event.text);
      return;
    case "assistant-output":
      // Deltas already streamed this step's text; only print committed
      // output when the model produced no deltas.
      if (!state.sawOutputDelta) {
        process.stdout.write(event.text);
      }
      return;
    case "tool-call":
      console.log(`\n[tool] ${event.toolName}`);
      return;
    case "tool-result":
      console.log(`[tool-result] ${event.toolName}`);
      return;
    case "turn-end":
      return;
    default:
      if (!isStreamAgentEvent(event)) {
        console.log(`\n[${event.type}]`, event);
      }
  }
}
