// Preserve layout whitespace while making terminal-interpreted C0/C1 controls
// visible. ESC becomes "^[", BEL becomes "^G", and C1 controls become \uXXXX.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal safety requires matching the complete C0/C1 ranges
const TERMINAL_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export const sanitizeTerminalText = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(TERMINAL_CONTROL_PATTERN, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 0x80) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return code === 0x7f ? "^?" : `^${String.fromCharCode(code + 0x40)}`;
  });

// Escape sequences are removed rather than escaped for untrusted tool output:
// the bytes are not shown, so nothing can move the cursor, clear the screen,
// or emit an OSC payload. Mirrors what pi does with bash output.
const ESC = "\u001b";
const BEL = "\u0007";
// OSC runs until BEL or ST; CSI ends at a final byte; other two-byte escapes
// are covered by the last alternative.
const ESCAPE_SEQUENCE = new RegExp(
  `${ESC}(?:\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|\\[[0-9;?]*[ -/]*[@-~]|[@-Z\\\\-_])`,
  "g"
);

/**
 * Same guarantees as `sanitizeTerminalText`, except escape sequences are
 * stripped so their payload never reaches the screen as literal text.
 */
export const stripTerminalEscapes = (text: string): string =>
  sanitizeTerminalText(text.replace(ESCAPE_SEQUENCE, ""));
