export type ShutdownStep =
  | "dispose-assistant-views"
  | "erase-composer"
  | "stop-render";

export const shutdownSteps = (): readonly ShutdownStep[] => [
  "stop-render",
  "erase-composer",
  "dispose-assistant-views",
];
