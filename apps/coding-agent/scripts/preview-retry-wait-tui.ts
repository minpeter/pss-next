// Real-surface capture of the retry-wait status through `createAgentTUI`:
// `pnpm --filter @minpeter/pss-coding-agent preview:retry-wait-tui`
// (set PSS_RETRY_PREVIEW=recovery|cancel|exhausted; default recovery).
//
// Unlike `preview-retry-wait.ts`, which composes the footer chain directly,
// this drives the actual TUI: real `createAgentTUI`, real composer, real
// header/chat/footer layout, real runtime turn against a local mock provider.
//
// The TUI paints to stdout continuously, so the last frame of a completed run
// would never show a wait. The driver therefore records every byte the TUI
// paints, marks the offset at which the countdown first appeared, lets the TUI
// shut down cleanly, and finally replays only the prefix up to that offset.
// The captured artifact is the TUI's own paint output at the wait moment.

import type { AgentTurn } from "@minpeter/pss-runtime";
import { createAgent } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { APICallError } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { createAgentTUI } from "../src/tui/agent";

const SCENARIOS = ["recovery", "cancel", "exhausted"] as const;
type Scenario = (typeof SCENARIOS)[number];
const requested = process.env.PSS_RETRY_PREVIEW ?? "recovery";
if (!SCENARIOS.includes(requested as Scenario)) {
  throw new Error(`PSS_RETRY_PREVIEW must be one of ${SCENARIOS.join(", ")}`);
}
const SCENARIO = requested as Scenario;
const EXPECTED_CALLS = { cancel: 1, exhausted: 3, recovery: 2 } as const;
const EXPECTED_TERMINAL = {
  cancel: "turn-abort",
  exhausted: "turn-error",
  recovery: "turn-end",
} as const;
const EXPECTED_STOP = {
  cancel: "cancelled",
  exhausted: "exhausted",
  recovery: undefined,
} as const;

const failure = () =>
  new APICallError({
    isRetryable: true,
    message: "rate limited by fixture",
    requestBodyValues: {},
    responseHeaders: { "retry-after": "5" },
    statusCode: 429,
    url: "https://fixture.invalid/chat",
  });

let calls = 0;
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
        {
          delta: "Recovered after the retry.",
          id: "t",
          type: "text-delta",
        },
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
const thread = agent.thread("retry-wait-tui-preview");

// Capture every byte the real TUI paints, suppressing live output so the
// harness only receives the frame we deliberately replay at the end.
const realWrite = process.stdout.write.bind(process.stdout);
let painted = "";
let countdownOffset: number | undefined;
const RETRY_LABEL = "Retrying in";

// Resolves the first time the real TUI paints a countdown, so every gate below
// waits on an observed render instead of a wall-clock guess.
let notifyCountdownPainted: (() => void) | undefined;
const countdownPainted = new Promise<void>((resolve) => {
  notifyCountdownPainted = resolve;
});

process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  painted += typeof chunk === "string" ? chunk : String(chunk);
  if (countdownOffset === undefined && painted.includes(RETRY_LABEL)) {
    // First frame that contains the countdown: this is the capture point.
    countdownOffset = painted.length;
    notifyCountdownPainted?.();
    notifyCountdownPainted = undefined;
  }
  const callback = rest.at(-1);
  if (typeof callback === "function") {
    (callback as () => void)();
  }
  return true;
}) as typeof process.stdout.write;

// The TUI attaches its stdin handler during startup; defer a tick so the
// injected keystrokes always land on a live listener.
const inject = (data: string): void => {
  setImmediate(() => process.stdin.emit("data", data));
};
const injectExit = (): void => {
  inject("\u0003");
  inject("\u0003");
};

let observedTerminal: string | undefined;
let observedStop: string | undefined;
let sawCountdownFrame = false;

/**
 * Mirrors the runtime turn so the driver can gate on real retry phases.
 * `events` is a read-only own property, so the mirror is a fresh object rather
 * than a prototype-chained copy.
 */
const observeTurn = (turn: AgentTurn): AgentTurn => {
  const events = turn.events.bind(turn);
  return {
    ...turn,
    events: () => {
      const source = events();
      return (async function* observed() {
        try {
          for await (const event of source) {
            observedTerminal = event.type;
            if (event.type === "model-retry" && event.phase === "stopped") {
              observedStop = event.reason;
            }
            const isSchedule =
              event.type === "model-retry" && event.phase === "scheduled";
            // Yield first: the TUI only paints the wait once it has handled
            // the event, so the paint gate below must run after the handoff.
            yield event;
            if (isSchedule) {
              await countdownPainted;
              sawCountdownFrame = true;
              if (SCENARIO === "cancel") {
                thread.interrupt();
              }
            }
          }
        } finally {
          // Turn is over on every path, including the interrupted one that
          // never reaches onTurnComplete. Drive the TUI's own exit keys.
          injectExit();
        }
      })();
    },
  };
};

const tuiFinished = createAgentTUI({
  footer: { text: "retry-wait QA" },
  header: { subtitle: "retry-wait visual QA", title: "pss" },
  thread: {
    interrupt: () => thread.interrupt(),
    send: async (input: string) => observeTurn(await thread.send(input)),
    steer: async (input: string) => observeTurn(await thread.steer(input)),
  },
  onSetup: () => {
    // The composer is live once setup completes; submit the prompt.
    inject("go\r");
  },
});

// Backstop only: the turn's own completion drives the exit above.
const exitGuard = setTimeout(injectExit, 60_000);
exitGuard.unref?.();

await tuiFinished;
clearTimeout(exitGuard);
process.stdout.write = realWrite;
await agent.dispose();

const frame = painted.slice(0, countdownOffset ?? painted.length);
realWrite(frame);
realWrite("\r\n");

const failures: string[] = [];
if (countdownOffset === undefined) {
  failures.push("the TUI never painted a retry countdown");
}
if (!sawCountdownFrame) {
  failures.push("the countdown frame gate never resolved");
}
if (calls !== EXPECTED_CALLS[SCENARIO]) {
  failures.push(
    `physical calls: expected ${EXPECTED_CALLS[SCENARIO]}, observed ${calls}`
  );
}
if (observedTerminal !== EXPECTED_TERMINAL[SCENARIO]) {
  failures.push(
    `terminal event: expected ${
      EXPECTED_TERMINAL[SCENARIO]
    }, observed ${observedTerminal}`
  );
}
if (observedStop !== EXPECTED_STOP[SCENARIO]) {
  failures.push(
    `stop reason: expected ${EXPECTED_STOP[SCENARIO] ?? "none"}, observed ${
      observedStop ?? "none"
    }`
  );
}

realWrite(
  `__PSS_QA_META__${JSON.stringify({
    calls,
    capturedBytes: frame.length,
    passed: failures.length === 0,
    scenario: SCENARIO,
    stopReason: observedStop ?? null,
    terminal: observedTerminal ?? null,
  })}\n`
);

if (failures.length > 0) {
  process.stderr.write(
    `${SCENARIO} TUI capture failed:\n- ${failures.join("\n- ")}\n`
  );
  process.exitCode = 1;
}
