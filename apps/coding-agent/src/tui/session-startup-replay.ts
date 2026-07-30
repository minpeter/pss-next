export interface StartupReplayContext {
  readonly resumedExplicitly: boolean;
}

export const shouldReplayOnStartup = ({
  resumedExplicitly,
}: StartupReplayContext): boolean => resumedExplicitly;
