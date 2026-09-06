import type { Container, Text } from "@earendil-works/pi-tui";

/**
 * Reuse-and-pulse behaviour for immediately repeated TUI system notices.
 *
 * A user who presses Enter on an empty composer twice gets no new information
 * from a second identical row, only a taller transcript. Instead the already
 * visible row is briefly re-rendered inverted and then restored, which reads as
 * "yes, still the same notice" without growing the transcript.
 *
 * MATCHING SCOPE — deliberately narrow:
 *
 * - Only the *current notice instance* is reusable: the exact `Text` row this
 *   module appended, only while it is still the LAST child of the chat
 *   container, and only for a byte-identical message.
 * - Anything landing after it (assistant text, tool output, a user message, a
 *   different notice) makes the tracked row stale, so the next notice is
 *   appended fresh. A genuinely new notice is never suppressed.
 * - This is NOT transcript deduplication. Assistant/model/tool/user content is
 *   never inspected, compared, or collapsed.
 *
 * The pulse is pure view state on a mounted component: nothing here reaches
 * persisted session state, and restore writes back the byte-identical string
 * captured when the row was created.
 */

export const NOTICE_PULSE_MS = 140;

export interface RepeatedNotice {
  /** Restores a still-mounted pulse and drops the tracked row and timer. */
  reset(): void;
  /**
   * Ends any in-flight pulse immediately, restoring the normal style. Used at
   * shutdown so the final preserved frame never keeps a row inverted.
   */
  settle(): void;
  /**
   * Renders terminal-sanitized `message`. Appends a new row, or pulses the
   * current notice instance when this is an immediate identical repeat.
   */
  show(message: string): void;
  /** Tears down without painting; call settle before the UI's final render. */
  stop(): void;
}

export interface AppendedNotice {
  /** The byte-identical normal-style string the row was created with. */
  readonly normalText: string;
  readonly row: Text;
}

export interface RepeatedNoticeOptions {
  /**
   * Appends a fresh notice row, or returns `undefined` when the message
   * renders to nothing and no row was added.
   */
  appendNotice: (message: string) => AppendedNotice | undefined;
  /** The chat container the notice rows live in; used for staleness checks. */
  chatContainer: Pick<Container, "children">;
  /** Styles the sanitized notice with white background and black text. */
  pulseStyle: (message: string) => string;
  requestRender: () => void;
}

interface TrackedNotice {
  readonly message: string;
  /** The byte-identical normal-style string to restore after the pulse. */
  readonly normalText: string;
  readonly row: Text;
}

export const createRepeatedNotice = ({
  appendNotice,
  chatContainer,
  pulseStyle,
  requestRender,
}: RepeatedNoticeOptions): RepeatedNotice => {
  let tracked: TrackedNotice | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clearPulse = (): void => {
    if (pulseTimer !== undefined) {
      clearTimeout(pulseTimer);
      pulseTimer = undefined;
    }
  };

  const restore = (notice: TrackedNotice): boolean => {
    if (!chatContainer.children.includes(notice.row)) {
      return false;
    }
    notice.row.setText(notice.normalText);
    return true;
  };

  const settle = (): void => {
    if (pulseTimer === undefined) {
      return;
    }
    // Restore while the old pulse still has an owner, before replacing it.
    if (tracked !== undefined) {
      restore(tracked);
    }
    clearPulse();
  };

  /**
   * The reusable notice for `message`, or `undefined` when this is not an
   * immediate identical repeat of the still-visible current notice.
   */
  const reusableFor = (message: string): TrackedNotice | undefined => {
    if (tracked === undefined || tracked.message !== message) {
      return;
    }
    // Anything appended after the tracked row makes it stale, so a later
    // exchange never suppresses a genuinely new notice.
    return chatContainer.children.at(-1) === tracked.row ? tracked : undefined;
  };

  return {
    show(message: string): void {
      if (stopped) {
        return;
      }

      const current = reusableFor(message);
      if (current !== undefined) {
        current.row.setText(pulseStyle(message));
        // A rapid repeat re-arms the single pulse instead of stacking timers,
        // so the inversion can never outlive the last attempt.
        clearPulse();
        pulseTimer = setTimeout(() => {
          pulseTimer = undefined;
          if (restore(current)) {
            requestRender();
          }
        }, NOTICE_PULSE_MS);
        pulseTimer.unref?.();
        requestRender();
        return;
      }

      settle();
      const appended = appendNotice(message);
      tracked =
        appended === undefined
          ? undefined
          : { message, normalText: appended.normalText, row: appended.row };
      requestRender();
    },
    reset(): void {
      settle();
      tracked = undefined;
    },
    settle,
    stop(): void {
      stopped = true;
      clearPulse();
      tracked = undefined;
    },
  };
};
