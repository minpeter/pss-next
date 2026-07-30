export const CTRL_C_EXIT_WINDOW_MS = 500;

export type CtrlCPressDecision = "clear" | "exit";

export const ctrlCPressDecision = (
  now: number,
  previousPressAt: number
): CtrlCPressDecision =>
  now - previousPressAt < CTRL_C_EXIT_WINDOW_MS ? "exit" : "clear";
