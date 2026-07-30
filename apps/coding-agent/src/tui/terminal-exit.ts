const SAFE_SHELL_WORD = /^[\w./:@%+=,#-]+$/;

const shellWord = (value: string): string =>
  SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

export const formatSessionResumeHint = (sessionKey: string): string =>
  `To resume this session: pss --session ${shellWord(sessionKey)}`;

export const terminalExitCursorSequence = (composerRows: number): string => {
  const cursor = composerRows === 0 ? "\r" : `\x1b[${composerRows}A\r`;
  return `${cursor}\x1b[J`;
};
