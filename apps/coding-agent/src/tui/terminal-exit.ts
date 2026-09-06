import type { TuiMainScreenRenderState } from "@earendil-works/pi-tui";

export const formatSessionResumeHint = (sessionKey: string): string =>
  `To resume this session: pss --session ${sessionResumeSelector(sessionKey)}`;

const sessionResumeSelector = (sessionKey: string): string => {
  const separator = sessionKey.lastIndexOf("#");
  return separator >= 0 ? sessionKey.slice(separator + 1) : sessionKey;
};

export const terminalExitCursorSequence = (
  state: TuiMainScreenRenderState,
  composerRows: number
): string => {
  // Reclaim the top border's row, not the row after it. Shutdown logs may
  // replace the composer here; the outer exit block restores its separator.
  // Clamp only to the visible viewport if an oversized composer scrolled.
  const borderRow = Math.max(
    state.previousViewportTop,
    state.previousLines.length - composerRows
  );
  const delta = borderRow - state.hardwareCursorRow;
  const cursor =
    delta === 0 ? "" : `\x1b[${Math.abs(delta)}${delta < 0 ? "A" : "B"}`;
  return `${cursor}\r\x1b[J`;
};
