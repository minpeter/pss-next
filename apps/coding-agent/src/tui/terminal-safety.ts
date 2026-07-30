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
