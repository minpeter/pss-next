// Preserve layout whitespace while making terminal-interpreted C0/C1 controls
// visible. ESC becomes "^[", BEL becomes "^G", and C1 controls become \uXXXX.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal safety requires matching the complete C0/C1 ranges
const TERMINAL_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Only SGR (`CSI ... m`) is safe to pass through: it changes colors and text
// attributes without moving the cursor, scrolling, clearing the screen, or
// querying the terminal. Every other escape sequence stays neutralized.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

const escapeControls = (text: string): string =>
  text.replace(TERMINAL_CONTROL_PATTERN, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 0x80) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return code === 0x7f ? "^?" : `^${String.fromCharCode(code + 0x40)}`;
  });

export const sanitizeTerminalText = (text: string): string =>
  escapeControls(text.replace(/\r\n/g, "\n"));

/**
 * Same guarantees as `sanitizeTerminalText`, except SGR color/attribute
 * sequences survive so tool output keeps its own coloring.
 */
export const sanitizeTerminalTextPreservingColor = (text: string): string => {
  const normalized = text.replace(/\r\n/g, "\n");
  const preserved: string[] = [];
  const masked = normalized.replace(SGR_SEQUENCE, (sequence) => {
    preserved.push(sequence);
    return "\u0000\u0001";
  });
  let index = 0;
  return escapeControls(masked).replace(
    /\^@\^A/g,
    () => preserved[index++] ?? ""
  );
};
