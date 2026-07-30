export const formatSessionResumeHint = (sessionKey: string): string =>
  `To resume this session: pss --session ${sessionResumeSelector(sessionKey)}`;

const sessionResumeSelector = (sessionKey: string): string => {
  const separator = sessionKey.lastIndexOf("#");
  return separator >= 0 ? sessionKey.slice(separator + 1) : sessionKey;
};

export const terminalExitCursorSequence = (composerRows: number): string => {
  const cursor = composerRows === 0 ? "\r" : `\x1b[${composerRows}A\r`;
  return `${cursor}\x1b[J`;
};
