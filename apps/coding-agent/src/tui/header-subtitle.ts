export interface TuiHeaderSubtitleOptions {
  readonly cwd: string;
  readonly maxInputTokens: number | undefined;
  readonly modelLabel: string;
  readonly threadKey: string;
}

/**
 * Keep workspace context visible without repeating the default cwd-derived
 * thread key (for example, `cwd:/repo · thread cwd:/repo`).
 */
export const formatTuiHeaderSubtitle = ({
  cwd,
  maxInputTokens,
  modelLabel,
  threadKey,
}: TuiHeaderSubtitleOptions): string => {
  const threadLabel =
    threadKey === `cwd:${cwd}` ? "thread default" : `thread ${threadKey}`;
  const compactionLabel = `compaction auto max=${maxInputTokens ?? "default"}`;
  return `${modelLabel}\n${cwd} · ${threadLabel} · ${compactionLabel}`;
};
