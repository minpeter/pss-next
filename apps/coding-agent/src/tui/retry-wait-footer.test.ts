import { Container } from "@earendil-works/pi-tui";
import type { AgentEvent } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { FooterStatusBar } from "./agent";
import { agentEventStreamParts } from "./agent-event-stream";
import { createRetryStatus } from "./retry-status";
import { createSpinnerOrchestrator } from "./spinner-orchestrator";
import {
  type PiTuiStreamState,
  STREAM_HANDLERS,
  type TuiStreamPart,
} from "./stream-handlers";

// biome-ignore lint/suspicious/noControlCharactersInRegex: test helper strips ANSI emitted by the footer
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const RETRY_AT = 1_700_000_004_000;
const NOW = 1_700_000_000_000;
const SPINNER_FRAME_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/**
 * Composes the real chain a turn drives — runtime event -> stream part ->
 * dispatch handler -> retry countdown -> spinner orchestrator -> footer row —
 * so the assertion is on the rendered status line, not on an internal hook.
 */
const createFooterHarness = () => {
  const requestRender = vi.fn();
  const footer = new FooterStatusBar({ requestRender });
  const chatContainer = new Container();
  let foregroundMessage: string | null = null;
  let now = NOW;

  const setForeground = (message: string | null): void => {
    foregroundMessage = message;
    footer.setForegroundMessage(message);
  };

  const orchestrator = createSpinnerOrchestrator(
    {
      clearStatus: () => setForeground(null),
      hasSpinner: () => foregroundMessage !== null,
      setMessage: (message) => setForeground(message),
      showLoader: (message) => setForeground(message),
    },
    "Working..."
  );
  const retryStatus = createRetryStatus({
    now: () => now,
    setMessage: (message) => {
      if (message === null) {
        orchestrator.onRetryWaitEnd();
      } else {
        orchestrator.onRetryWaitMessage(message);
      }
    },
  });

  const state = {
    activeToolInputs: new Map(),
    chatContainer,
    ensureAssistantView: () => ({
      appendReasoning: () => undefined,
      appendText: () => undefined,
    }),
    ensureToolView: () => {
      throw new Error("tool view should not be used");
    },
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
    onReasoningEnd: orchestrator.onReasoningEnd,
    onReasoningStart: orchestrator.onReasoningStart,
    onRetryClear: retryStatus.clear,
    onRetryWait: retryStatus.scheduled,
    onToolPendingEnd: orchestrator.onToolPendingEnd,
    onToolPendingStart: orchestrator.onToolPendingStart,
    pendingToolCallIds: new Set<string>(),
    resetAssistantView: () => undefined,
    streamedToolCallIds: new Set<string>(),
  } as unknown as PiTuiStreamState;

  const dispatch = async (events: AgentEvent[]): Promise<TuiStreamPart[]> => {
    const source = (async function* () {
      yield* events;
    })();
    const parts: TuiStreamPart[] = [];
    for await (const part of agentEventStreamParts(source)) {
      parts.push(part);
      await STREAM_HANDLERS[part.type]?.(part, state);
    }
    return parts;
  };

  return {
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    chatContainer,
    dispatch,
    footerText: () =>
      footer
        .render(80)
        .map((line) => line.replace(ANSI_PATTERN, "").trimEnd())
        .join("\n"),
    retryStatus,
    showWorking: () => setForeground("Working..."),
    stop: () => {
      retryStatus.stop();
      footer.stop();
    },
  };
};

const scheduled: AgentEvent = {
  attempt: 1,
  attemptId: "step-1",
  delayMs: 4000,
  phase: "scheduled",
  remainingRetries: 2,
  retryAt: RETRY_AT,
  type: "model-retry",
} as AgentEvent;

describe("retry wait in the TUI footer", () => {
  it("shows the countdown with attempt and budget while a retry is pending", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    expect(h.footerText()).toContain(
      "Retrying in 4s · attempt 2 · 2 retries left"
    );

    h.advance(2000);
    expect(h.footerText()).toContain(
      "Retrying in 2s · attempt 2 · 2 retries left"
    );

    h.stop();
    vi.useRealTimers();
  });

  it("keeps a running spinner frame in front of the retry label", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    expect(h.footerText().trimStart().charAt(0)).toMatch(SPINNER_FRAME_PATTERN);

    h.stop();
    vi.useRealTimers();
  });

  it("restores the working label once the wait completes", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    await h.dispatch([
      {
        attempt: 1,
        attemptId: "step-1",
        phase: "started",
        remainingRetries: 1,
        type: "model-retry",
      } as AgentEvent,
    ]);

    expect(h.footerText()).toContain("Working...");
    expect(h.footerText()).not.toContain("Retrying");

    h.advance(5000);
    expect(h.footerText()).not.toContain("Retrying");

    h.stop();
    vi.useRealTimers();
  });

  it.each(["cancelled", "exhausted", "non-retryable", "stream-ended"] as const)(
    "drops the banner when the retry stops as %s",
    async (reason) => {
      vi.useFakeTimers();
      const h = createFooterHarness();
      h.showWorking();

      await h.dispatch([scheduled]);
      await h.dispatch([
        {
          attempt: 2,
          attemptId: "step-1",
          phase: "stopped",
          reason,
          remainingRetries: 0,
          type: "model-retry",
        } as AgentEvent,
      ]);

      expect(h.footerText()).not.toContain("Retrying");
      expect(h.retryStatus.isWaiting()).toBe(false);

      h.stop();
      vi.useRealTimers();
    }
  );

  it("never writes the retry wait into the transcript", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([
      scheduled,
      {
        attempt: 1,
        attemptId: "step-1",
        phase: "started",
        remainingRetries: 1,
        type: "model-retry",
      } as AgentEvent,
    ]);

    expect(h.chatContainer.render(80).join("\n").trim()).toBe("");

    h.stop();
    vi.useRealTimers();
  });

  it("does not let the wait label survive into the next step's streaming", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    await h.dispatch([
      {
        attempt: 1,
        attemptId: "step-1",
        phase: "started",
        remainingRetries: 1,
        type: "model-retry",
      } as AgentEvent,
      { text: "hi", type: "assistant-reasoning-delta" } as AgentEvent,
    ]);

    expect(h.footerText()).toContain("Thinking...");
    expect(h.footerText()).not.toContain("Retrying");

    h.stop();
    vi.useRealTimers();
  });

  it("holds the retry label over a concurrent reasoning delta", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    await h.dispatch([
      { text: "hi", type: "assistant-reasoning-delta" } as AgentEvent,
    ]);

    expect(h.footerText()).toContain("Retrying in");
    expect(h.footerText()).not.toContain("Thinking...");

    h.stop();
    vi.useRealTimers();
  });

  // A session switch tears the stream down mid-wait. The teardown must clear
  // the countdown so the next thread never inherits the previous one's banner.
  it("leaves no countdown running after a mid-wait teardown", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    expect(h.retryStatus.isWaiting()).toBe(true);

    h.retryStatus.clear();
    h.retryStatus.stop();

    expect(h.retryStatus.isWaiting()).toBe(false);
    expect(h.footerText()).not.toContain("Retrying");

    // Only the retry text must stay gone; the base spinner keeps animating.
    h.advance(10_000);
    expect(h.footerText()).not.toContain("Retrying");
    expect(h.footerText()).toContain("Working...");

    h.stop();
    vi.useRealTimers();
  });

  it("keeps the one-row footer height while the countdown runs", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    h.showWorking();

    await h.dispatch([scheduled]);
    expect(h.footerText().split("\n")).toHaveLength(1);

    h.stop();
    vi.useRealTimers();
  });

  it("truncates the countdown inside a narrow terminal instead of overflowing", async () => {
    vi.useFakeTimers();
    const h = createFooterHarness();
    const footer = new FooterStatusBar({ requestRender: vi.fn() });
    h.showWorking();
    await h.dispatch([scheduled]);
    footer.setForegroundMessage("Retrying in 4s · attempt 2 · 2 retries left");

    for (const width of [12, 24, 40]) {
      const [line = ""] = footer.render(width);
      expect(line.replace(ANSI_PATTERN, "").length).toBeLessThanOrEqual(width);
    }

    footer.stop();
    h.stop();
    vi.useRealTimers();
  });
});
