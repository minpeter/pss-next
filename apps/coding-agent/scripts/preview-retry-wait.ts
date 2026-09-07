// Visual preview of the retry-wait footer status against a real runtime turn:
// `pnpm --filter @minpeter/pss-coding-agent preview:retry-wait`
// (set PSS_RETRY_PREVIEW=recovery|cancel|exhausted; default recovery).
//
// A deterministic local mock provider raises a retryable 429 so the runtime's
// own model-retry controller schedules a real wait; no provider is contacted.
// Every scenario asserts its terminal turn state and physical call count, so a
// fixture that silently stops streaming can never be captured as a success.
import { createAgent } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { APICallError } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { FooterStatusBar } from "../src/tui/agent";
import { agentEventStreamParts } from "../src/tui/agent-event-stream";
import { createRetryStatus } from "../src/tui/retry-status";
import { createSpinnerOrchestrator } from "../src/tui/spinner-orchestrator";
import {
  type PiTuiStreamState,
  STREAM_HANDLERS,
} from "../src/tui/stream-handlers";

const WIDTH = Math.min(process.stdout.columns || 100, 120);
const SCENARIOS = ["recovery", "cancel", "exhausted"] as const;
type Scenario = (typeof SCENARIOS)[number];

const requestedScenario = process.env.PSS_RETRY_PREVIEW ?? "recovery";
if (!SCENARIOS.includes(requestedScenario as Scenario)) {
  throw new Error(
    `PSS_RETRY_PREVIEW must be one of ${SCENARIOS.join(", ")}; got "${requestedScenario}"`
  );
}
const SCENARIO = requestedScenario as Scenario;

/** Terminal state each scenario must reach for the capture to count. */
const EXPECTED = {
  cancel: { calls: 1, stopReason: "cancelled", terminal: "turn-abort" },
  exhausted: { calls: 3, stopReason: "exhausted", terminal: "turn-error" },
  recovery: { calls: 2, stopReason: undefined, terminal: "turn-end" },
} as const satisfies Record<
  Scenario,
  {
    calls: number;
    stopReason: string | undefined;
    terminal: string;
  }
>;

/** Collects every way a scenario failed to reach its documented end state. */
const verifyOutcome = ({
  calls,
  frames,
  stopReason,
  terminal,
}: {
  calls: number;
  frames: readonly string[];
  stopReason: string | undefined;
  terminal: string | undefined;
}): string[] => {
  const expected = EXPECTED[SCENARIO];
  const failures: string[] = [];
  if (terminal !== expected.terminal) {
    failures.push(
      `terminal event: expected ${expected.terminal}, observed ${terminal}`
    );
  }
  if (calls !== expected.calls) {
    failures.push(
      `physical calls: expected ${expected.calls}, observed ${calls}`
    );
  }
  if (stopReason !== expected.stopReason) {
    failures.push(
      `stop reason: expected ${expected.stopReason ?? "none"}, observed ${
        stopReason ?? "none"
      }`
    );
  }
  if (!frames.some((frame) => frame.includes("Retrying"))) {
    failures.push("no frame showed a retry countdown");
  }
  return failures;
};

const failure = () =>
  new APICallError({
    isRetryable: true,
    message: "rate limited by fixture",
    requestBodyValues: {},
    responseHeaders: { "retry-after": "5" },
    statusCode: 429,
    url: "https://fixture.invalid/chat",
  });

const main = async (): Promise<void> => {
  let calls = 0;
  // Local deterministic provider; nothing leaves the machine. `recovery` fails
  // only the first physical call, the other scenarios fail every call.
  const model = new MockLanguageModelV4({
    doStream: () => {
      calls += 1;
      if (calls === 1 || SCENARIO !== "recovery") {
        return Promise.reject(failure());
      }
      return Promise.resolve({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { id: "t", type: "text-start" },
          { delta: "Recovered after the retry.", id: "t", type: "text-delta" },
          { id: "t", type: "text-end" },
          {
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: {
                cacheRead: undefined,
                cacheWrite: undefined,
                noCache: 12,
                total: 12,
              },
              outputTokens: {
                reasoning: undefined,
                text: 5,
                total: 5,
              },
            },
          },
        ]),
      });
    },
  });
  const agent = await createAgent({ host: createInMemoryHost(), model });

  const footer = new FooterStatusBar({ requestRender: () => undefined });
  let foregroundMessage: string | null = null;
  const setForeground = (message: string | null): void => {
    foregroundMessage = message;
    footer.setForegroundMessage(message);
  };
  const orchestrator = createSpinnerOrchestrator(
    {
      clearStatus: () => setForeground(null),
      hasSpinner: () => foregroundMessage !== null,
      setMessage: setForeground,
      showLoader: setForeground,
    },
    "Working..."
  );

  // Explicit render gate: resolves on the next countdown label the status
  // actually emits, so the capture never depends on a wall-clock sleep.
  let awaitNextLabel: ((label: string) => void) | undefined;
  const nextCountdownLabel = (): Promise<string> =>
    new Promise((resolve) => {
      awaitNextLabel = resolve;
    });
  const retryStatus = createRetryStatus({
    now: () => Date.now(),
    setMessage: (message) => {
      if (message === null) {
        orchestrator.onRetryWaitEnd();
        return;
      }
      orchestrator.onRetryWaitMessage(message);
      const notify = awaitNextLabel;
      awaitNextLabel = undefined;
      notify?.(message);
    },
  });

  const state = {
    activeToolInputs: new Map(),
    ensureAssistantView: () => ({
      appendReasoning: () => undefined,
      appendText: () => undefined,
    }),
    flags: {
      showFiles: false,
      showFinishReason: false,
      showRawToolIo: false,
      showReasoning: true,
      showSources: false,
      showSteps: false,
      showToolResults: true,
    },
    getToolView: () => undefined,
    onRetryClear: retryStatus.clear,
    onRetryWait: retryStatus.scheduled,
    pendingToolCallIds: new Set<string>(),
    resetAssistantView: () => undefined,
    streamedToolCallIds: new Set<string>(),
  } as unknown as PiTuiStreamState;

  const frames: string[] = [];
  const capture = (label: string): void => {
    frames.push(`${label}\n${footer.render(WIDTH).join("\n")}`);
  };

  setForeground("Working...");
  const thread = agent.thread("retry-wait-preview");
  const turn = await thread.send("go");

  const observed: string[] = [];
  let stopReason: string | undefined;
  let sawFirstSchedule = false;
  let pendingTick: Promise<string> | undefined;

  for await (const event of turn.events()) {
    observed.push(event.type);
    for await (const part of agentEventStreamParts(singleEvent(event))) {
      await STREAM_HANDLERS[part.type]?.(part, state);
    }
    if (event.type !== "model-retry") {
      continue;
    }
    if (event.phase === "scheduled" && !sawFirstSchedule) {
      sawFirstSchedule = true;
      capture("waiting (fresh schedule)");
      // Gate on the countdown's own next render, not on elapsed time.
      pendingTick = nextCountdownLabel();
      await pendingTick;
      capture("waiting (counting down)");
      if (SCENARIO === "cancel") {
        thread.interrupt();
      }
    }
    if (event.phase === "started") {
      capture("retry started (wait cleared)");
    }
    if (event.phase === "stopped") {
      stopReason = event.reason;
      capture(`stopped (${event.reason})`);
    }
  }

  retryStatus.stop();
  footer.stop();
  await agent.dispose();

  const terminal = observed.at(-1);
  const failures = verifyOutcome({ calls, frames, stopReason, terminal });

  process.stdout.write(
    `\nretry-wait footer preview (${SCENARIO}) — width ${WIDTH}\n\n${frames.join(
      "\n\n"
    )}\n`
  );
  process.stdout.write(
    `\nterminal event: ${terminal} · physical calls: ${calls} · stop reason: ${
      stopReason ?? "none"
    }\n`
  );
  process.stdout.write(
    `__PSS_QA_META__${JSON.stringify({
      calls,
      frames: frames.length,
      passed: failures.length === 0,
      scenario: SCENARIO,
      stopReason: stopReason ?? null,
      terminal,
    })}\n`
  );

  if (failures.length > 0) {
    // Never let a broken fixture be captured as a passing scenario.
    process.stderr.write(
      `${SCENARIO} scenario did not reach its expected terminal state:\n- ${failures.join(
        "\n- "
      )}\n`
    );
    process.exitCode = 1;
  }
};

async function* singleEvent<T>(event: T): AsyncGenerator<T> {
  yield await Promise.resolve(event);
}

await main();
