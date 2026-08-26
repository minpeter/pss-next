// Match terminal-active characters and malformed UTF-16 code units. Unicode
// properties include astral format controls such as tag characters.
const CONTROL_CHARACTER = /\p{Cc}/u;
const TERMINAL_UNSAFE_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

export const sanitizeTerminalText = (
  text: string,
  maximumLength?: number
): string => {
  const bounded = text
    .slice(0, maximumLength ?? text.length)
    .replace(/\r\n/g, "\n");
  const preserveLayout = maximumLength === undefined;
  return bounded.replace(TERMINAL_UNSAFE_CHARACTER, (character) => {
    if (preserveLayout && (character === "\t" || character === "\n")) {
      return character;
    }
    if (!CONTROL_CHARACTER.test(character)) {
      return "";
    }
    const code = character.charCodeAt(0);
    if (code >= 0x80) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return code === 0x7f ? "^?" : `^${String.fromCharCode(code + 0x40)}`;
  });
};

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
