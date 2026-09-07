export interface SpinnerOrchestratorAdapter {
  clearStatus: () => void;
  hasSpinner: () => boolean;
  setMessage: (message: string) => void;
  showLoader: (message: string) => void;
}

export interface SpinnerOrchestrator {
  onReasoningEnd: () => void;
  onReasoningStart: () => void;
  /** Ends the retry wait and restores whatever label the turn implies. */
  onRetryWaitEnd: () => void;
  /** Shows or refreshes the retry countdown, outranking every other label. */
  onRetryWaitMessage: (message: string) => void;
  onToolPendingEnd: () => void;
  onToolPendingStart: () => void;
}

export const createSpinnerOrchestrator = (
  adapter: SpinnerOrchestratorAdapter,
  baseLoaderMessage: string | null | undefined
): SpinnerOrchestrator => {
  let reasoningActive = false;
  let reasoningRevivedSpinner = false;
  let retryWaiting = false;
  let retryRevivedSpinner = false;
  let toolPendingCount = 0;
  let toolRevivedSpinner = false;

  const restoreBase = (): void => {
    if (baseLoaderMessage) {
      adapter.setMessage(baseLoaderMessage);
    }
  };

  return {
    onRetryWaitMessage: (message: string) => {
      // The provider call is not in flight during the wait, so the countdown
      // replaces any streaming label until the wait resolves.
      retryWaiting = true;
      if (adapter.hasSpinner()) {
        adapter.setMessage(message);
        return;
      }
      adapter.showLoader(message);
      retryRevivedSpinner = true;
    },
    onRetryWaitEnd: () => {
      if (!retryWaiting) {
        return;
      }
      retryWaiting = false;
      if (reasoningActive) {
        adapter.setMessage("Thinking...");
        retryRevivedSpinner = false;
        return;
      }
      if (toolPendingCount > 0) {
        adapter.setMessage("Executing...");
        retryRevivedSpinner = false;
        return;
      }
      if (retryRevivedSpinner && !baseLoaderMessage) {
        adapter.clearStatus();
        retryRevivedSpinner = false;
        return;
      }
      restoreBase();
    },
    onReasoningStart: () => {
      reasoningActive = true;
      if (retryWaiting) {
        return;
      }
      if (adapter.hasSpinner()) {
        adapter.setMessage("Thinking...");
      } else {
        adapter.showLoader("Thinking...");
        reasoningRevivedSpinner = true;
      }
    },
    onReasoningEnd: () => {
      reasoningActive = false;
      if (retryWaiting) {
        return;
      }
      if (toolPendingCount > 0) {
        if (adapter.hasSpinner()) {
          adapter.setMessage("Executing...");
        } else {
          adapter.showLoader("Executing...");
        }
        if (reasoningRevivedSpinner) {
          toolRevivedSpinner = true;
          reasoningRevivedSpinner = false;
        }
        return;
      }
      if (reasoningRevivedSpinner && !baseLoaderMessage) {
        adapter.clearStatus();
        reasoningRevivedSpinner = false;
        return;
      }
      restoreBase();
    },
    onToolPendingStart: () => {
      toolPendingCount += 1;
      if (reasoningActive || retryWaiting) {
        return;
      }
      if (adapter.hasSpinner()) {
        adapter.setMessage("Executing...");
      } else {
        adapter.showLoader("Executing...");
        toolRevivedSpinner = true;
      }
    },
    onToolPendingEnd: () => {
      toolPendingCount = Math.max(0, toolPendingCount - 1);
      if (toolPendingCount > 0 || retryWaiting) {
        return;
      }
      if (reasoningActive) {
        if (toolRevivedSpinner) {
          reasoningRevivedSpinner = true;
          toolRevivedSpinner = false;
        }
        return;
      }
      if (toolRevivedSpinner && !baseLoaderMessage) {
        adapter.clearStatus();
        toolRevivedSpinner = false;
        return;
      }
      restoreBase();
    },
  };
};
