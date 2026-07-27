import { type AgentTurn, isStreamAgentEvent } from "@minpeter/pss-runtime";

export async function drain(run: AgentTurn) {
  let sawOutputDelta = false;
  for await (const event of run.events()) {
    switch (event.type) {
      case "step-start":
        sawOutputDelta = false;
        console.log(`\n[${event.type}]`, event);
        break;
      case "assistant-output-delta":
        sawOutputDelta = true;
        process.stdout.write(event.text);
        break;
      case "assistant-output":
        // Deltas already streamed this step's text; only print committed
        // output when the model produced no deltas.
        process.stdout.write(sawOutputDelta ? "\n" : `\n${event.text}\n`);
        break;
      case "tool-call":
        console.log(`\n[tool] ${event.toolName}`);
        break;
      case "tool-result":
        console.log(`[tool-result] ${event.toolName}`);
        break;
      default:
        if (!isStreamAgentEvent(event)) {
          console.log(`\n[${event.type}]`, event);
        }
    }
  }
}
