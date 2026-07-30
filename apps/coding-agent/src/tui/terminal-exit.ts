const SAFE_SHELL_WORD = /^[\w./:@%+=,#-]+$/;

const shellWord = (value: string): string =>
  SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

export const formatSessionResumeHint = (sessionKey: string): string =>
  `To resume this session: pss --session ${shellWord(sessionKey)}`;

export const terminalExitCursorSequence = (
  renderedRows: number,
  transcriptRows: number
): string => {
  const rowsUp = Math.max(0, renderedRows - transcriptRows);
  const cursor = rowsUp === 0 ? "\r" : `\x1b[${rowsUp}A\r`;
  return `${cursor}\x1b[J`;
};
